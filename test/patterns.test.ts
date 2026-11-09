import {test,expect} from 'bun:test';
import {patternScore,PATTERN_CYCLE,PATTERN_COLORS,decodePatternReference,catalogPatterns,filterPatterns} from '../src/shared/patterns';
import {buildLod4Region} from '../src/shared/lod4';
import {summarizeLod4Cells} from '../src/shared/lod4Summary';
import {encodeMetric} from '../src/shared/mapAnalytics';
import {encodeSizes} from '../src/shared/httpPack';
import PatternsClient from '../src/data/PatternsClient';
import MapController from '../src/map/MapController';
import type {MapDataSource} from '../src/data/MapDataSource';

// Independent Protobuf fixture: snapshot "s", canonical IDs [0,1,0,3,1,5].
const reference=Uint8Array.of(8,1,18,1,115,26,6,0,1,0,3,1,5);
const counts=Float32Array.of(1,2,1,1,2,3),patterns=Uint32Array.of(0,1,0,3,1,5);
function source(){
    return {getAnalyticsIndex:async()=>({count:6,parcels:10}),getPatternInputs:async()=>({snapshot:'s',count:6,patternBytes:reference,countBytes:encodeMetric(counts)}),
        async *streamParcels(_region:number,ids:number[],signal:AbortSignal){for(const id of ids){signal.throwIfAborted();yield encodeSizes(id,id===0?[5]:[5,5]);}},getPreviewIndex:async()=>({}),
    } as unknown as MapDataSource;
}
function controller(){
    const prior=Object.getOwnPropertyDescriptor(globalThis,'window');Object.defineProperty(globalThis,'window',{value:{location:{search:''}},configurable:true});
    let c: any;try{c=new MapController({} as any);}finally{if(prior)Object.defineProperty(globalThis,'window',prior);else Reflect.deleteProperty(globalThis,'window');}
    c.active=true;c.snapshot={...c.getState(),publishedHeight:5};c.overview={slots:[{}],setSizeColors(){},setAnalytic(){}};
    let regions:Float32Array|undefined;
    c.preview={setActive(){},setSizeColorMode(){},setBitmapAreaMode(){},setIndex(){},setAnalytic(){},setParcelClasses(){},setSizeColors(){},setRegionSummaries(value:Float32Array){regions=value;},setSpatialMetric(){}};
    c.source=source();return {c,get regions(){return regions;}};
}

test('chronological colors repeat exactly every 200 neighborhoods, with a closed multicolor loop',()=>{
    expect(PATTERN_CYCLE).toBe(403200);expect(PATTERN_COLORS[0]).toBe(PATTERN_COLORS[8]);
    for(const id of [0,1,2015,2016,89273,403199]){
        expect(patternScore(id+PATTERN_CYCLE)).toBe(patternScore(id));
        expect(patternScore(id)).toBeGreaterThanOrEqual(1);expect(patternScore(id)).toBeLessThan(9);
    }
    expect(patternScore(0)).toBe(1);expect(patternScore(PATTERN_CYCLE/2)).toBe(5);
});
test('catalog lists only repeated geometry, while transaction totals include unique bitmaps',()=>{
    expect(decodePatternReference(reference,'s',6)).toEqual(patterns);
    expect(catalogPatterns(patterns,counts)).toEqual({entries:[{id:0,transactions:1,occurrences:2},{id:1,transactions:2,occurrences:2}],groups:[{transactions:1,patterns:1,bitmaps:3},{transactions:2,patterns:1,bitmaps:2}]});
    expect(()=>decodePatternReference(reference,'other',6)).toThrow('snapshot');
    expect(()=>decodePatternReference(Uint8Array.of(8,1,18,1,115,26,2,1,1),'s',2)).toThrow('canonical');
    expect(()=>catalogPatterns(patterns,Float32Array.of(1,2,9,1,2,3))).toThrow('transaction');
});
test('selecting and clearing a pattern preserves exact TX filtering and original chronology scores',()=>{
    const all=filterPatterns(patterns,counts),tx=filterPatterns(patterns,counts,1),selected=filterPatterns(patterns,counts,1,0);
    expect(all.matches).toBe(6);expect(tx.matches).toBe(3);expect(selected.matches).toBe(2);
    for(let id=0;id<6;id++){
        expect(all.scores[id]).toBe(Math.fround(patternScore(id)));
        expect(tx.scores[id]).toBe([0,2,3].includes(id)?all.scores[id]:-1);
        expect(selected.scores[id]).toBe([0,2].includes(id)?all.scores[id]:-1);
    }
    expect(filterPatterns(patterns,counts,1).scores).toEqual(tx.scores);
    expect(tx.summaries[0]).toBe(all.summaries[0]);expect(selected.summaries[0]).toBe(all.summaries[0]);
    expect(filterPatterns(patterns,counts,3).matches).toBe(1);
    expect(filterPatterns(patterns,counts,9).matches).toBe(0);
    expect(filterPatterns(patterns,counts,2,0).matches).toBe(0);
    expect(()=>filterPatterns(patterns,counts,0)).toThrow();
    expect(()=>filterPatterns(patterns,counts,undefined,2)).toThrow('selection');
});
test('pattern LOD4 retains selected colors at full strength and disables empty cells',()=>{
    const page=buildLod4Region({neighborhood:0,width:16,height:16,bitmaps:[{x:0,y:0,width:8,height:16},{x:8,y:0,width:8,height:16}]},'0'.repeat(64));
    const values=Float32Array.of(2,6),cells=summarizeLod4Cells(page,{kind:'patterns',values,scores:Float32Array.of(2,-1),summary:{min:1,max:9,scale:'linear'},low:1,high:9},16);
    expect([...cells.summaries]).toEqual([4,1]);
    const empty=summarizeLod4Cells(page,{kind:'patterns',values,scores:Float32Array.of(-1,-1),summary:{min:1,max:9,scale:'linear'},low:1,high:9},16);
    expect(empty.summaries[1]).toBe(0);
});
test('worker catalog, filters and canonical previews preserve their source buffers',async()=>{
    const client=new PatternsClient(source());
    try{
        const catalog=await client.init();expect(catalog.entries.length).toBe(2);expect(reference.byteLength).toBe(13);
        expect(client.page(1,0,12)).toEqual({entries:[{id:0,transactions:1,occurrences:2}],total:1});
        expect((await client.filter(1)).matches).toBe(3);
        const preview=await client.preview(0,new AbortController().signal);expect(preview.width).toBe(5);expect(preview.height).toBe(5);expect([...preview.rects]).toEqual([0,0,5,5]);
        expect(await client.preview(0,new AbortController().signal)).toBe(preview);
    }finally{client.close();}
});
test('controller ignores stale selections, retains unique TX matches and clears membership on mode exit',async()=>{
    const f=controller(),c=f.c;
    try{
        await c.setRenderingMode('patterns');expect(c.getState().publishedParcels).toBe(10);expect(c.getState().patternTotal).toBe(2);expect(c.getState().filterMatches).toBe(6);
        const original=c.analyticTexture.image.data.slice();
        await Promise.all([c.setPatternFilter(1,0),c.setPatternFilter(2)]);
        expect(c.getState().patternTransactions).toBe(2);expect(c.getState().selectedPattern).toBeUndefined();expect(c.getState().filterMatches).toBe(2);
        expect(c.analyticTexture.image.data[1]).toBe(original[1]);expect(c.analyticTexture.image.data[0]).toBe(-1);expect(f.regions![1]).toBe(1);
        await c.setPatternFilter(1,0);expect(c.getState().filterMatches).toBe(2);
        await c.setPatternFilter(1);expect(c.getState().filterMatches).toBe(3);
        const pending=c.setPatternFilter(3);await c.setRenderingMode('default');await pending;
        expect(c.getState().renderingMode).toBe('default');expect(c.getState().filterBusy).toBe(false);expect(c.getState().patternGroups).toBeUndefined();expect(c.patternsClient).toBeUndefined();
    }finally{c.patternsClient?.close();c.analyticTexture?.dispose();}
});

test('inspector filtering accepts repeated geometry only and opens its exact TX count and pattern',async()=>{
    const {c}=controller();
    try{
        c.snapshot={...c.getState(),selection:{id:3,pattern:3,count:1,occurrences:1}};
        const before=c.getState();await c.findPatternMatches();expect(c.getState()).toBe(before);expect(c.patternsClient).toBeUndefined();
        c.snapshot={...c.getState(),selection:{id:2,pattern:0,count:1,occurrences:2}};
        await c.findPatternMatches();
        expect(c.getState().renderingMode).toBe('patterns');expect(c.getState().patternTransactions).toBe(1);
        expect(c.getState().selectedPattern).toBe(0);expect(c.getState().filterMatches).toBe(2);
    }finally{c.patternsClient?.close();c.analyticTexture?.dispose();}
});
