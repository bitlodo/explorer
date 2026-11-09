import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {browserHarness} from './helpers/browser.mjs';

const browser=await browserHarness();
const {cdp,evaluate,wait}=browser;
try {
    await browser.start();
    await cdp('Emulation.setDeviceMetricsOverride',{width:1920,height:993,deviceScaleFactor:1,mobile:false});
    await cdp('Page.navigate',{url:browser.origin+'/repository/?chunks=off'});
    await wait("!!document.getElementById('mapCanvas')");
    await evaluate("window.state=()=>{const e=document.getElementById('mapCanvas'),k=Object.keys(e).find(k=>k.startsWith('__reactFiber$'));for(let f=e[k];f;f=f.return)for(let h=f.memoizedState;h;h=h.next){const r=h.memoizedState?.current??h.memoizedState;if(r?.controller)return r.controller;}}");
    await wait('state()?.getState().ready&&!state().tween?.isPlaying()');
    const fixture=await evaluate('('+ (async function(){
        const T=await import('/test-three.js'),s=state(),n=await s.ensureNeighborhood(0),renderer=s.runtime.renderer;
        const layer=new n.compactParcels.constructor(),rect={x:0,y:0,width:100,height:100};
        layer.setBitmapSizes([rect]);layer.addBitmap(0,rect,Array.from({length:10000},(_,i)=>({x:i%100,y:Math.floor(i/100),width:1,height:1})));
        layer.material.uniforms.baseColor.value.set('#f5a340');
        const scene=new T.Scene();scene.add(layer);
        const camera=new T.PerspectiveCamera(15,1,.1,20000);camera.up.set(0,0,-1);
        const target=new T.WebGLRenderTarget(240,240,{samples:4});target.texture.colorSpace=T.LinearSRGBColorSpace;
        const previous=renderer.getRenderTarget(),tone=renderer.toneMapping,clear=renderer.getClearColor(new T.Color()).clone(),alpha=renderer.getClearAlpha();
        const images=[],results=[];
        const aligner=Object.create(s.scene);aligner.camera=camera;aligner.renderer={domElement:{width:240,height:240}};aligner.pixelAnchor=new T.Vector3();
        try{
            renderer.toneMapping=T.NoToneMapping;renderer.setClearColor('#17191d',1);
            const unit=240/(2*Math.tan(Math.PI/24));
            for(const [scale,aligned] of [[3.8614718614718613,false],[6,false],[6,true]]){
                camera.clearViewOffset();
                layer.setLOD(scale,1,true);
                const samples=[];let first;
                for(const phase of [0,.02,.04,.07,.19,.37]){
                    camera.position.set(50+phase,unit/scale,50+phase*.63);camera.lookAt(50+phase,0,50+phase*.63);camera.updateMatrixWorld();aligner.alignParcelPixels(aligned);
                    renderer.setRenderTarget(target);renderer.clear();renderer.render(scene,camera);
                    const pixels=new Uint8Array(240*240*4);renderer.readRenderTargetPixels(target,0,0,240,240,pixels);
                    let max=0,total=0,count=0;
                    for(let y=30;y<204;y++)for(let x=30;x<204;x++){
                        const p=(y*240+x)*4;
                        for(const shift of [6,6*240]){
                            const d=Math.abs(pixels[p]-pixels[p+shift*4]);max=Math.max(max,d);total+=d;count++;
                        }
                    }
                    let firstDifference=0,mean=0;
                    for(let y=30;y<204;y++)for(let x=30;x<204;x++){const p=(y*240+x)*4;mean+=pixels[p];if(first)firstDifference=Math.max(firstDifference,Math.abs(pixels[p]-first[p]));}
                    first??=pixels;
                    samples.push({phase,maxRepeatError:max,meanRepeatError:total/count,firstDifference,mean:mean/(174*174)});
                    if(phase===0)images.push(pixels);
                }
                results.push({scale,aligned,samples});
            }
            const minified=[];
            camera.clearViewOffset();
            for(const scale of [.65,1.1,1.73,2.49]){
                layer.setLOD(scale,1,true);
                const modes=[];
                for(const smoothing of [0,1]){
                    layer.material.uniforms.rectangleSmoothing.value=smoothing;
                    let min=255,max=0,minMean=255,maxMean=0;
                    for(const phase of [0,.07,.19,.37]){
                        camera.position.set(50+phase,unit/scale,50+phase*.63);camera.lookAt(50+phase,0,50+phase*.63);camera.updateMatrixWorld();
                        renderer.setRenderTarget(target);renderer.clear();renderer.render(scene,camera);
                        const pixels=new Uint8Array(240*240*4);renderer.readRenderTargetPixels(target,0,0,240,240,pixels);
                        let sum=0;
                        for(let y=104;y<136;y++)for(let x=104;x<136;x++){const value=pixels[(y*240+x)*4];sum+=value;min=Math.min(min,value);max=Math.max(max,value);}
                        minMean=Math.min(minMean,sum/1024);maxMean=Math.max(maxMean,sum/1024);
                    }
                    modes.push({smoothing,spatialRange:max-min,temporalMeanRange:maxMean-minMean,minMean});
                }
                minified.push({scale,modes});
            }
            layer.material.uniforms.rectangleSmoothing.value=1;
            const canvas=document.createElement('canvas');canvas.width=720;canvas.height=240;
            const ctx=canvas.getContext('2d');images.forEach((bytes,i)=>ctx.putImageData(new ImageData(new Uint8ClampedArray(bytes),240,240),i*240,0));
            return {results,minified,image:canvas.toDataURL('image/png').split(',')[1],programs:renderer.info.programs.every(p=>p.diagnostics?.runnable!==false)};
        }finally{layer.dispose();target.dispose();renderer.setRenderTarget(previous);renderer.setClearColor(clear,alpha);renderer.toneMapping=tone;}
    }).toString()+')()');
    await fs.writeFile('/tmp/bitmap-pixel-zoom-comparison.png',Buffer.from(fixture.image,'base64'));
    assert.ok(fixture.programs,'Shaders compile');
    assert.ok(fixture.minified.every(r=>r.modes[1].spatialRange<=2&&r.modes[1].temporalMeanRange<=1),'Unresolved grids must have uniform stable fill: '+JSON.stringify(fixture.minified));
    assert.ok(fixture.results.slice(1).every(r=>r.samples.every(s=>s.maxRepeatError<=2)),JSON.stringify(fixture.results));
    assert.ok(fixture.results[2].samples.filter(s=>s.phase<=.07).every(s=>s.firstDifference<=2),'Subpixel pan must retain identical aligned pixels');
    assert.ok(Math.max(...fixture.results[2].samples.map(s=>s.mean))-Math.min(...fixture.results[2].samples.map(s=>s.mean))<1,'Aligned pan must retain brightness');
    await evaluate('state().goToBitmap(892773)');
    await wait('state().loadedBitmaps.has(892773)&&!state().tween?.isPlaying()');
    await evaluate('state().selectBitmap(-1);state().setZoomFromControl(state().distanceLevels()[0],"drag")');
    await browser.frame();
    const resolutions=[];
    for(const [width,height] of [[1920,993],[1365,993],[1280,720],[900,1200],[3840,2160]]){
        await cdp('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
        await browser.frame();
        await wait('!state().tween?.isPlaying()');
        await browser.frame();
        const result=await evaluate('('+function(){
            const s=state(),camera=s.scene.camera,canvas=s.runtime.renderer.domElement;
            const a=camera.position.clone().set(camera.position.x,0,camera.position.z).project(camera);
            const b=camera.position.clone().set(camera.position.x+1,0,camera.position.z).project(camera);
            const anchor=camera.position.clone().set(Math.round(camera.position.x*2)/2,0,Math.round(camera.position.z*2)/2).project(camera);
            const px=(anchor.x+1)*canvas.width/2,py=(1-anchor.y)*canvas.height/2;
            const center=s.scene.getPointerRaycast({x:0,y:0}),bounds=s.groundBounds();
            const boundsError=Math.max(Math.abs(center.x-bounds.x-bounds.width/2),Math.abs(center.z-bounds.y-bounds.height/2));
            const hit=s.scene.getPointerRaycast({x:.17,y:-.23}).project(camera);
            return {boundsError,phaseError:Math.max(Math.abs(px-Math.round(px)),Math.abs(py-Math.round(py))),pickingError:Math.max(Math.abs(hit.x-.17),Math.abs(hit.y+.23)),width:canvas.width,height:canvas.height,pixels:s.pixelsPerWorld(),projectedPitch:(b.x-a.x)*canvas.width/2,stops:s.distanceLevels().length,aligned:camera.view?.enabled};
        }.toString()+')()');
        assert.ok(Math.abs(result.pixels-6)<1e-5,JSON.stringify(result));
        assert.ok(Math.abs(result.projectedPitch-6)<1e-4,JSON.stringify(result));
        assert.equal(result.stops,5);assert.equal(result.aligned,true);assert.ok(result.boundsError<.001,JSON.stringify(result));assert.ok(result.phaseError<1e-5,JSON.stringify(result));assert.ok(result.pickingError<1e-6,JSON.stringify(result));resolutions.push(result);
        if(width===1920)await fs.writeFile('/tmp/bitmap-pixel-zoom-map.png',Buffer.from((await cdp('Page.captureScreenshot',{format:'png'})).data,'base64'));
    }
    await cdp('Emulation.setDeviceMetricsOverride',{width:1920,height:993,deviceScaleFactor:1,mobile:false});await browser.frame();await wait('!state().tween?.isPlaying()');
    const target=await evaluate('state().scene.controls.target.toArray()');
    await evaluate('state().setZoomFromControl(state().distanceLevels()[1],"drag")');await browser.frame();
    const zoomed=await evaluate('({aligned:state().scene.camera.view?.enabled,target:state().scene.controls.target.toArray()})');
    assert.equal(zoomed.aligned,false);assert.deepEqual(zoomed.target,target,'Clearing pixel alignment preserves the zoom target');
    await wait('state().arrivalFades.opacityFor(892773)===1');await browser.frame();
    await fs.writeFile('/tmp/bitmap-parcel-stop2-filtered.png',Buffer.from((await cdp('Page.captureScreenshot',{format:'png'})).data,'base64'));
    assert.equal(browser.errors.length,0,JSON.stringify(browser.errors));
    console.log(JSON.stringify({fixture:fixture.results,minified:fixture.minified,resolutions,errors:browser.errors.length}));
}finally{await browser.close();}
