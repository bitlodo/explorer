import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {browserHarness} from './helpers/browser.mjs';

const browser=await browserHarness(),{cdp,evaluate,wait,frame}=browser;
try{
 await browser.start();await cdp('Emulation.setDeviceMetricsOverride',{width:1920,height:993,deviceScaleFactor:1,mobile:false});
 await cdp('Page.navigate',{url:browser.origin+'/repository/?chunks=off'});await wait("!!document.getElementById('mapCanvas')");
 await evaluate(`window.state=()=>{const e=document.getElementById('mapCanvas'),k=Object.keys(e).find(k=>k.startsWith('__reactFiber$'));for(let f=e[k];f;f=f.return)for(let h=f.memoizedState;h;h=h.next){const r=h.memoizedState?.current??h.memoizedState;if(r?.controller)return r.controller;}};`);
 await wait('state()?.getState().ready&&!state().getState().renderingBusy&&!!state().preview?.regional');
 const pixels=await evaluate(`(async()=>{
  const T=await import('/test-three.js'),s=state(),renderer=s.runtime.renderer,slots=[{x:0,y:0,width:100,height:100},{x:100,y:0,width:100,height:100}],view={x:0,y:0,width:200,height:100};
  const preview=new s.preview.regional.constructor(slots,Float32Array.of(9,1,9,1));preview.setColors(Array(9).fill('#ffffff'));
  const scene=new T.Scene();scene.add(preview);const camera=new T.OrthographicCamera(0,200,50,-50,.1,100);camera.position.set(0,10,50);camera.up.set(0,0,-1);camera.lookAt(0,0,50);camera.updateMatrixWorld();
  const previous=renderer.getRenderTarget(),tone=renderer.toneMapping,clear=renderer.getClearColor(new T.Color()).clone(),alpha=renderer.getClearAlpha(),scales=[],fade=[];
  let target;
  try{
   renderer.toneMapping=T.NoToneMapping;renderer.setClearColor(0,1);
   const read=(x,y)=>{const pixel=new Uint8Array(4);renderer.readRenderTargetPixels(target,x,y,1,1,pixel);return pixel[0];};
   const draw=()=>{renderer.setRenderTarget(target);renderer.clear();renderer.render(scene,camera);};
   for(const scale of [.5,1,2]){
    target=new T.WebGLRenderTarget(200*scale,100*scale,{samples:4});target.texture.colorSpace=T.LinearSRGBColorSpace;
    preview.updateView(view,1,{opacity:0,cellSize:50,revision:1,coverage:()=>0});
    preview.material.uniforms.borderPixels.value=0;draw();const baseline=read(100*scale-1,50*scale);
    preview.material.uniforms.borderPixels.value=1;draw();
    scales.push({scale,baseline,boundary:read(100*scale-1,50*scale),inside:read(100*scale-2,50*scale),neighbor:read(100*scale,50*scale),cellLeft:read(50*scale-1,50*scale),cellRight:read(50*scale,50*scale),cellAbove:read(75*scale,50*scale-1),bottom:read(75*scale,0)});
    renderer.setRenderTarget(previous);target.dispose();target=undefined;
   }
   target=new T.WebGLRenderTarget(200,100,{samples:4});target.texture.colorSpace=T.LinearSRGBColorSpace;
   for(const q of [0,.25,.5,.75,1,.5,0]){
    preview.updateView(view,1,{opacity:q,cellSize:50,revision:2,coverage:()=>1});draw();
    fade.push({q,inside:read(75,50),border:read(99,50),version:preview.mesh.geometry.attributes.geometryCoverage.version});
   }
   return{scales,fade,programs:renderer.info.programs.every(p=>p.diagnostics?.runnable!==false)};
  }finally{renderer.setRenderTarget(previous);renderer.setClearColor(clear,alpha);renderer.toneMapping=tone;target?.dispose();preview.dispose();}
 })()`);
 assert.ok(pixels.programs);
 for(const p of pixels.scales){
  assert.ok(p.baseline>=254&&p.boundary<=1,`Touching same-color neighborhoods gain a distinct boundary: ${JSON.stringify(p)}`);
  for(const key of ['inside','neighbor','cellLeft','cellRight','cellAbove'])assert.ok(p[key]>=254,`Only original neighborhood edges are inset, never internal owner-cell seams: ${JSON.stringify(p)}`);
  assert.ok(p.bottom<=1,'The bottom boundary is separated too');
 }
 for(const p of pixels.fade){assert.ok(Math.abs(p.inside-255*(1-p.q))<=1);assert.ok(p.border<=1);assert.equal(p.version,pixels.fade[0].version,'Zoom keeps the original fixed coverage buffers');}
 for(const [name,index] of [['overview',4],['preview',3]]){
  await evaluate(`state().setZoomFromControl(state().distanceLevels()[${index}],'drag')`);await frame();
  await fs.writeFile('/tmp/bitmap-neighborhood-borders-'+name+'.png',Buffer.from((await cdp('Page.captureScreenshot',{format:'png'})).data,'base64'));
 }
 await fs.writeFile('/tmp/bitmap-neighborhood-borders.json',JSON.stringify(pixels,null,2)+'\n');
 assert.deepEqual(browser.errors,[]);console.log(JSON.stringify({status:'passed',scales:pixels.scales,fadeSamples:pixels.fade.length,exceptions:browser.errors.length}));
}finally{await browser.close();}
