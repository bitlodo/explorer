import assert from 'node:assert/strict';
import fs from 'node:fs';
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
    assert.equal(await evaluate('state().renderingMode'),'patterns');
    assert.ok(!requests.some(p=>p.endsWith('parcel-colors.json')),'No summaries at opening');
    await delay(1200);
    const shot=async()=> (await cdp('Page.captureScreenshot',{format:'png',clip:{x:350,y:160,width:900,height:500,scale:1}})).data;
    const before=await shot();
    const change=async(value)=>{
      await evaluate(`(()=>{const s=document.querySelector('select[aria-label="Rendering"]');const set=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set;set.call(s,'${value}');s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
      await wait(`state().renderingMode==='${value}' && !document.querySelector('select[aria-label="Rendering"]').disabled`);
      await wait('!state().preview.active || state().preview.rootsReady');await delay(1500);
    };
    await change('size');const far=await shot();assert.notEqual(far,before,'Distant map pixels change');
    assert.ok(await evaluate(`(()=>{const a=state().getState().parcelDistribution.areas,m=Math.max(...a),bars=[...document.querySelectorAll('.parcel-distribution button span')];return a.every((v,i)=>Math.abs(parseFloat(bars[i].style.height)-100*v/m)<.0001);})()`),'Parcel distribution bar heights retain exact area ratios without a minimum floor');
    const defaultPalette=['#49099e','#c03e80','#ffff00'];
    assert.deepEqual(await evaluate('state().getState().palette'),defaultPalette,'Default parcel colors follow the supplied reference in class order');
    assert.deepEqual(await evaluate('Array.from(document.querySelectorAll(".palette-swatches input")).map(e=>e.value)'),defaultPalette);
    assert.ok(await evaluate('(()=>{const s=state(),r=s.parcelResult,summary=s.preview.regional.summaries;return r.neighborhoodMeans.every((mean,id)=>summary[id*2]===Math.fround(mean)&&summary[id*2+1]===Math.fround(r.neighborhoodCoverage[id]))})()'),'Distant parcels use the restored weighted mean and selected-area share');
    assert.ok(await evaluate('Math.abs(state().preview.regional.material.uniforms.opacity.value-1)<.00001'),'Distant parcel strength is restored');
    fs.writeFileSync('/tmp/bitmap-parcel-default-palette.png',Buffer.from(far,'base64'));
    for(const [low,high] of [[9,9],[7,9],[5,9],[1,9]]){
        await evaluate('state().setParcelRange('+low+','+high+')');await browser.frame();
        assert.ok(await evaluate(`(()=>{const s=state(),r=s.parcelResult,v=s.preview.regional.summaries;return r.neighborhoodMeans.every((mean,id)=>v[id*2]===Math.fround(mean)&&v[id*2+1]===Math.fround(r.neighborhoodCoverage[id]))})()`),'Filtering retains exact area density and the selected weighted mean');
        assert.ok(await evaluate('Math.abs(state().preview.regional.material.uniforms.opacity.value-1)<.00001'));
        if(low===9){
            const sample=await evaluate(`(()=>{const s=state(),r=s.parcelResult;
                const hit=r.neighborhoodCoverage.map((share,id)=>({share,id})).filter(r=>r.share>0).sort((a,b)=>a.share-b.share)[0];
                s.scene.render();const slot=s.overview.slots[hit.id],c=s.runtime.renderer.domElement,gl=s.runtime.renderer.getContext();
                const p=s.scene.camera.position.clone().set(slot.x+slot.width/2,0,slot.y+slot.height/2).project(s.scene.camera),pixel=new Uint8Array(4);
                gl.readPixels(Math.floor((p.x+1)*c.width/2),Math.floor((p.y+1)*c.height/2),1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);
                const a=s.layerAnalysis.parcel.areas;
                return {pixel:[...pixel],rareShare:hit.share,presence:s.preview.regional.summaries[hit.id*2+1],count:s.getState().parcelMatches,expected:s.layerAnalysis.parcel.counts[8],areaShare:s.getState().parcelAreaShare,expectedShare:a[8]/a.reduce((sum,n)=>sum+n,0)};})()`);
            assert.ok(sample.presence>0);assert.equal(sample.count,sample.expected);assert.equal(sample.areaShare,sample.expectedShare);
            assert.ok(sample.pixel[0]>100&&sample.pixel[1]>100&&sample.pixel[2]<=2,JSON.stringify(sample));
            fs.writeFileSync('/tmp/bitmap-parcel-filter-9.png',Buffer.from(await shot(),'base64'));
        }
        if(low===7)fs.writeFileSync('/tmp/bitmap-parcel-filter-large.png',Buffer.from(await shot(),'base64'));
    }
    assert.ok(requests.some(p=>p.endsWith('layer-analysis.json')));
    const fixture=JSON.parse(fs.readFileSync('test/fixtures/real-blocks.ndjson','utf8').split('\n',1)[0]);
    const expected=fixture.tx.reduce((a,b)=>a+b*b*b,0)/fixture.tx.reduce((a,b)=>a+b*b,0);
    assert.equal(await evaluate(`state().parcelResult.pixels[${fixture.bitmap}*2]`),Math.fround(expected),'Color score weights parcel classes by area');
    assert.ok(await evaluate('game().renderer.info.programs.every(p=>p.diagnostics?.runnable!==false)'),'Shaders compile');
    const stats={farChanged:before!==far,summaryBytes:await evaluate('state().parcelResult.pixels.byteLength')};
    // Verify the native picker updates uniforms and produces a new image.
    const editedClass=5;
    await evaluate(`(()=>{const e=document.querySelector('input[aria-label="Size ${editedClass} color"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'#00ff00');e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await delay(500);assert.ok(await shot()!==far,'Editing a class represented in distant means changes pixels');
    await evaluate('Array.from(document.querySelectorAll("button")).find(e=>e.textContent==="Restore palette").click()');await browser.frame();
    assert.deepEqual(await evaluate('state().getState().palette'),defaultPalette,'Restore uses the new default palette');
    await change('count');
    await evaluate('state().setPalette(["#007eff","#58c059","#ffa100"])');
    await evaluate('state().goToBitmap(806400)');
    await wait('state().loadedBitmaps.has(806400) && !state().tween?.isPlaying() && state().arrivalFades.opacityFor(806400)===1');
    await evaluate('state().selectBitmap(-1)');await delay(500);
    const nearBefore=await shot();await change('size');const nearAfter=await shot();
    assert.notEqual(nearAfter,nearBefore,'Parcel pixels change');
    assert.ok(await evaluate('state().neighborhoods.get(400).compactParcels.material.uniforms.parcelClassMode.value===1'));
    await change('count');
    assert.ok(await evaluate('state().neighborhoods.get(400).compactParcels.material.uniforms.parcelClassMode.value===0'));
    assert.ok(await evaluate('game().renderer.info.programs.every(p=>p.diagnostics?.runnable!==false)'));
    await evaluate('state().setZoomFromControl(state().distanceLevels()[2],"drag")');
    await wait('state().neighborhoodGeometry.stats.visible>0 && state().lodDetail>=state().preview.pyramid.maxLevel+0.99');
    await delay(1500);const midBefore=await shot();await change('size');const midAfter=await shot();
    console.log(JSON.stringify(await evaluate('({level:state().lodDetail,mode:state().renderingMode,geometry:state().neighborhoodGeometry.stats,programs:game().renderer.info.programs.map(p=>p.diagnostics)})')));
    assert.ok(midAfter!==midBefore,'Bitmap pixels change');
    assert.ok(await evaluate('state().neighborhoodGeometry.material.uniforms.parcelClassMode.value===1'));
    assert.ok(await evaluate('game().renderer.info.programs.every(p=>p.diagnostics?.runnable!==false)'));
    await change('count');
    stats.midChanged=midBefore!==midAfter;
    const sharePixels=await evaluate(String.raw`(async()=>{
        const T=await import('/test-three.js'),renderer=game().renderer,n=state().neighborhoods.get(400);
        const shader=n.compactParcels.material.fragmentShader;
        const shared=shader.slice(shader.indexOf('uniform vec3 disabledColor'),shader.indexOf('flat varying float vSelected'));
        const material=new T.ShaderMaterial({uniforms:{...n.compactParcels.material.uniforms,selectedShare:{value:0}},
            vertexShader:'void main(){gl_Position=vec4(position.xy,0.,1.);}',
            fragmentShader:shared+'\n uniform float selectedShare;void main(){gl_FragColor=vec4(parcelCoverageColor(vec3(1.,.5,0.),selectedShare),1.);}'
        });
        const geometry=new T.PlaneGeometry(2,2),scene=new T.Scene(),mesh=new T.Mesh(geometry,material);mesh.frustumCulled=false;scene.add(mesh);
        const camera=new T.OrthographicCamera(-1,1,1,-1,.1,100),target=new T.WebGLRenderTarget(16,16);target.texture.colorSpace=T.LinearSRGBColorSpace;
        const previous=renderer.getRenderTarget(),tone=renderer.toneMapping;
        try{renderer.toneMapping=T.NoToneMapping;renderer.setRenderTarget(target);
            return [0,1e-8,.25,1].map(share=>{material.uniforms.selectedShare.value=share;renderer.clear();renderer.render(scene,camera);const out=new Uint8Array(4);renderer.readRenderTargetPixels(target,8,8,1,1,out);return [...out];});
        }finally{renderer.setRenderTarget(previous);renderer.toneMapping=tone;target.dispose();geometry.dispose();material.dispose();}
    })()`);
    assert.ok(sharePixels[0].slice(0,3).every(v=>v<10),'Zero area share stays excluded');
    for(const [i,expected] of [[1,[51,26,0]],[2,[153,77,0]],[3,[255,128,0]]]){
        for(let c=0;c<3;c++)assert.ok(Math.abs(sharePixels[i][c]-expected[c])<=2,JSON.stringify(sharePixels));
    }
    assert.equal(errors.length,0,JSON.stringify(errors));
    console.log(JSON.stringify({...stats,nearChanged:nearBefore!==nearAfter,exceptions:errors.length,sharePixels}));
}finally{await browser.close();}
