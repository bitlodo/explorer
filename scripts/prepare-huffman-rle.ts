import {buildParcelSegments} from './parcel-segments';
import { readMapManifest } from './read-map-manifest';
import { dataPath, validArtifactPath } from '../src/shared/dataStorage';
/** Convert prepared v8/v9 data to frozen Huffman RLE v9; never recalculate geometry. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, realpath, readdir, link, copyFile, constants } from 'node:fs/promises';
import { resolve, join, dirname, sep } from 'node:path';
import protobuf from 'protobufjs';
import { createProtoCodec, type ProtoChunk } from '../src/shared/protobufChunks';
import { HUFFMAN_FORMAT, isPagedFormat, decodeSizes, decodeParcelSizes, encodeAdaptiveSizes, recordEncoding, type FileRef, type ParcelRecord } from '../src/shared/httpPack';
import { TX_CODEC_VERSION } from '../src/shared/txHuffmanRle';
import { createPreviewCodec } from '../src/shared/heatmapPreview';
import { decodeNeighborhoodChunkIndex, jsonBytes } from '../src/shared/neighborhoodChunks';
import { argumentsFor } from './cli';
import { readReferenceSnapshot, writeReferencePatterns } from './reference-snapshot';
import { GenerationCoverage, generationProgressEnabled, reportGenerationProgress } from './generation-progress';

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const codec = createProtoCodec(protobuf, hash), previews = createPreviewCodec(protobuf);

export async function prepareHuffmanRle(sourceArg: string, outArg: string) {
    const source = await realpath(resolve(sourceArg)), out = resolve(outArg);
    const parent = await realpath(dirname(out)).catch(async error => { if (error.code !== 'ENOENT') throw error; await mkdir(dirname(out), { recursive: true }); return realpath(dirname(out)); });
    assert.equal(parent, dirname(out), 'Output cannot traverse symlinks');
    assert(out !== source && !out.startsWith(source + sep) && !source.startsWith(out + sep), 'Use a separate new output');
    const input=await readMapManifest(source),manifestBytes=input.bytes;
    const manifest = input.manifest, prior = await Bun.file(join(source, 'report.json')).json();
    const reference = await readReferenceSnapshot(source, manifest.snapshot, manifest.publishedHeight + 1);
    assert(isPagedFormat(manifest.format) && prior.status === 'passed' && prior.snapshot === manifest.snapshot, 'Validated paged source required');
    await mkdir(out, { recursive: false });
    const read = async (ref: FileRef) => {
        assert(validArtifactPath(ref.url,ref.sha256));
        const bytes = new Uint8Array(await Bun.file(join(source, ref.url)).arrayBuffer());
        assert.equal(bytes.length, ref.bytes); assert.equal(hash(bytes), ref.sha256); return bytes;
    };
    const put = async (bytes: Uint8Array) => {
        const sha256 = hash(bytes), url = sha256 + '.pb';
        if (!await Bun.file(join(out, url)).exists()) await Bun.write(join(out, url), bytes);
        return { url, sha256, bytes: bytes.length };
    };
    const pages = [];
    const obsolete = new Set(['manifest.json','manifest.pb', 'report.json', 'preview.pb', 'parcel-size-preview.pb', 'parcel-colors.json', 'bitmap-area-colors.json', 'neighborhood-chunks.json']);
    if (reference) obsolete.add(reference.ref.url);
    for (const ref of manifest.indexPages!) {
        pages.push({ ref, chunks: codec.decodeIndexPage(await read(ref), ref, manifest) }); obsolete.add(ref.url);
    }
    let bitmaps = 0, parcels = 0, oldBytes = 0, newBytes = 0, oldPayload = 0, newPayload = 0, packs = 0;
    const encodings = { raw4: 0, rle4: 0, huffmanRle: 0 }, members = new Uint8Array(manifest.publishedHeight + 1);
    const progress = generationProgressEnabled() ? new GenerationCoverage(manifest.publishedHeight, manifest.parcelRegions.length) : undefined;
    let completedChunks = 0;
    const totalChunks = pages.reduce((sum, page) => sum + page.chunks.length, 0);
    const next = { ...manifest, storageLayout: undefined, format: HUFFMAN_FORMAT, snapshot: '', indexPages: [] as NonNullable<typeof manifest.indexPages> };
    for (const page of pages) {
        const chunks: ProtoChunk[] = [];
        for (const chunk of page.chunks) {
            const newPacks = [];const chunkRecords:ParcelRecord[]=[];
            for (const pack of chunk.packs) {
                obsolete.add(pack.url);
                const original = await read(pack), records: ParcelRecord[] = [], expected: Uint8Array[] = [];
                async function* input() { yield original; }
                for await (const record of codec.parsePack(input(), pack)) {
                    assert.equal(members[record.id], 0, 'Duplicate bitmap across pages'); members[record.id] = 1;
                    const sizes = decodeSizes(record), encoded = encodeAdaptiveSizes(record.id, sizes);
                    records.push(encoded); expected.push(Uint8Array.from(sizes));
                    oldPayload += record.tx.length; newPayload += encoded.tx.length;
                    const encoding = recordEncoding(encoded); encodings[encoding === 4 ? 'huffmanRle' : encoding === 1 ? 'rle4' : 'raw4']++;
                    bitmaps++; parcels += record.txCount;
                    progress?.record(record.id);
                }
                oldBytes+=original.length;chunkRecords.push(...records);
            }
            for(const built of await buildParcelSegments(chunkRecords,chunk.x,chunk.y,manifest.shuffleSeed!,manifest.frameBytes!,manifest.packBytes)){
                const ref={...built.descriptor,...await put(built.wire)};
                newBytes+=built.wire.length;packs++;newPacks.push(ref);
            }
            // Digest identifies canonical original TX records, independent of the new wire encoding.
            chunks.push({ ...chunk, packs: newPacks });
            completedChunks++;
            if (progress) reportGenerationProgress({ kind: 'coverage', phase: 'Compressed parcel chunks', unit: 'Chunks',
                completed: completedChunks, total: totalChunks, ...progress.snapshot() });
        }
        const bytes = codec.encodeIndexPage(chunks, page.ref.x, page.ref.y, next);
        const ref = { ...page.ref, ...await put(bytes) };
        assert.deepEqual(codec.decodeIndexPage(bytes, ref, next), chunks); next.indexPages.push(ref);
    }
    assert.equal(bitmaps, manifest.parcelRegions.length * 2016);
    for (const region of manifest.regions) if (region.coverage === 'complete') for (let i = region.id * 2016; i < (region.id + 1) * 2016; i++) assert.equal(members[i], 1);
    next.snapshot = hash(codec.encodeManifest(next, false));
    const bytes = codec.encodeManifest(next); await codec.decodeManifest(bytes);
    async function copyInputs(dir: string, prefix = '') {
        for (const entry of await readdir(dir, {withFileTypes:true})) {
            const name = prefix + entry.name;
            if(entry.isDirectory()) { await copyInputs(join(dir,entry.name),name+'/'); continue; }
            assert(entry.isFile(), 'Source must contain regular files');
            if(obsolete.has(name) || !/^[a-f0-9]{64}\.(pb|nbc|means)$/.test(entry.name))continue;
            const input=join(source,name),output=join(out,entry.name);
            const payload=new Uint8Array(await Bun.file(input).arrayBuffer());
            assert.equal(hash(payload),entry.name.split('.')[0]);
            if(await Bun.file(output).exists()) { assert.deepEqual(new Uint8Array(await Bun.file(output).arrayBuffer()),payload); continue; }
            try { await link(input,output); } catch(error:any) { if(error.code!=='EXDEV'&&error.code!=='EPERM')throw error; await copyFile(input,output,constants.COPYFILE_EXCL); }
        }
    }
    await copyInputs(source);
    if (reference) await writeReferencePatterns(out, next.snapshot, reference.patterns);
    for (const name of ['preview.pb', 'parcel-size-preview.pb']) {
        const kind = name === 'preview.pb' ? 'previews' : 'parcel-previews';
        const input = join(source,dataPath(manifest.storageLayout,kind,name));
        if (!await Bun.file(input).exists()) continue;
        const index = await previews.decodeIndex(new Uint8Array(await Bun.file(input).arrayBuffer()), manifest.snapshot,manifest.storageLayout,kind);
        index.sourceSnapshot = next.snapshot; index.snapshot = hash(previews.encodeIndex(index, false));
        await Bun.write(join(out, name), previews.encodeIndex(index));
    }
    for (const name of ['parcel-colors.json', 'bitmap-area-colors.json', 'neighborhood-chunks.json']) {
        if (!await Bun.file(join(source, name)).exists()) continue;
        const root = await Bun.file(join(source, name)).json(); assert.equal(root.sourceSnapshot, manifest.snapshot);
        if (name === 'neighborhood-chunks.json') await decodeNeighborhoodChunkIndex(new Uint8Array(await Bun.file(join(source, name)).arrayBuffer()), manifest.snapshot);
        root.sourceSnapshot = next.snapshot;
        if (name === 'neighborhood-chunks.json') { const { snapshot, ...unsigned } = root; root.snapshot = hash(jsonBytes(unsigned)); }
        await Bun.write(join(out, name), JSON.stringify(root));
    }
    assert.deepEqual(new Uint8Array(await Bun.file(input.filename).arrayBuffer()), new Uint8Array(manifestBytes));
    const report = { status: 'passed', format: HUFFMAN_FORMAT, snapshot: next.snapshot, sourceSnapshot: manifest.snapshot, txCodec: TX_CODEC_VERSION,
        sample: prior.sample, neighborhoods: next.regions.length, bitmaps, parcels, packs, encodings,
        oldPackBytes: oldBytes, packBytes: newBytes, packReductionPercent: (1 - newBytes / oldBytes) * 100,
        oldPayloadBytes: oldPayload, payloadBytes: newPayload,
        validation: 'Every TX value/order round-tripped through authenticated v9 frames; all IDs retained with fixed cell/neighborhood-band segments; source immutable hashes checked; geometry/dimensions/tiles copied unchanged; root addons rebound to new manifest.' };
    await Bun.write(join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    // Publish the entry only after all references and checks succeed.
    await Bun.write(join(out, 'manifest.pb'), bytes);
    console.log(JSON.stringify(report)); return report;
}

if (import.meta.main) {
    const args = argumentsFor(process.argv.slice(2), ['--source', '--out']);
    if (!args['--source'] || !args['--out']) throw Error('Use --source MAP_DATA --out NEW_MAP_DATA');
    await prepareHuffmanRle(args['--source'], args['--out']);
}
