import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { browserHarness } from './helpers/browser.mjs';

const browser = await browserHarness();
const { cdp, evaluate, wait, frame } = browser;
try {
    await browser.start();
    await cdp('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
    await cdp('Page.navigate', { url: browser.origin + '/repository/?chunks=off' });
    await wait("!!document.getElementById('mapCanvas')");
    await evaluate(`window.state=()=>{const e=document.getElementById('mapCanvas'),key=Object.keys(e).find(k=>k.startsWith('__reactFiber$'));for(let f=e[key];f;f=f.return)for(let h=f.memoizedState;h;h=h.next){const runtime=h.memoizedState?.current??h.memoizedState;if(runtime?.controller)return runtime.controller;}};
    window.panSnapshot=()=>{const s=state(),c=s.scene.camera,t=s.scene.controls.target,v=s.groundBounds();return{x:c.position.x,z:c.position.z,tx:t.x,tz:t.z,height:c.position.y,view:v,occupied:s.overview.slots.some(r=>r.x<v.x+v.width&&r.x+r.width>v.x&&r.y<v.y+v.height&&r.y+r.height>v.y)};};`);
    await wait(`state()?.overview?.slots.length===${browser.manifest.regions.length}&&!state().tween?.isPlaying()`);
    await wait('state().preview?.rootsReady&&state().source.mode==="static"');
    const canvas = await evaluate('(()=>{const c=state().runtime.renderer.domElement,r=c.getBoundingClientRect();return{width:c.clientWidth,height:c.clientHeight,left:r.left,top:r.top};})()');
    const results = [];
    for (const stop of [1, 2]) {
        const gap = await evaluate(`(()=>{
            const s=state(),regions=s.overview.slots,height=s.distanceLevels()[${stop - 1}];
            const viewHeight=2*height*Math.tan(s.scene.camera.fov*Math.PI/360),viewWidth=viewHeight*s.scene.camera.aspect;
            let best;
            // Find a real interior corridor wide enough to contain the whole viewport.
            for(const region of regions){
                const z=region.y+region.height/2;
                const intervals=regions.filter(r=>r.y<z+viewHeight/2&&r.y+r.height>z-viewHeight/2)
                    .map(r=>[r.x,r.x+r.width]).sort((a,b)=>a[0]-b[0]);
                let edge=intervals[0][1];
                for(const [left,right] of intervals.slice(1)){
                    const width=left-edge;
                    if(width>viewWidth*1.5&&(!best||width<best.width))best={left:edge,right:left,width,z,height,viewWidth,viewHeight};
                    edge=Math.max(edge,right);
                }
            }
            return best;
        })()`);
        assert.ok(gap, `Stop ${stop}: published layout has a gap larger than the viewport`);
        for (const direction of [-1, 1]) {
            const x = direction > 0 ? gap.left - gap.viewWidth * .25 : gap.right + gap.viewWidth * .25;
            await evaluate(`(()=>{const s=state();s.cancelZoom();s.tween?.stop();s.scene.camera.position.set(${x},${gap.height},${gap.z});s.scene.controls.target.set(${x},0,${gap.z});s.scene.controls.update();s.requestUpdate();})()`);
            await frame();
            const initial = await evaluate('panSnapshot()');
            // Three native drags move one canvas width, across the old
            // per-neighborhood containment boundary and into the empty corridor.
            const leftX=canvas.left+150,rightX=leftX+canvas.width/3;
            const startX = direction > 0 ? rightX : leftX, endX = direction > 0 ? leftX : rightX;
            const samples = [];
            for (let gesture = 0; gesture < 3; gesture++) {
                await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: startX, y: 630, button: 'left', buttons: 1, clickCount: 1 });
                for (let step = 1; step <= 4; step++) {
                    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: startX + (endX - startX) * step / 4, y: 630, buttons: 1 });
                    await frame();
                    samples.push(await evaluate('panSnapshot()'));
                }
                await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: endX, y: 630, button: 'left', buttons: 0, clickCount: 1 });
            }
            const final = samples.at(-1), expected = direction * gap.viewWidth;
            await fs.writeFile('/tmp/bitmap-pan-gap-case.json', JSON.stringify({ stop, direction, gap, initial, final, expected, samples }, null, 2) + '\n');
            assert.ok(Math.abs(final.tx - initial.tx - expected) < gap.viewWidth * .001,
                `Stop ${stop}/${direction}: native drag crosses the gap without being clamped: ${JSON.stringify({initial,final,expected,gap})}`);
            assert.equal(final.occupied, false, `Stop ${stop}/${direction}: the entire viewport can lie in the internal gap`);
            let previous = initial;
            for (const sample of samples) {
                assert.ok(Math.abs(direction*(sample.tx-previous.tx)-gap.viewWidth/12)<gap.viewWidth*.001,
                    'Every drag step moves continuously through the gap');
                assert.ok(Math.abs(sample.height - initial.height) < 1e-6, 'Pan preserves zoom height');
                assert.ok(Math.abs(sample.tz - initial.tz) < gap.viewHeight * .00001, 'Horizontal pan preserves its vertical target');
                previous = sample;
            }
            await cdp('Emulation.setDeviceMetricsOverride', { width: 1598, height: 900, deviceScaleFactor: 1, mobile: false });
            await wait(`state().runtime.renderer.domElement.clientWidth===${canvas.width-2}&&state().scene.camera.aspect===${canvas.width-2}/${canvas.height}`);
            const resized = await evaluate('panSnapshot()');
            assert.ok(Math.abs(resized.tx-final.tx)<1e-6&&Math.abs(resized.tz-final.tz)<1e-6, 'Resize does not snap a gap destination to a neighborhood');
            await cdp('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
            await wait(`state().runtime.renderer.domElement.clientWidth===${canvas.width}&&state().scene.camera.aspect===${canvas.width}/${canvas.height}`);
            results.push({ stop, direction, gap, initial, final, resized, samples });
        }
    }
    assert.equal(browser.errors.length, 0, JSON.stringify(browser.errors));
    await fs.writeFile('/tmp/bitmap-pan-gaps.json', JSON.stringify(results, null, 2) + '\n');
    await fs.writeFile('/tmp/bitmap-pan-gap.png', Buffer.from((await cdp('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
    console.log(JSON.stringify({ status: 'passed', stops: [1, 2], directions: ['left', 'right'], cases: results.length, exceptions: browser.errors.length }));
} finally {
    await browser.close();
}
