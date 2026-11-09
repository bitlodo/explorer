import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prepareNeighborhoodDimensions } from '../scripts/tools/prepare-neighborhood-dimensions.ts';
import { fixture, codec, SHUFFLE_FORMAT, protobuf } from './neighborhood-dimensions-fixture.mjs';
import { loadShared } from './helpers/load-shared.ts';
const { sha256 } = await loadShared('../../src/shared/httpPack.ts');

test('the packed dimensions schema matches the published v7 bytes', async () => {
    const { files, manifest, data } = await fixture();
    const root = protobuf.parse(await fs.readFile(new URL('../src/shared/proto/neighborhood_dimensions.proto', import.meta.url), 'utf8')).root;
    const bytes = root.lookupType('bitmap.neighborhood.Dimensions').encode({ version: 1, id: 0, width: data.width, height: data.height, sizes: data.bitmaps.flatMap(r => [r.width, r.height]) }).finish();
    assert.deepEqual(new Uint8Array(bytes), files.get(manifest.regions[0].dimensions.url));
});

test('offline converter reuses v6 parcels/canonical bytes and refuses overwrites or corrupt input before publishing a manifest', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'neighborhood-dimensions-'));
    try {
        const { files, manifest } = await fixture(), source = path.join(tmp, 'source'), out = path.join(tmp, 'v7');
        manifest.format = SHUFFLE_FORMAT; delete manifest.regions[0].dimensions;
        manifest.snapshot = await sha256(codec.encodeManifest(manifest, false)); files.set('manifest.pb', codec.encodeManifest(manifest));
        await fs.mkdir(source);
        for (const [name, bytes] of files) await fs.writeFile(path.join(source, name), bytes);
        await fs.writeFile(path.join(source, 'report.json'), JSON.stringify({ status: 'passed', snapshot: manifest.snapshot, sample: false }));
        const report = await prepareNeighborhoodDimensions(source, out), next = await codec.decodeManifest(await fs.readFile(path.join(out, 'manifest.pb')));
        assert.equal(report.neighborhoods, 1); assert.equal(report.canonicalBytesIdentical, true);
        assert.deepEqual(next.chunks, manifest.chunks); assert.deepEqual(next.regions.map(r => [r.x, r.y, r.width, r.height]), manifest.regions.map(r => [r.x, r.y, r.width, r.height]));
        for (const ref of [...manifest.regions.map(r => r.geometry), ...manifest.chunks.flatMap(c => c.packs)]) assert.deepEqual(await fs.readFile(path.join(out, ref.url)), await fs.readFile(path.join(source, ref.url)));
        await assert.rejects(() => prepareNeighborhoodDimensions(source, out), /EEXIST/);
        const ref = manifest.chunks[0].packs[0], bytes = files.get(ref.url).slice(); bytes[0] ^= 1;
        await fs.writeFile(path.join(source, ref.url), bytes);
        const corrupt = path.join(tmp, 'corrupt'); await assert.rejects(() => prepareNeighborhoodDimensions(source, corrupt), /integrity/);
        await assert.rejects(() => fs.access(path.join(corrupt, 'manifest.pb')), { code: 'ENOENT' });
    } finally { await fs.rm(tmp, { recursive: true, force: true }); }
});
