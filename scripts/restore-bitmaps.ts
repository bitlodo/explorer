import { createHash } from 'node:crypto';
import { basename, dirname, resolve } from 'node:path';
import protobuf from 'protobufjs';
import { argumentsFor } from './cli';
import { acquireSyncLock, exists, safeDirectory } from './aws-download';
import { request, validDate } from './aws-public-data';
import { bitmapGeometry, openBitmapDatabase, seedFingerprintSql } from './bitmap-reference';
import type { Database } from './duckdb';
import { bitmapDatabasePath, mapDataRoot } from './paths';
import { openPublishedMap } from './published-map';
import { readArtifact, readReferenceSnapshot } from './reference-snapshot';
import { createProtoCodec } from '../src/shared/protobufChunks';
import { decodeSizes } from '../src/shared/httpPack';

const codec = createProtoCodec(protobuf);
export type RestoreOptions = { source?: string; from?: string; signal?: AbortSignal; log?: (message: string) => void;
    fetcher?: typeof fetch; resolveDate?: (height: number, signal: AbortSignal) => Promise<string> };

/** A conservative date boundary avoids fetching the prefix already stored in the packs. */
export async function bitmapSyncDate(height: number, signal: AbortSignal, fetcher?: typeof fetch) {
    if (!Number.isSafeInteger(height) || height < 0 || height > 0xffffffff) throw Error('Invalid block height.');
    const failures: unknown[] = [];
    for (const base of ['https://mempool.space/api/', 'https://blockstream.info/api/']) {
        signal.throwIfAborted();
        try {
            const options = { signal, retries: 2, timeoutMs: 10000, fetcher };
            const hash = (await (await request(new URL(`block-height/${height}`, base), options)).text()).trim();
            if (!/^[a-f0-9]{64}$/.test(hash)) throw Error('Invalid block hash response.');
            const value = await (await request(new URL(`block/${hash}`, base), options)).json() as
                { id: string; height: number; mediantime: number; timestamp: number };
            const timestamp = Math.min(value.mediantime, value.timestamp);
            if (value.id !== hash || value.height !== height || !Number.isSafeInteger(timestamp) || timestamp < 1231006505)
                throw Error('Invalid block date response.');
            return new Date(Math.max(1231006505, timestamp - 86400) * 1000).toISOString().slice(0, 10);
        } catch (error) { signal.throwIfAborted(); failures.push(error); }
    }
    throw new AggregateError(failures, 'Cannot resolve the block date. Use bun scripts/restore-bitmaps.ts --from YYYY-MM-DD to set the boundary explicitly.');
}

/** Bounded, authenticated traversal shared by restoration and reference validation. */
export async function* protobufBatches(source: Awaited<ReturnType<typeof openPublishedMap>>, signal: AbortSignal) {
    const manifest = source.manifest, count = manifest.publishedHeight + 1;
    const widths = new Uint32Array(count), heights = new Uint32Array(count), seen = new Uint8Array(count);
    for (const region of manifest.regions) for (const [index, rect] of source.neighborhood(region.id).data.bitmaps.entries()) {
        const id = region.id * 2016 + index; widths[id] = rect.width; heights[id] = rect.height;
    }
    let records = 0;
    const pages = manifest.indexPages ?? [];
    for (let page = -1; page < pages.length; page++) {
        signal.throwIfAborted();
        const entries = page < 0 ? manifest.chunks : codec.decodeIndexPage(await readArtifact(source.root, pages[page]), pages[page], manifest);
        for (const chunk of entries) for (const pack of chunk.packs) {
            const bytes = await readArtifact(source.root, pack);
            async function* input() { yield bytes; }
            let batch: { bitmap: number; tx: number[]; size: number[] }[] = [], batchBytes = 0;
            for await (const record of codec.parsePack(input(), pack)) {
                signal.throwIfAborted();
                const id = record.id;
                if (id >= count || seen[id]) throw Error(`Duplicate/out-of-range restored bitmap ${id}.`);
                const tx = decodeSizes(record);
                if (batch.length && batchBytes + tx.length * 8 > 8 * 1024 * 1024) { yield batch; batch = []; batchBytes = 0; }
                batch.push({ bitmap: id, tx, size: [widths[id], heights[id]] }); batchBytes += tx.length * 8;
                seen[id] = 1; records++;
            }
            if (batch.length) yield batch;
        }
    }
    if (records !== manifest.parcelRegions.length * 2016) throw Error('Incomplete Protobuf bitmap coverage.');
    source.assertUnchanged();
}

/** Restore an empty reference atomically; a failed or cancelled import can be retried. */
export async function restoreProtobufs(db: Database, options: RestoreOptions = {}) {
    if (Number((await db.all('SELECT count(*) AS n FROM bitmaps'))[0]!.n)) return undefined;
    const source = await openPublishedMap(options.source ?? mapDataRoot), manifest = source.manifest;
    if (manifest.parcelRegions.length !== manifest.regions.length || manifest.regions.some(region => region.coverage !== 'complete'))
        throw Error('Database restoration requires complete parcel coverage from block 0; sample datasets cannot seed AWS sync.');
    const count = manifest.publishedHeight + 1, signal = options.signal ?? new AbortController().signal;
    const reference = await readReferenceSnapshot(source.root, manifest.snapshot, count);
    const from = options.from ?? await (options.resolveDate ?? ((height, abort) => bitmapSyncDate(height, abort, options.fetcher)))(manifest.publishedHeight, signal);
    if (!validDate(from)) throw Error('Invalid Protobuf sync boundary date.');
    options.log?.(`Restoring ${count.toLocaleString('en-US')} bitmaps from Protobuf files${reference ? '' : '; reconstructing missing patterns'}…`);
    const interrupt = () => db.interrupt(); signal.addEventListener('abort', interrupt, { once: true });
    const cache = new Map<string, { hash: string; size: number[] }>();
    let restored = 0;
    await db.exec("SET memory_limit='512MB'; SET threads=1; BEGIN TRANSACTION");
    try {
        await db.exec('CREATE TABLE restored_bitmaps AS SELECT * FROM bitmaps WHERE false');
        if (!reference) await db.exec('CREATE TEMP TABLE restored_hashes(bitmap UINTEGER, hash VARCHAR)');
        let loggedAt = 0;
        for await (const batch of protobufBatches(source, signal)) {
            const rows: [number, number[], number[], bigint][] = [], hashes: [number, string][] = [];
            for (const { bitmap: id, tx, size } of batch) {
                if (!reference) {
                    const key = createHash('sha256').update(Uint8Array.from(tx)).digest('hex');
                    let geometry = cache.get(key);
                    if (!geometry) {
                        geometry = bitmapGeometry(tx);
                        if (cache.size >= 4096) cache.delete(cache.keys().next().value!);
                        cache.set(key, geometry);
                    }
                    if (geometry.size[0] !== size[0] || geometry.size[1] !== size[1]) throw Error(`Restored dimensions differ at bitmap ${id}.`);
                    hashes.push([id, geometry.hash]);
                }
                rows.push([id, tx, size, BigInt(reference?.patterns[id] ?? id)]); restored++;
            }
            await db.appendRows('restored_bitmaps', rows);
            if (!reference) await db.appendRows('restored_hashes', hashes);
            if (Date.now() - loggedAt >= 1000 || restored === count) {
                options.log?.(`Restored ${restored.toLocaleString('en-US')} / ${count.toLocaleString('en-US')} bitmaps`); loggedAt = Date.now();
            }
        }
        if (restored !== count) throw Error('Incomplete Protobuf bitmap coverage.');
        if (!reference) {
            options.log?.('Resolving reconstructed pattern representatives…');
            await db.exec('INSERT INTO patterns SELECT hash,min(bitmap)::BIGINT FROM restored_hashes GROUP BY hash');
        }
        // Sort and fingerprint bounded height ranges instead of materializing all TX lists in one global sort.
        options.log?.('Ordering and indexing restored bitmaps…');
        for (let first = 0; first < count; first += 2016) {
            signal.throwIfAborted();
            const last = Math.min(first + 2016, count);
            if (reference) await db.exec('INSERT INTO bitmaps SELECT * FROM restored_bitmaps WHERE bitmap>=? AND bitmap<? ORDER BY bitmap', first, last);
            else await db.exec(`INSERT INTO bitmaps SELECT s.bitmap,s.tx,s.size,p.first_bitmap FROM restored_bitmaps s
                JOIN restored_hashes h USING(bitmap) JOIN patterns p USING(hash) WHERE s.bitmap>=? AND s.bitmap<? ORDER BY s.bitmap`, first, last);
            if (reference) await db.exec(`INSERT INTO seed_patterns SELECT bitmap,${seedFingerprintSql('tx', 'size')}
                FROM bitmaps WHERE bitmap>=? AND bitmap<? AND bitmap=pattern ORDER BY bitmap`, first, last);
            if (Date.now() - loggedAt >= 1000 || last === count) {
                options.log?.(`Indexed ${last.toLocaleString('en-US')} / ${count.toLocaleString('en-US')} bitmaps`); loggedAt = Date.now();
            }
        }
        await db.exec('DROP TABLE restored_bitmaps');
        if (!reference) await db.exec('DROP TABLE restored_hashes');
        for (const [name, value] of [['seed_height', String(manifest.publishedHeight)], ['seed_from_date', from],
            ['seed_source', source.root], ['seed_snapshot', manifest.snapshot]])
            await db.exec('INSERT INTO settings VALUES (?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value', name, value);
        source.assertUnchanged(); signal.throwIfAborted(); await db.exec('COMMIT');
        options.log?.(`Restored through block ${manifest.publishedHeight.toLocaleString('en-US')}. AWS sync will continue after this block.`);
        return { bitmaps: count, lastBitmap: manifest.publishedHeight, from, snapshot: manifest.snapshot };
    } catch (error) { await db.exec('ROLLBACK'); throw error; }
    finally { signal.removeEventListener('abort', interrupt); }
}

export async function restoreBitmapDatabase(options: RestoreOptions & { database?: string } = {}) {
    const database = resolve(options.database ?? bitmapDatabasePath);
    await safeDirectory(dirname(database));
    const release = await acquireSyncLock(dirname(database), basename(database) + '.sync.lock');
    let db: Database | undefined;
    try {
        const info = await exists(database);
        if (info && (!info.isFile() || info.isSymbolicLink())) throw Error('Unsafe DuckDB database path.');
        db = await openBitmapDatabase(database);
        return await restoreProtobufs(db, options);
    } finally { try { await db?.close(); } finally { await release(); } }
}

if (import.meta.main) {
    const controller = new AbortController(), stop = () => controller.abort(Error('Restore interrupted; rerun to retry.'));
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    try {
        const args = argumentsFor(process.argv.slice(2), ['--source', '--db', '--from']);
        const result = await restoreBitmapDatabase({ source: args['--source'], database: args['--db'], from: args['--from'], signal: controller.signal, log: console.error });
        console.log(result ? 'Bitmap database restored.' : 'The bitmap database already contains data; nothing was changed.');
    } catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }
    finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
}
