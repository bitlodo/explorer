import {isSemanticDataset} from './dataset-path';
import {editSemanticDataset} from './semantic-dataset';
import {datasetPath} from './dataset-path';
import {encodePatternPage} from '../src/shared/patternPages';
import { mkdir, writeFile, readFile, rename, unlink } from 'node:fs/promises';
import { resolve, sep, dirname } from 'node:path';
import protobuf from 'protobufjs';
import geometryDescriptor from '../src/shared/proto/neighborhood_descriptor.json';
import { ANALYTICS_FORMAT, METRIC_IDS, encodeMetric, encodeInspection, decodeInspection, normalizeMetric, validateAnalyticsIndex, type AnalyticsIndex, type BitmapInspection, type MetricId } from '../src/shared/mapAnalytics';
import { check, sha256, type FileRef } from '../src/shared/httpPack';
import { createPreviewCodec } from '../src/shared/heatmapPreview';
import { dataPath } from '../src/shared/dataStorage';
import { readMapManifest } from './read-map-manifest';
import { Database, OPEN_READONLY } from './duckdb';
import { generatePreviews } from './generate-previews';
import { argumentsFor } from './cli';

/** READ_ONLY reference -> a new, independently versioned analytical addon. */
export async function generateAnalytics(sourceArg: string, database: string, outArg: string, previous?: string) {
    const source = resolve(sourceArg), out = resolve(outArg);
    check(out !== source && !out.startsWith(source+sep) && !source.startsWith(out+sep), 'Use a separate new analytics destination');
    const manifest = (await readMapManifest(source)).manifest, count = manifest.publishedHeight+1;
    check(count <= 1048576, 'Analytics exceeds the v1 bitmap budget');
    await mkdir(out, { recursive: false });
    const artifacts = resolve(out,'colors'); await mkdir(artifacts);
    const put = async (bytes: Uint8Array): Promise<FileRef> => {
        const hash = await sha256(bytes), url = hash+'.pb', file = resolve(artifacts,url);
        if (!await Bun.file(file).exists()) await writeFile(file,bytes,{flag:'wx'});
        return { url, sha256: hash, bytes: bytes.length };
    };
    const db = await Database.create(database,OPEN_READONLY), metrics = Object.fromEntries(METRIC_IDS.map(id=>[id,new Float32Array(count)])) as Record<MetricId,Float32Array>;
    const index: AnalyticsIndex = { format: ANALYTICS_FORMAT, sourceSnapshot: manifest.snapshot, count, parcels:0, patterns:0, regions:[], metrics:{} as AnalyticsIndex['metrics'] };
    try {
        await db.exec("SET threads=2; SET memory_limit='512MB'; BEGIN TRANSACTION");
        const prior: AnalyticsIndex|undefined=previous&&await Bun.file(datasetPath(previous,'analytics.json')).exists()?await Bun.file(datasetPath(previous,'analytics.json')).json():undefined;
        if(prior){const old=(await readMapManifest(previous!)).manifest;validateAnalyticsIndex(prior,old.snapshot,old.publishedHeight+1);check(prior.count<=count,'Analytics prefix exceeds target');}
        const priorRegion=async(id:number)=>{
            const ref=prior!.regions[id],bytes=new Uint8Array(await readFile(datasetPath(previous!,'colors',ref.url)));
            check(bytes.length===ref.bytes&&await sha256(bytes)===ref.sha256,'Prior analytics integrity failure');
            return decodeInspection(bytes,id,Math.min(2016,prior!.count-id*2016));
        };
        const frequencies = new Map<number,number>();
        if(prior)for(let id=0;id<prior.regions.length;id++)for(const row of await priorRegion(id))frequencies.set(row.pattern,(frequencies.get(row.pattern)??0)+1);
        for (const row of await db.all('SELECT pattern,count(*) AS n FROM bitmaps WHERE bitmap>=? AND bitmap<=? GROUP BY pattern',prior?.count??0,manifest.publishedHeight)) frequencies.set(Number(row.pattern),(frequencies.get(Number(row.pattern))??0)+Number(row.n));
        index.patterns = frequencies.size;
        const members=new Map<number,number[]>();
        index.regionEncoding='inspection-local-v2';index.patternPages={};
        const type = protobuf.Root.fromJSON(geometryDescriptor).lookupType('Neighborhood');
        for (const region of manifest.regions) {
            const bytes = new Uint8Array(await readFile(datasetPath(source,region.geometry.url)));
            check(bytes.length===region.geometry.bytes && await sha256(bytes)===region.geometry.sha256,'Analytics geometry integrity failure');
            const canonical = type.toObject(type.decode(bytes),{arrays:true,defaults:true}) as any;
            const rows = prior&&region.id<prior.regions.length
                ?(await priorRegion(region.id)).map(row=>({bitmap:row.id,size:[row.width,row.height],pattern:row.pattern,histogram:row.histogram.map((n,i)=>({key:i+1,value:n}))}))
                :await db.all('SELECT bitmap,size,pattern,list_histogram(tx) AS histogram FROM bitmaps WHERE bitmap>=? AND bitmap<? ORDER BY bitmap',region.id*2016,(region.id+1)*2016);
            check(rows.length===2016 && canonical.neighborhood===region.id && canonical.bitmaps.length===rows.length,'Missing analytics neighborhood');
            const inspections: BitmapInspection[] = [];
            for (let i=0;i<rows.length;i++) {
                const row=rows[i], id=region.id*2016+i, histogram=Array<number>(9).fill(0), rect=canonical.bitmaps[i];
                check(row.bitmap===id && row.size[0]===rect.width && row.size[1]===rect.height,'Analytics source geometry differs from published snapshot');
                for (const entry of row.histogram) { const size=Number(entry.key), n=Number(entry.value); check(Number.isInteger(size)&&size>=1&&size<=9,'Unsupported parcel class'); histogram[size-1]=n; }
                const n=histogram.reduce((a,b)=>a+b,0), meanSize=histogram.reduce((a,b,j)=>a+b*(j+1),0)/n;
                const occupied=histogram.reduce((a,b,j)=>a+b*(j+1)**2,0), occupancy=occupied/(rect.width*rect.height);
                const diversity=-histogram.reduce((sum,nc)=>{const p=nc/n;return sum+(p?p*Math.log2(p):0);},0);
                const pattern=Number(row.pattern), occurrences=frequencies.get(pattern)!;
                if(!members.has(pattern))members.set(pattern,[]);members.get(pattern)!.push(id);
                inspections.push({id,width:rect.width,height:rect.height,count:n,meanSize,composition:histogram[0]/n,diversity,occupancy,pattern,occurrences,histogram});
                metrics.count[id]=n; metrics.composition[id]=histogram[0]/n; metrics.diversity[id]=Math.max(0,diversity); metrics.occupancy[id]=occupancy;
                metrics.shape[id]=Math.max(rect.width,rect.height)/Math.min(rect.width,rect.height); metrics.rarity[id]=occurrences; metrics.chronology[id]=id;
                index.parcels+=n;
            }
            const mean=inspections.reduce((s,r)=>s+r.count,0)/inspections.length;
            const std=Math.sqrt(inspections.reduce((s,r)=>s+(r.count-mean)**2,0)/inspections.length);
            for (const row of inspections) metrics.anomaly[row.id]=std?Math.abs(row.count-mean)/std:0;
            const encoded=encodeInspection(region.id,inspections,true);decodeInspection(encoded,region.id,inspections.length);
            index.regions.push(await put(encoded));
            if(region.id%40===0)console.log(`Analytics: ${region.id+1}/${manifest.regions.length} neighborhoods`);
        }
        const buckets=new Map<number,Map<number,number[]>>();
        for(const [pattern,ids] of members){const bucket=Math.floor(pattern/1024);if(!buckets.has(bucket))buckets.set(bucket,new Map());buckets.get(bucket)!.set(pattern,ids);}
        for(const [bucket,entries] of buckets)index.patternPages![bucket]=await put(encodePatternPage(bucket,entries));
        for (const id of METRIC_IDS) {
            const values=metrics[id];let min=Infinity,max=0,sum=0;
            for(const v of values){min=Math.min(min,v);max=Math.max(max,v);sum+=v;}
            const summary=index.metrics[id]={min,max,mean:sum/count,scale: ['count','shape','rarity','anomaly'].includes(id)?'log':'linear',histogram:Array<number>(32).fill(0),neighborhoodMeans:[] as number[],values:await put(encodeMetric(values)),preview:null as unknown as FileRef};
            const normalized=new Float32Array(count);
            for(let i=0;i<count;i++){const t=normalizeMetric(values[i],summary);summary.histogram[Math.min(31,Math.floor(t*32))]++;normalized[i]=1+t*8;}
            for(let first=0;first<count;first+=2016){let total=0;for(let i=first;i<Math.min(count,first+2016);i++)total+=values[i];summary.neighborhoodMeans.push(total/Math.min(2016,count-first));}
            const indexName=`analytics-${id}.pb`;
            await generatePreviews({source,out,means:normalized,indexName});
            const path=resolve(out,dataPath(manifest.storageLayout,'parcel-previews',indexName));
            const codec=createPreviewCodec(protobuf), preview=await codec.decodeIndex(new Uint8Array(await readFile(path)),manifest.snapshot,manifest.storageLayout,'parcel-previews');
            // The published index uses immutable hashed names, as do its tiles.
            summary.preview=await put(codec.encodeIndex(preview));
            await unlink(path);
            console.log(`Analytics layer ready: ${id}`);
        }
        validateAnalyticsIndex(index,manifest.snapshot,count);
        await writeFile(resolve(out,'analytics.json'),JSON.stringify(index)+'\n',{flag:'wx'});
        return index;
    } finally { await db.close(); }
}

/** Publish a fully generated additive bundle, writing its root last. */
export async function installAnalytics(bundle: string, target: string):Promise<void>{
    if(isSemanticDataset(target))return editSemanticDataset(target,typed=>installAnalytics(bundle,typed));
    const root=await Bun.file(resolve(bundle,'analytics.json')).json();
    const manifest=(await readMapManifest(target)).manifest;
    validateAnalyticsIndex(root,manifest.snapshot,manifest.publishedHeight+1);
    const copy=async(ref:FileRef,kind:'colors'|'parcel-previews')=>{
        const name=resolve(bundle,kind,ref.url.split('/').at(-1)!),bytes=new Uint8Array(await readFile(name));
        check(bytes.length===ref.bytes&&await sha256(bytes)===ref.sha256,'Analytics bundle integrity failure');
        const destination=resolve(target,kind,ref.url.split('/').at(-1)!);await mkdir(dirname(destination),{recursive:true});
        if(await Bun.file(destination).exists())check(await sha256(new Uint8Array(await readFile(destination)))===ref.sha256,'Existing analytics artifact is corrupt');
        else await writeFile(destination,bytes,{flag:'wx'});
        return bytes;
    };
    for(const ref of Object.values(root.patternPages??{}) as FileRef[])await copy(ref,'colors');
    for(const ref of root.regions)await copy(ref,'colors');
    const codec=createPreviewCodec(protobuf);
    for(const id of METRIC_IDS){const metric=root.metrics[id];await copy(metric.values,'colors');const bytes=await copy(metric.preview,'colors');
        const index=await codec.decodeIndex(bytes,manifest.snapshot,manifest.storageLayout,'parcel-previews');
        for(const ref of index.tiles)await copy(ref,'parcel-previews');
    }
    const temporary=resolve(target,'analytics.json.tmp');await writeFile(temporary,JSON.stringify(root)+'\n');await rename(temporary,resolve(target,'analytics.json'));
}
if(import.meta.main){
    const args=argumentsFor(process.argv.slice(2),['--source','--db','--out']);
    check(args['--source']&&args['--db']&&args['--out'],'Use --source MAP_DATA --db DATABASE --out NEW_DIRECTORY');
    await mkdir(dirname(resolve(args['--out'])),{recursive:true});
    await generateAnalytics(args['--source'],args['--db'],args['--out']);
}
