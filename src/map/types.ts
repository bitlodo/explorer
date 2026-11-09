export interface Rect {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface NeighborhoodData {
    neighborhood: number;
    x: number;
    y: number;
    width: number;
    height: number;
    bitmaps: Rect[]
}
