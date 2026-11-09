import { DATA_STORAGE, dataPath } from '../src/shared/dataStorage';
import { test, expect } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import protobuf from 'protobufjs';
import { openPublishedMap } from './published-map';
import { createProtoCodec, type ProtoManifest } from '../src/shared/protobufChunks';
import { HUFFMAN_FORMAT, LAYOUT, sha256 } from '../src/shared/httpPack';
import descriptor from '../src/shared/proto/neighborhood_descriptor.json';

test('maintenance reads authenticated published geometry and rejects corrupt files and changing manifests', async () => {
    for (const storage of [undefined, DATA_STORAGE]) {
        const root = await mkdtemp('/tmp/bitmap-published-map-');
        try {
            const bitmaps = Array.from({ length: 2016 }, (_, i) => ({ x: i, y: 0, width: 1, height: 1 }));
            const bytes = protobuf.Root.fromJSON(descriptor).lookupType('Neighborhood').encode({ neighborhood: 0, width: 2016, height: 1, bitmaps }).finish();
            const hash = await sha256(bytes), geometry = { url: dataPath(storage,'geometry',hash+'.pb'), sha256: hash, bytes: bytes.length };
            await Bun.write(resolve(root, geometry.url), bytes);
            const ref = { url: 'a'.repeat(64) + '.pb', sha256: 'a'.repeat(64), bytes: 1 };
            const body: ProtoManifest = { ...(storage ? {storageLayout:storage} : {}), format: HUFFMAN_FORMAT, layout: LAYOUT, 
                publishedHeight: 2015, regions: [{ id: 0, x: 0, y: 0, width: 2016, height: 1, geometry, descriptor: geometry, dimensions: ref, coverage: 'complete' }],
                grid: { size: 1024, originX: 0, originY: 0, ownership: 'top-left' }, chunks: [], parcelRegions: [0],
                indexPages: [{ ...ref, x: 0, y: 0, records: 2016, chunks: 1 }], indexPageSide: 8, shuffleSeed: 20261023, packBytes: 524288, frameBytes: 16384, snapshot: '' };
            const codec = createProtoCodec(protobuf);
            body.snapshot = await sha256(codec.encodeManifest(body, false));
            await Bun.write(resolve(root, 'manifest.pb'), codec.encodeManifest(body));
            const source = await openPublishedMap(root);
            expect(source.manifest.storageLayout).toBe(storage);
            const invalid = {...body,storageLayout:'unsupported-storage',snapshot:''};
            invalid.snapshot=await sha256(codec.encodeManifest(invalid,false));
            await expect(codec.decodeManifest(codec.encodeManifest(invalid))).rejects.toThrow('storage layout');
            expect(source.neighborhood(0).data.bitmaps.map(({ x, y, width, height }) => ({ x, y, width, height }))).toEqual(bitmaps);
            expect(() => source.neighborhood(-1)).toThrow('Invalid neighborhood');
            expect(() => source.neighborhood(1)).toThrow('Invalid neighborhood');
            await Bun.write(resolve(root, geometry.url), new Uint8Array([0]));
            expect(() => source.neighborhood(0)).toThrow('Geometry integrity failure');
            await Bun.write(resolve(root, 'manifest.pb'), new Uint8Array([0]));
            expect(() => source.assertUnchanged()).toThrow('manifest changed');
            await expect(openPublishedMap(root)).rejects.toThrow();
        } finally { await rm(root, { recursive: true, force: true }); }
    }
});
