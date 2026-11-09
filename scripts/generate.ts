#!/usr/bin/env bun
import {convertSemanticDataset} from './semantic-dataset';
import {isSemanticDataset} from './dataset-path';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { basename, dirname, resolve, sep } from 'node:path';
import { mkdtemp, rename, rm, rmdir } from 'node:fs/promises';
import { argumentsFor, runTool } from './cli';
import { acquireSyncLock, exists, safeDirectory } from './aws-download';
import { databasePath } from './db-config';
import { Database, OPEN_READONLY } from './duckdb';
import { mapDataRoot, temporaryRoot, projectRoot, publicRoot, srcRoot } from './paths';
import { readMapManifest } from './read-map-manifest';
import { restoreBitmapDatabase, type RestoreOptions } from './restore-bitmaps';
import { formatGenerationProgress } from './generation-progress';
import {writeMapStatus} from './map-status';

export type GenerationMode = 'continue' | 'restart';

export async function generationMode(value?: string): Promise<GenerationMode> {
    if (value) {
        if (value !== 'continue' && value !== 'restart') throw Error('Use --mode continue or --mode restart.');
        return value;
    }
    if (!process.stdin.isTTY) throw Error('Use --mode continue or --mode restart when running without an interactive terminal.');
    const terminal = createInterface({ input: process.stdin, output: process.stdout });
    try {
        const answer = (await terminal.question('Generate Protobuf files\n  1. Continue updating (default)\n  2. Rebuild Protobuf files from scratch (keep the database)\nChoice [1]: ')).trim();
        if (answer === '' || answer === '1') return 'continue';
        if (answer === '2') return 'restart';
        throw Error('Choose 1 or 2.');
    } finally { terminal.close(); }
}

async function writeJson(filename: string, value: unknown) {
    const temporary = filename + '.tmp';
    await Bun.write(temporary, JSON.stringify(value, null, 2) + '\n');
    await rename(temporary, filename);
}

/** Keep the previous dataset only until replacement succeeds; the caller cleans its temporary directory. */
export async function replaceMapData(source: string, target: string, directory: string, archive?:string) {
    const previous = resolve(directory, 'previous-map-data'), journal = resolve(dirname(directory), 'publish.json');
    const hadTarget = !!await exists(target);
    await writeJson(journal, { source, target, previous, ...(archive?{archive}:{}) });
    let moved=false;
    try {
        if(hadTarget){await rename(target,previous);moved=true;}
        await rename(source,target);
    }
    catch (error) { if (moved) await rename(previous, target); await rm(journal); throw error; }
    if(moved&&archive){
        try{await mkdir(dirname(archive),{recursive:true});await rename(previous,archive);}
        catch(error){await rename(target,source);await rename(previous,target);await rm(journal);throw error;}
    }
    await rm(journal);
}

export async function generate(options: { mode: GenerationMode; database?: string; target?: string; workRoot?: string;
    restore?: RestoreOptions; log?: (message: string) => void }) {
    const database = resolve(options.database ?? databasePath('DB_BITMAP')), target = resolve(options.target ?? mapDataRoot);
    const work = resolve(options.workRoot ?? (target.startsWith(projectRoot+sep)?temporaryRoot:resolve(dirname(target),'.tmp'))), log = options.log ?? console.log;
    if (target === projectRoot || [srcRoot, resolve(projectRoot, 'scripts'), resolve(projectRoot, 'data')].some(root =>
        target === root || target.startsWith(root + sep)) || (target.startsWith(publicRoot + sep) && target !== mapDataRoot) ||
        target === work || target.startsWith(work + sep) || work.startsWith(target + sep) || database.startsWith(target + sep))
        throw Error('Generation must preserve sources and its database.');
    await safeDirectory(dirname(target));await safeDirectory(work);
    const unlock = await acquireSyncLock(work,'.generate.lock');
    let unlockDatabase: (() => Promise<void>) | undefined;
    let directory: string | undefined;
    async function removeEmptyWork() {
        await rmdir(work).catch((error:NodeJS.ErrnoException)=>{if(error.code!=='ENOENT'&&error.code!=='ENOTEMPTY')throw error;});
    }
    try {
        const journal = resolve(work, 'publish.json');
        if (await Bun.file(journal).exists()) {
            const pending = await Bun.file(journal).json();
            const recovery=dirname(String(pending.previous));
            if (pending.target !== target || dirname(recovery)!==work || !basename(recovery).startsWith('generation-') ||
                pending.previous!==resolve(recovery,'previous-map-data') || !String(pending.source).startsWith(recovery+sep)) throw Error('Unexpected generation recovery journal.');
            if(pending.archive){const allowed=target.startsWith(projectRoot+sep)?resolve(projectRoot,'.cache/maintenance/map-data-history'):resolve(dirname(target),'.cache/maintenance/map-data-history');
                if(dirname(pending.archive)!==allowed||!/^legacy-[a-f0-9]{64}-[a-f0-9-]+$/.test(basename(pending.archive)))throw Error('Unexpected migration archive.');}
            if(!await exists(target)){
                const previous=await exists(pending.previous),candidate=previous?pending.previous:pending.source;
                const info=await exists(candidate);
                if(!info?.isDirectory()||info.isSymbolicLink())throw Error('No safe dataset found in the generation recovery journal.');
                await readMapManifest(candidate);await rename(candidate,target);
                log(previous?'Recovered the previous Protobuf dataset.':'Recovered the generated Protobuf dataset.');
            }
            if(pending.archive&&await exists(pending.previous)){await safeDirectory(dirname(pending.archive));await rename(pending.previous,pending.archive);}
            await rm(journal);
            await rm(dirname(pending.previous),{recursive:true,force:true});await removeEmptyWork();
        }
        const archiveRoot=target.startsWith(projectRoot+sep)?resolve(projectRoot,'.cache/maintenance/map-data-history'):resolve(dirname(target),'.cache/maintenance/map-data-history');
        const targetInfo = await exists(target);
        if (targetInfo && (!targetInfo.isDirectory() || targetInfo.isSymbolicLink())) throw Error('Unsafe map-data destination.');
        const hasSnapshot = !!(await exists(resolve(target, 'manifest.json')) || await exists(resolve(target, 'manifest.pb')) || await exists(resolve(target,'release.json')));
        if (targetInfo && !hasSnapshot) throw Error('Existing map-data destination has no manifest; choose a separate output.');
        let empty = !await exists(database);
        if (!empty) {
            const probe = await Database.create(database, OPEN_READONLY);
            try { empty = Number((await probe.all('SELECT count(*) AS n FROM bitmaps'))[0]!.n) === 0; }
            finally { await probe.close(); }
        }
        if (empty) {
            if (!hasSnapshot) throw Error('No database or Protobuf dataset found. Run bun run db:sync first.');
            await restoreBitmapDatabase({ ...options.restore, database, source: target, log });
        }
        const databaseInfo = await exists(database);
        if (!databaseInfo?.isFile() || databaseInfo.isSymbolicLink()) throw Error('Unsafe bitmap database.');
        unlockDatabase = await acquireSyncLock(dirname(database), basename(database) + '.sync.lock');
        const db = await Database.create(database, OPEN_READONLY);
        let last: number;
        try {
            const meta = (await db.all('SELECT min(bitmap) AS first,max(bitmap) AS last,count(*) AS records FROM bitmaps'))[0]!;
            last = Number(meta.last ?? -1);
            if (last < 2015) throw Error('Sync at least one complete neighborhood with bun run db:sync before generating.');
            if (meta.first !== 0 || Number(meta.records) !== last + 1) throw Error('Generation requires a complete bitmap prefix from block 0.');
        }
        finally { await db.close(); }
        const completeCount = Math.floor((last + 1) / 2016);
        const inputManifest = hasSnapshot ? (await readMapManifest(target)).manifest : undefined;
        let pipeline: 'full' | 'update' = 'full';
        if (options.mode === 'continue' && inputManifest) {
            if (inputManifest.parcelRegions.length !== inputManifest.regions.length) throw Error('Continue requires complete published parcel coverage. Use --mode restart.');
            if (inputManifest.publishedHeight > completeCount * 2016 - 1) throw Error('The database is missing published neighborhoods; synchronize it before generating.');
            log(`Published: neighborhood ${inputManifest.regions.length - 1}, through bitmap ${inputManifest.publishedHeight.toLocaleString('en-US')}.`);
            log(`Database: through bitmap ${last.toLocaleString('en-US')}; ${completeCount.toLocaleString('en-US')} complete neighborhoods.`);
            if (completeCount === inputManifest.regions.length) {
                const tail = last - inputManifest.publishedHeight;
                if (tail) log(`Waiting for a complete neighborhood: ${tail.toLocaleString('en-US')} / 2,016 new blocks available; ${(2016 - tail).toLocaleString('en-US')} missing.`);
                if(!isSemanticDataset(target)){
                    await safeDirectory(work);directory=await mkdtemp(resolve(work,'generation-'));
                    const native=resolve(directory,'semantic-map-data');log('Migrating the current dataset to semantic source paths…');
                    await convertSemanticDataset(target,native);
                    await writeMapStatus(native,database,{previous:target});
                    const archive=resolve(archiveRoot,`legacy-${inputManifest.snapshot}-${randomUUID()}`);await replaceMapData(native,target,directory,archive);
                    log(`Previous dataset preserved: ${archive}`);log('Semantic map data ready for bun dev.');return target;
                }
                await writeMapStatus(target,database);
                log(`Protobuf files are already up to date through block ${inputManifest.publishedHeight.toLocaleString('en-US')}. No Protobuf files regenerated; map status updated.`);
                return target;
            }
            pipeline = 'update';
            log(`Continuing with neighborhoods ${inputManifest.regions.length}–${completeCount - 1}, bitmaps ${(inputManifest.publishedHeight + 1).toLocaleString('en-US')}–${(completeCount * 2016 - 1).toLocaleString('en-US')}.`);
        }
        await safeDirectory(work);directory=await mkdtemp(resolve(work,'generation-'));
        log(options.mode === 'restart' ? 'Rebuilding all Protobuf files from the local database…' : 'Generating updated Protobuf files from the local database…');
        const build = resolve(directory, 'build'), data = resolve(build, 'map-data'), logfile = resolve(directory, 'generation.log');
        const progress = { log: logfile, env: { BITMAP_GENERATION_PROGRESS: '1' },
            onLine: (line: string) => { for (const message of formatGenerationProgress(line)) log(message); } };
        if (pipeline === 'update') await runTool('scripts/update-static.ts', ['--source', target, '--db', database, '--out', build], progress);
        else await runTool('scripts/generate-static.ts', ['--db', database, '--geometry', hasSnapshot ? target : 'none', '--out', build], progress);
        const generated = (await readMapManifest(data)).manifest;
        log(pipeline === 'update' ? 'Validating new/changed Protobuf files and index coverage…' : 'Validating all generated Protobuf files…');
        await runTool('scripts/tools/prepare-pages.ts', [data, resolve(directory, 'unused-app'), resolve(directory, 'unused-site'), '--validate-only',
            ...(pipeline === 'update' ? ['--baseline=' + target] : [])], progress);
        const native=resolve(directory,'semantic-map-data');
        log('Preparing semantic source paths for development and publication…');
        await convertSemanticDataset(data,native,{...(pipeline==='update'?{baseline:target}:{}),...(isSemanticDataset(target)?{retain:target}:{})});
        await writeMapStatus(native,database,{previous:target,generated:true});
        const archive=inputManifest&&!isSemanticDataset(target)?resolve(archiveRoot,`legacy-${inputManifest.snapshot}-${randomUUID()}`):undefined;
        await replaceMapData(native, target, directory,archive);
        if(archive)log(`Previous dataset preserved: ${archive}`);
        log(`Protobuf files ready through block ${generated.publishedHeight.toLocaleString('en-US')}: ${target}`);
        return target;
    } catch(error) {
        const logfile=directory&&Bun.file(resolve(directory,'generation.log'));
        if(logfile&&await logfile.exists())throw new Error(`Failed to generate Protobuf files.\n${(await logfile.slice(-8192).text()).trim()}`,{cause:error});
        throw error;
    } finally {
        try {
            // Preserve the recovery journal and its data only if rollback itself failed.
            if(!await Bun.file(resolve(work,'publish.json')).exists()){
                if(directory)await rm(directory,{recursive:true,force:true});
                await rm(resolve(work,'publish.json.tmp'),{force:true});await removeEmptyWork();
            }
        } finally { try { await unlockDatabase?.(); } finally { await unlock();await removeEmptyWork(); } }
    }
}

if (import.meta.main) {
    try {
        const args = argumentsFor(process.argv.slice(2), ['--mode', '--db', '--out']);
        await generate({ mode: await generationMode(args['--mode']), database: args['--db'], target: args['--out'] });
    } catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }
}
