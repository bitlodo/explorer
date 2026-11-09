// CPU buffer preparation only: no claim about FPS, GPU time or end-to-end latency.
import * as THREE from 'three';
import CompactParcelLayer from '../src/map/layers/CompactParcelLayer.ts';

const count = 100000, capacity = 100000, bitmap = { x: 237, y: 419 };
const slots = Array.from({ length: count }, (_, i) => ({ x: i % 1000, y: Math.floor(i / 1000), width: 1 + i % 9, height: 1 + i % 9 }));
const legacy = () => {
    const geometry = new THREE.PlaneGeometry(1, 1), material = new THREE.MeshBasicMaterial();
    const mesh = new THREE.InstancedMesh(geometry, material, capacity), matrix = new THREE.Matrix4(), color = new THREE.Color('yellow');
    for (let i = 0; i < slots.length; i++) {
        const s = slots[i];
        matrix.compose(new THREE.Vector3(bitmap.x + s.x, 0, bitmap.y + s.y), new THREE.Quaternion(), new THREE.Vector3(s.width - 0.5, 1, s.height - 0.5));
        mesh.setMatrixAt(i, matrix); mesh.setColorAt(i, color);
    }
    const bytes = mesh.instanceMatrix.array.byteLength + mesh.instanceColor.array.byteLength;
    return { bytes, dispose: () => { mesh.dispose(); geometry.dispose(); material.dispose(); } };
};
const compact = () => {
    const layer = new CompactParcelLayer(capacity); layer.addBitmap(1, bitmap, slots);
    return { bytes: layer.stats.allocatedInstanceBytes, dispose: () => layer.dispose() };
};
const results = { legacy: [], compact: [] }, bytes = {};
for (let round = 0; round < 12; round++) {
    for (const [name, build] of round % 2 ? [['compact', compact], ['legacy', legacy]] : [['legacy', legacy], ['compact', compact]]) {
        const start = performance.now(), result = build(), elapsed = performance.now() - start;
        bytes[name] = result.bytes; result.dispose();
        if (round >= 3) results[name].push(elapsed);
    }
}
const median = values => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
console.log(JSON.stringify({ scope: 'Node CPU buffer preparation; synthetic parcels; no GPU uploads', parcels: count,
    medianMilliseconds: Object.fromEntries(Object.entries(results).map(([name, times]) => [name, median(times)])), instanceBytes: bytes,
    attributeReductionPercent: (1 - bytes.compact / bytes.legacy) * 100 }, null, 2));
