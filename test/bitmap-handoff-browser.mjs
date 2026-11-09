import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { browserHarness } from './helpers/browser.mjs';

const browser=await browserHarness();
const {cdp,evaluate,wait}=browser;
try {
    await browser.start();
    await cdp('Page.navigate',{url:browser.origin+'/repository/?chunks=off'});
    await wait("!!document.getElementById('mapCanvas')");
    await evaluate(`window.state=()=>{const e=document.getElementById('mapCanvas'),key=Object.keys(e).find(k=>k.startsWith('__reactFiber$'));for(let f=e[key];f;f=f.return)for(let h=f.memoizedState;h;h=h.next){const runtime=h.memoizedState?.current??h.memoizedState;if(runtime?.controller)return runtime.controller;}};`);
    await wait('state()?.getState().ready&&!state().getState().renderingBusy');
    const report=await evaluate(`(async()=>{
        const T=await import('/test-three.js'),s=state(),n=await s.ensureNeighborhood(0),renderer=s.runtime.renderer;
        const rect={x:0,y:0,width:20,height:20},parcel={...rect,width:14};
        const base=new s.neighborhoodGeometry.constructor([]),parcels=new n.compactParcels.constructor(),fades=new s.arrivalFades.constructor(2016);
        const legacy=new n.constructor({neighborhood:0,...rect,bitmaps:[rect]},'legacy');
        legacy.defaultColor.set('#ffffff');legacy.setArrivalFades(fades);legacy.AddBitmap(0,[parcel]);legacy.setLOD(128/25,1,1,true,false);
        base.addRegion({neighborhood:0,width:20,height:20,bitmaps:[rect]},rect);base.labels.visible=false;
        parcels.setBitmapSizes([rect]);parcels.setLOD(128/25,1,true);parcels.addBitmap(0,rect,[parcel]);
        for(const layer of [base,parcels]){layer.setSizeColorMode(false);layer.material.uniforms.baseColor.value.set('#ffffff');layer.setArrivalFades(fades,0);}
        const scene=new T.Scene();scene.add(base);
        const target=new T.WebGLRenderTarget(128,128,{samples:4});target.texture.colorSpace=T.LinearSRGBColorSpace;
        const camera=new T.PerspectiveCamera(15,1,.1,20000);camera.up.set(0,0,-1);
        camera.position.set(10,25/(2*Math.tan(Math.PI/24)),10);camera.lookAt(10,0,10);camera.updateMatrixWorld();
        const previous=renderer.getRenderTarget(),tone=renderer.toneMapping,clear=renderer.getClearColor(new T.Color()).clone(),alpha=renderer.getClearAlpha();
        const read=()=>{renderer.setRenderTarget(target);renderer.clear();renderer.render(scene,camera);const pixels=new Uint8Array(128*128*4);renderer.readRenderTargetPixels(target,0,0,128,128,pixels);return pixels;};
        const mean=pixels=>{let sum=0;for(let y=48;y<80;y++)for(let x=48;x<80;x++)sum+=pixels[(y*128+x)*4];return sum/1024;};
        const frames=[],settledDifferences=[];
        try {
            renderer.toneMapping=T.NoToneMapping;renderer.setClearColor(0,1);
            fades.setVisibleNeighborhoods([0]);
            for(const [name,layer,start] of [['compact',parcels,0],['legacy',legacy,1000]]){
                fades.resetNeighborhood(0);fades.update(start);fades.begin(0);scene.add(layer);
                for(let now=start;now<=start+800;now+=20){fades.update(now);base.updateView(rect,1,25/128,1,now);const pixels=read();frames.push({renderer:name,now:now-start,parcel:fades.opacityFor(0),base:fades.baseOpacityFor(0),mean:mean(pixels),gap:pixels[(64*128+100)*4]});}
                const settled=read();scene.remove(base);const parcelOnly=read();scene.add(base);
                settledDifferences.push({renderer:name,pixels:settled.reduce((n,value,i)=>n+Number(value!==parcelOnly[i]),0)});
                scene.remove(layer);
            }
            scene.remove(base);
            const cells=Array.from({length:1024},(_,i)=>({x:(i%32)*20,y:Math.floor(i/32)*20,width:20,height:20}));
            const outline=new s.neighborhoodGeometry.constructor([]),bounds={x:0,y:0,width:640,height:640};
            try {
                outline.addRegion({neighborhood:0,width:640,height:640,bitmaps:cells},bounds);outline.labels.visible=false;
                outline.material.uniforms.baseColor.value.set('#ffffff');
                for(let t=0;t<=800;t+=20)outline.updateView(bounds,1,4,0,t);
                const newMargin=outline.material.uniforms.bitmapMargin.value;
                scene.add(outline);camera.position.set(320,512/(2*Math.tan(Math.PI/24)),320);camera.lookAt(320,0,320);camera.updateMatrixWorld();
                outline.material.uniforms.bitmapMargin.value=.5;const original=mean(read());
                outline.material.uniforms.bitmapMargin.value=newMargin;const defined=mean(read());
                outline.updateView(bounds,1,4,1,820);
                const parcelBand=mean(read());
                return{frames,settledDifferences,outlines:{original,defined,parcelBand,vectorMargin:newMargin,parcelMargin:outline.material.uniforms.bitmapMargin.value},programs:renderer.info.programs.every(p=>p.diagnostics?.runnable!==false)};
            } finally {outline.dispose();}
        } finally {renderer.setRenderTarget(previous);renderer.setClearColor(clear,alpha);renderer.toneMapping=tone;target.dispose();base.dispose();parcels.dispose();legacy.dispose();fades.dispose();}
    })()`);
    await fs.writeFile('/tmp/bitmap-handoff.json',JSON.stringify(report,null,2)+'\n');
    assert.ok(report.programs,'Shaders compile');
    assert.ok(report.frames.every(f=>f.mean>=254),'Filled bitmap interiors do not darken during the handoff');
    assert.ok(report.frames.some(f=>f.parcel>0&&f.parcel<1&&f.base===1),'Base covers incoming translucent parcels');
    assert.ok(report.frames.some(f=>f.base>0&&f.base<1&&f.parcel===1),'Base exit follows completed parcel arrival');
    for(const renderer of ['compact','legacy']){
        const releasing=report.frames.find(f=>f.renderer===renderer&&f.now===220),complete=report.frames.find(f=>f.renderer===renderer&&f.now===320);
        assert.ok(releasing.gap>0&&releasing.gap<254,'The solid base is already fading from empty parcel space by 220 ms');
        assert.ok(complete.gap<=1,'The solid base no longer fills parcel gaps by 320 ms');
    }
    assert.equal(report.outlines.vectorMargin,4,'Vector outlines target one screen pixel');
    assert.equal(report.outlines.parcelMargin,report.outlines.vectorMargin,'Unloaded bitmap bases retain one-pixel outlines in the parcel band');
    assert.equal(report.outlines.parcelBand,report.outlines.defined,'Stop-2 bitmap bases retain the same separation as stop 3');
    assert.ok(report.settledDifferences.every(r=>r.pixels===0),'Completed bitmaps with parcels match parcel-only rendering exactly');
    assert.ok(report.outlines.defined<report.outlines.original-20,'Stop-3 outlines have visibly greater gap coverage');
    await cdp('Emulation.setDeviceMetricsOverride',{width:1920,height:993,deviceScaleFactor:1,mobile:false});
    await evaluate('state().goToBitmap(563559)');
    await wait('state().loadedBitmaps.has(563559)&&state().arrivalFades.activeCount===0&&!state().tween?.isPlaying()');
    await evaluate('state().selectBitmap(-1);state().setZoomFromControl(state().distanceLevels()[2],"drag")');
    await wait('state().neighborhoodGeometry.stats.visible>0&&Math.abs(state().lodDetail-state().preview.pyramid.maxLevel-1)<.0001');
    await wait('state().neighborhoodChunks.mode===false?state().visibleRegions(state().geometryBounds()).every(r=>state().neighborhoodGeometry.has(r.data)):state().neighborhoodChunks.ready(state().geometryBounds())');
    await wait('[...state().neighborhoodGeometry.regions.values(),...state().neighborhoodGeometry.chunks.values()].filter(e=>e.mesh.visible).every(e=>e.previewExit.opacity===1)');
    const actual=await evaluate('(()=>{const s=state(),g=s.neighborhoodGeometry,p=s.preview.regional;return{zoom:s.getZoom(),detail:s.lodDetail,target:s.lodTarget,max:s.preview.pyramid.maxLevel,vectorUniforms:Object.fromEntries(Object.entries(g.material.uniforms).filter(([k])=>["opacity","geometryArrival","parcelOpacity","bitmapMargin","rectanglePixelsPerWorld","rectangleSmoothing"].includes(k)).map(([k,u])=>[k,u.value])),previewVisible:p?.visible,previewUniforms:p&&{opacity:p.material.uniforms.opacity.value,geometry:p.material.uniforms.geometryOpacity.value},coverage:p?.patches.filter(p=>p.bounds.x<s.groundBounds().x+s.groundBounds().width&&p.bounds.x+p.bounds.width>s.groundBounds().x&&p.bounds.y<s.groundBounds().y+s.groundBounds().height&&p.bounds.y+p.bounds.height>s.groundBounds().y).map(p=>({region:p.region,coverage:p.coverage})),regions:[...g.regions].filter(([id,e])=>e.mesh.visible).map(([id,e])=>({id,arrival:e.arrival.opacity})),chunks:[...g.chunks].filter(([id,e])=>e.mesh.visible).map(([id,e])=>({id,arrival:e.arrival.opacity}))};})()');
    await fs.writeFile('/tmp/bitmap-stop3-state.json',JSON.stringify(actual,null,2)+'\n');
    const stroke=await evaluate(`(()=>{const s=state(),n=s.neighborhoods.get(279),r=n.data.bitmaps[563559%2016],g=s.neighborhoodGeometry;
        if(s.selectionOutline)s.selectionOutline.visible=false;
        const canvas=s.runtime.renderer.domElement,gl=s.runtime.renderer.getContext();
        const sample=(x,z)=>{const p=s.scene.camera.position.clone().set(x,0,z).project(s.scene.camera),out=new Uint8Array(4);gl.readPixels(Math.floor((p.x+1)*canvas.width/2),Math.floor((p.y+1)*canvas.height/2),1,1,gl.RGBA,gl.UNSIGNED_BYTE,out);return Array.from(out);};
        s.scene.render();const x=n.position.x+r.x+r.width/2,z=n.position.z+r.y;
        return{interior:sample(x,z+r.height/2),edge:sample(x,z+r.height-g.material.uniforms.bitmapMargin.value/2)};})()`);
    if(actual.coverage.filter(p=>p.region===279).every(p=>p.coverage===1))assert.ok(stroke.edge.slice(0,3).reduce((a,b)=>a+b,0)<.9*stroke.interior.slice(0,3).reduce((a,b)=>a+b,0),
        `A settled bitmap retains its dark boundary after preview exit: ${JSON.stringify(stroke)}`);
    await fs.writeFile('/tmp/bitmap-stop3-outlines.png',Buffer.from((await cdp('Page.captureScreenshot',{format:'png'})).data,'base64'));
    assert.equal(browser.errors.length,0,JSON.stringify(browser.errors));
    console.log(JSON.stringify({status:'passed',arrivalFrames:report.frames.length,minInterior:Math.min(...report.frames.map(f=>f.mean)),outlines:report.outlines,exceptions:browser.errors.length}));
} finally {await browser.close();}
