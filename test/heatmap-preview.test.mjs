import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {deflateSync} from 'node:zlib';
import {loadShared} from './helpers/load-shared.ts';
import {fixture} from './protobuf-fixture.mjs';
const require=createRequire(new URL('../package.json',import.meta.url)),protobuf=require('protobufjs');
const {createPreviewCodec,previewLevel,smooth,cameraDetail,detailLayers,advanceDetail}=await loadShared('../../src/shared/heatmapPreview.ts');
const {sha256,LAYOUT}=await loadShared('../../src/shared/httpPack.ts');
const {default:Source}=await loadShared('../../src/data/StaticHttpDataSource.ts');
const codec=createPreviewCodec(protobuf);

test('rounding near a zoom-stop boundary does not enter a new presentation band',()=>{
    for(const delta of [-5e-7,-3e-8,0,3e-8,5e-7])assert.equal(advanceDetail(5,5+delta,1/60,()=>true),5);
    assert.ok(advanceDetail(5,5.01,1/60,()=>true)>5,'Actual movement still enters the next band');
});

test('preview pyramid chooses finer tiles on approach and fades continuously',()=>{
    const index={tileSize:4096,resolution:256,maxLevel:4};
    const levels=[300,100,30,10,1].map(n=>previewLevel(n,index));
    assert.deepEqual(levels,[4,3,1,0,0]);
    assert.deepEqual([300,100,30,10,1].map(n=>previewLevel(n,{...index,resolution:24})),levels,'Coarse preview textures must not request finer world tiles');
    assert.equal(smooth(90,260,90),0);assert.equal(smooth(90,260,260),1);assert.ok(smooth(90,260,170)>0&&smooth(90,260,170)<1);
});
test('preview index is snapshot-pinned, files are authenticated, inflation bounded and uses a separate cache',async()=>{
    const {files,manifest}=await fixture('v5'),resolution=32,pixels=new Uint8Array(resolution*resolution*4);pixels.fill(17);
    const tile=codec.encodeTile(1,-1,0,resolution,deflateSync(pixels)),hash=await sha256(tile),ref={level:1,x:-1,y:0,url:hash+'.pb',sha256:hash,bytes:tile.length};files.set(ref.url,tile);
    const index={sourceSnapshot:manifest.snapshot,layout:LAYOUT,tileSize:4096,resolution,maxLevel:1,tiles:[ref],snapshot:''};index.snapshot=await sha256(codec.encodeIndex(index,false));files.set('preview.pb',codec.encodeIndex(index));
    await assert.rejects(()=>codec.decodeIndex(files.get('preview.pb'),'0'.repeat(64)),/another snapshot/);
    const corrupt=new Uint8Array(files.get('preview.pb'));corrupt[corrupt.length-1]^=1;await assert.rejects(()=>codec.decodeIndex(corrupt,manifest.snapshot));
    const oldFetch=globalThis.fetch,oldLocation=globalThis.location,requests=[];globalThis.location={href:'https://example.org/repository/'};
    globalThis.fetch=async url=>{const name=new URL(url).pathname.split('/').pop();requests.push(name);return files.has(name)?new Response(files.get(name)):new Response('',{status:404});};
    const source=new Source('map-data/');
    const outlines=[];source.onPreviewTileLoaded=chunk=>outlines.push(chunk);
    try{
        const loaded=await source.getPreviewIndex();assert.equal(loaded.snapshot,index.snapshot);
        assert.deepEqual(await source.getPreviewTile(ref,loaded,new AbortController().signal),pixels);
        const gets=requests.length;await source.getPreviewTile(ref,loaded,new AbortController().signal);assert.equal(requests.length,gets);
        assert.deepEqual(outlines,[{x:-1,y:0,size:8192},{x:-1,y:0,size:8192}],'Network and cache mark the actual tile extent after validation');
        assert.equal(source.previewCache.namespace,'http-heatmap-preview-v1');
        const oversized=codec.encodeTile(1,-1,0,resolution,deflateSync(new Uint8Array(pixels.length+1))),badHash=await sha256(oversized),bad={...ref,url:badHash+'.pb',sha256:badHash,bytes:oversized.length};files.set(bad.url,oversized);
        await assert.rejects(()=>source.getPreviewTile(bad,loaded,new AbortController().signal),/budget/);
        const cancelled=new AbortController();cancelled.abort();await assert.rejects(()=>source.getPreviewTile(ref,loaded,cancelled.signal),{name:'AbortError'});
        assert.equal(outlines.length,2,'Rejected/cancelled tiles must not add outlines');
    }finally{source.close();assert.equal(source.onPreviewTileLoaded,undefined);globalThis.fetch=oldFetch;globalThis.location=oldLocation;}
});


test('camera LOD traverses only adjacent levels, including reversals and delayed data',()=>{
    const index={tileSize:4096,resolution:256,maxLevel:6};
    let detail=0;
    const observed=[];
    for(const target of [8,0,7.5,2.7,8,6.5,0])for(let frame=0;frame<150;frame++){
        const previous=detail;
        detail=advanceDetail(detail,target,1/60,()=>frame>10);
        const layers=detailLayers(detail);
        assert.ok(layers.length<=2);
        if(layers.length===2)assert.equal(layers[1].index-layers[0].index,1);
        assert.ok(Math.abs(layers.reduce((sum,l)=>sum+l.weight,0)-1)<1e-9);
        if(frame<=10)assert.equal(detail,previous,'Wait for data without introducing fallback ancestors');
        observed.push(detail);
    }
    assert.ok(observed.some(d=>d>6&&d<7));assert.ok(observed.some(d=>d>7&&d<8));
    // The same camera scale applies to small/large neighborhoods and cached/new regions.
    for(let worldPerPixel=1000;worldPerPixel>.001;worldPerPixel*=.97){
        const layers=detailLayers(cameraDetail(worldPerPixel,index));
        assert.ok(layers.length<=2);
        if(layers.some(l=>l.index<7))assert.ok(layers.every(l=>l.index<8),'No parcels while a preview is visible');
    }
});
