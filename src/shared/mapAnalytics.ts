import protobuf from 'protobufjs';
import { check, integer, type FileRef } from './httpPack';

export const ANALYTICS_FORMAT = 'bitmap-analytics-v1-protobuf';
export const METRIC_IDS = ['count', 'composition', 'diversity', 'occupancy', 'shape', 'rarity', 'chronology', 'anomaly'] as const;
export type MetricId = typeof METRIC_IDS[number];
export type MetricSummary = {
    min: number; max: number; mean: number; scale: 'linear' | 'log';
    histogram: number[]; neighborhoodMeans: number[]; values: FileRef; preview: FileRef;
};
export type AnalyticsIndex = {
    format: typeof ANALYTICS_FORMAT; sourceSnapshot: string; count: number;
    parcels: number; patterns: number; metrics: Record<MetricId, MetricSummary>;
    regions: FileRef[]; regionEncoding?:'inspection-local-v2'; patternPages?:Record<string,FileRef>;
};
export type BitmapInspection = {
    id: number; width: number; height: number; count: number; meanSize: number;
    composition: number; diversity: number; occupancy: number; pattern: number; occurrences: number;
    histogram: number[];
};
export const METRICS: Record<MetricId, { label: string; description: string; unit: string; colors: readonly string[] }> = {
    count: { label: 'Transactions', description: 'Transaction count per bitmap, including coinbase.', unit: 'transactions', colors: ['#007eff','#58c059','#ffa100'] },
    composition: { label: 'Small parcels', description: 'Share of parcels in side-length class 1. A size class is not a byte size.', unit: 'share', colors: ['#252b42','#343d61','#485784','#5a75a1','#7197b6','#8ab8c4','#a9d5c8','#d2e8bf','#f3f2bb'] },
    diversity: { label: 'Size diversity', description: 'Shannon entropy of parcel side-length classes. Higher means a more varied composition.', unit: 'bits', colors: ['#29233d','#443158','#624374','#85578d','#ae6b9c','#d284a3','#eaa4a9','#f5c8b5','#f7e7ce'] },
    occupancy: { label: 'Geometric occupancy', description: 'Parcel square area divided by the bitmap bounding rectangle. This does not measure block capacity.', unit: 'share', colors: ['#1e3140','#264c58','#2c696d','#35867d','#4da38a','#77bb96','#a6cfa8','#d2dfbf','#f4ecd8'] },
    shape: { label: 'Bitmap shape', description: 'Longer side divided by shorter side. 1 is square; higher values are more elongated.', unit: 'ratio', colors: ['#203c44','#2a575e','#397576','#58938b','#81afa0','#adc6af','#d2d5bd','#e6c6a8','#efaa87'] },
    rarity: { label: 'Pattern recurrence', description: 'Number of bitmaps sharing the exact rendered geometry in this snapshot. 1 means unique.', unit: 'occurrences', colors: ['#ffac55','#e69763','#c78176','#a36e88','#805f94','#62558e','#484a7a','#333d62','#26334b'] },
    chronology: { label: 'Chronology', description: 'Block height, from genesis to the published edge. Height is not a calendar date.', unit: 'height', colors: ['#375b6b','#4c7f8e','#71a5a5','#a8c6b3','#d8d9bb','#eac69f','#eaa379','#e77e54','#ff9d3d'] },
    anomaly: { label: 'Activity deviation', description: 'Absolute transaction-count z-score within the same 2,016-block neighborhood. A statistical signal, not a cause.', unit: 'σ', colors: ['#263440','#344c58','#436573','#56818c','#789e9e','#a7b8a4','#d2bd8c','#ed9d63','#f0674d'] },
};
export const isMetric = (id: string): id is MetricId => (METRIC_IDS as readonly string[]).includes(id);
export function normalizeMetric(value: number, summary: Pick<MetricSummary, 'min' | 'max' | 'scale'>): number {
    const f = summary.scale === 'log' ? Math.log1p : (x: number) => x;
    const low = f(summary.min), span = f(summary.max) - low;
    return span > 0 ? Math.max(0, Math.min(1, (f(value) - low) / span)) : 0;
}
export function metricAt(t: number, summary: Pick<MetricSummary, 'min' | 'max' | 'scale'>): number {
    return summary.scale === 'log'
        ? Math.expm1(Math.log1p(summary.min) + t * (Math.log1p(summary.max) - Math.log1p(summary.min)))
        : summary.min + t * (summary.max - summary.min);
}

// A separate, explicitly versioned addon leaves the distributed geometry contract unchanged.
const root = protobuf.Root.fromJSON({ nested: { AnalyticsValues: { fields: {
    version: { type: 'uint32', id: 1 }, values: { rule: 'repeated', type: 'float', id: 2, options: { packed: true } },
} }, AnalyticsRegion: { fields: {
    version: { type: 'uint32', id: 1 }, region: { type: 'uint32', id: 2 },
    counts: { rule: 'repeated', type: 'uint32', id: 3, options: { packed: true } },
    widths: { rule: 'repeated', type: 'uint32', id: 4, options: { packed: true } },
    heights: { rule: 'repeated', type: 'uint32', id: 5, options: { packed: true } },
    means: { rule: 'repeated', type: 'float', id: 6, options: { packed: true } },
    occupancies: { rule: 'repeated', type: 'float', id: 7, options: { packed: true } },
    diversities: { rule: 'repeated', type: 'float', id: 8, options: { packed: true } },
    patterns: { rule: 'repeated', type: 'uint32', id: 9, options: { packed: true } },
    occurrences: { rule: 'repeated', type: 'uint32', id: 10, options: { packed: true } },
    histograms: { rule: 'repeated', type: 'uint32', id: 11, options: { packed: true } },
} } } });
const valuesType = root.lookupType('AnalyticsValues'), regionType = root.lookupType('AnalyticsRegion');
export function encodeMetric(values: Float32Array) { return valuesType.encode({ version: 1, values: Array.from(values) }).finish(); }
export function decodeMetric(bytes: Uint8Array, count: number): Float32Array {
    check(integer(count, 1, 1048576) && bytes.length <= count * 4 + 64, 'Analytics values exceed budget');
    const raw = valuesType.toObject(valuesType.decode(bytes), { arrays: true, defaults: true });
    check(raw.version === 1 && raw.values.length === count && raw.values.every((v: number) => Number.isFinite(v) && v >= 0), 'Invalid analytics values');
    return Float32Array.from(raw.values);
}
export function encodeInspection(region: number, rows: BitmapInspection[], local = false): Uint8Array {
    return regionType.encode({ version: local?2:1, region, counts: rows.map(r => r.count), widths: rows.map(r => r.width), heights: rows.map(r => r.height),
        means: rows.map(r => r.meanSize), occupancies: rows.map(r => r.occupancy), diversities: rows.map(r => r.diversity),
        patterns: rows.map(r => r.pattern), occurrences: local?[]:rows.map(r => r.occurrences), histograms: rows.flatMap(r => r.histogram) }).finish();
}
export function decodeInspection(bytes: Uint8Array, region: number, count: number): BitmapInspection[] {
    check(bytes.length <= 256 * 1024 && integer(region, 0, 520) && integer(count, 1, 2016), 'Inspection exceeds budget');
    const r = regionType.toObject(regionType.decode(bytes), { defaults: true, arrays: true });
    check((r.version === 1||r.version===2) && r.region === region && ['counts','widths','heights','means','occupancies','diversities','patterns'].every(k => r[k].length === count) && (r.version===2?r.occurrences.length===0:r.occurrences.length===count) && r.histograms.length === count * 9, 'Invalid inspection coverage');
    return Array.from({ length: count }, (_, i) => {
        const histogram = r.histograms.slice(i * 9, i * 9 + 9);
        check(r.counts[i] >= 1 && histogram.reduce((a: number,b: number) => a+b,0) === r.counts[i] && r.widths[i] > 0 && r.heights[i] > 0 && r.patterns[i] <= region*2016+i && (r.version===2||r.occurrences[i] >= 1) && Number.isFinite(r.means[i]) && r.means[i] >= 1 && r.means[i] <= 9 && Number.isFinite(r.occupancies[i]) && r.occupancies[i] > 0 && r.occupancies[i] <= 1.000001 && Number.isFinite(r.diversities[i]) && r.diversities[i] >= 0 && r.diversities[i] <= Math.log2(9)+.000001, 'Invalid bitmap inspection');
        return { id: region*2016+i, count: r.counts[i], width: r.widths[i], height: r.heights[i], meanSize: r.means[i], occupancy: r.occupancies[i], diversity: r.diversities[i], pattern: r.patterns[i], occurrences: r.version===2?1:r.occurrences[i], histogram, composition: histogram[0]/r.counts[i] };
    });
}
export function validateAnalyticsIndex(root: AnalyticsIndex, snapshot: string, count: number): void {
    check(root?.format === ANALYTICS_FORMAT && root.sourceSnapshot === snapshot && root.count === count && integer(count,1,1048576), 'Analytics belongs to another snapshot');
    const regions = Math.ceil(count / 2016);
    const ref = (r: FileRef) => r && /^[a-f0-9]{64}\.pb$/.test(r.url) && r.url === r.sha256+'.pb' && integer(r.bytes, 1, 8*1024*1024);
    check(Number.isSafeInteger(root.parcels) && root.parcels >= count && integer(root.patterns,1,count) && root.regions.length === regions && root.regions.every(ref), 'Invalid analytics coverage');
    if(root.regionEncoding!==undefined)check(root.regionEncoding==='inspection-local-v2'&&root.patternPages&&Object.entries(root.patternPages).every(([key,r])=>integer(Number(key),0,1023)&&ref(r)),'Invalid pattern page contract');
    for (const id of METRIC_IDS) {
        const m = root.metrics[id];
        check(m && [m.min,m.max,m.mean].every(Number.isFinite) && m.min >= 0 && m.min <= m.mean && m.mean <= m.max && ['linear','log'].includes(m.scale) && m.histogram.length === 32 && m.histogram.every(n=>integer(n,0,count)) && m.histogram.reduce((a,b)=>a+b,0) === count && m.neighborhoodMeans.length === regions && m.neighborhoodMeans.every(n=>Number.isFinite(n)&&n>=m.min-.00001&&n<=m.max+.00001) && ref(m.values) && ref(m.preview), 'Invalid analytics metric: '+id);
    }
}
