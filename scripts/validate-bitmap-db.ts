#!/usr/bin/env bun
import { Database, OPEN_READONLY } from './duckdb';
import { argumentsFor } from './cli';
import { mapDataRoot } from './paths';
import { stat } from 'node:fs/promises';
import { openPublishedMap } from './published-map';
import { protobufBatches } from './restore-bitmaps';
import { readReferenceSnapshot } from './reference-snapshot';
import { readOnlyBitmapDatabase, resolveBitmapPath } from './sync-aws-transactions';

export async function validateBitmapDatabase(path: string, reference?: string) {
    const local = await readOnlyBitmapDatabase(path);
    let source: Database | undefined;
    const result = { checked: 0, outsideReference: 0, txMismatches: 0, sizeMismatches: 0, patternMismatches: 0, examples: [] as unknown[] };
    try {
        await local.exec("SET memory_limit='512MB'; SET threads=2");
        const referencePath: string = reference ?? (await local.all("SELECT value FROM settings WHERE name='seed_source'"))[0]?.value ?? mapDataRoot;
        if ((await stat(referencePath)).isDirectory()) {
            const published = await openPublishedMap(referencePath), count = published.manifest.publishedHeight + 1;
            const patterns = await readReferenceSnapshot(published.root, published.manifest.snapshot, count);
            let missingBitmaps = 0;
            for await (const batch of protobufBatches(published, new AbortController().signal)) {
                const rows = new Map((await local.all(`SELECT bitmap,tx,size,pattern FROM bitmaps WHERE bitmap IN (${batch.map(row => row.bitmap).join(',')})`)).map(row => [row.bitmap, row]));
                for (const expected of batch) {
                    const row = rows.get(expected.bitmap);
                    if (!row) { missingBitmaps++; continue; }
                    result.checked++;
                    if (JSON.stringify(row.tx) !== JSON.stringify(expected.tx)) result.txMismatches++;
                    if (JSON.stringify(row.size) !== JSON.stringify(expected.size)) result.sizeMismatches++;
                    if (patterns && Number(row.pattern) !== patterns.patterns[row.bitmap]) result.patternMismatches++;
                }
            }
            result.outsideReference = Number((await local.all('SELECT count(*) AS n FROM bitmaps WHERE bitmap>?', published.manifest.publishedHeight))[0]!.n);
            return { status: missingBitmaps || result.txMismatches || result.sizeMismatches || result.patternMismatches ? 'failed' : 'passed', ...result, missingBitmaps, patternsChecked: !!patterns };
        }
        source = await Database.create(referencePath, OPEN_READONLY);
        const next = 'SELECT bitmap,tx,size,pattern FROM bitmaps WHERE bitmap>? ORDER BY bitmap LIMIT 512';
        let last = -1;
        while (true) {
            const rows = await local.all(next,last); if (!rows.length) break;
            const expected = new Map((await source.all(`SELECT bitmap,tx,size,pattern FROM bitmaps WHERE bitmap IN (${rows.map(r => r.bitmap).join(',')})`))
                .map(row => [row.bitmap, row]));
            for (const row of rows) {
                const original = expected.get(row.bitmap);
                if (!original) { result.outsideReference++; continue; }
                result.checked++;
                const differences: string[] = [];
                if (JSON.stringify(row.tx) !== JSON.stringify(original.tx)) { result.txMismatches++; differences.push('tx'); }
                if (JSON.stringify(row.size) !== JSON.stringify(original.size)) { result.sizeMismatches++; differences.push('size'); }
                if (Number(row.pattern) !== Number(original.pattern)) { result.patternMismatches++; differences.push('pattern'); }
                if (differences.length && result.examples.length < 10) result.examples.push({ bitmap: row.bitmap, differences });
            }
            last = rows.at(-1)!.bitmap;
        }
        return { status: result.txMismatches || result.sizeMismatches || result.patternMismatches ? 'failed' : 'passed', ...result };
    } finally { try { await source?.close(); } finally { await local.close(); } }
}

if (import.meta.main) {
    try {
        const options = argumentsFor(process.argv.slice(2), ['--db', '--reference']);
        const result = await validateBitmapDatabase(resolveBitmapPath(options['--db']), options['--reference']);
        console.log(JSON.stringify(result, null, 2));
        if (result.status !== 'passed') process.exitCode = 1;
    } catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }
}
