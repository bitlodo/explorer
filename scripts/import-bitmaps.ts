#!/usr/bin/env bun
import { realpath, stat } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { argumentsFor } from './cli';
import { acquireSyncLock, safeDirectory } from './aws-download';
import { AWS_BITCOIN_ENDPOINT, validDate } from './aws-public-data';
import { bitmapGeometry, openBitmapDatabase, resolveSeedPattern, seedFingerprintSql, sqlString } from './bitmap-reference';
import { bitmapDatabasePath, resolveBitmapPath } from './sync-aws-transactions';

type ImportOptions = { source: string; database?: string; from: string; signal?: AbortSignal; log?: (message: string)=>void };

/** Copy a trusted contiguous reference in height order, preserving newer rows. */
export async function importBitmaps(options: ImportOptions) {
    if (!validDate(options.from)) throw Error('Use --from YYYY-MM-DD for the UTC date of the reference boundary.');
    const source=await realpath(resolve(options.source)),destination=resolve(options.database ?? bitmapDatabasePath);
    if (source===destination || (await stat(source)).isDirectory()) throw Error('Use a separate DuckDB source file.');
    await safeDirectory(dirname(destination));
    const release=await acquireSyncLock(dirname(destination),basename(destination)+'.sync.lock');
    const signal=options.signal ?? new AbortController().signal;
    let db: Awaited<ReturnType<typeof openBitmapDatabase>>|undefined,attached=false;
    const interrupt=()=>db?.interrupt();
    try {
        db=await openBitmapDatabase(destination);
        signal.addEventListener('abort',interrupt,{once:true});
        await db.exec(`ATTACH ${sqlString(source)} AS seed_source (READ_ONLY); SET threads=1;`);attached=true;
        const meta=(await db.all(`SELECT count(*)::INTEGER AS rows,count(DISTINCT bitmap)::INTEGER AS heights,
            min(bitmap) AS first,max(bitmap) AS last FROM seed_source.bitmaps`))[0]!;
        if (!meta.rows || meta.first!==0 || meta.heights!==meta.rows || meta.last+1!==meta.rows)
            throw Error('The source must contain unique, consecutive block heights starting at 0.');
        const invalid=Number((await db.all(`SELECT count(*) AS n FROM seed_source.bitmaps b
            LEFT JOIN seed_source.bitmaps p ON p.bitmap=b.pattern
            WHERE b.tx IS NULL OR array_length(b.tx)=0 OR list_min(b.tx)<1 OR b.size IS NULL OR array_length(b.size)<>2
                OR list_min(b.size)<1 OR b.pattern IS NULL OR b.pattern<0 OR b.pattern>b.bitmap OR p.pattern<>p.bitmap OR p.bitmap IS NULL`))[0]!.n);
        if (invalid) throw Error(`The source contains ${invalid} invalid bitmap rows or pattern references.`);
        const differences=Number((await db.all(`SELECT count(*) AS n FROM bitmaps b JOIN seed_source.bitmaps s USING(bitmap)
            WHERE b.tx<>s.tx OR b.size<>s.size`))[0]!.n);
        if (differences) throw Error(`${differences} existing rows differ from the source; no bitmap data was changed.`);
        const oldSeed=Number((await db.all("SELECT value FROM settings WHERE name='seed_height'"))[0]?.value ?? -1);
        if (oldSeed>meta.last) throw Error('The source is shorter than the existing imported baseline.');
        options.log?.(`Copying ${meta.rows.toLocaleString('en-US')} bitmaps in ascending height order…`);
        signal.throwIfAborted();
        await db.exec('BEGIN TRANSACTION');
        try {
            await db.exec(`CREATE TABLE seeded_bitmaps (bitmap UINTEGER PRIMARY KEY,tx UTINYINT[] NOT NULL,
                size UINTEGER[] NOT NULL,pattern BIGINT NOT NULL);
                INSERT INTO seeded_bitmaps SELECT * FROM (
                    SELECT bitmap::UINTEGER AS bitmap,tx::UTINYINT[] AS tx,size::UINTEGER[] AS size,pattern::BIGINT AS pattern FROM seed_source.bitmaps
                    UNION ALL SELECT bitmap,tx,size,pattern FROM bitmaps WHERE bitmap>${meta.last}
                ) ORDER BY bitmap ASC;
                DROP TABLE bitmaps; ALTER TABLE seeded_bitmaps RENAME TO bitmaps;
                CREATE INDEX bitmaps_pattern ON bitmaps(pattern);
                UPDATE patterns SET first_bitmap=s.pattern FROM seed_source.bitmaps s WHERE patterns.first_bitmap=s.bitmap;`);
            options.log?.('Indexing imported pattern candidates…');
            await db.exec(`DELETE FROM seed_patterns;
                INSERT INTO seed_patterns SELECT bitmap,${seedFingerprintSql('tx','size')} FROM bitmaps b
                WHERE bitmap=pattern AND bitmap<=${meta.last}
                    AND NOT EXISTS(SELECT 1 FROM patterns p WHERE p.first_bitmap=b.bitmap) ORDER BY bitmap ASC;`);
            // Existing later matches may now have an earlier imported equivalent.
            for (const row of await db.all(`SELECT b.bitmap,b.tx,b.size FROM patterns p JOIN bitmaps b ON b.bitmap=p.first_bitmap
                WHERE p.first_bitmap>${meta.last} ORDER BY b.bitmap`)) {
                signal.throwIfAborted();
                await resolveSeedPattern(db!,row.tx,row.size,bitmapGeometry(row.tx).hash,true);
            }
            for (const [name,value] of [['seed_height',String(meta.last)],['seed_from_date',options.from],['seed_source',source]])
                await db.exec(`INSERT INTO settings VALUES (${sqlString(name)},${sqlString(value)}) ON CONFLICT(name) DO UPDATE SET value=excluded.value`);
            await db.exec(`INSERT INTO settings VALUES ('endpoint',${sqlString(AWS_BITCOIN_ENDPOINT)}) ON CONFLICT DO NOTHING`);
            const mismatches=Number((await db.all(`SELECT count(*) AS n FROM seed_source.bitmaps s LEFT JOIN bitmaps b USING(bitmap)
                WHERE b.bitmap IS NULL OR b.tx<>s.tx OR b.size<>s.size OR b.pattern<>s.pattern`))[0]!.n);
            if (mismatches) throw Error(`Imported data verification failed for ${mismatches} rows.`);
            signal.throwIfAborted();await db.exec('COMMIT');
        } catch (error) {await db.exec('ROLLBACK');throw error;}
        await db.exec('CHECKPOINT');
        return {source,database:destination,copiedBitmaps:meta.rows,firstBitmap:0,lastBitmap:meta.last,nextBitmap:meta.last+1,
            syncFrom:options.from,verified:true};
    } finally {
        signal.removeEventListener('abort',interrupt);
        try {if(attached) await db?.exec('DETACH seed_source');} finally {try {await db?.close();} finally {await release();}}
    }
}

if(import.meta.main) {
    const controller=new AbortController(),stop=()=>controller.abort(Error('Import interrupted; uncommitted changes rolled back.'));
    process.once('SIGINT',stop);process.once('SIGTERM',stop);
    try {
        const args=argumentsFor(process.argv.slice(2),['--source','--db','--from']);
        if(!args['--source'] || !args['--from']) throw Error('Use --source FILE --from YYYY-MM-DD [--db data/db/bitmaps.db].');
        const result=await importBitmaps({source:args['--source'],database:resolveBitmapPath(args['--db']),from:args['--from'],signal:controller.signal,log:console.error});
        console.log(JSON.stringify(result,null,2));
    } catch(error) {console.error(error instanceof Error ? error.message : error);process.exitCode=1;}
    finally {process.off('SIGINT',stop);process.off('SIGTERM',stop);}
}
