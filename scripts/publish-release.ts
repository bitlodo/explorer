import {datasetPath,isSemanticDataset,datasetLogicalFiles} from './dataset-path';
import {decodeLod4Index,lod4RegionPath} from '../src/shared/lod4';
import {decodeNeighborhoodChunkIndex,decodeNeighborhoodChunkPage} from '../src/shared/neighborhoodChunks';
import {dataPath} from '../src/shared/dataStorage';
import { mkdir, readdir, readFile, writeFile, realpath, lstat } from 'node:fs/promises';
import { resolve, dirname, sep } from 'node:path';
import protobuf from 'protobufjs';
import { readMapManifest } from './read-map-manifest';
import { createProtoCodec } from '../src/shared/protobufChunks';
import { canonicalBytes, decodeRelease, immutableName, routeBucket, signedCell, RELEASE_FORMAT, type MapRelease } from '../src/shared/mapRelease';
import { sha256, check, type FileRef } from '../src/shared/httpPack';
import { argumentsFor,runTool } from './cli';
const codec=createProtoCodec(protobuf);
export async function artifactFiles(root:string,prefix=''):Promise<string[]>{
    const result:string[]=[];
    for(const entry of await readdir(resolve(root,prefix),{withFileTypes:true})){
        check(!entry.isSymbolicLink(),'Release files must not be symlinks');
        const name=prefix+entry.name;
        if(entry.isDirectory())result.push(...await artifactFiles(root,name+'/'));else{check(entry.isFile(),'Invalid release artifact');result.push(name);}
    }
    return result.sort();
}
/** Exclusive writes plus full-byte comparison make retries idempotent. Never remove old content. */
export async function appendFile(root:string,name:string,bytes:Uint8Array){
    check(!name.startsWith('/')&&!name.split('/').some(p=>p==='..'||p==='.'),'Unsafe immutable path');
    const destination=resolve(root,name);await mkdir(dirname(destination),{recursive:true});
    check(await realpath(dirname(destination))===dirname(destination),'Immutable output cannot traverse symlinks');
    const prior=await lstat(destination).catch(e=>{if(e.code!=='ENOENT')throw e;});
    if(prior){check(prior.isFile()&&!prior.isSymbolicLink(),'Unsafe immutable destination');check(Buffer.from(await readFile(destination)).equals(Buffer.from(bytes)),'Immutable artifact conflict: '+name);return;}
    try{await writeFile(destination,bytes,{flag:'wx'});}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;check(Buffer.from(await readFile(destination)).equals(Buffer.from(bytes)),'Immutable artifact conflict: '+name);}
}
/** Input is a fully validated publication tree; the descriptor is the commit point. */
export async function publishRelease(sourceArg:string,storeArg:string,options:{legacyUrls?:boolean;files?:string[]}={}){
    const source=await realpath(resolve(sourceArg)),store=resolve(storeArg);
    check(source!==store&&!source.startsWith(store+sep)&&!store.startsWith(source+sep),'Release store must be separate from the source');
    await mkdir(store,{recursive:true});check(await realpath(store)===store,'Release store cannot traverse symlinks');
    const {manifest}=await readMapManifest(source);
    const names=new Map<string,string>();
    for(const r of manifest.regions)for(const [kind,ref] of [['geometry',r.geometry],['dimensions',r.dimensions]] as const)if(ref)names.set(ref.url,`neighborhoods/${kind}/n${String(r.id).padStart(6,'0')}.${ref.sha256}.pb`);
    for(const page of manifest.indexPages??[]){
        names.set(page.url,`parcels/index/${signedCell(page.x,page.y)}.${page.sha256}.pb`);
        const bytes=new Uint8Array(await readFile(datasetPath(source,page.url)));check(bytes.length===page.bytes&&await sha256(bytes)===page.sha256,'Release page integrity failure');
        for(const chunk of codec.decodeIndexPage(bytes,page,manifest)){const parts=new Map<number,number>();for(const pack of chunk.packs){const band=Math.floor(pack.first/2016),part=parts.get(band)??0;parts.set(band,part+1);names.set(pack.url,`parcels/chunks/${signedCell(chunk.x,chunk.y)}_n${String(band).padStart(6,'0')}_p${String(part).padStart(3,'0')}.${pack.sha256}.pb`);}}
    }
    let bitmapGrid=10240;
    if(await Bun.file(datasetPath(source,'lod4.json')).exists()){
        const discovery=await Bun.file(datasetPath(source,'lod4.json')).json(),bytes=new Uint8Array(await readFile(datasetPath(source,discovery.index.url)));
        const index=await decodeLod4Index(bytes,manifest.snapshot,discovery.index.sha256);names.set(discovery.index.url,`bitmaps/summaries/index.${discovery.index.sha256}.pb`);
        for(const ref of index.regions)names.set('lod4/'+lod4RegionPath(ref),`bitmaps/summaries/n${String(ref.id).padStart(6,'0')}.${ref.sha256}.pb`);
    }
    if(await Bun.file(datasetPath(source,'neighborhood-chunks.json')).exists()){
        const index=await decodeNeighborhoodChunkIndex(new Uint8Array(await readFile(datasetPath(source,'neighborhood-chunks.json'))),manifest.snapshot);bitmapGrid=index.size;
        for(const ref of index.pages){const url=dataPath(manifest.storageLayout,'bitmap-chunks',ref.url);names.set(url,`bitmaps/index/${signedCell(ref.x,ref.y)}.${ref.sha256}.pb`);
            const bytes=new Uint8Array(await readFile(datasetPath(source,url)));check(bytes.length===ref.bytes&&await sha256(bytes)===ref.sha256,'Release bitmap index integrity failure');
            for(const chunk of decodeNeighborhoodChunkPage(bytes,ref,index))names.set(dataPath(manifest.storageLayout,'bitmap-chunks',chunk.url),`bitmaps/chunks/${signedCell(chunk.x,chunk.y)}.${chunk.sha256}.pb`);
        }
    }
    if(await Bun.file(datasetPath(source,'analytics.json')).exists()){
        const root=await Bun.file(datasetPath(source,'analytics.json')).json();
        root.regions.forEach((ref:FileRef,id:number)=>names.set(dataPath(manifest.storageLayout,'colors',ref.url),`metrics/inspection/n${String(id).padStart(6,'0')}.${ref.sha256}.pb`));
        for(const [key,ref] of Object.entries(root.patternPages??{}) as [string,FileRef][])names.set(dataPath(manifest.storageLayout,'colors',ref.url),`metrics/patterns/b${key.padStart(4,'0')}.${ref.sha256}.pb`);
        for(const [key,value] of Object.entries(root.metrics) as [string,{values:FileRef;preview:FileRef}][])for(const [kind,ref] of Object.entries(value))if(kind==='values'||kind==='preview')names.set(dataPath(manifest.storageLayout,'colors',(ref as FileRef).url),`metrics/global/${key}-${kind}.${(ref as FileRef).sha256}.pb`);
    }
    const release:MapRelease={format:RELEASE_FORMAT,storage:'semantic-aliases-v1',snapshot:manifest.snapshot,roots:{},routes:{},grids:{parcels:manifest.grid!.size,bitmaps:bitmapGrid}};
    const buckets=new Map<string,Record<string,FileRef>>();
    for(const path of options.files??(isSemanticDataset(source)?datasetLogicalFiles(source):await artifactFiles(source))){
        if(path==='status.json')continue; // Mutable UI observations are separate from authenticated payload identity.
        if(path==='report.json'){if(!await Bun.file(resolve(store,path)).exists())await appendFile(store,path,new Uint8Array(await readFile(datasetPath(source,path))));continue;}
        if(path.startsWith('releases/')||path.startsWith('routing/')||path.startsWith('manifests/'))continue;
        check(/\.(?:json|pb|nbc|bin|means)$/.test(path),'Unsupported release artifact: '+path);
        const bytes=new Uint8Array(await readFile(datasetPath(source,path))),hash=await sha256(bytes),ext=path.split('.').at(-1)!;
        if(immutableName(path))check(path.includes(hash+'.'),'Release artifact hash mismatch: '+path);
        let name=names.get(path);
        if(!name){
            if(path==='parcel-filters.json')name=`metrics/parcel-filters/discovery.${hash}.json`;
            else if(path==='lod4-summary.json')name=`bitmaps/summaries/aggregates/discovery.${hash}.json`;
            else if(path.startsWith('lod4/regions/'))name=`bitmaps/summaries/${hash}.pb`;
            else if(path==='lod4.json')name=`bitmaps/summaries/discovery.${hash}.json`;
            else if(path.startsWith('lod4/'))name=`bitmaps/summaries/index.${hash}.${ext}`;
            else if(path==='neighborhood-chunks.json')name=`bitmaps/index/discovery.${hash}.json`;
            else if(path==='analytics.json')name=`metrics/analytics.${hash}.json`;
            else if(path==='metrics.json')name=`metrics/index.${hash}.json`;
            else if(path==='layer-analysis.json')name=`metrics/layers.${hash}.json`;
            else if(path==='bitmap-area-colors.json')name=`metrics/area/summary.${hash}.json`;
            else if(path==='parcel-colors.json')name=`metrics/parcel-size/summary.${hash}.json`;
            else if(path==='bitmap-reference.json')name=`metrics/patterns/index.${hash}.json`;
            else if(path.startsWith('metrics/'))name=path;
            else if(path.startsWith('colors/'))name=`metrics/auxiliary/${hash}.${ext}`;
            else if(path.startsWith('bitmap-chunks/'))name=`bitmaps/chunks/${hash}.${ext}`;
            else if(path.startsWith('parcel-index/'))name=`parcels/index/${hash}.${ext}`;
            else if(path.startsWith('parcels/'))name=`parcels/chunks/${hash}.${ext}`;
            else if(path.startsWith('previews/'))name=`bitmaps/previews/${immutableName(path)?'':'index.'}${hash}.${ext}`;
            else if(path.startsWith('parcel-previews/'))name=`parcels/previews/${immutableName(path)?'':'index.'}${hash}.${ext}`;
            else if(path.startsWith('geometry/'))name=`neighborhoods/geometry/${hash}.${ext}`;
            else if(path.startsWith('dimensions/'))name=`neighborhoods/dimensions/${hash}.${ext}`;
            else if(immutableName(path)&&!path.includes('/'))name=`metrics/reference/${hash}.${ext}`;
            else if(!immutableName(path))name=`manifests/${path.replaceAll('/','-').replace(/\.[^.]+$/,'')}.${hash}.${ext}`;
            else name=path;
        }
        const ref={url:name,sha256:hash,bytes:bytes.length};await appendFile(store,name,bytes);
        if(immutableName(path)){
            // Retained legacy hash URLs keep older readers usable after upgrading.
            if(options.legacyUrls!==false&&name!==path)await appendFile(store,path,bytes);
            const key=routeBucket(path)!;if(!buckets.has(key))buckets.set(key,{});buckets.get(key)![path]=ref;
        }else {release.roots[path]=ref;if(options.legacyUrls!==false&&!await Bun.file(resolve(store,path)).exists())await appendFile(store,path,bytes);}
    }
    for(const [key,paths] of buckets){const bytes=canonicalBytes(paths),hash=await sha256(bytes),url=`routing/${key}.${hash}.json`;await appendFile(store,url,bytes);release.routes[key]={url,sha256:hash,bytes:bytes.length};}
    const bytes=canonicalBytes(release),hash=await sha256(bytes);await decodeRelease(bytes,hash);
    const path=`releases/${hash}.json`;await appendFile(store,path,bytes);return path;
}
if(import.meta.main){const args=argumentsFor(process.argv.slice(2),['--source','--store']);check(args['--source']&&args['--store'],'Use --source VALIDATED_MAP_DATA --store RETAINED_STORE');await runTool('scripts/tools/prepare-pages.ts',[args['--source'],resolve(args['--store'],'unused-app'),resolve(args['--store'],'unused-site'),'--validate-only']);console.log(await publishRelease(args['--source'],args['--store']));}
