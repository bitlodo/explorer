import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import readline from 'node:readline';
import * as THREE from 'three';
import Mondrian from '../src/shared/MondrianLayout.ts';
import CompactParcelLayer from '../src/map/layers/CompactParcelLayer.ts';

const bitmap = { x: 237, y: 419, width: 1000, height: 1000 };
const source = [{ x: 0, y: 0, width: 4, height: 3 }, { x: 4, y: 0, width: 2, height: 2 },
    { x: 0, y: 3, width: 1, height: 1 }, { x: 1, y: 3, width: 3, height: 5 }];

function verifyVertices(layer, localId, slots) {
    const info = layer.getBitmapInfo(localId);
    assert.equal(info.count, slots.length);
    const matrix = new THREE.Matrix4(), actual = new THREE.Vector3(), expected = new THREE.Vector3();
    for (const range of info.ranges) {
        const rects = range.chunk.geometry.getAttribute('parcelRect').array;
        const ids = range.chunk.geometry.getAttribute('bitmapIndex').array;
        for (let index = range.start; index <= range.end; index++) {
            const slot = slots[range.firstParcel + index - range.start], base = index * 4;
            assert.equal(ids[index], localId);
            matrix.compose(new THREE.Vector3(bitmap.x + slot.x, 0, bitmap.y + slot.y), new THREE.Quaternion(),
                new THREE.Vector3(slot.width - 0.5, 1, slot.height - 0.5));
            for (const [x, z] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
                expected.set(x, 0, z).applyMatrix4(matrix);
                actual.set(rects[base] + x * rects[base + 2], 0, rects[base + 1] + z * rects[base + 3]);
                assert.deepEqual(actual.toArray(), expected.toArray());
                assert.ok(range.chunk.geometry.boundingBox.containsPoint(actual));
                assert.ok(range.chunk.geometry.boundingSphere.containsPoint(actual));
                // The shader may fill the visual margin when its gap is subpixel.
                actual.set(bitmap.x + slot.x + x * slot.width, 0, bitmap.y + slot.y + z * slot.height);
                assert.ok(range.chunk.geometry.boundingBox.containsPoint(actual));
                assert.ok(range.chunk.geometry.boundingSphere.containsPoint(actual));
            }
        }
    }
}

test('packed compact rectangles retain legacy insets and order, with bounds covering canonical cells', () => {
    const layer = new CompactParcelLayer(3), before = structuredClone(source);
    layer.addBitmap(2015, bitmap, source);
    verifyVertices(layer, 2015, source);
    assert.deepEqual(source, before);
    assert.equal(layer.chunks.length, 2);
    assert.equal(layer.chunks[0].isInstancedMesh, undefined);
    assert.equal(layer.chunks[0].geometry.getAttribute('instanceMatrix'), undefined);
    assert.equal(layer.chunks[0].geometry.getAttribute('instanceColor'), undefined);
    assert.equal(layer.stats.bytesPerParcel, 18);
    assert.equal(layer.stats.allocatedInstanceBytes, 2 * 3 * 18);
    layer.dispose();
});

test('hover changes only a uniform, including multiple chunks, without buffer uploads', () => {
    const layer = new CompactParcelLayer(2);
    layer.addBitmap(4, bitmap, source);
    const versions = layer.chunks.map(c => Object.values(c.geometry.attributes).map(a => a.version));
    layer.setBitmapSelected(4, true);
    assert.equal(layer.material.uniforms.selectedBitmap.value, 4);
    layer.setBitmapSelected(9, false);
    assert.equal(layer.material.uniforms.selectedBitmap.value, 4);
    layer.setBitmapSelected(4, false);
    assert.equal(layer.material.uniforms.selectedBitmap.value, -1);
    assert.deepEqual(layer.chunks.map(c => Object.values(c.geometry.attributes).map(a => a.version)), versions);
    assert.ok(layer.chunks.every(c => c.material === layer.material));
    assert.deepEqual(layer.material.uniforms.selectedColor.value.toArray(), new THREE.Color('#ffe0aa').toArray());
    layer.dispose();
});

test('duplicate and empty bitmaps do not allocate or reorder parcels; invalid inputs fail atomically', () => {
    const layer = new CompactParcelLayer(8);
    layer.addBitmap(0, bitmap, []);
    assert.equal(layer.stats.chunks, 0);
    layer.addBitmap(1, bitmap, source);
    layer.addBitmap(1, bitmap, source);
    assert.equal(layer.stats.parcels, 4);
    assert.throws(() => layer.addBitmap(2016, bitmap, source));
    assert.throws(() => layer.addBitmap(2, bitmap, [...source, { x: 0, y: NaN, width: 1, height: 1 }]));
    assert.equal(layer.stats.parcels, 4);
    assert.equal(layer.getBitmapInfo(2), undefined);
    layer.dispose();
});

test('uploads use contiguous appended ranges, clear after upload, and bounds include all instances', () => {
    const layer = new CompactParcelLayer(8);
    layer.addBitmap(0, bitmap, source.slice(0, 2));
    layer.addBitmap(1, bitmap, source.slice(2));
    const geometry = layer.chunks[0].geometry, rects = geometry.getAttribute('parcelRect');
    assert.deepEqual(rects.updateRanges, [{ start: 0, count: 16 }]);
    rects.onUploadCallback();
    geometry.getAttribute('bitmapIndex').onUploadCallback();
    layer.addBitmap(2, bitmap, source.slice(0, 1));
    assert.deepEqual(rects.updateRanges, [{ start: 16, count: 4 }]);
    assert.deepEqual(geometry.getAttribute('bitmapIndex').updateRanges, [{ start: 4, count: 1 }]);
    assert.equal(layer.chunks[0].frustumCulled, true);
    verifyVertices(layer, 0, source.slice(0, 2));
    verifyVertices(layer, 1, source.slice(2));
    layer.dispose();
});

test('a bitmap larger than a chunk preserves every transaction index across boundaries', () => {
    const layer = new CompactParcelLayer(100000);
    const slots = Array.from({ length: 100007 }, (_, i) => ({ x: i % 1000, y: Math.floor(i / 1000), width: 1, height: 1 }));
    layer.addBitmap(17, bitmap, slots);
    assert.deepEqual(layer.getBitmapInfo(17).ranges.map(r => [r.start, r.end, r.firstParcel]), [[0, 99999, 0], [0, 6, 100000]]);
    assert.equal(layer.stats.parcels, slots.length);
    layer.dispose();
});

test('dispose releases geometry and shared material once', () => {
    const layer = new CompactParcelLayer(2); layer.addBitmap(1, bitmap, source);
    let geometries = 0, materials = 0;
    layer.chunks.forEach(c => c.geometry.addEventListener('dispose', () => geometries++));
    layer.material.addEventListener('dispose', () => materials++);
    layer.dispose(); layer.dispose();
    assert.equal(geometries, 2); assert.equal(materials, 1);
    assert.equal(layer.stats.allocatedInstanceBytes, 0);
    assert.throws(() => layer.addBitmap(1, bitmap, source));
});

test('packed parcel rectangles match the unchanged Mondrian on four real block fixtures', async () => {
    const wanted = new Set([806401, 806402, 807408, 808415]), checked = [];
    const stream = fs.createReadStream(new URL('./fixtures/real-blocks.ndjson', import.meta.url));
    const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
    try {
        for await (const line of lines) {
            const id = Number(line.match(/^\{"bitmap":(\d+)/)?.[1]);
            if (!wanted.has(id)) continue;
            const fixture = JSON.parse(line), layout = new Mondrian(fixture.tx), layer = new CompactParcelLayer(1000);
            layer.addBitmap(id % 2016, bitmap, layout.slots);
            verifyVertices(layer, id % 2016, layout.slots);
            checked.push({ bitmap: id, parcels: layout.slots.length }); layer.dispose();
        }
    } finally { lines.close(); stream.destroy(); }
    assert.equal(checked.length, 4);
    console.log(JSON.stringify({ realFixtures: checked, packedRectangleEquality: 'exact' }));
});

test('default compact capacity grows for actual demand and preserves prior instances and budget estimates',()=>{
    const layer=new CompactParcelLayer(),one={x:0,y:0,width:1,height:1};
    assert.equal(layer.estimateBytes(2016),2048*18);
    for(let id=0;id<2016;id++)layer.addBitmap(id,bitmap,[one]);
    assert.equal(layer.chunks.length,1);assert.equal(layer.chunks[0].geometry.instanceCount,2016);assert.equal(layer.stats.allocatedInstanceBytes,2048*18);
    layer.dispose();
    const growing=new CompactParcelLayer(),source=Array.from({length:2000},(_,i)=>({x:i,y:0,width:1,height:1}));
    growing.addBitmap(0,bitmap,source);const old=growing.chunks[0].geometry;let disposed=false;old.addEventListener('dispose',()=>disposed=true);
    const before=Array.from(old.attributes.parcelRect.array.slice(0,8000)),estimate=growing.estimateBytes(2000);
    growing.addBitmap(1,bitmap,source);
    assert.equal(disposed,true);assert.equal(growing.chunks.length,1);assert.equal(growing.chunks[0].geometry.instanceCount,4000);
    assert.equal(growing.stats.allocatedInstanceBytes,estimate);assert.equal(estimate,4096*18);
    assert.deepEqual(Array.from(growing.chunks[0].geometry.attributes.parcelRect.array.slice(0,8000)),before);
    const large=Array.from({length:100001},()=>one),next=growing.estimateBytes(large.length);growing.addBitmap(2,bitmap,large);
    assert.equal(growing.stats.allocatedInstanceBytes,next);assert.equal(growing.chunks.length,2);assert.equal(growing.stats.parcels,104001);
    growing.dispose();
});

test('bitmap area uses canonical dimensions and switching modes keeps instance buffers intact',()=>{
    const layer=new CompactParcelLayer(10),blocks=[{x:0,y:0,width:7,height:11},{x:0,y:0,width:3,height:5}];
    layer.setBitmapSizes(blocks);layer.addBitmap(0,blocks[0],[{x:0,y:0,width:1,height:1},{x:1,y:0,width:4,height:4}]);
    const sizes=layer.material.uniforms.bitmapSizes.value.image.data;
    assert.equal(sizes[1],77);assert.equal(sizes[5],15);
    const before=layer.chunks.map(c=>[c.geometry.attributes.parcelRect.version,c.geometry.attributes.bitmapIndex.version]);
    layer.setBitmapAreaMode(true,77);assert.equal(layer.material.uniforms.sizeColorMode.value,2);
    assert.equal(layer.material.uniforms.bitmapAreaMax.value,77);
    layer.setSizeColorMode(true);assert.equal(layer.material.uniforms.sizeColorMode.value,1);
    layer.setSizeColorMode(false);assert.equal(layer.material.uniforms.sizeColorMode.value,0);
    assert.deepEqual(layer.chunks.map(c=>[c.geometry.attributes.parcelRect.version,c.geometry.attributes.bitmapIndex.version]),before);
    assert.equal(layer.stats.bytesPerParcel,18);layer.dispose();
});

test('persistent inspection has its own global ID uniform and never rewrites parcel attributes',()=>{
    const layer=new CompactParcelLayer(2);layer.addBitmap(4,bitmap,source);
    const versions=layer.chunks.map(chunk=>Object.values(chunk.geometry.attributes).map(attribute=>attribute.version));
    layer.setInspectedBitmap(2020);layer.setBitmapSelected(4,true);layer.setBitmapSelected(4,false);
    assert.equal(layer.material.uniforms.inspectedBitmap.value,2020);
    assert.deepEqual(layer.chunks.map(chunk=>Object.values(chunk.geometry.attributes).map(attribute=>attribute.version)),versions);
    layer.setInspectedBitmap();assert.equal(layer.material.uniforms.inspectedBitmap.value,-1);layer.dispose();
});
