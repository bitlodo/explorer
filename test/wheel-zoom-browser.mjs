import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {browserHarness} from './helpers/browser.mjs';
import {createServer} from 'vite';
import {clientConfig} from '../vite.config.ts';

const development=process.env.MAP_SMOKE_DEVELOPMENT==='1';
const config=clientConfig(),dev=development?await createServer({...config,configFile:false,server:{...config.server,port:5398,strictPort:true}}):undefined;
const browser=await browserHarness({development}),{cdp,evaluate,wait,frame,delay}=browser;
try{
 await dev?.listen();await browser.start();
 await cdp('Emulation.setDeviceMetricsOverride',{width:1600,height:900,deviceScaleFactor:1,mobile:false});
 await cdp('Page.navigate',{url:(development?'http://127.0.0.1:5398/':browser.origin+'/repository/')+'?chunks=off'});
 await wait("!!document.getElementById('mapCanvas')");
 await evaluate(`window.state=()=>{const e=document.getElementById('mapCanvas'),k=Object.keys(e).find(k=>k.startsWith('__reactFiber$'));for(let f=e[k];f;f=f.return)for(let h=f.memoizedState;h;h=h.next){const r=h.memoizedState?.current??h.memoizedState;if(r?.controller)return r.controller;}};`);
 await wait('state()?.getState().ready&&state().preview?.rootsReady&&!state().tween?.isPlaying()');
 // This harness validates input and camera movement. Parcel download/LOD
 // eligibility is covered separately by bounded-parcels-browser.mjs.
 await evaluate('state().scheduler.close()');
 await evaluate(`window.deliveredWheelEvents=0;state().runtime.renderer.domElement.addEventListener('wheel',()=>window.deliveredWheelEvents++);`);
 await evaluate(`window.wheelRead=()=>{const s=state();return{height:s.scene.camera.position.y,target:s.zoomDamping.active?s.zoomDamping.targetHeight:s.scene.camera.position.y,active:s.zoomDamping.active,center:s.scene.controls.target.toArray(),stops:s.distanceLevels()};};window.wheelFrames=[];window.wheelRecording=true;window.wheelRecord=()=>{if(!window.wheelRecording)return;window.wheelFrames.push(wheelRead());requestAnimationFrame(wheelRecord);};wheelRecord();`);
 const initial=await evaluate('wheelRead()'),trace=[];
 const wheel=async(deltaY,point={x:900,y:400})=>{
  const delivered=await evaluate('window.deliveredWheelEvents');
  await cdp('Input.dispatchMouseEvent',{type:'mouseWheel',...point,deltaX:0,deltaY});
  await wait(`window.deliveredWheelEvents>${delivered}`);
 };
 // Controlled batches exercise the actual canvas handler without compositor
 // coalescing or delivery gaps between synthetic CDP wheel packets. The single
 // and two-sample native checks below separately cover browser event delivery.
 const gesture=(deltaY,point={x:900,y:400})=>evaluate(`(()=>{const canvas=state().runtime.renderer.domElement,p=${JSON.stringify(point)};for(let i=0;i<3;i++)canvas.dispatchEvent(new WheelEvent('wheel',{deltaY:${deltaY},clientX:p.x,clientY:p.y,bubbles:true,cancelable:true}));})()`);
 const record=async label=>{const value=await evaluate('wheelRead()');trace.push({label,...value});console.log(label);return value;};
 const targetIs=(value,index)=>assert.ok(Math.abs(Math.log(value.target/value.stops[index]))<1e-6,JSON.stringify({index,value}));
 const settle=async()=>{await wait('!state().wheelGesture.pending&&!state().zoomDamping.active');await frame();const value=await evaluate('wheelRead()');assert.ok(value.stops.some(n=>Math.abs(Math.log(n/value.height))<1e-6),'The camera must settle at one of the five states');};
 let layout;
 if(!process.env.MAP_SMOKE_CURSOR_ONLY){
 // Neither a single notch nor two large samples may move the camera, even
 // after the direction window. Three samples select their majority direction.
 await wheel(-100);await delay(90);targetIs(await record('single-notch-ignored'),4);
 assert.equal(await evaluate('state().zoomDamping.active'),false);
 await wheel(-1000);await delay(90);targetIs(await record('two-notches-ignored'),4);
 assert.equal(await evaluate('state().zoomDamping.active'),false);
 await evaluate('state().wheelGesture.reset()');
 await gesture(-100);await wait('state().zoomDamping.active');targetIs(await record('three-notch-gesture'),3);
 await evaluate(`new Promise(resolve=>{let count=0;const timer=setInterval(()=>{state().runtime.renderer.domElement.dispatchEvent(new WheelEvent('wheel',{deltaY:-500,clientX:900,clientY:400,bubbles:true,cancelable:true}));if(++count===16){clearInterval(timer);resolve();}},60);})`);
 await settle();targetIs(await record('long-momentum'),3);
 await delay(260);await gesture(-100);await wait('state().zoomDamping.active');targetIs(await record('next-gesture'),2);
 await delay(240);await gesture(-100);await wait('Math.abs(Math.log(state().zoomDamping.targetHeight/state().distanceLevels()[1]))<.000001');
 targetIs(await record('gesture-during-animation'),1);await settle();
 for(const [delta,index,label] of [[-100,0,'closest'],[-10000,0,'closest-boundary'],[100,1,'out-one'],[100,2,'out-two'],[100,3,'out-three'],[100,4,'overview'],[10000,4,'overview-boundary']]){
  await delay(260);await gesture(delta);await frame();
  await wait(`!state().wheelGesture.pending&&Math.abs(Math.log((state().zoomDamping.active?state().zoomDamping.targetHeight:state().scene.camera.position.y)/state().distanceLevels()[${index}]))<.000001`);
  await settle();targetIs(await record(label),index);
 }
 // Small incomplete scrolls do not leave the camera between states.
 await evaluate('state().setZoomFromControl(state().distanceLevels()[2],"drag")');await frame();
 await wheel(-30);await delay(120);await frame();targetIs(await record('incomplete-gesture'),2);
 assert.equal(await evaluate('state().zoomDamping.active'),false);
 await delay(260);
 // An arbitrarily large inverted vote cannot outweigh two small votes,
 // including when the inverted event arrives before the direction window ends.
 await evaluate(`(()=>{const canvas=state().runtime.renderer.domElement;for(const deltaY of [10000,-5,-5])canvas.dispatchEvent(new WheelEvent('wheel',{deltaY,clientX:900,clientY:400,bubbles:true,cancelable:true}));})()`);
 await wait('state().zoomDamping.active');targetIs(await record('inverted-first-sample'),1);await settle();
 // Pointer movement alone must not steer an unfinished cursor-anchored zoom.
 await delay(260);
 const anchorPoint={x:800,y:600};
 await evaluate(`(()=>{const s=state(),p=${JSON.stringify(anchorPoint)};window.fixedWheelPoint=s.pointerWorld({clientX:p.x,clientY:p.y});})()`);
 await gesture(-100,anchorPoint);await wait('state().zoomDamping.active');
 const anchor=await evaluate('state().zoomPointer.toArray()');
 await cdp('Input.dispatchMouseEvent',{type:'mouseMoved',x:1000,y:700});await frame();
 assert.deepEqual(await evaluate('state().zoomPointer?.toArray()'),anchor);
 await settle();targetIs(await record('fixed-scroll-anchor'),0);
 const fixedPointError=await evaluate(`(()=>{const s=state(),p=fixedWheelPoint,v=s.scene.camera.position.clone().set(p.x,0,p.z).project(s.scene.camera),r=s.runtime.renderer.domElement.getBoundingClientRect();return Math.hypot(r.x+(v.x+1)*r.width/2-${anchorPoint.x},r.y+(1-v.y)*r.height/2-${anchorPoint.y});})()`);
 assert.ok(fixedPointError<.8,'The animation preserves its scroll-event anchor');
 // Slider use cancels the gesture immediately; line and page wheel deltas
 // still select the adjacent state through the actual canvas handler.
 for(const [deltaY,deltaMode,index,label] of [[-6,1,1,'line-delta'],[1,2,3,'page-delta']]){
  await evaluate('state().setZoomFromControl(state().distanceLevels()[2],"drag")');await frame();
  await evaluate(`(()=>{for(let i=0;i<3;i++)state().runtime.renderer.domElement.dispatchEvent(new WheelEvent('wheel',{deltaY:${deltaY},deltaMode:${deltaMode},clientX:900,clientY:400,bubbles:true,cancelable:true}));})()`);
  await wait('state().zoomDamping.active');targetIs(await record(label),index);await settle();
 }
 layout=await evaluate(`(()=>{const r=document.getElementById('map-zoom-controls').getBoundingClientRect(),i=document.querySelector('.inspector').getBoundingClientRect(),h=document.querySelector('.atlas-header').getBoundingClientRect(),s=document.getElementById('map-zoom-slider').getBoundingClientRect();return{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height,inspectorTop:i.top,headerBottom:h.bottom,viewport:innerWidth,orientation:document.getElementById('map-zoom-slider').getAttribute('aria-orientation'),slider:{left:s.left+9,travel:s.width-18,y:s.top+s.height/2}}})()`);
 assert.equal(layout.orientation,'horizontal');assert.ok(layout.width>4*layout.height);
 assert.ok(layout.viewport-layout.right<=24&&layout.top>=layout.headerBottom&&layout.top-layout.headerBottom<=20,'Zoom controls sit at the top right of the map');
 assert.ok(layout.bottom<layout.inspectorTop,'The inspector does not cover the zoom controls');
 const sliderAt=f=>({x:layout.slider.left+f*layout.slider.travel,y:layout.slider.y});
 await cdp('Input.dispatchMouseEvent',{type:'mousePressed',...sliderAt(0),button:'left',buttons:1,clickCount:1});
 for(const fraction of [0,.25,.5,.75,1,.5]){
  await cdp('Input.dispatchMouseEvent',{type:'mouseMoved',...sliderAt(fraction),buttons:1});await frame();
  const value=await record('horizontal-slider-'+fraction),expected=value.stops.at(-1)*(value.stops[0]/value.stops.at(-1))**fraction;
  assert.ok(Math.abs(Math.log(value.height/expected))<.03,'Dragging horizontally follows the logarithmic slider');
 }
 await cdp('Input.dispatchMouseEvent',{type:'mouseReleased',...sliderAt(.5),button:'left',buttons:0,clickCount:1});await settle();
 targetIs(await record('horizontal-release'),2);
 for(const [position,index] of [[.12,4],[.36,3],[.64,1],[.88,0]]){
  await cdp('Input.dispatchMouseEvent',{type:'mousePressed',...sliderAt(position),button:'left',buttons:1,clickCount:1});await frame();
  await cdp('Input.dispatchMouseEvent',{type:'mouseReleased',...sliderAt(position),button:'left',buttons:0,clickCount:1});await settle();
  targetIs(await record('fractional-slider-release-'+position),index);
  const actual=await evaluate('Number(document.getElementById("map-zoom-slider").value)');
  assert.ok(Math.abs(actual-(4-index)*250)<.01,'The settled thumb must align with a state marker');
 }
 await evaluate('state().setZoom(state().distanceLevels()[2],"snap")');await wait('!state().tween?.isPlaying()');await frame();
 for(const [label,index] of [['Zoom in to next level',1],['Zoom out to next level',2]]){
  const point=await evaluate(`(()=>{const r=document.querySelector('button[aria-label="${label}"]').getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2};})()`);
  await cdp('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',buttons:1,clickCount:1});
  await cdp('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',buttons:0,clickCount:1});
  await wait('!state().tween?.isPlaying()');await frame();targetIs(await record(label),index);
 }
 }
 // Verify the actual ground point remains at the cursor on every animation
 // frame, through both directions and across all five stops.
 console.log('Checking cursor anchors');
 await evaluate(`document.querySelector('button[aria-label="Toggle bitmap inspector"]').click()`);
 const anchored=[];
 const canvas=await evaluate(`(()=>{const r=state().runtime.renderer.domElement.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height};})()`);
 await evaluate(`window.anchorSamples=[];window.probeAnchor=()=>{if(!window.anchorProbe)return;const s=state(),p=window.anchorProbe,v=s.scene.camera.position.clone().set(p.world.x,0,p.world.z).project(s.scene.camera),r=s.runtime.renderer.domElement.getBoundingClientRect();window.anchorSamples.push(Math.hypot((v.x+1)*r.width/2+r.x-p.x,(1-v.y)*r.height/2+r.y-p.y));requestAnimationFrame(probeAnchor);};`);
 for(const [index,fx,fy,direction] of [[4,.22,.3,-1],[3,.8,.68,-1],[2,.3,.75,-1],[1,.7,.3,-1],[0,.24,.7,1],[1,.78,.3,1],[2,.3,.65,1],[3,.75,.7,1]]){
  await evaluate(`state().setZoom(state().distanceLevels()[${index}],'snap')`);await wait('!state().tween?.isPlaying()');await frame();await delay(260);
  const point={x:Math.round(canvas.x+canvas.width*fx),y:Math.round(canvas.y+canvas.height*fy)};
  await evaluate(`(()=>{const s=state(),p=${JSON.stringify(point)};s.scene.camera.updateMatrixWorld();window.anchorProbe={...p,world:s.pointerWorld({clientX:p.x,clientY:p.y})};window.anchorSamples=[];probeAnchor();})()`);
  await gesture(100*direction,point);
  await wait('state().zoomDamping.active');await settle();
  const errors=await evaluate('window.anchorProbe=undefined;window.anchorSamples');
  const maxPixelDrift=Math.max(...errors);
  assert.ok(errors[0]<.01,'The initial ground-point probe projects to the cursor');
  assert.ok(maxPixelDrift<.8,`Cursor anchor at stop ${index}: ${maxPixelDrift}px`);
  anchored.push({index,point,direction,maxPixelDrift,frames:errors.length});
 }
 await evaluate(`document.querySelector('button[aria-label="Toggle bitmap inspector"]').click()`);
 // The Home icon uses the same command as the former sidebar action.
 await evaluate(`document.querySelector('button[aria-label="Return to genesis"]').click()`);
 await wait('!state().tween?.isPlaying()');await frame();
 assert.ok(await evaluate('Math.hypot(state().scene.controls.target.x-state().overviewFrame.x,state().scene.controls.target.z-state().overviewFrame.z)<1e-5'));
 assert.equal(await evaluate('document.querySelectorAll(".tools-section,.sidebar-heading,.sidebar-bottom").length'),0);
 assert.equal(await evaluate('/atlas/i.test(document.body.innerText)'),false);
 for(const [width,height] of [[1600,900],[1280,720],[900,900]]){
  await cdp('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});await frame();
  const ui=await evaluate(`(()=>{const s=document.querySelector('.atlas-sidebar'),r=s.getBoundingClientRect(),z=document.getElementById('map-zoom-controls').getBoundingClientRect();return{scroll:s.scrollHeight-s.clientHeight,sidebarRight:r.right,zoomLeft:z.left,minFont:Math.min(...[...s.querySelectorAll('h2,label,select,summary,.filter-heading,.filter-result,.microcopy')].filter(e=>e.getBoundingClientRect().height).map(e=>parseFloat(getComputedStyle(e).fontSize)))};})()`);
  if(ui.scroll>0){
   // Full integer totals and data coverage can make a short viewport scroll.
   // The last control must remain accessible inside the sidebar above the footer.
   await evaluate(`document.querySelector('.atlas-sidebar').scrollTop=document.querySelector('.atlas-sidebar').scrollHeight`);await frame();
   assert.ok(await evaluate(`(()=>{const r=document.querySelector('.atlas-sidebar').getBoundingClientRect(),p=document.querySelector('.palette-settings summary').getBoundingClientRect();return p.top>=r.top&&p.bottom<=r.bottom;})()`),'Sidebar controls remain accessible at '+width+'×'+height);
   await evaluate(`document.querySelector('.atlas-sidebar').scrollTop=0`);await frame();
  }
  assert.ok(ui.minFont>=11&&ui.zoomLeft>ui.sidebarRight,'Readable controls fit the map viewport');
  await fs.writeFile(`/tmp/bitmap-navigation-${width}.png`,Buffer.from((await cdp('Page.captureScreenshot',{format:'png'})).data,'base64'));
 }
 await fs.writeFile('/tmp/bitmap-horizontal-zoom.png',Buffer.from((await cdp('Page.captureScreenshot',{format:'png'})).data,'base64'));
 const frames=await evaluate('window.wheelRecording=false;window.wheelFrames');
 const drift=Math.max(...frames.map(f=>Math.hypot(f.center[0]-initial.center[0],f.center[2]-initial.center[2])));
 assert.ok(drift>1,'Off-center wheel input moves the camera target toward the cursor');
 assert.ok(frames.some(f=>f.active&&f.height>f.stops[3]*1.01&&f.height<f.stops[4]/1.01),'The level transition contains continuous intermediate camera distances');
 assert.deepEqual(browser.errors,[]);
 await fs.writeFile('/tmp/bitmap-wheel-zoom.json',JSON.stringify({initial,trace,drift,layout,frames,anchored},null,2)+'\n');
 console.log(JSON.stringify({status:'passed',cases:trace.length,frames:frames.length,targetTravel:drift,anchoredCases:anchored.length,maxAnchorPixelDrift:Math.max(...anchored.map(c=>c.maxPixelDrift)),exceptions:browser.errors.length}));
}catch(error){
 console.error('Wheel state on failure:',await evaluate(`(()=>{const s=state();return{...wheelRead(),gesture:{...s.wheelGesture},now:performance.now()};})()`).catch(()=>undefined));
 throw error;
}finally{await browser.close();await dev?.close();}
