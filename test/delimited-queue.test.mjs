import test from 'node:test';
import assert from 'node:assert/strict';
import {loadShared} from './helpers/load-shared.ts';
const {default:Queue}=await loadShared('../../src/shared/DelimitedQueue.ts');
const message=size=>{const prefix=[];let value=size;do{prefix.push((value&127)|(value>127?128:0));value=Math.floor(value/128);}while(value);return Uint8Array.from([...prefix,...Array.from({length:size},(_,i)=>i%251)]);};

test('delimited queue preserves fragmented varints, large payloads and views already returned',()=>{
    const q=new Queue(),first=message(3);q.append(first);const retained=q.next(100000);
    for(const size of [1,127,128,16384,70000]){
        const bytes=message(size);
        for(let i=0;i<bytes.length;i++){q.append(bytes.subarray(i,i+1));if(i<bytes.length-1)assert.equal(q.next(100000),undefined);}
        assert.ok(q.pieces.length<100,'Tiny fragments must be coalesced');
        assert.deepEqual(q.next(100000),bytes);assert.equal(q.length,0);
    }
    assert.deepEqual(retained,first);
});
test('delimited queue consumes consecutive messages across arbitrary boundaries',()=>{
    const input=[message(1),message(257),message(10000)],wire=Uint8Array.from(input.flatMap(x=>[...x]));
    for(const step of [1,7,129,4096,wire.length]){const q=new Queue(),out=[];for(let i=0;i<wire.length;i+=step){q.append(wire.subarray(i,i+step));let record;while((record=q.next(20000)))out.push(record);}assert.deepEqual(out,input);assert.equal(q.length,0);}
});
test('delimited queue rejects invalid lengths and waits for incomplete payloads',()=>{
    for(const bytes of [[0],[128,128,128,128,128],[255,255,255,255,127]]){const q=new Queue();q.append(Uint8Array.from(bytes));assert.throws(()=>q.next(100),/Invalid protobuf/);}
    const q=new Queue();q.append(Uint8Array.of(10,1,2));assert.equal(q.next(100),undefined);assert.equal(q.length,3);
});
