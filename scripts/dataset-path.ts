import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { validateDatasetReference } from '../src/shared/datasetReference';
import { validateRelease, routeBucket, type MapRelease } from '../src/shared/mapRelease';
import { check, type FileRef } from '../src/shared/httpPack';
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
type Dataset={signature:string;release:MapRelease;routes:Map<string,{bytes:number;paths:Record<string,FileRef>}>;routeBytes:number;verified:Map<string,string>};
const datasets=new Map<string,Dataset>();
export function isSemanticDataset(root:string){return existsSync(resolve(root,'release.json'));}
function identity(path:string){const s=statSync(path);return `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;}
function checkedFile(root:string,ref:FileRef,state?:Dataset){
    check(ref&&typeof ref.url==='string'&&!ref.url.startsWith('/')&&!ref.url.includes('..')&&!ref.url.includes('\\')&&!ref.url.includes(':'),'Unsafe dataset route');
    const path=resolve(root,ref.url),real=realpathSync(path);check(real===path&&real.startsWith(root+sep),'Dataset route escapes its root');
    const signature=identity(path);
    if(state?.verified.get(path)!==signature){const bytes=readFileSync(path);check(bytes.length===ref.bytes&&hash(bytes)===ref.sha256,'Dataset routing integrity failure: '+ref.url);state?.verified.set(path,signature);}
    return path;
}
function dataset(root:string):Dataset|undefined{
    const locator=resolve(root,'release.json');if(!existsSync(locator))return;
    const signature=identity(locator),existing=datasets.get(root);if(existing?.signature===signature)return existing;
    check(realpathSync(locator)===locator,'Dataset reference must not be a symlink');
    const ref=validateDatasetReference(JSON.parse(readFileSync(locator,'utf8'))).release;
    const bytes=readFileSync(checkedFile(root,ref)),release=validateRelease(JSON.parse(bytes.toString()));
    const state:Dataset={signature,release,routes:new Map(),routeBytes:0,verified:new Map()};datasets.delete(root);datasets.set(root,state);
    while(datasets.size>8)datasets.delete(datasets.keys().next().value!);return state;
}
/** Resolve logical v9 references to physical semantic files, without aliases on disk. */
export function datasetPath(rootArg:string,...parts:string[]):string{
    const root=resolve(rootArg),name=parts.join('/');check(!parts.some(p=>p.startsWith('/')||/^[A-Za-z]:/.test(p))&&!name.startsWith('/')&&!name.split('/').some(p=>p==='..')&&!name.includes('\\'),'Unsafe dataset path');
    const state=dataset(root);if(!state||name==='report.json'||name==='release.json')return resolve(root,...parts);
    const ref=state.release.roots[name];if(ref)return checkedFile(root,ref,state);
    const bucket=routeBucket(name),page=bucket?state.release.routes[bucket]:undefined;
    if(!bucket||!page)return resolve(root,...parts);
    let cached=state.routes.get(bucket);
    if(cached){state.routes.delete(bucket);state.routes.set(bucket,cached);}
    else{
        check(page.bytes<=2*1024*1024,'Dataset routing shard exceeds budget');
        const bytes=readFileSync(checkedFile(root,page,state));cached={bytes:bytes.length,paths:JSON.parse(bytes.toString())};state.routes.set(bucket,cached);state.routeBytes+=cached.bytes;
        while(state.routeBytes>8*1024*1024&&state.routes.size>1){const key=state.routes.keys().next().value!;state.routeBytes-=state.routes.get(key)!.bytes;state.routes.delete(key);}
    }
    const target=cached.paths[name];if(!target)return resolve(root,...parts);
    check(target.sha256===name.match(/([a-f0-9]{64})\.[^.]+$/)?.[1],'Dataset route content identity mismatch');
    // Payload readers authenticate bytes themselves, including trusted-baseline
    // validation paths that intentionally perform only presence/length checks.
    check(!target.url.startsWith('/')&&!target.url.includes('..')&&!target.url.includes('\\')&&!target.url.includes(':'),'Unsafe payload route');
    return resolve(root,target.url);
}
export function datasetLogicalFiles(rootArg:string):string[]{
    const root=resolve(rootArg),state=dataset(root);if(!state)throw Error('Semantic dataset required');
    const files=[...Object.keys(state.release.roots),'report.json'];
    for(const ref of Object.values(state.release.routes)){const bytes=readFileSync(checkedFile(root,ref,state));files.push(...Object.keys(JSON.parse(bytes.toString())));}
    return [...new Set(files)].sort();
}
