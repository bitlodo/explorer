import test from 'node:test';
import assert from 'node:assert/strict';
import MapController from '../src/map/MapController.ts';
import {normalizeMetric,metricAt} from '../src/shared/mapAnalytics.ts';

const summary={min:1,max:100,mean:37,scale:'linear',neighborhoodMeans:[37],histogram:[],values:{},preview:{}};
function fixture(areaSummary=summary){
    const prior=Object.getOwnPropertyDescriptor(globalThis,'window');
    Object.defineProperty(globalThis,'window',{value:{location:{search:''}},configurable:true});
    let controller;
    try{controller=new MapController({});}finally{if(prior)Object.defineProperty(globalThis,'window',prior);else delete globalThis.window;}
    let calls=0,resolve,reject,regions,metric;
    controller.active=true;controller.snapshot={...controller.getState(),publishedHeight:2};
    controller.overview={setSizeColors(){},setAnalytic(){}};
    controller.preview={setActive(){},setSizeColorMode(){},setBitmapAreaMode(){},setIndex(){},setAnalytic(){},setParcelClasses(){},setSizeColors(){},
        setRegionSummaries(value){regions=value;},setSpatialMetric(value){metric=value;}};
    controller.source={getLayerAnalysis:async()=>({area:areaSummary,parcel:{counts:[3]}}),getPreviewIndex:async()=>({}),
        getAreaMetric:()=>{calls++;return new Promise((yes,no)=>{resolve=yes;reject=no;});}};
    return{controller,get calls(){return calls;},get regions(){return regions;},get metric(){return metric;},
        resolve:()=>resolve(Float32Array.of(1,10,100)),reject:()=>reject(Error('Area fetch failed'))};
}

test('Bitmap Area opens and resets using metadata, loading values only for a filter and sharing rapid requests',async()=>{
    const f=fixture(),c=f.controller;await c.setRenderingMode('area');
    assert.equal(f.calls,0);assert.equal(f.regions[0],Math.fround(1+8*36/99));assert.equal(f.regions[1],1);
    assert.equal(f.metric.scores,undefined,'Spatial LOD uses each page\'s authenticated bitmap areas');
    await c.setMetricFilter(0,1);assert.equal(f.calls,0);assert.equal(c.getState().filterMatches,3);
    const first=c.setMetricFilter(.5,1),latest=c.setMetricFilter(0,0);
    assert.equal(f.calls,1);assert.equal(c.getState().filterBusy,true);f.resolve();await Promise.all([first,latest]);
    assert.equal(c.getState().filterBusy,false);assert.equal(c.getState().filterMatches,1);
    assert.deepEqual(c.getState().filter,[0,0]);assert.equal(f.regions[0],1);assert.ok(Math.abs(f.regions[1]-1/3)<1e-7);
    await c.setMetricFilter(0,1);await c.setMetricFilter(.5,1);assert.equal(f.calls,1);assert.equal(c.getState().filterMatches,1);
});

test('an area request cannot overwrite a later reset or display-mode change',async()=>{
    for(const change of ['reset','mode']){
        const f=fixture(),c=f.controller;await c.setRenderingMode('area');const pending=c.setMetricFilter(.5,1);
        if(change==='reset')await c.setMetricFilter(0,1);else await c.setRenderingMode('default');
        const state=c.getState(),regions=f.regions;f.resolve();await pending;
        assert.equal(c.getState(),state);assert.equal(f.regions,regions);assert.equal(c.getState().filterBusy,false);
    }
});

test('failed lazy area downloads expose an error, clear busy state and allow retry',async()=>{
    const f=fixture(),c=f.controller;await c.setRenderingMode('area');let pending=c.setMetricFilter(.5,1);
    f.reject();await pending;assert.equal(c.getState().filterBusy,false);assert.match(c.getState().renderingError,/Area fetch failed/);
    pending=c.setMetricFilter(.5,1);assert.equal(f.calls,2);f.resolve();await pending;
    assert.equal(c.getState().renderingError,'');assert.equal(c.getState().filterMatches,1);
});


test('logarithmic Bitmap Area filters retain arithmetic area means and exact counts',async()=>{
    const logSummary={...summary,scale:'log'},f=fixture(logSummary),c=f.controller;
    await c.setRenderingMode('area');assert.equal(f.calls,0);
    assert.equal(c.getState().layerSummary.scale,'log');
    assert.ok(Math.abs(metricAt(.5,logSummary)-(Math.sqrt(202)-1))<1e-10);
    const pending=c.setMetricFilter(0,.6);f.resolve();await pending;
    assert.equal(c.getState().filterMatches,2);
    assert.ok(Math.abs(f.regions[0]-(1+8*normalizeMetric(5.5,logSummary)))<1e-6,'Average canonical areas before log normalization');
    assert.ok(Math.abs(f.regions[1]-2/3)<1e-7);
    await c.setRenderingMode('default');await c.setRenderingMode('area');
    await c.setMetricFilter(0,.6);assert.equal(f.calls,1);assert.equal(c.getState().filterMatches,2);
    await c.setMetricFilter(0,1);assert.equal(c.getState().filterMatches,3);
    assert.ok(Math.abs(f.regions[0]-(1+8*normalizeMetric(37,logSummary)))<1e-6);
});
