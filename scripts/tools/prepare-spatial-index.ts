import type { FileRef } from '../../src/shared/httpPack';
import { reportGenerationProgress } from '../generation-progress';
import type { ProtoManifest, ProtoChunk } from '../../src/shared/protobufChunks';
// Shard only the chunk/pack index of a validated v7 snapshot. Existing geometry,
// dimensions, parcels and preview tiles are copied without regeneration.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
const require = createRequire(new URL('../../package.json', import.meta.url));
import { createProtoCodec, DIMENSIONS_FORMAT, PAGED_FORMAT, INDEX_PAGE_BYTES } from '../../src/shared/protobufChunks.ts';
import { createPreviewCodec } from '../../src/shared/heatmapPreview.ts';
import { sha256 } from '../../src/shared/httpPack.ts';
const codec = createProtoCodec(require('protobufjs')), previews = createPreviewCodec(require('protobufjs'));

export async function prepareSpatialIndex(sourceArg: string, outArg: string) {
    const source = await fs.realpath(path.resolve(sourceArg)), out = path.resolve(outArg);
    assert(out !== source && !out.startsWith(source + '/') && !source.startsWith(out + '/'), 'Output must be separate');
    const originalBytes = await fs.readFile(path.join(source, 'manifest.pb'));
    const manifest = await codec.decodeManifest(originalBytes);
    const prior = JSON.parse(await fs.readFile(path.join(source, 'report.json'), 'utf8'));
    assert(manifest.format === DIMENSIONS_FORMAT && prior.status === 'passed' && prior.snapshot === manifest.snapshot, 'Validated v7 source required');
    await fs.mkdir(path.dirname(out), { recursive: true }); await fs.mkdir(out, { recursive: false });
    const copied = new Set();
    const copy = async (ref: FileRef) => {
        if (copied.has(ref.url)) return;
        assert(/^[a-f0-9]{64}\.pb$/.test(ref.url) && ref.url === ref.sha256 + '.pb');
        const bytes = await fs.readFile(path.join(source, ref.url));
        assert(bytes.length === ref.bytes && await sha256(bytes) === ref.sha256, 'Source artifact integrity failure');
        await fs.writeFile(path.join(out, ref.url), bytes, { flag: 'wx' }); copied.add(ref.url);
    };
    const next: ProtoManifest & {indexPages: NonNullable<ProtoManifest['indexPages']>} = { ...manifest, format: PAGED_FORMAT, chunks: [], indexPageSide: 8, indexPages: [], snapshot: '' };
    const groups = new Map<string,{x:number;y:number;chunks:ProtoChunk[]}>();
    for (const chunk of manifest.chunks) {
        const x = Math.floor(chunk.x / 8), y = Math.floor(chunk.y / 8), key = `${x},${y}`;
        if (!groups.has(key)) groups.set(key, { x, y, chunks: [] });
        groups.get(key)!.chunks.push(chunk);
    }
    for (const { x, y, chunks } of [...groups.values()].sort((a, b) => a.y - b.y || a.x - b.x)) {
        const bytes = codec.encodeIndexPage(chunks, x, y, next), hash = await sha256(bytes);
        assert(bytes.length <= INDEX_PAGE_BYTES, 'Spatial page exceeds budget');
        const ref = { x, y, url: hash + '.pb', sha256: hash, bytes: bytes.length, chunks: chunks.length, records: chunks.reduce((n, c) => n + c.records, 0) };
        assert.deepEqual(codec.decodeIndexPage(bytes, ref, next), chunks);
        next.indexPages.push(ref); await fs.writeFile(path.join(out, ref.url), bytes, { flag: 'wx' });
        reportGenerationProgress({ kind: 'units', phase: 'Spatial index', unit: 'Pages written', completed: next.indexPages.length, total: groups.size });
    }
    for (const region of manifest.regions) { await copy(region.geometry); await copy(region.dimensions!); }
    for (const chunk of manifest.chunks) for (const pack of chunk.packs) await copy(pack);
    next.snapshot = await sha256(codec.encodeManifest(next, false));
    const bytes = codec.encodeManifest(next); await codec.decodeManifest(bytes);
    const preview = await fs.readFile(path.join(source, 'preview.pb')).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (preview) {
        const index = await previews.decodeIndex(preview, manifest.snapshot);
        for (const ref of index.tiles) await copy(ref);
        index.sourceSnapshot = next.snapshot; index.snapshot = await sha256(previews.encodeIndex(index, false));
        await fs.writeFile(path.join(out, 'preview.pb'), previews.encodeIndex(index), { flag: 'wx' });
    }
    const report = { status: 'passed', format: PAGED_FORMAT, snapshot: next.snapshot, sourceSnapshot: manifest.snapshot,
        sample: manifest.parcelRegions.length !== manifest.regions.length, neighborhoods: manifest.regions.length,
        bitmaps: manifest.publishedHeight + 1, chunks: manifest.chunks.length, pages: next.indexPages.length,
        oldManifestBytes: originalBytes.length, manifestBytes: bytes.length,
        indexBytes: next.indexPages.reduce((n, p) => n + p.bytes, 0), maxIndexBytes: Math.max(...next.indexPages.map(p => p.bytes)),
        unchanged: 'All geometry/dimensions/parcel/preview tile hashes; world positions; every chunk pack/membership compared after page round-trip. No Mondrian or parcel generation.' };
    await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    await fs.writeFile(path.join(out, 'manifest.pb.tmp'), bytes, { flag: 'wx' }); await fs.rename(path.join(out, 'manifest.pb.tmp'), path.join(out, 'manifest.pb'));
    console.log(JSON.stringify(report)); return report;
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
    const [source, out, extra] = process.argv.slice(2);
    if (!source || !out || extra) throw Error('Usage: node scripts/prepare-spatial-index.ts SOURCE_V7 NEW_OUT');
    await prepareSpatialIndex(source, out);
}
