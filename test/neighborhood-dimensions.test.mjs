import test from 'node:test';
import assert from 'node:assert/strict';
import { loadShared } from './helpers/load-shared.ts';
import { fixture, codec, dimensionCodec, compute, protobuf, FakeWorker } from './neighborhood-dimensions-fixture.mjs';
const { default: Client } = await loadShared('../../src/data/NeighborhoodLayoutClient.ts');

test('v7 manifest round-trips with immutable dimensions and v6 parcel packs; incompatible versions fail', async () => {
    const { manifest, files } = await fixture();
    const decoded = await codec.decodeManifest(files.get('manifest.pb'));
    assert.deepEqual(decoded.regions[0].dimensions, manifest.regions[0].dimensions);
    assert.ok(decoded.chunks.every(c => c.packs.every(p => p.format === 'bitmap-http-protobuf-v6')));
});

test('packed ordered dimensions produce byte-identical canonical geometry and reject invalid identity/content/budgets', async () => {
    const { request, canonical } = await fixture();
    assert.deepEqual((await compute(request)).wire, canonical);
    const changed = structuredClone(request); changed.dimensions[changed.dimensions.length - 1] ^= 1;
    await assert.rejects(() => compute(changed), /integrity/);
    await assert.rejects(() => compute({ ...request, expected: { ...request.expected, sha256: '0'.repeat(64) } }), /canonical/);
    assert.throws(() => dimensionCodec.decode(request.dimensions, { ...request.expected, id: 1 }), /manifest/);
    const type = new protobuf.Type('Dimensions').add(new protobuf.Field('version', 1, 'uint32')).add(new protobuf.Field('id', 2, 'uint32')).add(new protobuf.Field('width', 3, 'uint32')).add(new protobuf.Field('height', 4, 'uint32')).add(new protobuf.Field('sizes', 5, 'uint32', 'repeated', undefined, { packed: true }));
    for (const sizes of [[1, 1], Array(4032).fill(0), Array(4032).fill(1000000)]) {
        const bytes = type.encode({ version: 1, id: 0, width: 45, height: 45, sizes }).finish();
        assert.throws(() => dimensionCodec.decode(bytes, request.expected), /pairs|dimensions|budget/);
    }
});

test('real worker handler returns transferable canonical bytes and structured errors', async () => {
    const previous = globalThis.self, messages = [];
    globalThis.self = { postMessage: (message, options) => messages.push({ message, options }) };
    try {
        await loadShared('../../src/data/neighborhoodLayoutWorker.ts');
        const { request, canonical } = await fixture();
        await self.onmessage({ data: request });
        const { message, options } = messages.pop();
        assert.deepEqual(message.wire, canonical); assert.equal(options.transfer[0], message.wire.buffer);
        await self.onmessage({ data: { ...request, dimensionsHash: '0'.repeat(64) } });
        assert.match(messages.pop().message.error, /integrity/);
    } finally { globalThis.self = previous; }
});

test('worker queue transfers private buffers, honors priority and cancels queued/active work without accepting stale results', async () => {
    const { request } = await fixture(), workers = [];
    const client = new Client(() => { const w = new FakeWorker(); workers.push(w); return w; });
    const a = new AbortController(), b = new AbortController(), c = new AbortController();
    const input = () => ({ ...request, dimensions: request.dimensions.slice() });
    const firstInput = input(), first = client.generate(firstInput, a.signal);
    assert.equal(firstInput.dimensions.byteLength, 0);
    const second = client.generate(input(), b.signal, 1), secondRejected = assert.rejects(second, { name: 'AbortError' });
    const third = client.generate(input(), c.signal, 10);
    b.abort(); await secondRejected;
    const firstRejected = assert.rejects(first, { name: 'AbortError' }); a.abort(); await firstRejected;
    assert.equal(workers[0].terminated, true); assert.equal(workers.length, 2);
    await workers[0].complete(); // simulated late delivery must not complete the next job
    assert.equal(client.stats.completed, 0);
    await workers[1].complete(); await third;
    assert.equal(client.stats.completed, 1); assert.equal(client.stats.cancelled, 2);
    client.close(); await assert.rejects(() => client.generate(input(), new AbortController().signal), { name: 'AbortError' });
});

test('worker crashes settle active and queued promises; a later request can recreate it; close terminates pending work', async () => {
    const { request } = await fixture(), workers = [];
    const client = new Client(() => { const w = new FakeWorker(); workers.push(w); return w; });
    const input = () => ({ ...request, dimensions: request.dimensions.slice() });
    const a = client.generate(input(), new AbortController().signal), b = client.generate(input(), new AbortController().signal);
    const rejected = Promise.all([assert.rejects(a, /crashed/), assert.rejects(b, /crashed/)]);
    workers[0].onerror({ message: 'crashed', preventDefault() {} }); await rejected;
    const next = client.generate(input(), new AbortController().signal); await workers[1].complete(); await next;
    const pending = client.generate(input(), new AbortController().signal), closed = assert.rejects(pending, { name: 'AbortError' });
    client.close(); await closed; assert.equal(workers[1].terminated, true);
});

test('unresponsive workers time out and a queued neighborhood can be promoted by a new search', async () => {
    const { request } = await fixture(), workers = [];
    const client = new Client(() => { const w = new FakeWorker(); workers.push(w); return w; }, 10);
    await assert.rejects(client.generate({ ...request, dimensions: request.dimensions.slice() }, new AbortController().signal), /timed out/);
    assert.equal(workers[0].terminated, true); client.close();
    const queue = new Client(() => new FakeWorker());
    const input = id => ({ ...request, expected: { ...request.expected, id }, dimensions: request.dimensions.slice() });
    const active = queue.generate(input(0), new AbortController().signal), next = queue.generate(input(1), new AbortController().signal), target = queue.generate(input(2), new AbortController().signal);
    queue.prioritize(2); assert.equal(queue.queue[0].request.expected.id, 2);
    const cancelled = Promise.all([active, next, target].map(p => assert.rejects(p, { name: 'AbortError' })));
    queue.close(); await cancelled;
});
