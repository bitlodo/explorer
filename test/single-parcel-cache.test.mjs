import test from 'node:test';
import assert from 'node:assert/strict';
import {loadShared} from './helpers/load-shared.ts';
import {fixture} from './protobuf-fixture.mjs';
const {default:Cache}=await loadShared('../../src/data/SingleParcelCache.ts');
const {default:Source}=await loadShared('../../src/data/StaticHttpDataSource.ts');
const collect=async stream=>{const a=[];for await(const r of stream)a.push(r);return a;};
test('single-tx proof cache is bounded, uses exact IDs and releases pages',()=>{
    const c=new Cache(2);c.set(1,15);c.set(65536,2);assert.equal(c.get(1),15);c.set(131072,1);
    assert.equal(c.get(65536),0);assert.equal(c.get(1),15);assert.equal(c.get(131072),1);assert.equal(c.bytes,131072);c.clear();assert.equal(c.bytes,0);
});
test('return to validated one-tx records needs no pack scan and preserves identity/cancellation',async()=>{
    const {files}=await fixture('v6'),oldFetch=globalThis.fetch,oldLocation=globalThis.location,requests=[];
    globalThis.location={href:'https://example.org/'};globalThis.fetch=async url=>{const name=new URL(url).pathname.split('/').pop();requests.push(name);return new Response(files.get(name));};
    const s=new Source('map-data/');
    try{
        const first=await collect(s.streamParcels(0,[0,2],new AbortController().signal));assert.deepEqual(first.map(r=>r.id).sort((a,b)=>a-b),[0,2]);
        const frames=s.stats.framesValidated,before=requests.length,hit=await collect(s.streamParcels(0,[2,0],new AbortController().signal));
        assert.deepEqual(hit.map(r=>r.id),[2,0]);assert.ok(hit.every(r=>r.txCount===1&&r.tx[0]===0x10));assert.equal(s.stats.framesValidated,frames);assert.equal(requests.length,before);
        const mixed=await collect(s.streamParcels(0,[0,1,2],new AbortController().signal));assert.deepEqual(mixed.map(r=>r.id).sort((a,b)=>a-b),[0,1,2]);
        const abort=new AbortController(),stream=s.streamParcels(0,[0,1],abort.signal);await stream.next();abort.abort();await assert.rejects(()=>stream.next(),e=>e.name==='AbortError');
        assert.ok(s.singleParcels.bytes<=1024*1024);s.close();assert.equal(s.singleParcels.bytes,0);
    }finally{s.close();globalThis.fetch=oldFetch;globalThis.location=oldLocation;}
});

test('small-record cache keeps authenticated payloads independent from transferred worker buffers',async()=>{
    const {default:Small}=await loadShared('../../src/data/SmallRecordCache.ts');const c=new Small();
    const input={id:170,txCount:2,rle:false,tx:new Uint8Array([0x53])};c.set(input);input.tx[0]=0;
    assert.equal(c.get(170).tx[0],0x53);
    for(let i=0;i<5000;i++)c.set({id:i,txCount:2,rle:false,tx:new Uint8Array([0x11])});
    assert.ok(c.bytes<=4*1024*1024);assert.equal(c.get(0),undefined);c.clear();assert.equal(c.bytes,0);
});
