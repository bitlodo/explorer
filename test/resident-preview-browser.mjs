import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {browserHarness} from './helpers/browser.mjs';

const browser=await browserHarness(),{cdp,evaluate,wait,frame}=browser;
try{
 await browser.start();
 await cdp('Emulation.setDeviceMetricsOverride',{width:1600,height:900,deviceScaleFactor:1,mobile:false});
 await cdp('Page.navigate',{url:browser.origin+'/repository/?chunks=off'});
 await wait("!!document.getElementById('mapCanvas')");
 await evaluate(`window.state=()=>{const e=document.getElementById('mapCanvas'),k=Object.keys(e).find(k=>k.startsWith('__reactFiber$'));for(let f=e[k];f;f=f.return)for(let h=f.memoizedState;h;h=h.next){const r=h.memoizedState?.current??h.memoizedState;if(r?.controller)return r.controller;}};`);
 await wait('state()?.preview?.regional&&state().getState().ready&&!state().getState().renderingBusy');
 const pixels=await evaluate(`(async()=>{
  const T=await import('/test-three.js'),s=state(),renderer=s.runtime.renderer;
  const view={x:-100,y:0,width:200,height:100},patch={x:0,y:0,width:100,height:100},slots=[{...view,crown:0,side:'center'}];
  const geometry=new s.neighborhoodGeometry.constructor(slots),preview=new s.preview.regional.constructor(slots,Float32Array.of(9,1));
  geometry.labels.visible=false;geometry.material.uniforms.baseColor.value.set('#ffffff');preview.setColors(Array(9).fill('#ffffff'));
  const scene=new T.Scene();scene.add(preview,geometry);
  const target=new T.WebGLRenderTarget(400,200,{samples:4});target.texture.colorSpace=T.LinearSRGBColorSpace;
  const camera=new T.PerspectiveCamera(15,2,.1,20000);camera.up.set(0,0,-1);camera.position.set(0,100/(2*Math.tan(Math.PI/24)),50);camera.lookAt(0,0,50);camera.updateMatrixWorld();
  const previous=renderer.getRenderTarget(),tone=renderer.toneMapping,clear=renderer.getClearColor(new T.Color()).clone(),alpha=renderer.getClearAlpha(),samples=[];
  try{
   renderer.toneMapping=T.NoToneMapping;renderer.setClearColor(0,1);
   geometry.addChunk({x:0,y:0,size:100,bitmaps:[{id:0,x:20,y:10,width:60,height:80}]});geometry.setWantedChunks(['0,0'],patch);
   const oldEntry=geometry.chunks.get('0,0'),buffer=oldEntry.mesh.geometry.attributes.bitmapRect.array;
   const render=stage=>{preview.updateView(view,1,{opacity:1,cellSize:100,revision:geometry.previewCoverageRevision,coverage:(bounds,region)=>geometry.previewCoverage(bounds,region)});renderer.setRenderTarget(target);renderer.clear();renderer.render(scene,camera);const read=x=>{const p=new Uint8Array(4);renderer.readRenderTargetPixels(target,x,100,1,1,p);return Array.from(p);};samples.push({stage,gap:read(380),interior:read(300),coverage:preview.patches.find(p=>p.bounds.x===0).coverage,sameEntry:geometry.chunks.get('0,0')===oldEntry,sameBuffer:geometry.chunks.get('0,0')?.mesh.geometry.attributes.bitmapRect.array===buffer,arrival:oldEntry.arrival.opacity,exit:oldEntry.previewExit.opacity});};
   for(let now=0;now<=1000;now+=20)geometry.updateView(patch,1,.5,0,now);
   render('settled');
   // A new query discovers a conservative incoming extent. It must not refill
   // already revealed gaps in a partially resident neighborhood.
   geometry.setWantedChunks(['0,0','-1,0'],view,new Map([['-1,0',{x:-100,y:0,width:110,height:110}]]));render('pending');
   geometry.addChunk({x:-1,y:0,size:100,bitmaps:[{id:1,x:-10,y:10,width:20,height:80}]});
   for(let now=1020;now<=2020;now+=20){geometry.updateView(view,1,.5,0,now);render(now);}
   geometry.removeChunk('-1,0');render('unrelated-eviction');
   geometry.removeChunk('0,0');render('contributing-eviction');
   return samples;
  }finally{renderer.setRenderTarget(previous);renderer.setClearColor(clear,alpha);renderer.toneMapping=tone;target.dispose();geometry.dispose();preview.dispose();}
 })()`);
 for(const p of pixels.slice(0,-1)){
  assert.equal(p.coverage,1,`Resident handoff remains complete: ${p.stage}`);
  assert.ok(p.gap.slice(0,3).every(v=>v<=1),`The neighborhood summary does not refill resident gaps: ${JSON.stringify(p)}`);
  assert.ok(p.interior.slice(0,3).every(v=>v>=254),'Resident bitmap interiors stay opaque');
  assert.ok(p.sameEntry&&p.sameBuffer&&p.arrival===1&&p.exit===1,'Resident buffers and completed clocks stay intact');
 }
 assert.equal(pixels.at(-1).coverage,0,'Evicting the supporting geometry restores its preview');
 assert.ok(pixels.at(-1).gap.slice(0,3).every(v=>v>=254));
 // Audit every visible patch during consecutive native drags, rather than
 // selecting one already-complete neighborhood or waiting after each drag.
 await evaluate(`(()=>{const s=state(),r=s.overview.slots[326];s.cancelZoom();s.tween?.stop();s.scene.camera.position.set(r.x+r.width/2,s.distanceLevels()[2],r.y+r.height/2);s.scene.controls.target.set(r.x+r.width/2,0,r.y+r.height/2);s.scene.controls.update();s.requestUpdate();window.residentAudit={frames:0,patches:0,drops:[],entries:new Map(),coverage:new Map()};const update=s.updateLOD.bind(s);s.updateLOD=()=>{update();const a=window.residentAudit,g=s.neighborhoodGeometry,v=s.groundBounds();a.frames++;if(g.material.uniforms.opacity.value!==1)a.drops.push({kind:'lod',detail:s.lodDetail});for(const [key,e] of g.chunks){if(!e.mesh.visible)continue;const previous=a.entries.get(key);if(previous&&previous!==e)a.drops.push({kind:'buffer',key});a.entries.set(key,e);}for(const p of s.preview.regional.patches){if(p.bounds.x>=v.x+v.width||p.bounds.x+p.bounds.width<=v.x||p.bounds.y>=v.y+v.height||p.bounds.y+p.bounds.height<=v.y)continue;const key=p.region+':'+p.bounds.x+','+p.bounds.y,previous=a.coverage.get(key);if(previous>p.coverage+.00001)a.drops.push({kind:'preview',key,previous,next:p.coverage});a.coverage.set(key,p.coverage);a.patches++;}};})()`);
 await wait('[...state().neighborhoodGeometry.chunks.values()].some(e=>e.previewExit.opacity===1)');
 for(let n=0;n<12;n++){
  const start=n<6?1100:600,points=n<6?[1000,900,800,700,600]:[700,800,900,1000,1100];
  await cdp('Input.dispatchMouseEvent',{type:'mousePressed',x:start,y:470,button:'left',buttons:1,clickCount:1});
  for(const x of points){await cdp('Input.dispatchMouseEvent',{type:'mouseMoved',x,y:470,buttons:1});await frame();}
  await cdp('Input.dispatchMouseEvent',{type:'mouseReleased',x:points.at(-1),y:470,button:'left',buttons:0,clickCount:1});
 }
 await wait('state().neighborhoodChunks.ready(state().geometryBounds())');
 const audit=await evaluate('({frames:residentAudit.frames,patches:residentAudit.patches,drops:residentAudit.drops,entries:residentAudit.entries.size})');
 assert.ok(audit.frames>20&&audit.patches>20&&audit.entries>0);assert.deepEqual(audit.drops,[]);
 assert.deepEqual(browser.errors,[]);
 await fs.writeFile('/tmp/bitmap-resident-preview.json',JSON.stringify({pixels,audit},null,2)+'\n');
 await fs.writeFile('/tmp/bitmap-resident-preview.png',Buffer.from((await cdp('Page.captureScreenshot',{format:'png'})).data,'base64'));
 console.log(JSON.stringify({status:'passed',pixelSamples:pixels.length,...audit,exceptions:browser.errors.length}));
}finally{await browser.close();}
