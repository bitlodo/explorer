import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {loadShared} from './helpers/load-shared.ts';
const require=createRequire(new URL('../package.json',import.meta.url)),protobuf=require('protobufjs');
const {createProtoCodec,PROTO_FORMAT}=await loadShared('../../src/shared/protobufChunks.ts');
const {encodeSizes,decodeSizes,sha256}=await loadShared('../../src/shared/httpPack.ts');
const codec=createProtoCodec(protobuf);
const collect=async stream=>{const items=[];for await(const item of stream)items.push(item);return items;};
async function* split(bytes,cut){yield bytes.slice(0,cut);yield bytes.slice(cut);}

test('the active v9 schema matches its descriptor and preserves v4 streaming across every cut',async()=>{
    const schema=protobuf.parse(fs.readFileSync(new URL('../src/shared/proto/map_snapshot.proto',import.meta.url),'utf8')).root.toJSON();
    assert.deepEqual(schema,JSON.parse(fs.readFileSync(new URL('../src/shared/proto/map_snapshot_descriptor.json',import.meta.url))));
    const input=[encodeSizes(0,[]),encodeSizes(2,[1]),encodeSizes(2016,[15,10,1]),encodeSizes(900000,Array(50).fill(5))];
    const built=await codec.buildPack(input,-1,2,13);assert.equal(built.descriptor.format,PROTO_FORMAT);
    for(let cut=0;cut<=built.wire.length;cut++)assert.deepEqual(await collect(codec.parsePack(split(built.wire,cut),built.descriptor)),input);
    assert.deepEqual((await collect(codec.parsePack(split(built.wire,1),built.descriptor))).map(decodeSizes),input.map(decodeSizes));
    await assert.rejects(()=>codec.buildPack([input[1],input[0]],-1,2),/increasing/);
    await assert.rejects(()=>codec.buildPack([input[1],input[1]],-1,2),/increasing/);
});
test('v4 rejects corruption, truncation, trailing bytes, count/identity/encoding and length corruption',async()=>{
    const built=await codec.buildPack([encodeSizes(0,[1]),encodeSizes(10,[5])],-1,0,64);
    const {wire,descriptor}=built;
    for(let cut=0;cut<wire.length;cut++)await assert.rejects(()=>collect(codec.parsePack(split(wire.slice(0,cut),1),descriptor)));
    const extra=new Uint8Array(wire.length+1);extra.set(wire);await assert.rejects(()=>collect(codec.parsePack(split(extra,1),descriptor)),/trailing/);
    const bad=wire.slice();bad[bad.length-1]^=1;await assert.rejects(()=>collect(codec.parsePack(split(bad,1),descriptor)),/Corrupt/);
    for(const changed of [{chunkX:1},{records:3},{parcels:8},{first:1}])await assert.rejects(()=>collect(codec.parsePack(split(wire,1),{...descriptor,...changed})));
    const root=protobuf.parse(fs.readFileSync(new URL('../src/shared/proto/map_snapshot.proto',import.meta.url),'utf8')).root;
    const Header=root.lookupType('bitmap.snapshot.PackHeader'),Bitmap=root.lookupType('bitmap.snapshot.Bitmap'),Frame=root.lookupType('bitmap.snapshot.Frame');
    const concat=parts=>new Uint8Array(Buffer.concat(parts));
    for(const payload of [
        concat([Header.encodeDelimited({version:4,chunkX:-1,chunkY:0,records:1,first:0,last:0}).finish(),Bitmap.encodeDelimited({id:0,txCount:1,encoding:9,tx:new Uint8Array([0x10])}).finish()]),
        new Uint8Array([255,255,255,255,255,255]),
    ]){
        const bytes=Frame.encodeDelimited({index:0,payload}).finish(),hash=await sha256(bytes);
        await assert.rejects(()=>collect(codec.parsePack(split(bytes,1),{...descriptor,records:1,first:0,last:0,parcels:1,bytes:bytes.length,sha256:hash,frames:[{bytes:bytes.length,sha256:hash}]})));
    }
});
test('a complete protobuf bitmap is available before a later frame and EOF',async()=>{
    const input=[encodeSizes(0,[1]),encodeSizes(10,Array.from({length:1000},(_,i)=>i%15+1))];
    const {wire,descriptor}=await codec.buildPack(input,0,0,64);
    let release;const gate=new Promise(r=>release=r);let finished=false;
    async function* slow(){yield wire.slice(0,descriptor.frames[0].bytes);await gate;yield wire.slice(descriptor.frames[0].bytes);finished=true;}
    const iterator=codec.parsePack(slow(),descriptor);
    assert.equal((await iterator.next()).value.id,0);assert.equal(finished,false);
    release();assert.equal((await iterator.next()).value.id,10);assert.equal((await iterator.next()).done,true);
});


test('v5 emits the first bitmap of tiny and large files while the remaining record is withheld',async()=>{
    const {CHAIN_FORMAT}=await loadShared('../../src/shared/protobufChunks.ts');
    for(const sizes of [[1],Array.from({length:1000},(_,i)=>i%15+1),Array.from({length:40000},(_,i)=>i%15+1)]){
        const input=[encodeSizes(0,[1]),encodeSizes(100,sizes)],built=await codec.buildChainedPack(input,-1,0,1024);
        assert.equal(built.descriptor.format,CHAIN_FORMAT);
        const frames=[];const reader=protobuf.Reader.create(built.wire);
        while(reader.pos<built.wire.length){const start=reader.pos,n=reader.uint32();reader.pos+=n;frames.push(built.wire.slice(start,reader.pos));}
        let release;const gate=new Promise(r=>release=r);let ended=false;
        async function* slow(){yield frames[0];yield frames[1];await gate;for(const f of frames.slice(2))yield f;ended=true;}
        const iterator=codec.parsePack(slow(),built.descriptor);
        assert.equal((await iterator.next()).value.id,0);assert.equal(ended,false);
        assert.ok(frames[0].length+frames[1].length<built.wire.length);
        release();assert.equal((await iterator.next()).value.id,100);assert.equal((await iterator.next()).done,true);
        const corrupt=built.wire.slice();corrupt[corrupt.length-1]^=1;
        await assert.rejects(()=>collect(codec.parsePack(split(corrupt,1),built.descriptor)),/Corrupt/);
        await assert.rejects(()=>collect(codec.parsePack(split(built.wire.slice(0,-1),1),built.descriptor)));
        await assert.rejects(()=>collect(codec.parsePack(split(built.wire,1),{...built.descriptor,headSha256:'0'.repeat(64)})),/Corrupt/);
    }
});
