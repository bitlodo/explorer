import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { browserHarness } from './helpers/browser.mjs';
const browser=await browserHarness();
const {cdp,evaluate,wait,delay,errors,requests}=browser;
try{
    await browser.start();
    await cdp('Browser.setDownloadBehavior',{behavior:'deny'});
    await cdp('Emulation.setDeviceMetricsOverride',{width:1600,height:1000,deviceScaleFactor:1,mobile:false});
    await cdp('Page.navigate',{url:process.env.ATLAS_DEV_URL||browser.origin+'/repository/'});
    await wait("document.getElementById('mapCanvas')&&document.querySelector('canvas')");
    await evaluate(`window.game=()=>{const e=document.getElementById('mapCanvas'),key=Object.keys(e).find(k=>k.startsWith('__reactFiber$'));for(let f=e[key];f;f=f.return)for(let h=f.memoizedState;h;h=h.next)if((h.memoizedState?.current??h.memoizedState)?.controller)return h.memoizedState.current??h.memoizedState;};window.state=()=>game()?.controller;`);
    await wait('state()?.getState().ready&&!state().getState().renderingBusy&&state().preview?.rootsReady');
    await delay(600);
    const shot=async name=>fs.writeFile(`/tmp/bitmap-atlas-${name}.png`,Buffer.from((await cdp('Page.captureScreenshot',{format:'png'})).data,'base64'));
    await shot('patterns');
    assert.equal(await evaluate('state().getState().renderingMode'),'patterns');
    assert.ok(await evaluate('state().getState().publishedParcels>0'),'Opening Patterns retains the published parcel total');
    assert.equal(await evaluate("game().scene.background.getHexString()"),'17191d');
    assert.ok(await evaluate('!!state().analyticTexture'), 'Patterns initializes its chronology and membership texture');
    const choose=async mode=>{
        console.log("Switching layer",mode);
        await evaluate(`(()=>{const e=document.querySelector('select[aria-label="Rendering"]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(e,'${mode}');e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
        await wait(`state().getState().renderingMode==='${mode}'&&!state().getState().renderingBusy`);
        await wait('!state().preview.active||state().preview.rootsReady');await delay(150);
        assert.ok(await evaluate('game().renderer.info.programs.every(p=>p.diagnostics?.runnable!==false)'),'All shaders compile for '+mode);
    };
    for(const mode of ['area','size','count','diversity','occupancy']){
        await choose(mode);assert.equal(await evaluate('document.querySelectorAll("input[type=color]").length'),3);
        if(['count','diversity','occupancy'].includes(mode)){
            const exact=await evaluate(`(async()=>{
                const s=state(),values=(await s.source.getAnalyticsMetric('${mode}')).values,summary=s.getState().layerSummary;
                const transform=summary.scale==='log'?Math.log1p:x=>x;
                const min=transform(summary.min),span=transform(summary.max)-min;
                const bars=[...document.querySelectorAll('.distribution-chart button')];
                if(!summary.histogram.every((n,i)=>n>0||bars[i].getBoundingClientRect().height===0))throw Error('Empty histogram bin is visible');
                const score=v=>1+8*(span?Math.max(0,Math.min(1,(transform(v)-min)/span)):0);
                for(const [low,high] of [[0,1],[.2,.8]]){
                    s.setMetricFilter(low,high);let matches=0;
                    const output=s.preview.regional.summaries;
                    for(let r=0;r<s.overview.slots.length;r++){
                        const start=r*2016,end=Math.min(values.length,start+2016);let sum=0,selected=0;
                        for(let i=start;i<end;i++){const v=Math.fround(score(values[i]));if(v>=1+8*low-.000001&&v<=1+8*high+.000001){sum+=values[i];selected++;}}
                        matches+=selected;
                        if(Math.abs(output[r*2+1]-selected/(end-start))>1e-6)throw Error('Incorrect matching share');
                        if(selected&&Math.abs(output[r*2]-score(sum/selected))>1e-6)throw Error('Mean is not computed in original units');
                    }
                    if(matches!==s.getState().filterMatches)throw Error('Incorrect exact count');
                }
                s.setMetricFilter(0,1);return true;
            })()`);
            assert.ok(exact,mode+': raw-value regional means and shares agree with the published values');
        }
    }
    assert.equal(await evaluate("document.querySelectorAll('#rendering-layer optgroup').length"),0,'Every layer belongs to the same selector');
    assert.equal(await evaluate("Array.from(document.querySelectorAll('#rendering-layer option')).some(e=>['composition','shape','heatmap','default','chronology','rarity','anomaly'].includes(e.value))"),false,'Redundant layers are removed');
    assert.equal(await evaluate("typeof state().setView"),'undefined','The runtime is 2D only');
    await choose('size');await shot('parcel-sizes');
    assert.equal(await evaluate('state().preview.pyramid.channels'),3);
    assert.ok(await evaluate('state().preview.stats.textureBytes<=64*96*96*4'),'Class previews preserve the texture budget');
    await evaluate('Promise.all([state().setParcelRange(1,3),state().setParcelRange(4,6),state().setParcelRange(7,9)])');await delay(100);await shot('large-parcels');
    assert.ok(await evaluate('state().getState().parcelMatches===state().getState().parcelDistribution.counts.slice(6).reduce((a,b)=>a+b,0)'),'Large filter counts actual parcels');
    assert.ok(await evaluate('state().getState().parcelAreaShare>0&&state().getState().parcelAreaShare<1'));
    await evaluate('state().setParcelRange(1,3)');
    assert.ok(await evaluate('state().getState().parcelMatches===state().getState().parcelDistribution.counts.slice(0,3).reduce((a,b)=>a+b,0)'));
    await choose('area');await evaluate('state().setMetricFilter(.2,.8)');
    assert.ok(await evaluate('state().getState().filterMatches>0&&state().getState().filterMatches<state().getState().publishedHeight+1'),'Bitmap area has the same range filter system');
    await choose('count');await delay(400);await shot('transactions');
    await evaluate('state().setMetricFilter(.4,.9)');
    assert.ok(await evaluate('state().getState().filterMatches>0&&state().getState().filterMatches<state().getState().analytics.count'));
    await evaluate('state().setMetricFilter(0,1)');
    // Search through the real form, inspect exact data, then compare two blocks.
    await evaluate(`(()=>{const e=document.querySelector('input[aria-label="Search bitmap by block height"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'Block #100,000');e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    assert.equal(await evaluate(`document.querySelector('.atlas-search input').value`),'100000','Search removes pasted labels and separators');
    await evaluate(`document.querySelector('.atlas-search').requestSubmit()`);
    await wait('state().getState().selection?.id===100000&&!state().tween?.isPlaying()');
    assert.equal(await evaluate('state().getState().selection.count'),4);
    await evaluate(`document.querySelector('button[aria-label="Pin selected bitmap"]').click()`);
    await evaluate('state().goToBitmap(500000)');
    await wait('state().getState().selection?.id===500000&&state().loadedBitmaps.has(500000)&&!state().tween?.isPlaying()');
    await delay(1200);
    assert.equal(await evaluate('state().getState().selection.count'),2701);
    await evaluate(`document.querySelector('button[aria-label="Pin selected bitmap"]').click()`);
    await evaluate(`document.querySelector('.pinned-list-actions button').click()`);
    assert.equal(await evaluate("document.querySelectorAll('.comparison-card').length"),2);
    assert.ok(await evaluate("document.querySelector('.comparison-card[data-bitmap=\"500000\"]').textContent.includes('2,701')"));
    await evaluate(`document.querySelector('button[aria-label="Close pinned comparison"]').click()`);
    assert.equal(await evaluate('state().neighborhoods.get(Math.floor(500000/2016)).compactParcels.material.uniforms.metricEnabled.value'),1);
    assert.ok(await evaluate(`(()=>{const h=state().getState().selection.histogram,w=h.map((n,i)=>n*(i+1)**2),max=Math.max(...w),bars=[...document.querySelectorAll('.composition-chart span')];return w.every((v,i)=>Math.abs(parseFloat(bars[i].style.height)-100*v/max)<.0001);})()`),'Inspector bars have exact area proportions without a minimum height');
    await shot('inspection');
    await evaluate(`window.captureCsv=URL.createObjectURL;URL.createObjectURL=blob=>{window.exportedCsv=blob;return window.captureCsv(blob)};document.querySelector('button[aria-label="Export bitmap metrics as CSV"]').click()`);
    assert.ok(await evaluate(`exportedCsv.text().then(text=>text.includes('transactions,2701')&&text.includes('bitmap,500000'))`),'Inspector CSV exports real metrics');
    await choose('count');await delay(300);await shot('transactions-detail');
    await evaluate('state().goToBitmap(100000)');await wait('state().getState().selection?.id===100000&&!state().tween?.isPlaying()');
    const point=await evaluate(`(()=>{const s=state(),n=s.neighborhoods.get(49),r=n.data.bitmaps[100000%2016],v=s.scene.camera.position.clone().set(n.position.x+r.x+r.width/2,0,n.position.z+r.y+r.height/2).project(s.scene.camera),c=document.querySelector('#mapCanvas').getBoundingClientRect();return{x:c.left+(v.x+1)*c.width/2,y:c.top+(1-v.y)*c.height/2}})()`);
    await evaluate('state().clearSelection()');
    await cdp('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',buttons:1,clickCount:1});
    await cdp('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',buttons:0,clickCount:1});
    await wait('state().getState().selection?.id===100000');
    await evaluate(`document.querySelector('button[aria-label="Filter this pattern"]').click()`);
    await wait("state().getState().renderingMode==='patterns'&&!state().getState().filterBusy&&!state().getState().renderingBusy");
    assert.ok(await evaluate("state().getState().renderingMode==='patterns'&&state().getState().selectedPattern===68460&&state().getState().filterMatches>=1"));
    await choose('count');
    await choose('size');await evaluate('state().setParcelRange(7,9)');
    assert.ok(await evaluate('Array.from(state().neighborhoods.values()).every(n=>n.compactParcels.material.uniforms.parcelMin.value===7&&n.compactParcels.material.uniforms.parcelMax.value===9)'),'Exact parcels receive the size range');
    await shot('parcel-filter-detail');
    const filteredHover=await evaluate(`(async()=>{
        const T=await import('/test-three.js'),renderer=game().renderer,n=Array.from(state().neighborhoods.values())[0],layer=new n.compactParcels.constructor();
        const texture=new T.DataTexture(Float32Array.of(9,1),1,1,T.RGFormat,T.FloatType);texture.needsUpdate=true;
        layer.setBitmapSizes([{x:0,y:0,width:11,height:9}]);layer.setParcelClasses(texture,7,9);layer.setLOD(1,1,true);
        layer.addBitmap(0,{x:0,y:0,width:11,height:9},[{x:0,y:0,width:1,height:1},{x:2,y:0,width:9,height:9}]);layer.setBitmapSelected(0,true);
        const scene=new T.Scene();scene.add(layer);const camera=new T.OrthographicCamera(-1,12,10,-1,.1,100);camera.position.set(0,10,0);camera.up.set(0,0,-1);camera.lookAt(0,0,0);camera.updateMatrixWorld();
        const target=new T.WebGLRenderTarget(130,110);target.texture.colorSpace=T.LinearSRGBColorSpace;
        const previous=renderer.getRenderTarget(),tone=renderer.toneMapping;
        try{renderer.toneMapping=T.NoToneMapping;renderer.setRenderTarget(target);renderer.clear();renderer.render(scene,camera);
            return [.25,3].map(x=>{const v=new T.Vector3(x,0,.25).project(camera),pixel=new Uint8Array(4);renderer.readRenderTargetPixels(target,Math.floor((v.x+1)/2*target.width),Math.floor((v.y+1)/2*target.height),1,1,pixel);return [...pixel];});
        }finally{renderer.setRenderTarget(previous);renderer.toneMapping=tone;target.dispose();texture.dispose();layer.dispose();}
    })()`);
    assert.ok(Math.max(...filteredHover[0].slice(0,3))<50,'Hover cannot brighten an excluded small parcel');
    assert.ok(filteredHover[1][0]>100,'Selected large parcels retain a strong highlight');
    await evaluate('state().home()');await wait('!state().tween?.isPlaying()');
    await cdp('Emulation.setDeviceMetricsOverride',{width:1100,height:760,deviceScaleFactor:1,mobile:false});await delay(400);await shot('compact');
    const dimensions=await evaluate('(()=>{const c=document.querySelector("#mapCanvas").getBoundingClientRect();return{right:c.right,bottom:c.bottom,width:innerWidth,height:innerHeight,overflow:document.documentElement.scrollWidth>innerWidth}})()');
    assert.ok(dimensions.right<=dimensions.width&&!dimensions.overflow,'Canvas fits the workspace');
    assert.equal(errors.length,0,JSON.stringify(errors));
    console.log(JSON.stringify({layers:6,search:true,inspection:true,comparison:true,csv:true,filter:true,patterns:true,click:true,only2D:true,parcelFilters:true,filteredHover:true,areaFilter:true,responsive:true,exceptions:errors.length,requests:requests.length}));
}catch(error){console.error('Browser state',await evaluate('JSON.stringify({mode:state()?.getState().renderingMode,error:state()?.getState().renderingError,preview:state()?.preview?.stats,pending:state()?.preview?.loads?.size})').catch(()=>null));throw error;}finally{await browser.close();}
