import test from 'node:test';
import assert from 'node:assert/strict';
import {loadShared} from './helpers/load-shared.ts';
const {selectDetailRegions}=await loadShared('../../src/shared/detailSelection.ts');

test('pan keeps visible detail even when another region becomes nearer the camera',()=>{
 const previous=new Set(Array.from({length:24},(_,i)=>i));
 const reordered=[24,25,...[...previous].reverse()];
 assert.deepEqual(selectDetailRegions(reordered,previous),previous);
});
test('only newly vacant detail slots are filled; the 24-region budget never grows',()=>{
 const previous=new Set(Array.from({length:24},(_,i)=>i));
 const visible=[25,24,...[...previous].filter(n=>n!==3&&n!==7).reverse()];
 const selected=selectDetailRegions(visible,previous);
 assert.equal(selected.size,24);assert(selected.has(25)&&selected.has(24));
 for(const id of previous)assert.equal(selected.has(id),id!==3&&id!==7);
 assert.equal(selectDetailRegions([],selected).size,0);
 assert.deepEqual([...selectDetailRegions([4,4,3,2],new Set(),2)],[4,3]);
});
