import { test, expect } from 'bun:test';
import { normalizeMetric, metricAt, encodeMetric, decodeMetric, encodeInspection, decodeInspection, validateAnalyticsIndex, type BitmapInspection } from '../src/shared/mapAnalytics';

test('scalar normalization and legend values agree, including constant data',()=>{
    for(const scale of ['linear','log'] as const){
        const summary={min:1,max:12239,scale};
        for(const value of [1,4,50,3000,12239])expect(metricAt(normalizeMetric(value,summary),summary)).toBeCloseTo(value,6);
        expect(normalizeMetric(1,{min:1,max:1,scale})).toBe(0);
    }
});
test('metric Protobuf has independently known wire bytes and rejects bad coverage',()=>{
    // Version 1, packed Float32 values 1 and 2.
    const fixture=Uint8Array.from([8,1,18,8,0,0,128,63,0,0,0,64]);
    expect([...encodeMetric(Float32Array.of(1,2))]).toEqual([...fixture]);
    expect([...decodeMetric(fixture,2)]).toEqual([1,2]);
    expect(()=>decodeMetric(fixture,3)).toThrow('Invalid analytics values');
    expect(()=>decodeMetric(encodeMetric(Float32Array.of(NaN)),1)).toThrow();
});
test('inspection preserves actual counts rather than inferring them from equal areas',()=>{
    const base={meanSize:2,diversity:0,occupancy:1,pattern:0,occurrences:1,composition:0};
    const rows:BitmapInspection[]=[{...base,id:0,width:2,height:2,count:1,histogram:[0,1,0,0,0,0,0,0,0]},
        {...base,id:1,width:2,height:2,count:4,meanSize:1,composition:1,pattern:1,histogram:[4,0,0,0,0,0,0,0,0]}];
    const decoded=decodeInspection(encodeInspection(0,rows),0,2);
    expect(decoded.map(r=>r.count)).toEqual([1,4]);expect(decoded.map(r=>r.width*r.height)).toEqual([4,4]);
    expect(()=>decodeInspection(encodeInspection(0,[{...rows[0],count:2}]),0,1)).toThrow('Invalid bitmap inspection');
    expect(()=>decodeInspection(encodeInspection(0,rows),1,2)).toThrow('Invalid inspection coverage');
});
test('analytics rejects a different snapshot before trusting metric metadata',()=>{
    expect(()=>validateAnalyticsIndex({format:'bitmap-analytics-v1-protobuf',sourceSnapshot:'old',count:1} as any,'new',1)).toThrow('Analytics belongs to another snapshot');
});
