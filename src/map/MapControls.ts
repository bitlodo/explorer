import type { RenderingMode } from './layers/ParcelSizeColors';
import type { ChunkDebugMode } from './layers/LoadedChunkBounds';
import type { AnalyticsIndex, BitmapInspection, MetricSummary } from '@shared/mapAnalytics';
import type {PatternEntry,PatternGroup,PatternPreview} from '@shared/patterns';
export type { RenderingMode, ChunkDebugMode };

export type ZoomPhase = 'drag' | 'release' | 'snap';

export interface MapSnapshot {
    readonly ready: boolean;
    readonly status: string;
    readonly renderingAvailable: boolean;
    readonly renderingMode: RenderingMode;
    readonly renderingBusy: boolean;
    readonly renderingError: string;
    readonly palette: readonly string[];
    readonly chunkDebugEnabled: boolean;
    readonly chunkDebugMode: ChunkDebugMode;
    readonly publishedHeight: number;
    readonly snapshot?: string;
    readonly publishedParcels?: number;
    readonly neighborhoods: number;
    readonly analytics?: AnalyticsIndex;
    readonly selection?: BitmapInspection;
    readonly inspectionBusy: boolean;
    readonly inspectionError: string;
    readonly filter: readonly [number,number];
    readonly filterMatches?: number;
    readonly matchedPattern?: number;
    readonly layerSummary?: MetricSummary;
    readonly parcelRange: readonly [number,number];
    readonly parcelDistribution?: {counts:readonly number[];areas:readonly number[]};
    readonly parcelMatches?: number;
    readonly parcelAreaShare?: number;
    readonly filterBusy: boolean;
    readonly patternGroups?:readonly PatternGroup[];
    readonly patternTotal?:number;
    readonly patternTransactions?:number;
    readonly selectedPattern?:number;
}

export interface MapZoomSnapshot {
    readonly height: number;
    readonly stops: readonly number[];
}

/** The application's controls depend only on this map API. */
export interface MapControls {
    getState(): MapSnapshot;
    subscribe(listener: () => void): () => void;
    getZoom(): MapZoomSnapshot;
    subscribeZoom(listener: () => void): () => void;
    goToBitmap(height: number): Promise<void>;
    setZoom(height: number, phase: ZoomPhase): void;
    setRenderingMode(mode: RenderingMode, colors?: readonly string[]): Promise<void>;
    setPalette(colors: readonly string[]): void;
    setChunkDebug(mode: ChunkDebugMode): void;
    home(): void;
    inspectBitmap(id: number): Promise<void>;
    clearSelection(): void;
    loadAnalytics(): Promise<void>;
    setMetricFilter(low: number, high: number): void;
    setParcelRange(low:number,high:number):Promise<void>;
    findPatternMatches(): Promise<void>;
    setPatternFilter(transactions?:number,pattern?:number):Promise<void>;
    getPatternPage(transactions:number|undefined,offset:number,limit?:number):{entries:PatternEntry[];total:number};
    getPatternPreview(id:number,signal:AbortSignal):Promise<PatternPreview>;
}
