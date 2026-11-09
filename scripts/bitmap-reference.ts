import { Database, OPEN_READONLY } from './duckdb';
import { createHash } from 'node:crypto';
import MondrianLayout from '../src/shared/MondrianLayout';
import type { RemoteObject } from './aws-public-data';

export const BITMAP_DB_FORMAT = 'bitmap-reference-duckdb-v1';
export const PARCEL_RULE = 'output-satoshis-ceil-log10-minus5-v1';
export const PATTERN_RULE = 'mondrian-square-rectangles-sha256-v1';
export type BitmapRecord = { bitmap: number; tx: number[]; size: number[]; pattern: number };
export type ImportedFile = RemoteObject & { sha256: string; bytes: number };
export type BlockAmounts = { bitmap: number; satoshis: bigint[] };
export type BlockRange = [number, number];
export const sqlString = (value: string) => "'" + value.replaceAll("'", "''") + "'";
export const sqlRanges = (ranges: BlockRange[]) => `CAST(${JSON.stringify(ranges)} AS UINTEGER[][])`;
export const seedFingerprintSql = (tx: string, size: string) => `md5_number_lower(
    CAST((${size})[1] AS VARCHAR)||','||CAST((${size})[2] AS VARCHAR)||':'||
    array_to_string(list_transform(list_sort(map_entries(list_histogram(${tx}))),
        e->CAST(e.key AS VARCHAR)||'='||CAST(e.value AS VARCHAR)),','))`;

/** Integer thresholds avoid floating-point log errors at powers of ten. */
export function parcelSize(satoshis: bigint): number {
    if (satoshis < 0n) throw Error('Negative transaction output value.');
    let side = 1, threshold = 1_000_000n;
    while (satoshis > threshold) { side++; threshold *= 10n; }
    if (side > 255) throw Error('Parcel size exceeds the reference byte domain.');
    return side;
}

export function bitmapGeometry(tx: readonly number[]) {
    if (!tx.length) throw Error('A bitmap must contain its coinbase transaction.');
    const layout = new MondrianLayout(tx);
    let width = 0, height = 0;
    for (const rect of layout.slots) { width = Math.max(width, rect.x + rect.width); height = Math.max(height, rect.y + rect.height); }
    const rectangles = layout.slots.slice().sort((a, b) => a.width - b.width || a.x - b.x || a.y - b.y);
    const bytes = Buffer.allocUnsafe(rectangles.length * 12);
    rectangles.forEach((rect, i) => {
        bytes.writeUInt32LE(rect.width, i * 12); bytes.writeUInt32LE(rect.x, i * 12 + 4); bytes.writeUInt32LE(rect.y, i * 12 + 8);
    });
    const hash = createHash('sha256').update(PATTERN_RULE + '\0').update(bytes).digest('hex');
    return { size: [width, height], hash };
}

export async function openBitmapDatabase(path: string, endpoint?: string, readonly = false): Promise<Database> {
    if (path !== ':memory:' && await Bun.file(path).exists() &&
        await Bun.file(path).slice(0, 16).text() === 'SQLite format 3\0')
        throw Error('The sync database is SQLite. Remove this generated file to start a fresh DuckDB sync.');
    const db = await Database.create(path, readonly ? OPEN_READONLY : undefined);
    try {
        const tables = await db.all('SHOW TABLES');
        if (tables.length && (!tables.some(t => t.name === 'settings') ||
            (await db.all("SELECT value FROM settings WHERE name='format'"))[0]?.value !== BITMAP_DB_FORMAT))
            throw Error('Existing file is not an AWS bitmap DuckDB database.');
        if (readonly) return db;
        await db.exec("SET threads=2; SET memory_limit='256MB'; BEGIN TRANSACTION;");
        try {
            await db.exec(`CREATE TABLE IF NOT EXISTS settings (name VARCHAR PRIMARY KEY,value VARCHAR NOT NULL);
                CREATE TABLE IF NOT EXISTS bitmaps (bitmap UINTEGER PRIMARY KEY,tx UTINYINT[] NOT NULL,
                    size UINTEGER[] NOT NULL,pattern BIGINT NOT NULL);
                CREATE INDEX IF NOT EXISTS bitmaps_pattern ON bitmaps(pattern);
                CREATE TABLE IF NOT EXISTS patterns (hash VARCHAR PRIMARY KEY,first_bitmap BIGINT NOT NULL);
                CREATE INDEX IF NOT EXISTS patterns_first_bitmap ON patterns(first_bitmap);
                CREATE TABLE IF NOT EXISTS seed_patterns (first_bitmap UINTEGER PRIMARY KEY,fingerprint UBIGINT NOT NULL);
                CREATE INDEX IF NOT EXISTS seed_patterns_fingerprint ON seed_patterns(fingerprint);
                CREATE TABLE IF NOT EXISTS aws_partitions (date VARCHAR PRIMARY KEY,fingerprint VARCHAR NOT NULL,
                    files INTEGER NOT NULL,blocks INTEGER NOT NULL,transactions BIGINT NOT NULL,processed_at VARCHAR NOT NULL,
                    block_ranges UINTEGER[][] NOT NULL);
                CREATE TABLE IF NOT EXISTS aws_files (key VARCHAR PRIMARY KEY,date VARCHAR NOT NULL,etag VARCHAR NOT NULL,
                    size BIGINT NOT NULL,modified VARCHAR NOT NULL,sha256 VARCHAR NOT NULL);
                CREATE INDEX IF NOT EXISTS aws_files_date ON aws_files(date);
                CREATE TABLE IF NOT EXISTS aws_downloads (key VARCHAR PRIMARY KEY,etag VARCHAR NOT NULL,
                    size BIGINT NOT NULL,sha256 VARCHAR NOT NULL,bytes BIGINT NOT NULL);`);
            for (const [name,value] of [['format',BITMAP_DB_FORMAT],['parcel_rule',PARCEL_RULE],['pattern_rule',PATTERN_RULE],
                ...(endpoint ? [['endpoint',endpoint]] : [])]) {
                await db.exec(`INSERT INTO settings VALUES (${sqlString(name)},${sqlString(value)}) ON CONFLICT DO NOTHING`);
                if ((await db.all('SELECT value FROM settings WHERE name=?',name))[0]?.value !== value)
                    throw Error(`Bitmap database ${name} does not match this importer.`);
            }
            await db.exec('COMMIT');
        } catch (error) { await db.exec('ROLLBACK'); throw error; }
        return db;
    } catch (error) { await db.close(); throw error; }
}

export async function readBitmap(db: Database, bitmap: number): Promise<BitmapRecord | null> {
    const row = (await db.all('SELECT bitmap,tx,size,pattern FROM bitmaps WHERE bitmap=?',bitmap))[0];
    return row ? { bitmap: Number(row.bitmap),tx: row.tx,size: row.size,pattern: Number(row.pattern) } : null;
}

export function partitionFingerprint(files: RemoteObject[]): string {
    return createHash('sha256').update(JSON.stringify(files.map(f => [f.key,f.etag,f.size]).sort((a,b) => String(a[0]).localeCompare(String(b[0]))))).digest('hex');
}

/** Resolve imported patterns lazily, using size and parcel counts as a prefilter. */
export async function resolveSeedPattern(db: Database,tx: number[],size: number[],hash: string,searchKnown=false): Promise<number|undefined> {
    let first=(await db.all('SELECT first_bitmap FROM patterns WHERE hash=?',hash))[0]?.first_bitmap;
    if (first !== undefined && !searchKnown) return Number(first);
    const candidates=await db.all(`SELECT s.first_bitmap,b.tx FROM seed_patterns s JOIN bitmaps b ON b.bitmap=s.first_bitmap
        WHERE s.fingerprint=${seedFingerprintSql(JSON.stringify(tx),JSON.stringify(size))}
        ${first === undefined ? '' : `AND s.first_bitmap<${Number(first)}`} ORDER BY s.first_bitmap`);
    for (const candidate of candidates) {
        const geometry=bitmapGeometry(candidate.tx),prior=(await db.all('SELECT first_bitmap FROM patterns WHERE hash=?',geometry.hash))[0];
        const earliest=Math.min(candidate.first_bitmap,prior ? Number(prior.first_bitmap) : Infinity);
        if (prior && earliest<Number(prior.first_bitmap)) await db.exec(`UPDATE bitmaps SET pattern=${earliest} WHERE pattern=${Number(prior.first_bitmap)}`);
        await db.exec(`INSERT INTO patterns VALUES (${sqlString(geometry.hash)},${earliest})
            ON CONFLICT(hash) DO UPDATE SET first_bitmap=excluded.first_bitmap;
            DELETE FROM seed_patterns WHERE first_bitmap=${candidate.first_bitmap}`);
        if (geometry.hash===hash) first=earliest;
    }
    return first === undefined ? undefined : Number(first);
}

/** Read projected scalar columns, preserving exact satoshi thresholds and TX order. */
export async function* parquetBitmaps(paths: string[], date: string, temporaryDirectory: string,afterBitmap=-1): AsyncGenerator<BlockAmounts> {
    const reader = await Database.create(':memory:');
    try {
        await reader.exec(`SET threads=2; SET memory_limit='256MB'; SET temp_directory=${sqlString(temporaryDirectory)}`);
        const files = '[' + paths.map(sqlString).join(',') + ']';
        const result = reader.stream(`WITH transactions AS (
            SELECT *,CAST(CAST(output_value AS DECIMAL(28,8))*100000000 AS BIGINT) AS satoshis
            FROM read_parquet(${files},union_by_name=true,hive_partitioning=false)
            WHERE block_number>${afterBitmap} OR block_number IS NULL OR block_number<0
        ) SELECT block_number AS bitmap,min(block_hash) AS block_hash,count(DISTINCT block_hash) AS hashes,
            min("index") AS first_index,max("index") AS last_index,count(DISTINCT "index") AS indices,count(*) AS count,
            count(*) FILTER(WHERE date<>? OR date IS NULL OR satoshis IS NULL OR satoshis<0) AS invalid,
            list(satoshis ORDER BY "index") AS satoshis
            FROM transactions GROUP BY block_number ORDER BY block_number`,date);
        for await (const row of result) {
            const height = Number(row.bitmap), count = Number(row.count);
            if (row.bitmap === null || !Number.isSafeInteger(height) || height < 0 || height > 0xffffffff || count < 1 ||
                Number(row.invalid) !== 0 || Number(row.hashes) !== 1 || !/^[a-f0-9]{64}$/.test(row.block_hash) ||
                Number(row.first_index) !== 0 || Number(row.last_index) !== count - 1 || Number(row.indices) !== count)
                throw Error(`Invalid or incomplete AWS transactions for block ${row.bitmap}.`);
            yield { bitmap: height,satoshis: row.satoshis.map((value: bigint) => BigInt(value)) };
        }
    } finally { await reader.close(); }
}

/** Replace one day's rows and checkpoint atomically; no metadata is stored per bitmap. */
export async function importPartition(db: Database,date: string,fingerprint: string,files: ImportedFile[],
    blocks: AsyncIterable<BlockAmounts>,signal: AbortSignal,afterBitmap=-1) {
    const affected = new Map<string,{ temporary: number; original?: number }>();
    const ranges: BlockRange[] = [],moved: number[] = [];
    const stagePattern = async (hash: string,tx?: number[],size?: number[]) => {
        const staged = affected.get(hash); if (staged) return staged.temporary;
        const original=tx && size ? await resolveSeedPattern(db,tx,size,hash) :
            (await db.all('SELECT first_bitmap FROM patterns WHERE hash=?',hash))[0]?.first_bitmap;
        const temporary = -affected.size-1;
        if (original === undefined) await db.exec(`INSERT INTO patterns VALUES (${sqlString(hash)},${temporary})`);
        affected.set(hash,{ temporary,original: original === undefined ? undefined : Number(original) }); return temporary;
    };
    let count=0,transactions=0,previous=-1;
    await db.exec('BEGIN TRANSACTION');
    try {
        const savedRanges: BlockRange[] = (await db.all('SELECT block_ranges FROM aws_partitions WHERE date=?',date))[0]?.block_ranges ?? [];
        const priorRanges: BlockRange[]=savedRanges.map(([start,end])=>[Math.max(start,afterBitmap+1),end] as BlockRange).filter(([start,end])=>start<=end);
        const members = `SELECT b.bitmap FROM bitmaps b JOIN unnest(${sqlRanges(priorRanges)}) t(r) ON b.bitmap BETWEEN r[1] AND r[2]`;
        for (const row of await db.all(`SELECT hash FROM patterns WHERE first_bitmap IN (
            SELECT DISTINCT pattern FROM bitmaps WHERE bitmap IN (${members}))`)) await stagePattern(row.hash);
        await db.exec(`DELETE FROM bitmaps WHERE bitmap IN (${members})`);
        for await (const block of blocks) {
            signal.throwIfAborted();
            if (block.bitmap <= previous) throw Error('Partition block heights must be unique and ordered.');
            if (block.bitmap<=afterBitmap) throw Error('Partition overlaps the imported baseline.');
            previous=block.bitmap;
            const prior = (await db.all(`SELECT p.hash FROM bitmaps b JOIN patterns p ON p.first_bitmap=b.pattern WHERE b.bitmap=?`,block.bitmap))[0];
            if (prior) {
                await stagePattern(prior.hash); moved.push(block.bitmap);
                await db.exec(`DELETE FROM bitmaps WHERE bitmap=${block.bitmap}`);
            }
            const tx=block.satoshis.map(parcelSize),geometry=bitmapGeometry(tx),pattern=await stagePattern(geometry.hash,tx,geometry.size);
            await db.exec(`INSERT INTO bitmaps VALUES (${block.bitmap},${JSON.stringify(tx)},${JSON.stringify(geometry.size)},${pattern})`);
            const last=ranges.at(-1);
            if (last && last[1]+1 === block.bitmap) last[1]=block.bitmap;
            else ranges.push([block.bitmap,block.bitmap]);
            count++; transactions+=tx.length;
        }
        if (!count && (afterBitmap<0 || priorRanges.length)) throw Error('Refusing to replace a partition with no transactions.');
        const resolved=[];
        for (const [hash,group] of affected) {
            const row=(await db.all(`SELECT min(bitmap) AS bitmap FROM (
                SELECT min(bitmap) AS bitmap FROM bitmaps WHERE pattern=? UNION ALL
                SELECT min(bitmap) AS bitmap FROM bitmaps WHERE pattern=?)`,group.temporary,group.original ?? group.temporary))[0]!;
            resolved.push({hash,...group,bitmap:row.bitmap as number|null});
        }
        for (const group of resolved) if (group.original !== undefined && group.original !== group.bitmap) {
            signal.throwIfAborted();
            await db.exec(`UPDATE bitmaps SET pattern=${group.temporary} WHERE pattern=${group.original}`);
            await db.exec(`UPDATE patterns SET first_bitmap=${group.temporary} WHERE hash=${sqlString(group.hash)}`);
        }
        for (const {hash,temporary,bitmap} of resolved) {
            signal.throwIfAborted();
            if (bitmap === null) await db.exec(`DELETE FROM patterns WHERE hash=${sqlString(hash)}`);
            else await db.exec(`UPDATE patterns SET first_bitmap=${bitmap} WHERE hash=${sqlString(hash)};
                UPDATE bitmaps SET pattern=${bitmap} WHERE pattern=${temporary}`);
        }
        if (moved.length) for (const other of await db.all('SELECT date,block_ranges FROM aws_partitions WHERE date<>?',date)) {
            const remaining: BlockRange[]=[];
            for (const [start,end] of other.block_ranges as BlockRange[]) {
                let next=start;
                for (const height of moved) if (height>=next && height<=end) {
                    if (next<height) remaining.push([next,height-1]); next=height+1;
                }
                if (next<=end) remaining.push([next,end]);
            }
            if (JSON.stringify(remaining)!==JSON.stringify(other.block_ranges))
                await db.exec(`UPDATE aws_partitions SET block_ranges=${sqlRanges(remaining)},fingerprint='' WHERE date=${sqlString(other.date)}`);
        }
        await db.exec(`DELETE FROM aws_files WHERE date=${sqlString(date)}`);
        for (const file of files) await db.exec(`INSERT INTO aws_files VALUES (${sqlString(file.key)},${sqlString(date)},
            ${sqlString(file.etag)},${file.size},${sqlString(file.modified)},${sqlString(file.sha256)});
            DELETE FROM aws_downloads WHERE key=${sqlString(file.key)}`);
        await db.exec(`DELETE FROM aws_partitions WHERE date=${sqlString(date)};
            INSERT INTO aws_partitions VALUES (${sqlString(date)},${sqlString(fingerprint)},${files.length},${count},${transactions},
                ${sqlString(new Date().toISOString())},${sqlRanges(ranges)})`);
        signal.throwIfAborted(); await db.exec('COMMIT');
        return {blocks:count,transactions,lastBitmap:previous};
    } catch (error) { await db.exec('ROLLBACK'); throw error; }
}
