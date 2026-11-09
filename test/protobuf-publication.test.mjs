import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fixture,codec} from './protobuf-fixture.mjs';
import {fixture as dimensionsFixture} from './neighborhood-dimensions-fixture.mjs';
import {fixture as spatialFixture} from './spatial-index-fixture.mjs';
import {loadShared} from './helpers/load-shared.ts';
const {sha256}=await loadShared('../../src/shared/httpPack.ts');

for(const format of ['v4','v5','v6','v7','v8']) test(`${format} publisher validates direct references, canonical positions and coverage; publishes no JSON/bin descriptors`,async()=>{
    const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'proto-publication-'));
    try{
        const {files,manifest,original}=await (format==='v8'?spatialFixture():format==='v7'?dimensionsFixture():fixture(format)),snapshot=path.join(tmp,'snapshot'),build=path.join(tmp,'build');
        await fs.mkdir(snapshot);await fs.mkdir(path.join(build,'assets'),{recursive:true});
        for(const [name,bytes] of files)await fs.writeFile(path.join(snapshot,name),bytes);
        await fs.writeFile(path.join(snapshot,'report.json'),JSON.stringify({status:'passed',snapshot:manifest.snapshot,sample:false}));
        await fs.writeFile(path.join(build,'index.html'),'<script src="assets/index.js"></script>');await fs.writeFile(path.join(build,'assets/index.js'),'void 0');
        const run=name=>spawnSync(process.execPath,['scripts/tools/prepare-pages.ts',snapshot,build,path.join(tmp,name)],{encoding:'utf8'});
        const ok=run('site');assert.equal(ok.status,0,ok.stderr);
        const published=await fs.readdir(path.join(tmp,'site','map-data'));assert.ok(published.every(name=>name.endsWith('.pb')));assert.equal(published.length,files.size);
        const pack=(original||manifest).chunks[0].packs[0],wire=files.get(pack.url);
        await fs.writeFile(path.join(snapshot,pack.url),wire.slice(1));assert.notEqual(run('corrupt').status,0);await fs.writeFile(path.join(snapshot,pack.url),wire);
        manifest.regions[0].x+=1;manifest.snapshot=await sha256(codec.encodeManifest(manifest,false));
        await fs.writeFile(path.join(snapshot,'manifest.pb'),codec.encodeManifest(manifest));await fs.writeFile(path.join(snapshot,'report.json'),JSON.stringify({status:'passed',snapshot:manifest.snapshot,sample:false}));
        const shifted=run('shifted');assert.notEqual(shifted.status,0);assert.match(shifted.stderr,/position differs/);
    }finally{await fs.rm(tmp,{recursive:true,force:true});}
});
