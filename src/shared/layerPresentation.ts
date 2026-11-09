import { METRICS } from './mapAnalytics';
import {PATTERN_COLORS} from './patterns';

export type DisplayMetric = 'count' | 'diversity' | 'occupancy';
export type RenderingMode = 'default' | 'patterns' | 'area' | 'size' | DisplayMetric;
export type RegionStyle = 'share' | 'density';
export const DEFAULT_RENDERING_MODE = 'patterns' as const;
export const REGION_MIN_INTENSITY = .2;
export const PARCEL_SIZE_COLORS = ['#49099e', '#c03e80', '#ffff00'];
export const BITMAP_AREA_COLORS = ['#31566a', '#80c7ad', '#ffb14d'];
export const LAYER_PRESENTATION = {
    patterns: {label:'Patterns',description:'Browse repeated bitmap shapes. Filter by transaction count, then choose a pattern to highlight its matches.',colors:PATTERN_COLORS,regionStyle:'share'},
    area: { label: 'Bitmap Area', description: 'Canonical width × height. Distant colors show the selected mean area; intensity shows the matching bitmap share.', colors: BITMAP_AREA_COLORS, regionStyle: 'density' },
    size: { label: 'Parcel size', description: 'Parcel side-length classes, weighted by occupied area.', colors: PARCEL_SIZE_COLORS, regionStyle: 'density' },
    count: { ...METRICS.count, regionStyle: 'density' },
    diversity: { ...METRICS.diversity, colors: ['#624374', '#ae6b9c', '#f7e7ce'], regionStyle: 'density' },
    occupancy: { ...METRICS.occupancy, colors: ['#1e3140', '#4da38a', '#f4ecd8'], regionStyle: 'density' },
} as const;
export const DISPLAY_MODES = ['patterns', 'area', 'size', 'count', 'diversity', 'occupancy'] as const;
export const isDisplayMetric = (mode: string): mode is DisplayMetric => mode === 'count' || mode === 'diversity' || mode === 'occupancy';
export const regionStyleFor = (mode: RenderingMode): RegionStyle => mode === 'default' ? 'share' : LAYER_PRESENTATION[mode].regionStyle;
