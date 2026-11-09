import { test, expect } from 'bun:test';
import RequestCoordinator,{SharedRequests} from '../src/data/RequestCoordinator';
import RetryPolicy,{DownloadError} from '../src/data/RetryPolicy';
import StaticHttpDataSource from '../src/data/StaticHttpDataSource';
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
test('shared transport bounds concurrency, prioritizes prerequisites and removes cancelled queued consumers',async()=>{
    const queue=new RequestCoordinator(1),signal=new AbortController(),release=await queue.acquire(signal.signal),order:string[]=[];
    const low=queue.acquire(signal.signal,0).then(done=>{order.push('local');done();});
    const stale=new AbortController(),cancelled=queue.acquire(stale.signal,10);stale.abort();await expect(cancelled).rejects.toBeDefined();
    const high=queue.acquire(signal.signal,2).then(done=>{order.push('index');done();});
    release();release();await Promise.all([low,high]);expect(order).toEqual(['index','local']);
});
test('shared payload keeps a current consumer alive and cancels admission after the final consumer leaves',async()=>{
    const shared=new SharedRequests<number>(),a=new AbortController(),b=new AbortController();let workSignal:AbortSignal|undefined,resolve!:(value:number)=>void,calls=0;
    const work=(signal:AbortSignal)=>{calls++;workSignal=signal;return new Promise<number>(yes=>{resolve=yes;});};
    const first=shared.run('same',a.signal,work),second=shared.run('same',b.signal,work);await tick();a.abort();await expect(first).rejects.toBeDefined();expect(workSignal!.aborted).toBe(false);resolve(7);expect(await second).toBe(7);expect(calls).toBe(1);
    const stale=new AbortController(),never=shared.run('queued',stale.signal,async()=>{calls++;return 2;});stale.abort();await expect(never).rejects.toBeDefined();await tick();expect(calls).toBe(1);
});
test('transient failures recover on bounded backoff; absence and corruption remain explicit',()=>{
    let now=0;const retry=new RetryPolicy(()=>now);retry.fail('chunk',new DownloadError('busy',429,5000));expect(retry.ready('chunk')).toBe(false);now=5000;expect(retry.ready('chunk')).toBe(true);retry.success('chunk');expect(retry.ready('chunk')).toBe(true);
    retry.fail('missing',new DownloadError('absent',404));retry.fail('corrupt',new DownloadError('hash',undefined,0,true));now=1e9;expect(retry.ready('missing')).toBe(false);expect(retry.ready('corrupt')).toBe(false);
    for(let i=0;i<4;i++)retry.fail('transport',Error('offline'));now+=60000;expect(retry.ready('transport')).toBe(true);
});
test('body counters include a prefix before a cancelled small download',async()=>{
    const previousFetch=globalThis.fetch,location=Object.getOwnPropertyDescriptor(globalThis,'location');Object.defineProperty(globalThis,'location',{value:{href:'https://map.test/'},configurable:true});
    let streamController!:ReadableStreamDefaultController<Uint8Array>;
    globalThis.fetch=(async()=>new Response(new ReadableStream({start(c){streamController=c;c.enqueue(Uint8Array.of(1,2,3));}}))) as unknown as typeof fetch;
    const source=new StaticHttpDataSource('https://map.test/');
    try{
        const pending=(source as unknown as {small:(path:string,limit:number,signal:AbortSignal)=>Promise<Uint8Array>}).small('metadata',100,new AbortController().signal);
        await tick();expect(source.stats.networkBytes).toBe(3);streamController.error(new DOMException('cancelled','AbortError'));await expect(pending).rejects.toBeDefined();expect(source.stats.networkBytes).toBe(3);
    }finally{source.close();globalThis.fetch=previousFetch;if(location)Object.defineProperty(globalThis,'location',location);else Reflect.deleteProperty(globalThis,'location');}
});

test('parcel analysis transfers a private buffer and preserves authenticated cache bytes for re-entry',async()=>{
    const {default:ParcelAnalysisClient}=await import('../src/data/ParcelAnalysisClient');
    const previous=globalThis.Worker,bytes=Uint8Array.of(1,2,3);let transferred=0;
    class FakeWorker{
        onmessage?: (event:{data:{result:object}})=>void;
        postMessage(message:unknown,transfer:Transferable[]){structuredClone(message,{transfer});transferred++;queueMicrotask(()=>this.onmessage?.({data:{result:{pixels:new Float32Array(2),occupiedAreas:Float32Array.of(1)}}}));}
        terminate(){}
    }
    globalThis.Worker=FakeWorker as unknown as typeof Worker;
    try{
        for(let i=0;i<2;i++){
            const client=new ParcelAnalysisClient(1,async()=>bytes);await client.filter(1,9);client.close();expect([...bytes]).toEqual([1,2,3]);
        }
        expect(transferred).toBe(2);
    }finally{globalThis.Worker=previous;}
});
