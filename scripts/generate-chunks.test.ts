import { test, expect } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { generateChunks } from './generate-chunks';
import { buildGroupedPack, encodeSizes, sha256, GROUP_FORMAT, CHUNK_FORMAT, LAYOUT, chunkAt, parsePack } from '../src/shared/httpPack';
const require = createRequire(new URL('../package.json', import.meta.url));
const type = require('protobufjs').Root.fromJSON(require('./src/shared/proto/neighborhood_descriptor.json')).lookupType('Neighborhood');
const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value) + '\n');
async function fixture(root: string, count: number, mutate = false) {
    await fs.mkdir(root);
    async function put(bytes: Uint8Array, ext: string) { const hash = await sha256(bytes), url = hash + '.' + ext; await Bun.write(path.join(root, url), bytes); return { sha256: hash, url, bytes: bytes.length }; }
    const regions = [];
    for (let id = 0; id < count; id++) {
        const geometry = await put(type.encode({ neighborhood: id, width: 64, height: 32, bitmaps: Array.from({ length: 2016 }, (_, i) => ({ x: i % 64, y: Math.floor(i / 64), width: i === 31 ? 32 : 1, height: 1 })) }).finish(), 'pb');
        const records = Array.from({ length: 2016 }, (_, i) => encodeSizes(id * 2016 + i, [mutate && id === 0 && i === 0 ? 2 : 1]));
        const built = await buildGroupedPack(records), pack = { ...built.descriptor, ...await put(built.wire, 'bin') };
        const descriptor = await put(json({ format: GROUP_FORMAT, id, geometry, coverage: 'complete', packs: [pack] }), 'json');
        regions.push({ id, width: 64, height: 32, descriptor });
    }
    const body = { format: GROUP_FORMAT, layout: LAYOUT, publishedHeight: count * 2016 - 1, regions, parcelRegions: regions.map(r => r.id) };
    const snapshot = await sha256(json(body));
    await Bun.write(path.join(root, 'manifest.json'), json({ ...body, snapshot }));
    await Bun.write(path.join(root, 'report.json'), json({ status: 'passed', snapshot, sample: false }));
}
async function inspect(root: string) {
    const manifest = await Bun.file(path.join(root, 'manifest.json')).json(), chunks = new Map<string, any>(), owners = new Map<number, string>();
    for (const region of manifest.regions) {
        const desc = await Bun.file(path.join(root, region.descriptor.url)).json();
        desc.bitmapChunks.forEach((index: number, i: number) => { const c = desc.chunks[index]; owners.set(region.id * 2016 + i, `${c.x},${c.y}`); });
        for (const c of desc.chunks) if (!chunks.has(`${c.x},${c.y}`)) {
            const data = await Bun.file(path.join(root, c.descriptor.url)).json();
            const packs = await Promise.all(data.packs.map((p: any) => Bun.file(path.join(root, p.url)).json()));
            chunks.set(`${c.x},${c.y}`, { ...data, packs });
        }
    }
    return { manifest, chunks, owners };
}
test('top-left ownership uses half-open bounds, including negative and exact borders', () => {
    expect(chunkAt(0, 0, 16)).toEqual({ x: 0, y: 0 });
    expect(chunkAt(16, -16, 16)).toEqual({ x: 1, y: -1 });
    expect(chunkAt(-0.5, -16.5, 16)).toEqual({ x: -1, y: -2 });
    expect(chunkAt(15.5, 15.5, 16)).toEqual({ x: 0, y: 0 }); // width/height do not change the owner.
});
test('Bun generator reuses snapshots, appends existing chunk tails, creates new cells and rejects history changes', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'explorer-chunks-'));
    try {
        const first = path.join(tmp, 'source1'), next = path.join(tmp, 'source2');
        await fixture(first, 1); await fixture(next, 3);
        const a = path.join(tmp, 'a'), b = path.join(tmp, 'b'), c = path.join(tmp, 'c');
        const options = { format: 'v3' as const, chunkSize: 64, packBytes: 1024 };
        const initial = await generateChunks({ source: first, out: a, ...options });
        const unchanged = await generateChunks({ source: first, out: b, previous: a, ...options });
        expect(unchanged.snapshot).toBe(initial.snapshot); expect(unchanged.written).toBe(0); expect(unchanged.reused).toBeGreaterThan(0);
        const updated = await generateChunks({ source: next, out: c, previous: a, ...options });
        expect(updated.records).toBe(6048); expect(updated.reused).toBeGreaterThan(0);
        const old = await inspect(a), now = await inspect(c);
        expect(now.chunks.size).toBeGreaterThan(old.chunks.size);
        expect(old.owners.get(31)).toBe('-1,-1'); // x0=-1, width=32: center is in the next cell.
        for (const [id, owner] of old.owners) expect(now.owners.get(id)).toBe(owner);
        let grew = false, reusedSealed = false;
        for (const [key, chunk] of old.chunks) {
            const current = now.chunks.get(key);
            if (current.records > chunk.records) grew = true;
            for (let i = 0; i < chunk.packs.length - 1; i++) { expect(current.packs[i].sha256).toBe(chunk.packs[i].sha256); reusedSealed = true; }
        }
        expect(grew).toBe(true); expect(reusedSealed).toBe(true);
        const ids = new Set();
        for (const [key, chunk] of now.chunks) for (const pack of chunk.packs) {
            const wire = new Uint8Array(await Bun.file(path.join(c, pack.url)).arrayBuffer());
            async function* bytes() { yield wire; }
            for await (const record of parsePack(bytes(), pack)) { expect(ids.has(record.id)).toBe(false); expect(now.owners.get(record.id)).toBe(key); ids.add(record.id); }
        }
        expect(ids.size).toBe(6048); expect(now.manifest.format).toBe(CHUNK_FORMAT);
        await expect(generateChunks({ source: next, out: path.join(tmp, 'wrong-grid'), previous: a, format: 'v3', chunkSize: 128, packBytes: 1024 })).rejects.toThrow('settings differ');
        const mutated = path.join(tmp, 'mutated'); await fixture(mutated, 3, true);
        const rejected = path.join(tmp, 'rejected');
        await expect(generateChunks({ source: mutated, out: rejected, previous: a, ...options })).rejects.toThrow('payload/ownership changed');
        expect(await Bun.file(path.join(rejected, 'manifest.json')).exists()).toBe(false);
    } finally { await fs.rm(tmp, { recursive: true, force: true }); }
}, 30000);

for(const format of ['v4','v5','v6'] as const) test(`${format} generator publishes only protobuf data, preserves geometry and supports append-only reuse`,async()=>{
    const {createProtoCodec}=await import('../src/shared/protobufChunks');
    const codec=createProtoCodec(require('protobufjs'));
    const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'explorer-protobuf-'));
    try{
        const source=path.join(tmp,'source'),next=path.join(tmp,'next'),a=path.join(tmp,'a'),b=path.join(tmp,'b'),c=path.join(tmp,'c');
        await fixture(source,1);await fixture(next,3);
        const settings={format,chunkSize:64,packBytes:1024};
        const initial=await generateChunks({source,out:a,...settings});
        const unchanged=await generateChunks({source,out:b,previous:a,...settings});
        expect(unchanged.snapshot).toBe(initial.snapshot);expect(unchanged.written).toBe(0);expect(unchanged.reused).toBeGreaterThan(0);
        const updated=await generateChunks({source:next,out:c,previous:a,...settings});expect(updated.records).toBe(6048);expect(updated.reused).toBeGreaterThan(0);
        expect((await fs.readdir(c)).every(f=>f.endsWith('.pb')||f==='report.json')).toBe(true);
        const read=async(root:string)=>codec.decodeManifest(new Uint8Array(await Bun.file(path.join(root,'manifest.pb')).arrayBuffer()));
        const before=await read(a),after=await read(c);expect(after.regions[0].geometry.sha256).toBe(before.regions[0].geometry.sha256);
        const ids=new Set<number>();
        let shuffledChunk=false;
        for(const chunk of after.chunks)for(const pack of chunk.packs){
            const data=new Uint8Array(await Bun.file(path.join(c,pack.url)).arrayBuffer());
            async function* bytes(){yield data;}
            for await(const record of codec.parsePack(bytes(),pack)){expect(ids.has(record.id)).toBe(false);ids.add(record.id);}
        }
        expect(ids.size).toBe(6048);
        if(format==='v6'){
            const {chunkShuffleOrder}=await import('../src/shared/chunkShuffle');
            for(const chunk of after.chunks){
                const actual:number[]=[];
                for(const pack of chunk.packs){
                    const data=new Uint8Array(await Bun.file(path.join(c,pack.url)).arrayBuffer());
                    async function* bytes(){yield data;}
                    for await(const r of codec.parsePack(bytes(),pack))actual.push(r.id);
                }
                const canonical=[...actual].sort((a,b)=>a-b);
                expect(actual).toEqual([...chunkShuffleOrder(actual.length,after.shuffleSeed!,chunk.x,chunk.y)].map(i=>canonical[i]));
                if(chunk.packs.length>1&&chunk.packs[0].ids!.some(id=>id>canonical[Math.floor(canonical.length/2)]))shuffledChunk=true;
            }
            expect(shuffledChunk).toBe(true); // Shuffle precedes pack partition, not just each pack.
            await expect(generateChunks({source:next,out:path.join(tmp,'wrong-seed'),previous:a,...settings,seed:1})).rejects.toThrow('seed differs');
        }
        const bad=path.join(tmp,'bad');await fixture(bad,3,true);
        await expect(generateChunks({source:bad,out:path.join(tmp,'rejected'),previous:a,...settings})).rejects.toThrow('payload/ownership changed');
        expect(await Bun.file(path.join(tmp,'rejected','manifest.pb')).exists()).toBe(false);
    }finally{await fs.rm(tmp,{recursive:true,force:true});}
},30000);
