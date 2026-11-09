import { mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { openPublishedMap } from './published-map';
import { datasetPath, isSemanticDataset } from './dataset-path';
import { editSemanticDataset } from './semantic-dataset';
import { appendFile } from './publish-release';
import { argumentsFor } from './cli';
import { check, sha256, type FileRef } from '../src/shared/httpPack';
import { buildLod4Region } from '../src/shared/lod4';
import { decodeSpatialMetricPage, validateSpatialMetricsIndex, type SpatialMetricsIndex } from '../src/shared/spatialMetrics';
import { LOD4_AGGREGATES_FORMAT, LOD4_BATCH_REGIONS, LOD4_MODES, aggregateBatchPath, aggregateIndexPath,
    buildAggregateRegion, decodeAggregateBatch, decodeAggregateIndex, encodeAggregateBatch, encodeAggregateIndex,
    validateAggregateDiscovery, type AggregateDiscovery, type AggregateIndex, type AggregateRegion } from '../src/shared/lod4Aggregates';
import SpiralLayout from '../src/shared/SpiralLayout';
import { newDestination } from './generate-lod4';

async function inputs(sourceDirectory:string){
    const source=await openPublishedMap(sourceDirectory),metrics=await Bun.file(datasetPath(source.root,'metrics.json')).json() as SpatialMetricsIndex;
    validateSpatialMetricsIndex(metrics,source.manifest.snapshot,source.manifest.publishedHeight+1);
    const read=async(ref:FileRef)=>{
        const name=await realpath(datasetPath(source.root,ref.url));check(name.startsWith(source.root+sep),'Aggregate input escapes dataset');
        const bytes=new Uint8Array(await readFile(name));check(bytes.length===ref.bytes&&await sha256(bytes)===ref.sha256,'Aggregate input integrity failure');return bytes;
    };
    return {source,metrics,read};
}
// Fixed signed integer coordinates avoid dataset-dependent Morton normalization.
function morton(x:number,y:number){
    let result=0n;const a=BigInt(Math.floor(x)+0x80000000),b=BigInt(Math.floor(y)+0x80000000);
    for(let bit=0n;bit<32n;bit++)result|=((a>>bit)&1n)<<(bit*2n)|((b>>bit)&1n)<<(bit*2n+1n);return result;
}
export function aggregateGroups(regions:readonly {width:number;height:number}[]){
    const order=new SpiralLayout(regions).slots.map((r,id)=>({id,key:morton(r.x+r.width/2,r.y+r.height/2)})).sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:a.id-b.id);
    return Array.from({length:Math.ceil(order.length/LOD4_BATCH_REGIONS)},(_,i)=>order.slice(i*LOD4_BATCH_REGIONS,(i+1)*LOD4_BATCH_REGIONS).map(r=>r.id));
}

/** Generate palette-independent aggregates from authenticated geometry and local metric pages. */
export async function generateLod4Summaries(sourceDirectory:string,outDirectory:string){
    const {source,metrics,read}=await inputs(sourceDirectory),out=await newDestination(outDirectory);
    check(out!==source.root&&!out.startsWith(source.root+sep)&&!source.root.startsWith(out+sep),'Use a separate new aggregate output');
    await mkdir(dirname(out),{recursive:true});check(await realpath(dirname(out))===dirname(out),'Aggregate output cannot traverse symlinks');await mkdir(out,{recursive:false});
    const index:AggregateIndex={version:2,format:LOD4_AGGREGATES_FORMAT,sourceSnapshot:source.manifest.snapshot,gridSide:16,
        regions:source.manifest.regions.map(r=>({id:r.id,width:r.width,height:r.height,geometrySha256:r.geometry!.sha256,metricsSha256:metrics.regions[r.id].sha256})),batches:[]};
    for(const [tile,ids] of aggregateGroups(index.regions).entries()){
        const pages=new Map<number,{page:ReturnType<typeof buildLod4Region>;metrics:ReturnType<typeof decodeSpatialMetricPage>}>();
        for(const id of ids){const canonical=source.neighborhood(id);pages.set(id,{page:buildLod4Region(canonical.data,canonical.ref.sha256),metrics:decodeSpatialMetricPage(await read(metrics.regions[id]),id,canonical.data.bitmaps.length)});}
        for(const mode of LOD4_MODES){
            const regions=ids.map(id=>{const p=pages.get(id)!;return buildAggregateRegion(p.page,mode,p.metrics);}),bytes=encodeAggregateBatch(mode,tile,regions),hash=await sha256(bytes),url=aggregateBatchPath(mode,tile,hash);
            await appendFile(out,url,bytes);index.batches.push({mode,tile,ids,url,sha256:hash,bytes:bytes.length});
        }
    }
    const bytes=encodeAggregateIndex(index),hash=await sha256(bytes),url=aggregateIndexPath(hash);
    await appendFile(out,url,bytes);
    const discovery:AggregateDiscovery={format:LOD4_AGGREGATES_FORMAT,sourceSnapshot:index.sourceSnapshot,index:{url,sha256:hash,bytes:bytes.length}};
    source.assertUnchanged();await writeFile(resolve(out,'lod4-summary.json'),JSON.stringify(discovery)+'\n',{flag:'wx'});
    const report={format:LOD4_AGGREGATES_FORMAT,snapshot:index.sourceSnapshot,gridSide:16,regions:index.regions.length,indexBytes:bytes.length,
        modes:Object.fromEntries(LOD4_MODES.map(mode=>{const batches=index.batches.filter(b=>b.mode===mode);return [mode,{files:batches.length,bytes:batches.reduce((s,b)=>s+b.bytes,0),min:Math.min(...batches.map(b=>b.bytes)),max:Math.max(...batches.map(b=>b.bytes))}];}))};
    await writeFile(resolve(out,'lod4-summary-report.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});return report;
}

/** Validate byte-for-byte against source statistics; baseline reuse never opens inherited payloads. */
export async function validateLod4Summaries(sourceDirectory:string,index:AggregateIndex,read:(ref:FileRef)=>Promise<Uint8Array>,reuse?:{index:AggregateIndex;file:(ref:FileRef)=>Promise<void>},progress?:(completed:number,total:number)=>void){
    const source=await openPublishedMap(sourceDirectory),metrics=await Bun.file(datasetPath(source.root,'metrics.json')).json() as SpatialMetricsIndex;
    validateSpatialMetricsIndex(metrics,source.manifest.snapshot,source.manifest.publishedHeight+1);
    check(index.sourceSnapshot===source.manifest.snapshot&&index.regions.length===source.manifest.regions.length,'Aggregate source coverage mismatch');
    index.regions.forEach((r,id)=>{const original=source.manifest.regions[id];check(r.width===original.width&&r.height===original.height&&r.geometrySha256===original.geometry!.sha256&&r.metricsSha256===metrics.regions[id].sha256,'Aggregate source binding mismatch');});
    const groups=aggregateGroups(index.regions);
    let completed=0;progress?.(completed,index.batches.length);
    for(const ref of index.batches){
        check(ref.ids.join(',')===groups[ref.tile]?.join(','),'Aggregate spatial grouping mismatch');
        const prior=reuse?.index.batches.find(b=>b.url===ref.url);
        if(prior&&prior.sha256===ref.sha256&&prior.bytes===ref.bytes&&prior.ids.join(',')===ref.ids.join(',')&&ref.ids.every(id=>JSON.stringify(index.regions[id])===JSON.stringify(reuse!.index.regions[id]))){await reuse!.file(ref);progress?.(++completed,index.batches.length);continue;}
        const bytes=await read(ref);await decodeAggregateBatch(bytes,ref,index);const regions:AggregateRegion[]=[];
        for(const id of ref.ids){
            const canonical=source.neighborhood(id),page=buildLod4Region(canonical.data,canonical.ref.sha256),m=metrics.regions[id];
            const payload=new Uint8Array(await readFile(datasetPath(source.root,m.url)));check(payload.length===m.bytes&&await sha256(payload)===m.sha256,'Aggregate metric integrity failure');
            regions.push(buildAggregateRegion(page,ref.mode,decodeSpatialMetricPage(payload,id,canonical.data.bitmaps.length)));
        }
        check(await sha256(encodeAggregateBatch(ref.mode,ref.tile,regions))===ref.sha256,'Aggregate values differ from canonical statistics');
        progress?.(++completed,index.batches.length);
    }
    source.assertUnchanged();
}
export async function installLod4Summaries(bundle:string,target:string):Promise<void>{
    if(isSemanticDataset(target))return editSemanticDataset(target,typed=>installLod4Summaries(bundle,typed));
    const input=await realpath(resolve(bundle)),read=async(ref:FileRef)=>{const path=await realpath(resolve(input,ref.url));check(path.startsWith(input+sep),'Aggregate bundle escapes root');return new Uint8Array(await readFile(path));};
    const {manifest}=await openPublishedMap(target),discovery=validateAggregateDiscovery(await Bun.file(resolve(input,'lod4-summary.json')).json(),manifest.snapshot),bytes=await read(discovery.index),index=await decodeAggregateIndex(bytes,manifest.snapshot,discovery.index);
    await validateLod4Summaries(target,index,read);
    for(const ref of [...index.batches,discovery.index])await appendFile(target,ref.url,await read(ref));
    const temporary=resolve(target,`.lod4-summary-${crypto.randomUUID()}.json`);await writeFile(temporary,JSON.stringify(discovery)+'\n',{flag:'wx'});await rename(temporary,resolve(target,'lod4-summary.json'));
}
if(import.meta.main){const args=argumentsFor(process.argv.slice(2),['--source','--out','--install']);check(args['--source']&&args['--out'],'Use --source MAP_DATA --out NEW_DIRECTORY [--install true]');check(!args['--install']||args['--install']==='true','Use --install true');const report=await generateLod4Summaries(args['--source'],args['--out']);if(args['--install'])await installLod4Summaries(args['--out'],args['--source']);console.log(JSON.stringify(report));}
