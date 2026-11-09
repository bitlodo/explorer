import test from 'node:test';
import assert from 'node:assert/strict';
import {loadShared} from './helpers/load-shared.ts';
const {constrainMapCenter}=await loadShared('../../src/shared/mapNavigation.ts');
const bounds={x:-500,y:-400,width:1000,height:800};
const overlap=(c,v,r)=>({width:Math.max(0,Math.min(c.x+v.width/2,r.x+r.width)-Math.max(c.x-v.width/2,r.x)),height:Math.max(0,Math.min(c.y+v.height/2,r.y+r.height)-Math.max(c.y-v.height/2,r.y))});

test('all edges and corners retain 25% of the smaller map/view rectangle at any aspect and zoom',()=>{
    for(const aspect of [320/568,900/1200,1920/993,2400/700])for(const height of [100,800,4000]){
        const view={width:height*aspect,height};
        for(const x of [-1e7,0,1e7])for(const y of [-1e7,0,1e7]){
            const center=constrainMapCenter({x,y},view,bounds),o=overlap(center,view,bounds);
            assert.ok(o.width>=.5*Math.min(view.width,bounds.width)-1e-8);
            assert.ok(o.height>=.5*Math.min(view.height,bounds.height)-1e-8);
            assert.ok(o.width*o.height>=.25*Math.min(view.width,bounds.width)*Math.min(view.height,bounds.height)-1e-8);
            assert.deepEqual(constrainMapCenter(center,view,bounds),center,'Stable boundary without frame-to-frame drift');
        }
    }
});

test('internal gaps and empty corners do not move the camera, even with a viewport smaller than a gap',()=>{
    // Two occupied strips can leave a hole hundreds of world units wide.
    for(const height of [5,20,60,200])for(const aspect of [.5,1,2]){
        const view={width:height*aspect,height};
        for(const direction of [-1,1])for(let step=0;step<=180;step++){
            const center={x:direction*(-450+step*5),y:0};
            assert.strictEqual(constrainMapCenter(center,view,bounds),center,'Horizontal travel across the gap stays continuous');
            const vertical={x:0,y:direction*(-350+step*700/180)};
            assert.strictEqual(constrainMapCenter(vertical,view,bounds),vertical,'Vertical travel across the gap stays continuous');
        }
        const emptyCorner={x:400,y:-300};
        assert.strictEqual(constrainMapCenter(emptyCorner,view,bounds),emptyCorner);
    }
});

test('zoom-out preserves every previously valid center, including far from the map center',()=>{
    for(const x of [-1e6,0,1e6])for(const y of [-1e6,0,1e6]){
        const center=constrainMapCenter({x,y},{width:90,height:60},bounds);
        for(const scale of [1,2,10,100])assert.deepEqual(constrainMapCenter(center,{width:90*scale,height:60*scale},bounds),center);
    }
});

test('resize and manifest growth recompute limits without retaining a stale viewport or layout',()=>{
    const original={x:0,y:0},view={width:100,height:80};
    assert.strictEqual(constrainMapCenter(original,view,bounds),original);
    const far=constrainMapCenter({x:10000,y:10000},{width:4000,height:3000},bounds);
    const resized=constrainMapCenter(far,view,bounds);
    assert.notDeepEqual(resized,far);assert.deepEqual(resized,{x:500,y:400});
    const grown={...bounds,width:2000};
    const destination={x:1200,y:0};
    assert.strictEqual(constrainMapCenter(destination,view,grown),destination);
});

test('empty bounds and invalid viewport sizes leave startup alone; disconnected maps allow crossing',()=>{
    const center={x:100,y:100};
    assert.strictEqual(constrainMapCenter(center,{width:100,height:100},{x:0,y:0,width:0,height:0}),center);
    assert.strictEqual(constrainMapCenter(center,{width:0,height:100},bounds),center);
    assert.strictEqual(constrainMapCenter(center,{width:100,height:0},bounds),center);
    const sparse={x:-10000,y:-10000,width:20020,height:20020},view={width:100,height:100};
    const middle={x:0,y:0};
    assert.strictEqual(constrainMapCenter(middle,view,sparse),middle);
});
