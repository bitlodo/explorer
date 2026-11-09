import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve, sep } from 'node:path';
import { check, sha256 } from '../src/shared/httpPack';
import { buildLod4Region, decodeLod4Index, decodeLod4Region, encodeLod4Index, encodeLod4Region,
    LOD4_FORMAT, LOD4_SIDE, lod4RegionPath, type Lod4Index } from '../src/shared/lod4';
import { openPublishedMap } from './published-map';
import { argumentsFor } from './cli';
import { mapDataRoot } from './paths';

type PublishedMap = Awaited<ReturnType<typeof openPublishedMap>>;
const overlaps = (a: string, b: string) => a === b || a.startsWith(b + sep) || b.startsWith(a + sep);

/** Resolve existing symlink ancestors before creating any output directories. */
export async function newDestination(path: string) {
    const missing: string[] = [];
    let current = resolve(path);
    while (true) {
        try { return resolve(await realpath(current), ...missing.reverse()); }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            missing.push(basename(current)); current = dirname(current);
        }
    }
}

async function readBundleFile(directory: string, name: string) {
    const file = await realpath(resolve(directory, name));
    check(file.startsWith(directory + sep), 'LOD4 artifact escapes its bundle');
    return readFile(file);
}

async function validatePages(directory: string, index: Lod4Index, source: PublishedMap) {
    check(index.bitmapCount === source.manifest.publishedHeight + 1 && index.regions.length === source.manifest.regions.length, 'LOD4 source coverage mismatch');
    let bytes = 0, cells = 0, occupiedCells = 0, memberships = 0, geometryBytes = 0;
    for (const ref of index.regions) {
        const canonical = source.neighborhood(ref.id);
        check(ref.width === canonical.data.width && ref.height === canonical.data.height && ref.geometrySha256 === canonical.ref.sha256, 'LOD4 canonical source mismatch');
        const data = new Uint8Array(await readBundleFile(directory, lod4RegionPath(ref)));
        const page = await decodeLod4Region(data, ref, index);
        const expected = encodeLod4Region(buildLod4Region(canonical.data, canonical.ref.sha256, index.gridSide), index.gridSide);
        check(await sha256(expected) === ref.sha256, 'LOD4 membership differs from canonical intersections');
        bytes += data.length; geometryBytes += canonical.ref.bytes;
        cells += page.columns * page.rows; memberships += page.memberDeltas.length;
        for (let cell = 0; cell < page.cellOffsets.length - 1; cell++) {
            if (page.cellOffsets[cell + 1] > page.cellOffsets[cell]) occupiedCells++;
        }
    }
    source.assertUnchanged();
    return { cells, occupiedCells, memberships, pageBytes: bytes, canonicalGeometryBytes: geometryBytes };
}

/** Read-only verifier: every page is rebuilt from authenticated canonical geometry. */
export async function validateLod4Bundle(bundle: string, sourceDirectory = mapDataRoot) {
    const source = await openPublishedMap(sourceDirectory), directory = await realpath(resolve(bundle));
    const report = JSON.parse((await readBundleFile(directory, 'lod4-report.json')).toString('utf8'));
    const bytes = new Uint8Array(await readBundleFile(directory, 'lod4.pb'));
    check(report.status === 'passed' && report.index?.bytes === bytes.length, 'Incomplete LOD4 bundle');
    const index = await decodeLod4Index(bytes, source.manifest.snapshot, report.index.sha256);
    return { index, ...await validatePages(directory, index, source) };
}

/** New destination only. Does not modify the source, databases, or distributed contracts. */
export async function generateLod4(sourceDirectory: string, outputDirectory: string) {
    const source = await openPublishedMap(sourceDirectory), output = await newDestination(outputDirectory);
    check(!overlaps(output, source.root), 'Use a separate new LOD4 destination outside the source dataset');
    await mkdir(dirname(output), { recursive: true });
    await mkdir(output, { recursive: false });
    await mkdir(resolve(output, 'regions'));
    const index: Lod4Index = { version: 1, format: LOD4_FORMAT, sourceSnapshot: source.manifest.snapshot,
        gridSide: LOD4_SIDE, bitmapCount: source.manifest.publishedHeight + 1, regions: [] };
    for (const region of source.manifest.regions) {
        const canonical = source.neighborhood(region.id);
        const page = buildLod4Region(canonical.data, canonical.ref.sha256);
        const bytes = encodeLod4Region(page), hash = await sha256(bytes);
        const ref = { id: region.id, width: region.width, height: region.height, bitmapCount: page.bitmapAreas.length,
            geometrySha256: canonical.ref.sha256, sha256: hash, bytes: bytes.length };
        await writeFile(resolve(output, lod4RegionPath(ref)), bytes, { flag: 'wx' });
        index.regions.push(ref);
        if (index.regions.length % 64 === 0) console.log(JSON.stringify({ lod4Regions: index.regions.length, total: source.manifest.regions.length }));
    }
    const rootBytes = encodeLod4Index(index), hash = await sha256(rootBytes);
    const decoded = await decodeLod4Index(rootBytes, source.manifest.snapshot, hash);
    const statistics = await validatePages(output, decoded, source);
    const report = { status: 'passed', format: LOD4_FORMAT, sourceSnapshot: index.sourceSnapshot,
        sourceManifestSha256: source.manifestHash, gridSide: index.gridSide, regions: index.regions.length,
        bitmaps: index.bitmapCount, ...statistics, index: { url: 'lod4.pb', sha256: hash, bytes: rootBytes.length },
        totalBytes: rootBytes.length + statistics.pageBytes };
    // The discoverable root is written only after all page hashes and memberships pass.
    source.assertUnchanged();
    await writeFile(resolve(output, 'lod4.pb'), rootBytes, { flag: 'wx' });
    await writeFile(resolve(output, 'lod4-report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    return report;
}

if (import.meta.main) {
    const args = argumentsFor(process.argv.slice(2), ['--source', '--out']);
    check(args['--out'], 'Use --out NEW_MAINTENANCE_DIRECTORY');
    console.log(JSON.stringify(await generateLod4(args['--source'] ?? mapDataRoot, args['--out'])));
}
