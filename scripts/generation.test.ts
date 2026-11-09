import {datasetPath,isSemanticDataset,datasetLogicalFiles} from './dataset-path';
import {materializeLogicalDataset} from './semantic-dataset';
import { expect, test } from 'bun:test';
import { copyFile, cp, mkdir, mkdtemp, readdir, rename, rm, utimes } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { generate, generationMode, replaceMapData } from './generate';
import { generateStatic } from './generate-static';
import { openBitmapDatabase, readBitmap } from './bitmap-reference';
import { bitmapSyncDate, restoreBitmapDatabase } from './restore-bitmaps';
import { validateBitmapDatabase } from './validate-bitmap-db';
import { readReferenceSnapshot } from './reference-snapshot';
import { readMapManifest } from './read-map-manifest';
import { projectRoot } from './paths';
import { Database } from './duckdb';
import { organizeMapData } from './organize-map-data';
import protobuf from 'protobufjs';
import { createProtoCodec } from '../src/shared/protobufChunks';
import { encodeJsonManifest, decodeMapManifest } from '../src/shared/mapManifest';
import { dataPath } from '../src/shared/dataStorage';
import { readArtifact } from './reference-snapshot';
import { decodeNeighborhoodChunkIndex, decodeNeighborhoodChunkPage } from '../src/shared/neighborhoodChunks';

async function artifacts(root: string, prefix = ''): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    if(!prefix&&isSemanticDataset(root)){
        for(const name of datasetLogicalFiles(root))if(name.endsWith('.pb')||name==='manifest.json'||name==='bitmap-reference.json')result[name]=createHash('sha256').update(await Bun.file(datasetPath(root,name)).bytes()).digest('hex');
        return Object.fromEntries(Object.entries(result).sort(([a],[b])=>a.localeCompare(b)));
    }
    for (const entry of await readdir(resolve(root, prefix), { withFileTypes: true })) {
        const name = prefix + entry.name;
        if (entry.isDirectory()) Object.assign(result, await artifacts(root, name + '/'));
        else if (name.endsWith('.pb') || name === 'manifest.json' || name === 'bitmap-reference.json')
            result[name] = createHash('sha256').update(await Bun.file(resolve(root, name)).bytes()).digest('hex');
    }
    return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));
}

test('dense restoration batches preserve IDs and every parcel across native list allocation boundaries', async () => {
    const db = await Database.create();
    try {
        await db.exec('CREATE TABLE bitmaps(bitmap UINTEGER PRIMARY KEY,tx UTINYINT[],size UINTEGER[],pattern BIGINT)');
        const tx = Array.from({ length: 4096 }, (_, i) => i % 9 + 1);
        await db.appendRows('bitmaps', Array.from({ length: 512 }, (_, id) => [id, tx, [900,800], BigInt(id)]));
        expect((await db.all('SELECT count(*)::INTEGER AS n,min(bitmap) AS first,max(bitmap) AS last FROM bitmaps'))[0]).toEqual({ n: 512, first: 0, last: 511 });
        for (const row of await db.all('SELECT * FROM bitmaps ORDER BY bitmap')) {
            expect(row.tx).toEqual(tx); expect(row.size).toEqual([900,800]); expect(row.pattern).toBe(BigInt(row.bitmap));
        }
        await expect(db.appendRows('bitmaps', [[999, [256], [1,1], 999n]])).rejects.toThrow();
        expect(Number((await db.all('SELECT count(*) AS n FROM bitmaps'))[0]!.n)).toBe(512);
    } finally { await db.close(); }
});

test('new-user generation, temporary cleanup, deterministic files, atomic replacement and Protobuf database restore', async () => {
    const projectTemporary=await readdir(resolve(projectRoot,'.tmp')).catch(()=>[]);
    const temp = await mkdtemp('/tmp/bitmap-simple-generation-');
    try {
        const database = resolve(temp, 'bitmaps.db'), target = resolve(temp, 'map-data'), workRoot = resolve(temp, 'generation');
        const db = await openBitmapDatabase(database);
        try {
            await db.exec(`INSERT INTO bitmaps SELECT i::UINTEGER,[5]::UTINYINT[],[5,5]::UINTEGER[],0::BIGINT FROM range(4032) t(i);
                UPDATE bitmaps SET tx=[5,5,5,1,2,1],size=[9,15],pattern=1 WHERE bitmap=1;
                UPDATE bitmaps SET tx=[5,5,1,2,1,5],size=[9,15],pattern=1 WHERE bitmap=2;`);
        } finally { await db.close(); }
        const messages: string[] = [], options = { database, target, workRoot, log: (line: string) => messages.push(line) };
        await generate({ ...options, mode: 'continue' });
        expect(messages).toContain('Neighborhood geometry | Neighborhood ID 0 created | Neighborhoods: 1 / 2 (50.0%)');
        expect(messages).toContain('Neighborhood geometry | Neighborhood ID 1 created | Neighborhoods: 2 / 2 (100.0%)');
        for (const phase of ['Parcel chunks written', 'Compressed parcel chunks', 'Bitmap vector chunks written', 'Organizing parcel files', 'Validating parcel chunks']) {
            const progress = messages.filter(line => line.startsWith(phase + ' |') && line.includes(' | Bitmaps: '));
            expect(progress.length).toBeGreaterThan(0);
            const counts = progress.map(line => Number(line.match(/Bitmaps: ([\d,]+) \//)![1].replaceAll(',', '')));
            expect(counts.every((value, index) => index === 0 || value >= counts[index - 1])).toBe(true);
            expect(counts.at(-1)).toBe(4032);
            expect(messages).toContain(phase + ' | Neighborhood ID 0 completed');
            expect(messages).toContain(phase + ' | Neighborhood ID 1 completed');
        }
        expect(messages.some(line => line.startsWith('Generation:'))).toBe(false);
        const first = await artifacts(target);
        expect(await Bun.file(resolve(workRoot,'state.json')).exists()).toBe(false);
        expect(await readdir(temp)).not.toContain('generation');
        // Default staging stays on the destination filesystem, including external --out paths.
        const defaultTarget=resolve(temp,'default-map-data');
        await generate({...options,workRoot:undefined,target:defaultTarget,mode:'continue'});
        expect(await artifacts(defaultTarget)).toEqual(first);
        expect(await readdir(resolve(projectRoot,'.tmp')).catch(()=>[])).toEqual(projectTemporary);
        expect(await readdir(temp)).not.toContain('.tmp');
        const reorganized = resolve(temp, 'reorganized');
        await organizeMapData(target, reorganized);
        expect(await artifacts(reorganized)).toEqual(first);
        await generate({ ...options, mode: 'continue' });
        expect(messages.at(-1)).toContain('already up to date');
        expect(await readdir(temp)).not.toContain('generation');

        // An independent output path and a full rebuild must produce identical PB names and bytes.
        await generate({ ...options, mode: 'restart' });
        expect(await artifacts(target)).toEqual(first);
        expect(await readdir(temp)).not.toContain('generation');

        const recovery = resolve(workRoot, 'generation-recovery');
        await mkdir(recovery,{recursive:true});
        await rename(target, resolve(recovery, 'previous-map-data'));
        await Bun.write(resolve(workRoot, 'publish.json'), JSON.stringify({ target, source: resolve(recovery, 'map-data'), previous: resolve(recovery, 'previous-map-data') }));
        await generate({ ...options, mode: 'continue' });
        expect(messages).toContain('Recovered the previous Protobuf dataset.');
        expect(await artifacts(target)).toEqual(first);
        expect(await readdir(temp)).not.toContain('generation');

        const cloneTarget = resolve(temp, 'clone-map-data'), cloneDatabase = resolve(temp, 'clone.db');
        await cp(target, cloneTarget, { recursive: true });
        const empty = await openBitmapDatabase(cloneDatabase); await empty.close();
        await generate({ mode: 'continue', database: cloneDatabase, target: cloneTarget, workRoot: resolve(temp, 'clone-generation'), restore: { from: '2009-01-04' }, log: () => {} });
        expect(await artifacts(cloneTarget)).toEqual(first);
        expect(await validateBitmapDatabase(cloneDatabase, target)).toMatchObject({ status: 'passed', checked: 4032 });

        // Resume a run whose final organization stage did not complete; preserve its partial output.
        const checkpointRoot = resolve(temp, 'checkpoint'), otherDatabase = resolve(temp, 'other-machine.db');
        await copyFile(database, otherDatabase);
        const staged = await generateStatic({ db: otherDatabase, geometry: 'none', out: checkpointRoot });
        expect(await artifacts(staged)).toEqual(first);
        const checkpoint = resolve(checkpointRoot, 'generation-checkpoint.json'), saved = await Bun.file(checkpoint).json();
        delete saved.done.organize;
        await Bun.write(checkpoint, JSON.stringify(saved));
        const resumed = await generateStatic({ db: otherDatabase, geometry: 'none', out: checkpointRoot, resume: true });
        expect(await artifacts(resumed)).toEqual(first);
        expect((await readdir(checkpointRoot)).some(name => name.startsWith('incomplete-organize-'))).toBe(true);

        const restoredDatabase = resolve(temp, 'restored.db');
        await restoreBitmapDatabase({ source: target, database: restoredDatabase, from: '2009-01-04' });
        expect(await validateBitmapDatabase(restoredDatabase, target)).toMatchObject({ status: 'passed', checked: 4032, patternsChecked: true, missingBitmaps: 0 });
        const restored = await openBitmapDatabase(restoredDatabase);
        try {
            expect((await readBitmap(restored, 1))!.tx).toEqual([5,5,5,1,2,1]);
            expect((await readBitmap(restored, 2))!.pattern).toBe(1);
        } finally { await restored.close(); }
        expect(await restoreBitmapDatabase({ source: '/does-not-exist', database: restoredDatabase })).toBeUndefined();

        // Older snapshots have no pattern addon. Reconstruct exact geometry equivalence, including reordered TXs.
        const olderSource=resolve(temp,'older-protobufs');await materializeLogicalDataset(target,olderSource);
        await rm(resolve(olderSource,'bitmap-reference.json'));
        const olderDatabase = resolve(temp, 'older.db');
        await restoreBitmapDatabase({ source: olderSource, database: olderDatabase, from: '2009-01-04' });
        const older = await openBitmapDatabase(olderDatabase);
        try { expect((await readBitmap(older, 2))!.pattern).toBe(1); }
        finally { await older.close(); }

        const interruptedDatabase = resolve(temp, 'interrupted.db'), controller = new AbortController();
        await expect(restoreBitmapDatabase({ source: target, database: interruptedDatabase, from: '2009-01-04', signal: controller.signal,
            log: message => { if (message.startsWith('Restored ')) controller.abort(Error('Interrupted fixture')); } })).rejects.toThrow();
        const interrupted = await openBitmapDatabase(interruptedDatabase);
        try { expect(Number((await interrupted.all('SELECT count(*) AS n FROM bitmaps'))[0]!.n)).toBe(0); }
        finally { await interrupted.close(); }
        await restoreBitmapDatabase({ source: target, database: interruptedDatabase, from: '2009-01-04' });

        const sample = await generateStatic({ db: database, geometry: 'none', regions: '0', out: resolve(temp, 'sample'), colorsFrom: 'none' });
        await expect(restoreBitmapDatabase({ source: sample, database: resolve(temp, 'sample.db'), from: '2009-01-04' })).rejects.toThrow('complete parcel coverage');

        const manifest = (await readMapManifest(target)).manifest, reference = (await readReferenceSnapshot(target, manifest.snapshot, 4032))!;
        const payload = datasetPath(target, reference.ref.url), original = await Bun.file(payload).bytes();
        await Bun.write(payload, new Uint8Array([0]));
        await expect(restoreBitmapDatabase({ source: target, database: resolve(temp, 'corrupt.db'), from: '2009-01-04' })).rejects.toThrow('integrity');
        await Bun.write(payload, original);

        // A bad new input cannot replace the already validated public dataset.
        const invalid = await openBitmapDatabase(database);
        try { await invalid.exec('UPDATE bitmaps SET size=[1,1] WHERE bitmap=0'); } finally { await invalid.close(); }
        await expect(generate({ ...options, mode: 'restart' })).rejects.toThrow('Failed');
        await expect(generate({...options,workRoot:undefined,target:defaultTarget,mode:'restart'})).rejects.toThrow('Failed');
        expect(await readdir(resolve(projectRoot,'.tmp')).catch(()=>[])).toEqual(projectTemporary);
        expect(await artifacts(defaultTarget)).toEqual(first);
        expect(await artifacts(target)).toEqual(first);
        expect(await readdir(temp)).not.toContain('generation');
        await mkdir(resolve(temp, 'rollback'));
        await expect(replaceMapData(resolve(temp, 'missing-data'), target, resolve(temp, 'rollback'))).rejects.toThrow();
        expect(await Bun.file(resolve(temp,'publish.json')).exists()).toBe(false);
        expect(await artifacts(target)).toEqual(first);
        await mkdir(resolve(temp,'rollback','previous-map-data'));
        await Bun.write(resolve(temp,'rollback','previous-map-data','occupied'),'preserve');
        await expect(replaceMapData(resolve(temp,'missing-data'),target,resolve(temp,'rollback'))).rejects.toThrow();
        expect(await Bun.file(resolve(temp,'publish.json')).exists()).toBe(false);
        expect(await artifacts(target)).toEqual(first);
        expect(await generationMode('continue')).toBe('continue');
        expect(await generationMode('restart')).toBe('restart');
        await expect(generationMode('delete')).rejects.toThrow('mode');
    } finally { await rm(temp, { recursive: true, force: true }); }
}, 60000);

test('block metadata resolves a conservative UTC sync date and validates the returned height', async () => {
    const fetcher = Object.assign(async (input: RequestInfo | URL) => String(input).includes('/block-height/') ? new Response('a'.repeat(64)) :
        Response.json({ id: 'a'.repeat(64), height: 800000, timestamp: 1690168629, mediantime: 1690164000 }), { preconnect: fetch.preconnect });
    expect(await bitmapSyncDate(800000, new AbortController().signal, fetcher)).toBe('2023-07-23');
    await expect(bitmapSyncDate(800001, new AbortController().signal, fetcher)).rejects.toThrow('Cannot resolve');
    const fallback = Object.assign(async (input: RequestInfo | URL) => String(input).startsWith('https://mempool.space/') ?
        new Response('', { status: 403 }) : fetcher(input), { preconnect: fetch.preconnect });
    expect(await bitmapSyncDate(800000, new AbortController().signal, fallback)).toBe('2023-07-23');
    const parsed = await import('protobufjs');
    const root = parsed.default.loadSync(resolve(projectRoot, 'src/shared/proto/bitmap_reference.proto'));
    const type = root.lookupType('bitmap.reference.Reference');
    const bytes = type.encode({ version: 1, sourceSnapshot: 'abc', patterns: [0,0,2] }).finish();
    expect(type.toObject(type.decode(bytes))).toEqual({ version: 1, sourceSnapshot: 'abc', patterns: [0,0,2] });
});

test('continue uses the published cursor without auditing history and appends only complete neighborhoods', async () => {
    const projectTemporary=await readdir(resolve(projectRoot,'.tmp')).catch(()=>[]);
    const temp = await mkdtemp('/tmp/bitmap-incremental-generation-');
    try {
        const database = resolve(temp, 'bitmaps.db'), target = resolve(temp, 'map-data'), workRoot = resolve(temp, 'generation');
        let db = await openBitmapDatabase(database);
        try { await db.exec('INSERT INTO bitmaps SELECT i::UINTEGER,[5]::UTINYINT[],[5,5]::UINTEGER[],0::BIGINT FROM range(4032) t(i)'); }
        finally { await db.close(); }
        const messages: string[] = [], options = { database, target, workRoot, log: (line: string) => messages.push(line) };
        await generate({ ...options, mode: 'continue' });
        const first = await artifacts(target);
        const manifest = (await readMapManifest(target)).manifest;
        const initialStatus=await Bun.file(resolve(target,'status.json')).json();
        expect(initialStatus).toMatchObject({snapshot:manifest.snapshot,publishedHeight:4031,syncedHeight:4031,syncedAt:null});
        expect(Number.isFinite(Date.parse(initialStatus.generatedAt))).toBe(true);
        const previous=resolve(temp,'previous-map-data');await cp(target,previous,{recursive:true});

        // Sync checkpoint writes and a different mtime are not changes to bitmap content.
        db = await openBitmapDatabase(database);
        try { await db.exec("CREATE TABLE generation_fixture_checkpoint(day VARCHAR); INSERT INTO generation_fixture_checkpoint VALUES ('2026-10-31')"); }
        finally { await db.close(); }
        await utimes(database, new Date('2020-01-01'), new Date('2020-01-01'));
        messages.length = 0;
        await generate({ ...options, mode: 'continue' });
        expect(messages.at(-1)).toContain('No Protobuf files regenerated');
        expect((await Bun.file(resolve(target,'status.json')).json()).generatedAt).toBe(initialStatus.generatedAt);
        expect(await readdir(temp)).not.toContain('generation');
        expect(await artifacts(target)).toEqual(first);

        // No-op continuation reads the manifest, without opening geometry/packs or an obsolete sidecar.
        await Bun.write(resolve(target, 'generation-source.json'), 'obsolete metadata is ignored');
        await rename(resolve(target, 'parcels'), resolve(target, 'unavailable-parcels'));
        const uncached = { ...options, workRoot: resolve(temp, 'new-machine-generation') };
        await generate({ ...uncached, mode: 'continue' });
        await rename(resolve(target, 'unavailable-parcels'), resolve(target, 'parcels'));
        expect(await artifacts(target)).toEqual(first);
        expect(await readdir(temp)).not.toContain('new-machine-generation');
        expect(messages.some(line => line.startsWith('Checking published data:'))).toBe(false);

        db = await openBitmapDatabase(database);
        try { await db.exec('INSERT INTO bitmaps SELECT i::UINTEGER,[5]::UTINYINT[],[5,5]::UINTEGER[],0::BIGINT FROM range(4032,6032) t(i)'); }
        finally { await db.close(); }
        messages.length = 0;
        await generate({ ...uncached, mode: 'continue' });
        expect(messages).toContain('Waiting for a complete neighborhood: 2,000 / 2,016 new blocks available; 16 missing.');
        expect(await Bun.file(resolve(target,'status.json')).json()).toMatchObject({snapshot:manifest.snapshot,publishedHeight:4031,syncedHeight:6031,generatedAt:initialStatus.generatedAt});
        expect(await artifacts(target)).toEqual(first);

        db = await openBitmapDatabase(database);
        try {
            await db.exec('INSERT INTO bitmaps SELECT i::UINTEGER,[5]::UTINYINT[],[5,5]::UINTEGER[],0::BIGINT FROM range(6032,6048) t(i)');
            // Published history must come from Protobufs, even inside a chunk shared with new rows.
            await db.exec('UPDATE bitmaps SET tx=[],size=[] WHERE bitmap<4032');
        }
        finally { await db.close(); }
        messages.length = 0;
        await generate({ ...uncached, mode: 'continue' });
        expect(messages.some(line => line.includes('Neighborhood ID 2 created'))).toBe(true);
        expect(messages.some(line => line.startsWith('Database transactions | Neighborhood ID 0'))).toBe(false);
        const updated = (await readMapManifest(target)).manifest, report = await Bun.file(resolve(target, 'report.json')).json();
        expect(updated.publishedHeight).toBe(6047);
        expect(await Bun.file(resolve(target,'status.json')).json()).toMatchObject({snapshot:updated.snapshot,publishedHeight:6047,syncedHeight:6047});
        expect(updated.regions.slice(0, 2).map(region => region.geometry.sha256)).toEqual(manifest.regions.map(region => region.geometry.sha256));
        expect(report).toMatchObject({ incremental: true, newNeighborhoods: [2] });
        expect(report.reusedChunks).toBeGreaterThan(0); expect(report.rebuiltChunks).toBeGreaterThan(0);
        expect(report.databaseRowsRead).toBe(2016);
        db = await openBitmapDatabase(database);
        try { await db.exec('UPDATE bitmaps SET tx=[5],size=[5,5],pattern=0 WHERE bitmap<4032'); }
        finally { await db.close(); }
        const independent = await generateStatic({ db: database, geometry: 'none', out: resolve(temp, 'independent') });
        expect(await artifacts(target)).toEqual(await artifacts(independent));

        const validate = (incremental = true, validationOnly = true) => {
            const result = Bun.spawnSync([process.execPath, resolve(projectRoot, 'scripts/tools/prepare-pages.ts'), target,
                resolve(temp, 'unused-app'), resolve(temp, 'unused-site'), ...(validationOnly ? ['--validate-only'] : []),
                ...(incremental ? ['--baseline=' + previous] : [])], { cwd: projectRoot, stdout: 'pipe', stderr: 'pipe',
                env: { ...process.env, BITMAP_GENERATION_PROGRESS: '1' } });
            return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
        };
        const fast = validate(), complete = validate(false);
        expect(fast.code).toBe(0); expect(complete.code).toBe(0);
        const fastStats = JSON.parse(fast.stdout.trim().split('\n').at(-1)!).validation;
        const fullStats = JSON.parse(complete.stdout.trim().split('\n').at(-1)!).validation;
        expect(fastStats).toMatchObject({ mode: 'incremental', neighborhoodsVerified: 1 });
        expect(fullStats).toMatchObject({ mode: 'full', neighborhoodsVerified: 3, parcelPacksReused: 0 });
        expect(fastStats.parcelPacksReused).toBeGreaterThan(0);
        expect(fastStats.parcelPacksVerified).toBeLessThan(fullStats.parcelPacksVerified);
        expect(fastStats.bitmapChunksReused).toBeGreaterThan(0);
        expect(fastStats.bitmapChunksVerified).toBeLessThan(fullStats.bitmapChunksVerified);
        expect(fastStats.previewTilesReused).toBeGreaterThan(0);
        expect(fast.stdout).not.toContain('"phase":"Validating parcel chunks"');
        expect(fast.stdout).not.toContain('"phase":"Validating new neighborhood geometry","id":0');
        expect(messages).toContain('Validating new/changed Protobuf files and index coverage…');
        expect(validate(true, false).stderr).toContain('supported only by --validate-only');

        const codec = createProtoCodec(protobuf);
        async function packs(root: string) {
            const manifest = (await readMapManifest(root)).manifest, packs = [];
            for (const page of manifest.indexPages!) for (const chunk of codec.decodeIndexPage(await readArtifact(root, page), page, manifest)) packs.push(...chunk.packs);
            return packs;
        }
        const oldPacks = new Set((await packs(previous)).map(pack => pack.sha256)), newPacks = await packs(target);
        const changedPack = newPacks.find(pack => !oldPacks.has(pack.sha256))!, reusedPack = newPacks.find(pack => oldPacks.has(pack.sha256))!;
        async function corrupt(ref: { url: string }, check: () => void) {
            const file = datasetPath(target, ref.url), bytes = await Bun.file(file).bytes(), changed = bytes.slice(); changed[0] ^= 255;
            await Bun.write(file, changed);
            try { check(); } finally { await Bun.write(file, bytes); }
        }
        await corrupt(changedPack, () => { expect(validate().code).not.toBe(0); });
        await corrupt(updated.regions[2].geometry, () => { expect(validate().code).not.toBe(0); });
        // The fast path intentionally trusts inherited bytes. Full validation still catches their corruption.
        await corrupt(reusedPack, () => { expect(validate().code).toBe(0); expect(validate(false).code).not.toBe(0); });
        const inheritedFile=datasetPath(target,reusedPack.url);await rename(inheritedFile,inheritedFile+'.missing');
        try { expect(validate().code).not.toBe(0); }
        finally { await rename(inheritedFile+'.missing',inheritedFile); }
        async function bitmapChunks(root: string) {
            const manifest = (await readMapManifest(root)).manifest;
            const index = await decodeNeighborhoodChunkIndex(await Bun.file(datasetPath(root, 'neighborhood-chunks.json')).bytes(), manifest.snapshot), chunks = [];
            for (const page of index.pages) chunks.push(...decodeNeighborhoodChunkPage(await readArtifact(root, { ...page, url: dataPath(manifest.storageLayout, 'bitmap-chunks', page.url) }), page, index));
            return chunks;
        }
        const oldBitmapChunks = new Set((await bitmapChunks(previous)).map(ref => ref.sha256));
        const newBitmapChunk = (await bitmapChunks(target)).find(ref => !oldBitmapChunks.has(ref.sha256))!;
        await corrupt({ url: dataPath(updated.storageLayout, 'bitmap-chunks', newBitmapChunk.url) }, () => { expect(validate().code).not.toBe(0); });
        // Re-signing a modified root cannot make a changed historical region eligible for reuse.
        const manifestFile=datasetPath(target,'manifest.json');
        const originalManifest = await Bun.file(manifestFile).bytes(), originalReport = await Bun.file(resolve(target, 'report.json')).text();
        const shifted = structuredClone(updated); shifted.regions[0].x++;
        const shiftedBytes = await encodeJsonManifest(shifted), shiftedSnapshot = (await decodeMapManifest(shiftedBytes, 'manifest.json')).snapshot;
        await Bun.write(manifestFile, shiftedBytes);
        await Bun.write(resolve(target, 'report.json'), JSON.stringify({ ...JSON.parse(originalReport), snapshot: shiftedSnapshot }));
        try { expect(validate().stderr).toMatch(/unchanged published prefix|integrity failure/); }
        finally { await Bun.write(manifestFile, originalManifest); await Bun.write(resolve(target, 'report.json'), originalReport); }

        // Historical edits are left to restart, rather than scanning the existing prefix on continue.
        db = await openBitmapDatabase(database);
        try { await db.exec('UPDATE bitmaps SET tx=[1,1,1,1,1],pattern=6000 WHERE bitmap=6000'); }
        finally { await db.close(); }
        messages.length = 0;
        const beforeCorrection = await artifacts(target);
        await generate({ ...uncached, mode: 'continue' });
        expect(messages.at(-1)).toContain('No Protobuf files regenerated');
        expect(await artifacts(target)).toEqual(beforeCorrection);
        await generate({ ...uncached, mode: 'restart' });
        expect((await readMapManifest(target)).manifest.snapshot).not.toBe(updated.snapshot);
        expect(await validateBitmapDatabase(database, target)).toMatchObject({ status: 'passed', checked: 6048 });

        // Failed incremental work is discarded; the next attempt starts from the published cursor.
        const baseline = (await readMapManifest(target)).manifest;
        db = await openBitmapDatabase(database);
        try { await db.exec('INSERT INTO bitmaps SELECT i::UINTEGER,[5]::UTINYINT[],[5,5]::UINTEGER[],0::BIGINT FROM range(6048,8064) t(i);UPDATE bitmaps SET size=[1,1] WHERE bitmap=8063'); }
        finally { await db.close(); }
        await expect(generate({...uncached,mode:'continue'})).rejects.toThrow('Failed');
        expect((await readMapManifest(target)).manifest.snapshot).toBe(baseline.snapshot);
        expect(await readdir(temp)).not.toContain('new-machine-generation');
        db=await openBitmapDatabase(database);
        try{await db.exec('UPDATE bitmaps SET size=[5,5] WHERE bitmap=8063');}finally{await db.close();}
        messages.length = 0;
        await generate({ ...uncached, mode: 'continue' });
        expect(await readdir(temp)).not.toContain('new-machine-generation');
        expect((await Bun.file(resolve(target, 'report.json')).json()).newNeighborhoods).toEqual([3]);
        expect(await validateBitmapDatabase(database, target)).toMatchObject({ status: 'passed', checked: 8064 });
    } finally { await rm(temp, { recursive: true, force: true }); }
}, 120000);
