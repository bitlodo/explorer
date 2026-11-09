import {isSemanticDataset} from './dataset-path';
import {editSemanticDataset} from './semantic-dataset';
import { mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { check, sha256 } from '../src/shared/httpPack';
import { LOD4_FORMAT, lod4RegionPath, validateLod4Discovery, type Lod4Discovery } from '../src/shared/lod4';
import { validateLod4Bundle } from './generate-lod4';
import { argumentsFor } from './cli';
import { mapDataRoot } from './paths';

/** Install only verified immutable addon files; canonical payloads are never rewritten. */
export async function installLod4(bundle:string,target=mapDataRoot):Promise<Lod4Discovery>{
    if(isSemanticDataset(target))return editSemanticDataset(target,typed=>installLod4(bundle,typed));
    const root=await realpath(resolve(target)),input=await realpath(resolve(bundle));
    const {index}=await validateLod4Bundle(input,root);
    const indexBytes=new Uint8Array(await readFile(resolve(input,'lod4.pb'))),hash=await sha256(indexBytes);
    const destination=resolve(root,'lod4');await mkdir(resolve(destination,'regions'),{recursive:true});
    check((await realpath(destination)).startsWith(root+sep)&&(await realpath(resolve(destination,'regions'))).startsWith(root+sep),'LOD4 install destination escapes source');
    const copy=async(name:string,bytes:Uint8Array)=>{
        const file=resolve(destination,name);
        try{await writeFile(file,bytes,{flag:'wx'});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;check(await sha256(new Uint8Array(await readFile(file)))===await sha256(bytes),'Existing LOD4 artifact differs');}
    };
    for(const ref of index.regions)await copy(lod4RegionPath(ref),new Uint8Array(await readFile(resolve(input,lod4RegionPath(ref)))));
    await copy(hash+'.pb',indexBytes);
    const discovery:Lod4Discovery={format:LOD4_FORMAT,sourceSnapshot:index.sourceSnapshot,index:{url:`lod4/${hash}.pb`,sha256:hash,bytes:indexBytes.length}};
    validateLod4Discovery(discovery,index.sourceSnapshot);
    const bytes=JSON.stringify(discovery)+'\n',temporary=resolve(root,`.lod4-${crypto.randomUUID()}.json`);
    await writeFile(temporary,bytes,{flag:'wx'});await rename(temporary,resolve(root,'lod4.json'));
    return discovery;
}
if(import.meta.main){const args=argumentsFor(process.argv.slice(2),['--source','--bundle']);check(args['--bundle'],'Use --bundle LOD4_DIRECTORY');console.log(JSON.stringify(await installLod4(args['--bundle'],args['--source'])));}
