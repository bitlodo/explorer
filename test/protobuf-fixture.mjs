import {createRequire} from 'node:module';
import fs from 'node:fs';
import {loadShared} from './helpers/load-shared.ts';
const require=createRequire(new URL('../package.json',import.meta.url)),protobuf=require('protobufjs');
const {createProtoCodec,PROTO_FORMAT,CHAIN_FORMAT,SHUFFLE_FORMAT}=await loadShared('../../src/shared/protobufChunks.ts');
const {LAYOUT,encodeSizes,sha256}=await loadShared('../../src/shared/httpPack.ts');
const type=protobuf.Root.fromJSON(JSON.parse(fs.readFileSync(new URL('../src/shared/proto/neighborhood_descriptor.json',import.meta.url)))).lookupType('Neighborhood');
export const codec=createProtoCodec(protobuf);
export async function fixture(format='v4'){
    const files=new Map();
    async function ref(bytes){const hash=await sha256(bytes),url=hash+'.pb';files.set(url,bytes);return{url,sha256:hash,bytes:bytes.length};}
    const geometry=await ref(type.encode({neighborhood:0,width:2017,height:1,bitmaps:Array.from({length:2016},(_,x)=>({x,y:0,width:1,height:1}))}).finish());
    const chunks=[];
    for(const [x,first,last] of [[-1,0,1008],[0,1009,2015]]){
        const input=Array.from({length:last-first+1},(_,i)=>encodeSizes(first+i,[1]));
        const packs=[];
        const groups=format==='v6'?[input.filter((_,i)=>i%2===0).reverse(),input.filter((_,i)=>i%2===1).reverse()]:[input];
        for(const group of groups){const built=await (format==='v4'?codec.buildPack(group,x,-1,1024):codec.buildChainedPack(group,x,-1,1024,format==='v6'?6:5));packs.push({...built.descriptor,...await ref(built.wire)});}
        chunks.push({x,y:-1,records:input.length,lastHeight:last,recordDigest:'0'.repeat(64),packs});
    }
    const body={format:format==='v6'?SHUFFLE_FORMAT:format==='v5'?CHAIN_FORMAT:PROTO_FORMAT,...(format==='v6'?{shuffleSeed:20261023}:{}),layout:LAYOUT,publishedHeight:2015,snapshot:'',grid:{size:1024,originX:0,originY:0,ownership:'top-left'},packBytes:524288,
        regions:[{id:0,width:2017,height:1,x:-1008.5,y:-.5,descriptor:geometry,geometry,coverage:'complete'}],chunks,parcelRegions:[0]};
    body.snapshot=await sha256(codec.encodeManifest(body,false));files.set('manifest.pb',codec.encodeManifest(body));
    return{files,manifest:body};
}
