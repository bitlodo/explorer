import {isSemanticDataset} from './dataset-path';
import {editSemanticDataset} from './semantic-dataset';
import {datasetPath} from './dataset-path';
import { SPATIAL_METRICS_FORMAT, encodeSpatialMetricPage, metricRegionPath, validateSpatialMetricsIndex, type SpatialMetricsIndex } from '../src/shared/spatialMetrics';
import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { resolve, dirname, sep } from 'node:path';
import protobuf from 'protobufjs';
import { LAYER_ANALYSIS_FORMAT, encodeParcelClasses, validateLayerAnalysis, type LayerAnalysis } from '../src/shared/layerAnalysis';
import { decodeInspection, validateAnalyticsIndex, encodeMetric, decodeMetric, normalizeMetric, type AnalyticsIndex, type MetricSummary } from '../src/shared/mapAnalytics';
import { sha256, check, type FileRef } from '../src/shared/httpPack';
import { createPreviewCodec } from '../src/shared/heatmapPreview';
import { dataPath } from '../src/shared/dataStorage';
import { readMapManifest } from './read-map-manifest';
import { generatePreviews } from './generate-previews';
import { argumentsFor } from './cli';

/** Derive interactive class filters from authenticated summaries, without opening a database. */
export async function generateLayerAnalysis(sourceArg:string,outArg:string){
    const source=resolve(sourceArg),out=resolve(outArg);
    check(out!==source&&!out.startsWith(source+sep)&&!source.startsWith(out+sep),'Use a separate new layer-analysis directory');
    const manifest=(await readMapManifest(source)).manifest,count=manifest.publishedHeight+1;
    const analytics=await Bun.file(datasetPath(source,'analytics.json')).json() as AnalyticsIndex;
    validateAnalyticsIndex(analytics,manifest.snapshot,count);
    await mkdir(out,{recursive:false});await mkdir(resolve(out,'colors'));
    const put=async(bytes:Uint8Array):Promise<FileRef>=>{const hash=await sha256(bytes),url=hash+'.pb';if(!await Bun.file(resolve(out,'colors',url)).exists())await writeFile(resolve(out,'colors',url),bytes,{flag:'wx'});return {url,sha256:hash,bytes:bytes.length};};
    const classes=new Uint32Array(count*9),areas=new Float32Array(count),counts=Array<number>(9).fill(0),weights=Array<number>(9).fill(0);
    const local:SpatialMetricsIndex={format:SPATIAL_METRICS_FORMAT,sourceSnapshot:manifest.snapshot,count,regions:[],parcelMeans:[]};
    let min=Infinity,max=0,total=0;const neighborhoodMeans:number[]=[];
    for(let region=0;region<analytics.regions.length;region++){
        const ref=analytics.regions[region],bytes=new Uint8Array(await readFile(datasetPath(source,'colors',ref.url)));
        check(bytes.length===ref.bytes&&await sha256(bytes)===ref.sha256,'Inspection integrity failure');
        const rows=decodeInspection(bytes,region,Math.min(2016,count-region*2016));let sum=0;
        for(const row of rows){const area=row.width*row.height;areas[row.id]=area;sum+=area;min=Math.min(min,area);max=Math.max(max,area);total+=area;
            for(let j=0;j<9;j++){classes[row.id*9+j]=row.histogram[j];counts[j]+=row.histogram[j];weights[j]+=row.histogram[j]*(j+1)**2;}}
        neighborhoodMeans.push(sum/rows.length);
        const page=encodeSpatialMetricPage(region,rows),hash=await sha256(page),url=metricRegionPath(region,hash);
        await mkdir(dirname(resolve(out,url)),{recursive:true});await writeFile(resolve(out,url),page,{flag:'wx'});
        local.regions.push({url,sha256:hash,bytes:page.length});
        let weight=0,score=0;for(const row of rows)for(let j=0;j<9;j++){const area=row.histogram[j]*(j+1)**2;weight+=area;score+=area*(j+1);}
        local.parcelMeans.push(score/weight);
    }
    const areaPreview=new Uint8Array(await readFile(datasetPath(source,dataPath(manifest.storageLayout,'previews','preview.pb'))));
    const area={min,max,mean:total/count,scale:'log' as const,histogram:Array<number>(32).fill(0),neighborhoodMeans,values:await put(encodeMetric(areas)),preview:await put(areaPreview)};
    for(const value of areas)area.histogram[Math.min(31,Math.floor(normalizeMetric(value,area)*32))]++;
    const classFile=await put(encodeParcelClasses(classes,count));
    await generatePreviews({source,out,classes,indexName:'parcel-class-preview.pb'});
    const previewPath=resolve(out,dataPath(manifest.storageLayout,'parcel-previews','parcel-class-preview.pb'));
    const preview=await put(new Uint8Array(await readFile(previewPath)));await unlink(previewPath);
    const root:LayerAnalysis={format:LAYER_ANALYSIS_FORMAT,sourceSnapshot:manifest.snapshot,count,parcel:{classes:classFile,preview,counts,areas:weights},area};
    validateLayerAnalysis(root,manifest.snapshot,count);await writeFile(resolve(out,'layer-analysis.json'),JSON.stringify(root)+'\n',{flag:'wx'});
    validateSpatialMetricsIndex(local,manifest.snapshot,count);
    await writeFile(resolve(out,'metrics.json'),JSON.stringify(local)+'\n',{flag:'wx'});
    return root;
}
/** Rebin existing authenticated areas; preserve all Protobufs and retained releases. */
export async function updateBitmapAreaScale(target:string,scale:MetricSummary['scale']='log'):Promise<void>{
    check(scale==='linear'||scale==='log','Invalid bitmap area scale');
    if(isSemanticDataset(target))return editSemanticDataset(target,logical=>updateBitmapAreaScale(logical,scale));
    const manifest=(await readMapManifest(target)).manifest;
    const root=await Bun.file(resolve(target,'layer-analysis.json')).json() as LayerAnalysis;
    validateLayerAnalysis(root,manifest.snapshot,manifest.publishedHeight+1);
    const bytes=new Uint8Array(await readFile(resolve(target,'colors',root.area.values.url)));
    check(bytes.length===root.area.values.bytes&&await sha256(bytes)===root.area.values.sha256,'Area metric integrity failure');
    const values=decodeMetric(bytes,root.count);
    root.area={...root.area,scale,histogram:Array<number>(32).fill(0)};
    for(const value of values)root.area.histogram[Math.min(31,Math.floor(normalizeMetric(value,root.area)*32))]++;
    validateLayerAnalysis(root,manifest.snapshot,root.count);
    const temporary=resolve(target,'layer-analysis.json.tmp');
    await writeFile(temporary,JSON.stringify(root)+'\n');await rename(temporary,resolve(target,'layer-analysis.json'));
}
export async function installLayerAnalysis(bundle:string,target:string):Promise<void>{
    if(isSemanticDataset(target))return editSemanticDataset(target,typed=>installLayerAnalysis(bundle,typed));
    const manifest=(await readMapManifest(target)).manifest,root=await Bun.file(resolve(bundle,'layer-analysis.json')).json() as LayerAnalysis;
    validateLayerAnalysis(root,manifest.snapshot,manifest.publishedHeight+1);
    const copy=async(ref:FileRef,kind:'colors'|'parcel-previews')=>{
        const name=ref.url.split('/').at(-1)!,bytes=new Uint8Array(await readFile(resolve(bundle,kind,name)));
        check(bytes.length===ref.bytes&&await sha256(bytes)===ref.sha256,'Layer analysis integrity failure');
        const destination=resolve(target,kind,name);await mkdir(dirname(destination),{recursive:true});
        if(await Bun.file(destination).exists())check(await sha256(new Uint8Array(await readFile(destination)))===ref.sha256,'Existing layer artifact differs');else await writeFile(destination,bytes,{flag:'wx'});
        return bytes;
    };
    await copy(root.parcel.classes,'colors');await copy(root.area.values,'colors');
    const codec=createPreviewCodec(protobuf);
    for(const ref of [root.parcel.preview,root.area.preview]){
        const index=await codec.decodeIndex(await copy(ref,'colors'),manifest.snapshot,manifest.storageLayout,ref===root.parcel.preview?'parcel-previews':'previews');
        for(const tile of index.tiles){
            if(ref===root.parcel.preview)await copy(tile,'parcel-previews');
            else{const bytes=new Uint8Array(await readFile(resolve(target,tile.url)));check(bytes.length===tile.bytes&&await sha256(bytes)===tile.sha256,'Area preview integrity failure');}
        }
    }
    if(await Bun.file(resolve(bundle,'metrics.json')).exists()){
        const local=await Bun.file(resolve(bundle,'metrics.json')).json() as SpatialMetricsIndex;validateSpatialMetricsIndex(local,manifest.snapshot,manifest.publishedHeight+1);
        for(const ref of local.regions){const bytes=new Uint8Array(await readFile(resolve(bundle,ref.url)));check(bytes.length===ref.bytes&&await sha256(bytes)===ref.sha256,'Local metric integrity failure');
            const destination=resolve(target,ref.url);await mkdir(dirname(destination),{recursive:true});
            if(await Bun.file(destination).exists())check(await sha256(new Uint8Array(await readFile(destination)))===ref.sha256,'Existing local metric differs');else await writeFile(destination,bytes,{flag:'wx'});}
        await writeFile(resolve(target,'metrics.json.tmp'),JSON.stringify(local)+'\n');await rename(resolve(target,'metrics.json.tmp'),resolve(target,'metrics.json'));
    }
    const temporary=resolve(target,'layer-analysis.json.tmp');await writeFile(temporary,JSON.stringify(root)+'\n');await rename(temporary,resolve(target,'layer-analysis.json'));
}
if(import.meta.main){const args=argumentsFor(process.argv.slice(2),['--source','--out']);check(args['--source']&&args['--out'],'Use --source MAP_DATA --out NEW_DIRECTORY');await mkdir(dirname(resolve(args['--out'])),{recursive:true});await generateLayerAnalysis(args['--source'],args['--out']);}
