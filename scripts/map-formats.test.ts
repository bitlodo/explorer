import {test,expect} from 'bun:test';
import protobuf from 'protobufjs';
import descriptor from '../src/shared/proto/map_addons_descriptor.json';
import {createProtoCodec,type ProtoManifest} from '../src/shared/protobufChunks';
import {encodeJsonManifest,decodeMapManifest,canonicalJson} from '../src/shared/mapManifest';
import {DATA_STORAGE} from '../src/shared/dataStorage';
import {HUFFMAN_FORMAT,LAYOUT,sha256} from '../src/shared/httpPack';
import * as chunks from '../src/shared/neighborhoodChunks';
import {encodeParcelMeans,decodeParcelMeans,PARCEL_MEANS_PROTO} from '../src/shared/parcelMeans';
const codec=createProtoCodec(protobuf),text=new TextEncoder();
function fixture():ProtoManifest{
    const ref={url:'geometry/'+'a'.repeat(64)+'.pb',sha256:'a'.repeat(64),bytes:1};
    return {format:HUFFMAN_FORMAT,storageLayout:DATA_STORAGE,layout:LAYOUT,publishedHeight:2015,
        regions:[{id:0,x:-.5,y:-.5,width:2016,height:1,geometry:ref,descriptor:ref,dimensions:{...ref,url:'dimensions/'+ref.sha256+'.pb'},coverage:'complete'}],
        grid:{size:1024,originX:0,originY:0,ownership:'top-left'},chunks:[],parcelRegions:[0],indexPages:[{...ref,url:'parcel-index/'+ref.sha256+'.pb',x:0,y:0,records:2016,chunks:1}],indexPageSide:8,shuffleSeed:20261023,packBytes:524288,snapshot:''};
}
test('JSON root is canonical, authenticated and validates all Protobuf semantics and paths',async()=>{
    const m=fixture(),wire=await encodeJsonManifest(m),decoded=await decodeMapManifest(wire,'manifest.json');
    expect(decoded.regions).toEqual(m.regions);expect(decoded.snapshot).toHaveLength(64);
    const raw=JSON.parse(new TextDecoder().decode(wire));
    expect(raw.manifestEncoding).toBe('bitmap-manifest-json-v1');
    expect(raw).not.toHaveProperty('mondrian'); expect(raw).not.toHaveProperty('rectMondrian');
    expect((await decodeMapManifest(text.encode(JSON.stringify(raw)),'manifest.json')).snapshot).toBe(decoded.snapshot);
    const reorder=Object.fromEntries(Object.entries(raw).reverse());
    expect((await decodeMapManifest(text.encode(JSON.stringify(reorder)),'manifest.json')).snapshot).toBe(decoded.snapshot);
    await expect(decodeMapManifest(text.encode(JSON.stringify({...raw,publishedHeight:1})),'manifest.json')).rejects.toThrow('revision');
    for(const mutation of [(v:any)=>v.regions[0].geometry.url='../escape.pb',(v:any)=>v.regions[0].width=1.5,(v:any)=>v.regions[0].id=1,(v:any)=>v.indexPages[0].records=1,(v:any)=>v.extra=true]){
        const value=structuredClone(raw);mutation(value);const {snapshot:_,...body}=value;value.snapshot=await sha256(text.encode(canonicalJson(body)));
        await expect(decodeMapManifest(text.encode(JSON.stringify(value)),'manifest.json')).rejects.toThrow();
    }
    const legacy={...m,storageLayout:undefined};legacy.snapshot=await sha256(codec.encodeManifest(legacy,false));
    expect((await decodeMapManifest(codec.encodeManifest(legacy),'manifest.pb')).storageLayout).toBeUndefined();
});
test('addon schemas match descriptor; Protobuf chunk/page preserve every Float64 coordinate and identity',async()=>{
    expect(protobuf.parse(await Bun.file('src/shared/proto/map_addons.proto').text()).root.toJSON()).toEqual(descriptor);
    const bitmaps=[{id:0,x:-.5,y:-100.125,width:300,height:400},{id:2016,x:-20.5,y:-10,width:2,height:3}];
    const index:chunks.NeighborhoodChunkIndex={format:chunks.NEIGHBORHOOD_CHUNKS_PROTO,sourceSnapshot:'a'.repeat(64),snapshot:'',size:1024,side:8,maxWidth:300,maxHeight:400,pages:[]};
    const bytes=chunks.encodeNeighborhoodChunkProto(bitmaps,-1,-1,1024),sha=await sha256(bytes),ref={x:-1,y:-1,records:2,url:sha+'.pb',sha256:sha,bytes:bytes.length};
    expect(chunks.decodeNeighborhoodChunk(bytes,ref,index,4031).bitmaps).toEqual(bitmaps);
    expect(()=>chunks.decodeNeighborhoodChunk(bytes,{...ref,records:3},index,4031)).toThrow();
    expect(()=>chunks.decodeNeighborhoodChunk(bytes.slice(0,-1),ref,index,4031)).toThrow();
    const page=chunks.encodeNeighborhoodChunkPageProto([ref],-1,-1),hash=await sha256(page),pageRef={x:-1,y:-1,url:hash+'.pb',sha256:hash,bytes:page.length};
    expect(chunks.decodeNeighborhoodChunkPage(page,pageRef,index)).toEqual([ref]);
    const duplicated=chunks.encodeNeighborhoodChunkProto([bitmaps[0],{...bitmaps[1],id:0}],-1,-1,1024);
    expect(()=>chunks.decodeNeighborhoodChunk(duplicated,{...ref,bytes:duplicated.length},index,4031)).toThrow();
});
test('packed float means preserve original Float32 bytes and reject corrupt versions/counts/domain',()=>{
    const values=Float32Array.from([1,1.234567,7.25,15]),wire=encodeParcelMeans(values);
    expect(new Uint8Array(decodeParcelMeans(wire,values.length,PARCEL_MEANS_PROTO).buffer)).toEqual(new Uint8Array(values.buffer));
    expect(decodeParcelMeans(new Uint8Array(values.buffer),4,'parcel-size-means-v1')).toEqual(values);
    const badVersion=wire.slice();badVersion[1]=2;expect(()=>decodeParcelMeans(badVersion,4,PARCEL_MEANS_PROTO)).toThrow();
    expect(()=>decodeParcelMeans(wire,3,PARCEL_MEANS_PROTO)).toThrow();
    expect(()=>decodeParcelMeans(wire.slice(0,-1),4,PARCEL_MEANS_PROTO)).toThrow();
    expect(()=>encodeParcelMeans(Float32Array.from([NaN]))).toThrow();
    expect(()=>encodeParcelMeans(Float32Array.from([0]))).toThrow();
});
