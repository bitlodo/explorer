import test from 'node:test';
import assert from 'node:assert/strict';
import {loadShared} from './helpers/load-shared.ts';
const c=await loadShared('../../src/shared/neighborhoodChunks.ts');
const {sha256}=await loadShared('../../src/shared/httpPack.ts');
const {default:Source}=await loadShared('../../src/data/NeighborhoodChunkSource.ts');
const {default:Loader}=await loadShared('../../src/data/NeighborhoodChunkLoader.ts');
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
async function fixture(){
 const index={format:c.NEIGHBORHOOD_CHUNKS,sourceSnapshot:'a'.repeat(64),size:1024,side:8,maxWidth:300,maxHeight:400,pages:[]};
 const bitmaps=[{id:0,x:-.5,y:-100,width:300,height:400},{id:2016,x:-20.5,y:-10,width:2,height:3}];
 const bytes=c.encodeNeighborhoodChunk(bitmaps,-1,-1,1024),hash=await sha256(bytes),ref={x:-1,y:-1,records:2,url:hash+'.nbc',sha256:hash,bytes:bytes.length};
 const page=c.jsonBytes({format:c.NEIGHBORHOOD_CHUNKS,x:-1,y:-1,chunks:[ref]}),pageHash=await sha256(page),pageRef={x:-1,y:-1,url:pageHash+'.nbc',sha256:pageHash,bytes:page.length};
 index.pages=[pageRef];index.snapshot=await sha256(c.jsonBytes(index));const root=c.jsonBytes(index);
 return{index,bitmaps,bytes,ref,page,pageRef,root};
}
test('fixed spatial chunks preserve canonical bitmap identity, fractional/negative world coordinates and variable counts',async()=>{
 const f=await fixture();const index=await c.decodeNeighborhoodChunkIndex(f.root,f.index.sourceSnapshot);
 assert.deepEqual(c.decodeNeighborhoodChunkPage(f.page,f.pageRef,index),[f.ref]);
 assert.deepEqual(c.decodeNeighborhoodChunk(f.bytes,f.ref,index,4031).bitmaps,f.bitmaps);
 assert(c.chunkIntersects(f.ref,1024,{x:10,y:0,width:10,height:10},index.maxWidth,index.maxHeight),'owner across viewport edge is included');
 assert(!c.chunkIntersects(f.ref,1024,{x:10,y:0,width:10,height:10}),'owner cell itself is outside viewport');
});
test('rejects wrong snapshots, tampered root, wrong owners, duplicate IDs and truncated chunks',async()=>{
 const f=await fixture();await assert.rejects(c.decodeNeighborhoodChunkIndex(f.root,'b'.repeat(64)));
 await assert.rejects(c.decodeNeighborhoodChunkIndex(c.jsonBytes({...f.index,size:512}),f.index.sourceSnapshot));
 assert.throws(()=>c.decodeNeighborhoodChunk(f.bytes,{...f.ref,x:0},f.index,4031));
 assert.throws(()=>c.decodeNeighborhoodChunk(f.bytes.subarray(1),f.ref,f.index,4031));
 const duplicate=c.encodeNeighborhoodChunk([f.bitmaps[0],{...f.bitmaps[1],id:0}],-1,-1,1024);
 assert.throws(()=>c.decodeNeighborhoodChunk(duplicate,f.ref,f.index,4031));
});
test('source certifies complete owner cells, reuses page metadata, and legacy absence is explicit',async()=>{
 const f=await fixture(),requests=[],signal=new AbortController().signal;
 const source=new Source(async()=>({snapshot:f.index.sourceSnapshot,publishedHeight:4031}),async name=>{requests.push(name);return f.root;},async ref=>{requests.push(ref.url);return ref.url===f.pageRef.url?f.page:f.bytes;});
 assert.deepEqual(await source.refs({x:10000,y:10000,width:1,height:1},signal),[]);assert.deepEqual(requests,['neighborhood-chunks.json']);
 const bounds={x:10,y:0,width:10,height:10},runtimeRef={...f.ref,coverageBounds:{x:-1024,y:-1024,width:1324,height:1424}};
 assert.deepEqual(await source.refs(bounds,signal),[runtimeRef]);await source.refs(bounds,signal);assert.equal(requests.length,2);
 assert.deepEqual(await source.refs({x:700,y:700,width:10,height:10},signal),[runtimeRef],'Pan within an owner cell retains every possible incoming owner');
 assert.equal(requests.length,2,'Owner-cell certification reuses paged metadata');
 assert.deepEqual((await source.load(f.ref,signal)).bitmaps,f.bitmaps);source.close();
 const legacy=new Source(async()=>({snapshot:f.index.sourceSnapshot}),async()=>{throw Object.assign(Error('missing'),{status:404});},()=>{throw Error('Unexpected data request');});
 assert.equal(await legacy.refs(bounds,signal),undefined);legacy.close();
});
test('loader limits concurrency, marks only complete chunks and cancels obsolete work',async()=>{
 let active=0,peak=0;const pending=[],loaded=[],present=new Set(),layer={chunkCapacity:2048,hasChunk:key=>present.has(key),setWantedChunks(){},addChunk(chunk){present.add(`${chunk.x},${chunk.y}`);return true;}};
 const refs=Array.from({length:8},(_,x)=>({x,y:0}));
 const source={getNeighborhoodChunkRefs:async()=>refs,getNeighborhoodChunk:(ref,signal)=>new Promise((resolve,reject)=>{active++;peak=Math.max(peak,active);let done=false;const finish=action=>{if(done)return;done=true;active--;action();};pending.push(()=>finish(()=>resolve({...ref,size:1024,bitmaps:[]})));signal.addEventListener('abort',()=>finish(()=>reject(new DOMException('Aborted','AbortError'))),{once:true});})};
 const loader=new Loader(source,layer,()=>{},chunk=>loaded.push(chunk),error=>{throw error;});const bounds={x:0,y:0,width:8192,height:1024};loader.update(bounds);await tick();assert.equal(active,4);assert.equal(loaded.length,0);
 pending.splice(0).forEach(resolve=>resolve());await tick();assert.equal(active,4);assert.equal(loaded.length,4);assert(!loader.ready(bounds));
 loader.update(undefined);await tick();assert.equal(active,0);assert.equal(loaded.length,4);assert.equal(peak,4);
 loader.update(bounds);await tick();pending.splice(0).forEach(resolve=>resolve());await tick();assert(loader.ready(bounds));assert.equal(loaded.length,8);loader.close();
});


test('pan retains shared in-flight chunks while resolving refs, and requests only newly missing chunks',async()=>{
 const present=new Set(),pins=[],signals=new Map(),downloads=[],queries=[];
 const layer={chunkCapacity:2048,hasChunk:k=>present.has(k),setWantedChunks(keys){pins.push([...keys]);},addChunk(c){present.add(`${c.x},${c.y}`);return true;}};
 const refs=[{x:0,y:0},{x:1,y:0},{x:2,y:0}];
 const source={getNeighborhoodChunkRefs:(_b,signal)=>new Promise(resolve=>queries.push({resolve,signal})),getNeighborhoodChunk:(r,signal)=>new Promise((resolve,reject)=>{const key=`${r.x},${r.y}`;signals.set(key,signal);downloads.push({key,resolve:()=>resolve({...r,size:1024,bitmaps:[]})});signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true});})};
 const loader=new Loader(source,layer,()=>{},()=>{},e=>{throw e;});
 loader.update({x:0,y:0,width:2048,height:1024});queries[0].resolve(refs.slice(0,2));await tick();
 assert.equal(downloads.length,2);downloads[0].resolve();await tick();assert(present.has('0,0'));
 loader.update({x:128,y:0,width:2048,height:1024});
 assert.deepEqual(pins.at(-1),['0,0','1,0'],'Do not clear coverage while the next index query is pending');assert.equal(signals.get('1,0').aborted,false);
 queries[1].resolve(refs);await tick();assert.equal(signals.get('1,0').aborted,false);assert.equal(downloads.filter(d=>d.key==='1,0').length,1);assert.equal(downloads.filter(d=>d.key==='2,0').length,1);assert.equal(downloads.filter(d=>d.key==='0,0').length,1);
 loader.update({x:1024,y:0,width:2048,height:1024});queries[2].resolve([refs[2]]);await tick();assert.equal(signals.get('1,0').aborted,true);assert.equal(signals.get('2,0').aborted,false);
 loader.close();assert.equal(signals.get('2,0').aborted,true);
});
