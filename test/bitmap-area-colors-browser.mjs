import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { browserHarness } from './helpers/browser.mjs';

const browser = await browserHarness();
const { origin, requests, errors, cdp, evaluate, wait, delay } = browser;

try {
    await browser.start();
    await cdp('Emulation.setDeviceMetricsOverride', { width: Number(process.env.MAP_LOD_WIDTH||1600), height: Number(process.env.MAP_LOD_HEIGHT||900), deviceScaleFactor: 1, mobile: false });
    await cdp('Page.navigate', {url:origin+'/repository/'+(process.env.MAP_SMOKE_DEBUG_ONLY==='off'?'?chunks=off':process.env.MAP_SMOKE_PARCELS==='legacy'?'?parcels=legacy':'')});
    await wait("document.readyState==='complete' && document.getElementById('mapCanvas') && !!document.querySelector('canvas')");
    await evaluate(`window.game=()=>{const e=document.getElementById('mapCanvas'),key=Object.keys(e).find(k=>k.startsWith('__reactFiber$'));for(let f=e[key];f;f=f.return)for(let h=f.memoizedState;h;h=h.next)if((h.memoizedState?.current??h.memoizedState)?.controller)return h.memoizedState.current??h.memoizedState;};window.state=()=>game()?.controller;`);
    await wait(`state()?.overview?.slots.length===${browser.manifest.regions.length} && !state().tween?.isPlaying()`);
    await wait('state().preview?.rootsReady');
    assert.ok(!requests.some(p=>p.endsWith('parcel-colors.json')),'Opening Area does not load parcel summaries');
    const shot=async()=> (await cdp('Page.captureScreenshot',{format:'png',clip:{x:350,y:160,width:900,height:500,scale:1}})).data;
    const change=async(mode)=>{
        await evaluate(`(()=>{const e=document.querySelector('select[aria-label="Rendering"]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(e,'${mode}');e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
        await wait(`state().renderingMode==='${mode}' && !document.querySelector('select[aria-label="Rendering"]').disabled`);
        await wait('!state().preview.active || state().preview.rootsReady');await delay(1200);
        assert.ok(await evaluate('game().renderer.info.programs.every(p=>p.diagnostics?.runnable!==false)'),'Valid shaders');
    };
    const stats={};
    for(const level of ['far','near','mid']){
        if(level==='near'){
            await evaluate('state().goToBitmap(806400)');
            await wait('state().loadedBitmaps.has(806400) && !state().tween?.isPlaying() && state().arrivalFades.opacityFor(806400)===1');
            await evaluate('state().selectBitmap(-1)');
        }
        if(level==='mid'){
            await evaluate('state().setZoomFromControl(state().distanceLevels()[2],"drag")');
            await wait('state().neighborhoodGeometry.stats.visible>0 && state().lodDetail>=state().preview.pyramid.maxLevel+0.99');
        }
        await change('count');const heat=await shot();
        await change('area');assert.equal(await evaluate('document.querySelectorAll("input[type=color]").length'),3);const area=await shot();assert.ok(area!==heat,level+': area differs from heatmap');
        if(level==='far'){
            await fs.writeFile('/tmp/bitmap-area-navigation-overview.png',Buffer.from(await shot(),'base64'));
            const navigation=await evaluate(`(async()=>{
                const s=state(),values=await s.source.getAreaMetric(),summary=s.getState().layerSummary,max=summary.max;
                const bins=[...document.querySelectorAll('.distribution-chart button')];
                if(!summary.histogram.every((n,i)=>n>0||(bins[i].style.height==='0%'&&bins[i].getBoundingClientRect().height===0)))throw Error('Empty histogram bins have visible bars');
                const region=Math.floor(values.indexOf(max)/2016),regional=s.preview.regional;
                const allScore=regional.summaries[region*2],strength=regional.material.uniforms.opacity.value;
                const start=region*2016,end=Math.min(values.length,start+2016),regionValues=values.slice(start,end);
                const normalize=v=>(Math.log1p(v)-Math.log1p(summary.min))/(Math.log1p(max)-Math.log1p(summary.min));
                const expectedMean=1+8*normalize(regionValues.reduce((a,b)=>a+b,0)/regionValues.length);
                const expectedShare=regionValues.reduce((n,v)=>n+Number(v===max),0)/regionValues.length;
                await s.setMetricFilter(1,1);s.scene.render();
                const excluded=s.overview.slots.map((slot,id)=>({slot,id})).filter(r=>regional.summaries[r.id*2+1]===0).sort((a,b)=>b.slot.width*b.slot.height-a.slot.width*a.slot.height)[0].id;
                const sample=id=>{const r=s.overview.slots[id],canvas=s.runtime.renderer.domElement,gl=s.runtime.renderer.getContext();
                    const p=s.scene.camera.position.clone().set(r.x+r.width/2,0,r.y+r.height/2).project(s.scene.camera),out=new Uint8Array(4);
                    gl.readPixels(Math.floor((p.x+1)*canvas.width/2),Math.floor((p.y+1)*canvas.height/2),1,1,gl.RGBA,gl.UNSIGNED_BYTE,out);return [...out];};
                return {allScore,expectedMean,expectedShare,strength,presence:regional.summaries[region*2+1],matches:s.getState().filterMatches,expected:values.reduce((n,v)=>n+Number(v===max),0),peak:sample(region),excluded:sample(excluded),scale:s.getState().layerSummary.scale};
            })()`);
            assert.equal(navigation.scale,'log');assert.ok(Math.abs(navigation.allScore-navigation.expectedMean)<1e-6,'Regional color represents the arithmetic mean area');assert.ok(navigation.allScore<9);assert.equal(navigation.strength,1);
            assert.ok(Math.abs(navigation.presence-navigation.expectedShare)<1e-8,'A rare maximum retains its exact matching share');assert.ok(navigation.presence<1);assert.equal(navigation.matches,navigation.expected);
            for(let i=0;i<3;i++){
                assert.ok(navigation.peak[i]<=[255,177,77][i],JSON.stringify(navigation));
                assert.ok(Math.abs(navigation.excluded[i]-[36,39,45][i])<=2,JSON.stringify(navigation));
            }
            await fs.writeFile('/tmp/bitmap-area-navigation-filter.png',Buffer.from(await shot(),'base64'));
            const rangeCheck=await evaluate(`(async()=>{
                const s=state(),v=await s.source.getAreaMetric(),summary=s.getState().layerSummary;
                await s.setMetricFilter(.25,.75);
                const normalize=value=>(Math.log1p(value)-Math.log1p(summary.min))/(Math.log1p(summary.max)-Math.log1p(summary.min));
                let matches=0;
                for(let r=0;r<s.overview.slots.length;r++){
                    const first=r*2016,end=Math.min(v.length,first+2016);let selected=0,sum=0;
                    for(let i=first;i<end;i++){
                        const t=normalize(v[i]);
                        if(t>=.25-1e-7&&t<=.75+1e-7){selected++;sum+=v[i];}
                    }
                    matches+=selected;
                    const out=s.preview.regional.summaries;
                    if(Math.abs(out[r*2+1]-selected/(end-first))>1e-6)throw Error('Incorrect area share');
                    if(selected&&Math.abs(out[r*2]-(1+8*normalize(sum/selected)))>1e-6)throw Error('Incorrect area mean');
                }
                return matches===s.getState().filterMatches;
            })()`);
            assert.ok(rangeCheck,'All regional area summaries agree with independently computed means, shares and exact counts');
            await evaluate('state().setMetricFilter(0,1)');
            assert.ok(!requests.some(p=>p.endsWith('parcel-colors.json')),'Area mode needs no parcel means');
            assert.equal(await evaluate('state().areaValues.maxArea'),145908);
            assert.ok(await evaluate('!state().meanTexture'),'No new GPU summary texture');
            const old=await shot();
            await evaluate(`(()=>{const e=document.querySelector('input[aria-label="Minimum area color"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'#00ff00');e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
            await delay(500);assert.ok(old!==await shot(),'Editing area palette changes pixels');
        }
        if(level==='near'){
            assert.equal(await evaluate('state().neighborhoods.get(400).compactParcels.material.uniforms.sizeColorMode.value'),2);
            assert.ok(await evaluate('(()=>{const n=state().neighborhoods.get(400);return n.data.bitmaps.every((b,i)=>n.compactParcels.material.uniforms.bitmapSizes.value.image.data[i*4+1]===b.width*b.height)})()'),'Every compact bitmap area equals width times height');
        }
        await change('size');assert.equal(await evaluate('document.querySelectorAll("input[type=color]").length'),3);const size=await shot();assert.ok(size!==area,level+': parcel size differs from area');
        assert.equal(await evaluate(`document.querySelector('input[aria-label="Size 1 color"]').value`),'#49099e','Area palette does not alter parcel palette');
        await change('area');assert.equal(await evaluate(`document.querySelector('input[aria-label="Minimum area color"]').value`),'#00ff00','Area palette survives switches');
        stats[level]=true;
    }
    // Render actual compact shader into a linear target with analytically known area ratios.
    const samples=await evaluate(`(async()=>{
        const T=await import('/test-three.js'),renderer=game().renderer,n=state().neighborhoods.get(400);
        const ratios=[0,.1249,.125,.1251,.25,.5,.75,1],max=145908;
        const blocks=ratios.map((t,i)=>({x:i*2,y:0,width:1+t*(max-1),height:1}));
        const layer=new n.compactParcels.constructor();layer.setBitmapSizes(blocks);layer.setSizeColors(['#000000','#ff0000','#ffffff']);layer.setBitmapAreaMode(true,max);layer.setLOD(1,1,true);
        blocks.forEach((b,i)=>layer.addBitmap(i,b,[{x:0,y:0,width:1,height:1}]));
        const scene=new T.Scene();scene.add(layer);
        const camera=new T.OrthographicCamera(-.5,ratios.length*2-.5,1,-1,.1,100);camera.position.set(0,10,0);camera.up.set(0,0,-1);camera.lookAt(0,0,0);camera.updateMatrixWorld();
        const target=new T.WebGLRenderTarget(ratios.length*16,16);target.texture.colorSpace=T.LinearSRGBColorSpace;
        const previous=renderer.getRenderTarget(),tone=renderer.toneMapping;
        try{
            renderer.toneMapping=T.NoToneMapping;renderer.setRenderTarget(target);renderer.clear();renderer.render(scene,camera);
            const output=ratios.map((t,i)=>{const v=new T.Vector3(i*2+.25,0,.25).project(camera),pixel=new Uint8Array(4);renderer.readRenderTargetPixels(target,Math.floor((v.x+1)/2*target.width),Math.floor((v.y+1)/2*target.height),1,1,pixel);return {t,pixel:[...pixel]};});
            layer.setBitmapAreaMode(true,9,9);layer.setBitmapSizes(blocks.map(b=>({...b,width:9,height:1})));layer.setLOD(1,1,true);
            layer.material.uniforms.filterMin.value=1;layer.material.uniforms.filterMax.value=1;
            renderer.clear();renderer.render(scene,camera);
            const v=new T.Vector3(.25,0,.25).project(camera),pixel=new Uint8Array(4);
            renderer.readRenderTargetPixels(target,Math.floor((v.x+1)/2*target.width),Math.floor((v.y+1)/2*target.height),1,1,pixel);
            return [...output,{t:0,pixel:[...pixel]}];
        }finally{renderer.setRenderTarget(previous);renderer.toneMapping=tone;target.dispose();layer.dispose();}
    })()`);
    for(const {t,pixel} of samples){assert.equal(pixel[3],255);for(let c=0;c<3;c++){const expected=c===0?Math.min(1,t*2):Math.max(0,t*2-1);assert.ok(Math.abs(pixel[c]-expected*255)<=2,JSON.stringify({t,pixel}));}}
    stats.linearAreaSamples=samples.length;
    await change('count');
    assert.equal(errors.length,0,JSON.stringify(errors));
    console.log(JSON.stringify({...stats,exceptions:errors.length,requests:requests.length}));
}finally{await browser.close();}
