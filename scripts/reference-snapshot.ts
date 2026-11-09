import {datasetPath,isSemanticDataset} from './dataset-path';
import protobuf from 'protobufjs';
import { readFile, realpath, writeFile, rm } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { Database, OPEN_READONLY } from './duckdb';
import { readMapManifest } from './read-map-manifest';
import { validArtifactPath } from '../src/shared/dataStorage';
import type { FileRef } from '../src/shared/httpPack';
import { reportGenerationProgress } from './generation-progress';

const type = protobuf.loadSync(resolve(import.meta.dir, '../src/shared/proto/bitmap_reference.proto')).lookupType('bitmap.reference.Reference');
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export const REFERENCE_FORMAT = 'bitmap-reference-protobuf-v1';

export async function readArtifact(root: string, ref: FileRef): Promise<Uint8Array> {
    if (!validArtifactPath(ref.url, ref.sha256)) throw Error('Invalid immutable artifact path.');
    const file = await realpath(datasetPath(root, ref.url));
    if (!file.startsWith(await realpath(root) + sep)) throw Error('Artifact escapes the dataset.');
    const bytes = await readFile(file);
    if (bytes.length !== ref.bytes || hash(bytes) !== ref.sha256) throw Error(`Artifact integrity failure: ${ref.url}`);
    return bytes;
}

export function validatePatterns(patterns: number[], count: number) {
    if (patterns.length !== count) throw Error('Reference pattern coverage mismatch.');
    patterns.forEach((pattern, bitmap) => {
        if (!Number.isSafeInteger(pattern) || pattern < 0 || pattern > bitmap || patterns[pattern] !== pattern)
            throw Error(`Invalid reference pattern at bitmap ${bitmap}.`);
    });
}

export async function readReferenceSnapshot(root: string, snapshot: string, count: number) {
    const filename = datasetPath(root, 'bitmap-reference.json');
    if (!await Bun.file(filename).exists()) return undefined;
    const bytes = await readFile(filename), index = JSON.parse(bytes.toString());
    if (index.format !== REFERENCE_FORMAT || index.sourceSnapshot !== snapshot || index.count !== count)
        throw Error('Reference snapshot/coverage mismatch.');
    const payload = await readArtifact(root, index.patterns);
    if (payload.length > count * 5 + 1024) throw Error('Reference payload exceeds its budget.');
    const decoded = type.toObject(type.decode(payload), { arrays: true, defaults: true });
    if (decoded.version !== 1 || decoded.sourceSnapshot !== snapshot) throw Error('Reference payload identity mismatch.');
    const patterns = decoded.patterns as number[];
    validatePatterns(patterns, count);
    return { patterns, ref: index.patterns as FileRef, bytes };
}

/** No dates, local paths or machine-dependent values enter these content-addressed bytes. */
export async function exportReferenceSnapshot(root: string, database: string) {
    const { manifest } = await readMapManifest(root), count = manifest.publishedHeight + 1;
    const db = await Database.create(database, OPEN_READONLY);
    try {
        const rows = await db.all('SELECT bitmap, pattern FROM bitmaps WHERE bitmap <= ? ORDER BY bitmap', manifest.publishedHeight);
        if (rows.length !== count || rows.some((row, index) => row.bitmap !== index)) throw Error('Missing reference bitmaps.');
        await writeReferencePatterns(root, manifest.snapshot, rows.map(row => Number(row.pattern)));
        reportGenerationProgress({ kind: 'units', phase: 'Database restoration metadata', unit: 'Bitmaps indexed', completed: count, total: count });
    } finally { await db.close(); }
}

export async function writeReferencePatterns(root: string, snapshot: string, patterns: number[]): Promise<void> {
    if (isSemanticDataset(root)) {
        const { editSemanticDataset } = await import('./semantic-dataset');
        await editSemanticDataset(root, async typed => {
            await rm(resolve(typed, 'bitmap-reference.json'), { force: true });
            await writeReferencePatterns(typed, snapshot, patterns);
        });
        return;
    }
    validatePatterns(patterns, patterns.length);
    const payload = type.encode({ version: 1, sourceSnapshot: snapshot, patterns }).finish();
    const sha256 = hash(payload), url = sha256 + '.pb', destination = resolve(root, url);
    if (await Bun.file(destination).exists()) {
        if (hash(await readFile(destination)) !== sha256) throw Error('Conflicting reference payload.');
    } else await writeFile(destination, payload, { flag: 'wx' });
    await writeFile(resolve(root, 'bitmap-reference.json'), JSON.stringify({ format: REFERENCE_FORMAT,
        sourceSnapshot: snapshot, count: patterns.length, patterns: { url, sha256, bytes: payload.length } }) + '\n', { flag: 'wx' });
}
