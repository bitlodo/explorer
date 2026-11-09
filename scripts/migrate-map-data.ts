import { mkdtemp, rm } from 'node:fs/promises';
import { resolve, dirname, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { argumentsFor } from './cli';
import { acquireSyncLock, safeDirectory } from './aws-download';
import { replaceMapData } from './generate';
import { convertSemanticDataset } from './semantic-dataset';
import { isSemanticDataset } from './dataset-path';
import { readMapManifest } from './read-map-manifest';
import { projectRoot, temporaryRoot } from './paths';
import { check } from '../src/shared/httpPack';

export async function migrateMapData(sourceArg:string,options:{workRoot?:string;log?:(text:string)=>void}={}){
    const source=resolve(sourceArg),log=options.log??console.log;
    const work=resolve(options.workRoot??(source.startsWith(projectRoot+sep)?temporaryRoot:resolve(dirname(source),'.tmp')));
    check(source!==work&&!source.startsWith(work+sep)&&!work.startsWith(source+sep),'Migration staging must be separate');
    await safeDirectory(work);const unlock=await acquireSyncLock(work,'.generate.lock');let directory:string|undefined;
    try{
        check(!await Bun.file(resolve(work,'publish.json')).exists(),'Recover the pending publication with map:generate before migrating');
        const {manifest}=await readMapManifest(source);
        if(isSemanticDataset(source)){log('Semantic source paths are already active.');return source;}
        directory=await mkdtemp(resolve(work,'generation-'));
        const output=resolve(directory,'semantic-map-data');await convertSemanticDataset(source,output);
        const archiveRoot=source.startsWith(projectRoot+sep)?resolve(projectRoot,'.cache/maintenance/map-data-history'):resolve(dirname(source),'.cache/maintenance/map-data-history');
        const archive=resolve(archiveRoot,`legacy-${manifest.snapshot}-${randomUUID()}`);
        await replaceMapData(output,source,directory,archive);log(`Previous dataset preserved: ${archive}`);log('Semantic source paths are ready for bun dev.');return source;
    }finally{
        if(directory&&!await Bun.file(resolve(work,'publish.json')).exists())await rm(directory,{recursive:true,force:true});await unlock();
    }
}
if(import.meta.main){const args=argumentsFor(process.argv.slice(2),['--source','--out','--install']);check(args['--source'],'Use --source MAP_DATA [--out NEW_DIRECTORY | --install true]');
    if(args['--install']==='true'){check(!args['--out'],'Choose --out or --install');await migrateMapData(args['--source']);}
    else{check(args['--out']&&!args['--install'],'Use --out NEW_DIRECTORY or --install true');await convertSemanticDataset(args['--source'],args['--out']);}
}
