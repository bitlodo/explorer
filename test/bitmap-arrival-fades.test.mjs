import test from 'node:test';
import assert from 'node:assert/strict';
import {loadShared} from './helpers/load-shared.ts';
const {default:Fades}=await loadShared('../../src/map/layers/BitmapArrivalFades.ts');
const frame=(f,from,to)=>{for(let now=from;now<=to;now+=20)f.update(now);};

test('late bitmaps fade independently and replace only their own parent rectangle',()=>{
 const f=new Fades(4032);f.setVisibleNeighborhoods([0]);f.update(0);f.begin(170);
 assert.equal(f.opacityFor(170),0);frame(f,20,100);const early=f.opacityFor(170);assert(early>.2&&early<.8);
 f.begin(171);assert.equal(f.opacityFor(171),0);frame(f,120,160);assert(f.opacityFor(170)>f.opacityFor(171));assert(f.opacityFor(171)>0);
 frame(f,180,1100);assert.equal(f.opacityFor(170),1);assert.equal(f.opacityFor(171),1);assert.equal(f.opacityFor(172),0);
 assert.equal(f.baseOpacityFor(170),0);assert.equal(f.baseOpacityFor(172),1);
 const version=f.texture.version;frame(f,1120,1320);assert.equal(f.texture.version,version,'Settled frames must not upload the fade atlas');f.dispose();
});
test('the base stays opaque through parcel arrival, then exits after detail is opaque',()=>{
 const f=new Fades(2016);f.setVisibleNeighborhoods([0]);f.update(0);f.begin(0);
 let sawParcelFade=false,sawBaseExit=false;
 for(let now=20;now<=800;now+=20){
  f.update(now);const parcel=f.opacityFor(0),base=f.baseOpacityFor(0);
  if(parcel>0&&parcel<1){sawParcelFade=true;assert.equal(base,1,'Incoming detail never overlaps a fading base');}
  if(base>0&&base<1){sawBaseExit=true;assert.equal(parcel,1,'Base exit starts only after parcels are opaque');}
  assert.equal(parcel+base*(1-parcel),1,'Alpha-over keeps filled interiors covered');
 }
 assert(sawParcelFade&&sawBaseExit);assert.equal(f.baseOpacityFor(0),0);assert.equal(f.activeCount,0);f.dispose();
});
test('parcel arrival releases the solid base promptly instead of holding it for 600 ms',()=>{
 const f=new Fades(2016);try{
  f.setVisibleNeighborhoods([0]);f.update(0);f.begin(0);
  frame(f,20,160);assert(f.opacityFor(0)>0&&f.opacityFor(0)<1);assert.equal(f.baseOpacityFor(0),1);
  frame(f,180,220);assert.equal(f.opacityFor(0),1);assert(f.baseOpacityFor(0)>0&&f.baseOpacityFor(0)<1,'The base must already be fading by 220 ms');
  frame(f,240,320);assert.equal(f.baseOpacityFor(0),0);assert.equal(f.activeCount,0,'The complete handoff finishes within 320 ms');
 }finally{f.dispose();}
});
test('frame stalls limit arrival; leaving and returning never restarts completed bitmap fades',()=>{
 const f=new Fades(2016);f.setVisibleNeighborhoods([0]);f.update(0);f.begin(0);f.update(10000);assert(f.opacityFor(0)>0&&f.opacityFor(0)<.2);
 frame(f,10020,11000);assert.equal(f.opacityFor(0),1);f.setVisibleNeighborhoods([]);frame(f,11020,11120);assert.equal(f.opacityFor(0),0);
 frame(f,11140,11500);assert.equal(f.opacityFor(0),0);f.setVisibleNeighborhoods([0]);f.update(11520);assert.equal(f.opacityFor(0),1);
 const version=f.texture.version;f.begin(0);frame(f,11540,11700);assert.equal(f.opacityFor(0),1);assert.equal(f.texture.version,version);f.dispose();
});
test('eviction immediately restores parent coverage, reload restarts the fade and atlas growth preserves uniforms',()=>{
 const f=new Fades(2016),uniforms={};f.bind(uniforms,2016);f.setVisibleNeighborhoods([0]);f.update(0);f.begin(170);frame(f,20,1000);
 const texture=f.texture;f.ensureCount(10000);assert.equal(f.texture,texture);assert.equal(uniforms.arrivalMap.value,texture);assert.equal(uniforms.arrivalMapSize.value,f.size);assert.equal(f.opacityFor(170),1);
 const version=texture.version;f.resetNeighborhood(0);assert.equal(f.opacityFor(170),0);assert(texture.version>version);f.begin(170);frame(f,1020,1120);assert(f.opacityFor(170)>0&&f.opacityFor(170)<1);
 let disposed=0;texture.addEventListener('dispose',()=>disposed++);f.dispose();f.dispose();assert.equal(disposed,1);assert.equal(f.activeCount,0);
});
