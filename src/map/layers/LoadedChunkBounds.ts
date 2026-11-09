import * as THREE from 'three';
import type { LoadedChunk } from '@/data/MapDataSource';

export type ChunkDebugMode='all'|'parcels'|'bitmaps'|'heatmap'|'none';

/** Debug outlines for verified spatial chunks in this session. */
export default class LoadedChunkBounds extends THREE.LineSegments {
    private keys = new Set<string>();
    private capacity = 32;
    private positions = new THREE.BufferAttribute(new Float32Array(this.capacity * 24), 3).setUsage(THREE.DynamicDrawUsage);

    constructor(color: THREE.ColorRepresentation = 0xffffff, name = 'loaded-world-chunk-bounds', order = 2) {
        // Transparent objects are drawn after the opaque queue. renderOrder
        // alone cannot put an opaque line above transparent map surfaces.
        super(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color, transparent: true, depthTest: false, depthWrite: false, toneMapped: false }));
        this.name = name;
        this.geometry.setAttribute('position', this.positions);
        this.geometry.setDrawRange(0, 0);
        this.renderOrder = order;
        this.frustumCulled = false;
    }

    get count() { return this.keys.size; }

    addChunk({ x, y, size }: LoadedChunk) {
        const key = `${size}:${x},${y}`;
        this.addBounds(key, x * size, y * size, size, size);
    }

    private addBounds(key: string, x0: number, z0: number, width: number, height: number) {
        if (this.keys.has(key)) return;
        const index = this.keys.size;
        if (index === this.capacity) {
            this.capacity *= 2;
            const replacement = new THREE.BufferAttribute(new Float32Array(this.capacity * 24), 3).setUsage(THREE.DynamicDrawUsage);
            (replacement.array as Float32Array).set(this.positions.array);
            this.geometry.dispose();
            this.geometry = new THREE.BufferGeometry();
            this.positions = replacement;
            this.geometry.setAttribute('position', this.positions);
        }
        const x1 = x0 + width, z1 = z0 + height;
        (this.positions.array as Float32Array).set([
            x0, 0, z0, x1, 0, z0,
            x1, 0, z0, x1, 0, z1,
            x1, 0, z1, x0, 0, z1,
            x0, 0, z1, x0, 0, z0,
        ], index * 24);
        this.keys.add(key);
        this.positions.addUpdateRange(index * 24, 24);
        this.positions.needsUpdate = true;
        this.geometry.setDrawRange(0, this.keys.size * 8);
    }

    dispose() {
        this.geometry.dispose();
        (this.material as THREE.LineBasicMaterial).dispose();
        this.keys.clear();
        this.removeFromParent();
    }
}
