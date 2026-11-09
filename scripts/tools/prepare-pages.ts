import {datasetPath,isSemanticDataset} from '../dataset-path';
import { decodeAggregateIndex, validateAggregateDiscovery, validAggregatePath, type AggregateIndex } from '../../src/shared/lod4Aggregates';
import { validateLod4Summaries } from '../generate-lod4-summaries';
import { validateParcelFilterDiscovery, decodeParcelFilterMetadata, decodeParcelFilterIndex, validParcelFilterPath } from '../../src/shared/parcelFilters';
import { validateParcelFilters, type ParcelFilterBaseline } from '../generate-parcel-filters';
import {decodePatternPage} from '../../src/shared/patternPages';
import { validateSpatialMetricsIndex, decodeSpatialMetricPage, metricRegionPath } from '../../src/shared/spatialMetrics';
import { buildLod4Region, encodeLod4Region, decodeLod4Index, decodeLod4Region, lod4RegionPath, validateLod4Discovery, type Lod4Discovery } from '../../src/shared/lod4';
import { readMapManifest } from '../read-map-manifest';
import { readReferenceSnapshot, readArtifact } from '../reference-snapshot';
import { GenerationCoverage, generationProgressEnabled, reportGenerationProgress } from '../generation-progress';
import {buildProgressEnabled,reportBuildProgress} from '../build-progress';
import {decodeParcelMeans,validateMeansRef} from '../../src/shared/parcelMeans';
import { validateAnalyticsIndex, decodeMetric, decodeInspection, METRIC_IDS, type AnalyticsIndex } from '../../src/shared/mapAnalytics';
import { validateLayerAnalysis, decodeParcelClasses, type LayerAnalysis } from '../../src/shared/layerAnalysis';
import type { ProtoManifest } from '../../src/shared/protobufChunks';
import type { FileRef, RegionDescriptor, ChunkDescriptor, ChunkRef, PackRef } from '../../src/shared/httpPack';
import type { MondrianRect } from '../../src/shared/MondrianLayout';
import { dataPath, validArtifactPath } from '../../src/shared/dataStorage.ts';
// Assemble only referenced, verified static artifacts. Never exports DBs or deploys.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {inflateSync} from 'node:zlib';
import { isDeepStrictEqual } from 'node:util';
import { createRequire } from 'node:module';
import SpiralLayout from '../../src/shared/SpiralLayout.ts';
const require = createRequire(new URL('../../package.json', import.meta.url));
const type = require('protobufjs').Root.fromJSON(require('./src/shared/proto/neighborhood_descriptor.json')).lookupType('Neighborhood');
import { PROTO_FORMAT, CHUNK_FORMAT, chunkAt, supportsFormat, validateRegionPacks, LAYOUT, parsePack } from '../../src/shared/httpPack.ts';
import { createProtoCodec } from '../../src/shared/protobufChunks.ts';
const protoCodec = createProtoCodec(require('protobufjs'));
import {createPreviewCodec} from '../../src/shared/heatmapPreview.ts';
const previewCodec=createPreviewCodec(require('protobufjs'));
import {createNeighborhoodLayoutComputer} from '../../src/shared/computeNeighborhoodLayout.ts';
const computeNeighborhood=createNeighborhoodLayoutComputer(require('protobufjs'));
import * as neighborhoodChunkCodec from '../../src/shared/neighborhoodChunks.ts';
const [snapshotArg,buildArg,outArg,...options] = process.argv.slice(2);
if(!snapshotArg||!buildArg||!outArg||options.some(o=>o!=='--allow-sample'&&o!=='--validate-only'&&o!=='--integrity-only'&&!o.startsWith('--neighborhood-chunks=')&&!o.startsWith('--baseline=')&&!o.startsWith('--file-list='))) throw Error('Usage: bun scripts/tools/prepare-pages.ts SNAPSHOT BUILD OUT [--allow-sample] [--integrity-only | --validate-only [--baseline=MAP_DATA]] [--neighborhood-chunks=DIR]');
const validationOnly = options.includes('--validate-only');
const integrityOnly = options.includes('--integrity-only');
if(integrityOnly&&(validationOnly||options.some(o=>o.startsWith('--baseline=')||o.startsWith('--file-list=')||o.startsWith('--neighborhood-chunks='))))throw Error('Integrity-only publication cannot use audit or generation options.');
const baselineArg = options.find(o=>o.startsWith('--baseline='))?.slice('--baseline='.length);
if (baselineArg !== undefined && (!baselineArg || !validationOnly || options.some(o=>o.startsWith('--neighborhood-chunks='))))
    throw Error('An incremental baseline is supported only by --validate-only with the staged dataset addons.');
const approval=options.includes('--allow-sample')?'--allow-sample':undefined;
const snapshot=path.resolve(snapshotArg), build=path.resolve(buildArg), out=path.resolve(outArg);
reportBuildProgress({phase:'Reading dataset metadata'});
if(integrityOnly&&!isSemanticDataset(snapshot))throw Error('Integrity-only publication requires a native semantic dataset.');
const chunkDirectory=path.resolve(options.find(o=>o.startsWith('--neighborhood-chunks='))?.slice('--neighborhood-chunks='.length)||snapshot);
if(out===chunkDirectory||chunkDirectory.startsWith(out+'/')||out.startsWith(chunkDirectory+'/'))throw Error('Chunk output must be separate');
const hasNeighborhoodChunks=await fs.access(datasetPath(chunkDirectory,'neighborhood-chunks.json')).then(()=>true,()=>false);
if(options.some(o=>o.startsWith('--neighborhood-chunks='))&&!hasNeighborhoodChunks)throw Error('Missing neighborhood chunk root');
if(out===snapshot || out.startsWith(snapshot+'/') || snapshot.startsWith(out+'/') || out===build || out.startsWith(build+'/') || build.startsWith(out+'/')) throw Error('Output must be separate from inputs');
const hash = (bytes:Uint8Array) => crypto.createHash('sha256').update(bytes).digest('hex');
const {entry,bytes:manifestBytes,manifest}=await readMapManifest(snapshot);
const proto=manifest.format.startsWith('bitmap-http-protobuf-');
const report=JSON.parse(await fs.readFile(datasetPath(snapshot,'report.json'),'utf8'));
if(report.status!=='passed'||report.snapshot!==manifest.snapshot||!supportsFormat(manifest.format)||typeof manifest.layout!=='string'||!manifest.layout.length) throw Error('Unvalidated/incompatible snapshot');
const { snapshot: snapshotId, ...body } = manifest;
if((!proto && hash(Buffer.from(JSON.stringify(body)+'\n'))!==snapshotId) || !Array.isArray(manifest.regions) || !manifest.regions.length || manifest.publishedHeight!==manifest.regions.length*2016-1) throw Error('Manifest revision/coverage mismatch');
const selected=new Set(manifest.parcelRegions);
if(selected.size!==manifest.parcelRegions.length || [...selected].some(id=>!Number.isInteger(id)||id<0||id>=manifest.regions.length) || report.sample!==(selected.size!==manifest.regions.length)) throw Error('Invalid sample coverage');
if(report.sample && approval!=='--allow-sample') throw Error('Sample snapshot: explicit --allow-sample is required');
const storage=manifest.storageLayout;
const files=new Map([[entry,manifestBytes.length]]);
const sources=new Map<string,string>();
const fileSource=(file:string)=>sources.get(file)??datasetPath(file==='neighborhood-chunks.json'?chunkDirectory:snapshot,file);
const baselineInput = baselineArg ? await readMapManifest(path.resolve(baselineArg)) : undefined;
const baseline = baselineInput?.manifest, baselineRoot = baselineArg ? path.resolve(baselineArg) : undefined;
const baselinePacks = new Map<string,PackRef>(), inheritedOwners = new Map<number,string>();
const validation = { mode: integrityOnly?'integrity':baseline ? 'incremental' : 'full', neighborhoodsVerified: 0, parcelPacksVerified: 0,
    parcelPacksReused: 0, bitmapChunksVerified: 0, bitmapChunksReused: 0, previewTilesVerified: 0, previewTilesReused: 0 };
if(!integrityOnly){
if (baseline) {
    const prior = JSON.parse(await fs.readFile(datasetPath(baselineRoot!, 'report.json'),'utf8'));
    if (baselineRoot === snapshot || manifest.format !== 'bitmap-http-protobuf-v9' || baseline.format !== manifest.format ||
        prior.status !== 'passed' || prior.snapshot !== baseline.snapshot || prior.sample !== false || report.sample ||
        report.incremental !== true || report.sourceSnapshot !== baseline.snapshot ||
        baseline.parcelRegions.length !== baseline.regions.length || baseline.regions.length > manifest.regions.length ||
        ['storageLayout','layout','grid','packBytes','frameBytes','shuffleSeed','indexPageSide'].some(key=>
            !isDeepStrictEqual(baseline[key as keyof ProtoManifest],manifest[key as keyof ProtoManifest])) ||
        baseline.regions.some((region,id)=>!isDeepStrictEqual(region,manifest.regions[id])))
        throw Error('Incremental baseline must be the unchanged published prefix with matching data contracts.');
    for (const page of baseline.indexPages!) for (const chunk of protoCodec.decodeIndexPage(await readArtifact(baselineRoot!,page),page,baseline))
        for (const pack of chunk.packs) {
            if (baselinePacks.has(pack.url)) throw Error('Duplicate baseline parcel pack.');
            baselinePacks.set(pack.url,pack);
            for (const id of pack.ids!) {
                if (inheritedOwners.has(id)) throw Error('Duplicate baseline bitmap coverage.');
                inheritedOwners.set(id,`${chunk.x},${chunk.y}`);
            }
        }
    if (inheritedOwners.size !== baseline.publishedHeight + 1) throw Error('Incomplete baseline parcel index coverage.');
}
const reusablePack = (pack:PackRef) => !!baseline && isDeepStrictEqual(pack,baselinePacks.get(pack.url));
const reference = await readReferenceSnapshot(snapshot, manifest.snapshot, manifest.publishedHeight + 1);
if (reference) {
    files.set('bitmap-reference.json', reference.bytes.length);
    files.set(reference.ref.url, reference.ref.bytes);
}
const canonicalRects=hasNeighborhoodChunks?new Float64Array((manifest.publishedHeight+1)*4):undefined;

const validPublicationPath=(url:string,sha:string)=>validArtifactPath(url,sha)||validAggregatePath(url,sha)||validParcelFilterPath(url,sha)||(/^metrics\/values\/n\d{6}\.[a-f0-9]{64}\.pb$/.test(url)&&url.endsWith(sha+'.pb'))||(/^[a-f0-9]{64}$/.test(sha)&&(url===`lod4/${sha}.pb`||url===`lod4/regions/${sha}.pb`));
async function read(ref:FileRef,kind?:'bitmap-chunks'|'colors') {
    if(!kind&&ref.url.endsWith('.nbc'))kind='bitmap-chunks';
    if(!kind&&ref.url.endsWith('.means'))kind='colors';
    const logical=ref.url.split('/').at(-1)!;
    const destination=kind?dataPath(storage,kind,logical):ref.url;
    if(!validPublicationPath(ref.url,ref.sha256)||!validPublicationPath(destination,ref.sha256))throw Error('Invalid immutable artifact path');
    const root=kind==='bitmap-chunks'?chunkDirectory:snapshot;
    const filename=datasetPath(root,kind?dataPath(root===snapshot?storage:undefined,kind,logical):ref.url);
    const bytes=await fs.readFile(filename);
    if(bytes.length!==ref.bytes||hash(bytes)!==ref.sha256)throw Error('Artifact integrity failure '+ref.url);
    files.set(destination,bytes.length);sources.set(destination,filename);return bytes;
}
// Published payloads have already been authenticated during generation/copying.
// Check their presence and length without reopening or decoding the historical bytes.
async function reuse(ref:FileRef,kind?:'bitmap-chunks') {
    const destination=kind?dataPath(storage,kind,ref.url.split('/').at(-1)!):ref.url;
    if(!validPublicationPath(ref.url,ref.sha256)||!validPublicationPath(destination,ref.sha256))throw Error('Invalid inherited artifact path');
    const filename=datasetPath(snapshot,destination),info=await fs.lstat(filename);
    if(!info.isFile()||info.isSymbolicLink()||info.size!==ref.bytes)throw Error('Missing/changed inherited artifact '+destination);
    files.set(destination,info.size);sources.set(destination,filename);
}
const loadedGeometry=new Set<number>();
async function loadGeometry(region:ProtoManifest['regions'][number],verifyLayout:boolean,owners?:Map<number,string>) {
    if(loadedGeometry.has(region.id))return;
    const canonical=await read(region.geometry),geometry=type.decode(canonical) as {neighborhood:number;width:number;height:number;bitmaps:MondrianRect[]};
    if(region.dimensions&&verifyLayout){
        const dimensions=await read(region.dimensions);
        await computeNeighborhood({job:region.id,dimensions,dimensionsHash:region.dimensions.sha256,
            expected:{id:region.id,width:region.width,height:region.height,sha256:region.geometry.sha256,bytes:region.geometry.bytes}});
    }
    if(geometry.neighborhood!==region.id||geometry.width!==region.width||geometry.height!==region.height||geometry.bitmaps.length!==2016)throw Error('Invalid protobuf geometry');
    for(const [i,r] of geometry.bitmaps.entries()){
        if(![r.x,r.y,r.width,r.height].every(Number.isSafeInteger)||r.x<0||r.y<0||r.width<=0||r.height<=0||r.x+r.width>region.width||r.y+r.height>region.height)throw Error('Invalid canonical rectangle');
        const id=region.id*2016+i;
        canonicalRects?.set([region.x+r.x,region.y+r.y,r.width,r.height],id*4);
        if(owners&&region.coverage==='complete'){const c=chunkAt(region.x+r.x,region.y+r.y,manifest.grid!.size);owners.set(id,`${c.x},${c.y}`);}
    }
    loadedGeometry.add(region.id);
}

if(proto) {
    reportBuildProgress({phase:'Validating neighborhood geometry',completed:0,total:manifest.regions.length,unit:'neighborhoods'});
    const spatialChunks=[...manifest.chunks];
    for(const ref of manifest.indexPages||[])spatialChunks.push(...protoCodec.decodeIndexPage(await read(ref),ref,manifest));
    const owners=inheritedOwners, seen=new Set();
    const officialSlots=manifest.layout===LAYOUT?new SpiralLayout(manifest.regions).slots:undefined;
    for(const region of manifest.regions) {
        const slot=region;
        if(officialSlots&&(officialSlots[region.id].x!==slot.x||officialSlots[region.id].y!==slot.y)) throw Error('Protobuf world position differs from official spiral');
        if(baseline&&region.id<baseline.regions.length){await reuse(region.geometry);await reuse(region.dimensions!);}
        else{await loadGeometry(region,true,owners);validation.neighborhoodsVerified++;}
        reportBuildProgress({phase:'Validating neighborhood geometry',completed:region.id+1,total:manifest.regions.length,unit:'neighborhoods'});
        if(baseline&&region.id<baseline.regions.length)continue;
        reportGenerationProgress({ kind: 'neighborhood', phase: baseline?'Validating new neighborhood geometry':'Validating neighborhood geometry', id: region.id,
            completed: validation.neighborhoodsVerified, total: manifest.regions.length-(baseline?.regions.length??0), action: 'verified' });
    }
    const progress = generationProgressEnabled()&&!baseline ? new GenerationCoverage(manifest.publishedHeight, manifest.parcelRegions.length) : undefined;
    let completedChunks = 0;
    const changedChunks=spatialChunks.filter(chunk=>chunk.packs.some(pack=>!reusablePack(pack))).length;
    const chunkKeys=new Set<string>();
    const totalPacks=spatialChunks.reduce((sum,chunk)=>sum+chunk.packs.length,0);
    let completedPacks=0;
    reportBuildProgress({phase:'Validating parcel packs',completed:0,total:totalPacks,unit:'packs'});
    for(const chunk of spatialChunks) {
        const key=`${chunk.x},${chunk.y}`;
        if(chunkKeys.has(key))throw Error('Duplicate parcel chunk across index pages');chunkKeys.add(key);
        let changed=false;
        for(const pack of chunk.packs) {
            if(reusablePack(pack)){
                await reuse(pack);validation.parcelPacksReused++;
                for(const id of pack.ids!){if(seen.has(id)||owners.get(id)!==key)throw Error('Duplicate/wrong inherited protobuf owner');seen.add(id);}
                reportBuildProgress({phase:'Validating parcel packs',completed:++completedPacks,total:totalPacks,unit:'packs'});
                continue;
            }
            changed=true;validation.parcelPacksVerified++;
            const bytes=await read(pack);async function* stream(){yield bytes;}
            for await(const record of protoCodec.parsePack(stream(),pack)) {
                if(seen.has(record.id)||owners.get(record.id)!==`${chunk.x},${chunk.y}`) throw Error('Duplicate/wrong protobuf owner');
                seen.add(record.id); progress?.record(record.id);
            }
            reportBuildProgress({phase:'Validating parcel packs',completed:++completedPacks,total:totalPacks,unit:'packs'});
        }
        if(!baseline||changed)completedChunks++;
        if(baseline&&changed)reportGenerationProgress({kind:'units',phase:'Validating changed parcel chunks',unit:'Changed chunks verified',completed:completedChunks,total:changedChunks});
        if (progress) reportGenerationProgress({ kind: 'coverage', phase: 'Validating parcel chunks', unit: 'Chunks verified',
            completed: completedChunks, total: spatialChunks.length, ...progress.snapshot() });
    }
    if(seen.size!==owners.size) throw Error('Incomplete protobuf coverage');
}
if(hasNeighborhoodChunks){
    reportBuildProgress({phase:'Validating bitmap vectors',completed:0,total:manifest.publishedHeight+1,unit:'bitmaps'});
    if(!proto)throw Error('Neighborhood chunks require a Protobuf snapshot');
    const bytes=await fs.readFile(datasetPath(chunkDirectory,'neighborhood-chunks.json'));
    const index=await neighborhoodChunkCodec.decodeNeighborhoodChunkIndex(bytes,manifest.snapshot);files.set('neighborhood-chunks.json',bytes.length);
    const reusableChunks=new Map<string,neighborhoodChunkCodec.NeighborhoodChunkRef>();
    const priorFile=baselineRoot&&datasetPath(baselineRoot,'neighborhood-chunks.json');
    if(priorFile&&await fs.access(priorFile).then(()=>true,()=>false)){
        const prior=await neighborhoodChunkCodec.decodeNeighborhoodChunkIndex(await fs.readFile(priorFile),baseline!.snapshot);
        if(prior.format===index.format&&prior.size===index.size&&prior.side===index.side&&prior.maxWidth<=index.maxWidth&&prior.maxHeight<=index.maxHeight)
            for(const page of prior.pages)for(const ref of neighborhoodChunkCodec.decodeNeighborhoodChunkPage(await readArtifact(baselineRoot!,{...page,url:dataPath(baseline!.storageLayout,'bitmap-chunks',page.url)}),page,prior)){
                const key=`${ref.x},${ref.y}`;if(reusableChunks.has(key))throw Error('Duplicate baseline bitmap chunk');reusableChunks.set(key,ref);
            }
    }
    const seen=new Set(),cells=new Set<string>();let covered=0;
    for(const page of index.pages)for(const ref of neighborhoodChunkCodec.decodeNeighborhoodChunkPage(await read(page,'bitmap-chunks'),page,index)){
        const key=`${ref.x},${ref.y}`;if(cells.has(key))throw Error('Duplicate bitmap chunk across index pages');cells.add(key);
        covered+=ref.records;
        if(isDeepStrictEqual(ref,reusableChunks.get(key))){await reuse(ref,'bitmap-chunks');validation.bitmapChunksReused++;reportBuildProgress({phase:'Validating bitmap vectors',completed:covered,total:manifest.publishedHeight+1,unit:'bitmaps'});continue;}
        validation.bitmapChunksVerified++;
        const chunk=neighborhoodChunkCodec.decodeNeighborhoodChunk(await read(ref,'bitmap-chunks'),ref,index,manifest.publishedHeight);
        for(const b of chunk.bitmaps){const p=b.id*4;
            await loadGeometry(manifest.regions[Math.floor(b.id/2016)],false);
            if(seen.has(b.id)||canonicalRects![p]!==b.x||canonicalRects![p+1]!==b.y||canonicalRects![p+2]!==b.width||canonicalRects![p+3]!==b.height)throw Error('Duplicate/changed neighborhood bitmap');seen.add(b.id);
        }
        reportBuildProgress({phase:'Validating bitmap vectors',completed:covered,total:manifest.publishedHeight+1,unit:'bitmaps'});
    }
    if(covered!==manifest.publishedHeight+1)throw Error('Incomplete neighborhood chunk coverage');
}
async function validatePreview(name:string,kind:'previews'|'parcel-previews'='previews') {
    name=dataPath(storage,kind,name);
    const bytes=await fs.readFile(datasetPath(snapshot,name)),index=await previewCodec.decodeIndex(bytes,manifest.snapshot,storage,kind);files.set(name,bytes.length);
    const priorFile=baselineRoot&&datasetPath(baselineRoot,dataPath(baseline!.storageLayout,kind,path.basename(name)));
    const prior=priorFile&&await fs.access(priorFile).then(()=>true,()=>false)?await previewCodec.decodeIndex(await fs.readFile(priorFile),baseline!.snapshot,baseline!.storageLayout,kind):undefined;
    const oldTiles=new Map(prior?.tiles.map(ref=>[`${ref.level},${ref.x},${ref.y}`,ref]));
    const phase=kind==='previews'?'Validating bitmap previews':'Validating parcel previews';
    let completed=0;reportBuildProgress({phase,completed,total:index.tiles.length,unit:'tiles'});
    for(const ref of index.tiles){
        if(prior&&prior.layout===index.layout&&prior.tileSize===index.tileSize&&prior.resolution===index.resolution&&isDeepStrictEqual(ref,oldTiles.get(`${ref.level},${ref.x},${ref.y}`))){await reuse(ref);validation.previewTilesReused++;reportBuildProgress({phase,completed:++completed,total:index.tiles.length,unit:'tiles'});continue;}
        const tile=await read(ref),compressed=previewCodec.decodeTile(tile,ref,index),pixels=inflateSync(compressed,{maxOutputLength:index.resolution*index.resolution*4});if(pixels.length!==index.resolution*index.resolution*4)throw Error('Invalid preview pixel count');validation.previewTilesVerified++;
        reportBuildProgress({phase,completed:++completed,total:index.tiles.length,unit:'tiles'});
    }
}
if(await fs.access(datasetPath(snapshot,dataPath(storage,'previews','preview.pb'))).then(()=>true,()=>false)) await validatePreview('preview.pb');
for(const name of ['parcel-colors.json','bitmap-area-colors.json']) {
    const bytes=await fs.readFile(datasetPath(snapshot,name)).catch(error=>{if(error.code!=='ENOENT')throw error;});
    if(!bytes)continue;
    const root=JSON.parse(bytes.toString());
    if(root.sourceSnapshot!==manifest.snapshot||root.count!==manifest.publishedHeight+1)throw Error('Color summary snapshot/coverage mismatch');
    if(name==='parcel-colors.json') {
        validateMeansRef(root.means,root.count,root.format);if(root.preview!=='parcel-size-preview.pb')throw Error('Invalid parcel color summary');
        decodeParcelMeans(await read(root.means,'colors'),root.count,root.format);
        await validatePreview(root.preview,'parcel-previews');
    } else if(root.format!=='bitmap-area-colors-v1'||root.normalization!=='linear-area-v1'||!Number.isSafeInteger(root.maxArea)||root.maxArea<1||!Array.isArray(root.neighborhoodMeans)||root.neighborhoodMeans.length!==manifest.regions.length||root.neighborhoodMeans.some((v:number)=>!Number.isFinite(v)||v<1||v>root.maxArea)) throw Error('Invalid bitmap area summary');
    files.set(name,bytes.length);
}
const metricsFile=datasetPath(snapshot,'metrics.json');
if(await fs.access(metricsFile).then(()=>true,()=>false)){
    const bytes=await fs.readFile(metricsFile),root=JSON.parse(bytes.toString());validateSpatialMetricsIndex(root,manifest.snapshot,manifest.publishedHeight+1);files.set('metrics.json',bytes.length);
    reportBuildProgress({phase:'Validating spatial metrics',completed:0,total:root.regions.length,unit:'pages'});
    for(let id=0;id<root.regions.length;id++){decodeSpatialMetricPage(await read(root.regions[id]),id,Math.min(2016,root.count-id*2016));reportBuildProgress({phase:'Validating spatial metrics',completed:id+1,total:root.regions.length,unit:'pages'});}
}
const lod4File=datasetPath(snapshot,'lod4.json');
if(await fs.access(lod4File).then(()=>true,()=>false)){
    reportBuildProgress({phase:'Validating zoom-4 cells',completed:0,total:manifest.regions.length,unit:'neighborhoods'});
    const bytes=await fs.readFile(lod4File),discovery=validateLod4Discovery(JSON.parse(bytes.toString()) as Lod4Discovery,manifest.snapshot);
    files.set('lod4.json',bytes.length);
    const root=await read(discovery.index),index=await decodeLod4Index(root,manifest.snapshot,discovery.index.sha256);
    if(index.bitmapCount!==manifest.publishedHeight+1||index.regions.length!==manifest.regions.length)throw Error('LOD4 publication coverage mismatch');
    let priorLod4:Awaited<ReturnType<typeof decodeLod4Index>>|undefined;
    if(baseline&&baselineRoot&&await fs.access(datasetPath(baselineRoot,'lod4.json')).then(()=>true,()=>false)){
        const d=validateLod4Discovery(JSON.parse(await fs.readFile(datasetPath(baselineRoot,'lod4.json'),'utf8')),baseline.snapshot);
        const b=new Uint8Array(await fs.readFile(datasetPath(baselineRoot,d.index.url)));priorLod4=await decodeLod4Index(b,baseline.snapshot,d.index.sha256);
    }
    for(const ref of index.regions){
        const original=manifest.regions[ref.id];
        if(ref.width!==original.width||ref.height!==original.height||ref.geometrySha256!==original.geometry!.sha256)throw Error('LOD4 publication canonical identity mismatch');
        const file={...ref,url:'lod4/'+lod4RegionPath(ref)};
        if(baseline&&isDeepStrictEqual(priorLod4?.regions[ref.id],ref)){await reuse(file);reportBuildProgress({phase:'Validating zoom-4 cells',completed:ref.id+1,total:index.regions.length,unit:'neighborhoods'});continue;}
        const data=await read(file);await decodeLod4Region(data,ref,index);
        const canonical=type.toObject(type.decode(await read(original.geometry!)),{arrays:true,defaults:true});
        const expected=encodeLod4Region(buildLod4Region(canonical as any,original.geometry!.sha256,index.gridSide),index.gridSide);
        if(hash(expected)!==ref.sha256)throw Error('LOD4 publication membership differs from canonical geometry');
        reportBuildProgress({phase:'Validating zoom-4 cells',completed:ref.id+1,total:index.regions.length,unit:'neighborhoods'});
    }
}
const aggregateFile=datasetPath(snapshot,'lod4-summary.json');
if(await fs.access(aggregateFile).then(()=>true,()=>false)){
    const bytes=await fs.readFile(aggregateFile),discovery=validateAggregateDiscovery(JSON.parse(bytes.toString()),manifest.snapshot);files.set('lod4-summary.json',bytes.length);
    const index=await decodeAggregateIndex(await read(discovery.index),manifest.snapshot,discovery.index);
    let prior:AggregateIndex|undefined;
    if(baseline&&baselineRoot&&await fs.access(datasetPath(baselineRoot,'lod4-summary.json')).then(()=>true,()=>false)){
        const d=validateAggregateDiscovery(JSON.parse(await fs.readFile(datasetPath(baselineRoot,'lod4-summary.json'),'utf8')),baseline.snapshot);
        prior=await decodeAggregateIndex(new Uint8Array(await fs.readFile(datasetPath(baselineRoot,d.index.url))),baseline.snapshot,d.index);
    }
    await validateLod4Summaries(snapshot,index,async ref=>new Uint8Array(await read(ref)),prior?{index:prior,file:async ref=>{await reuse(ref);}}:undefined,
        (completed,total)=>reportBuildProgress({phase:'Validating mode summaries',completed,total,unit:'batches'}));
}
const parcelFilterFile=datasetPath(snapshot,'parcel-filters.json');
if(await fs.access(parcelFilterFile).then(()=>true,()=>false)){
    const bytes=await fs.readFile(parcelFilterFile),d=validateParcelFilterDiscovery(JSON.parse(bytes.toString()),manifest.snapshot);files.set('parcel-filters.json',bytes.length);
    const metadata=await decodeParcelFilterMetadata(await read(d.metadata),d.metadata,manifest.snapshot,manifest.publishedHeight+1);
    let prior:ParcelFilterBaseline|undefined;
    if(baseline&&baselineRoot&&await fs.access(datasetPath(baselineRoot,'parcel-filters.json')).then(()=>true,()=>false)){
        const old=validateParcelFilterDiscovery(JSON.parse(await fs.readFile(datasetPath(baselineRoot,'parcel-filters.json'),'utf8')),baseline.snapshot);
        const m=await decodeParcelFilterMetadata(new Uint8Array(await fs.readFile(datasetPath(baselineRoot,old.metadata.url))),old.metadata,baseline.snapshot,baseline.publishedHeight+1);
        const parent=await decodeAggregateIndex(new Uint8Array(await fs.readFile(datasetPath(baselineRoot,m.parent.url))),baseline.snapshot,m.parent),indexes=[];
        for(const ref of m.ranges)indexes.push(await decodeParcelFilterIndex(new Uint8Array(await fs.readFile(datasetPath(baselineRoot,ref.url))),ref,m));
        prior={metadata:m,parent,indexes,reuse:async ref=>{await reuse(ref);}};
    }
    await validateParcelFilters(snapshot,metadata,async ref=>new Uint8Array(await read(ref)),prior,
        (completed,total)=>reportBuildProgress({phase:'Validating parcel filters',completed,total,unit:'batches'}));
}
const layerFile=datasetPath(snapshot,'layer-analysis.json');
if(await fs.access(layerFile).then(()=>true,()=>false)){
    reportBuildProgress({phase:'Validating analytical layer data'});
    const bytes=await fs.readFile(layerFile),root=JSON.parse(bytes.toString()) as LayerAnalysis;
    validateLayerAnalysis(root,manifest.snapshot,manifest.publishedHeight+1);files.set('layer-analysis.json',bytes.length);
    const classes=decodeParcelClasses(await read(root.parcel.classes,'colors'),root.count),totals=Array<number>(9).fill(0);
    for(let id=0;id<root.count;id++)for(let j=0;j<9;j++)totals[j]+=classes[id*9+j];
    if(totals.some((n,j)=>n!==root.parcel.counts[j]))throw Error('Parcel class totals differ from distribution');
    decodeMetric(await read(root.area.values,'colors'),root.count);
    for(const [ref,kind,channels] of [[root.parcel.preview,'parcel-previews',3],[root.area.preview,'previews',1]] as const){
        const index=await previewCodec.decodeIndex(await read(ref,'colors'),manifest.snapshot,storage,kind);
        if(index.layout!==manifest.layout)throw Error('Layer preview layout mismatch');
        for(const tile of index.tiles){const payload=await read(tile),compressed=previewCodec.decodeTile(payload,tile,index);if(inflateSync(compressed,{maxOutputLength:index.resolution**2*4*channels}).length!==index.resolution**2*4*channels)throw Error('Invalid layer preview pixels');}
    }
}
const analyticsFile=datasetPath(snapshot,'analytics.json');
if(await fs.access(analyticsFile).then(()=>true,()=>false)){
    reportBuildProgress({phase:'Validating analytical pages'});
    const bytes=await fs.readFile(analyticsFile),root=JSON.parse(bytes.toString()) as AnalyticsIndex;
    validateAnalyticsIndex(root,manifest.snapshot,manifest.publishedHeight+1);files.set('analytics.json',bytes.length);
    for(const [key,ref] of Object.entries(root.patternPages??{}))decodePatternPage(await read(ref,'colors'),Number(key),root.count);
    for(let region=0;region<root.regions.length;region++)decodeInspection(await read(root.regions[region],'colors'),region,Math.min(2016,root.count-region*2016));
    for(const id of METRIC_IDS){
        const metric=root.metrics[id];decodeMetric(await read(metric.values,'colors'),root.count);
        const preview=await read(metric.preview,'colors'),index=await previewCodec.decodeIndex(preview,manifest.snapshot,storage,'parcel-previews');
        if(index.layout!==manifest.layout)throw Error('Analytics preview layout mismatch');
        for(const ref of index.tiles){const payload=await read(ref),compressed=previewCodec.decodeTile(payload,ref,index);if(inflateSync(compressed,{maxOutputLength:index.resolution**2*4}).length!==index.resolution**2*4)throw Error('Invalid analytics preview pixels');}
    }
}
if(!proto) {
const spatial = manifest.format === CHUNK_FORMAT;
if(spatial && (!manifest.grid || !Number.isSafeInteger(manifest.grid!.size) || manifest.grid!.size < 1 || manifest.grid.originX !== 0 || manifest.grid.originY !== 0 || manifest.grid.ownership !== 'top-left')) throw Error('Invalid chunk grid');
const layout = spatial ? new SpiralLayout(manifest.regions) : undefined;
const chunks = new Map<string,{ref:ChunkRef;chunk:ChunkDescriptor}>(), owners = new Map<number,string>();
for(const [id,region] of manifest.regions.entries()) {
    if(region.id!==id || !Number.isSafeInteger(region.width) || region.width<=0 || !Number.isSafeInteger(region.height) || region.height<=0) throw Error('Invalid region manifest');
    const descriptor=JSON.parse((await read(region.descriptor)).toString()) as RegionDescriptor; const geometryBytes=await read(descriptor.geometry);
    if(descriptor.id!==id || descriptor.coverage!==(selected.has(id)?'complete':'geometry-only')) throw Error('Invalid region descriptor');
    validateRegionPacks(descriptor,manifest.format);
    if(spatial) {
        const geometry=type.decode(geometryBytes);
        if(geometry.neighborhood!==id || geometry.width!==region.width || geometry.height!==region.height || geometry.bitmaps.length!==2016) throw Error('Invalid canonical geometry');
        if(selected.has(id)) for(const [i,rect] of geometry.bitmaps.entries()) {
            const expected=chunkAt(layout!.slots[id].x+rect.x,layout!.slots[id].y+rect.y,manifest.grid!.size);
            const ref=descriptor.chunks![descriptor.bitmapChunks![i]];
            if(ref.x!==expected.x || ref.y!==expected.y) throw Error('Wrong top-left chunk owner');
            owners.set(id*2016+i,`${ref.x},${ref.y}`);
        }
        for(const ref of descriptor.chunks!) {
            const key=`${ref.x},${ref.y}`, existing=chunks.get(key);
            if(existing && JSON.stringify(existing.ref)!==JSON.stringify(ref)) throw Error('Conflicting chunk references');
            if(existing) continue;
            const chunk=JSON.parse((await read(ref.descriptor)).toString()) as ChunkDescriptor;
            if(chunk.format!==CHUNK_FORMAT || chunk.x!==ref.x || chunk.y!==ref.y || chunk.size!==manifest.grid!.size || !Array.isArray(chunk.packs)) throw Error('Invalid chunk descriptor');
            chunks.set(key,{ref,chunk});
        }
    }
    for(const pack of descriptor.packs) {
        if(files.has(pack.url)) continue; // Shared across regions: validate/copy once.
        const bytes=await read(pack);
        async function* chunks() { yield bytes; }
        for await(const _record of parsePack(chunks(),pack)) { /* full coverage and frame hashes */ }
    }
}
if(spatial) {
    const seen=new Set();
    for(const [key,{chunk}] of chunks) {
        let count=0,last=-1;
        for(const ref of chunk.packs) {
            const pack=JSON.parse((await read(ref)).toString()) as PackRef;
            if(pack.format!==CHUNK_FORMAT || `${pack.chunkX},${pack.chunkY}`!==key || pack.first<=last) throw Error('Invalid spatial pack identity/order');
            const bytes=await read(pack);
            async function* source(){yield bytes;}
            for await(const record of parsePack(source(),pack)) {
                if(seen.has(record.id) || owners.get(record.id)!==key) throw Error('Duplicate/wrong chunk bitmap');
                seen.add(record.id);count++;
            }
            last=pack.last;
        }
        if(count!==chunk.records || last!==chunk.lastHeight) throw Error('Incomplete chunk coverage');
    }
    if(seen.size!==selected.size*2016) throw Error('Incomplete spatial snapshot');
}
}
} // Deep validation remains mandatory for generation and explicit audits.
async function walk(dir:string,prefix=''):Promise<string[]> {
    const found=[];
    for(const entry of await fs.readdir(dir,{withFileTypes:true})) {
        if(entry.isSymbolicLink()) throw Error('Symlinks are not supported in publication');
        const name=path.posix.join(prefix,entry.name);
        if(entry.isDirectory()) found.push(...await walk(path.join(dir,entry.name),name));
        else found.push(name);
    }
    return found;
}
// Explicit app allowlist: excludes public prototypes, private configs and previous snapshots.
const app=validationOnly?[]:(await walk(build)).filter(name=>name==='index.html'||name.startsWith('assets/')||name==='grid-icon.png');
reportBuildProgress({phase:'Checking validated dataset'});
if(!validationOnly) {
    if(!app.includes('index.html')) throw Error('Missing client bundle');
    const html=await fs.readFile(path.join(build,'index.html'),'utf8');
    if(!html.includes('assets/')) throw Error('Unexpected client entry');
}
let bytes=0;
for(const file of app) {
    const filename=path.join(build,file);
    bytes+=(await fs.stat(filename)).size;
    if(file.endsWith('.js') && /localhost:3000|\/api\/v1|socket\.io/.test(await fs.readFile(filename,'utf8'))) throw Error('Legacy transport found in static bundle');
}
const appBytes=bytes;
for(const size of files.values()) bytes+=size;
if(bytes>1_000_000_000) throw Error('Publication exceeds conservative 1 GB budget');
if(baselineInput&&!Buffer.from(await fs.readFile(baselineInput.filename)).equals(baselineInput.bytes))throw Error('Published baseline changed during validation');
const listOutput=options.find(o=>o.startsWith('--file-list='))?.slice('--file-list='.length);
if(listOutput)await fs.writeFile(listOutput,JSON.stringify({snapshot:manifest.snapshot,files:[...files.keys()].sort()})+'\n',{flag:'wx'});
if (validationOnly) { console.log(JSON.stringify({ status: 'passed', snapshot: manifest.snapshot, files: files.size, bytes, validation })); process.exit(0); }
await fs.mkdir(path.dirname(out),{recursive:true});
await fs.mkdir(out,{recursive:false});
reportBuildProgress({phase:'Copying application files',completed:0,total:app.length,unit:'files'});
let copiedApp=0;
for(const file of app) { const dest=path.join(out,file); await fs.mkdir(path.dirname(dest),{recursive:true}); await fs.copyFile(path.join(build,file),dest);reportBuildProgress({phase:'Copying application files',completed:++copiedApp,total:app.length,unit:'files'}); }
await fs.mkdir(path.join(out,'map-data'));
let publicationFiles=files.size+app.length;
if(isSemanticDataset(snapshot)){
    const {copyCurrentSemanticDataset}=await import('../semantic-dataset');
    const copied=await copyCurrentSemanticDataset(snapshot,path.join(out,'map-data'),manifest.snapshot);
    if(integrityOnly){bytes=appBytes+copied.bytes;publicationFiles=app.length+copied.files;}
}else {let copied=0;reportBuildProgress({phase:'Copying map files',completed:0,total:files.size,unit:'files'});for(const file of files.keys()) { const dest=path.join(out,'map-data',file); await fs.mkdir(path.dirname(dest),{recursive:true}); await fs.copyFile(fileSource(file),dest);reportBuildProgress({phase:'Copying map files',completed:++copied,total:files.size,unit:'files'}); }}
if(bytes>1_000_000_000)throw Error('Publication exceeds conservative 1 GB budget');
await fs.writeFile(path.join(out,'.nojekyll'),'');
if(!buildProgressEnabled())console.log(JSON.stringify({snapshot:manifest.snapshot,sample:report.sample,publicationBytes:bytes,files:publicationFiles}));
