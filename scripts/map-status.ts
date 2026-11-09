import {resolve} from 'node:path';
import {rename,lstat,rm,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {Database,OPEN_READONLY} from './duckdb';
import {readMapManifest} from './read-map-manifest';
import {mapStatus,type MapStatus} from '../src/shared/siteMetadata';

export async function readMapStatus(source:string,snapshot:string,publishedHeight:number){
    const filename=resolve(source,'status.json'),info=await lstat(filename).catch(e=>{if(e.code!=='ENOENT')throw e;});
    if(!info)return;
    if(!info.isFile()||info.isSymbolicLink())throw Error('Unsafe map status file');
    const file=Bun.file(filename);
    if(file.size>16*1024)throw Error('Map status exceeds its metadata budget');
    return mapStatus(await file.json(),snapshot,publishedHeight);
}

/** Update UI status only; never publish partial neighborhoods or alter payloads. */
export async function writeMapStatus(source:string,database:string,options:{previous?:string;generated?:boolean;connection?:Database}={}){
    const {manifest}=await readMapManifest(source),{snapshot,publishedHeight}=manifest;
    const prior=await readMapStatus(options.previous??source,snapshot,publishedHeight);
    const db=options.connection??await Database.create(database,OPEN_READONLY);
    let syncedHeight:number|null=null,syncedAt:string|null=null;
    try{
        const row=(await db.all('SELECT min(bitmap) AS first,max(bitmap) AS last,count(*) AS records FROM bitmaps'))[0];
        if(Number(row.first)===0&&Number(row.records)===Number(row.last)+1&&Number(row.last)>=publishedHeight)syncedHeight=Number(row.last);
        const tables=await db.all("SELECT 1 FROM information_schema.tables WHERE table_name='aws_partitions'");
        if(tables.length){const time=(await db.all('SELECT max(processed_at) AS time FROM aws_partitions'))[0]?.time;if(time&&Number.isFinite(Date.parse(time)))syncedAt=new Date(time).toISOString();}
    }finally{if(!options.connection)await db.close();}
    const now=new Date().toISOString();
    const status:MapStatus={format:'bitmap-map-status-v1',snapshot,publishedHeight,syncedHeight,syncedAt,
        generatedAt:prior?.generatedAt??(options.generated?now:null),checkedAt:now};
    const filename=resolve(source,'status.json'),info=await lstat(filename).catch(e=>{if(e.code!=='ENOENT')throw e;});
    if(info&&(!info.isFile()||info.isSymbolicLink()))throw Error('Unsafe map status file');
    const temporary=filename+'.tmp-'+randomUUID();
    try{await writeFile(temporary,JSON.stringify(status,null,2)+'\n',{flag:'wx'});await rename(temporary,filename);}
    finally{await rm(temporary,{force:true});}
    return status;
}
