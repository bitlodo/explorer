import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import fs from 'node:fs';
import {loadShared} from './helpers/load-shared.ts';
const {default:Source}=await loadShared('../../src/data/StaticHttpDataSource.ts');
const {encodeSizes,buildPack,sha256,FORMAT,LAYOUT}=await loadShared('../../src/shared/httpPack.ts');
const require=createRequire(new URL('../package.json',import.meta.url));
const protobuf=require('protobufjs');
const type=protobuf.Root.fromJSON(JSON.parse(fs.readFileSync(new URL('../src/shared/proto/neighborhood_descriptor.json',import.meta.url)))).lookupType('Neighborhood');
const geometry=type.encode({neighborhood:0,width:2016,height:1,bitmaps:Array.from({length:2016},(_,x)=>({x,y:0,width:1,height:1}))}).finish();
const records=Array.from({length:2016},(_,i)=>encodeSizes(i,[1]));
const pack=await buildPack(records,0,0,1024);
const files=new Map();
async function ref(bytes,ext){const hash=await sha256(bytes),url=hash+'.'+ext;files.set(url,bytes);return{url,sha256:hash,bytes:bytes.length};}
const packRef={...pack.descriptor,...await ref(pack.wire,'bin')};
const region={format:FORMAT,id:0,geometry:await ref(geometry,'pb'),coverage:'complete',packs:[packRef]};
const descriptor=await ref(new TextEncoder().encode(JSON.stringify(region)),'json');
const manifest={format:FORMAT,layout:LAYOUT,snapshot:'fixture-v1',publishedHeight:2015,regions:[{id:0,width:2016,height:1,descriptor}]};
files.set('manifest.json',new TextEncoder().encode(JSON.stringify(manifest)));
const collect=async stream=>{const values=[];for await(const v of stream)values.push(v);return values;};

test('source pins snapshot, streams verified frames, resumes cancelled prefix and reuses warm data',async()=>{
    const previousFetch=globalThis.fetch,previousLocation=globalThis.location;
    globalThis.location={href:'https://example.org/repository/'};
    let requests=[],cancelled=0,abortObserved=0,slow=true;
    globalThis.fetch=async(url,{signal}={})=>{
        requests.push(String(url));const name=new URL(url).pathname.split('/').pop();const bytes=files.get(name);
        if(!bytes)return new Response('',{status:404});
        let offset=0;
        return new Response(new ReadableStream({
            async pull(controller){
                if(name===packRef.url&&offset>0&&slow){await new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>{abortObserved++;reject(signal.reason);},{once:true});});}
                signal?.throwIfAborted();
                if(offset>=bytes.length){controller.close();return;}
                const end=Math.min(bytes.length,offset+(name===packRef.url?packRef.frames[0].bytes:7));controller.enqueue(bytes.slice(offset,end));offset=end;
            },cancel(){cancelled++;}
        }),{headers:{'content-type':'application/octet-stream'}});
    };
    const source=new Source('map-data/','manifest.json');
    try{
        assert.equal((await source.getManifest()).snapshot,'fixture-v1');
        assert.equal((await source.getNeighborhood(0)).bitmaps.length,2016);
        const controller=new AbortController(),stream=source.streamParcels(0,[0],controller.signal);
        assert.equal((await stream.next()).value.id,0);controller.abort();
        await assert.rejects(()=>stream.next(),e=>e.name==='AbortError');
        const cached=await source.cache.get(packRef.frames[0].sha256);assert.ok(cached,'validated prefix persists even on cancel');
        slow=false;
        const values=await collect(source.streamParcels(0,[0,2015],new AbortController().signal));assert.deepEqual(values.map(v=>v.id),[0,2015]);
        const network=requests.length;
        await collect(source.streamParcels(0,[2015],new AbortController().signal));
        assert.equal(requests.length,network);
        // Validated single-parcel records can serve this fixture directly,
        // without visiting the frame cache again.
        assert.ok(source.stats.cacheBytes>0 || source.stats.singleParcelHits>0);
        const changed={...manifest,snapshot:'fixture-v2'};files.set('manifest.json',new TextEncoder().encode(JSON.stringify(changed)));
        assert.equal((await source.getManifest()).snapshot,'fixture-v1');
        assert.ok(requests.every(url=>url.startsWith('https://example.org/repository/map-data/')));
        assert.ok(cancelled>0 || abortObserved>0);
    }finally{source.close();globalThis.fetch=previousFetch;globalThis.location=previousLocation;files.set('manifest.json',new TextEncoder().encode(JSON.stringify(manifest)));}
});
test('status, metadata hash, incompatible versions and unexpected HTML fail clearly',async()=>{
    const previousFetch=globalThis.fetch,previousLocation=globalThis.location;globalThis.location={href:'https://example.org/repository/'};
    try{
        for(const status of [404,429,500]){
            globalThis.fetch=async()=>new Response('',{status});const source=new Source('map-data/','manifest.json');
            await assert.rejects(()=>source.getManifest(),new RegExp(String(status)));source.close();
        }
        globalThis.fetch=async()=>new Response('<html>',{headers:{'content-type':'text/html'}});
        const html=new Source('map-data/','manifest.json');await assert.rejects(()=>html.getManifest(),/HTML/);html.close();
        globalThis.fetch=async()=>new Response(JSON.stringify({...manifest,format:'unknown'}));
        const unknown=new Source('map-data/','manifest.json');await assert.rejects(()=>unknown.getManifest(),/Incompatible/);unknown.close();
        globalThis.fetch=async url=>new Response(String(url).endsWith('manifest.json')?JSON.stringify(manifest):'corrupt');
        const corrupt=new Source('map-data/','manifest.json');await assert.rejects(()=>corrupt.getNeighborhood(0),/integrity/);corrupt.close();
    }finally{globalThis.fetch=previousFetch;globalThis.location=previousLocation;}
});

test('v2 scheduler downloads a shared pack once across regions, follows pan within it and reloads from cache',async()=>{
    const {buildGroupedPack,GROUP_FORMAT}=await loadShared('../../src/shared/httpPack.ts');
    const {default:Scheduler}=await loadShared('../../src/data/ParcelScheduler.ts');
    const grouped=await buildGroupedPack(Array.from({length:6048},(_,id)=>encodeSizes(id,[1])),1024);
    const content=new Map();
    const reference=async(bytes,ext)=>{const sha=await sha256(bytes),url=sha+'.'+ext;content.set(url,bytes);return{url,sha256:sha,bytes:bytes.length};};
    const shared={...grouped.descriptor,...await reference(grouped.wire,'bin')},regions=[];
    for(let id=0;id<3;id++) {
        const geom=await reference(type.encode({neighborhood:id,width:2016,height:1,bitmaps:Array.from({length:2016},(_,x)=>({x,y:0,width:1,height:1}))}).finish(),'pb');
        const descriptor=await reference(new TextEncoder().encode(JSON.stringify({format:GROUP_FORMAT,id,geometry:geom,coverage:'complete',packs:[shared]})),'json');
        regions.push({id,width:2016,height:1,descriptor});
    }
    content.set('manifest.json',new TextEncoder().encode(JSON.stringify({...manifest,format:GROUP_FORMAT,publishedHeight:6047,regions})));
    const previousFetch=globalThis.fetch,previousLocation=globalThis.location;globalThis.location={href:'https://example.org/repository/'};
    let packGets=0,aborts=0,release;const gate=new Promise(resolve=>release=resolve);
    globalThis.fetch=async(url,{signal}={})=>{
        const name=new URL(url).pathname.split('/').pop(),bytes=content.get(name);assert.ok(bytes);
        if(name!==shared.url)return new Response(bytes);
        packGets++;let offset=0;
        signal.addEventListener('abort',()=>aborts++,{once:true});
        return new Response(new ReadableStream({async pull(controller){
            if(offset>0)await gate;
            signal.throwIfAborted();
            if(offset===bytes.length){controller.close();return;}
            const end=offset===0?shared.frames[0].bytes:bytes.length;controller.enqueue(bytes.slice(offset,end));offset=end;
        }}));
    };
    const source=new Source('map-data/','manifest.json'),resident=new Set(),errors=[];
    const scheduler=new Scheduler(source,id=>resident.has(id),async batch=>batch.forEach(record=>resident.add(record.id)),e=>errors.push(e));
    async function until(condition){for(let i=0;i<1000;i++){if(condition())return;await new Promise(r=>setTimeout(r,2));}throw Error('shared pack condition timed out');}
    try{
        const jobs=await source.getParcelJobs([0,2016]);assert.equal(jobs.length,1);assert.deepEqual(jobs[0].ids,[0,2016]);
        assert.equal(source.cache.namespace,'http-pack-cache-v2');
        scheduler.setDesired([0,2016]);await until(()=>resident.has(0));assert.equal(packGets,1);
        scheduler.setDesired([2016,4032]);await new Promise(r=>setTimeout(r,5));assert.equal(aborts,0,'pan within shared file must not abort it');
        release();await until(()=>resident.has(2016)&&resident.has(4032)&&scheduler.active.size===0);
        assert.equal(packGets,1);assert.equal(scheduler.stats.maxConcurrentDownloads,1);assert.deepEqual(errors,[]);
        assert.deepEqual((await collect(source.streamParcels(2,[4032],new AbortController().signal))).map(r=>r.id),[4032]);
        assert.equal(packGets,1,'a different neighborhood reuses the same frames');
        // Evicted geometry is reconstructed from the shared immutable payload.
        resident.clear();scheduler.setDesired([1,2017,4033]);await until(()=>resident.size===3&&scheduler.active.size===0);assert.equal(packGets,1);
    }finally{release();scheduler.close();source.close();globalThis.fetch=previousFetch;globalThis.location=previousLocation;}
});

test('closing during v2 manifest bootstrap cannot reopen a cache after teardown',async()=>{
    const previousLocation=globalThis.location;globalThis.location={href:'https://example.org/repository/'};
    const source=new Source('map-data/','manifest.json');
    source.small=async()=>{source.close();return new TextEncoder().encode(JSON.stringify({...manifest,format:'bitmap-http-pack-v2'}));};
    try{await assert.rejects(()=>source.getManifest(),e=>e.name==='AbortError');assert.equal(source.cache.closed,true);}
    finally{source.close();globalThis.location=previousLocation;}
});

test('v3 sparse square chunks share jobs across neighborhoods and reuse verified data',async()=>{
    const {CHUNK_FORMAT,buildChunkPack}=await loadShared('../../src/shared/httpPack.ts');
    const {default:Scheduler}=await loadShared('../../src/data/ParcelScheduler.ts');
    const content=new Map(),packs=[],chunks=[],regions=[];
    const json=value=>new TextEncoder().encode(JSON.stringify(value));
    async function ref(bytes,ext){const hash=await sha256(bytes),url=hash+'.'+ext;content.set(url,bytes);return{url,sha256:hash,bytes:bytes.length};}
    for(let x=0;x<2;x++) {
        const built=await buildChunkPack(Array.from({length:2016},(_,i)=>encodeSizes(i*2+x,[1])),x,0,1024);
        const pack={...built.descriptor,...await ref(built.wire,'bin')};packs.push(pack);
        chunks.push({x,y:0,descriptor:await ref(json({format:CHUNK_FORMAT,x,y:0,size:1024,packs:[await ref(json(pack),'json')],records:2016,lastHeight:pack.last}),'json')});
    }
    for(let id=0;id<2;id++) {
        const geometry=await ref(type.encode({neighborhood:id,width:2016,height:1,bitmaps:Array.from({length:2016},(_,x)=>({x,y:0,width:1,height:1}))}).finish(),'pb');
        const descriptor=await ref(json({format:CHUNK_FORMAT,id,geometry,coverage:'complete',packs:[],chunks,bitmapChunks:Array.from({length:2016},(_,i)=>i%2)}),'json');
        regions.push({id,width:2016,height:1,descriptor});
    }
    content.set('manifest.json',json({...manifest,format:CHUNK_FORMAT,publishedHeight:4031,regions,grid:{size:1024,originX:0,originY:0,ownership:'top-left'}}));
    const oldFetch=globalThis.fetch,oldLocation=globalThis.location;globalThis.location={href:'https://example.org/repository/'};const requests=[];
    globalThis.fetch=async url=>{const name=new URL(url).pathname.split('/').pop();requests.push(name);assert.ok(content.has(name));return new Response(content.get(name));};
    const source=new Source('map-data/','manifest.json'),resident=new Set(),errors=[];
    const scheduler=new Scheduler(source,id=>resident.has(id),async batch=>batch.forEach(r=>resident.add(r.id)),e=>errors.push(e));
    const until=async condition=>{for(let i=0;i<1000;i++){if(condition())return;await new Promise(r=>setTimeout(r,2));}throw Error('v3 wait timed out');};
    try{
        const jobs=await source.getParcelJobs([0,2016,1]);assert.equal(jobs.length,2);assert.deepEqual(jobs[0].ids,[0,2016]);assert.equal(jobs[0].pack.chunkX,0);
        assert.equal(source.cache.namespace,'http-pack-cache-v3');
        const healthyFetch=globalThis.fetch,retrySource=new Source('map-data/','manifest.json');
        try {
            globalThis.fetch=async(url,...args)=>String(url).endsWith(chunks[0].descriptor.url)?new Response('',{status:429}):healthyFetch(url,...args);
            assert.match((await retrySource.getParcelJobs([0]))[0].error,/429/,'metadata failure becomes a retryable scheduler job');
            globalThis.fetch=healthyFetch;
            assert.ok((await retrySource.getParcelJobs([0]))[0].pack,'failed chunk selection can recover');
        } finally {globalThis.fetch=healthyFetch;retrySource.close();}
        scheduler.setDesired([0,2016,1,2017]);await until(()=>resident.size===4&&scheduler.active.size===0);
        assert.equal(requests.filter(n=>n.endsWith('.bin')).length,2);
        resident.clear();scheduler.setDesired([2,2018]);await until(()=>resident.has(2)&&resident.has(2018)&&scheduler.active.size===0);
        assert.equal(requests.filter(n=>n.endsWith('.bin')).length,2);assert.deepEqual(errors,[]);
        const controller=new AbortController();scheduler.active.set('fake',{controller,job:jobs[0]});scheduler.setDesired([1]);assert.equal(controller.signal.aborted,true,'a height interval hole belongs to another chunk');scheduler.active.delete('fake');
    }finally{scheduler.close();source.close();globalThis.fetch=oldFetch;globalThis.location=oldLocation;}
});
