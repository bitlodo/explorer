import {test,expect} from 'bun:test';
import {encodeParcelClasses,decodeParcelClasses,parcelClassFilter,validateLayerAnalysis} from '../src/shared/layerAnalysis';

test('large parcels dominate the distant color by occupied area, rather than transaction count',()=>{
    const counts=Uint32Array.of(10,0,0,0,0,0,0,0,1);
    const all=parcelClassFilter(counts,1,1,9);
    expect(all.pixels[0]).toBeCloseTo(739/91,5);
    expect(all.pixels[0]).toBeGreaterThan(8);
    expect(all.pixels[1]).toBe(1);
    expect(all.parcelMatches).toBe(11);
    const large=parcelClassFilter(counts,1,7,9);
    expect(large.pixels[0]).toBe(9);expect(large.pixels[1]).toBeCloseTo(81/91,6);
    expect(large.parcelMatches).toBe(1);expect(large.selectedArea).toBe(81);
    const small=parcelClassFilter(counts,1,1,3);
    expect(small.pixels[0]).toBe(1);expect(small.parcelMatches).toBe(10);
    expect(small.selectedArea).toBe(10);
});
test('class filters distinguish empty membership and neighborhood area weighting',()=>{
    const counts=new Uint32Array(18);counts[0]=4;counts[10]=1;
    const empty=parcelClassFilter(counts,2,7,9);
    expect(empty.bitmapMatches).toBe(0);expect(empty.parcelMatches).toBe(0);
    expect(empty.neighborhoodMeans).toEqual([1]);expect(empty.neighborhoodCoverage).toEqual([0]);
    const all=parcelClassFilter(counts,2,1,9);
    expect(all.neighborhoodMeans).toEqual([1.5]);expect(all.totalArea).toBe(8);
    expect(()=>parcelClassFilter(counts,2,9,1)).toThrow();
});
test('class Protobuf matches an independent wire fixture and rejects wrong counts',()=>{
    const counts=Uint32Array.of(1,0,0,0,0,0,0,0,0);
    const bytes=Uint8Array.of(8,1,16,1,26,9,1,0,0,0,0,0,0,0,0);
    expect([...encodeParcelClasses(counts,1)]).toEqual([...bytes]);
    expect([...decodeParcelClasses(bytes,1)]).toEqual([...counts]);
    expect(()=>decodeParcelClasses(bytes,2)).toThrow();
    expect(()=>decodeParcelClasses(encodeParcelClasses(new Uint32Array(9),1),1)).toThrow('Invalid parcel count');
    expect(()=>validateLayerAnalysis({format:'map-layer-analysis-v1-protobuf',sourceSnapshot:'old',count:1} as any,'new',1)).toThrow('Layer analysis snapshot mismatch');
});
