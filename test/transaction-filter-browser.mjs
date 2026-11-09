import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { browserHarness } from './helpers/browser.mjs';

const browser = await browserHarness();
const { cdp, evaluate, wait } = browser;
try {
    await browser.start();
    await cdp('Emulation.setDeviceMetricsOverride', {width:1600,height:1000,deviceScaleFactor:1,mobile:false});
    await cdp('Page.navigate', {url:browser.origin+'/repository/'});
    await wait("!!document.getElementById('mapCanvas')");
    await evaluate(`window.controller=()=>{const e=document.getElementById('mapCanvas'),key=Object.keys(e).find(k=>k.startsWith('__reactFiber$'));for(let f=e[key];f;f=f.return)for(let h=f.memoizedState;h;h=h.next){const r=h.memoizedState?.current??h.memoizedState;if(r?.controller)return r.controller;}};`);
    await wait('controller()?.getState().ready && !controller().getState().renderingBusy');
    await evaluate(`(()=>{const e=document.querySelector('select[aria-label="Rendering"]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(e,'count');e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await wait("controller().renderingMode==='count' && !controller().getState().renderingBusy");
    assert.equal(await evaluate('document.querySelectorAll("input[type=color]").length'),3,'Transactions has three editable palette anchors');
    const paletteCheck=await evaluate(`(async()=>{
        const T=await import('/test-three.js'),s=controller(),original=[...s.getState().palette];
        s.setPalette([original[0],'#ff0000',original[2]]);
        const midpoint=s.preview.regional.material.uniforms.sizeColors.value[4].getHexString();
        s.setPalette(original);
        return {midpoint,restored:s.getState().palette};
    })()`);
    assert.equal(paletteCheck.midpoint,'ff0000','Middle anchor reaches the renderer');
    assert.deepEqual(paletteCheck.restored,['#007eff','#58c059','#ffa100']);
    await browser.frame();
    const unfilteredStrength = await evaluate('controller().preview.regional.material.uniforms.opacity.value');
    const brightness = await evaluate(`(()=>{
        const s=controller(),scores=s.analyticTexture.image.data,n=s.getState().publishedHeight+1;
        const region=s.overview.slots.map((slot,r)=>({slot,r})).sort((a,b)=>b.slot.width*b.slot.height-a.slot.width*a.slot.height).find(({r})=>{
            for(let i=r*2016;i<Math.min(n,(r+1)*2016);i++)if(scores[i]>1+31/32*8)return false;
            return true;
        })?.r;
        if(region===undefined)throw Error('No unchanged region for brightness comparison');
        const sample=()=>{s.scene.render();const r=s.overview.slots[region],renderer=s.runtime.renderer,gl=renderer.getContext();
            const p=s.scene.camera.position.clone().set(r.x+r.width/2,0,r.y+r.height/2).project(s.scene.camera),out=new Uint8Array(4);
            gl.readPixels(Math.floor((p.x+1)*renderer.domElement.width/2),Math.floor((p.y+1)*renderer.domElement.height/2),1,1,gl.RGBA,gl.UNSIGNED_BYTE,out);return [...out];};
        return {before:sample(),region};
    })()`);
    await evaluate('controller().setMetricFilter(0,31/32)');
    await browser.frame();
    const filteredPixel = await evaluate(`(()=>{
        const s=controller(),r=s.overview.slots[${brightness.region}],renderer=s.runtime.renderer,gl=renderer.getContext();s.scene.render();
        const p=s.scene.camera.position.clone().set(r.x+r.width/2,0,r.y+r.height/2).project(s.scene.camera),out=new Uint8Array(4);
        gl.readPixels(Math.floor((p.x+1)*renderer.domElement.width/2),Math.floor((p.y+1)*renderer.domElement.height/2),1,1,gl.RGBA,gl.UNSIGNED_BYTE,out);return [...out];
    })()`);
    assert.deepEqual(filteredPixel, brightness.before, 'Applying a filter preserves pixels in an unchanged region');
    await evaluate('controller().setMetricFilter(12/32,13/32)');
    await browser.frame();
    const stats = await evaluate(`(()=>{
        const s=controller(),scores=s.analyticTexture.image.data,values=s.metricValues,summary=s.getState().layerSummary,n=s.getState().publishedHeight+1;
        const [lo,hi]=s.getState().filter.map(v=>1+v*8),regional=s.preview.regional;
        let matches=0,rare,empty;
        for(let r=0;r<s.overview.slots.length;r++){
            let selected=0,sum=0;
            for(let i=r*2016;i<Math.min(n,(r+1)*2016);i++)if(scores[i]>=lo-.000001&&scores[i]<=hi+.000001){selected++;sum+=values[i];}
            matches+=selected;
            const weight=selected/Math.min(2016,n-r*2016);
            if(Math.abs(regional.summaries[r*2+1]-weight)>1e-6)throw Error('Incorrect density '+r);
            if(selected){const mean=1+8*(Math.log1p(sum/selected)-Math.log1p(summary.min))/(Math.log1p(summary.max)-Math.log1p(summary.min));if(Math.abs(regional.summaries[r*2]-mean)>1e-6)throw Error('Incorrect original-value mean '+r);}
            const slot=s.overview.slots[r];
            if(selected&&(!rare||selected<rare.selected)&&Math.min(slot.width,slot.height)*s.pixelsPerWorld()>6)rare={r,selected};
            if(!selected&&(!empty||slot.width*slot.height>empty.area))empty={r,area:slot.width*slot.height};
        }
        s.scene.render();
        const sample=id=>{const r=s.overview.slots[id],canvas=s.runtime.renderer.domElement,gl=s.runtime.renderer.getContext();
            const p=s.scene.camera.position.clone().set(r.x+r.width/2,0,r.y+r.height/2).project(s.scene.camera),out=new Uint8Array(4);
            gl.readPixels(Math.floor((p.x+1)*canvas.width/2),Math.floor((p.y+1)*canvas.height/2),1,1,gl.RGBA,gl.UNSIGNED_BYTE,out);return [...out];};
        return {matches,reported:s.getState().filterMatches,rare,selectedPixel:sample(rare.r),emptyPixel:sample(empty.r),strength:regional.material.uniforms.opacity.value};
    })()`);
    assert.equal(stats.matches, stats.reported);
    assert.equal(stats.strength, unfilteredStrength);
    assert.deepEqual(stats.emptyPixel,[36,39,45,255]);
    assert.ok(stats.selectedPixel.slice(0,3).reduce((sum,v,i)=>sum+Math.abs(v-stats.emptyPixel[i]),0)>40,JSON.stringify(stats));
    await fs.writeFile('/tmp/bitmap-transactions-filter.png', Buffer.from((await cdp('Page.captureScreenshot',{format:'png'})).data,'base64'));
    await evaluate('controller().setMetricFilter(0,0)');
    await browser.frame();
    const density = await evaluate(`(async()=>{
        const T=await import('/test-three.js'),s=controller(),values=s.preview.regional.summaries;
        const weights=Array.from(values).filter((_,i)=>i%2===1&&values[i]>0);
        const rare=Math.min(...weights),dense=Math.max(...weights);
        const slots=[0,1,2].map(i=>({x:i*100,y:0,width:90,height:100}));
        const layer=new s.preview.regional.constructor(slots,Float32Array.of(1,0,1,rare,1,dense));
        layer.setColors(s.sizeColors);layer.setRegionStyle('density');
        const scene=new T.Scene();scene.add(layer);
        const camera=new T.OrthographicCamera(0,300,50,-50,.1,100);camera.position.set(0,10,50);camera.up.set(0,0,-1);camera.lookAt(0,0,50);camera.updateMatrixWorld();
        const renderer=s.runtime.renderer,target=new T.WebGLRenderTarget(300,100);target.texture.colorSpace=T.SRGBColorSpace;
        const previous=renderer.getRenderTarget(),tone=renderer.toneMapping;
        try{
            renderer.toneMapping=T.NoToneMapping;renderer.setRenderTarget(target);
            const sample=()=>{layer.updateView({x:0,y:0,width:300,height:100},s.preview.regional.material.uniforms.opacity.value);renderer.clear();renderer.render(scene,camera);
                return [45,145,245].map(x=>{const pixel=new Uint8Array(4);renderer.readRenderTargetPixels(target,x,50,1,1,pixel);return [...pixel];});};
            return {rare,dense,pixels:sample()};
        }finally{renderer.setRenderTarget(previous);renderer.toneMapping=tone;target.dispose();layer.dispose();}
    })()`);
    assert.ok(density.rare>0 && density.dense>density.rare,JSON.stringify(density));
    assert.deepEqual(density.pixels[0],[36,39,45,255],'Empty 1-TX summary stays exactly neutral');
    const separation=p=>p.slice(0,3).reduce((sum,v,i)=>sum+Math.abs(v-density.pixels[0][i]),0);
    assert.ok(separation(density.pixels[1])>=25,'Rare 1-TX matches remain visibly colored');
    assert.ok(density.pixels[2].slice(0,3).reduce((sum,v,i)=>sum+v-density.pixels[1][i],0)>70,'Dense 1-TX regions must have a clearly stronger color, not just a numeric difference');
    for(let channel=0;channel<3;channel++)assert.ok(density.pixels[2][channel]<=[0,126,255][channel], 'Dense 1-TX summaries never brighten the original palette color');
    const denseRegion = await evaluate('(()=>{const s=controller();return s.overview.slots.map((r,id)=>({r,id})).filter(({id})=>id<50&&s.preview.regional.summaries[id*2+1]>.05).sort((a,b)=>b.r.width*b.r.height-a.r.width*a.r.height)[0]?.id??0;})()');
    const zoomPixels=[];
    for(const stop of [4,3,2]){
        await evaluate(`controller().setZoom(controller().getZoom().stops[${stop}],"drag")`);
        await browser.delay(1800);
        if(stop===2){
            await wait('controller().neighborhoodChunks.ready(controller().geometryBounds())');
            await browser.delay(1500);
        }
        assert.equal(await evaluate('controller().preview.regional.material.uniforms.opacity.value'),1);
        await fs.writeFile(`/tmp/bitmap-transactions-one-tx-zoom-${stop+1}.png`,Buffer.from((await cdp('Page.captureScreenshot',{format:'png'})).data,'base64'));
        if(stop>=3)zoomPixels.push(await evaluate(`(()=>{
            const s=controller(),r=s.overview.slots[${denseRegion}],renderer=s.runtime.renderer,gl=renderer.getContext();s.scene.render();
            const p=s.scene.camera.position.clone().set(r.x+r.width/2,0,r.y+r.height/2).project(s.scene.camera),out=new Uint8Array(4);
            gl.readPixels(Math.floor((p.x+1)*renderer.domElement.width/2),Math.floor((p.y+1)*renderer.domElement.height/2),1,1,gl.RGBA,gl.UNSIGNED_BYTE,out);return [...out];
        })()`));
    }
    assert.deepEqual(zoomPixels[0],zoomPixels[1],'Dense region retains its color between zooms 5 and 4');
    await evaluate('controller().setMetricFilter(0,1)');
    await browser.frame();
    assert.ok(await evaluate('controller().preview.regional.summaries.every((v,i)=>i%2===0||v===1)'));
    assert.equal(browser.errors.length,0,JSON.stringify(browser.errors));
    console.log(JSON.stringify({...stats,density,zoomPixels,unchangedRegion:brightness.region,before:brightness.before,after:filteredPixel}));
} finally { await browser.close(); }
