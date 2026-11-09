import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { browserHarness } from './helpers/browser.mjs';

const browser=await browserHarness();
const {cdp,evaluate,wait}=browser;
try{
    await browser.start();
    await cdp('Page.navigate',{url:browser.origin+'/repository/'});
    await wait("!!document.getElementById('mapCanvas')");
    await evaluate(`window.controller=()=>{const e=document.getElementById('mapCanvas'),key=Object.keys(e).find(k=>k.startsWith('__reactFiber$'));for(let f=e[key];f;f=f.return)for(let h=f.memoizedState;h;h=h.next){const runtime=h.memoizedState?.current??h.memoizedState;if(runtime?.controller)return runtime.controller;}};`);
    await wait('controller()?.getState().ready&&!controller().getState().renderingBusy');
    const result=await evaluate(`(async()=>{
        const T=await import('/test-three.js'),s=controller(),renderer=s.runtime.renderer;
        const n=await s.ensureNeighborhood(0),parcel=new n.compactParcels.constructor();
        // The exact area and dimensions of the reported maximum-area bitmap.
        const rect={x:0,y:0,width:378,height:386};
        parcel.setBitmapSizes([rect]);parcel.setLOD(1,1,true);parcel.addBitmap(0,rect,[rect]);
        const vectors=new s.neighborhoodGeometry.constructor([rect]);
        vectors.addRegion({neighborhood:0,width:378,height:386,bitmaps:[rect]},rect);
        for(let t=0;t<=800;t+=20)vectors.updateView(rect,1,1,0,t);
        vectors.labels.visible=false;
        const metric=new T.DataTexture(Float32Array.of(Math.fround(5.123456)),1,1,T.RedFormat,T.FloatType);
        metric.minFilter=metric.magFilter=T.NearestFilter;metric.needsUpdate=true;
        const cases=[],neutral=new T.Color('#24272d').toArray().map(v=>Math.round(v*255));
        const scene=new T.Scene();
        const target=new T.WebGLRenderTarget(960,960);target.texture.colorSpace=T.LinearSRGBColorSpace;
        const camera=new T.PerspectiveCamera(15,1,.1,20000);camera.up.set(0,1,0);
        const previous=renderer.getRenderTarget(),tone=renderer.toneMapping,clear=renderer.getClearColor(new T.Color()).clone(),alpha=renderer.getClearAlpha();
        try{
            renderer.toneMapping=T.NoToneMapping;renderer.setClearColor(0,0);renderer.setRenderTarget(target);
            for(const [name,layer] of [['parcels',parcel],['vectors',vectors]]){
                scene.add(layer);layer.setSizeColors(['#ffffff','#ffffff']);
                for(const mode of ['maximum-area','excluded-area','metric-endpoint','excluded-metric','excluded-size']){
                    const endpoint=Math.fround(5.123456),disabled=mode.startsWith('excluded');
                    metric.image.data[0]=endpoint;metric.needsUpdate=true;
                    layer.setParcelClasses(undefined);layer.setBitmapSelected?.(0,false);
                    layer.setSizeColorMode(false);layer.setBitmapAreaMode(mode.includes('area'),145908,1);
                    if(mode==='maximum-area')layer.setAnalytic(undefined,9,9);
                    else if(mode==='excluded-area')layer.setAnalytic(undefined,1,8.99);
                    else if(mode==='excluded-size'){layer.setAnalytic(undefined);layer.setParcelClasses(new T.DataTexture(Float32Array.of(5,0),1,1,T.RGFormat,T.FloatType),7,9);const t=layer.material.uniforms.parcelValues.value;t.needsUpdate=true;}
                    else{const bound=mode==='metric-endpoint'?endpoint:9;layer.setAnalytic(metric,bound,bound);}
                    if(mode.includes('metric'))layer.setSizeColors(Array(9).fill('#ffffff'));
                    const frames=[];
                    for(let i=0;i<20;i++){
                        if(disabled){
                            const colors=i%2?['#ff0000','#ffff00','#00ff00','#00ffff','#0000ff','#ff00ff','#ffffff','#000000','#ff0000']:Array(9).fill('#00ff00');
                            layer.setSizeColors(mode==='excluded-area'?colors.slice(0,2):colors);layer.setBitmapSelected?.(0,true);
                            if(mode==='excluded-metric'){metric.image.data[0]=[1,3,5,7,8][i%5];metric.needsUpdate=true;}
                        }
                        const x=189+Math.sin(i*.71)*12,z=193+Math.cos(i*.53)*12,h=1680+i*.31;
                        camera.position.set(x,h,z+.001*h);camera.lookAt(x,0,z);camera.updateMatrixWorld();
                        // Test filter membership inside the rectangle, excluding
                        // the intentional background-colored bitmap outline.
                        const corners=[[0,0],[378,0],[0,386],[378,386]].map(([x,z])=>new T.Vector3(x,0,z).project(camera));
                        const left=Math.ceil(Math.min(...corners.map(p=>(p.x+1)*480))+5),right=Math.floor(Math.max(...corners.map(p=>(p.x+1)*480))-5);
                        const bottom=Math.ceil(Math.min(...corners.map(p=>(p.y+1)*480))+5),top=Math.floor(Math.max(...corners.map(p=>(p.y+1)*480))-5);
                        renderer.clear();renderer.render(scene,camera);
                        const pixels=new Uint8Array(960*960*4);renderer.readRenderTargetPixels(target,0,0,960,960,pixels);
                        let covered=0,bright=0,dark=0,wrongNeutral=0;
                        for(let p=0;p<pixels.length;p+=4){const x=(p/4)%960,y=Math.floor(p/(4*960));if(x<left||x>right||y<bottom||y>top||pixels[p+3]!==255)continue;covered++;if(pixels[p]>250)bright++;if(pixels[p]<50)dark++;if(disabled&&(Math.abs(pixels[p]-neutral[0])>1||Math.abs(pixels[p+1]-neutral[1])>1||Math.abs(pixels[p+2]-neutral[2])>1))wrongNeutral++;}
                        frames.push({frame:i,covered,bright,dark,wrongNeutral});
                    }
                    cases.push({renderer:name,mode,frames});
                    if(mode==='excluded-size')layer.material.uniforms.parcelValues.value.dispose();
                }
                scene.remove(layer);
            }
            return{cases,programs:renderer.info.programs.every(p=>p.diagnostics?.runnable!==false)};
        }finally{renderer.setRenderTarget(previous);renderer.setClearColor(clear,alpha);renderer.toneMapping=tone;target.dispose();metric.dispose();parcel.dispose();vectors.dispose();}
    })()`);
    await fs.writeFile('/tmp/bitmap-filter-stability.json',JSON.stringify(result,null,2)+'\n');
    assert.ok(result.programs,'Shaders compile');
    for(const item of result.cases){
        assert.ok(item.frames.every(f=>f.covered>500000),`${item.renderer}/${item.mode}: substantial bitmap interiors are covered`);
        const selected=!item.mode.startsWith('excluded');
        assert.ok(item.frames.every(f=>(selected?f.bright:f.dark)===f.covered),`${item.renderer}/${item.mode}: filter membership must stay constant throughout the rectangle during pan and zoom`);
        if(!selected)assert.ok(item.frames.every(f=>f.wrongNeutral===0),`${item.renderer}/${item.mode}: excluded pixels use the same neutral color across palettes, values and hover`);
    }
    console.log(JSON.stringify({cases:result.cases.map(c=>({renderer:c.renderer,mode:c.mode,frames:c.frames.length,wrongPixels:c.frames.reduce((n,f)=>n+f.covered-(c.mode.startsWith('excluded')?f.dark:f.bright),0)})),programs:result.programs}));
    await cdp('Emulation.setDeviceMetricsOverride',{width:1600,height:1000,deviceScaleFactor:1,mobile:false});
    await evaluate('controller().setRenderingMode("area")');
    await evaluate('controller().goToBitmap(401265)');
    await wait('controller().loadedBitmaps.has(401265)&&controller().arrivalFades.opacityFor(401265)===1&&!controller().tween?.isPlaying()');
    await evaluate('controller().setMetricFilter(1,1);controller().selectBitmap(-1)');
    for(let i=0;i<3;i++){
        await evaluate(`(()=>{const s=controller();s.scene.camera.position.x+=.31;s.scene.controls.target.x+=.31;s.setZoom(s.scene.camera.position.y+.17,"drag");s.scene.controls.update();s.scene.render();})()`);
        await fs.writeFile(`/tmp/bitmap-area-stability-${i}.png`,Buffer.from((await cdp('Page.captureScreenshot',{format:'png'})).data,'base64'));
    }
    assert.equal(browser.errors.length,0,JSON.stringify(browser.errors));
}finally{await browser.close();}
