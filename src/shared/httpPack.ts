/** bitmap-http-pack-v1/v2. All integers are unsigned little endian. See docs/http-pack-format.md. */
import { encodeHuffmanRle, decodeHuffmanRle, validateHuffmanRle } from './txHuffmanRle';
export const FORMAT = 'bitmap-http-pack-v1';
export const GROUP_FORMAT = 'bitmap-http-pack-v2';
export const CHUNK_FORMAT = 'bitmap-http-chunks-v3';
export const PROTO_FORMAT = 'bitmap-http-protobuf-v4';
export const CHAIN_FORMAT = 'bitmap-http-protobuf-v5';
export const SHUFFLE_FORMAT = 'bitmap-http-protobuf-v6';
export const DIMENSIONS_FORMAT = 'bitmap-http-protobuf-v7';
export const PAGED_FORMAT = 'bitmap-http-protobuf-v8';
export const HUFFMAN_FORMAT = 'bitmap-http-protobuf-v9';
export const isPagedFormat = (format: string) => format === PAGED_FORMAT || format === HUFFMAN_FORMAT;
export const supportsFormat = (format: string) => format === FORMAT || format === GROUP_FORMAT || format === CHUNK_FORMAT || format === PROTO_FORMAT || format === CHAIN_FORMAT || format === SHUFFLE_FORMAT || format === DIMENSIONS_FORMAT || isPagedFormat(format);
export const LAYOUT = 'tight-neighborhood-spiral-v3-guided-inner-edge';
export const LIMITS = { frame: 262144, record: 16 * 1024 * 1024, tx: 4_000_000, pack: 32 * 1024 * 1024, metadata: 2 * 1024 * 1024 };
export type FileRef = { url: string; sha256: string; bytes: number };
export type PackRef = FileRef & { format?: string; headSha256?: string; frameCount?: number; ids?: number[]; chunkX?: number; chunkY?: number; neighborhood?: number; ordinal?: number; first: number; last: number; records: number; parcels: number; frames: { bytes: number; sha256: string }[] };
export type Region = { id: number; width: number; height: number; descriptor: FileRef; x?: number; y?: number };
export type Manifest = { format: string; layout: string; snapshot: string; publishedHeight: number; grid?: { size: number; originX: 0; originY: 0; ownership: 'top-left' }; regions: Region[] };
export type RegionDescriptor = { format: string; id: number; geometry: FileRef; coverage: 'complete' | 'geometry-only'; packs: PackRef[]; chunks?: ChunkRef[]; bitmapChunks?: number[] };
export type ChunkRef = { x: number; y: number; descriptor: FileRef };
export type ChunkDescriptor = { format: string; x: number; y: number; size: number; packs: FileRef[]; records: number; lastHeight: number; recordDigest: string };
export function chunkAt(x0: number, y0: number, size: number) {
    check(Number.isFinite(x0) && Number.isFinite(y0) && integer(size, 1, 0x7fffffff), 'Invalid chunk coordinates/size');
    return { x: Math.floor(x0 / size), y: Math.floor(y0 / size) };
}
export type ParcelRecord = { id: number; txCount: number; rle: boolean; tx: Uint8Array; encoding?: 0 | 1 | 4 };
export function recordEncoding(record: ParcelRecord): 0 | 1 | 4 {
    const encoding = record.encoding ?? (record.rle ? 1 : 0);
    check((encoding === 0 || encoding === 1 || encoding === 4) && record.rle === (encoding === 1), 'Unknown/inconsistent parcel encoding');
    return encoding;
}
const magic = new Uint8Array([66, 77, 72, 80, 65, 67, 75, 0]);
const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);
export function check(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
export const integer = (n: number, min: number, max: number) => Number.isSafeInteger(n) && n >= min && n <= max;
export async function sha256(bytes: Uint8Array): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer);
    return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}
export function validateRecord(record: ParcelRecord) {
    check(integer(record.id, 0, 0xffffffff) && integer(record.txCount, 0, LIMITS.tx), 'Invalid bitmap/txCount');
    check(record.tx instanceof Uint8Array && record.tx.length + 12 <= LIMITS.record, 'Invalid record payload');
    if (recordEncoding(record) === 4) { validateHuffmanRle(record.tx, record.txCount); return; }
    if (record.rle) {
        let count = 0;
        for (const byte of record.tx) { check((byte >> 4) > 0 && (byte & 15) > 0, 'Invalid rle4 run'); count += byte & 15; check(count <= record.txCount, 'Invalid rle4 count'); }
        check(count === record.txCount, 'Transaction coverage mismatch');
    } else {
        check(record.tx.length === Math.ceil(record.txCount / 2), 'Invalid raw4 length');
        for (let i = 0; i < record.tx.length; i++) {
            const byte = record.tx[i]; check((byte >> 4) > 0, 'Zero parcel size');
            if (i === record.tx.length - 1 && record.txCount % 2) check((byte & 15) === 0, 'Invalid raw4 padding');
            else check((byte & 15) > 0, 'Zero parcel size');
        }
    }
}
export function decodeSizes(record: ParcelRecord): number[] {
    if (record.encoding === 4) return Array.from(decodeParcelSizes(record));
    validateRecord(record);
    const result = new Array<number>(record.txCount);
    if (record.rle) {
        let index = 0;
        for (const byte of record.tx) for (let i = 0; i < (byte & 15); i++) result[index++] = byte >> 4;
    } else for (let i = 0; i < record.txCount; i++) result[i] = (record.tx[i >> 1] >> (i % 2 ? 0 : 4)) & 15;
    return result;
}
/** The official worker consumes Huffman output without an intermediate JS array. */
export function decodeParcelSizes(record: ParcelRecord): number[] | Uint8Array {
    if (recordEncoding(record) !== 4) return decodeSizes(record);
    check(integer(record.id, 0, 0xffffffff) && integer(record.txCount, 0, LIMITS.tx) && record.tx instanceof Uint8Array && record.tx.length + 12 <= LIMITS.record, 'Invalid bitmap payload');
    return decodeHuffmanRle(record.tx, record.txCount);
}
/** Frozen model; no training when appending data. Values 10..15 retain legacy encoding. */
export function encodeAdaptiveSizes(id: number, sizes: number[]): ParcelRecord {
    const legacy = encodeSizes(id, sizes);
    if (!sizes.every(value => value >= 1 && value <= 9)) return legacy;
    const encoded = encodeHuffmanRle(sizes);
    return encoded.tx.length < legacy.tx.length ? { id, txCount: sizes.length, rle: false, encoding: 4, tx: encoded.tx } : legacy;
}
export function encodeSizes(id: number, sizes: number[]): ParcelRecord {
    check(integer(id, 0, 0xffffffff) && sizes.length <= LIMITS.tx, 'Invalid bitmap/transaction count');
    const raw = new Uint8Array(Math.ceil(sizes.length / 2));
    const runs: number[] = [];
    for (let i = 0; i < sizes.length; i++) {
        check(integer(sizes[i], 1, 15), 'raw4/rle4 supports sizes 1..15');
        raw[i >> 1] |= sizes[i] << (i % 2 ? 0 : 4);
        const last = runs.length - 1;
        if (last >= 0 && (runs[last] >> 4) === sizes[i] && (runs[last] & 15) < 15) runs[last]++;
        else runs.push((sizes[i] << 4) | 1);
    }
    return { id, txCount: sizes.length, rle: runs.length < raw.length, tx: runs.length < raw.length ? new Uint8Array(runs) : raw };
}
export function validatePack(pack: PackRef) {
    if (pack.format === PROTO_FORMAT || pack.format === CHAIN_FORMAT || pack.format === SHUFFLE_FORMAT || pack.format === HUFFMAN_FORMAT) {
        check(integer(pack.chunkX ?? NaN, -0x80000000, 0x7fffffff) && integer(pack.chunkY ?? NaN, -0x80000000, 0x7fffffff), 'Invalid protobuf chunk identity');
        check(integer(pack.first, 0, 0xffffffff) && integer(pack.last, pack.first, 0xffffffff) && integer(pack.records, 1, 65536) && pack.records <= pack.last - pack.first + 1, 'Invalid protobuf pack coverage');
        check(pack.neighborhood === undefined && pack.ordinal === undefined, 'Unexpected protobuf pack index');
        if((pack.format===SHUFFLE_FORMAT || pack.format===HUFFMAN_FORMAT)){
            check(Array.isArray(pack.ids)&&pack.ids.length===pack.records,'Invalid shuffled pack membership');
            pack.ids.forEach((id,i)=>check(integer(id,pack.first,pack.last)&&(!i||id>pack.ids![i-1]),'Invalid/duplicate shuffled bitmap'));
            check(pack.ids[0]===pack.first&&pack.ids[pack.ids.length-1]===pack.last,'Invalid shuffled pack bounds');
        }else check(pack.ids===undefined,'Unexpected protobuf pack membership');
    } else if (pack.format === CHUNK_FORMAT) {
        check(integer(pack.chunkX ?? NaN, -0x80000000, 0x7fffffff) && integer(pack.chunkY ?? NaN, -0x80000000, 0x7fffffff), 'Invalid chunk identity');
        check(Array.isArray(pack.ids) && pack.ids.length === pack.records && pack.records > 0 && pack.records <= 65536, 'Invalid chunk pack membership');
        pack.ids.forEach((id, i) => check(integer(id, 0, 0xffffffff) && (!i || id > pack.ids![i - 1]), 'Invalid/duplicate chunk bitmap'));
        check(pack.first === pack.ids[0] && pack.last === pack.ids[pack.ids.length - 1] && pack.neighborhood === undefined && pack.ordinal === undefined, 'Invalid chunk pack coverage');
    } else if (pack.format === GROUP_FORMAT) {
        check(integer(pack.first, 0, 0xffffffff) && integer(pack.last, pack.first, 0xffffffff) && pack.records === pack.last - pack.first + 1 && pack.records <= 65536, 'Invalid grouped pack coverage');
        check(pack.neighborhood === undefined && pack.ordinal === undefined, 'Grouped pack must not belong to one neighborhood');
    } else {
        check(pack.format === undefined || pack.format === FORMAT, 'Unknown pack format');
        const neighborhood = pack.neighborhood ?? -1;
        check(integer(neighborhood, 0, 0xffffffff) && integer(pack.ordinal ?? -1, 0, 2015), 'Invalid pack ID');
        check(integer(pack.first, neighborhood * 2016, (neighborhood + 1) * 2016 - 1) &&
            integer(pack.last, pack.first, (neighborhood + 1) * 2016 - 1) && pack.records === pack.last - pack.first + 1, 'Invalid pack coverage');
    }
    check(integer(pack.parcels, 0, LIMITS.tx * pack.records) && integer(pack.bytes, (pack.format === PROTO_FORMAT || pack.format === CHAIN_FORMAT || pack.format === SHUFFLE_FORMAT || pack.format === HUFFMAN_FORMAT) ? 1 : 32, LIMITS.pack), 'Invalid pack totals');
    if (pack.format === CHAIN_FORMAT || pack.format === SHUFFLE_FORMAT || pack.format === HUFFMAN_FORMAT) {
        check(/^[a-f0-9]{64}$/.test(pack.sha256) && /^[a-f0-9]{64}$/.test(pack.headSha256 || '') && integer(pack.frameCount ?? 0, pack.records + 1, 1000000) && pack.frames.length === 0, 'Invalid chained frame index');
        return;
    }
    check(Array.isArray(pack.frames) && pack.frames.length > 0 && pack.frames.length <= 8192, 'Invalid frame count');
    let bytes = 0;
    for (const frame of pack.frames) { check(integer(frame.bytes, pack.format === PROTO_FORMAT ? 1 : 9, LIMITS.frame + (pack.format === PROTO_FORMAT ? 32 : 8)) && /^[a-f0-9]{64}$/.test(frame.sha256), 'Invalid frame metadata'); bytes += frame.bytes; }
    check(bytes === pack.bytes && /^[a-f0-9]{64}$/.test(pack.sha256), 'Invalid pack length/hash');
}
export async function buildPack(records: ParcelRecord[], neighborhood: number, ordinal: number, frameBytes = 131072, version = 1) {
    check(records.length > 0 && records.length <= 65536 && integer(frameBytes, 1, LIMITS.frame) && (version === 1 || version === 2 || version === 3), 'Invalid pack/frame size');
    let first = Infinity, last = -1;
    for (const record of records) { first = Math.min(first, record.id); last = Math.max(last, record.id); }
    const parts = [new Uint8Array(24)];
    parts[0].set(magic); const header = view(parts[0]);
    header.setUint32(8, version, true); header.setUint32(12, version === 2 ? first : neighborhood >>> 0, true); header.setUint32(16, version === 2 ? last : ordinal >>> 0, true); header.setUint32(20, records.length, true);
    for (const record of records) {
        validateRecord(record);
        check(recordEncoding(record) <= 1, 'Legacy binary packs cannot contain Huffman records');
        check(record.tx.length + 12 <= LIMITS.record, 'Record exceeds memory limit');
        const part = new Uint8Array(16 + record.tx.length), v = view(part);
        v.setUint32(0, part.length - 4, true); v.setUint32(4, record.id, true); v.setUint32(8, record.txCount, true);
        part[12] = record.rle ? 1 : 0; part.set(record.tx, 16); parts.push(part);
    }
    const total = parts.reduce((s, p) => s + p.length, 0);
    check(total + Math.ceil(total / frameBytes) * 8 <= LIMITS.pack, 'Pack exceeds memory limit');
    const logical = new Uint8Array(total); let pos = 0;
    for (const part of parts) { logical.set(part, pos); pos += part.length; }
    const frames: Uint8Array[] = [], metadata: PackRef['frames'] = [];
    for (let offset = 0; offset < total; offset += frameBytes) {
        const payload = logical.subarray(offset, offset + frameBytes), frame = new Uint8Array(8 + payload.length);
        view(frame).setUint32(0, frames.length, true); view(frame).setUint32(4, payload.length, true); frame.set(payload, 8);
        frames.push(frame); metadata.push({ bytes: frame.length, sha256: await sha256(frame) });
    }
    const wire = new Uint8Array(frames.reduce((s, p) => s + p.length, 0)); pos = 0;
    for (const frame of frames) { wire.set(frame, pos); pos += frame.length; }
    const ids = records.map(r => r.id);
    const descriptor: PackRef = { url: '', sha256: await sha256(wire), bytes: wire.length, ...(version === 3 ? { format: CHUNK_FORMAT, chunkX: neighborhood, chunkY: ordinal, ids: [...ids].sort((a, b) => a - b) } : version === 2 ? { format: GROUP_FORMAT } : { neighborhood, ordinal }),
        first, last, records: records.length, parcels: records.reduce((s, r) => s + r.txCount, 0), frames: metadata };
    validatePack(descriptor);
    check(new Set(ids).size === records.length, 'Duplicate bitmap');
    return { wire, descriptor };
}
export function buildChunkPack(records: ParcelRecord[], x: number, y: number, frameBytes = 131072) {
    return buildPack(records, x, y, frameBytes, 3);
}
/** Same record/frame encoding; v2 header identifies a cross-neighborhood height interval. */
export function buildGroupedPack(records: ParcelRecord[], frameBytes = 131072) {
    return buildPack(records, 0, 0, frameBytes, 2);
}
/** Validate clipped coverage: one immutable pack may be referenced by many regions. */
export function validateRegionPacks(region: RegionDescriptor, format: string) {
    check(supportsFormat(format) && region.format === format && integer(region.id, 0, 10000) && Array.isArray(region.packs) && region.packs.length <= 2016, 'Invalid region descriptor');
    if (format === CHUNK_FORMAT) {
        check(region.packs.length === 0 && Array.isArray(region.chunks) && region.chunks.length <= 2016 && Array.isArray(region.bitmapChunks) && region.bitmapChunks.length === 2016, 'Invalid spatial region index');
        const keys = new Set<string>();
        for (const chunk of region.chunks) {
            const key = `${chunk.x},${chunk.y}`;
            check(integer(chunk.x, -0x80000000, 0x7fffffff) && integer(chunk.y, -0x80000000, 0x7fffffff) && !keys.has(key), 'Invalid/duplicate region chunk'); keys.add(key);
        }
        check(region.coverage === 'complete' || region.coverage === 'geometry-only', 'Invalid region coverage');
        region.bitmapChunks.forEach(index => check(region.coverage === 'complete' ? integer(index, 0, region.chunks!.length - 1) : index === -1, 'Missing bitmap chunk'));
        return;
    }
    const first = region.id * 2016, last = first + 2015;
    let next = first;
    for (const [ordinal, pack] of region.packs.entries()) {
        validatePack(pack);
        if (format === GROUP_FORMAT) check(pack.format === GROUP_FORMAT && pack.first <= last && pack.last >= first, 'Pack does not intersect region');
        else check(pack.format !== GROUP_FORMAT && pack.neighborhood === region.id && pack.ordinal === ordinal, 'Region pack identity mismatch');
        check(Math.max(first, pack.first) === next, 'Region pack coverage mismatch'); next = Math.min(last, pack.last) + 1;
    }
    check(region.coverage === 'complete' ? next === last + 1 : region.coverage === 'geometry-only' && region.packs.length === 0, 'Missing region bitmaps');
}
/** Keeps one upstream chunk and one bounded read; never accumulates previous network chunks. */
export class ByteReader {
    private iterator: AsyncIterator<Uint8Array>; private current: Uint8Array = new Uint8Array(0); private offset = 0;
    constructor(chunks: AsyncIterable<Uint8Array>) { this.iterator = chunks[Symbol.asyncIterator](); }
    async read(length: number): Promise<Uint8Array> {
        check(integer(length, 0, LIMITS.record + 4), 'Read exceeds memory limit');
        const result = new Uint8Array(length); let offset = 0;
        while (offset < length) {
            if (this.offset === this.current.length) {
                const next = await this.iterator.next(); check(!next.done, 'Truncated HTTP pack');
                this.current = next.value; this.offset = 0;
            }
            const count = Math.min(length - offset, this.current.length - this.offset);
            result.set(this.current.subarray(this.offset, this.offset + count), offset); this.offset += count; offset += count;
        }
        return result;
    }
    async eof() { if (this.offset < this.current.length) return false; let next; do { next = await this.iterator.next(); } while (!next.done && !next.value.length); return !!next.done; }
    async close() { await this.iterator.return?.(); }
}
export async function* parsePack(chunks: AsyncIterable<Uint8Array>, pack: PackRef, onFrame?: (hash: string, frame: Uint8Array) => Promise<void>): AsyncGenerator<ParcelRecord> {
    validatePack(pack);
    const wire = new ByteReader(chunks);
    const verified = async function* () {
        for (let i = 0; i < pack.frames.length; i++) {
            const expected = pack.frames[i], frame = await wire.read(expected.bytes);
            check(await sha256(frame) === expected.sha256, 'Corrupt pack frame');
            const v = view(frame); check(v.getUint32(0, true) === i && v.getUint32(4, true) === frame.length - 8, 'Invalid frame sequence/length');
            await onFrame?.(expected.sha256, frame);
            yield frame.subarray(8);
        }
        check(await wire.eof(), 'Unexpected trailing pack bytes');
    };
    const logical = new ByteReader(verified());
    try {
        const header = await logical.read(24), v = view(header);
        const spatial = pack.format === CHUNK_FORMAT, members = spatial ? new Set(pack.ids) : undefined;
        check(magic.every((b, i) => b === header[i]) && v.getUint32(8, true) === (spatial ? 3 : pack.format === GROUP_FORMAT ? 2 : 1), 'Unknown pack magic/version');
        check((spatial ? v.getInt32(12, true) === pack.chunkX && v.getInt32(16, true) === pack.chunkY : v.getUint32(12, true) === (pack.format === GROUP_FORMAT ? pack.first : pack.neighborhood) && v.getUint32(16, true) === (pack.format === GROUP_FORMAT ? pack.last : pack.ordinal)) && v.getUint32(20, true) === pack.records, 'Pack identity mismatch');
        const seen = new Set<number>(); let parcels = 0;
        for (let i = 0; i < pack.records; i++) {
            const length = view(await logical.read(4)).getUint32(0, true);
            check(integer(length, 12, LIMITS.record), 'Invalid record length');
            const bytes = await logical.read(length), v = view(bytes);
            const record = { id: v.getUint32(0, true), txCount: v.getUint32(4, true), rle: bytes[8] === 1, tx: bytes.slice(12) };
            check(bytes[8] <= 1 && bytes[9] === 0 && bytes[10] === 0 && bytes[11] === 0, 'Unknown record encoding/flags');
            check((members ? members.has(record.id) : record.id >= pack.first && record.id <= pack.last) && !seen.has(record.id), 'Duplicate/out-of-range bitmap');
            // Validate counts/domain without passing incomplete data to Mondrian.
            validateRecord(record); seen.add(record.id); parcels += record.txCount;
            yield record;
        }
        check(seen.size === pack.records && parcels === pack.parcels && await logical.eof(), 'Pack coverage/EOF mismatch');
    } finally { await logical.close(); await wire.close(); }
}
