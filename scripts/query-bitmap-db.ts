#!/usr/bin/env bun
import { argumentsFor } from './cli';
import { readBitmap } from './bitmap-reference';
import { readOnlyBitmapDatabase, resolveBitmapPath } from './sync-aws-transactions';

if (import.meta.main) {
    try {
        const options = argumentsFor(process.argv.slice(2), ['--db', '--block']);
        const block = Number(options['--block']);
        if (!Number.isSafeInteger(block) || block < 0 || block > 0xffffffff) throw Error('Use --block HEIGHT.');
        const db = await readOnlyBitmapDatabase(resolveBitmapPath(options['--db']));
        try {
            const bitmap = await readBitmap(db, block);
            if (!bitmap) throw Error(`Block ${block} has not been imported.`);
            console.log(JSON.stringify(bitmap, null, 2));
        } finally { await db.close(); }
    } catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }
}
