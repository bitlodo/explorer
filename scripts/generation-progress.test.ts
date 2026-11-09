import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runTool } from './cli';
import { formatGenerationProgress, GenerationCoverage } from './generation-progress';

test('spatial chunk order produces monotonic unique bitmap counts and announces each completed neighborhood once', () => {
    const progress = new GenerationCoverage(4031, 2);
    for (let id = 4031; id >= 2016; id--) progress.record(id);
    const first = progress.snapshot();
    for (let id = 0; id < 1000; id++) progress.record(id);
    progress.record(4031);
    const second = progress.snapshot();
    for (let id = 2015; id >= 1000; id--) progress.record(id);
    const third = progress.snapshot();
    expect([first.bitmaps, second.bitmaps, third.bitmaps]).toEqual([2016, 3016, 4032]);
    expect([first.neighborhoods, second.neighborhoods, third.neighborhoods]).toEqual([1, 1, 2]);
    expect([first.completedNeighborhoods, second.completedNeighborhoods, third.completedNeighborhoods]).toEqual([[1], [], [0]]);
    const lines = [first, second, third].map((coverage, index) => formatGenerationProgress(JSON.stringify({ generationProgress: {
        kind: 'coverage', phase: 'Parcel chunks written', unit: 'Chunks', completed: index + 1, total: 3, ...coverage,
    } })));
    expect(lines[0]).toEqual([
        'Parcel chunks written | Chunks: 1 / 3 (33.3%) | Bitmaps: 2,016 / 4,032 (50.0%) | Neighborhoods complete: 1 / 2',
        'Parcel chunks written | Neighborhood ID 1 completed',
    ]);
    expect(lines[1][0]).toContain('Bitmaps: 3,016 / 4,032 (74.8%)');
    expect(lines[2][0]).toContain('Bitmaps: 4,032 / 4,032 (100.0%)');
    expect(lines[2][1]).toBe('Parcel chunks written | Neighborhood ID 0 completed');
    expect(progress.snapshot().completedNeighborhoods).toEqual([]);
    expect(() => progress.record(4032)).toThrow('Invalid');
    expect(formatGenerationProgress('unstructured debug output')).toEqual([]);
    expect(formatGenerationProgress('{"generationProgress":broken')).toEqual([]);
    expect(formatGenerationProgress('{"generationProgress":{"kind":"stage","stage":"chunks","state":"reused"}}')).toEqual([
        'Reused completed stage: Create parcel chunks and previews',
    ]);
});

test('tool progress streams before exit, handles split UTF-8 and final lines, and keeps complete stdout/stderr logs on failure', async () => {
    const root = await mkdtemp('/tmp/bitmap-progress-stream-');
    const script = resolve(root, 'worker.ts'), logfile = resolve(root, 'generation.log'), release = resolve(root, 'release');
    try {
        await Bun.write(script, `
console.log('raw detail');
await Bun.write(Bun.stdout, 'x'.repeat(70000) + '\\n');
const line = JSON.stringify({generationProgress:{kind:'units',phase:'Writing…',unit:'Files',completed:1,total:2}}) + '\\n';
const bytes = new TextEncoder().encode(line), split = bytes.indexOf(0xe2) + 1;
await Bun.write(Bun.stdout, bytes.subarray(0, split));
await Bun.sleep(5);
await Bun.write(Bun.stdout, bytes.subarray(split));
const deadline = Date.now() + 5000;
while (!await Bun.file(process.argv[2]).exists() && Date.now() < deadline) await Bun.sleep(5);
console.error('stderr detail');
await Bun.write(Bun.stdout, 'tail without newline');
if (process.argv[3] === 'fail') process.exitCode = 7;
`);
        let announce!: () => void, finished = false;
        const live = new Promise<void>(resolve => { announce = resolve; }), lines: string[] = [];
        const execution = runTool(script, [release], { log: logfile, onLine: line => {
            lines.push(line);
            if (line.startsWith('{"generationProgress":')) announce();
        } }).finally(() => { finished = true; });
        try {
            await Promise.race([live, execution.then(() => { throw Error('No live progress received.'); })]);
            expect(finished).toBe(false);
            const message = lines.flatMap(formatGenerationProgress);
            expect(message).toEqual(['Writing… | Files: 1 / 2 (50.0%)']);
        } finally { await Bun.write(release, 'continue'); await execution; }
        expect(lines).toContain('tail without newline');
        expect(lines.some(line => line.length > 65536)).toBe(false);
        const log = await Bun.file(logfile).text();
        expect(log).toContain('x'.repeat(70000));
        expect(log).toContain('raw detail'); expect(log).toContain('stderr detail');
        expect(log).toContain('Writing…'); expect(log).toContain('tail without newline');
        await expect(runTool(script, [release, 'fail'], { log: logfile, onLine: () => {} })).rejects.toThrow('Failed:');
        expect((await Bun.file(logfile).text()).split('tail without newline')).toHaveLength(3);
    } finally { await rm(root, { recursive: true, force: true }); }
}, 10000);
