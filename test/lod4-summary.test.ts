import { expect,test } from 'bun:test';
import { buildLod4Region,compactLod4Region } from '../src/shared/lod4';
import { summarizeLod4Cells } from '../src/shared/lod4Summary';
import { parcelClassFilter } from '../src/shared/layerAnalysis';
const page=buildLod4Region({neighborhood:0,width:8,height:4,bitmaps:[{x:0,y:0,width:1,height:4},{x:1,y:0,width:7,height:4}]},'0'.repeat(64),2);
const summary={min:1,max:99,scale:'linear' as const};
test('LOD4 merging preserves equal bitmap weights despite unequal rectangle areas',()=>{
    const metric={kind:'scalar' as const,summary,values:Float32Array.of(1,99),low:1,high:9};
    const full=summarizeLod4Cells(page,metric,2);expect([...full.summaries]).toEqual([5,1]);expect([...full.coverage]).toEqual([1]);
    const selected=summarizeLod4Cells(page,{...metric,low:9,high:9},2);expect([...selected.summaries]).toEqual([9,.5]);
    const cells=summarizeLod4Cells(page,metric,1);
    expect(cells.summaries[0]).toBeCloseTo(1+8*((.5+99*3/14)/(.5+3/14)-1)/98,6);
    expect(cells.summaries[2]).toBe(9);
});
test('LOD4 keeps original-value log means, empty cells and occupied-area parcel weights',()=>{
    const log=summarizeLod4Cells(page,{kind:'scalar',summary:{...summary,scale:'log'},values:Float32Array.of(1,99),low:1,high:9},2);
    expect(log.summaries[0]).toBeCloseTo(1+8*(Math.log1p(50)-Math.log(2))/(Math.log(100)-Math.log(2)),6);
    const parcel=summarizeLod4Cells(page,{kind:'parcel',pixels:Float32Array.of(1,0,9,1),occupiedAreas:Float32Array.of(1,81)},2);
    expect(parcel.summaries[0]).toBe(9);expect(parcel.summaries[1]).toBeCloseTo(81/82,7);
    const sparse=buildLod4Region({neighborhood:0,width:16,height:16,bitmaps:[{x:0,y:0,width:1,height:1}]},'0'.repeat(64),2);
    const out=summarizeLod4Cells(sparse,{kind:'scalar',summary,low:1,high:9});
    expect([...out.coverage]).toEqual([1/64,0,0,0]);expect([...out.summaries]).toEqual([1,1,1,0,1,0,1,0]);
});
test('occupied parcel areas are optional, exact and allocated only on initialization',()=>{
    const counts=new Uint32Array(18);counts[0]=3;counts[8]=2;counts[10]=1;
    const initial=parcelClassFilter(counts,2,1,9,true);expect([...initial.occupiedAreas!]).toEqual([165,4]);
    expect(parcelClassFilter(counts,2,9,9).occupiedAreas).toBeUndefined();
});
test('compact pages preserve analytical weights with independent horizontal and vertical grouping',()=>{
    const compact=compactLod4Region(page),metric={kind:'scalar' as const,summary,values:Float32Array.of(1,99),low:1,high:9};
    expect(compact.bitmapAreas).toBeInstanceOf(Uint32Array);
    for(const x of [1,2])for(const y of [1,2]){
        const original=summarizeLod4Cells(page,metric,x,y),small=summarizeLod4Cells(compact,metric,x,y);
        expect(small).toEqual(original);expect(small.bounds.length).toBe((2/x)*(2/y));
        expect(small.bounds.reduce((sum,r)=>sum+r.width*r.height,0)).toBe(32);
    }
});
