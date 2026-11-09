import {datasetPath} from './dataset-path';
import {buildParcelSegments} from './parcel-segments';
import { generateLod4 } from './generate-lod4';
import { generateLod4Summaries, installLod4Summaries } from './generate-lod4-summaries';
import { generateParcelFilters, installParcelFilters } from './generate-parcel-filters';
import { installLod4 } from './install-lod4';
import { mkdir, readdir, realpath, link, copyFile, constants, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import protobuf from 'protobufjs';
import { Database, OPEN_READONLY } from './duckdb';
import { openPublishedMap } from './published-map';
import { readArtifact, readReferenceSnapshot, writeReferencePatterns } from './reference-snapshot';
import { createProtoCodec, type ProtoChunk, type ProtoManifest } from '../src/shared/protobufChunks';
import { createDimensionsCodec } from '../src/shared/neighborhoodDimensions';
import { encodeSizes, encodeAdaptiveSizes, decodeSizes, HUFFMAN_FORMAT, LAYOUT, chunkAt, type FileRef, type ParcelRecord } from '../src/shared/httpPack';
import SpiralLayout from '../src/shared/SpiralLayout';
import { databaseNeighborhood } from './database-neighborhood';
import { recordBytes } from './generate-chunks';
import { generatePreviews } from './generate-previews';
import { generateBitmapAreaColors } from './generate-bitmap-area-colors';
import { organizeMapData } from './organize-map-data';
import { generateAnalytics, installAnalytics } from './generate-analytics';
import { generateLayerAnalysis, installLayerAnalysis } from './generate-layer-analysis';
import { argumentsFor, runTool } from './cli';
import { reportGenerationProgress } from './generation-progress';
import { encodeParcelMeans, decodeParcelMeans, PARCEL_MEANS_PROTO } from '../src/shared/parcelMeans';
import { dataPath } from '../src/shared/dataStorage';
import { publicRoot, srcRoot, dataRoot, projectRoot, maintenanceRoot, temporaryRoot } from './paths';
import { validatePayloadBounds } from './tools/export-validation';

const codec = createProtoCodec(protobuf), dimensionsCodec = createDimensionsCodec(protobuf);
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Append complete neighborhoods; published history comes from Protobufs, and only new rows come from the database. */
export async function updateStatic(options: { source: string; database: string; out: string }) {
    const source = await openPublishedMap(options.source), old = source.manifest;
    if (old.format !== HUFFMAN_FORMAT || old.layout !== LAYOUT || old.parcelRegions.length !== old.regions.length)
        throw Error('Incremental generation requires a complete official v9 dataset. Use --mode restart.');
    const out = resolve(options.out), database = await realpath(options.database);
    for (const input of [source.root, database, publicRoot, srcRoot, dataRoot])
        if (out === input || out.startsWith(input + sep) || input.startsWith(out + sep)) throw Error('Use a separate new update output.');
    if (out.startsWith(projectRoot + sep) && ![maintenanceRoot,temporaryRoot].some(root=>out.startsWith(root+sep))) throw Error('Local outputs belong under .cache/maintenance/ or .tmp/.');
    await mkdir(dirname(out), { recursive: true });
    if (await realpath(dirname(out)) !== dirname(out)) throw Error('Update output cannot traverse symlinks.');
    await mkdir(out, { recursive: false });
    const flat = resolve(out, 'flat-update'); await mkdir(flat);
    const db = await Database.create(database, OPEN_READONLY);
    try {
        await db.exec("SET memory_limit='512MB'; SET threads=1; BEGIN TRANSACTION");
        const meta = (await db.all('SELECT min(bitmap) AS first,max(bitmap) AS last,count(*)::INTEGER AS records FROM bitmaps'))[0]!;
        const count = Math.floor((Number(meta.last) + 1) / 2016), publishedHeight = count * 2016 - 1;
        if (meta.first !== 0 || meta.records !== Number(meta.last) + 1 || count < old.regions.length) throw Error('The bitmap reference lost published rows.');
        if (count === old.regions.length) throw Error('No new complete neighborhoods to append.');
        const changed = new Set<number>();
        for (let id = old.regions.length; id < count; id++) changed.add(id);
        const copied = new Set<string>();
        async function copy(ref: FileRef) {
            const url = basename(ref.url);
            if (!copied.has(url)) {
                await readArtifact(source.root, ref);
                try { await link(datasetPath(source.root, ref.url), resolve(flat, url)); }
                catch (error: any) {
                    if (error.code !== 'EXDEV' && error.code !== 'EPERM') throw error;
                    await copyFile(datasetPath(source.root, ref.url), resolve(flat, url), constants.COPYFILE_EXCL);
                }
                copied.add(url);
            }
            return { ...ref, url };
        }
        async function put(bytes: Uint8Array) {
            const sha256 = hash(bytes), url = sha256 + '.pb';
            if (!copied.has(url)) { await writeFile(resolve(flat, url), bytes, { flag: 'wx' }); copied.add(url); }
            return { url, sha256, bytes: bytes.length };
        }
        const regions: ProtoManifest['regions'] = [], geometry: Awaited<ReturnType<typeof databaseNeighborhood>>['data'][] = [];
        for (let id = 0; id < count; id++) {
            if (id < old.regions.length) {
                const existing = source.neighborhood(id), region = old.regions[id]; geometry.push(existing.data);
                const ref = await copy(region.geometry);
                regions.push({ ...region, geometry: ref, descriptor: ref, dimensions: await copy(region.dimensions!) });
            } else {
                const next = await databaseNeighborhood(db, id), ref = await put(next.bytes); geometry.push(next.data);
                regions.push({ id, x: 0, y: 0, width: next.data.width, height: next.data.height,
                    geometry: ref, descriptor: ref, dimensions: await put(dimensionsCodec.encode(next.data)), coverage: 'complete' });
                reportGenerationProgress({ kind: 'neighborhood', phase: 'New neighborhood geometry', id, completed: id - old.regions.length + 1,
                    total: count - old.regions.length, action: 'created' });
            }
        }
        const layout = new SpiralLayout(regions);
        for (const region of regions) {
            const position = layout.slots[region.id];
            if (region.id < old.regions.length && (old.regions[region.id].x !== position.x || old.regions[region.id].y !== position.y))
                throw Error('Published world positions differ from the official layout. Use --mode restart.');
            region.x = position.x; region.y = position.y;
        }
        const oldChunks = new Map<string, ProtoChunk>();
        for (const page of old.indexPages!) for (const chunk of codec.decodeIndexPage(await readArtifact(source.root, page), page, old)) oldChunks.set(`${chunk.x},${chunk.y}`, chunk);
        const groups = new Map<string, { x: number; y: number; ids: number[]; dirty: boolean }>();
        for (const region of regions) geometry[region.id].bitmaps.forEach((rect, index) => {
            const id = region.id * 2016 + index, cell = chunkAt(region.x + rect.x, region.y + rect.y, old.grid!.size), key = `${cell.x},${cell.y}`;
            let group = groups.get(key); if (!group) { group = { ...cell, ids: [], dirty: false }; groups.set(key, group); }
            group.ids.push(id); group.dirty ||= changed.has(region.id);
        });
        const chunks: ProtoChunk[] = []; let rebuilt = 0, reused = 0, rowsRead = 0;
        for (const [key, group] of groups) {
            const previous = oldChunks.get(key);
            if (previous && !group.dirty && previous.records === group.ids.length) {
                const packs = [];
                for (const pack of previous.packs) packs.push({ ...pack, ...await copy(pack) });
                chunks.push({ ...previous, packs }); reused++;
            } else {
                const records: ParcelRecord[] = [];
                if (previous) for (const pack of previous.packs) {
                    const bytes = await readArtifact(source.root, pack);
                    async function* input() { yield bytes; }
                    for await (const record of codec.parsePack(input(), pack)) records.push(encodeSizes(record.id, decodeSizes(record)));
                }
                const added = group.ids.filter(id => id > old.publishedHeight);
                for (let start = 0; start < added.length; start += 128) {
                    const ids = added.slice(start, start + 128);
                    const rows = await db.all(`SELECT bitmap,tx FROM bitmaps WHERE bitmap IN (${ids.join(',')}) ORDER BY bitmap`);
                    if (rows.length !== ids.length || rows.some((row, index) => row.bitmap !== ids[index])) throw Error('Missing bitmap in an updated chunk.');
                    for (const row of rows) {
                        validatePayloadBounds(row.tx, geometry[Math.floor(row.bitmap / 2016)].bitmaps[row.bitmap % 2016], row.bitmap);
                        records.push(encodeSizes(row.bitmap, row.tx));
                    }
                    rowsRead += rows.length;
                }
                records.sort((a, b) => a.id - b.id);
                if (records.length !== group.ids.length || records.some((record, index) => record.id !== group.ids[index])) throw Error('Updated chunk membership differs.');
                const digest = createHash('sha256'); for (const record of records) digest.update(recordBytes(record));
                const packs:ProtoChunk['packs']=[];
                for(const built of await buildParcelSegments(records,group.x,group.y,old.shuffleSeed!,old.frameBytes!,old.packBytes))packs.push({...built.descriptor,...await put(built.wire)});
                chunks.push({ x: group.x, y: group.y, records: records.length, lastHeight: records.at(-1)!.id, recordDigest: digest.digest('hex'), packs }); rebuilt++;
            }
            oldChunks.delete(key);
            reportGenerationProgress({ kind: 'units', phase: 'Updating parcel chunks', unit: `Chunks ready (${reused} reused, ${rebuilt} rebuilt)`, completed: chunks.length, total: groups.size });
        }
        if (oldChunks.size) throw Error('Published chunk ownership was lost.');
        const next: ProtoManifest = { ...old, storageLayout: undefined, publishedHeight, regions,
            parcelRegions: regions.map(region => region.id), chunks: [], indexPages: [], snapshot: '' };
        const pages = new Map<string, { x: number; y: number; chunks: ProtoChunk[] }>();
        for (const chunk of chunks) {
            const x = Math.floor(chunk.x / old.indexPageSide!), y = Math.floor(chunk.y / old.indexPageSide!), key = `${x},${y}`;
            if (!pages.has(key)) pages.set(key, { x, y, chunks: [] }); pages.get(key)!.chunks.push(chunk);
        }
        for (const page of [...pages.values()].sort((a, b) => a.y - b.y || a.x - b.x)) {
            const bytes = codec.encodeIndexPage(page.chunks, page.x, page.y, next);
            const ref = { ...await put(bytes), x: page.x, y: page.y, chunks: page.chunks.length, records: page.chunks.reduce((sum, chunk) => sum + chunk.records, 0) };
            codec.decodeIndexPage(bytes, ref, next); next.indexPages!.push(ref);
        }
        next.snapshot = hash(codec.encodeManifest(next, false));
        await writeFile(resolve(flat, 'manifest.pb'), codec.encodeManifest(next));
        const report = { status: 'passed', snapshot: next.snapshot, sourceSnapshot: old.snapshot, sample: false,
            records: publishedHeight + 1, incremental: true, newNeighborhoods: [...changed], reusedChunks: reused, rebuiltChunks: rebuilt, databaseRowsRead: rowsRead };
        await writeFile(resolve(flat, 'report.json'), JSON.stringify(report, null, 2) + '\n');
        await generatePreviews({ source: flat });
        const vectors = resolve(out, 'vectors');
        await runTool('scripts/tools/prepare-neighborhood-chunks.ts', [flat, vectors]);
        async function merge(directory: string) { for (const name of await readdir(directory)) {
            const destination = resolve(flat, name);
            if (!await Bun.file(destination).exists()) await copyFile(resolve(directory, name), destination, constants.COPYFILE_EXCL);
        } }
        await merge(vectors);
        const means = new Float32Array(publishedHeight + 1), priorColors = await Bun.file(datasetPath(source.root, 'parcel-colors.json')).json();
        if (priorColors.sourceSnapshot !== old.snapshot || priorColors.count !== old.publishedHeight + 1) throw Error('Published parcel means mismatch.');
        means.set(decodeParcelMeans(await readArtifact(source.root, { ...priorColors.means, url: dataPath(old.storageLayout, 'colors', priorColors.means.url) }), priorColors.count, priorColors.format));
        for (const id of [...changed].sort((a, b) => a - b)) {
            const rows = await db.all('SELECT bitmap,list_avg(tx) AS mean FROM bitmaps WHERE bitmap>=? AND bitmap<? ORDER BY bitmap', id * 2016, (id + 1) * 2016);
            if (rows.length !== 2016 || rows.some((row, index) => row.bitmap !== id * 2016 + index || !Number.isFinite(row.mean) || row.mean < 1 || row.mean > 15)) throw Error('Invalid updated parcel mean.');
            for (const row of rows) means[row.bitmap] = row.mean;
        }
        const colors = resolve(out, 'colors'); await mkdir(colors);
        const bytes = encodeParcelMeans(means), sha256 = hash(bytes), url = sha256 + '.pb';
        await writeFile(resolve(colors, url), bytes);
        await writeFile(resolve(colors, 'parcel-colors.json'), JSON.stringify({ format: PARCEL_MEANS_PROTO, sourceSnapshot: next.snapshot, count: means.length,
            means: { url, sha256, bytes: bytes.length }, preview: 'parcel-size-preview.pb' }) + '\n');
        await runTool('scripts/generate-size-previews.ts', ['--source', flat, '--summary', colors]); await merge(colors);
        const areas = resolve(out, 'areas'); await generateBitmapAreaColors(flat, areas); await merge(areas);
        source.assertUnchanged();
        const reference = await readReferenceSnapshot(source.root, old.snapshot, old.publishedHeight + 1);
        if (!reference) throw Error('The published dataset has no database restoration metadata. Use --mode restart.');
        const additions = await db.all('SELECT bitmap,pattern FROM bitmaps WHERE bitmap>? AND bitmap<=? ORDER BY bitmap', old.publishedHeight, publishedHeight);
        if (additions.length !== publishedHeight - old.publishedHeight || additions.some((row, index) => row.bitmap !== old.publishedHeight + 1 + index)) throw Error('Missing new reference patterns.');
        const data = resolve(out, 'map-data'); await organizeMapData(flat, data);
        await writeReferencePatterns(data, (await openPublishedMap(data)).manifest.snapshot, [...reference.patterns, ...additions.map(row => Number(row.pattern))]);
        // Old transaction content comes from authenticated inspection addons. Databases
        // used for incremental updates need only contain the newly appended rows.
        if(await Bun.file(datasetPath(source.root,'analytics.json')).exists()){
            const analytics=resolve(out,'analytics');await generateAnalytics(data,database,analytics,source.root);await installAnalytics(analytics,data);
            const layers=resolve(out,'layer-analysis');await generateLayerAnalysis(data,layers);await installLayerAnalysis(layers,data);
        }
        if(await Bun.file(resolve(data,'layer-analysis.json')).exists()){const lod4=resolve(out,'lod4');await generateLod4(data,lod4);await installLod4(lod4,data);}
        if(await Bun.file(resolve(data,'metrics.json')).exists()){const summaries=resolve(out,'lod4-summaries');await generateLod4Summaries(data,summaries);await installLod4Summaries(summaries,data);}
        if(await Bun.file(resolve(data,'lod4-summary.json')).exists()){const filters=resolve(out,'parcel-filters');await generateParcelFilters(data,filters);await installParcelFilters(filters,data);}
        await writeFile(resolve(out, 'update-complete.json'), JSON.stringify({ sourceSnapshot: old.snapshot, snapshot: (await openPublishedMap(data)).manifest.snapshot }) + '\n', { flag: 'wx' });
        return data;
    } finally { try { await db.exec('ROLLBACK'); } finally { await db.close(); } }
}

if (import.meta.main) {
    const args = argumentsFor(process.argv.slice(2), ['--source', '--db', '--out']);
    if (!args['--source'] || !args['--db'] || !args['--out']) throw Error('Use --source MAP_DATA --db FILE --out NEW_OUTPUT');
    await updateStatic({ source: args['--source'], database: args['--db'], out: args['--out'] });
}
