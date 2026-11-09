import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import MapController from '../src/map/MapController.ts';
import MapSceneBase from '../src/map/MapSceneBase.ts';
import NeighborhoodMap from '../src/map/layers/NeighborhoodMap.ts';
const levels=[1,10,100,1000,10000];
test('zero parcel opacity hides the compact render group and restores the same resident layer',()=>{
    const compact={visible:true,setLOD(){}},base={visible:true};
    const region={bitmapAreaMaterial:{},bitmapAreaInstance:base,compactParcels:compact};
    NeighborhoodMap.prototype.setLOD.call(region,1,1,0,false,false);
    assert.equal(base.visible,false);assert.equal(compact.visible,false);
    NeighborhoodMap.prototype.setLOD.call(region,1,1,.5,true,false);
    assert.equal(compact.visible,true);assert.equal(region.compactParcels,compact);
});
function fixture(){
    const previous=Object.getOwnPropertyDescriptor(globalThis,'window');Object.defineProperty(globalThis,'window',{value:{location:{search:''}},configurable:true});
    try{const c=new MapController({});c.distanceLevels=()=>levels;return c;}finally{if(previous)Object.defineProperty(globalThis,'window',previous);else delete globalThis.window;}
}
test('detail work starts inside the 3-to-2 band but never at idle stop 3 or a farther stop',()=>{
    const c=fixture();c.scene={camera:{position:{y:100}}};
    for(const height of [10000,1000,100,100*(1-1e-7)]){c.scene.camera.position.y=height;assert.equal(c.parcelDownloadsAllowed(),false);}
    for(const height of [99.99,Math.sqrt(100*10),10,1]){c.scene.camera.position.y=height;assert.equal(c.parcelDownloadsAllowed(),true);}
});

test('crossing stop 3 hides parcel groups immediately even when their LOD is still catching up',()=>{
    const c=fixture(),bounds={x:0,y:0,width:10,height:10};let visible=[],parcelOpacity;
    c.source={};c.overview={setOpacity(){}};c.scene={camera:{position:{y:100}}};
    c.groundBounds=c.geometryBounds=()=>bounds;c.pixelsPerWorld=()=>1;c.visibleRegions=()=>[];
    c.preview={pyramid:{maxLevel:0},ready:true,analyticalPolicy:{},setActive(){},setSpatialView(){},updateView(){},levelReady(){return true;}};
    c.previewInitialized=true;c.lodDetail=2;c.wantedGeometry=new Set([0]);
    c.neighborhoodChunks={mode:true,ready(){return true;}};
    c.arrivalFades={setVisibleNeighborhoods(ids){visible=ids;},update(){}};
    const region={data:{neighborhood:0,width:10,height:10},position:{x:0,z:0},bitmapChunksContainer:{visible:true},setLOD(_pixels,_exact,parcels){parcelOpacity=parcels;}};
    c.neighborhoods=new Map([[0,region]]);c.loadedBitmaps.add(0);
    for(const distance of [100,100.0001,200,1000]){
        c.scene.camera.position.y=distance;c.lodDetail=2;c.updateLOD();
        assert.equal(region.visible,false);assert.equal(region.bitmapChunksContainer.visible,false);
        assert.equal(parcelOpacity,0);assert.deepEqual(visible,[]);assert.equal(c.loadedBitmaps.has(0),true);
    }
    c.scene.camera.position.y=10;c.lodDetail=2;c.updateLOD();assert.equal(region.visible,true);assert.ok(parcelOpacity>0);
});
test('anticipated requests keep the stop-2 frustum and closer navigation uses the actual smaller view',()=>{
    const c=fixture(),camera=new THREE.PerspectiveCamera(15,1.6,.1,10000),target=new THREE.Vector3(40,0,80);
    camera.position.set(40,Math.sqrt(100*10),80);camera.lookAt(target);camera.updateProjectionMatrix();c.scene={camera,controls:{target}};
    const anticipated=c.parcelDownloadView().frustum.bounds;
    assert.ok(Math.abs(anticipated.height-2*Math.tan(15*Math.PI/360)*10)<1e-5);
    assert.equal(camera.position.y,Math.sqrt(100*10),'Selection must not move the real camera');
    camera.position.y=5;camera.lookAt(target);const closer=c.parcelDownloadView().frustum.bounds;
    assert.ok(Math.abs(closer.height/anticipated.height-.5)<1e-5);
});
test('cursor zoom anticipates the translated stop-2 footprint without moving the rendering camera',()=>{
    const c=fixture(),camera=new THREE.PerspectiveCamera(15,1.6,.1,10000),target=new THREE.Vector3(40,0,80);
    camera.up.set(0,0,-1);camera.position.set(40,60,80);camera.lookAt(target);camera.updateMatrixWorld();
    c.scene={camera,controls:{target},raycaster:new THREE.Raycaster(),getPointerRaycast:MapSceneBase.prototype.getPointerRaycast};
    c.zoomPointer=new THREE.Vector2(.65,-.5);
    const anchor=c.scene.getPointerRaycast(c.zoomPointer),position=camera.position.clone();
    const anticipated=c.parcelDownloadView().frustum.bounds,ratio=levels[1]/camera.position.y;
    const expectedX=anchor.x+(camera.position.x-anchor.x)*ratio,expectedZ=anchor.z+(camera.position.z-anchor.z)*ratio;
    assert.ok(Math.abs(anticipated.x+anticipated.width/2-expectedX)<1e-5);
    assert.ok(Math.abs(anticipated.y+anticipated.height/2-expectedZ)<1e-5);
    assert.deepEqual(camera.position,position,'Download prediction must not move the rendering camera');
    assert.deepEqual(target,new THREE.Vector3(40,0,80),'Download prediction must not move the navigation target');
});
test('one pending neighboring layout cannot hold back the parcel blend or a ready region',()=>{
    const c=fixture(),bounds={x:0,y:0,width:10,height:10};let visible=[];
    c.source={};c.overview={setOpacity(){}};c.scene={camera:{position:{y:10}}};
    c.groundBounds=c.geometryBounds=()=>bounds;c.pixelsPerWorld=()=>1;c.visibleRegions=()=>[];
    c.preview={pyramid:{maxLevel:0},ready:true,analyticalPolicy:{},setActive(){},setSpatialView(){},updateView(){},levelReady(){return true;}};
    c.previewInitialized=true;c.lodDetail=1;c.wantedGeometry=new Set([0,1]);c.wantedParcelGeometry=new Set([0,1]);
    c.neighborhoodChunks={mode:true,ready(){return true;}};
    c.arrivalFades={setVisibleNeighborhoods(ids){visible=ids;},update(){}};
    const region={data:{neighborhood:0,width:10,height:10},position:{x:0,z:0},bitmapChunksContainer:{visible:false},setLOD(){}};
    c.neighborhoods=new Map([[0,region]]);c.updateLOD();
    assert.ok(c.lodDetail>1,'The blend advances while neighborhood 1 is still missing');assert.equal(region.visible,true);assert.deepEqual(visible,[0]);
});
