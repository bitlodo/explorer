import { mapWorker } from '../workerUrls';
import type { ParcelFilterResult } from '../shared/layerAnalysis';
type Job={low:number;high:number;resolve:(value:ParcelFilterResult|undefined)=>void;reject:(error:Error)=>void};
/** One active calculation and one replaceable pending range, without a drag backlog. */
export default class ParcelAnalysisClient {
    private worker?:Worker;
    private current?:Job;
    private pending?:Job;
    private serial=0;
    private closed=false;
    private abort=new AbortController();
    private occupiedAreas?:Float32Array;
    constructor(private count:number,private load:(signal:AbortSignal)=>Promise<Uint8Array>){}
    filter(low:number,high:number):Promise<ParcelFilterResult|undefined>{
        if(this.closed)return Promise.reject(Error('Parcel analysis is closed'));
        return new Promise((resolve,reject)=>{
            this.pending?.resolve(undefined);this.pending={low,high,resolve,reject};void this.pump();
        });
    }
    private async pump(){
        if(this.closed||this.current||!this.pending)return;
        const job=this.current=this.pending;this.pending=undefined;
        try{
            let bytes:Uint8Array|undefined;
            if(!this.worker){
                const cached=await this.load(this.abort.signal);if(this.closed||this.abort.signal.aborted)return;
                bytes=new Uint8Array(cached);
                this.worker=mapWorker('parcelAnalysisWorker');
                this.worker.onmessage=event=>{
                    const current=this.current;this.current=undefined;
                    if(event.data.error)current?.reject(Error(event.data.error));else{const result=event.data.result as ParcelFilterResult;if(result.occupiedAreas)this.occupiedAreas=result.occupiedAreas;result.occupiedAreas=this.occupiedAreas;current?.resolve(result);}
                    void this.pump();
                };
                this.worker.onerror=()=>this.fail(Error('Parcel analysis worker failed'));
                this.worker.onmessageerror=()=>this.fail(Error('Invalid parcel analysis worker response'));
            }
            this.worker.postMessage({id:++this.serial,count:this.count,bytes,low:job.low,high:job.high},bytes?[bytes.buffer as ArrayBuffer]:[]);
        }catch(error){this.current=undefined;job.reject(error instanceof Error?error:Error(String(error)));void this.pump();}
    }
    private fail(error:Error){this.current?.reject(error);this.pending?.reject(error);this.current=this.pending=undefined;this.worker?.terminate();this.worker=undefined;}
    close(){this.abort.abort();this.occupiedAreas=undefined;this.closed=true;this.fail(Error('Parcel analysis is closed'));}
}
