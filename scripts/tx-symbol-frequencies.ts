#!/usr/bin/env bun
/** Read-only TX histogram and canonical Huffman builder used by model training. */
import assert from 'node:assert/strict';
import { resolve, join, dirname } from 'node:path';
import { mkdir, stat } from 'node:fs/promises';
import { Database, OPEN_READONLY } from './duckdb';
import { databasePath } from './db-config.ts';
import { maintenanceRoot } from './paths';

const number = (value: unknown) => {
    const n = Number(value);
    assert(Number.isSafeInteger(n) && n >= 0, 'Unsafe/negative aggregate');
    return n;
};
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
type Count = { symbol: number; count: number };
type Node = { weight: number; first: number; symbol?: number; left?: Node; right?: Node };

export function huffman(counts: Count[]) {
    assert(counts.length > 0);
    const nodes: Node[] = counts.map(c => ({ weight: c.count, first: c.symbol, symbol: c.symbol }));
    while (nodes.length > 1) {
        nodes.sort((a, b) => a.weight - b.weight || a.first - b.first);
        const left = nodes.shift()!, right = nodes.shift()!;
        nodes.push({ weight: left.weight + right.weight, first: Math.min(left.first, right.first), left, right });
    }
    const lengths = new Map<number, number>();
    const visit = (node: Node, depth: number) => {
        if (node.symbol !== undefined) lengths.set(node.symbol, Math.max(depth, 1));
        else { visit(node.left!, depth + 1); visit(node.right!, depth + 1); }
    };
    visit(nodes[0], 0);
    const sorted = [...lengths].sort((a, b) => a[1] - b[1] || a[0] - b[0]);
    let code = 0, previous = 0;
    const codes = sorted.map(([symbol, bits]) => {
        code *= 2 ** (bits - previous);
        const result = { symbol, bits, code: code.toString(2).padStart(bits, '0') };
        code++; previous = bits;
        return result;
    });
    for (const a of codes) for (const b of codes) if (a !== b) assert(!a.code.startsWith(b.code), 'Non-prefix code');
    const total = sum(counts.map(c => c.count));
    const weightedBits = sum(counts.map(c => c.count * lengths.get(c.symbol)!));
    return { codes: codes.sort((a, b) => a.symbol - b.symbol), weightedBits, averageBitsPerTransaction: weightedBits / total, idealPackedBytes: Math.ceil(weightedBits / 8), reductionVsRaw4BitsPercent: (1 - weightedBits / (total * 4)) * 100 };
}

async function main() {
    // Known optimum and prefix invariants, independently of this dataset.
    const fixture = huffman([{ symbol: 1, count: 50 }, { symbol: 2, count: 25 }, { symbol: 3, count: 15 }, { symbol: 4, count: 10 }]);
    assert.equal(fixture.weightedBits, 175);
    assert.equal(fixture.codes.find(c => c.symbol === 1)!.bits, 1);
    const database = databasePath('DB_BITMAP', process.argv[2]);
    const out = resolve(process.argv[3] ?? join(maintenanceRoot, `tx-symbol-frequencies-${new Date().toISOString().replace(/[:.]/g, '-')}`));
    const first = 0, endExclusive = 840000, bandSize = 100000;
    const before = await stat(database);
    const db = await Database.create(database, OPEN_READONLY);
    let report: any;
    try {
        await db.exec("SET threads=4; SET memory_limit='512MB'; BEGIN TRANSACTION;");
        const version = (await db.all('SELECT version() AS version'))[0].version;
        const started = performance.now();
        const metadataSql = `SELECT floor(bitmap / ${bandSize})::INTEGER AS band,
            min(bitmap) AS first, max(bitmap) AS last, count(*) AS bitmaps,
            count(DISTINCT bitmap) AS distinct_bitmaps,
            sum(array_length(tx)) AS transactions, sum(list_count(tx)) AS nonnull_transactions,
            count(*) FILTER (WHERE tx IS NULL) AS null_arrays,
            count(*) FILTER (WHERE array_length(tx) = 0) AS empty_arrays
            FROM bitmaps WHERE bitmap >= ${first} AND bitmap < ${endExclusive}
            GROUP BY band ORDER BY band`;
        const bands = await db.all(metadataSql);
        const metadataMs = performance.now() - started;
        console.log(JSON.stringify({ phase: 'coverage', bands, milliseconds: metadataMs }, (_, v) => typeof v === 'bigint' ? v.toString() : v));
        const histogramSql = `WITH per_bitmap AS (
            SELECT floor(bitmap / ${bandSize})::INTEGER AS band,
                   unnest(map_entries(list_histogram(tx))) AS entry
            FROM bitmaps WHERE bitmap >= ${first} AND bitmap < ${endExclusive}
        ) SELECT band, entry.key::INTEGER AS symbol,
                 sum(entry.value)::UBIGINT AS occurrences,
                 count(*) AS bitmaps_containing
          FROM per_bitmap GROUP BY band, entry.key ORDER BY band, symbol`;
        const histogramStart = performance.now();
        const rows = await db.all(histogramSql);
        const histogramMs = performance.now() - histogramStart;
        const combined = new Map<number, { count: number; bitmapsContaining: number }>();
        for (const row of rows) {
            const value = combined.get(row.symbol) ?? { count: 0, bitmapsContaining: 0 };
            value.count += number(row.occurrences); value.bitmapsContaining += number(row.bitmaps_containing);
            combined.set(row.symbol, value);
        }
        const bitmaps = sum(bands.map(b => number(b.bitmaps)));
        const transactions = sum(bands.map(b => number(b.transactions)));
        assert.equal(bitmaps, endExclusive - first);
        assert.equal(sum(bands.map(b => number(b.distinct_bitmaps))), bitmaps);
        assert.equal(bands[0].first, first); assert.equal(bands.at(-1)!.last, endExclusive - 1);
        assert.equal(sum(bands.map(b => number(b.null_arrays))), 0);
        assert.equal(sum(bands.map(b => number(b.nonnull_transactions))), transactions);
        assert.equal(sum([...combined.values()].map(v => v.count)), transactions);
        for (const band of bands) {
            assert.equal(number(band.bitmaps), band.last - band.first + 1);
            assert.equal(sum(rows.filter(r => r.band === band.band).map(r => number(r.occurrences))), number(band.transactions));
        }
        // Independent JS counting on six real blocks, compared to the SQL method.
        const ids = [0, 1, 209999, 419999, 629999, 839999];
        const samples = await db.all(`SELECT bitmap, tx FROM bitmaps WHERE bitmap IN (${ids.join(',')}) ORDER BY bitmap`);
        assert.equal(samples.length, ids.length);
        const jsCounts = new Map<number, number>();
        for (const sample of samples) for (const symbol of sample.tx) jsCounts.set(symbol, (jsCounts.get(symbol) ?? 0) + 1);
        const sqlCounts = await db.all(`WITH s AS (SELECT unnest(map_entries(list_histogram(tx))) AS entry FROM bitmaps WHERE bitmap IN (${ids.join(',')})) SELECT entry.key::INTEGER AS symbol, sum(entry.value)::UBIGINT AS occurrences FROM s GROUP BY entry.key ORDER BY symbol`);
        assert.deepEqual(sqlCounts.map(r => [r.symbol, number(r.occurrences)]), [...jsCounts].sort((a, b) => a[0] - b[0]));
        await db.exec('COMMIT;');

        const symbols = [...new Set([...Array.from({ length: 9 }, (_, i) => i + 1), ...combined.keys()])].sort((a, b) => a - b);
        const counts = symbols.map(symbol => ({ symbol, count: combined.get(symbol)?.count ?? 0 }));
        const tree = huffman(counts);
        const entropy = -sum(counts.filter(c => c.count).map(c => { const p = c.count / transactions; return p * Math.log2(p); }));
        const distribution = counts.map(c => ({ ...c, percentage: c.count / transactions * 100, bitmapsContaining: combined.get(c.symbol)?.bitmapsContaining ?? 0, ...tree.codes.find(code => code.symbol === c.symbol) }));
        report = {
            format: 'tx-symbol-frequencies-huffman-v1', createdAt: new Date().toISOString(),
            source: { database, table: 'bitmaps', field: 'tx', fieldType: 'UTINYINT[]', mode: 'READ_ONLY; single read transaction', duckdbVersion: version, threads: 4, memoryLimit: '512MB' },
            range: { first, endExclusive, last: endExclusive - 1, bitmaps, transactions, nullArrays: 0, nullValues: 0, emptyArrays: sum(bands.map(b => number(b.empty_arrays))) },
            distribution, rankedByFrequency: [...distribution].sort((a, b) => b.count - a.count || a.symbol - b.symbol),
            outsideRequestedAlphabet: distribution.filter(c => c.symbol < 1 || c.symbol > 9),
            huffman: { ...tree, alphabet: 'All symbols 1..9, including zero-frequency symbols, plus any actually observed outside that range', construction: 'Merge least frequent nodes; deterministic tie break by smallest descendant symbol; canonical codes sorted by length then symbol', entropyBitsPerTransaction: entropy, idealEntropyBytes: Math.ceil(entropy * transactions / 8), raw4MeaningfulBits: transactions * 4, raw4UnpaddedBytes: transactions / 2 },
            byBand: bands.map(b => ({ first: b.first, last: b.last, bitmaps: number(b.bitmaps), transactions: number(b.transactions), distribution: symbols.map(symbol => { const row = rows.find(r => r.band === b.band && r.symbol === symbol); return { symbol, count: row ? number(row.occurrences) : 0, percentage: row ? number(row.occurrences) / number(b.transactions) * 100 : 0 }; }) })),
            validation: { exactContinuousBitmapCoverage: true, histogramSumMatchesArrayLengths: true, perBandTotalsMatch: true, noNullArraysOrValues: true, sqlComparedToIndependentJsOnBlocks: ids, sampleTransactions: sum(samples.map(s => s.tx.length)), canonicalCodesPrefixFree: true, independentHuffmanFixturePassed: true },
            timings: { metadataMs, histogramMs, totalReadTransactionMs: performance.now() - started },
            queries: { coverage: metadataSql, histogram: histogramSql },
            limitations: ['Symbol frequencies and theoretical Huffman payload only; no full Huffman PB encoding or decoder benchmark', 'Byte padding per bitmap, codebook, Protobuf, hashes and frames are excluded from ideal sizes', 'Raw4 baseline is four bits per symbol, not the current per-bitmap minimum of raw4/rle4', 'Optimal symbol code lengths for this global histogram do not imply optimal run-length coding or optimal recent-block distribution'],
        };
    } finally { await db.close(); }
    const after = await stat(database);
    assert.equal(after.size, before.size); assert.equal(after.mtimeMs, before.mtimeMs);
    report.validation.sourceSizeAndMtimeUnchanged = true;
    await mkdir(dirname(out), { recursive: true });
    await mkdir(out, { recursive: false });
    await Bun.write(join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ out, range: report.range, distribution: report.rankedByFrequency, huffman: report.huffman, timings: report.timings }, null, 2));
}

if (import.meta.main) await main();
