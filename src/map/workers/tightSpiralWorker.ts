import SpiralLayout from '@shared/SpiralLayout';

const layout = new SpiralLayout();

self.onmessage = (event: MessageEvent<{ sizes: { width: number; height: number }[] }>) => {
    try {
        const { sizes } = event.data;
        if (!Array.isArray(sizes) || sizes.some(size => !Number.isFinite(size?.width)
            || !Number.isFinite(size?.height) || size.width <= 0 || size.height <= 0)) {
            throw new Error('Invalid neighborhood dimensions in the manifest.');
        }
        let area = 0;
        for (const size of sizes) {
            const next = size.width * size.height;
            area += next;
            if (!Number.isFinite(area) || next === 0) throw new Error('Invalid neighborhood area in the manifest.');
        }
        if (sizes.length < layout.slots.length) throw new Error('The neighborhood manifest moved backwards.');
        for (let id = 0; id < layout.slots.length; id++) {
            if (layout.slots[id].width !== sizes[id].width || layout.slots[id].height !== sizes[id].height)
                throw new Error(`Published neighborhood ${id} changed dimensions; keeping the existing map.`);
        }
        for (let id = layout.slots.length; id < sizes.length; id++) layout.append(sizes[id]);
        self.postMessage({ bounds: layout.bounds, slots: layout.slots });
    } catch (error) {
        self.postMessage({ error: error instanceof Error ? error.message : String(error) });
    }
};
