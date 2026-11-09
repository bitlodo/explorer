import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rename, rm, symlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import { clientConfig } from '../vite.config';

test('Vite serves current map bytes after atomic dataset replacement even when its public index cannot observe the swap', async () => {
    const temp = await mkdtemp('/tmp/bitmap-vite-map-data-');
    let dev: Awaited<ReturnType<typeof createServer>> | undefined;
    try {
        const publicDir = resolve(temp, 'public'), data = resolve(publicDir, 'map-data');
        const staging = resolve(temp, '.cache/maintenance/revision/map-data'), previous = resolve(temp, '.cache/maintenance/previous');
        await mkdir(data, { recursive: true });
        await Bun.write(resolve(temp, 'index.html'), '<!doctype html><p>Application HTML fallback</p>');
        await Bun.write(resolve(data, 'manifest.json'), '{"revision":"old"}');
        await Bun.write(resolve(data, 'old.pb'), new Uint8Array([8, 1]));
        const config = clientConfig({ base: '/site/' });
        dev = await createServer({ ...config, configFile: false, root: temp, publicDir, cacheDir: resolve(temp, '.vite'),
            server: { ...config.server, port: 0, watch: { ...config.server?.watch,
                ignored: [...config.server?.watch?.ignored as string[], '**/public/map-data/**'] } } });
        await dev.listen();
        const origin = dev.resolvedUrls!.local[0], url = (name: string) => origin + 'map-data/' + name;
        expect([...await (await fetch(url('old.pb'))).bytes()]).toEqual([8, 1]);

        await Bun.write(resolve(staging, 'manifest.json'), '{"revision":"new"}');
        const page = new Uint8Array([8, 2, 18, 2, 1, 2]), chunk = new Uint8Array([8, 2, 24, 128, 1]);
        await Bun.write(resolve(staging, 'bitmap-chunks/new-page.pb'), page);
        await Bun.write(resolve(staging, 'previews/new-preview.pb'), chunk);
        await rename(data, previous);
        // The generator's replacement window must produce 404, never HTML with 200.
        expect((await fetch(url('manifest.json'))).status).toBe(404);
        await rename(staging, data);

        const gzip=await fetch(url('manifest.json'),{headers:{'Accept-Encoding':'gzip'}});
        expect(gzip.headers.get('content-encoding')).toBe('gzip');expect(await gzip.json()).toEqual({revision:'new'});
        const identity=await fetch(url('manifest.json'),{headers:{'Accept-Encoding':'identity'}});
        expect(identity.headers.get('content-encoding')).toBeNull();expect(await identity.json()).toEqual({revision:'new'});
        expect(identity.headers.get('etag')).not.toBe(gzip.headers.get('etag'));
        const unchanged=await fetch(url('manifest.json'),{headers:{'Accept-Encoding':'gzip','If-None-Match':gzip.headers.get('etag')!}});expect(unchanged.status).toBe(304);
        expect(unchanged.headers.get('content-encoding')).toBe('gzip');
        for (const [name, bytes] of [['bitmap-chunks/new-page.pb', page], ['previews/new-preview.pb', chunk]] as const) {
            const response = await fetch(url(name));
            expect(response.status).toBe(200);
            expect(response.headers.get('content-type')).toBe('application/octet-stream');
            expect(response.headers.get('content-length')).toBe(String(bytes.length));
            expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
            const head = await fetch(url(name), { method: 'HEAD' });
            expect(head.status).toBe(200); expect(head.headers.get('content-length')).toBe(String(bytes.length));
            expect((await head.bytes()).length).toBe(0);
        }
        for (const name of ['old.pb', 'missing.pb', 'bitmap-chunks/missing.pb', 'previews/missing.pb']) {
            for (const accept of ['*/*', 'text/html', 'application/octet-stream']) {
                const missing = await fetch(url(name), { headers: { Accept: accept } });
                expect(missing.status).toBe(404);
                expect(missing.headers.get('content-type')).not.toContain('text/html');
            }
        }
        const privateFile = resolve(temp, 'data/db/private.db');
        await Bun.write(privateFile, 'private database');
        await symlink(privateFile, resolve(data, 'leak.pb'));
        expect((await fetch(url('leak.pb'))).status).toBe(404);
        expect((await fetch(url('%2e%2e%2fdata/db/private.db'))).status).toBe(404);
        expect((await fetch(url('manifest.json'), { method: 'POST' })).status).toBe(405);
        expect((await fetch(url('manifest.json') + '?refresh=1')).status).toBe(200);
        expect(await (await fetch(origin + 'ordinary-client-route')).text()).toContain('Application HTML fallback');
    } finally { await dev?.close(); await rm(temp, { recursive: true, force: true }); }
}, 15000);
