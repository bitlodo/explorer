import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { browserHarness } from './helpers/browser.mjs';

const browser=await browserHarness();
const {cdp,evaluate,wait,frame}=browser;
try {
    await browser.start();
    await cdp('Page.navigate',{url:browser.origin+'/repository/?chunks=off'});
    await wait("!!document.getElementById('mapCanvas')");
    await evaluate(`window.state=()=>{const e=document.getElementById('mapCanvas'),k=Object.keys(e).find(k=>k.startsWith('__reactFiber$'));for(let f=e[k];f;f=f.return)for(let h=f.memoizedState;h;h=h.next){const r=h.memoizedState?.current??h.memoizedState;if(r?.controller)return r.controller;}};`);
    await wait('state()?.preview?.regional&&state().getState().ready&&!state().getState().renderingBusy');
    const pixels=await evaluate(`(async()=>{
        const T=await import('/test-three.js'),s=state(),renderer=s.runtime.renderer,bounds={x:0,y:0,width:128,height:64};
        const slots=[{...bounds,crown:0,side:'center'}],geometry=new s.neighborhoodGeometry.constructor(slots);
        const preview=new s.preview.regional.constructor(slots,Float32Array.of(9,1));preview.setColors(Array(9).fill('#ffffff'));
        geometry.labels.visible=false;
        geometry.material.uniforms.baseColor.value.set('#ffffff');
        // All IDs belong to owner cell 0. The empty right half belongs to cell 1,
        // outside the queried view, while an unrelated owner is still missing.
        geometry.setWantedChunks(['0,0','-1,0'],{x:0,y:0,width:63,height:32});
        geometry.addChunk({x:0,y:0,size:64,bitmaps:Array.from({length:2016},(_,id)=>id===0?{id,x:0,y:0,width:4,height:4}:{id,x:(id-1)%63,y:4+Math.floor((id-1)/63),width:1,height:1})});
        const scene=new T.Scene();scene.add(preview,geometry);
        const target=new T.WebGLRenderTarget(256,128,{samples:4});target.texture.colorSpace=T.LinearSRGBColorSpace;
        const camera=new T.PerspectiveCamera(15,2,.1,20000);camera.up.set(0,0,-1);camera.position.set(64,64/(2*Math.tan(Math.PI/24)),32);camera.lookAt(64,0,32);camera.updateMatrixWorld();
        const previous=renderer.getRenderTarget(),tone=renderer.toneMapping,clear=renderer.getClearColor(new T.Color()).clone(),alpha=renderer.getClearAlpha(),frames=[],coldFrames=[];
        try {
            renderer.toneMapping=T.NoToneMapping;renderer.setClearColor(0,1);
            const sample=(x,y)=>{const p=new Uint8Array(4);renderer.readRenderTargetPixels(target,x,y,1,1,p);return Array.from(p);};
            for(let now=0;now<=1000;now+=20){
                geometry.updateView(bounds,1,.5,0,now);
                preview.updateView(bounds,1,{opacity:1,cellSize:64,revision:geometry.previewCoverageRevision,coverage:(b,region)=>geometry.previewCoverage(b,region)});
                renderer.setRenderTarget(target);renderer.clear();renderer.render(scene,camera);
                const entry=geometry.chunks.get('0,0');
                coldFrames.push({now,arrival:entry.arrival.opacity,exit:entry.previewExit.opacity,hole:sample(192,64),gap:sample(41,95),interior:sample(4,123)});
            }
            for(const q of [0,.1,.25,.5,.75,.9,.99,.999,1,.999,.9,.5,0]){
                geometry.updateView(bounds,q,.5,0,1000);
                preview.updateView(bounds,1,{opacity:q,cellSize:64,revision:geometry.previewCoverageRevision,coverage:(b,region)=>geometry.previewCoverage(b,region)});
                renderer.setRenderTarget(target);renderer.clear();renderer.render(scene,camera);
                const out=new Uint8Array(4);renderer.readRenderTargetPixels(target,192,64,1,1,out);
                frames.push({q,pixel:Array.from(out),coverage:preview.patches.map(p=>p.coverage),version:preview.mesh.geometry.attributes.geometryCoverage.version});
            }
            return{frames,coldFrames,programs:renderer.info.programs.every(p=>p.diagnostics?.runnable!==false)};
        } finally {renderer.setRenderTarget(previous);renderer.setClearColor(clear,alpha);renderer.toneMapping=tone;target.dispose();geometry.dispose();preview.dispose();}
    })()`);
    await fs.writeFile('/tmp/bitmap-preview-transition-pixels.json',JSON.stringify(pixels,null,2)+'\n');
    assert.ok(pixels.programs,'Shaders compile');
    for(const f of pixels.coldFrames){
        assert.ok(f.interior[0]>=254,'Opaque preview support prevents an interior brightness dip');
        if(f.arrival<1){
            assert.equal(f.exit,0,'Preview exit waits for opaque vectors');
            assert.ok(f.gap[0]>=254,'No painted black border appears above the preview during arrival');
        }
        assert.ok(Math.abs(f.hole[0]-255*(1-f.exit))<=1,'Natural empty space follows the local preview exit');
    }
    assert.ok(pixels.coldFrames.filter(f=>f.exit>0&&f.exit<1).length>=10,'Preview exit contains intermediate frames');
    for(let i=1;i<pixels.coldFrames.length;i++)assert.ok(pixels.coldFrames[i-1].hole[0]-pixels.coldFrames[i].hole[0]<=30,'Preview never cuts away in one frame');
    for(const f of pixels.frames){
        assert.ok(Math.abs(f.pixel[0]-255*(1-f.q))<=1,`Natural gaps follow the linear fade through its endpoint: ${JSON.stringify(f)}`);
        assert.ok(f.coverage.every(c=>c===1),'The complete neighborhood certifies its natural empty cells');
        assert.equal(f.version,pixels.frames[0].version,'Zoom does not upload or rebuild fixed coverage patches');
    }
    await cdp('Emulation.setDeviceMetricsOverride',{width:1600,height:900,deviceScaleFactor:1,mobile:false});
    await evaluate(`(()=>{const s=state(),r=s.overview.slots[178];s.cancelZoom();s.tween?.stop();s.scene.camera.position.set(r.x+r.width/2,s.distanceLevels()[2],r.y+r.height/2);s.scene.controls.target.set(r.x+r.width/2,0,r.y+r.height/2);s.scene.controls.update();s.requestUpdate();})()`);
    await wait('state().neighborhoodChunks.mode===false?state().visibleRegions(state().geometryBounds()).every(r=>state().neighborhoodGeometry.has(r.data)):state().neighborhoodChunks.ready(state().geometryBounds())');
    await wait('[...state().neighborhoodGeometry.regions.values(),...state().neighborhoodGeometry.chunks.values()].filter(e=>e.mesh.visible).every(e=>e.previewExit.opacity===1)');
    const trace=[];
    for(const q of [0,.25,.5,.75,.9,.99,.999,1,1.0001]){
        await evaluate(`state().setZoomFromControl(Math.exp(Math.log(state().distanceLevels()[3])+${q}*(Math.log(state().distanceLevels()[2])-Math.log(state().distanceLevels()[3]))),'drag')`);await frame();
        const sample=await evaluate(`(()=>{const s=state(),p=s.preview.regional,g=s.neighborhoodGeometry;return{q:${q},detail:s.lodDetail,previewGeometry:p.material.uniforms.geometryOpacity.value,strength:p.material.uniforms.opacity.value,parcel:g.material.uniforms.parcelOpacity.value};})()`);
        assert.ok(Math.abs(sample.previewGeometry-Math.min(1,q))<1e-6,'Actual zoom preserves the linear preview/vector blend');
        assert.equal(sample.parcel,0,'Subpixel rounding at stop 3 does not start the parcel band');
        trace.push(sample);
        if(q===.5||q===1)await fs.writeFile(`/tmp/bitmap-preview-transition-${q===1?'complete':'half'}.png`,Buffer.from((await cdp('Page.captureScreenshot',{format:'png'})).data,'base64'));
    }
    // Hold new geometry downloads, then perform a genuine mouse drag at fixed
    // stop 3. Local arrival clocks are stepped deterministically after release.
    await evaluate(`(async()=>{const s=state(),g=s.neighborhoodGeometry;window.panNow=0;window.panReleased=false;window.panGates=[];window.panChunks=new Map();window.panIndexReleased=false;window.panIndexGates=[];window.panDownloads=[];window.panResidentKeys=new Set(g.chunks.keys());
        window.panSource=s.source.getNeighborhoodChunk.bind(s.source);window.panAdd=g.addChunk.bind(g);
        window.panIndexSource=s.source.getNeighborhoodChunkRefs.bind(s.source);
        s.source.getNeighborhoodChunkRefs=async(bounds,signal)=>{if(!window.panIndexReleased)await new Promise((resolve,reject)=>{window.panIndexGates.push(resolve);signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});return window.panIndexSource(bounds,signal);};
        s.source.getNeighborhoodChunk=async(ref,signal)=>{window.panDownloads.push(ref.x+','+ref.y);if(!window.panReleased)await new Promise((resolve,reject)=>{window.panGates.push(resolve);signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});return window.panSource(ref,signal);};
        g.addChunk=chunk=>{const key=chunk.x+','+chunk.y,old=g.hasChunk(key),added=window.panAdd(chunk);if(added&&!old){const e=g.chunks.get(key),a=e.arrival.update.bind(e.arrival),p=e.previewExit.update.bind(e.previewExit);e.arrival.update=()=>a(window.panNow);e.previewExit.update=()=>p(window.panNow);window.panChunks.set(key,chunk);}return added;};
        window.findResident=(v,requireCoverage=false)=>{for(const [key,e] of g.chunks){if(!window.panResidentKeys.has(key))continue;const box=e.mesh.geometry.boundingBox;if(e.mesh.position.x>=v.x+v.width||e.mesh.position.x+box.max.x<=v.x||e.mesh.position.z>=v.y+v.height||e.mesh.position.z+box.max.z<=v.y)continue;const a=e.mesh.geometry.attributes.bitmapRect.array,ids=e.mesh.geometry.attributes.bitmapId.array;for(let i=0;i<e.mesh.geometry.instanceCount;i++){const k=i*4,b={id:ids[i],key,x:e.mesh.position.x+a[k],y:e.mesh.position.z+a[k+1],width:a[k+2]+.5,height:a[k+3]+.5};if(Math.min(b.width,b.height)*s.pixelsPerWorld()<8||b.x<v.x+50/s.pixelsPerWorld()||b.y<v.y+20/s.pixelsPerWorld()||b.x+b.width>v.x+v.width-50/s.pixelsPerWorld()||b.y+b.height>v.y+v.height-20/s.pixelsPerWorld())continue;if(!requireCoverage)return b;const region=Math.floor(b.id/2016),p=s.preview.regional.patches.find(p=>p.region===region&&b.x+b.width/2>=p.bounds.x&&b.x+b.width/2<p.bounds.x+p.bounds.width&&b.y+b.height/2>=p.bounds.y&&b.y+b.height/2<p.bounds.y+p.bounds.height);if(!p||g.previewCoverage(p.bounds,region)!==1)continue;return b;}}return undefined;};
        const view=s.groundBounds(s.distanceLevels()[2]),origin=s.scene.controls.target,indices=s.overview.slots.map((r,id)=>({r,id})).sort((a,b)=>Number(b.id===326)-Number(a.id===326)||Math.hypot(a.r.x-origin.x,a.r.y-origin.z)-Math.hypot(b.r.x-origin.x,b.r.y-origin.z));
        let chosen;for(const item of indices){const r=item.r,b={x:r.x+r.width/2-view.width/2,y:r.y+r.height/2-view.height/2,width:view.width,height:view.height};const future={...b,x:b.x+view.width*150/s.runtime.renderer.domElement.clientWidth};if(!window.findResident(future))continue;const refs=await window.panIndexSource(future,new AbortController().signal);if(refs?.some(ref=>!g.hasChunk(ref.x+','+ref.y))){chosen=item;break;}}
        if(!chosen)throw Error('No mixed resident/cold viewport in the published fixture');window.panRegion=chosen.id;const r=chosen.r;
        s.cancelZoom();s.tween?.stop();s.scene.camera.position.set(r.x+r.width/2,s.distanceLevels()[2],r.y+r.height/2);s.scene.controls.target.set(r.x+r.width/2,0,r.y+r.height/2);s.scene.controls.update();s.requestUpdate();g.labels.visible=false;})()`);
    await frame();
    const beforePan=await evaluate('({x:state().scene.controls.target.x,height:state().scene.camera.position.y})');
    await cdp('Input.dispatchMouseEvent',{type:'mousePressed',x:850,y:470,button:'left',buttons:1,clickCount:1});
    for(const x of [800,750,700]){await cdp('Input.dispatchMouseEvent',{type:'mouseMoved',x,y:470,buttons:1});await frame();}
    await cdp('Input.dispatchMouseEvent',{type:'mouseReleased',x:700,y:470,button:'left',buttons:0,clickCount:1});
    const afterPan=await evaluate('({x:state().scene.controls.target.x,height:state().scene.camera.position.y})');
    assert.ok(Math.abs(afterPan.x-beforePan.x)>10,'Native pan moves to the cold area');
    assert.ok(Math.abs(afterPan.height-beforePan.height)<1e-6,'Cold pan keeps stop-3 zoom fixed');
    await wait('window.panIndexGates.length>0');
    // A shared border pixel can include the independently fading neighbor.
    // Sample the resident interior here; the coverage assertion and isolated
    // gap-pixel regression separately detect a returning summary.
    // Inactive fallback layers intentionally skip coverage updates. Probe the
    // resident coverage proof while pixels verify that no preview is restored.
    const residentBefore=await evaluate(`(()=>{const s=state(),g=s.neighborhoodGeometry,b=window.findResident(s.groundBounds(),true);if(!b)throw Error('No settled resident bitmap remains after native pan');window.residentBitmap=b;window.residentEntry=g.chunks.get(b.key);window.residentBuffer=window.residentEntry.mesh.geometry.attributes.bitmapRect.array;
        window.readResident=()=>{const s=state(),g=s.neighborhoodGeometry,b=window.residentBitmap,e=g.chunks.get(b.key),canvas=s.runtime.renderer.domElement,gl=s.runtime.renderer.getContext(),x=b.x+b.width/2,z=b.y+b.height/2,p=s.scene.camera.position.clone().set(x,0,z).project(s.scene.camera),out=new Uint8Array(4);s.scene.render();gl.readPixels(Math.floor((p.x+1)*canvas.width/2),Math.floor((p.y+1)*canvas.height/2),1,1,gl.RGBA,gl.UNSIGNED_BYTE,out);const patch=s.preview.regional.patches.find(p=>p.region===Math.floor(b.id/2016)&&x>=p.bounds.x&&x<p.bounds.x+p.bounds.width&&z>=p.bounds.y&&z<p.bounds.y+p.bounds.height);return{bitmap:b.id,key:b.key,pixel:Array.from(out),arrival:e?.arrival.opacity,exit:e?.previewExit.opacity,sameEntry:e===window.residentEntry,sameBuffer:e?.mesh.geometry.attributes.bitmapRect.array===window.residentBuffer,coverage:patch?g.previewCoverage(patch.bounds,Math.floor(b.id/2016)):undefined};};return window.readResident();})()`);
    const residentStable=value=>{
        assert.ok(value.sameEntry&&value.sameBuffer,'Resident bitmap buffers are retained');
        assert.equal(value.arrival,1,'Resident vector arrival never restarts');assert.equal(value.exit,1,'Resident preview exit never restarts');
        assert.equal(value.coverage,1,'New owners never restore preview over the resident patch');
        assert.ok(value.pixel.every((v,i)=>Math.abs(v-residentBefore.pixel[i])<=2),`Resident interior pixels remain stable: ${JSON.stringify({before:residentBefore,after:value})}`);
    };
    await evaluate('window.panIndexReleased=true;for(const release of window.panIndexGates)release()');
    await wait('window.panGates.length>0');await frame();residentStable(await evaluate('window.readResident()'));
    await evaluate('window.panReleased=true;for(const release of window.panGates)release()');
    await wait('state().neighborhoodChunks.ready(state().geometryBounds())&&window.panChunks.size>0');
    await evaluate(`(()=>{const s=state(),g=s.neighborhoodGeometry,v=s.groundBounds(),scale=s.pixelsPerWorld();
        const candidates=[...window.panChunks.values()].flatMap(c=>c.bitmaps).filter(b=>g.completeRegionOwners.get(Math.floor(b.id/2016))?.count===2016&&Math.min(b.width,b.height)*scale>8&&b.x>v.x+5/scale&&b.y>v.y+5/scale&&b.x+b.width<v.x+v.width-5/scale&&b.y+b.height<v.y+v.height-5/scale);
        candidates.sort((a,b)=>Number(Math.floor(b.id/2016)===326)-Number(Math.floor(a.id/2016)===326));
        window.panBitmap=candidates[0];if(!window.panBitmap)throw Error('No fully covered cold bitmap in the pan viewport');})()`);
    const panFrames=[];
    for(const now of [0,200,400,600,650,700,750,800,850,900,1000]){
        await evaluate(`(()=>{const s=state(),g=s.neighborhoodGeometry;while(window.panNow<${now}){window.panNow=Math.min(${now},window.panNow+20);g.updateView(s.groundBounds(),1,1/s.pixelsPerWorld(),0,window.panNow);}})()`);await frame();
        const sample=await evaluate(`(()=>{const s=state(),g=s.neighborhoodGeometry,b=window.panBitmap,region=Math.floor(b.id/2016),canvas=s.runtime.renderer.domElement,gl=s.runtime.renderer.getContext();
            const edge=s.scene.camera.position.clone().set(b.x+b.width/2,0,b.y+b.height-g.material.uniforms.bitmapMargin.value/2).project(s.scene.camera);
            const read=()=>{const p=new Uint8Array(4);gl.readPixels(Math.floor((edge.x+1)*canvas.width/2),Math.floor((edge.y+1)*canvas.height/2),1,1,gl.RGBA,gl.UNSIGNED_BYTE,p);return Array.from(p);};
            s.scene.render();const pixel=read();g.visible=false;s.scene.render();const support=read();g.visible=true;s.scene.render();
            const owners=g.completeRegionOwners.get(region).owners,entries=[...owners].map(k=>g.chunks.get(k));
            return{now:${now},bitmap:b.id,arrival:Math.min(...entries.map(e=>e.arrival.opacity)),exit:Math.min(...entries.map(e=>e.previewExit.opacity)),pixel,support,height:s.scene.camera.position.y,desired:s.scheduler.desiredCount};})()`);
        if(sample.arrival<1)assert.ok(sample.pixel.slice(0,3).reduce((a,b)=>a+b,0)>=sample.support.slice(0,3).reduce((a,b)=>a+b,0)-8,`Native cold pan has no artificial black outline over preview: ${JSON.stringify(sample)}`);
        assert.equal(sample.desired,0,'Stop-3 pan never requests parcels');
        assert.ok(Math.abs(sample.height-afterPan.height)<1e-6,'Arrival does not change zoom');
        panFrames.push(sample);
        residentStable(await evaluate('window.readResident()'));
        if([400,750,1000].includes(now))await fs.writeFile(`/tmp/bitmap-cold-pan-${now}.png`,Buffer.from((await cdp('Page.captureScreenshot',{format:'png'})).data,'base64'));
    }
    assert.ok(panFrames.some(f=>f.exit>0&&f.exit<1&&f.arrival===1),'Real cold data releases the preview only after vector arrival');
    assert.equal(panFrames.at(-1).exit,1,'Cold preview finishes its exit');
    const residentRequests=await evaluate('window.panDownloads.filter(key=>window.panResidentKeys.has(key))');
    assert.deepEqual(residentRequests,[],'The loader never redownloads resident geometry');
    await fs.writeFile('/tmp/bitmap-preview-transition.json',JSON.stringify({pixels,trace,beforePan,afterPan,residentBefore,residentRequests,panFrames},null,2)+'\n');
    assert.equal(browser.errors.length,0,JSON.stringify(browser.errors));
    console.log(JSON.stringify({status:'passed',pixelFrames:pixels.frames.length,coldPixelFrames:pixels.coldFrames.length,panSamples:panFrames.length,zoomSamples:trace.length,exceptions:browser.errors.length}));
} finally {await browser.close();}
