import protobuf from 'protobufjs';
import descriptor from './proto/lod4_descriptor.json';
import { check, integer, sha256 } from './httpPack';

export const LOD4_FORMAT = 'bitmap-lod4-spatial-cells-v1' as const;
export const LOD4_SIDE = 16;
export const LOD4_INDEX_LIMIT = 256 * 1024;
export const LOD4_REGION_LIMIT = 4 * 1024 * 1024;
const UINT32_MAX = 0xffffffff;
const hashValid = (hash: string) => /^[a-f0-9]{64}$/.test(hash);
const root = protobuf.Root.fromJSON(structuredClone(descriptor));
const indexType = root.lookupType('bitmap.lod4.Index'), regionType = root.lookupType('bitmap.lod4.Region');

export type Lod4RegionRef = {
    id: number; width: number; height: number; bitmapCount: number;
    geometrySha256: string; sha256: string; bytes: number;
};
export type Lod4Index = {
    version: 1; format: typeof LOD4_FORMAT; sourceSnapshot: string;
    gridSide: number; bitmapCount: number; regions: Lod4RegionRef[];
};
export type Lod4Region<T extends number[] | Uint32Array = number[]> = {
    version: 1; id: number; width: number; height: number; columns: number; rows: number;
    geometrySha256: string; bitmapAreas: T; cellOffsets: T;
    memberDeltas: T; overlapAreas: T;
};
/** Runtime residency uses four-byte integers; the Protobuf contract is unchanged. */
export function compactLod4Region(region: Lod4Region): Lod4Region<Uint32Array> {
    return { ...region, bitmapAreas: Uint32Array.from(region.bitmapAreas), cellOffsets: Uint32Array.from(region.cellOffsets),
        memberDeltas: Uint32Array.from(region.memberDeltas), overlapAreas: Uint32Array.from(region.overlapAreas) };
}
export type Lod4Shape = {
    neighborhood: number; width: number; height: number;
    bitmaps: { x: number; y: number; width: number; height: number }[];
};
export const lod4RegionPath = (ref: Pick<Lod4RegionRef, 'sha256'>) => {
    check(hashValid(ref.sha256), 'Invalid LOD4 page hash');
    return `regions/${ref.sha256}.pb`;
};

/** Integer boundaries are nested at power-of-two grid resolutions. */
export function lod4CellBounds(region: Pick<Lod4Region, 'width' | 'height' | 'columns' | 'rows'>, cell: number) {
    check(integer(cell, 0, region.columns * region.rows - 1), 'Invalid LOD4 cell');
    const col = cell % region.columns, row = Math.floor(cell / region.columns);
    const x = Math.floor(col * region.width / region.columns), y = Math.floor(row * region.height / region.rows);
    return { x, y, width: Math.floor((col + 1) * region.width / region.columns) - x,
        height: Math.floor((row + 1) * region.height / region.rows) - y };
}

export function validateLod4Region(region: Lod4Region, side = LOD4_SIDE) {
    check(integer(side, 1, LOD4_SIDE) && (side & (side - 1)) === 0, 'Invalid LOD4 grid side');
    check(region.version === 1 && integer(region.id, 0, 520) && hashValid(region.geometrySha256), 'Invalid LOD4 region identity');
    check(integer(region.width, 1, 65535) && integer(region.height, 1, 65535) &&
        region.columns === Math.min(side, region.width) && region.rows === Math.min(side, region.height), 'Invalid LOD4 grid dimensions');
    const count = region.bitmapAreas.length, cells = region.columns * region.rows, entries = region.memberDeltas.length;
    check(integer(count, 1, 2016) && entries <= count * cells && entries === region.overlapAreas.length, 'Invalid LOD4 membership budget');
    check(region.bitmapAreas.every(area => integer(area, 1, region.width * region.height)), 'Invalid LOD4 bitmap area');
    check(region.cellOffsets.length === cells + 1 && region.cellOffsets[0] === 0 && region.cellOffsets[cells] === entries, 'Invalid LOD4 cell offsets');
    const covered = new Float64Array(count);
    for (let cell = 0; cell < cells; cell++) {
        const first = region.cellOffsets[cell], end = region.cellOffsets[cell + 1];
        check(integer(first, 0, entries) && integer(end, first, entries), 'Invalid LOD4 offset range');
        const b = lod4CellBounds(region, cell), capacity = b.width * b.height;
        let bitmap = 0, occupied = 0;
        for (let i = first; i < end; i++) {
            const delta = region.memberDeltas[i], area = region.overlapAreas[i];
            check(integer(delta, i === first ? 0 : 1, count - 1), 'Invalid LOD4 member delta');
            bitmap += delta;
            check(bitmap < count && integer(area, 1, Math.min(capacity, region.bitmapAreas[bitmap])), 'Invalid LOD4 cell intersection');
            covered[bitmap] += area; occupied += area;
        }
        check(occupied <= capacity, 'LOD4 cell coverage exceeds its canonical bounds');
    }
    check(region.bitmapAreas.every((area, bitmap) => covered[bitmap] === area), 'LOD4 bitmap intersections do not conserve area');
    return region;
}

/** A bitmap crossing cells contributes overlap / bitmapArea to each, summing to one. */
export function buildLod4Region(shape: Lod4Shape, geometrySha256: string, side = LOD4_SIDE): Lod4Region {
    check(integer(side, 1, LOD4_SIDE) && (side & (side - 1)) === 0, 'Invalid LOD4 grid side');
    check(integer(shape.width, 1, 65535) && integer(shape.height, 1, 65535) && integer(shape.bitmaps.length, 1, 2016), 'Invalid LOD4 source dimensions');
    const columns = Math.min(side, shape.width), rows = Math.min(side, shape.height);
    const cells: { bitmap: number; area: number }[][] = Array.from({ length: columns * rows }, () => []);
    // floor(edge * extent / cells) may put an integer pixel in the next cell.
    const coordinate = (pixel: number, extent: number, divisions: number) => Math.ceil((pixel + 1) * divisions / extent) - 1;
    const region: Lod4Region = { version: 1, id: shape.neighborhood, width: shape.width, height: shape.height,
        columns, rows, geometrySha256, bitmapAreas: [], cellOffsets: [0], memberDeltas: [], overlapAreas: [] };
    for (const [bitmap, r] of shape.bitmaps.entries()) {
        check(integer(r.x, 0, shape.width - 1) && integer(r.y, 0, shape.height - 1) && integer(r.width, 1, shape.width - r.x) && integer(r.height, 1, shape.height - r.y), 'Invalid canonical LOD4 bitmap bounds');
        region.bitmapAreas.push(r.width * r.height);
        for (let row = coordinate(r.y, shape.height, rows); row <= coordinate(r.y + r.height - 1, shape.height, rows); row++) {
            for (let col = coordinate(r.x, shape.width, columns); col <= coordinate(r.x + r.width - 1, shape.width, columns); col++) {
                const cell = row * columns + col, b = lod4CellBounds(region, cell);
                const area = (Math.min(r.x + r.width, b.x + b.width) - Math.max(r.x, b.x)) *
                    (Math.min(r.y + r.height, b.y + b.height) - Math.max(r.y, b.y));
                check(integer(area, 1, UINT32_MAX), 'Invalid LOD4 overlap area');
                cells[cell].push({ bitmap, area });
            }
        }
    }
    for (const members of cells) {
        let previous = 0;
        for (const { bitmap, area } of members) {
            region.memberDeltas.push(bitmap - previous); region.overlapAreas.push(area); previous = bitmap;
        }
        region.cellOffsets.push(region.memberDeltas.length);
    }
    return validateLod4Region(region, side);
}

export function validateLod4Index(index: Lod4Index, sourceSnapshot: string) {
    check(index.version === 1 && index.format === LOD4_FORMAT && hashValid(index.sourceSnapshot) && index.sourceSnapshot === sourceSnapshot, 'LOD4 index snapshot/version mismatch');
    check(integer(index.gridSide, 1, LOD4_SIDE) && (index.gridSide & (index.gridSide - 1)) === 0 && integer(index.bitmapCount, 1, 1048576), 'Invalid LOD4 index dimensions');
    check(index.regions.length === Math.ceil(index.bitmapCount / 2016), 'Invalid LOD4 region coverage');
    let count = 0;
    index.regions.forEach((ref, id) => {
        check(ref.id === id && integer(ref.width, 1, 65535) && integer(ref.height, 1, 65535) && ref.bitmapCount === Math.min(2016, index.bitmapCount - id * 2016), 'Invalid LOD4 index region');
        check(hashValid(ref.geometrySha256) && hashValid(ref.sha256) && integer(ref.bytes, 1, LOD4_REGION_LIMIT), 'Invalid LOD4 index reference');
        count += ref.bitmapCount;
    });
    check(count === index.bitmapCount, 'Invalid LOD4 bitmap coverage');
    return index;
}

export function encodeLod4Index(index: Lod4Index) {
    validateLod4Index(index, index.sourceSnapshot);
    const bytes = indexType.encode(index).finish();
    check(bytes.length <= LOD4_INDEX_LIMIT, 'LOD4 index exceeds byte budget');
    return bytes;
}
export async function decodeLod4Index(bytes: Uint8Array, sourceSnapshot: string, expectedHash?: string): Promise<Lod4Index> {
    check(bytes.length > 0 && bytes.length <= LOD4_INDEX_LIMIT, 'LOD4 index exceeds byte budget');
    if (expectedHash !== undefined) check(hashValid(expectedHash) && await sha256(bytes) === expectedHash, 'LOD4 index integrity failure');
    return validateLod4Index(indexType.toObject(indexType.decode(bytes), { arrays: true, defaults: true }) as Lod4Index, sourceSnapshot);
}
export function encodeLod4Region(region: Lod4Region, side = LOD4_SIDE) {
    validateLod4Region(region, side);
    const bytes = regionType.encode(region).finish();
    check(bytes.length <= LOD4_REGION_LIMIT, 'LOD4 page exceeds byte budget');
    return bytes;
}
export async function decodeLod4Region(bytes: Uint8Array, ref: Lod4RegionRef, index: Lod4Index): Promise<Lod4Region> {
    validateLod4Index(index, index.sourceSnapshot);
    const recorded = index.regions[ref.id];
    check(recorded && Object.keys(recorded).every(key => recorded[key as keyof Lod4RegionRef] === ref[key as keyof Lod4RegionRef]), 'LOD4 page does not belong to this index');
    check(bytes.length === ref.bytes && bytes.length <= LOD4_REGION_LIMIT && await sha256(bytes) === ref.sha256, 'LOD4 page integrity failure');
    const region = validateLod4Region(regionType.toObject(regionType.decode(bytes), { arrays: true, defaults: true }) as Lod4Region, index.gridSide);
    check(region.id === ref.id && region.width === ref.width && region.height === ref.height && region.bitmapAreas.length === ref.bitmapCount && region.geometrySha256 === ref.geometrySha256, 'LOD4 page canonical identity mismatch');
    return region;
}


export type Lod4Discovery = { format: typeof LOD4_FORMAT; sourceSnapshot: string; index: { url: string; sha256: string; bytes: number } };
export function validateLod4Discovery(value: Lod4Discovery, snapshot: string) {
    check(value?.format === LOD4_FORMAT && value.sourceSnapshot === snapshot, 'LOD4 discovery snapshot mismatch');
    check(value.index && hashValid(value.index.sha256) && value.index.url === `lod4/${value.index.sha256}.pb` && integer(value.index.bytes, 1, LOD4_INDEX_LIMIT), 'Invalid LOD4 discovery reference');
    return value;
}
