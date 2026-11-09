import { test, expect } from 'bun:test';
import { summarizeBitmapScores, summarizeParcelRegions, summarizeRegionMeans } from '../src/shared/analyticalLod';
import { normalizeMetric } from '../src/shared/mapAnalytics';
import { parcelClassFilter } from '../src/shared/layerAnalysis';

test('unfiltered metadata means retain equal bitmap weights without loading per-bitmap values',()=>{
    const summary={min:1,max:100,scale:'linear' as const,neighborhoodMeans:[37,100]};
    expect([...summarizeRegionMeans(summary)]).toEqual([Math.fround(1+8*36/99),1,9,1]);
    expect(()=>summarizeRegionMeans({...summary,neighborhoodMeans:[NaN]})).toThrow();
});

test('a filter cannot highlight an average of values that are all excluded', () => {
    const result = summarizeBitmapScores(Float32Array.of(1, 9), 2, 4, 6);
    expect(result.matches).toBe(0);
    expect([...result.summaries]).toEqual([5, 0]);
});

test('each region summarizes its own exact matches, including a partial last region', () => {
    const scores = new Float32Array(2019).fill(2);
    scores[2015] = 5; scores.set([9, 7, 8], 2016);
    const result = summarizeBitmapScores(scores, scores.length, 4, 6);
    expect(result.matches).toBe(1);
    expect(result.summaries[0]).toBe(5);
    expect(result.summaries[1]).toBeCloseTo(1 / 2016, 8);
    expect([...result.summaries.slice(2)]).toEqual([8, 0]);
    expect([...summarizeBitmapScores(scores, scores.length).summaries.slice(2)]).toEqual([8, 1]);
});

test('regional parcel summaries preserve selected occupied area and area-weighted side', () => {
    const counts = new Uint32Array(18); counts[0] = 81; counts[8] = 1; counts[9] = 1;
    const filtered = parcelClassFilter(counts, 2, 9, 9);
    const result = summarizeParcelRegions(filtered.neighborhoodMeans, filtered.neighborhoodCoverage);
    expect(result[0]).toBe(9);
    expect(result[1]).toBeCloseTo(81 / 163, 6);
});

test('parcel summaries preserve rare area shares instead of forcing full presence',()=>{
    const means=[9,7.25,1],coverage=[1e-8,.0058,0];
    const result=summarizeParcelRegions(means,coverage);
    expect(result[0]).toBe(9);expect(result[1]).toBeCloseTo(1e-8,12);
    expect(result[2]).toBe(7.25);expect(result[3]).toBeCloseTo(.0058,8);
    expect(result[5]).toBe(0);
    expect(coverage).toEqual([1e-8,.0058,0]);
});

test('area summaries use equal-weight means and exact shares rather than a rare maximum', () => {
    const scores = new Float32Array(4032).fill(2);
    scores[1789] = 9;
    const all = summarizeBitmapScores(scores, scores.length);
    expect(all.summaries[0]).toBeCloseTo((2015 * 2 + 9) / 2016, 6);
    expect([...all.summaries.slice(2)]).toEqual([2, 1]);
    const rare = summarizeBitmapScores(scores, scores.length, 9, 9);
    expect(rare.matches).toBe(1);
    expect(rare.summaries[0]).toBe(9);
    expect(rare.summaries[1]).toBeCloseTo(1 / 2016, 8);
    expect(rare.summaries[3]).toBe(0);
    const unselected = summarizeBitmapScores(scores, scores.length, 4, 6);
    expect(unselected.matches).toBe(0);
    expect(unselected.summaries[1]).toBe(0);
    expect(unselected.summaries[3]).toBe(0);
});

test('regional summaries reject invalid coverage, values and ranges', () => {
    expect(() => summarizeBitmapScores(Float32Array.of(5), 2)).toThrow();
    expect(() => summarizeBitmapScores(Float32Array.of(NaN), 1)).toThrow();
    expect(() => summarizeBitmapScores(Float32Array.of(5), 1, 6, 4)).toThrow();
    expect(() => summarizeParcelRegions([5], [])).toThrow();
    expect(() => summarizeParcelRegions([5], [1.1])).toThrow();
});


test('transaction summaries retain exact density, selected means and counts', () => {
    const scores = new Float32Array(4035).fill(2);
    scores[100] = 5;
    scores.set([4, 6, 2], 4032);
    const result = summarizeBitmapScores(scores, scores.length, 4, 6);
    expect(result.matches).toBe(3);
    expect(result.summaries[0]).toBe(5);
    expect(result.summaries[1]).toBeCloseTo(1 / 2016, 7);
    expect([...result.summaries.slice(2, 4)]).toEqual([2, 0]);
    expect(result.summaries[4]).toBe(5);
    expect(result.summaries[5]).toBeCloseTo(2 / 3, 7);
    expect(result.summaries[5]).toBeGreaterThan(result.summaries[1]);
    const restored = summarizeBitmapScores(scores, scores.length);
    expect([...restored.summaries].filter((_, i) => i % 2 === 1)).toEqual([1, 1, 1]);
    expect(summarizeBitmapScores(scores, scores.length, 4, 6).summaries[1]).toBeCloseTo(1 / 2016, 8);
});


test('logarithmic palettes normalize the arithmetic mean, not a geometric-like mean', () => {
    const values=Float32Array.of(1,9999),summary={min:1,max:9999,scale:'log' as const};
    const scores=Float32Array.from(values,v=>1+8*normalizeMetric(v,summary));
    const all=summarizeBitmapScores(scores,2,1,9,{values,summary});
    expect(all.summaries[0]).toBeCloseTo(1+8*normalizeMetric(5000,summary),6);
    expect(all.summaries[0]).toBeGreaterThan(8);
    expect(all.summaries[1]).toBe(1);
    const filtered=summarizeBitmapScores(scores,2,9,9,{values,summary});
    expect([...filtered.summaries]).toEqual([9,.5]);expect(filtered.matches).toBe(1);
    expect(()=>summarizeBitmapScores(scores,2,1,9,{values:Float32Array.of(1),summary})).toThrow();
});
