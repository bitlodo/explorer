import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {browserHarness} from './helpers/browser.mjs';

const browser=await browserHarness(),{cdp,evaluate,wait}=browser;
try{
 await browser.start();await cdp('Page.navigate',{url:browser.origin+'/repository/?chunks=off'});
 await wait("!!document.getElementById('mapCanvas')");
 await evaluate(`window.state=()=>{const e=document.getElementById('mapCanvas'),k=Object.keys(e).find(k=>k.startsWith('__reactFiber$'));for(let f=e[k];f;f=f.return)for(let h=f.memoizedState;h;h=h.next){const r=h.memoizedState?.current??h.memoizedState;if(r?.controller)return r.controller;}};`);
 await wait('state()?.preview?.regional&&state().getState().ready&&!state().getState().renderingBusy');
 const samples=await evaluate(`(async()=>{
  const T=await import('/test-three.js'),s=state(),renderer=s.runtime.renderer;
  const a={x:0,y:0,width:100,height:100},b={x:100,y:0,width:100,height:100},all={x:0,y:0,width:200,height:100};
  const slots=[a,b].map(r=>({...r,crown:0,side:'center'}));
  const geometry=new s.neighborhoodGeometry.constructor(slots),preview=new s.preview.regional.constructor(slots,Float32Array.of(9,1,9,1));
  geometry.labels.visible=false;geometry.material.uniforms.baseColor.value.set('#ffffff');preview.setColors(Array(9).fill('#ffffff'));
  const scene=new T.Scene();scene.add(preview,geometry);const target=new T.WebGLRenderTarget(400,400,{samples:4});target.texture.colorSpace=T.LinearSRGBColorSpace;
  const camera=new T.PerspectiveCamera(15,1,.1,20000);camera.up.set(0,0,-1);
  const position=view=>{camera.position.set(view.x+50,100/(2*Math.tan(Math.PI/24)),50);camera.lookAt(view.x+50,0,50);camera.updateMatrixWorld();};
  const previous=renderer.getRenderTarget(),tone=renderer.toneMapping,clear=renderer.getClearColor(new T.Color()).clone(),alpha=renderer.getClearAlpha(),out=[];
  try{
   renderer.toneMapping=T.NoToneMapping;renderer.setClearColor(0,1);
   const sample=stage=>{renderer.setRenderTarget(target);renderer.clear();renderer.render(scene,camera);const point=new T.Vector3(90,0,50).project(camera),pixel=new Uint8Array(4);renderer.readRenderTargetPixels(target,Math.floor((point.x+1)*200),Math.floor((point.y+1)*200),1,1,pixel);out.push({stage,pixel:Array.from(pixel),cpu:preview.patches.map(p=>p.coverage),visible:preview.visible,ranges:preview.mesh.geometry.attributes.geometryCoverage.updateRanges.map(r=>({...r}))});};
   // Upload the initial all-preview mask, as at zoom stop 4.
   position(a);geometry.visible=false;preview.updateView(all,1,{opacity:1,cellSize:100,revision:0,coverage:()=>0});sample('initial');
   geometry.addRegion({neighborhood:0,width:100,height:100,bitmaps:[{x:0,y:0,width:80,height:90}]},a);
   for(let now=0;now<=1000;now+=20)geometry.updateView(a,1,.25,0,now);
   preview.updateView(a,1,{opacity:1,cellSize:100,revision:1,coverage:r=>r.x===0?1:0});sample('resident-hidden');
   // A neighboring patch has already started its independent exit when pan
   // reveals it. Updating B must retain A's still-pending GPU range.
   geometry.addRegion({neighborhood:1,width:100,height:100,bitmaps:[{x:0,y:0,width:80,height:90}]},b);
   for(let now=1020;now<=1740;now+=20)geometry.updateView(all,1,.25,0,now);
   const pan={x:50,y:0,width:100,height:100};position(pan);
   preview.updateView(pan,1,{opacity:1,cellSize:100,revision:2,coverage:r=>r.x===0?1:.25});sample('pan-new-preview');
   preview.updateView(pan,1,{opacity:1,cellSize:100,revision:3,coverage:()=>1});sample('complete-hidden');
   return out;
  }finally{renderer.setRenderTarget(previous);renderer.setClearColor(clear,alpha);renderer.toneMapping=tone;target.dispose();geometry.dispose();preview.dispose();}
 })()`);
 await fs.writeFile('/tmp/bitmap-preview-upload.json',JSON.stringify(samples,null,2)+'\n');
 assert.deepEqual(samples[1].cpu,[1,0]);assert.equal(samples[1].visible,false);
 assert.ok(samples[1].pixel.slice(0,3).every(v=>v<=1));
 assert.deepEqual(samples[2].cpu,[1,.25]);assert.equal(samples[2].visible,true);
 assert.ok(samples[2].pixel.slice(0,3).every(v=>v<=1),`A resident gap must stay black when a neighboring preview draws: ${JSON.stringify(samples)}`);
 assert.ok(samples[3].pixel.slice(0,3).every(v=>v<=1));
 await cdp('Emulation.setDeviceMetricsOverride',{width:2048,height:1080,deviceScaleFactor:1,mobile:false});
 await evaluate(`(()=>{const s=state(),r=s.overview.slots[448];s.cancelZoom();s.tween?.stop();s.scene.camera.position.set(r.x+r.width/2,s.distanceLevels()[2],r.y+r.height/2);s.scene.controls.target.set(r.x+r.width/2,0,r.y+r.height/2);s.scene.controls.update();s.requestUpdate();window.gpuAudit={draws:0,compared:0,mismatches:[]};s.preview.regional.mesh.onAfterRender=(renderer,_scene,_camera,geometry,material)=>{const attribute=geometry.attributes.geometryCoverage,gl=renderer.getContext(),program=renderer.properties.get(material).currentProgram,location=program.getAttributes().geometryCoverage.location,buffer=gl.getVertexAttrib(location,gl.VERTEX_ATTRIB_ARRAY_BUFFER_BINDING),previous=gl.getParameter(gl.COPY_READ_BUFFER_BINDING),gpu=new Float32Array(attribute.array.length);gl.bindBuffer(gl.COPY_READ_BUFFER,buffer);gl.getBufferSubData(gl.COPY_READ_BUFFER,0,gpu);gl.bindBuffer(gl.COPY_READ_BUFFER,previous);const a=window.gpuAudit;a.draws++;for(let i=0;i<gpu.length;i++){a.compared++;if(Math.abs(gpu[i]-attribute.array[i])>1e-6&&a.mismatches.length<10)a.mismatches.push({draw:a.draws,patch:i,region:s.preview.regional.patches[i].region,cpu:attribute.array[i],gpu:gpu[i]});}};})()`);
 await wait('state().neighborhoodChunks.mode===false?state().visibleRegions(state().geometryBounds()).every(r=>state().neighborhoodGeometry.has(r.data)):state().neighborhoodChunks.ready(state().geometryBounds())');
 await wait('[...state().neighborhoodGeometry.chunks.values(),...state().neighborhoodGeometry.regions.values()].filter(e=>e.mesh.visible).every(e=>e.previewExit.opacity===1)');
 const panSnapshots=[];
 for(let n=0;n<16;n++){
  const vertical=n<12,forward=n<6||n>=12,from={x:1100,y:vertical?(forward?760:340):540},to={x:vertical?1100:(forward?680:1520),y:vertical?(forward?340:760):540};
  await cdp('Input.dispatchMouseEvent',{type:'mousePressed',...from,button:'left',buttons:1,clickCount:1});
  for(let i=1;i<=4;i++){await cdp('Input.dispatchMouseEvent',{type:'mouseMoved',x:from.x+(to.x-from.x)*i/4,y:from.y+(to.y-from.y)*i/4,buttons:1});await browser.frame();}
  await cdp('Input.dispatchMouseEvent',{type:'mouseReleased',...to,button:'left',buttons:0,clickCount:1});
  panSnapshots.push(await evaluate('({x:state().scene.camera.position.x,z:state().scene.camera.position.z,detail:state().lodDetail,draws:gpuAudit.draws})'));
  if(n===1||n===7)await fs.writeFile('/tmp/bitmap-preview-upload-pan-'+n+'.png',Buffer.from((await cdp('Page.captureScreenshot',{format:'png'})).data,'base64'));
 }
 const gpu=await evaluate('gpuAudit');
 await fs.writeFile('/tmp/bitmap-preview-upload.json',JSON.stringify({samples,gpu,panSnapshots},null,2)+'\n');
 assert.ok(gpu.draws>1&&gpu.compared>100,'The real map checks coverage uploads while new previews render');
 assert.deepEqual(gpu.mismatches,[],'Every rendered GPU mask matches all CPU patches, including earlier hidden writes');
 assert.deepEqual(browser.errors,[]);console.log(JSON.stringify({status:'passed',samples,gpu,pans:panSnapshots.length,exceptions:browser.errors.length}));
}finally{await browser.close();}
