import { expect, test } from 'bun:test';
import { Database as DuckDB } from './duckdb';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { projectParquet, TRANSACTION_COLUMNS } from './aws-download';
import { parseListing, TRANSACTION_PREFIX } from './aws-public-data';
import { awsTransactionStatus, createSyncLogger, formatSyncEvent, readOnlyBitmapDatabase, syncAwsCommand, syncAwsTransactions, type SyncActivity, type SyncEvent, type SyncOptions } from './sync-aws-transactions';
import { bitmapGeometry, importPartition, openBitmapDatabase, parcelSize, readBitmap, sqlString } from './bitmap-reference';
import { importBitmaps } from './import-bitmaps';
import { validateBitmapDatabase } from './validate-bitmap-db';
import { generateStatic } from './generate-static';

const endpoint = 'https://aws.fixture.invalid/';
const key = (date: string, name = 'part-a') => `${TRANSACTION_PREFIX}date=${date}/${name}.parquet`;
type ObjectData = { bytes: Buffer; etag: string; modified: string };
function object(bytes: Buffer): ObjectData {
    return { bytes, etag: '"' + createHash('md5').update(bytes).digest('hex') + '"', modified: '2026-10-01T00:00:00.000Z' };
}
const xml = (entries: [string, ObjectData][], next = '') => `<ListBucketResult><EncodingType>url</EncodingType>
    <KeyCount>${entries.length}</KeyCount><IsTruncated>${!!next}</IsTruncated>
    ${entries.map(([k, o]) => `<Contents><Key>${encodeURIComponent(k)}</Key><ETag>${o.etag.replaceAll('"', '&quot;')}</ETag>
    <LastModified>${o.modified}</LastModified><Size>${o.bytes.length}</Size></Contents>`).join('')}
    ${next ? `<NextContinuationToken>${next}</NextContinuationToken>` : ''}</ListBucketResult>`;
function source() {
    const objects = new Map<string, ObjectData>(), gets: string[] = [];
    let throttles = 0, corruptKey = '';
    const fetcher = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        if (url.searchParams.has('list-type')) {
            const prefix = url.searchParams.get('prefix')!, after = url.searchParams.get('start-after') || '';
            const entries = [...objects].sort(([a], [b]) => a.localeCompare(b)).filter(([k]) => k.startsWith(prefix) && k > after);
            const offset = Number(url.searchParams.get('continuation-token') || 0), page = entries.slice(offset, offset + 1);
            return new Response(xml(page, offset + 1 < entries.length ? String(offset + 1) : ''));
        }
        const name = decodeURIComponent(url.pathname.slice(1)), value = objects.get(name);
        if (throttles > 0) { throttles--; return new Response('', { status: 429, headers: { 'Retry-After': '0' } }); }
        if (!value) return new Response('', { status: 404 });
        if (new Headers(init?.headers).get('if-match') !== value.etag) return new Response('', { status: 412 });
        return new Response(null, { headers: {
            ETag: value.etag, 'Content-Length': String(value.bytes.length), 'x-amz-checksum-type': 'FULL_OBJECT',
            'x-amz-checksum-sha256': createHash('sha256').update(corruptKey === name ? Buffer.from('wrong') : value.bytes).digest('base64'),
        } });
    }, { preconnect: fetch.preconnect });
    return { objects, gets, fetcher, isCorrupt: (k: string) => corruptKey === k, throttle: () => { throttles++; }, corrupt: (k: string) => { corruptKey = k; } };
}

type Tx = { block: number; index: number; sats: bigint; hash?: string };
async function parquet(directory: string, date: string, rows: Tx[]): Promise<Buffer> {
    const path = join(directory, `fixture-${createHash('sha256').update(JSON.stringify(rows,(_,v)=>typeof v==='bigint'?v.toString():v)).digest('hex')}.parquet`);
    const db = await DuckDB.create(':memory:');
    try {
        const values = rows.map(r => `(${r.block},${r.index},${sqlString(r.hash ?? 'a'.repeat(64))},${r.sats.toString()})`).join(',');
        await db.exec(`COPY (SELECT bitmap AS block_number,txindex AS "index",block_hash,${sqlString(date)} AS date,
            [struct_pack(value:=CAST(satoshis AS DECIMAL(28,8))/100000000)] AS outputs, CAST(satoshis AS DOUBLE)/100000000 AS output_value
            FROM (VALUES ${values}) AS t(bitmap,txindex,block_hash,satoshis)) TO ${sqlString(path)} (FORMAT PARQUET)`);
        return await readFile(path);
    } finally { await db.close(); }
}
async function fixture(run: (directory: string, remote: ReturnType<typeof source>, options: SyncOptions) => Promise<void>) {
    const directory = await mkdtemp('/tmp/bitmap-aws-import-'), remote = source();
    const projector: NonNullable<SyncOptions['projectParquet']> = async (url,destination,signal,extensions) => {
        const name=decodeURIComponent(new URL(url).pathname.slice(1)),value=remote.objects.get(name)!;
        remote.gets.push(name);
        if (remote.isCorrupt(name)) throw Error('Corrupt Parquet fixture.');
        const sourcePath=join(directory,'projection-'+createHash('sha256').update(name).digest('hex')+'.parquet');
        await writeFile(sourcePath,value.bytes);
        await projectParquet(sourcePath,destination,signal,extensions);
        return value.bytes.length;
    };
    try { await run(directory,remote,{dbPath:join(directory,'db/bitmaps.db'),workRoot:join(directory,'work'),
        endpoint,fetcher:remote.fetcher,projectParquet:projector,retries:0,retryDelayMs:0}); }
    finally { await rm(directory, { recursive: true, force: true }); }
}
async function read(path: string,height: number) { const db=await readOnlyBitmapDatabase(path); try { return await readBitmap(db,height); } finally { await db.close(); } }

test('a new checkout restores the Protobuf prefix before AWS and imports only later block heights', async () => {
    await fixture(async (directory, remote, options) => {
        const seed = join(directory, 'seed.db'), db = await openBitmapDatabase(seed);
        try { await db.exec('INSERT INTO bitmaps SELECT i::UINTEGER,[5]::UTINYINT[],[5,5]::UINTEGER[],0::BIGINT FROM range(2016) t(i)'); }
        finally { await db.close(); }
        const source = await generateStatic({ db: seed, geometry: 'none', out: join(directory, 'protobufs'), colorsFrom: 'none' });
        remote.objects.set(key('2009-01-03'), object(await parquet(directory, '2009-01-03', [{ block: 0, index: 0, sats: 1n }])));
        remote.objects.set(key('2009-01-04'), object(await parquet(directory, '2009-01-04', [
            { block: 2015, index: 0, sats: 1n }, { block: 2016, index: 0, sats: 1000000001n },
        ])));
        const configured = { ...options, bootstrapSource: source, bootstrapFrom: '2009-01-04' };
        const report = await syncAwsTransactions(configured);
        expect(report).toMatchObject({ importedBitmaps: 1, lastBitmap: 2016 });
        expect(remote.gets).toEqual([key('2009-01-04')]);
        expect((await read(options.dbPath!, 0))!.tx).toEqual([5]);
        expect((await read(options.dbPath!, 2015))!.tx).toEqual([5]);
        expect((await read(options.dbPath!, 2016))!.pattern).toBe(0);
        expect(await validateBitmapDatabase(options.dbPath!)).toMatchObject({ status: 'passed', checked: 2016, outsideReference: 1, patternsChecked: true });
        expect((await syncAwsTransactions(configured)).importedBitmaps).toBe(0);
        expect(remote.gets).toEqual([key('2009-01-04')]);
    });
}, 60000);

async function seedReference(directory: string) {
    const path=join(directory,'reference.duck'),db=await DuckDB.create(path);
    try {
        await db.exec(`CREATE TABLE bitmaps(bitmap INTEGER PRIMARY KEY,tx UTINYINT[],size USMALLINT[],pattern INTEGER);
            INSERT INTO bitmaps VALUES (4,[2],[2,2],4),(2,[5,5,1,2,1,5],[9,15],0),
                (0,[5,5,5,1,2,1],[9,15],0),(3,[1],[1,1],3),(1,[5],[5,5],1)`);
    } finally {await db.close();}
    return path;
}

test('reference import orders heights and resumes after the seed without downloading its old history',async()=>{
    await fixture(async(directory,remote,options)=>{
        await syncAwsTransactions(options);
        const sourcePath=await seedReference(directory);
        const result=await importBitmaps({source:sourcePath,database:options.dbPath,from:'2009-01-04'});
        expect(result).toMatchObject({copiedBitmaps:5,lastBitmap:4,nextBitmap:5,verified:true});
        const db=await readOnlyBitmapDatabase(options.dbPath!);
        try {
            expect((await db.all('SELECT bitmap FROM bitmaps')).map(row=>row.bitmap)).toEqual([0,1,2,3,4]);
            expect(Number((await db.all('SELECT count(*) AS n FROM seed_patterns'))[0]!.n)).toBe(4);
        } finally {await db.close();}
        const tx=[5,5,1,2,1,5];
        remote.objects.set(key('2009-01-04'),object(await parquet(directory,'2009-01-04',[{block:4,index:0,sats:1000001n}])));
        const covered=await syncAwsTransactions(options);
        expect(covered.importedBitmaps).toBe(0);expect(covered.skippedPartitions).toBe(1);
        expect((await awsTransactionStatus(options.dbPath)).bitmaps).toBe(5);
        remote.objects.set(key('2009-01-03'),object(await parquet(directory,'2009-01-03',[{block:0,index:0,sats:1n}])));
        remote.objects.set(key('2009-01-04'),object(await parquet(directory,'2009-01-04',tx.map((side,index)=>({
            block:5,index,sats:side===1?1n:10n**BigInt(side+4)+1n,
        })))));
        const synced=await syncAwsTransactions(options);
        expect(synced.listedFiles).toBe(1);expect(synced.importedBitmaps).toBe(1);
        expect(await read(options.dbPath!,5)).toEqual({bitmap:5,tx,size:[9,15],pattern:0});
        expect((await read(options.dbPath!,0))!.tx).toEqual([5,5,5,1,2,1]);
        expect((await syncAwsTransactions(options)).downloadedFiles).toBe(0);
        const damaged=await DuckDB.create(options.dbPath!);
        try {await damaged.exec('DELETE FROM bitmaps WHERE bitmap=3');} finally {await damaged.close();}
        await expect(syncAwsTransactions(options)).rejects.toThrow('baseline has missing blocks');
        await importBitmaps({source:sourcePath,database:options.dbPath,from:'2009-01-04'});
        expect((await awsTransactionStatus(options.dbPath)).missingBitmaps).toBe(0);
        expect((await read(options.dbPath!,5))!.pattern).toBe(0);
        expect(await validateBitmapDatabase(options.dbPath!)).toMatchObject({status:'passed',checked:5,outsideReference:1,
            txMismatches:0,sizeMismatches:0,patternMismatches:0});
    });
});

test('reference import preserves later rows and repairs their patterns against the older imported history',async()=>{
    await fixture(async(directory,remote,options)=>{
        const tx=[5,5,1,2,1,5],date='2009-01-04';
        remote.objects.set(key(date),object(await parquet(directory,date,tx.map((side,index)=>({
            block:5,index,sats:side===1?1n:10n**BigInt(side+4)+1n,
        })))));
        await syncAwsTransactions(options);
        expect((await read(options.dbPath!,5))!.pattern).toBe(5);
        await importBitmaps({source:await seedReference(directory),database:options.dbPath,from:date});
        expect((await read(options.dbPath!,5))!.pattern).toBe(0);
        expect((await awsTransactionStatus(options.dbPath)).bitmaps).toBe(6);
        expect((await syncAwsTransactions(options)).downloadedFiles).toBe(0);
    });
});

test('reference import rejects conflicting overlap without changing existing data',async()=>{
    await fixture(async(directory,remote,options)=>{
        const date='2009-01-03';
        remote.objects.set(key(date),object(await parquet(directory,date,[{block:0,index:0,sats:1n}])));
        await syncAwsTransactions(options);
        await expect(importBitmaps({source:await seedReference(directory),database:options.dbPath,from:date})).rejects.toThrow('existing rows differ');
        expect(await read(options.dbPath!,0)).toEqual({bitmap:0,tx:[1],size:[1,1],pattern:0});
        expect((await awsTransactionStatus(options.dbPath)).bitmaps).toBe(1);
    });
});

test('reference import restores earlier pattern IDs for overlapping rows and their cached hashes',async()=>{
    await fixture(async(directory,remote,options)=>{
        const tx=[5,5,1,2,1,5],date='2009-01-03';
        remote.objects.set(key(date),object(await parquet(directory,date,tx.map((side,index)=>({
            block:2,index,sats:side===1?1n:10n**BigInt(side+4)+1n,
        })))));
        await syncAwsTransactions(options);
        expect((await read(options.dbPath!,2))!.pattern).toBe(2);
        await importBitmaps({source:await seedReference(directory),database:options.dbPath,from:date});
        expect((await read(options.dbPath!,2))!.pattern).toBe(0);
        const db=await readOnlyBitmapDatabase(options.dbPath!);
        try {expect(Number((await db.all('SELECT first_bitmap FROM patterns WHERE hash=?',bitmapGeometry(tx).hash))[0]!.first_bitmap)).toBe(0);}
        finally {await db.close();}
    });
});

test('parcel thresholds use total output satoshis and visual hashes ignore transaction ordering only when geometry matches', () => {
    expect([0n,1n,1000000n,1000001n,10000000n,10000001n,5000000000n].map(parcelSize)).toEqual([1,1,1,2,2,3,5]);
    expect(() => parcelSize(-1n)).toThrow();
    expect(bitmapGeometry([5,5]).size).toEqual([5,10]);
    // Captured reference pair: bitmap 100000 points to the earlier bitmap 68460.
    expect(bitmapGeometry([5,4,5,1]).hash).toBe(bitmapGeometry([5,5,4,1]).hash);
    expect(bitmapGeometry([5,5,4,1]).size).toEqual([9,10]);
    expect(bitmapGeometry([5,1]).hash).not.toBe(bitmapGeometry([1,5]).hash);
});

test('listing rejects unrelated paths, invalid dates, duplicates and malformed pagination', () => {
    const o=object(Buffer.from('PAR1testPAR1')), k=key('2009-01-03');
    expect(parseListing(xml([[k,o]])).objects[0].date).toBe('2009-01-03');
    for(const bad of [k.replace('transactions','blocks'),key('2009-02-30'),TRANSACTION_PREFIX+'date=2009-01-03/../a.parquet'])
        expect(()=>parseListing(xml([[bad,o]]))).toThrow();
    expect(()=>parseListing(xml([[k,o],[k,o]]))).toThrow();
    expect(()=>parseListing(xml([[k,o]]).replace('<IsTruncated>false','<IsTruncated>true'))).toThrow();
});

test('a complete daily partition is ordered, imported to DuckDB and deleted; a rerun downloads zero bytes', async () => {
    await fixture(async (directory,remote,options)=>{
        const date='2009-01-03',a=key(date),b=key(date,'part-b');
        remote.objects.set(a,object(await parquet(directory,date,[{block:0,index:1,sats:5000000000n}])));
        remote.objects.set(b,object(await parquet(directory,date,[{block:0,index:0,sats:5000000000n}])));
        const events: SyncEvent[]=[];
        const first=await syncAwsTransactions({...options,log:event=>events.push(event)}); expect(first.downloadedFiles).toBe(2);expect(first.importedBitmaps).toBe(1);
        const transferred=remote.objects.get(a)!.bytes.length+remote.objects.get(b)!.bytes.length;
        expect(first.bytesDownloaded).toBe(transferred);
        expect(events.at(-1)).toMatchObject({stage:'progress',dayBytesDownloaded:transferred,bytesDownloaded:transferred});
        expect(formatSyncEvent(events.at(-1)!)).toContain(' MB');
        expect((await read(options.dbPath!,0))).toEqual({bitmap:0,tx:[5,5],size:[5,10],pattern:0});
        await expect(lstat(join(options.workRoot!,'transactions',`date=${date}`,'part-a.parquet'))).rejects.toThrow('ENOENT');
        await expect(lstat(join(options.workRoot!,'transactions',`date=${date}`))).rejects.toThrow('ENOENT');
        const second=await syncAwsTransactions(options);expect(second.bytesStaged).toBe(0);expect(second.skippedPartitions).toBe(1);
        expect(second.bytesDownloaded).toBe(0);
        expect(remote.gets.length).toBe(2);expect((await awsTransactionStatus(options.dbPath)).processedFiles).toBe(2);
    });
});

test('sync emits timed activity while a file is pending and stops the heartbeat after completion', async () => {
    await fixture(async (directory, remote, options) => {
        const date = '2009-01-03', events: SyncEvent[] = [];
        const first = object(await parquet(directory, date, [{ block: 0, index: 0, sats: 1n }]));
        remote.objects.set(key(date), first);
        remote.objects.set(key(date, 'part-b'), object(await parquet(directory, date, [{ block: 1, index: 0, sats: 1n }])));
        let release!: () => void;
        const pending = new Promise<void>(resolve => { release = resolve; });
        const sync = syncAwsTransactions({ ...options, concurrency: 1,
            projectParquet: async (...args) => {
                if (args[0].includes('part-b')) await pending;
                return options.projectParquet!(...args);
            },
            log: event => {
                events.push(event);
                if (event.stage === 'activity' && event.phase === 'downloading' && event.elapsedSeconds >= 1) release();
            },
        });
        try { await sync; } finally { release(); }
        const heartbeat = events.find(event => event.stage === 'activity' && event.phase === 'downloading' && event.elapsedSeconds >= 1);
        expect(heartbeat).toMatchObject({ filesCompleted: 1, fileCount: 2, dayBytesDownloaded: first.bytes.length });
        expect(events.some(event => event.stage === 'activity' && event.phase === 'importing' && event.filesCompleted === 2)).toBe(true);
        expect(events.at(-1)).toMatchObject({ stage: 'progress', action: 'imported', blocks: 2 });
        const count = events.length;
        await Bun.sleep(1100);
        expect(events.length).toBe(count);
    });
});

test('an interrupted download clears the activity heartbeat', async () => {
    await fixture(async (directory, remote, options) => {
        const date = '2009-01-03', controller = new AbortController(), events: SyncEvent[] = [];
        remote.objects.set(key(date), object(await parquet(directory, date, [{ block: 0, index: 0, sats: 1n }])));
        await expect(syncAwsTransactions({ ...options, signal: controller.signal,
            projectParquet: async (_source, _destination, signal) => {
                await new Promise<void>((_resolve, reject) => {
                    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
                });
                return 0;
            },
            log: event => {
                events.push(event);
                if (event.stage === 'activity' && event.phase === 'downloading' && event.elapsedSeconds >= 1)
                    controller.abort(Error('cancelled fixture'));
            },
        })).rejects.toThrow('cancelled fixture');
        const count = events.length;
        await Bun.sleep(1100);
        expect(events.length).toBe(count);
    });
});

test('activity redraws one terminal line and preserves completed lines; redirected and JSON logs have no escapes', () => {
    const activity: SyncActivity = { stage: 'activity', phase: 'downloading', date: '2009-01-03', block: 0,
        filesCompleted: 1, fileCount: 2, dayBytesDownloaded: 1_250_000, elapsedSeconds: 12 };
    expect(formatSyncEvent(activity)).toBe('2009-01-03 | Downloading | 1/2 files ready | 1.25 MB confirmed | 12s');
    const terminal: string[] = [], logger = createSyncLogger(false, { isTTY: true, columns: 120, write: text => terminal.push(text) });
    logger.log(activity); logger.log({ ...activity, elapsedSeconds: 13 });
    expect(terminal.join('')).not.toContain('\n');
    logger.log({ stage: 'start', block: 1, database: 'fixture.db', dryRun: false });
    expect(terminal.at(-2)).toBe('\r\x1b[2K');
    expect(terminal.at(-1)).toBe('Block 1 | Resuming sync\n');
    const count = terminal.length; logger.clear(); expect(terminal.length).toBe(count);
    const narrow: string[] = [], narrowLogger = createSyncLogger(false, { isTTY: true, columns: 40, write: text => narrow.push(text) });
    narrowLogger.log(activity); expect(narrow[0]!.replace('\r\x1b[2K', '').length).toBe(39);
    const plain: string[] = [], plainLogger = createSyncLogger(false, { write: text => plain.push(text) });
    plainLogger.log(activity); plainLogger.log({ ...activity, elapsedSeconds: 13 }); plainLogger.clear();
    expect(plain).toEqual([formatSyncEvent(activity) + '\n']);
    const json: string[] = [], jsonLogger = createSyncLogger(true, { isTTY: true, write: text => json.push(text) });
    jsonLogger.log(activity); jsonLogger.clear();
    expect(JSON.parse(json[0]!)).toEqual(activity);
});

test('startup removes leftover empty date folders while retaining files and unknown directories',async()=>{
    await fixture(async(_directory,_remote,options)=>{
        const root=join(options.workRoot!,'transactions');
        for(const name of ['date=2009-01-03','date=2009-01-04','date=2009-01-05','notes'])
            await mkdir(join(root,name),{recursive:true});
        await writeFile(join(root,'date=2009-01-04','unfinished.parquet'),'unfinished');
        await writeFile(join(root,'date=2009-01-05','notes.txt'),'keep');
        await syncAwsTransactions(options);
        await expect(lstat(join(root,'date=2009-01-03'))).rejects.toThrow('ENOENT');
        expect(await readFile(join(root,'date=2009-01-04','unfinished.parquet'),'utf8')).toBe('unfinished');
        expect(await readFile(join(root,'date=2009-01-05','notes.txt'),'utf8')).toBe('keep');
        expect((await lstat(join(root,'notes'))).isDirectory()).toBe(true);
    });
});

test('DuckDB stores native arrays and retained Parquet files contain only the required columns', async () => {
    await fixture(async (directory, remote, options) => {
        const date='2009-01-03',name=key(date);
        remote.objects.set(name,object(await parquet(directory,date,[{block:0,index:0,sats:5000000000n}])));
        const result=await syncAwsTransactions({...options,keepParquet:true});
        const staged=join(options.workRoot!,'transactions',`date=${date}`,'part-a.parquet');
        const db=await readOnlyBitmapDatabase(options.dbPath!);
        try {
            expect((await Bun.file(options.dbPath!).slice(8,12).text())).toBe('DUCK');
            const schema=await db.all('DESCRIBE bitmaps');
            expect(schema.map(row=>row.column_name)).toEqual(['bitmap','tx','size','pattern']);
            expect(schema.find(row=>row.column_name==='tx')!.column_type).toBe('UTINYINT[]');
            expect((await db.all(`DESCRIBE SELECT * FROM read_parquet(${sqlString(staged)})`)).map(row=>row.column_name)).toEqual([...TRANSACTION_COLUMNS]);
            expect(result.bytesStaged).toBe((await lstat(staged)).size);
        } finally { await db.close(); }
    });
});

test('an object replaced during column projection is rejected before checkpointing', async () => {
    await fixture(async (directory,remote,options) => {
        const date='2009-01-03',name=key(date);
        remote.objects.set(name,object(await parquet(directory,date,[{block:0,index:0,sats:1n}])));
        const project=options.projectParquet!;
        await expect(syncAwsTransactions({...options,projectParquet:async(...args)=>{
            const bytes=await project(...args);
            remote.objects.set(name,{...remote.objects.get(name)!,etag:'"changed"'});
            return bytes;
        }})).rejects.toThrow('412');
        const status=await awsTransactionStatus(options.dbPath);
        expect(status.bitmaps).toBe(0); expect(status.partitions).toBe(0);
        expect(status.cachedDownloads).toBe(0);
    });
});

test('partition ranges preserve gaps and other days; missing block rows are detected and repaired', async () => {
    await fixture(async (directory, remote, options) => {
        const first = '2009-01-03', second = '2009-01-04';
        remote.objects.set(key(first), object(await parquet(directory, first, [
            { block: 0, index: 0, sats: 5000000000n }, { block: 2, index: 0, sats: 5000000000n },
        ])));
        remote.objects.set(key(second), object(await parquet(directory, second, [{ block: 1, index: 0, sats: 5000000000n }])));
        await syncAwsTransactions(options);
        const db = await readOnlyBitmapDatabase(options.dbPath!);
        try {
            expect((await db.all('SELECT block_ranges FROM aws_partitions WHERE date=?',first))[0]!.block_ranges).toEqual([[0,0],[2,2]]);
            expect((await db.all('SELECT count(*)::INTEGER AS n FROM patterns'))[0]).toEqual({ n: 1 });
        } finally { await db.close(); }
        const damaged = await DuckDB.create(options.dbPath!);
        try { await damaged.exec('DELETE FROM bitmaps WHERE bitmap=1'); } finally { await damaged.close(); }
        expect((await awsTransactionStatus(options.dbPath)).missingBitmaps).toBe(1);
        const repaired = await syncAwsTransactions(options);
        expect(repaired.downloadedFiles).toBe(1); expect(repaired.skippedPartitions).toBe(1);
        expect((await awsTransactionStatus(options.dbPath)).missingBitmaps).toBe(0);
        remote.objects.set(key(first), object(await parquet(directory, first, [
            { block: 0, index: 0, sats: 1n }, { block: 2, index: 0, sats: 5000000000n },
        ])));
        await syncAwsTransactions(options);
        expect((await read(options.dbPath!, 1))!.tx).toEqual([5]);
        expect((await read(options.dbPath!, 2))!.pattern).toBe(1);
    });
});

test('replacing a day can swap earliest pattern identities without merging distinct geometries', async () => {
    await fixture(async (directory, remote, options) => {
        const date = '2009-01-03';
        for (const amounts of [[1n,1000001n,1n,1000001n], [1000001n,1n,1000001n,1n]]) {
            remote.objects.set(key(date), object(await parquet(directory, date, amounts.map((sats, block) => ({ block, index: 0, sats })))));
            await syncAwsTransactions(options);
        }
        expect(await Promise.all([0,1,2,3].map(async height => (await read(options.dbPath!, height))!.pattern))).toEqual([0,1,0,1]);
        expect(await Promise.all([0,1,2,3].map(async height => (await read(options.dbPath!, height))!.tx))).toEqual([[2],[1],[2],[1]]);
    });
});

test('corrected source dates transfer height ownership and converge to a zero-download rerun', async () => {
    await fixture(async (directory, remote, options) => {
        const first = '2009-01-03', second = '2009-01-04';
        const set = async (date: string, heights: number[]) => remote.objects.set(key(date), object(await parquet(directory, date,
            heights.map(block => ({ block, index: 0, sats: 5000000000n })))));
        await set(first, [0,1]); await set(second, [2]); await syncAwsTransactions(options);
        await set(first, [0,2]); await set(second, [1]);
        expect((await syncAwsTransactions(options)).importedPartitions).toBe(2);
        const rerun = await syncAwsTransactions(options);
        expect(rerun.skippedPartitions).toBe(2); expect(rerun.downloadedFiles).toBe(0);
        expect((await awsTransactionStatus(options.dbPath)).missingBitmaps).toBe(0);
        expect(await Promise.all([0,1,2].map(async height => (await read(options.dbPath!, height))!.pattern))).toEqual([0,0,0]);
    });
});

test('changed partitions replace rows and recompute earliest patterns, including older imports arriving later', async () => {
    await fixture(async (directory,remote,options)=>{
        const first='2009-01-09',second='2009-01-10';
        remote.objects.set(key(second),object(await parquet(directory,second,[{block:10,index:0,sats:5000000000n}])));
        await syncAwsTransactions(options); expect((await read(options.dbPath!,10))!.pattern).toBe(10);
        remote.objects.set(key(first),object(await parquet(directory,first,[{block:0,index:0,sats:5000000000n}])));
        await syncAwsTransactions(options);expect((await read(options.dbPath!,10))!.pattern).toBe(0);
        remote.objects.set(key(first),object(await parquet(directory,first,[{block:0,index:0,sats:1n}])));
        const update=await syncAwsTransactions(options);expect(update.downloadedFiles).toBe(1);
        expect((await read(options.dbPath!,0))!.tx).toEqual([1]);expect((await read(options.dbPath!,10))!.pattern).toBe(10);
    });
});

test('incomplete or corrupt updates roll back; completed downloads survive and are reused on restart', async () => {
    await fixture(async(directory,remote,options)=>{
        const date='2009-01-03',a=key(date),b=key(date,'part-b');
        remote.objects.set(a,object(await parquet(directory,date,[{block:0,index:0,sats:1n}])));
        await syncAwsTransactions(options);
        remote.objects.set(a,object(await parquet(directory,date,[{block:0,index:0,sats:5000000000n}])));
        remote.objects.set(b,object(await parquet(directory,date,[{block:0,index:2,sats:1n}])));
        await expect(syncAwsTransactions({...options,concurrency:1})).rejects.toThrow('incomplete');
        expect((await read(options.dbPath!,0))!.tx).toEqual([1]);
        remote.objects.set(b,object(await parquet(directory,date,[{block:0,index:1,sats:1n}])));
        const resumed=await syncAwsTransactions(options);expect(resumed.reusedDownloads).toBe(1);expect(resumed.downloadedFiles).toBe(1);
        expect(resumed.bytesDownloaded).toBe(remote.objects.get(b)!.bytes.length);
        expect((await read(options.dbPath!,0))!.tx).toEqual([5,1]);
        remote.objects.set(a,object(await parquet(directory,date,[{block:0,index:0,sats:20000000000n}])));remote.corrupt(a);
        await expect(syncAwsTransactions(options)).rejects.toThrow('Corrupt');expect((await read(options.dbPath!,0))!.tx).toEqual([5,1]);
    });
});

test('plan creates no persistent database, date-scoped sync does not replace other dates, and 429 retry is bounded',async()=>{
    await fixture(async(directory,remote,options)=>{
        for(const [i,date]of ['2009-01-03','2009-01-09'].entries())
            remote.objects.set(key(date),object(await parquet(directory,date,[{block:i,index:0,sats:1n}])));
        expect((await syncAwsTransactions({...options,dryRun:true})).filesPlanned).toBe(2);
        await expect(lstat(options.dbPath!)).rejects.toThrow('ENOENT');
        remote.throttle();await syncAwsTransactions({...options,retries:1});expect(remote.gets.length).toBe(2);
        const scoped=await syncAwsTransactions({...options,from:'2009-01-09',to:'2009-01-09'});
        expect(scoped.listedFiles).toBe(1);expect((await awsTransactionStatus(options.dbPath)).bitmaps).toBe(2);
        for(const args of [['--db','data/databases/bitmaps_simples.duck'],['--db','/tmp/outside.db'],['--keep-parquet','yes']])
            await expect(syncAwsCommand(args)).rejects.toThrow();
    });
});


test('cancelling a partition rolls back geometry, patterns and the source checkpoint together',async()=>{
    await fixture(async(directory,_remote,options)=>{
        const path=join(directory,'rollback.db'),db=await openBitmapDatabase(path,endpoint),signal=new AbortController();
        async function* initial(){yield{bitmap:0,blockHash:'a'.repeat(64),satoshis:[5000000000n]};}
        await importPartition(db,'2009-01-03','initial',[],initial(),signal.signal);
        async function* cancelled(){yield{bitmap:0,blockHash:'b'.repeat(64),satoshis:[1n]};signal.abort(Error('cancelled'));}
        try{
            await expect(importPartition(db,'2009-01-03','replacement',[],cancelled(),signal.signal)).rejects.toThrow('cancelled');
            expect((await readBitmap(db,0))!.tx).toEqual([5]);
            expect((await db.all('SELECT fingerprint FROM aws_partitions'))[0]!.fingerprint).toBe('initial');
            expect(Number((await db.all('SELECT count(*) AS n FROM patterns'))[0]!.n)).toBe(1);
        }finally{await db.close();}
    });
});


test('reference bitmaps 101965 and 100525 preserve their distinct sequences but share the earliest visual pattern',async()=>{
    await fixture(async(directory,remote,options)=>{
        const earlier=[5,5,5,1,2,1],later=[5,5,1,2,1,5];
        const amounts=(block:number,tx:number[])=>tx.map((side,index)=>({block,index,sats:side===1?1n:10n**BigInt(side+4)+1n}));
        remote.objects.set(key('2011-01-10'),object(await parquet(directory,'2011-01-10',amounts(101965,later))));
        await syncAwsTransactions(options);
        remote.objects.set(key('2011-01-01'),object(await parquet(directory,'2011-01-01',amounts(100525,earlier))));
        await syncAwsTransactions(options);
        expect((await read(options.dbPath!,100525))).toEqual({bitmap:100525,tx:earlier,size:[9,15],pattern:100525});
        expect((await read(options.dbPath!,101965))).toEqual({bitmap:101965,tx:later,size:[9,15],pattern:100525});
        expect(bitmapGeometry(earlier).hash).toBe('8db2b97243749f0ab61c8818f4e4598f18392b3ba2aeb7b40e5f303eac663d27');
    });
});


test('fresh checkout creates data directories and resumes from the saved block without displaying old skipped days',async()=>{
    await fixture(async(directory,remote,options)=>{
        const data=join(directory,'fresh-checkout/data'),events:SyncEvent[]=[];
        const fresh={...options,dbPath:join(data,'db/bitmaps.db'),workRoot:join(data,'aws/bitcoin'),log:(event:SyncEvent)=>events.push(event)};
        remote.objects.set(key('2009-01-03'),object(await parquet(directory,'2009-01-03',[{block:420,index:0,sats:1n}])));
        await expect(lstat(data)).rejects.toThrow('ENOENT');
        const initial=await syncAwsTransactions(fresh);
        expect((await lstat(join(data,'db'))).isDirectory()).toBe(true);
        expect((await lstat(join(data,'aws/bitcoin/.partial'))).isDirectory()).toBe(true);
        expect(initial.lastBitmap).toBe(420);
        expect(events[0]).toMatchObject({stage:'start',block:null});
        expect(events.at(-1)).toMatchObject({stage:'progress',action:'imported',block:420,blocks:1,transactions:1});
        events.length=0;
        const resumed=await syncAwsTransactions(fresh);
        expect(resumed.bytesStaged).toBe(0);
        expect(events[0]).toMatchObject({stage:'start',block:420});
        expect(events.filter(event=>event.stage==='progress').every(event=>formatSyncEvent(event)===null)).toBe(true);
    });
});
