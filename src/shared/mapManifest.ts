import protobuf from 'protobufjs';
import { createProtoCodec, type ProtoManifest } from './protobufChunks';
import { check, HUFFMAN_FORMAT, sha256 } from './httpPack';
import { DATA_STORAGE } from './dataStorage';

export const JSON_MANIFEST_ENCODING = 'bitmap-manifest-json-v1';
export const JSON_MANIFEST_LIMIT = 1024 * 1024;
const codec = createProtoCodec(protobuf);
const encoder = new TextEncoder();
/** JSON domain: sorted object keys, ordered arrays, finite numbers, no undefined. */
export function canonicalJson(value: unknown): string {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
    if (typeof value === 'number') { check(Number.isFinite(value), 'Non-finite JSON number'); return JSON.stringify(value); }
    if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
    check(typeof value === 'object' && value !== null, 'Invalid canonical JSON value');
    const object = value as Record<string, unknown>;
    return '{' + Object.keys(object).sort().map(key => JSON.stringify(key) + ':' + canonicalJson(object[key])).join(',') + '}';
}
function body(m: ProtoManifest) {
    const value = { manifestEncoding: JSON_MANIFEST_ENCODING, format: m.format, storageLayout: m.storageLayout,
        layout: m.layout, publishedHeight: m.publishedHeight,
        grid: m.grid, packBytes: m.packBytes, frameBytes: m.frameBytes, shuffleSeed: m.shuffleSeed,
        regions: m.regions.map(({ descriptor: _, ...region }) => region), chunks: m.chunks,
        parcelRegions: m.parcelRegions, indexPages: m.indexPages, indexPageSide: m.indexPageSide };
    return Object.fromEntries(Object.entries(value).filter(([,value])=>value!==undefined));
}
export async function encodeJsonManifest(m: ProtoManifest): Promise<Uint8Array> {
    check(m.format === HUFFMAN_FORMAT && m.storageLayout === DATA_STORAGE, 'JSON manifest requires current paged storage');
    const wireSnapshot=await sha256(codec.encodeManifest(m,false));
    const normalized=await codec.decodeManifest(codec.encodeManifest({...m,snapshot:wireSnapshot}));
    const unsigned = body(normalized), snapshot = await sha256(encoder.encode(canonicalJson(unsigned)));
    const bytes = encoder.encode(JSON.stringify({ ...unsigned, snapshot }, null, 2) + '\n');
    check(bytes.length <= JSON_MANIFEST_LIMIT, 'JSON manifest exceeds metadata budget');
    return bytes;
}
export async function decodeMapManifest(bytes: Uint8Array, entry: 'manifest.pb' | 'manifest.json'): Promise<ProtoManifest> {
    if (entry === 'manifest.pb') return codec.decodeManifest(bytes);
    check(bytes.length <= JSON_MANIFEST_LIMIT, 'JSON manifest exceeds metadata budget');
    const raw = JSON.parse(new TextDecoder().decode(bytes));
    // Legacy JSON v1-v3 remains subject to its existing source/publication validation.
    if (!raw.manifestEncoding) { check(!raw.format?.startsWith('bitmap-http-protobuf-'), 'Missing JSON manifest encoding'); return raw; }
    check(raw.manifestEncoding === JSON_MANIFEST_ENCODING && raw.format === HUFFMAN_FORMAT && raw.storageLayout === DATA_STORAGE, 'Unsupported JSON manifest contract');
    const { snapshot, ...unsigned } = raw;
    check(await sha256(encoder.encode(canonicalJson(unsigned))) === snapshot, 'JSON manifest revision mismatch');
    // Reuse all existing coverage, identity, dimensions, page and budget checks.
    const candidate = { ...raw, regions: raw.regions.map((r: ProtoManifest['regions'][number]) => ({ ...r, descriptor: r.geometry })) };
    const wireSnapshot = await sha256(codec.encodeManifest(candidate, false));
    const validated = await codec.decodeManifest(codec.encodeManifest({ ...candidate, snapshot: wireSnapshot }));
    check(canonicalJson(body(validated)) === canonicalJson(unsigned), 'Non-canonical JSON manifest fields or references');
    return { ...validated, snapshot };
}
