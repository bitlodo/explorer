import {isSemanticDataset} from './dataset-path';
import {editSemanticDataset} from './semantic-dataset';
import {readFile,mkdir,writeFile,rename} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {argumentsFor} from './cli';
import {openPublishedMap} from './published-map';
import {appendFile} from './publish-release';
import {dataPath} from '../src/shared/dataStorage';
import {decodeNeighborhoodChunkIndex,decodeNeighborhoodChunkPage,decodeNeighborhoodChunk} from '../src/shared/neighborhoodChunks';
import {check,sha256,type FileRef} from '../src/shared/httpPack';
export async function installBitmapChunks(bundle:string,target:string):Promise<import('../src/shared/neighborhoodChunks').NeighborhoodChunkIndex>{
    if(isSemanticDataset(target))return editSemanticDataset(target,typed=>installBitmapChunks(bundle,typed));
    const map=await openPublishedMap(target),bytes=new Uint8Array(await readFile(resolve(bundle,'neighborhood-chunks.json'))),root=await decodeNeighborhoodChunkIndex(bytes,map.manifest.snapshot);
    const seen=new Uint8Array(map.manifest.publishedHeight+1),canonical=new Map<number,ReturnType<typeof map.neighborhood>>();
    const read=async(ref:FileRef)=>{const bytes=new Uint8Array(await readFile(resolve(bundle,ref.url)));check(bytes.length===ref.bytes&&await sha256(bytes)===ref.sha256,'Bitmap chunk integrity failure');return bytes;};
    const files:FileRef[]=[];
    for(const page of root.pages){const bytes=await read(page);files.push(page);
        for(const ref of decodeNeighborhoodChunkPage(bytes,page,root)){
            const chunk=decodeNeighborhoodChunk(await read(ref),ref,root,map.manifest.publishedHeight);files.push(ref);
            for(const b of chunk.bitmaps){check(!seen[b.id],'Duplicate bitmap chunk ID');seen[b.id]=1;const id=Math.floor(b.id/2016);let neighborhood=canonical.get(id);if(!neighborhood){neighborhood=map.neighborhood(id);canonical.set(id,neighborhood);}
                const original=neighborhood.data.bitmaps[b.id%2016],region=map.manifest.regions[id];check(b.x===region.x+original.x&&b.y===region.y+original.y&&b.width===original.width&&b.height===original.height,'Bitmap chunk differs from canonical geometry');}
        }
    }
    check(seen.every(Boolean),'Incomplete bitmap chunk coverage');map.assertUnchanged();
    for(const ref of files)await appendFile(target,dataPath(map.manifest.storageLayout,'bitmap-chunks',ref.url),await read(ref));
    await writeFile(resolve(target,'neighborhood-chunks.json.tmp'),bytes);map.assertUnchanged();await rename(resolve(target,'neighborhood-chunks.json.tmp'),resolve(target,'neighborhood-chunks.json'));return root;
}
if(import.meta.main){const args=argumentsFor(process.argv.slice(2),['--source','--target']);check(args['--source']&&args['--target'],'Use --source NEW_BITMAP_CHUNKS --target MAP_DATA');await installBitmapChunks(args['--source'],args['--target']);}
