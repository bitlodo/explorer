import assert from 'node:assert/strict';
import { browserHarness } from './helpers/browser.mjs';
const browser = await browserHarness();
const { origin, snapshot, manifest, errors, cdp, evaluate, wait, delay } = browser;
let ws;
try {
    ws = await browser.start();
    await cdp('Emulation.setDeviceMetricsOverride', { width: 1920, height: 993, deviceScaleFactor: 1, mobile: false });
    await cdp('Page.navigate', {url:origin+'/repository/'});
    await wait("document.readyState==='complete' && document.getElementById('mapCanvas') && !!document.querySelector('canvas')");
    await evaluate(`window.game=()=>{const e=document.getElementById('mapCanvas'),key=Object.keys(e).find(k=>k.startsWith('__reactFiber$'));for(let f=e[key];f;f=f.return)for(let h=f.memoizedState;h;h=h.next)if((h.memoizedState?.current??h.memoizedState)?.controller)return h.memoizedState.current??h.memoizedState;};window.state=()=>game()?.controller;`);
    await wait('state()?.overview?.slots.length===416 && !state().tween?.isPlaying()');
    const samples=await evaluate(`(async()=>{
        const s=state(),roundTrips=[],sent=new Map(),worker=s.bitmapWorker;
        const post=worker.postMessage.bind(worker),receive=worker.onmessage;
        worker.postMessage=function(message,...args){if(message.protocol==='parcel-worker-batch-v1')sent.set(message.batchId,{at:performance.now(),records:message.records.length,parcels:message.records.reduce((n,r)=>n+r.txCount,0)});return post(message,...args);};
        worker.onmessage=function(event){const item=sent.get(event.data.batchId);if(item){roundTrips.push({...item,ms:performance.now()-item.at});sent.delete(event.data.batchId);}return receive.call(this,event);};
        const run=async(name,begin)=>{
            const before={...s.source.stats},initial=s.loadedBitmaps.size,at=performance.now(),rows=[];let firstMs;
            begin();
            while(performance.now()-at<30000){await new Promise(r=>setTimeout(r,100));let loaded=0;for(let id=0;id<2016;id++)if(s.loadedBitmaps.has(id))loaded++;
                const row={ms:performance.now()-at,loaded,height:s.scene.camera.position.y,previewVisible:s.preview.visible,active:s.scheduler.active.size,frames:s.source.stats.framesValidated-before.framesValidated};rows.push(row);
                if(loaded&&!firstMs)firstMs=row.ms;if(loaded===2016)break;
            }
            return {name,initial,firstMs,complete:rows.at(-1).loaded===2016,completeMs:rows.at(-1).loaded===2016?rows.at(-1).ms:null,before,after:{...s.source.stats},rows};
        };
        const cold=await run('empty profile / local HTTP',()=>s.animateDistance(s.distanceLevels()[1],{center:{x:0,z:0},duration:350}));
        ${process.env.MAP_CENTER_COLD_ONLY?'return {cold,roundTrips};':''}
        await new Promise(r=>setTimeout(r,300));
        const resident=await run('details already resident',()=>{s.animateDistance(s.distanceLevels()[3],{center:{x:0,z:0},duration:0});s.animateDistance(s.distanceLevels()[1],{center:{x:0,z:0},duration:0});});
        await new Promise(r=>setTimeout(r,300));
        for(let i=0;i<600&&s.scheduler.active.size;i++)await new Promise(r=>setTimeout(r,100));
        const cached=await run('controlled GPU discard / authenticated RAM',()=>{s.scheduler.setDesired([]);s.neighborhoods.get(0).clearParcelDetails();for(let id=0;id<2016;id++)s.loadedBitmaps.delete(id);s.requestUpdate();});
        worker.postMessage=post;worker.onmessage=receive;
        return {cold,resident,cached,roundTrips};
    })()`);
    if(!process.env.MAP_CENTER_COLD_ONLY){
    assert.ok(samples.cold.complete,'The complete neighborhood 0 must become resident');
    assert.ok(samples.cached.complete,'GPU discard must reconstruct from authenticated records');
    assert.equal(samples.cached.after.networkBytes,samples.cached.before.networkBytes,'RAM reconstruction must not fetch packs');
    assert.equal(samples.cold.rows.at(-1).previewVisible,false,'Settled near tier must hide image previews');
    }
    const maintenance=process.env.MAP_CENTER_COLD_ONLY?undefined:await evaluate(`(async()=>{
        const Cache=state().source.cache.constructor;state().dispose();
        const cache=new Cache(0,1024,'maintenance-test');await cache.ready;
        const transaction=(action)=>new Promise((resolve,reject)=>{const tx=cache.db.transaction('content','readwrite');action(tx.objectStore('content'));tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);});
        await transaction(store=>store.clear());
        await transaction(store=>{for(let i=0;i<300;i++)store.put({key:'maintenance-test:'+String(i).padStart(4,'0'),bytes:new Uint8Array(8),size:8,time:1234});});
        cache.startCleanup();const started=performance.now();const read=await cache.get('0299');const readMs=performance.now()-started;await cache.cleanupRunning;
        const count=await new Promise((resolve,reject)=>{const tx=cache.db.transaction('content','readonly'),r=tx.objectStore('content').count();r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
        const newest=await cache.get('0299'),oldest=await cache.get('0000');cache.close();return {count,newest:!!newest,oldest:!!oldest,read:!!read,readMs};
    })()`);
    if(maintenance){assert.equal(maintenance.count,128);assert.equal(maintenance.newest,true);assert.equal(maintenance.oldest,false);assert.equal(maintenance.read,true);}
    if(process.env.MAP_CENTER_COLD_ONLY)await evaluate('state().dispose()');
    await delay(100);assert.equal(errors.length,0,JSON.stringify(errors));
    console.log(JSON.stringify({snapshot:manifest.snapshot,renderer:'Chrome isolated / SwiftShader',viewport:[1920,993],timing:'Local HTTP; empty isolated profile, followed by same-session reuse. Not device FPS or CDN performance.',samples,maintenance,exceptions:errors.length}));
} catch (error) {
    console.error(error);
    if (ws?.readyState === 1) { console.error(await evaluate('document.body.innerText').catch(String));console.error(await evaluate('({loaded170:state()?.loadedBitmaps.has(170),desired170:state()?.scheduler.wants(170),inFlight:[...state().inFlight],active:[...state().scheduler.active.keys()],failed:[...state().scheduler.failed],desired:[...state().scheduler.desired].slice(0,20),skipped:[...state().budgetSkipped],uploads:state().uploads.length,jobs:state().workerJobs.size,stats:state().source.stats})').catch(String)); }
    process.exitCode = 1;
} finally {
    await browser.close();
}
