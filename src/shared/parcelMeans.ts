import protobuf from 'protobufjs';
import descriptor from './proto/map_addons_descriptor.json';
import { check, integer, type FileRef } from './httpPack';
export const PARCEL_MEANS_PROTO = 'parcel-size-means-v2-protobuf';
const type = protobuf.Root.fromJSON(structuredClone(descriptor)).lookupType('bitmap.addons.ParcelMeans');
export function encodeParcelMeans(values: Float32Array): Uint8Array {
    check(values.length <= 1048576 && values.every(v => Number.isFinite(v) && v >= 1 && v <= 15), 'Invalid parcel means');
    return type.encode({ version: 1, values: Array.from(values) }).finish();
}
export function decodeParcelMeans(bytes: Uint8Array, count: number, format: string): Float32Array {
    check(integer(count, 1, 1048576) && bytes.length <= count * 4 + 64, 'Parcel means exceed budget');
    let values: Float32Array;
    if (format === PARCEL_MEANS_PROTO) {
        const raw = type.toObject(type.decode(bytes), { defaults: true, arrays: true });
        check(raw.version === 1 && raw.values.length === count, 'Invalid Protobuf means version/count');
        values = Float32Array.from(raw.values);
    } else {
        check(format === 'parcel-size-means-v1' && bytes.length === count * 4, 'Invalid legacy parcel means');
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        values = Float32Array.from({ length: count }, (_, i) => view.getFloat32(i * 4, true));
    }
    check(values.every(v => Number.isFinite(v) && v >= 1 && v <= 15), 'Invalid parcel mean');
    return values;
}
export function validateMeansRef(ref: FileRef, count: number, format: string) {
    const ext = format === PARCEL_MEANS_PROTO ? 'pb' : 'means';
    check((format === PARCEL_MEANS_PROTO || format === 'parcel-size-means-v1') && ref?.url === ref?.sha256 + '.' + ext
        && /^[a-f0-9]{64}$/.test(ref.sha256) && integer(ref.bytes, count * 4, count * 4 + (format === PARCEL_MEANS_PROTO ? 64 : 0)), 'Invalid size summary descriptor');
}
