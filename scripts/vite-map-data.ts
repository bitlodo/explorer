import { artifactHeaders } from '../server/http-cache';
import { open, realpath } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { extname, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Plugin } from 'vite';

/** Read the current dataset directly; Vite's public-file index can outlive an atomic generation swap. */
export function mapDataAssets(): Plugin {
    return {
        name: 'bitmap-map-data',
        apply: 'serve',
        configureServer(server) {
            const publicDir = server.config.publicDir;
            if (!publicDir) return;
            const base = new URL(server.config.base, 'http://vite.local').pathname;
            const mount = base.replace(/\/?$/, '/') + 'map-data/';
            server.middlewares.use((request, response, next) => {
                const pathname = (request.url ?? '/').split('?')[0];
                if (pathname !== mount.slice(0, -1) && !pathname.startsWith(mount)) return next();
                if (request.method !== 'GET' && request.method !== 'HEAD') {
                    response.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain' }).end('Method not allowed'); return;
                }
                void (async () => {
                    let file: Awaited<ReturnType<typeof open>> | undefined;
                    try {
                        const publicRoot = await realpath(publicDir), root = resolve(publicRoot, 'map-data');
                        if (await realpath(root) !== root) throw Error('Dataset root must not be a symlink.');
                        const filename = await realpath(resolve(root, decodeURIComponent(pathname.slice(mount.length))));
                        if (!filename.startsWith(root + sep)) throw Error('Artifact escapes the dataset.');
                        const extension = extname(filename);
                        if (!['.json', '.pb', '.bin', '.nbc', '.means'].includes(extension)) throw Error('Not a map artifact.');
                        file = await open(filename, 'r');
                        const info = await file.stat();
                        if (!info.isFile()) throw Error('Not a regular map artifact.');
                        const acceptsGzip=/(?:^|,)\s*gzip(?:\s*;\s*q=(?!0(?:\.0*)?(?:,|$))[\d.]+)?\s*(?:,|$)/i.test(request.headers['accept-encoding']||'');
                        // Source development has the same compressed JSON delivery as built sites.
                        // Binary spatial payloads remain small by construction, independently of compression.
                        const compressed=extension==='.json'&&acceptsGzip&&info.size<=2*1024*1024?gzipSync(await file.readFile()):undefined;
                        const cache={...artifactHeaders(filename,compressed?.length??info.size,info.mtimeMs,compressed?'gzip':undefined),...(compressed?{'Content-Encoding':'gzip'}:{})};
                        if(request.headers['if-none-match']?.split(/\s*,\s*/).some(tag=>tag==='*'||tag===cache.ETag)){response.writeHead(304,cache).end();return;}
                        response.writeHead(200, {
                            ...server.config.server.headers,
                            'Content-Type': extension === '.json' ? 'application/json; charset=utf-8' : 'application/octet-stream',
                            'Content-Length': String(compressed?.length??info.size), ...cache,
                        });
                        if (request.method === 'HEAD') response.end();
                        else if(compressed)response.end(compressed);
                        else await pipeline(file.createReadStream({ autoClose: false }), response);
                    } catch (error) {
                        if (response.headersSent) response.destroy(error instanceof Error ? error : undefined);
                        else response.writeHead(404, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-cache' }).end('Map data not found');
                    } finally { await file?.close(); }
                })();
            });
        },
    };
}
