import {isSemanticDataset} from './dataset-path';
import {convertSemanticDataset} from './semantic-dataset';
import {validateSpatialMetricsIndex,decodeSpatialMetricPage} from '../src/shared/spatialMetrics';
import { readMapManifest } from './read-map-manifest';
import { encodeJsonManifest, decodeMapManifest } from '../src/shared/mapManifest';
import { encodeParcelMeans, decodeParcelMeans, validateMeansRef, PARCEL_MEANS_PROTO } from '../src/shared/parcelMeans';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, realpath, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname, sep } from 'node:path';
import protobuf from 'protobufjs';
import { DATA_STORAGE, dataPath, validArtifactPath, type DataKind } from '../src/shared/dataStorage';
import { createProtoCodec } from '../src/shared/protobufChunks';
import { createPreviewCodec } from '../src/shared/heatmapPreview';
import { decodeNeighborhoodChunkIndex, decodeNeighborhoodChunkPage, decodeNeighborhoodChunk, encodeNeighborhoodChunkProto, encodeNeighborhoodChunkPageProto, NEIGHBORHOOD_CHUNKS_PROTO, type NeighborhoodChunkRef, jsonBytes } from '../src/shared/neighborhoodChunks';
import { HUFFMAN_FORMAT, type FileRef } from '../src/shared/httpPack';
import { argumentsFor } from './cli';
import { readReferenceSnapshot, writeReferencePatterns } from './reference-snapshot';
import { GenerationCoverage, generationProgressEnabled, reportGenerationProgress } from './generation-progress';
import { validateAnalyticsIndex, METRIC_IDS, type AnalyticsIndex } from '../src/shared/mapAnalytics';
import { validateLayerAnalysis, type LayerAnalysis } from '../src/shared/layerAnalysis';
import { validateLod4Discovery, decodeLod4Index, decodeLod4Region, encodeLod4Index, lod4RegionPath, type Lod4Discovery } from '../src/shared/lod4';

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const codec = createProtoCodec(protobuf), previews = createPreviewCodec(protobuf);

/** New output only: preserve canonical payloads, round-trip addons through Protobuf, authenticate a JSON root. */
export async function organizeMapData(sourceArg: string, outArg: string) {
    const source = await realpath(sourceArg), out = resolve(outArg);
    if(isSemanticDataset(source)){await convertSemanticDataset(source,out);return Bun.file(resolve(out,'report.json')).json();}
    assert(out !== source && !out.startsWith(source + sep) && !source.startsWith(out + sep), 'Separate new output required');
    await mkdir(dirname(out), { recursive: true });
    assert.equal(await realpath(dirname(out)), dirname(out), 'Output cannot traverse symlinks');
    const input = await readMapManifest(source), original=input.bytes;
    const manifest = input.manifest, prior = await Bun.file(resolve(source, 'report.json')).json();
    assert(manifest.format === HUFFMAN_FORMAT && prior.status === 'passed' && prior.snapshot === manifest.snapshot, 'Validated v9 dataset required');
    await mkdir(out, { recursive: false });
    const counts: Record<string, { files: number; bytes: number }> = {};
    const copied = new Set<string>();
    async function write(name: string, bytes: Uint8Array) {
        const dest = resolve(out, name);
        await mkdir(dirname(dest), { recursive: true });
        await writeFile(dest, bytes, { flag: 'wx' });
        if(name.includes('/')) {
            const kind = name.split('/')[0], total = counts[kind] ??= { files: 0, bytes: 0 };
            total.files++; total.bytes += bytes.length;
        }
    }
    async function read(ref: FileRef, lod4 = false) {
        assert(lod4 ? ref.url === `lod4/${ref.sha256}.pb` || ref.url === `lod4/regions/${ref.sha256}.pb` : validArtifactPath(ref.url, ref.sha256), 'Invalid immutable artifact path');
        const file = await realpath(resolve(source, ref.url));
        assert(file.startsWith(source + sep), 'Artifact escapes dataset');
        const bytes = await readFile(file);
        assert.equal(bytes.length, ref.bytes); assert.equal(hash(bytes), ref.sha256, ref.url);
        return bytes;
    }
    async function copy(ref: FileRef, kind: DataKind) {
        const bytes = await read(ref), name = dataPath(DATA_STORAGE, kind, ref.url.split('/').at(-1)!);
        if (!copied.has(name)) { await write(name, bytes); copied.add(name); }
        return bytes;
    }
    for (const region of manifest.regions) {
        await copy(region.geometry, 'geometry');
        assert(region.dimensions); await copy(region.dimensions, 'dimensions');
        reportGenerationProgress({ kind: 'neighborhood', phase: 'Organizing neighborhood files', id: region.id,
            completed: region.id + 1, total: manifest.regions.length, action: 'copied' });
    }
    let packs = 0;
    const progress = generationProgressEnabled() ? new GenerationCoverage(manifest.publishedHeight, manifest.parcelRegions.length) : undefined;
    for (const ref of manifest.indexPages!) {
        const bytes = await copy(ref, 'parcel-index');
        for (const chunk of codec.decodeIndexPage(bytes, ref, manifest)) for (const pack of chunk.packs) {
            await copy(pack, 'parcels'); packs++;
            if (progress) {
                for (const id of pack.ids!) progress.record(id);
                reportGenerationProgress({ kind: 'coverage', phase: 'Organizing parcel files', unit: 'Packs copied', completed: packs, ...progress.snapshot() });
            }
        }
    }
    const next = { ...manifest, storageLayout: DATA_STORAGE, snapshot: '' };
    const manifestBytes=await encodeJsonManifest(next);
    next.snapshot=(await decodeMapManifest(manifestBytes,'manifest.json')).snapshot;
    for (const [kind, name] of [['previews', 'preview.pb'], ['parcel-previews', 'parcel-size-preview.pb']] as const) {
        const input = resolve(source, dataPath(manifest.storageLayout, kind, name));
        if (!await Bun.file(input).exists()) continue;
        const index = await previews.decodeIndex(await readFile(input), manifest.snapshot, manifest.storageLayout, kind);
        for (const ref of index.tiles) await copy(ref, kind);
        index.sourceSnapshot = next.snapshot; index.snapshot = hash(previews.encodeIndex(index, false));
        await write(dataPath(DATA_STORAGE, kind, name), previews.encodeIndex(index));
    }
    for (const name of ['parcel-colors.json', 'bitmap-area-colors.json', 'neighborhood-chunks.json']) {
        if (!await Bun.file(resolve(source, name)).exists()) continue;
        const bytes = await readFile(resolve(source, name)), root = JSON.parse(bytes.toString());
        assert.equal(root.sourceSnapshot, manifest.snapshot);
        if (name === 'parcel-colors.json') {
            validateMeansRef(root.means,root.count,root.format);
            const values=decodeParcelMeans(await read({...root.means,url:dataPath(manifest.storageLayout,'colors',root.means.url)}),root.count,root.format);
            const payload=encodeParcelMeans(values),sha256=hash(payload),url=sha256+'.pb';
            assert.deepEqual(decodeParcelMeans(payload,root.count,PARCEL_MEANS_PROTO),values);
            await write(dataPath(DATA_STORAGE,'colors',url),payload);
            root.format=PARCEL_MEANS_PROTO;root.means={url,sha256,bytes:payload.length};
        }
        if (name === 'neighborhood-chunks.json') {
            const index = await decodeNeighborhoodChunkIndex(bytes, manifest.snapshot);
            const pages=[];
            for (const page of index.pages) {
                const payload = await read({ ...page, url: dataPath(manifest.storageLayout, 'bitmap-chunks', page.url) });
                const chunks:NeighborhoodChunkRef[]=[];
                for (const ref of decodeNeighborhoodChunkPage(payload, page, index)) {
                    const bytes=await read({ ...ref, url: dataPath(manifest.storageLayout, 'bitmap-chunks', ref.url) });
                    const chunk=decodeNeighborhoodChunk(bytes,ref,index,manifest.publishedHeight);
                    const converted=encodeNeighborhoodChunkProto(chunk.bitmaps,ref.x,ref.y,index.size),sha256=hash(converted),url=sha256+'.pb';
                    const nextRef={...ref,url,sha256,bytes:converted.length};
                    assert.deepEqual(decodeNeighborhoodChunk(converted,nextRef,{...index,format:NEIGHBORHOOD_CHUNKS_PROTO},manifest.publishedHeight).bitmaps,chunk.bitmaps);
                    await write(dataPath(DATA_STORAGE,'bitmap-chunks',url),converted);chunks.push(nextRef);
                }
                const converted=encodeNeighborhoodChunkPageProto(chunks,page.x,page.y),sha256=hash(converted),url=sha256+'.pb';
                const nextPage={...page,url,sha256,bytes:converted.length};
                assert.deepEqual(decodeNeighborhoodChunkPage(converted,nextPage,{...index,format:NEIGHBORHOOD_CHUNKS_PROTO}),chunks);
                await write(dataPath(DATA_STORAGE,'bitmap-chunks',url),converted);pages.push(nextPage);
            }
            root.format=NEIGHBORHOOD_CHUNKS_PROTO;root.pages=pages;
        }
        root.sourceSnapshot = next.snapshot;
        if (name === 'neighborhood-chunks.json') { const { snapshot: _, ...unsigned } = root; root.snapshot = hash(jsonBytes(unsigned)); }
        await write(name, jsonBytes(root));
    }
    const reference = await readReferenceSnapshot(source, manifest.snapshot, manifest.publishedHeight + 1);
    if (reference) await writeReferencePatterns(out, next.snapshot, reference.patterns);
    if(await Bun.file(resolve(source,'analytics.json')).exists()){
        const root=await Bun.file(resolve(source,'analytics.json')).json() as AnalyticsIndex;
        validateAnalyticsIndex(root,manifest.snapshot,manifest.publishedHeight+1);
        for(const ref of Object.values(root.patternPages??{}) as FileRef[])await copy({...ref,url:dataPath(manifest.storageLayout,'colors',ref.url)},'colors');
        for(const ref of root.regions)await copy({...ref,url:dataPath(manifest.storageLayout,'colors',ref.url)},'colors');
        for(const id of METRIC_IDS){
            const metric=root.metrics[id];await copy({...metric.values,url:dataPath(manifest.storageLayout,'colors',metric.values.url)},'colors');
            const bytes=await read({...metric.preview,url:dataPath(manifest.storageLayout,'colors',metric.preview.url)});
            const index=await previews.decodeIndex(bytes,manifest.snapshot,manifest.storageLayout,'parcel-previews');
            for(const ref of index.tiles)await copy(ref,'parcel-previews');
            index.sourceSnapshot=next.snapshot;index.snapshot=hash(previews.encodeIndex(index,false));
            const payload=previews.encodeIndex(index),sha256=hash(payload),url=sha256+'.pb',name=dataPath(DATA_STORAGE,'colors',url);
            if(!copied.has(name)){await write(name,payload);copied.add(name);}
            metric.preview={url,sha256,bytes:payload.length};
        }
        root.sourceSnapshot=next.snapshot;await write('analytics.json',jsonBytes(root));
    }
    if(await Bun.file(resolve(source,'metrics.json')).exists()){
        const root=await Bun.file(resolve(source,'metrics.json')).json();validateSpatialMetricsIndex(root,manifest.snapshot,manifest.publishedHeight+1);
        for(let id=0;id<root.regions.length;id++){const ref=root.regions[id],bytes=new Uint8Array(await readFile(resolve(source,ref.url)));assert(bytes.length===ref.bytes&&hash(bytes)===ref.sha256);decodeSpatialMetricPage(bytes,id,Math.min(2016,root.count-id*2016));await write(ref.url,bytes);}
        root.sourceSnapshot=next.snapshot;await write('metrics.json',jsonBytes(root));
    }
    if(await Bun.file(resolve(source,'layer-analysis.json')).exists()){
        const root=await Bun.file(resolve(source,'layer-analysis.json')).json() as LayerAnalysis;
        validateLayerAnalysis(root,manifest.snapshot,manifest.publishedHeight+1);
        for(const ref of [root.parcel.classes,root.area.values])await copy({...ref,url:dataPath(manifest.storageLayout,'colors',ref.url)},'colors');
        for(const [owner,kind] of [[root.parcel,'parcel-previews'],[root.area,'previews']] as const){
            const index=await previews.decodeIndex(await read({...owner.preview,url:dataPath(manifest.storageLayout,'colors',owner.preview.url)}),manifest.snapshot,manifest.storageLayout,kind);
            for(const ref of index.tiles)await copy(ref,kind);
            index.sourceSnapshot=next.snapshot;index.snapshot=hash(previews.encodeIndex(index,false));
            const payload=previews.encodeIndex(index),sha256=hash(payload),url=sha256+'.pb',name=dataPath(DATA_STORAGE,'colors',url);
            if(!copied.has(name)){await write(name,payload);copied.add(name);}
            owner.preview={url,sha256,bytes:payload.length};
        }
        root.sourceSnapshot=next.snapshot;await write('layer-analysis.json',jsonBytes(root));
    }
    if (await Bun.file(resolve(source, 'lod4.json')).exists()) {
        const discovery = validateLod4Discovery(await Bun.file(resolve(source, 'lod4.json')).json() as Lod4Discovery, manifest.snapshot);
        const index = await decodeLod4Index(await read(discovery.index, true), manifest.snapshot, discovery.index.sha256);
        assert.equal(index.bitmapCount, manifest.publishedHeight + 1);
        assert.equal(index.regions.length, manifest.regions.length);
        for (const ref of index.regions) {
            const canonical = manifest.regions[ref.id];
            assert(canonical && ref.width === canonical.width && ref.height === canonical.height && ref.geometrySha256 === canonical.geometry.sha256, 'LOD4 canonical geometry mismatch');
            const name = `lod4/${lod4RegionPath(ref)}`, bytes = await read({ ...ref, url: name }, true);
            await decodeLod4Region(bytes, ref, index);
            await write(name, bytes);
        }
        index.sourceSnapshot = next.snapshot;
        const bytes = encodeLod4Index(index), sha256 = hash(bytes), url = `lod4/${sha256}.pb`;
        await write(url, bytes);
        await write('lod4.json', jsonBytes({ ...discovery, sourceSnapshot: next.snapshot, index: { url, sha256, bytes: bytes.length } }));
    }
    assert.deepEqual(await readFile(input.filename), original, 'Source changed during conversion');
    const bytes = manifestBytes; await decodeMapManifest(bytes,'manifest.json');
    const report = { ...prior, snapshot: next.snapshot, storageLayout: DATA_STORAGE, storageSourceSnapshot: manifest.snapshot,
        storage: counts, storageValidation: 'All referenced immutable files checked by SHA-256 and length; geometry, dimensions, parcel packs/pages and tiles copied byte for byte; every bitmap chunk field and Float32 mean compared after Protobuf conversion; JSON roots authenticated without layout/TX regeneration.', packs };
    await write('report.json', Buffer.from(JSON.stringify(report, null, 2) + '\n'));
    // The entry is written last so an interrupted conversion cannot look complete.
    await write('manifest.json', bytes);
    return report;
}

if (import.meta.main) {
    const args = argumentsFor(process.argv.slice(2), ['--source', '--out']);
    if (!args['--source'] || !args['--out']) throw Error('Use --source MAP_DATA --out NEW_MAP_DATA');
    console.log(JSON.stringify(await organizeMapData(args['--source'], args['--out']), null, 2));
}
