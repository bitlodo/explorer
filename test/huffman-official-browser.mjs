import { readMapManifest } from '../scripts/read-map-manifest.ts';
import { datasetPath } from '../scripts/dataset-path.ts';
// Actual v9 site/worker, isolated Chrome profile, no canonical-data generation.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import protobuf from 'protobufjs';
import { staticHandler } from '../server/index.ts';
import { createProtoCodec } from '../src/shared/protobufChunks.ts';

const build = path.resolve(process.env.MAP_SMOKE_BUILD_DIR || 'dist');
const reportFile = path.resolve(process.env.MAP_SMOKE_REPORT || '/tmp/bitmap-explorer-huffman-official-browser.json');
const codec = createProtoCodec(protobuf), data = path.join(build, 'map-data');
const manifest = (await readMapManifest(data)).manifest;
assert.equal(manifest.format, 'bitmap-http-protobuf-v9');
const targetHeight = 822619;
let targetPack;
for (const ref of manifest.indexPages) {
    const chunks = codec.decodeIndexPage(await fs.readFile(datasetPath(data, ref.url)), ref, manifest);
    for (const chunk of chunks) for (const pack of chunk.packs) if (pack.ids.includes(targetHeight)) targetPack = pack;
}
assert(targetPack);
const targetPackUrl = path.relative(data, datasetPath(data, targetPack.url)).split(path.sep).join('/');
const manifestUrl = path.relative(data, datasetPath(data, 'manifest.json')).split(path.sep).join('/');
const requests = [], failedHttp = [], exceptions = [];
const base = (JSON.parse(await fs.readFile(path.join(build, 'build-info.json'), 'utf8'))).base;
const content = await staticHandler(build, base);
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const pathname = new URL(request.url).pathname; requests.push(pathname);
    const response = await content(request);
    if (response.status >= 400 && pathname !== '/favicon.ico') failedHttp.push({ pathname, status: response.status });
    return response;
} });
const profile = await fs.mkdtemp('/tmp/bitmap-explorer-huffman-official-');
const chrome = Bun.spawn(['/usr/bin/google-chrome', '--headless=new', '--no-sandbox', '--disable-dev-shm-usage',
    '--disable-background-networking', '--no-first-run', '--no-default-browser-check', '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], { stdout: 'ignore', stderr: 'ignore' });
let ws;
try {
    let port;
    for (let i = 0; i < 100; i++) {
        try { port = Number((await fs.readFile(profile + '/DevToolsActivePort', 'utf8')).split('\n')[0]); if (port) break; } catch {}
        await Bun.sleep(100);
    }
    assert(port);
    const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    let serial = 0; const pending = new Map();
    ws.onmessage = event => {
        const message = JSON.parse(event.data);
        if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails);
        const p = pending.get(message.id); if (!p) return;
        pending.delete(message.id); clearTimeout(p.timer); message.error ? p.reject(Error(JSON.stringify(message.error))) : p.resolve(message.result);
    };
    const call = (method, params = {}) => new Promise((resolve, reject) => {
        const id = ++serial, timer = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout: ' + method)); }, 30000);
        pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async expression => {
        const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
        assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails)); return result.result.value;
    };
    const wait = async expression => {
        for (let i = 0; i < 800; i++) { if (await evaluate(expression)) return; await Bun.sleep(100); }
        throw Error('Condition failed: ' + expression);
    };
    await call('Page.enable'); await call('Runtime.enable');
    await call('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
    const initialize = async () => {
        await wait("document.readyState==='complete' && !!document.querySelector('canvas') && !!document.getElementById('mapCanvas')");
        await evaluate(`window.game=()=>{const e=document.getElementById('mapCanvas'),key=Object.keys(e).find(k=>k.startsWith('__reactFiber$'));for(let f=e[key];f;f=f.return)for(let h=f.memoizedState;h;h=h.next)if((h.memoizedState?.current??h.memoizedState)?.controller)return h.memoizedState.current??h.memoizedState;};window.state=()=>game()?.controller;`);
        await wait(`state()?.overview?.slots.length===${manifest.regions.length} && state().preview?.rootsReady`);
        assert.equal(await evaluate('state().source.cache.namespace'), 'http-pack-cache-v9');
        assert.equal(await evaluate('(async()=> (await state().source.getManifest()).format)()'), 'bitmap-http-protobuf-v9');
        await evaluate(`window.huffmanRecords=0;window.workerErrors=[];const worker=state().bitmapWorker,post=worker.postMessage.bind(worker);worker.postMessage=(message,...rest)=>{if(message.protocol==='parcel-worker-batch-v1')huffmanRecords+=message.records.filter(r=>r.encoding===4).length;return post(message,...rest);};worker.addEventListener('message',e=>{for(const r of e.data.results||[])if(r.error)workerErrors.push(r.error);});`);
    };
    await call('Page.navigate', { url: new URL(base, server.url).href }); await initialize();
    for (const mode of ['area', 'size', 'default']) {
        await evaluate(`state().setRenderingMode('${mode}')`);
        await wait(`state().renderingMode==='${mode}' && !state().getState().renderingBusy`);
    }
    const chunkProbe = await evaluate(`(async()=>{const source=state().source,m=await source.getManifest(),r=m.regions[0],signal=new AbortController().signal,refs=await source.getNeighborhoodChunkRefs({x:r.x,y:r.y,width:r.width,height:r.height},signal);if(!refs?.length)throw Error('Missing bitmap chunks');const chunk=await source.getNeighborhoodChunk(refs[0],signal);return{records:chunk.bitmaps.length,url:refs[0].url};})()`);
    assert(chunkProbe.records>0);assert(chunkProbe.url.endsWith('.pb'));
    await evaluate(`state().goToBitmap(${targetHeight})`);
    await wait(`state().loadedBitmaps.has(${targetHeight}) && huffmanRecords>0 && state().source.stats.packsCompleted>0`);
    // A visible bitmap can arrive before the complete pack is committed. Wait for
    // this exact pack in IndexedDB before refreshing.
    await wait(`(async()=>{const cache=state().source.cache;await cache.ready;if(!cache.db)return false;return new Promise(resolve=>{const tx=cache.db.transaction('content','readonly'),request=tx.objectStore('content').get(cache.namespace+':'+${JSON.stringify(targetPack.sha256)});tx.oncomplete=()=>resolve(request.result?.bytes?.length===${targetPack.bytes});tx.onerror=()=>resolve(false);});})()`);
    const first = await evaluate('({huffmanRecords,workerErrors,stats:state().source.stats,loaded:state().loadedBitmaps.size})');
    assert.deepEqual(first.workerErrors, []);
    const beforeReload = requests.filter(p => p.endsWith('/' + targetPackUrl)).length;
    assert(beforeReload > 0);
    await call('Page.reload', { ignoreCache: true }); await initialize();
    await evaluate(`state().goToBitmap(${targetHeight})`);
    await wait(`state().loadedBitmaps.has(${targetHeight}) && huffmanRecords>0 && state().source.stats.cacheBytes>0`);
    const second = await evaluate('({huffmanRecords,workerErrors,stats:state().source.stats,loaded:state().loadedBitmaps.size})');
    assert.deepEqual(second.workerErrors, []);
    assert.equal(requests.filter(p => p.endsWith('/' + targetPackUrl)).length, beforeReload, 'Target pack must be reused after reload');
    assert.equal(exceptions.length, 0, JSON.stringify(exceptions)); assert.deepEqual(failedHttp, []);
    assert(!requests.some(p => p.includes('/api/') || p.includes('socket.io')));
    assert(requests.some(p=>p.endsWith('/' + manifestUrl)));
    assert(!requests.some(p=>p.endsWith('/manifest.pb')||p.endsWith('.nbc')||p.endsWith('.means')));
    const result = { status: 'passed', browser: 'isolated Chrome/SwiftShader', snapshot: manifest.snapshot, format: manifest.format,
        target: targetHeight, targetPack: targetPack.url, first, afterReload: second, cacheNamespace: 'http-pack-cache-v9',
        targetPackRequestsBeforeReload: beforeReload, targetPackRequestsAfterReload: beforeReload,
        colors: ['area', 'size', 'default'], chunkProbe, manifestEncoding:'bitmap-manifest-json-v1', only2D: true, exceptions, failedHttp,
        limitations: 'Functional actual-app test, not device FPS/heap/VRAM performance.' };
    await fs.writeFile(reportFile, JSON.stringify(result, null, 2) + '\n'); console.log(JSON.stringify(result));
} finally { ws?.close(); chrome.kill(); await chrome.exited; server.stop(true); }
