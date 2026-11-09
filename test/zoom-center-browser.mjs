import assert from 'node:assert/strict';
import fs from 'node:fs';
import { browserHarness } from './helpers/browser.mjs';

const browser = await browserHarness();
const { origin, errors, cdp, evaluate, wait, frame, delay } = browser;
let ws;

try {
    ws = await browser.start();
    await cdp('Emulation.setDeviceMetricsOverride', { width: Number(process.env.MAP_LOD_WIDTH||1600), height: Number(process.env.MAP_LOD_HEIGHT||900), deviceScaleFactor: 1, mobile: false });
    await cdp('Page.navigate', {url:origin+'/repository/'+(process.env.MAP_SMOKE_DEBUG_ONLY==='off'?'?chunks=off':process.env.MAP_SMOKE_PARCELS==='legacy'?'?parcels=legacy':'')});
    await wait("document.readyState==='complete' && document.getElementById('mapCanvas') && !!document.querySelector('canvas')");
    await evaluate(`window.game=()=>{const e=document.getElementById('mapCanvas'),key=Object.keys(e).find(k=>k.startsWith('__reactFiber$'));for(let f=e[key];f;f=f.return)for(let h=f.memoizedState;h;h=h.next)if((h.memoizedState?.current??h.memoizedState)?.controller)return h.memoizedState.current??h.memoizedState;};window.state=()=>game()?.controller;`);
    await wait(`state()?.overview?.slots.length===${browser.manifest.regions.length} && !state().tween?.isPlaying()`);
    await wait('state().preview?.rootsReady && state().source.mode==="static"');

    const viewport=[Number(process.env.MAP_LOD_WIDTH||1600),Number(process.env.MAP_LOD_HEIGHT||900)];
    const install=()=>evaluate(`window.readZoomCenter=()=>{const s=state(),c=s.scene.camera,t=s.scene.controls.target;return{x:c.position.x,z:c.position.z,tx:t.x,tz:t.z,height:c.position.y,pixels:s.pixelsPerWorld(),panConstraints:window.zoomPanCalls||0};};`);
    await install();
    // Reproduce the reported route from an actual page refresh, without a search or pan.
    await evaluate('window.beforeZoomReload=true');
    await cdp('Page.reload',{ignoreCache:true});
    await wait("!window.beforeZoomReload && document.readyState==='complete' && !!document.getElementById('mapCanvas')");
    await evaluate(`window.game=()=>{const e=document.getElementById('mapCanvas'),key=Object.keys(e).find(k=>k.startsWith('__reactFiber$'));for(let f=e[key];f;f=f.return)for(let h=f.memoizedState;h;h=h.next)if((h.memoizedState?.current??h.memoizedState)?.controller)return h.memoizedState.current??h.memoizedState;};window.state=()=>game()?.controller;`);
    await wait(`state()?.overview?.slots.length===${browser.manifest.regions.length} && state().preview?.rootsReady && !state().tween?.isPlaying()`);await frame();await install();
    await evaluate('window.zoomPanCalls=0;window.zoomConstrainPan=state().scene.constrainPan;state().scene.constrainPan=()=>{window.zoomPanCalls++;window.zoomConstrainPan();}');
    await evaluate('window.zoomCenterFrames=[];window.zoomCenterRecording=true;window.recordZoomCenter=()=>{if(!window.zoomCenterRecording)return;window.zoomCenterFrames.push(readZoomCenter());requestAnimationFrame(recordZoomCenter);};recordZoomCenter()');
    const initial=await evaluate('readZoomCenter()');
    const genesis=await evaluate('(async()=>{const s=state(),n=await s.source.getNeighborhood(0),b=n.bitmaps[0],slot=s.overview.slots[0],c=s.scene.camera;return{x:slot.x+b.x+b.width/2,z:slot.y+b.y+b.height/2,screen:c.position.clone().set(slot.x+b.x+b.width/2,0,slot.y+b.y+b.height/2).project(c).toArray(),maxMapEdge:Math.max(...s.overview.slots.flatMap(r=>[[r.x,r.y],[r.x+r.width,r.y],[r.x,r.y+r.height],[r.x+r.width,r.y+r.height]].flatMap(([x,z])=>{const p=c.position.clone().set(x,0,z).project(c);return[Math.abs(p.x),Math.abs(p.y)];}))),detailedRegions:s.neighborhoods.size,parcelJobs:s.scheduler.desiredCount};})()');
    assert.ok(Math.abs(initial.tx-genesis.x)<1e-6&&Math.abs(initial.tz-genesis.z)<1e-6,'Startup target must be the actual bitmap 0 center');
    assert.ok(Math.abs(genesis.screen[0])<1e-6&&Math.abs(genesis.screen[1])<1e-6,'Bitmap 0 starts at the screen center');
    assert.ok(genesis.maxMapEdge<=.90001,'The entire map still fits with its overview margin');
    assert.equal(genesis.detailedRegions,0);assert.equal(genesis.parcelJobs,0,'The startup reference must not materialize parcels');
    const slider=await evaluate('(()=>{const r=document.getElementById("map-zoom-slider").getBoundingClientRect(),d=document.querySelector("[data-zoom-drag]").getBoundingClientRect();return{left:r.left+9,travel:r.width-18,y:d.top+d.height/2};})()'),sliderAt=f=>({x:slider.left+f*slider.travel,y:slider.y});
    const samples=[];
    await cdp('Input.dispatchMouseEvent',{type:'mousePressed',...sliderAt(0),button:'left',buttons:1,clickCount:1});
    for(const position of [0,.15,.3,.45,.6,.75,.85,.9,.94,.97,.99,1]){
      await cdp('Input.dispatchMouseEvent',{type:'mouseMoved',...sliderAt(position),buttons:1});await frame();samples.push({...await evaluate('readZoomCenter()'),position});
    }
    await cdp('Input.dispatchMouseEvent',{type:'mouseReleased',...sliderAt(1),button:'left',buttons:0,clickCount:1});await wait('!state().zoomDamping.active');await frame();
    const closest=await evaluate('readZoomCenter()');await delay(300);await frame();const paused=await evaluate('readZoomCenter()');
    const frames=await evaluate('window.zoomCenterRecording=false;window.zoomCenterFrames');
    const maxTargetDrift=Math.max(...[...frames,...samples,closest,paused].map(p=>Math.hypot(p.tx-initial.tx,p.tz-initial.tz)));
    fs.writeFileSync(process.env.MAP_SMOKE_TRACE||'/tmp/bitmap-explorer-zoom-center-trace.json',JSON.stringify({viewport,initial,samples,closest,paused,maxTargetDrift},null,2)+'\n');
    assert.ok(maxTargetDrift<1e-5,'Zoom must preserve the original target on every frame after refresh; drift='+maxTargetDrift);
    for(const p of samples)assert.ok(Math.hypot(p.x-initial.x,p.z-initial.z)*p.pixels<.01,'Slider must preserve camera X/Z as well as its target');
    assert.ok(samples.every(p=>p.panConstraints===0),'Zoom frames must not apply pan containment');
    assert.equal(paused.tx,closest.tx);assert.equal(paused.tz,closest.tz);
    // Reverse the slider, then exercise buttons, wheel, middle drag and keyboard at the same center.
    const otherControls=[];
    await evaluate('state().setZoomFromControl(state().distanceLevels()[3],"snap")');await wait('!state().tween?.isPlaying()');await frame();otherControls.push({control:'snap',...await evaluate('readZoomCenter()')});
    await evaluate(`(()=>{const canvas=state().runtime.renderer.domElement;for(let i=0;i<3;i++)canvas.dispatchEvent(new WheelEvent('wheel',{deltaY:-250,clientX:${viewport[0]*.4},clientY:${viewport[1]*.4},bubbles:true,cancelable:true}));})()`);
    await wait('state().zoomDamping.active');await wait('!state().zoomDamping.active');await frame();otherControls.push({control:'wheel',...await evaluate('readZoomCenter()')});
    const beforeMiddle=await evaluate('readZoomCenter()');
    const middleX=viewport[0]*.4,middleY=viewport[1]*.6;
    await cdp('Input.dispatchMouseEvent',{type:'mousePressed',x:middleX,y:middleY,button:'middle',buttons:4,clickCount:1});
    await cdp('Input.dispatchMouseEvent',{type:'mouseMoved',x:middleX,y:middleY-80,buttons:4});await frame();
    await cdp('Input.dispatchMouseEvent',{type:'mouseReleased',x:middleX,y:middleY-80,button:'middle',buttons:0,clickCount:1});await wait('!state().zoomDamping.active');await frame();otherControls.push({control:'middle',...await evaluate('readZoomCenter()')});
    await evaluate('document.getElementById("map-zoom-slider").focus()');await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'End',code:'End'});await cdp('Input.dispatchKeyEvent',{type:'keyUp',key:'End',code:'End'});await wait('!state().tween?.isPlaying()');await frame();otherControls.push({control:'keyboard',...await evaluate('readZoomCenter()')});
    assert.ok(Math.hypot(otherControls[0].tx-initial.tx,otherControls[0].tz-initial.tz)<1e-5,'Slider snap retains its target');
    assert.ok(Math.hypot(beforeMiddle.tx-initial.tx,beforeMiddle.tz-initial.tz)>1,'Wheel follows the cursor');
    assert.ok(Math.hypot(otherControls[3].tx-otherControls[2].tx,otherControls[3].tz-otherControls[2].tz)<1e-5,'Keyboard zoom retains the target after mouse zoom');
    // A genuine map pan must still move the target and enforce the map limits.
    await evaluate('state().setZoomFromControl(state().distanceLevels()[2],"snap")');await wait('!state().tween?.isPlaying()');await frame();
    const panStart=await evaluate('readZoomCenter()'),panX=viewport[0]*.35,panY=viewport[1]*.4;
    await cdp('Input.dispatchMouseEvent',{type:'mousePressed',x:panX,y:panY,button:'left',buttons:1,clickCount:1});
    for(const fraction of [.25,.5,.75,1]){await cdp('Input.dispatchMouseEvent',{type:'mouseMoved',x:panX+viewport[0]*.2*fraction,y:panY+viewport[1]*.15*fraction,buttons:1});await frame();}
    await cdp('Input.dispatchMouseEvent',{type:'mouseReleased',x:panX+viewport[0]*.2,y:panY+viewport[1]*.15,button:'left',buttons:0,clickCount:1});await frame();
    const panEnd=await evaluate('readZoomCenter()');assert.ok(Math.hypot(panEnd.tx-panStart.tx,panEnd.tz-panStart.tz)>10,'Real panning still moves the map');assert.ok(panEnd.panConstraints>panStart.panConstraints,'Real pan still invokes the containment rule');
    const panCoverage=await evaluate('(()=>{const s=state(),v=s.groundBounds();const r=s.scene.occupiedBounds;return Math.max(0,Math.min(v.x+v.width,r.x+r.width)-Math.max(v.x,r.x))>=.5*Math.min(v.width,r.width)-1e-5&&Math.max(0,Math.min(v.y+v.height,r.y+r.height)-Math.max(v.y,r.y))>=.5*Math.min(v.height,r.height)-1e-5})()');assert.ok(panCoverage,'Pan remains within the occupied outer bounds');
    await evaluate('state().setZoomFromControl(state().distanceLevels()[0],"snap")');await wait('!state().tween?.isPlaying()');await frame();const afterPanZoom=await evaluate('readZoomCenter()');assert.ok(Math.hypot(afterPanZoom.tx-panEnd.tx,afterPanZoom.tz-panEnd.tz)<1e-5,'Zoom preserves an off-center pan destination too');assert.equal(afterPanZoom.panConstraints,panEnd.panConstraints,'Zoom must not clamp the destination chosen by pan');
    await evaluate('document.getElementById("map-zoom-slider").blur()');await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'Home',code:'Home'});await cdp('Input.dispatchKeyEvent',{type:'keyUp',key:'Home',code:'Home'});await wait('!state().tween?.isPlaying()');await frame();
    const home=await evaluate('({...readZoomCenter(),frame:state().overviewFrame})');assert.ok(Math.abs(home.tx-home.frame.x)<1e-5&&Math.abs(home.tz-home.frame.z)<1e-5,'Home still selects the overview center explicitly');
    await evaluate('state().goToBitmap(170)');await wait('!state().tween?.isPlaying() && state().neighborhoods.has(0)');await frame();
    const search=await evaluate('(()=>{const n=state().neighborhoods.get(0),b=n.data.bitmaps[170];return{...readZoomCenter(),expectedX:n.position.x+b.x+b.width/2,expectedZ:n.position.z+b.y+b.height/2};})()');assert.ok(Math.abs(search.tx-search.expectedX)<1e-5&&Math.abs(search.tz-search.expectedZ)<1e-5,'Search still focuses the canonical bitmap explicitly');
    await evaluate('state().dispose()');assert.deepEqual(errors,[]);
    const result={status:'passed',renderer:'Chrome isolated / SwiftShader',viewport,genesis,initial,samples,closest,paused,maxTargetDrift,frames:frames.length,otherControls,panStart,panEnd,panCoverage,afterPanZoom,home,search,exceptions:errors.length};fs.writeFileSync(process.env.MAP_SMOKE_REPORT||'/tmp/bitmap-explorer-zoom-center-browser.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({status:'passed',viewport,sliderSamples:samples.length,frames:frames.length,maxTargetDrift,panCoverage,exceptions:errors.length}));
} catch(error){console.error(error);if(ws?.readyState===1)console.error(await evaluate('({camera:window.readZoomCenter?.(),text:document.body.innerText})').catch(String));process.exitCode=1;} finally{await browser.close();}
