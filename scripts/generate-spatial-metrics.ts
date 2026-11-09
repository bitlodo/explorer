import {isSemanticDataset} from './dataset-path';
import {editSemanticDataset} from './semantic-dataset';
import {datasetPath} from './dataset-path';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { argumentsFor } from './cli';
import { readMapManifest } from './read-map-manifest';
import { validateAnalyticsIndex, decodeInspection, type AnalyticsIndex } from '../src/shared/mapAnalytics';
import { SPATIAL_METRICS_FORMAT, encodeSpatialMetricPage, decodeSpatialMetricPage, metricRegionPath, validateSpatialMetricsIndex, type SpatialMetricsIndex } from '../src/shared/spatialMetrics';
import { check, sha256 } from '../src/shared/httpPack';
/** Add local values without rebuilding canonical geometry or the existing color bundles. */
export async function generateSpatialMetrics(sourceArg:string,outArg:string){
    const source=resolve(sourceArg),out=resolve(outArg);check(out!==source&&!out.startsWith(source+sep)&&!source.startsWith(out+sep),'Use a separate new metrics destination');
    const {manifest}=await readMapManifest(source),count=manifest.publishedHeight+1,analytics=await Bun.file(datasetPath(source,'analytics.json')).json() as AnalyticsIndex;
    validateAnalyticsIndex(analytics,manifest.snapshot,count);await mkdir(out,{recursive:false});
    const root:SpatialMetricsIndex={format:SPATIAL_METRICS_FORMAT,sourceSnapshot:manifest.snapshot,count,regions:[],parcelMeans:[]};
    for(let id=0;id<analytics.regions.length;id++){
        const ref=analytics.regions[id],input=new Uint8Array(await readFile(datasetPath(source,'colors',ref.url)));
        check(input.length===ref.bytes&&await sha256(input)===ref.sha256,'Source inspection integrity failure');
        const rows=decodeInspection(input,id,Math.min(2016,count-id*2016)),bytes=encodeSpatialMetricPage(id,rows),hash=await sha256(bytes),url=metricRegionPath(id,hash);
        decodeSpatialMetricPage(bytes,id,rows.length);await mkdir(dirname(resolve(out,url)),{recursive:true});await writeFile(resolve(out,url),bytes,{flag:'wx'});root.regions.push({url,sha256:hash,bytes:bytes.length});
        let weight=0,sum=0;for(const row of rows)for(let j=0;j<9;j++){const area=row.histogram[j]*(j+1)**2;weight+=area;sum+=area*(j+1);}root.parcelMeans.push(sum/weight);
    }
    validateSpatialMetricsIndex(root,manifest.snapshot,count);await writeFile(resolve(out,'metrics.json'),JSON.stringify(root)+'\n',{flag:'wx'});return root;
}
export async function installSpatialMetrics(bundle:string,target:string):Promise<void>{
    if(isSemanticDataset(target))return editSemanticDataset(target,typed=>installSpatialMetrics(bundle,typed));
    const {manifest}=await readMapManifest(target),root=await Bun.file(resolve(bundle,'metrics.json')).json() as SpatialMetricsIndex;validateSpatialMetricsIndex(root,manifest.snapshot,manifest.publishedHeight+1);
    const {appendFile}=await import('./publish-release');
    for(const [id,ref] of root.regions.entries()){
        const bytes=new Uint8Array(await readFile(resolve(bundle,ref.url)));check(bytes.length===ref.bytes&&await sha256(bytes)===ref.sha256,'Metric page integrity failure');decodeSpatialMetricPage(bytes,id,Math.min(2016,root.count-id*2016));await appendFile(target,ref.url,bytes);
    }
    await writeFile(resolve(target,'metrics.json.tmp'),JSON.stringify(root)+'\n');await rename(resolve(target,'metrics.json.tmp'),resolve(target,'metrics.json'));
}
if(import.meta.main){const args=argumentsFor(process.argv.slice(2),['--source','--out','--install']);check(args['--source']&&args['--out'],'Use --source MAP_DATA --out NEW_DIRECTORY [--install true]');check(!args['--install']||args['--install']==='true','Use --install true');await mkdir(dirname(resolve(args['--out'])),{recursive:true});const root=await generateSpatialMetrics(args['--source'],args['--out']);if(args['--install'])await installSpatialMetrics(args['--out'],args['--source']);console.log(`Spatial metrics ready: ${root.regions.length} neighborhoods, ${root.regions.reduce((sum,r)=>sum+r.bytes,0)} bytes.`);}
