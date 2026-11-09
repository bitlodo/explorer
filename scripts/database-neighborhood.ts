import protobuf from 'protobufjs';
import type { Database } from './duckdb';
import MondrianLayout from '../src/shared/MondrianLayout';
import descriptor from '../src/shared/proto/neighborhood_descriptor.json';
import { check } from '../src/shared/httpPack';

const geometryType = protobuf.Root.fromJSON(descriptor).lookupType('Neighborhood');
export type BitmapDimensions = { bitmap: number; size: number[] };

/** The reference stores occupied bounds, in block-height order. */
export function orderedDimensions(rows: BitmapDimensions[], id: number): [number, number][] {
    check(rows.length === 2016, `Missing source dimensions for neighborhood ${id}`);
    return rows.map(({ bitmap, size }, index) => {
        check(bitmap === id * 2016 + index && Array.isArray(size) && size.length === 2 &&
            size.every(value => Number.isSafeInteger(value) && value > 0 && value <= 1e6),
        `Invalid source dimensions at bitmap ${id * 2016 + index}`);
        return [size[0], size[1]];
    });
}

/** Only new complete neighborhoods are packed; published geometry is copied. */
export async function databaseNeighborhood(db: Database, id: number) {
    const rows = await db.all<BitmapDimensions>(
        'SELECT bitmap, size FROM bitmaps WHERE bitmap >= ? AND bitmap < ? ORDER BY bitmap', id * 2016, (id + 1) * 2016);
    const layout = new MondrianLayout(orderedDimensions(rows, id));
    const data = { neighborhood: id, width: layout.width, height: layout.height, bitmaps: layout.slots };
    return { bytes: geometryType.encode(data).finish(), data };
}
