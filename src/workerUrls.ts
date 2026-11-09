/** Literal module URLs let Vite build, watch and version each worker. */
export function mapWorker(name: 'tightSpiralWorker' | 'neighborhoodBitmapWorker' | 'neighborhoodLayoutWorker' | 'parcelAnalysisWorker' | 'patternWorker'): Worker {
    switch (name) {
        case 'patternWorker': return new Worker(new URL('./data/patternWorker.ts', import.meta.url), { type: 'module' });
        case 'parcelAnalysisWorker': return new Worker(new URL('./data/parcelAnalysisWorker.ts', import.meta.url), { type: 'module' });
        case 'tightSpiralWorker': return new Worker(new URL('./map/workers/tightSpiralWorker.ts', import.meta.url), { type: 'module' });
        case 'neighborhoodBitmapWorker': return new Worker(new URL('./map/workers/neighborhoodBitmapWorker.ts', import.meta.url), { type: 'module' });
        case 'neighborhoodLayoutWorker': return new Worker(new URL('./data/neighborhoodLayoutWorker.ts', import.meta.url), { type: 'module' });
    }
}
