import protobuf from 'protobufjs';
import { check, integer, sha256, type FileRef } from './httpPack';
import { lod4CellBounds, type Lod4Region } from './lod4';
import { normalizeMetric } from './mapAnalytics';
import type { Lod4Cells, Lod4Metric } from './lod4Summary';
import type { SpatialMetricPage } from './spatialMetrics';

export const LOD4_AGGREGATES_FORMAT = 'bitmap-lod4-aggregates-v2';
export const LOD4_BATCH_LIMIT = 20 * 1024;
export const LOD4_AGGREGATE_INDEX_LIMIT = 256 * 1024;
export const LOD4_BATCH_REGIONS = 6;
export const LOD4_MODES = ['area', 'count', 'diversity', 'occupancy', 'size'] as const;
export type Lod4Mode = typeof LOD4_MODES[number];
export type AggregateRegion = { id:number; width:number; height:number; columns:number; rows:number; means:Float32Array; weights:Float32Array; coverage:Float32Array };
export type AggregateBatchRef = FileRef & { mode:Lod4Mode; tile:number; ids:number[] };
export type AggregateIndex = { version:2; format:typeof LOD4_AGGREGATES_FORMAT; sourceSnapshot:string; gridSide:16; regions:{id:number;width:number;height:number;geometrySha256:string;metricsSha256:string}[]; batches:AggregateBatchRef[] };
export type AggregateDiscovery = { format:typeof LOD4_AGGREGATES_FORMAT; sourceSnapshot:string; index:FileRef };
const field=(type:string,id:number,repeated=false)=>({type,id,...(repeated?{rule:'repeated',options:{packed:true}}:{})});
const root=protobuf.Root.fromJSON({nested:{
    Region:{fields:{id:field('uint32',1),width:field('uint32',2),height:field('uint32',3),columns:field('uint32',4),rows:field('uint32',5),means:field('float',6,true),weights:field('float',7,true),coverage:field('float',8,true)}},
    Batch:{fields:{version:field('uint32',1),mode:field('string',2),tile:field('uint32',3),regions:field('Region',4,true)}},
    RegionRef:{fields:{id:field('uint32',1),width:field('uint32',2),height:field('uint32',3),geometrySha256:field('string',4),metricsSha256:field('string',5)}},
    BatchRef:{fields:{mode:field('string',1),tile:field('uint32',2),ids:field('uint32',3,true),url:field('string',4),sha256:field('string',5),bytes:field('uint32',6)}},
    Index:{fields:{version:field('uint32',1),format:field('string',2),sourceSnapshot:field('string',3),gridSide:field('uint32',4),regions:field('RegionRef',5,true),batches:field('BatchRef',6,true)}}
}});
const indexType=root.lookupType('Index'),batchType=root.lookupType('Batch');
const validHash=(s:string)=>/^[a-f0-9]{64}$/.test(s);
export const aggregateIndexPath=(hash:string)=>`bitmaps/summaries/aggregates/index.${hash}.pb`;
export const aggregateBatchPath=(mode:Lod4Mode,tile:number,hash:string)=>`bitmaps/summaries/aggregates/${mode}/t${String(tile).padStart(4,'0')}.${hash}.pb`;
export function validAggregatePath(url:string,hash:string){return validHash(hash)&&(url===aggregateIndexPath(hash)||LOD4_MODES.some(mode=>new RegExp(`^bitmaps/summaries/aggregates/${mode}/t[0-9]{4}\\.${hash}\\.pb$`).test(url)));}
export function validateAggregateDiscovery(d:AggregateDiscovery,snapshot:string){
    check(d?.format===LOD4_AGGREGATES_FORMAT&&d.sourceSnapshot===snapshot&&d.index?.url===aggregateIndexPath(d.index.sha256)&&validHash(d.index.sha256)&&integer(d.index.bytes,1,LOD4_AGGREGATE_INDEX_LIMIT),'Invalid aggregate discovery');return d;
}
export function validateAggregateIndex(index:AggregateIndex,snapshot:string){
    check(index.version===2&&index.format===LOD4_AGGREGATES_FORMAT&&index.sourceSnapshot===snapshot&&validHash(snapshot)&&index.gridSide===16,'Invalid aggregate index identity');
    check(index.regions.length>0&&index.regions.length<=521&&index.batches.length<=521*5,'Invalid aggregate coverage');
    index.regions.forEach((r,id)=>check(r.id===id&&integer(r.width,1,65535)&&integer(r.height,1,65535)&&validHash(r.geometrySha256)&&validHash(r.metricsSha256),'Invalid aggregate canonical reference'));
    for(const mode of LOD4_MODES){
        const seen=new Set<number>(),tiles=new Set<number>();
        for(const b of index.batches.filter(b=>b.mode===mode)){
            check(integer(b.tile,0,520)&&!tiles.has(b.tile)&&integer(b.bytes,1,LOD4_BATCH_LIMIT)&&validHash(b.sha256)&&b.url===aggregateBatchPath(mode,b.tile,b.sha256)&&b.ids.length>0&&b.ids.length<=LOD4_BATCH_REGIONS,'Invalid aggregate batch reference');tiles.add(b.tile);
            for(const id of b.ids){check(integer(id,0,index.regions.length-1)&&!seen.has(id),'Duplicate aggregate region');seen.add(id);}
        }
        check(seen.size===index.regions.length,'Missing aggregate region');
    }
    check(index.batches.every(b=>LOD4_MODES.includes(b.mode)),'Invalid aggregate mode');return index;
}
function validateRegion(r:AggregateRegion,mode:Lod4Mode){
    const cells=r.columns*r.rows;
    check(integer(r.id,0,520)&&integer(r.width,1,65535)&&integer(r.height,1,65535)&&r.columns===Math.min(16,r.width)&&r.rows===Math.min(16,r.height),'Invalid aggregate dimensions');
    check(r.means.length===cells&&r.weights.length===cells&&r.coverage.length===cells,'Invalid aggregate cell coverage');
    for(let c=0;c<cells;c++)check(Number.isFinite(r.means[c])&&r.means[c]>=0&&(mode!=='size'||r.means[c]<=9)&&Number.isFinite(r.weights[c])&&r.weights[c]>=0&&Number.isFinite(r.coverage[c])&&r.coverage[c]>=0&&r.coverage[c]<=1&&(r.weights[c]>0)===(r.coverage[c]>0),'Invalid aggregate cell');
    return r;
}
export function encodeAggregateIndex(index:AggregateIndex){validateAggregateIndex(index,index.sourceSnapshot);const b=indexType.encode(index).finish();check(b.length<=LOD4_AGGREGATE_INDEX_LIMIT,'Aggregate index exceeds budget');return b;}
export async function decodeAggregateIndex(bytes:Uint8Array,snapshot:string,ref:FileRef){
    check(bytes.length===ref.bytes&&bytes.length<=LOD4_AGGREGATE_INDEX_LIMIT&&await sha256(bytes)===ref.sha256,'Aggregate index integrity failure');
    return validateAggregateIndex(indexType.toObject(indexType.decode(bytes),{arrays:true,defaults:true}) as AggregateIndex,snapshot);
}
export function encodeAggregateBatch(mode:Lod4Mode,tile:number,regions:AggregateRegion[]){
    check(regions.length>0&&regions.length<=LOD4_BATCH_REGIONS,'Aggregate batch region budget');regions.forEach(r=>validateRegion(r,mode));
    const bytes=batchType.encode({version:2,mode,tile,regions:regions.map(r=>({...r,means:Array.from(r.means),weights:Array.from(r.weights),coverage:Array.from(r.coverage)}))}).finish();
    check(bytes.length<=LOD4_BATCH_LIMIT,'Aggregate batch exceeds budget');return bytes;
}
export async function decodeAggregateBatch(bytes:Uint8Array,ref:AggregateBatchRef,index:AggregateIndex){
    check(index.batches.some(b=>b===ref||b.url===ref.url&&b.sha256===ref.sha256&&b.bytes===ref.bytes&&b.mode===ref.mode&&b.tile===ref.tile&&b.ids.join(',')===ref.ids.join(',')),'Aggregate batch absent from index');
    check(bytes.length===ref.bytes&&bytes.length<=LOD4_BATCH_LIMIT&&await sha256(bytes)===ref.sha256,'Aggregate batch integrity failure');
    const b=batchType.toObject(batchType.decode(bytes),{arrays:true,defaults:true});
    check(b.version===2&&b.mode===ref.mode&&b.tile===ref.tile&&b.regions.length===ref.ids.length,'Aggregate batch identity mismatch');
    return b.regions.map((r:AggregateRegion,i:number)=>{
        const original=index.regions[ref.ids[i]];check(r.id===original.id&&r.width===original.width&&r.height===original.height,'Aggregate canonical dimensions mismatch');
        return validateRegion({...r,means:Float32Array.from(r.means),weights:Float32Array.from(r.weights),coverage:Float32Array.from(r.coverage)},ref.mode);
    }) as AggregateRegion[];
}

/** Display-only sufficient statistics. Exact filtering keeps the immutable membership pages. */
export function buildAggregateRegion(page:Lod4Region,mode:Lod4Mode,metrics:SpatialMetricPage):AggregateRegion{
    check(metrics.region===page.id&&metrics.count.length===page.bitmapAreas.length,'Aggregate metric identity mismatch');
    const n=page.columns*page.rows,means=new Float32Array(n),weights=new Float32Array(n),coverage=new Float32Array(n);
    for(let cell=0;cell<n;cell++){
        let local=0,sum=0,weight=0,occupied=0;
        for(let i=page.cellOffsets[cell];i<page.cellOffsets[cell+1];i++){
            local+=page.memberDeltas[i];const area=page.overlapAreas[i],fraction=area/page.bitmapAreas[local];occupied+=area;
            if(mode==='size'){
                let total=0,value=0;for(let j=0;j<9;j++){const a=metrics.classes[local*9+j]*(j+1)**2;total+=a;value+=a*(j+1);}
                // Match the Float32 per-bitmap parcel texture used by the exact path.
                const w=Math.fround(total)*fraction;weight+=w;sum+=Math.fround(value/total)*w;
            }else{weight+=fraction;sum+=(mode==='area'?page.bitmapAreas[local]:metrics[mode][local])*fraction;}
        }
        const bounds=lod4CellBounds(page,cell);means[cell]=weight?sum/weight:0;weights[cell]=weight;coverage[cell]=occupied/(bounds.width*bounds.height);
    }
    return validateRegion({id:page.id,width:page.width,height:page.height,columns:page.columns,rows:page.rows,means,weights,coverage},mode);
}
/** Merge raw means with their original weights before applying a metric's scale. */
export function summarizeAggregateCells(page:AggregateRegion,metric:Lod4Metric,step=1,rowStep=step,totalWeights?:Float32Array):Lod4Cells{
    check([1,2,4,8,16].includes(step)&&[1,2,4,8,16].includes(rowStep),'Invalid aggregate grouping');
    const bounds:Lod4Cells['bounds']=[],values:number[]=[],coverage:number[]=[];
    for(let row=0;row<page.rows;row+=rowStep)for(let col=0;col<page.columns;col+=step){
        let sum=0,weight=0,total=0,occupied=0;
        const lastRow=Math.min(page.rows,row+rowStep),lastCol=Math.min(page.columns,col+step),a=lod4CellBounds(page,row*page.columns+col),b=lod4CellBounds(page,(lastRow-1)*page.columns+lastCol-1);
        const rect={x:a.x,y:a.y,width:b.x+b.width-a.x,height:b.y+b.height-a.y};
        for(let y=row;y<lastRow;y++)for(let x=col;x<lastCol;x++){const c=y*page.columns+x,r=lod4CellBounds(page,c);sum+=page.means[c]*page.weights[c];weight+=page.weights[c];total+=totalWeights?.[c]??page.weights[c];occupied+=page.coverage[c]*r.width*r.height;}
        const mean=weight?sum/weight:1;bounds.push(rect);values.push(metric.kind==='scalar'&&weight?1+8*normalizeMetric(mean,metric.summary):mean,total?Math.min(1,weight/total):0);coverage.push(Math.min(1,occupied/(rect.width*rect.height)));
    }
    return {bounds,summaries:Float32Array.from(values),coverage:Float32Array.from(coverage)};
}
