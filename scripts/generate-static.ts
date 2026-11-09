import {datasetPath,isSemanticDataset} from './dataset-path';
import { generateLod4 } from './generate-lod4';
import { generateLod4Summaries, installLod4Summaries } from './generate-lod4-summaries';
import { generateParcelFilters, installParcelFilters } from './generate-parcel-filters';
import { installLod4 } from './install-lod4';
import { organizeMapData } from './organize-map-data';
import { generateAnalytics, installAnalytics } from './generate-analytics';
import { generateLayerAnalysis, installLayerAnalysis } from './generate-layer-analysis';
import { mkdir, readdir, realpath, rename, stat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { exists } from './aws-download';
import { exportReferenceSnapshot } from './reference-snapshot';
import { Database, OPEN_READONLY } from './duckdb';
import { dirname, resolve, sep } from 'node:path';
import { generateChunks } from './generate-chunks';
import { generateBitmapAreaColors } from './generate-bitmap-area-colors';
import { argumentsFor, runTool } from './cli';
import { srcRoot, publicRoot, mapDataRoot, projectRoot, maintenanceRoot, temporaryRoot, dataRoot } from './paths';
import { LAYOUT } from '../src/shared/httpPack';
import { prepareHuffmanRle } from './prepare-huffman-rle';
import { databasePath } from './db-config';
import { reportGenerationProgress } from './generation-progress';

async function mergeArtifacts(source: string, destination: string): Promise<void> {
    for (const entry of await readdir(source, { withFileTypes: true })) {
        if (!entry.isFile()) throw new Error('Generated artifact directories must contain regular files only.');
        const input = Bun.file(resolve(source, entry.name)), outputPath = resolve(destination, entry.name), output = Bun.file(outputPath);
        if (await output.exists()) {
            if (!Buffer.from(await input.arrayBuffer()).equals(Buffer.from(await output.arrayBuffer()))) throw new Error(`Conflicting artifact: ${entry.name}`);
        } else {
            // Bun 1.4 can retain a zero-length stat on a BunFile probed before it exists.
            // Copy through the path rather than reusing that destination BunFile.
            await Bun.write(outputPath, input);
        }
    }
}

/** Offline preparation only: no server, no database mutation, no publication. */
export async function generateStatic(options: { source?: string; geometry?: string; regions?: string; db?: string; out: string; colorsFrom?: string; resume?: boolean }) {
    if (options.source && (options.geometry || options.regions)) throw new Error('Use --source EXPORT or --geometry MAP_DATA/--regions, not both.');
    const geometryPath = options.geometry === 'none' ? undefined : resolve(options.geometry ?? mapDataRoot);
    const hasGeometry = geometryPath && (await exists(resolve(geometryPath, 'manifest.json')) || await exists(resolve(geometryPath, 'manifest.pb')) || isSemanticDataset(geometryPath));
    if (options.geometry && options.geometry !== 'none' && !hasGeometry) throw Error('Missing geometry manifest.');
    const input = options.source ? await realpath(options.source) : hasGeometry ? await realpath(geometryPath!) : undefined;
    const colorsFrom = options.colorsFrom ?? (options.source ? mapDataRoot : 'database');
    const database = !options.source || colorsFrom === 'database' ? await realpath(databasePath('DB_BITMAP', options.db)) : undefined;
    const databaseArgs = database ? ['--db', database] : [];
    const requested = resolve(options.out);
    function validateOutput(out: string) {
        for (const protectedInput of [input, dataRoot, srcRoot, publicRoot, database].filter(Boolean) as string[]) {
            if (out === protectedInput || out.startsWith(protectedInput + sep) || protectedInput.startsWith(out + sep)) throw new Error('Use a separate new output directory.');
        }
        if (out.startsWith(projectRoot + sep) && ![maintenanceRoot, temporaryRoot].some(root=>out.startsWith(root+sep))) throw new Error('Local generation outputs belong under .cache/maintenance/ or .tmp/.');
    }
    validateOutput(requested);
    await mkdir(dirname(requested), { recursive: true });
    const out = resolve(await realpath(dirname(requested)), requested.slice(dirname(requested).length + 1));
    validateOutput(out);
    const previous = await exists(out);
    if (previous && (!options.resume || !previous.isDirectory() || previous.isSymbolicLink())) throw Error('Use a new output directory, or resume its matching checkpoint.');
    if (!previous) await mkdir(out, { recursive: false });
    const guard = database ? await Database.create(database, OPEN_READONLY) : undefined;
    try {
        const info = database ? await stat(database) : undefined;
        const manifestFile = input&&isSemanticDataset(input)?resolve(input,'release.json'):input ? datasetPath(input, await Bun.file(datasetPath(input,'manifest.json')).exists() ? 'manifest.json' : 'manifest.pb') : undefined;
        const identity = { source: options.source, input, inputManifest: manifestFile ? createHash('sha256').update(await Bun.file(manifestFile).bytes()).digest('hex') : undefined,
            database, databaseSize: info?.size, databaseModified: info?.mtimeMs, regions: options.regions ?? 'all', colorsFrom, pipeline: 1 };
        const plan = JSON.stringify(identity), checkpoint = resolve(out, 'generation-checkpoint.json');
        let done: Record<string, string> = {};
        if (previous) {
            const saved = await Bun.file(checkpoint).json();
            if (saved.plan !== plan) throw Error('Generation inputs changed since the checkpoint. Start a new revision.');
            done = saved.done;
        }
        async function save() { const next = checkpoint + '.tmp'; await Bun.write(next, JSON.stringify({ plan, done }, null, 2) + '\n'); await rename(next, checkpoint); }
        await save();
        const digest = async (marker: string) => createHash('sha256').update(await Bun.file(marker).bytes()).digest('hex');
        async function stage(name: string, directory: string, markerName: string, action: () => Promise<unknown>) {
            const marker = resolve(directory, markerName);
            if (done[name]) {
                if (!await Bun.file(marker).exists() || await digest(marker) !== done[name]) throw Error(`Changed generation checkpoint: ${name}`);
                reportGenerationProgress({ kind: 'stage', stage: name, state: 'reused' });
                console.log(`Reusing completed stage: ${name}`); return;
            }
            if (await exists(directory)) await rename(directory, resolve(out, `incomplete-${name}-${randomUUID()}`));
            reportGenerationProgress({ kind: 'stage', stage: name, state: 'started' });
            await action(); done[name] = await digest(marker); await save();
            reportGenerationProgress({ kind: 'stage', stage: name, state: 'complete' });
        }
        const source = options.source ? input! : resolve(out, 'export');
        if (!options.source) await stage('export', source, 'manifest.json', () => runTool('scripts/tools/export-http-packs.ts',
            ['--geometry', input ?? 'none', '--out', source, '--regions', options.regions || 'all', '--format', 'v2', '--validation', 'grid', ...databaseArgs]));
        const chunks = resolve(out, 'chunks'), dimensions = resolve(out, 'dimensions'), data = resolve(out, 'map-data'), paged = resolve(out, 'paged-v8');
        await stage('chunks', chunks, 'manifest.pb', () => generateChunks({ source, out: chunks, format: 'v6', seed: 20261023, chunkSize: 1024, previewTileSize: 16384, previewResolution: 96 }));
        await stage('dimensions', dimensions, 'manifest.pb', () => runTool('scripts/tools/prepare-neighborhood-dimensions.ts', [chunks, dimensions]));
        await stage('spatial', paged, 'manifest.pb', () => runTool('scripts/tools/prepare-spatial-index.ts', [dimensions, paged]));
        const flat = resolve(out, 'flat-v9');
        await stage('huffman', flat, 'manifest.pb', () => prepareHuffmanRle(paged, flat));
        const bitmapChunks = resolve(out, 'neighborhood-chunks');
        await stage('bitmap-chunks', bitmapChunks, 'neighborhood-chunks.json', () => runTool('scripts/tools/prepare-neighborhood-chunks.ts', [flat, bitmapChunks]));
        await mergeArtifacts(bitmapChunks, flat);
        if (colorsFrom !== 'none') {
            const colors = resolve(out, 'colors');
            await stage('colors', colors, 'parcel-colors.json', async () => {
                if (colorsFrom === 'database') await runTool('scripts/tools/export-parcel-means.ts', ['--source', flat, '--out', colors, ...databaseArgs]);
                else await runTool('scripts/tools/prepare-layout-color-summaries.ts', [colorsFrom, flat, colors]);
                await runTool('scripts/generate-size-previews.ts', ['--source', flat, '--summary', colors]);
            });
            await mergeArtifacts(colors, flat);
        }
        const areas = resolve(out, 'area-colors');
        await stage('areas', areas, 'bitmap-area-colors.json', () => generateBitmapAreaColors(flat, areas));
        await mergeArtifacts(areas, flat);
        await stage('organize', data, 'manifest.json', () => organizeMapData(flat, data));
        if (database && !await Bun.file(resolve(data, 'bitmap-reference.json')).exists()) await exportReferenceSnapshot(data, database);
        if(database){
            const analytics=resolve(out,'analytics');await stage('analytics',analytics,'analytics.json',()=>generateAnalytics(data,database,analytics));await installAnalytics(analytics,data);
            const layers=resolve(out,'layer-analysis');await stage('layer-analysis',layers,'layer-analysis.json',()=>generateLayerAnalysis(data,layers));await installLayerAnalysis(layers,data);
        }
        if(database){const lod4=resolve(out,'lod4');await stage('lod4',lod4,'lod4.pb',()=>generateLod4(data,lod4));await installLod4(lod4,data);}
        if(database){const summaries=resolve(out,'lod4-summaries');await stage('lod4-summaries',summaries,'lod4-summary.json',()=>generateLod4Summaries(data,summaries));await installLod4Summaries(summaries,data);}
        if(database){const filters=resolve(out,'parcel-filters');await stage('parcel-filters',filters,'parcel-filters.json',()=>generateParcelFilters(data,filters));await installParcelFilters(filters,data);}
        const report = await Bun.file(resolve(data, 'report.json')).json();
        await Bun.write(resolve(out, 'static-report.json'), JSON.stringify({ status: 'passed', snapshot: report.snapshot, layout: LAYOUT, data, database, colors: colorsFrom !== 'none', colorsFrom }, null, 2) + '\n');
        console.log(`Optimized static data ready: ${data}\nBuild with: bun run build --data ${JSON.stringify(data)}`);
        return data;
    } finally { await guard?.close(); }
}

if (import.meta.main) {
    const options = argumentsFor(process.argv.slice(2), ['--source', '--geometry', '--regions', '--db', '--out', '--colors-from', '--resume']);
    if (options['--resume'] && !['true', 'false'].includes(options['--resume'])) throw Error('--resume must be true or false.');
    if (!options['--out']) throw new Error('Use bun scripts/generate-static.ts --out .cache/maintenance/NEW_REVISION [--db FILE] [--source EXPORT | --geometry MAP_DATA --regions IDS] [--colors-from MAP_DATA|database|none]');
    await generateStatic({ source: options['--source'], geometry: options['--geometry'], regions: options['--regions'], db: options['--db'], out: options['--out'], colorsFrom: options['--colors-from'], resume: options['--resume'] === 'true' });
}
