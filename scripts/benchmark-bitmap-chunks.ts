import {mkdir,writeFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {openPublishedMap} from './published-map';
import {argumentsFor} from './cli';
import {encodeNeighborhoodChunkProto,chunkIntersects,type NeighborhoodBitmap,type ChunkBounds} from '../src/shared/neighborhoodChunks';
import {check} from '../src/shared/httpPack';
/** Offline transfer footprints only. This does not measure browser/GPU speed. */
export async function benchmarkBitmapChunks(source:string,bounds:ChunkBounds){
    const map=await openPublishedMap(source),rows:NeighborhoodBitmap[]=[];let maxWidth=1,maxHeight=1;
    for(const r of map.manifest.regions)for(const [i,b] of map.neighborhood(r.id).data.bitmaps.entries()){rows.push({id:r.id*2016+i,...b,x:r.x+b.x,y:r.y+b.y});maxWidth=Math.max(maxWidth,b.width);maxHeight=Math.max(maxHeight,b.height);}
    const result=[];
    for(const size of [10240,4096,2048,1024]){
        const groups=new Map<string,{x:number;y:number;rows:NeighborhoodBitmap[]}>();
        for(const row of rows){const x=Math.floor(row.x/size),y=Math.floor(row.y/size),key=`${x},${y}`;if(!groups.has(key))groups.set(key,{x,y,rows:[]});groups.get(key)!.rows.push(row);}
        const sizes:number[]=[];let total=0,wantedBytes=0,wantedRecords=0,wanted=0;
        const x=Math.floor(bounds.x/size)*size,y=Math.floor(bounds.y/size)*size,coverage={x,y,width:Math.ceil((bounds.x+bounds.width)/size)*size-x,height:Math.ceil((bounds.y+bounds.height)/size)*size-y};
        for(const g of groups.values()){const bytes=encodeNeighborhoodChunkProto(g.rows,g.x,g.y,size).length;sizes.push(bytes);total+=bytes;
            if(chunkIntersects(g,size,coverage,maxWidth,maxHeight)){wanted++;wantedBytes+=bytes;wantedRecords+=g.rows.length;}}
        sizes.sort((a,b)=>a-b);result.push({size,chunks:groups.size,totalBytes:total,median:sizes[Math.floor(sizes.length*.5)],p95:sizes[Math.floor(sizes.length*.95)],max:sizes.at(-1),wanted,wantedBytes,wantedRecords});
    }
    map.assertUnchanged();return {snapshot:map.manifest.snapshot,bounds,visible:rows.filter(b=>b.x<bounds.x+bounds.width&&b.x+b.width>bounds.x&&b.y<bounds.y+bounds.height&&b.y+b.height>bounds.y).length,grids:result};
}
if(import.meta.main){const args=argumentsFor(process.argv.slice(2),['--source','--audit','--out']);check(args['--source']&&args['--audit']&&args['--out'],'Use --source MAP_DATA --audit AUDIT_JSON --out NEW_REPORT_JSON');const audit=await Bun.file(args['--audit']).json(),report=await benchmarkBitmapChunks(args['--source'],audit.geometryFootprint.bounds);await mkdir(dirname(resolve(args['--out'])),{recursive:true});await writeFile(args['--out'],JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(report));}
