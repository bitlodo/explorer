#!/usr/bin/env bun
import { artifactHeaders } from './http-cache';
import { realpath, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { distRoot, siteBase } from './paths';
import { shutdownOnSignal } from './lifecycle';

export async function staticHandler(directory: string, base = siteBase()) {
    const root = await realpath(resolve(directory));
    return async (request: Request): Promise<Response> => {
        if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
        try {
            const pathname = decodeURIComponent(new URL(request.url).pathname);
            if (base !== '/' && (pathname === '/' || pathname === base.slice(0, -1))) return Response.redirect(new URL(base, request.url), 302);
            if (!pathname.startsWith(base)) return new Response('Not found', { status: 404 });
            let filename = resolve(root, pathname.slice(base.length) || 'index.html');
            if (!filename.startsWith(root + sep)) return new Response('Not found', { status: 404 });
            if ((await stat(filename)).isDirectory()) filename = resolve(filename, 'index.html');
            filename = await realpath(filename);
            if (!filename.startsWith(root + sep) || !(await stat(filename)).isFile()) return new Response('Not found', { status: 404 });
            const original=Bun.file(filename);let file=original,encoding:string|undefined;
            if(/(?:^|,)\s*gzip(?:\s*;\s*q=(?!0(?:\.0*)?(?:,|$))[\d.]+)?\s*(?:,|$)/i.test(request.headers.get('accept-encoding')||'')){
                const compressed=await realpath(filename+'.gz').catch(()=>undefined);
                if(compressed?.startsWith(root+sep)){file=Bun.file(compressed);encoding='gzip';}
            }
            const headers=artifactHeaders(filename,file.size,(await stat(filename)).mtimeMs,encoding);
            if(request.headers.get('if-none-match')?.split(/\s*,\s*/).some(tag=>tag==='*'||tag===headers.ETag))return new Response(null,{status:304,headers});
            return new Response(request.method === 'HEAD' ? null : file, { headers: { ...headers,'Content-Type':original.type,'Content-Length':String(file.size),...(encoding?{'Content-Encoding':encoding}:{}) } });
        } catch { return new Response('Not found', { status: 404 }); }
    };
}

export async function serverBase(directory = distRoot, override?: string) {
    const info = Bun.file(resolve(directory, 'build-info.json'));
    const recorded: { base?: string } = await info.exists() ? await info.json() : {};
    return siteBase(override || process.env.SITE_BASE || recorded.base);
}

export async function startServer(directory = distRoot, port = Number(process.env.PORT || 4174), overrideBase?: string) {
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid PORT.');
    if (!await Bun.file(resolve(directory, 'index.html')).exists()) throw new Error('Prepared site missing. Run bun run build first.');
    const base = await serverBase(directory, overrideBase), content = await staticHandler(directory, base);
    return Bun.serve({
        hostname: process.env.HOST || '127.0.0.1',
        port,
        development: false,
        async fetch(request) {
            const started = performance.now();
            const response = await content(request);
            const size = request.method === 'HEAD' ? '0' : (response.headers.get('Content-Length') || '-');
            console.log(`${new Date().toISOString()} ${request.method} ${JSON.stringify(new URL(request.url).pathname)} ${response.status} ${size} B ${(performance.now() - started).toFixed(1)} ms`);
            return response;
        },
    });
}

if (import.meta.main) {
    const server = await startServer(process.argv[2]);
    shutdownOnSignal(() => server.stop(true));
    console.log(`Static map: http://${server.hostname}:${server.port}${await serverBase(process.argv[2])}\nPress Ctrl+C to stop.`);
}
