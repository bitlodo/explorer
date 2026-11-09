import test from 'node:test';
import assert from 'node:assert/strict';
import { loadShared } from './helpers/load-shared.ts';
const { default: Scheduler }=await loadShared('../../src/data/ParcelScheduler.ts');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(condition) {for(let i=0;i<500;i++){if(condition())return;await sleep(2);}throw Error('Scheduler condition timed out');}
const rec=id=>({id,txCount:1,rle:false,tx:new Uint8Array([0x10])});
test('dedup, persistent priorities, batches, concurrency and backpressure',async()=>{
    const resident=new Set(), errors=[];let streams=0,active=0,maxActive=0,consumes=0,maxConsume=0,gate;
    const pause=new Promise(r=>gate=r);
    const source={async *streamParcels(_n,ids,signal){streams++;active++;maxActive=Math.max(maxActive,active);try{for(const id of ids){signal.throwIfAborted();yield rec(id);}}finally{active--;}}};
    const batches=[];
    const scheduler=new Scheduler(source,id=>resident.has(id),async batch=>{consumes++;maxConsume=Math.max(maxConsume,consumes);batches.push(batch.map(r=>r.id));await pause;batch.forEach(r=>resident.add(r.id));consumes--;},e=>errors.push(e));
    const ids=Array.from({length:1800},(_,i)=>i);
    scheduler.setDesired(ids);scheduler.setDesired(ids);scheduler.setDesired(ids);
    await until(()=>batches.length>0);
    assert.equal(streams,1);assert.equal(batches[0].length,1024);assert.equal(resident.size,0);
    gate();await until(()=>resident.size===1800&&scheduler.active.size===0);
    assert.equal(streams,1);assert.equal(maxActive,1);assert.equal(maxConsume,1);assert.deepEqual(errors,[]);
    assert.deepEqual(batches.flat(),ids);scheduler.close();
});
test('flush before delayed next record, cancel obsolete streams and reject stale rendering',async()=>{
    const resident=new Set(), rendered=[],errors=[];let release;
    const gate=new Promise(r=>release=r);
    const source={async *streamParcels(_n,ids,signal){yield rec(ids[0]);await new Promise((resolve,reject)=>{gate.then(resolve);signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});for(const id of ids.slice(1))yield rec(id);}};
    const scheduler=new Scheduler(source,id=>resident.has(id),async batch=>{for(const r of batch)if(scheduler.wants(r.id)){rendered.push(r.id);resident.add(r.id);}},e=>errors.push(e));
    scheduler.setDesired([0,1]);await until(()=>resident.has(0));assert.deepEqual(rendered,[0]);
    scheduler.setDesired([2016]);release();await until(()=>resident.has(2016));
    assert.ok(!rendered.includes(1));assert.deepEqual(errors,[]);scheduler.close();await until(()=>scheduler.active.size===0);
});
test('close prevents retries after failure and never exceeds two concurrent regions',async()=>{
    let active=0,max=0;const failures=[];
    const source={async *streamParcels(_n,_ids,signal){active++;max=Math.max(max,active);try{await sleep(5);signal.throwIfAborted();throw Error('test network failure');}finally{active--;}}};
    const scheduler=new Scheduler(source,()=>false,async()=>{},e=>failures.push(e));
    scheduler.setDesired([0,2016,4032]);await until(()=>failures.length===3);assert.ok(max<=2);scheduler.close();assert.equal(active,0);
});

test('larger record batches remain bounded by parcel work and preserve indivisible bitmaps',async()=>{
    const resident=new Set(),batches=[],errors=[];
    const input=Array.from({length:90},(_,id)=>({...rec(id),txCount:id===45?40000:1000}));
    const source={async *streamParcels(){yield* input;}};
    const scheduler=new Scheduler(source,id=>resident.has(id),async records=>{batches.push(records);records.forEach(r=>resident.add(r.id));},e=>errors.push(e));
    try {
        scheduler.setDesired(input.map(r=>r.id));await until(()=>resident.size===input.length&&scheduler.active.size===0);
        assert.deepEqual(batches.flat().map(r=>r.id),input.map(r=>r.id));
        for(const batch of batches) {
            const parcels=batch.reduce((sum,r)=>sum+r.txCount,0);
            assert.ok(parcels<=32768 || batch.length===1 && batch[0].txCount>32768);
        }
        assert.equal(batches.find(batch=>batch.some(r=>r.id===45)).length,1);
        assert.deepEqual(errors,[]);
    }finally{scheduler.close();}
});

test('direct protobuf jobs cancel another spatial chunk even when height intervals overlap',async()=>{
    const resident=new Set(),errors=[];let aborted=false;
    const source={
        async getParcelJobs(ids){return ids.map(id=>({key:String(id%2),first:0,last:100,ids:[id],contains:bitmap=>bitmap%2===id%2}));},
        async *streamParcelJob(job,signal){yield rec(job.ids[0]);if(job.key==='0')await new Promise((_,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(signal.reason);},{once:true}));}
    };
    const scheduler=new Scheduler(source,id=>resident.has(id),async batch=>batch.forEach(r=>resident.add(r.id)),e=>errors.push(e));
    try{scheduler.setDesired([0]);await until(()=>resident.has(0));scheduler.setDesired([1]);await until(()=>resident.has(1)&&scheduler.active.size===0);assert.equal(aborted,true);assert.deepEqual(errors,[]);}
    finally{scheduler.close();}
});

test('remaining IDs are resolved again after a pack, using newly validated cache instead of replaying the file',async()=>{
    const resident=new Set(),errors=[];let cached=false,packRuns=0,cacheRuns=0;
    const source={
        async getParcelJobs(ids){return [{key:cached?'cache':'pack',first:0,last:1,ids}]},
        async *streamParcelJob(job){if(job.key==='pack'){packRuns++;yield rec(0);cached=true;}else{cacheRuns++;for(const id of job.ids)yield rec(id);}},
    };
    const scheduler=new Scheduler(source,id=>resident.has(id),async batch=>{for(const r of batch)resident.add(r.id);},e=>errors.push(e));
    scheduler.setDesired([0,1]);await until(()=>resident.has(1));assert.equal(packRuns,1);assert.equal(cacheRuns,1);assert.deepEqual(errors,[]);scheduler.close();
});
