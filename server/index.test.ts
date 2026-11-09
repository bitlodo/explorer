import {test, expect} from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {startServer} from './index';

test('serves only the selected dist, preserves /repository URLs and handles HEAD and missing files', async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'explorer-static-server-'));
    const dist = path.join(temp, 'dist');
    await fs.mkdir(path.join(dist, 'map-data'), {recursive: true});
    await fs.writeFile(path.join(dist, 'index.html'), '<html>published</html>');
    await fs.writeFile(path.join(dist, 'map-data', 'manifest.pb'), new Uint8Array([1, 2, 3]));
    await fs.writeFile(path.join(temp, 'private.txt'), 'private');
    await fs.symlink(path.join(temp, 'private.txt'), path.join(dist, 'escape.txt'));
    const server = await startServer(dist, 0, '/repository/');
    const base = `http://127.0.0.1:${server.port}`;
    try {
        const redirect = await fetch(base + '/', {redirect: 'manual'});
        expect(redirect.status).toBe(302);
        expect(redirect.headers.get('location')).toBe(base + '/repository/');
        const index = await fetch(base + '/repository/');
        expect(index.status).toBe(200);
        expect(await index.text()).toBe('<html>published</html>');
        const manifest = await fetch(base + '/repository/map-data/manifest.pb');
        expect([...new Uint8Array(await manifest.arrayBuffer())]).toEqual([1, 2, 3]);
        const head = await fetch(base + '/repository/', {method: 'HEAD'});
        expect(head.status).toBe(200);
        expect(await head.text()).toBe('');
        for (const route of ['/src/App.tsx', '/.env', '/repository/missing.bin', '/repository/escape.txt', '/repository/%2e%2e%2fprivate.txt']) {
            expect((await fetch(base + route)).status).toBe(404);
        }
        expect((await fetch(base + '/repository/', {method: 'POST'})).status).toBe(405);
    } finally {
        await server.stop(true);
        await fs.rm(temp, {recursive: true, force: true});
    }
});

test('static startup works with only server files and dist, without project config or installed dependencies', async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'explorer-static-isolated-'));
    let child: ReturnType<typeof Bun.spawn> | undefined;
    try {
        await fs.mkdir(path.join(temp, 'server'));
        await fs.mkdir(path.join(temp, 'dist'));
        for (const name of ['index.ts', 'paths.ts', 'lifecycle.ts','http-cache.ts']) {
            await Bun.write(path.join(temp, 'server', name), Bun.file(new URL(name, import.meta.url)));
        }
        await Bun.write(path.join(temp, 'dist/index.html'), '<html>isolated static site</html>');
        await Bun.write(path.join(temp, 'dist/build-info.json'), JSON.stringify({ base: '/site/' }));
        child = Bun.spawn([process.execPath, '--no-addons', '--no-install', 'server/index.ts'], {
            cwd: temp, env: { ...process.env, PORT: '0', SITE_BASE: '' }, stdout: 'pipe', stderr: 'pipe',
        });
        const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
        const ready = new TextDecoder().decode((await reader.read()).value);
        const url = ready.match(/http:\/\/[^\s]+/)?.[0];
        expect(url).toBeDefined();
        expect(await (await fetch(url!)).text()).toBe('<html>isolated static site</html>');
        child.kill('SIGTERM');
        expect(await child.exited).toBe(0);
        await reader.cancel();
    } finally {
        if (child && child.exitCode === null) { child.kill('SIGKILL'); await child.exited; }
        await fs.rm(temp, { recursive: true, force: true });
    }
}, 10000);
