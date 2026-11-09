export const BITMAP_ARRIVAL_FADE_SECONDS = .18;
export const BITMAP_BASE_EXIT_SECONDS = .12;
export const BITMAP_ARRIVAL_ATLAS_FORMAT = 'bitmap-arrival-progress-v3-responsive-base';
export const BITMAP_ARRIVAL_TOTAL_SECONDS = BITMAP_ARRIVAL_FADE_SECONDS + BITMAP_BASE_EXIT_SECONDS;
// Align the handoff to an R8 sample so the base cannot leave before parcels are opaque.
export const BITMAP_PARCEL_COMPLETE = Math.ceil(255 * BITMAP_ARRIVAL_FADE_SECONDS / BITMAP_ARRIVAL_TOTAL_SECONDS) / 255;

function smooth(from:number,to:number,value:number) {
    const t=Math.max(0,Math.min(1,(value-from)/(to-from)));
    return t*t*(3-2*t);
}

export const parcelArrivalOpacity = (progress:number) => smooth(0,BITMAP_PARCEL_COMPLETE,progress);
export const bitmapBaseOpacity = (progress:number) => 1-smooth(BITMAP_PARCEL_COMPLETE,1,progress);
export function bitmapArrivalProgress(seconds:number) {
    return seconds<=BITMAP_ARRIVAL_FADE_SECONDS
        ?BITMAP_PARCEL_COMPLETE*Math.max(0,seconds/BITMAP_ARRIVAL_FADE_SECONDS)
        :BITMAP_PARCEL_COMPLETE+(1-BITMAP_PARCEL_COMPLETE)*Math.min(1,(seconds-BITMAP_ARRIVAL_FADE_SECONDS)/BITMAP_BASE_EXIT_SECONDS);
}

export const bitmapArrivalGLSL = `
    float parcelArrivalOpacity(float progress) {
        return smoothstep(0.0, ${BITMAP_PARCEL_COMPLETE.toFixed(10)}, progress);
    }
    float bitmapBaseExit(float progress) {
        return smoothstep(${BITMAP_PARCEL_COMPLETE.toFixed(10)}, 1.0, progress);
    }
`;
