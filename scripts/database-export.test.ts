import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import protobuf from 'protobufjs';
import { Database } from './duckdb';
import { bitmapGeometry } from './bitmap-reference';
import { databaseNeighborhood } from './database-neighborhood';
import { databasePath } from './db-config';
import { bitmapDatabasePath, projectRoot } from './paths';
import { createProtoCodec, type ProtoManifest } from '../src/shared/protobufChunks';
import { HUFFMAN_FORMAT, LAYOUT, sha256, parsePack, decodeSizes } from '../src/shared/httpPack';

test('bitmap source defaults to the synced reference and honors explicit paths before environment overrides', () => {
    const previous = process.env.DB_BITMAP;
    try {
        delete process.env.DB_BITMAP;
        expect(databasePath('DB_BITMAP')).toBe(bitmapDatabasePath);
        process.env.DB_BITMAP = './other-reference.duck';
        expect(databasePath('DB_BITMAP')).toBe(resolve(projectRoot, 'other-reference.duck'));
        expect(databasePath('DB_BITMAP', '/tmp/explicit-bitmaps.db')).toBe('/tmp/explicit-bitmaps.db');
    } finally {
        if (previous === undefined) delete process.env.DB_BITMAP;
        else process.env.DB_BITMAP = previous;
    }
});

test('native reference export preserves parcel indices and rejects invalid dimensions, changed bounds and gaps before publishing a manifest', async () => {
    const temp = await mkdtemp('/tmp/bitmap-reference-export-'), databaseFile = resolve(temp, 'reference.db');
    const geometryRoot = resolve(temp, 'geometry'), tx = [5, 1, 2, 5], size = bitmapGeometry(tx).size;
    let db: Database | undefined;
    try {
        db = await Database.create(databaseFile);
        await db.exec(`CREATE TABLE bitmaps AS SELECT i::UINTEGER AS bitmap, ${JSON.stringify(tx)}::UTINYINT[] AS tx,
            ${JSON.stringify(size)}::UINTEGER[] AS size, 0::BIGINT AS pattern FROM range(4033) AS t(i)`);
        const canonical = await databaseNeighborhood(db, 0);
        const hash = await sha256(canonical.bytes), geometry = { url: hash + '.pb', sha256: hash, bytes: canonical.bytes.length };
        await Bun.write(resolve(geometryRoot, geometry.url), canonical.bytes);
        const ref = { url: 'a'.repeat(64) + '.pb', sha256: 'a'.repeat(64), bytes: 1 };
        const body: ProtoManifest = {
            format: HUFFMAN_FORMAT, layout: LAYOUT, publishedHeight: 2015,
            regions: [{ id: 0, x: 0, y: 0, width: canonical.data.width, height: canonical.data.height, geometry, descriptor: geometry, dimensions: ref, coverage: 'complete' }],
            grid: { size: 1024, originX: 0, originY: 0, ownership: 'top-left' }, chunks: [], parcelRegions: [0],
            indexPages: [{ ...ref, x: 0, y: 0, records: 2016, chunks: 1 }], indexPageSide: 8, shuffleSeed: 20261023,
            packBytes: 524288, frameBytes: 16384, snapshot: '',
        };
        const codec = createProtoCodec(protobuf);
        body.snapshot = await sha256(codec.encodeManifest(body, false));
        await Bun.write(resolve(geometryRoot, 'manifest.pb'), codec.encodeManifest(body));
        await db.close(); db = undefined;
        async function exportTo(name: string, format = 'v2') {
            const out = resolve(temp, name);
            const child = Bun.spawn([process.execPath, resolve(projectRoot, 'scripts/tools/export-http-packs.ts'),
                '--db', databaseFile, '--geometry', geometryRoot, '--out', out, '--regions', 'all', '--format', format],
            { stdout: 'pipe', stderr: 'pipe' });
            const [status, error] = await Promise.all([child.exited, new Response(child.stderr).text(), new Response(child.stdout).text()]);
            return { out, status, error };
        }
        for (const format of ['v1', 'v2']) {
            const result = await exportTo(format, format);
            expect(result.status).toBe(0);
            const manifest = await Bun.file(resolve(result.out, 'manifest.json')).json();
            const region = await Bun.file(resolve(result.out, manifest.regions[1].descriptor.url)).json();
            let count = 0;
            for (const pack of region.packs) {
                const wire = await Bun.file(resolve(result.out, pack.url)).bytes();
                async function* chunks() { yield wire; }
                for await (const record of parsePack(chunks(), pack)) {
                    expect(decodeSizes(record)).toEqual(tx);
                    count++;
                }
            }
            expect(count).toBeGreaterThanOrEqual(2016);
            const copied = await Bun.file(resolve(result.out, geometry.url)).bytes();
            expect(await sha256(copied)).toBe(hash);
        }
        for (const [name, sql, message] of [
            ['invalid-size', 'UPDATE bitmaps SET size=[1] WHERE bitmap=17', 'Invalid source dimensions'],
            ['changed-size', 'UPDATE bitmaps SET size=[1,1] WHERE bitmap=17', 'Grid/canonical geometry mismatch'],
            ['changed-tx', `UPDATE bitmaps SET size=${JSON.stringify(size)},tx=[1] WHERE bitmap=17`, 'Canonical occupied dimensions differ'],
            ['gap', 'DELETE FROM bitmaps WHERE bitmap=2017', 'complete bitmap prefix'],
        ]) {
            db = await Database.create(databaseFile);
            await db.exec(sql);
            await db.close(); db = undefined;
            const result = await exportTo(name);
            expect(result.status).toBe(1);
            expect(result.error).toContain(message);
            expect(await Bun.file(resolve(result.out, 'manifest.json')).exists()).toBe(false);
            expect((await Bun.file(resolve(result.out, 'failure-report.json')).json()).status).toBe('failed');
        }
    } finally { await db?.close(); await rm(temp, { recursive: true, force: true }); }
}, 20000);
