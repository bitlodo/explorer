import {DownloadError} from '../src/data/RetryPolicy';
import StaticHttpDataSource from '../src/data/StaticHttpDataSource';
import {test,expect} from 'bun:test';
import {mkdtemp,rm,readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import protobuf from 'protobufjs';
import {appendFile,publishRelease} from './publish-release';
import {buildParcelSegments} from './parcel-segments';
import {decodeRelease,signedCell} from '../src/shared/mapRelease';
import {createProtoCodec,type ProtoManifest} from '../src/shared/protobufChunks';
import {encodeSizes,HUFFMAN_FORMAT,sha256,LAYOUT} from '../src/shared/httpPack';
import {encodeJsonManifest} from '../src/shared/mapManifest';
import {DATA_STORAGE} from '../src/shared/dataStorage';
import {encodeSpatialMetricPage,decodeSpatialMetricPage} from '../src/shared/spatialMetrics';
import type {BitmapInspection} from '../src/shared/mapAnalytics';
const codec=createProtoCodec(protobuf);
test('fixed band segments and local index identity survive appended heights',async()=>{
    const records=[encodeSizes(0,[1,2]),encodeSizes(1,[1]),encodeSizes(2016,[2])];
    const first=await buildParcelSegments(records.slice(0,2),-1,2,123,128,256),next=await buildParcelSegments(records,-1,2,123,128,256);
    expect(next.slice(0,first.length).map(p=>p.descriptor.sha256)).toEqual(first.map(p=>p.descriptor.sha256));expect(next.every(p=>Math.floor(p.descriptor.first/2016)===Math.floor(p.descriptor.last/2016))).toBe(true);
    const chunk={x:-1,y:2,records:2,lastHeight:1,recordDigest:'1'.repeat(64),packs:first.map(p=>({...p.descriptor,url:p.descriptor.sha256+'.pb'}))};
    const manifest={format:HUFFMAN_FORMAT,indexPageSide:8,publishedHeight:2015} as ProtoManifest;
    expect(codec.encodeIndexPage([chunk],-1,0,manifest)).toEqual(codec.encodeIndexPage([chunk],-1,0,{...manifest,publishedHeight:4031}));expect(signedCell(-42,17)).toBe('x-0042_y+0017');expect(signedCell(-10000,0)).toBe('x-10000_y+0000');
});
test('local metrics exclude global recurrence and reproduce exact scalar and class values',()=>{
    const row={id:0,width:3,height:4,count:3,meanSize:2,composition:1/3,diversity:1,occupancy:.5,pattern:0,occurrences:7,histogram:[1,2,0,0,0,0,0,0,0]} satisfies BitmapInspection;
    // Independent wire bytes: version 1, region 0, one count=3, diversity=1,
    // occupancy=.5 and nine class counts. Unknown fields are not needed.
    const wire=Uint8Array.of(8,1,16,0,26,1,3,34,4,0,0,128,63,42,4,0,0,0,63,50,9,1,2,0,0,0,0,0,0,0);
    expect([...decodeSpatialMetricPage(wire,0,1).count]).toEqual([3]);
    const bytes=encodeSpatialMetricPage(0,[row]);expect(encodeSpatialMetricPage(0,[{...row,occurrences:900}])).toEqual(bytes);
    const page=decodeSpatialMetricPage(bytes,0,1);expect([...page.count]).toEqual([3]);expect([...page.classes]).toEqual(row.histogram);expect(()=>decodeSpatialMetricPage(bytes,1,1)).toThrow('coverage');
});
test('release IDs include addons; exclusive publication, retries and retained old roots never overwrite bytes',async()=>{
    const temp=await mkdtemp('/tmp/map-release-');
    try{
        const source=resolve(temp,'source'),store=resolve(temp,'store');await mkdir(source);await mkdir(resolve(source,'geometry'));await mkdir(resolve(source,'dimensions'));await mkdir(resolve(source,'parcel-index'));
        const put=async(kind:string,bytes:Uint8Array)=>{const hash=await sha256(bytes),url=`${kind}/${hash}.pb`;await writeFile(resolve(source,url),bytes);return{url,sha256:hash,bytes:bytes.length};};
        const geometry=await put('geometry',Uint8Array.of(1)),dimensions=await put('dimensions',Uint8Array.of(2)),page=await put('parcel-index',Uint8Array.of(3));
        const manifest={format:HUFFMAN_FORMAT,storageLayout:DATA_STORAGE,layout:LAYOUT,snapshot:'',publishedHeight:2015,grid:{size:1024,originX:0,originY:0,ownership:'top-left'},packBytes:1024,frameBytes:128,shuffleSeed:1,regions:[{id:0,width:10,height:10,x:0,y:0,geometry,descriptor:geometry,dimensions,coverage:'complete'}],parcelRegions:[0],chunks:[],indexPageSide:8,indexPages:[{...page,x:0,y:0,records:2016,chunks:1}]} as ProtoManifest;
        await mkdir(resolve(source,'parcels'));
        const builds=await buildParcelSegments(Array.from({length:2016},(_,id)=>encodeSizes(id,[1])),0,0,1,128,65536),packs=[];
        for(const built of builds)packs.push({...built.descriptor,...await put('parcels',built.wire)});
        const chunk={x:0,y:0,records:2016,lastHeight:2015,recordDigest:'0'.repeat(64),packs};
        const indexBytes=codec.encodeIndexPage([chunk],0,0,manifest),index=await put('parcel-index',indexBytes);manifest.indexPages=[{...index,x:0,y:0,records:2016,chunks:1}];
        await rm(resolve(source,page.url));
        await writeFile(resolve(source,'manifest.json'),await encodeJsonManifest(manifest));
        await writeFile(resolve(source,'addon.json'),'one');
        const first=await publishRelease(source,store),firstBytes=await readFile(resolve(store,first));
        expect(await publishRelease(source,store)).toBe(first);
        const old=await decodeRelease(firstBytes,first.split('/')[1].slice(0,64));
        await writeFile(resolve(source,'addon.json'),'two');const next=await publishRelease(source,store);expect(next).not.toBe(first);expect(await Bun.file(resolve(store,'addon.json')).text()).toBe('one');
        expect(await readFile(resolve(store,first))).toEqual(firstBytes);expect(await Bun.file(resolve(store,old.roots['addon.json'].url)).text()).toBe('one');
        const savedFetch=globalThis.fetch,savedLocation=Object.getOwnPropertyDescriptor(globalThis,'location'),savedDocument=Object.getOwnPropertyDescriptor(globalThis,'document');
        let selected=first;const clients:StaticHttpDataSource[]=[];
        Object.defineProperty(globalThis,'location',{value:{href:'https://release.test/'},configurable:true});
        Object.defineProperty(globalThis,'document',{value:{querySelector:()=>({getAttribute:()=>selected})},configurable:true});
        globalThis.fetch=(async(input:RequestInfo|URL)=>{try{return new Response(await readFile(resolve(store,new URL(String(input)).pathname.slice('/map-data/'.length))));}catch{return new Response(null,{status:404});}}) as unknown as typeof fetch;
        try{
            const previous=new StaticHttpDataSource('https://release.test/map-data/','manifest.json');clients.push(previous);await previous.getManifest();
            selected=next;const current=new StaticHttpDataSource('https://release.test/map-data/','manifest.json');clients.push(current);const currentManifest=await current.getManifest() as ProtoManifest;
            const file=(ref:typeof geometry)=>(current as unknown as {file:(ref:typeof geometry)=>Promise<Uint8Array>}).file(ref);
            expect([...await file(currentManifest.regions[0].geometry)]).toEqual([1]);expect([...await file(currentManifest.regions[0].geometry)]).toEqual([1]);
            expect(current.downloads.some(entry=>entry.cache==='memory')).toBe(true);
            const loadNeighborhood=current.getNeighborhood,rate=new DownloadError('Rate limited index',429,12000);
            current.getNeighborhood=async()=>{throw rate;};
            const jobs=await current.getParcelJobs([0]);expect(jobs[0].failure).toBe(rate);
            await expect(current.streamParcelJob(jobs[0],new AbortController().signal).next()).rejects.toBe(rate);
            current.getNeighborhood=loadNeighborhood;
            const root=(client:StaticHttpDataSource)=>(client as unknown as {small:(path:string,limit:number)=>Promise<Uint8Array>}).small('addon.json',32);
            expect(new TextDecoder().decode(await root(previous))).toBe('one');expect(new TextDecoder().decode(await root(current))).toBe('two');
        }finally{
            clients.forEach(client=>client.close());globalThis.fetch=savedFetch;
            if(savedLocation)Object.defineProperty(globalThis,'location',savedLocation);else Reflect.deleteProperty(globalThis,'location');
            if(savedDocument)Object.defineProperty(globalThis,'document',savedDocument);else Reflect.deleteProperty(globalThis,'document');
        }

        const conflict=resolve(temp,'exclusive');await appendFile(conflict,'releases/example.json',Uint8Array.of(1));await appendFile(conflict,'releases/example.json',Uint8Array.of(1));await expect(appendFile(conflict,'releases/example.json',Uint8Array.of(2))).rejects.toThrow('conflict');
        expect([...await readFile(resolve(conflict,'releases/example.json'))]).toEqual([1]);
    }finally{await rm(temp,{recursive:true,force:true});}
});
