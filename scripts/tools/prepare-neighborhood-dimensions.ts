import type { FileRef } from '../../src/shared/httpPack';
import { reportGenerationProgress } from '../generation-progress';
// Convert a validated v6 snapshot to v7. Reuses every parcel pack and canonical
// geometry byte; writes only to a new directory. No database/server startup.
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../../package.json', import.meta.url));
const protobuf = require('protobufjs');
import { createProtoCodec, DIMENSIONS_FORMAT, SHUFFLE_FORMAT } from '../../src/shared/protobufChunks.ts';
import { createDimensionsCodec } from '../../src/shared/neighborhoodDimensions.ts';
import { createNeighborhoodLayoutComputer } from '../../src/shared/computeNeighborhoodLayout.ts';
import { createPreviewCodec } from '../../src/shared/heatmapPreview.ts';
import { sha256, check } from '../../src/shared/httpPack.ts';
const codec = createProtoCodec(protobuf), dimensionsCodec = createDimensionsCodec(protobuf);
const compute = createNeighborhoodLayoutComputer(protobuf), previewCodec = createPreviewCodec(protobuf);
const type = protobuf.Root.fromJSON(require('./src/shared/proto/neighborhood_descriptor.json')).lookupType('Neighborhood');

export async function prepareNeighborhoodDimensions(sourceArg: string, outArg: string) {
    const source = await fs.realpath(path.resolve(sourceArg)), out = path.resolve(outArg);
    check(out !== source && !out.startsWith(source + '/') && !source.startsWith(out + '/'), 'Output must be separate from source');
    const manifest = await codec.decodeManifest(await fs.readFile(path.join(source, 'manifest.pb')));
    const prior = JSON.parse(await fs.readFile(path.join(source, 'report.json'), 'utf8'));
    check(manifest.format === SHUFFLE_FORMAT && prior.status === 'passed' && prior.snapshot === manifest.snapshot, 'A validated v6 source is required');
    await fs.mkdir(path.dirname(out), { recursive: true });
    await fs.mkdir(out, { recursive: false });
    const copied = new Set(), regions = [];
    const read = async (ref: FileRef) => {
        check(/^[a-f0-9]{64}\.pb$/.test(ref.url) && ref.url === ref.sha256 + '.pb', 'Invalid immutable artifact');
        const bytes = await fs.readFile(path.join(source, ref.url));
        check(bytes.length === ref.bytes && await sha256(bytes) === ref.sha256, 'Source artifact integrity failure');
        return bytes;
    };
    const copy = async (ref: FileRef) => {
        if (copied.has(ref.url)) return;
        const bytes = await read(ref);
        await fs.writeFile(path.join(out, ref.url), bytes, { flag: 'wx' }); copied.add(ref.url);
    };
    let fullBytes = 0, dimensionBytes = 0;
    for (const region of manifest.regions) {
        const canonical = await read(region.geometry), data = type.decode(canonical);
        check(data.neighborhood === region.id && data.width === region.width && data.height === region.height, 'Source region differs from manifest');
        const dimensions = dimensionsCodec.encode(data), hash = await sha256(dimensions);
        const result = await compute({ job: region.id, dimensions, dimensionsHash: hash,
            expected: { id: region.id, width: region.width, height: region.height, sha256: region.geometry.sha256, bytes: region.geometry.bytes } });
        check(Buffer.from(result.wire).equals(canonical), 'Generated canonical bytes differ');
        const ref = { url: hash + '.pb', sha256: hash, bytes: dimensions.length };
        await fs.writeFile(path.join(out, ref.url), dimensions, { flag: 'wx' });
        await copy(region.geometry);
        regions.push({ ...region, dimensions: ref });
        reportGenerationProgress({ kind: 'neighborhood', phase: 'Neighborhood dimensions', id: region.id, completed: regions.length, total: manifest.regions.length, action: 'created' });
        fullBytes += canonical.length; dimensionBytes += dimensions.length;
        if (regions.length % 32 === 0 || regions.length === manifest.regions.length) console.log(JSON.stringify({ dimensionsValidated: regions.length, total: manifest.regions.length }));
    }
    for (const chunk of manifest.chunks) for (const pack of chunk.packs) await copy(pack);
    const next = { ...manifest, format: DIMENSIONS_FORMAT, regions, snapshot: '' };
    next.snapshot = await sha256(codec.encodeManifest(next, false));
    await codec.decodeManifest(codec.encodeManifest(next));
    let previewTiles = 0;
    const preview = await fs.readFile(path.join(source, 'preview.pb')).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (preview) {
        const index = await previewCodec.decodeIndex(preview, manifest.snapshot);
        for (const tile of index.tiles) await copy(tile);
        index.sourceSnapshot = next.snapshot; index.snapshot = '';
        index.snapshot = await sha256(previewCodec.encodeIndex(index, false));
        await fs.writeFile(path.join(out, 'preview.pb'), previewCodec.encodeIndex(index), { flag: 'wx' });
        previewTiles = index.tiles.length;
    }
    const report = { status: 'passed', snapshot: next.snapshot, sourceSnapshot: manifest.snapshot, format: DIMENSIONS_FORMAT,
        sample: next.parcelRegions.length !== regions.length, 
        neighborhoods: regions.length, bitmaps: regions.length * 2016, differences: 0, canonicalBytesIdentical: true,
        canonicalGeometryBytes: fullBytes, dimensionsBytes: dimensionBytes, reduction: 1 - dimensionBytes / fullBytes,
        reusedPacks: manifest.chunks.reduce((n, c) => n + c.packs.length, 0), reusedPreviewTiles: previewTiles,
        validation: 'All dimensions round-tripped and computed layouts hashed and byte-compared to canonical geometry; every copied source artifact hash checked; source parcel coverage reused without recomputing parcels.' };
    await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    await fs.writeFile(path.join(out, 'manifest.pb.tmp'), codec.encodeManifest(next), { flag: 'wx' });
    await fs.rename(path.join(out, 'manifest.pb.tmp'), path.join(out, 'manifest.pb'));
    console.log(JSON.stringify(report)); return report;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
    const [source, out, extra] = process.argv.slice(2);
    if (!source || !out || extra) throw Error('Usage: node scripts/prepare-neighborhood-dimensions.ts SOURCE_V6 NEW_OUT');
    await prepareNeighborhoodDimensions(source, out);
}
