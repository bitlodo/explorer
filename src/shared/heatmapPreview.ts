import { dataPath } from './dataStorage';
import descriptor from './proto/heatmap_preview_descriptor.json';
import {check, integer, sha256, type FileRef} from './httpPack';
export const PREVIEW_LIMIT = 2 * 1024 * 1024;
export type PreviewTileRef = FileRef & {level: number; x: number; y: number};
export type PreviewIndex = {channels?:1|3;sourceSnapshot: string; layout: string; tileSize: number; resolution: number; maxLevel: number; tiles: PreviewTileRef[]; snapshot: string};
const hex = (bytes: Uint8Array) => Array.from(bytes, x=>x.toString(16).padStart(2,'0')).join('');
const hashBytes = (hash: string) => {check(/^[a-f0-9]{64}$/.test(hash),'Invalid preview hash');return Uint8Array.from(hash.match(/../g)!,x=>parseInt(x,16));};
export const previewKey = (level: number,x: number,y: number) => `${level}:${x}:${y}`;
export const smooth = (a: number,b: number,x: number) => {const t=Math.min(1,Math.max(0,(x-a)/(b-a)));return t*t*(3-2*t);};
export const PREVIEW_PIXEL_TARGET = 1;
// Group 4x4 old 4096/24 tiles, retaining the exact world/pixel density.
export const DEFAULT_PREVIEW_TILE_SIZE = 16384;
export const DEFAULT_PREVIEW_RESOLUTION = 96;
export const PREVIEW_LOD_POLICY = 'preview-stops-v10-deferred-coverage-uploads';
// Lower-resolution tiles should reduce data/texture size, without selecting
// finer world tiles to compensate and undoing the intended reduction.
export const PREVIEW_LOD_RESOLUTION = 256;
export const previewLevel = (worldPerPixel: number,index: Pick<PreviewIndex,'tileSize'|'resolution'|'maxLevel'>) => Math.max(0,Math.min(index.maxLevel,Math.round(Math.log2(Math.max(1,worldPerPixel*PREVIEW_PIXEL_TARGET/(index.tileSize/Math.max(PREVIEW_LOD_RESOLUTION,index.resolution)))))));
export const BITMAP_FADE = {start:90,end:260};
export const PARCEL_FADE = {start:24,end:64};
// One scale for the whole viewport. Object size still controls download eligibility,
// but cannot introduce a third presentation level into a camera transition.
export const LOD_REFERENCE = {neighborhood:512,bitmap:8};
export const parcelReference=(closestWorldPerPixel:number)=>Math.max(LOD_REFERENCE.bitmap,PARCEL_FADE.end*closestWorldPerPixel);
export function cameraDetail(worldPerPixel:number,index:Pick<PreviewIndex,'tileSize'|'resolution'|'maxLevel'>,closestWorldPerPixel=0):number {
    const pixels=1/worldPerPixel;
    const exact=smooth(BITMAP_FADE.start,BITMAP_FADE.end,LOD_REFERENCE.neighborhood*pixels);
    if(exact>0)return index.maxLevel+exact+(exact===1?smooth(PARCEL_FADE.start,PARCEL_FADE.end,parcelReference(closestWorldPerPixel)*pixels):0);
    return Math.max(0,index.maxLevel-Math.max(0,Math.log2(Math.max(1,worldPerPixel*2/(index.tileSize/Math.max(PREVIEW_LOD_RESOLUTION,index.resolution))))));
}
export function detailLayers(detail:number):{index:number;weight:number}[] {
    const lower=Math.floor(detail),mix=detail-lower;
    return mix<1e-6?[{index:lower,weight:1}]:1-mix<1e-6?[{index:lower+1,weight:1}]:[{index:lower,weight:1-mix},{index:lower+1,weight:mix}];
}
/** Traverse adjacent levels, stopping at boundaries until the next one is ready. */
export function advanceDetail(current:number,target:number,dt:number,ready:(level:number)=>boolean):number {
    if(Math.abs(target-current)<1e-6)return Math.abs(target-Math.round(target))<1e-6?Math.round(target):target;
    const direction=Math.sign(target-current),boundary=direction>0?Math.floor(current+1e-6)+1:Math.ceil(current-1e-6)-1;
    if(!ready(boundary))return current;
    const next=current+direction*Math.min(Math.abs(target-current),Math.abs(boundary-current),Math.max(0,Math.min(.1,dt))*8);
    return Math.abs(next-Math.round(next))<1e-6?Math.round(next):next;
}
export function createPreviewCodec(protobuf: any) {
    const root=protobuf.Root.fromJSON(descriptor), Index=root.lookupType('bitmap.preview.Index'), Tile=root.lookupType('bitmap.preview.Tile');
    function encodeIndex(index: PreviewIndex,withHash=true):Uint8Array {
        return Index.encode({version:1,sourceSnapshot:hashBytes(index.sourceSnapshot),layout:index.layout,tileSize:index.tileSize,resolution:index.resolution,maxLevel:index.maxLevel,
            tiles:index.tiles.map(t=>({level:t.level,x:t.x,y:t.y,sha256:hashBytes(t.sha256),bytes:t.bytes})),...(withHash&&index.snapshot?{snapshot:hashBytes(index.snapshot)}:{})}).finish();
    }
    async function decodeIndex(bytes:Uint8Array,sourceSnapshot:string, storage?:string, kind:'previews'|'parcel-previews'='previews'):Promise<PreviewIndex>{
        check(bytes.length<=PREVIEW_LIMIT,'Preview index exceeds budget');
        const raw=Index.toObject(Index.decode(bytes),{defaults:true,arrays:true});
        check(raw.version===1&&typeof raw.layout==='string'&&raw.layout.length>0&&raw.layout.length<=128&&hex(raw.sourceSnapshot)===sourceSnapshot,'Preview belongs to another snapshot/layout');
        check(integer(raw.tileSize,64,1048576)&&integer(raw.resolution,16,512)&&integer(raw.maxLevel,0,20)&&raw.tiles.length<=20000,'Invalid preview pyramid');
        const keys=new Set<string>();
        const tiles:PreviewTileRef[]=raw.tiles.map((t:any)=>{
            const key=previewKey(t.level,t.x,t.y),hash=hex(t.sha256);
            check(integer(t.level,0,raw.maxLevel)&&integer(t.x,-0x80000000,0x7fffffff)&&integer(t.y,-0x80000000,0x7fffffff)&&integer(t.bytes,1,PREVIEW_LIMIT)&&/^[a-f0-9]{64}$/.test(hash)&&!keys.has(key),'Invalid/duplicate preview tile');keys.add(key);
            return {level:t.level,x:t.x,y:t.y,sha256:hash,bytes:t.bytes,url:dataPath(storage,kind,hash+'.pb')};
        });
        const index={sourceSnapshot,layout:raw.layout,tileSize:raw.tileSize,resolution:raw.resolution,maxLevel:raw.maxLevel,tiles,snapshot:hex(raw.snapshot)};
        check(await sha256(encodeIndex(index,false))===index.snapshot,'Corrupt preview index');return index;
    }
    const encodeTile=(level:number,x:number,y:number,resolution:number,deflatedRgba:Uint8Array):Uint8Array=>Tile.encode({version:1,level,x,y,resolution,deflatedRgba}).finish();
    function decodeTile(bytes:Uint8Array,ref:PreviewTileRef,index:PreviewIndex):Uint8Array{
        const t=Tile.toObject(Tile.decode(bytes),{defaults:true});
        check(t.version===1&&t.level===ref.level&&t.x===ref.x&&t.y===ref.y&&t.resolution===index.resolution&&t.deflatedRgba.length<=PREVIEW_LIMIT,'Invalid preview tile identity');
        return new Uint8Array(t.deflatedRgba);
    }
    return{encodeIndex,decodeIndex,encodeTile,decodeTile};
}
