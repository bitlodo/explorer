import {mapWorker} from '../workerUrls';
import type {MapDataSource} from './MapDataSource';
import type {PatternEntry,PatternGroup,PatternFilter,PatternPreview} from '../shared/patterns';
type Catalog={entries:PatternEntry[];groups:PatternGroup[];values:Float32Array};
type PreviewJob={id:number;signal:AbortSignal;resolve:(value:PatternPreview)=>void;reject:(error:unknown)=>void};
/** Explicit mode loads its exact catalog once; previews have two consumers and a bounded cache. */
export default class PatternsClient{
    private worker=mapWorker('patternWorker');
    private serial=0;
    private pending=new Map<number,{resolve:(value:unknown)=>void;reject:(error:Error)=>void}>();
    private abort=new AbortController();
    private catalog?:Catalog;
    private previews=new Map<number,PatternPreview>();
    private queue:PreviewJob[]=[];
    private active=0;
    private closed=false;
    constructor(private source:MapDataSource){
        this.worker.onmessage=event=>{const {id,value,error}=event.data,job=this.pending.get(id);this.pending.delete(id);if(error)job?.reject(Error(error));else job?.resolve(value);};
        this.worker.onerror=()=>this.close();this.worker.onmessageerror=()=>this.close();
    }
    private request<T>(message:object,transfer:Transferable[]=[]):Promise<T>{
        if(this.closed)return Promise.reject(new DOMException('Patterns mode closed','AbortError'));
        return new Promise((resolve,reject)=>{const id=++this.serial;this.pending.set(id,{resolve:value=>resolve(value as T),reject});this.worker.postMessage({...message,id},transfer);});
    }
    async init():Promise<Catalog>{
        const inputs=await this.source.getPatternInputs!(this.abort.signal);this.abort.signal.throwIfAborted();
        const patternBytes=inputs.patternBytes.slice(),countBytes=inputs.countBytes.slice();
        this.catalog=await this.request<Catalog>({kind:'init',inputs:{...inputs,patternBytes,countBytes}},[patternBytes.buffer,countBytes.buffer]);return this.catalog;
    }
    page(transactions:number|undefined,offset:number,limit=12){
        const entries=this.catalog?.entries.filter(e=>transactions===undefined||e.transactions===transactions)??[];
        return {entries:entries.slice(offset,offset+Math.min(24,Math.max(1,limit))),total:entries.length};
    }
    filter(transactions?:number,pattern?:number){return this.request<PatternFilter>({kind:'filter',transactions,pattern});}
    preview(id:number,signal:AbortSignal):Promise<PatternPreview>{
        signal.throwIfAborted();const cached=this.previews.get(id);
        if(cached){this.previews.delete(id);this.previews.set(id,cached);return Promise.resolve(cached);}
        if(!this.catalog?.entries.some(e=>e.id===id))return Promise.reject(Error('Unknown repeated pattern'));
        return new Promise((resolve,reject)=>{const job={id,signal:AbortSignal.any([signal,this.abort.signal]),resolve,reject};this.queue.push(job);void this.pump();});
    }
    private async pump(){
        if(this.closed||this.active>=2)return;
        const job=this.queue.shift();if(!job)return;
        if(job.signal.aborted){job.reject(job.signal.reason);void this.pump();return;}
        this.active++;void this.pump();
        try{
            let preview:PatternPreview|undefined;
            for await(const record of this.source.streamParcels(Math.floor(job.id/2016),[job.id],job.signal)){
                job.signal.throwIfAborted();preview=await this.request<PatternPreview>({kind:'preview',record});break;
            }
            job.signal.throwIfAborted();if(!preview)throw Error('Pattern preview unavailable');
            this.previews.set(job.id,preview);while(this.previews.size>64||[...this.previews.values()].reduce((n,p)=>n+p.rects.byteLength,0)>4*1024*1024)this.previews.delete(this.previews.keys().next().value!);
            job.resolve(preview);
        }catch(error){job.reject(error);}finally{this.active--;void this.pump();}
    }
    close(){if(this.closed)return;this.closed=true;this.abort.abort();this.worker.terminate();for(const p of this.pending.values())p.reject(new DOMException('Patterns mode closed','AbortError'));this.pending.clear();for(const job of this.queue)job.reject(this.abort.signal.reason);this.queue=[];this.catalog=undefined;this.previews.clear();}
}
