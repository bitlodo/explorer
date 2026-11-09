import { DATA_STORAGE, DIRECTORY_STORAGE, dataPath, type DataKind } from './dataStorage';
import DelimitedQueue from './DelimitedQueue';
import schema from './proto/map_snapshot_descriptor.json';
import { DIMENSION_BYTES } from './neighborhoodDimensions';
import { HUFFMAN_FORMAT, isPagedFormat, recordEncoding, PAGED_FORMAT, DIMENSIONS_FORMAT, SHUFFLE_FORMAT, CHAIN_FORMAT, PROTO_FORMAT, LIMITS, ByteReader, check, integer, sha256, validatePack, validateRecord, type Manifest, type Region, type FileRef, type PackRef, type ParcelRecord } from './httpPack';
export { HUFFMAN_FORMAT, PAGED_FORMAT, DIMENSIONS_FORMAT, SHUFFLE_FORMAT, CHAIN_FORMAT, PROTO_FORMAT };
export const PROTO_MANIFEST_BYTES = 4 * 1024 * 1024;
export type ProtoRegion = Region & { geometry: FileRef; dimensions?: FileRef; coverage: 'complete' | 'geometry-only'; x: number; y: number };
export type ProtoChunk = { x: number; y: number; records: number; lastHeight: number; recordDigest: string; packs: PackRef[] };
export const INDEX_PAGE_BYTES = 256 * 1024;
export const PAGED_MANIFEST_BYTES = 256 * 1024;
export type IndexPageRef = FileRef & { x: number; y: number; records: number; chunks: number };
export type ProtoManifest = Omit<Manifest, 'regions'> & { storageLayout?: string; regions: ProtoRegion[]; chunks: ProtoChunk[]; packBytes: number; frameBytes?: number; parcelRegions: number[]; shuffleSeed?: number; indexPages?: IndexPageRef[]; indexPageSide?: number };
const HEX=Array.from({length:256},(_,n)=>n.toString(16).padStart(2,'0'));
const hex=(b:Uint8Array)=>{let s='';for(const n of b)s+=HEX[n];return s;};
const binaryHash = (s: string) => { check(/^[a-f0-9]{64}$/.test(s), 'Invalid SHA-256'); return Uint8Array.from(s.match(/../g)!, n => parseInt(n, 16)); };
const concatenate = (parts: Uint8Array[]) => { const b = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { b.set(p, o); o += p.length; } return b; };

/** Inject the app's protobufjs runtime, also usable by Bun/Node without another installation. */
export function createProtoCodec(protobuf: any,hashFrame:(bytes:Uint8Array)=>string|Promise<string>=sha256) {
    const root = protobuf.Root.fromJSON(schema);
    const type = (name: string) => root.lookupType(`bitmap.snapshot.${name}`);
    const IndexPageType = type('IndexPage');
    const ManifestType = type('Manifest'), Header = type('PackHeader'), Bitmap = type('Bitmap'), Frame = type('Frame');
    const object = (t: any, bytes: Uint8Array) => t.toObject(t.decode(bytes), { defaults: true, arrays: true, longs: Number });
    const fileWire = (r: FileRef) => ({ sha256: binaryHash(r.sha256), bytes: r.bytes });
    const fileRef = (r: any, storage?: string, kind: DataKind = 'parcels'): FileRef => { const hash = hex(r.sha256); check(/^[a-f0-9]{64}$/.test(hash) && integer(r.bytes, 1, LIMITS.pack), 'Invalid protobuf file reference'); return { url: dataPath(storage, kind, `${hash}.pb`), sha256: hash, bytes: r.bytes }; };
    const encodeRecord = (record: ParcelRecord, huffman = false): Uint8Array => {
        validateRecord(record);
        check(huffman || recordEncoding(record) <= 1, 'Huffman requires a v9 pack');
        const bytes = Bitmap.encodeDelimited({ id: record.id, txCount: record.txCount, encoding: recordEncoding(record), tx: record.tx }).finish();
        check(bytes.length <= LIMITS.record, 'Protobuf record exceeds memory limit'); return bytes;
    };
    const chunksWire = (chunks: ProtoChunk[]) => chunks.map(c => ({ x: c.x, y: c.y, records: c.records, lastHeight: c.lastHeight, recordDigest: binaryHash(c.recordDigest),
                packs: c.packs.map(p => ({ file: fileWire(p), first: p.first, last: p.last, records: p.records, parcels: p.parcels, frames: p.frames.map(f => ({ bytes: f.bytes, sha256: binaryHash(f.sha256) })), ...(p.ids ? {idDeltas:p.ids.map((id,i)=>i?id-p.ids![i-1]:id)}:{}), ...(p.headSha256 ? { headSha256: binaryHash(p.headSha256), frameCount: p.frameCount } : {}) })) }));
    function encodeManifest(m: ProtoManifest, includeSnapshot = true): Uint8Array {
        const paged = isPagedFormat(m.format), dimensions = paged || m.format === DIMENSIONS_FORMAT;
        const value = { ...(m.storageLayout ? { storageLayout: m.storageLayout } : {}), version: m.format === HUFFMAN_FORMAT ? 9 : paged ? 8 : dimensions ? 7 : m.format === SHUFFLE_FORMAT ? 6 : m.format === CHAIN_FORMAT ? 5 : 4, layout: m.layout, publishedHeight: m.publishedHeight, chunkSize: m.grid!.size, packBytes: m.packBytes,
            regions: m.regions.map(r => ({ id: r.id, width: r.width, height: r.height, geometry: fileWire(r.geometry), complete: r.coverage === 'complete', x: r.x, y: r.y, ...(dimensions ? { dimensions: fileWire(r.dimensions!) } : {}) })),
            chunks: chunksWire(m.chunks),
            ...(m.frameBytes ? { frameBytes: m.frameBytes } : {}),
            ...(m.format===SHUFFLE_FORMAT||dimensions?{shuffleSeed:m.shuffleSeed}:{}),
            ...(paged ? { indexPageSide: m.indexPageSide, indexPages: m.indexPages!.map(p => ({ x: p.x, y: p.y, file: fileWire(p), records: p.records, chunks: p.chunks })) } : {}),
            ...(includeSnapshot && m.snapshot ? { snapshot: binaryHash(m.snapshot) } : {}) };
        return ManifestType.encode(value).finish();
    }
    function decodeChunks(rawChunks: any[], regions: ProtoRegion[], publishedHeight: number, version: number, storage?: string) {
        const shuffled = version >= 6;
        const members=shuffled?new Uint8Array(Math.ceil((publishedHeight+1)/8)):undefined;
        const keys = new Set<string>(); let records = 0;
        const chunks: ProtoChunk[] = rawChunks.map((c: any) => {
            const key = `${c.x},${c.y}`;
            check(integer(c.x, -0x80000000, 0x7fffffff) && integer(c.y, -0x80000000, 0x7fffffff) && !keys.has(key) && integer(c.records, 1, publishedHeight + 1), 'Invalid/duplicate protobuf chunk'); keys.add(key);
            let last = -1, count = 0;
            const packs = c.packs.map((p: any): PackRef => {
                let id=0;
                const ids=shuffled?p.idDeltas.map((delta:number,i:number)=>{
                    check(integer(delta,i?1:0,publishedHeight),'Invalid shuffled membership delta');
                    id+=delta;check(id<=publishedHeight&&regions[Math.floor(id/2016)].coverage==='complete','Out-of-snapshot shuffled bitmap');
                    const bit=1<<(id&7);check(!(members![id>>>3]&bit),'Duplicate shuffled bitmap coverage');members![id>>>3]|=bit;return id;
                }):undefined;
                check(shuffled||p.idDeltas.length===0,'Unexpected shuffled membership');
                const pack = { ...fileRef(p.file, storage), format: version === 9 ? HUFFMAN_FORMAT : shuffled?SHUFFLE_FORMAT:version === 5 ? CHAIN_FORMAT : PROTO_FORMAT, chunkX: c.x, chunkY: c.y, first: p.first, last: p.last, records: p.records, parcels: p.parcels,
                    frames: p.frames.map((f: any) => ({ bytes: f.bytes, sha256: hex(f.sha256) })), ...(ids?{ids}:{}), ...(version >= 5 ? { headSha256: hex(p.headSha256), frameCount: p.frameCount } : {}) };
                validatePack(pack); check((shuffled||pack.first > last) && pack.last <= publishedHeight, 'Unordered/out-of-snapshot protobuf pack'); last = Math.max(last,pack.last); count += pack.records;
                return pack;
            });
            check(count === c.records && last === c.lastHeight && c.recordDigest.length === 32, 'Invalid protobuf chunk totals'); records += count;
            return { x: c.x, y: c.y, records: c.records, lastHeight: c.lastHeight, recordDigest: hex(c.recordDigest), packs };
        });
        return { chunks, records };
    }
    async function decodeManifest(bytes: Uint8Array): Promise<ProtoManifest> {
        check(bytes.length <= PROTO_MANIFEST_BYTES, 'Protobuf manifest exceeds metadata budget');
        const raw = object(ManifestType, bytes);
        check(!raw.storageLayout || (raw.version === 9 && (raw.storageLayout === DATA_STORAGE || raw.storageLayout === DIRECTORY_STORAGE)), 'Unsupported map data storage layout');
        const storage = raw.storageLayout || undefined;
        check((raw.version === 4 || raw.version === 5 || raw.version === 6 || raw.version === 7 || raw.version === 8 || raw.version === 9) && typeof raw.layout === 'string' && raw.layout.length > 0 && raw.layout.length <= 128, 'Incompatible protobuf manifest');
        check(!raw.frameBytes || integer(raw.frameBytes, 1, LIMITS.frame), 'Invalid protobuf frame budget');
        check(integer(raw.chunkSize, 1, 0x7fffffff) && integer(raw.packBytes, 128, LIMITS.pack) && raw.regions.length > 0 && raw.regions.length <= 10000 && raw.chunks.length <= 50000, 'Invalid protobuf manifest dimensions');
        const regions: ProtoRegion[] = raw.regions.map((r: any, i: number) => {
            check(r.id === i && integer(r.width, 1, 0x7fffffff) && integer(r.height, 1, 0x7fffffff) && Number.isFinite(r.x) && Number.isFinite(r.y), 'Invalid protobuf region');
            const geometry = fileRef(r.geometry, storage, 'geometry'); check(geometry.bytes <= LIMITS.metadata, 'Geometry exceeds metadata budget');
            // descriptor is a compatibility alias in memory only; no descriptor file exists in v4.
            check(raw.version >= 7 || !r.dimensions, 'Unexpected rectangle dimensions');
            check(raw.version < 7 || r.dimensions, 'Missing neighborhood dimensions');
            const dimensions = raw.version >= 7 ? fileRef(r.dimensions, storage, 'dimensions') : undefined;
            if (dimensions) check(dimensions.bytes <= DIMENSION_BYTES, 'Rectangle dimensions exceed budget');
            return { id: r.id, width: r.width, height: r.height, x: r.x, y: r.y, geometry, descriptor: geometry, ...(dimensions ? { dimensions } : {}), coverage: r.complete ? 'complete' : 'geometry-only' };
        });
        check(raw.publishedHeight === regions.length * 2016 - 1, 'Invalid protobuf published height');
        const shuffled=raw.version>=6;
        check(shuffled?integer(raw.shuffleSeed,0,0xffffffff):raw.shuffleSeed===0,'Invalid shuffle seed/version');
        const { chunks, records } = decodeChunks(raw.chunks, regions, raw.publishedHeight, raw.version, storage);
        const indexPages: IndexPageRef[] = [];
        if (raw.version >= 8) {
            check(bytes.length <= PAGED_MANIFEST_BYTES && raw.chunks.length === 0 && raw.indexPageSide === 8 && raw.indexPages.length > 0 && raw.indexPages.length <= 4096, 'Invalid paged overview');
            const keys = new Set<string>();
            for (const p of raw.indexPages) {
                const key = `${p.x},${p.y}`, ref = fileRef(p.file, storage, 'parcel-index');
                check(integer(p.x, -0x80000000, 0x7fffffff) && integer(p.y, -0x80000000, 0x7fffffff) && !keys.has(key) && ref.bytes <= INDEX_PAGE_BYTES && integer(p.records, 1, raw.publishedHeight + 1) && integer(p.chunks, 1, 64), 'Invalid/duplicate spatial index page');
                keys.add(key); indexPages.push({ ...ref, x: p.x, y: p.y, records: p.records, chunks: p.chunks });
            }
        } else check(!raw.indexPages.length && !raw.indexPageSide, 'Unexpected spatial pages');
        const parcelRegions = regions.filter(r => r.coverage === 'complete').map(r => r.id);
        check((raw.version >= 8 ? indexPages.reduce((sum, p) => sum + p.records, 0) : records) === parcelRegions.length * 2016, 'Missing protobuf bitmap coverage');
        const m: ProtoManifest = { ...(storage ? { storageLayout: storage } : {}), format: raw.version === 9 ? HUFFMAN_FORMAT : raw.version === 8 ? PAGED_FORMAT : raw.version === 7 ? DIMENSIONS_FORMAT : shuffled?SHUFFLE_FORMAT:raw.version === 5 ? CHAIN_FORMAT : PROTO_FORMAT, ...(raw.version >= 8 ? { indexPages, indexPageSide: raw.indexPageSide } : {}), layout: raw.layout, publishedHeight: raw.publishedHeight, snapshot: hex(raw.snapshot),
            grid: { size: raw.chunkSize, originX: 0, originY: 0, ownership: 'top-left' }, packBytes: raw.packBytes, ...(raw.frameBytes ? { frameBytes: raw.frameBytes } : {}), regions, chunks, parcelRegions, ...(shuffled?{shuffleSeed:raw.shuffleSeed}:{}) };
        check(await sha256(encodeManifest(m, false)) === m.snapshot, 'Protobuf manifest revision mismatch');
        return m;
    }
    function encodeIndexPage(chunks: ProtoChunk[], x: number, y: number, manifest: ProtoManifest): Uint8Array {
        return IndexPageType.encode({ version: manifest.format === HUFFMAN_FORMAT ? 10 : 8, x, y, side: manifest.indexPageSide, publishedHeight: manifest.format === HUFFMAN_FORMAT ? Math.max(...chunks.map(c=>c.lastHeight)) : manifest.publishedHeight, chunks: chunksWire(chunks) }).finish();
    }
    function decodeIndexPage(bytes: Uint8Array, ref: IndexPageRef, manifest: ProtoManifest): ProtoChunk[] {
        check(isPagedFormat(manifest.format) && bytes.length === ref.bytes && bytes.length <= INDEX_PAGE_BYTES, 'Invalid spatial index bytes');
        const raw = object(IndexPageType, bytes);
        check((manifest.format === HUFFMAN_FORMAT ? raw.version===9||raw.version===10 : raw.version===8) && raw.x === ref.x && raw.y === ref.y && raw.side === manifest.indexPageSide && (raw.version===10 ? raw.publishedHeight<=manifest.publishedHeight&&raw.publishedHeight===Math.max(...raw.chunks.map((c:any)=>c.lastHeight)) : raw.publishedHeight===manifest.publishedHeight) && raw.chunks.length === ref.chunks, 'Spatial index identity mismatch');
        const { chunks, records } = decodeChunks(raw.chunks, manifest.regions, manifest.publishedHeight, raw.version===10?9:raw.version, manifest.storageLayout);
        check(records === ref.records && chunks.every(c => Math.floor(c.x / raw.side) === ref.x && Math.floor(c.y / raw.side) === ref.y), 'Spatial index coverage/owner mismatch');
        return chunks;
    }
    async function buildPack(records: ParcelRecord[], x: number, y: number, frameBytes = 16384) {
        check(records.length > 0 && records.length <= 65536 && integer(frameBytes, 1, LIMITS.frame), 'Invalid protobuf pack/frame size');
        let previous = -1;
        for (const record of records) { check(record.id > previous, 'Protobuf records must have strictly increasing IDs'); previous = record.id; }
        const first = records[0].id, last = records[records.length - 1].id;
        const parts: Uint8Array[] = [Header.encodeDelimited({ version: 4, chunkX: x, chunkY: y, records: records.length, first, last }).finish()];
        let length = parts[0].length;
        for (const record of records) {
            const bytes = encodeRecord(record); length += bytes.length;
            check(length + Math.ceil(length / frameBytes) * 32 <= LIMITS.pack, 'Protobuf pack exceeds memory limit'); parts.push(bytes);
        }
        const logical = concatenate(parts);
        const frames: Uint8Array[] = [], metadata: PackRef['frames'] = [];
        for (let offset = 0; offset < logical.length; offset += frameBytes) {
            const wire = Frame.encodeDelimited({ index: frames.length, payload: logical.subarray(offset, offset + frameBytes) }).finish();
            metadata.push({ bytes: wire.length, sha256: await sha256(wire) }); frames.push(wire);
        }
        const wire = concatenate(frames);
        const descriptor: PackRef = { format: PROTO_FORMAT, chunkX: x, chunkY: y, first, last, records: records.length, parcels: records.reduce((s, r) => s + r.txCount, 0), frames: metadata, bytes: wire.length, sha256: await sha256(wire), url: '' };
        validatePack(descriptor); return { wire, descriptor };
    }
    async function delimited(reader: ByteReader, limit: number): Promise<Uint8Array> {
        let length = 0, factor = 1;
        for (let i = 0; i < 5; i++) {
            const byte = (await reader.read(1))[0]; length += (byte & 127) * factor;
            if (!(byte & 128)) { check(integer(length, 1, limit), 'Invalid protobuf message length'); return reader.read(length); }
            factor *= 128;
        }
        throw new Error('Invalid protobuf length varint');
    }
    async function* parsePack(chunks: AsyncIterable<Uint8Array>, pack: PackRef, onFrame?: (hash: string, frame: Uint8Array) => void|Promise<void>, yieldControl?:()=>Promise<void>,acceptRecord?:(record:ParcelRecord)=>boolean): AsyncGenerator<ParcelRecord> {
        if (pack.format === CHAIN_FORMAT || pack.format === SHUFFLE_FORMAT || pack.format === HUFFMAN_FORMAT) { yield* parseChainedPack(chunks, pack, onFrame,yieldControl,acceptRecord); return; }
        validatePack(pack); check(pack.format === PROTO_FORMAT, 'Wrong protobuf format');
        const wire = new ByteReader(chunks);
        const verified = async function* () {
            for (let i = 0; i < pack.frames.length; i++) {
                const expected = pack.frames[i], bytes = await wire.read(expected.bytes);
                check(await sha256(bytes) === expected.sha256, 'Corrupt protobuf frame');
                async function* single() { yield bytes; }
                const message = new ByteReader(single());
                try {
                    const f = object(Frame, await delimited(message, LIMITS.frame + 24));
                    check(await message.eof() && f.index === i && f.payload.length > 0 && f.payload.length <= LIMITS.frame, 'Invalid protobuf frame identity/length');
                    await onFrame?.(expected.sha256, bytes); yield f.payload;
                } finally { await message.close(); }
            }
            check(await wire.eof(), 'Unexpected trailing protobuf bytes');
        };
        const logical = new ByteReader(verified());
        try {
            const header = object(Header, await delimited(logical, 128));
            check(header.version === 4 && header.chunkX === pack.chunkX && header.chunkY === pack.chunkY && header.records === pack.records && header.first === pack.first && header.last === pack.last, 'Protobuf pack identity mismatch');
            let last = -1, parcels = 0;
            for (let i = 0; i < pack.records; i++) {
                const value = object(Bitmap, await delimited(logical, LIMITS.record));
                const record = { id: value.id, txCount: value.txCount, rle: value.encoding === 1, tx: new Uint8Array(value.tx) };
                check(value.encoding <= 1 && record.id > last && record.id >= pack.first && record.id <= pack.last && (i > 0 || record.id === pack.first), 'Invalid protobuf bitmap identity/encoding');
                validateRecord(record); last = record.id; parcels += record.txCount; yield record;
            }
            check(last === pack.last && parcels === pack.parcels && await logical.eof(), 'Protobuf coverage/EOF mismatch');
        } finally { await logical.close(); await wire.close(); }
    }
    /** One record per authenticated frame; large records fragment, small ones never wait for a byte threshold. */
    async function buildChainedPack(records: ParcelRecord[], x: number, y: number, frameBytes = 16384, version:5|6|9 = 5) {
        check(records.length > 0 && records.length <= 65536 && integer(frameBytes, 1, LIMITS.frame) && (version===5||version===6||version===9), 'Invalid chained pack/frame size');
        const ids=records.map(r=>r.id).sort((a,b)=>a-b);
        check(new Set(ids).size===records.length,'Duplicate protobuf bitmap');
        if(version===5)records.forEach((r,i)=>check(!i||r.id>records[i-1].id,'Protobuf records must have strictly increasing IDs'));
        const first=ids[0],last=ids[ids.length-1];
        const payloads: Uint8Array[] = [];
        let total = 0;
        const addMessage = (message: Uint8Array) => {
            for (let offset = 0; offset < message.length; offset += frameBytes) {
                const payload = message.subarray(offset, offset + frameBytes); total += payload.length + 64;
                check(total <= LIMITS.pack, 'Chained protobuf pack exceeds memory limit'); payloads.push(payload);
            }
        };
        addMessage(Header.encodeDelimited({ version, chunkX: x, chunkY: y, records: records.length, first, last }).finish());
        for (const record of records) addMessage(encodeRecord(record, version === 9));
        const frames = new Array<Uint8Array>(payloads.length); let next = new Uint8Array(0), hash = '';
        for (let index = payloads.length - 1; index >= 0; index--) {
            frames[index] = Frame.encodeDelimited({ index, payload: payloads[index], ...(next.length ? { nextSha256: next } : {}) }).finish();
            hash = await sha256(frames[index]); next = binaryHash(hash);
        }
        const wire = concatenate(frames);
        const descriptor: PackRef = { format: version===9?HUFFMAN_FORMAT:version===6?SHUFFLE_FORMAT:CHAIN_FORMAT, ...(version>=6?{ids}:{}), chunkX: x, chunkY: y, first, last, records: records.length, parcels: records.reduce((n, r) => n + r.txCount, 0),
            headSha256: hash, frameCount: frames.length, frames: [], bytes: wire.length, sha256: await sha256(wire), url: '' };
        validatePack(descriptor); return { wire, descriptor };
    }
    function inspectChainFrame(bytes: Uint8Array) {
        const reader = protobuf.Reader.create(bytes), frame = Frame.decodeDelimited(reader);
        check(reader.pos === bytes.length, 'Trailing chained frame bytes');
        return { index: frame.index as number, payload: frame.payload as Uint8Array, next: hex(frame.nextSha256) };
    }
    async function* parseChainedPack(chunks:AsyncIterable<Uint8Array>,pack:PackRef,onFrame?:(hash:string,frame:Uint8Array)=>void|Promise<void>,yieldControl?:()=>Promise<void>,acceptRecord?:(record:ParcelRecord)=>boolean):AsyncGenerator<ParcelRecord>{
        validatePack(pack);
        const wire=new DelimitedQueue(),logical=new DelimitedQueue(),shuffled=pack.format===SHUFFLE_FORMAT||pack.format===HUFFMAN_FORMAT;
        const remaining=shuffled?new Set(pack.ids):undefined;
        let expected=pack.headSha256!,received=0,frames=0,header=false,records=0,last=-1,parcels=0;
        for await(const chunk of chunks){
            received+=chunk.length;check(received<=pack.bytes,'Unexpected trailing chained bytes');wire.append(chunk);
            let frame:Uint8Array|undefined;
            while((frame=wire.next(LIMITS.frame+64))!==undefined){
                check(frames<pack.frameCount!,'Unexpected trailing chained frame');
                if(frames&&frames%128===0)await yieldControl?.();
                const hash=hashFrame(frame);check((typeof hash==='string'?hash:await hash)===expected,'Corrupt chained protobuf frame');
                const info=inspectChainFrame(frame);
                check(info.index===frames&&info.payload.length>0&&info.payload.length<=LIMITS.frame&&(frames+1===pack.frameCount?info.next==='':/^[a-f0-9]{64}$/.test(info.next)),'Invalid chained frame identity/link');
                const stored=onFrame?.(expected,frame);if(stored)await stored;
                expected=info.next;frames++;logical.append(info.payload);
                let message:Uint8Array|undefined;
                while((message=logical.next(header?LIMITS.record:128))!==undefined){
                    if(!header){
                        const reader=protobuf.Reader.create(message),h=Header.decodeDelimited(reader);
                        check(reader.pos===message.length&&h.version===(pack.format===HUFFMAN_FORMAT?9:shuffled?6:5)&&h.chunkX===pack.chunkX&&h.chunkY===pack.chunkY&&h.records===pack.records&&h.first===pack.first&&h.last===pack.last,'Chained pack identity mismatch');header=true;continue;
                    }
                    check(records<pack.records,'Unexpected trailing chained bitmap');
                    const reader=protobuf.Reader.create(message),v=Bitmap.decodeDelimited(reader);
                    const record={id:v.id as number,txCount:v.txCount as number,rle:v.encoding===1,tx:new Uint8Array(v.tx),...(v.encoding===4?{encoding:4 as const}:{})};
                    check(reader.pos===message.length&&(v.encoding<=1||(pack.format===HUFFMAN_FORMAT&&v.encoding===4))&&(remaining?remaining.delete(record.id):record.id>last&&record.id>=pack.first&&record.id<=pack.last&&(records>0||record.id===pack.first)),'Invalid chained bitmap identity/encoding');
                    validateRecord(record);last=record.id;parcels+=record.txCount;records++;if(!acceptRecord||acceptRecord(record))yield record;
                }
            }
        }
        check(received===pack.bytes&&frames===pack.frameCount&&wire.length===0&&logical.length===0&&header&&records===pack.records&&(remaining?remaining.size===0:last===pack.last)&&parcels===pack.parcels,'Chained bitmap coverage/EOF mismatch');
    }
    return { encodeManifest, decodeManifest, encodeIndexPage, decodeIndexPage, encodeRecord, buildPack, buildChainedPack, inspectChainFrame, parsePack };
}
