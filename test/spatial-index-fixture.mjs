import { fixture as base, codec } from './neighborhood-dimensions-fixture.mjs';
import { loadShared } from './helpers/load-shared.ts';
const { PAGED_FORMAT, sha256 } = await loadShared('../../src/shared/httpPack.ts');
export async function fixture() {
    const result = await base(), original = structuredClone(result.manifest), groups = new Map();
    const manifest = { ...result.manifest, format: PAGED_FORMAT, chunks: [], indexPages: [], indexPageSide: 8, snapshot: '' };
    for (const chunk of original.chunks) {
        const x = Math.floor(chunk.x / 8), y = Math.floor(chunk.y / 8), key = `${x},${y}`;
        if (!groups.has(key)) groups.set(key, { x, y, chunks: [] });
        groups.get(key).chunks.push(chunk);
    }
    for (const { x, y, chunks } of groups.values()) {
        const bytes = codec.encodeIndexPage(chunks, x, y, manifest), hash = await sha256(bytes), url = hash + '.pb';
        result.files.set(url, bytes); manifest.indexPages.push({ x, y, url, sha256: hash, bytes: bytes.length, chunks: chunks.length, records: chunks.reduce((n, c) => n + c.records, 0) });
    }
    manifest.snapshot = await sha256(codec.encodeManifest(manifest, false)); result.files.set('manifest.pb', codec.encodeManifest(manifest));
    return { ...result, manifest, original };
}
