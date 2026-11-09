import { test } from 'bun:test';
import assert from 'node:assert/strict';
import type { WebGLRenderer } from 'three';
import MapRuntime from '../src/map/MapRuntime';

test('map owns one frame loop and disposes once, including failures and reentrant disposal', async () => {
    const originalFrame = globalThis.requestAnimationFrame, originalCancel = globalThis.cancelAnimationFrame;
    const originalWindow = globalThis.window;
    globalThis.window = { location: { search: '' } } as Window & typeof globalThis;
    const frames = new Map<number, FrameRequestCallback>();
    let serial = 0, starts = 0, exits = 0, disposed = 0;
    globalThis.requestAnimationFrame = callback => { const id = ++serial; frames.set(id, callback); return id; };
    globalThis.cancelAnimationFrame = id => { frames.delete(id); };
    const renderer = { setPixelRatio() {}, dispose() { disposed++; } } as unknown as WebGLRenderer;
    try {
        const runtime = new MapRuntime(renderer);
        runtime.controller.start = () => { starts++; };
        runtime.controller.dispose = () => { exits++; runtime.dispose(); };
        runtime.start(); runtime.start();
        assert.equal(frames.size, 1, 'Starting twice must not duplicate the loop');
        assert.equal(starts, 1);
        runtime.dispose(); runtime.dispose();
        assert.equal(frames.size, 0);
        assert.equal(exits, 1);
        assert.equal(disposed, 1);
        assert.throws(() => runtime.start(), /disposed/);

        const failed = new MapRuntime(renderer);
        failed.controller.start = () => { throw Error('initialization failed'); };
        failed.controller.dispose = () => { throw Error('exit failed'); };
        assert.throws(() => failed.start(), /initialization failed/);
        assert.throws(() => failed.dispose(), /exit failed/);
        failed.dispose();
        assert.equal(frames.size, 0);
        assert.equal(disposed, 2, 'Renderer disposal must survive a failing controller disposal');

        const stops = new MapRuntime(renderer);
        stops.controller.start = () => {};
        stops.controller.update = () => stops.dispose();
        stops.controller.dispose = () => {};
        stops.start();
        const [id, callback] = [...frames][0];
        frames.delete(id); callback(16);
        assert.equal(frames.size, 0, 'Disposal inside update must not schedule another frame');
        assert.equal(disposed, 3);
        await new Promise(resolve => setTimeout(resolve, 0));
    } finally {
        globalThis.requestAnimationFrame = originalFrame;
        globalThis.cancelAnimationFrame = originalCancel;
        globalThis.window = originalWindow;
    }
});
