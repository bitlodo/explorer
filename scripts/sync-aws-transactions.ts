#!/usr/bin/env bun
import { Database } from './duckdb';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { readdir, rm } from 'node:fs/promises';
import { argumentsFor } from './cli';
import { dataRoot, bitmapDatabasePath, mapDataRoot } from './paths';
import { restoreProtobufs, type RestoreOptions } from './restore-bitmaps';
import { AWS_BITCOIN_ENDPOINT, listTransactions, validDate, type RemoteObject, type RequestOptions } from './aws-public-data';
import { acquireSyncLock, digest, downloadObject, exists, localFile, removeEmptyTransactionDirectories, safeDirectory, type ParquetProjector } from './aws-download';
import { importPartition, openBitmapDatabase, parquetBitmaps, partitionFingerprint, type ImportedFile, sqlString } from './bitmap-reference';
import {writeMapStatus} from './map-status';

export { bitmapDatabasePath };
export const awsWorkRoot = join(dataRoot, 'aws/bitcoin');
export type SyncOptions = {
    dbPath?: string; workRoot?: string; from?: string; to?: string; concurrency?: number; retries?: number;
    dryRun?: boolean; keepParquet?: boolean; signal?: AbortSignal; endpoint?: string; fetcher?: typeof fetch;
    retryDelayMs?: number; log?: (value: SyncEvent) => void; projectParquet?: ParquetProjector;
    bootstrapSource?: string; bootstrapFrom?: string; restoreLog?: (message: string) => void; resolveDate?: RestoreOptions['resolveDate'];
};

export type SyncReport = {
    database: string; dryRun: boolean; listedFiles: number; downloadedFiles: number; reusedDownloads: number;
    skippedPartitions: number; importedPartitions: number; importedBitmaps: number; importedTransactions: number;
    bytesDownloaded: number; bytesStaged: number; filesPlanned: number; sourceBytesPlanned: number; firstDate: string | null;
    lastDate: string | null; lastBitmap: number | null;
};
export type SyncActivity = { stage: 'activity'; phase: 'listing' | 'checking' | 'downloading' | 'importing' | 'cleanup';
    date: string | null; block: number | null; filesCompleted: number; fileCount: number;
    dayBytesDownloaded: number; elapsedSeconds: number };
export type SyncEvent = SyncActivity | { stage: 'start'; block: number | null; database: string; dryRun: boolean }
    | (SyncReport & { stage: 'progress'; date: string; action: 'imported' | 'skipped' | 'planned';
        block: number | null; blocks: number; transactions: number; dayBytesDownloaded: number });

const count = (value: number) => value.toLocaleString('en-US');
const quantity = (value: number, unit: string) => `${count(value)} ${unit}${value === 1 ? '' : 's'}`;
const megabytes = (value: number) => `${(value/1_000_000).toFixed(2)} MB`;
function bytes(value: number) {
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
    return `${value.toFixed(unit ? 1 : 0)} ${units[unit]}`;
}
export function formatSyncEvent(event: SyncEvent): string | null {
    if (event.stage === 'activity') {
        const phase = { listing: 'Listing AWS dates', checking: 'Checking saved progress', downloading: 'Downloading',
            importing: 'Importing', cleanup: 'Cleaning up' }[event.phase];
        const location = event.date ?? (event.block === null ? 'AWS sync' : `Block ${count(event.block)}`);
        const transfer = event.phase === 'downloading' || event.phase === 'importing' || event.phase === 'cleanup'
            ? ` | ${event.filesCompleted}/${event.fileCount} files ready | ${megabytes(event.dayBytesDownloaded)} confirmed` : '';
        return `${location} | ${phase}${transfer} | ${event.elapsedSeconds}s`;
    }
    if (event.stage === 'start') {
        if (event.dryRun) return 'Checking AWS updates…';
        return event.block === null ? 'Starting AWS sync…' : `Block ${count(event.block)} | Resuming sync`;
    }
    if (event.action === 'skipped') return null;
    if (event.action === 'planned') return `Plan | ${event.date} | ${quantity(event.filesPlanned, 'file')} | source files up to ${bytes(event.sourceBytesPlanned)}`;
    return `Block ${count(event.block!)} | ${event.date} | +${quantity(event.blocks, 'block')} | +${count(event.transactions)} tx | ${megabytes(event.dayBytesDownloaded)}`;
}

/** Keep one live terminal line; redirected logs use occasional plain-text updates. */
export function createSyncLogger(json: boolean, output: { isTTY?: boolean; columns?: number; write: (text: string) => unknown } = process.stderr) {
    let live = false, lastActivity = 0, lastActivityKey = '';
    const clear = () => { if (live) { output.write('\r\x1b[2K'); live = false; } };
    return {
        clear,
        log(event: SyncEvent) {
            if (json) { output.write(JSON.stringify(event) + '\n'); return; }
            const line = formatSyncEvent(event);
            if (!line) return;
            if (event.stage === 'activity') {
                if (output.isTTY) {
                    const width = output.columns ? Math.max(1, output.columns - 1) : line.length;
                    output.write('\r\x1b[2K' + line.slice(0, width)); live = true;
                } else {
                    const key = `${event.date}:${event.phase}`;
                    if (key !== lastActivityKey || Date.now() - lastActivity >= 15_000) {
                        output.write(line + '\n'); lastActivity = Date.now(); lastActivityKey = key;
                    }
                }
            } else { clear(); output.write(line + '\n'); }
        },
    };
}
function formatSyncSummary(report: SyncReport) {
    if (report.dryRun) return `Plan: ${quantity(report.filesPlanned, 'file')} (source files up to ${bytes(report.sourceBytesPlanned)}); ${quantity(report.skippedPartitions, 'day')} unchanged.`;
    return `Done: ${quantity(report.importedBitmaps, 'block')}, ${count(report.importedTransactions)} tx; ${quantity(report.skippedPartitions, 'day')} unchanged. Downloaded ${megabytes(report.bytesDownloaded)}.`;
}
export class SyncInterrupted extends Error {
    constructor() { super('Stopped. Progress saved; rerun to resume.'); }
}


export async function readOnlyBitmapDatabase(path: string) {
    return openBitmapDatabase(path,undefined,true);
}

export type TransactionStatus = { database: string; bitmaps: number; firstBitmap: number|null; lastBitmap: number|null;
    missingBitmaps: number; partitions: number; processedFiles: number; cachedDownloads: number; firstDate: string|null; lastDate: string|null };
export async function awsTransactionStatus(path = bitmapDatabasePath): Promise<TransactionStatus> {
    if (!await exists(path)) return { database:path,bitmaps:0,firstBitmap:null,lastBitmap:null,missingBitmaps:0,
        partitions:0,processedFiles:0,cachedDownloads:0,firstDate:null,lastDate:null };
    const db=await readOnlyBitmapDatabase(path);
    try {
        const counts=(await db.all<Pick<TransactionStatus,'bitmaps'|'firstBitmap'|'lastBitmap'|'missingBitmaps'>>(`SELECT count(*)::INTEGER AS bitmaps,min(bitmap) AS firstBitmap,max(bitmap) AS lastBitmap,
            (coalesce(max(bitmap)::BIGINT+1,0)-count(*))::INTEGER AS missingBitmaps FROM bitmaps`))[0]!;
        const state=(await db.all<Pick<TransactionStatus,'partitions'|'firstDate'|'lastDate'>>(`SELECT count(*)::INTEGER AS partitions,min(date) AS firstDate,max(date) AS lastDate FROM aws_partitions`))[0]!;
        return {database:path,...counts,...state,
            processedFiles:Number((await db.all('SELECT count(*) AS n FROM aws_files'))[0]!.n),
            cachedDownloads:Number((await db.all('SELECT count(*) AS n FROM aws_downloads'))[0]!.n)};
    } finally { await db.close(); }
}

async function* partitions(endpoint: string, options: SyncOptions, requests: RequestOptions) {
    let pending: RemoteObject[] = [];
    for await (const page of listTransactions(endpoint, options.from, options.to, requests)) {
        for (const object of page) {
            if (pending.length && pending[0].date !== object.date) { yield pending; pending = []; }
            pending.push(object);
        }
    }
    if (pending.length) yield pending;
}

async function cachedDownload(db: Database,work: string,object: RemoteObject): Promise<ImportedFile|null> {
    const row=(await db.all('SELECT etag,size,sha256,bytes FROM aws_downloads WHERE key=?',object.key))[0];
    const path=localFile(work,object.key),info=await exists(path);
    if (info?.isSymbolicLink()) throw Error(`Unsafe cached Parquet file: ${path}`);
    if (row && row.etag===object.etag && Number(row.size)===object.size && info?.isFile() && info.size===Number(row.bytes)
        && await digest(path)===row.sha256) return {...object,sha256:row.sha256,bytes:Number(row.bytes)};
    return null;
}

async function cleanupPartition(db: Database,work: string,date: string) {
    const files=await db.all(`SELECT key,sha256 FROM aws_files WHERE date=?
        UNION SELECT key,sha256 FROM aws_downloads WHERE key LIKE ?`,date,`v1.0/btc/transactions/date=${date}/%`);
    for (const file of files) {
        const path=localFile(work,file.key),info=await exists(path);
        if (info?.isFile() && !info.isSymbolicLink() && await digest(path)===file.sha256) await rm(path);
    }
    await db.exec(`DELETE FROM aws_downloads WHERE key LIKE ${sqlString(`v1.0/btc/transactions/date=${date}/%`)}`);
    await removeEmptyTransactionDirectories(work,date);
}

export async function syncAwsTransactions(options: SyncOptions = {}) {
    const path = resolve(options.dbPath ?? bitmapDatabasePath), work = resolve(options.workRoot ?? awsWorkRoot);
    const endpoint = options.endpoint ?? AWS_BITCOIN_ENDPOINT, concurrency = options.concurrency ?? 2, retries = options.retries ?? 4;
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8 || !Number.isInteger(retries) || retries < 0 || retries > 10)
        throw Error('Use concurrency 1..8 and retries 0..10.');
    if (options.from && !validDate(options.from) || options.to && !validDate(options.to) || options.from && options.to && options.from > options.to)
        throw Error('Use valid inclusive --from/--to dates in YYYY-MM-DD order.');
    const signal = options.signal ?? new AbortController().signal;
    const requests: RequestOptions = { signal, retries, fetcher: options.fetcher, retryDelayMs: options.retryDelayMs };
    const report: SyncReport = { database: path, dryRun: !!options.dryRun, listedFiles: 0, downloadedFiles: 0, reusedDownloads: 0,
        skippedPartitions: 0, importedPartitions: 0, importedBitmaps: 0, importedTransactions: 0,
        bytesDownloaded: 0, bytesStaged: 0, filesPlanned: 0, sourceBytesPlanned: 0, firstDate: null as string | null, lastDate: null as string | null, lastBitmap: null };
    let release: (() => Promise<void>) | undefined, db: Database | undefined;
    let activity: SyncActivity | undefined, activityStarted = Date.now(), heartbeat: ReturnType<typeof setInterval> | undefined;
    const emitActivity = () => {
        if (activity) options.log?.({ ...activity, elapsedSeconds: Math.floor((Date.now() - activityStarted) / 1000) });
    };
    const setActivity = (phase: SyncActivity['phase'], date: string | null = null, fileCount = 0, announce = false) => {
        activityStarted = Date.now();
        activity = { stage: 'activity', phase, date, block: report.lastBitmap, filesCompleted: 0, fileCount,
            dayBytesDownloaded: 0, elapsedSeconds: 0 };
        if (announce) emitActivity();
    };
    try {
        if (!options.dryRun) {
            await safeDirectory(dirname(path)); release = await acquireSyncLock(dirname(path), basename(path) + '.sync.lock');
            await safeDirectory(work); await safeDirectory(join(work, '.partial')); await safeDirectory(join(work, '.duckdb-tmp'));
            await removeEmptyTransactionDirectories(work);
            for (const file of await readdir(join(work, '.partial')))
                if (/^[a-f0-9-]+\.part(?:\.profile\.json)?$/.test(file)) await rm(join(work, '.partial', file), { force: true });
            const info = await exists(path);
            if (info && (!info.isFile() || info.isSymbolicLink())) throw Error('Unsafe DuckDB database path.');
            db = await openBitmapDatabase(path, endpoint);
            if (options.bootstrapSource && (await exists(join(options.bootstrapSource, 'manifest.json')) || await exists(join(options.bootstrapSource, 'manifest.pb'))))
                await restoreProtobufs(db, { source: options.bootstrapSource, from: options.bootstrapFrom, signal,
                    fetcher: options.fetcher, resolveDate: options.resolveDate, log: options.restoreLog });
        } else {
            db = await exists(path) ? await readOnlyBitmapDatabase(path) : await openBitmapDatabase(':memory:', endpoint);
            if ((await db.all("SELECT value FROM settings WHERE name='endpoint'"))[0]?.value !== endpoint)
                throw Error('Bitmap database source mismatch.');
        }
        report.lastBitmap = (await db.all('SELECT max(bitmap) AS height FROM bitmaps'))[0]!.height;
        const seedHeight=Number((await db.all("SELECT value FROM settings WHERE name='seed_height'"))[0]?.value ?? -1);
        const seedFrom=(await db.all("SELECT value FROM settings WHERE name='seed_from_date'"))[0]?.value as string|undefined;
        if (!Number.isInteger(seedHeight) || seedHeight < -1 || seedHeight > 0xffffffff || seedFrom && !validDate(seedFrom))
            throw Error('Invalid imported baseline settings.');
        if (seedHeight>=0 && Number((await db.all('SELECT count(*) AS n FROM bitmaps WHERE bitmap<=?',seedHeight))[0]!.n)!==seedHeight+1)
            throw Error('The imported baseline has missing blocks. Run bun scripts/import-bitmaps.ts again to restore it.');
        options.log?.({ stage: 'start', database: path, block: report.lastBitmap, dryRun: report.dryRun });
        setActivity('listing');
        if (options.log) heartbeat = setInterval(emitActivity, 1000);
        for await (const objects of partitions(endpoint, {...options,from:options.from ?? seedFrom}, requests)) {
            signal.throwIfAborted();
            const date = objects[0].date, fingerprint = partitionFingerprint(objects);
            setActivity('checking', date);
            report.listedFiles += objects.length; report.firstDate ??= date; report.lastDate = date;
            const prior=(await db.all('SELECT fingerprint,blocks FROM aws_partitions WHERE date=?',date))[0];
            const local=(await db.all(`SELECT count(*)::INTEGER AS n,max(b.bitmap) AS height
                FROM aws_partitions p,unnest(p.block_ranges) t(r),bitmaps b
                WHERE p.date=? AND b.bitmap BETWEEN r[1] AND r[2]`,date))[0]!;
            let action: 'skipped' | 'planned' | 'imported' = 'skipped', block = local.height, blocks = 0, transactions = 0,dayBytesDownloaded=0;
            if (prior?.fingerprint === fingerprint && prior.blocks === local.n) {
                report.skippedPartitions++;
                if (!options.dryRun && !options.keepParquet) await cleanupPartition(db, work, date);
            } else if (options.dryRun) {
                action = 'planned';
                report.filesPlanned += objects.length; report.sourceBytesPlanned += objects.reduce((sum, f) => sum + f.size, 0);
            } else {
                const imported: ImportedFile[] = new Array(objects.length); let cursor = 0, failure: unknown;
                setActivity('downloading', date, objects.length, true);
                await Promise.all(Array.from({ length: Math.min(concurrency, objects.length) }, async () => {
                    while (cursor < objects.length && !failure) {
                        const index = cursor++, object = objects[index];
                        try {
                            await safeDirectory(dirname(localFile(work, object.key)));
                            const cached = await cachedDownload(db!, work, object);
                            if (cached) { imported[index] = cached; report.reusedDownloads++; }
                            else {
                                const file = await downloadObject(work, object, endpoint, requests, options.projectParquet);
                                await db!.exec(`DELETE FROM aws_downloads WHERE key=${sqlString(object.key)};
                                    INSERT INTO aws_downloads VALUES (${sqlString(object.key)},${sqlString(object.etag)},
                                        ${object.size},${sqlString(file.sha256)},${file.bytes})`);
                                imported[index]={...object,...file};
                                report.downloadedFiles++; report.bytesStaged+=file.bytes;
                                report.bytesDownloaded+=file.downloadedBytes; dayBytesDownloaded+=file.downloadedBytes;
                            }
                            activity!.filesCompleted++; activity!.dayBytesDownloaded = dayBytesDownloaded;
                            emitActivity();
                        } catch (error) { failure = error; }
                    }
                }));
                if (failure) throw failure;
                setActivity('importing', date, objects.length);
                activity!.filesCompleted = objects.length; activity!.dayBytesDownloaded = dayBytesDownloaded;
                emitActivity();
                const result = await importPartition(db, date, fingerprint, imported,
                    parquetBitmaps(imported.map(f => localFile(work, f.key)), date, join(work, '.duckdb-tmp'),seedHeight), signal,seedHeight);
                if (result.blocks) {
                    report.importedPartitions++; report.importedBitmaps += result.blocks; report.importedTransactions += result.transactions;
                    action = 'imported'; block = result.lastBitmap; blocks = result.blocks; transactions = result.transactions;
                    report.lastBitmap = Math.max(report.lastBitmap ?? -1, result.lastBitmap);
                } else { action='skipped'; block=report.lastBitmap; report.skippedPartitions++; }
                if (!options.keepParquet) {
                    setActivity('cleanup', date, objects.length);
                    activity!.filesCompleted = objects.length; activity!.dayBytesDownloaded = dayBytesDownloaded;
                    await cleanupPartition(db, work, date);
                }
            }
            options.log?.({ stage: 'progress', date, action, block, blocks, transactions, dayBytesDownloaded, ...report });
            setActivity('listing');
        }
        signal.throwIfAborted();
        if(!report.dryRun&&path===resolve(bitmapDatabasePath)&&
            (await exists(join(mapDataRoot,'release.json'))||await exists(join(mapDataRoot,'manifest.json'))||await exists(join(mapDataRoot,'manifest.pb'))))
            await writeMapStatus(mapDataRoot,path,{connection:db});
        return report;
    } finally {
        clearInterval(heartbeat);
        try { await db?.close(); } finally { await release?.(); }
    }
}

export function resolveBitmapPath(value = bitmapDatabasePath) {
    const path = resolve(value), within = relative(join(dataRoot, 'db'), path);
    if (!within || within === '..' || within.startsWith('..' + sep) || !path.endsWith('.db'))
        throw Error('--db must be a .db file under data/db/.');
    return path;
}

export async function syncAwsCommand(args: string[]) {
    const options = argumentsFor(args, ['--from', '--to', '--db', '--concurrency', '--retries', '--dry-run', '--keep-parquet', '--status', '--json', '--source', '--bootstrap']);
    for (const name of ['--dry-run', '--keep-parquet', '--status', '--json', '--bootstrap'])
        if (options[name] && !['true', 'false'].includes(options[name])) throw Error(`${name} must be true or false.`);
    const dbPath = resolveBitmapPath(options['--db']);
    if (options['--status'] === 'true') { const result = await awsTransactionStatus(dbPath); console.log(JSON.stringify(result, null, 2)); return result; }
    const controller = new AbortController(), stop = () => controller.abort(new SyncInterrupted());
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    const json = options['--json'] === 'true';
    const logger = createSyncLogger(json);
    try {
        const result = await syncAwsTransactions({ dbPath, from: options['--from'], to: options['--to'],
            bootstrapSource: options['--bootstrap'] === 'false' ? undefined : resolve(options['--source'] ?? mapDataRoot),
            restoreLog: message => console.error(json ? JSON.stringify({ stage: 'restore', message }) : message),
            concurrency: options['--concurrency'] === undefined ? undefined : Number(options['--concurrency']),
            retries: options['--retries'] === undefined ? undefined : Number(options['--retries']),
            dryRun: options['--dry-run'] === 'true', keepParquet: options['--keep-parquet'] === 'true', signal: controller.signal,
            log: logger.log });
        logger.clear(); console.log(json ? JSON.stringify({ status: 'passed', ...result }, null, 2) : formatSyncSummary(result)); return result;
    } catch (error) { if (controller.signal.aborted) throw controller.signal.reason; throw error; }
    finally { logger.clear(); process.off('SIGINT', stop); process.off('SIGTERM', stop); }
}

if (import.meta.main) {
    try { await syncAwsCommand(process.argv.slice(2)); }
    catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = error instanceof SyncInterrupted ? 130 : 1; }
}
