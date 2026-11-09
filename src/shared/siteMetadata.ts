export type SiteBuild = { version: number; builtAt: string | null };
export type MapStatus = {
    format: 'bitmap-map-status-v1'; snapshot: string; publishedHeight: number;
    syncedHeight: number | null; syncedAt: string | null; generatedAt: string | null; checkedAt: string;
};
const height = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 0xffffffff;
const date = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));

/** Observational metadata must refer to the exact dataset being displayed. */
export function mapStatus(value: unknown, snapshot: string, publishedHeight: number): MapStatus | undefined {
    const s=value as Partial<MapStatus> | null;
    if(!s || s.format!=='bitmap-map-status-v1' || s.snapshot!==snapshot || s.publishedHeight!==publishedHeight ||
        !height(s.publishedHeight) || (s.publishedHeight+1)%2016!==0 || !date(s.checkedAt) ||
        !(s.syncedHeight===null || height(s.syncedHeight)&&s.syncedHeight>=publishedHeight) ||
        !(s.syncedAt===null || date(s.syncedAt)) || !(s.generatedAt===null || date(s.generatedAt))) return;
    return {format:s.format,snapshot,publishedHeight,syncedHeight:s.syncedHeight!,syncedAt:s.syncedAt!,generatedAt:s.generatedAt!,checkedAt:s.checkedAt};
}

export function pendingNeighborhoods(publishedHeight:number,syncedHeight:number){
    return {unpublished:syncedHeight-publishedHeight,ready:Math.floor((syncedHeight+1)/2016)-(publishedHeight+1)/2016,
        progress:(syncedHeight+1)%2016,remaining:2016-(syncedHeight+1)%2016};
}
