import {encodeParcelMeans,PARCEL_MEANS_PROTO} from '../../src/shared/parcelMeans';
import { readMapManifest } from '../read-map-manifest';
import { reportGenerationProgress } from '../generation-progress';
// Offline, READ_ONLY. Produces a separate summary; never starts the legacy server.
import fs from 'node:fs/promises';
import path from 'node:path';
import { Database, OPEN_READONLY } from '../duckdb';
import crypto from 'node:crypto';
import {databasePath} from '../db-config.ts';
const args=process.argv.slice(2),opts:Record<string,string>={};
if(args.length%2)throw Error('Use --source SNAPSHOT --out NEW_DIR [--db FILE]');
for(let i=0;i<args.length;i+=2){if(!['--source','--out','--db'].includes(args[i])||opts[args[i]])throw Error('Unknown/duplicate option');opts[args[i]]=args[i+1];}
if(!opts['--source']||!opts['--out'])throw Error('--source and --out required');
const source=path.resolve(opts['--source']),out=path.resolve(opts['--out']);
if(out===source||out.startsWith(source+path.sep))throw Error('Use a separate output directory');
const manifest=(await readMapManifest(source)).manifest;
if(manifest.publishedHeight>=1048576)throw Error('Summary exceeds v1 bitmap budget');
const dbPath=databasePath('DB_BITMAP',opts['--db']);
if(!dbPath)throw Error('Supply --db');
await fs.mkdir(out,{recursive:false});
let db;
try{
 db=await Database.create(dbPath,OPEN_READONLY);await db.exec("SET memory_limit='512MB'; SET threads=2; BEGIN TRANSACTION");
 const values=new Float32Array(manifest.publishedHeight+1);let records=0;
 for(let first=0;first<=manifest.publishedHeight;first+=2016){
  const last=Math.min(first+2016,manifest.publishedHeight+1);
  const rows=await db.all('SELECT bitmap, list_avg(tx) AS mean FROM bitmaps WHERE bitmap >= ? AND bitmap < ? ORDER BY bitmap',first,last);
  if(rows.length!==last-first)throw Error('Missing source bitmaps');
  for(let i=0;i<rows.length;i++){
   const {bitmap,mean}=rows[i];if(bitmap!==first+i||!Number.isFinite(mean)||mean<1||mean>15)throw Error('Invalid bitmap/mean '+bitmap);
   values[bitmap]=mean;records++;
  }
  if(first%20160===0)console.log(JSON.stringify({records}));
  reportGenerationProgress({ kind: 'neighborhood', phase: 'Parcel-size colors', id: Math.floor(first / 2016), completed: Math.ceil(last / 2016), total: manifest.regions.length, action: 'processed' });
 }
 const bytes=encodeParcelMeans(values);
 const hash=crypto.createHash('sha256').update(bytes).digest('hex'),url=hash+'.pb';await fs.writeFile(path.join(out,url),bytes,{flag:'wx'});
 await fs.writeFile(path.join(out,'parcel-colors.json'),JSON.stringify({format:PARCEL_MEANS_PROTO,sourceSnapshot:manifest.snapshot,count:records,means:{url,bytes:bytes.length,sha256:hash},preview:'parcel-size-preview.pb'})+'\n',{flag:'wx'});
 console.log(JSON.stringify({records,bytes:bytes.length,sourceSnapshot:manifest.snapshot}));
}finally{if(db)await db.close();}
