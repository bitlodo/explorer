import test from 'node:test';
import assert from 'node:assert/strict';
import MapController from '../src/map/MapController.ts';
function fixture(){
    const prior=Object.getOwnPropertyDescriptor(globalThis,'window');Object.defineProperty(globalThis,'window',{value:{location:{search:''}},configurable:true});let controller;
    try{controller=new MapController({});}finally{if(prior)Object.defineProperty(globalThis,'window',prior);else delete globalThis.window;}
    let signal;controller.source={getNeighborhood:(_id,s)=>new Promise((_resolve,reject)=>{signal=s;s.addEventListener('abort',()=>reject(s.reason),{once:true});})};
    controller.overview={slots:[{x:0,y:0,width:1,height:1}]};
    return{controller,get signal(){return signal;}};
}
test('departed viewport cancels canonical geometry work without discarding another current wish',async()=>{
    const f=fixture(),c=f.controller;c.setGeometryWishes([0]);const first=c.load2DGeometry(0),shared=c.load2DGeometry(0);assert.equal(first,shared);
    c.setGeometryWishes([0,1]);assert.equal(f.signal.aborted,false);c.setGeometryWishes([]);await assert.rejects(first,{name:'AbortError'});assert.equal(c.geometryLoads.size,0);
});
test('a current search protects shared canonical work until it is abandoned',async()=>{
    const f=fixture(),c=f.controller;c.searchGeometry=0;c.searchGeometryNavigation=c.navigationId;const pending=c.load2DGeometry(0);c.setGeometryWishes([]);assert.equal(f.signal.aborted,false);
    c.navigationId++;c.setGeometryWishes([]);await assert.rejects(pending,{name:'AbortError'});
});
