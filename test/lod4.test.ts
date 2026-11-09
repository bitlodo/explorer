import { expect, test } from 'bun:test';
import protobuf from 'protobufjs';
import descriptor from '../src/shared/proto/lod4_descriptor.json';
import { sha256 } from '../src/shared/httpPack';
import { buildLod4Region, decodeLod4Index, decodeLod4Region, encodeLod4Index, encodeLod4Region,
    LOD4_FORMAT, lod4CellBounds, validateLod4Region, type Lod4Index, type Lod4Shape } from '../src/shared/lod4';
const geometryHash = '0'.repeat(64), sourceSnapshot = '1'.repeat(64);

async function indexFor(region: ReturnType<typeof buildLod4Region>, side: number) {
    const bytes = encodeLod4Region(region, side);
    const index: Lod4Index = { version: 1, format: LOD4_FORMAT, sourceSnapshot, gridSide: side,
        bitmapCount: region.bitmapAreas.length, regions: [{ id: region.id, width: region.width, height: region.height,
            bitmapCount: region.bitmapAreas.length, geometrySha256: geometryHash, bytes: bytes.length, sha256: await sha256(bytes) }] };
    return { bytes, index };
}

function memberships(region: ReturnType<typeof buildLod4Region>, cell: number) {
    const result: [number, number][] = []; let bitmap = 0;
    for (let i = region.cellOffsets[cell]; i < region.cellOffsets[cell + 1]; i++) {
        bitmap += region.memberDeltas[i]; result.push([bitmap, region.overlapAreas[i]]);
    }
    return result;
}

test('LOD4 descriptor matches the documented Protobuf schema and an independent wire fixture', async () => {
    const parsed = protobuf.parse(await Bun.file('src/shared/proto/lod4.proto').text()).root.toJSON();
    expect(parsed).toEqual(descriptor);
    const region = buildLod4Region({ neighborhood: 0, width: 2, height: 1,
        bitmaps: [{ x: 0, y: 0, width: 1, height: 1 }, { x: 1, y: 0, width: 1, height: 1 }] }, geometryHash, 2);
    const wire = Uint8Array.of(8,1,16,0,24,2,32,1,40,2,48,1,58,64,...new TextEncoder().encode(geometryHash),
        66,2,1,1,74,3,0,1,2,82,2,0,1,90,2,1,1);
    expect(encodeLod4Region(region, 2)).toEqual(wire);
    const { index } = await indexFor(region, 2);
    const rootWire = encodeLod4Index(index), decoded = await decodeLod4Index(rootWire, sourceSnapshot, await sha256(rootWire));
    expect(await decodeLod4Region(wire, decoded.regions[0], decoded)).toEqual(region);
});

test('cross-cell membership conserves each bitmap instead of multiplying its analytical weight', () => {
    const region = buildLod4Region({ neighborhood: 0, width: 8, height: 8,
        bitmaps: [{ x: 0, y: 0, width: 8, height: 8 }] }, geometryHash, 2);
    expect(region.overlapAreas).toEqual([16,16,16,16]);
    expect(region.memberDeltas).toEqual([0,0,0,0]);
    expect(region.overlapAreas.reduce((sum,area)=>sum+area/region.bitmapAreas[0],0)).toBe(1);
    const sparse = buildLod4Region({ neighborhood: 0, width: 16, height: 16,
        bitmaps: [{ x: 0, y: 0, width: 1, height: 1 }, { x: 8, y: 8, width: 8, height: 8 }] }, geometryHash, 2);
    expect(sparse.cellOffsets).toEqual([0,1,1,1,2]);
    expect(memberships(sparse,0)).toEqual([[0,1]]);
    expect(memberships(sparse,3)).toEqual([[1,64]]);
});

test('integer grid intersections agree with exhaustive geometry at uneven boundaries and thin regions', () => {
    for (const [width,height] of [[31,23],[17,19],[1,65],[65,1],[2,2],[97,101]]) {
        const bitmaps: Lod4Shape['bitmaps'] = [];
        for (let y = 0; y < height; y += 7) for (let x = 0; x < width; x += 5) {
            if ((x+y)%3) bitmaps.push({ x, y, width: Math.min(5,width-x), height: Math.min(7,height-y) });
        }
        if (!bitmaps.length) bitmaps.push({ x:0,y:0,width,height });
        const region = buildLod4Region({ neighborhood:0,width,height,bitmaps },geometryHash);
        for (let cell = 0; cell < region.columns*region.rows; cell++) {
            const b=lod4CellBounds(region,cell),expected: [number,number][]=[];
            bitmaps.forEach((r,id)=>{
                const w=Math.max(0,Math.min(r.x+r.width,b.x+b.width)-Math.max(r.x,b.x));
                const h=Math.max(0,Math.min(r.y+r.height,b.y+b.height)-Math.max(r.y,b.y));
                if(w*h)expected.push([id,w*h]);
            });
            expect(memberships(region,cell)).toEqual(expected);
        }
    }
});

test('LOD4 rejects corrupt hashes, wrong snapshots, lost area, duplicate IDs and excessive dimensions', async () => {
    const region=buildLod4Region({neighborhood:0,width:8,height:8,bitmaps:[{x:0,y:0,width:8,height:8}]},geometryHash,2);
    const {bytes,index}=await indexFor(region,2);
    const corrupt=bytes.slice();corrupt[0]^=1;
    expect(decodeLod4Region(corrupt,index.regions[0],index)).rejects.toThrow(/integrity/);
    expect(decodeLod4Index(encodeLod4Index(index),'2'.repeat(64))).rejects.toThrow(/snapshot/);
    const missing=structuredClone(region);missing.overlapAreas[0]--;
    expect(()=>validateLod4Region(missing,2)).toThrow(/conserve/);
    const outOfOrder=structuredClone(region);outOfOrder.memberDeltas[0]=1;
    expect(()=>validateLod4Region(outOfOrder,2)).toThrow();
    expect(()=>buildLod4Region({neighborhood:0,width:65536,height:1,bitmaps:[]},geometryHash)).toThrow();
    const overlap=()=>buildLod4Region({neighborhood:0,width:1,height:1,bitmaps:[{x:0,y:0,width:1,height:1},{x:0,y:0,width:1,height:1}]},geometryHash);
    expect(overlap).toThrow(/coverage/);
});
