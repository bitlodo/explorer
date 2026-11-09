import test from 'node:test';
import assert from 'node:assert/strict';
import {loadShared} from './helpers/load-shared.ts';
const {RectFrustum,interleaveSpatial}=await loadShared('../../src/shared/rectFrustum.ts');
// Independent, allocation-heavy SAT reference kept in the test, not in the engine.
function intersectsPolygon(points, rect) {
    const box=[{x:rect.x,y:rect.y},{x:rect.x+rect.width,y:rect.y},
        {x:rect.x+rect.width,y:rect.y+rect.height},{x:rect.x,y:rect.y+rect.height}];
    for (const polygon of [points,box]) for (let i=0;i<polygon.length;i++) {
        const a=polygon[i],b=polygon[(i+1)%polygon.length],axis={x:a.y-b.y,y:b.x-a.x};
        const project=vertices=>vertices.map(p=>p.x*axis.x+p.y*axis.y);
        const p=project(points),q=project(box);
        if(Math.max(...p)<Math.min(...q)||Math.max(...q)<Math.min(...p))return false;
    }
    return true;
}

test('fast frustum matches an independent polygon reference for translated, rotated and tilted viewports',()=>{
    let seed=123456;const rand=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2**32;};
    for(const angle of [0,.000001,.3,1.7])for(const reverse of [false,true]){
        let points=[[-100,-70],[100,-70],[90,70],[-90,70]].map(([x,y])=>({x:x*Math.cos(angle)-y*Math.sin(angle)+300,y:x*Math.sin(angle)+y*Math.cos(angle)-200}));
        if(reverse)points.reverse();const fast=new RectFrustum(points);
        for(let i=0;i<20000;i++){const r={x:rand()*500-250,y:rand()*500-250,width:rand()*50+.01,height:rand()*50+.01},ox=300,oy=-200;
            assert.equal(fast.intersects(r,ox,oy),intersectsPolygon(points,{...r,x:r.x+ox,y:r.y+oy}));}
    }
});
test('frustum includes touching edges and rejects outside rectangles',()=>{
    const f=new RectFrustum([{x:0,y:0},{x:10,y:0},{x:10,y:10},{x:0,y:10}]);
    assert.equal(f.intersects({x:10,y:5,width:1,height:1}),true);assert.equal(f.intersects({x:11,y:5,width:1,height:1}),false);
    assert.equal(f.intersects({x:-20,y:-20,width:40,height:40}),true);
    assert.equal(f.contains({x:0,y:0,width:10,height:10}),true);assert.equal(f.contains({x:9,y:0,width:2,height:1}),false);
    assert.equal(f.contains({x:-100,y:20,width:1,height:1},105,-15),true);
});
test('spatial interleave retains the existing order without scanning exhausted queues',()=>{
    const queues=[[1,2,3],[],[4],[5,6]];assert.deepEqual(interleaveSpatial(queues),[1,4,5,2,6,3]);
    assert.deepEqual(queues,[[1,2,3],[],[4],[5,6]]);assert.deepEqual(interleaveSpatial([]),[]);
});
