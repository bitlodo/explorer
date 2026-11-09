import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {browserHarness} from './helpers/browser.mjs';
const browser=await browserHarness(),{cdp,evaluate,wait,delay,requests,errors}=browser;
const report={samples:[],cache:{}};
try{
    await browser.start();await cdp('Page.navigate',{url:browser.origin+'/repository/'});
    await wait("!!document.getElementById('mapCanvas')");
    await evaluate(`window.state=()=>{const e=document.getElementById('mapCanvas'),key=Object.keys(e).find(k=>k.startsWith('__reactFiber$'));for(let f=e[key];f;f=f.return)for(let h=f.memoizedState;h;h=h.next){const r=h.memoizedState?.current??h.memoizedState;if(r?.controller)return r.controller;}};`);
    await wait('state()?.getState().ready&&!state().getState().renderingBusy');
    assert.ok(await evaluate('!!state().source.release'),'Production pins an immutable release');
    // Import the real cache into an isolated Chrome profile; no user namespace is touched.
    const bundle=await Bun.build({entrypoints:['src/data/PackCache.ts'],target:'browser',format:'esm',write:false});
    assert.equal(bundle.success,true);
    const cacheModule=Buffer.from(await bundle.outputs[0].text()).toString('base64');
    report.cache=await evaluate(`(async()=>{
        const {default:Cache}=await import('data:application/javascript;base64,${cacheModule}');
        const large=new Cache(0,128*1024,'audit-large'),small=new Cache(0,1024,'audit-small');await Promise.all([large.ready,small.ready]);
        await large.putMany([{hash:'protected',bytes:new Uint8Array(4096)}]);await large.compact();
        await small.putMany([{hash:'tiny',bytes:new Uint8Array(16)}]);await small.compact();
        const protectedBytes=(await large.get('protected'))?.length,tinyBytes=(await small.get('tiny'))?.length;
        const lru=new Cache(0,6,'audit-lru');await lru.ready;
        const pause=()=>new Promise(resolve=>setTimeout(resolve,5));
        await lru.putMany([{hash:'a',bytes:new Uint8Array(3)}]);await lru.compact();await pause();
        await lru.putMany([{hash:'b',bytes:new Uint8Array(3)}]);await lru.compact();await pause();await lru.get('a');await lru.compact();await pause();
        await lru.putMany([{hash:'c',bytes:new Uint8Array(3)}]);await lru.compact();
        const lruRetained={a:!!await lru.get('a'),b:!!await lru.get('b'),c:!!await lru.get('c')};
        large.close();small.close();lru.close();return {protectedBytes,tinyBytes,lruRetained};
    })()`);
    assert.equal(report.cache.protectedBytes,4096);assert.equal(report.cache.tinyBytes,16);assert.deepEqual(report.cache.lruRetained,{a:true,b:false,c:true});
    for(const [width,height] of [[1280,720],[1920,1080],[3440,1440]]){
        await cdp('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});await browser.frame();
        for(const mode of ['area','count','diversity','occupancy','size']){
            await evaluate(`state().setZoom(state().getZoom().stops[4],'drag')`);await wait('!state().zoomDamping.active');
            await evaluate(`state().setRenderingMode('${mode}')`);await browser.frame();
            const opening=await evaluate(`({mode:state().getState().renderingMode,arrays:state().source.downloads?.filter(d=>d.purpose==='analysis'&&d.path.startsWith('colors/')&&d.bodyBytes>256*1024).length??0,cells:state().preview.spatialStats?.cells??0,regions:state().preview.spatialStats?.visibleRegions??0})`);
            assert.equal(opening.mode,mode);assert.equal(opening.arrays,0,'Unfiltered overview starts no global analytical array');assert.equal(opening.cells,0,'Stop 5 has no spatial draws');assert.equal(opening.regions,0);
            await evaluate(`state().setZoom(state().getZoom().stops[3],'drag')`);
            await wait('!state().zoomDamping.active&&state().preview.spatialStats.active===0&&state().preview.spatialStats.wanted>0&&state().preview.spatialStats.visibleRegions===state().preview.spatialStats.wanted');
            const sample=await evaluate(`({mode:state().getState().renderingMode,width:innerWidth,height:innerHeight,spatial:{...state().preview.spatialStats},aggregate:!!state().preview.spatial.supportsAggregates,locals:state().localReady.size,draws:state().runtime.renderer.info.render.calls})`);report.samples.push(sample);
            if(sample.aggregate)assert.equal(sample.locals,0,'Unfiltered summaries use precomputed cells without local bitmap values');
            else if(mode!=='area')assert.ok(sample.locals>0,'Legacy spatial summaries wait for local authenticated values');
            await evaluate(`state().setZoom(state().getZoom().stops[4],'drag')`);await wait('!state().zoomDamping.active');await browser.frame();assert.equal(await evaluate('state().preview.spatialStats.visibleRegions'),0);
        }
    }
    const globalHashes=await evaluate(`(async()=>{const s=state(),a=await s.source.getAnalyticsIndex(),l=await s.source.getLayerAnalysis();return [l.area.values.sha256,l.parcel.classes.sha256,...['count','diversity','occupancy'].map(m=>a.metrics[m].values.sha256)];})()`);
    assert.equal(requests.some(path=>globalHashes.some(hash=>path.includes(hash+'.pb'))),false,'Opening and all unfiltered modes avoid global value/class payloads');
    assert.equal(errors.length,0,JSON.stringify(errors));
    await fs.writeFile('/tmp/bitmap-streaming-audit.json',JSON.stringify(report,null,2));
    await fs.writeFile('/tmp/bitmap-streaming-audit.png',Buffer.from((await cdp('Page.captureScreenshot',{format:'png'})).data,'base64'));
    console.log(JSON.stringify({samples:report.samples.length,cache:report.cache,requests:requests.length,errors:errors.length}));
}finally{await browser.close();}
