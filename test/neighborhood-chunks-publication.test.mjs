import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fixture} from './neighborhood-dimensions-fixture.mjs';
const run=(script,...args)=>spawnSync(process.execPath,[script,...args],{encoding:'utf8',maxBuffer:1024*1024});
test('offline spatial bitmap chunks preserve the source, refuse overwrite and assemble only verified artifacts',async()=>{
 const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'neighborhood-chunks-publication-'));
 try{
  const f=await fixture(),source=path.join(tmp,'source'),chunks=path.join(tmp,'chunks'),build=path.join(tmp,'build'),site=path.join(tmp,'site');
  await fs.mkdir(source);for(const [name,bytes] of f.files)await fs.writeFile(path.join(source,name),bytes);
  await fs.writeFile(path.join(source,'report.json'),JSON.stringify({status:'passed',snapshot:f.manifest.snapshot,sample:false}));
  await fs.mkdir(path.join(build,'assets'),{recursive:true});await fs.writeFile(path.join(build,'index.html'),'<script src="assets/index.js"></script>');await fs.writeFile(path.join(build,'assets/index.js'),'console.log("fixture")');
  const generated=run('scripts/tools/prepare-neighborhood-chunks.ts',source,chunks);assert.equal(generated.status,0,generated.stderr);
  const report=JSON.parse(await fs.readFile(path.join(chunks,'neighborhood-chunks-report.json'),'utf8'));assert.equal(report.bitmaps,2016);assert.equal(report.size,2048);assert.equal(JSON.parse(await fs.readFile(path.join(chunks,'neighborhood-chunks.json'),'utf8')).gridPolicy,'bitmap-owner-grid-v1-2048');
  const refused=run('scripts/tools/prepare-neighborhood-chunks.ts',source,chunks);assert.notEqual(refused.status,0);assert.match(refused.stderr,/EEXIST/);
  const prepared=run('scripts/tools/prepare-pages.ts',source,build,site,'--neighborhood-chunks='+chunks);assert.equal(prepared.status,0,prepared.stderr);
  assert.deepEqual(await fs.readFile(path.join(site,'map-data','neighborhood-chunks.json')),await fs.readFile(path.join(chunks,'neighborhood-chunks.json')));
  for(const [name,bytes] of f.files)assert.deepEqual(new Uint8Array(await fs.readFile(path.join(source,name))),new Uint8Array(bytes));
  const file=(await fs.readdir(chunks)).find(name=>name.endsWith('.pb')),bytes=await fs.readFile(path.join(chunks,file));bytes[0]^=1;await fs.writeFile(path.join(chunks,file),bytes);
  const corrupt=run('scripts/tools/prepare-pages.ts',source,build,path.join(tmp,'rejected'),'--neighborhood-chunks='+chunks);assert.notEqual(corrupt.status,0);assert.match(corrupt.stderr,/integrity/);
  await assert.rejects(fs.access(path.join(tmp,'rejected')),{code:'ENOENT'});
 }finally{await fs.rm(tmp,{recursive:true,force:true});}
});
