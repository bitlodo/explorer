import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createServer } from 'vite';
import { clientConfig } from '../vite.config.ts';
import { browserHarness } from './helpers/browser.mjs';
const port=Number(process.env.MAP_DEV_TEST_PORT||5392),origin=`http://127.0.0.1:${port}`;
const config=clientConfig(),server=await createServer({...config,configFile:false,server:{...config.server,port,strictPort:true}});
let browser;
const report={sourceDevelopment:true,requests:[],samples:[]};
try{
    await server.listen();browser=await browserHarness({development:true});const ws=await browser.start(),byId=new Map();
    ws.addEventListener('message',event=>{
        const m=JSON.parse(event.data),p=m.params;
        if(m.method==='Network.requestWillBeSent'&&p.request.url.startsWith(origin+'/map-data/')){const r={path:new URL(p.request.url).pathname,bytes:0};report.requests.push(r);byId.set(p.requestId,r);}
        if(m.method==='Network.dataReceived'&&byId.has(p.requestId))byId.get(p.requestId).bytes+=p.dataLength;
    });
    const {cdp,evaluate,wait,delay}=browser;
    await cdp('Network.enable');await cdp('Emulation.setDeviceMetricsOverride',{width:1600,height:1000,deviceScaleFactor:1,mobile:false});await cdp('Page.navigate',{url:origin+'/'});
    await wait("!!document.getElementById('mapCanvas')");
    await evaluate(`window.state=()=>{const e=document.getElementById('mapCanvas'),key=Object.keys(e).find(k=>k.startsWith('__reactFiber$'));for(let f=e[key];f;f=f.return)for(let h=f.memoizedState;h;h=h.next){const r=h.memoizedState?.current??h.memoizedState;if(r?.controller)return r.controller;}};`);
    await wait('state()?.getState().ready&&!state().getState().renderingBusy');await delay(300);
    assert.equal(await evaluate("!!document.querySelector('script[src*=\"/src/main.tsx\"]')"),true);
    assert.equal(report.requests.some(r=>r.path.includes('/summaries/')),false,'Stop 5 starts no spatial summary downloads');
    await evaluate('state().setZoom(Math.sqrt(state().distanceLevels()[3]*state().distanceLevels()[4]),"drag")');await wait('!state().zoomDamping.active');await delay(100);
    assert.equal(report.requests.some(r=>r.path.includes('/summaries/')),false,'The approach to stop 4 remains metadata-only');
    await evaluate('state().setZoom(state().distanceLevels()[3],"drag")');
    const settle=async()=>{await wait('!state().zoomDamping.active&&state().preview.spatialStats.wanted>0&&state().preview.spatialStats.active===0&&state().preview.spatialStats.visibleRegions===state().preview.spatialStats.wanted');await browser.frame();};
    await settle();
    const pan=async id=>{await evaluate(`(()=>{const s=state(),r=s.overview.slots[${id}];s.cancelZoom();s.tween?.stop();s.scene.camera.position.set(r.x+r.width/2,s.distanceLevels()[3],r.y+r.height/2);s.scene.controls.target.set(r.x+r.width/2,0,r.y+r.height/2);s.scene.controls.update();s.requestUpdate();})()`);await browser.frame();await settle();};
    // Visit spatially distributed neighborhoods at a fixed stop, without search/detail downloads.
    for(let id=0;id<browser.manifest.regions.length;id+=12)await pan(id);
    report.areaSweep={requests:report.requests.length,summaryFiles:report.requests.filter(r=>/\/aggregates\/area\//.test(r.path)).length,bytes:report.requests.filter(r=>/\/aggregates\//.test(r.path)).reduce((s,r)=>s+r.bytes,0)};
    assert.equal(report.requests.some(r=>/\/summaries\/n\d|\/metrics\/values\//.test(r.path)),false,'Unfiltered stop-4 pans need neither membership pages nor local bitmap metrics');
    const unrelated=report.requests.filter(r=>/\/aggregates\/(count|diversity|occupancy|size)\//.test(r.path));assert.equal(unrelated.length,0,'Bitmap Area does not fetch the other modes');
    console.log(JSON.stringify({phase:'area-sweep',...report.areaSweep}));
    for(const mode of ['area','count','diversity','occupancy','size']){
        const start=report.requests.length;await evaluate(`state().setRenderingMode('${mode}')`);await settle();await pan(178);
        const data=await evaluate(`(()=>{const p=state().preview.spatial;return {mode:state().renderingMode,stats:{...p.stats},ready:state().localReady.size,grid:[...p.records.values()].every(r=>r.page.columns===Math.min(16,r.page.width)&&r.page.rows===Math.min(16,r.page.height))};})()`);
        assert.equal(data.grid,true);assert.equal(data.ready,0,'Unfiltered stop 4 uses precomputed aggregates');
        assert.equal(report.requests.slice(start).some(r=>/\/routing\/|\/metrics\/values\/|\/summaries\/n\d/.test(r.path)),false,'Mode changes need no summary routing or detailed values');
        report.samples.push(data);await fs.writeFile(`/tmp/bitmap-lod4-aggregates-${mode}.png`,Buffer.from((await cdp('Page.captureScreenshot',{format:'png'})).data,'base64'));
    }
    const versions=()=>evaluate(`[...state().preview.spatial.records.values()].flatMap(r=>r.layer?Object.values(r.layer.mesh.geometry.attributes).map(a=>a.version):[])`);
    await delay(700);const before=await versions();await delay(200);assert.deepEqual(await versions(),before,'Settled aggregate cells do not upload buffers');
    await evaluate("state().setRenderingMode('area')");await settle();const resident=report.requests.filter(r=>r.path.includes('/aggregates/area/')).length;
    await evaluate('state().setZoom(state().distanceLevels()[4],"drag")');await wait('!state().zoomDamping.active');await browser.frame();assert.equal(await evaluate('state().preview.spatialStats.visibleRegions'),0);
    await evaluate('state().setZoom(state().distanceLevels()[3],"drag")');await settle();assert.equal(report.requests.filter(r=>r.path.includes('/aggregates/area/')).length,resident,'Resident summaries survive reverse zoom');
    await evaluate('state().setMetricFilter(.2,.7)');await wait('!state().getState().filterBusy');await settle();
    assert.equal(await evaluate('state().preview.spatial.useExact'),true,'Exact filters retain the canonical membership path');
    assert.ok(report.requests.some(r=>/\/summaries\/n\d/.test(r.path)));
    await evaluate('state().setMetricFilter(0,1)');await settle();assert.equal(await evaluate('state().preview.spatial.useExact'),false);
    await evaluate('state().setZoom(state().distanceLevels()[2],"drag")');await wait('!state().zoomDamping.active&&state().neighborhoodChunks.ready(state().geometryBounds())');await delay(650);
    assert.ok(report.requests.some(r=>r.path.includes('/bitmaps/chunks/')),'Closer zoom still loads exact vectors');
    assert.equal(browser.errors.length,0,JSON.stringify(browser.errors));report.errors=browser.errors;
    await fs.writeFile('/tmp/bitmap-lod4-aggregates-browser.json',JSON.stringify(report,null,2));
    console.log(JSON.stringify({status:'passed',sourceDevelopment:true,samples:report.samples.length,areaSweep:report.areaSweep,exceptions:browser.errors.length}));
}catch(error){
    if(browser)console.error(JSON.stringify(await browser.evaluate(`(()=>{const s=state(),p=s?.preview?.spatial;return {state:s?.getState(),stats:p?.stats,missing:p?.missing,root:!!p?.index,active:p?[...p.active.keys()]:[],failures:p?[...p.retry.failures]:[]};})()`).catch(()=>null)));
    throw error;
}finally{if(browser)await browser.close();await server.close();}
