import type { ChunkDebugMode } from '@/map/MapControls';

export default function MapChunkDebugControls({ mode, onChange }: {
    mode: ChunkDebugMode;
    onChange: (mode: ChunkDebugMode) => void;
}) {
    return <label className="absolute left-4 top-16 z-10 flex h-9 items-center gap-2 rounded-sm border border-white/25 bg-slate-950/85 px-2 text-sm text-white pointer-events-auto"
        onPointerDown={event => event.stopPropagation()} onWheel={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
        <span>Chunk outlines</span>
        <select id="map-chunk-debug" aria-label="Chunk outlines" value={mode}
            className="h-7 rounded-sm border border-white/25 bg-slate-950 px-2 text-white focus:outline-none focus:ring-1 focus:ring-orange-400"
            onChange={event => onChange(event.target.value as ChunkDebugMode)}>
            <option value="all">All</option>
            <option value="parcels">Parcel chunks</option>
            <option value="bitmaps">Bitmap chunks</option>
            <option value="heatmap">Heatmap tiles</option>
            <option value="none">None</option>
        </select>
    </label>;
}
