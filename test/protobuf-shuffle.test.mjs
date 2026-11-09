import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {loadShared} from './helpers/load-shared.ts';
import {fixture,codec} from './protobuf-fixture.mjs';
const require=createRequire(new URL('../package.json',import.meta.url)),protobuf=require('protobufjs');
const {encodeSizes,decodeSizes,SHUFFLE_FORMAT,sha256}=await loadShared('../../src/shared/httpPack.ts');
const {chunkShuffleOrder}=await loadShared('../../src/shared/chunkShuffle.ts');
const {default:Source}=await loadShared('../../src/data/StaticHttpDataSource.ts');
const collect=async stream=>{const result=[];for await(const r of stream)result.push(r);return result;};

test('chunk shuffle is reproducible, bijective, dispersed across the whole chunk and sensitive to seed/coordinates',()=>{
    const order=chunkShuffleOrder(4096,20261023,-1,2);
    assert.deepEqual(order,chunkShuffleOrder(4096,20261023,-1,2));
    assert.equal(new Set(order).size,4096);assert.equal(Math.min(...order),0);assert.equal(Math.max(...order),4095);
    assert.notDeepEqual(order,chunkShuffleOrder(4096,20261024,-1,2));assert.notDeepEqual(order,chunkShuffleOrder(4096,20261023,0,2));
    assert.equal(new Set([...order.slice(0,64)].map(n=>Math.floor(n/512))).size,8);
    assert.deepEqual([...chunkShuffleOrder(0,0,0,0)],[]);assert.deepEqual([...chunkShuffleOrder(1,0,0,0)],[0]);
});

test('v6 preserves arbitrary record order, IDs and tx order across every network cut',async()=>{
    const input=[encodeSizes(2016,[9,1,15]),encodeSizes(0,[]),encodeSizes(900000,[3]),encodeSizes(2,[1,10])];
    const {wire,descriptor}=await codec.buildChainedPack(input,-1,0,13,6);
    assert.equal(descriptor.format,SHUFFLE_FORMAT);assert.deepEqual(descriptor.ids,[0,2,2016,900000]);
    for(let cut=0;cut<=wire.length;cut++){async function* stream(){yield wire.slice(0,cut);yield wire.slice(cut);}const actual=await collect(codec.parsePack(stream(),descriptor));assert.deepEqual(actual,input);assert.deepEqual(actual.map(decodeSizes),input.map(decodeSizes));}
    await assert.rejects(()=>codec.buildChainedPack([input[0],input[0]],0,0,13,6),/Duplicate/);
});

test('v6 releases the first out-of-order bitmap before EOF for tiny files and fragmented records',async()=>{
    for(const n of [1,50000]){
        const input=[encodeSizes(99,[1]),encodeSizes(0,Array.from({length:n},(_,i)=>i%15+1))];
        const {wire,descriptor}=await codec.buildChainedPack(input,0,0,1024,6),reader=protobuf.Reader.create(wire),frames=[];
        while(reader.pos<wire.length){const start=reader.pos,n=reader.uint32();reader.pos+=n;frames.push(wire.slice(start,reader.pos));}
        let release,ended=false;const gate=new Promise(r=>release=r);
        async function* slow(){yield frames[0];yield frames[1];await gate;for(const f of frames.slice(2))yield f;ended=true;}
        const stream=codec.parsePack(slow(),descriptor);assert.equal((await stream.next()).value.id,99);assert.equal(ended,false);
        release();assert.equal((await stream.next()).value.id,0);assert.equal((await stream.next()).done,true);
        const changed=wire.slice();changed[changed.length-1]^=1;async function* bad(){yield changed;}
        await assert.rejects(()=>collect(codec.parsePack(bad(),descriptor)),/Corrupt/);
    }
});

test('v6 direct index distinguishes overlapping pack ranges, streams in wire order and reuses authenticated cache',async()=>{
    const {files,manifest}=await fixture('v6'),requests=[],oldFetch=globalThis.fetch,oldLocation=globalThis.location;
    globalThis.location={href:'https://example.org/repository/'};globalThis.fetch=async url=>{const name=new URL(url).pathname.split('/').pop();requests.push(name);return new Response(files.get(name));};
    const source=new Source('map-data/');
    try{
        const jobs=await source.getParcelJobs([0,1,2,3,1008]);assert.equal(jobs.length,2);assert.notEqual(jobs[0].pack.sha256,jobs[1].pack.sha256);
        assert.deepEqual(jobs[0].ids,[0,2,1008]);assert.deepEqual(jobs[1].ids,[1,3]);
        assert.equal(jobs[0].contains(1),false);assert.equal(jobs[0].contains(1008),true);
        const all=await collect(source.streamParcelJob(jobs[0],new AbortController().signal));
        assert.deepEqual(all.map(r=>r.id),manifest.chunks[0].packs[0].ids.slice().reverse());
        const before=requests.length;await collect(source.streamParcelJob(jobs[0],new AbortController().signal));assert.equal(requests.length,before);
        assert.equal(source.cache.namespace,'http-pack-cache-v6');
        const abort=new AbortController(),stream=source.streamParcelJob(jobs[1],abort.signal);await stream.next();abort.abort();await assert.rejects(()=>stream.next(),e=>e.name==='AbortError');
        assert.deepEqual((await collect(source.streamParcelJob(jobs[1],new AbortController().signal))).map(r=>r.id),manifest.chunks[0].packs[1].ids.slice().reverse());
    }finally{source.close();globalThis.fetch=oldFetch;globalThis.location=oldLocation;}
});

test('v6 membership rejects duplicate/missing IDs across overlapping packs before accepting a manifest',async()=>{
    const {manifest}=await fixture('v6'),c=manifest.chunks[0];
    c.packs[1].ids[0]=c.packs[0].ids[0];c.packs[1].first=c.packs[1].ids[0];
    manifest.snapshot=await sha256(codec.encodeManifest(manifest,false));
    await assert.rejects(()=>codec.decodeManifest(codec.encodeManifest(manifest)),/Duplicate shuffled/);
});

test('chain verification offers rendering checkpoints without changing authenticated records',async()=>{
    const input=Array.from({length:300},(_,id)=>encodeSizes(id,[1]));
    const {wire,descriptor}=await codec.buildChainedPack(input,0,0,1024,6);let yields=0;
    async function* bytes(){yield wire;}
    const actual=await collect(codec.parsePack(bytes(),descriptor,undefined,async()=>{yields++;}));
    assert.deepEqual(actual,input);assert.equal(yields,Math.floor((descriptor.frameCount-1)/128));
});

test('record filtering skips async delivery while retaining authentication and complete coverage checks',async()=>{
    const input=Array.from({length:300},(_,id)=>encodeSizes(id,[id%15+1]));
    const {wire,descriptor}=await codec.buildChainedPack(input,0,0,1024,6);
    async function* bytes(){yield wire;}
    const visited=[],frames=[];
    const actual=await collect(codec.parsePack(bytes(),descriptor,hash=>{frames.push(hash);},undefined,record=>{visited.push(record.id);return record.id===150;}));
    assert.deepEqual(actual,[input[150]]);assert.equal(visited.length,300);assert.equal(frames.length,descriptor.frameCount);
    const bad=wire.slice();bad[bad.length-1]^=1;async function* corrupt(){yield bad;}
    await assert.rejects(()=>collect(codec.parsePack(corrupt(),descriptor,undefined,undefined,()=>false)),/Corrupt/);
    await assert.rejects(()=>collect(codec.parsePack(bytes(),{...descriptor,parcels:descriptor.parcels+1},undefined,undefined,()=>false)),/coverage/);
});
