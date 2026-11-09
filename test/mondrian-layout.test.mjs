import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import MondrianLayout from '../src/shared/MondrianLayout.ts';
import expected from './fixtures/mondrian-results.json' with { type: 'json' };
import { mondrianCases } from './mondrian-cases.mjs';
import { openPublishedMap } from '../scripts/published-map.ts';

const digest = layout => JSON.stringify([layout.width, layout.height, layout.slots]) + '\n';
test('square and rectangle paths preserve captured coordinates, dimensions and input order', () => {
    const groups = new Map();
    for (const [group, input] of mondrianCases()) {
        const before = structuredClone(input), layout = new MondrianLayout(input);
        assert.deepEqual(input, before);
        assert.equal(layout.slots.length, input.length);
        assert.equal(layout.useRects, Array.isArray(input[0]));
        const hash = groups.get(group) ?? createHash('sha256'); hash.update(digest(layout)); groups.set(group, hash);
        if (input.length) assert.equal(layout.strategy, Array.isArray(input[0]) ? 'indexed-rectangles' : input.every(n => n === input[0]) ? 'uniform-squares' : 'indexed-squares');
    }
    assert.deepEqual(Object.fromEntries([...groups].map(([key, hash]) => [key, hash.digest('hex')])), expected.groups);
});
test('real parcel fixtures retain captured layout and typed/frozen inputs follow the square path', async () => {
    const lines = (await Bun.file(new URL('./fixtures/real-blocks.ndjson', import.meta.url)).text()).trim().split('\n');
    for (const line of lines) {
        const { bitmap, tx } = JSON.parse(line), layout = new MondrianLayout(tx);
        assert.equal(createHash('sha256').update(digest(layout)).digest('hex'), expected.real[bitmap]);
        assert.deepEqual(new MondrianLayout(Uint8Array.from(tx)).slots, layout.slots);
        assert.deepEqual(new MondrianLayout(Object.freeze(tx)).slots, layout.slots);
    }
    const pairs = Object.freeze([[2, 10], [10, 2], [4, 5], [1, 1]].map(Object.freeze));
    assert.equal(new MondrianLayout(pairs).strategy, 'indexed-rectangles');
});
test('all published neighborhoods retain exact geometry and canonical Protobuf hashes', async () => {
    const published = await openPublishedMap();
    const { default: protobuf } = await import('protobufjs');
    const { default: descriptor } = await import('../src/shared/proto/neighborhood_descriptor.json', { with: { type: 'json' } });
    const type = protobuf.Root.fromJSON(descriptor).lookupType('Neighborhood');
    for (const region of published.manifest.regions) {
        const { data, bytes } = published.neighborhood(region.id);
        const layout = new MondrianLayout(data.bitmaps.map(r => [r.width, r.height]));
        assert.deepEqual(layout.getSize(), { width: data.width, height: data.height });
        assert.deepEqual(layout.slots, data.bitmaps.map(({ x, y, width, height }) => ({ x, y, width, height })));
        const wire = type.encode({ neighborhood: data.neighborhood, width: layout.width, height: layout.height, bitmaps: layout.slots }).finish();
        assert.deepEqual(Buffer.from(wire), bytes);
    }
    published.assertUnchanged();
});
test('invalid, mixed, fractional and over-budget inputs fail before layout allocation', () => {
    for (const input of [null, {}, [0], [-1], [NaN], [Infinity], [1.5], [65536], [1, [2, 3]], [[2, 3], 1], [[1]], [[1, 2, 3]], [[0, 1]], [[-1, 2]], [[1.5, 1]], [[1, Infinity]], [[1000001, 1]], [[1, 1000001]], Array(240).fill(65535)]) {
        assert.throws(() => new MondrianLayout(input), { name: input === null || !Array.isArray(input) || Array.isArray(input[0]) && (!Array.isArray(input[1]) && input.length > 1 || input[0].length !== 2) ? 'TypeError' : 'RangeError' });
    }
});
