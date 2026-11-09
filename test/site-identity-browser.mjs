import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {browserHarness} from './helpers/browser.mjs';

const browser=await browserHarness(),{cdp,evaluate,wait}=browser;
const build=JSON.parse(await fs.readFile(path.join(browser.dist,'build-info.json'),'utf8'));
const status=JSON.parse(await fs.readFile(path.join(browser.dist,'map-data/status.json'),'utf8'));
const click=async selector=>{
    const point=await evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    await cdp('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',buttons:1,clickCount:1});
    await cdp('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',buttons:0,clickCount:1});
};
try{
    await browser.start();
    await cdp('Emulation.setDeviceMetricsOverride',{width:1600,height:900,deviceScaleFactor:1,mobile:false});
    await cdp('Page.navigate',{url:browser.origin+'/repository/'});
    await wait(`document.querySelectorAll('.footer-totals dd').length===3&&document.querySelectorAll('.footer-totals dd')[1].textContent!=='—'`);
    assert.equal(await evaluate(`document.querySelector('.footer-totals dd').textContent`),(browser.manifest.publishedHeight+1).toLocaleString('en-US'));
    assert.equal(await evaluate(`document.querySelectorAll('.footer-totals dd')[2].textContent`),browser.manifest.regions.length.toLocaleString('en-US'));
    assert.match(await evaluate(`document.querySelectorAll('.footer-totals dd')[1].textContent`),/^\d{1,3}(,\d{3})+$/);
    assert.equal(await evaluate(`document.querySelector('.workspace-name')`),null);
    assert.ok(await evaluate(`(()=>{const a=document.querySelector('.footer-links').getBoundingClientRect(),b=document.querySelector('.footer-totals').getBoundingClientRect(),c=document.querySelector('.build-metadata').getBoundingClientRect();return c.right<b.left&&b.right<a.left&&Math.abs((b.left+b.right)/2-innerWidth/2)<2})()`),'Desktop footer aligns build metadata, exact totals and links in three areas');
    assert.equal(await evaluate(`document.querySelector('.footer-links a').href`),'https://twitter.com/bitlodo');
    assert.equal(await evaluate(`document.querySelector('.footer-links a:last-child').href`),'https://github.com/bitlodo/explorer');
    assert.equal(await evaluate(`document.querySelector('.build-version').textContent`),'v'+build.version);
    assert.equal(await evaluate(`document.querySelector('.build-metadata time').dateTime`),build.builtAt);
    assert.equal(status.snapshot,browser.manifest.snapshot);
    assert.equal(status.publishedHeight,browser.manifest.publishedHeight);
    if(status.syncedHeight>status.publishedHeight){
        await click('.data-status summary');
        await wait(`document.querySelector('.coverage-details').textContent.includes(${JSON.stringify(status.syncedHeight.toLocaleString('en-US'))})`);
        await evaluate(`(()=>{const e=document.querySelector('.atlas-search input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'${status.syncedHeight}');e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
        await evaluate(`document.querySelector('.atlas-search').requestSubmit()`);
        await wait(`document.querySelector('.search-error')?.textContent.includes('synced but not on the map yet')`);
        await click('.data-status summary');
    }
    await click('button[aria-label="Enter fullscreen"]');
    await wait(`document.fullscreenElement?.classList.contains('atlas-app')&&!!document.querySelector('button[aria-label="Exit fullscreen"]')`);
    const fullscreen=await evaluate(`(()=>{const r=document.fullscreenElement.getBoundingClientRect();return{target:document.fullscreenElement.className,app:[r.width,r.height],viewport:[innerWidth,innerHeight]}})()`);
    assert.deepEqual(fullscreen.app,fullscreen.viewport);
    await click('button[aria-label="Exit fullscreen"]');
    await wait(`!document.fullscreenElement&&!!document.querySelector('button[aria-label="Enter fullscreen"]')`);
    await cdp('Emulation.setDeviceMetricsOverride',{width:900,height:700,deviceScaleFactor:1,mobile:false});
    await browser.frame();
    assert.ok(await evaluate(`(()=>{const c=document.querySelector('.footer-links').getBoundingClientRect(),b=document.querySelector('.build-metadata').getBoundingClientRect(),f=document.querySelector('.atlas-footer').getBoundingClientRect(),t=document.querySelector('.footer-totals').getBoundingClientRect();return b.right<c.left&&t.top>=f.top&&b.bottom<=f.bottom&&document.documentElement.scrollWidth===innerWidth})()`),'Footer links and build metadata fit without overlap');
    await fs.writeFile('/tmp/bitmap-site-identity.png',Buffer.from((await cdp('Page.captureScreenshot',{format:'png'})).data,'base64'));
    assert.deepEqual(browser.errors,[]);
    await fs.writeFile('/tmp/bitmap-site-identity.json',JSON.stringify({version:build.version,builtAt:build.builtAt,status,fullscreen,
        scope:'Functional Chrome/SwiftShader checks. Emulated viewport does not establish native window maximization.'},null,2)+'\n');
    console.log('Site identity, data coverage, pending search, fullscreen API and compact footer passed.');
}finally{await browser.close();}
