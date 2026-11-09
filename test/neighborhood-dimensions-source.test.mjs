import test from 'node:test';
import assert from 'node:assert/strict';
import { loadShared } from './helpers/load-shared.ts';
import { fixture, FakeWorker } from './neighborhood-dimensions-fixture.mjs';
const { default: Source } = await loadShared('../../src/data/StaticHttpDataSource.ts');
const { default: Client } = await loadShared('../../src/data/NeighborhoodLayoutClient.ts');

async function harness(mode, disk = new Map(), auto = true) {
    const f = await fixture(), previousFetch = globalThis.fetch, previousLocation = globalThis.location, requests = [], workers = [];
    globalThis.location = { href: 'https://example.org/repository/' };
    globalThis.fetch = async url => { const name = new URL(url).pathname.split('/').pop(); requests.push(name); return new Response(f.files.get(name)); };
    const source = new Source('map-data/', 'manifest.pb', mode);
    source.layouts = new Client(() => {
        const worker = new FakeWorker(); workers.push(worker);
        if (auto) { const post = worker.postMessage.bind(worker); worker.postMessage = (...args) => { post(...args); queueMicrotask(() => worker.complete()); }; }
        return worker;
    });
    source.layoutCache.close();
    source.layoutCache = { get: async key => disk.get(key), putMany: async entries => { for (const e of entries) disk.set(e.hash, e.bytes.slice()); return true; }, close() {} };
    return { ...f, source, disk, requests, workers, close() { source.close(); globalThis.fetch = previousFetch; globalThis.location = previousLocation; } };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test('v7 default downloads dimensions once, coalesces callers and resolves unchanged parcel owners', async () => {
    const h = await harness();
    try {
        const [a, b] = await Promise.all([h.source.getNeighborhood(0), h.source.getNeighborhood(0)]);
        assert.equal(a, b); assert.deepEqual(a.bitmaps.map(r => ({ ...r })), h.data.bitmaps);
        assert.deepEqual(h.requests, ['manifest.pb', h.manifest.regions[0].dimensions.url]);
        assert.equal(h.workers.length, 1); assert.equal(h.source.stats.neighborhoodLayouts, 1);
        for (const id of [0, 1008, 2015]) {
            const [job] = await h.source.getParcelJobs([id]), r = a.bitmaps[id], region = h.manifest.regions[0];
            assert.equal(job.pack.chunkX, Math.floor((region.x + r.x) / 1024));
            assert.equal(job.pack.chunkY, Math.floor((region.y + r.y) / 1024));
        }
    } finally { h.close(); }
});

test('persistent generated layouts avoid both dimension requests and worker computation after reload; corrupt cache is rebuilt', async () => {
    const disk = new Map(), first = await harness('client', disk);
    await first.source.getNeighborhood(0); first.close();
    const second = await harness('client', disk);
    try {
        await second.source.getNeighborhood(0);
        assert.deepEqual(second.requests, ['manifest.pb']); assert.equal(second.workers.length, 0);
        assert.equal(second.source.stats.neighborhoodLayoutCacheHits, 1);
    } finally { second.close(); }
    for (const value of disk.values()) value[0] ^= 1;
    const third = await harness('client', disk);
    try { await third.source.getNeighborhood(0); assert.equal(third.source.stats.neighborhoodLayouts, 1); }
    finally { third.close(); }
});

test('server A/B mode fetches canonical geometry and creates no worker', async () => {
    const h = await harness('server');
    try {
        const data = await h.source.getNeighborhood(0);
        assert.deepEqual(data.bitmaps.map(r => ({ ...r })), h.data.bitmaps);
        assert.deepEqual(h.requests, ['manifest.pb', h.manifest.regions[0].geometry.url]);
        assert.equal(h.workers.length, 0); assert.equal(h.disk.size, 0);
    } finally { h.close(); }
});

test('one cancelled consumer leaves shared work alive; cancelling the last consumer terminates work and permits retry', async () => {
    const h = await harness('client', new Map(), false);
    try {
        const a = new AbortController(), b = new AbortController();
        const first = h.source.getNeighborhood(0, a.signal), rejected = assert.rejects(first, { name: 'AbortError' });
        const second = h.source.getNeighborhood(0, b.signal);
        while (!h.workers.length) await tick();
        a.abort(); await rejected; assert.equal(h.workers[0].terminated, false);
        const secondRejected = assert.rejects(second, { name: 'AbortError' }); b.abort(); await secondRejected;
        assert.equal(h.workers[0].terminated, true); assert.equal(h.disk.size, 0); assert.equal(h.source.geometry.size, 0);
        const retry = h.source.getNeighborhood(0);
        while (h.workers.length < 2) await tick();
        await h.workers[1].complete(); await retry;
        assert.equal(h.source.stats.neighborhoodLayouts, 1);
    } finally { h.close(); }
});

test('corrupt dimensions fail without canonical fallback or persisted output; close rejects pending work', async () => {
    const h = await harness();
    try {
        const ref = h.manifest.regions[0].dimensions, bytes = h.files.get(ref.url).slice(); bytes[0] ^= 1; h.files.set(ref.url, bytes);
        await assert.rejects(() => h.source.getNeighborhood(0), /integrity/);
        assert.equal(h.disk.size, 0); assert.equal(h.workers.length, 0);
        assert.ok(!h.requests.includes(h.manifest.regions[0].geometry.url));
    } finally { h.close(); }
    const pending = await harness('client', new Map(), false);
    try {
        const request = pending.source.getNeighborhood(0), rejected = assert.rejects(request, { name: 'AbortError' });
        while (!pending.workers.length) await tick();
        pending.source.close(); await rejected;
        assert.equal(pending.workers[0].terminated, true); assert.equal(pending.source.geometry.size, 0);
    } finally { pending.close(); }
});

test('unavailable/quota-failed persistent storage still returns generated geometry', async () => {
    const h = await harness();
    try {
        h.source.layoutCache.putMany = async () => false;
        const data = await h.source.getNeighborhood(0);
        assert.equal(data.bitmaps.length, 2016); assert.equal(h.disk.size, 0);
    } finally { h.close(); }
});

test('an immediate retry after cancelling the dimension download does not join the aborted file promise', async () => {
    const h = await harness(), baseFetch = globalThis.fetch;
    let waiting = false, delayed = false;
    globalThis.fetch = async (url, options) => {
        if (new URL(url).pathname.endsWith(h.manifest.regions[0].dimensions.url) && !delayed) {
            delayed = true; waiting = true;
            return new Promise((resolve, reject) => {
                options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
            });
        }
        return baseFetch(url, options);
    };
    try {
        const abort = new AbortController(), first = h.source.getNeighborhood(0, abort.signal), rejected = assert.rejects(first, { name: 'AbortError' });
        while (!waiting) await tick();
        abort.abort();
        const retry = h.source.getNeighborhood(0);
        await rejected; assert.equal((await retry).bitmaps.length, 2016);
    } finally { h.close(); }
});
