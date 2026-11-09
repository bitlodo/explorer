import {datasetPath} from '../dataset-path';
import { readMapManifest } from '../read-map-manifest';
import { GenerationCoverage, generationProgressEnabled, reportGenerationProgress } from '../generation-progress';
import type { NeighborhoodChunkIndex, NeighborhoodBitmap, NeighborhoodChunkRef } from '../../src/shared/neighborhoodChunks';
import type { MondrianRect } from '../../src/shared/MondrianLayout';
// New additive, snapshot-bound artifacts. Reads canonical rectangles; never recalculates layouts/parcels.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(new URL('../../package.json',import.meta.url));
const protobuf=require('protobufjs');
import {sha256} from '../../src/shared/httpPack.ts';
import * as c from '../../src/shared/neighborhoodChunks.ts';
const [sourceArg,outArg]=process.argv.slice(2);assert(sourceArg&&outArg&&process.argv.length===4,'Usage: node scripts/prepare-neighborhood-chunks.ts SNAPSHOT NEW_OUT');
const source=await fs.realpath(sourceArg),out=path.resolve(outArg);assert(source!==out&&!out.startsWith(source+'/')&&!source.startsWith(out+'/'),'Separate new output required');
await fs.mkdir(out,{recursive:false});
const manifest=(await readMapManifest(source)).manifest;
const slots=manifest.regions;assert(slots?.length===manifest.regions.length);
const type=protobuf.Root.fromJSON(require('./src/shared/proto/neighborhood_descriptor.json')).lookupType('Neighborhood');
// Fixed 2048-unit owner cells bound small-view transfers. Parcel grids and
// canonical rectangles are unchanged; the root versions this spatial grid.
const size=2048,side=8,groups=new Map<string,{x:number;y:number;bitmaps:NeighborhoodBitmap[]}>();let count=0,maxWidth=1,maxHeight=1;
for(const region of manifest.regions){
 assert(Number.isFinite(region.x)&&Number.isFinite(region.y),'Invalid stored world positions');
 const bytes=await fs.readFile(datasetPath(source,region.geometry.url));assert(bytes.length===region.geometry.bytes&&await sha256(bytes)===region.geometry.sha256);
 const data=type.toObject(type.decode(bytes),{defaults:true});assert(data.neighborhood===region.id&&data.bitmaps.length===2016);
 data.bitmaps.forEach((r:MondrianRect,i:number)=>{const b={id:region.id*2016+i,x:slots[region.id].x+r.x,y:slots[region.id].y+r.y,width:r.width,height:r.height};const x=Math.floor(b.x/size),y=Math.floor(b.y/size),key=`${x},${y}`;
 if(!groups.has(key))groups.set(key,{x,y,bitmaps:[]});groups.get(key)!.bitmaps.push(b);count++;maxWidth=Math.max(maxWidth,b.width);maxHeight=Math.max(maxHeight,b.height);});
 reportGenerationProgress({ kind: 'neighborhood', phase: 'Bitmap vector geometry', id: region.id, completed: region.id + 1, total: manifest.regions.length, action: 'processed' });
}
assert(count===manifest.publishedHeight+1);
const write=async (bytes:Uint8Array)=>{const hash=await sha256(bytes),url=hash+'.pb';await fs.writeFile(path.join(out,url),bytes,{flag:'wx'});return{url,sha256:hash,bytes:bytes.length};};
const pages=new Map<string,{format:string;x:number;y:number;chunks:NeighborhoodChunkRef[]}>();let totalBytes=0,maxChunkBytes=0;
const progress = generationProgressEnabled() ? new GenerationCoverage(manifest.publishedHeight, manifest.regions.length) : undefined;
let completedChunks = 0;
for(const g of [...groups.values()].sort((a,b)=>a.y-b.y||a.x-b.x)){
 const bytes=c.encodeNeighborhoodChunkProto(g.bitmaps,g.x,g.y,size),ref={x:g.x,y:g.y,records:g.bitmaps.length,...await write(bytes)};
 const decoded=c.decodeNeighborhoodChunk(bytes,ref,{format:c.NEIGHBORHOOD_CHUNKS_PROTO,sourceSnapshot:manifest.snapshot,snapshot:'',pages:[],side,size,maxWidth,maxHeight},manifest.publishedHeight);assert.deepEqual(decoded.bitmaps,g.bitmaps);
 completedChunks++;
 if (progress) {
  for (const bitmap of g.bitmaps) progress.record(bitmap.id);
  reportGenerationProgress({ kind: 'coverage', phase: 'Bitmap vector chunks written', unit: 'Chunks', completed: completedChunks, total: groups.size, ...progress.snapshot() });
 }
 totalBytes+=bytes.length;maxChunkBytes=Math.max(maxChunkBytes,bytes.length);const x=Math.floor(g.x/side),y=Math.floor(g.y/side),key=`${x},${y}`;if(!pages.has(key))pages.set(key,{format:c.NEIGHBORHOOD_CHUNKS_PROTO,x,y,chunks:[]});pages.get(key)!.chunks.push(ref);
}
const root:NeighborhoodChunkIndex={snapshot:'',gridPolicy:c.BITMAP_GRID_POLICY,format:c.NEIGHBORHOOD_CHUNKS_PROTO,sourceSnapshot:manifest.snapshot,size,side,maxWidth,maxHeight,pages:[]};
for(const page of pages.values())root.pages.push({x:page.x,y:page.y,...await write(c.encodeNeighborhoodChunkPageProto(page.chunks,page.x,page.y))});
const {snapshot:_,...unsigned}=root;root.snapshot=await sha256(c.jsonBytes(unsigned));const bytes=c.jsonBytes(root);await c.decodeNeighborhoodChunkIndex(bytes,manifest.snapshot);
await fs.writeFile(path.join(out,'neighborhood-chunks.json'),bytes,{flag:'wx'});
const report={status:'passed',format:c.NEIGHBORHOOD_CHUNKS_PROTO,sourceSnapshot:manifest.snapshot,snapshot:root.snapshot,size,side,bitmaps:count,chunks:groups.size,pages:pages.size,rootBytes:bytes.length,chunkBytes:totalBytes,maxChunkBytes,validation:'Every bitmap ID, world coordinate and dimension compared exactly after round-trip; canonical source hashes verified. No layout or parcels regenerated.'};
await fs.writeFile(path.join(out,'neighborhood-chunks-report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
