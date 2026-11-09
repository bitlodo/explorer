#!/usr/bin/env bun
import {datasetPath} from './dataset-path';
import { readMapManifest } from './read-map-manifest';
import { reportGenerationProgress } from './generation-progress';
// Offline geometry only. No DB, parcel layouts or source mutations.
import fs from 'node:fs/promises';
import path from 'node:path';
import protobuf from 'protobufjs';
import {check,sha256} from '../src/shared/httpPack';
import descriptor from '../src/shared/proto/neighborhood_descriptor.json';
export async function generateBitmapAreaColors(source:string,out:string){
 source=await fs.realpath(source);out=path.resolve(out);out=path.join(await fs.realpath(path.dirname(out)),path.basename(out));
 check(out!==source&&!out.startsWith(source+path.sep),'Use a separate new output directory');
 const manifest=(await readMapManifest(source)).manifest;
 const type=protobuf.Root.fromJSON(descriptor).lookupType('Neighborhood');
 let count=0,maxArea=1;const neighborhoodMeans:number[]=[];
 for(const region of manifest.regions){
  const bytes=new Uint8Array(await fs.readFile(datasetPath(source,region.geometry.url)));
  check(bytes.length===region.geometry.bytes&&await sha256(bytes)===region.geometry.sha256,'Geometry integrity failure');
  const data=type.decode(bytes) as any;
  check(data.neighborhood===region.id&&data.width===region.width&&data.height===region.height&&data.bitmaps.length===2016,'Invalid canonical neighborhood');
  let sum=0;
  for(const r of data.bitmaps){const area=r.width*r.height;check(Number.isSafeInteger(area)&&r.width>0&&r.height>0&&r.x>=0&&r.y>=0&&r.x+r.width<=region.width&&r.y+r.height<=region.height,'Invalid bitmap bounds/area');sum+=area;maxArea=Math.max(maxArea,area);count++;}
  neighborhoodMeans.push(sum/data.bitmaps.length);
  reportGenerationProgress({ kind: 'neighborhood', phase: 'Bitmap area colors', id: region.id, completed: neighborhoodMeans.length, total: manifest.regions.length, action: 'processed' });
 }
 check(maxArea<=145908,'Area exceeds the existing preview encoding; generate a new version');
 check(count===manifest.publishedHeight+1,'Incomplete geometry coverage');
 const root={format:'bitmap-area-colors-v1',normalization:'linear-area-v1',sourceSnapshot:manifest.snapshot,count,maxArea,neighborhoodMeans};
 await fs.mkdir(out,{recursive:false});await fs.writeFile(path.join(out,'bitmap-area-colors.json'),JSON.stringify(root)+'\n',{flag:'wx'});
 console.log(JSON.stringify({count,maxArea,neighborhoods:neighborhoodMeans.length}));return root;
}
if(import.meta.main){const args=process.argv.slice(2);check(args.length===4&&args[0]==='--source'&&args[2]==='--out','Use --source SNAPSHOT --out NEW_DIR');await generateBitmapAreaColors(args[1],args[3]);}
