import assert from 'node:assert/strict';
import fs from 'node:fs';
import { browserHarness } from './helpers/browser.mjs';

const browser = await browserHarness();
const { origin, errors, cdp, evaluate, wait, frame } = browser;
let ws;

try {
    ws = await browser.start();
    await cdp('Emulation.setDeviceMetricsOverride', { width: Number(process.env.MAP_LOD_WIDTH||1600), height: Number(process.env.MAP_LOD_HEIGHT||900), deviceScaleFactor: 1, mobile: false });
    await cdp('Page.navigate', {url:origin+'/repository/'+(process.env.MAP_SMOKE_DEBUG_ONLY==='off'?'?chunks=off':process.env.MAP_SMOKE_PARCELS==='legacy'?'?parcels=legacy':'')});
    await wait("document.readyState==='complete' && document.getElementById('mapCanvas') && !!document.querySelector('canvas')");
    await evaluate(`window.game=()=>{const e=document.getElementById('mapCanvas'),key=Object.keys(e).find(k=>k.startsWith('__reactFiber$'));for(let f=e[key];f;f=f.return)for(let h=f.memoizedState;h;h=h.next)if((h.memoizedState?.current??h.memoizedState)?.controller)return h.memoizedState.current??h.memoizedState;};window.state=()=>game()?.controller;`);
    await wait(`state()?.overview?.slots.length===${browser.manifest.regions.length} && !state().tween?.isPlaying()`);
    await wait('state().preview?.rootsReady && state().source.mode==="static"');
    const checks=[];
    await evaluate(`window.navSnapshot=()=>{const s=state(),c=s.scene.camera,t=s.scene.controls.target;return{x:c.position.x,z:c.position.z,height:c.position.y,tx:t.x,tz:t.z};};
    window.navCoverage=()=>{const s=state(),v=s.groundBounds(),o=s.scene.occupiedBounds;
    const overlap=r=>({width:Math.max(0,Math.min(v.x+v.width,r.x+r.width)-Math.max(v.x,r.x)),height:Math.max(0,Math.min(v.y+v.height,r.y+r.height)-Math.max(v.y,r.y))});
    const b=overlap(o);return{poleTolerance:s.overviewFrame.height*8e-6,axisX:b.width/Math.min(v.width,o.width),axisY:b.height/Math.min(v.height,o.height),actual:s.overview.slots.some(r=>{const a=overlap(r);return a.width>=.5*Math.min(v.width,r.width)-1e-5&&a.height>=.5*Math.min(v.height,r.height)-1e-5;}),...window.navSnapshot()};};
    window.navPlace=(height,x,z)=>{const s=state();s.cancelZoom();s.tween?.stop();s.scene.camera.position.set(x,height,z);s.scene.controls.target.set(x,0,z);s.scene.controls.update();s.scene.constrainPan();s.requestUpdate();};`);
    // OrbitControls keeps a 1e-6-radian pole offset: allow its subpixel numeric drift, including 4x temporary overscroll.
    const sameCenter=(a,b,label)=>{const epsilon=1e-5+Math.max(a.height||0,b.height||0)*8e-6;assert.ok(Math.abs(a.x-b.x)<epsilon&&Math.abs(a.z-b.z)<epsilon,label+JSON.stringify({a,b}));};
    const coverage=async()=>{const c=await evaluate('navCoverage()');assert.ok(c.axisX>=.5-1e-6&&c.axisY>=.5-1e-6,JSON.stringify(c));assert.ok(Math.abs(c.x-c.tx)<1e-5+c.poleTolerance&&Math.abs(c.z-c.tz)<1e-5+c.poleTolerance,'Camera and target must share X/Z');return c;};
    for(const [width,height] of [[1600,900],[900,1200],[2400,700]]){
        await cdp('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});await frame();
        await wait(`state().viewportSignature.startsWith('${width}:${height}:') && !state().tween?.isPlaying()`);
        const check={width,height,edges:[]};
        // All outer edges and corners remain bounded; internal empty areas are allowed.
        for(const scale of [1,.02])for(const dx of [-1,0,1])for(const dz of [-1,0,1]){
            if(!dx&&!dz)continue;
            await evaluate(`navPlace(Math.max(state().closestDistance,state().overviewFrame.height*${scale}),${dx}*1e9,${dz}*1e9)`);await frame();
            check.edges.push(await coverage());
        }
        // Native mouse drag through OrbitControls, repeatedly past the boundary.
        await evaluate('navPlace(state().overviewFrame.height,state().overviewFrame.x,state().overviewFrame.z)');
        for(let repeat=0;repeat<4;repeat++){
            await cdp('Input.dispatchMouseEvent',{type:'mousePressed',x:160,y:180,button:'left',buttons:1,clickCount:1});
            for(let step=1;step<=5;step++)await cdp('Input.dispatchMouseEvent',{type:'mouseMoved',x:160+(width-420)*step/5,y:180+(height-400)*step/5,buttons:1});
            await cdp('Input.dispatchMouseEvent',{type:'mouseReleased',x:width-260,y:height-220,button:'left',buttons:0,clickCount:1});await frame();
            await coverage();
        }
        check.nativeDrag=await coverage();
        if(width===1600){const shot=await cdp('Page.captureScreenshot',{format:'png'});fs.writeFileSync('/tmp/bitmap-explorer-navigation-boundary.png',Buffer.from(shot.data,'base64'));}
        // Start at a distant real neighborhood so an unwanted Home is detectable.
        await evaluate('(()=>{const r=state().overview.slots[220];navPlace(state().distanceLevels()[2],r.x+r.width/2,r.y+r.height/2);})()');await frame();
        const initial=await evaluate('navSnapshot()');
        for(let i=0;i<4;i++)await cdp('Input.dispatchMouseEvent',{type:'mouseWheel',x:width*.15,y:height*.25,deltaX:0,deltaY:-350});
        // CDP may acknowledge wheel input before the page dispatches it.
        // Require the zoom to have moved before accepting an idle damping state.
        await wait(`state().scene.camera.position.y<${initial.height} && !state().zoomDamping.active`);await frame();
        const near=await evaluate('navSnapshot()');sameCenter(initial,near,'Wheel zoom-in follows camera center, not cursor: ');assert.ok(Math.abs(initial.tx-near.tx)<1e-5&&Math.abs(initial.tz-near.tz)<1e-5,'Wheel must not accumulate drift in its ground target');assert.ok(near.height<initial.height);await coverage();
        // Separate wheel gestures are required to traverse multiple stops.
        for(let i=0;i<4;i++){
            await browser.delay(260);
            const target=await evaluate('(()=>{const s=state();return s.distanceLevels().find(n=>n>s.scene.camera.position.y*(1+1e-6))??s.distanceLevels().at(-1)})()');
            await cdp('Input.dispatchMouseEvent',{type:'mouseWheel',x:width*.8,y:height*.2,deltaX:0,deltaY:500});
            await wait(`Math.abs(Math.log(state().scene.camera.position.y/${target}))<.00001&&!state().zoomDamping.active`);
        }
        await wait(`state().scene.camera.position.y>${near.height} && !state().zoomDamping.active`);await frame();
        const far=await evaluate('navSnapshot()');sameCenter(near,far,'Wheel zoom-out must not recenter: ');assert.ok(Math.abs(near.tx-far.tx)<1e-5&&Math.abs(near.tz-far.tz)<1e-5,'Zoom-out keeps the same ground target');assert.ok(Math.abs(far.height/await evaluate('state().overviewFrame.height')-1)<1e-5);await coverage();
        await evaluate('state().setZoomFromControl(state().distanceLevels()[2],"snap")');await wait('!state().tween?.isPlaying()');
        await evaluate('state().setZoomFromControl(state().distanceLevels().at(-1),"snap")');await wait('!state().tween?.isPlaying()');await frame();
        const slider=await evaluate('navSnapshot()');sameCenter(far,slider,'Slider far stop must not recenter: ');
        await cdp('Input.dispatchMouseEvent',{type:'mousePressed',x:width*.4,y:height*.4,button:'middle',buttons:4,clickCount:1});
        await cdp('Input.dispatchMouseEvent',{type:'mouseMoved',x:width*.4,y:height*.4+100,buttons:4});
        await cdp('Input.dispatchMouseEvent',{type:'mouseReleased',x:width*.4,y:height*.4+100,button:'middle',buttons:0,clickCount:1});
        await wait('!state().zoomDamping.active && !state().middleZoom');await frame();sameCenter(slider,await evaluate('navSnapshot()'),'Middle zoom must preserve center: ');
        // Home remains an explicit request to center the whole map.
        await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'Home',code:'Home',windowsVirtualKeyCode:36});
        await cdp('Input.dispatchKeyEvent',{type:'keyUp',key:'Home',code:'Home',windowsVirtualKeyCode:36});
        await wait('!state().tween?.isPlaying()');await frame();
        const home=await evaluate('navSnapshot()'),target=await evaluate('state().overviewFrame');sameCenter(home,target,'Home centers explicitly: ');
        check.zoom={initial,near,far,slider,home};checks.push(check);
    }
    // Search keeps its explicit navigation behavior.
    await evaluate('state().goToBitmap(806401)');await wait('!state().tween?.isPlaying() && state().neighborhoods.has(400)');await frame();await coverage();
    await evaluate('state().dispose()');assert.deepEqual(errors,[]);
    const result={status:'passed',renderer:'Chrome isolated / SwiftShader',checks,exceptions:errors.length};
    fs.writeFileSync(process.env.MAP_SMOKE_REPORT||'/tmp/bitmap-explorer-navigation-browser.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({status:result.status,resolutions:checks.map(c=>[c.width,c.height]),exceptions:errors.length}));
} catch(error){console.error(error);if(ws?.readyState===1)console.error(await evaluate('({camera:window.navSnapshot?.(),coverage:window.navCoverage?.(),text:document.body.innerText})').catch(String));process.exitCode=1;} finally{await browser.close();}
