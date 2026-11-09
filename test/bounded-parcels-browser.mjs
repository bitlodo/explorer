import assert from 'node:assert/strict';
import protobuf from 'protobufjs';
import { RectFrustum } from '../src/shared/rectFrustum.ts';
import fs from 'node:fs';
import { browserHarness } from './helpers/browser.mjs';
import {datasetPath} from '../scripts/dataset-path.ts';
import {createServer} from 'vite';
import {clientConfig} from '../vite.config.ts';

const development=process.env.MAP_SMOKE_DEVELOPMENT==='1';
const cfg=clientConfig(),dev=development?await createServer({...cfg,configFile:false,server:{...cfg.server,port:5397,strictPort:true}}):undefined;
const browser = await browserHarness({development});
const { origin, snapshot, manifest, requests, errors, cdp, evaluate, wait, frame, delay } = browser;
let ws;

try {
    await dev?.listen();
    ws = await browser.start();
    await cdp('Emulation.setDeviceMetricsOverride', { width: Number(process.env.MAP_LOD_WIDTH||1600), height: Number(process.env.MAP_LOD_HEIGHT||900), deviceScaleFactor: 1, mobile: false });
    await cdp('Page.navigate', {url:(development?'http://127.0.0.1:5397/':origin+'/repository/')+(process.env.MAP_SMOKE_DEBUG_ONLY==='off'?'?chunks=off':process.env.MAP_SMOKE_PARCELS==='legacy'?'?parcels=legacy':'')});
    await wait("document.readyState==='complete' && document.getElementById('mapCanvas') && !!document.querySelector('canvas')");
    await evaluate(`window.game=()=>{const e=document.getElementById('mapCanvas'),key=Object.keys(e).find(k=>k.startsWith('__reactFiber$'));for(let f=e[key];f;f=f.return)for(let h=f.memoizedState;h;h=h.next)if((h.memoizedState?.current??h.memoizedState)?.controller)return h.memoizedState.current??h.memoizedState;};window.state=()=>game()?.controller;`);
    await wait(`state()?.overview?.slots.length===${browser.manifest.regions.length} && !state().tween?.isPlaying()`);
    await wait('state().preview?.rootsReady && state().source.mode==="static"');

    await evaluate(`(()=>{const s=state(),r=s.overview.slots[205];s.cancelZoom();s.scene.camera.position.set(r.x+r.width*.6,s.distanceLevels()[2],r.y+r.height*.6);s.scene.controls.target.set(s.scene.camera.position.x,0,s.scene.camera.position.z);s.scene.controls.update();s.requestUpdate();})()`);
    await wait('(state().neighborhoodChunks.mode===false ? state().visibleRegions(state().geometryBounds()).every(r=>state().neighborhoodGeometry.has(r.data)) : state().neighborhoodChunks.ready(state().geometryBounds())) && Math.abs(state().lodDetail-state().preview.pyramid.maxLevel-1)<.0001');await frame();
    assert.equal(await evaluate('state().scheduler.desiredCount'),0,'Stop 3 must not request parcels');
    await evaluate(`(()=>{const s=state();window.parcelGates=[];window.parcelJobs=[];window.parcelAudits=[];window.parcelOriginalStream=s.source.streamParcelJob;window.parcelOriginalDesired=s.scheduler.setDesired;
      window.parcelExpectedCamera=()=>{const c=s.scene.camera.clone();c.position.y=Math.min(c.position.y,s.distanceLevels()[1]);c.lookAt(s.scene.controls.target);c.updateMatrixWorld();return c;};
      window.parcelPoints=c=>[[-1,-1],[1,-1],[1,1],[-1,1]].map(([x,y])=>{const direction=c.position.clone().set(x,y,.5).unproject(c).sub(c.position).normalize(),point=c.position.clone().addScaledVector(direction,-c.position.y/direction.y);return{x:point.x,y:point.z};});
      window.parcelAuditIDs=ids=>{const c=parcelExpectedCamera();let outside=0;const examples=[];for(const id of ids){const n=s.neighborhoods.get(Math.floor(id/2016)),r=n?.data.bitmaps[id%2016];if(!r)throw Error('Missing requested bitmap geometry');const corners=[[r.x,r.y],[r.x+r.width,r.y],[r.x,r.y+r.height],[r.x+r.width,r.y+r.height]].map(([x,z])=>c.position.clone().set(n.position.x+x,0,n.position.z+z).project(c));if(corners.every(p=>p.x< -1-1e-6)||corners.every(p=>p.x>1+1e-6)||corners.every(p=>p.y< -1-1e-6)||corners.every(p=>p.y>1+1e-6)){outside++;if(examples.length<8)examples.push(id);}}return{count:ids.length,outside,examples,height:s.scene.camera.position.y,targetHeight:c.position.y};};
      s.scheduler.setDesired=function(ids){if(ids.length)window.parcelAudits.push(window.parcelAuditIDs(ids));return window.parcelOriginalDesired.call(this,ids);};
      s.source.streamParcelJob=async function*(job,signal){window.parcelJobs.push({key:job.key,ids:job.ids.length,chunkX:job.pack?.chunkX,chunkY:job.pack?.chunkY,bytes:job.pack?.bytes||0});await new Promise((resolve,reject)=>{const abort=()=>reject(signal.reason),release=()=>{signal.removeEventListener('abort',abort);resolve();};signal.addEventListener('abort',abort,{once:true});window.parcelGates.push({job,signal,release});if(signal.aborted)abort();});yield* window.parcelOriginalStream.call(this,job,signal);};
      window.readParcelWindow=()=>{const l=s.distanceLevels(),q=Math.log(s.scene.camera.position.y/l[0])/Math.log(l.at(-1)/l[0])*4,t=Math.max(0,Math.min(1,2-q));return{q,target:s.lodTarget,expected:s.preview.pyramid.maxLevel+1+t*t*(3-2*t),detail:s.lodDetail,parcel:s.neighborhoodGeometry.material.uniforms.parcelOpacity.value,selected:s.wantedGeometry.size,desired:s.scheduler.desiredCount,bounds:s.groundBounds()};};})()`);
    const slider=await evaluate('(()=>{const r=document.getElementById("map-zoom-slider").getBoundingClientRect(),d=document.querySelector("[data-zoom-drag]").getBoundingClientRect();return{left:r.left+9,travel:r.width-18,y:d.top+d.height/2};})()'),sliderAt=f=>({x:slider.left+f*slider.travel,y:slider.y});
    await cdp('Input.dispatchMouseEvent',{type:'mousePressed',...sliderAt(.5),button:'left',buttons:1,clickCount:1});
    const coldSamples=[];
    for(const position of [.501,.53,.58,.63,.68,.72,.749]){
        await cdp('Input.dispatchMouseEvent',{type:'mouseMoved',...sliderAt(position),buttons:1});
        await delay(180);await frame();
        const sample=await evaluate('({...readParcelWindow(),jobs:parcelJobs.length,regions:state().neighborhoods.size,pending:state().pendingNeighborhoods.size})');
        assert.ok(sample.selected<=24,'Detail region selection remains bounded');
        assert.equal(await evaluate('parcelAudits.some(a=>a.outside>0)'),false,'Anticipated requests stay inside the final stop-2 footprint');
        coldSamples.push(sample);
    }
    assert.ok(coldSamples.some(s=>s.desired>0),'Parcel selection starts during the approach to stop 2');
    await cdp('Input.dispatchMouseEvent',{type:'mouseMoved',...sliderAt(.75),buttons:1});
    await wait('state().geometryLoads.size===0 && state().pendingNeighborhoods.size===0 && state().scheduler.desiredCount>0 && window.parcelGates.some(g=>!g.signal.aborted)');await frame();
    const snapshotState=await evaluate('(()=>{const s=state(),actual=s.scene.camera.clone(),expected=parcelExpectedCamera();actual.position.y=s.distanceLevels()[2];actual.lookAt(s.scene.controls.target);actual.updateMatrixWorld();return{desired:[...s.scheduler.desired],selected:[...s.wantedGeometry],slots:s.overview.slots.map(r=>({x:r.x,y:r.y,width:r.width,height:r.height})),full:parcelPoints(actual),target:parcelPoints(expected),view:readParcelWindow(),audits:window.parcelAudits};})()');
    const regionType=protobuf.Root.fromJSON(JSON.parse(fs.readFileSync(new URL('../src/shared/proto/neighborhood_descriptor.json',import.meta.url),'utf8'))).lookupType('Neighborhood');
    const geometries=new Map(snapshotState.selected.map(id=>[id,regionType.decode(fs.readFileSync(datasetPath(snapshot,manifest.regions[id].geometry.url)))]));
    const idsFor=points=>{const frustum=new RectFrustum(points),ids=[];for(const [id,data] of geometries){const slot=snapshotState.slots[id];data.bitmaps.forEach((r,index)=>{if(frustum.intersects(r,slot.x,slot.y))ids.push(id*2016+index);});}return ids;};
    const targetIDs=idsFor(snapshotState.target),fullIDs=idsFor(snapshotState.full),targetSet=new Set(targetIDs),outside=snapshotState.desired.filter(id=>!targetSet.has(id));
    const comparison={requestedIDs:snapshotState.desired.length,targetIDs:targetIDs.length,fullIDs:fullIDs.length,outsideIDs:outside.length,outsideExamples:outside.slice(0,8)};
    fs.writeFileSync(process.env.MAP_SMOKE_TRACE||'/tmp/bitmap-explorer-bounded-parcels-trace.json',JSON.stringify({comparison,first:snapshotState.view,audits:snapshotState.audits},null,2)+'\n');
    assert.equal(outside.length,0,'All requested parcels must intersect the final stop-2 view: '+JSON.stringify(comparison));assert.equal(snapshotState.desired.length,targetIDs.length,'The bounded footprint must include every eligible bitmap in selected regions');assert.ok(fullIDs.length>targetIDs.length,'Reproduce an excessive level-3 viewport');
    const samples=[snapshotState.view];
    for(const position of [.53,.58,.63,.68,.72,.75]){await cdp('Input.dispatchMouseEvent',{type:'mouseMoved',...sliderAt(position),buttons:1});await frame();const f=await evaluate('readParcelWindow()');assert.ok(Math.abs(f.target-f.expected)<1e-5,'Distance-driven 3 -> 2 fade target is unchanged');assert.ok(f.selected<=24);samples.push(f);}
    await cdp('Input.dispatchMouseEvent',{type:'mouseReleased',...sliderAt(.75),button:'left',buttons:0,clickCount:1});await wait('!state().zoomDamping.active && Math.abs(state().lodDetail-state().lodTarget)<.0001');await frame();
    const audits=await evaluate('window.parcelAudits');assert.ok(audits.length>0);assert.ok(audits.every(a=>a.outside===0),'Every request throughout the native slider drag stays inside stop 2');
    // Allow just the first spatial pack to arrive; the others stay gated.
    await evaluate(`(()=>{const s=state();window.parcelArrivalFrames=[];window.parcelArrivalId=undefined;window.parcelBegin=s.arrivalFades.begin;s.arrivalFades.begin=function(id){window.parcelBegin.call(this,id);if(window.parcelArrivalId===undefined){window.parcelArrivalId=id;window.parcelArrivalFrames.push({alpha:this.opacityFor(id),parcel:s.neighborhoodGeometry.material.uniforms.parcelOpacity.value});}};window.parcelCapture=true;window.recordParcelArrival=()=>{if(!window.parcelCapture)return;if(window.parcelArrivalId!==undefined)window.parcelArrivalFrames.push({alpha:s.arrivalFades.opacityFor(window.parcelArrivalId),parcel:s.neighborhoodGeometry.material.uniforms.parcelOpacity.value});requestAnimationFrame(recordParcelArrival);};recordParcelArrival();window.parcelGates.find(g=>!g.signal.aborted).release();})()`);
    await wait('window.parcelArrivalId!==undefined && state().arrivalFades.opacityFor(window.parcelArrivalId)===1');await frame();
    const arrivals=await evaluate('window.parcelCapture=false;window.parcelArrivalFrames');assert.equal(arrivals[0].alpha,0);assert.ok(arrivals.some(f=>f.alpha>0&&f.alpha<1));assert.ok(arrivals.every(f=>Math.abs(f.parcel-1)<.0001),'Bitmap arrival does not restart or alter the global slider fade');
    // Resident data keeps its fade clock while zooming out and back in.
    const residentId=await evaluate('window.parcelArrivalId');
    await cdp('Input.dispatchMouseEvent',{type:'mousePressed',...sliderAt(.75),button:'left',buttons:1,clickCount:1});
    const residentSamples=[];
    for(const position of [.7,.65,.6,.501,.5,.501,.6,.65,.7,.749]){
        await cdp('Input.dispatchMouseEvent',{type:'mouseMoved',...sliderAt(position),buttons:1});
        await delay(200);await frame();
        const sample=await evaluate('({...readParcelWindow(),alpha:state().arrivalFades.opacityFor(window.parcelArrivalId),arrival:state().arrivalFades.arrivals[window.parcelArrivalId]/255,jobs:parcelJobs.length})');
        assert.equal(sample.arrival,1,'Zoom must not restart resident arrivals');
        assert.equal(sample.alpha,sample.parcel>0?1:0,'Completed resident arrival is gated only by visibility');
        if(position===.5)assert.equal(sample.desired,0,'Idle stop 3 does not start new parcel requests');
        assert.ok(Math.abs(sample.detail-sample.expected)<.0001,'Resident detail follows the slider through 3↔2');
        residentSamples.push(sample);
    }
    assert.ok(residentSamples.some(s=>s.parcel>0&&s.parcel<1),'Resident parcels retain intermediate fade opacities');
    assert.equal(await evaluate('parcelAudits.some(a=>a.outside>0)'),false,'Continued refinement during the resident fade remains spatially bounded');
    await cdp('Input.dispatchMouseEvent',{type:'mouseMoved',...sliderAt(.75),buttons:1});
    await cdp('Input.dispatchMouseEvent',{type:'mouseReleased',...sliderAt(.75),button:'left',buttons:0,clickCount:1});await wait('!state().zoomDamping.active');
    const initialPan=await evaluate('({x:state().scene.controls.target.x,z:state().scene.controls.target.z})'),w=Number(process.env.MAP_LOD_WIDTH||1600),h=Number(process.env.MAP_LOD_HEIGHT||900);
    await cdp('Input.dispatchMouseEvent',{type:'mousePressed',x:w*.4,y:h*.4,button:'left',buttons:1,clickCount:1});await cdp('Input.dispatchMouseEvent',{type:'mouseMoved',x:w*.55,y:h*.5,buttons:1});await cdp('Input.dispatchMouseEvent',{type:'mouseReleased',x:w*.55,y:h*.5,button:'left',buttons:0,clickCount:1});await delay(180);await frame();
    const pan=await evaluate('({x:state().scene.controls.target.x,z:state().scene.controls.target.z,audit:parcelAuditIDs([...state().scheduler.desired])})');assert.ok(Math.hypot(pan.x-initialPan.x,pan.z-initialPan.z)>10);assert.equal(pan.audit.outside,0,'The parcel request window follows pan');
    const afterPan=await evaluate('({jobs:window.parcelJobs,peak:state().scheduler.stats.maxConcurrentDownloads})');assert.ok(afterPan.peak<=2);
    await evaluate('state().dispose()');assert.deepEqual(errors,[]);
    const result={status:'passed',renderer:'Chrome isolated / SwiftShader',viewport:[w,h],comparison,coldSamples,samples,residentSamples,audits:audits.map(a=>({count:a.count,outside:a.outside,height:a.height,targetHeight:a.targetHeight})),arrivals,residentId,pan,peak:afterPan.peak,jobs:afterPan.jobs,exceptions:errors.length};fs.writeFileSync(process.env.MAP_SMOKE_REPORT||'/tmp/bitmap-explorer-bounded-parcels-browser.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({status:'passed',comparison,coldSamples:coldSamples.length,residentSamples:residentSamples.length,sliderSamples:samples.length,arrivalFrames:arrivals.length,peak:afterPan.peak,exceptions:errors.length}));
} catch(error){console.error(error);if(ws?.readyState===1)console.error(await evaluate('({detail:state()?.lodDetail,target:state()?.lodTarget,desired:state()?.scheduler.desiredCount,regions:state()?.wantedGeometry.size,loaded:state()?.loadedBitmaps.size,audits:window.parcelAudits?.slice(-2),text:document.body.innerText})').catch(String));process.exitCode=1;} finally{if(ws?.readyState===1)await evaluate('state()?.dispose()').catch(()=>{});await browser.close();await dev?.close();}
