import test from 'node:test';
import assert from 'node:assert/strict';
import {loadShared} from './helpers/load-shared.ts';
const {default:Layer}=await loadShared('../../src/map/layers/NeighborhoodGeometryLayer.ts');

test('resident vectors remain visible during a pending spatial query and on return, without recreating buffers',()=>{
 const old=globalThis.document;globalThis.document={createElement:()=>({getContext:()=>({fillText(){},measureText:()=>({width:8})})})};
 let layer;
 try{
  layer=new Layer([]);layer.addChunk({x:0,y:0,size:100,bitmaps:[{id:0,x:0,y:0,width:80,height:90}]});
  const entry=layer.chunks.get('0,0'),buffer=entry.mesh.geometry.attributes.bitmapRect.array;
  const view={x:0,y:0,width:100,height:100};layer.setWantedChunks(['0,0']);layer.updateView(view,1,1);assert(entry.mesh.visible);
  layer.setWantedChunks([]);layer.updateView(view,1,1);assert(entry.mesh.visible,'Pending query does not hide a resident chunk');
  layer.updateView({x:500,y:500,width:100,height:100},1,1);assert.equal(entry.mesh.visible,false);
  layer.updateView(view,1,1);assert(entry.mesh.visible);assert.equal(entry.mesh.geometry.attributes.bitmapRect.array,buffer);
 }finally{layer?.dispose();globalThis.document=old;}
});


test('memory pressure keeps visible vectors and evicts them only after they leave the view',()=>{
 const old=globalThis.document;globalThis.document={createElement:()=>({getContext:()=>({fillText(){},measureText:()=>({width:8})})})};let layer;
 try{
  layer=new Layer([]);layer.chunkCapacity=1;
  const chunk=x=>({x,y:0,size:100,bitmaps:[{id:x*2016,x:x*100,y:0,width:80,height:90}]});
  assert(layer.addChunk(chunk(0)));layer.updateView({x:0,y:0,width:100,height:100},1,1);
  layer.setWantedChunks([]);assert.equal(layer.addChunk(chunk(1)),false);assert(layer.hasChunk('0,0'));assert.equal(layer.chunks.size,1);
  layer.updateView({x:100,y:0,width:100,height:100},1,1);assert(layer.addChunk(chunk(1)));assert.equal(layer.hasChunk('0,0'),false);assert.equal(layer.chunks.size,1);
 }finally{layer?.dispose();globalThis.document=old;}
});

test('new pending owners cannot restore preview over resident bitmap geometry',()=>{
 const old=globalThis.document;globalThis.document={createElement:()=>({getContext:()=>({fillText(){},measureText:()=>({width:8})})})};let layer;
 try{
  layer=new Layer([{x:-200,y:0,width:300,height:100,crown:0,side:'center'}]);
  const resident={x:0,y:0,width:100,height:100},expanded={x:-200,y:0,width:300,height:100};
  layer.addChunk({x:0,y:0,size:100,bitmaps:Array.from({length:1008},(_,id)=>({id,x:id%80,y:Math.floor(id/80),width:1,height:1}))});
  layer.setWantedChunks(['0,0'],resident);
  for(let t=0;t<=1000;t+=20)layer.updateView(resident,1,1,0,t);
  const entry=layer.chunks.get('0,0'),buffer=entry.mesh.geometry.attributes.bitmapRect.array;
  assert.equal(layer.previewCoverage(resident,0),1);
  layer.setWantedChunks(['0,0','-2,0'],expanded,new Map([['-2,0',{x:-200,y:0,width:110,height:110}]]));
  layer.updateView(expanded,1,1,0,1020);
  assert.equal(layer.previewCoverage(resident,0),1,'An unrelated pending owner does not revoke resident coverage');
  layer.addChunk({x:-2,y:0,size:100,bitmaps:Array.from({length:1008},(_,i)=>({id:1008+i,x:-200+i%80,y:Math.floor(i/80),width:1,height:1}))});
  assert.equal(layer.completeRegionOwners.get(0).count,2016,'The new owner completes the same neighborhood');
  for(let t=1040;t<=2000;t+=20){
   layer.updateView(expanded,1,1,0,t);
   assert.equal(layer.previewCoverage(resident,0),1);assert.equal(entry.arrival.opacity,1);assert.equal(entry.previewExit.opacity,1);
   assert.equal(entry.mesh.geometry.attributes.bitmapRect.array,buffer);assert(entry.mesh.visible);
  }
 }finally{layer?.dispose();globalThis.document=old;}
});

test('a completed preview patch keeps its resident proof when a later query discovers another incoming owner',()=>{
 const old=globalThis.document;globalThis.document={createElement:()=>({getContext:()=>({fillText(){},measureText:()=>({width:8})})})};let layer;
 try{
  const patch={x:0,y:0,width:100,height:100},view={x:-100,y:0,width:200,height:100};
  layer=new Layer([view]);
  layer.addChunk({x:0,y:0,size:100,bitmaps:[{id:0,x:0,y:0,width:80,height:90}]});
  layer.setWantedChunks(['0,0'],patch);
  for(let t=0;t<=1000;t+=20)layer.updateView(patch,1,1,0,t);
  assert.equal(layer.previewCoverage(patch,0),1);
  // The next metadata result has a conservative incoming extent overlapping
  // this patch. Request readiness is not loss of the geometry already drawn.
  layer.setWantedChunks(['0,0','-1,0'],view,new Map([['-1,0',{x:-100,y:0,width:110,height:110}]]));
  assert.equal(layer.previewCoverage(patch,0),1,'A new request cannot revoke a completed resident handoff');
  layer.addChunk({x:-1,y:0,size:100,bitmaps:[{id:1,x:-10,y:0,width:20,height:90}]});
  for(let t=1020;t<=2000;t+=20){layer.updateView(view,1,1,0,t);assert.equal(layer.previewCoverage(patch,0),1);}
  layer.removeChunk('-1,0');
  assert.equal(layer.previewCoverage(patch,0),1,'Evicting an unrelated arrival does not invalidate the original proof');
  layer.removeChunk('0,0');
  assert.equal(layer.previewCoverage(patch,0),0,'Losing the original geometry restores its preview');
 }finally{layer?.dispose();globalThis.document=old;}
});

test('a resident preview exit keeps advancing on its own clock while a new owner is pending',()=>{
 const old=globalThis.document;globalThis.document={createElement:()=>({getContext:()=>({fillText(){},measureText:()=>({width:8})})})};let layer;
 try{
  const patch={x:0,y:0,width:100,height:100};layer=new Layer([patch]);
  layer.addChunk({x:0,y:0,size:100,bitmaps:[{id:0,x:0,y:0,width:80,height:90}]});layer.setWantedChunks(['0,0'],patch);
  for(let now=0;now<=740;now+=20)layer.updateView(patch,1,1,0,now);
  const before=layer.previewCoverage(patch,0);assert(before>0&&before<1);
  layer.setWantedChunks(['0,0','-1,0'],patch,new Map([['-1,0',{x:-100,y:0,width:110,height:110}]]));
  for(let now=760;now<=1000;now+=20){
   layer.updateView(patch,1,1,0,now);
   assert.equal(layer.previewCoverage(patch,0),layer.chunks.get('0,0').previewExit.opacity,'A new request neither lowers nor stalls the original exit');
  }
  assert.equal(layer.previewCoverage(patch,0),1);
 }finally{layer?.dispose();globalThis.document=old;}
});
