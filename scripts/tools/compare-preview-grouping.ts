import { readMapManifest } from '../read-map-manifest';
// Read-only comparison: regroup pixels without changing heat, coverage or owners.
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {inflateSync} from 'node:zlib';
const require=createRequire(new URL('../../package.json',import.meta.url)),protobuf=require('protobufjs');
import { createPreviewCodec } from '../../src/shared/heatmapPreview.ts';
import { dataPath } from '../../src/shared/dataStorage.ts';
const codec=createPreviewCodec(protobuf);
const [beforeDir,afterDir]=process.argv.slice(2);if(!beforeDir||!afterDir)throw Error('Usage: node scripts/compare-preview-grouping.ts BEFORE AFTER');

async function read(dir:string){
 const manifest=(await readMapManifest(dir)).manifest,source=manifest.snapshot;
 const bytes=fs.readFileSync(path.join(dir,dataPath(manifest.storageLayout,'previews','preview.pb'))),index=await codec.decodeIndex(bytes,source,manifest.storageLayout),pixels=new Map<string,Buffer>(),levels:Record<number,number[]>={};
 for(const ref of index.tiles){const tile=fs.readFileSync(path.join(dir,ref.url));if(tile.length!==ref.bytes||createHash('sha256').update(tile).digest('hex')!==ref.sha256)throw Error('Invalid preview hash');
  const data=inflateSync(codec.decodeTile(tile,ref,index),{maxOutputLength:index.resolution**2*4});if(data.length!==index.resolution**2*4)throw Error('Invalid pixels');pixels.set(`${ref.level}:${ref.x}:${ref.y}`,data);(levels[ref.level]??=[]).push(tile.length);
 }
 return{index,pixels,stats:{sourceSnapshot:source,previewSnapshot:index.snapshot,tileSize:index.tileSize,resolution:index.resolution,indexBytes:bytes.length,tiles:index.tiles.length,tileBytes:index.tiles.reduce((s,t)=>s+t.bytes,0),levels:Object.fromEntries(Object.entries(levels).map(([k,v])=>[k,{count:v.length,median:v.sort((a,b)=>a-b)[Math.floor(v.length/2)],min:Math.min(...v),max:Math.max(...v)}]))}};
}
const a=await read(beforeDir),b=await read(afterDir),factor=b.index.tileSize/a.index.tileSize;
if(!Number.isInteger(factor)||factor<1||b.index.resolution!==a.index.resolution*factor)throw Error('Pixel density changed');
let channelsCompared=0,differences=0;
for(const ref of b.index.tiles){const pixels=b.pixels.get(`${ref.level}:${ref.x}:${ref.y}`);
 for(let sy=0;sy<factor;sy++)for(let sx=0;sx<factor;sx++){
  const previous=a.pixels.get(`${ref.level}:${ref.x*factor+sx}:${ref.y*factor+sy}`);
  for(let y=0;y<a.index.resolution;y++)for(let x=0;x<a.index.resolution;x++)for(let c=0;c<4;c++){
   const expected=previous?previous[(y*a.index.resolution+x)*4+c]:c<2?0:255,actual=pixels![((sy*a.index.resolution+y)*b.index.resolution+sx*a.index.resolution+x)*4+c];channelsCompared++;if(actual!==expected)differences++;
  }
 }
}
if(differences)throw Error(`${differences} preview channels changed`);
console.log(JSON.stringify({status:'passed',factor,before:a.stats,after:b.stats,pixelComparison:{channelsCompared,differences},sourcePreserved:true},null,2));
