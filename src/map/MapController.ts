import SpatialMetricLoader from '@/data/SpatialMetricLoader';
import PatternsClient from '@/data/PatternsClient';
import {PATTERN_COLORS,type PatternEntry,type PatternPreview,type PatternFilter} from '@shared/patterns';
import type {SpatialMetricPage} from '@shared/spatialMetrics';
import {parcelClassFilter} from '@shared/layerAnalysis';
import { DEFAULT_RENDERING_MODE, DISPLAY_MODES, LAYER_PRESENTATION, isDisplayMetric as isMetric, regionStyleFor } from '@shared/layerPresentation';
import { parcelFilterTotals } from '@shared/parcelFilters';
import type {LayerAnalysis,ParcelFilterResult} from '@shared/layerAnalysis';
import {normalizeMetric,type AnalyticsIndex,type MetricSummary} from '@shared/mapAnalytics';
import {PARCEL_SIZE_COLORS,BITMAP_AREA_COLORS,type RenderingMode} from '@/map/layers/ParcelSizeColors';
import * as THREE from 'three';
import { Easing, Tween } from '@tweenjs/tween.js';
import { Rectangle } from '@timohausmann/quadtree-ts';
import SpriteText from 'three-spritetext';
import type MapRuntime from './MapRuntime';
import type { MapControls, MapSnapshot, MapZoomSnapshot, ZoomPhase } from './MapControls';
import NeighborhoodOverviewMap from '@/map/layers/NeighborhoodOverviewMap';
import NeighborhoodMap from '@/map/layers/NeighborhoodMap';
import HeatmapPreviewLayer from '@/map/layers/HeatmapPreviewLayer';
import NeighborhoodGeometryLayer from '@/map/layers/NeighborhoodGeometryLayer';
import BitmapArrivalFades from '@/map/layers/BitmapArrivalFades';
import type {ChunkDebugMode} from '@/map/layers/LoadedChunkBounds';
import {advanceDetail} from '@shared/heatmapPreview';
import {summarizeBitmapScores,summarizeParcelRegions,summarizeRegionMeans,type RegionSummaries} from '@shared/analyticalLod';
import {selectDetailRegions} from '@shared/detailSelection';
import {DampedZoom,WheelZoomGesture,zoomDistances,nearestZoom,overviewFrame,parcelDetailDistance,MAP_FRAMING,ZOOM_DAMPING,tierDetail,heatmapStrength,zoomPosition,lod4DownloadsAllowed} from '@shared/zoomLevels';
import type { NeighborhoodData, Rect } from '@/map/types';
import type { NeighborhoodRect, NeighborhoodSlot } from '@shared/NeighborhoodLayout.ts';
import {RectFrustum,interleaveSpatial} from '@shared/rectFrustum';
import SceneNeighborhoodMap from '@/map/scenes/SceneNeighborhoodMap';
import type { MapDataSource } from '@/data/MapDataSource';
import StaticHttpDataSource from '@/data/StaticHttpDataSource';
import NeighborhoodChunkLoader from '@/data/NeighborhoodChunkLoader';
import ParcelScheduler from '@/data/ParcelScheduler';
import { LAYOUT, type ParcelRecord } from '@shared/httpPack';
import { mapWorker } from '../workerUrls';
import type { ParcelWorkerResponse } from './workers/neighborhoodBitmapWorker';

type LayoutResult = { bounds: NeighborhoodRect; slots: NeighborhoodSlot[]; error?: string };

/** Owns map data, navigation, LOD and the 2D scene, independently of React. */
export default class MapController implements MapControls {
    private readonly layoutLabel = 'Neighborhood spiral';
    private sourceSlots?: NeighborhoodRect[];
    private needsPositionTranslation = false;

    public scene!: SceneNeighborhoodMap;
    private active = false;
    private disposed = false;
    private source!: MapDataSource;
    private scheduler!: ParcelScheduler;
    private inFlight = new Set<number>();
    private workerSerial = 0;
    private workerJobs = new Map<number, { resolve: () => void; reject: (error: Error) => void }>();
    private uploads: { id: number; rects: Float64Array; width: number; height: number; done: () => void }[] = [];
    private uploadFrame = 0;
    private budgetSkipped = new Set<number>();
    private desiredSignature = '';
    private selectionSignature = '';
    private detailLRU = new Map<number, number>();
    private readonly parcelBudget = 96 * 1024 * 1024;
    private layoutWorker!: Worker;
    private bitmapWorker!: Worker;
    private overview?: NeighborhoodOverviewMap;
    private renderingMode:RenderingMode=DEFAULT_RENDERING_MODE;
    private areaValues?:{scale:MetricSummary['scale'];minArea:number;maxArea:number;neighborhoodMeans:number[]};
    private sizeColorRevision=0;
    private sizeColors:readonly string[]=LAYER_PRESENTATION[DEFAULT_RENDERING_MODE].colors;
    private parcelClassTexture?:THREE.DataTexture;
    private parcelResult?:ParcelFilterResult;
    private parcelFilterRevision=0;
    private layerAnalysis?:LayerAnalysis;
    private filterAbort=new AbortController();
    private modeAbort=new AbortController();
    private localMetrics?:SpatialMetricLoader;
    private localReady=new Set<number>();
    private globalMetric=false;
    private areaScores?:Float32Array;
    private areaMetricValues?:Float32Array;
    private areaScoreLoad?:Promise<Float32Array>;
    private metricFilterRevision=0;
    private patternsClient?:PatternsClient;
    private patternFilterRevision=0;
    private preview?: HeatmapPreviewLayer;
    private neighborhoodGeometry?: NeighborhoodGeometryLayer;
    private arrivalFades?: BitmapArrivalFades;
    private neighborhoodChunks?: NeighborhoodChunkLoader;
    private geometryControllers=new Map<number,AbortController>();
    private viewGeometryWishes=new Set<number>();
    private searchGeometry?:number;
    private searchGeometryNavigation?:number;
    private geometryLoads=new Map<number,Promise<NeighborhoodData>>();
    private vectorLoads=new Map<number,Promise<void>>();
    private lodTime = 0;
    private previewInitialized = false;
    private lodDetail = 0;
    private lodTarget = 0;
    private overviewOpacity = 1;
    private zoomDamping = new DampedZoom();
    private wheelGesture = new WheelZoomGesture();
    private zoomPointer?: THREE.Vector2;
    private overviewFrame?: {x:number;z:number;height:number};
    private overviewCenter?: {x:number;z:number};
    private layoutApplication=0;
    private closestDistance = 20;
    private viewRevision=0;
    private requestBounds='';
    private viewportSignature = "";
    private directZoomDragging = false;
    private middleZoom?: {pointerId:number;y:number};
    private readonly touchPointers = new Map<number, {clientX:number;clientY:number}>();
    private touchPinched = false;
    private touchNeedsSnap = false;
    private zoomControlSignature = "";
    private readonly chunkDebugEnabled = new URLSearchParams(window.location.search).get('chunks') !== 'off';
    private genesisLabel?: SpriteText;
    private neighborhoods = new Map<number, NeighborhoodMap>();
    private loadedBitmaps = new Set<number>();
    private manifestSignature = '';
    private zoomLevels = [400, 2500, 40000, 500000];
    private zoomLevel = 3;
    private tween?: Tween;
    private dirty = true;
    private lastUpdate = 0;
    private hoveredBitmap = -1;
    private navigationId = 0;
    private priorityBitmap = -1;
    private wantedGeometry = new Set<number>();
    private wantedParcelGeometry = new Set<number>();
    private pendingNeighborhoods = new Map<number, Promise<NeighborhoodMap>>();
    private geometryAbort = new AbortController();
    // Comparison/rollback switch changes rendering only, never Mondrian or cache data.
    private readonly parcelRenderer = new URLSearchParams(window.location.search).get('parcels') === 'legacy' ? 'legacy' : 'compact';

    private palettes: Record<RenderingMode, readonly string[]> = {
        patterns:PATTERN_COLORS, default: PARCEL_SIZE_COLORS, size: PARCEL_SIZE_COLORS, area: BITMAP_AREA_COLORS,
        count: LAYER_PRESENTATION.count.colors, diversity: LAYER_PRESENTATION.diversity.colors, occupancy: LAYER_PRESENTATION.occupancy.colors,
    };
    private analyticTexture?:THREE.DataTexture;
    private metricValues?:Float32Array;
    private analyticIndex?:AnalyticsIndex;
    private inspectionRevision=0;
    private clickStart?:{x:number;y:number};
    private selectionOutline?:THREE.LineLoop;

    private snapshot: MapSnapshot = {
        ready: false, status: '', renderingAvailable: this.parcelRenderer === 'compact',
        renderingMode: DEFAULT_RENDERING_MODE, renderingBusy: false, renderingError: '', palette: LAYER_PRESENTATION[DEFAULT_RENDERING_MODE].colors,
        chunkDebugEnabled: this.chunkDebugEnabled, chunkDebugMode: 'none',
        publishedHeight: -1, neighborhoods:0, inspectionBusy:false, inspectionError:'', filter:[0,1],parcelRange:[1,9],filterBusy:false,
    };
    private zoomSnapshot: MapZoomSnapshot = { height: 1, stops: [] };
    private readonly listeners = new Set<() => void>();
    private readonly zoomListeners = new Set<() => void>();

    constructor(readonly runtime: MapRuntime) {
        if(this.parcelRenderer==='legacy'){
            this.renderingMode='default';this.sizeColors=PARCEL_SIZE_COLORS;
            this.snapshot={...this.snapshot,renderingMode:'default',palette:PARCEL_SIZE_COLORS};
        }
    }

    getState = (): MapSnapshot => this.snapshot;
    getZoom = (): MapZoomSnapshot => this.zoomSnapshot;
    subscribe = (listener: () => void): (() => void) => {
        if (this.disposed) return () => {};
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    };
    subscribeZoom = (listener: () => void): (() => void) => {
        if (this.disposed) return () => {};
        this.zoomListeners.add(listener);
        return () => { this.zoomListeners.delete(listener); };
    };

    private publish(patch: Partial<MapSnapshot>): void {
        if (!(Object.keys(patch) as (keyof MapSnapshot)[]).some(key => !Object.is(this.snapshot[key], patch[key]))) return;
        this.snapshot = { ...this.snapshot, ...patch };
        for (const listener of this.listeners) listener();
    }

    setZoom = (height: number, phase: ZoomPhase): void => this.setZoomFromControl(height, phase);
    setChunkDebug = (mode: ChunkDebugMode): void => {
        if (!this.active || !this.chunkDebugEnabled) return;
        this.scene.setChunkDebugMode(mode);
        this.publish({ chunkDebugMode: mode });
    };

    start() {
        if (this.disposed) throw new Error('Map is disposed.');
        if (this.active) return;
        this.active = true;
        this.layoutWorker = mapWorker('tightSpiralWorker');
        this.bitmapWorker = mapWorker('neighborhoodBitmapWorker');
        this.layoutWorker.onmessage = (event: MessageEvent<LayoutResult>) => {
            if (!this.active) return;
            if (event.data.error) {
                this.manifestSignature = '';
                this.report(event.data.error);
                return;
            }
            void this.applyLayout(event.data).catch(error=>{if(this.active)this.report(error);});
        };
        this.bitmapWorker.onmessage = (event: MessageEvent<ParcelWorkerResponse>) => {
            if (!this.active) return;
            const { protocol, batchId, results } = event.data;
            if (protocol !== 'parcel-worker-batch-v1') return;
            const job = this.workerJobs.get(batchId);
            if (!job) return;
            let remaining = results.length;
            if (!remaining) { this.workerJobs.delete(batchId); return job.resolve(); }
            let failure: Error | undefined;
            const done = () => { if (--remaining === 0) { this.workerJobs.delete(batchId); if (failure) job.reject(failure); else job.resolve(); } };
            for (const result of results) {
                if ('cancelled' in result) { this.inFlight.delete(result.id); done(); }
                else if ('error' in result) { this.inFlight.delete(result.id); failure = new Error(result.error); done(); }
                else this.uploads.push({ ...result, done });
            }
            this.scheduleUploads();
        };
        const workerFailed = () => {
            const error = new Error('Parcel worker failed. Reload the map to retry.');
            this.scheduler?.close();
            this.bitmapWorker.terminate();
            for (const job of this.workerJobs.values()) job.reject(error);
            this.workerJobs.clear(); this.inFlight.clear(); this.uploads.length = 0;
            if (this.active) this.report(error);
        };
        this.bitmapWorker.onerror = workerFailed;
        this.bitmapWorker.onmessageerror = workerFailed;
        this.source = new StaticHttpDataSource(new URL('map-data/', document.baseURI).href, 'manifest.json',undefined,true);
        if (this.chunkDebugEnabled) {
            this.source.onChunkPackLoaded = chunk => { if (this.active&&!this.needsPositionTranslation) this.scene?.showLoadedChunk(chunk); };
            this.source.onPreviewTileLoaded = chunk => { if (this.active&&!this.needsPositionTranslation) this.scene?.showLoadedHeatmapChunk(chunk); };
        }
        this.scheduler = new ParcelScheduler(this.source, id => this.loadedBitmaps.has(id) || this.inFlight.has(id) || this.budgetSkipped.has(id),
            records => this.layoutParcels(records), error => this.report(error));
        this.scheduler.onDesired=ids=>this.bitmapWorker.postMessage({protocol:'parcel-worker-wishes-v1',ids});
        this.scene = new SceneNeighborhoodMap(this.runtime.renderer);
        this.scene.start();
        this.runtime.scene = this.scene;
        this.scene.controls.addEventListener('change', this.requestUpdate);
        const canvas = this.runtime.renderer.domElement;
        canvas.addEventListener('pointerdown', this.onTouchStart, true);
        canvas.addEventListener('pointermove', this.onTouchMove, true);
        canvas.addEventListener('pointerup', this.onTouchEnd, true);
        canvas.addEventListener('pointercancel', this.onTouchEnd, true);
        canvas.addEventListener('lostpointercapture', this.onTouchEnd, true);
        canvas.addEventListener('pointermove', this.onPointerMove);
        canvas.addEventListener('pointerdown',this.onInspectStart);canvas.addEventListener('pointerup',this.onInspectEnd);
        canvas.addEventListener('pointerup', this.requestUpdate);
        canvas.addEventListener('pointerdown', this.onMiddleZoomStart, true);
        canvas.addEventListener('pointermove', this.onMiddleZoomMove, true);
        canvas.addEventListener('pointerup', this.onMiddleZoomEnd, true);
        canvas.addEventListener('pointercancel', this.onMiddleZoomEnd, true);
        canvas.addEventListener('lostpointercapture', this.onMiddleZoomEnd, true);
        canvas.addEventListener('auxclick', this.onMiddleAuxClick);
        canvas.addEventListener('wheel', this.onWheel, { passive: false });
        window.addEventListener('keydown', this.onKeyDown);
        this.scene.setChunkDebugMode(this.snapshot.chunkDebugMode);
        this.report('Loading centered regions…');
        void this.refreshManifest();
    }

    setPalette=(colors:readonly string[])=>{
        if (!this.active) return;
        if(colors.length!==(this.renderingMode==='patterns'?9:3)||colors.some(c=>!/^#[0-9a-f]{6}$/i.test(c)))throw new Error('Choose three palette colors');
        colors=[...colors];this.palettes[this.renderingMode]=colors;this.sizeColors=colors;
        this.preview?.setSizeColors(colors);this.neighborhoodGeometry?.setSizeColors(colors);
        if(this.renderingMode==='size'&&this.parcelResult)this.overview?.setParcelClasses(this.parcelResult.neighborhoodMeans,this.parcelResult.neighborhoodCoverage,colors);
        else if(isMetric(this.renderingMode)&&this.analyticIndex)this.overview?.setAnalytic(this.analyticIndex.metrics[this.renderingMode],colors,1+this.snapshot.filter[0]*8,1+this.snapshot.filter[1]*8);
        else this.overview?.setSizeColors(undefined,colors,this.renderingMode==='area'?this.areaValues:undefined,1+this.snapshot.filter[0]*8,1+this.snapshot.filter[1]*8);
        for(const n of this.neighborhoods.values())n.setSizeColors(colors);
        this.publish({palette:colors,renderingMode:this.renderingMode});this.requestUpdate();
    };
    setRenderingMode=async(mode:RenderingMode,colors:readonly string[]=this.palettes[mode])=>{
        if(!this.active||!this.overview||this.parcelRenderer!=='compact')return;
        if(mode!=='default'&&!DISPLAY_MODES.includes(mode))throw new Error('Unsupported display mode');
        this.modeAbort.abort();this.modeAbort=new AbortController();this.filterAbort.abort();this.filterAbort=new AbortController();this.areaScoreLoad=undefined;
        this.localMetrics?.update([]);this.patternsClient?.close();this.patternsClient=undefined;++this.patternFilterRevision;
        const signal=this.modeAbort.signal,revision=++this.sizeColorRevision;++this.parcelFilterRevision;++this.metricFilterRevision;
        const current=()=>this.active&&revision===this.sizeColorRevision&&!signal.aborted;
        this.publish({renderingBusy:true,renderingError:''});
        let texture:THREE.DataTexture|undefined,classTexture:THREE.DataTexture|undefined,metricValues:Float32Array|undefined;
        try{
            this.preview?.setActive(true);
            let index,summary,parcelResult:ParcelFilterResult|undefined,regionSummaries:RegionSummaries|undefined,patternCatalog:Awaited<ReturnType<PatternsClient['init']>>|undefined,patternResult:PatternFilter|undefined;
            if(mode==='size'||mode==='area'){
                const analysis=await this.source.getLayerAnalysis!();if(!current())return;this.layerAnalysis=analysis;
                this.publish({publishedParcels:analysis.parcel.counts.reduce((sum,n)=>sum+n,0)});
            }
            if(mode==='patterns'){
                await this.loadAnalytics();if(!current())return;
                const client=this.patternsClient=new PatternsClient(this.source);
                patternCatalog=await client.init();if(!current())return;
                patternResult=await client.filter();if(!current())return;
                metricValues=patternCatalog.values;regionSummaries=patternResult.summaries;
                texture=new THREE.DataTexture(patternResult.scores as Float32Array<ArrayBuffer>,1024,Math.ceil(metricValues.length/1024),THREE.RedFormat,THREE.FloatType);
                texture.minFilter=texture.magFilter=THREE.NearestFilter;texture.generateMipmaps=false;texture.needsUpdate=true;
            }else if(mode==='size'){
                const local=await this.source.getSpatialMetricsIndex!();if(!current())return;
                const pixels=new Float32Array(Math.ceil(local.count/1024)*1024*2);
                for(let id=0;id<local.count;id++){pixels[id*2]=1;pixels[id*2+1]=-1;}
                const totalArea=this.layerAnalysis!.parcel.areas.reduce((a,b)=>a+b,0);
                parcelResult={pixels,occupiedAreas:new Float32Array(local.count).fill(NaN),bitmapMatches:local.count,parcelMatches:this.layerAnalysis!.parcel.counts.reduce((a,b)=>a+b,0),selectedArea:totalArea,totalArea,neighborhoodMeans:local.parcelMeans,neighborhoodCoverage:local.parcelMeans.map(()=>1)};
                classTexture=this.createParcelTexture(parcelResult);
                regionSummaries=summarizeParcelRegions(local.parcelMeans,local.parcelMeans.map(()=>1));
            }else if(isMetric(mode)){
                await this.loadAnalytics();if(!current())return;
                summary=this.analyticIndex!.metrics[mode];
                const count=this.snapshot.publishedHeight+1,width=1024,height=Math.ceil(count/width),pixels=new Float32Array(width*height).fill(-1);
                metricValues=new Float32Array(count).fill(NaN);regionSummaries=summarizeRegionMeans(summary);
                texture=new THREE.DataTexture(pixels,width,height,THREE.RedFormat,THREE.FloatType);
                texture.minFilter=texture.magFilter=THREE.NearestFilter;texture.generateMipmaps=false;texture.needsUpdate=true;
            }
            if(!current())return;
            index=await this.source.getPreviewIndex?.();if(!current()){texture?.dispose();classTexture?.dispose();return;}
            if(mode==='area'){
                summary=this.layerAnalysis!.area;
                this.areaValues={scale:summary.scale,minArea:summary.min,maxArea:summary.max,neighborhoodMeans:summary.neighborhoodMeans};
                regionSummaries=summarizeRegionMeans(summary);
            }
            if(!index)throw Error('This snapshot has no preview for this layer.');
            if(!this.active||revision!==this.sizeColorRevision){texture?.dispose();classTexture?.dispose();return;}
            const oldTexture=this.analyticTexture,oldClassTexture=this.parcelClassTexture;
            this.analyticTexture=texture;this.metricValues=metricValues;this.parcelClassTexture=classTexture;this.parcelResult=parcelResult;
            this.renderingMode=mode;this.sizeColors=colors;this.localReady.clear();this.globalMetric=false;
            if((mode==='size'||isMetric(mode))&&!this.localMetrics)this.localMetrics=new SpatialMetricLoader(this.source,page=>this.applyMetricPage(page),this.requestUpdate,error=>this.report(error));
            this.localMetrics?.replay();
            this.preview?.setSizeColorMode(isMetric(mode));this.preview?.setBitmapAreaMode(mode==='area',this.areaValues?.maxArea,this.areaValues?.minArea,this.areaValues?.scale==='log');this.preview?.setIndex(index);
            this.preview?.setAnalytic(isMetric(mode)||mode==='patterns');this.preview?.setParcelClasses(mode==='size');
            this.preview?.setRegionSummaries(regionSummaries,regionStyleFor(mode));
            this.neighborhoodGeometry?.setSizeColorMode(false);this.neighborhoodGeometry?.setBitmapAreaMode(mode==='area',this.areaValues?.maxArea,this.areaValues?.minArea,this.areaValues?.scale==='log');
            this.neighborhoodGeometry?.setAnalytic(texture);this.neighborhoodGeometry?.setParcelClasses(classTexture);
            for(const n of this.neighborhoods.values()){n.setSizeColorMode(false);n.setBitmapAreaMode(mode==='area',this.areaValues?.maxArea,this.areaValues?.minArea,this.areaValues?.scale==='log');n.setAnalytic(texture);n.setParcelClasses(classTexture);}
            this.publish({filter:[0,1],parcelRange:[1,9],filterBusy:false,matchedPattern:undefined,layerSummary:summary,
                parcelDistribution:mode==='size'?{counts:this.layerAnalysis!.parcel.counts,areas:this.layerAnalysis!.parcel.areas}:undefined,
                parcelMatches:parcelResult?.parcelMatches,parcelAreaShare:parcelResult?parcelResult.selectedArea/parcelResult.totalArea:undefined,
                patternGroups:patternCatalog?.groups,patternTotal:patternCatalog?.entries.length,patternTransactions:undefined,selectedPattern:undefined,
                filterMatches:patternResult?.matches??parcelResult?.bitmapMatches??(summary?this.snapshot.publishedHeight+1:undefined)});
            this.updateSpatialMetric();this.setPalette(colors);oldTexture?.dispose();oldClassTexture?.dispose();
        }catch(error){texture?.dispose();classTexture?.dispose();if(signal.aborted)return;if(this.active&&revision===this.sizeColorRevision)this.publish({renderingError:error instanceof Error?error.message:String(error)});throw error;}
        finally{if(this.active&&revision===this.sizeColorRevision)this.publish({renderingBusy:false});}
    };
    private createParcelTexture(result:ParcelFilterResult){
        const texture=new THREE.DataTexture(result.pixels as Float32Array<ArrayBuffer>,1024,Math.ceil((this.snapshot.publishedHeight+1)/1024),THREE.RGFormat,THREE.FloatType);
        texture.minFilter=texture.magFilter=THREE.NearestFilter;texture.generateMipmaps=false;texture.needsUpdate=true;return texture;
    }
    private updateSpatialMetric(){
        if(this.renderingMode==='patterns'&&this.analyticTexture&&this.metricValues){
            this.preview?.setSpatialMetric({kind:'patterns',summary:{min:1,max:9,scale:'linear'},values:this.metricValues,scores:this.analyticTexture.image.data as unknown as Float32Array,low:1,high:9,filtered:true});
        }else if(this.renderingMode==='size'){
            if(this.parcelResult?.occupiedAreas)this.preview?.setSpatialMetric({mode:'size',filtered:this.snapshot.parcelRange[0]!==1||this.snapshot.parcelRange[1]!==9,range:this.snapshot.parcelRange,ready:id=>this.localReady.has(id),kind:'parcel',pixels:this.parcelResult.pixels,occupiedAreas:this.parcelResult.occupiedAreas});
        }else if(this.snapshot.layerSummary){
            const [low,high]=this.snapshot.filter;
            this.preview?.setSpatialMetric({mode:this.renderingMode==='area'?'area':isMetric(this.renderingMode)?this.renderingMode:undefined,filtered:low!==0||high!==1,ready:isMetric(this.renderingMode)&&!this.globalMetric?id=>this.localReady.has(id):undefined,kind:'scalar',summary:this.snapshot.layerSummary,low:1+low*8,high:1+high*8,
                values:isMetric(this.renderingMode)?this.metricValues:undefined,scores:this.renderingMode==='area'?this.areaScores:this.analyticTexture?.image.data as unknown as Float32Array|undefined});
        }
    }
    private applyMetricPage(page:SpatialMetricPage){
        if(this.globalMetric)return;
        const first=page.region*2016;
        if(isMetric(this.renderingMode)&&this.analyticTexture&&this.metricValues){
            const values=page[this.renderingMode];this.metricValues.set(values,first);
            const pixels=this.analyticTexture.image.data as unknown as Float32Array,summary=this.analyticIndex!.metrics[this.renderingMode];
            for(let i=0;i<values.length;i++)pixels[first+i]=1+8*normalizeMetric(values[i],summary);
            this.analyticTexture.needsUpdate=true;
        }else if(this.renderingMode==='size'&&this.parcelResult&&this.parcelClassTexture){
            const result=parcelClassFilter(page.classes,page.count.length,...this.snapshot.parcelRange,true);
            this.parcelResult.pixels.set(result.pixels.subarray(0,page.count.length*2),first*2);
            this.parcelResult.occupiedAreas!.set(result.occupiedAreas!,first);this.parcelClassTexture.needsUpdate=true;
        }else return;
        this.localReady.add(page.region);this.updateSpatialMetric();
    }
    setParcelRange=async(low:number,high:number)=>{
        if(this.renderingMode!=='size'||!this.parcelClassTexture||!Number.isFinite(low)||!Number.isFinite(high))return;
        low=Math.max(1,Math.min(9,Math.round(low)));high=Math.max(low,Math.min(9,Math.round(high)));
        const revision=++this.parcelFilterRevision;this.publish({parcelRange:[low,high],filterBusy:true,renderingError:''});
        if(low===1&&high===9){await this.setRenderingMode('size');return;}
        try{
            if(!this.source.getParcelFilterMetadata)throw Error('Generate the spatial Parcel size filter addon for this dataset.');
            const metadata=await this.source.getParcelFilterMetadata();
            if(!this.active||this.renderingMode!=='size'||revision!==this.parcelFilterRevision)return;
            const result=parcelFilterTotals(metadata,low,high);
            this.globalMetric=false;this.localReady.clear();
            Object.assign(this.parcelResult!,result);this.parcelResult!.occupiedAreas!.fill(NaN);
            for(let id=0;id<metadata.count;id++){this.parcelResult!.pixels[id*2]=1;this.parcelResult!.pixels[id*2+1]=-1;}
            this.localMetrics?.replay();this.parcelClassTexture.needsUpdate=true;
            this.preview?.setParcelClasses(true,low,high);this.neighborhoodGeometry?.setParcelClasses(this.parcelClassTexture,low,high);
            this.preview?.setRegionSummaries(summarizeParcelRegions(result.neighborhoodMeans,result.neighborhoodCoverage),regionStyleFor('size'));
            for(const n of this.neighborhoods.values())n.setParcelClasses(this.parcelClassTexture,low,high);
            this.updateSpatialMetric();this.publish({filterBusy:false,filterMatches:result.bitmapMatches,parcelMatches:result.parcelMatches,parcelAreaShare:result.selectedArea/result.totalArea});
            this.requestUpdate();
        }catch(error){if(this.active&&revision===this.parcelFilterRevision)this.publish({filterBusy:false,renderingError:String(error)});}
    };
    loadAnalytics=async()=>{
        try{const index=await this.source.getAnalyticsIndex!();if(!this.active)return;this.analyticIndex=index;this.publish({analytics:index,publishedParcels:index.parcels});}
        catch(error){throw new Error('Analytical data unavailable for this snapshot. '+(error instanceof Error?error.message:String(error)));}
    };
    private loadAreaScores(summary:MetricSummary):Promise<Float32Array>{
        if(this.areaScores)return Promise.resolve(this.areaScores);
        if(!this.areaScoreLoad){
            const signal=AbortSignal.any([this.modeAbort.signal,this.filterAbort.signal]);
            const load=this.source.getAreaMetric!(signal).then(values=>{signal.throwIfAborted();this.areaMetricValues=values;this.areaScores=Float32Array.from(values,value=>1+normalizeMetric(value,summary)*8);return this.areaScores;})
                .catch(error=>{if(this.areaScoreLoad===load)this.areaScoreLoad=undefined;throw error;});this.areaScoreLoad=load;
        }
        return this.areaScoreLoad;
    }
    setMetricFilter=async(low:number,high:number)=>{
        const summary=this.snapshot.layerSummary;
        if(!summary||this.renderingMode==='size'||![low,high].every(Number.isFinite))return;
        low=Math.max(0,Math.min(1,low));high=Math.max(low,Math.min(1,high));
        const revision=++this.metricFilterRevision,mode=this.renderingMode,all=low===0&&high===1;
        if(all){this.filterAbort.abort();this.filterAbort=new AbortController();this.areaScoreLoad=undefined;}
        this.publish({filter:[low,high],filterBusy:!all&&(mode==='area'?!this.areaScores:!this.globalMetric),renderingError:''});
        if(mode==='area'&&!all&&!this.areaScores){
            try{await this.loadAreaScores(summary);}
            catch(error){if(this.active&&revision===this.metricFilterRevision)this.publish({filterBusy:false,renderingError:String(error)});return;}
            if(!this.active||revision!==this.metricFilterRevision||this.renderingMode!==mode)return;
        }
        if(isMetric(mode)&&!all&&!this.globalMetric){
            try{
                const signal=AbortSignal.any([this.modeAbort.signal,this.filterAbort.signal]),data=await this.source.getAnalyticsMetric!(mode,signal);signal.throwIfAborted();
                if(!this.active||revision!==this.metricFilterRevision||mode!==this.renderingMode)return;
                this.metricValues=data.values;const pixels=this.analyticTexture!.image.data as unknown as Float32Array;
                for(let i=0;i<data.values.length;i++)pixels[i]=1+8*normalizeMetric(data.values[i],summary);
                this.analyticTexture!.needsUpdate=true;this.globalMetric=true;this.localMetrics?.update([]);
            }catch(error){if(this.active&&revision===this.metricFilterRevision)this.publish({filterBusy:false,renderingError:String(error)});return;}
        }
        const a=1+low*8,b=1+high*8;
        this.preview?.setAnalytic(isMetric(this.renderingMode),a,b);this.neighborhoodGeometry?.setAnalytic(this.analyticTexture,a,b);
        for(const n of this.neighborhoods.values())n.setAnalytic(this.analyticTexture,a,b);
        const scores=this.renderingMode==='area'?this.areaScores:this.analyticTexture?.image.data as unknown as Float32Array|undefined;
        let matches=0;
        if(all){matches=this.snapshot.publishedHeight+1;this.preview?.setRegionSummaries(summarizeRegionMeans(summary),regionStyleFor(mode));}
        else if(scores){const result=summarizeBitmapScores(scores,this.snapshot.publishedHeight+1,a,b,mode==='area'&&this.areaMetricValues?{values:this.areaMetricValues,summary}:isMetric(mode)&&this.metricValues?{values:this.metricValues,summary}:undefined);matches=result.matches;this.preview?.setRegionSummaries(result.summaries,regionStyleFor(this.renderingMode));}
        this.updateSpatialMetric();this.publish({filterMatches:matches,filterBusy:false});this.requestUpdate();
    };
    home=()=>{if(!this.overview)return;this.navigationId++;this.animateCamera(3,0,0);};
    clearSelection=()=>{this.inspectionRevision++;this.selectionOutline&&(this.selectionOutline.visible=false);this.neighborhoodGeometry?.setInspectedBitmap();for(const n of this.neighborhoods.values())n.setInspectedBitmap();this.publish({selection:undefined,inspectionBusy:false,inspectionError:''});};
    inspectBitmap=async(id:number)=>{
        const revision=++this.inspectionRevision;this.publish({inspectionBusy:true,inspectionError:''});
        try{
            const selection=await this.source.inspectBitmap!(id);
            if(!this.active||revision!==this.inspectionRevision)return;
            this.publish({selection,inspectionBusy:false});
            this.neighborhoodGeometry?.setInspectedBitmap(id);for(const n of this.neighborhoods.values())n.setInspectedBitmap(id);
            const data=await this.source.getNeighborhood(Math.floor(id/2016));
            if(!this.active||revision!==this.inspectionRevision)return;
            const r=data.bitmaps[id%2016],slot=this.overview!.slots[Math.floor(id/2016)];
            if(!this.selectionOutline){const geometry=new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0,0,0),new THREE.Vector3(1,0,0),new THREE.Vector3(1,0,1),new THREE.Vector3(0,0,1)]);
                this.selectionOutline=new THREE.LineLoop(geometry,new THREE.LineBasicMaterial({color:'#ffffff',depthTest:false,transparent:true,opacity:1}));this.selectionOutline.renderOrder=25;this.scene.add(this.selectionOutline);}
            this.selectionOutline.position.set(slot.x+r.x,.06,slot.y+r.y);this.selectionOutline.scale.set(r.width,1,r.height);this.selectionOutline.visible=true;
        }catch(error){if(this.active&&revision===this.inspectionRevision)this.publish({inspectionBusy:false,inspectionError:error instanceof Error?error.message:String(error)});}
    };
    getPatternPage=(transactions:number|undefined,offset:number,limit=12):{entries:PatternEntry[];total:number}=>this.patternsClient?.page(transactions,offset,limit)??{entries:[],total:0};
    getPatternPreview=(id:number,signal:AbortSignal):Promise<PatternPreview>=>this.patternsClient?.preview(id,signal)??Promise.reject(Error('Open Patterns to preview geometry'));
    setPatternFilter=async(transactions?:number,pattern?:number)=>{
        if(this.renderingMode!=='patterns'||!this.patternsClient||!this.analyticTexture)return;
        const revision=++this.patternFilterRevision;this.publish({patternTransactions:transactions,selectedPattern:pattern,filterBusy:true,renderingError:''});
        try{
            const result=await this.patternsClient.filter(transactions,pattern);
            if(!this.active||revision!==this.patternFilterRevision||this.renderingMode!=='patterns')return;
            (this.analyticTexture.image.data as unknown as Float32Array).set(result.scores);this.analyticTexture.needsUpdate=true;
            this.preview?.setRegionSummaries(result.summaries,regionStyleFor('patterns'));this.updateSpatialMetric();
            this.publish({filterMatches:result.matches,filterBusy:false});this.requestUpdate();
        }catch(error){if(this.active&&revision===this.patternFilterRevision&&this.renderingMode==='patterns')this.publish({filterBusy:false,renderingError:String(error)});}
    };
    findPatternMatches=async()=>{
        const selection=this.snapshot.selection;if(!selection||selection.occurrences<=1)return;
        await this.setRenderingMode('patterns');
        if(!this.active||this.snapshot.selection?.id!==selection.id||this.renderingMode!=='patterns')return;
        await this.setPatternFilter(selection.count,selection.pattern);
    };
    private onInspectStart=(event:PointerEvent)=>{if(event.button===0)this.clickStart={x:event.clientX,y:event.clientY};};
    private onInspectEnd=(event:PointerEvent)=>{
        const start=this.clickStart;this.clickStart=undefined;
        if(!start||event.button!==0||Math.hypot(event.clientX-start.x,event.clientY-start.y)>4||!this.overview)return;
        const point=this.pointerWorld(event),hit=this.overview.quadtree.retrieve(new Rectangle({x:point.x,y:point.z,width:.01,height:.01})).find(r=>point.x>=r.x&&point.x<r.x+r.width&&point.z>=r.y&&point.z<r.y+r.height);
        if(!hit)return;
        const slot=this.overview.slots[hit.data!];
        void this.source.getNeighborhood(hit.data!).then(data=>{if(!this.active)return;const x=point.x-slot.x,y=point.z-slot.y,index=data.bitmaps.findIndex(r=>x>=r.x&&x<r.x+r.width&&y>=r.y&&y<r.y+r.height);if(index>=0)void this.inspectBitmap(hit.data!*2016+index);}).catch(error=>this.publish({inspectionError:String(error)}));
    };

    private async refreshManifest() {
        try {
            if (!this.active) return;
            const manifest = await this.source.getManifest();
            this.publish({snapshot:manifest.snapshot,publishedHeight:manifest.publishedHeight,neighborhoods:manifest.regions.length});
            if (!this.active) return;
            const storedPositions = manifest.regions.map(region => Number.isFinite(region.x) && Number.isFinite(region.y)
                ? { x: region.x!, y: region.y!, width: region.width, height: region.height } : undefined);
            if (storedPositions.every((position): position is NeighborhoodRect => position !== undefined)) {
                this.sourceSlots = storedPositions;
            } else if (manifest.layout !== LAYOUT) {
                throw new Error('Map data requires stored region positions.');
            }
            const sizes = manifest.regions.map(({ width, height }) => ({ width, height }));
            const signature = JSON.stringify(sizes);
            if (signature !== this.manifestSignature) { this.manifestSignature = signature; this.layoutWorker.postMessage({ sizes }); }
        } catch (error) { if (this.active) this.report(error); }
    }

    private layoutParcels(records: ParcelRecord[]): Promise<void> {
        if (!this.active) return Promise.resolve();
        const selected = records.filter(record => {
            if (this.inFlight.has(record.id) || this.loadedBitmaps.has(record.id)) return false;
            // A complete oversized record remains cached and represented by its parent.
            // Keep transient layout output bounded independently of disk and GPU budgets.
            if (record.txCount > 262144) { this.budgetSkipped.add(record.id); this.report(`Bitmap ${record.id} exceeds the current parcel layout memory budget.`); return false; }
            return true;
        });
        if (!selected.length) return Promise.resolve();
        selected.forEach(record => this.inFlight.add(record.id));
        const batchId = ++this.workerSerial;
        return new Promise((resolve, reject) => {
            this.workerJobs.set(batchId, { resolve, reject });
            this.bitmapWorker.postMessage({ protocol: 'parcel-worker-batch-v1', batchId, records: selected }, selected.map(record => record.tx.buffer));
        });
    }

    private scheduleUploads() {
        if (!this.active || this.uploadFrame || !this.uploads.length) return;
        this.uploadFrame = requestAnimationFrame(() => {
            this.uploadFrame = 0;
            const started = performance.now();
            do {
                const result = this.uploads.shift()!;
                this.inFlight.delete(result.id);
                const neighborhood = this.neighborhoods.get(Math.floor(result.id / 2016));
                if (this.scheduler.wants(result.id) && neighborhood && !this.loadedBitmaps.has(result.id)) {
                    const canonical = neighborhood.data.bitmaps[result.id % 2016];
                    if (canonical.width !== result.width || canonical.height !== result.height) { this.budgetSkipped.add(result.id); this.report(`Bitmap ${result.id} does not match canonical geometry.`); }
                    else if (this.reserveParcels(neighborhood, result.rects.length / 4, result.id)) {
                        const slots: Rect[] = [];
                        for (let i = 0; i < result.rects.length; i += 4) slots.push({ x: result.rects[i], y: result.rects[i + 1], width: result.rects[i + 2], height: result.rects[i + 3] });
                        neighborhood.AddBitmap(result.id, slots);
                        this.arrivalFades?.begin(result.id);
                        this.loadedBitmaps.add(result.id);
                        if (result.id === this.hoveredBitmap) neighborhood.setBitmapSelected(result.id, true);
                    }
                }
                result.done();
            } while (this.uploads.length && performance.now() - started < 3);
            this.scheduleUploads();
        });
    }

    private reserveParcels(target: NeighborhoodMap, count: number, bitmap: number) {
        const total = () => [...this.neighborhoods.values()].reduce((sum, n) => sum + n.parcelBytes, 0);
        // Only build the eviction index under actual pressure, never once per bitmap.
        if (total() - target.parcelBytes + target.estimateParcelBytes(count) <= this.parcelBudget) {
            this.detailLRU.set(target.data.neighborhood, performance.now()); return true;
        }
        const desiredRegions = new Set([...this.loadedBitmaps].filter(id => this.scheduler.wants(id)).map(id => Math.floor(id / 2016)));
        for (const [id] of [...this.detailLRU].sort((a, b) => a[1] - b[1])) {
            if (total() - target.parcelBytes + target.estimateParcelBytes(count) <= this.parcelBudget) break;
            if (id === target.data.neighborhood || desiredRegions.has(id)) continue;
            this.neighborhoods.get(id)?.clearParcelDetails();
            this.arrivalFades?.resetNeighborhood(id);
            for (const loaded of this.loadedBitmaps) if (Math.floor(loaded / 2016) === id) this.loadedBitmaps.delete(loaded);
            this.detailLRU.delete(id);
        }
        if (total() - target.parcelBytes + target.estimateParcelBytes(count) > this.parcelBudget) {
            this.budgetSkipped.add(bitmap);
            this.report('Parcel memory budget reached. Zoom closer to refine this region.');
            return false;
        }
        this.detailLRU.set(target.data.neighborhood, performance.now()); return true;
    }

    private async applyLayout({ slots, bounds }: LayoutResult) {
        if (!slots.length) return this.report('The server has no published regions yet.');
        this.needsPositionTranslation = this.sourceSlots?.some((source, id) => source.x !== slots[id]?.x || source.y !== slots[id]?.y) ?? false;
        if (!this.needsPositionTranslation) this.sourceSlots = undefined;
        const application=++this.layoutApplication;
        const firstLayout = !this.overview;
        if(firstLayout){
            // Resolve only neighborhood 0 before exposing the map. Its canonical
            // first bitmap supplies the exact startup focus, without parcels or GPU detail.
            const data=await this.source.getNeighborhood(0);
            if(!this.active||application!==this.layoutApplication)return;
            const first=data.bitmaps[0],slot=slots[0];
            if(data.neighborhood!==0||data.width!==slot.width||data.height!==slot.height||!first)
                throw new Error('Bitmap 0 does not match the initial layout.');
            this.overviewCenter={x:slot.x+first.x+first.width/2,z:slot.y+first.y+first.height/2};
        }
        const replacement = new NeighborhoodOverviewMap(slots, bounds);
        this.overview?.dispose();
        this.overview = replacement;
        this.scene.add(replacement);
        this.scene.setMapRegions(slots);
        if(!this.preview&&this.source.getPreviewIndex&&this.source.getPreviewTile){
            this.preview=new HeatmapPreviewLayer(this.source,slots,this.requestUpdate,error=>{if(this.active)this.report(error);},this.sourceSlots);
            if(this.parcelRenderer==='compact'){
                const pending=new Float32Array(slots.length*2);for(let i=0;i<slots.length;i++)pending[i*2]=1;
                this.preview.setRegionSummaries(pending);
            }
            this.scene.add(this.preview);
        }else this.preview?.setLayout(slots);
        if(!this.arrivalFades)this.arrivalFades=new BitmapArrivalFades(slots.length*2016,this.runtime.renderer.capabilities.maxTextureSize);
        else this.arrivalFades.ensureCount(slots.length*2016);
        if(!this.neighborhoodGeometry){this.neighborhoodGeometry=new NeighborhoodGeometryLayer(slots);this.neighborhoodGeometry.setArrivalFades(this.arrivalFades);this.neighborhoodGeometry.setInspectedBitmap(this.snapshot.selection?.id);this.scene.add(this.neighborhoodGeometry);
            this.neighborhoodChunks=new NeighborhoodChunkLoader(this.source,this.neighborhoodGeometry,this.requestUpdate,chunk=>{
                if(this.active&&this.chunkDebugEnabled)this.scene.showLoadedNeighborhoodChunk(chunk);
            },error=>{if(this.active)this.report(error);});}
        else this.neighborhoodGeometry.setLayout(slots);
        // Stored data with different world positions uses canonical regional
        // geometry; its old chunk ownership is never treated as the official map.
        if (this.needsPositionTranslation && this.neighborhoodChunks) this.neighborhoodChunks.mode = false;
        this.refreshOverviewFrame(true);
        if (!this.genesisLabel) {
            this.genesisLabel = new SpriteText('0', 1, '#ffffff');
            this.genesisLabel.position.set(0, 0.5, 0);
            this.genesisLabel.material.depthTest = false;
            this.genesisLabel.renderOrder = 20;
            this.scene.add(this.genesisLabel);
        }
        if (firstLayout ) {
            // Open at the full-map distance around bitmap 0. Traversing detail
            // scales from the scene's initial camera would fetch near data during startup.
            const frame=this.overviewFrame!;
            this.scene.camera.position.set(frame.x,frame.height,frame.z);
            this.scene.controls.target.set(frame.x,0,frame.z);this.zoomLevel=3;
            this.lodDetail=0;this.lodTarget=0;
        }
        this.report(this.viewLabel());
        this.publish({ ready: true });
        if(this.parcelRenderer==='compact')void this.setRenderingMode(this.renderingMode).catch(()=>{});
        else void this.loadAnalytics().catch(()=>{});
        this.requestUpdate();
    }

    private viewLabel() {
        return `${this.layoutLabel} | ${this.overview?.slots.length ?? 0} neighborhoods | Home: center`;
    }

    private addNeighborhood(data: NeighborhoodData): NeighborhoodMap {
        // Position belongs to this scene, not the source's cached geometry.
        const decoded = { neighborhood: data.neighborhood, width: data.width, height: data.height,
            bitmaps: data.bitmaps, x: 0, y: 0 };
        const existing = this.neighborhoods.get(decoded.neighborhood);
        if (existing) return existing;
        const slot = this.overview?.slots[decoded.neighborhood];
        if (!slot) throw new Error(`Neighborhood ${decoded.neighborhood} is not in the current layout.`);
        if (decoded.width !== slot.width || decoded.height !== slot.height) {
            throw new Error(`Neighborhood ${decoded.neighborhood} does not match the manifest.`);
        }
        // Build the detail quadtree in local coordinates before placing its group.
        const neighborhood = new NeighborhoodMap(decoded, this.parcelRenderer);
        neighborhood.setSizeColors(this.sizeColors);
        neighborhood.setInspectedBitmap(this.snapshot.selection?.id);
        neighborhood.setSizeColorMode(false);
        neighborhood.setBitmapAreaMode(this.renderingMode==='area',this.areaValues?.maxArea,this.areaValues?.minArea,this.areaValues?.scale==='log');
        neighborhood.setAnalytic(this.analyticTexture,1+this.snapshot.filter[0]*8,1+this.snapshot.filter[1]*8);neighborhood.setParcelClasses(this.parcelClassTexture,...this.snapshot.parcelRange);
        neighborhood.setArrivalFades(this.arrivalFades!);
        decoded.x = neighborhood.position.x = slot.x;
        decoded.y = neighborhood.position.z = slot.y;
        neighborhood.name = `neighborhood-${decoded.neighborhood}`;
        neighborhood.visible = this.zoomLevel < 3;
        neighborhood.bitmapChunksContainer.visible = this.zoomLevel <= 1;
        if (this.neighborhoods.size >= 32) {
            const victim = [...this.neighborhoods.keys()].find(id => !this.wantedGeometry.has(id));
            if (victim !== undefined) {
                this.neighborhoods.get(victim)!.dispose(); this.neighborhoods.delete(victim); this.detailLRU.delete(victim);
                this.arrivalFades?.resetNeighborhood(victim);
                for (const id of this.loadedBitmaps) if (Math.floor(id / 2016) === victim) this.loadedBitmaps.delete(id);
            }
        }
        if(this.neighborhoodChunks?.mode===false)this.neighborhoodGeometry?.addRegion(decoded,slot);
        this.neighborhoods.set(decoded.neighborhood, neighborhood);
        this.scene.add(neighborhood);
        this.requestUpdate();
        return neighborhood;
    }

    private setGeometryWishes(ids:Iterable<number>){
        this.viewGeometryWishes=new Set(ids);
        for(const [id,controller] of this.geometryControllers)if(!this.viewGeometryWishes.has(id)&&(id!==this.searchGeometry||this.searchGeometryNavigation!==this.navigationId))controller.abort();
    }
    private load2DGeometry(id:number):Promise<NeighborhoodData>{
        const resident=this.neighborhoods.get(id);if(resident)return Promise.resolve(resident.data);
        const pending=this.geometryLoads.get(id);if(pending&&!this.geometryControllers.get(id)?.signal.aborted)return pending;
        const controller=new AbortController(),signal=AbortSignal.any([controller.signal,this.geometryAbort.signal]);this.geometryControllers.set(id,controller);
        const load=(async()=>{const data=await this.source.getNeighborhood(id,signal);signal.throwIfAborted();
            const slot=this.overview?.slots[id];if(!slot||data.neighborhood!==id||data.width!==slot.width||data.height!==slot.height)throw Error('Neighborhood geometry differs from manifest');return data;
        })().finally(()=>{if(this.geometryLoads.get(id)===load){this.geometryLoads.delete(id);this.geometryControllers.delete(id);}this.requestUpdate();});
        this.geometryLoads.set(id,load);return load;
    }
    private ensureVectorRegion(id:number):Promise<void>{
        if(this.neighborhoodGeometry?.has(id))return Promise.resolve();
        const pending=this.vectorLoads.get(id);if(pending&&!this.geometryControllers.get(id)?.signal.aborted)return pending;
        const load=(async()=>{const data=await this.load2DGeometry(id);if(!this.active)return;this.neighborhoodGeometry?.addRegion(data,this.overview!.slots[id]);this.requestUpdate();})().finally(()=>{if(this.vectorLoads.get(id)===load)this.vectorLoads.delete(id);});
        this.vectorLoads.set(id,load);return load;
    }
    private ensureNeighborhood(id: number): Promise<NeighborhoodMap> {
        const existing = this.neighborhoods.get(id);
        if (existing) return Promise.resolve(existing);
        const pending = this.pendingNeighborhoods.get(id);
        if (pending&&!this.geometryControllers.get(id)?.signal.aborted) return pending;
        const load = (async () => {
            if (!this.active) throw new Error('Map closed.');
            const data = await this.load2DGeometry(id);
            if (!this.active) throw new Error('Map closed.');
            return this.addNeighborhood(data);
        })().finally(() => {if(this.pendingNeighborhoods.get(id)===load)this.pendingNeighborhoods.delete(id);});
        this.pendingNeighborhoods.set(id, load);
        return load;
    }

    public async goToBitmap(id: number) {
        if (!this.active) return;
        if (!this.overview || !Number.isSafeInteger(id) || id < 0 || !this.overview.slots[Math.floor(id / 2016)]) {
            return this.report('This block is outside the published map.');
        }
        this.source.prioritizeNeighborhood?.(Math.floor(id / 2016));
        const navigation = ++this.navigationId;
        this.priorityBitmap = id;this.searchGeometry=Math.floor(id/2016);this.searchGeometryNavigation=navigation;this.setGeometryWishes(this.viewGeometryWishes);
        try {
            const neighborhood = await this.ensureNeighborhood(Math.floor(id / 2016));
            if (!this.active || navigation !== this.navigationId) return;
            const block = neighborhood.data.bitmaps[id % 2016];
            if (!block) throw new Error('This block is not published yet.');
            const distance=Math.min(2500,Math.max(40,this.scene.fitDistance(block.width,block.height)*1.8));
            this.animateDistance(distance,{center:{x:neighborhood.position.x+block.x+block.width/2,z:neighborhood.position.z+block.y+block.height/2},duration:350});
            this.selectBitmap(id);void this.inspectBitmap(id);
            // Center immediately on the known block rectangle; refine parcels afterward.
            if (!this.loadedBitmaps.has(id)) this.scheduler.setDesired([id]);
        } catch (error) { if (this.active&&navigation===this.navigationId&&(error as Error)?.name!=='AbortError') this.report(error); }
        finally{if(this.searchGeometryNavigation===navigation){this.searchGeometry=undefined;this.searchGeometryNavigation=undefined;this.setGeometryWishes(this.viewGeometryWishes);}}
    }

    private animateCamera(level: number, x = this.scene.camera.position.x, z = this.scene.camera.position.z) {
        this.zoomLevel=level;
        if(level===3&&this.overviewFrame){x=this.overviewFrame.x;z=this.overviewFrame.z;}
        this.animateDistance(this.zoomLevels[level],{center:{x,z},duration:350});
    }
    private animateDistance(height:number,{center,duration=180}:{center?:{x:number;z:number};duration?:number}={}) {
        height=THREE.MathUtils.clamp(height,this.closestDistance,this.zoomLevels[3]*MAP_FRAMING.overscrollMultiplier);
        this.cancelZoom();this.tween?.stop();
        this.tween=new Tween({x:this.scene.camera.position.x,y:this.scene.camera.position.y,z:this.scene.camera.position.z})
            .to(center?{x:center.x,y:height,z:center.z}:{y:height},duration).easing(Easing.Sinusoidal.InOut)
            .onUpdate(position=>{
                // Only Home/search explicitly change the center. Zoom-only
                // tweens keep both X/Z and the existing OrbitControls target.
                if(center){this.scene.camera.position.set(position.x,position.y,position.z);this.scene.controls.target.set(position.x,0,position.z);}
                else this.scene.camera.position.y=position.y;
                this.requestUpdate();
            })
            .onComplete(this.requestUpdate).start();this.requestUpdate();
    }
    private onWheel = (event:WheelEvent)=>{
        event.preventDefault();
        if(!this.overview||!event.deltaY||this.middleZoom||this.touchPointers.size)return;
        this.zoomPointer=this.pointerPosition(event);
        const delta=event.deltaY*(event.deltaMode===1?16:event.deltaMode===2?this.runtime.renderer.domElement.clientHeight:1);
        const now=performance.now(),reference=this.zoomDamping.active?this.zoomDamping.targetHeight:this.scene.camera.position.y;
        const target=this.wheelGesture.input(reference,delta,now,this.distanceLevels());
        if(target!==undefined)this.applyWheelZoom(target,now);
    };
    private applyWheelZoom(target:number,now:number){
        this.tween?.stop();this.directZoomDragging=false;
        this.zoomDamping.snap(this.scene.camera.position.y,now,this.closestDistance,this.zoomLevels[3],target);
        this.requestUpdate();
    }
    private cancelZoom(){
        const middle=this.middleZoom;this.middleZoom=undefined;
        if(middle&&this.runtime.renderer.domElement.hasPointerCapture(middle.pointerId))this.runtime.renderer.domElement.releasePointerCapture(middle.pointerId);
        this.zoomDamping.cancel();this.wheelGesture.reset();this.directZoomDragging=false;this.zoomPointer=undefined;
    }
    private distanceLevels(){
        const unit=this.runtime.renderer.domElement.clientHeight/(2*Math.tan(THREE.MathUtils.degToRad(this.scene.camera.fov)/2));
        return zoomDistances(unit,this.preview?.pyramid||{tileSize:4096,resolution:256,maxLevel:0},this.closestDistance,this.zoomLevels[3]*MAP_FRAMING.overscrollMultiplier,this.zoomLevels[3]);
    }
    private setZoomFromControl=(height:number,phase:ZoomPhase,overscroll=false)=>{
        if(!this.active||!this.overview)return;
        height=THREE.MathUtils.clamp(height,this.closestDistance,this.zoomLevels[3]*(overscroll?MAP_FRAMING.overscrollMultiplier:1));
        if(phase==='drag'){
            if(!this.directZoomDragging){this.cancelZoom();this.tween?.stop();}
            this.directZoomDragging=true;this.setCameraHeight(height);
            this.requestUpdate();return;
        }
        this.directZoomDragging=false;
        if(phase==='release'){
            this.zoomDamping.snap(height,performance.now(),this.closestDistance,this.zoomLevels[3]*MAP_FRAMING.overscrollMultiplier,nearestZoom(height,this.distanceLevels()));
            this.requestUpdate();return;
        }
        height=nearestZoom(height,this.distanceLevels());
        this.animateDistance(height,{duration:300});
    };
    private onMiddleZoomStart=(event:PointerEvent)=>{
        if(event.button!==1||!this.overview)return;
        event.preventDefault();event.stopImmediatePropagation();
        this.setZoomFromControl(this.scene.camera.position.y,'drag',true);
        this.zoomPointer=this.pointerPosition(event);
        this.middleZoom={pointerId:event.pointerId,y:event.clientY};
        this.runtime.renderer.domElement.setPointerCapture(event.pointerId);
    };
    private onMiddleZoomMove=(event:PointerEvent)=>{
        const middle=this.middleZoom;if(!middle||middle.pointerId!==event.pointerId)return;
        event.preventDefault();event.stopImmediatePropagation();
        const delta=event.clientY-middle.y;middle.y=event.clientY;
        this.setZoomFromControl(this.scene.camera.position.y*Math.exp(THREE.MathUtils.clamp(delta,-500,500)*ZOOM_DAMPING.swipeSensitivity),'drag',true);
    };
    private onMiddleZoomEnd=(event:PointerEvent)=>{
        const middle=this.middleZoom;if(!middle||middle.pointerId!==event.pointerId)return;
        this.middleZoom=undefined;event.preventDefault();event.stopImmediatePropagation();
        this.setZoomFromControl(this.scene.camera.position.y,'release',true);
        if(this.runtime.renderer.domElement.hasPointerCapture(event.pointerId))this.runtime.renderer.domElement.releasePointerCapture(event.pointerId);
    };
    private onMiddleAuxClick=(event:MouseEvent)=>{if(event.button===1){event.preventDefault();}};
    private touchFrame(){
        const points=[...this.touchPointers.values()].slice(0,2),a=points[0],b=points[1]??a;
        return {clientX:(a.clientX+b.clientX)/2,clientY:(a.clientY+b.clientY)/2,distance:Math.hypot(a.clientX-b.clientX,a.clientY-b.clientY)};
    }
    private onTouchStart=(event:PointerEvent)=>{
        if(event.pointerType!=='touch'||!this.overview)return;
        event.preventDefault();event.stopImmediatePropagation();
        if(!this.touchPointers.size){
            this.touchNeedsSnap=this.zoomDamping.active||this.directZoomDragging;
            this.cancelZoom();this.tween?.stop();this.touchPinched=false;
            this.onInspectStart(event);
        }else{this.touchPinched=true;this.clickStart=undefined;}
        this.touchPointers.set(event.pointerId,{clientX:event.clientX,clientY:event.clientY});
        this.runtime.renderer.domElement.setPointerCapture(event.pointerId);
    };
    private onTouchMove=(event:PointerEvent)=>{
        if(!this.touchPointers.has(event.pointerId))return;
        event.preventDefault();event.stopImmediatePropagation();
        const before=this.touchFrame();
        this.touchPointers.set(event.pointerId,{clientX:event.clientX,clientY:event.clientY});
        const after=this.touchFrame(),camera=this.scene.camera,controls=this.scene.controls;
        if(this.clickStart&&Math.hypot(event.clientX-this.clickStart.x,event.clientY-this.clickStart.y)>4)this.clickStart=undefined;
        camera.updateMatrixWorld();
        const ground=this.scene.getPointerRaycast(this.pointerPosition(before));
        const point=this.scene.getPointerRaycast(this.pointerPosition(after));
        const dx=ground.x-point.x,dz=ground.z-point.z;
        camera.position.x+=dx;camera.position.z+=dz;
        controls.target.x+=dx;controls.target.z+=dz;
        // Constrain finger translation at the current scale before zooming.
        // The anchored scale change itself must never apply pan limits.
        if(before.clientX!==after.clientX||before.clientY!==after.clientY)this.scene.constrainPan();
        controls.update();
        camera.updateMatrixWorld();
        this.zoomPointer=this.pointerPosition(after);
        if(this.touchPointers.size>=2&&before.distance>0&&after.distance>0){
            // Reuse continuous LOD and the existing midpoint anchor; release
            // below uses the same five-stop snap policy as the slider.
            this.directZoomDragging=true;
            this.setCameraHeight(THREE.MathUtils.clamp(camera.position.y*before.distance/after.distance,this.closestDistance,this.zoomLevels[3]));
        }
        this.requestUpdate();
    };
    private onTouchEnd=(event:PointerEvent)=>{
        if(!this.touchPointers.has(event.pointerId))return;
        event.preventDefault();event.stopImmediatePropagation();
        if(event.type==='pointerup'&&!this.touchPinched)this.onInspectEnd(event);
        else this.clickStart=undefined;
        this.touchPointers.delete(event.pointerId);
        const canvas=this.runtime.renderer.domElement;
        if(canvas.hasPointerCapture(event.pointerId))canvas.releasePointerCapture(event.pointerId);
        if(!this.touchPointers.size){
            const snap=this.touchPinched||this.touchNeedsSnap;
            this.touchPinched=false;this.touchNeedsSnap=false;
            if(snap)this.setZoomFromControl(this.scene.camera.position.y,'release');
            else this.zoomPointer=undefined;
        }
    };
    private updateZoomControl(){
        if(!this.overview)return;
        const canvas=this.runtime.renderer.domElement;
        const signature=`${this.closestDistance}:${this.zoomLevels[3]}:${canvas.clientHeight}:${this.preview?.pyramid?.snapshot||'legacy'}`;
        const changed = signature !== this.zoomControlSignature;
        const height = this.scene.camera.position.y;
        if (!changed && height === this.zoomSnapshot.height) return;
        this.zoomControlSignature = signature;
        this.zoomSnapshot = { height, stops: changed ? this.distanceLevels() : this.zoomSnapshot.stops };
        for (const listener of this.zoomListeners) listener();
    }
    private refreshOverviewFrame(force=false){
        if(!this.overview)return;
        const canvas=this.runtime.renderer.domElement,width=canvas.clientWidth,height=canvas.clientHeight;
        if(!width||!height)return;
        const signature=`${width}:${height}:${this.scene.camera.fov}`;
        if(!force&&signature===this.viewportSignature)return;
        this.viewportSignature=signature;
        const previous=this.overviewFrame,atOverview=previous&&this.scene.camera.position.y>=previous.height*(1-1e-5);
        const atClosest=!!previous&&this.scene.camera.position.y<=this.closestDistance*(1+1e-5);
        let x=Infinity,y=Infinity,right=-Infinity,bottom=-Infinity;
        for(const r of this.overview.slots){x=Math.min(x,r.x);y=Math.min(y,r.y);right=Math.max(right,r.x+r.width);bottom=Math.max(bottom,r.y+r.height);}
        const frame=overviewFrame({x,y,width:right-x,height:bottom-y},width/height,this.scene.camera.fov,this.overviewCenter);
        this.closestDistance=parcelDetailDistance(height,this.scene.camera.fov);
        this.overviewFrame=frame;this.zoomLevels[3]=frame.height;
        this.scene.camera.far=Math.max(2000000,frame.height*16);this.scene.camera.updateProjectionMatrix();
        this.scene.controls.minDistance=Math.min(this.closestDistance,this.scene.camera.position.y);this.scene.controls.maxDistance=frame.height*MAP_FRAMING.overscrollMultiplier;
        if(atOverview)this.animateDistance(frame.height,{duration:350});
        else if(atClosest||this.scene.camera.position.y<this.closestDistance)this.animateDistance(this.closestDistance,{duration:350});
    }
    private updateZoom(){
        const now=performance.now();
        if(this.wheelGesture.pending){const target=this.wheelGesture.update(now,this.distanceLevels());if(target!==undefined)this.applyWheelZoom(target,now);}
        if(!this.zoomDamping.active)return;
        this.setCameraHeight(this.zoomDamping.tick(now,this.distanceLevels()));
        if(!this.zoomDamping.active)this.zoomPointer=undefined;
        this.requestUpdate();
    }
    private setCameraHeight(height:number){
        const camera=this.scene.camera,pointer=this.zoomPointer;
        camera.updateMatrixWorld();
        const before=pointer?this.scene.getPointerRaycast(pointer):undefined;
        camera.position.y=height;
        if(before){
            this.scene.controls.update();
            camera.updateMatrixWorld();
            const after=this.scene.getPointerRaycast(pointer!);
            // Translate camera and target together to keep the ground point
            // under the cursor fixed throughout the damped zoom animation.
            const dx=before.x-after.x,dz=before.z-after.z;
            camera.position.x+=dx;camera.position.z+=dz;
            this.scene.controls.target.x+=dx;this.scene.controls.target.z+=dz;
            camera.updateMatrixWorld();
        }
    }
    private pixelsPerWorld(){return this.runtime.renderer.domElement.clientHeight/(2*Math.tan(THREE.MathUtils.degToRad(this.scene.camera.fov)/2)*this.scene.camera.position.y);}
    private groundBounds(distance=this.scene.camera.position.y){
        const height=2*Math.tan(THREE.MathUtils.degToRad(this.scene.camera.fov)/2)*distance,width=height*this.scene.camera.aspect;
        const camera=this.scene.camera;
        const center=camera.view?.enabled?this.scene.getPointerRaycast(new THREE.Vector2(0,0)):camera.position;
        return{x:center.x-width/2,y:center.z-height/2,width,height};
    }
    private geometryBounds(){
        // During 4 <-> 3, request only the final stop-3 footprint around the
        // current center. Rendering/preview coverage still use the actual view.
        return this.groundBounds(Math.min(this.scene.camera.position.y,this.distanceLevels()[2]));
    }
    private visibleRegions(bounds:ReturnType<MapController['groundBounds']>){
        return this.overview?.quadtree.retrieve(new Rectangle(bounds)).filter(r=>r.x<bounds.x+bounds.width&&r.x+r.width>bounds.x&&r.y<bounds.y+bounds.height&&r.y+r.height>bounds.y)||[];
    }
    private updateLOD(){
        if(!this.overview)return;
        const now=performance.now(),dt=this.lodTime?Math.min(.1,(now-this.lodTime)/1000):1/60;this.lodTime=now;
        const pixels=this.pixelsPerWorld(),bounds=this.groundBounds();
        const requestBounds=[bounds.x,bounds.y,bounds.width,bounds.height].map(Math.round).join(',');if(requestBounds!==this.requestBounds){this.requestBounds=requestBounds;this.viewRevision++;}
        this.source.setRequestContext?.({viewRevision:this.viewRevision,modeRevision:this.sizeColorRevision,mode:this.renderingMode});
        const pyramid=this.preview?.pyramid||{tileSize:4096,resolution:256,maxLevel:0},max=pyramid.maxLevel;
        const moving=!!this.tween?.isPlaying()||this.zoomDamping.active||this.directZoomDragging;
        const stops=this.distanceLevels();
        const desired=tierDetail(this.scene.camera.position.y,stops,pyramid,1/pixels,moving);
        // Start at the actual overview preview once its index arrives; do not
        // download every invisible ancestor on the way from detail zero.
        if(this.preview?.pyramid&&!this.previewInitialized){this.lodDetail=Math.min(max,desired);this.previewInitialized=true;}
        const rasterAllowed=desired<=max+1+1e-6||this.lodDetail<=max+1+1e-6;
        this.preview?.setActive(rasterAllowed&&this.snapshot.matchedPattern===undefined);
        this.lodTarget=desired;
        if(!this.parcelDownloadsAllowed())this.scheduler?.setDesired([]);
        const geometryBounds=this.geometryBounds(),visible=this.visibleRegions(geometryBounds),vectorsReady=this.neighborhoodChunks?.mode===false
            ?visible.length<=(this.neighborhoodGeometry?.capacity||0)&&visible.every(r=>this.neighborhoodGeometry?.has(Number(r.data)))
            :!!this.neighborhoodChunks?.ready(geometryBounds);
        // Readiness gates entry into a finer level below; it must never lower
        // the camera's target when pan reveals a new, still-loading region.
        const spatialBlend=THREE.MathUtils.clamp(4-zoomPosition(this.scene.camera.position.y,stops),0,1);
        this.preview?.setSpatialView(spatialBlend<1e-6?0:spatialBlend>1-1e-6?1:spatialBlend,pixels,bounds,lod4DownloadsAllowed(this.scene.camera.position.y,stops));
        const needsBitmapMetrics=!this.preview?.aggregateOverviews||zoomPosition(this.scene.camera.position.y,stops)<3-1e-6;
        this.localMetrics?.update(!this.globalMetric&&needsBitmapMetrics&&(isMetric(this.renderingMode)||this.renderingMode==='size')&&lod4DownloadsAllowed(this.scene.camera.position.y,stops)?this.visibleRegions(bounds).map(r=>Number(r.data)):[]);
        const strength=this.renderingMode==='default'?heatmapStrength(this.scene.camera.position.y,stops):1;
        if(!this.preview?.analyticalPolicy)this.preview?.updateView(bounds,this.lodDetail,this.lodTarget,strength);
        // Preview -> exact follows camera/slider position immediately. Network
        // readiness and 600ms per-entry arrivals cannot delay this blend.
        // Parcel arrivals are independent. A missing neighboring layout must not
        // hold back a ready bitmap; its base stays opaque until its own arrival.
        this.lodDetail=desired>=max&&desired<=max+1?desired:advanceDetail(this.lodDetail,this.lodTarget,dt,level=>level>max&&this.lodTarget<this.lodDetail?true:level===max+1?vectorsReady:level>max+1?true:!this.preview?.ready||this.preview.levelReady(max-level,bounds));
        const exact=THREE.MathUtils.clamp(this.lodDetail-max,0,1);
        // Detail LOD may lag a fast reverse zoom. Hide its bitmap/parcel groups
        // at stop 3 and farther even while that independent LOD catches up.
        const parcels=this.parcelDownloadsAllowed()?THREE.MathUtils.clamp(this.lodDetail-max-1,0,1):0;
        const wantedDetails=[...this.neighborhoods.values()].filter(n=>parcels>0&&this.wantedGeometry.has(n.data.neighborhood)&&n.position.x<bounds.x+bounds.width&&n.position.x+n.data.width>bounds.x&&n.position.z<bounds.y+bounds.height&&n.position.z+n.data.height>bounds.y).map(n=>n.data.neighborhood);
        this.arrivalFades?.setVisibleNeighborhoods(wantedDetails);this.arrivalFades?.update(now);
        this.neighborhoodGeometry?.updateView(bounds,exact,1/pixels,parcels,now);
        this.preview?.updateView(bounds,this.lodDetail,this.lodTarget,strength,
            this.lodDetail>=max&&this.lodDetail<=max+1?{opacity:exact,cellSize:this.neighborhoodGeometry?.previewCellSize,revision:this.neighborhoodGeometry?.previewCoverageRevision,coverage:(area,region)=>this.neighborhoodGeometry?.previewCoverage(area,region)??0}:undefined);
        for(const n of this.neighborhoods.values()){
            const visible=n.position.x<bounds.x+bounds.width&&n.position.x+n.data.width>bounds.x&&n.position.z<bounds.y+bounds.height&&n.position.z+n.data.height>bounds.y;
            n.visible=visible&&parcels>0&&(this.wantedGeometry.has(n.data.neighborhood)||(this.arrivalFades?.regionGain(n.data.neighborhood)||0)>0);n.bitmapChunksContainer.visible=n.visible;n.setLOD(pixels,exact,parcels,parcels>0,false);
        }
        // Analytical summaries own distant coverage; the overview still serves pattern highlights and the legacy comparison.
        this.overviewOpacity=1-exact;this.overview?.setOpacity(this.preview?.analyticalPolicy&&this.snapshot.matchedPattern===undefined?0:this.overviewOpacity);
    }

    private onKeyDown = (event: KeyboardEvent) => {
        const element = event.target as HTMLElement;
        if (element.closest('input, textarea, select, button, a, summary, [contenteditable="true"]')) return;
        if (event.key === 'Home' && this.overview) {
            event.preventDefault();
            this.navigationId++;
            this.animateCamera(3, 0, 0);
        }
    };

    private pointerPosition(event: {clientX:number;clientY:number}) {
        const rect = this.runtime.renderer.domElement.getBoundingClientRect();
        return new THREE.Vector2(
            (event.clientX - rect.left) / rect.width * 2 - 1,
            -(event.clientY - rect.top) / rect.height * 2 + 1,
        );
    }
    private pointerWorld(event: PointerEvent | WheelEvent) {
        return this.scene.getPointerRaycast(this.pointerPosition(event));
    }

    private onPointerMove = (event: PointerEvent) => {
        if (!this.overview || event.pointerType==='touch') return;
        const point = this.pointerWorld(event);
        const candidates = this.overview.quadtree.retrieve(new Rectangle({ x: point.x, y: point.z, width: 0.01, height: 0.01 }));
        const hit = candidates.find(rect => point.x >= rect.x && point.x < rect.x + rect.width && point.z >= rect.y && point.z < rect.y + rect.height);
        let bitmap = -1;
        if (hit) {
            const neighborhood = this.neighborhoods.get(hit.data!);
            if (neighborhood) {
                const x = point.x - neighborhood.position.x, y = point.z - neighborhood.position.z;
                const blocks = neighborhood.quadtree.retrieve(new Rectangle({ x, y, width: 0.01, height: 0.01 }));
                const block = blocks.find(rect => x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height);
                if (block) bitmap = Number(block.data);
            }
        }
        this.selectBitmap(bitmap);
        this.report(`${this.layoutLabel} | region ${hit?.data ?? '—'}${bitmap >= 0 ? ` | bitmap ${bitmap}` : ''} | Home: center`);
    };

    private selectBitmap(id: number) {
        if (id === this.hoveredBitmap) return;
        if (this.hoveredBitmap >= 0) this.neighborhoods.get(Math.floor(this.hoveredBitmap / 2016))?.setBitmapSelected(this.hoveredBitmap, false);
        this.hoveredBitmap = id;
        if (id >= 0) this.neighborhoods.get(Math.floor(id / 2016))?.setBitmapSelected(id, true);
    }

    private requestUpdate = () => { this.dirty = true; };

    private parcelDownloadsAllowed(){
        // Begin detail work as the camera enters 3↔2. parcelDownloadView bounds
        // every new request to the final stop-2 frustum, not the wider current view.
        return this.scene.camera.position.y<this.distanceLevels()[2]*(1-1e-6);
    }

    private parcelDownloadView(){
        const current=this.scene.camera,distance=Math.min(current.position.y,this.distanceLevels()[1]);
        const camera=distance<current.position.y?current.clone():current;
        if(camera!==current){camera.position.y=distance;camera.lookAt(this.scene.controls.target);}
        camera.updateMatrixWorld();
        const raycaster=new THREE.Raycaster(),plane=new THREE.Plane(new THREE.Vector3(0,1,0),0);
        if(camera!==current&&this.zoomPointer){
            const before=this.scene.getPointerRaycast(this.zoomPointer);
            raycaster.setFromCamera(this.zoomPointer,camera);
            const after=raycaster.ray.intersectPlane(plane,new THREE.Vector3())!;
            camera.position.x+=before.x-after.x;camera.position.z+=before.z-after.z;
            camera.updateMatrixWorld();
        }
        const points=[[-1,-1],[1,-1],[1,1],[-1,1]].map(([x,y])=>{
            raycaster.setFromCamera(new THREE.Vector2(x,y),camera);
            const point=raycaster.ray.intersectPlane(plane,new THREE.Vector3())!;
            return{x:point.x,y:point.z};
        });
        return{points,frustum:new RectFrustum(points)};
    }

    private updateMap() {
        if (!this.overview) return;
        // Rendering keeps its actual viewport. Each download tier anticipates
        // only the footprint at its own final zoom stop.
        const camera = this.scene.camera;
        camera.updateMatrixWorld();
        // Use the same region coverage as the LOD readiness gate. OrbitControls'
        // tiny top-down tilt can otherwise leave a boundary-only neighbor missing
        // forever: the ray polygon excludes it while the readiness bounds include it.
        const geometryBounds=this.geometryBounds();
        const visible = this.visibleRegions(geometryBounds);
        const center = this.scene.controls.target;
        visible.sort((a, b) => (a.x + a.width / 2 - center.x) ** 2 + (a.y + a.height / 2 - center.z) ** 2
            - (b.x + b.width / 2 - center.x) ** 2 - (b.y + b.height / 2 - center.z) ** 2);
        const pyramid=this.preview?.pyramid||{tileSize:4096,resolution:256,maxLevel:0},max=pyramid.maxLevel;
        const detail=tierDetail(this.scene.camera.position.y,this.distanceLevels(),pyramid,1/this.pixelsPerWorld(),true);
        const geometryTier=detail>max+1e-6||this.lodDetail>max+1e-6;
        const parcelTier=detail>max+1+1e-6;
        const parcelView=this.parcelDownloadsAllowed()?this.parcelDownloadView():undefined;
        this.neighborhoodChunks?.update(geometryTier?geometryBounds:undefined);
        this.neighborhoodGeometry?.setWanted(geometryTier&&this.neighborhoodChunks?.mode===false?visible.map(r=>r.data!):[]);
        const detailed=parcelTier?visible:[];
        this.wantedGeometry=selectDetailRegions(detailed.map(rect=>rect.data!),this.wantedGeometry);
        const selectedDetails=detailed.filter(rect=>this.wantedGeometry.has(rect.data!));
        const requestedDetails=parcelView?selectedDetails.filter(rect=>parcelView.frustum.intersects(rect)):[];
        this.wantedParcelGeometry=new Set(requestedDetails.map(rect=>rect.data!));
        const vectorWishes=geometryTier&&this.neighborhoodChunks?.mode===false?visible.slice(0,this.neighborhoodGeometry?.capacity||0):[];
        this.setGeometryWishes([...this.wantedParcelGeometry,...vectorWishes.map(rect=>rect.data!)]);
        for(const rect of requestedDetails){
            const id=rect.data!;if(this.neighborhoods.has(id)||this.pendingNeighborhoods.has(id))continue;
            if(!this.geometryLoads.has(id)&&this.geometryLoads.size>=4)break;
            void this.ensureNeighborhood(id).catch(error=>{if(this.active&&(error as Error)?.name!=='AbortError')this.report(error);});
        }
        for(const rect of vectorWishes){
            const id=rect.data!;if(this.neighborhoodGeometry?.has(id)||this.vectorLoads.has(id))continue;
            if(!this.geometryLoads.has(id)&&this.geometryLoads.size>=4)break;
            void this.ensureVectorRegion(id).catch(error=>{if(this.active&&(error as Error)?.name!=='AbortError')this.report(error);});
        }
        for(const rect of visible)if(this.detailLRU.has(rect.data!))this.detailLRU.set(rect.data!,performance.now());
        const selectionSignature=`${geometryTier}:${parcelTier}:${this.priorityBitmap}:${parcelView?.points.map(p=>`${p.x},${p.y}`).join(';')||''}:${detailed.map(r=>this.neighborhoods.has(r.data!)?r.data:'pending').join(',')}`;
        if(selectionSignature===this.selectionSignature&&(!parcelTier||this.scheduler.desiredCount>0))return;
        this.selectionSignature=selectionSignature;
        const blocks: number[] = [];
        const frustum=parcelView?.frustum;
        if(frustum)for (const rect of requestedDetails) {
            const neighborhood = this.neighborhoods.get(rect.data!);
            if (!neighborhood) continue;
            if(frustum.contains(rect)){
                const first=neighborhood.data.neighborhood*2016;
                for(let i=0;i<neighborhood.data.bitmaps.length;i++)blocks.push(first+i);
                continue;
            }
            const b=frustum.bounds,localBounds=new Rectangle({x:b.x-neighborhood.position.x,y:b.y-neighborhood.position.z,width:b.width,height:b.height});
            for(const block of neighborhood.quadtree.retrieve(localBounds))
                if(frustum.intersects(block,neighborhood.position.x,neighborhood.position.z))blocks.push(Number(block.data));
        }
        // Round-robin spatial cells preserves distributed refinement at every viewport.
        const cells = new Map<string, number[]>();
        for (const id of blocks) {
            const n = this.neighborhoods.get(Math.floor(id / 2016))!;
            const r = n.data.bitmaps[id % 2016];
            const key = `${n.data.neighborhood}:${Math.floor(r.x / n.data.width * 8)}:${Math.floor(r.y / n.data.height * 8)}`;
            const cell = cells.get(key) || []; cell.push(id); cells.set(key, cell);
        }
        const distributed = interleaveSpatial([...cells.values()]);
        if (distributed.includes(this.priorityBitmap)) { distributed.splice(distributed.indexOf(this.priorityBitmap), 1); distributed.unshift(this.priorityBitmap); }
        const signature = distributed.join(',');
        if (signature !== this.desiredSignature) { this.desiredSignature = signature; this.budgetSkipped.clear(); }
        this.scheduler?.setDesired(distributed);
    }

    update() {
        if (!this.active || !this.scene) return;
        this.refreshOverviewFrame();
        this.tween?.update();
        this.updateZoom();
        this.scene.controls.minDistance=this.tween?.isPlaying()?Math.min(this.closestDistance,this.scene.camera.position.y):this.closestDistance;
        this.scene.controls.update();
        this.scene.alignParcelPixels(!this.tween?.isPlaying()&&!this.zoomDamping.active&&Math.abs(this.scene.camera.position.y-this.closestDistance)<this.closestDistance*1e-6);
        this.updateLOD();
        this.updateZoomControl();
        if (this.genesisLabel) {
            const height = Math.max(2, this.scene.camera.position.y * 0.004);
            const aspect = this.genesisLabel.scale.x / this.genesisLabel.scale.y;
            this.genesisLabel.scale.set(height * aspect, height, 1);
        }
        const now = performance.now();
        if (this.dirty && now - this.lastUpdate >= 120) {
            this.dirty = false;
            this.lastUpdate = now;
            this.updateMap();
        }
    }

    private report(message: unknown) {
        this.publish({ status: message instanceof Error ? message.message : String(message) });
    }

    dispose() {
        if (this.disposed) return;
        const wasActive = this.active;
        this.active = false;
        this.disposed = true;
        this.publish({ ready: false, renderingBusy: false });
        this.listeners.clear();
        this.zoomListeners.clear();
        if (!wasActive) return;
        this.modeAbort.abort();this.filterAbort.abort();this.patternsClient?.close();++this.patternFilterRevision;this.localMetrics?.close();this.sizeColorRevision++;this.parcelFilterRevision++;this.parcelClassTexture?.dispose();
        this.navigationId++;
        this.geometryAbort.abort();this.geometryControllers.clear();this.viewGeometryWishes.clear();
        this.cancelZoom();
        this.tween?.stop();
        this.layoutWorker?.terminate();
        this.bitmapWorker?.terminate();
        this.scheduler?.close();
        this.source?.close();
        cancelAnimationFrame(this.uploadFrame);
        this.uploadFrame = 0;
        this.uploads.length = 0;
        for (const job of this.workerJobs.values()) job.resolve();
        this.workerJobs.clear();
        this.inFlight.clear();
        const canvas = this.runtime.renderer.domElement;
        canvas.removeEventListener('pointerdown', this.onTouchStart, true);
        canvas.removeEventListener('pointermove', this.onTouchMove, true);
        canvas.removeEventListener('pointerup', this.onTouchEnd, true);
        canvas.removeEventListener('pointercancel', this.onTouchEnd, true);
        canvas.removeEventListener('lostpointercapture', this.onTouchEnd, true);
        for(const id of this.touchPointers.keys())if(canvas.hasPointerCapture(id))canvas.releasePointerCapture(id);
        this.touchPointers.clear();
        canvas.removeEventListener('pointermove', this.onPointerMove);
        canvas.removeEventListener('pointerdown',this.onInspectStart);canvas.removeEventListener('pointerup',this.onInspectEnd);
        canvas.removeEventListener('pointerup', this.requestUpdate);
        canvas.removeEventListener('pointerdown', this.onMiddleZoomStart, true);
        canvas.removeEventListener('pointermove', this.onMiddleZoomMove, true);
        canvas.removeEventListener('pointerup', this.onMiddleZoomEnd, true);
        canvas.removeEventListener('pointercancel', this.onMiddleZoomEnd, true);
        canvas.removeEventListener('lostpointercapture', this.onMiddleZoomEnd, true);
        canvas.removeEventListener('auxclick', this.onMiddleAuxClick);
        canvas.removeEventListener('wheel', this.onWheel);
        window.removeEventListener('keydown', this.onKeyDown);
        this.scene?.controls?.removeEventListener('change', this.requestUpdate);
        this.overview?.dispose();
        this.preview?.dispose();
        this.neighborhoodChunks?.close();
        this.neighborhoodGeometry?.dispose();
        this.arrivalFades?.dispose();
        this.analyticTexture?.dispose();this.selectionOutline?.geometry.dispose();(this.selectionOutline?.material as THREE.Material|undefined)?.dispose();
        for (const neighborhood of this.neighborhoods.values()) neighborhood.dispose();
        this.genesisLabel?.material.map?.dispose();
        this.genesisLabel?.material.dispose();
        this.genesisLabel?.removeFromParent();
        this.genesisLabel = undefined;
        this.neighborhoods.clear();
        this.loadedBitmaps.clear();
        this.scene?.dispose();
    }
}
