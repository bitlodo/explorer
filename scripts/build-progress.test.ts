import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createBuildProgress } from './build-progress';
import { runTool } from './cli';

test('build progress keeps per-stage counts separate and reports stage and total elapsed time', () => {
    const lines: string[] = [];
    let clock = 0;
    const progress = createBuildProgress({ output: { write: text => lines.push(text) }, now: () => clock });
    try {
        progress.update({ phase: 'Validating geometry', completed: 0, total: 10, unit: 'neighborhoods' });
        clock = 4300;
        progress.update({ phase: 'Validating geometry', completed: 10, total: 10, unit: 'neighborhoods' });
        progress.update({ phase: 'Copying map files', completed: 0, total: 20, unit: 'files', bytes: 0 });
        clock = 6300;
        progress.update({ phase: 'Copying map files', completed: 5, total: 20, unit: 'files', bytes: 12_500_000 });
        expect(progress.consume('unstructured diagnostic')).toBe(false);
        expect(progress.consume('{"buildProgress":broken')).toBe(false);
        progress.close();
        expect(lines[1]).toContain('Validating geometry complete | 10 / 10 (100.0%) neighborhoods | 4.3s stage | 4.3s total');
        expect(lines[2]).toContain('Copying map files | 0 / 20 (0.0%) files | 0.0 MB | 0.0s stage');
        expect(lines.at(-1)).toContain('5 / 20 (25.0%) files | 12.5 MB | 2.0s stage | 6.3s total');
        const count = lines.length;
        progress.close();
        progress.update({ phase: 'Closed logger' });
        expect(lines).toHaveLength(count);
    } finally { progress.close(); }
});

test('build heartbeat stays live while a child is CPU-bound and stops after the child finishes', async () => {
    const root = await mkdtemp('/tmp/bitmap-build-progress-');
    const worker = resolve(root, 'worker.ts'), release = resolve(root, 'release');
    const lines: string[] = [], diagnostics: string[] = [];
    const progress = createBuildProgress({ output: { write: text => lines.push(text) }, refreshMs: 10 });
    let announce!: () => void, finished = false;
    const announced = new Promise<void>(resolve => { announce = resolve; });
    let execution: Promise<void> | undefined;
    try {
        await Bun.write(worker, `
import { existsSync } from 'node:fs';
import { reportBuildProgress } from ${JSON.stringify(resolve(import.meta.dir, 'build-progress.ts'))};
reportBuildProgress({phase:'Validating parcel packs',completed:0,total:2,unit:'packs'});
const deadline=Date.now()+5000;
while(!existsSync(process.argv[2])&&Date.now()<deadline){}
reportBuildProgress({phase:'Validating parcel packs',completed:2,total:2,unit:'packs'});
console.log('ordinary diagnostic');
`);
        execution = runTool(worker, [release], { env: { BITMAP_BUILD_PROGRESS: '1' }, forwardStdout: false,
            onLine: line => { if (progress.consume(line)) announce(); else diagnostics.push(line); },
        }).finally(() => { finished = true; progress.close(); });
        await Promise.race([announced, execution.then(() => { throw Error('No live progress received'); })]);
        const deadline = Date.now() + 2000;
        while (lines.filter(line => line.includes('Validating parcel packs')).length < 2 && Date.now() < deadline) await Bun.sleep(10);
        expect(finished).toBe(false);
        expect(lines.filter(line => line.includes('0 / 2 (0.0%) packs')).length).toBeGreaterThanOrEqual(2);
        await Bun.write(release, 'continue');
        await execution;
        expect(lines.at(-1)).toContain('2 / 2 (100.0%) packs');
        expect(diagnostics).toEqual(['ordinary diagnostic']);
        const count = lines.length;
        await Bun.sleep(30);
        expect(lines).toHaveLength(count);
    } finally {
        await Bun.write(release, 'continue');
        await execution?.catch(() => {});
        progress.close();
        await rm(root, { recursive: true, force: true });
    }
}, 10000);
