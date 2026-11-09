import * as THREE from 'three';

/** Unit X/Z plane, anchored at its top-left corner. */
export function CreateBufferPlaneGeometry(): THREE.BufferGeometry {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([
        0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 1,
    ], 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 1, 1], 2));
    geometry.setIndex(new THREE.BufferAttribute(new Uint16Array([0, 2, 1, 2, 3, 1]), 1));
    return geometry;
}
