import {test,expect} from 'bun:test';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {gzipSync,gunzipSync} from 'node:zlib';
import {staticHandler} from './index';
test('immutable hashes validate conditionally and precompressed responses preserve canonical bytes',async()=>{
    const root=await mkdtemp('/tmp/map-http-cache-');
    try{
        const bytes=Buffer.from('immutable payload '.repeat(100)),hash=createHash('sha256').update(bytes).digest('hex'),name=`map-data/parcels/${hash}.pb`;
        await mkdir(resolve(root,'map-data/parcels'),{recursive:true});await writeFile(resolve(root,name),bytes);await writeFile(resolve(root,name+'.gz'),gzipSync(bytes));await writeFile(resolve(root,'map-data/manifest.json'),'{}');
        const serve=await staticHandler(root),request=(headers:HeadersInit={})=>new Request('https://map.test/'+name,{headers});
        const plain=await serve(request());expect(plain.headers.get('cache-control')).toContain('immutable');expect(plain.headers.get('etag')).toBe(`"${hash}"`);expect(new Uint8Array(await plain.arrayBuffer())).toEqual(new Uint8Array(bytes));
        expect((await serve(request({'if-none-match':`"${hash}"`}))).status).toBe(304);
        const compressed=await serve(request({'accept-encoding':'gzip'}));expect(compressed.headers.get('content-encoding')).toBe('gzip');expect(compressed.headers.get('vary')).toBe('Accept-Encoding');expect(gunzipSync(Buffer.from(await compressed.arrayBuffer()))).toEqual(bytes);
        expect((await serve(request({'accept-encoding':'gzip;q=0'}))).headers.get('content-encoding')).toBe(null);
        expect((await serve(new Request('https://map.test/map-data/manifest.json'))).headers.get('cache-control')).toBe('no-cache');
    }finally{await rm(root,{recursive:true,force:true});}
});
