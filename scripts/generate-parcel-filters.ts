import { mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { openPublishedMap } from './published-map';
import { datasetPath, isSemanticDataset } from './dataset-path';
import { editSemanticDataset } from './semantic-dataset';
import { appendFile } from './publish-release';
import { newDestination } from './generate-lod4';
import { aggregateGroups } from './generate-lod4-summaries';
import { argumentsFor } from './cli';
import { check, sha256, type FileRef } from '../src/shared/httpPack';
import { buildLod4Region } from '../src/shared/lod4';
import { decodeAggregateIndex, validateAggregateDiscovery, type AggregateIndex } from '../src/shared/lod4Aggregates';
import { decodeSpatialMetricPage, validateSpatialMetricsIndex, type SpatialMetricsIndex } from '../src/shared/spatialMetrics';
import { PARCEL_FILTER_FORMAT, buildParcelFilterGrid, encodeParcelFilterBatch, encodeParcelFilterIndex, encodeParcelFilterMetadata,
    decodeParcelFilterBatch, decodeParcelFilterIndex, decodeParcelFilterMetadata, parcelFilterBatchPath, parcelFilterIndexPath, parcelFilterMetadataPath,
    validateParcelFilterDiscovery, type ParcelFilterMetadata, type ParcelFilterIndex, type ParcelFilterDiscovery } from '../src/shared/parcelFilters';
async function context(sourceDirectory:string){
    const source=await openPublishedMap(sourceDirectory),read=async(ref:FileRef)=>{const path=await realpath(datasetPath(source.root,ref.url));check(path.startsWith(source.root+sep),'Parcel filter input escapes source');const bytes=new Uint8Array(await readFile(path));check(bytes.length===ref.bytes&&await sha256(bytes)===ref.sha256,'Parcel filter input integrity failure');return bytes;};
    const metrics=await Bun.file(datasetPath(source.root,'metrics.json')).json() as SpatialMetricsIndex;validateSpatialMetricsIndex(metrics,source.manifest.snapshot,source.manifest.publishedHeight+1);
    const discovery=validateAggregateDiscovery(await Bun.file(datasetPath(source.root,'lod4-summary.json')).json(),source.manifest.snapshot),parent=await decodeAggregateIndex(await read(discovery.index),source.manifest.snapshot,discovery.index);
    const input=async(id:number)=>{const canonical=source.neighborhood(id),m=metrics.regions[id];check(parent.regions[id].geometrySha256===canonical.ref.sha256&&parent.regions[id].metricsSha256===m.sha256,'Parcel filter parent differs from source');return {page:buildLod4Region(canonical.data,canonical.ref.sha256),metrics:decodeSpatialMetricPage(await read(m),id,canonical.data.bitmaps.length)};};
    return {source,parent,parentRef:discovery.index,input};
}
function accumulate(classes:Uint32Array,region:number,counts:number[],masks:number[]){
    for(let id=0;id<classes.length/9;id++){let mask=0;for(let j=0;j<9;j++){const n=classes[id*9+j];counts[region*9+j]+=n;if(n)mask|=1<<j;}masks[mask]++;}
}
export async function generateParcelFilters(sourceDirectory:string,outDirectory:string){
    const {source,parent,parentRef,input}=await context(sourceDirectory),out=await newDestination(outDirectory);
    check(out!==source.root&&!out.startsWith(source.root+sep)&&!source.root.startsWith(out+sep),'Use a separate new parcel filter output');await mkdir(dirname(out),{recursive:true});await mkdir(out,{recursive:false});
    const metadata:ParcelFilterMetadata={version:1,format:PARCEL_FILTER_FORMAT,sourceSnapshot:source.manifest.snapshot,count:source.manifest.publishedHeight+1,parent:parentRef,regionCounts:Array(parent.regions.length*9).fill(0),masks:Array(512).fill(0),ranges:[]};
    const indexes:ParcelFilterIndex[]=[];for(let low=1;low<=9;low++)for(let high=low;high<=9;high++)if(low!==1||high!==9)indexes.push({version:1,sourceSnapshot:metadata.sourceSnapshot,parentSha256:parentRef.sha256,low,high,batches:[]});
    for(const [tile,ids] of aggregateGroups(parent.regions).entries()){
        const inputs=new Map<number,Awaited<ReturnType<typeof input>>>();for(const id of ids){const value=await input(id);inputs.set(id,value);accumulate(value.metrics.classes,id,metadata.regionCounts,metadata.masks);}
        for(const index of indexes){const grids=ids.map(id=>{const p=inputs.get(id)!;return buildParcelFilterGrid(p.page,p.metrics.classes,index.low,index.high);}),bytes=encodeParcelFilterBatch(index.low,index.high,tile,grids),hash=await sha256(bytes),url=parcelFilterBatchPath(index.low,index.high,tile,hash);await appendFile(out,url,bytes);index.batches.push({tile,ids,url,sha256:hash,bytes:bytes.length});}
    }
    for(const index of indexes){const bytes=encodeParcelFilterIndex(index),hash=await sha256(bytes),url=parcelFilterIndexPath(index.low,index.high,hash);await appendFile(out,url,bytes);metadata.ranges.push({low:index.low,high:index.high,url,sha256:hash,bytes:bytes.length});}
    const bytes=encodeParcelFilterMetadata(metadata),hash=await sha256(bytes),url=parcelFilterMetadataPath(hash);await appendFile(out,url,bytes);
    const discovery:ParcelFilterDiscovery={format:PARCEL_FILTER_FORMAT,sourceSnapshot:metadata.sourceSnapshot,metadata:{url,sha256:hash,bytes:bytes.length}};
    source.assertUnchanged();await writeFile(resolve(out,'parcel-filters.json'),JSON.stringify(discovery)+'\n',{flag:'wx'});
    const first=indexes.find(r=>r.low===7&&r.high===9)!;return {metadataBytes:bytes.length,ranges:indexes.length,batchesPerRange:first.batches.length,rangeBytes:first.batches.reduce((sum,r)=>sum+r.bytes,0),maxBatchBytes:Math.max(...first.batches.map(r=>r.bytes))};
}
export type ParcelFilterBaseline={metadata:ParcelFilterMetadata;parent:AggregateIndex;indexes:ParcelFilterIndex[];reuse:(ref:FileRef)=>Promise<void>};
export async function validateParcelFilters(sourceDirectory:string,metadata:ParcelFilterMetadata,read:(ref:FileRef)=>Promise<Uint8Array>,baseline?:ParcelFilterBaseline,progress?:(completed:number,total:number)=>void){
    const {source,parent,parentRef,input}=await context(sourceDirectory);check(metadata.parent.sha256===parentRef.sha256,'Parcel filter aggregate binding mismatch');
    const unchanged=(id:number)=>!!baseline&&JSON.stringify(parent.regions[id])===JSON.stringify(baseline.parent.regions[id]);
    const prefix=baseline&&baseline.parent.regions.length<=parent.regions.length&&baseline.parent.regions.every((_r,id)=>unchanged(id));
    const counts=prefix?[...baseline!.metadata.regionCounts,...Array((parent.regions.length-baseline!.parent.regions.length)*9).fill(0)]:Array(parent.regions.length*9).fill(0),masks=prefix?[...baseline!.metadata.masks]:Array(512).fill(0);
    const cache=new Map<number,Awaited<ReturnType<typeof input>>>(),get=async(id:number)=>{let value=cache.get(id);if(!value){value=await input(id);cache.set(id,value);}return value;};
    const groups=aggregateGroups(parent.regions),total=metadata.ranges.length*groups.length;
    let completed=0;progress?.(completed,total);
    for(let id=prefix?baseline!.parent.regions.length:0;id<parent.regions.length;id++)accumulate((await get(id)).metrics.classes,id,counts,masks);
    check(counts.join(',')===metadata.regionCounts.join(',')&&masks.join(',')===metadata.masks.join(','),'Parcel filter totals differ from source');
    const indexes:ParcelFilterIndex[]=[];
    for(const ref of metadata.ranges){
        const index=await decodeParcelFilterIndex(await read(ref),ref,metadata);indexes.push(index);const prior=baseline?.indexes.find(i=>i.low===index.low&&i.high===index.high);
        for(const batch of index.batches){
            check(batch.ids.join(',')===groups[batch.tile]?.join(','),'Parcel filter spatial grouping mismatch');
            if(prefix&&batch.ids.every(id=>unchanged(id))&&prior?.batches.some(b=>b.url===batch.url&&b.sha256===batch.sha256&&b.bytes===batch.bytes&&b.ids.join(',')===batch.ids.join(','))){await baseline!.reuse(batch);progress?.(++completed,total);continue;}
            const bytes=await read(batch);await decodeParcelFilterBatch(bytes,batch,index,parent.regions);
            const grids=[];for(const id of batch.ids){const p=await get(id);grids.push(buildParcelFilterGrid(p.page,p.metrics.classes,index.low,index.high));}
            check(await sha256(encodeParcelFilterBatch(index.low,index.high,batch.tile,grids))===batch.sha256,'Parcel filter cells differ from source');
            progress?.(++completed,total);
        }
    }
    source.assertUnchanged();return {parent,indexes};
}
export async function installParcelFilters(bundle:string,target:string):Promise<void>{
    if(isSemanticDataset(target))return editSemanticDataset(target,logical=>installParcelFilters(bundle,logical));
    const root=await realpath(resolve(bundle)),read=async(ref:FileRef)=>{const path=await realpath(resolve(root,ref.url));check(path.startsWith(root+sep),'Parcel filter bundle escapes root');return new Uint8Array(await readFile(path));};
    const {manifest}=await openPublishedMap(target),discovery=validateParcelFilterDiscovery(await Bun.file(resolve(root,'parcel-filters.json')).json(),manifest.snapshot),metadata=await decodeParcelFilterMetadata(await read(discovery.metadata),discovery.metadata,manifest.snapshot,manifest.publishedHeight+1);
    const {indexes}=await validateParcelFilters(target,metadata,read);
    for(const ref of [discovery.metadata,...metadata.ranges,...indexes.flatMap(i=>i.batches)])await appendFile(target,ref.url,await read(ref));
    const temp=resolve(target,`.parcel-filters-${crypto.randomUUID()}.json`);await writeFile(temp,JSON.stringify(discovery)+'\n',{flag:'wx'});await rename(temp,resolve(target,'parcel-filters.json'));
}
if(import.meta.main){const args=argumentsFor(process.argv.slice(2),['--source','--out','--install']);check(args['--source']&&args['--out'],'Use --source MAP_DATA --out NEW_DIRECTORY [--install true]');check(!args['--install']||args['--install']==='true','Use --install true');const report=await generateParcelFilters(args['--source'],args['--out']);if(args['--install'])await installParcelFilters(args['--out'],args['--source']);console.log(JSON.stringify(report));}
