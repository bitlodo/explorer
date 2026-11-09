import type { MapDataSource } from './MapDataSource';
import type { SpatialMetricPage } from '../shared/spatialMetrics';
import RetryPolicy from './RetryPolicy';
/** Visible-region values, bounded independently from the sparse GPU score arrays. */
export default class SpatialMetricLoader {
    private records=new Map<number,SpatialMetricPage>();
    private consumed=new Set<number>();
    private wanted=new Set<number>();
    private active=new Map<number,AbortController>();
    private retry=new RetryPolicy();
    private closed=false;
    constructor(private source:MapDataSource,private loaded:(page:SpatialMetricPage)=>void,private changed:()=>void,private report:(e:unknown)=>void){}
    get(region:number){return this.records.get(region);}
    update(ids:Iterable<number>){
        if(this.closed)return;
        this.wanted=new Set(ids);
        for(const [id,c] of this.active)if(!this.wanted.has(id))c.abort();
        for(const id of this.wanted){const page=this.records.get(id);if(page){this.records.delete(id);this.records.set(id,page);}}
        this.pump();
    }
    replay(){this.consumed=new Set(this.records.keys());for(const page of this.records.values())this.loaded(page);}
    private pump(){
        if(this.closed||!this.source.getSpatialMetricPage)return;
        for(const id of this.wanted){
            if(this.active.size>=4)break;
            if(this.consumed.has(id)||this.active.has(id)||!this.retry.ready(id))continue;
            const c=new AbortController();this.active.set(id,c);
            void this.source.getSpatialMetricPage(id,c.signal).then(page=>{
                if(c.signal.aborted||this.closed)return;
                this.retry.success(id);this.consumed.add(id);this.records.set(id,page);this.loaded(page);
                while(this.records.size>64){this.records.delete(this.records.keys().next().value!);}
                this.changed();
            }).catch(e=>{if(!c.signal.aborted&&!this.closed){this.retry.fail(id,e);this.report(e);}})
                .finally(()=>{if(this.active.get(id)===c)this.active.delete(id);this.pump();});
        }
    }
    close(){this.closed=true;for(const c of this.active.values())c.abort();this.active.clear();this.wanted.clear();this.records.clear();}
}
