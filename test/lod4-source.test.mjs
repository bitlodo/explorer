import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './neighborhood-dimensions-fixture.mjs';
import StaticHttpDataSource from '../src/data/StaticHttpDataSource.ts';
import { buildLod4Region,encodeLod4Index,encodeLod4Region,LOD4_FORMAT } from '../src/shared/lod4.ts';
import { sha256 } from '../src/shared/httpPack.ts';

test('HTTP LOD4 discovery is optional, snapshot-pinned and page bytes are authenticated and cached',async()=>{
    const f=await fixture(),page=encodeLod4Region(buildLod4Region(f.data,f.manifest.regions[0].geometry.sha256));
    const hash=await sha256(page),index={version:1,format:LOD4_FORMAT,sourceSnapshot:f.manifest.snapshot,gridSide:16,bitmapCount:2016,
        regions:[{id:0,width:f.data.width,height:f.data.height,bitmapCount:2016,geometrySha256:f.manifest.regions[0].geometry.sha256,sha256:hash,bytes:page.length}]};
    const root=encodeLod4Index(index),rootHash=await sha256(root);
    const files=new Map(f.files);files.set('lod4.json',new TextEncoder().encode(JSON.stringify({format:LOD4_FORMAT,sourceSnapshot:f.manifest.snapshot,index:{url:`lod4/${rootHash}.pb`,sha256:rootHash,bytes:root.length}})));
    files.set(`lod4/${rootHash}.pb`,root);files.set(`lod4/regions/${hash}.pb`,page);
    const requests=[],fetchBefore=globalThis.fetch,locationBefore=Object.getOwnPropertyDescriptor(globalThis,'location');
    Object.defineProperty(globalThis,'location',{value:new URL('http://lod4.test/'),configurable:true});
    globalThis.fetch=async(url)=>{const path=new URL(url).pathname.slice('/data/'.length);requests.push(path);return files.has(path)?new Response(files.get(path),{status:200}):new Response('missing',{status:404});};
    let source;
    try{
        source=new StaticHttpDataSource('http://lod4.test/data/','manifest.pb','server');
        const loaded=await source.getLod4Index();assert.ok(loaded);assert.equal(await source.getLod4Index(),loaded);
        const first=await source.getLod4Region(loaded,0,new AbortController().signal);assert.equal(first.bitmapAreas.length,2016);
        await source.getLod4Region(loaded,0,new AbortController().signal);
        assert.equal(requests.filter(p=>p==='lod4.json').length,1);assert.equal(requests.filter(p=>p===`lod4/regions/${hash}.pb`).length,1);
        source.close();files.delete('lod4.json');source=new StaticHttpDataSource('http://lod4.test/data/','manifest.pb','server');
        assert.equal(await source.getLod4Index(),undefined);assert.equal(await source.getLod4Index(),undefined);source.close();
        files.set('lod4.json',new TextEncoder().encode(JSON.stringify({format:LOD4_FORMAT,sourceSnapshot:'f'.repeat(64),index:{url:`lod4/${rootHash}.pb`,sha256:rootHash,bytes:root.length}})));
        source=new StaticHttpDataSource('http://lod4.test/data/','manifest.pb','server');await assert.rejects(source.getLod4Index(),/snapshot/);
    }finally{source?.close();globalThis.fetch=fetchBefore;if(locationBefore)Object.defineProperty(globalThis,'location',locationBefore);else delete globalThis.location;}
});
