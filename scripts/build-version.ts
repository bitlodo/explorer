import {dirname,resolve} from 'node:path';
import {rename,rm,lstat,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {acquireSyncLock,safeDirectory} from './aws-download';
import {projectRoot} from './paths';
import type {SiteBuild} from '../src/shared/siteMetadata';

export const buildVersionPath=resolve(projectRoot,'build-version.json');

/** Serialize successful build numbers across output directories and processes. */
export async function reserveBuildVersion(filename=buildVersionPath){
    await safeDirectory(dirname(filename));
    const release=await acquireSyncLock(dirname(filename),'.build-version.lock').catch(error=>{
        if(error instanceof Error&&error.message.startsWith('Another sync'))throw Error('Another site build is using this version counter.');
        throw error;
    });
    const temporary=filename+'.tmp-'+randomUUID();
    try{
        const info=await lstat(filename).catch(e=>{if(e.code!=='ENOENT')throw e;});
        if(info&&(!info.isFile()||info.isSymbolicLink()))throw Error('Unsafe build version file');
        const previous:SiteBuild=info?await Bun.file(filename).json():{version:0,builtAt:null};
        if(!Number.isSafeInteger(previous.version)||previous.version<0||previous.version>=Number.MAX_SAFE_INTEGER)throw Error('Invalid build version');
        const next:SiteBuild={version:previous.version+1,builtAt:new Date().toISOString()};
        return {next,async commit(){await writeFile(temporary,JSON.stringify(next,null,2)+'\n',{flag:'wx'});await rename(temporary,filename);},
            async release(){try{await rm(temporary,{force:true});}finally{await release();}}};
    }catch(error){await release();throw error;}
}
