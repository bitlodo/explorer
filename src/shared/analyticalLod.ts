import { check, integer } from './httpPack';
import { normalizeMetric, type MetricSummary } from './mapAnalytics';

/** Runtime presentation identity; distributed geometry and caches are unchanged. */
export const ANALYTICAL_LOD_POLICY = 'analytical-region-summary-v11-original-value-means';
export type RegionSummaries = Float32Array;

/** Metadata already contains the unbiased, unfiltered means for every region. */
export function summarizeRegionMeans(summary: Pick<MetricSummary, 'min' | 'max' | 'scale' | 'neighborhoodMeans'>): RegionSummaries {
    const values = new Float32Array(summary.neighborhoodMeans.length * 2);
    summary.neighborhoodMeans.forEach((mean, region) => {
        check(Number.isFinite(mean) && mean >= summary.min && mean <= summary.max, 'Invalid regional metric mean');
        values[region * 2] = 1 + 8 * normalizeMetric(mean, summary);
        values[region * 2 + 1] = 1;
    });
    return values;
}

/** Two floats per region: display score and color coverage.
 * Density modes use the matching mean and exact share, rendered at 20–100%
 * palette intensity with a contrast floor. Each matching bitmap has equal weight.
 * Original metric values are averaged before applying any display normalization.
 * A range is tested on individual scores, never on an average of excluded values.
 */
export function summarizeBitmapScores(scores: Float32Array, count: number, low = 1, high = 9, source?: { values: Float32Array; summary: Pick<MetricSummary, 'min' | 'max' | 'scale'> }) {
    check(integer(count, 1, 1048576) && scores.length >= count, 'Invalid analytical score coverage');
    check(Number.isFinite(low) && Number.isFinite(high) && low >= 1 && high <= 9 && low <= high, 'Invalid analytical range');
    check(!source || source.values.length >= count, 'Invalid original metric coverage');
    const regions = Math.ceil(count / 2016), summaries = new Float32Array(regions * 2);
    let matches = 0;
    for (let region = 0; region < regions; region++) {
        const first = region * 2016, end = Math.min(count, first + 2016);
        let total = 0, selected = 0, sum = 0;
        for (let id = first; id < end; id++) {
            const score = scores[id];
            check(Number.isFinite(score) && score >= 1 && score <= 9, 'Invalid analytical score');
            const value = source ? source.values[id] : score;
            check(Number.isFinite(value) && value >= 0, 'Invalid original metric value');
            total += value;
            if (score >= low - .000001 && score <= high + .000001) { selected++; sum += value; }
        }
        const mean = selected ? sum / selected : total / (end - first);
        summaries[region * 2] = source ? 1 + 8 * normalizeMetric(mean, source.summary) : mean;
        const share = selected / (end - first);
        summaries[region * 2 + 1] = share;
        matches += selected;
    }
    return { summaries, matches };
}

/** Preserve selected area-weighted means and exact occupied-area shares. */
export function summarizeParcelRegions(means: readonly number[], coverage: readonly number[]): RegionSummaries {
    check(means.length === coverage.length, 'Invalid parcel region coverage');
    const summaries = new Float32Array(means.length * 2);
    for (let id = 0; id < means.length; id++) {
        check(Number.isFinite(means[id]) && means[id] >= 1 && means[id] <= 9 &&
            Number.isFinite(coverage[id]) && coverage[id] >= 0 && coverage[id] <= 1, 'Invalid parcel region summary');
        summaries[id * 2] = means[id]; summaries[id * 2 + 1] = coverage[id];
    }
    return summaries;
}
