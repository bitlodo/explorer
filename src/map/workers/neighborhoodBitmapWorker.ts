import { decodeParcelSizes, type ParcelRecord } from '@shared/httpPack';

type ParcelBatch = { protocol: 'parcel-worker-batch-v1'; batchId: number; records: ParcelRecord[] };
type ParcelLayoutResult = { id: number; rects: Float64Array; width: number; height: number } | { id: number; error: string } | { id:number;cancelled:true };
export type ParcelWorkerResponse = { protocol: 'parcel-worker-batch-v1'; batchId: number; results: ParcelLayoutResult[] };

// Official parcel worker: await initialization and return only the placed slots.
const ready = import('@shared/MondrianLayout.ts');
const LAYOUT_SLICE_MS=4,LAYOUT_SLICE_RECORDS=64;

let desired:Set<number>|undefined;
let queue=Promise.resolve();
self.onmessage = (event: MessageEvent<ParcelBatch|{protocol:'parcel-worker-wishes-v1';ids:number[]}>) => {
    const message=event.data;
    if(message.protocol==='parcel-worker-wishes-v1'){desired=new Set(message.ids);return;}
    queue=queue.then(async()=>{
        const { batchId, records } = message;
        const { default: MondrianLayout } = await ready;
        const transfers:ArrayBuffer[]=[],results:ParcelLayoutResult[]=[];
        let sliceStarted=performance.now(),sliceRecords=0;
        for(const record of records){
            // Process wishes between bounded slices, rather than paying the
            // browser's nested-timer delay for every cheap bitmap layout.
            if(sliceRecords>=LAYOUT_SLICE_RECORDS||performance.now()-sliceStarted>=LAYOUT_SLICE_MS){
                await new Promise(resolve=>setTimeout(resolve,0));
                sliceStarted=performance.now();sliceRecords=0;
            }
            sliceRecords++;
            if(desired&&!desired.has(record.id)){results.push({id:record.id,cancelled:true});continue;}
            try{
                const layout=new MondrianLayout(decodeParcelSizes(record)),rects=new Float64Array(layout.slots.length*4);
                let width=0,height=0;
                layout.slots.forEach((slot,i)=>{rects.set([slot.x,slot.y,slot.width,slot.height],i*4);width=Math.max(width,slot.x+slot.width);height=Math.max(height,slot.y+slot.height);});
                transfers.push(rects.buffer);results.push({id:record.id,rects,width,height});
            }catch(error){results.push({id:record.id,error:error instanceof Error?error.message:String(error)});}
        }
        self.postMessage({protocol:'parcel-worker-batch-v1',batchId,results},{transfer:transfers});
    });
    return queue;
};
