#!/usr/bin/env bun
/** Offline only. Repartition verified v1/v2 snapshots without touching canonical geometry. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { createProtoCodec, type ProtoManifest, type ProtoChunk, type ProtoRegion } from '../src/shared/protobufChunks';
import {chunkShuffleOrder,DEFAULT_SHUFFLE_SEED,CHUNK_SHUFFLE} from '../src/shared/chunkShuffle';
import {generatePreviews} from './generate-previews';
import { GenerationCoverage, generationProgressEnabled, reportGenerationProgress } from './generation-progress';
import SpiralLayout from '../src/shared/SpiralLayout';
import { SHUFFLE_FORMAT, CHAIN_FORMAT, PROTO_FORMAT, CHUNK_FORMAT, FORMAT, GROUP_FORMAT, LAYOUT, LIMITS, check, integer, chunkAt, ByteReader, buildChunkPack, parsePack, validateRegionPacks, type ParcelRecord, type PackRef, type FileRef, type ChunkDescriptor, type ChunkRef, type RegionDescriptor } from '../src/shared/httpPack';
const require = createRequire(new URL('../package.json', import.meta.url));
const protobuf = require('protobufjs');
const codec = createProtoCodec(protobuf);
const type = protobuf.Root.fromJSON(require('./src/shared/proto/neighborhood_descriptor.json')).lookupType('Neighborhood');
const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value) + '\n');
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export function recordBytes(record: ParcelRecord) {
    const bytes = new Uint8Array(16 + record.tx.length), v = new DataView(bytes.buffer);
    v.setUint32(0, bytes.length - 4, true); v.setUint32(4, record.id, true); v.setUint32(8, record.txCount, true);
    bytes[12] = record.rle ? 1 : 0; bytes.set(record.tx, 16); return bytes;
}
export async function generateChunks(options: { source: string; out: string; chunkSize?: number; packBytes?: number; previous?: string; format?: 'v3' | 'v4' | 'v5' | 'v6'; seed?:number; frameBytes?: number; previews?: boolean; previewTileSize?: number; previewResolution?: number }) {
    const source = path.resolve(options.source), out = path.resolve(options.out), previous = options.previous && path.resolve(options.previous);
    const shuffled=options.format===undefined||options.format==='v6',seed=options.seed??DEFAULT_SHUFFLE_SEED;
    check(integer(seed,0,0xffffffff),'Invalid shuffle seed');
    const proto = options.format !== 'v3', chained = options.format !== 'v3' && options.format !== 'v4';
    const frameBytes = options.frameBytes ?? (proto ? 16384 : 131072);
    check(integer(frameBytes, 1, LIMITS.frame), 'Invalid frame-bytes');
    const size = options.chunkSize ?? 1024, target = options.packBytes ?? 524288;
    check(integer(size, 1, 0x7fffffff) && integer(target, 128, LIMITS.pack - 1024), 'Invalid chunk-size/pack-bytes');
    for (const input of [source, previous].filter(Boolean) as string[]) check(out !== input && !out.startsWith(input + '/') && !input.startsWith(out + '/'), 'Output must be separate from input/previous snapshot');
    async function read(root: string, ref: FileRef) {
        check(/^[a-f0-9]{64}\.(pb|json|bin)$/.test(ref.url) && ref.url.startsWith(ref.sha256 + '.'), 'Invalid immutable path');
        const bytes = new Uint8Array(await fs.readFile(path.join(root, ref.url)));
        check(bytes.length === ref.bytes && digest(bytes) === ref.sha256, `Artifact integrity failure: ${ref.url}`); return bytes;
    }
    async function rootManifest(root: string) {
        if (await Bun.file(path.join(root, 'manifest.pb')).exists()) return codec.decodeManifest(new Uint8Array(await Bun.file(path.join(root, 'manifest.pb')).arrayBuffer()));
        const manifest = await Bun.file(path.join(root, 'manifest.json')).json();
        const { snapshot, ...body } = manifest;
        check(snapshot === digest(json(body)) && typeof manifest.layout === 'string' && manifest.layout.length > 0, 'Incompatible manifest/revision');
        check(Array.isArray(manifest.regions) && manifest.regions.length > 0 && manifest.publishedHeight === manifest.regions.length * 2016 - 1, 'Invalid source coverage');
        manifest.regions.forEach((r: any, i: number) => check(r.id === i && integer(r.width, 1, 0x7fffffff) && integer(r.height, 1, 0x7fffffff), 'Invalid region dimensions'));
        return manifest;
    }
    const manifest = await rootManifest(source);
    check([FORMAT, GROUP_FORMAT].includes(manifest.format), 'Source must be a validated v1/v2 export');
    const inputReport = await Bun.file(path.join(source, 'report.json')).json();
    check(inputReport.status === 'passed' && inputReport.snapshot === manifest.snapshot, 'Source validation report missing/mismatched');
    const grid = { size, originX: 0, originY: 0, ownership: 'top-left' };
    const old = previous && await rootManifest(previous);
    if (old) {
        check(old.layout===LAYOUT,'Previous data differs from the official spiral; use a separate output');
        check(old.format === (shuffled?SHUFFLE_FORMAT:chained ? CHAIN_FORMAT : proto ? PROTO_FORMAT : CHUNK_FORMAT) && JSON.stringify(old.grid) === JSON.stringify(grid) && old.packBytes === target, 'Previous grid/pack settings differ; start a separate snapshot without --previous');
        check(!shuffled||old.shuffleSeed===seed,'Previous shuffle seed differs; start a separate snapshot without --previous');
        check((old.frameBytes ?? 131072) === frameBytes, 'Previous frame size differs; start a separate snapshot without --previous');
        check(manifest.publishedHeight >= old.publishedHeight, 'Published height cannot move backwards');
        old.regions.forEach((r: any, i: number) => check(r.width === manifest.regions[i].width && r.height === manifest.regions[i].height, 'Published neighborhood dimensions changed'));
    }
    await fs.mkdir(path.dirname(out), { recursive: true });
    await fs.mkdir(out, { recursive: false });
    const work = path.join(out, '.work'); await fs.mkdir(work);
    let written = 0, reused = 0, records = 0, parcels = 0, bytesTotal = 0;
    async function put(bytes: Uint8Array, ext: string, metadata = true): Promise<FileRef> {
        if (metadata && (ext === 'json' || ext === 'pb')) check(bytes.length <= LIMITS.metadata, 'Metadata exceeds client limit');
        const hash = digest(bytes), url = `${hash}.${ext}`, destination = path.join(out, url);
        try { await fs.access(destination); }
        catch {
            let reuse = false;
            if (previous) {
                try {
                    const oldBytes = await fs.readFile(path.join(previous, url));
                    check(oldBytes.length === bytes.length && digest(oldBytes) === hash, 'Corrupt previous immutable artifact');
                    await fs.copyFile(path.join(previous, url), destination); reuse = true;
                } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
            }
            if (reuse) reused++; else { await Bun.write(destination, bytes); written++; }
            bytesTotal += bytes.length;
        }
        return { url, sha256: hash, bytes: bytes.length };
    }
    const layout = new SpiralLayout(manifest.regions);
    type Cell = { x: number; y: number; count: number; index: number; ref?: ChunkRef; proto?: ProtoChunk };
    const cells = new Map<string, Cell>(), cellList: Cell[] = [], owners = new Uint32Array(manifest.publishedHeight + 1);
    const regional: { descriptor: RegionDescriptor; geometry: FileRef; owners: number[] }[] = [];
    const packs = new Map<string, PackRef>(), oldCells = new Map<string, Pick<ChunkDescriptor, 'records' | 'lastHeight' | 'recordDigest'>>();
    if ((old?.format === PROTO_FORMAT || old?.format === CHAIN_FORMAT || old?.format === SHUFFLE_FORMAT)) for (const c of old.chunks) oldCells.set(`${c.x},${c.y}`, c);
    for (const r of manifest.regions) {
        const descriptor = JSON.parse(new TextDecoder().decode(await read(source, r.descriptor))) as RegionDescriptor;
        check(descriptor.id === r.id, 'Wrong source region'); validateRegionPacks(descriptor, manifest.format);
        const geometryBytes = await read(source, descriptor.geometry), geometry = type.decode(geometryBytes);
        check(geometry.neighborhood === r.id && geometry.width === r.width && geometry.height === r.height && geometry.bitmaps.length === 2016, 'Invalid canonical geometry');
        if (old && r.id < old.regions.length) {
            const oldDescriptor = proto ? old.regions[r.id] : JSON.parse(new TextDecoder().decode(await read(previous!, old.regions[r.id].descriptor)));
            if (proto) check(oldDescriptor.x === layout.slots[r.id].x && oldDescriptor.y === layout.slots[r.id].y, 'Published neighborhood position changed');
            check(oldDescriptor.geometry.sha256 === descriptor.geometry.sha256, 'Published canonical geometry changed');
            for (const c of oldDescriptor.chunks || []) if (!oldCells.has(`${c.x},${c.y}`)) {
                const data = JSON.parse(new TextDecoder().decode(await read(previous!, c.descriptor)));
                check(data.x === c.x && data.y === c.y && data.size === size && data.format === CHUNK_FORMAT, 'Invalid previous chunk');
                oldCells.set(`${c.x},${c.y}`, data);
            }
        }
        const localOwners: number[] = [];
        for (const [i, rect] of geometry.bitmaps.entries()) {
            check(integer(rect.x, 0, r.width) && integer(rect.y, 0, r.height) && integer(rect.width, 1, r.width) && integer(rect.height, 1, r.height) && rect.x + rect.width <= r.width && rect.y + rect.height <= r.height, 'Invalid bitmap bounds');
            const { x, y } = chunkAt(layout.slots[r.id].x + rect.x, layout.slots[r.id].y + rect.y, size), key = `${x},${y}`;
            let cell = cells.get(key);
            if (!cell) { cell = { x, y, count: 0, index: cellList.length }; cells.set(key, cell); cellList.push(cell); }
            owners[r.id * 2016 + i] = cell.index; localOwners.push(cell.index);
        }
        for (const pack of descriptor.packs) {
            const existing = packs.get(pack.sha256);
            check(!existing || JSON.stringify(existing) === JSON.stringify(pack), 'Conflicting source pack metadata'); packs.set(pack.sha256, pack);
        }
        regional.push({ descriptor, geometry: await put(geometryBytes, 'pb'), owners: localOwners });
        reportGenerationProgress({ kind: 'neighborhood', phase: 'Parcel chunk geometry', id: r.id, completed: regional.length, total: manifest.regions.length, action: 'processed' });
    }
    type SpoolWriter = { write: (bytes: Uint8Array) => number | Promise<number>; end: () => Promise<void> };
    const writers = new Map<number, SpoolWriter>();
    async function writer(index: number) {
        let result = writers.get(index);
        if (result) { writers.delete(index); writers.set(index, result); return result; }
        if (writers.size >= 32) { const [key, value] = writers.entries().next().value!; await value.end(); writers.delete(key); }
        // Bun writer opens with truncation: append using an explicit append-mode descriptor.
        const handle = await fs.open(path.join(work, String(index)), 'a');
        const sink = Bun.file(handle.fd).writer();
        const opened: SpoolWriter = { write: bytes => sink.write(bytes), end: async () => { await sink.end(); await handle.close(); } };
        writers.set(index, opened); return opened;
    }
    try {
        let last = -1;
        for (const pack of [...packs.values()].sort((a, b) => a.first - b.first)) {
            const wire = await read(source, pack), batch: ParcelRecord[] = [];
            async function* chunks() { yield wire; }
            for await (const record of parsePack(chunks(), pack)) batch.push(record);
            batch.sort((a, b) => a.id - b.id);
            for (const record of batch) {
                check(record.id > last && record.id <= manifest.publishedHeight, 'Duplicate/out-of-order source bitmap'); last = record.id;
                const cell = cellList[owners[record.id]]; cell.count++; records++; parcels += record.txCount;
                await (await writer(cell.index)).write(recordBytes(record));
            }
            if (records % 50000 < batch.length) console.log(JSON.stringify({ stage: 'partition', records, chunks: cells.size }));
            reportGenerationProgress({ kind: 'units', phase: 'Reading parcel packs', unit: 'Bitmaps read', completed: records, total: manifest.parcelRegions.length * 2016 });
        }
    } finally { for (const writer of writers.values()) await writer.end(); writers.clear(); }
    const selected = manifest.regions.filter((r: any) => regional[r.id].descriptor.coverage === 'complete').map((r: any) => r.id);
    check(records === selected.length * 2016, 'Source record coverage mismatch');
    let physicalPacks = 0, maxPackBytes = 0;
    let completedChunks = 0;
    const totalChunks = cellList.filter(cell => cell.count > 0).length;
    const progress = generationProgressEnabled() ? new GenerationCoverage(manifest.publishedHeight, selected.length) : undefined;
    for (const [index, cell] of cellList.entries()) {
        if (!cell.count) continue;
        const oldCell = oldCells.get(`${cell.x},${cell.y}`);
        if (oldCell) check(cell.count >= oldCell.records, 'Published chunk lost bitmaps');
        const stream = new ByteReader(createReadStream(path.join(work, String(cell.index)))), recordHash = createHash('sha256');
        const packRefs: FileRef[] = [], protoPacks: PackRef[] = [];
        let batch: ParcelRecord[] = [], logicalBytes = proto ? 64 : 24, last = -1;
        async function flush() {
            if (!batch.length) return;
            const pack = chained ? await codec.buildChainedPack(batch, cell.x, cell.y, frameBytes,shuffled?6:5) : proto ? await codec.buildPack(batch, cell.x, cell.y, frameBytes) : await buildChunkPack(batch, cell.x, cell.y, frameBytes);
            const ref = { ...pack.descriptor, ...await put(pack.wire, proto ? 'pb' : 'bin', false) };
            if (proto) protoPacks.push(ref); else packRefs.push(await put(json(ref), 'json')); physicalPacks++; maxPackBytes = Math.max(maxPackBytes, pack.wire.length);
            batch = []; logicalBytes = proto ? 64 : 24;
        }
        const offsets:number[]=[],lengths:number[]=[];
        async function* canonicalRecords(){
            let offset=0;
            try {
                for(let i=0;i<cell.count;i++){
                    const prefix=await stream.read(4),length=new DataView(prefix.buffer,prefix.byteOffset,4).getUint32(0,true);
                    check(integer(length,12,LIMITS.record),'Invalid spool record');
                    const bytes=await stream.read(length),v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
                    const record={id:v.getUint32(0,true),txCount:v.getUint32(4,true),rle:bytes[8]===1,tx:bytes.subarray(12)};
                    check(record.id>last,'Non-monotonic canonical chunk');last=record.id;
                    progress?.record(record.id);
                    recordHash.update(prefix);recordHash.update(bytes);
                    if(oldCell&&i+1===oldCell.records)check(recordHash.copy().digest('hex')===oldCell.recordDigest,'Published bitmap payload/ownership changed');
                    if(shuffled){offsets.push(offset+4);lengths.push(length);}offset+=length+4;
                    yield record;
                }
                check(await stream.eof(),'Trailing spool bytes');
            }finally{await stream.close();}
        }
        async function* shuffledRecords(){
            // Verify immutable canonical history before changing transport order.
            for await(const _record of canonicalRecords()){ /* retain offsets, never all decoded payloads */ }
            const handle=await fs.open(path.join(work,String(cell.index)),'r');
            try{
                const stat=await handle.stat();
                // Dense chunks have a bounded 32 MiB read cache; larger spools use positioned reads.
                const cached=stat.size<=LIMITS.pack?new Uint8Array(await handle.readFile()):undefined;
                for(const i of chunkShuffleOrder(cell.count,seed,cell.x,cell.y)){
                    const length=lengths[i],offset=offsets[i];
                    const bytes=cached?cached.subarray(offset,offset+length):new Uint8Array(length);
                    if(!cached){let read=0;while(read<length){const result=await handle.read(bytes,read,length-read,offset+read);check(result.bytesRead>0,'Truncated shuffled spool');read+=result.bytesRead;}}
                    const v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
                    yield {id:v.getUint32(0,true),txCount:v.getUint32(4,true),rle:bytes[8]===1,tx:bytes.subarray(12)};
                }
            }finally{await handle.close();}
        }
        for await(const record of shuffled?shuffledRecords():canonicalRecords()){
            const encodedLength=proto?codec.encodeRecord(record).length:record.tx.length+16;
            const recordLength=encodedLength+(chained?64*Math.ceil(encodedLength/frameBytes):0),next=logicalBytes+recordLength;
            if(batch.length&&(next+Math.ceil(next/frameBytes)*(chained?0:proto?32:8)>target||batch.length===65536))await flush();
            batch.push(record);logicalBytes+=recordLength;
        }
        await flush();
        const descriptor: ChunkDescriptor = { format: CHUNK_FORMAT, x: cell.x, y: cell.y, size, packs: packRefs, records: cell.count, lastHeight: last, recordDigest: recordHash.digest('hex') };
        if (proto) cell.proto = { x: cell.x, y: cell.y, records: cell.count, lastHeight: last, recordDigest: descriptor.recordDigest, packs: protoPacks };
        else cell.ref = { x: cell.x, y: cell.y, descriptor: await put(json(descriptor), 'json') };
        oldCells.delete(`${cell.x},${cell.y}`);
        completedChunks++;
        if (progress) reportGenerationProgress({ kind: 'coverage', phase: 'Parcel chunks written', unit: 'Chunks',
            completed: completedChunks, total: totalChunks, ...progress.snapshot() });
        if (index % 100 === 0) console.log(JSON.stringify({ stage: 'pack', chunks: index + 1, total: cellList.length, physicalPacks }));
    }
    check(oldCells.size === 0, 'Published chunks disappeared');
    const regions: any[] = [];
    for (const r of manifest.regions) {
        const data = regional[r.id], chunks: ChunkRef[] = [], chunkIndices = new Map<number, number>();
        if (proto) {
            regions.push({ id: r.id, width: r.width, height: r.height, descriptor: data.geometry, geometry: data.geometry, coverage: data.descriptor.coverage, x: layout.slots[r.id].x, y: layout.slots[r.id].y } as ProtoRegion); continue;
        }
        const bitmapChunks = data.owners.map(index => {
            const ref = cellList[index].ref;
            if (data.descriptor.coverage !== 'complete') return -1;
            check(ref, 'Missing generated chunk');
            if (!chunkIndices.has(index)) { chunkIndices.set(index, chunks.length); chunks.push(ref); }
            return chunkIndices.get(index)!;
        });
        const descriptor: RegionDescriptor = { format: CHUNK_FORMAT, id: r.id, geometry: data.geometry, coverage: data.descriptor.coverage, packs: [], chunks, bitmapChunks };
        validateRegionPacks(descriptor, CHUNK_FORMAT);
        regions.push({ id: r.id, width: r.width, height: r.height, descriptor: await put(json(descriptor), 'json') });
    }
    const body = { format: shuffled?SHUFFLE_FORMAT:chained ? CHAIN_FORMAT : proto ? PROTO_FORMAT : CHUNK_FORMAT, ...(shuffled?{shuffleSeed:seed}:{}), layout: LAYOUT, grid, packBytes: target, publishedHeight: manifest.publishedHeight, regions, parcelRegions: selected, ...(proto ? { frameBytes, chunks: cellList.filter(c => c.proto).map(c => c.proto!) } : {}) };
    const snapshot = digest(proto ? codec.encodeManifest({ ...body, snapshot: '' } as ProtoManifest, false) : json(body));
    const manifestBytes = proto ? codec.encodeManifest({ ...body, snapshot } as ProtoManifest) : json({ ...body, snapshot });
    if (proto) await codec.decodeManifest(manifestBytes);
    const report = { status: 'passed', snapshot, sourceSnapshot: manifest.snapshot, previousSnapshot: old?.snapshot, sample: selected.length !== regions.length,
        ...(shuffled?{order:CHUNK_SHUFFLE,shuffleSeed:seed}:{}), records, parcels, chunks: cellList.filter(c => c.count).length, physicalPacks, maxPackBytes, artifactBytes: bytesTotal, written, reused,
        validation: `verified-source-frames-and-records; canonical-geometry; ${LAYOUT}-top-left-ownership; append-only-prefix`, exactMondrian: inputReport.validation?.exactMondrian ?? false };
    if(proto&&options.previews!==false) (report as any).preview=await generatePreviews({source:out,manifest:await codec.decodeManifest(manifestBytes),previous,tileSize:options.previewTileSize,resolution:options.previewResolution});
    await Bun.write(path.join(out, 'report.json'), json(report));
    await fs.rm(work, { recursive: true });
    const entry = proto ? 'manifest.pb' : 'manifest.json';
    await Bun.write(path.join(out, entry + '.tmp'), manifestBytes);
    await fs.rename(path.join(out, entry + '.tmp'), path.join(out, entry));
    console.log(JSON.stringify(report)); return report;
}
if (import.meta.main) {
    const args = process.argv.slice(2), options: Record<string, string> = {};
    check(args.length % 2 === 0, 'Usage: bun scripts/generate-chunks.ts --source EXPORT --out NEW_DIR [--chunk-size 1024] [--pack-bytes 524288] [--previous OLD_CHUNKS] [--format v6|v5|v4|v3] [--seed UINT32] [--frame-bytes 16384]');
    for (let i = 0; i < args.length; i += 2) { check(['--source', '--out', '--seed', '--chunk-size', '--pack-bytes', '--previous', '--format', '--frame-bytes', '--previews', '--preview-tile-size', '--preview-resolution'].includes(args[i]) && !options[args[i]], 'Unknown/duplicate option'); options[args[i]] = args[i + 1]; }
    check(options['--source'] && options['--out'], '--source and --out are required');
    check(!options['--format'] || ['v3', 'v4', 'v5', 'v6'].includes(options['--format']), 'Invalid output format');
    await generateChunks({ seed:options['--seed']===undefined?undefined:Number(options['--seed']), previews: options['--previews'] !== 'false', previewTileSize: options['--preview-tile-size'] ? Number(options['--preview-tile-size']) : undefined, previewResolution: options['--preview-resolution'] ? Number(options['--preview-resolution']) : undefined, frameBytes: options['--frame-bytes'] ? Number(options['--frame-bytes']) : undefined, format: (options['--format'] || 'v6') as 'v3' | 'v4' | 'v5' | 'v6', source: options['--source'], out: options['--out'], previous: options['--previous'], chunkSize: options['--chunk-size'] ? Number(options['--chunk-size']) : undefined, packBytes: options['--pack-bytes'] ? Number(options['--pack-bytes']) : undefined });
}
