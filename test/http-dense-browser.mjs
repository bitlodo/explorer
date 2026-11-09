import assert from 'node:assert/strict';
import fs from 'node:fs';
import { browserHarness } from './helpers/browser.mjs';
const browser = await browserHarness();
const { origin, snapshot, manifest, requests, errors, cdp, evaluate, wait, delay } = browser;
let ws;
try {
    ws = await browser.start();
    await cdp('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
    await cdp('Page.navigate', {url:origin+'/repository/'});
    await wait("document.readyState==='complete' && document.getElementById('mapCanvas') && !!document.querySelector('canvas')");
    await evaluate(`window.game=()=>{const e=document.getElementById('mapCanvas'),key=Object.keys(e).find(k=>k.startsWith('__reactFiber$'));for(let f=e[key];f;f=f.return)for(let h=f.memoizedState;h;h=h.next)if((h.memoizedState?.current??h.memoizedState)?.controller)return h.memoizedState.current??h.memoizedState;};window.state=()=>game()?.controller;`);
    await wait('state()?.overview?.slots.length===416 && !state().tween?.isPlaying()');
    await evaluate(`(()=>{
        const s=state();window.denseProfile={reserveMs:0,reserveCalls:0,selectMs:0,selectCalls:0,jobSelectionMs:0,jobSelections:0,batchWallMs:0,singleTx:0};
        for(const [key,total,calls] of [['reserveParcels','reserveMs','reserveCalls'],['updateMap','selectMs','selectCalls']]){
            const original=s[key];s[key]=function(...args){const t=performance.now();try{return original.apply(this,args);}finally{denseProfile[total]+=performance.now()-t;denseProfile[calls]++;}};
        }
        const get=s.source.getParcelJobs;s.source.getParcelJobs=async function(...args){const t=performance.now();try{return await get.apply(this,args);}finally{denseProfile.jobSelectionMs+=performance.now()-t;denseProfile.jobSelections++;}};
        const layout=s.layoutParcels;s.layoutParcels=async function(records){denseProfile.singleTx+=records.filter(r=>r.txCount===1).length;const t=performance.now();try{return await layout.call(this,records);}finally{denseProfile.batchWallMs+=performance.now()-t;}};
        const slot=s.overview.slots[10];s.animateCamera(1,slot.x+slot.width/2,slot.y+slot.height/2);
    })()`);
    const started=performance.now(),samples=[];
    let complete=false,last;
    while(performance.now()-started<Number(process.env.MAP_DENSE_MS||30000)){
        await delay(1000);
        last=await evaluate(`(()=>{const s=state(),ids=[...s.scheduler.desired];return {wanted:ids.length,resident:ids.filter(id=>s.loadedBitmaps.has(id)).length,skipped:ids.filter(id=>s.budgetSkipped.has(id)).length,active:s.scheduler.active.size,geometryPending:s.pendingNeighborhoods.size,selected:s.scheduler.selectedRevision===s.scheduler.revision,stats:{...s.source.stats,...s.scheduler.stats},profile:{...denseProfile},chunkBounds:s.scene.chunkBounds.count};})()`);
        samples.push({ms:performance.now()-started,...last});
        if(last.wanted>0 && last.resident+last.skipped===last.wanted && !last.geometryPending && !last.active && last.selected){complete=true;break;}
    }
    const screenshot=await cdp('Page.captureScreenshot',{format:'png'});fs.writeFileSync(process.env.MAP_DENSE_SCREENSHOT||'/tmp/bitmap-explorer-dense.png',Buffer.from(screenshot.data,'base64'));
    await evaluate('state().dispose()');await delay(100);assert.equal(errors.length,0,JSON.stringify(errors));
    assert.ok(last.wanted>0,'The viewport must request parcel detail');
    assert.ok(requests.every(p=>p.startsWith('/repository/') && !p.includes('/api/v1') && !p.includes('socket.io')));
    console.log(JSON.stringify({timeUntilAllVisibleMs:complete?samples.at(-1).ms:null,snapshot:manifest.snapshot,lod:'bounded parcel selection with bitmap-vector fallback',renderer:'Chrome isolated / SwiftShader',viewport:[1600,900],neighborhood:10,complete,elapsedMs:performance.now()-started,last,samples,exceptions:errors.length}));
} catch (error) {
    console.error(error);
    if (ws?.readyState === 1) { console.error(await evaluate('document.body.innerText').catch(String));console.error(await evaluate('({loaded170:state()?.loadedBitmaps.has(170),desired170:state()?.scheduler.wants(170),inFlight:[...state().inFlight],active:[...state().scheduler.active.keys()],failed:[...state().scheduler.failed],desired:[...state().scheduler.desired].slice(0,20),skipped:[...state().budgetSkipped],uploads:state().uploads.length,jobs:state().workerJobs.size,stats:state().source.stats})').catch(String)); }
    process.exitCode = 1;
} finally {
    await browser.close();
}
