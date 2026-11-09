import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {loadShared} from './helpers/load-shared.ts';
const {FORMAT,LAYOUT,sha256}=await loadShared('../../src/shared/httpPack.ts');
const require=createRequire(new URL('../package.json',import.meta.url)),protobuf=require('protobufjs');
const type=protobuf.Root.fromJSON(JSON.parse(await fs.readFile(new URL('../src/shared/proto/neighborhood_descriptor.json',import.meta.url)))).lookupType('Neighborhood');
const json=value=>Buffer.from(JSON.stringify(value)+'\n');

test('publication verifies sample opt-in, hashes, revision, allowlist, bundle transport and total budget',async()=>{
    const temp=await fs.mkdtemp(path.join(os.tmpdir(),'http-publication-'));
    const source=path.join(temp,'snapshot'),build=path.join(temp,'build');
    await fs.mkdir(source);await fs.mkdir(path.join(build,'assets'),{recursive:true});
    await fs.writeFile(path.join(build,'index.html'),'<script src="/repository/assets/index.js"></script>');
    await fs.writeFile(path.join(build,'assets/index.js'),'void 0');
    await fs.writeFile(path.join(build,'.env'),'private-do-not-publish');
    await fs.writeFile(path.join(build,'database.db'),'private-do-not-publish');
    const file=async(bytes,ext)=>{const hash=await sha256(bytes),url=hash+'.'+ext;await fs.writeFile(path.join(source,url),bytes);return{url,sha256:hash,bytes:bytes.length};};
    const geometry=await file(type.encode({neighborhood:0,width:2016,height:1,bitmaps:Array.from({length:2016},(_,x)=>({x,y:0,width:1,height:1}))}).finish(),'pb');
    const descriptor=await file(json({format:FORMAT,id:0,geometry,coverage:'geometry-only',packs:[]}),'json');
    const body={format:FORMAT,layout:LAYOUT,publishedHeight:2015,parcelRegions:[],regions:[{id:0,width:2016,height:1,descriptor}]};
    const manifest={...body,snapshot:await sha256(json(body))};
    await fs.writeFile(path.join(source,'manifest.json'),json(manifest));
    await fs.writeFile(path.join(source,'report.json'),json({status:'passed',sample:true,snapshot:manifest.snapshot}));
    const run=(name,allow=true)=>spawnSync(process.execPath,['scripts/tools/prepare-pages.ts',source,build,path.join(temp,name),...(allow?['--allow-sample']:[])],{encoding:'utf8'});
    try{
        assert.notEqual(run('no-opt-in',false).status,0);
        const success=run('site');assert.equal(success.status,0,success.stderr);
        assert.deepEqual((await fs.readdir(path.join(temp,'site'))).sort(),['.nojekyll','assets','index.html','map-data']);
        const published=await fs.readdir(path.join(temp,'site/map-data'));assert.ok(!published.includes('report.json'));
        await fs.writeFile(path.join(build,'assets/legacy.js'),'fetch("/api/v1/getBitmap/0")');
        assert.match(run('legacy').stderr,/Legacy transport/);await fs.unlink(path.join(build,'assets/legacy.js'));
        const large=await fs.open(path.join(build,'assets/large.bin'),'w');await large.truncate(1_000_000_001);await large.close();
        assert.match(run('oversized').stderr,/budget/);await fs.unlink(path.join(build,'assets/large.bin'));
        await fs.writeFile(path.join(source,descriptor.url),'corrupted');assert.match(run('corrupt').stderr,/integrity/);
        await fs.writeFile(path.join(source,'manifest.json'),json({...manifest,publishedHeight:0}));assert.match(run('revision').stderr,/revision/);
    }finally{await fs.rm(temp,{recursive:true,force:true});}
});
