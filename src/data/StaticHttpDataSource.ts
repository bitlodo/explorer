import {validateDatasetReference} from '../shared/datasetReference';
import { decodeParcelFilterMetadata, decodeParcelFilterIndex, decodeParcelFilterBatch, validateParcelFilterDiscovery, validParcelFilterPath, PARCEL_FILTER_LIMIT, PARCEL_FILTER_BATCH_LIMIT, type ParcelFilterMetadata, type ParcelFilterIndex, type ParcelFilterBatchRef } from '../shared/parcelFilters';
import {decodePatternPage} from '../shared/patternPages';
import {decodeRelease,routeBucket,immutableName,type MapRelease} from '../shared/mapRelease';
import { validateSpatialMetricsIndex, decodeSpatialMetricPage, type SpatialMetricsIndex } from '../shared/spatialMetrics';
import RequestCoordinator, { SharedRequests } from './RequestCoordinator';
import { DownloadError } from './RetryPolicy';
import { decodeLod4Index, decodeLod4Region, validateLod4Discovery, type Lod4Index, type Lod4Discovery, lod4RegionPath } from '../shared/lod4';
import { decodeAggregateIndex, decodeAggregateBatch, validateAggregateDiscovery, validAggregatePath, LOD4_AGGREGATE_INDEX_LIMIT, LOD4_BATCH_LIMIT, type AggregateIndex, type AggregateBatchRef } from '../shared/lod4Aggregates';
import { decodeMapManifest, JSON_MANIFEST_LIMIT } from '../shared/mapManifest';
import { validateLayerAnalysis, type LayerAnalysis } from '../shared/layerAnalysis';
import { validateAnalyticsIndex, decodeMetric, decodeInspection, type AnalyticsIndex, type MetricId, type BitmapInspection } from '../shared/mapAnalytics';
import { decodeParcelMeans, validateMeansRef } from '../shared/parcelMeans';
import { dataPath } from '../shared/dataStorage';
import protobuf from 'protobufjs';
import {createPreviewCodec,PREVIEW_LIMIT,type PreviewIndex,type PreviewTileRef} from '../shared/heatmapPreview';
import descriptor from '../shared/proto/neighborhood_descriptor.json';
import { HUFFMAN_FORMAT, isPagedFormat, decodeSizes, PAGED_FORMAT, DIMENSIONS_FORMAT, SHUFFLE_FORMAT, CHAIN_FORMAT, PROTO_FORMAT, CHUNK_FORMAT, GROUP_FORMAT, chunkAt, validatePack, supportsFormat, validateRegionPacks, LIMITS, check, integer, sha256, parsePack, type ChunkRef, type ChunkDescriptor, type FileRef, type Manifest, type RegionDescriptor, type PackRef } from '../shared/httpPack';
import { PROTO_MANIFEST_BYTES, createProtoCodec, type ProtoManifest, type ProtoChunk, type IndexPageRef } from '../shared/protobufChunks';
import type { NeighborhoodData } from '../map/types';
import type { LoadedChunk, MapDataSource, ParcelJob } from './MapDataSource';
import PackCache from './PackCache';
import SingleParcelCache from './SingleParcelCache';
import SmallRecordCache from './SmallRecordCache';
import {frameHash} from './frameHash';
import NeighborhoodLayoutClient from './NeighborhoodLayoutClient';
import NeighborhoodChunkSource from './NeighborhoodChunkSource';
import type {ChunkBounds,NeighborhoodChunkRef} from '@shared/neighborhoodChunks';
const protoCodec = createProtoCodec(protobuf,frameHash);
const previewCodec = createPreviewCodec(protobuf);
const yieldToTask=()=>new Promise<void>(resolve=>setTimeout(resolve,0));
type NeighborhoodLoad = { promise: Promise<NeighborhoodData>; controller: AbortController; users: number; settled: boolean };

export default class StaticHttpDataSource implements MapDataSource {
    readonly mode = 'static' as const;
    onChunkPackLoaded?: (chunk: LoadedChunk) => void;
    onPreviewTileLoaded?: (chunk: LoadedChunk) => void;
    private cache = new PackCache();
    private singleParcels=new SingleParcelCache();
    private smallRecords=new SmallRecordCache();
    private manifest?: Manifest;
    private proto?: ProtoManifest;
    private protoChunks = new Map<string, ProtoChunk>();
    private indexRefs = new Map<string, IndexPageRef>();
    private indexPages = new Map<string, { promise: Promise<Map<string, ProtoChunk>>; settled: boolean; bytes: number }>();
    private indexWaiters: (() => void)[] = [];
    private geometry = new Map<number, NeighborhoodData>();
    private neighborhoodLoads = new Map<number, NeighborhoodLoad>();
    private layouts = new NeighborhoodLayoutClient();
    private neighborhoodChunks = new NeighborhoodChunkSource(()=>this.getManifest(),(path,limit,signal)=>this.small(path,limit,signal),(ref,signal)=>this.file({...ref,url:dataPath(this.proto?.storageLayout,'bitmap-chunks',ref.url)},signal));
    private layoutCache = new PackCache(1024 * 1024, 16 * 1024 * 1024, 'http-neighborhood-layout-v1');
    private geometryMode: 'client' | 'server';
    private preferredNeighborhood?: number;
    private lod4Load?:Promise<Lod4Index|undefined>;
    private aggregateLoad?:Promise<AggregateIndex|undefined>;
    private parcelFilterMetadata?:Promise<ParcelFilterMetadata>;
    private parcelFilterCache=new PackCache(4*1024*1024,64*1024*1024,'http-parcel-spatial-filters-v1');
    private aggregateCache=new PackCache(8*1024*1024,16*1024*1024,'http-lod4-aggregates-v2');
    private lod4Cache=new PackCache(512*1024,16*1024*1024,'http-lod4-spatial-v1');
    private previewLoad?:Promise<PreviewIndex|undefined>;
    private previewCache = new PackCache(4*1024*1024,256*1024*1024,'http-heatmap-preview-v1');
    private manifestLoad?: Promise<Manifest>;
    private files = new SharedRequests<Uint8Array>();
    private requests = new RequestCoordinator(4);
    private analyticsCache = new PackCache(4 * 1024 * 1024, 64 * 1024 * 1024, 'http-analytics-v1');
    private chunks = new Map<string, Promise<Map<number, PackRef>>>();
    private regions = new Map<number, Promise<RegionDescriptor>>();
    private abort = new AbortController();
    private type = protobuf.Root.fromJSON(descriptor).lookupType('Neighborhood');
    private release?:MapRelease;
    private releasePath?:string;
    private routes=new Map<string,Promise<Record<string,FileRef>>>();
    readonly base: URL;
    private requestContext:{viewRevision?:number;modeRevision?:number;mode?:string}={};
    readonly downloads:{path:string;purpose:string;bodyBytes:number;cache:'network'|'memory'|'persistent';outcome:string;reason?:string;viewRevision?:number;modeRevision?:number;mode?:string}[]=[];
    setRequestContext(context:typeof this.requestContext){this.requestContext={...context};}
    private recordDownload(path:string,cache:'network'|'memory'|'persistent'){
        const entry={path,purpose:/manifest|index|json/.test(path)?'metadata':/colors|metrics/.test(path)?'analysis':/parcels/.test(path)?'parcels':'geometry',bodyBytes:0,cache,outcome:'queued',...this.requestContext};
        this.downloads.push(entry);if(this.downloads.length>256)this.downloads.shift();return entry as typeof this.downloads[number];
    }
    readonly stats = { networkBytes: 0, cacheBytes: 0, framesValidated: 0, packsCompleted: 0, singleParcelHits:0, smallRecordHits:0, neighborhoodLayouts: 0, neighborhoodLayoutCacheHits: 0, neighborhoodLayoutMs: 0, indexPagesLoaded: 0, indexPageBytes: 0 };
    constructor(base: string, private entry: 'manifest.pb' | 'manifest.json' = 'manifest.pb', geometryMode?: 'client' | 'server',private discoverDataset=false) {
        const release=typeof document==='undefined'?undefined:document.querySelector('meta[name="bitmap-release"]')?.getAttribute('content');
        if(release){check(/^releases\/[a-f0-9]{64}\.json$/.test(release),'Invalid pinned release');this.releasePath=release;}
        this.base = new URL(base.endsWith('/') ? base : base + '/', location.href);
        this.geometryMode = geometryMode ?? (new URL(location.href).searchParams.get('neighborhoods') === 'server' ? 'server' : 'client');
    }
    private url(path: string) {
        check(typeof path === 'string' && !path.includes('..') && !path.startsWith('/') && !/^[a-z]+:/i.test(path), 'Invalid artifact path');
        return new URL(path, this.base);
    }
    private async artifactUrl(path:string):Promise<string>{
        if(!this.release||path.startsWith('routing/')||path.startsWith('releases/'))return path;
        const root=this.release.roots[path];if(root)return root.url;
        const key=routeBucket(path),ref=key?this.release.routes[key]:undefined;
        if(!key||!ref)throw new DownloadError('Artifact absent from pinned release',404);
        let load=this.routes.get(key);if(load){this.routes.delete(key);this.routes.set(key,load);}
        if(!load){load=(async()=>{const bytes=await this.payload(ref,this.cache,LIMITS.metadata);check(bytes.length===ref.bytes&&await sha256(bytes)===ref.sha256,'Release routing integrity failure');return JSON.parse(new TextDecoder().decode(bytes)) as Record<string,FileRef>;})().catch(e=>{this.routes.delete(key);throw e;});this.routes.set(key,load);while(this.routes.size>16)this.routes.delete(this.routes.keys().next().value!);}
        const target=(await load)[path];check(target&&target.sha256===path.match(/([a-f0-9]{64})\.[^.]+$/)?.[1]&&immutableName(target.url),'Invalid release artifact route');return target.url;
    }
    private async response(path: string, signal = this.abort.signal, direct = false) {
        signal.throwIfAborted();const logical=path;if(!direct)path=await this.artifactUrl(path);signal.throwIfAborted();const event=this.recordDownload(logical,'network');
        signal = AbortSignal.any([signal, this.abort.signal]);
        const release = await this.requests.acquire(signal, /(?:index|manifest|dimensions|json)/.test(path) ? 2 : /(?:colors|metrics)/.test(path) ? 0 : 1).catch(error=>{event.outcome='cancelled';event.reason=String(signal.reason??error);throw error;});
        try {
            event.outcome='active';const response = await fetch(this.url(path), { signal });
            if (response.status !== 200) {
                await response.body?.cancel();
                const retry = response.headers.get('retry-after');
                const retryAfter = retry ? (/^\d+$/.test(retry) ? Number(retry) * 1000 : Math.max(0, Date.parse(retry) - Date.now())) : 0;
                throw new DownloadError(`Map download failed (${response.status})`, response.status, retryAfter);
            }
            if(response.headers.get('content-type')?.includes('text/html')){await response.body?.cancel();throw new DownloadError('Unexpected HTML instead of map data',undefined,0,true);}
            check(response.body, 'Streaming HTTP is unavailable');
            const reader = response.body.getReader();
            const thisSource=this;const body = new ReadableStream<Uint8Array>({
                async pull(controller) {
                    try { const next = await reader.read(); if (next.done) { event.outcome='complete';release(); controller.close(); } else {event.bodyBytes+=next.value.length;thisSource.stats.networkBytes+=next.value.length;controller.enqueue(next.value);} }
                    catch (error) { event.outcome=signal.aborted?'cancelled':'failed';event.reason=error instanceof Error?error.message:String(error);release(); controller.error(error); }
                },
                async cancel(reason) { if(event.outcome!=='complete'){event.outcome='cancelled';event.reason=String(reason??signal.reason??'Consumer stopped');}try { await reader.cancel(reason); } finally { release(); } },
            });
            return new Response(body, { status: 200, headers: response.headers });
        } catch (error) {event.outcome=signal.aborted?'cancelled':'failed';event.reason=error instanceof Error?error.message:String(error);release(); throw error; }
    }
    private async small(path: string, limit: number, signal = this.abort.signal, direct = false) {
        signal.throwIfAborted();
        const response = await this.response(path, signal, direct);
        const reader = response.body!.getReader(), chunks: Uint8Array[] = []; let length = 0;
        try { while (true) { signal.throwIfAborted(); const next = await reader.read(); if (next.done) break; length += next.value.length; check(length <= limit, 'Metadata exceeds memory limit'); chunks.push(next.value); } }
        finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        signal.throwIfAborted();
        const bytes = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
        const ref=this.release?.roots[path];if(ref)check(bytes.length===ref.bytes&&await sha256(bytes)===ref.sha256,'Release root integrity failure');return bytes;
    }
    private async payload(ref: FileRef, cache: PackCache, limit: number, signal = this.abort.signal, direct = false) {
        check(integer(ref.bytes, 1, limit) && /^[a-f0-9]{64}$/.test(ref.sha256), 'Invalid file reference');
        if(direct)check(validAggregatePath(ref.url,ref.sha256)||validParcelFilterPath(ref.url,ref.sha256),'Invalid direct analytical reference');
        signal = AbortSignal.any([signal, this.abort.signal]);
        return this.files.run(ref.sha256, signal, async shared => {
            const memory=cache.peek(ref.sha256),cached = await cache.get(ref.sha256); shared.throwIfAborted();
            if (cached && cached.length === ref.bytes && await sha256(cached) === ref.sha256) { shared.throwIfAborted(); this.stats.cacheBytes += cached.length;this.recordDownload(ref.url,memory===cached?'memory':'persistent').outcome='complete';return cached; }
            const bytes = await this.small(ref.url, ref.bytes, shared, direct); shared.throwIfAborted();
            if (bytes.length !== ref.bytes || await sha256(bytes) !== ref.sha256) throw new DownloadError('Artifact integrity mismatch', undefined, 0, true);
            shared.throwIfAborted(); await cache.putMany([{ hash: ref.sha256, bytes }]); shared.throwIfAborted(); return bytes;
        });
    }
    private file(ref: FileRef, signal?: AbortSignal) { return this.payload(ref, this.cache, LIMITS.metadata, signal); }

    private async discoverSourceRelease(){
        let bytes:Uint8Array;
        try{bytes=await this.small('release.json',2048);}catch(error){if((error as {status?:number}).status===404)return false;throw error;}
        const reference=validateDatasetReference(JSON.parse(new TextDecoder().decode(bytes))).release;
        const descriptor=await this.small(reference.url,reference.bytes);check(descriptor.length===reference.bytes,'Dataset release length mismatch');
        this.releasePath=reference.url;this.release=await decodeRelease(descriptor,reference.sha256);return true;
    }
    async getManifest(): Promise<Manifest> {
        if (this.manifest) return this.manifest; // Snapshot pinned for this map session.
        if (!this.manifestLoad) this.manifestLoad = (async () => {
            if(this.discoverDataset&&!this.releasePath)await this.discoverSourceRelease();
            if(this.releasePath&&!this.release){const bytes=await this.small(this.releasePath,256*1024);this.release=await decodeRelease(bytes,this.releasePath.split('/')[1].slice(0,64));}
            let entry=this.release?.roots['manifest.json']?'manifest.json' as const:this.entry, payload:Uint8Array;
            try{payload=await this.small(entry,entry==='manifest.pb'?PROTO_MANIFEST_BYTES:JSON_MANIFEST_LIMIT);}
            catch(error){if((error as {status?:number}).status!==404)throw error;
                if(!this.release&&await this.discoverSourceRelease())entry=this.release!.roots['manifest.json']?'manifest.json':'manifest.pb';else entry=entry==='manifest.pb'?'manifest.json':'manifest.pb';
                payload=await this.small(entry,entry==='manifest.pb'?PROTO_MANIFEST_BYTES:JSON_MANIFEST_LIMIT);}
            this.abort.signal.throwIfAborted();
            const manifest=await decodeMapManifest(payload,entry);
            if(this.release)check(manifest.snapshot===this.release.snapshot&&manifest.grid?.size===this.release.grids.parcels,'Pinned release manifest mismatch');
            this.abort.signal.throwIfAborted();
            if ((manifest.format === PROTO_FORMAT || manifest.format === CHAIN_FORMAT || manifest.format === SHUFFLE_FORMAT || manifest.format === DIMENSIONS_FORMAT || isPagedFormat(manifest.format))) {
                this.proto = manifest as ProtoManifest;
                for (const chunk of this.proto.chunks) this.protoChunks.set(`${chunk.x},${chunk.y}`, chunk);
                for (const ref of this.proto.indexPages || []) this.indexRefs.set(`${ref.x},${ref.y}`, ref);
            }
            check(supportsFormat(manifest.format) && typeof manifest.layout === 'string' && manifest.layout.length > 0 && manifest.layout.length <= 128 && typeof manifest.snapshot === 'string', 'Incompatible map manifest');
            check(Array.isArray(manifest.regions) && manifest.regions.length > 0 && manifest.regions.length <= 10000, 'Invalid region manifest');
            manifest.regions.forEach((r, i) => check(r.id === i && integer(r.width, 1, 0x7fffffff) && integer(r.height, 1, 0x7fffffff), 'Invalid/non-contiguous region manifest'));
            check(manifest.publishedHeight === manifest.regions.length * 2016 - 1, 'Invalid published height');
            this.abort.signal.throwIfAborted();
            if (manifest.format === CHUNK_FORMAT) check(manifest.grid && integer(manifest.grid.size, 1, 0x7fffffff) && manifest.grid.originX === 0 && manifest.grid.originY === 0 && manifest.grid.ownership === 'top-left', 'Invalid chunk grid');
            // V7 changes only geometry delivery; parcel files still use the v6
            // wire format and hashes, so retain their existing authenticated cache.
            if (manifest.format === GROUP_FORMAT || manifest.format === CHUNK_FORMAT || (manifest.format === PROTO_FORMAT || manifest.format === CHAIN_FORMAT || manifest.format === SHUFFLE_FORMAT || manifest.format === DIMENSIONS_FORMAT || isPagedFormat(manifest.format))) { this.cache.close(); this.cache = new PackCache(undefined, undefined, manifest.format === HUFFMAN_FORMAT ? 'http-pack-cache-v9' : manifest.format === PAGED_FORMAT || manifest.format === DIMENSIONS_FORMAT || manifest.format === SHUFFLE_FORMAT ? 'http-pack-cache-v6' : manifest.format === CHAIN_FORMAT ? 'http-pack-cache-v5' : manifest.format === PROTO_FORMAT ? 'http-pack-cache-v4' : manifest.format === CHUNK_FORMAT ? 'http-pack-cache-v3' : 'http-pack-cache-v2'); }
            this.manifest = manifest; return manifest;
        })().catch(error => { this.manifestLoad = undefined; throw error; });
        return this.manifestLoad;
    }
    private spatialMetrics?:Promise<SpatialMetricsIndex>;
    getSpatialMetricsIndex(){
        if(!this.spatialMetrics)this.spatialMetrics=(async()=>{const manifest=await this.getManifest();const root=JSON.parse(new TextDecoder().decode(await this.small('metrics.json',256*1024)));validateSpatialMetricsIndex(root,manifest.snapshot,manifest.publishedHeight+1);return root as SpatialMetricsIndex;})().catch(e=>{this.spatialMetrics=undefined;throw e;});
        return this.spatialMetrics;
    }
    async getSpatialMetricPage(region:number,signal:AbortSignal){
        const root=await this.getSpatialMetricsIndex();signal.throwIfAborted();const ref=root.regions[region];check(ref,'Invalid metric page');
        const bytes=await this.payload(ref,this.analyticsCache,128*1024,signal);signal.throwIfAborted();return decodeSpatialMetricPage(bytes,region,Math.min(2016,root.count-region*2016));
    }
    private areaData?:Promise<{maxArea:number;neighborhoodMeans:number[]}>;
    private analyticsIndex?: Promise<AnalyticsIndex>;
    private layerAnalysis?:Promise<LayerAnalysis>;
    getLayerAnalysis(){
        if(!this.layerAnalysis)this.layerAnalysis=(async()=>{const manifest=await this.getManifest();const root=JSON.parse(new TextDecoder().decode(await this.small('layer-analysis.json',128*1024)));validateLayerAnalysis(root,manifest.snapshot,manifest.publishedHeight+1);return root as LayerAnalysis;})().catch(error=>{this.layerAnalysis=undefined;throw error;});
        return this.layerAnalysis;
    }
    async getParcelClassBytes(signal?:AbortSignal){const root=await this.getLayerAnalysis();signal?.throwIfAborted();return this.analyticsFile(root.parcel.classes,signal);}
    getLod4Index():Promise<Lod4Index|undefined>{
        if(!this.lod4Load)this.lod4Load=(async()=>{
            const manifest=await this.getManifest();if(!this.proto)return;
            let bytes:Uint8Array;
            try{bytes=await this.small('lod4.json',2048);}catch(error){if((error as {status?:number}).status===404)return;throw error;}
            const discovery=validateLod4Discovery(JSON.parse(new TextDecoder().decode(bytes)) as Lod4Discovery,manifest.snapshot);
            const data=await this.small(discovery.index.url,discovery.index.bytes);
            check(data.length===discovery.index.bytes,'Invalid LOD4 index length');
            const index=await decodeLod4Index(data,manifest.snapshot,discovery.index.sha256);
            check(index.bitmapCount===manifest.publishedHeight+1&&index.regions.length===manifest.regions.length,'LOD4 published coverage mismatch');
            index.regions.forEach((r,id)=>{const expected=this.proto!.regions[id];check(r.width===expected.width&&r.height===expected.height&&r.geometrySha256===expected.geometry.sha256,'LOD4 canonical geometry mismatch');});
            return index;
        })().catch(e=>{this.lod4Load=undefined;throw e;});
        return this.lod4Load;
    }
    getLod4SummaryIndex():Promise<AggregateIndex|undefined>{
        if(!this.aggregateLoad)this.aggregateLoad=(async()=>{
            const manifest=await this.getManifest();
            // Older pinned releases keep their original LOD4 contract.
            if(this.release&&!this.release.roots['lod4-summary.json'])return;
            let bytes:Uint8Array;
            try{bytes=await this.small('lod4-summary.json',2048);}catch(error){if((error as {status?:number}).status===404)return;throw error;}
            const d=validateAggregateDiscovery(JSON.parse(new TextDecoder().decode(bytes)),manifest.snapshot);
            const index=await decodeAggregateIndex(await this.payload(d.index,this.aggregateCache,LOD4_AGGREGATE_INDEX_LIMIT,undefined,true),manifest.snapshot,d.index);
            check(index.regions.length===manifest.regions.length,'Aggregate manifest coverage mismatch');
            index.regions.forEach((r,id)=>{const original=this.proto!.regions[id];check(r.width===original.width&&r.height===original.height&&r.geometrySha256===original.geometry.sha256,'Aggregate canonical identity mismatch');});
            return index;
        })().catch(error=>{this.aggregateLoad=undefined;throw error;});
        return this.aggregateLoad;
    }
    async getLod4SummaryBatch(index:AggregateIndex,ref:AggregateBatchRef,signal:AbortSignal){
        check(index===await this.getLod4SummaryIndex(),'Aggregate index does not belong to this source');signal.throwIfAborted();
        const bytes=await this.payload(ref,this.aggregateCache,LOD4_BATCH_LIMIT,signal,true);signal.throwIfAborted();
        return decodeAggregateBatch(bytes,ref,index);
    }
    getParcelFilterMetadata():Promise<ParcelFilterMetadata>{
        if(!this.parcelFilterMetadata)this.parcelFilterMetadata=(async()=>{
            const manifest=await this.getManifest(),d=validateParcelFilterDiscovery(JSON.parse(new TextDecoder().decode(await this.small('parcel-filters.json',2048))),manifest.snapshot);
            const metadata=await decodeParcelFilterMetadata(await this.payload(d.metadata,this.parcelFilterCache,PARCEL_FILTER_LIMIT,undefined,true),d.metadata,manifest.snapshot,manifest.publishedHeight+1);
            const analysis=await this.getLayerAnalysis();for(let j=0;j<9;j++)check(metadata.regionCounts.reduce((sum,n,i)=>sum+(i%9===j?n:0),0)===analysis.parcel.counts[j],'Parcel filter distribution mismatch');return metadata;
        })().catch(error=>{this.parcelFilterMetadata=undefined;throw error;});return this.parcelFilterMetadata;
    }
    async getParcelFilterIndex(low:number,high:number,signal:AbortSignal){
        const m=await this.getParcelFilterMetadata();signal.throwIfAborted();const ref=m.ranges.find(r=>r.low===low&&r.high===high);check(ref,'Unsupported parcel filter range');
        const index=await decodeParcelFilterIndex(await this.payload(ref,this.parcelFilterCache,PARCEL_FILTER_LIMIT,signal,true),ref,m);
        // Exact regional class totals certify empty filters before any spatial download.
        index.matchingRegions=Array.from({length:m.regionCounts.length/9},(_,id)=>id).filter(id=>m.regionCounts.slice(id*9+low-1,id*9+high).some(n=>n>0));return index;
    }
    async getParcelFilterBatch(index:ParcelFilterIndex,ref:ParcelFilterBatchRef,signal:AbortSignal){
        const parent=await this.getLod4SummaryIndex(),m=await this.getParcelFilterMetadata();signal.throwIfAborted();check(parent&&index.parentSha256===m.parent.sha256,'Invalid parcel filter parent');
        return decodeParcelFilterBatch(await this.payload(ref,this.parcelFilterCache,PARCEL_FILTER_BATCH_LIMIT,signal,true),ref,index,parent.regions);
    }
    async getLod4Region(index:Lod4Index,id:number,signal:AbortSignal){
        const ref=index.regions[id];check(ref?.id===id,'Invalid LOD4 requested region');
        const cached=await this.lod4Cache.get(ref.sha256);
        const bytes=cached??await this.small('lod4/'+lod4RegionPath(ref),ref.bytes,signal);
        signal.throwIfAborted();const page=await decodeLod4Region(bytes,ref,index);
        if(!cached)await this.lod4Cache.putMany([{hash:ref.sha256,bytes}]);
        return page;
    }
    async getAreaMetric(signal?:AbortSignal){const root=await this.getLayerAnalysis();signal?.throwIfAborted();const bytes=await this.analyticsFile(root.area.values,signal);signal?.throwIfAborted();return decodeMetric(bytes,root.count);}
    async getClassPreview(){const root=await this.getLayerAnalysis(),manifest=await this.getManifest();const index=await previewCodec.decodeIndex(await this.analyticsFile(root.parcel.preview),manifest.snapshot,this.proto?.storageLayout,'parcel-previews');check(index.layout===manifest.layout,'Parcel class preview layout mismatch');return {...index,channels:3 as const};}
    private inspectionRegions = new Map<number, Promise<BitmapInspection[]>>();
    async getPatternInputs(signal:AbortSignal){
        const manifest=await this.getManifest(),analytics=await this.getAnalyticsIndex();signal.throwIfAborted();
        const index=JSON.parse(new TextDecoder().decode(await this.small('bitmap-reference.json',4096,signal)));
        check(index.format==='bitmap-reference-protobuf-v1'&&index.sourceSnapshot===manifest.snapshot&&index.count===analytics.count,'Pattern reference snapshot mismatch');
        const ref=index.patterns;
        check(ref?.url===ref?.sha256+'.pb'&&/^[a-f0-9]{64}$/.test(ref.sha256)&&integer(ref.bytes,1,analytics.count*5+1024),'Invalid pattern reference');
        const [patternBytes,countBytes]=await Promise.all([this.payload(ref,this.analyticsCache,analytics.count*5+1024,signal),this.analyticsFile(analytics.metrics.count.values,signal)]);
        signal.throwIfAborted();return {snapshot:manifest.snapshot,count:analytics.count,patternBytes,countBytes};
    }
    async getPatternMatches(pattern: number): Promise<number[]> {
        const analytics=await this.getAnalyticsIndex();
        if(analytics.patternPages){const ref=analytics.patternPages[String(Math.floor(pattern/1024))];check(ref,'Unknown pattern');const bytes=await this.analyticsFile(ref);return decodePatternPage(bytes,Math.floor(pattern/1024),analytics.count).get(pattern)??[];}
        const manifest=await this.getManifest(),count=manifest.publishedHeight+1;
        const index=JSON.parse(new TextDecoder().decode(await this.small('bitmap-reference.json',4096)));
        check(index.format==='bitmap-reference-protobuf-v1'&&index.sourceSnapshot===manifest.snapshot&&index.count===count,'Pattern reference snapshot mismatch');
        const ref=index.patterns;
        check(ref?.url===ref?.sha256+'.pb'&&/^[a-f0-9]{64}$/.test(ref.sha256)&&integer(ref.bytes,1,count*5+1024),'Invalid pattern reference');
        const bytes=await this.payload(ref,this.analyticsCache,count*5+1024);
        const type=protobuf.Root.fromJSON({nested:{Reference:{fields:{version:{type:'uint32',id:1},sourceSnapshot:{type:'string',id:2},patterns:{rule:'repeated',type:'uint32',id:3,options:{packed:true}}}}}}).lookupType('Reference');
        const raw=type.toObject(type.decode(bytes),{arrays:true,defaults:true});
        check(raw.version===1&&raw.sourceSnapshot===manifest.snapshot&&raw.patterns.length===count&&raw.patterns.every((p:number,id:number)=>integer(p,0,id)&&raw.patterns[p]===p),'Invalid pattern membership');
        return raw.patterns.flatMap((p:number,id:number)=>p===pattern?[id]:[]);
    }
    getAnalyticsIndex(): Promise<AnalyticsIndex> {
        if (!this.analyticsIndex) this.analyticsIndex = (async () => {
            const manifest = await this.getManifest();
            const root = JSON.parse(new TextDecoder().decode(await this.small('analytics.json',512*1024)));
            validateAnalyticsIndex(root,manifest.snapshot,manifest.publishedHeight+1);return root;
        })().catch(error=>{this.analyticsIndex=undefined;throw error;});
        return this.analyticsIndex;
    }
    private analyticsFile(ref: FileRef, signal?: AbortSignal): Promise<Uint8Array> {
        return this.payload({...ref,url:dataPath(this.proto?.storageLayout,'colors',ref.url)},this.analyticsCache,48*1024*1024,signal);
    }
    private metricRequests=new SharedRequests<{values:Float32Array;preview:PreviewIndex}>();
    getAnalyticsMetric(id:MetricId,signal=this.abort.signal){
        return this.metricRequests.run(id,AbortSignal.any([signal,this.abort.signal]),async shared=>{
            const root=await this.getAnalyticsIndex();shared.throwIfAborted();const metric=root.metrics[id];
            const bytes=await this.analyticsFile(metric.values,shared);shared.throwIfAborted();
            const values=decodeMetric(bytes,root.count);shared.throwIfAborted();
            const previewBytes=await this.analyticsFile(metric.preview,shared);shared.throwIfAborted();
            const preview=await previewCodec.decodeIndex(previewBytes,root.sourceSnapshot,this.proto?.storageLayout,'parcel-previews');
            shared.throwIfAborted();check(preview.layout===this.manifest?.layout,'Analytics preview layout mismatch');return {values,preview};
        });
    }
    async inspectBitmap(id: number): Promise<BitmapInspection> {
        const root=await this.getAnalyticsIndex();check(integer(id,0,root.count-1),'Bitmap outside analytics');
        const region=Math.floor(id/2016);let load=this.inspectionRegions.get(region);
        if(!load){load=this.analyticsFile(root.regions[region]).then(bytes=>decodeInspection(bytes,region,Math.min(2016,root.count-region*2016)))
            .catch(error=>{this.inspectionRegions.delete(region);throw error;});this.inspectionRegions.set(region,load);
            while(this.inspectionRegions.size>4)this.inspectionRegions.delete(this.inspectionRegions.keys().next().value!);
        }
        const row=(await load)[id%2016];
        return root.regionEncoding==='inspection-local-v2'?{...row,occurrences:(await this.getPatternMatches(row.pattern)).length}:row;
    }
    getBitmapAreaData(){
        if(!this.areaData)this.areaData=(async()=>{
            const manifest=await this.getManifest();
            const root=JSON.parse(new TextDecoder().decode(await this.small('bitmap-area-colors.json',256*1024)));
            check(root.format==='bitmap-area-colors-v1'&&root.normalization==='linear-area-v1'&&root.sourceSnapshot===manifest.snapshot&&root.count===manifest.publishedHeight+1,'Invalid bitmap area summary');
            check(integer(root.maxArea,1,145908)&&Array.isArray(root.neighborhoodMeans)&&root.neighborhoodMeans.length===manifest.regions.length&&root.neighborhoodMeans.every((v:unknown)=>typeof v==='number'&&Number.isFinite(v)&&v>=1&&v<=root.maxArea),'Invalid area range or neighborhood means');
            return {maxArea:root.maxArea,neighborhoodMeans:root.neighborhoodMeans as number[]};
        })().catch(error=>{this.areaData=undefined;throw error;});
        return this.areaData;
    }
    private sizeData?:Promise<{means:Float32Array;preview:PreviewIndex}>;
    getParcelSizeData(){
        if(!this.sizeData)this.sizeData=(async()=>{
            const manifest=await this.getManifest();
            const root=JSON.parse(new TextDecoder().decode(await this.small('parcel-colors.json',4096)));
            check((root.format==='parcel-size-means-v1'||root.format==='parcel-size-means-v2-protobuf')&&root.sourceSnapshot===manifest.snapshot&&root.count===manifest.publishedHeight+1&&root.count<=1048576,'Invalid parcel size summary');
            validateMeansRef(root.means,root.count,root.format);check(root.preview==='parcel-size-preview.pb','Invalid size preview path');
            const bytes=await this.small(dataPath(this.proto?.storageLayout,'colors',root.means.url),root.means.bytes);
            check(bytes.length===root.means.bytes&&await sha256(bytes)===root.means.sha256,'Parcel size summary hash mismatch');
            const means=decodeParcelMeans(bytes,root.count,root.format);
            const preview=await previewCodec.decodeIndex(await this.small(dataPath(this.proto?.storageLayout,'parcel-previews',root.preview),PREVIEW_LIMIT),manifest.snapshot,this.proto?.storageLayout,'parcel-previews');
            check(preview.layout===manifest.layout,'Parcel preview layout mismatch');
            return {means,preview};
        })().catch(error=>{this.sizeData=undefined;throw error;});
        return this.sizeData;
    }
    async getPreviewIndex():Promise<PreviewIndex|undefined>{
        if(!this.previewLoad)this.previewLoad=(async()=>{
            const manifest=await this.getManifest();
            try{const bytes=await this.small(dataPath(this.proto?.storageLayout,'previews','preview.pb'),PREVIEW_LIMIT);this.abort.signal.throwIfAborted();const index=await previewCodec.decodeIndex(bytes,manifest.snapshot,this.proto?.storageLayout);check(index.layout===manifest.layout,'Preview layout mismatch');return index;}
            catch(error){if((error as {status?:number}).status===404)return undefined;throw error;}
        })();
        return this.previewLoad;
    }
    async getPreviewTile(ref:PreviewTileRef,index:PreviewIndex,signal:AbortSignal):Promise<Uint8Array>{
        signal.throwIfAborted();
        let bytes=await this.previewCache.get(ref.sha256);
        if(!bytes||bytes.length!==ref.bytes||await sha256(bytes)!==ref.sha256){bytes=await this.small(ref.url,ref.bytes,signal);check(bytes.length===ref.bytes&&await sha256(bytes)===ref.sha256,'Preview integrity failure');await this.previewCache.putMany([{hash:ref.sha256,bytes}]);}
        const compressed=previewCodec.decodeTile(bytes,ref,index),expected=index.resolution*index.resolution*4*(index.channels??1);
        const stream=new Blob([new Uint8Array(compressed).buffer]).stream().pipeThrough(new DecompressionStream('deflate')),reader=stream.getReader();
        const pixels=new Uint8Array(expected);let offset=0;
        try{while(true){signal.throwIfAborted();this.abort.signal.throwIfAborted();const next=await reader.read();if(next.done)break;check(offset+next.value.length<=expected,'Preview inflation exceeds budget');pixels.set(next.value,offset);offset+=next.value.length;}}
        finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
        check(offset===expected,'Truncated preview pixels');signal.throwIfAborted();this.abort.signal.throwIfAborted();
        this.onPreviewTileLoaded?.({x:ref.x,y:ref.y,size:index.tileSize*2**ref.level});return pixels;
    }
    private async region(id: number): Promise<RegionDescriptor> {
        const manifest = await this.getManifest(); const region = manifest.regions[id]; check(region, 'Region outside snapshot');
        if (this.proto) { const r = this.proto.regions[id]; return { format: PROTO_FORMAT, id, geometry: r.geometry, coverage: r.coverage, packs: [] }; }
        let pending = this.regions.get(id);
        if (pending) { this.regions.delete(id); this.regions.set(id, pending); }
        if (!pending) {
            pending = (async () => {
                const result = JSON.parse(new TextDecoder().decode(await this.file(region.descriptor))) as RegionDescriptor;
                check(result.id === id, 'Invalid region descriptor ID');
                validateRegionPacks(result, manifest.format); return result;
            })().catch(error => { this.regions.delete(id); throw error; });
            this.regions.set(id, pending);
            while (this.regions.size > 24) this.regions.delete(this.regions.keys().next().value!);
        }
        return pending;
    }
    prioritizeNeighborhood(id: number) { this.preferredNeighborhood = id; this.layouts.prioritize(id); }
    getNeighborhoodChunkRefs(bounds:ChunkBounds,signal:AbortSignal){return this.neighborhoodChunks.refs(bounds,signal);}
    getNeighborhoodChunk(ref:NeighborhoodChunkRef,signal:AbortSignal){return this.neighborhoodChunks.load(ref,signal);}
    async getNeighborhood(id: number, signal?: AbortSignal): Promise<NeighborhoodData> {
        signal?.throwIfAborted();
        this.abort.signal.throwIfAborted();
        const cached = this.geometry.get(id);
        if (cached) { this.geometry.delete(id); this.geometry.set(id, cached); return cached; }
        let load = this.neighborhoodLoads.get(id);
        if (!load) {
            const controller = new AbortController();
            load = { controller, users: 0, settled: false, promise: undefined! };
            const current = load;
            load.promise = this.loadNeighborhood(id, AbortSignal.any([controller.signal, this.abort.signal])).finally(() => {
                current.settled = true;
                if (this.neighborhoodLoads.get(id) === current) this.neighborhoodLoads.delete(id);
            });
            this.neighborhoodLoads.set(id, load);
        }
        const current = load;
        return new Promise((resolve, reject) => {
            current.users++; let done = false;
            const finish = (action: () => void) => {
                if (done) return; done = true; signal?.removeEventListener('abort', cancel);
                current.users--;
                if (!current.users && !current.settled) {
                    if (this.neighborhoodLoads.get(id) === current) this.neighborhoodLoads.delete(id);
                    current.controller.abort();
                }
                action();
            };
            const cancel = () => finish(() => reject(signal?.reason || new DOMException('Aborted', 'AbortError')));
            current.promise.then(data => finish(() => resolve(data)), error => finish(() => reject(error)));
            signal?.addEventListener('abort', cancel, { once: true });
            if (signal?.aborted) cancel();
        });
    }
    private async loadNeighborhood(id: number, signal: AbortSignal): Promise<NeighborhoodData> {
        const region = await this.region(id), manifest = await this.getManifest();
        signal.throwIfAborted();
        const compact = this.proto?.regions[id]?.dimensions;
        let bytes: Uint8Array;
        if (compact && this.geometryMode === 'client') {
            const key = await sha256(new TextEncoder().encode(`http-neighborhood-layout-v1:${compact.sha256}:${region.geometry.sha256}`));
            const cached = await this.layoutCache.get(key);
            signal.throwIfAborted();
            if (cached && cached.length === region.geometry.bytes && await sha256(cached) === region.geometry.sha256) {
                bytes = cached; this.stats.neighborhoodLayoutCacheHits++;
            } else {
                const dimensions = new Uint8Array(await this.file(compact, signal));
                signal.throwIfAborted();
                const result = await this.layouts.generate({ dimensions, dimensionsHash: compact.sha256, expected: { id, width: manifest.regions[id].width, height: manifest.regions[id].height, sha256: region.geometry.sha256, bytes: region.geometry.bytes } }, signal, id === this.preferredNeighborhood ? 100 : 0);
                bytes = result.wire;
                check(bytes instanceof Uint8Array && bytes.length === region.geometry.bytes && await sha256(bytes) === region.geometry.sha256, 'Invalid generated neighborhood output');
                signal.throwIfAborted();
                this.stats.neighborhoodLayouts++; this.stats.neighborhoodLayoutMs += result.durationMs;
                await this.layoutCache.putMany([{ hash: key, bytes }]);
            }
        } else bytes = await this.file(region.geometry, signal);
        signal.throwIfAborted();
        const data = this.type.decode(bytes) as unknown as NeighborhoodData;
        check(data.neighborhood === id && data.width === manifest.regions[id].width && data.height === manifest.regions[id].height && data.bitmaps.length === 2016, 'Geometry does not match manifest');
        for (const r of data.bitmaps) check(integer(r.x, 0, data.width) && integer(r.y, 0, data.height) && integer(r.width, 1, data.width) && integer(r.height, 1, data.height) && r.x + r.width <= data.width && r.y + r.height <= data.height, 'Invalid canonical bitmap rectangle');
        if (this.proto) {
            this.geometry.set(id, data);
            while (this.geometry.size > 32) this.geometry.delete(this.geometry.keys().next().value!);
        }
        return data;
    }
    private async chunk(ref: ChunkRef): Promise<Map<number, PackRef>> {
        const key = ref.descriptor.sha256;
        let pending = this.chunks.get(key);
        if (pending) { this.chunks.delete(key); this.chunks.set(key, pending); return pending; }
        pending = (async () => {
            const manifest = await this.getManifest();
            const chunk = JSON.parse(new TextDecoder().decode(await this.file(ref.descriptor))) as ChunkDescriptor;
            check(chunk.format === CHUNK_FORMAT && chunk.x === ref.x && chunk.y === ref.y && chunk.size === manifest.grid?.size && Array.isArray(chunk.packs) && chunk.packs.length <= 65536, 'Invalid chunk descriptor');
            const result = new Map<number, PackRef>();
            let last = -1;
            // Sequential metadata reads bound pending buffers for unusually dense chunks.
            for (const reference of chunk.packs) {
                const pack = JSON.parse(new TextDecoder().decode(await this.file(reference))) as PackRef;
                validatePack(pack);
                check(pack.format === CHUNK_FORMAT && pack.chunkX === ref.x && pack.chunkY === ref.y && pack.first > last, 'Wrong chunk pack identity/order');
                for (const id of pack.ids!) { check(id <= manifest.publishedHeight && !result.has(id), 'Duplicate/out-of-snapshot chunk bitmap'); result.set(id, pack); }
                last = pack.last;
            }
            check(result.size === chunk.records && last === chunk.lastHeight, 'Chunk coverage mismatch');
            return result;
        })().catch(error => { this.chunks.delete(key); throw error; });
        this.chunks.set(key, pending);
        while (this.chunks.size > 24) this.chunks.delete(this.chunks.keys().next().value!);
        return pending;
    }
    /** The job key is the immutable pack hash, independent of region references. */
    async getParcelJobs(ids: number[], signal=this.abort.signal): Promise<ParcelJob[]> {
        await this.getManifest();signal.throwIfAborted();
        const cached:number[]=[],sizes:number[]=[],missing:number[]=[],small:import('../shared/httpPack').ParcelRecord[]=[];
        let first=Infinity,last=-1;
        for(const id of ids){const size=this.singleParcels.get(id);if(size){cached.push(id);sizes.push(size);first=Math.min(first,id);last=Math.max(last,id);}else {const record=this.smallRecords.get(id);if(record)small.push(record);else missing.push(id);}}
        if(cached.length||small.length){
            const members=new Set([...cached,...small.map(r=>r.id)]),jobs:ParcelJob[]=[];
            if(cached.length){const singles=new Set(cached);jobs.push({key:'validated-single-parcels',first,last,ids:cached,singleSizes:new Uint8Array(sizes),contains:id=>singles.has(id)});}
            if(small.length){const smallIds=small.map(r=>r.id),set=new Set(smallIds);jobs.push({key:'validated-small-records',first:Math.min(...smallIds),last:Math.max(...smallIds),ids:smallIds,validatedRecords:small,contains:id=>set.has(id)});}
            return [...jobs,...(missing.length?(await this.getParcelJobs(missing,signal)).map(j=>({...j,skipIds:members})):[])];
        }
        if (this.proto) return this.protoJobs(ids,signal);
        const grouped = new Map<number, number[]>();
        for (const id of ids) { const n = Math.floor(id / 2016), list = grouped.get(n) || []; list.push(id); grouped.set(n, list); }
        const regions = await Promise.all([...grouped].map(async ([id, wanted]) => {
            try { return { id, wanted, region: await this.region(id) }; }
            catch (error) { return { id, wanted, error: error instanceof Error ? error.message : String(error),failure:error }; }
        }));
        const jobs = new Map<string, ParcelJob>(), checkedReferences = new Set<PackRef>();
        for (const { id, wanted, region, error, failure } of regions) {
            if (!region || region.coverage !== 'complete') {
                const key = `unavailable:${id}`;
                jobs.set(key, { key, first: id * 2016, last: (id + 1) * 2016 - 1, ids: wanted, failure,error: error || 'Parcel detail is not included in this sample snapshot.' });
                continue;
            }
            for (const bitmap of wanted) {
                try {
                    const chunk = region.chunks?.[region.bitmapChunks?.[bitmap % 2016] ?? -1];
                    const pack = region.format === CHUNK_FORMAT
                        ? (check(chunk, 'Missing bitmap chunk owner'), (await this.chunk(chunk)).get(bitmap))
                        : region.packs.find(p => bitmap >= p.first && bitmap <= p.last);
                    check(pack, 'Bitmap missing from pack index');
                    const existing = jobs.get(pack.sha256);
                    if (existing) {
                        if (!checkedReferences.has(pack)) {
                            check(JSON.stringify(existing.pack) === JSON.stringify(pack), 'Conflicting shared pack metadata');
                            checkedReferences.add(pack);
                        }
                        existing.ids.push(bitmap);
                    } else jobs.set(pack.sha256, { key: pack.sha256, first: pack.first, last: pack.last, pack, ids: [bitmap] });
                } catch (error) {
                    const key = `unavailable:${id}`, existing = jobs.get(key);
                    if (existing) existing.ids.push(bitmap);
                    else jobs.set(key, { key, first: id * 2016, last: (id + 1) * 2016 - 1, ids: [bitmap], error: error instanceof Error ? error.message : String(error),failure:error });
                }
            }
        }
        return [...jobs.values()].sort((a, b) => ids.indexOf(a.ids[0]) - ids.indexOf(b.ids[0]));
    }
    private async protoJobs(ids: number[],signal:AbortSignal): Promise<ParcelJob[]> {
        const manifest = this.proto!, grouped = new Map<number, number[]>(), jobs = new Map<string, ParcelJob>();
        for (const id of ids) { const region = Math.floor(id / 2016), list = grouped.get(region) || []; list.push(id); grouped.set(region, list); }
        await Promise.all([...grouped].map(async ([id, wanted]) => {
            try {
                const region = manifest.regions[id];
                check(region?.coverage === 'complete', 'Parcel detail is not included in this snapshot.');
                const geometry = await this.getNeighborhood(id,signal);signal.throwIfAborted();
                const owners = new Map<string, { x: number; y: number; ids: number[] }>();
                for (const bitmap of wanted) {
                    const rect = geometry.bitmaps[bitmap % 2016];
                    check(rect, 'Bitmap outside protobuf geometry');
                    const owner = chunkAt(region.x + rect.x, region.y + rect.y, manifest.grid!.size);
                    const key = `${owner.x},${owner.y}`, group = owners.get(key) || { ...owner, ids: [] };
                    group.ids.push(bitmap); owners.set(key, group);
                }
                await Promise.all([...owners.values()].map(async owner => {
                    const chunk = await this.protoChunkAt(owner.x, owner.y,signal);
                    for (const bitmap of owner.ids) {
                    const pack = chunk?.packs.find(p => p.first <= bitmap && p.last >= bitmap && (!p.ids||this.hasBitmap(p.ids,bitmap)));
                    check(pack, 'Bitmap missing from direct protobuf index');
                    const existing = jobs.get(pack.sha256);
                    if (existing) existing.ids.push(bitmap);
                    else jobs.set(pack.sha256, { key: pack.sha256, first: pack.first, last: pack.last, pack, ids: [bitmap], contains: id => this.protoContains(pack, id) });
                    }
                }));
            } catch (error) {
                signal.throwIfAborted();const key = `unavailable:${id}`;
                jobs.set(key, { key, first: id * 2016, last: (id + 1) * 2016 - 1, ids: wanted, error: error instanceof Error ? error.message : String(error),failure:error });
            }
        }));
        const rank = new Map(ids.map((id, i) => [id, i]));
        return [...jobs.values()].sort((a, b) => rank.get(a.ids[0])! - rank.get(b.ids[0])!);
    }
    private indexRequests=new SharedRequests<Map<string,ProtoChunk>>();
    private indexQueue=new RequestCoordinator(2);
    private async protoChunkAt(x:number,y:number,signal=this.abort.signal):Promise<ProtoChunk|undefined>{
        signal.throwIfAborted();const manifest=this.proto!;
        if(!isPagedFormat(manifest.format))return this.protoChunks.get(`${x},${y}`);
        const key=`${Math.floor(x/manifest.indexPageSide!)},${Math.floor(y/manifest.indexPageSide!)}`,ref=this.indexRefs.get(key);if(!ref)return;
        let entry=this.indexPages.get(key);
        if(entry){this.indexPages.delete(key);this.indexPages.set(key,entry);return (await entry.promise).get(`${x},${y}`);}
        const result=await this.indexRequests.run(key,signal,async shared=>{
            const release=await this.indexQueue.acquire(shared);
            try{
                const bytes=await this.file(ref,shared);shared.throwIfAborted();const chunks=protoCodec.decodeIndexPage(bytes,ref,manifest);
                const result=new Map(chunks.map(c=>[`${c.x},${c.y}`,c]));
                const size=chunks.reduce((sum,c)=>sum+c.packs.reduce((s,p)=>s+256+(p.ids?.length||0)*8,0),bytes.length);
                this.indexPages.set(key,{promise:Promise.resolve(result),bytes:size,settled:true});this.stats.indexPagesLoaded++;this.trimIndexPages();return result;
            }finally{release();}
        });
        signal.throwIfAborted();return result.get(`${x},${y}`);
    }
    private trimIndexPages() {
        let bytes = [...this.indexPages.values()].reduce((sum, e) => sum + e.bytes, 0);
        let count = [...this.indexPages.values()].filter(e => e.settled).length;
        for (const [key, entry] of this.indexPages) {
            if (count <= 16 && bytes <= 8 * 1024 * 1024) break;
            if (!entry.settled) continue; bytes -= entry.bytes; count--; this.indexPages.delete(key);
        }
        this.stats.indexPageBytes = bytes;
    }
    private hasBitmap(ids:readonly number[],bitmap:number){
        let lo=0,hi=ids.length;while(lo<hi){const mid=(lo+hi)>>>1;if(ids[mid]<bitmap)lo=mid+1;else hi=mid;}return ids[lo]===bitmap;
    }
    private protoContains(pack: PackRef, bitmap: number) {
        if(pack.ids)return this.hasBitmap(pack.ids,bitmap);
        if (bitmap < pack.first || bitmap > pack.last) return false;
        const id = Math.floor(bitmap / 2016), region = this.proto!.regions[id], rect = this.geometry.get(id)?.bitmaps[bitmap % 2016];
        if (!region || !rect) return false;
        const c = chunkAt(region.x + rect.x, region.y + rect.y, this.proto!.grid!.size);
        return c.x === pack.chunkX && c.y === pack.chunkY;
    }
    async *streamParcelJob(job: ParcelJob, signal: AbortSignal) {
        if(job.validatedRecords){
            for(let i=0;i<job.validatedRecords.length;i++){
                signal.throwIfAborted();this.abort.signal.throwIfAborted();this.stats.smallRecordHits++;
                const record=job.validatedRecords[i];yield {...record,tx:record.tx.slice()};
                if((i&127)===127)await new Promise<void>(resolve=>setTimeout(resolve,0));
            }
            return;
        }
        if(job.singleSizes){
            // Cooperative batches preserve UI opportunities even when every read is synchronous RAM.
            for(let i=0;i<job.ids.length;i++){
                signal.throwIfAborted();this.abort.signal.throwIfAborted();
                const size=job.singleSizes[i];this.stats.singleParcelHits++;
                yield {id:job.ids[i],txCount:1,rle:false,tx:new Uint8Array([size<<4])};
                if((i&1023)===1023)await new Promise<void>(resolve=>setTimeout(resolve,0));
            }
            return;
        }
        if(job.error)throw job.failure??new DownloadError(job.error,undefined,0,true);
        check(job.pack,'Missing pack job');
        const cacheWanted=new Set(job.ids);
        const visit=(record:import('../shared/httpPack').ParcelRecord)=>{
            if(record.txCount===1)this.singleParcels.set(record.id,record.encoding===4?decodeSizes(record)[0]:record.tx[0]>>>4);
            else if(cacheWanted.has(record.id))this.smallRecords.set(record);
            return !job.skipIds?.has(record.id)&&(!job.accept||job.accept(record.id));
        };
        for await(const record of this.streamPack(job.pack,signal,visit))yield record;
    }
    async *streamParcels(neighborhood: number, ids: number[], signal: AbortSignal) {
        check(ids.every(id => Math.floor(id / 2016) === neighborhood), 'Wrong neighborhood request');
        const wanted = new Set(ids);
        for (const job of await this.getParcelJobs(ids,signal)) {
            for await (const record of this.streamParcelJob(job, signal)) if (wanted.has(record.id)) yield record;
        }
    }
    private async *streamPack(pack: PackRef, signal: AbortSignal,visit?:(record:import('../shared/httpPack').ParcelRecord)=>boolean) {
        if (pack.format === CHAIN_FORMAT || pack.format === SHUFFLE_FORMAT || pack.format === HUFFMAN_FORMAT) { yield* this.streamChainedPack(pack, signal,visit); return; }
        signal.throwIfAborted();
        const cache = this.cache, stats = this.stats;
        // Probe without retaining all frames in RAM. A second read streams a warm pack.
        let warm = true;
        for (const frame of pack.frames) { const value = await cache.get(frame.sha256); if (!value || value.length !== frame.bytes || await sha256(value) !== frame.sha256) { warm = false; break; } }
        const source = this;
        const chunks = async function* () {
            if (warm) {
                for (const frame of pack.frames) { signal.throwIfAborted(); const bytes = await cache.get(frame.sha256); check(bytes, 'Cached frame evicted during read; retry region'); stats.cacheBytes += bytes.length; yield bytes; }
                return;
            }
            const response = await source.response(pack.url, signal); check(response.body, 'Streaming body unavailable');
            const reader = response.body.getReader();
            try { while (true) { signal.throwIfAborted(); const next = await reader.read(); if (next.done) break; yield next.value; } }
            finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        };
        let pending: { hash: string; bytes: Uint8Array }[] = [];
        try {
            const parser = (pack.format === PROTO_FORMAT || pack.format === CHAIN_FORMAT) ? protoCodec.parsePack : parsePack;
            for await (const record of parser(chunks(), pack, async (hash, bytes) => {
                stats.framesValidated++;
                if (!warm) { pending.push({ hash, bytes }); if (pending.length >= 4) { await cache.putMany(pending); pending = []; } }
            })) {
                signal.throwIfAborted(); if(!visit||visit(record))yield record;
            }
            stats.packsCompleted++;
            if ((pack.format === CHUNK_FORMAT || pack.format === PROTO_FORMAT || pack.format === CHAIN_FORMAT) && this.manifest?.grid) this.onChunkPackLoaded?.({ x: pack.chunkX!, y: pack.chunkY!, size: this.manifest.grid.size });
        } finally { if (pending.length) await cache.putMany(pending); }
    }
    private async *streamChainedPack(pack: PackRef, signal: AbortSignal,visit?:(record:import('../shared/httpPack').ParcelRecord)=>boolean) {
        signal.throwIfAborted();
        const source = this, cache = this.cache, stats = this.stats;
        let wholeCached=false,completeWire:Uint8Array|undefined,networkWire:Uint8Array|undefined,receivedWire=0,verifiedBytes=0,completed=false;
        let firstFrame:{hash:string;bytes:Uint8Array}|undefined;
        const prefixKey=pack.sha256+':prefix-v1';
        const chunks = async function* () {
            const whole=await cache.get(pack.sha256);
            if(whole&&whole.length===pack.bytes&&await sha256(whole)===pack.sha256){
                wholeCached=true;stats.cacheBytes+=whole.length;yield whole;return;
            }
            let hash = pack.headSha256!, prefix = 0, count = 0;
            const prefixParts:Uint8Array[]=[];
            const partial=await cache.get(prefixKey);
            if(partial&&partial.length<=pack.bytes){
                const reader=protobuf.Reader.create(partial);
                for(;count<pack.frameCount!&&reader.pos<partial.length;count++){
                    signal.throwIfAborted();let frame:Uint8Array;
                    try{const start=reader.pos,length=reader.uint32();if(length>LIMITS.frame+64||reader.pos+length>partial.length)break;reader.pos+=length;frame=partial.subarray(start,reader.pos);
                        if(await frameHash(frame)!==hash)break;const info=protoCodec.inspectChainFrame(frame);if(info.index!==count)break;hash=info.next;
                    }catch{break;}
                    stats.cacheBytes+=frame.length;prefix+=frame.length;yield frame;
                }
            }
            if(prefix&&partial)prefixParts.push(partial.subarray(0,prefix));
            for (; count < pack.frameCount!; count++) {
                signal.throwIfAborted(); const cached = cache.peek(hash);
                if (!cached || await frameHash(cached) !== hash) break;
                const info = protoCodec.inspectChainFrame(cached);
                stats.cacheBytes += cached.length; prefix += cached.length; hash = info.next;prefixParts.push(cached); yield cached;
            }
            if (count === pack.frameCount) {if(partial?.length===pack.bytes)completeWire=partial;return;}
            let response:Response;
            try{response=await source.response(pack.url,signal);}
            catch(error){
                signal.throwIfAborted();source.abort.signal.throwIfAborted();
                // Old frame-only caches remain useful offline, without making
                // online navigation wait for thousands of serial disk reads.
                for(;count<pack.frameCount!;count++){
                    const cached=await cache.get(hash);if(!cached||await frameHash(cached)!==hash)throw error;
                    const info=protoCodec.inspectChainFrame(cached);stats.cacheBytes+=cached.length;hash=info.next;yield cached;
                }
                return;
            }
            check(response.body, 'Streaming body unavailable');
            const reader = response.body.getReader(); let skip = prefix;
            const collected=new Uint8Array(pack.bytes);networkWire=collected;let received=0;
            let offset=0;for(const part of prefixParts){collected.set(part,offset);offset+=part.length;}
            try {
                while (true) {
                    signal.throwIfAborted(); const next = await reader.read(); if (next.done) break;
                   
                    check(received+next.value.length<=pack.bytes,'Pack exceeds declared size');
                    for(let i=0,n=Math.min(skip,next.value.length);i<n;i++)check(next.value[i]===collected[received+i],'Resumed pack prefix mismatch');
                    collected.set(next.value,received);received+=next.value.length;receivedWire=received;
                    if (skip >= next.value.length) { skip -= next.value.length; continue; }
                    yield next.value.subarray(skip); skip = 0;
                }
                check(skip === 0, 'Truncated resumed protobuf pack');
                check(received===pack.bytes,'Truncated complete protobuf pack');completeWire=collected;
            } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        };
        let lastYield=performance.now();
        try {
            for await (const record of protoCodec.parsePack(chunks(), pack, (hash, bytes) => {
                signal.throwIfAborted();source.abort.signal.throwIfAborted();
                stats.framesValidated++;verifiedBytes+=bytes.length;if(!firstFrame)firstFrame={hash,bytes};
            },async()=>{if(performance.now()-lastYield>=12){await yieldToTask();lastYield=performance.now();}},visit)) { signal.throwIfAborted(); yield record; }
            if(completeWire){check(await sha256(completeWire)===pack.sha256,'Complete pack hash mismatch');await cache.putMany([{hash:pack.sha256,bytes:completeWire}]);}
            completed=true;
            stats.packsCompleted++;
            this.onChunkPackLoaded?.({ x: pack.chunkX!, y: pack.chunkY!, size: this.manifest!.grid!.size });
        } finally {
            if(!completed&&!wholeCached&&networkWire&&verifiedBytes&&receivedWire>=verifiedBytes){
                await cache.putMany([{hash:prefixKey,bytes:networkWire.slice(0,verifiedBytes)},...(firstFrame?[firstFrame]:[])]);
            }
        }
    }
    close() { this.neighborhoodChunks.close();this.routes.clear(); this.onChunkPackLoaded = undefined; this.onPreviewTileLoaded = undefined; this.abort.abort(); for (const resolve of this.indexWaiters.splice(0)) resolve(); this.indexPages.clear(); this.indexRefs.clear(); this.layouts.close(); this.layoutCache.close(); this.neighborhoodLoads.clear(); this.cache.close(); this.singleParcels.clear(); this.smallRecords.clear(); this.previewCache.close();this.lod4Cache.close();this.lod4Load=undefined;this.aggregateCache.close();this.aggregateLoad=undefined;this.parcelFilterCache.close();this.parcelFilterMetadata=undefined; this.regions.clear(); this.chunks.clear(); this.geometry.clear(); this.protoChunks.clear(); this.analyticsCache.close();this.inspectionRegions.clear();this.analyticsIndex=undefined; }
}
