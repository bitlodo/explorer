const stageNames: Record<string, string> = {
    export: 'Export database neighborhoods', chunks: 'Create parcel chunks and previews',
    dimensions: 'Create and verify neighborhood dimensions', spatial: 'Create spatial index pages',
    huffman: 'Compress parcel packs', 'bitmap-chunks': 'Create bitmap vector chunks',
    colors: 'Create parcel colors and previews', areas: 'Calculate bitmap area colors', organize: 'Organize output files',
};

type Coverage = { bitmaps: number; totalBitmaps: number; neighborhoods: number; totalNeighborhoods: number; completedNeighborhoods: number[] };
export type GenerationProgress =
    | { kind: 'stage'; stage: string; state: 'started' | 'complete' | 'reused' }
    | { kind: 'neighborhood'; phase: string; id: number; completed: number; total: number; action: 'created' | 'reused' | 'processed' | 'verified' | 'copied' }
    | ({ kind: 'coverage'; phase: string; unit: string; completed: number; total?: number } & Coverage)
    | { kind: 'units'; phase: string; unit: string; completed: number; total: number };

export const generationProgressEnabled = () => process.env.BITMAP_GENERATION_PROGRESS === '1';
export function reportGenerationProgress(event: GenerationProgress) {
    if (generationProgressEnabled()) console.log(JSON.stringify({ generationProgress: event }));
}

/** Count unique completed work; spatial order must never masquerade as a block-height cursor. */
export class GenerationCoverage {
    private readonly seen: Uint8Array;
    private readonly neighborhoodCounts: Uint16Array;
    private bitmaps = 0;
    private neighborhoods = 0;
    private completedNeighborhoods: number[] = [];
    constructor(publishedHeight: number, private readonly totalNeighborhoods: number) {
        this.seen = new Uint8Array(publishedHeight + 1);
        this.neighborhoodCounts = new Uint16Array(Math.ceil((publishedHeight + 1) / 2016));
    }
    record(id: number) {
        if (!Number.isSafeInteger(id) || id < 0 || id >= this.seen.length) throw Error('Invalid progress bitmap ID.');
        if (this.seen[id]) return;
        this.seen[id] = 1; this.bitmaps++;
        const neighborhood = Math.floor(id / 2016);
        if (++this.neighborhoodCounts[neighborhood] === 2016) {
            this.neighborhoods++; this.completedNeighborhoods.push(neighborhood);
        }
    }
    snapshot(): Coverage {
        const completedNeighborhoods = this.completedNeighborhoods.sort((a, b) => a - b);
        this.completedNeighborhoods = [];
        return { bitmaps: this.bitmaps, totalBitmaps: this.totalNeighborhoods * 2016,
            neighborhoods: this.neighborhoods, totalNeighborhoods: this.totalNeighborhoods, completedNeighborhoods };
    }
}

const number = (value: number) => value.toLocaleString('en-US');
const amount = (completed: number, total: number) => {
    const percent = !total || completed >= total ? 100 : Math.min(99.9, 100 * completed / total);
    return `${number(completed)} / ${number(total)} (${percent.toFixed(1)}%)`;
};
export function formatGenerationProgress(line: string): string[] {
    if (!line.startsWith('{"generationProgress":')) return [];
    try {
        const event = JSON.parse(line).generationProgress as GenerationProgress;
        switch (event.kind) {
            case 'stage': return [`${event.state === 'started' ? 'Starting' : event.state === 'reused' ? 'Reused completed stage' : 'Completed'}: ${stageNames[event.stage] ?? event.stage}`];
            case 'neighborhood': return [`${event.phase} | Neighborhood ID ${number(event.id)} ${event.action} | Neighborhoods: ${amount(event.completed, event.total)}`];
            case 'units': return [`${event.phase} | ${event.unit}: ${amount(event.completed, event.total)}`];
            case 'coverage': return [
                `${event.phase} | ${event.unit}: ${event.total === undefined ? number(event.completed) : amount(event.completed, event.total)} | Bitmaps: ${amount(event.bitmaps, event.totalBitmaps)} | Neighborhoods complete: ${number(event.neighborhoods)} / ${number(event.totalNeighborhoods)}`,
                ...event.completedNeighborhoods.map(id => `${event.phase} | Neighborhood ID ${number(id)} completed`),
            ];
            default: return [];
        }
    } catch { return []; }
}
