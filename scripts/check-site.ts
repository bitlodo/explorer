#!/usr/bin/env bun
import { decodeMapManifest } from '../src/shared/mapManifest';
import {decodeRelease} from '../src/shared/mapRelease';
import { supportsFormat,sha256 } from '../src/shared/httpPack';
import { startServer, serverBase } from '../server/index';

const directory = process.argv[2];
const server = await startServer(directory, 0);
const url = `http://127.0.0.1:${server.port}${await serverBase(directory)}`;
try {
    const index = await fetch(url), html = await index.text();
    if (!index.ok || !html.includes('assets/')) throw new Error('Static entry failed.');
    let entry:'manifest.json'|'manifest.pb'='manifest.json';
    const pinned=html.match(/<meta name="bitmap-release" content="(releases\/[a-f0-9]{64}\.json)">/)?.[1];
    let path='map-data/'+entry,expected:{bytes:number;sha256:string}|undefined;
    if(pinned){const response=await fetch(new URL('map-data/'+pinned,url));if(!response.ok)throw Error('Pinned release unavailable');
        const release=await decodeRelease(new Uint8Array(await response.arrayBuffer()),pinned.split('/')[1].slice(0,64));
        entry=release.roots['manifest.json']?'manifest.json':'manifest.pb';const ref=release.roots[entry];expected=ref;path='map-data/'+ref.url;
    }
    let manifest=await fetch(new URL(path,url));
    if(!pinned&&manifest.status===404){entry='manifest.pb';manifest=await fetch(new URL('map-data/'+entry,url));}
    const bytes=new Uint8Array(await manifest.arrayBuffer());
    if(!manifest.ok||(expected&&(bytes.length!==expected.bytes||await sha256(bytes)!==expected.sha256))||!supportsFormat((await decodeMapManifest(bytes,entry)).format))throw Error('Snapshot manifest failed.');
    const missing = await fetch(new URL('missing.bin', url));
    if (missing.status !== 404) throw new Error('Missing artifact must return 404.');
    const head = await fetch(url, { method: 'HEAD' });
    if (!head.ok || (await head.text()) !== '') throw new Error('HEAD failed.');
    console.log('Bun static site verified: entry, manifest, HEAD and 404.');
} finally { await server.stop(true); }
