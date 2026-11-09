import fs from 'node:fs';
import { createRequire } from 'node:module';
import { loadShared } from './helpers/load-shared.ts';

const require = createRequire(new URL('../package.json', import.meta.url));
export const protobuf = require('protobufjs');
export const { createProtoCodec, DIMENSIONS_FORMAT, SHUFFLE_FORMAT } = await loadShared('../../src/shared/protobufChunks.ts');
export const { createDimensionsCodec } = await loadShared('../../src/shared/neighborhoodDimensions.ts');
const { createNeighborhoodLayoutComputer } = await loadShared('../../src/shared/computeNeighborhoodLayout.ts');
const { default: MondrianLayout } = await loadShared('../../src/shared/MondrianLayout.ts');
const { chunkAt, sha256, encodeSizes, LAYOUT } = await loadShared('../../src/shared/httpPack.ts');
export const codec = createProtoCodec(protobuf), dimensionCodec = createDimensionsCodec(protobuf);
export const compute = createNeighborhoodLayoutComputer(protobuf);
export const regionType = protobuf.Root.fromJSON(JSON.parse(fs.readFileSync(new URL('../src/shared/proto/neighborhood_descriptor.json', import.meta.url)))).lookupType('Neighborhood');

export async function fixture() {
    const files = new Map();
    const ref = async bytes => { const hash = await sha256(bytes), url = hash + '.pb'; files.set(url, bytes); return { url, sha256: hash, bytes: bytes.length }; };
    const layout = new MondrianLayout(Array.from({ length: 2016 }, () => [1, 1]));
    const data = { neighborhood: 0, width: layout.width, height: layout.height, bitmaps: layout.slots };
    const canonical = new Uint8Array(regionType.encode(data).finish()), geometry = await ref(canonical);
    const dimensions = await ref(dimensionCodec.encode(data));
    const region = { id: 0, width: data.width, height: data.height, x: -data.width / 2, y: -data.height / 2, geometry, descriptor: geometry, dimensions, coverage: 'complete' };
    const grouped = new Map();
    data.bitmaps.forEach((r, id) => {
        const c = chunkAt(region.x + r.x, region.y + r.y, 1024), key = `${c.x},${c.y}`;
        if (!grouped.has(key)) grouped.set(key, { ...c, input: [] });
        grouped.get(key).input.push(encodeSizes(id, [1]));
    });
    const chunks = [];
    for (const { x, y, input } of grouped.values()) {
        const built = await codec.buildChainedPack(input.slice().reverse(), x, y, 1024, 6);
        chunks.push({ x, y, records: input.length, lastHeight: input.at(-1).id, recordDigest: '0'.repeat(64), packs: [{ ...built.descriptor, ...await ref(built.wire) }] });
    }
    const manifest = { format: DIMENSIONS_FORMAT, shuffleSeed: 20261023, layout: LAYOUT, publishedHeight: 2015, snapshot: '', grid: { size: 1024, originX: 0, originY: 0, ownership: 'top-left' }, packBytes: 524288, regions: [region], chunks, parcelRegions: [0] };
    manifest.snapshot = await sha256(codec.encodeManifest(manifest, false)); files.set('manifest.pb', codec.encodeManifest(manifest));
    const request = { job: 1, dimensions: new Uint8Array(files.get(dimensions.url)), dimensionsHash: dimensions.sha256,
        expected: { id: 0, width: data.width, height: data.height, sha256: geometry.sha256, bytes: geometry.bytes } };
    return { files, manifest, data, canonical, request };
}

export class FakeWorker {
    constructor() { this.messages = []; this.terminated = false; }
    postMessage(request, transfer) { this.request = structuredClone(request, { transfer }); this.messages.push(this.request); }
    async complete() {
        try { const result = await compute(this.request); this.onmessage?.({ data: structuredClone(result, { transfer: [result.wire.buffer] }) }); }
        catch (error) { this.onmessage?.({ data: { job: this.request.job, error: error.message } }); }
    }
    terminate() { this.terminated = true; }
}
