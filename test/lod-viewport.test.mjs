import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import MapController from '../src/map/MapController.ts';
import MapSceneBase from '../src/map/MapSceneBase.ts';

// Compare the controller's footprint with independent camera-ray intersections.
test('all five LOD footprints follow the resized canvas, aspect and pixel-aligned projection',()=>{
    const camera=new THREE.PerspectiveCamera(15,1,.1,2000000);
    const scene={camera,raycaster:new THREE.Raycaster(),getPointerRaycast:MapSceneBase.prototype.getPointerRaycast};
    const canvas={clientWidth:0,clientHeight:0};
    const controller={scene,runtime:{renderer:{domElement:canvas}},groundBounds:MapController.prototype.groundBounds};
    const stops=[2,20,200,2000,20000];
    for(const [width,height] of [[1024,768],[2048,1152],[3440,1440],[900,1200]])for(const distance of stops)for(const aligned of [false,true]){
        canvas.clientWidth=width;canvas.clientHeight=height;
        camera.clearViewOffset();MapSceneBase.prototype.resizeWindow.call(scene,width,height);
        camera.position.set(123,distance,-456);camera.up.set(0,0,-1);camera.lookAt(123,0,-456);
        if(aligned)camera.setViewOffset(width,height,.35,-.3,width,height);
        camera.updateMatrixWorld();
        const box=controller.groundBounds(),pixels=MapController.prototype.pixelsPerWorld.call(controller);
        const corners=[[-1,-1],[-1,1],[1,-1],[1,1]].map(([x,y])=>scene.getPointerRaycast(new THREE.Vector2(x,y)));
        const expected={x:Math.min(...corners.map(p=>p.x)),y:Math.min(...corners.map(p=>p.z)),
            width:Math.max(...corners.map(p=>p.x))-Math.min(...corners.map(p=>p.x)),height:Math.max(...corners.map(p=>p.z))-Math.min(...corners.map(p=>p.z))};
        for(const key of Object.keys(box))assert.ok(Math.abs(box[key]-expected[key])<1e-5,`${width}x${height}, ${distance}, ${aligned}, ${key}`);
        assert.ok(Math.abs(box.width*pixels-width)<1e-6);assert.ok(Math.abs(box.height*pixels-height)<1e-6);
    }
});
