import protobuf from 'protobufjs';
import descriptor from './proto/map_addons_descriptor.json';
import {check, integer, sha256, type FileRef} from './httpPack';
export const BITMAP_GRID_POLICY='bitmap-owner-grid-v1-2048';
export const NEIGHBORHOOD_CHUNKS_PROTO='neighborhood-bitmap-chunks-v2-protobuf';
const protoRoot=protobuf.Root.fromJSON(structuredClone(descriptor)), ChunkType=protoRoot.lookupType('bitmap.addons.BitmapChunk'), PageType=protoRoot.lookupType('bitmap.addons.ChunkPage');
export const NEIGHBORHOOD_CHUNKS='neighborhood-bitmap-chunks-v1';
export const NEIGHBORHOOD_CHUNK_LIMIT=16*1024*1024;
export type ChunkBounds={x:number;y:number;width:number;height:number};
export type NeighborhoodBitmap={id:number;x:number;y:number;width:number;height:number};
export type NeighborhoodChunkRef=FileRef&{x:number;y:number;records:number;
    /** Runtime-only potential geometry extent from the authenticated index. */
    coverageBounds?:ChunkBounds;
};
export type NeighborhoodChunk=NeighborhoodChunkRef&{size:number;bitmaps:NeighborhoodBitmap[]};
export type NeighborhoodChunkPage=FileRef&{x:number;y:number};
export type NeighborhoodChunkIndex={gridPolicy?:typeof BITMAP_GRID_POLICY;format:typeof NEIGHBORHOOD_CHUNKS | typeof NEIGHBORHOOD_CHUNKS_PROTO;sourceSnapshot:string;snapshot:string;size:number;side:number;maxWidth:number;maxHeight:number;pages:NeighborhoodChunkPage[]};
const encoder=new TextEncoder(),decoder=new TextDecoder();
export function jsonBytes(value:unknown){return encoder.encode(JSON.stringify(value));}
export function readJSON(bytes:Uint8Array){return JSON.parse(decoder.decode(bytes));}
export function validateChunkFile(ref:FileRef,format:string=NEIGHBORHOOD_CHUNKS){check(/^[a-f0-9]{64}$/.test(ref.sha256)&&ref.url===ref.sha256+(format===NEIGHBORHOOD_CHUNKS_PROTO?'.pb':'.nbc')&&integer(ref.bytes,1,NEIGHBORHOOD_CHUNK_LIMIT),'Invalid neighborhood chunk file');}
export async function decodeNeighborhoodChunkIndex(bytes:Uint8Array,sourceSnapshot:string):Promise<NeighborhoodChunkIndex>{
    check(bytes.length<=128*1024,'Neighborhood chunk root exceeds limit');
    const value=readJSON(bytes) as NeighborhoodChunkIndex;
    check((value.format===NEIGHBORHOOD_CHUNKS||value.format===NEIGHBORHOOD_CHUNKS_PROTO)&&value.sourceSnapshot===sourceSnapshot&&integer(value.size,1,0x7fffffff)&&integer(value.side,1,64)&&integer(value.maxWidth,1,0x7fffffff)&&integer(value.maxHeight,1,0x7fffffff)&&Array.isArray(value.pages)&&value.pages.length<=10000,'Invalid neighborhood chunk root');
    check(value.gridPolicy===undefined||(value.gridPolicy===BITMAP_GRID_POLICY&&value.size===2048),'Unsupported bitmap grid policy');
    const {snapshot,...unsigned}=value;check(snapshot===await sha256(jsonBytes(unsigned)),'Neighborhood chunk root hash mismatch');
    const keys=new Set<string>();for(const ref of value.pages){validateChunkFile(ref,value.format);check(integer(ref.x,-0x7fffffff,0x7fffffff)&&integer(ref.y,-0x7fffffff,0x7fffffff)&&!keys.has(`${ref.x},${ref.y}`),'Duplicate/invalid neighborhood page');keys.add(`${ref.x},${ref.y}`);}
    return value;
}
export function decodeNeighborhoodChunkPage(bytes:Uint8Array,ref:NeighborhoodChunkPage,index:NeighborhoodChunkIndex):NeighborhoodChunkRef[]{
    let value;
    if(index.format===NEIGHBORHOOD_CHUNKS_PROTO){
        check(bytes.length===ref.bytes && bytes.length<=NEIGHBORHOOD_CHUNK_LIMIT,'Invalid chunk page length');
        const raw=PageType.toObject(PageType.decode(bytes),{defaults:true,arrays:true});
        check(raw.version===1,'Unsupported chunk page version');
        value={format:NEIGHBORHOOD_CHUNKS_PROTO,x:raw.x,y:raw.y,chunks:raw.chunks.map((c:any)=>{const sha256=Array.from(c.sha256 as Uint8Array,b=>b.toString(16).padStart(2,'0')).join('');return{x:c.x,y:c.y,records:c.records,sha256,bytes:c.bytes,url:sha256+'.pb'};})};
    }else value=readJSON(bytes);
    check(value.format===index.format&&value.x===ref.x&&value.y===ref.y&&Array.isArray(value.chunks)&&value.chunks.length<=index.side**2,'Invalid neighborhood chunk page');
    const keys=new Set<string>();for(const c of value.chunks){validateChunkFile(c,index.format);check(integer(c.x,-0x7fffffff,0x7fffffff)&&integer(c.y,-0x7fffffff,0x7fffffff)&&Math.floor(c.x/index.side)===ref.x&&Math.floor(c.y/index.side)===ref.y&&integer(c.records,1,599185)&&!keys.has(`${c.x},${c.y}`),'Invalid neighborhood chunk reference');keys.add(`${c.x},${c.y}`);}
    return value.chunks;
}
// Lossless world coordinates (float64), canonical IDs and integer dimensions.
export function encodeNeighborhoodChunk(bitmaps:NeighborhoodBitmap[],x:number,y:number,size:number){
    const bytes=new Uint8Array(24+bitmaps.length*28),v=new DataView(bytes.buffer);v.setUint32(0,0x4e424331);v.setInt32(4,x);v.setInt32(8,y);v.setUint32(12,size);v.setUint32(16,bitmaps.length);v.setUint32(20,1);
    bitmaps.forEach((b,i)=>{const p=24+i*28;v.setUint32(p,b.id);v.setFloat64(p+4,b.x);v.setFloat64(p+12,b.y);v.setUint32(p+20,b.width);v.setUint32(p+24,b.height);});return bytes;
}
export function decodeNeighborhoodChunk(bytes:Uint8Array,ref:NeighborhoodChunkRef,index:NeighborhoodChunkIndex,publishedHeight:number):NeighborhoodChunk{
    check(bytes.length===ref.bytes&&bytes.length<=NEIGHBORHOOD_CHUNK_LIMIT,'Invalid neighborhood chunk length');
    let bitmaps:NeighborhoodBitmap[]=[];
    if(index.format===NEIGHBORHOOD_CHUNKS_PROTO){
        const raw=ChunkType.toObject(ChunkType.decode(bytes),{defaults:true,arrays:true});
        check(raw.version===1&&raw.x===ref.x&&raw.y===ref.y&&raw.size===index.size,'Neighborhood chunk identity mismatch');
        check([raw.ids,raw.xs,raw.ys,raw.widths,raw.heights].every(a=>a.length===ref.records),'Protobuf chunk column count mismatch');
        bitmaps=raw.ids.map((id:number,i:number)=>({id,x:raw.xs[i],y:raw.ys[i],width:raw.widths[i],height:raw.heights[i]}));
    }else{
        check(bytes.length===24+ref.records*28,'Invalid neighborhood chunk length');const v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
        check(v.getUint32(0)===0x4e424331&&v.getInt32(4)===ref.x&&v.getInt32(8)===ref.y&&v.getUint32(12)===index.size&&v.getUint32(16)===ref.records&&v.getUint32(20)===1,'Neighborhood chunk identity mismatch');
        for(let i=0;i<ref.records;i++){const p=24+i*28;bitmaps.push({id:v.getUint32(p),x:v.getFloat64(p+4),y:v.getFloat64(p+12),width:v.getUint32(p+20),height:v.getUint32(p+24)});}
    }
    let last=-1;
    for(const b of bitmaps){check(integer(b.id,last+1,publishedHeight)&&Number.isFinite(b.x)&&Number.isFinite(b.y)&&Math.floor(b.x/index.size)===ref.x&&Math.floor(b.y/index.size)===ref.y&&integer(b.width,1,index.maxWidth)&&integer(b.height,1,index.maxHeight),'Invalid neighborhood bitmap rectangle');last=b.id;}
    return {...ref,size:index.size,bitmaps};
}
export function chunkIntersects(ref:{x:number;y:number},size:number,bounds:ChunkBounds,maxWidth=0,maxHeight=0){return ref.x*size<bounds.x+bounds.width&&ref.y*size<bounds.y+bounds.height&&(ref.x+1)*size+maxWidth>bounds.x&&(ref.y+1)*size+maxHeight>bounds.y;}

export function encodeNeighborhoodChunkProto(bitmaps:NeighborhoodBitmap[],x:number,y:number,size:number):Uint8Array{
    return ChunkType.encode({version:1,x,y,size,ids:bitmaps.map(b=>b.id),xs:bitmaps.map(b=>b.x),ys:bitmaps.map(b=>b.y),widths:bitmaps.map(b=>b.width),heights:bitmaps.map(b=>b.height)}).finish();
}
export function encodeNeighborhoodChunkPageProto(chunks:NeighborhoodChunkRef[],x:number,y:number):Uint8Array{
    return PageType.encode({version:1,x,y,chunks:chunks.map(c=>({...c,sha256:Uint8Array.from(c.sha256.match(/../g)!,h=>parseInt(h,16))}))}).finish();
}
