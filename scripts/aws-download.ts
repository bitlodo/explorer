import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, rename, rm, rmdir } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { Database } from './duckdb';
import { sqlString } from './bitmap-reference';
import { request, retry, validDate, type RemoteObject, type RequestOptions } from './aws-public-data';

export async function exists(path: string) {
    return lstat(path).catch(error => { if (error.code !== 'ENOENT') throw error; return undefined; });
}

/** Refuse symlinks in paths owned by this mirror. */
export async function safeDirectory(path: string) {
    const absolute = resolve(path);
    let current: string = sep;
    for (const part of absolute.slice(sep.length).split(sep).filter(Boolean)) {
        current = join(current, part);
        const info = await exists(current);
        if (!info) await mkdir(current).catch(error => { if (error.code !== 'EEXIST') throw error; });
        const checked = await lstat(current);
        if (!checked.isDirectory() || checked.isSymbolicLink()) throw Error(`Expected a real directory: ${current}`);
    }
}

export function localFile(root: string, key: string): string {
    if (!/^v1\.0\/btc\/transactions\/date=\d{4}-\d{2}-\d{2}\/[A-Za-z0-9_.-]+\.parquet$/.test(key))
        throw Error(`Invalid cached object key: ${key}`);
    return join(root, key.slice('v1.0/btc/'.length));
}

/** Remove only empty date folders; preserve retained, unfinished and unknown files. */
export async function removeEmptyTransactionDirectories(root: string, date?: string): Promise<number> {
    if (date !== undefined && !validDate(date)) throw Error('Invalid transaction partition date.');
    const directory=join(root,'transactions'),info=await exists(directory);
    if (!info) return 0;
    if (!info.isDirectory() || info.isSymbolicLink()) throw Error('Unsafe transaction cache directory.');
    const names=date ? [`date=${date}`] : (await readdir(directory)).filter(name=>
        name.startsWith('date=') && validDate(name.slice(5)));
    let removed=0;
    for (const name of names) {
        const path=join(directory,name),entry=await exists(path);
        if (!entry?.isDirectory() || entry.isSymbolicLink()) continue;
        try { await rmdir(path); removed++; }
        catch (error) {
            if (!['ENOENT','ENOTEMPTY','EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        }
    }
    return removed;
}

export async function acquireSyncLock(root: string, filename = '.sync.lock') {
    const path = join(root, filename), owner = JSON.stringify({ pid: process.pid, id: randomUUID() });
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const handle = await open(path, 'wx');
            try { await handle.writeFile(owner); } finally { await handle.close(); }
            return async () => { if (await readFile(path, 'utf8').catch(() => '') === owner) await rm(path); };
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
            const info = await lstat(path);
            if (!info.isFile() || info.isSymbolicLink()) throw Error('Unsafe sync lock.');
            const previous = JSON.parse(await readFile(path, 'utf8')) as { pid: number };
            if (!Number.isSafeInteger(previous.pid) || previous.pid <= 0) throw Error('Invalid sync lock; inspect .sync.lock.');
            try { process.kill(previous.pid, 0); }
            catch (failure) { if ((failure as NodeJS.ErrnoException).code === 'ESRCH') { await rm(path); continue; } throw failure; }
            throw Error(`Another sync is running (PID ${previous.pid}).`);
        }
    }
    throw Error('Could not acquire sync lock.');
}

export async function digest(path: string) {
    const hash = createHash('sha256');
    for await (const chunk of Bun.file(path).stream()) hash.update(chunk);
    return hash.digest('hex');
}

export const TRANSACTION_COLUMNS = ['block_number','block_hash','index','date','output_value'] as const;
export type ParquetProjector = (source: string,destination: string,signal: AbortSignal,extensions: string) => Promise<number>;
const extensionSetup = new Map<string,Promise<void>>();

async function prepareHttpfs(directory: string) {
    let ready=extensionSetup.get(directory);
    if (!ready) {
        ready=(async()=>{
            await safeDirectory(directory);
            const db=await Database.create(':memory:');
            try {
                await db.exec(`SET extension_directory=${sqlString(directory)}`);
                try { await db.exec('LOAD httpfs'); }
                catch { await db.exec("INSTALL httpfs FROM 'https://extensions.duckdb.org'; LOAD httpfs"); }
            } finally { await db.close(); }
        })();
        extensionSetup.set(directory,ready);
        ready.catch(()=>extensionSetup.delete(directory));
    }
    await ready;
}

/** DuckDB fetches Parquet metadata and selected column chunks using HTTP ranges. */
export const projectParquet: ParquetProjector = async (source,destination,signal,extensions) => {
    signal.throwIfAborted();
    const remote=/^https?:/.test(source),profile=destination+'.profile.json';
    if (remote) await prepareHttpfs(extensions);
    signal.throwIfAborted();
    const db=await Database.create(':memory:'),interrupt=()=>db.interrupt();
    signal.addEventListener('abort',interrupt,{once:true});
    try {
        await db.exec("SET threads=1; SET memory_limit='128MB'");
        if (remote) await db.exec(`SET extension_directory=${sqlString(extensions)};
            LOAD httpfs; SET http_retries=0; SET http_timeout=120;`);
        signal.throwIfAborted();
        if (remote) await db.exec(`SET profiling_output=${sqlString(profile)};
            SET custom_profiling_settings='{"TOTAL_BYTES_READ":"true"}'; PRAGMA enable_profiling='json'`);
        await db.exec(`COPY (SELECT ${TRANSACTION_COLUMNS.map(name=>'"'+name+'"').join(',')}
            FROM read_parquet(${sqlString(source)},hive_partitioning=false))
            TO ${sqlString(destination)} (FORMAT PARQUET,COMPRESSION ZSTD)`);
        signal.throwIfAborted();
        if (!remote) return 0;
        await db.exec('PRAGMA disable_profiling');
        const downloaded=Number((await Bun.file(profile).json()).total_bytes_read);
        if (!Number.isSafeInteger(downloaded) || downloaded<0) throw Error('Invalid Parquet download byte count.');
        return downloaded;
    } finally {
        signal.removeEventListener('abort',interrupt);
        try {await db.close();} finally {await rm(profile,{force:true});}
    }
};

/** Stage only the required columns; the source object is never downloaded whole. */
export async function downloadObject(root: string,object: RemoteObject,endpoint: string,options: RequestOptions,
    project: ParquetProjector = projectParquet) {
    const path=localFile(root,object.key),extensions=join(root,'.duckdb-extensions');
    await safeDirectory(dirname(path));
    const current=await exists(path);
    if (current && (!current.isFile() || current.isSymbolicLink())) throw Error(`Unsafe destination: ${path}`);
    const url=new URL(object.key.split('/').map(encodeURIComponent).join('/'),endpoint);
    const checkVersion=async()=>{
        const response=await request(url,options,{'If-Match':object.etag},'HEAD');
        await response.body?.cancel();
        if (response.headers.get('etag')!==object.etag || Number(response.headers.get('content-length'))!==object.size)
            throw Error(`S3 object changed during projection: ${object.key}`);
    };
    let downloadedBytes=0;
    return retry(async()=>{
        const temporary=join(root,'.partial',`${randomUUID()}.part`);
        let handle: Awaited<ReturnType<typeof open>>|undefined;
        try {
            await checkVersion();
            const transferred=await project(url.href,temporary,options.signal,extensions);
            if (!Number.isSafeInteger(transferred) || transferred<0) throw Error('Invalid Parquet download byte count.');
            downloadedBytes+=transferred;
            await checkVersion();
            options.signal.throwIfAborted();
            handle=await open(temporary,'r');
            const size=(await handle.stat()).size,magic=Buffer.alloc(8);
            if (size<8) throw Error('Incomplete projected Parquet file.');
            await handle.read(magic,0,4,0); await handle.read(magic,4,4,size-4);
            if (magic.toString()!=='PAR1PAR1') throw Error('Invalid projected Parquet file.');
            const sha256=await digest(temporary);
            await handle.sync(); await handle.close(); handle=undefined;
            await rename(temporary,path);
            return {sha256,bytes:size,downloadedBytes};
        } finally { await handle?.close(); await rm(temporary,{force:true}); }
    },options);
}
