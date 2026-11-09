import { canonicalJson } from './mapManifest';
import { check, sha256, type FileRef } from './httpPack';
export const RELEASE_FORMAT='bitmap-immutable-release-v1';
export type MapRelease={format:typeof RELEASE_FORMAT;storage:'semantic-aliases-v1';snapshot:string;roots:Record<string,FileRef>;routes:Record<string,FileRef>;grids:{parcels:number;bitmaps:number}};
export const immutableName=(path:string)=>/(?:^|[./])[a-f0-9]{64}\.(?:json|pb|bin|nbc|means)$/.test(path);
export const routeBucket=(path:string)=>path.match(/([a-f0-9]{64})\.(?:json|pb|bin|nbc|means)$/)?.[1].slice(0,2);
export function signedCell(x:number,y:number){
    check(Number.isSafeInteger(x)&&Number.isSafeInteger(y),'Invalid world cell');
    const axis=(v:number)=>(v<0?'-':'+')+String(Math.abs(v)).padStart(4,'0');
    return `x${axis(x)}_y${axis(y)}`;
}
export const canonicalBytes=(value:unknown)=>new TextEncoder().encode(canonicalJson(value)+'\n');
export async function decodeRelease(bytes:Uint8Array,hash:string):Promise<MapRelease>{
    check(bytes.length<=256*1024&&await sha256(bytes)===hash,'Release integrity failure');
    return validateRelease(JSON.parse(new TextDecoder().decode(bytes)));
}
export function validateRelease(r:MapRelease):MapRelease{
    check(r.format===RELEASE_FORMAT&&r.storage==='semantic-aliases-v1'&&/^[a-f0-9]{64}$/.test(r.snapshot)&&r.roots&&r.routes&&(r.roots['manifest.json']||r.roots['manifest.pb']),'Unsupported release');
    check(r.grids&&[r.grids.parcels,r.grids.bitmaps].every(n=>Number.isSafeInteger(n)&&n>0&&n<=0x7fffffff),'Invalid release grids');
    for(const ref of [...Object.values(r.roots),...Object.values(r.routes)])check(ref&&Number.isSafeInteger(ref.bytes)&&ref.bytes>0&&ref.bytes<=16*1024*1024&&immutableName(ref.url)&&!ref.url.includes('..')&&!ref.url.startsWith('/'),'Invalid release reference');
    check(Object.keys(r.routes).every(k=>/^[a-f0-9]{2}$/.test(k))&&Object.keys(r.routes).length<=256,'Invalid release routes');
    return r;
}
