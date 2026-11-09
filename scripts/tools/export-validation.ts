import type { ParcelRecord } from '../../src/shared/httpPack';
import type { MondrianRect } from '../../src/shared/MondrianLayout';
/** Transport validation uses existing geometry; it does not claim Mondrian equivalence. */
export function validateGrid(rows: {bitmap:number;width:number;height:number}[], id: number, rectangles: Pick<MondrianRect,'width'|'height'>[]) {
    if (rows.length !== rectangles.length || rectangles.length !== 2016) throw Error(`Missing grid records for neighborhood ${id}`);
    rows.forEach((row, index) => {
        const rect = rectangles[index];
        if (row.bitmap !== id * 2016 + index || row.width !== rect.width || row.height !== rect.height)
            throw Error(`Grid/canonical geometry mismatch at bitmap ${id * 2016 + index}`);
    });
}
export function validateRoundTrip(record: ParcelRecord, tx: number[], decodeSizes: (record:ParcelRecord)=>number[]) {
    const decoded = decodeSizes(record);
    if (decoded.length !== tx.length) throw Error(`Transaction count changed at bitmap ${record.id}`);
    for (let i = 0; i < tx.length; i++) if (decoded[i] !== tx[i]) throw Error(`Transaction order changed at bitmap ${record.id}, parcel ${i}`);
}
export function validatePayloadBounds(tx: number[], rect: Pick<MondrianRect,'width'|'height'>, bitmap: number) {
    let area = 0;
    for (const size of tx) {
        if (size > rect.width || size > rect.height) throw Error(`Parcel exceeds canonical bitmap ${bitmap}`);
        area += size * size;
    }
    if (!tx.length || area > rect.width * rect.height) throw Error(`Parcel area exceeds canonical bitmap ${bitmap}`);
}
