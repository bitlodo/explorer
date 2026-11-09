import type { ParcelRecord, PackRef, RegionDescriptor } from '../../src/shared/httpPack';
import type { MondrianRect } from '../../src/shared/MondrianLayout';
// Offline only. Never imports server startup/cache processing. Source DB is READ_ONLY.
import fs from 'node:fs/promises';
import path from 'node:path';
import { Database, OPEN_READONLY } from '../duckdb';
import crypto from 'node:crypto';
import {databasePath} from '../db-config.ts';
import { openPublishedMap } from '../published-map.ts';
import { projectRoot, maintenanceRoot, temporaryRoot } from '../paths.ts';
import { validateGrid, validateRoundTrip, validatePayloadBounds } from './export-validation.ts';
import * as codec from '../../src/shared/httpPack.ts';
import MondrianLayout from '../../src/shared/MondrianLayout.ts';
import { databaseNeighborhood, orderedDimensions, type BitmapDimensions } from '../database-neighborhood';
import { reportGenerationProgress } from '../generation-progress';
const root = projectRoot;
const args = process.argv.slice(2);
if (args.length % 2) throw Error('Use --out DIR --regions 0,400|all [--db FILE] [--frame-bytes 131072] [--pack-bytes N] [--format v1|v2] [--validation exact|grid] [--grid-db FILE] [--geometry MAP_DATA]');
const opts = Object.fromEntries(Array.from({ length: args.length / 2 }, (_, i) => [args[i * 2], args[i * 2 + 1]]));
for (const key of Object.keys(opts)) if (!['--out','--regions','--db','--frame-bytes','--pack-bytes','--format','--validation','--grid-db','--geometry'].includes(key)) throw Error('Unknown option ' + key);
if (!opts['--out'] || !opts['--regions']) throw Error('--out and explicit --regions are required');
const dbPath = await fs.realpath(databasePath('DB_BITMAP', opts['--db']));
const gridPath = opts['--grid-db'] ? await fs.realpath(path.resolve(opts['--grid-db'])) : undefined;
const requested = path.resolve(opts['--out']);
const allowed = [maintenanceRoot, temporaryRoot];
function validateOutput(out: string) {
    for (const input of [dbPath, gridPath].filter(Boolean) as string[]) {
        if (input === out || input.startsWith(out + path.sep)) throw Error('Export must preserve source databases');
    }
    if (out === root || root.startsWith(out + path.sep) ||
        (out.startsWith(root + path.sep) && !allowed.some(directory => out.startsWith(directory + path.sep)))) {
        throw Error('Export under .cache/maintenance/, .tmp/ or to a separate directory; preserve existing inputs and databases');
    }
}
validateOutput(requested);
await fs.mkdir(path.dirname(requested), { recursive: true });
const out = path.resolve(await fs.realpath(path.dirname(requested)), path.basename(requested));
validateOutput(out);
const validation = opts['--validation'] || 'exact';
if (!['exact','grid'].includes(validation)) throw Error('Unknown validation mode');
const grouped = opts['--format'] === 'v2';
if (opts['--format'] && !['v1','v2'].includes(opts['--format'])) throw Error('Unknown pack format');
const format = grouped ? codec.GROUP_FORMAT : codec.FORMAT;
const frameBytes = Number(opts['--frame-bytes'] || 131072), target = Number(opts['--pack-bytes'] || (grouped ? 524288 : 1048576));
codec.check(codec.integer(frameBytes, 1, codec.LIMITS.frame) && codec.integer(target, 64, 2 * 1024 * 1024), 'Invalid pack/frame target');
const published = opts['--geometry'] === 'none' ? undefined : await openPublishedMap(opts['--geometry']);
if (published && (out === published.root || out.startsWith(published.root + path.sep) || published.root.startsWith(out + path.sep))) throw Error('Export must be separate from published geometry');
await fs.mkdir(out, { recursive: false }); // Never overwrite an earlier export.
const publishedCount = published?.manifest.regions.length ?? 0;
const digest = (bytes: Uint8Array) => crypto.createHash('sha256').update(bytes).digest('hex');
const input = crypto.createHash('sha256'), sources: { file?: string; hash: string }[] = [];
const json = (object: unknown) => Buffer.from(JSON.stringify(object) + '\n');
let totalBytes = 0, records = 0, parcels = 0, interrupted = false, db, grid;
const stop = () => { interrupted = true; }; process.on('SIGINT', stop); process.on('SIGTERM', stop);
type RegionReport = {id:number;records:number;parcels:number;packs:number;bytes?:number;referencedPackBytes?:number;exactMondrian:boolean;gridDimensions:boolean;canonicalDimensions:string};
const report: Record<string,unknown> & {status:string;regions:RegionReport[];exclusions:{first:number;last:number;reason:string}[];artifactBytes?:number;oversizedBitmaps?:{first:number;last:number;bytes:number}[]} = { format, validation: { mode: validation, exactMondrian: validation === 'exact', transportRoundTrip: true, geometry: validation === 'exact' ? 'reference size and recomputed occupied parcel bounds' : 'READ_ONLY reference size compared to canonical rectangles; parcel area/size bounds checked', ...(gridPath ? { gridDatabase: gridPath } : {}) }, status: 'running', sourceMode: 'READ_ONLY bitmap reference; authenticated published geometry bytes copied; new complete neighborhoods packed from size', geometrySnapshot: published?.manifest.snapshot, deliveryOrder: grouped ? 'regional-cells-8x8-round-robin-mix32-v2-seed-0' : 'spatial-cells-8x8-round-robin-mix32-v1-seed-0', frameBytes, targetPackBytes: target, exclusions: [], regions: [] };
async function artifact(bytes: Uint8Array, extension: string) {
    const hash = digest(bytes), name = `${hash}.${extension}`;
    try { await fs.writeFile(path.join(out,name), bytes, { flag:'wx' }); totalBytes += bytes.length; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !Buffer.from(await fs.readFile(path.join(out,name))).equals(bytes)) throw error; }
    return { url: name, sha256: hash, bytes: bytes.length };
}
function mix(n:number) { n = Math.imul(n ^ (n >>> 16), 0x45d9f3b); n = Math.imul(n ^ (n >>> 16), 0x45d9f3b); return (n ^ (n >>> 16)) >>> 0; }
function distributed(batch:ParcelRecord[], rectangles:MondrianRect[], width:number, height:number) {
    const cells = new Map<string,ParcelRecord[]>();
    for (const record of batch) { const r=rectangles[record.id % 2016], key=`${Math.floor(r.x/width*8)}:${Math.floor(r.y/height*8)}`; const cell=cells.get(key)||[]; cell.push(record); cells.set(key,cell); }
    // Deterministic spatial spread; record IDs restore exact identity after permutation.
    const queues = [...cells.values()].sort((a,b)=>mix(a[0].id)-mix(b[0].id));
    const result=[]; while(queues.length) for(let i=0;i<queues.length;) { const cell=queues[i]; result.push(cell.shift()!); if(!cell.length) queues.splice(i,1); else i++; } return result;
}
try {
    db = await Database.create(dbPath, OPEN_READONLY); await db.exec("SET memory_limit='512MB'; SET threads=2; BEGIN TRANSACTION");
    if (validation === 'grid' && gridPath) { grid = await Database.create(gridPath, OPEN_READONLY); await grid.exec("SET memory_limit='128MB'; SET threads=2; BEGIN TRANSACTION"); }
    const metadata = (await db.all('SELECT min(bitmap) AS first, max(bitmap) AS last, count(*) AS records FROM bitmaps'))[0];
    codec.check(Number(metadata.records) > 0, 'Empty bitmap reference');
    const databaseCount = Math.floor((Number(metadata.last) + 1) / 2016);
    const count = Math.max(publishedCount, databaseCount);
    codec.check(count > 0, 'At least one complete neighborhood is required for generation.');
    codec.check(count <= 10000, 'Neighborhood count exceeds manifest budget');
    if (databaseCount > publishedCount) codec.check(Number(metadata.first) === 0 && Number(metadata.records) === Number(metadata.last) + 1, 'New neighborhoods require a complete bitmap prefix from block 0');
    const selected = opts['--regions'] === 'all' ? Array.from({ length: count }, (_, i) => i) : opts['--regions'].split(',').map(Number);
    codec.check(new Set(selected).size === selected.length && selected.length > 0 && selected.every(id => codec.integer(id, 0, count - 1)), 'Invalid/duplicate region selection');
    selected.sort((a, b) => a - b);
    const chosen = new Set(selected);
    report.database = { path: dbPath, first: Number(metadata.first), last: Number(metadata.last), records: Number(metadata.records) };
    report.selected = selected; report.geometryRegions = count; report.geometryHeight = count * 2016 - 1;
    report.reusedGeometryRegions = publishedCount; report.generatedGeometryRegions = count - publishedCount;
    if (Number(metadata.last) >= count * 2016) report.exclusions.push({ first: count*2016, last: Number(metadata.last), reason: 'Incomplete final neighborhood; retained in source database' });
    const regions=[], regionSources=[], packsByRegion=new Map<number,PackRef[]>(), allPacks:PackRef[]=[];
    let batch:ParcelRecord[]=[], batchBytes=24;
    const locations=new Map<number,string>();
    async function flushGrouped() {
        if(!batch.length) return;
        const cells=new Map<string,ParcelRecord[]>();
        for(const record of batch) { const key=locations.get(record.id)!, cell=cells.get(key)||[]; cell.push(record); cells.set(key,cell); }
        const queues=[...cells.values()].sort((a,b)=>mix(a[0].id)-mix(b[0].id)), ordered=[];
        while(queues.length) for(let i=0;i<queues.length;) {const cell=queues[i];ordered.push(cell.shift()!);if(!cell.length)queues.splice(i,1);else i++;}
        const {wire,descriptor}=await codec.buildGroupedPack(ordered,frameBytes), ref=await artifact(wire,'bin');
        const pack={...descriptor,...ref}; allPacks.push(pack);
        for(let region=Math.floor(pack.first/2016);region<=Math.floor(pack.last/2016);region++) { const packs=packsByRegion.get(region)||[];packs.push(pack);packsByRegion.set(region,packs); }
        batch=[]; batchBytes=24; locations.clear();
    }
    const physicalBytes = (logical:number) => logical + Math.ceil(logical/frameBytes)*8;
    for (let id=0;id<count;id++) {
        if (interrupted) throw Error('Export interrupted; manifest was not published');
        const source = published && id < publishedCount ? published.neighborhood(id) : await databaseNeighborhood(db, id);
        const { bytes, data: decoded } = source;
        codec.check(decoded.neighborhood===id && decoded.bitmaps.length===2016, `Invalid geometry ${id}`);
        for (const r of decoded.bitmaps) codec.check(r.width>0 && r.height>0 && r.x>=0 && r.y>=0 && r.x+r.width<=decoded.width && r.y+r.height<=decoded.height, 'Invalid source rectangle');
        sources.push({ ...('file' in source ? { file: source.file } : {}), hash: digest(bytes) });
        const geometry=await artifact(bytes,'pb'), packs:PackRef[]=[];
        reportGenerationProgress({ kind: 'neighborhood', phase: 'Neighborhood geometry', id, completed: id + 1, total: count,
            action: id < publishedCount ? 'reused' : 'created' });
        regionSources.push({id,width:decoded.width,height:decoded.height,geometry});
        if(chosen.has(id)) {
            const start=id*2016, end=start+2016;
            const rows=await db.all<BitmapDimensions & {tx:number[]}>('SELECT bitmap, tx, size FROM bitmaps WHERE bitmap >= ? AND bitmap < ? ORDER BY bitmap',start,end);
            codec.check(rows.length===2016,'Missing source bitmaps');
            const sizes = orderedDimensions(rows, id);
            validateGrid(sizes.map(([width, height], index) => ({ bitmap: start + index, width, height })), id, decoded.bitmaps);
            if (grid) validateGrid(await grid.all<{bitmap:number;width:number;height:number}>('SELECT bitmap,width,height FROM bitmaps WHERE bitmap >= ? AND bitmap < ? ORDER BY bitmap', start, end), id, decoded.bitmaps);
            let legacyBatch:ParcelRecord[]=[], legacyBytes=24, regionParcels=0;
            if(grouped && batch.length && batch[batch.length-1].id + 1 !== start) await flushGrouped();
            async function flush() {
                if(!legacyBatch.length) return;
                const {wire,descriptor}=await codec.buildPack(distributed(legacyBatch,decoded.bitmaps,decoded.width,decoded.height),id,packs.length,frameBytes);
                const ref=await artifact(wire,'bin'); packs.push({...descriptor,...ref}); legacyBatch=[]; legacyBytes=24;
            }
            for(let i=0;i<rows.length;i++) {
                if(interrupted) throw Error('Export interrupted; manifest was not published');
                const {bitmap,tx}=rows[i]; codec.check(bitmap===start+i && Array.isArray(tx),'Non-contiguous/invalid source');
                if (validation === 'exact') {
                    const a=new MondrianLayout(tx);
                    let occupiedWidth=0, occupiedHeight=0;
                    for(const r of a.slots) { occupiedWidth=Math.max(occupiedWidth,r.x+r.width); occupiedHeight=Math.max(occupiedHeight,r.y+r.height); }
                    codec.check(occupiedWidth===decoded.bitmaps[i].width && occupiedHeight===decoded.bitmaps[i].height,`Canonical occupied dimensions differ at bitmap ${bitmap}`);
                }
                const record=codec.encodeSizes(bitmap,tx);
                validateRoundTrip(record,tx,codec.decodeSizes);
                validatePayloadBounds(tx,decoded.bitmaps[i],bitmap);
                if(grouped) {
                    if(batch.length && (physicalBytes(batchBytes+16+record.tx.length)>target || batch.length>=65536)) await flushGrouped();
                    batch.push(record); batchBytes+=16+record.tx.length;
                    const r=decoded.bitmaps[i]; locations.set(bitmap,`${id}:${Math.floor(r.x/decoded.width*8)}:${Math.floor(r.y/decoded.height*8)}`);
                } else {
                    if(legacyBatch.length && legacyBytes+16+record.tx.length>target) await flush();
                    legacyBatch.push(record); legacyBytes+=16+record.tx.length;
                }
                const h=Buffer.alloc(8); h.writeUInt32LE(bitmap,0); h.writeUInt32LE(tx.length,4); input.update(h); input.update(Buffer.from(tx));
                records++; parcels+=tx.length; regionParcels+=tx.length;
            }
            if(!grouped) { await flush(); packsByRegion.set(id,packs); allPacks.push(...packs); }
            report.regions.push({id,records:rows.length,parcels:regionParcels,packs:packs.length,bytes:packs.reduce((s,p)=>s+p.bytes,0),exactMondrian:validation === 'exact',gridDimensions:validation === 'grid',canonicalDimensions:'occupied bounding box; initial bin width may include unused right margin'});
            reportGenerationProgress({ kind: 'neighborhood', phase: 'Database transactions', id, completed: report.regions.length, total: selected.length, action: 'processed' });
            console.log(JSON.stringify({stage:'region',id,records,parcels,bytes:totalBytes}));
        }
    }
    if(grouped) await flushGrouped();
    for(const {id,width,height,geometry} of regionSources) {
        const packs=packsByRegion.get(id)||[];
        const descriptorData:RegionDescriptor={format,id,geometry,coverage:chosen.has(id)?'complete':'geometry-only',packs};
        codec.validateRegionPacks(descriptorData,format);
        const descriptor=await artifact(json(descriptorData),'json');
        regions.push({id,width,height,descriptor});
    }
    if(grouped) for(const region of report.regions) {
        const packs=packsByRegion.get(region.id)||[]; region.packs=packs.length;
        region.referencedPackBytes=packs.reduce((sum,p)=>sum+p.bytes,0); delete region.bytes;
    }
    report.packCount=allPacks.length;
    report.packBytes=allPacks.reduce((sum,p)=>sum+p.bytes,0);
    report.packs=allPacks.map(({first,last,records,parcels,bytes,sha256})=>({first,last,records,parcels,bytes,sha256}));
    report.sharedPacks=allPacks.filter(p=>Math.floor(p.first/2016)!==Math.floor(p.last/2016)).length;
    report.oversizedBitmaps=allPacks.filter(p=>p.bytes>target).map(p=>({first:p.first,last:p.last,bytes:p.bytes}));
    codec.check(!grouped || !report.oversizedBitmaps.some(p=>p.first!==p.last), 'Pack target exceeded by multiple bitmaps');
    for(const source of sources) if (source.file) codec.check(digest(await fs.readFile(source.file))===source.hash,'Geometry changed during export');
    published?.assertUnchanged();
    report.inputSha256=input.digest('hex'); report.geometrySha256=digest(json(sources.map(s=>s.hash)));
    const body={format,layout:codec.LAYOUT,publishedHeight:count*2016-1,parcelRegions:selected,regions};
    const manifest={...body,snapshot:digest(json(body))};
    report.records=records; report.parcels=parcels; report.sample=selected.length!==count; report.snapshot=manifest.snapshot;
    report.artifactBytes=totalBytes+json(manifest).length; codec.check(report.artifactBytes<1_000_000_000,'Data alone exceeds Pages budget');
    report.status='passed';
    // Atomic root publication only after all referenced immutable files and comparisons pass.
    await fs.writeFile(path.join(out,'report.json'),json(report),{flag:'wx'});
    await fs.writeFile(path.join(out,'manifest.json.tmp'),json(manifest),{flag:'wx'}); await fs.rename(path.join(out,'manifest.json.tmp'),path.join(out,'manifest.json'));
    console.log(JSON.stringify({stage:'complete',...report}));
} catch(error) { report.status=interrupted?'interrupted':'failed'; report.error=String(error instanceof Error ? error.message : error); await fs.writeFile(path.join(out,'failure-report.json'),json(report)); console.error(error instanceof Error ? error.message : error); process.exitCode=interrupted?130:1; }
finally { if(grid) { await grid.exec('ROLLBACK').catch(()=>{}); await grid.close(); } if(db) { await db.exec('ROLLBACK').catch(()=>{}); await db.close(); } process.removeListener('SIGINT',stop); process.removeListener('SIGTERM',stop); }
