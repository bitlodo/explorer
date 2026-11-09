import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadShared } from './helpers/load-shared.ts';
const { encodeSizes, decodeSizes, buildPack, parsePack, sha256, LIMITS } = await loadShared('../../src/shared/httpPack.ts');
async function* chunks(bytes, cuts = []) { let offset = 0; for (const end of [...cuts, bytes.length]) { yield bytes.subarray(offset,end); offset=end; } }
const collect = async iterable => { const result=[]; for await(const item of iterable) result.push(item); return result; };
test('raw4/rle4 preserve every transaction including empty/odd padding/10/15 and runs >15', async () => {
    for(const tx of [[],[1],[10],[15,10,9,1,2],Array(47).fill(10),[1,2,1,2,1]]) {
        const record=encodeSizes(0,tx); assert.deepEqual(decodeSizes(record),tx);
        const {wire,descriptor}=await buildPack([record],0,0,7);
        assert.deepEqual((await collect(parsePack(chunks(wire),descriptor))).map(decodeSizes),[tx]);
    }
    for(const tx of [[0],[16],[-1],[1.2]]) assert.throws(()=>encodeSizes(0,tx));
    assert.throws(()=>decodeSizes({txCount:1,rle:false,tx:new Uint8Array([0x11])}));
    assert.throws(()=>decodeSizes({txCount:1,rle:true,tx:new Uint8Array([0x10])}));
    assert.throws(()=>decodeSizes({txCount:LIMITS.tx+1,rle:false,tx:new Uint8Array()}));
});
test('every network cut and one-byte chunks, records spanning verified frames', async()=>{
    const input=[encodeSizes(2,[10,1,15]),encodeSizes(0,[]),encodeSizes(1,Array(51).fill(2))];
    const {wire,descriptor}=await buildPack(input,0,0,17);
    for(let cut=0;cut<=wire.length;cut++) assert.deepEqual(await collect(parsePack(chunks(wire,[cut]),descriptor)),input);
    assert.deepEqual(await collect(parsePack(chunks(wire,Array.from({length:wire.length},(_,i)=>i)),descriptor)),input);
});
test('corruption, trailing/truncated data, lengths, versions, coverage, duplicates are rejected',async()=>{
    const {wire,descriptor}=await buildPack([encodeSizes(0,[1]),encodeSizes(1,[2])],0,0,24);
    const corrupt=wire.slice(); corrupt[20]^=1;
    await assert.rejects(()=>collect(parsePack(chunks(corrupt),descriptor)),/Corrupt/);
    for(let cut=0;cut<wire.length;cut++) await assert.rejects(()=>collect(parsePack(chunks(wire.subarray(0,cut)),descriptor)));
    const extra=new Uint8Array(wire.length+1); extra.set(wire); await assert.rejects(()=>collect(parsePack(chunks(extra),descriptor)),/trailing/);
    await assert.rejects(()=>buildPack([encodeSizes(0,[1]),encodeSizes(0,[1])],0,0),/coverage|Duplicate/);
    await assert.rejects(()=>buildPack([encodeSizes(0,[1]),encodeSizes(2,[1])],0,0),/coverage/);
    const forged={...descriptor,parcels:10}; await assert.rejects(()=>collect(parsePack(chunks(wire),forged)),/coverage/);
    const one=await buildPack([encodeSizes(0,[1])],0,0,128);
    const version=one.wire.slice(); version[16]=2; const frames=[{bytes:version.length,sha256:await sha256(version)}];
    await assert.rejects(()=>collect(parsePack(chunks(version),{...one.descriptor,frames})),/version/);
    const length=one.wire.slice(); new DataView(length.buffer).setUint32(32,LIMITS.record+1,true);
    const hash=await sha256(length);
    await assert.rejects(()=>collect(parsePack(chunks(length),{...one.descriptor,frames:[{bytes:length.length,sha256:hash}]})),/record length/);
});
test('a bitmap is yielded while a later verified frame and EOF are still unavailable',async()=>{
    const input=[encodeSizes(0,[1]),encodeSizes(1,Array.from({length:200},(_,i)=>i%15+1))];
    const {wire,descriptor}=await buildPack(input,0,0,48);
    let resume; const gate=new Promise(resolve=>{resume=resolve;}); let ended=false;
    async function* slow() { yield wire.subarray(0,descriptor.frames[0].bytes); await gate; yield wire.subarray(descriptor.frames[0].bytes); ended=true; }
    const iterator=parsePack(slow(),descriptor);
    const first=await iterator.next(); assert.equal(first.value.id,0); assert.equal(ended,false);
    resume(); assert.equal((await iterator.next()).value.id,1); assert.equal((await iterator.next()).done,true);
});

test('known little-endian fixture has fixed bytes/hash independent of network chunking',async()=>{
    const fixture=JSON.parse(fs.readFileSync(new URL('./fixtures/http-pack-v1.json',import.meta.url)));
    const {wire,descriptor}=await buildPack([encodeSizes(0,fixture.sizes)],0,0);
    assert.equal(Buffer.from(wire).toString('hex'),fixture.hex);assert.equal(descriptor.sha256,fixture.sha256);
});

test('v2 crosses neighborhood boundaries, preserves records and rejects v1 interpretation',async()=>{
    const {buildGroupedPack,GROUP_FORMAT}=await loadShared('../../src/shared/httpPack.ts');
    const records=[encodeSizes(2016,[15,10,1]),encodeSizes(2015,Array(32).fill(2))];
    const {wire,descriptor}=await buildGroupedPack(records,17);
    assert.equal(descriptor.format,GROUP_FORMAT);assert.equal(descriptor.first,2015);assert.equal(descriptor.last,2016);
    assert.equal(descriptor.neighborhood,undefined);
    for(let cut=0;cut<=wire.length;cut++) assert.deepEqual(await collect(parsePack(chunks(wire,[cut]),descriptor)),records);
    await assert.rejects(()=>collect(parsePack(chunks(wire),{...descriptor,format:undefined,neighborhood:0,ordinal:0})),/coverage/);
    await assert.rejects(()=>buildGroupedPack([encodeSizes(2015,[1]),encodeSizes(2017,[1])]),/coverage/);
    await assert.rejects(()=>buildGroupedPack([encodeSizes(2016,[1]),encodeSizes(2016,[1])]),/coverage|Duplicate/);
    const unknown={...descriptor,format:'bitmap-http-pack-v999'};await assert.rejects(()=>collect(parsePack(chunks(wire),unknown)),/Unknown/);
});
test('shared pack region index checks clipped coverage and detects missing/duplicate references',async()=>{
    const {buildGroupedPack,GROUP_FORMAT,validateRegionPacks}=await loadShared('../../src/shared/httpPack.ts');
    const {descriptor}=await buildGroupedPack(Array.from({length:4032},(_,id)=>encodeSizes(id,[1])));
    const region=id=>({format:GROUP_FORMAT,id,coverage:'complete',packs:[descriptor]});
    validateRegionPacks(region(0),GROUP_FORMAT);validateRegionPacks(region(1),GROUP_FORMAT);
    assert.throws(()=>validateRegionPacks(region(2),GROUP_FORMAT),/intersect/);
    assert.throws(()=>validateRegionPacks({...region(0),packs:[descriptor,descriptor]},GROUP_FORMAT),/coverage/);
    assert.throws(()=>validateRegionPacks({...region(0),packs:[]},GROUP_FORMAT),/Missing/);
    assert.throws(()=>validateRegionPacks(region(0),'bitmap-http-pack-v1'),/descriptor/);
});

test('v2 has an independent fixed byte/hash fixture across the region boundary',async()=>{
    const {buildGroupedPack}=await loadShared('../../src/shared/httpPack.ts');
    const fixture=JSON.parse(fs.readFileSync(new URL('./fixtures/http-pack-v2.json',import.meta.url)));
    const {wire,descriptor}=await buildGroupedPack(fixture.records.map(({id,sizes})=>encodeSizes(id,sizes)));
    assert.equal(Buffer.from(wire).toString('hex'),fixture.hex);assert.equal(descriptor.sha256,fixture.sha256);
});

test('v3 signed chunk identity and sparse membership are authenticated across arbitrary network cuts',async()=>{
    const {buildChunkPack,CHUNK_FORMAT}=await loadShared('../../src/shared/httpPack.ts');
    const input=[encodeSizes(808415,[15,10,1]),encodeSizes(0,[1]),encodeSizes(2016,[2])];
    const {wire,descriptor}=await buildChunkPack(input,-2,3,17);
    assert.equal(descriptor.format,CHUNK_FORMAT);assert.deepEqual(descriptor.ids,[0,2016,808415]);
    for(let cut=0;cut<=wire.length;cut++) assert.deepEqual(await collect(parsePack(chunks(wire,[cut]),descriptor)),input);
    await assert.rejects(()=>collect(parsePack(chunks(wire),{...descriptor,chunkX:2})),/identity/);
    await assert.rejects(()=>collect(parsePack(chunks(wire),{...descriptor,ids:[0,2017,808415]})),/out-of-range/);
    await assert.rejects(()=>buildChunkPack([input[0],input[0]],-2,3),/duplicate|Duplicate/);
});
