import test from 'node:test';
import assert from 'node:assert/strict';
import {loadShared} from './helpers/load-shared.ts';
const {default:Layer}=await loadShared('../../src/map/layers/HeatmapPreviewLayer.ts');
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));

test('a delayed initial preview cannot replace the selected analytical layer',async()=>{
 let complete;
 const initial=new Promise(resolve=>{complete=resolve;});
 const layer=new Layer({getPreviewIndex:()=>initial},[],()=>{},error=>{throw error;});
 const selected={tileSize:200,resolution:4,maxLevel:0,tiles:[]};
 try{
  layer.setIndex(selected);complete({...selected,tileSize:400});await tick();
  assert.equal(layer.pyramid,selected);
 }finally{layer.dispose();}
});

test('client projection moves each neighborhood while retaining stored preview UVs and shared textures',async()=>{
 const sourceSlots=[{x:0,y:0,width:100,height:100},{x:100,y:0,width:100,height:100}];
 const slots=[{x:-500,y:300,width:100,height:100},{x:600,y:-400,width:100,height:100}];
 const ref={level:0,x:0,y:0,url:'tile',bytes:64,sha256:'fixture'};
 const index={tileSize:200,resolution:4,maxLevel:0,tiles:[ref]};let downloads=0;
 const layer=new Layer({getPreviewIndex:async()=>index,getPreviewTile:async()=>{downloads++;return new Uint8Array(64).fill(255);}},slots,()=>{},error=>{throw error;},sourceSlots);
 try{
  await tick();
  assert.deepEqual(layer.visibleRefs(0,{x:-500,y:300,width:100,height:100}),[ref],'Translated view requests the original tile');
  assert.deepEqual(layer.visibleRefs(0,{x:0,y:0,width:100,height:100}),[],'Stored location no longer selects the tile');
  layer.updateView({x:600,y:-400,width:100,height:100},0,0);await tick();
  const tile=[...layer.tiles.values()][0];assert.ok(tile);
  const p=tile.mesh.geometry.getAttribute('position'),uv=tile.mesh.geometry.getAttribute('uv');
  for(let id=0;id<slots.length;id++){
   const i=id*4,slot=slots[id],source=sourceSlots[id];
   assert.equal(p.getX(i)*200,slot.x);assert.equal(p.getZ(i)*200,slot.y);
   assert.equal(uv.getX(i)*200,source.x);assert.equal(uv.getY(i)*200,source.y);
  }
  const mask={opacity:.5,cellSize:50,revision:1,coverage:b=>b.x<0?1:0};
  layer.updateView({x:-500,y:300,width:100,height:100},.5,.5,1,mask);
  assert.equal(opacityAt(tile,-450,350),.5,'Coverage is queried in the selected projection');
  assert.equal(opacityAt(tile,650,-350),1);
  assert.equal(downloads,1);assert.equal(layer.tiles.size,1,'Both neighborhoods share one texture');
  assert.deepEqual(sourceSlots,[{x:0,y:0,width:100,height:100},{x:100,y:0,width:100,height:100}]);
 }finally{layer.dispose();}
});

async function fixture(){
 const ref={level:0,x:0,y:0,url:'tile',bytes:64,sha256:'fixture'};
 const index={tileSize:200,resolution:4,maxLevel:0,tiles:[ref]};let downloads=0;
 const layer=new Layer({getPreviewIndex:async()=>index,getPreviewTile:async()=>{downloads++;return new Uint8Array(64).fill(255);}},[{x:0,y:0,width:200,height:100}],()=>{},error=>{throw error;});
 await tick();layer.updateView({x:0,y:0,width:200,height:100},0,0);await tick();
 return{layer,tile:[...layer.tiles.values()][0],downloads:()=>downloads};
}
function opacityAt(tile,x,y){
 const patch=tile.patches?.find(p=>x>=p.bounds.x&&x<p.bounds.x+p.bounds.width&&y>=p.bounds.y&&y<p.bounds.y+p.bounds.height);
 const u=tile.mesh.material.uniforms;
 return u.opacity.value*(1-(u.geometryOpacity?.value||0)*(patch?.coverage||0));
}
test('crossing a missing cell outside the viewport cannot cut the preview over a resident cell',async()=>{
 const f=await fixture();try{
  const mask={opacity:.6,cellSize:100,coverage:b=>b.x>=100?1:0};
  f.layer.updateView({x:99,y:0,width:101,height:100},.6,.6,1,mask);const before=opacityAt(f.tile,150,50);
  f.layer.updateView({x:101,y:0,width:99,height:100},.61,.61,1,{...mask,opacity:.61});const after=opacityAt(f.tile,150,50);
  assert.ok(Math.abs(before-.4)<1e-6,'Resident cell already follows the slider before the unknown cell leaves the view');
  assert.ok(Math.abs(after-.39)<1e-6);assert.ok(Math.abs(after-before)<.011,'A tiny zoom step must not remove a whole tile of preview');
  assert.equal(opacityAt(f.tile,50,50),1,'The missing cell retains its own fallback');
  assert.equal(f.downloads(),1,'Subdivision shares the original tile texture');
 }finally{f.layer.dispose();}
});
test('coverage buffers change only with residency/arrival, not pan or slider motion',async()=>{
 const f=await fixture();try{
  let arrival=.2;const mask={opacity:.5,cellSize:100,coverage:b=>b.x>=100?arrival:0},view={x:90,y:0,width:110,height:100};
  f.layer.updateView(view,.5,.5,1,mask);const geometry=f.tile.mesh.geometry,attribute=geometry.getAttribute('geometryCoverage'),version=attribute.version;
  assert.ok(Math.abs(opacityAt(f.tile,150,50)-.9)<1e-6);
  f.layer.updateView({x:101,y:5,width:99,height:90},.7,.7,1,{...mask,opacity:.7});assert.equal(f.tile.mesh.geometry,geometry);assert.equal(attribute.version,version);
  assert.ok(Math.abs(opacityAt(f.tile,150,50)-.86)<1e-6);
  arrival=.6;f.layer.updateView(view,.7,.7,1,{...mask,opacity:.7});assert.ok(attribute.version>version);assert.ok(Math.abs(opacityAt(f.tile,150,50)-.58)<1e-6);
  arrival=1;f.layer.updateView(view,1,1,1,{...mask,opacity:1});assert.equal(opacityAt(f.tile,150,50),0);assert.equal(opacityAt(f.tile,50,50),1);
  assert.equal(f.tile.mesh.geometry.getIndex().count,12,'Two fixed cells in one draw');assert.equal(f.layer.tiles.size,1);assert.equal(f.downloads(),1);
 }finally{f.layer.dispose();}
});


test('stable residency reuses coverage queries through zoom, pan and pauses',async()=>{
 const f=await fixture();try{
  let calls=0,gain=.5;const view={x:90,y:0,width:110,height:100},mask={opacity:.5,cellSize:100,revision:1,coverage:b=>{calls++;return b.x>=100?gain:0;}};
  f.layer.updateView(view,.5,.5,1,mask);const first=calls;assert.ok(first>0);
  f.layer.updateView({x:101,y:0,width:99,height:100},.6,.6,1,{...mask,opacity:.6});f.layer.updateView(view,.6,.6,1,{...mask,opacity:.6});assert.equal(calls,first,'No spatial coverage queries on gesture frames with stable data');
  gain=1;f.layer.updateView(view,.6,.6,1,{...mask,opacity:.6,revision:2});assert.ok(calls>first);assert.ok(Math.abs(opacityAt(f.tile,150,50)-.4)<1e-6);
 }finally{f.layer.dispose();}
});
