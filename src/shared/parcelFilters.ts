import protobuf from 'protobufjs';
import { check, integer, sha256, type FileRef } from './httpPack';
import type { Lod4Region } from './lod4';
import { parcelClassFilter } from './layerAnalysis';
export const PARCEL_FILTER_FORMAT='parcel-spatial-filters-v1';
export const PARCEL_FILTER_LIMIT=100*1024;
export const PARCEL_FILTER_BATCH_LIMIT=20*1024;
export type ParcelRangeRef=FileRef&{low:number;high:number};
export type ParcelFilterMetadata={version:1;format:typeof PARCEL_FILTER_FORMAT;sourceSnapshot:string;count:number;parent:FileRef;regionCounts:number[];masks:number[];ranges:ParcelRangeRef[]};
export type ParcelFilterBatchRef=FileRef&{tile:number;ids:number[]};
export type ParcelFilterIndex={version:1;sourceSnapshot:string;parentSha256:string;low:number;high:number;batches:ParcelFilterBatchRef[];matchingRegions?:number[]};
export type ParcelFilterGrid={id:number;means:Float32Array;weights:Float32Array};
export type ParcelFilterDiscovery={format:typeof PARCEL_FILTER_FORMAT;sourceSnapshot:string;metadata:FileRef};
export const parcelRangeKey=(low:number,high:number)=>`${String(low).padStart(2,'0')}-${String(high).padStart(2,'0')}`;
export const parcelFilterMetadataPath=(hash:string)=>`metrics/parcel-filters/index.${hash}.pb`;
export const parcelFilterIndexPath=(low:number,high:number,hash:string)=>`metrics/parcel-filters/range-${parcelRangeKey(low,high)}/index.${hash}.pb`;
export const parcelFilterBatchPath=(low:number,high:number,tile:number,hash:string)=>`metrics/parcel-filters/range-${parcelRangeKey(low,high)}/t${String(tile).padStart(4,'0')}.${hash}.pb`;
const hashValid=(s:string)=>/^[a-f0-9]{64}$/.test(s);
export const validParcelFilterPath=(url:string,hash:string)=>hashValid(hash)&&new RegExp(`^metrics/parcel-filters/(?:index\\.${hash}|range-0[1-9]-0[1-9]/(?:index|t[0-9]{4})\\.${hash})\\.pb$`).test(url);
const f=(type:string,id:number,repeated=false)=>({type,id,...(repeated?{rule:'repeated',options:{packed:true}}:{})});
const schema=protobuf.Root.fromJSON({nested:{
    Ref:{fields:{url:f('string',1),sha256:f('string',2),bytes:f('uint32',3)}},
    Range:{fields:{low:f('uint32',1),high:f('uint32',2),url:f('string',3),sha256:f('string',4),bytes:f('uint32',5)}},
    Metadata:{fields:{version:f('uint32',1),format:f('string',2),sourceSnapshot:f('string',3),count:f('uint32',4),parent:f('Ref',5),regionCounts:f('uint32',6,true),masks:f('uint32',7,true),ranges:f('Range',8,true)}},
    BatchRef:{fields:{tile:f('uint32',1),ids:f('uint32',2,true),url:f('string',3),sha256:f('string',4),bytes:f('uint32',5)}},
    Index:{fields:{version:f('uint32',1),sourceSnapshot:f('string',2),parentSha256:f('string',3),low:f('uint32',4),high:f('uint32',5),batches:f('BatchRef',6,true)}},
    Grid:{fields:{id:f('uint32',1),means:f('float',2,true),weights:f('float',3,true)}},
    Batch:{fields:{version:f('uint32',1),low:f('uint32',2),high:f('uint32',3),tile:f('uint32',4),grids:f('Grid',5,true)}}
}});
const metadataType=schema.lookupType('Metadata'),indexType=schema.lookupType('Index'),batchType=schema.lookupType('Batch');
const validRange=(low:number,high:number)=>integer(low,1,9)&&integer(high,low,9);
function validRef(ref:FileRef,limit=PARCEL_FILTER_LIMIT){return ref&&hashValid(ref.sha256)&&integer(ref.bytes,1,limit)&&validParcelFilterPath(ref.url,ref.sha256);}
export function validateParcelFilterMetadata(m:ParcelFilterMetadata,snapshot:string,count:number){
    check(m.version===1&&m.format===PARCEL_FILTER_FORMAT&&m.sourceSnapshot===snapshot&&m.count===count&&integer(count,1,1048576),'Parcel filter identity mismatch');
    check(m.parent&&hashValid(m.parent.sha256)&&m.parent.url===`bitmaps/summaries/aggregates/index.${m.parent.sha256}.pb`&&integer(m.parent.bytes,1,200*1024),'Invalid parcel filter parent');
    check(m.regionCounts.length===Math.ceil(count/2016)*9&&m.regionCounts.every(n=>integer(n,0,2016*262144))&&m.masks.length===512&&m.masks[0]===0&&m.masks.every(n=>integer(n,0,count))&&m.masks.reduce((a,b)=>a+b,0)===count,'Invalid parcel filter totals');
    for(let region=0;region<m.regionCounts.length/9;region++){const bitmaps=Math.min(2016,count-region*2016),total=m.regionCounts.slice(region*9,region*9+9).reduce((a,b)=>a+b,0);check(total>=bitmaps&&total<=bitmaps*262144,'Invalid regional parcel count');}
    const keys=new Set<string>();check(m.ranges.length===44,'Incomplete parcel filter ranges');
    for(const r of m.ranges){const key=parcelRangeKey(r.low,r.high);check(validRange(r.low,r.high)&&!(r.low===1&&r.high===9)&&!keys.has(key)&&validRef(r)&&r.url===parcelFilterIndexPath(r.low,r.high,r.sha256),'Invalid parcel filter range');keys.add(key);}return m;
}
export function encodeParcelFilterMetadata(m:ParcelFilterMetadata){validateParcelFilterMetadata(m,m.sourceSnapshot,m.count);const b=metadataType.encode(m).finish();check(b.length<=PARCEL_FILTER_LIMIT,'Parcel filter metadata exceeds budget');return b;}
export async function decodeParcelFilterMetadata(b:Uint8Array,ref:FileRef,snapshot:string,count:number){check(b.length===ref.bytes&&b.length<=PARCEL_FILTER_LIMIT&&await sha256(b)===ref.sha256,'Parcel filter metadata integrity failure');return validateParcelFilterMetadata(metadataType.toObject(metadataType.decode(b),{arrays:true,defaults:true}) as ParcelFilterMetadata,snapshot,count);}
export function validateParcelFilterDiscovery(d:ParcelFilterDiscovery,snapshot:string){check(d?.format===PARCEL_FILTER_FORMAT&&d.sourceSnapshot===snapshot&&validRef(d.metadata)&&d.metadata.url===parcelFilterMetadataPath(d.metadata.sha256),'Invalid parcel filter discovery');return d;}
export function validateParcelFilterIndex(index:ParcelFilterIndex,metadata:ParcelFilterMetadata,ref:ParcelRangeRef){
    check(index.version===1&&index.sourceSnapshot===metadata.sourceSnapshot&&index.parentSha256===metadata.parent.sha256&&index.low===ref.low&&index.high===ref.high,'Parcel filter range identity mismatch');
    const ids=new Set<number>(),tiles=new Set<number>(),regions=Math.ceil(metadata.count/2016);
    check(index.batches.length>0&&index.batches.length<=regions,'Invalid parcel filter batch count');
    for(const b of index.batches){check(integer(b.tile,0,520)&&!tiles.has(b.tile)&&b.ids.length>0&&b.ids.length<=6&&validRef(b,PARCEL_FILTER_BATCH_LIMIT)&&b.url===parcelFilterBatchPath(index.low,index.high,b.tile,b.sha256),'Invalid parcel filter batch');tiles.add(b.tile);for(const id of b.ids){check(integer(id,0,regions-1)&&!ids.has(id),'Duplicate parcel filter region');ids.add(id);}}
    check(ids.size===regions,'Missing parcel filter regions');return index;
}
export function encodeParcelFilterIndex(index:ParcelFilterIndex){const b=indexType.encode(index).finish();check(b.length<=PARCEL_FILTER_LIMIT,'Parcel filter index exceeds budget');return b;}
export async function decodeParcelFilterIndex(b:Uint8Array,ref:ParcelRangeRef,m:ParcelFilterMetadata){check(b.length===ref.bytes&&b.length<=PARCEL_FILTER_LIMIT&&await sha256(b)===ref.sha256,'Parcel filter index integrity failure');return validateParcelFilterIndex(indexType.toObject(indexType.decode(b),{arrays:true,defaults:true}) as ParcelFilterIndex,m,ref);}
export function encodeParcelFilterBatch(low:number,high:number,tile:number,grids:ParcelFilterGrid[]){
    check(validRange(low,high)&&grids.length>0&&grids.length<=6,'Invalid parcel filter batch');
    for(const g of grids)check(integer(g.id,0,520)&&g.means.length>0&&g.means.length<=256&&g.means.length===g.weights.length&&g.means.every(v=>Number.isFinite(v)&&v>=1&&v<=9)&&g.weights.every(v=>Number.isFinite(v)&&v>=0),'Invalid parcel filter grid');
    const b=batchType.encode({version:1,low,high,tile,grids:grids.map(g=>({id:g.id,means:Array.from(g.means),weights:Array.from(g.weights)}))}).finish();check(b.length<=PARCEL_FILTER_BATCH_LIMIT,'Parcel filter batch exceeds budget');return b;
}
export async function decodeParcelFilterBatch(b:Uint8Array,ref:ParcelFilterBatchRef,index:ParcelFilterIndex,dimensions:readonly {width:number;height:number}[]){
    check(index.batches.some(r=>r.url===ref.url&&r.sha256===ref.sha256&&r.bytes===ref.bytes&&r.ids.join(',')===ref.ids.join(',')),'Foreign parcel filter batch');
    check(b.length===ref.bytes&&b.length<=PARCEL_FILTER_BATCH_LIMIT&&await sha256(b)===ref.sha256,'Parcel filter batch integrity failure');
    const value=batchType.toObject(batchType.decode(b),{arrays:true,defaults:true});check(value.version===1&&value.low===index.low&&value.high===index.high&&value.tile===ref.tile&&value.grids.length===ref.ids.length,'Invalid parcel filter batch identity');
    return value.grids.map((g:ParcelFilterGrid,i:number)=>{const d=dimensions[ref.ids[i]],cells=Math.min(16,d.width)*Math.min(16,d.height);check(g.id===ref.ids[i]&&g.means.length===cells&&g.weights.length===cells,'Parcel filter grid mismatch');
        for(let c=0;c<cells;c++)check(Number.isFinite(g.means[c])&&g.means[c]>=1&&g.means[c]<=9&&Number.isFinite(g.weights[c])&&g.weights[c]>=0,'Invalid parcel filter values');return {id:g.id,means:Float32Array.from(g.means),weights:Float32Array.from(g.weights)};
    }) as ParcelFilterGrid[];
}
export function buildParcelFilterGrid(page:Lod4Region,classes:Uint32Array,low:number,high:number):ParcelFilterGrid{
    const result=parcelClassFilter(classes,page.bitmapAreas.length,low,high,true),cells=page.columns*page.rows,means=new Float32Array(cells).fill(1),weights=new Float32Array(cells);
    for(let c=0;c<cells;c++){let bitmap=0,sum=0,selected=0;for(let i=page.cellOffsets[c];i<page.cellOffsets[c+1];i++){bitmap+=page.memberDeltas[i];const fraction=page.overlapAreas[i]/page.bitmapAreas[bitmap],w=result.occupiedAreas![bitmap]*result.pixels[bitmap*2+1]*fraction;selected+=w;sum+=result.pixels[bitmap*2]*w;}means[c]=selected?sum/selected:1;weights[c]=selected;}
    return {id:page.id,means,weights};
}
/** Exact whole-dataset counts from compact histograms, independent of the viewport. */
export function parcelFilterTotals(m:ParcelFilterMetadata,low:number,high:number){
    check(validRange(low,high),'Invalid parcel range');const mask=((1<<high)-1)^((1<<(low-1))-1);
    let bitmapMatches=0,parcelMatches=0,selectedArea=0,totalArea=0;
    for(let bits=1;bits<512;bits++)if(bits&mask)bitmapMatches+=m.masks[bits];
    const neighborhoodMeans:number[]=[],neighborhoodCoverage:number[]=[];
    for(let region=0;region<m.regionCounts.length/9;region++){let total=0,selected=0,sum=0;for(let j=0;j<9;j++){const n=m.regionCounts[region*9+j],area=n*(j+1)**2;total+=area;if(j+1>=low&&j+1<=high){selected+=area;sum+=area*(j+1);parcelMatches+=n;}}totalArea+=total;selectedArea+=selected;neighborhoodMeans.push(selected?sum/selected:1);neighborhoodCoverage.push(selected/total);}
    return {bitmapMatches,parcelMatches,selectedArea,totalArea,neighborhoodMeans,neighborhoodCoverage};
}
