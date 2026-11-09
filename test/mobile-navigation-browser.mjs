import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createServer} from 'vite';
import {clientConfig} from '../vite.config.ts';
import {browserHarness} from './helpers/browser.mjs';

const config=clientConfig(),dev=await createServer({...config,configFile:false,server:{...config.server,port:5398,strictPort:true}});
const browser=await browserHarness({development:true}),{cdp,evaluate,wait,frame,delay}=browser;
const report={gestures:[],layouts:[]};
try{
    await dev.listen();await browser.start();
    await cdp('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
    await cdp('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:5});
    await cdp('Emulation.setUserAgentOverride',{userAgent:'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Mobile Safari/537.36'});
    await cdp('Page.navigate',{url:'http://127.0.0.1:5398/?chunks=off'});
    await wait("!!document.querySelector('#mapCanvas canvas')");
    await evaluate(`window.state=()=>{const e=document.getElementById('mapCanvas'),k=Object.keys(e).find(k=>k.startsWith('__reactFiber$'));for(let f=e[k];f;f=f.return)for(let h=f.memoizedState;h;h=h.next){const r=h.memoizedState?.current??h.memoizedState;if(r?.controller)return r.controller;}};`);
    await wait('state()?.getState().ready&&state().preview?.rootsReady&&!state().tween?.isPlaying()');
    assert.equal(await evaluate('document.querySelector(".inspector").hidden'),true,'Mobile opening leaves the map unobstructed');
    await evaluate('state().scheduler.close();window.inspections=0;state().inspectBitmap=async()=>{window.inspections++};');
    const settle=async()=>{await wait('!state().zoomDamping.active&&!state().tween?.isPlaying()');await frame();};
    const snap=async index=>{await evaluate(`state().setZoom(state().distanceLevels()[${index}],'snap')`);await settle();};
    const touch=async(type,points)=>{await cdp('Input.dispatchTouchEvent',{type,touchPoints:points.map(([id,x,y])=>({id,x,y,radiusX:2,radiusY:2,force:1}))});await frame();};
    const tap=async selector=>{
        const p=await evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2]})()`);
        await touch('touchStart',[[1,...p]]);await touch('touchEnd',[]);await frame();
    };
    const read=()=>evaluate(`(()=>{const s=state();return{height:s.scene.camera.position.y,stops:s.distanceLevels(),target:s.scene.controls.target.toArray(),pointers:s.touchPointers.size,scale:visualViewport.scale}})()`);
    // Native two-finger packets exercise pointer capture and browser gesture routing.
    // Each pinch ends in a fractional scale then must snap to one of the five stops.
    if(!process.env.MAP_MOBILE_LAYOUT_ONLY){
    for(const [index,fraction] of [[4,.68],[3,.32],[2,.67],[1,.35],[0,.7],[2,.34]]){
        await snap(index);
        const initial=await read(),cx=215,cy=425,start=44;
        const destination=initial.stops.at(-1)*(initial.stops[0]/initial.stops.at(-1))**fraction;
        // Scale the initial span to keep both fingers inside a phone screen.
        const span=Math.min(start,135*destination/initial.height),end=span*initial.height/destination;
        await evaluate(`window.pinchAnchor=state().pointerWorld({clientX:${cx},clientY:${cy}});`);
        await touch('touchStart',[[1,cx-span,cy],[2,cx+span,cy]]);
        const samples=[];
        for(let step=1;step<=8;step++){
            const d=span+(end-span)*step/8;
            await touch('touchMove',[[1,cx-d,cy],[2,cx+d,cy]]);samples.push((await read()).height);
        }
        const during=await read();
        assert.ok(Math.abs(Math.log(during.height/destination))<.01,'Pinch continuously follows the finger-distance ratio');
        await touch('touchEnd',[]);await settle();
        const final=await read();
        const stop=final.stops.findIndex(n=>Math.abs(Math.log(n/final.height))<1e-6);
        assert.ok(stop>=0,'Every released pinch settles at an existing stop');
        const error=await evaluate(`(()=>{const s=state(),v=pinchAnchor.clone().project(s.scene.camera),r=s.runtime.renderer.domElement.getBoundingClientRect();return Math.hypot(r.x+(v.x+1)*r.width/2-${cx},r.y+(1-v.y)*r.height/2-${cy})})()`);
        assert.ok(error<1.5,`Pinch and snap retain the ground point at their midpoint: ${error}px`);
        assert.equal(final.pointers,0);assert.equal(final.scale,1,'Pinch zooms the map rather than the page');
        report.gestures.push({index,fraction,stop,anchorPixelError:error,samples});
        console.log(`Pinch ${index} → ${stop}: anchor drift ${error.toFixed(3)} px`);
    }
    assert.equal(await evaluate('window.inspections'),0,'Pinch never inspects a bitmap');
    await snap(2);
    const beforePan=await read();
    await touch('touchStart',[[1,160,440]]);
    for(const x of [180,200,220])await touch('touchMove',[[1,x,470]]);
    await touch('touchEnd',[]);await settle();
    const afterPan=await read();
    assert.ok(Math.hypot(afterPan.target[0]-beforePan.target[0],afterPan.target[2]-beforePan.target[2])>1,'One finger pans the real map');
    assert.ok(Math.abs(Math.log(afterPan.height/beforePan.height))<1e-9,'Pan preserves the zoom stop');
    assert.equal(await evaluate('window.inspections'),0,'Pan never inspects a bitmap');
    // Search deliberately fits arbitrary distances; one-finger input must
    // retain that scale rather than treating a pan/tap as a zoom release.
    await evaluate(`state().animateDistance(state().distanceLevels()[2]*1.17,{duration:0})`);await settle();
    const searchScale=(await read()).height;
    await touch('touchStart',[[1,160,440]]);await touch('touchMove',[[1,180,440]]);await touch('touchEnd',[]);await settle();
    assert.ok(Math.abs(Math.log((await read()).height/searchScale))<1e-9,'One-finger pan preserves a search-fitted scale');
    // A real bitmap tap still reaches inspection, unlike a drag or pinch.
    const bitmap=await evaluate(`(()=>{const s=state(),n=[...s.neighborhoods.values()][0],b=n.data.bitmaps[0];s.scene.camera.position.x=n.position.x+b.x+b.width/2;s.scene.camera.position.z=n.position.z+b.y+b.height/2;s.scene.controls.target.set(s.scene.camera.position.x,0,s.scene.camera.position.z);s.scene.controls.update();s.scene.camera.updateMatrixWorld();const r=s.runtime.renderer.domElement.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    await touch('touchStart',[[1,bitmap.x,bitmap.y]]);await touch('touchEnd',[]);
    await wait('window.inspections===1');
    assert.ok(Math.abs(Math.log((await read()).height/searchScale))<1e-9,'Tap inspection preserves a search-fitted scale');
    // Partial release, one-finger continuation, cancellation and a fresh gesture.
    await touch('touchStart',[[1,140,430],[2,240,430]]);
    await touch('touchMove',[[1,120,430],[2,260,430]]);
    await touch('touchEnd',[[2,260,430]]);
    await touch('touchMove',[[2,270,440]]);
    await touch('touchCancel',[]);await settle();
    assert.equal((await read()).pointers,0);
    assert.equal(await evaluate('state().scene.controls.enabled'),true);
    await touch('touchStart',[[3,140,430],[4,240,430]]);
    await touch('touchMove',[[3,130,430],[4,250,430]]);
    await touch('touchEnd',[]);await settle();
    assert.equal(await evaluate('window.inspections'),1,'Cancellation and lifting either finger never create a tap');
    }
    // Mobile drawers, search, inspector, safe viewport bounds and landscape.
    for(const [width,height] of [[320,740],[390,844],[820,900],[844,390],[1024,390]]){
        await cdp('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:true});await delay(400);await frame();
        await tap('button[aria-label="Toggle map analysis"]');
        assert.notEqual(await evaluate('getComputedStyle(document.querySelector(".atlas-sidebar")).display'),'none');
        await evaluate(`document.querySelector('.atlas-sidebar').scrollTop=document.querySelector('.atlas-sidebar').scrollHeight`);await frame();
        assert.ok(await evaluate(`(()=>{const r=document.querySelector('.atlas-sidebar').getBoundingClientRect(),f=document.querySelector('.pattern-list').getBoundingClientRect();return f.top>=r.top&&f.bottom<=r.bottom})()`),'Pattern filters remain reachable in short landscape screens');
        await evaluate(`document.querySelector('.atlas-sidebar').scrollTop=0`);await frame();
        const center=await evaluate('state().scene.controls.target.toArray()');
        const panel=await evaluate(`(()=>{const e=document.querySelector('.atlas-sidebar'),r=e.getBoundingClientRect();return{x:r.x+100,y:r.y+r.height*.6}})()`);
        await touch('touchStart',[[1,panel.x,panel.y]]);await touch('touchMove',[[1,panel.x,panel.y-50]]);await touch('touchEnd',[]);
        assert.deepEqual(await evaluate('state().scene.controls.target.toArray()'),center,'Scrolling analysis does not pan the map');
        await tap('button[aria-label="Close analysis panel"]');
        assert.equal(await evaluate('getComputedStyle(document.querySelector(".atlas-sidebar")).display'),'none');
        await tap('button[aria-label="Toggle bitmap inspector"]');
        const layout=await evaluate(`(()=>{const rect=s=>{const r=document.querySelector(s).getBoundingClientRect();return{x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height}};return{width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,canvas:rect('#mapCanvas canvas'),zoom:rect('#map-zoom-controls'),search:rect('.atlas-search'),inspector:rect('.inspector'),totals:rect('.footer-totals')}})()`);
        assert.equal(layout.scrollWidth,width,'No horizontal page overflow');
        for(const key of ['canvas','zoom','search','inspector','totals']){
            const r=layout[key];assert.ok(r.x>=0&&r.right<=width+.1&&r.y>=0&&r.bottom<=height+.1,`${key} fits ${width}×${height}: ${JSON.stringify(r)}`);
        }
        assert.ok(layout.inspector.y>=layout.zoom.bottom,'The inspector stays below the zoom controls');
        report.layouts.push(layout);
        console.log(`Mobile controls fit ${width}×${height}`);
        await fs.writeFile(`/tmp/bitmap-mobile-${width}.png`,Buffer.from((await cdp('Page.captureScreenshot',{format:'png'})).data,'base64'));
        await tap('button[aria-label="Hide inspector"]');
    }
    await evaluate(`document.querySelector('#mapCanvas canvas').focus()`);
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('#mapCanvas canvas')).outlineStyle`),'none','Focused canvas has no orange border');
    assert.deepEqual(browser.errors,[]);
    await fs.writeFile('/tmp/bitmap-mobile-navigation.json',JSON.stringify(report,null,2)+'\n');
    console.log(JSON.stringify({status:'passed',gestures:report.gestures.length,layouts:report.layouts.length,maxAnchorPixelError:Math.max(0,...report.gestures.map(g=>g.anchorPixelError)),exceptions:browser.errors.length}));
}finally{await browser.close();await dev.close();}
