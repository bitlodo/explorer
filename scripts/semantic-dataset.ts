import { mkdir, mkdtemp, readFile, writeFile, rm, realpath, link, copyFile, constants } from 'node:fs/promises';
import { resolve, dirname, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { artifactFiles, appendFile, publishRelease } from './publish-release';
import { datasetPath, isSemanticDataset } from './dataset-path';
import { readMapManifest } from './read-map-manifest';
import { runTool } from './cli';
import { canonicalBytes, decodeRelease, immutableName, routeBucket } from '../src/shared/mapRelease';
import { DATASET_REFERENCE_FORMAT, validateDatasetReference } from '../src/shared/datasetReference';
import { check, type FileRef } from '../src/shared/httpPack';
import {readMapStatus} from './map-status';
import {reportBuildProgress} from './build-progress';
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const collections=new Set(['bitmaps','parcels','neighborhoods','metrics','manifests','routing','releases']);

/** Authenticate and copy the current release without recomputing layouts or filters. */
export async function copyCurrentSemanticDataset(sourceArg:string,targetArg:string,expectedSnapshot?:string){
    const source=await realpath(resolve(sourceArg)),target=resolve(targetArg);
    check(source!==target&&!source.startsWith(target+sep)&&!target.startsWith(source+sep),'Use a separate publication directory');
    function validateRef(ref:FileRef){
        check(ref&&typeof ref.url==='string'&&!ref.url.includes('\\')&&!ref.url.includes(':')&&
            !ref.url.split('/').some(part=>!part||part==='.'||part==='..')&&collections.has(ref.url.split('/')[0])&&
            immutableName(ref.url)&&ref.url.match(/([a-f0-9]{64})\.[^.]+$/)?.[1]===ref.sha256&&
            Number.isSafeInteger(ref.bytes)&&ref.bytes>0,'Invalid publication reference');
    }
    async function readRef(ref:FileRef){
        validateRef(ref);
        const filename=resolve(source,ref.url);
        check(filename.startsWith(source+sep)&&await realpath(filename)===filename,'Publication artifact escapes its source');
        const bytes=await readFile(filename);
        check(bytes.length===ref.bytes&&hash(bytes)===ref.sha256,'Publication artifact integrity failure: '+ref.url);
        return bytes;
    }
    const selectorFile=resolve(source,'release.json');
    check(await realpath(selectorFile)===selectorFile,'Dataset reference must not be a symlink');
    const selector=await readFile(selectorFile),reference=validateDatasetReference(JSON.parse(selector.toString()));
    const descriptor=await readRef(reference.release),release=await decodeRelease(descriptor,reference.release.sha256);
    const {manifest}=await readMapManifest(source);
    check(release.snapshot===manifest.snapshot&&(!expectedSnapshot||release.snapshot===expectedSnapshot),'Publication snapshot binding mismatch');
    const files=new Map<string,FileRef>();
    function add(ref:FileRef){
        validateRef(ref);
        const prior=files.get(ref.url);
        check(!prior||(prior.sha256===ref.sha256&&prior.bytes===ref.bytes),'Conflicting publication references: '+ref.url);
        files.set(ref.url,ref);
    }
    add(reference.release);
    for(const ref of Object.values(release.roots))add(ref);
    reportBuildProgress({phase:'Reading authenticated routing'});
    for(const [bucket,ref] of Object.entries(release.routes)){
        check(ref.bytes<=2*1024*1024,'Dataset routing shard exceeds budget');
        add(ref);
        const routes=JSON.parse((await readRef(ref)).toString());
        check(routes&&typeof routes==='object'&&!Array.isArray(routes),'Invalid dataset routing shard');
        for(const [logical,value] of Object.entries(routes) as [string,FileRef][]){
            check(!logical.startsWith('/')&&!logical.includes('..')&&!logical.includes('\\')&&!logical.includes(':')&&
                routeBucket(logical)===bucket&&logical.match(/([a-f0-9]{64})\.[^.]+$/)?.[1]===value?.sha256,'Dataset route content identity mismatch');
            add(value);
        }
    }
    await mkdir(target,{recursive:true});
    let completed=0,copiedBytes=0;
    reportBuildProgress({phase:'Copying map files',completed,total:files.size,unit:'files',bytes:copiedBytes});
    for(const ref of [...files.values()].sort((a,b)=>a.url.localeCompare(b.url))){
        const bytes=await readRef(ref);
        // Independent files keep edits to disposable build output away from source data.
        await appendFile(target,ref.url,bytes);
        copiedBytes+=bytes.length;
        reportBuildProgress({phase:'Copying map files',completed:++completed,total:files.size,unit:'files',bytes:copiedBytes});
    }
    check(Buffer.from(await readFile(selectorFile)).equals(selector),'Source changed during publication');
    await appendFile(target,'release.json',selector);
    return {files:files.size+1,bytes:copiedBytes+selector.length};
}

/** Preserve immutable source history in the same semantic tree, without legacy aliases. */
export async function copySemanticTree(source:string,target:string){
    check(isSemanticDataset(source),'Semantic dataset required');await mkdir(target,{recursive:true});
    for(const path of await artifactFiles(source)){
        if(path==='generation-source.json')continue; // Obsolete maintenance metadata is never a distributed artifact.
        if(path==='status.json')continue; // Mutable observations are copied only when their dataset identity matches.
        if(path==='release.json'||path==='report.json')continue;
        check(collections.has(path.split('/')[0])&&immutableName(path),'Unexpected semantic dataset file: '+path);
        const bytes=await readFile(resolve(source,path)),expected=path.match(/([a-f0-9]{64})\.[^.]+$/)![1];check(hash(bytes)===expected,'Retained semantic artifact integrity failure: '+path);
        const destination=resolve(target,path);await mkdir(dirname(destination),{recursive:true});check(await realpath(dirname(destination))===dirname(destination),'Semantic output cannot traverse symlinks');
        if(await Bun.file(destination).exists())await appendFile(target,path,bytes);
        else try{await link(resolve(source,path),destination);}catch(error){if(!['EXDEV','EPERM','EACCES'].includes((error as NodeJS.ErrnoException).code??''))throw error;await copyFile(resolve(source,path),destination,constants.COPYFILE_EXCL);}
    }
}

/** Convert validated logical v9 data into its native semantic physical layout. */
export async function convertSemanticDataset(sourceArg:string,outArg:string,options:{baseline?:string;retain?:string;allowSample?:boolean}={}){
    const source=await realpath(resolve(sourceArg)),out=resolve(outArg);
    check(source!==out&&!source.startsWith(out+sep)&&!out.startsWith(source+sep),'Use a separate new semantic output');
    const input=await readMapManifest(source),locator=isSemanticDataset(source)?resolve(source,'release.json'):input.filename,original=await readFile(locator);
    await mkdir(dirname(out),{recursive:true});check(await realpath(dirname(out))===dirname(out),'Semantic output cannot traverse symlinks');
    check(!await Bun.file(resolve(out,'release.json')).exists(),'Semantic output already exists');
    const scratch=await mkdtemp(resolve(dirname(out),'.semantic-validation-'));
    try{
        const list=resolve(scratch,'files.json');
        await runTool('scripts/tools/prepare-pages.ts',[source,resolve(scratch,'app'),resolve(scratch,'site'),'--validate-only','--file-list='+list,
            ...(options.baseline?['--baseline='+options.baseline]:[]),...(options.allowSample?['--allow-sample']:[])]);
        const files=JSON.parse(await readFile(list,'utf8')) as {snapshot:string;files:string[]};check(files.snapshot===input.manifest.snapshot,'Semantic conversion snapshot changed');
        await mkdir(out,{recursive:false});
        const retained=options.retain??(isSemanticDataset(source)?source:undefined);
        if(retained)await copySemanticTree(retained,out);
        const path=await publishRelease(source,out,{legacyUrls:false,files:files.files});
        const bytes=await readFile(resolve(out,path)),sha256=hash(bytes),reference=validateDatasetReference({format:DATASET_REFERENCE_FORMAT,release:{url:path,sha256,bytes:bytes.length}});
        const report=JSON.parse(await readFile(datasetPath(source,'report.json'),'utf8'));
        await writeFile(resolve(out,'report.json'),JSON.stringify({...report,physicalStorage:DATASET_REFERENCE_FORMAT},null,2)+'\n');
        check(Buffer.from(await readFile(locator)).equals(original),'Source changed during semantic conversion');
        await writeFile(resolve(out,'release.json'),canonicalBytes(reference),{flag:'wx'});
        const output=await readMapManifest(out);check(output.manifest.snapshot===input.manifest.snapshot,'Semantic conversion changed canonical identity');
        const status=await readMapStatus(source,output.manifest.snapshot,output.manifest.publishedHeight)??
            (retained?await readMapStatus(retained,output.manifest.snapshot,output.manifest.publishedHeight):undefined);
        if(status)await writeFile(resolve(out,'status.json'),JSON.stringify(status,null,2)+'\n',{flag:'wx'});
        return {snapshot:output.manifest.snapshot,release:path,out};
    }finally{await rm(scratch,{recursive:true,force:true});}
}

/** Materialize an owned intermediate view for existing conversion algorithms. */
export async function materializeLogicalDataset(source:string,target:string){
    await mkdir(target,{recursive:false});const {datasetLogicalFiles}=await import('./dataset-path');
    for(const path of datasetLogicalFiles(source)){const destination=resolve(target,path);await mkdir(dirname(destination),{recursive:true});await copyFile(datasetPath(source,path),destination,constants.COPYFILE_EXCL);}
}

/** Addon installers edit an isolated logical view, then atomically publish native paths. */
export async function editSemanticDataset<T>(targetArg:string,edit:(logicalRoot:string)=>Promise<T>):Promise<T>{
    const target=resolve(targetArg);check(isSemanticDataset(target),'Semantic dataset required');
    const {temporaryRoot,projectRoot}=await import('./paths'),{safeDirectory,acquireSyncLock}=await import('./aws-download');
    const work=target.startsWith(projectRoot+sep)?temporaryRoot:resolve(dirname(target),'.tmp');await safeDirectory(work);
    const unlock=await acquireSyncLock(work,'.generate.lock');let directory:string|undefined;
    try{
        check(!await Bun.file(resolve(work,'publish.json')).exists(),'Recover the pending map publication with map:generate before installing addons');
        directory=await mkdtemp(resolve(work,'generation-addon-'));const typed=resolve(directory,'logical'),next=resolve(directory,'semantic');await materializeLogicalDataset(target,typed);
        const result=await edit(typed);await convertSemanticDataset(typed,next,{retain:target});
        const {replaceMapData}=await import('./generate');await replaceMapData(next,target,directory);return result;
    }finally{if(directory&&!await Bun.file(resolve(work,'publish.json')).exists())await rm(directory,{recursive:true,force:true});await unlock();}
}
