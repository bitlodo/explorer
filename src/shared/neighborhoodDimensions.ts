import { check, integer } from './httpPack';

// Kept independent of the algorithm so the main bundle only imports the codec.
export const DIMENSION_BYTES = 65536;
export type NeighborhoodShape = { neighborhood: number; width: number; height: number; bitmaps: { x: number; y: number; width: number; height: number }[] };
export type LayoutExpectation = { id: number; width: number; height: number; sha256: string; bytes: number };

export function createDimensionsCodec(protobuf: any) {
    const type = protobuf.Root.fromJSON({ nested: { Dimensions: { fields: {
        version: { type: 'uint32', id: 1 }, id: { type: 'uint32', id: 2 },
        width: { type: 'uint32', id: 3 }, height: { type: 'uint32', id: 4 },
        sizes: { rule: 'repeated', type: 'uint32', id: 5, options: { packed: true } },
    } } } }).lookupType('Dimensions');
    function decode(bytes: Uint8Array, expected: Pick<LayoutExpectation, 'id' | 'width' | 'height'>): Uint32Array {
        check(bytes.length > 0 && bytes.length <= DIMENSION_BYTES, 'Invalid neighborhood dimensions byte count');
        const value = type.toObject(type.decode(bytes), { defaults: true, arrays: true });
        check(value.version === 1 && value.id === expected.id && value.width === expected.width && value.height === expected.height, 'Neighborhood dimensions do not match manifest');
        check(value.sizes.length === 2016 * 2, 'Neighborhood dimensions must contain 2016 ordered pairs');
        let area = 0, totalHeight = 0;
        for (let i = 0; i < value.sizes.length; i += 2) {
            const w = value.sizes[i], h = value.sizes[i + 1];
            check(integer(w, 1, Math.min(expected.width, 1e6)) && integer(h, 1, expected.height), 'Invalid bitmap dimensions');
            area += w * h; totalHeight += h;
        }
        check(Number.isSafeInteger(area) && area <= 1e12 && area <= expected.width * expected.height && totalHeight <= 1e6, 'Neighborhood dimensions exceed layout budget');
        return new Uint32Array(value.sizes);
    }
    function encode(data: NeighborhoodShape): Uint8Array {
        const bytes = type.encode({ version: 1, id: data.neighborhood, width: data.width, height: data.height, sizes: data.bitmaps.flatMap(r => [r.width, r.height]) }).finish();
        decode(bytes, { id: data.neighborhood, width: data.width, height: data.height });
        return new Uint8Array(bytes);
    }
    return { encode, decode };
}
