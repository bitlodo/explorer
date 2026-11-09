// Real app and snapshot in an isolated source copy; never edits the user's files.
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { clientConfig } from '../vite.config.ts';

const project = fileURLToPath(new URL('../', import.meta.url));
const work = await mkdtemp('/tmp/explorer-vite-browser-');
const root = resolve(work, 'app'), shared = resolve(root, 'src/shared');
const debugPort = Number(process.env.MAP_SMOKE_DEBUG_PORT || 9438);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let dev, cli, chrome, ws, serial = 0, navigations = 0;
const pending = new Map(), exceptions = [], failedHTTP = [];
const cdp = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++serial, timer = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout: ' + method)); }, 20000);
    pending.set(id, message => { clearTimeout(timer); message.error ? reject(Error(JSON.stringify(message.error))) : resolve(message.result); });
    ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async expression => {
    const response = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (response.exceptionDetails) throw Error(JSON.stringify(response.exceptionDetails));
    return response.result.value;
};
const wait = async expression => {
    for (let i = 0; i < 450; i++) { if (await evaluate(expression)) return; await delay(100); }
    throw Error('Condition failed: ' + expression);
};
const bind = () => evaluate(`window.game=()=>{const e=document.getElementById('mapCanvas');if(!e)return;const key=Object.keys(e).find(k=>k.startsWith('__reactFiber$'));for(let f=e[key];f;f=f.return)for(let h=f.memoizedState;h;h=h.next)if(h.memoizedState?.current?.controller)return h.memoizedState.current;};window.state=()=>game()?.controller;`);

try {
    await mkdir(root);
    for (const name of ['src', 'index.html', 'tsconfig.app.json', 'postcss.config.js', 'tailwind.config.ts']) {
        await cp(resolve(project, name), resolve(root, name), { recursive: true });
    }
    // Use the actual public assets; no snapshot middleware or dist is involved.
    await symlink(resolve(project, 'public'), resolve(root, 'public'), 'dir');
    await symlink(resolve(project, 'node_modules'), resolve(work, 'node_modules'), 'dir');
    const config = clientConfig({ base: '/' });
    dev = await createServer({ ...config, configFile: false, root, publicDir: resolve(root, 'public'), cacheDir: resolve(work, '.vite'), mode: 'development',
        resolve: { alias: { '@': resolve(root, 'src'), '@shared': shared } },
        server: { ...config.server, port: Number(process.env.MAP_SMOKE_PORT || 4285), fs: { allow: [work, resolve(project, 'node_modules')] } } });
    await dev.listen();
    chrome = spawn(process.env.MAP_SMOKE_CHROME || '/usr/bin/google-chrome', [
        '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-background-networking',
        '--use-angle=swiftshader', '--enable-unsafe-swiftshader', `--remote-debugging-port=${debugPort}`,
        '--user-data-dir=' + resolve(work, 'chrome'), '--no-first-run', '--no-default-browser-check', 'about:blank',
    ], { stdio: 'ignore' });
    let target;
    for (let i = 0; i < 100; i++) {
        try { target = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: 'PUT' })).json(); break; }
        catch { await delay(100); }
    }
    assert.ok(target, 'Chrome did not start');
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    ws.onmessage = event => {
        const message = JSON.parse(event.data);
        if (message.id) { const callback = pending.get(message.id); pending.delete(message.id); callback?.(message); }
        if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails);
        if (message.method === 'Page.frameNavigated' && !message.params.frame.parentId) navigations++;
        if (message.method === 'Network.responseReceived' && message.params.response.status >= 400) failedHTTP.push(message.params.response.url);
    };
    await cdp('Runtime.enable'); await cdp('Page.enable'); await cdp('Network.enable');
    await cdp('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
    await cdp('Page.navigate', { url: dev.resolvedUrls.local[0] });
    await wait("!!document.getElementById('mapCanvas') && !!document.querySelector('canvas')");
    await bind();
    await wait('state()?.overview?.slots.length===state()?.getState().neighborhoods && state().preview?.rootsReady');
    await evaluate('window.savedGame=game();window.hmrSession="preserved";');
    const before = navigations, appFile = resolve(root, 'src/App.tsx'), app = await readFile(appFile, 'utf8');
    const marker = "className='w-screen h-screen flex flex-col items-center'";
    assert.ok(app.includes(marker));
    await writeFile(appFile, app.replace(marker, marker.slice(0, -1) + " outline-[7px]' data-vite-probe='updated'"));
    await wait("!!document.querySelector('[data-vite-probe]') && getComputedStyle(document.querySelector('[data-vite-probe]')).outlineWidth==='7px'");
    assert.equal(navigations, before, 'React/CSS changes must use HMR');
    assert.equal(await evaluate('hmrSession==="preserved" && game()===savedGame && !savedGame.disposed'), true);
    await writeFile(appFile, app);
    await wait("!document.querySelector('[data-vite-probe]')");

    // Remove/recreate the real canvas through React HMR, in this isolated source copy.
    const withoutCanvas = app.replace('<MapCanvas onReady={setMap} />', '{false && <MapCanvas onReady={setMap} />}');
    assert.notEqual(withoutCanvas, app);
    await evaluate('window.previousRuntime=game();window.previousController=state();void 0');
    await writeFile(appFile, withoutCanvas);
    await wait('previousRuntime.disposed && !document.getElementById("mapCanvas")');
    assert.equal(await evaluate('!previousController.active && previousController.scene.disposed && previousController.source.abort.signal.aborted'), true);
    await writeFile(appFile, app);
    await wait('game() && game()!==previousRuntime && state()?.overview?.slots.length===state()?.getState().neighborhoods && state().preview?.rootsReady');
    await evaluate('window.previousRuntime=game();window.previousController=state();void 0');
    await writeFile(appFile, withoutCanvas);
    await wait('previousRuntime.disposed && !document.getElementById("mapCanvas")');
    assert.equal(await evaluate('!previousController.active && previousController.scene.disposed && previousController.source.abort.signal.aborted'), true);
    await writeFile(appFile, app);
    await wait('game() && game()!==previousRuntime && state()?.overview?.slots.length===state()?.getState().neighborhoods && state().preview?.rootsReady');

    // A changed worker must recreate the live map instead of retaining old jobs.
    const workerFile = resolve(root, 'src/map/workers/neighborhoodBitmapWorker.ts');
    await writeFile(workerFile, (await readFile(workerFile, 'utf8')) + '\n// Vite worker reload probe\n');
    for (let i = 0; i < 450 && navigations === before; i++) await delay(100);
    assert.ok(navigations > before, 'Worker edits must reload the map');
    await wait("!!document.getElementById('mapCanvas') && !!document.querySelector('canvas')");
    await bind();
    await wait('state()?.overview?.slots.length===state()?.getState().neighborhoods && state().preview?.rootsReady');
    await evaluate('state().goToBitmap(308448)');
    await wait('state().loadedBitmaps.has(308448) && state().arrivalFades.opacityFor(308448)===1 && !state().tween?.isPlaying()');
    assert.equal(await evaluate('document.querySelectorAll("#mapCanvas > canvas").length'), 1);

    // Also exercise the real CLI wrapper/config, without changing its sources.
    await cdp('Page.navigate', { url: 'about:blank' });
    await dev.close();
    const port = Number(process.env.MAP_SMOKE_PORT || 4285);
    cli = spawn(process.execPath, ['run', 'dev', '--port', String(port)], { cwd: project, stdio: 'ignore' });
    let ready = false;
    for (let i = 0; i < 100; i++) {
        try { if ((await fetch(`http://127.0.0.1:${port}/`)).ok) { ready = true; break; } } catch {}
        await delay(100);
    }
    assert(ready, 'Native Vite CLI did not start');
    await cdp('Page.navigate', { url: `http://127.0.0.1:${port}/` });
    await wait("!!document.getElementById('mapCanvas') && !!document.querySelector('canvas')");
    await bind(); await wait('state()?.overview?.slots.length===state()?.getState().neighborhoods && state().preview?.rootsReady');
    await evaluate('state().goToBitmap(308448)');
    await wait('state().loadedBitmaps.has(308448) && !state().tween?.isPlaying()');
    assert.deepEqual(exceptions, []);
    assert.deepEqual(failedHTTP, []);
    const result = { status: 'passed', renderer: 'Chrome isolated / SwiftShader', reactAndTailwindHMR: true, lifecycle: { teardown2d: true, teardown3d: true, remount: true },
        enginePreservedDuringHMR: true, workerReload: true, neighborhoods: 416, parcelWorkerBitmap: 308448,
        only2D: true, liveConfig: true, exceptions: 0, failedHTTP: [] };
    if (process.env.MAP_SMOKE_REPORT) await writeFile(process.env.MAP_SMOKE_REPORT, JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify(result));
} catch (error) {
    console.error(error);
    if (ws?.readyState === 1) console.error(await evaluate('document.body.innerText').catch(String));
    process.exitCode = 1;
} finally {
    ws?.close(); chrome?.kill('SIGTERM'); cli?.kill('SIGTERM'); await dev?.close();
    await rm(work, { recursive: true, force: true });
}
