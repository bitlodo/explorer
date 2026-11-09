#!/usr/bin/env bun
/** Reproduce the frozen Huffman model from native run histograms, read-only. */
import assert from 'node:assert/strict';
import { resolve, join, dirname } from 'node:path';
import { mkdir, stat } from 'node:fs/promises';
import { Database, OPEN_READONLY } from './duckdb';
import { databasePath } from './db-config.ts';
import { maintenanceRoot } from './paths';
import { huffman } from './tx-symbol-frequencies';


const integer = (v: unknown) => { const n = Number(v); assert(Number.isSafeInteger(n) && n >= 0); return n; };
export const ESCAPE = 288;
export const tokenId = (value: number, length: number) => (value - 1) * 32 + (31 - Math.clz32(length));

async function main() {
    const symbols = process.argv[4] ? await Bun.file(resolve(process.argv[4])).json() : undefined;
    const database = databasePath('DB_BITMAP', process.argv[2]);
    const out = resolve(process.argv[3] ?? join(maintenanceRoot, `tx-run-training-${new Date().toISOString().replace(/[:.]/g, '-')}`));
    const before = await stat(database), started = performance.now();
    const db = await Database.create(database, OPEN_READONLY);
    let report: any;
    try {
        await db.exec("SET threads=4; SET memory_limit='512MB'; BEGIN TRANSACTION;");
        const metadata = (await db.all(`SELECT min(bitmap) AS first, max(bitmap) AS last,
            count(*) AS blocks, count(DISTINCT bitmap) AS unique_blocks,
            sum(array_length(tx)) AS transactions, count(*) FILTER (WHERE tx IS NULL) AS null_arrays
            FROM bitmaps WHERE bitmap >= 0 AND bitmap < 840000`))[0];
        assert.equal(integer(metadata.first), 0); assert.equal(integer(metadata.last), 839999);
        assert.equal(integer(metadata.blocks), 840000); assert.equal(integer(metadata.unique_blocks), 840000);
        if(symbols)assert.equal(integer(metadata.transactions), symbols.range.transactions); assert.equal(integer(metadata.null_arrays), 0);
        const sql = `WITH starts AS (
          SELECT tx, list_filter(range(1,array_length(tx)+1), i -> i=1 OR tx[i]<>tx[i-1]) AS starts
          FROM bitmaps WHERE bitmap >= 0 AND bitmap < 840000
        ), codes AS (
          SELECT list_transform(range(1,array_length(starts)+1),
            j -> (coalesce(starts[j+1],array_length(tx)+1)-starts[j])*16+tx[starts[j]]) AS codes
          FROM starts
        ), entries AS (SELECT unnest(map_entries(list_histogram(codes))) AS e FROM codes)
        SELECT e.key::UBIGINT AS code, sum(e.value)::UBIGINT AS occurrences
        FROM entries GROUP BY e.key ORDER BY e.key`;
        console.log(JSON.stringify({ phase: 'aggregating-runs', bitmaps: 840000, transactions: integer(metadata.transactions) }));
        const queryStarted = performance.now();
        const rows = await db.all(sql);
        const queryMs = performance.now() - queryStarted;
        const pairs = rows.map(r => { const code = integer(r.code); return { value: code % 16, length: Math.floor(code / 16), count: integer(r.occurrences) }; });
        const valueCounts = Array(10).fill(0), runHeads = Array(10).fill(0), tokens = new Map<number, number>();
        let totalRuns = 0, reconstructed = 0, remainderBits = 0;
        for (const pair of pairs) {
            assert(pair.value >= 1 && pair.value <= 9 && pair.length >= 1 && pair.length <= 4_000_000);
            totalRuns += pair.count; reconstructed += pair.count * pair.length;
            valueCounts[pair.value] += pair.count * pair.length; runHeads[pair.value] += pair.count;
            const token = tokenId(pair.value, pair.length);
            tokens.set(token, (tokens.get(token) ?? 0) + pair.count);
            remainderBits += pair.count * (31 - Math.clz32(pair.length));
        }
        assert.equal(reconstructed, integer(metadata.transactions));
        for (const row of symbols?.distribution ?? []) assert.equal(valueCounts[row.symbol], row.count);
        const model = huffman([...tokens].map(([symbol, count]) => ({ symbol, count })).concat([{ symbol: ESCAPE, count: 1 }]));
        const weightedTokenBits = model.codes.reduce((sum, c) => sum + (tokens.get(c.symbol) ?? 0) * c.bits, 0);
        await db.exec('COMMIT;');
        report = {
            format: 'tx-huffman-run-model-v1', createdAt: new Date().toISOString(), database,
            sourceMode: 'DuckDB OPEN_READONLY; single transaction; native per-array run histogram',
            range: symbols?.range ?? {first:0,last:839999,blocks:840000,transactions:integer(metadata.transactions)}, queryMs, totalMs: performance.now() - started, sql,
            totalRuns, maxRunLength: Math.max(...pairs.map(p => p.length)),
            runLengthOneCount: pairs.filter(p => p.length === 1).reduce((sum, p) => sum + p.count, 0),
            runHeads: runHeads.slice(1).map((count, i) => ({ value: i + 1, count, percentage: count / totalRuns * 100 })),
            pairs, model: { tokenRule: '(value-1)*32 + floor(log2(runLength))', escape: ESCAPE,
                lengthRule: 'Huffman token selects value and b=floor(log2(n)); append b raw bits of n-2^b',
                escapeRule: 'ESC token, then 4 raw value bits and 22 raw bits of length-1',
                codes: model.codes, observedTokenCount: tokens.size, maxCodeBits: Math.max(...model.codes.map(c => c.bits)),
                weightedTokenBits, remainderBits, estimatedMeaningfulBits: weightedTokenBits + remainderBits,
                estimatedBitsPerTransaction: (weightedTokenBits + remainderBits) / reconstructed },
            validation: { fullContinuousCoverage: true, reconstructedRunLengthsMatchTransactionCount: true,
                everySymbolCountMatchesPreviousFullHistogram: Boolean(symbols), noNullArrays: true },
            limitations: ['Training statistics are global; selected comparison packs occur inside training corpus', 'Ideal model bit count excludes byte padding per bitmap, tables and PB framing', 'No change to active codec or snapshot'],
        };
    } finally { await db.close(); }
    const after = await stat(database);
    assert.equal(after.size, before.size); assert.equal(after.mtimeMs, before.mtimeMs);
    report.validation.sourceSizeAndMtimeUnchanged = true;
    await mkdir(dirname(out), { recursive: true }); await mkdir(out, { recursive: false });
    await Bun.write(join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ out, totalRuns: report.totalRuns, maxRunLength: report.maxRunLength,
        runHeads: report.runHeads, model: report.model, queryMs: report.queryMs, validation: report.validation }, null, 2));
}

if (import.meta.main) await main();
