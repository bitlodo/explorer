#!/usr/bin/env bun
import {datasetPath} from './dataset-path';
import { readMapManifest } from './read-map-manifest';
import { reportGenerationProgress } from './generation-progress';
import { dataPath } from '../src/shared/dataStorage';
import fs from 'node:fs/promises';
import path from 'node:path';
import {deflateSync} from 'node:zlib';
import {createRequire} from 'node:module';
import {type ProtoManifest} from '../src/shared/protobufChunks';
import {createPreviewCodec,DEFAULT_PREVIEW_TILE_SIZE,DEFAULT_PREVIEW_RESOLUTION,type PreviewIndex,type PreviewTileRef} from '../src/shared/heatmapPreview';
import {check,integer,sha256} from '../src/shared/httpPack';
const require=createRequire(new URL('../package.json',import.meta.url)),protobuf=require('protobufjs');
const codec=createPreviewCodec(protobuf);
const geometry=protobuf.Root.fromJSON(require('./src/shared/proto/neighborhood_descriptor.json')).lookupType('Neighborhood');

export async function generatePreviews(options:{source:string;out?:string;manifest?:ProtoManifest;tileSize?:number;resolution?:number;previous?:string;means?:Float32Array;classes?:Uint32Array;indexName?:string}){
    const source=path.resolve(options.source),out=path.resolve(options.out||source),size=options.tileSize??DEFAULT_PREVIEW_TILE_SIZE,resolution=options.resolution??DEFAULT_PREVIEW_RESOLUTION;
    check(integer(size,64,1048576)&&integer(resolution,16,512),'Invalid preview size/resolution');
    const manifest=options.manifest??(await readMapManifest(source)).manifest;
    check(!options.means||(options.means.length===manifest.publishedHeight+1&&options.means.every(v=>Number.isFinite(v)&&v>=1&&v<=15)),'Invalid parcel means');
    check(!options.classes||(!options.means&&options.classes.length===(manifest.publishedHeight+1)*9),'Invalid parcel class coverage');
    const parcelPreview=!!(options.means||options.classes);
    await fs.mkdir(out,{recursive:true});
    const rectangles=new Float64Array((manifest.publishedHeight+1)*6);let count=0,extent=0;
    for(const region of manifest.regions){
        const bytes=new Uint8Array(await Bun.file(datasetPath(source,region.geometry.url)).arrayBuffer());
        check(bytes.length===region.geometry.bytes&&await sha256(bytes)===region.geometry.sha256,'Preview geometry hash mismatch');
        const data=geometry.decode(bytes);check(data.neighborhood===region.id&&data.width===region.width&&data.height===region.height&&data.bitmaps.length===2016,'Invalid preview geometry');
        for(const r of data.bitmaps){
            check(r.x>=0&&r.y>=0&&r.width>0&&r.height>0&&r.x+r.width<=region.width&&r.y+r.height<=region.height,'Invalid preview bitmap bounds');
            const x=region.x+r.x,y=region.y+r.y,w=Math.max(0,r.width-.5),h=Math.max(0,r.height-.5);
            rectangles.set([x,y,w,h,options.means ? (options.means[count]/15) : Math.min(1,r.width*r.height/145908),region.id],count++*6);
            extent=Math.max(extent,Math.abs(x),Math.abs(y),Math.abs(x+w),Math.abs(y+h));
        }
    }
    const maxLevel=Math.min(20,Math.max(0,Math.ceil(Math.log2(Math.max(1,extent/size))))+2),tiles:PreviewTileRef[]=[];
    let tileBytes=0,reused=0,written=0;
    for(let level=maxLevel;level>=0;level--){
        const world=size*2**level,cell=world/resolution,groups=new Map<string,{x:number;y:number;ids:number[]}>();
        for(let id=0;id<count;id++){
            const o=id*6,x=rectangles[o],y=rectangles[o+1],w=rectangles[o+2],h=rectangles[o+3];
            check((Math.ceil((y+h)/world)-Math.floor(y/world))*(Math.ceil((x+w)/world)-Math.floor(x/world))<=20000,'Preview bitmap spans too many tiles');
            for(let ty=Math.floor(y/world);ty<Math.ceil((y+h)/world);ty++)for(let tx=Math.floor(x/world);tx<Math.ceil((x+w)/world);tx++){
                const key=`${tx},${ty}`;let group=groups.get(key);if(!group){group={x:tx,y:ty,ids:[]};groups.set(key,group);}group.ids.push(id);check(groups.size<=20000,'Preview grid exceeds tile budget');
            }
        }
        let completedTiles = 0;
        for(const group of [...groups.values()].sort((a,b)=>a.y-b.y||a.x-b.x)){
            const n=resolution*resolution,area=new Float64Array(n),heat=new Float64Array(n),dominant=new Float64Array(n),regionWeights=new Float64Array(n),owners=new Uint16Array(n);owners.fill(65535);
            const classWeights=options.classes?new Float64Array(n*9):undefined,ratios=new Float64Array(9);
            let current=-1,touched:number[]=[];
            const finishRegion=()=>{for(const p of touched){if(regionWeights[p]>dominant[p]){dominant[p]=regionWeights[p];owners[p]=current;}regionWeights[p]=0;}touched=[];};
            for(const id of group.ids){
                const o=id*6,x=rectangles[o]-group.x*world,y=rectangles[o+1]-group.y*world,w=rectangles[o+2],h=rectangles[o+3],value=rectangles[o+4],region=rectangles[o+5];
                if(options.classes){let total=0;for(let j=0;j<9;j++)total+=options.classes[id*9+j]*(j+1)**2;check(total>0,'Empty parcel class bitmap');for(let j=0;j<9;j++)ratios[j]=options.classes[id*9+j]*(j+1)**2/total;}
                if(region!==current){finishRegion();current=region;}
                for(let py=Math.max(0,Math.floor(y/cell));py<Math.min(resolution,Math.ceil((y+h)/cell));py++)for(let px=Math.max(0,Math.floor(x/cell));px<Math.min(resolution,Math.ceil((x+w)/cell));px++){
                    const coverage=Math.max(0,Math.min(x+w,(px+1)*cell)-Math.max(x,px*cell))*Math.max(0,Math.min(y+h,(py+1)*cell)-Math.max(y,py*cell));
                    if(!coverage)continue;const p=py*resolution+px;area[p]+=coverage;heat[p]+=coverage*value;
                    if(classWeights)for(let j=0;j<9;j++)classWeights[p*9+j]+=coverage*ratios[j];
                    if(!regionWeights[p])touched.push(p);regionWeights[p]+=coverage;
                }
            }
            finishRegion();
            const rgba=new Uint8Array(n*(options.classes?12:4));
            for(let p=0;p<n;p++){
                if(classWeights){
                    const x=p%resolution,y=Math.floor(p/resolution);
                    for(let j=0;j<9;j++){const plane=Math.floor(j/4),channel=j%4,at=(y*resolution*3+plane*resolution+x)*4+channel;rgba[at]=Math.round(255*Math.min(1,classWeights[p*9+j]/(cell*cell)));}
                    rgba[(y*resolution*3+2*resolution+x)*4+1]=Math.round(255*Math.min(1,area[p]/(cell*cell)));
                }else{rgba[p*4]=area[p]?Math.round(255*heat[p]/area[p]):0;rgba[p*4+1]=Math.round(255*Math.min(1,area[p]/(cell*cell)));rgba[p*4+2]=owners[p]&255;rgba[p*4+3]=owners[p]>>8;}
            }
            const bytes=codec.encodeTile(level,group.x,group.y,resolution,deflateSync(rgba)),hash=await sha256(bytes),url=dataPath(manifest.storageLayout,parcelPreview?'parcel-previews':'previews',hash+'.pb'),target=path.join(out,url);
            await fs.mkdir(path.dirname(target),{recursive:true});
            let reusedFile=false;
            if(await Bun.file(target).exists()){check(await sha256(new Uint8Array(await Bun.file(target).arrayBuffer()))===hash,'Corrupt existing preview');reusedFile=true;}
            else if(options.previous){const previous=path.join(options.previous,url);if(await Bun.file(previous).exists()){const old=new Uint8Array(await Bun.file(previous).arrayBuffer());check(await sha256(old)===hash,'Corrupt previous preview');if(target!==previous)await fs.copyFile(previous,target);reusedFile=true;}}
            if(reusedFile)reused++;else{await Bun.write(target,bytes);written++;}
            tileBytes+=bytes.length;tiles.push({level,x:group.x,y:group.y,url,sha256:hash,bytes:bytes.length});
            reportGenerationProgress({ kind: 'units', phase: `${parcelPreview ? 'Parcel-size' : 'Overview'} previews, level ${level}`, unit: 'Tiles ready', completed: ++completedTiles, total: groups.size });
        }
        console.log(JSON.stringify({stage:'preview',level,tiles:groups.size}));
    }
    const index:PreviewIndex={sourceSnapshot:manifest.snapshot,layout:manifest.layout,tileSize:size,resolution,maxLevel,tiles,snapshot:''};index.snapshot=await sha256(codec.encodeIndex(index,false));
    const indexName=dataPath(manifest.storageLayout,parcelPreview?'parcel-previews':'previews',options.indexName||'preview.pb');
    const bytes=codec.encodeIndex(index);await codec.decodeIndex(bytes,manifest.snapshot);
    await Bun.write(path.join(out,indexName+'.tmp'),bytes);await fs.rename(path.join(out,indexName+'.tmp'),path.join(out,indexName));
    const report={sourceSnapshot:manifest.snapshot,bitmaps:count,tileSize:size,resolution,maxLevel,tiles:tiles.length,tileBytes,indexBytes:bytes.length,reused,written};
    console.log(JSON.stringify(report));return report;
}
if(import.meta.main){
    const args=process.argv.slice(2),opts:Record<string,string>={};check(args.length%2===0,'Usage: bun scripts/generate-previews.ts --source SNAPSHOT [--tile-size 16384] [--resolution 96] [--previous SNAPSHOT]');
    for(let i=0;i<args.length;i+=2){check(['--source','--out','--tile-size','--resolution','--previous'].includes(args[i]),'Unknown preview option');opts[args[i]]=args[i+1];}
    check(opts['--source'],'--source is required');await generatePreviews({source:opts['--source'],out:opts['--out'],previous:opts['--previous'],tileSize:opts['--tile-size']?Number(opts['--tile-size']):undefined,resolution:opts['--resolution']?Number(opts['--resolution']):undefined});
}
