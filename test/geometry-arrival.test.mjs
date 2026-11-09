import test from 'node:test';
import assert from 'node:assert/strict';
import {loadShared} from './helpers/load-shared.ts';
const {ArrivalFade}=await loadShared('../../src/shared/ArrivalFade.ts');
const {default:Layer}=await loadShared('../../src/map/layers/NeighborhoodGeometryLayer.ts');

test('geometry arrival starts transparent, limits stalls and settles once independently of pan',()=>{
 const f=new ArrivalFade();f.update(100);assert.equal(f.opacity,0);f.update(10100);assert(f.opacity>0&&f.opacity<.03);
 let previous=f.opacity;for(let t=10120;t<=10800;t+=20){f.update(t);assert(f.opacity>=previous);previous=f.opacity;}
 assert.equal(f.opacity,1);f.update(100000);assert.equal(f.opacity,1);
});

test('new vector data becomes opaque before its preview starts a separate smooth exit',()=>{
 const old=globalThis.document;globalThis.document={createElement:()=>({getContext:()=>({fillText(){},measureText:()=>({width:8})})})};let layer;
 try{
  const view={x:0,y:0,width:100,height:100};layer=new Layer([view]);
  layer.addRegion({neighborhood:0,width:100,height:100,bitmaps:[{x:0,y:0,width:80,height:90}]},view);
  const entry=layer.regions.get(0);let intermediate=false;
  for(let t=0;t<=1000;t+=20){
   layer.updateView(view,1,1,0,t);
   if(entry.arrival.opacity<1)assert.equal(layer.previewCoverage(view,0),0,'Preview remains opaque throughout vector arrival');
   const exit=layer.previewCoverage(view,0);
   if(exit>0&&exit<1){intermediate=true;assert.equal(entry.arrival.opacity,1,'Only opaque geometry releases its preview');}
  }
  assert(intermediate);assert.equal(layer.previewCoverage(view,0),1);
  const version=entry.mesh.geometry.attributes.bitmapRect.version;
  layer.updateView({x:1000,y:1000,width:100,height:100},1,1,0,1020);layer.updateView(view,1,1,0,1040);
  assert.equal(entry.previewExit.opacity,1);assert.equal(entry.mesh.geometry.attributes.bitmapRect.version,version);
 }finally{layer?.dispose();globalThis.document=old;}
});

test('each vector chunk fades independently; resident buffers and preview coverage do not restart',()=>{
 const old=globalThis.document;globalThis.document={createElement:()=>({getContext:()=>({fillText(){},measureText:()=>({width:8})})})};let layer;
 try{
  layer=new Layer([]);const chunk=x=>({x,y:0,size:100,bitmaps:[{id:x*2016,x:x*100,y:0,width:80,height:90}]});
  const all={x:0,y:0,width:200,height:100},left={x:0,y:0,width:90,height:90},right={x:100,y:0,width:90,height:90};
  layer.setWantedChunks(['0,0','1,0'],all);layer.addChunk(chunk(0));layer.updateView(all,1,1,0,0);
  const first=layer.chunks.get('0,0'),buffer=first.mesh.geometry.attributes.bitmapRect.array;assert.equal(first.arrival.opacity,0);
  for(let t=20;t<=1000;t+=20)layer.updateView(all,1,1,0,t);assert.equal(first.arrival.opacity,1);assert.equal(layer.previewCoverage(left),1);assert.equal(layer.previewCoverage(right),0);
  layer.addChunk(chunk(1));const second=layer.chunks.get('1,0');layer.updateView(all,1,1,0,1020);assert.equal(second.arrival.opacity,0);
  for(let t=1040;t<=1320;t+=20)layer.updateView(all,.4,1,0,t);
  assert(second.arrival.opacity>.2&&second.arrival.opacity<.8);assert.equal(first.arrival.opacity,1);assert.equal(first.mesh.geometry.attributes.bitmapRect.array,buffer);
  first.mesh.onBeforeRender();assert.equal(layer.material.uniforms.geometryArrival.value,1);second.mesh.onBeforeRender();assert.equal(layer.material.uniforms.geometryArrival.value,second.arrival.opacity);assert.equal(layer.material.uniforms.opacity.value,.4);
  layer.material.uniforms.parcelOpacity.value=.5;second.mesh.onBeforeRender();assert.equal(layer.material.uniforms.geometryArrival.value,1,"Parcel arrivals keep their exact parent covered");layer.material.uniforms.parcelOpacity.value=0;
  layer.updateView({x:1000,y:1000,width:10,height:10},1,1,0,1340);layer.updateView(all,1,1,0,1360);assert.equal(first.arrival.opacity,1);
 }finally{layer?.dispose();globalThis.document=old;}
});


test('zoom-out beyond the last query preserves coverage from resident owner cells',()=>{
 const old=globalThis.document;globalThis.document={createElement:()=>({getContext:()=>({fillText(){},measureText:()=>({width:8})})})};let layer;
 try{
  layer=new Layer([]);layer.addChunk({x:0,y:0,size:100,bitmaps:[{id:0,x:0,y:0,width:80,height:90}]});
  const queried={x:20,y:20,width:20,height:20};layer.setWantedChunks(['0,0'],queried);
  for(let now=0;now<=1000;now+=20)layer.updateView(queried,1,1,0,now);
  const entry=layer.chunks.get('0,0'),buffer=entry.mesh.geometry.attributes.bitmapRect.array;
  assert.equal(layer.previewCoverage(queried),1);
  const expanded={x:10,y:10,width:60,height:60};assert.equal(layer.previewCoverage(expanded),1,'Moving slider does not revoke resident coverage while metadata catches up');
  assert.equal(layer.previewCoverage({x:80,y:10,width:40,height:60}),0,'Genuinely missing owner cells retain preview');
  assert.equal(entry.arrival.opacity,1);assert.equal(entry.mesh.geometry.attributes.bitmapRect.array,buffer);
 }finally{layer?.dispose();globalThis.document=old;}
});


test('certified empty owner cells remain covered while queries shrink and expand',()=>{
 const old=globalThis.document;globalThis.document={createElement:()=>({getContext:()=>({fillText(){},measureText:()=>({width:8})})})};let layer;
 try{
  layer=new Layer([]);const chunk=x=>({x,y:0,size:100,bitmaps:[{id:x*2016,x:x*100,y:0,width:80,height:90}]});
  layer.setWantedChunks(['0,0','2,0'],{x:0,y:0,width:300,height:100});layer.addChunk(chunk(0));layer.addChunk(chunk(2));
  for(let now=0;now<=1000;now+=20)layer.updateView({x:0,y:0,width:300,height:100},1,1,0,now);
  layer.setWantedChunks(['0,0'],{x:10,y:10,width:40,height:40});
  assert.equal(layer.previewCoverage({x:0,y:0,width:300,height:100}),1,'A known empty cell is not a missing download');
  assert.equal(layer.previewCoverage({x:0,y:0,width:400,height:100}),0,'Unknown space is still conservative');
  assert.ok(layer.knownEmptyCells.size<=layer.chunkCapacity);
 }finally{layer?.dispose();globalThis.document=old;}
});


test('legacy preview coverage follows fixed resident regions, including outside the current request set',()=>{
 const old=globalThis.document;globalThis.document={createElement:()=>({getContext:()=>({fillText(){},measureText:()=>({width:8})})})};let layer;
 try{
  const slots=[{x:0,y:0,width:100,height:100},{x:100,y:0,width:100,height:100}];layer=new Layer(slots);
  layer.setWanted([0]);layer.addRegion({neighborhood:0,width:100,height:100,bitmaps:[{x:0,y:0,width:80,height:90}]},slots[0]);
  for(let now=0;now<=1000;now+=20)layer.updateView({x:0,y:0,width:200,height:100},1,1,0,now);
  assert.equal(layer.previewCoverage(slots[0]),1);assert.equal(layer.previewCoverage(slots[1]),0,'A missing neighboring region keeps its own preview');
  layer.setWanted([]);assert.equal(layer.previewCoverage(slots[0]),1,'Changing the request set does not revoke resident coverage');assert.equal(layer.previewCoverage(slots[1]),0);
 }finally{layer?.dispose();globalThis.document=old;}
});

test('complete neighborhood coverage releases empty cells without waiting for unrelated owners',()=>{
 const old=globalThis.document;globalThis.document={createElement:()=>({getContext:()=>({fillText(){},measureText:()=>({width:8})})})};let layer;
 try{
  layer=new Layer([{x:0,y:0,width:300,height:100,crown:0,side:'center'}]);
  const all={x:0,y:0,width:300,height:100},empty={x:200,y:0,width:100,height:100};
  const chunk=(x,first,count)=>({x,y:0,size:100,bitmaps:Array.from({length:count},(_,i)=>({id:first+i,x:x*100+i%80,y:Math.floor(i/80),width:1,height:1}))});
  layer.setWantedChunks(['0,0','1,0','-1,0'],{x:0,y:0,width:190,height:100});
  layer.addChunk(chunk(0,0,1008));for(let t=0;t<=1000;t+=20)layer.updateView(all,1,1,0,t);
  assert.equal(layer.previewCoverage(empty,0),0,'Half a neighborhood is not a completeness proof');
  layer.addChunk(chunk(1,1008,1008));for(let t=1020;t<=1300;t+=20)layer.updateView(all,1,1,0,t);
  const arriving=layer.chunks.get('1,0').arrival.opacity;
  assert(arriving>0&&arriving<1);assert.equal(layer.previewCoverage(empty,0),0,'The summary remains opaque while vectors arrive');
  for(let t=1320;t<=1780;t+=20)layer.updateView(all,1,1,0,t);
  const exit=layer.chunks.get('1,0').previewExit.opacity;assert(exit>0&&exit<1);assert.equal(layer.previewCoverage(empty,0),exit);
  for(let t=1800;t<=2100;t+=20)layer.updateView(all,1,1,0,t);
  assert.equal(layer.previewCoverage(empty,0),1,'All canonical bitmap IDs certify natural empty cells too');
  const scan=layer.cellPreviewCoverage;layer.cellPreviewCoverage=()=>{throw Error('Settled regions must not scan owner bounds for a fresh child patch');};
  assert.equal(layer.previewCoverage({...empty,x:empty.x+1,width:empty.width-1},0),1);
  layer.cellPreviewCoverage=scan;
  assert.equal(layer.previewCoverage(empty),0,'Unidentified cells retain conservative coverage');
  assert.equal(layer.previewCoverage(empty,1),0,'An incomplete neighboring region retains its preview');
  layer.setWantedChunks([]);assert.equal(layer.previewCoverage(empty,0),1,'Resident proof survives reverse zoom');
  layer.chunkCapacity=1;layer.updateView({x:10000,y:10000,width:1,height:1},1,1,0,2120);layer.addChunk(chunk(2,2016,1));
  assert.equal(layer.completeRegionOwners.has(0),false,'Eviction invalidates the completeness proof');
  assert.equal(layer.previewCoverage(empty,0),0,'Eviction also invalidates the retained preview handoff');
 }finally{layer?.dispose();globalThis.document=old;}
});
