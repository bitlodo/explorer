import test from 'node:test';
import assert from 'node:assert/strict';
import { loadShared } from './helpers/load-shared.ts';
import { fixture } from './spatial-index-fixture.mjs';
import { codec, FakeWorker } from './neighborhood-dimensions-fixture.mjs';
const { default: Source } = await loadShared('../../src/data/StaticHttpDataSource.ts');
const { default: Client } = await loadShared('../../src/data/NeighborhoodLayoutClient.ts');

test('v8 root and spatial pages preserve each v6 chunk/pack/membership using the active codec',async()=>{
    const {manifest,original,files}=await fixture(),root=await codec.decodeManifest(files.get('manifest.pb'));
    assert.equal(root.chunks.length,0);assert.equal(root.indexPages.length,4);
    const chunks=root.indexPages.flatMap(ref=>codec.decodeIndexPage(files.get(ref.url),ref,root));
    const sorted=a=>a.slice().sort((a,b)=>a.y-b.y||a.x-b.x);
    assert.deepEqual(sorted(chunks),sorted(original.chunks));
    assert.throws(()=>codec.decodeIndexPage(files.get(root.indexPages[0].url),{...root.indexPages[0],x:99},root),/identity/);
    manifest.indexPages.pop();await assert.rejects(()=>codec.decodeManifest(codec.encodeManifest(manifest)),/coverage/);
});

test('overview and neighborhood geometry need no pack index; parcel owners fetch only their spatial page and reuse it',async()=>{
    const {manifest,files}=await fixture(),requests=[],oldFetch=globalThis.fetch,oldLocation=globalThis.location;
    globalThis.location={href:'https://example.org/repository/'};
    globalThis.fetch=async url=>{const name=new URL(url).pathname.split('/').pop();requests.push(name);return new Response(files.get(name));};
    const source=new Source('map-data/');
    source.layouts=new Client(()=>{
        const worker=new FakeWorker(),post=worker.postMessage.bind(worker);
        worker.postMessage=(...args)=>{post(...args);queueMicrotask(()=>worker.complete());};return worker;
    });
    try{
        await source.getManifest();assert.deepEqual(requests,['manifest.pb']);assert.equal(source.protoChunks.size,0);
        await source.getNeighborhood(0);assert.equal(requests.length,2);
        assert.equal(source.stats.indexPagesLoaded,0);
        const [job]=await source.getParcelJobs([0]);assert.ok(job.pack,job.error);assert.equal(source.stats.indexPagesLoaded,1);
        const ref=manifest.indexPages.find(r=>r.x===Math.floor(job.pack.chunkX/8)&&r.y===Math.floor(job.pack.chunkY/8));
        assert.equal(requests.at(-1),ref.url);assert.equal(requests.length,3);
        await source.getParcelJobs([1]);assert.equal(requests.length,3);
        const records=[];for await(const r of source.streamParcelJob(job,new AbortController().signal))records.push(r);
        assert.ok(records.some(r=>r.id===0));assert.equal(requests.length,4);
        assert.equal(source.cache.namespace,'http-pack-cache-v6');
    }finally{source.close();globalThis.fetch=oldFetch;globalThis.location=oldLocation;}
});

test('corrupt spatial pages fail before selecting parcel packs and close cannot retain pending index state',async()=>{
    const {files,manifest}=await fixture(),oldLocation=globalThis.location,oldFetch=globalThis.fetch;
    globalThis.location={href:'https://example.org/'};
    globalThis.fetch=async url=>new Response(files.get(new URL(url).pathname.split('/').pop()));
    const source=new Source('map-data/','manifest.pb','server');
    try{
        await source.getManifest();const ref=manifest.indexPages.find(r=>r.x===-1&&r.y===-1),bad=files.get(ref.url).slice();bad[0]^=1;files.set(ref.url,bad);
        const [job]=await source.getParcelJobs([0]);assert.match(job.error,/integrity/);assert.equal(source.stats.indexPagesLoaded,0);
        source.close();assert.equal(source.indexPages.size,0);assert.equal(source.indexRefs.size,0);
    }finally{source.close();globalThis.fetch=oldFetch;globalThis.location=oldLocation;}
});

test('spatial page downloads are deduplicated and limited to two; closing settles active and queued requests',async()=>{
    const {files,manifest,original}=await fixture(),oldLocation=globalThis.location,oldFetch=globalThis.fetch;
    globalThis.location={href:'https://example.org/'};
    const names=new Set(manifest.indexPages.map(p=>p.url));let active=0,maximum=0,downloads=0;
    globalThis.fetch=async url=>{
        const name=new URL(url).pathname.split('/').pop();
        if(names.has(name)){downloads++;active++;maximum=Math.max(maximum,active);await new Promise(resolve=>setTimeout(resolve,15));active--;}
        return new Response(files.get(name));
    };
    const source=new Source('map-data/');
    try{
        await source.getManifest();
        await Promise.all([...original.chunks,...original.chunks].map(c=>source.protoChunkAt(c.x,c.y)));
        assert.equal(downloads,4);assert.equal(maximum,2);assert.equal(source.stats.indexPagesLoaded,4);
    }finally{source.close();}
    const next=new Source('map-data/');
    try{
        await next.getManifest();
        const pending=original.chunks.map(c=>next.protoChunkAt(c.x,c.y));
        const rejected=Promise.all(pending.map(p=>assert.rejects(p,e=>e.name==='AbortError')));
        await new Promise(resolve=>setTimeout(resolve,0));next.close();await rejected;
        assert.equal(next.indexPages.size,0);assert.equal(next.indexWaiters.length,0);
    }finally{next.close();globalThis.fetch=oldFetch;globalThis.location=oldLocation;}
});
