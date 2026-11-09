import RetryPolicy from '@/data/RetryPolicy';
import * as THREE from 'three';
import type { MapDataSource } from '@/data/MapDataSource';
import type { NeighborhoodSlot } from '@shared/NeighborhoodLayout';
import { compactLod4Region, type Lod4Index, type Lod4Region } from '@shared/lod4';
import { summarizeLod4Cells, type Lod4Metric } from '@shared/lod4Summary';
import type { RegionSummaries } from '@shared/analyticalLod';
import AnalyticalRegionPreviewLayer, { type PreviewGeometryCoverage } from './AnalyticalRegionPreviewLayer';

type Bounds={x:number;y:number;width:number;height:number};
type Resident={page:Lod4Region<Uint32Array>;bytes:number;born:number;used:number;layer?:AnalyticalRegionPreviewLayer;step?:number;rowStep?:number;revision?:number};
const intersects=(a:Bounds,b:Bounds)=>a.x<b.x+b.width&&a.x+a.width>b.x&&a.y<b.y+b.height&&a.y+a.height>b.y;
// Cover the visible viewport, rather than imposing a camera-centered region count.
// 521 is the format's maximum neighborhood count, not a download target.
export const LOD4_RESIDENT_REGIONS=521,LOD4_DECODED_BUDGET=24*1024*1024;
const grouping=(extent:number,pixels:number)=>16/Math.min(16,2**Math.floor(Math.log2(Math.max(1,extent*pixels/4))));

/** Bounded spatial previews. No page or geometry is requested at the opening stop 5. */
export default class SpatialLod4Layer extends THREE.Group {
    private index?:Lod4Index;
    private rootLoad?:Promise<void>;
    private unavailable=false;
    private closed=false;
    private metric?:Lod4Metric;
    private revision=0;
    private summaries:RegionSummaries;
    private colors:readonly string[]=[];
    private records=new Map<number,Resident>();
    private active=new Map<number,AbortController>();
    private wanted=new Set<number>();
    private retry=new RetryPolicy();
    private deferred=new Set<number>();
    private weights:Float32Array;
    readonly stats={indexRequests:0,requests:0,loaded:0,visibleRegions:0,cells:0,decodedBytes:0,active:0,wanted:0,budgetLimited:0};
    constructor(private source:MapDataSource,private slots:readonly NeighborhoodSlot[],private changed:()=>void,private report:(error:unknown)=>void){
        super();this.name='spatial-lod4';this.weights=new Float32Array(slots.length).fill(1);this.summaries=new Float32Array(slots.length*2);
    }
    setMetric(metric:Lod4Metric){this.metric=metric;this.revision++;this.changed();}
    setSummaries(summaries:RegionSummaries){this.summaries=summaries;}
    setColors(colors:readonly string[]){this.colors=colors;for(const r of this.records.values())r.layer?.setColors(colors);}
    setLayout(slots:readonly NeighborhoodSlot[]){
        this.slots=slots;this.weights=new Float32Array(slots.length).fill(1);
        for(const r of this.records.values()){r.layer?.dispose();r.layer=undefined;}
    }
    private loadRoot(){
        if(this.rootLoad||this.unavailable||!this.retry.ready('root')||!this.source.getLod4Index||!this.source.getLod4Region)return;
        this.stats.indexRequests++;
        this.rootLoad=this.source.getLod4Index().then(index=>{if(this.closed)return;this.retry.success('root');this.index=index;this.unavailable=!index;this.pump();this.changed();})
            .catch(error=>{if(!this.closed){this.retry.fail('root',error);this.rootLoad=undefined;this.report(error);}});
    }
    private evict(except:number){
        while(this.records.size>LOD4_RESIDENT_REGIONS||this.stats.decodedBytes>LOD4_DECODED_BUDGET){
            const victim=[...this.records.entries()].filter(([id])=>id!==except).sort((a,b)=>Number(this.wanted.has(a[0]))-Number(this.wanted.has(b[0]))||a[1].used-b[1].used)[0];
            if(!victim){const r=this.records.get(except);if(r){r.layer?.dispose();this.stats.decodedBytes-=r.bytes;this.records.delete(except);this.deferred.add(except);}break;}
            if(this.wanted.has(victim[0]))this.deferred.add(victim[0]);
            victim[1].layer?.dispose();this.records.delete(victim[0]);this.stats.decodedBytes-=victim[1].bytes;
        }
        this.stats.loaded=this.records.size;
        this.stats.budgetLimited=this.deferred.size;
    }
    private pump(){
        if(this.closed||!this.index||!this.source.getLod4Region)return;
        for(const id of this.wanted){
            if(this.active.size>=4)break;
            if(this.records.has(id)||this.active.has(id)||!this.retry.ready(id)||this.deferred.has(id))continue;
            const controller=new AbortController();this.active.set(id,controller);this.stats.requests++;
            void this.source.getLod4Region(this.index,id,controller.signal).then(decoded=>{
                if(this.closed||controller.signal.aborted)return;
                this.retry.success(id);const page=compactLod4Region(decoded);
                const bytes=page.bitmapAreas.byteLength+page.cellOffsets.byteLength+page.memberDeltas.byteLength+page.overlapAreas.byteLength;
                const now=performance.now();this.records.set(id,{page,bytes,born:now,used:now});this.stats.decodedBytes+=bytes;this.evict(id);this.changed();
            }).catch(error=>{if(!this.closed&&!controller.signal.aborted){this.retry.fail(id,error);this.report(error);}})
                .finally(()=>{this.active.delete(id);this.stats.active=this.active.size;this.pump();});
        }
        this.stats.active=this.active.size;
    }
    private configure(id:number,r:Resident,step:number,rowStep:number){
        if(r.layer&&r.step===step&&r.rowStep===rowStep&&r.revision===this.revision)return;
        const cells=summarizeLod4Cells(r.page,this.metric!,step,rowStep),parent=this.slots[id];
        if(!r.layer||r.step!==step||r.rowStep!==rowStep){
            r.layer?.dispose();
            const slots=cells.bounds.map(b=>({...parent,x:parent.x+b.x,y:parent.y+b.y,width:b.width,height:b.height}));
            r.layer=new AnalyticalRegionPreviewLayer(slots,cells.summaries,{owners:slots.map(()=>id),parents:this.slots,contentCoverage:cells.coverage,baseSummary:[this.summaries[id*2],this.summaries[id*2+1]]});
            r.layer.setRegionStyle('density');r.layer.setColors(this.colors);r.layer.visible=false;this.add(r.layer);
        }else r.layer.setSummaries(cells.summaries);
        r.step=step;r.rowStep=rowStep;r.revision=this.revision;
    }
    updateView(bounds:Bounds,downloadBounds:Bounds,blend:number,pixels:number,strength:number,geometry?:PreviewGeometryCoverage,downloadsAllowed=false){
        blend=blend<1e-6?0:blend>1-1e-6?1:blend;
        this.weights.fill(1);this.stats.visibleRegions=0;this.stats.cells=0;
        const now=performance.now();
        for(const r of this.records.values())if(r.layer)r.layer.visible=false;
        if(this.closed||!this.metric||blend<=0||strength<=0){this.wanted.clear();this.stats.wanted=0;for(const c of this.active.values())c.abort();return this.weights;}
        const candidates=(!downloadsAllowed||geometry?.opacity===1?[]:this.slots.map((slot,id)=>({slot,id})).filter(({slot})=>intersects(slot,downloadBounds)&&Math.max(slot.width,slot.height)*pixels>=8));
        const cx=downloadBounds.x+downloadBounds.width/2,cy=downloadBounds.y+downloadBounds.height/2;
        const distance=(r:typeof candidates[number])=>(r.slot.x+r.slot.width/2-cx)**2+(r.slot.y+r.slot.height/2-cy)**2;
        candidates.sort((a,b)=>Number(!this.wanted.has(a.id))-Number(!this.wanted.has(b.id))||distance(a)-distance(b));
        const wanted=new Set(candidates.map(r=>r.id));
        if(wanted.size!==this.wanted.size||[...wanted].some(id=>!this.wanted.has(id)))this.deferred.clear();
        this.wanted=wanted;this.stats.wanted=wanted.size;this.stats.budgetLimited=this.deferred.size;
        for(const [id,c] of this.active)if(!this.wanted.has(id))c.abort();
        if(this.wanted.size){this.loadRoot();this.pump();}
        for(const [id,r] of this.records){
            const slot=this.slots[id];if((this.metric.ready&&!this.metric.ready(id))||!slot||!intersects(slot,bounds)||Math.max(slot.width,slot.height)*pixels<8)continue;
            const step=grouping(slot.width,pixels),rowStep=grouping(slot.height,pixels);r.used=now;
            this.weights[id]=0;this.stats.visibleRegions++;this.stats.cells+=Math.ceil(r.page.columns/step)*Math.ceil(r.page.rows/rowStep);
            const covered=!!geometry&&geometry.opacity>0&&geometry.coverage(slot,id)===1;
            if(geometry?.opacity===1&&covered)continue;
            this.configure(id,r,step,rowStep);
            const layer=r.layer!;layer.setBaseSummary(this.summaries[id*2],this.summaries[id*2+1]);
            layer.setSpatialMix(blend,Math.min(1,(now-r.born)/600));layer.updateView(bounds,strength,covered?{...geometry!,uniformCoverage:1}:geometry);
        }
        return this.weights;
    }
    stop(){this.wanted.clear();for(const c of this.active.values())c.abort();}
    dispose(){this.closed=true;this.stop();for(const r of this.records.values())r.layer?.dispose();this.records.clear();this.clear();}
}
