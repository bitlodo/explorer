import test from 'node:test';
import assert from 'node:assert/strict';
import MapController from '../src/map/MapController.ts';
const summary={min:1,max:100,mean:37,scale:'linear',neighborhoodMeans:[37],histogram:[],values:{},preview:{}};
function fixture(){
    const prior=Object.getOwnPropertyDescriptor(globalThis,'window');Object.defineProperty(globalThis,'window',{value:{location:{search:''}},configurable:true});let c;
    try{c=new MapController({});}finally{if(prior)Object.defineProperty(globalThis,'window',prior);else delete globalThis.window;}
    let globals=0,classes=0,resolve;
    c.active=true;c.snapshot={...c.getState(),publishedHeight:2};c.overview={setSizeColors(){},setAnalytic(){},setParcelClasses(){}};
    c.preview={setActive(){},setSizeColorMode(){},setBitmapAreaMode(){},setIndex(){},setAnalytic(){},setParcelClasses(){},setSizeColors(){},setRegionSummaries(){},setSpatialMetric(){}};
    c.source={getLayerAnalysis:async()=>({count:3,area:summary,parcel:{counts:[3,0,0,0,0,0,0,0,0],areas:[3,0,0,0,0,0,0,0,0]}}),getPreviewIndex:async()=>({}),
        getAnalyticsIndex:async()=>({count:3,parcels:3,metrics:{count:summary,diversity:summary,occupancy:summary}}),getSpatialMetricsIndex:async()=>({count:3,parcelMeans:[1]}),
        getAnalyticsMetric:(_mode,signal)=>{globals++;return new Promise((yes,no)=>{resolve=()=>yes({values:Float32Array.of(1,10,100)});signal.addEventListener('abort',()=>no(signal.reason),{once:true});});},
        getParcelClassBytes:()=>{classes++;throw Error('Unfiltered class download');}};
    return{c,get globals(){return globals;},get classes(){return classes;},resolve:()=>resolve()};
}
test('all unfiltered scalar modes use regional metadata and preserve loading as distinct from exclusion',async()=>{
    const f=fixture(),c=f.c;
    for(const mode of ['count','diversity','occupancy']){
        await c.setRenderingMode(mode);assert.equal(f.globals,0);assert.equal(c.getState().filterMatches,3);assert.equal(c.metricValues[0]!==c.metricValues[0],true);assert.equal(c.analyticTexture.image.data[0],-1);
        c.applyMetricPage({region:0,count:Float32Array.of(1,10,100),diversity:Float32Array.of(1,10,100),occupancy:Float32Array.of(1,10,100)});
        assert.equal(c.analyticTexture.image.data[0],1);assert.equal(c.analyticTexture.image.data[2],9);assert.equal(c.localReady.has(0),true);
    }
});
test('parcel overview needs no class worker or global payload; the first explicit scalar filter remains exact',async()=>{
    const f=fixture(),c=f.c;await c.setRenderingMode('size');assert.equal(f.classes,0);assert.equal(c.parcelAnalysis,undefined);assert.equal(c.getState().parcelMatches,3);assert.equal(c.parcelResult.pixels[1],-1);
    await c.setRenderingMode('count');const pending=c.setMetricFilter(.5,1);assert.equal(f.globals,1);assert.equal(c.getState().filterBusy,true);f.resolve();await pending;assert.equal(c.getState().filterMatches,1);assert.equal(c.globalMetric,true);
    await c.setMetricFilter(0,1);assert.equal(c.getState().filterMatches,3);assert.equal(f.globals,1);
});
test('departing a filtered scalar mode cancels its consumer without committing stale state',async()=>{
    const f=fixture(),c=f.c;await c.setRenderingMode('count');const pending=c.setMetricFilter(.5,1);await c.setRenderingMode('area');await pending;assert.equal(c.getState().renderingMode,'area');assert.equal(c.getState().renderingError,'');assert.equal(c.getState().filterBusy,false);
});
test('Parcel size filters use compact exact totals and apply only local bitmap classes',async()=>{
    const f=fixture(),c=f.c;await c.setRenderingMode('size');
    const masks=Array(512).fill(0);masks[1]=1;masks[8]=1;masks[256]=1;
    c.source.getParcelFilterMetadata=async()=>({count:3,regionCounts:[1,0,0,1,0,0,0,0,1],masks});
    await c.setParcelRange(9,9);assert.equal(f.classes,0);assert.equal(c.getState().parcelMatches,1);assert.equal(c.getState().filterMatches,1);assert.equal(c.getState().parcelAreaShare,81/98);assert.equal(c.globalMetric,false);assert.equal(c.parcelResult.pixels[1],-1);
    c.applyMetricPage({region:0,count:Float32Array.of(1,1,1),classes:Uint32Array.from([1,0,0,0,0,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,1])});
    assert.equal(c.parcelResult.pixels[1],0);assert.equal(c.parcelResult.pixels[5],1);assert.equal(c.parcelResult.pixels[4],9);assert.equal(c.getState().filterMatches,1);
    await Promise.all([c.setParcelRange(1,1),c.setParcelRange(4,4)]);assert.deepEqual(c.getState().parcelRange,[4,4]);assert.equal(c.getState().filterMatches,1);assert.equal(c.getState().parcelMatches,1);assert.equal(f.classes,0);
});
