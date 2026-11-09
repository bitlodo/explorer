import test from 'node:test';
import assert from 'node:assert/strict';
import {validateGrid,validateRoundTrip,validatePayloadBounds} from '../scripts/tools/export-validation.ts';
import {loadShared} from './helpers/load-shared.ts';
const {encodeSizes,decodeSizes}=await loadShared('../../src/shared/httpPack.ts');

test('grid validation requires every explicit ID and exact canonical dimensions',()=>{
    const rectangles=Array.from({length:2016},()=>({width:5,height:10}));
    const rows=rectangles.map((r,i)=>({bitmap:22*2016+i,...r}));
    validateGrid(rows,22,rectangles);
    assert.throws(()=>validateGrid(rows.slice(1),22,rectangles),/Missing/);
    assert.throws(()=>validateGrid(rows.map((r,i)=>i===1?{...r,bitmap:r.bitmap+1}:r),22,rectangles),/mismatch/);
    assert.throws(()=>validateGrid(rows.map((r,i)=>i===1?{...r,width:6}:r),22,rectangles),/mismatch/);
});
test('transport validation checks the value at every transaction index and canonical area bounds',()=>{
    for(const tx of [[10,1,15],Array(50).fill(5),[1]])validateRoundTrip(encodeSizes(0,tx),tx,decodeSizes);
    const record=encodeSizes(22,[1,2,3]);
    assert.throws(()=>validateRoundTrip(record,[1,3,2],decodeSizes),/order/);
    assert.throws(()=>validateRoundTrip(record,[1,2],decodeSizes),/count/);
    validatePayloadBounds([5,5],{width:5,height:10},170);
    assert.throws(()=>validatePayloadBounds([6],{width:5,height:10},170),/exceeds/);
    assert.throws(()=>validatePayloadBounds([5,5,5],{width:5,height:10},170),/area/);
    assert.throws(()=>validatePayloadBounds([],{width:5,height:10},170),/area/);
});
