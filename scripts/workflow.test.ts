import { readMapManifest } from './read-map-manifest';
import { encodeParcelMeans, PARCEL_MEANS_PROTO } from '../src/shared/parcelMeans';
import { organizeMapData } from './organize-map-data';
import { DATA_STORAGE, dataPath } from '../src/shared/dataStorage';
import { test, expect } from 'bun:test';
import { mkdir, mkdtemp, readdir, rm, symlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import protobuf from 'protobufjs';
import { generateStatic } from './generate-static';
import { buildSite } from './build';
import { startServer } from '../server/index';
import { createServer } from 'vite';
import { clientConfig } from '../vite.config';
import { createProtoCodec } from '../src/shared/protobufChunks';
import { LAYOUT, GROUP_FORMAT, buildGroupedPack, encodeSizes, sha256 } from '../src/shared/httpPack';
import MondrianLayout from '../src/shared/MondrianLayout';
import descriptor from '../src/shared/proto/neighborhood_descriptor.json';
import { bitmapGeometry } from './bitmap-reference';

const codec = createProtoCodec(protobuf);

async function fixture(source: string) {
    await mkdir(source);
    async function put(bytes: Uint8Array, ext: string) {
        const hash = await sha256(bytes), url = `${hash}.${ext}`;
        await Bun.write(resolve(source, url), bytes);
        return { sha256: hash, url, bytes: bytes.length };
    }
    const layout = new MondrianLayout(Array(2016).fill(1));
    const type = protobuf.Root.fromJSON(descriptor).lookupType('Neighborhood');
    const geometry = await put(type.encode({ neighborhood: 0, width: layout.width, height: layout.height, bitmaps: layout.slots }).finish(), 'pb');
    const records = Array.from({ length: 2016 }, (_, id) => encodeSizes(id, [1]));
    const pack = await buildGroupedPack(records);
    const packRef = { ...pack.descriptor, ...await put(pack.wire, 'bin') };
    const region = await put(new TextEncoder().encode(JSON.stringify({ format: GROUP_FORMAT, id: 0, geometry, coverage: 'complete', packs: [packRef] }) + '\n'), 'json');
    const body = { format: GROUP_FORMAT, layout: LAYOUT, publishedHeight: 2015, regions: [{ id: 0, width: layout.width, height: layout.height, descriptor: region }], parcelRegions: [0] };
    const snapshot = await sha256(new TextEncoder().encode(JSON.stringify(body) + '\n'));
    await Bun.write(resolve(source, 'manifest.json'), JSON.stringify({ ...body, snapshot }) + '\n');
    await Bun.write(resolve(source, 'report.json'), JSON.stringify({ status: 'passed', snapshot, sample: false }));
    return geometry;
}

test('Bun offline pipeline and static build preserve identity, colors, source data and the prior dist on failure', async () => {
    const temp = await mkdtemp('/tmp/explorer-bun-workflow-');
    let server: Awaited<ReturnType<typeof startServer>> | undefined;
    try {
        const source = resolve(temp, 'source'), geometry = await fixture(source);
        await expect(generateStatic({ source, out: resolve(import.meta.dir, '../src/invalid-generated'), colorsFrom: 'none' })).rejects.toThrow('Use a separate new output directory');
        const sourceManifest = await Bun.file(resolve(source, 'manifest.json')).text();
        const first = await generateStatic({ source, out: resolve(temp, 'first'), colorsFrom: 'none' });
        const initial = (await readMapManifest(first)).manifest;
        const means = new Uint8Array(2016 * 4), view = new DataView(means.buffer);
        for (let id = 0; id < 2016; id++) view.setFloat32(id * 4, 1, true);
        const hash = await sha256(means), url = `${hash}.means`;
        await Bun.write(resolve(first, dataPath(initial.storageLayout, 'colors', url)), means);
        await Bun.write(resolve(first, 'parcel-colors.json'), JSON.stringify({ format: 'parcel-size-means-v1', sourceSnapshot: initial.snapshot, count: 2016, means: { url, sha256: hash, bytes: means.length }, preview: 'parcel-size-preview.pb' }));
        const data = await generateStatic({ source, out: resolve(temp, 'next'), colorsFrom: first });
        const manifest = (await readMapManifest(data)).manifest;
        expect(manifest.format).toBe('bitmap-http-protobuf-v9');
        expect(manifest.layout).toBe(LAYOUT);
        expect(manifest.snapshot).toBe(initial.snapshot);
        expect(manifest.storageLayout).toBe(DATA_STORAGE);
        expect(manifest.regions[0].geometry).toEqual({...geometry,url:'geometry/'+geometry.url});
        expect(await Bun.file(resolve(source, 'manifest.json')).text()).toBe(sourceManifest);
        await expect(generateStatic({ source, out: resolve(temp, 'next'), colorsFrom: first })).rejects.toThrow();

        const { Database } = await import('./duckdb');
        const databaseFile = resolve(temp, 'bitmaps.db'), database = await Database.create(databaseFile);
        await database.exec('CREATE TABLE bitmaps AS SELECT i::UINTEGER AS bitmap, [1]::UTINYINT[] AS tx, [1,1]::UINTEGER[] AS size, 0::BIGINT AS pattern FROM range(2016) AS t(i)');
        await database.close();
        const previousDatabase = process.env.DB_BITMAP;
        let calculated: string;
        try {
            process.env.DB_BITMAP = databaseFile;
            calculated = await generateStatic({ source, out: resolve(temp, 'database-colors'), colorsFrom: 'database' });
            const updated = await Database.create(databaseFile);
            const tx = [5, 1, 2, 5], size = bitmapGeometry(tx).size;
            try {
                await updated.exec(`INSERT INTO bitmaps SELECT i::UINTEGER, ${JSON.stringify(tx)}::UTINYINT[], ${JSON.stringify(size)}::UINTEGER[], 2016::BIGINT FROM range(2016,4039) AS t(i)`);
            } finally { await updated.close(); }
            const databaseHash = await sha256(await Bun.file(databaseFile).bytes());
            // An explicit database must reach both transaction and color exporters.
            process.env.DB_BITMAP = resolve(temp, 'missing-database.db');
            const fromDatabase = await generateStatic({ geometry: first, db: databaseFile, out: resolve(temp, 'from-database') });
            const regenerated = (await readMapManifest(fromDatabase)).manifest;
            expect(regenerated.regions[0].geometry).toEqual({...geometry,url:'geometry/'+geometry.url});
            expect(regenerated.publishedHeight).toBe(4031);
            expect(regenerated.regions).toHaveLength(2);
            expect(regenerated.parcelRegions).toEqual([0, 1]);
            const generatedGeometry = regenerated.regions[1].geometry;
            const generated = protobuf.Root.fromJSON(descriptor).lookupType('Neighborhood').decode(await Bun.file(resolve(fromDatabase, generatedGeometry.url)).bytes()) as any;
            expect(generated.bitmaps.map((rect: any) => [rect.width, rect.height])).toEqual(Array.from({ length: 2016 }, () => size));
            const exportReport = await Bun.file(resolve(temp, 'from-database/export/report.json')).json();
            expect(exportReport.geometrySnapshot).toBe(initial.snapshot);
            expect(exportReport.records).toBe(4032);
            expect(exportReport.generatedGeometryRegions).toBe(1);
            expect(exportReport.reusedGeometryRegions).toBe(1);
            expect(exportReport.database.path).toBe(databaseFile);
            expect(exportReport.exclusions).toEqual([{ first: 4032, last: 4038, reason: 'Incomplete final neighborhood; retained in source database' }]);
            expect(exportReport.sourceMode).toContain('READ_ONLY');
            const updatedColors = await Bun.file(resolve(fromDatabase, 'parcel-colors.json')).json();
            const expectedMeans = new Float32Array(4032).fill(1); expectedMeans.fill(3.25, 2016);
            expect(updatedColors.count).toBe(4032);
            expect(updatedColors.means.sha256).toBe(await sha256(encodeParcelMeans(expectedMeans)));
            expect(await sha256(await Bun.file(databaseFile).bytes())).toBe(databaseHash);
        } finally {
            if (previousDatabase === undefined) delete process.env.DB_BITMAP;
            else process.env.DB_BITMAP = previousDatabase;
        }
        const calculatedColors = await Bun.file(resolve(calculated!, 'parcel-colors.json')).json();
        expect(calculatedColors.format).toBe(PARCEL_MEANS_PROTO);
        expect(calculatedColors.means.sha256).toBe(await sha256(encodeParcelMeans(new Float32Array(2016).fill(1))));

        const organizedAgain = resolve(temp,'organized-again');
        const organizedReport = await organizeMapData(data, organizedAgain);
        expect(organizedReport.snapshot).toBe(manifest.snapshot);
        const copiedManifest = (await readMapManifest(organizedAgain)).manifest;
        expect(copiedManifest).toEqual(manifest);
        await expect(organizeMapData(data, organizedAgain)).rejects.toThrow();

        const out = resolve(temp, 'dist');
        for (const name of ['src', 'public']) {
            await expect(buildSite({ out: resolve(import.meta.dir, '..', name), data })).rejects.toThrow('Build output must be separate');
        }
        const versionFile=resolve(temp,'build-version.json');
        const status={format:'bitmap-map-status-v1',snapshot:manifest.snapshot,publishedHeight:manifest.publishedHeight,
            syncedHeight:manifest.publishedHeight+100,syncedAt:'2026-11-06T22:24:20.462Z',generatedAt:null,checkedAt:new Date().toISOString()};
        await Bun.write(resolve(data,'status.json'),JSON.stringify(status));
        const built=await buildSite({ out, data, base: '/map/',versionFile,precompress:true });
        expect(built.version).toBe(1);expect((await Bun.file(versionFile).json()).version).toBe(1);
        expect((await readdir(resolve(out,'assets'))).some(name=>name.endsWith('.gz'))).toBe(true);
        expect(await Bun.file(resolve(out,'build-info.json')).json()).toMatchObject({version:1,builtAt:built.builtAt});
        expect(await Bun.file(resolve(out,'map-data/status.json')).json()).toEqual(status);
        await Bun.write(resolve(out,'map-data/previous-version.pb'),Uint8Array.of(1,2,3));
        await Bun.write(resolve(out,'assets/previous-version.js'),'obsolete');
        const rebuilt=await buildSite({out,data,base:'/map/',versionFile});
        expect(await Bun.file(resolve(out,'map-data/previous-version.pb')).exists()).toBe(false);
        expect(await Bun.file(resolve(out,'assets/previous-version.js')).exists()).toBe(false);
        expect(rebuilt.version).toBe(2);expect((await Bun.file(versionFile).json()).version).toBe(2);
        expect((await readdir(resolve(out,'assets'))).some(name=>name.endsWith('.gz'))).toBe(false);
        expect(rebuilt.release).toBe(built.release);
        expect(await Bun.file(resolve(out, 'map-data/parcel-colors.json')).exists()).toBe(true);
        expect(await Bun.file(resolve(out, 'map-data/parcel-previews/parcel-size-preview.pb')).exists()).toBe(true);
        expect(await Bun.file(resolve(out, 'map-data/bitmap-area-colors.json')).exists()).toBe(true);
        expect((await readdir(out)).sort()).not.toContain('src');
        const html = await Bun.file(resolve(out, 'index.html')).text();
        expect(html).toContain('<base href="/map/"');
        server = await startServer(out, 0);
        const origin = `http://127.0.0.1:${server.port}`;
        for (const match of html.matchAll(/(?:src|href)="(\/map\/assets\/[^\"]+)"/g)) expect((await fetch(origin + match[1])).status).toBe(200);
        const assets = await readdir(resolve(out, 'assets'));
        for (const name of ['tightSpiralWorker', 'neighborhoodBitmapWorker', 'neighborhoodLayoutWorker']) {
            const file = assets.find(file => file.startsWith(name + '-') && file.endsWith('.js'));
            expect(file).toBeDefined();
            const response = await fetch(`${origin}/map/assets/${file}`);
            expect(response.status).toBe(200);
            expect(response.headers.get('content-type')).toContain('javascript');
        }
        expect((await fetch(origin + '/map/__dev/events')).status).toBe(404);
        const page = manifest.indexPages![0];
        await Bun.write(resolve(data, page.url), new Uint8Array([0]));
        const rejected = resolve(temp,'corrupt-conversion');
        await expect(organizeMapData(data,rejected)).rejects.toThrow();
        expect(await Bun.file(resolve(rejected,'manifest.json')).exists()).toBe(false);
        await expect(buildSite({ out, data, base: '/map/',versionFile })).rejects.toThrow('Failed');
        expect((await Bun.file(versionFile).json()).version).toBe(2);
        expect(await Bun.file(resolve(out, 'index.html')).text()).toBe(html);
        expect((await fetch(origin + '/map/')).status).toBe(200);
    } finally { await server?.stop(true); await rm(temp, { recursive: true, force: true }); }
}, 60000);

test('Vite serves public map data from source and transforms workers after edits, errors and recovery', async () => {
    const temp = await mkdtemp('/tmp/explorer-vite-dev-');
    const root = resolve(temp, 'app'), data = resolve(root, 'public/map-data');
    await mkdir(data, { recursive: true });
    await symlink(resolve(import.meta.dir, '../node_modules'), resolve(temp, 'node_modules'), 'dir');
    await Bun.write(resolve(data, 'manifest.pb'), new Uint8Array([1, 2, 3]));
    await Bun.write(resolve(root, 'index.html'), '<script type="module" src="/entry.ts"></script>');
    await Bun.write(resolve(root, 'entry.ts'), "new Worker(new URL('./probe.ts', import.meta.url), { type: 'module' });");
    const input = resolve(root, 'probe.ts');
    await Bun.write(input, "const message: string = 'first'; self.postMessage(message);");
    const config = clientConfig({ base: '/site/' });
    const previousMode = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    const dev = await createServer({ ...config, configFile: false, root, publicDir: resolve(root, 'public'), cacheDir: resolve(temp, '.vite'), mode: 'development',
        server: { ...config.server, port: 0, fs: { ...config.server?.fs, allow: [root, resolve(import.meta.dir, '../node_modules')] } } });
    try {
        await dev.listen();
        const origin = dev.resolvedUrls!.local[0];
        expect([...await (await fetch(origin + 'map-data/manifest.pb')).bytes()]).toEqual([1, 2, 3]);
        expect((await fetch(origin + 'map-data/missing.pb', { headers: { Accept: 'application/octet-stream' } })).status).toBe(404);
        expect((await fetch(origin + 'map-data/manifest.pb', { method: 'HEAD' })).status).toBe(200);
        await Bun.write(resolve(root, 'data/databases/private.db'), 'not public');
        expect((await fetch(origin + 'data/databases/private.db')).status).toBe(403);
        await Bun.write(resolve(root, 'data/aws/bitcoin/local.parquet'), 'local history');
        expect((await fetch(origin + 'data/aws/bitcoin/local.parquet')).status).toBe(403);
        await Bun.write(resolve(root, 'data/db/bitmaps.db'), 'private DuckDB');
        expect((await fetch(origin + 'data/db/bitmaps.db')).status).toBe(403);
        expect(await (await fetch(origin)).text()).toContain('/site/@vite/client');
        const entry = await (await fetch(origin + 'entry.ts')).text();
        expect(entry).toContain('worker_file');
        const url = origin + 'probe.ts?worker_file&type=module';
        expect(await (await fetch(url)).text()).toContain('first');
        async function edit(code: string, expectedStatus: number, text?: string) {
            // Chokidar coalesces writes inside its short duplicate-event window.
            await Bun.sleep(150);
            await Bun.write(input, code);
            let last = '';
            for (let i = 0; i < 80; i++) {
                await Bun.sleep(25);
                const response = await fetch(url), body = await response.text();
                if (response.status === expectedStatus && (!text || body.includes(text))) return;
                last = `${response.status}: ${body.slice(0, 300)}`;
            }
            throw Error(`Worker did not reflect its new source (${expectedStatus}, ${text}): ${last}`);
        }
        await edit("const message: string = 'second'; self.postMessage(message);", 200, 'second');
        await edit('const = ;', 500);
        await edit("self.postMessage('recovered');", 200, 'recovered');
    } finally {
        await dev.close();
        if (previousMode === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = previousMode;
        await rm(temp, { recursive: true, force: true });
    }
}, 15000);
