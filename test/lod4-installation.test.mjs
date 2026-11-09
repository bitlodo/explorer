import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fixture} from './neighborhood-dimensions-fixture.mjs';
import {generateLod4} from '../scripts/generate-lod4.ts';
import {installLod4} from '../scripts/install-lod4.ts';

test('installed LOD4 discovery and pages participate in static build validation without changing canonical files',async()=>{
    const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'lod4-install-'));
    try{
        const f=await fixture(),source=path.join(tmp,'source'),bundle=path.join(tmp,'bundle');await fs.mkdir(source);
        for(const [name,bytes] of f.files)await fs.writeFile(path.join(source,name),bytes);
        await fs.writeFile(path.join(source,'report.json'),JSON.stringify({status:'passed',snapshot:f.manifest.snapshot,sample:false}));
        await generateLod4(source,bundle);const discovery=await installLod4(bundle,source);await installLod4(bundle,source);
        assert.deepEqual(JSON.parse(await fs.readFile(path.join(source,'lod4.json'),'utf8')),discovery);
        const run=()=>spawnSync(process.execPath,['scripts/tools/prepare-pages.ts',source,path.join(tmp,'app'),path.join(tmp,'site'),'--validate-only'],{encoding:'utf8',maxBuffer:1024*1024});
        const valid=run();assert.equal(valid.status,0,valid.stderr);
        for(const [name,bytes] of f.files)assert.deepEqual(new Uint8Array(await fs.readFile(path.join(source,name))),new Uint8Array(bytes));
        const page=path.join(source,'lod4','regions',(await fs.readdir(path.join(source,'lod4','regions')))[0]);
        const damaged=await fs.readFile(page);damaged[0]^=1;await fs.writeFile(page,damaged);
        const corrupt=run();assert.notEqual(corrupt.status,0);assert.match(corrupt.stderr,/integrity/);
    }finally{await fs.rm(tmp,{recursive:true,force:true});}
});
