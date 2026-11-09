import {test,expect} from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {inflateSync} from 'node:zlib';
import {generatePreviews} from './generate-previews';
import {createPreviewCodec} from '../src/shared/heatmapPreview';
import {LAYOUT,sha256} from '../src/shared/httpPack';
const require=createRequire(new URL('../package.json',import.meta.url)),protobuf=require('protobufjs');
const type=protobuf.Root.fromJSON(require('./src/shared/proto/neighborhood_descriptor.json')).lookupType('Neighborhood'),codec=createPreviewCodec(protobuf);
test('Bun preview generation covers negative coordinates, weights coverage and reuses unchanged pixels',async()=>{
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'preview-raster-'));
    try{
        const source=path.join(root,'source'),out=path.join(root,'out'),next=path.join(root,'next');await fs.mkdir(source);
        const bytes=type.encode({neighborhood:0,width:64,height:32,bitmaps:Array.from({length:2016},(_,i)=>({x:i%64,y:Math.floor(i/64),width:1,height:1}))}).finish(),hash=await sha256(bytes),geometry={url:hash+'.pb',sha256:hash,bytes:bytes.length};await Bun.write(path.join(source,geometry.url),bytes);
        const manifest:any={snapshot:'1'.repeat(64),layout:LAYOUT,publishedHeight:2015,regions:[{id:0,width:64,height:32,x:-32,y:-16,geometry}]};
        const result=await generatePreviews({source,out,manifest,tileSize:64,resolution:64});expect(result.bitmaps).toBe(2016);expect(result.tiles).toBe(12);
        const index=await codec.decodeIndex(new Uint8Array(await Bun.file(path.join(out,'preview.pb')).arrayBuffer()),manifest.snapshot),ref=index.tiles.find(t=>t.level===0&&t.x===-1&&t.y===-1)!;
        const data=codec.decodeTile(new Uint8Array(await Bun.file(path.join(out,ref.url)).arrayBuffer()),ref,index),pixels=inflateSync(data),offset=(48*64+32)*4;
        expect(pixels[offset+1]).toBe(64);expect(pixels[offset+2]).toBe(0);expect(pixels[offset+3]).toBe(0);expect(pixels[1]).toBe(0);
        const repeated=await generatePreviews({source,out:next,previous:out,manifest,tileSize:64,resolution:64});expect(repeated.reused).toBe(12);expect(repeated.written).toBe(0);
        const grouped=path.join(root,'group4');await generatePreviews({source,out:grouped,manifest,tileSize:256,resolution:256});
        const groupedIndex=await codec.decodeIndex(new Uint8Array(await Bun.file(path.join(grouped,'preview.pb')).arrayBuffer()),manifest.snapshot);
        for(const oldRef of index.tiles.filter(t=>t.level===0)){
            const gx=Math.floor(oldRef.x/4),gy=Math.floor(oldRef.y/4),newRef=groupedIndex.tiles.find(t=>t.level===0&&t.x===gx&&t.y===gy)!;
            const oldPixels=inflateSync(codec.decodeTile(new Uint8Array(await Bun.file(path.join(out,oldRef.url)).arrayBuffer()),oldRef,index));
            const newPixels=inflateSync(codec.decodeTile(new Uint8Array(await Bun.file(path.join(grouped,newRef.url)).arrayBuffer()),newRef,groupedIndex));
            const ox=(oldRef.x-gx*4)*64,oy=(oldRef.y-gy*4)*64;
            for(let row=0;row<64;row++)expect(newPixels.subarray(((oy+row)*256+ox)*4,((oy+row)*256+ox+64)*4)).toEqual(oldPixels.subarray(row*64*4,(row+1)*64*4));
        }
        const smaller=path.join(root,'default-96');const defaults=await generatePreviews({source,out:smaller,manifest,tileSize:64});expect(defaults.resolution).toBe(96);
        const halfIndex=await codec.decodeIndex(new Uint8Array(await Bun.file(path.join(smaller,'preview.pb')).arrayBuffer()),manifest.snapshot);
        expect(halfIndex.resolution).toBe(96);expect(halfIndex.tiles.length).toBe(index.tiles.length);
        const halfRef=halfIndex.tiles[0],halfPixels=inflateSync(codec.decodeTile(new Uint8Array(await Bun.file(path.join(smaller,halfRef.url)).arrayBuffer()),halfRef,halfIndex));
        expect(halfPixels.length).toBe(96*96*4);
    }finally{await fs.rm(root,{recursive:true,force:true});}
});
