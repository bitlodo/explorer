import * as THREE from 'three';
import type { MapDataSource } from '@/data/MapDataSource';
import RetryPolicy from '@/data/RetryPolicy';
import type { NeighborhoodSlot } from '@shared/NeighborhoodLayout';
import type { RegionSummaries } from '@shared/analyticalLod';
import type { Lod4Metric } from '@shared/lod4Summary';
import { summarizeAggregateCells, type AggregateIndex, type AggregateBatchRef, type AggregateRegion } from '@shared/lod4Aggregates';
import { parcelRangeKey, type ParcelFilterIndex, type ParcelFilterBatchRef, type ParcelFilterGrid } from '@shared/parcelFilters';
import SpatialLod4Layer from './SpatialLod4Layer';
import AnalyticalRegionPreviewLayer, { type PreviewGeometryCoverage } from './AnalyticalRegionPreviewLayer';

type Bounds={x:number;y:number;width:number;height:number};
type Resident={page:AggregateRegion;born:number;used:number;layer?:AnalyticalRegionPreviewLayer;step?:number;rowStep?:number;revision?:number};
const intersects=(a:Bounds,b:Bounds)=>a.x<b.x+b.width&&a.x+a.width>b.x&&a.y<b.y+b.height&&a.y+a.height>b.y;
const grouping=(extent:number,pixels:number)=>16/Math.min(16,2**Math.floor(Math.log2(Math.max(1,extent*pixels/4))));
const emptyMeans=new Float32Array(256).fill(1),emptyWeights=new Float32Array(256);
export const AGGREGATE_DECODED_BUDGET=8*1024*1024;

/** Unfiltered 16x16 statistics use small spatial batches; exact filters retain membership data. */
export default class SpatialSummaryLayer extends THREE.Group {
    private exact:SpatialLod4Layer;
    private index?:AggregateIndex;
    private rootLoad?:Promise<void>;
    private missing=false;
    private closed=false;
    private metric?:Lod4Metric;
    private summaries:RegionSummaries;
    private weights:Float32Array;
    private colors:readonly string[]=[];
    private revision=0;
    private retry=new RetryPolicy();
    private records=new Map<string,Resident>();
    private batches=new Map<string,AggregateBatchRef>();
    private active=new Map<string,AbortController>();
    private wanted=new Map<string,AggregateBatchRef>();
    private filterIndexes=new Map<string,ParcelFilterIndex>();
    private filterLoad?:{key:string;controller:AbortController};
    private filterRecords=new Map<string,{page:ParcelFilterGrid;used:number}>();
    private filterBatches=new Map<string,{range:string;ref:ParcelFilterBatchRef;used:number}>();
    private filterActive=new Map<string,AbortController>();
    private filterWanted=new Map<string,ParcelFilterBatchRef>();
    private filterBytes=0;
    private aggregatesStats={indexRequests:0,requests:0,loaded:0,visibleRegions:0,cells:0,decodedBytes:0,active:0,wanted:0,budgetLimited:0};
    private get parcelFilter(){return this.metric?.mode==='size'&&this.metric.filtered&&this.metric.range&&!!this.source.getParcelFilterIndex;}
    private get rangeKey(){return this.parcelFilter?parcelRangeKey(...this.metric!.range!):undefined;}
    private get useExact(){return !this.metric?.mode||(this.metric.filtered&&!this.parcelFilter)||this.missing;}
    get stats(){return this.useExact?this.exact.stats:this.aggregatesStats;}
    get supportsAggregates(){return !!this.index;}
    get aggregateOverviews(){return !this.missing;}
    constructor(private source:MapDataSource,private slots:readonly NeighborhoodSlot[],private changed:()=>void,private report:(error:unknown)=>void){
        super();this.name='spatial-summary';this.weights=new Float32Array(slots.length).fill(1);this.summaries=new Float32Array(slots.length*2);
        this.exact=new SpatialLod4Layer(source,slots,changed,report);this.add(this.exact);
    }
    setMetric(metric:Lod4Metric){
        if(this.metric?.range?.join(',')!==metric.range?.join(',')||this.metric?.mode!==metric.mode)this.cancelFilters();
        if(this.metric?.mode!==metric.mode)for(const r of this.records.values()){r.layer?.dispose();r.layer=undefined;}
        this.metric=metric;this.revision++;this.exact.setMetric(metric);this.changed();
    }
    setSummaries(summaries:RegionSummaries){this.summaries=summaries;this.exact.setSummaries(summaries);}
    setColors(colors:readonly string[]){this.colors=colors;this.exact.setColors(colors);for(const r of this.records.values())r.layer?.setColors(colors);}
    setLayout(slots:readonly NeighborhoodSlot[]){this.slots=slots;this.weights=new Float32Array(slots.length).fill(1);this.exact.setLayout(slots);for(const r of this.records.values()){r.layer?.dispose();r.layer=undefined;}}
    private loadRoot(){
        if(this.rootLoad||this.missing||!this.retry.ready('root'))return;
        this.aggregatesStats.indexRequests++;
        this.rootLoad=this.source.getLod4SummaryIndex!().then(index=>{
            if(this.closed)return;this.retry.success('root');this.index=index;this.missing=!index;this.changed();
        }).catch(error=>{if(!this.closed){this.retry.fail('root',error);this.rootLoad=undefined;this.report(error);}});
    }
    private pump(){
        if(this.closed||!this.index)return;
        for(const [key,ref] of this.wanted){
            if(this.active.size+this.filterActive.size>=4)break;
            if(this.batches.has(key)||this.active.has(key)||!this.retry.ready(key))continue;
            const controller=new AbortController();this.active.set(key,controller);this.aggregatesStats.requests++;
            void this.source.getLod4SummaryBatch!(this.index,ref,controller.signal).then(pages=>{
                if(this.closed||controller.signal.aborted)return;
                this.retry.success(key);const now=performance.now();
                for(const page of pages){const id=ref.mode+':'+page.id;this.records.set(id,{page,born:now,used:now});this.aggregatesStats.decodedBytes+=page.means.byteLength+page.weights.byteLength+page.coverage.byteLength;}
                this.batches.set(key,ref);this.evict();this.changed();
            }).catch(error=>{if(!this.closed&&!controller.signal.aborted){this.retry.fail(key,error);this.report(error);}})
                .finally(()=>{if(this.active.get(key)===controller)this.active.delete(key);this.aggregatesStats.active=this.active.size;this.pump();});
        }
        this.pumpFilters();this.aggregatesStats.active=this.active.size+this.filterActive.size;
    }
    private loadFilter(){
        const key=this.rangeKey;if(!key||this.filterIndexes.has(key)||this.filterLoad||!this.retry.ready('filter:'+key))return;
        const controller=new AbortController();this.filterLoad={key,controller};
        void this.source.getParcelFilterIndex!(...this.metric!.range!,controller.signal).then(index=>{
            if(this.closed||controller.signal.aborted)return;this.filterIndexes.set(key,index);this.retry.success('filter:'+key);this.changed();
        }).catch(error=>{if(!this.closed&&!controller.signal.aborted){this.retry.fail('filter:'+key,error);this.report(error);}}).finally(()=>{if(this.filterLoad?.controller===controller)this.filterLoad=undefined;});
    }
    private pumpFilters(){
        const key=this.rangeKey,index=key?this.filterIndexes.get(key):undefined;if(this.closed||!key||!index)return;
        for(const [url,ref] of this.filterWanted){
            if(this.active.size+this.filterActive.size>=4)break;
            if(this.filterBatches.has(url)||this.filterActive.has(url)||!this.retry.ready(url))continue;
            const controller=new AbortController();this.filterActive.set(url,controller);this.aggregatesStats.requests++;
            void this.source.getParcelFilterBatch!(index,ref,controller.signal).then(pages=>{
                if(this.closed||controller.signal.aborted)return;const now=performance.now();this.retry.success(url);
                for(const page of pages){this.filterRecords.set(key+':'+page.id,{page,used:now});this.filterBytes+=page.means.byteLength+page.weights.byteLength;}
                this.filterBatches.set(url,{range:key,ref,used:now});this.evictFilters();this.changed();
            }).catch(error=>{if(!this.closed&&!controller.signal.aborted){this.retry.fail(url,error);this.report(error);}}).finally(()=>{if(this.filterActive.get(url)===controller)this.filterActive.delete(url);this.pump();});
        }
    }
    private evictFilters(){
        while(this.filterBytes>AGGREGATE_DECODED_BUDGET){
            const victim=[...this.filterBatches].filter(([url])=>!this.filterWanted.has(url)).sort((a,b)=>a[1].used-b[1].used)[0];if(!victim)break;
            const [url,batch]=victim;for(const id of batch.ref.ids){const k=batch.range+':'+id,page=this.filterRecords.get(k)!.page;this.filterBytes-=page.means.byteLength+page.weights.byteLength;this.filterRecords.delete(k);}this.filterBatches.delete(url);
        }
    }
    private evict(){
        // All five modes of the maximum supported dataset fit; retain an explicit budget nonetheless.
        while(this.aggregatesStats.decodedBytes>AGGREGATE_DECODED_BUDGET){
            const candidate=[...this.batches].filter(([key])=>!this.wanted.has(key)).sort((a,b)=>Math.min(...a[1].ids.map(id=>this.records.get(a[1].mode+':'+id)!.used))-Math.min(...b[1].ids.map(id=>this.records.get(b[1].mode+':'+id)!.used)))[0];
            if(!candidate){this.aggregatesStats.budgetLimited++;break;}
            const [key,ref]=candidate;for(const id of ref.ids){const k=ref.mode+':'+id,r=this.records.get(k)!;r.layer?.dispose();this.aggregatesStats.decodedBytes-=r.page.means.byteLength+r.page.weights.byteLength+r.page.coverage.byteLength;this.records.delete(k);}this.batches.delete(key);
        }
        this.aggregatesStats.loaded=this.records.size;
    }
    private configure(r:Resident,step:number,rowStep:number,filter?:ParcelFilterGrid){
        if(r.layer&&r.step===step&&r.rowStep===rowStep&&r.revision===this.revision)return;
        const id=r.page.id,cells=summarizeAggregateCells(filter?{...r.page,means:filter.means,weights:filter.weights}:r.page,this.metric!,step,rowStep,filter?r.page.weights:undefined),parent=this.slots[id];
        if(!r.layer||r.step!==step||r.rowStep!==rowStep){
            r.layer?.dispose();const slots=cells.bounds.map(b=>({...parent,x:parent.x+b.x,y:parent.y+b.y,width:b.width,height:b.height}));
            r.layer=new AnalyticalRegionPreviewLayer(slots,cells.summaries,{owners:slots.map(()=>id),parents:this.slots,contentCoverage:cells.coverage,baseSummary:[this.summaries[id*2],this.summaries[id*2+1]]});
            r.layer.setRegionStyle('density');r.layer.setColors(this.colors);this.add(r.layer);
        }else r.layer.setSummaries(cells.summaries);
        r.step=step;r.rowStep=rowStep;r.revision=this.revision;
    }
    updateView(bounds:Bounds,downloadBounds:Bounds,blend:number,pixels:number,strength:number,geometry?:PreviewGeometryCoverage,downloadsAllowed=false){
        for(const r of this.records.values())if(r.layer)r.layer.visible=false;
        if(this.useExact){this.cancelBatches();this.cancelFilters();this.exact.visible=true;return this.exact.updateView(bounds,downloadBounds,blend,pixels,strength,geometry,downloadsAllowed);}
        this.exact.visible=false;this.exact.stop();this.weights.fill(1);this.aggregatesStats.visibleRegions=0;this.aggregatesStats.cells=0;
        blend=blend<1e-6?0:blend>1-1e-6?1:blend;
        if(this.closed||!this.metric||blend<=0||strength<=0){this.cancelBatches();this.cancelFilters();return this.weights;}
        const mode=this.metric.mode!,visible=this.slots.flatMap((r,id)=>intersects(r,downloadBounds)&&Math.max(r.width,r.height)*pixels>=8?[id]:[]),ids=new Set(visible);
        if(downloadsAllowed&&geometry?.opacity!==1&&ids.size)this.loadRoot();
        const cx=downloadBounds.x+downloadBounds.width/2,cy=downloadBounds.y+downloadBounds.height/2;
        const candidates=(!downloadsAllowed||geometry?.opacity===1?[]:this.index?.batches.filter(b=>b.mode===mode&&b.ids.some(id=>ids.has(id)))??[]);
        const distance=(b:AggregateBatchRef)=>Math.min(...b.ids.filter(id=>ids.has(id)).map(id=>{const r=this.slots[id];return (r.x+r.width/2-cx)**2+(r.y+r.height/2-cy)**2;}));
        candidates.sort((a,b)=>Number(!this.wanted.has(a.url))-Number(!this.wanted.has(b.url))||distance(a)-distance(b));
        this.wanted=new Map(candidates.map(b=>[b.url,b]));this.aggregatesStats.wanted=downloadsAllowed&&geometry?.opacity!==1?visible.length:0;
        if(downloadsAllowed&&geometry?.opacity!==1&&ids.size&&this.parcelFilter)this.loadFilter();
        const range=this.rangeKey,filterIndex=range?this.filterIndexes.get(range):undefined,matching=filterIndex?.matchingRegions?new Set(filterIndex.matchingRegions):undefined;
        const filtered=filterIndex?.batches.filter(b=>b.ids.some(id=>ids.has(id)&&(!matching||matching.has(id))));
        this.filterWanted=new Map((!downloadsAllowed||geometry?.opacity===1?[]:filtered??[]).map(b=>[b.url,b]));
        for(const [url,c] of this.filterActive)if(!this.filterWanted.has(url))c.abort();
        for(const [key,c] of this.active)if(!this.wanted.has(key))c.abort();this.pump();
        const now=performance.now();
        for(const [key,r] of this.records){
            if(!key.startsWith(mode+':'))continue;const slot=this.slots[r.page.id];if(!slot||!intersects(slot,bounds)||Math.max(slot.width,slot.height)*pixels<8)continue;
            const knownEmpty=range&&matching&&!matching.has(r.page.id),selected=range?this.filterRecords.get(range+':'+r.page.id):undefined;if(range&&!selected&&!knownEmpty)continue;if(selected)selected.used=now;
            const filteredPage=knownEmpty?{id:r.page.id,means:emptyMeans.subarray(0,r.page.means.length),weights:emptyWeights.subarray(0,r.page.weights.length)}:selected?.page;
            const step=grouping(slot.width,pixels),rowStep=grouping(slot.height,pixels);r.used=now;
            this.weights[r.page.id]=0;this.aggregatesStats.visibleRegions++;this.aggregatesStats.cells+=Math.ceil(r.page.columns/step)*Math.ceil(r.page.rows/rowStep);
            // A settled whole-region proof also covers every child cell while
            // reverse zoom reveals the preview. Keep the linear opacity blend.
            const covered=!!geometry&&geometry.opacity>0&&geometry.coverage(slot,r.page.id)===1;
            if(geometry?.opacity===1&&covered)continue;
            this.configure(r,step,rowStep,filteredPage);
            const layer=r.layer!;layer.visible=true;layer.setBaseSummary(this.summaries[r.page.id*2],this.summaries[r.page.id*2+1]);layer.setSpatialMix(blend,Math.min(1,(now-r.born)/600));layer.updateView(bounds,strength,covered?{...geometry!,uniformCoverage:1}:geometry);
        }
        return this.weights;
    }
    private cancelBatches(){this.wanted.clear();this.aggregatesStats.wanted=0;for(const c of this.active.values())c.abort();}
    private cancelFilters(){this.filterWanted.clear();for(const c of this.filterActive.values())c.abort();this.filterLoad?.controller.abort();this.filterLoad=undefined;}
    stop(){this.cancelBatches();this.cancelFilters();this.exact.stop();}
    dispose(){this.closed=true;this.stop();this.exact.dispose();for(const r of this.records.values())r.layer?.dispose();this.records.clear();this.batches.clear();this.filterRecords.clear();this.filterBatches.clear();this.filterIndexes.clear();this.clear();}
}
