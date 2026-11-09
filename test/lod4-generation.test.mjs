import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fixture } from './neighborhood-dimensions-fixture.mjs';
import { generateLod4, validateLod4Bundle } from '../scripts/generate-lod4.ts';

test('LOD4 generation is deterministic, validates canonical memberships and never overwrites its source or output', async()=>{
    const directory=await fs.mkdtemp(path.join(os.tmpdir(),'bitmap-lod4-'));
    try {
        const f=await fixture(),source=path.join(directory,'source'),out=path.join(directory,'lod4'),other=path.join(directory,'repeat');
        await fs.mkdir(source);
        for(const [name,bytes] of f.files)await fs.writeFile(path.join(source,name),bytes);
        const report=await generateLod4(source,out),repeat=await generateLod4(source,other);
        assert.equal(report.bitmaps,2016);assert.equal(report.regions,1);assert.equal(report.cells,256);
        assert.deepEqual(report,repeat);
        assert.deepEqual(await fs.readFile(path.join(out,'lod4.pb')),await fs.readFile(path.join(other,'lod4.pb')));
        const validated=await validateLod4Bundle(out,source);assert.equal(validated.index.bitmapCount,2016);
        await assert.rejects(generateLod4(source,out),/EEXIST/);
        await assert.rejects(generateLod4(source,path.join(source,'lod4')),/separate/);
        await fs.symlink(source,path.join(directory,'alias'));
        await assert.rejects(generateLod4(source,path.join(directory,'alias','new','lod4')),/separate/);
        await assert.rejects(fs.access(path.join(source,'new')),{code:'ENOENT'});
        const ref=validated.index.regions[0],file=path.join(out,'regions',ref.sha256+'.pb'),bytes=await fs.readFile(file);
        bytes[bytes.length-1]^=1;await fs.writeFile(file,bytes);
        await assert.rejects(validateLod4Bundle(out,source),/integrity/);
        await fs.unlink(file);await fs.symlink(path.join(other,'regions',ref.sha256+'.pb'),file);
        await assert.rejects(validateLod4Bundle(out,source),/escapes/);
        for(const [name,bytes] of f.files)assert.deepEqual(new Uint8Array(await fs.readFile(path.join(source,name))),new Uint8Array(bytes));
    } finally {await fs.rm(directory,{recursive:true,force:true});}
});
