import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { browserHarness } from './helpers/browser.mjs';

const browser = await browserHarness();
const { cdp, evaluate, wait } = browser;
try {
    await browser.start();
    await cdp('Page.navigate', { url: browser.origin + '/repository/?chunks=off' });
    await wait("!!document.getElementById('mapCanvas')");
    await evaluate(`window.controller=()=>{const e=document.getElementById('mapCanvas'),key=Object.keys(e).find(k=>k.startsWith('__reactFiber$'));for(let f=e[key];f;f=f.return)for(let h=f.memoizedState;h;h=h.next){const runtime=h.memoizedState?.current??h.memoizedState;if(runtime?.controller)return runtime.controller;}};`);
    await wait('controller()?.getState().ready&&!controller().getState().renderingBusy');
    await evaluate(`(async()=>{
        const T=await import('/test-three.js'),s=controller(),n=await s.ensureNeighborhood(0);
        const rect={x:0,y:0,width:128,height:128};
        const cells=Array.from({length:4096},(_,i)=>({x:(i%64)*2,y:Math.floor(i/64)*2,width:2,height:2}));
        const parcels=new n.compactParcels.constructor();
        parcels.setBitmapSizes([rect]);parcels.setLOD(1,1,true);parcels.addBitmap(0,rect,cells);
        const vectors=new s.neighborhoodGeometry.constructor([]);
        vectors.addRegion({neighborhood:0,width:128,height:128,bitmaps:cells},rect);
        for(let t=0;t<=800;t+=20)vectors.updateView(rect,1,1,0,t);
        vectors.material.uniforms.bitmapMargin.value=.5;
        vectors.labels.visible=false;
        for(const layer of [parcels,vectors]){layer.setSizeColorMode(false);layer.material.uniforms.baseColor.value.set('#ffffff');}
        const target=new T.WebGLRenderTarget(192,192,{samples:4});target.texture.colorSpace=T.LinearSRGBColorSpace;
        const camera=new T.PerspectiveCamera(15,1,.1,20000);camera.up.set(0,0,-1);
        window.coverageFixture={T,s,parcels,vectors,target,camera};
    })()`);
    const results = [];
    for (const layer of ['parcels', 'vectors']) {
        for (const pitch of [2.6, 3.4, 5.2, 12]) {
            const result = await evaluate(`(()=>{
                const f=coverageFixture,{T,target,camera}=f,renderer=f.s.runtime.renderer,layer=f.${layer};
                const scene=new T.Scene();scene.add(layer);
                const previous=renderer.getRenderTarget(),tone=renderer.toneMapping,clear=renderer.getClearColor(new T.Color()).clone(),alpha=renderer.getClearAlpha();
                const stats=[],images=[],versions=Object.values((layer.chunks[0]??layer.regions.get(0).mesh).geometry.attributes).map(a=>a.version);
                try{
                    renderer.toneMapping=T.NoToneMapping;renderer.setClearColor(0,1);renderer.setRenderTarget(target);
                    const scale=${pitch}/2,height=192/(2*Math.tan(T.MathUtils.degToRad(15)/2)*scale);
                    layer.material.uniforms.rectanglePixelsPerWorld.value=scale;
                    for(const smoothing of [0,1]){
                        layer.material.uniforms.rectangleSmoothing.value=smoothing;
                        let previousPixels,totalChange=0,sum=0,minMean=Infinity,maxMean=-Infinity,frames=0;
                        for(let frame=0;frame<16;frame++){
                            const pan=frame/16/scale;
                            camera.position.set(64+pan,height,64+pan*.63);camera.lookAt(64+pan,0,64+pan*.63);camera.updateMatrixWorld();
                            // Pixel readback binds the resolved framebuffer; rebind MSAA each frame.
                            renderer.setRenderTarget(target);renderer.clear();renderer.render(scene,camera);
                            const pixels=new Uint8Array(192*192*4);renderer.readRenderTargetPixels(target,0,0,192,192,pixels);
                            let mean=0;
                            for(let y=32;y<160;y++)for(let x=32;x<160;x++){
                                const p=(y*192+x)*4;mean+=pixels[p];
                                if(previousPixels)totalChange+=Math.abs(pixels[p]-previousPixels[p]);
                            }
                            mean/=128*128;sum+=mean;minMean=Math.min(minMean,mean);maxMean=Math.max(maxMean,mean);frames++;
                            if(frame===0)images.push(Array.from(pixels));
                            previousPixels=pixels;
                        }
                        stats.push({smoothing,mean:sum/frames,meanRange:maxMean-minMean,temporalChange:totalChange/(15*128*128)});
                    }
                    const canvas=document.createElement('canvas');canvas.width=384;canvas.height=192;const ctx=canvas.getContext('2d');
                    images.forEach((bytes,i)=>ctx.putImageData(new ImageData(new Uint8ClampedArray(bytes),192,192),i*192,0));
                    const after=Object.values((layer.chunks[0]??layer.regions.get(0).mesh).geometry.attributes).map(a=>a.version);
                    return{stats,image:canvas.toDataURL('image/png').split(',')[1],versions,after,programs:renderer.info.programs.every(p=>p.diagnostics?.runnable!==false)};
                }finally{layer.material.uniforms.rectangleSmoothing.value=1;scene.remove(layer);renderer.setRenderTarget(previous);renderer.setClearColor(clear,alpha);renderer.toneMapping=tone;}
            })()`);
            const { image, ...report } = result;
            results.push({ layer, pitch, ...report });
            await fs.writeFile(`/tmp/bitmap-coverage-${layer}-${pitch}.png`, Buffer.from(image, 'base64'));
            assert.ok(result.programs, `${layer}: shaders compile`);
            assert.deepEqual(result.versions, result.after, `${layer}: pan and smoothing do not upload geometry`);
            const [original, filtered] = result.stats;
            if (pitch >= 4.5) {
                assert.ok(Math.abs(filtered.mean - original.mean) < 5,
                    `${layer}/${pitch}: resolved cells preserve filled area and gaps: ${JSON.stringify(result.stats)}`);
            } else {
                assert.ok(filtered.mean >= original.mean,
                    `${layer}/${pitch}: unresolved gaps must not darken the grid`);
                if (pitch < 3) assert.ok(filtered.mean > original.mean + 20,
                    `${layer}/${pitch}: tiny grids approach their own fill instead of dark bands`);
            }
            if (pitch < 4) {
                assert.ok(filtered.temporalChange < original.temporalChange * .9,
                    `${layer}/${pitch}: subpixel gaps reduce temporal changes without erasing detail: ${JSON.stringify(result.stats)}`);
            } else if (pitch === 12) {
                assert.deepEqual(filtered, {...original,smoothing:1}, `${layer}: resolved gaps retain native MSAA at close zoom`);
            }
        }
    }
    await fs.writeFile('/tmp/bitmap-rectangle-coverage.json', JSON.stringify(results, null, 2) + '\n');
    console.log(JSON.stringify(results));
    await evaluate('coverageFixture.parcels.dispose();coverageFixture.vectors.dispose();coverageFixture.target.dispose();');
    await cdp('Emulation.setDeviceMetricsOverride', { width: 1920, height: 993, deviceScaleFactor: 1, mobile: false });
    await evaluate('controller().goToBitmap(362030)');
    await wait('controller().loadedBitmaps.has(362030)&&controller().arrivalFades.opacityFor(362030)===1&&!controller().tween?.isPlaying()');
    await evaluate('controller().selectBitmap(-1);controller().setZoomFromControl(controller().distanceLevels()[1],"drag")');
    await wait('!controller().getState().renderingBusy&&!controller().zoomDamping.active&&!controller().tween?.isPlaying()');
    await browser.delay(1200);
    for (const smoothing of [0, 1]) {
        await evaluate(`(()=>{const s=controller();s.neighborhoodGeometry.material.uniforms.rectangleSmoothing.value=${smoothing};for(const n of s.neighborhoods.values())if(n.compactParcels)n.compactParcels.material.uniforms.rectangleSmoothing.value=${smoothing};s.scene.render();})()`);
        await browser.frame();
        await fs.writeFile(`/tmp/bitmap-detail-stop2-${smoothing ? 'filtered' : 'original'}.png`,
            Buffer.from((await cdp('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
    }
    assert.equal(browser.errors.length, 0, JSON.stringify(browser.errors));
} finally {
    await browser.close();
}
