import test from 'node:test';
import assert from 'node:assert/strict';
import {loadShared} from './helpers/load-shared.ts';
import {fixture,codec} from './protobuf-fixture.mjs';
const {default:Source}=await loadShared('../../src/data/StaticHttpDataSource.ts');
const collect=async stream=>{const a=[];for await(const r of stream)a.push(r);return a;};

for(const format of ['v4','v5']) test(`${format} directly resolves manifest/geometry/pack, respects top-left ownership across a border and reuses frames`,async()=>{
    const {files,manifest}=await fixture(format),requests=[],events=[];
    const oldFetch=globalThis.fetch,oldLocation=globalThis.location;
    globalThis.location={href:'https://example.org/repository/'};
    globalThis.fetch=async(url)=>{const name=new URL(url).pathname.split('/').pop();requests.push(name);return files.has(name)?new Response(files.get(name)):new Response('',{status:404});};
    const source=new Source('map-data/');source.onChunkPackLoaded=c=>events.push(c);
    try{
        assert.equal((await source.getManifest()).snapshot,manifest.snapshot);assert.deepEqual(requests,['manifest.pb']);
        const jobs=await source.getParcelJobs([1008]);assert.equal(jobs.length,1);assert.equal(jobs[0].pack.chunkX,-1,'origin=-0.5 stays in the negative chunk despite crossing into x=0');
        assert.equal(requests.length,2,'one geometry request, no intermediate descriptors');
        const values=await collect(source.streamParcels(0,[1008],new AbortController().signal));assert.deepEqual(values.map(r=>r.id),[1008]);
        assert.equal(requests.length,3);assert.deepEqual(events,[{x:-1,y:-1,size:1024}]);
        assert.equal(source.cache.namespace,`http-pack-cache-${format}`);
        await collect(source.streamParcels(0,[0,1008],new AbortController().signal));assert.equal(requests.length,3,'warm pack is streamed without a GET');
        assert.equal((await source.getParcelJobs([1009]))[0].pack.chunkX,0);
        assert.ok(requests.every(p=>p.endsWith('.pb')));
    }finally{source.close();globalThis.fetch=oldFetch;globalThis.location=oldLocation;}
});
for(const format of ['v4','v5']) test(`${format} cancellation retains only verified frames and bootstrap rejects corruption without changing snapshots`,async()=>{
    const {files,manifest}=await fixture(format),pack=manifest.chunks[0].packs[0];
    const oldFetch=globalThis.fetch,oldLocation=globalThis.location;globalThis.location={href:'https://example.org/repository/'};
    globalThis.fetch=async url=>new Response(files.get(new URL(url).pathname.split('/').pop()));
    const source=new Source('map-data/');let events=0;source.onChunkPackLoaded=()=>events++;
    try{
        const abort=new AbortController(),stream=source.streamParcels(0,[0,1008],abort.signal);
        assert.equal((await stream.next()).value.id,0);abort.abort();await assert.rejects(()=>stream.next(),e=>e.name==='AbortError');
        assert.ok(await source.cache.get(pack.headSha256 || pack.frames[0].sha256));assert.equal(events,0,'cancelled pack is not reported complete');
        assert.deepEqual((await collect(source.streamParcels(0,[0,1008],new AbortController().signal))).map(r=>r.id),[0,1008]);
        if(format==='v5') assert.ok(source.stats.cacheBytes>0,'resume uses the verified prefix');
        const bad=files.get('manifest.pb').slice();bad[bad.length-1]^=1;
        await assert.rejects(()=>codec.decodeManifest(bad),/revision/);
        assert.equal((await source.getManifest()).snapshot,manifest.snapshot);
    }finally{source.close();globalThis.fetch=oldFetch;globalThis.location=oldLocation;}
});


test('closing while the protobuf manifest is verified does not reopen metadata/cache after teardown',async()=>{
    const {files}=await fixture(),oldLocation=globalThis.location;globalThis.location={href:'https://example.org/repository/'};
    const source=new Source('map-data/');source.small=async()=>files.get('manifest.pb');
    try{
        const pending=source.getManifest();await Promise.resolve();source.close();
        await assert.rejects(()=>pending,e=>e.name==='AbortError');
        assert.equal(source.protoChunks.size,0);assert.equal(source.cache.closed,true);
    }finally{source.close();globalThis.location=oldLocation;}
});

test('completed v6 pack is cached as a file and warm streaming needs one cache lookup, not one per bitmap',async()=>{
    const {files}=await fixture('v6'),oldFetch=globalThis.fetch,oldLocation=globalThis.location,requests=[];
    globalThis.location={href:'https://example.org/'};globalThis.fetch=async url=>{const name=new URL(url).pathname.split('/').pop();requests.push(name);return new Response(files.get(name));};
    const source=new Source('map-data/');
    try{
        const [job]=await source.getParcelJobs([0]),first=await collect(source.streamParcelJob(job,new AbortController().signal));
        assert.ok(await source.cache.get(job.pack.sha256));
        let gets=0;const get=source.cache.get.bind(source.cache);source.cache.get=hash=>{gets++;return get(hash);};const before=requests.length;
        const second=await collect(source.streamParcelJob(job,new AbortController().signal));assert.deepEqual(second,first);
        assert.equal(gets,1);assert.equal(requests.length,before);
    }finally{source.close();globalThis.fetch=oldFetch;globalThis.location=oldLocation;}
});

test('legacy frame-only cache remains readable offline without serial disk probes on the online path',async()=>{
    const {files}=await fixture('v6'),oldFetch=globalThis.fetch,oldLocation=globalThis.location;
    globalThis.location={href:'https://example.org/'};globalThis.fetch=async url=>new Response(files.get(new URL(url).pathname.split('/').pop()));
    const source=new Source('map-data/');
    try{
        const [job]=await source.getParcelJobs([0]),frames=[];
        async function* bytes(){yield files.get(job.pack.url);}
        const expected=await collect(codec.parsePack(bytes(),job.pack,(hash,bytes)=>{frames.push({hash,bytes});}));
        await source.cache.putMany(frames);source.cache.peek=()=>undefined;
        const before=source.stats.networkBytes;globalThis.fetch=async()=>{throw new TypeError('Offline test');};
        const actual=await collect(source.streamParcelJob(job,new AbortController().signal));
        assert.deepEqual(actual,expected);assert.equal(source.stats.networkBytes,before);
    }finally{source.close();globalThis.fetch=oldFetch;globalThis.location=oldLocation;}
});

test('resume rejects a changed duplicate network prefix without persisting unauthenticated bytes',async()=>{
    const {files}=await fixture('v6'),oldFetch=globalThis.fetch,oldLocation=globalThis.location;
    globalThis.location={href:'https://example.org/'};globalThis.fetch=async url=>new Response(files.get(new URL(url).pathname.split('/').pop()));
    const source=new Source('map-data/');
    try{
        const [job]=await source.getParcelJobs([0]),abort=new AbortController(),stream=source.streamParcelJob(job,abort.signal);
        await stream.next();abort.abort();await assert.rejects(()=>stream.next(),e=>e.name==='AbortError');
        const key=job.pack.sha256+':prefix-v1',prefix=(await source.cache.get(key)).slice(),bad=files.get(job.pack.url).slice();bad[0]^=1;
        globalThis.fetch=async()=>new Response(bad);
        await assert.rejects(()=>collect(source.streamParcelJob(job,new AbortController().signal)),/prefix mismatch/);
        assert.deepEqual(await source.cache.get(key),prefix);
    }finally{source.close();globalThis.fetch=oldFetch;globalThis.location=oldLocation;}
});
