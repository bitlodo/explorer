// Square layout CPU measurement. Opens DB_BITMAP READ_ONLY; never imports server/db.js/index.js.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import MondrianLayout from '../src/shared/MondrianLayout.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(new URL('../package.json', import.meta.url));
const { Database, OPEN_READONLY } = require('duckdb-async');
const argv = process.argv.slice(2);
if (argv.length % 2 || argv.some((value, index) => index % 2 === 0 && !value.startsWith('--')))
    throw Error('Expected --option value pairs: --db --start --end --batch --report.');
const args = Object.fromEntries(Array.from({ length: argv.length / 2 }, (_, i) => [argv[i * 2].slice(2), argv[i * 2 + 1]]));
for (const key of Object.keys(args)) if (!['db', 'start', 'end', 'batch', 'report'].includes(key)) throw Error('Unknown option: ' + key);
const { databasePath } = await import('../scripts/db-config.ts');
const dbPath = databasePath('DB_BITMAP', args.db);
if (!dbPath || !fs.existsSync(dbPath)) throw Error('Missing bitmap input database. Supply --db or DB_BITMAP.');
const batch = Number(args.batch || 256), start = Number(args.start || 0);
if (!Number.isSafeInteger(batch) || batch < 1 || batch > 10000 || !Number.isSafeInteger(start) || start < 0) throw Error('Invalid start/batch.');
const stamp = new Date().toISOString().replaceAll(':', '-');
const reportPath = path.resolve(args.report || path.join(root, `.cache/maintenance/mondrian-squares-${stamp}.json`));
if (fs.existsSync(reportPath)) throw Error('Refusing to overwrite benchmark report: ' + reportPath);
const inputDigest = crypto.createHash('sha256'), header = Buffer.alloc(8);
const wallStart = performance.now(), cpuStart = process.cpuUsage();
let db, checked = 0, parcels = 0, expectedId = start, layoutMs = 0, ioMs = 0;
let times, lastProgress = performance.now(), maxRss = 0;
let interrupted = false;
const requestStop = () => { interrupted = true; };
process.on('SIGINT', requestStop);
process.on('SIGTERM', requestStop);
const strategies = {}, samples = [];
const report = { status: 'running', startedAt: new Date().toISOString(),
    scope: 'Node CPU layout construction; same tx arrays, no output cache, no renderer/workers/GPU; query/hash times excluded from algorithm timers',
    environment: { node: process.version, platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length },
    input: { database: path.basename(dbPath), openMode: 'READ_ONLY', start, batch } };

function stats(array) {
    const values = array.subarray(0, checked).slice().sort();
    const q = fraction => checked ? values[Math.min(checked - 1, Math.floor(checked * fraction))] : 0;
    return { p50Ms: q(0.5), p95Ms: q(0.95), p99Ms: q(0.99), maxMs: q(1) };
}
function save() {
    report.finishedAt = new Date().toISOString();
    report.checked = { bitmaps: checked, parcels, first: start, last: expectedId - 1,
        strategies, inputSha256: inputDigest.digest('hex') };
    report.timings = { layoutTotalMs: layoutMs, queryMs: ioMs, wallMs: performance.now() - wallStart,
        layout: times ? stats(times) : null };
    report.resources = { maxObservedRssBytes: maxRss, cpuMicroseconds: process.cpuUsage(cpuStart) };
    report.samples = samples;
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ report: path.relative(root, reportPath), status: report.status, checked: report.checked,
        timings: report.timings }));
}

try {
    db = await Database.create(dbPath, OPEN_READONLY);
    await db.exec('BEGIN TRANSACTION');
    const metadata = (await db.all('SELECT min(bitmap) AS first, max(bitmap) AS last, count(*) AS records FROM bitmaps'))[0];
    const end = Number(args.end ?? (Number(metadata.last) + 1));
    if (!Number.isSafeInteger(end) || end <= start) throw Error('Invalid end. End is exclusive.');
    const expected = end - start;
    report.input = { ...report.input, endExclusive: end, expectedBitmaps: expected, databaseFirst: Number(metadata.first), databaseLast: Number(metadata.last), databaseRecords: Number(metadata.records) };
    times = new Float64Array(expected);
    // Warm the square path before measured full-corpus traversal.
    const warm = await db.all('SELECT tx FROM bitmaps WHERE bitmap IN (100000, 400000, 806401) ORDER BY bitmap');
    for (let round = 0; round < 8; round++) for (const { tx } of warm) { new MondrianLayout(tx); }
    console.log(JSON.stringify({ stage: 'start', ...report.input }));
    traversal: for (let offset = start; offset < end; offset += batch) {
        if (interrupted) break;
        const queryStart = performance.now();
        const rows = await db.all('SELECT bitmap, tx FROM bitmaps WHERE bitmap >= ? AND bitmap < ? ORDER BY bitmap', offset, Math.min(end, offset + batch));
        ioMs += performance.now() - queryStart;
        if (rows.length !== Math.min(batch, end - offset)) throw Error('Missing bitmap input in batch starting ' + offset);
        for (const { bitmap, tx } of rows) {
            if (interrupted) break traversal;
            if (bitmap !== expectedId || !Array.isArray(tx)) throw Error('Non-contiguous or invalid input at ' + expectedId);
            const t0 = performance.now(), layout = new MondrianLayout(tx), ms = performance.now() - t0;
            times[checked] = ms; layoutMs += ms;
            strategies[layout.strategy] = (strategies[layout.strategy] || 0) + 1;
            if ([0, 100000, 400000, 806401, 840671].includes(bitmap)) samples.push({ bitmap, parcels: tx.length, layoutMs: ms, width: layout.width, height: layout.height, strategy: layout.strategy });
            header.writeUInt32LE(bitmap, 0); header.writeUInt32LE(tx.length, 4);
            inputDigest.update(header); inputDigest.update(Buffer.from(tx));
            checked++; expectedId++; parcels += tx.length;
        }
        maxRss = Math.max(maxRss, process.memoryUsage().rss);
        const now = performance.now();
        if (now - lastProgress >= 5000) {
            lastProgress = now;
            console.log(JSON.stringify({ stage: 'progress', checked, expected, parcels, lastBitmap: expectedId - 1,
                percent: checked / expected * 100, layoutMs, wallSeconds: (now - wallStart) / 1000, rssMB: Math.round(process.memoryUsage().rss / 1048576) }));
        }
    }
    if (interrupted) {
        report.status = 'interrupted'; process.exitCode = 130;
    } else {
        if (checked !== expected) throw Error('Incomplete corpus coverage.');
        report.status = 'passed';
    }
} catch (error) {
    report.status = 'failed'; report.error = String(error?.stack || error);
    console.error(error); process.exitCode = 1;
} finally {
    if (db) { await db.exec('ROLLBACK').catch(() => {}); await db.close(); }
    save();
    process.removeListener('SIGINT', requestStop);
    process.removeListener('SIGTERM', requestStop);
}
