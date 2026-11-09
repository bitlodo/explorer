import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomFillSync} from 'node:crypto';
import {loadShared} from './helpers/load-shared.ts';
const {frameHash}=await loadShared('../../src/data/frameHash.ts');
test('fast tiny-frame SHA-256 matches the native oracle at block, threshold and view-offset boundaries',async()=>{
    for(const length of [...Array.from({length:257},(_,i)=>i),511,512,1023,4096,16383,16384,16385,65536,1048576]){
        const parent=randomFillSync(new Uint8Array(length+17)),bytes=parent.subarray(9,9+length);
        assert.equal(await frameHash(bytes),createHash('sha256').update(bytes).digest('hex'));
    }
});
