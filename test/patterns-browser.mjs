import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {browserHarness} from './helpers/browser.mjs';
const browser=await browserHarness(),{evaluate,wait,cdp,frame}=browser;
const attach=`window.state=()=>{const e=document.getElementById('mapCanvas'),key=Object.keys(e).find(k=>k.startsWith('__reactFiber$'));for(let f=e[key];f;f=f.return)for(let h=f.memoizedState;h;h=h.next){const r=h.memoizedState?.current??h.memoizedState;if(r?.controller)return r.controller;}};`;
const choose=async()=>{
    await evaluate(`(()=>{const e=document.querySelector('#rendering-layer');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(e,'patterns');e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await wait("state().getState().renderingMode==='patterns'&&!state().getState().renderingBusy");await frame();
};
try{
    await browser.start();await cdp('Emulation.setDeviceMetricsOverride',{width:1600,height:1000,deviceScaleFactor:1,mobile:false});
    await cdp('Page.navigate',{url:browser.origin+'/repository/'});await wait("!!document.getElementById('mapCanvas')");await evaluate(attach);
    await wait('state()?.getState().ready&&!state().getState().renderingBusy');
    assert.equal(await evaluate("document.querySelector('#rendering-layer option').value"),'patterns');
    assert.equal(await evaluate('!!state().patternsClient'),true,'Default startup initializes Patterns');
    assert.equal(await evaluate('state().getState().renderingMode'),'patterns');
    assert.equal(await evaluate('state().getState().filterMatches'),browser.manifest.publishedHeight+1);
    assert.equal(await evaluate('state().getState().selectedPattern'),undefined);
    assert.equal(await evaluate('state().getState().patternTransactions'),undefined);
    await choose();
    const baseline=await evaluate('[0,2015,2016,89273,403199,403200,403201].map(id=>state().analyticTexture.image.data[id])');
    assert.equal(baseline[0],baseline[5]);assert.ok(await evaluate('state().getState().patternTotal>3000'));
    await wait("document.querySelectorAll('.pattern-thumbnail canvas[style*=visible]').length>=3");
    const counts=await evaluate(`(async()=>{const c=state(),values=(await c.source.getAnalyticsMetric('count')).values;await c.setPatternFilter(2);return {expected:Array.from(values).filter(v=>v===2).length,actual:c.getState().filterMatches};})()`);
    assert.equal(counts.actual,counts.expected);
    const exact=await evaluate(`(async()=>{const c=state(),p=c.getPatternPage(2,0).entries[0];document.querySelector('.pattern-card').click();while(c.getState().filterBusy)await new Promise(r=>setTimeout(r,10));const ids=await c.source.getPatternMatches(p.id),selected=new Set(ids);for(let id=0;id<c.metricValues.length;id++){const actual=c.analyticTexture.image.data[id];if(selected.has(id)?actual!==c.metricValues[id]:actual!==-1)throw Error('Filter changed a selected color or retained an excluded bitmap');}return {id:p.id,expected:ids.length,actual:c.getState().filterMatches,selected:c.getState().selectedPattern};})()`);
    assert.equal(exact.actual,exact.expected);assert.equal(exact.selected,exact.id);
    await evaluate("document.querySelector('.pattern-card[aria-pressed=true]').click()");await wait('!state().getState().filterBusy');
    assert.equal(await evaluate('state().getState().selectedPattern'),undefined);assert.equal(await evaluate('state().getState().filterMatches'),counts.expected);
    await evaluate('state().setPatternFilter(6)');await frame();
    const first=await evaluate("[...document.querySelectorAll('.pattern-card')].map(e=>e.getAttribute('aria-label'))");
    for(let i=0;i<3;i++){await evaluate("(()=>{const l=document.querySelector('.pattern-list');l.scrollTop=l.scrollHeight;l.dispatchEvent(new Event('scroll',{bubbles:true}));})()");await frame();}
    const later=await evaluate("[...document.querySelectorAll('.pattern-card')].map(e=>e.getAttribute('aria-label'))");assert.notDeepEqual(first,later);assert.ok(later.length<=await evaluate("Math.ceil(document.querySelector('.pattern-list').clientHeight/80)+5"));assert.equal(new Set(later).size,later.length);
    assert.ok(await evaluate('state().patternsClient.active<=2'),'Preview consumers are bounded');
    await evaluate('state().setPatternFilter(2,170)');await evaluate('state().setZoom(state().getZoom().stops[3],"drag")');
    await wait('!state().zoomDamping.active&&state().preview.spatialStats.visibleRegions>0');
    assert.equal(await evaluate('state().preview.spatial.exact.metric.kind'),'patterns');
    await evaluate('state().goToBitmap(170)');await wait('state().loadedBitmaps.has(170)&&!state().tween?.isPlaying()');
    assert.ok(await evaluate('state().neighborhoods.get(0).compactParcels.material.uniforms.metricEnabled.value===1'));
    assert.ok(await evaluate('state().runtime.renderer.info.programs.every(p=>p.diagnostics?.runnable!==false)'));
    await evaluate("state().setRenderingMode('area')");assert.equal(await evaluate('!!state().patternsClient'),false);
    await cdp('Page.reload');await browser.delay(500);await wait("!!document.getElementById('mapCanvas')");await evaluate(attach);await wait('state()?.getState().ready&&!state().getState().renderingBusy');await choose();
    assert.deepEqual(await evaluate('[0,2015,2016,89273,403199,403200,403201].map(id=>state().analyticTexture.image.data[id])'),baseline,'Reload preserves every sampled color');
    await evaluate('state().setPatternFilter(2)');await frame();
    await fs.writeFile('/tmp/bitmap-patterns-browser.png',Buffer.from((await cdp('Page.captureScreenshot',{format:'png'})).data,'base64'));
    assert.equal(browser.errors.length,0,JSON.stringify(browser.errors));
    const report={status:'passed',patterns:await evaluate('state().getState().patternTotal'),counts,exact,pagination:true,deterministicReload:true,spatial:true,detail:true,exceptions:browser.errors.length};
    await fs.writeFile('/tmp/bitmap-patterns-browser.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await browser.close();}
