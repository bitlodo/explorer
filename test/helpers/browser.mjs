import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import protobuf from 'protobufjs';
import {datasetPath} from '../../scripts/dataset-path.ts';
import { readMapManifest } from '../../scripts/read-map-manifest.ts';
import { createProtoCodec } from '../../src/shared/protobufChunks.ts';

export const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Shared static fixture server and isolated Chrome session for map regressions. */
export async function browserHarness(options={}) {
    const port = Number(process.env.MAP_SMOKE_PORT || 4323);
    const debugPort = Number(process.env.MAP_SMOKE_DEBUG_PORT || 9351);
    const origin = `http://127.0.0.1:${port}`;
    const dist = path.resolve(options.development?'.':process.env.MAP_SMOKE_BUILD_DIR || 'dist');
    const snapshot = path.resolve(process.env.MAP_SMOKE_SNAPSHOT || (options.development?'public/map-data':path.join(dist, 'map-data')));
    const manifest = (await readMapManifest(snapshot)).manifest;
    const codec = createProtoCodec(protobuf);
    // Fixture selection is offline; the browser still loads index pages lazily.
    for (const ref of manifest.indexPages || []) {
        manifest.chunks.push(...codec.decodeIndexPage(fs.readFileSync(datasetPath(snapshot, ref.url)), ref, manifest));
    }
    const parcelFiles = new Set(manifest.chunks.flatMap(chunk => chunk.packs.map(pack => pack.url)));
    const requests = [], errors = [], pending = new Map();
    const require = createRequire(import.meta.url);
    let chrome, ws, profile, serial = 0;
    const front = http.createServer((req, res) => {
        const url = new URL(req.url, origin);
        requests.push(url.pathname);
        if (url.pathname === '/test-three.js') {
            res.setHeader('Content-Type', 'application/javascript');
            res.end(fs.readFileSync(path.join(path.dirname(require.resolve('three')), 'three.module.js')));
            return;
        }
        if (url.pathname.endsWith('/missing.bin')) { res.writeHead(404).end(); return; }
        if (url.pathname.endsWith('/limited.bin')) { res.writeHead(429).end(); return; }
        try {
            // Review builds may use the repository base or the normal root base.
            // Keep aliases limited to the static client and dataset mounts.
            assert.ok(url.pathname.startsWith('/repository/')||url.pathname.startsWith('/assets/')||url.pathname.startsWith('/map-data/'));
            const relative = (url.pathname.startsWith('/repository/')?url.pathname.slice('/repository/'.length):url.pathname.slice(1)) || 'index.html';
            const isData = relative.startsWith('map-data/');
            const base = isData ? snapshot : dist, name = isData ? relative.slice(9) : relative;
            const file = path.resolve(base, name);
            assert.ok(file.startsWith(base + path.sep));
            const bytes = fs.readFileSync(file);
            const types = { '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.html': 'text/html' };
            res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
            res.setHeader('Content-Length', bytes.length);
            const progressDelay = Number(process.env.MAP_SHUFFLE_PROGRESS_DELAY_MS || 0);
            if (progressDelay && isData && parcelFiles.has(name)) {
                let offset = 0;
                const timer = setInterval(() => {
                    const end = Math.min(bytes.length, offset + 4096);
                    res.write(bytes.subarray(offset, end)); offset = end;
                    if (offset === bytes.length) { clearInterval(timer); res.end(); }
                }, progressDelay);
                res.once('close', () => clearInterval(timer));
                return;
            }
            const tileDelay = Number(process.env.MAP_LOD_TILE_DELAY_MS || 0);
            if (tileDelay && isData && name.endsWith('.pb') && name !== 'manifest.pb') {
                const timer = setTimeout(() => res.end(bytes), tileDelay + (parseInt(path.basename(name)[0], 16) || 0) * 3);
                res.once('close', () => clearTimeout(timer));
            } else res.end(bytes);
        } catch (error) { res.writeHead(404).end(String(error.message)); }
    });
    const cdp = (method, params = {}) => new Promise((resolve, reject) => {
        const id = ++serial;
        const timer = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout: ' + method)); }, 15000);
        pending.set(id, { timer, resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async expression => {
        const result = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
        if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails));
        return result.result.value;
    };
    const wait = async expression => {
        for (let i = 0; i < 600; i++) { if (await evaluate(expression)) return; await delay(100); }
        throw Error('Condition failed: ' + expression);
    };
    return {
        origin, dist, snapshot, manifest, requests, errors, cdp, evaluate, wait, delay,
        frame: () => evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))'),
        async start() {
            assert.ok(fs.existsSync(path.join(dist, 'index.html')), 'Build with --base /repository/ first');
            await new Promise((resolve, reject) => front.once('error', reject).listen(port, '127.0.0.1', resolve));
            profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bitmap-browser-'));
            chrome = spawn(process.env.MAP_SMOKE_CHROME || '/usr/bin/google-chrome', [
                '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-background-networking',
                '--use-angle=swiftshader', '--enable-unsafe-swiftshader', `--remote-debugging-port=${debugPort}`,
                '--user-data-dir=' + profile, '--no-first-run', '--no-default-browser-check', 'about:blank',
            ], { stdio: 'ignore' });
            let launchError;
            chrome.on('error', error => { launchError = error; });
            let target;
            for (let i = 0; i < 100; i++) {
                if (launchError) throw launchError;
                try { target = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: 'PUT' })).json(); break; }
                catch { await delay(100); }
            }
            assert.ok(target, 'Chrome did not start');
            ws = new WebSocket(target.webSocketDebuggerUrl);
            await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
            ws.onmessage = event => {
                const message = JSON.parse(event.data);
                if (message.id) {
                    const call = pending.get(message.id); pending.delete(message.id);
                    if (call) {
                        clearTimeout(call.timer);
                        if (message.error) call.reject(Error(JSON.stringify(message.error))); else call.resolve(message.result);
                    }
                }
                if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails);
            };
            await cdp('Runtime.enable'); await cdp('Page.enable');
            return ws;
        },
        async close() {
            ws?.close();
            for (const call of pending.values()) { clearTimeout(call.timer); call.reject(Error('Browser closed')); }
            pending.clear();
            if (chrome && chrome.exitCode === null && !chrome.signalCode && chrome.pid) {
                const exited = new Promise(resolve => chrome.once('exit', resolve));
                chrome.kill('SIGTERM'); await exited;
            }
            front.closeAllConnections();
            await new Promise(resolve => front.close(resolve));
            if (profile) fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        },
    };
}
