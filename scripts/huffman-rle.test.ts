import { test, expect } from 'bun:test';
import protobuf from 'protobufjs';
import { createHash } from 'node:crypto';
import { encodeHuffmanRle, decodeHuffmanRle, validateHuffmanRle, TX_CODEC_VERSION } from '../src/shared/txHuffmanRle';
import { encodeSizes, encodeAdaptiveSizes, decodeSizes, decodeParcelSizes, HUFFMAN_FORMAT } from '../src/shared/httpPack';
import { createProtoCodec } from '../src/shared/protobufChunks';
import MondrianLayout from '../src/shared/MondrianLayout';
import model from '../src/shared/txHuffmanRleModel.json';

test('frozen Huffman RLE table, known bits, escapes, padding and counts', () => {
    expect(model.version).toBe(TX_CODEC_VERSION);
    expect(createHash('sha256').update(JSON.stringify(model.codes)).digest('hex')).toBe('f4e950584d0282fd5098da0a2351b3eb1cc4110de953b504318e2790ea4f9812');
    for (const [values, bytes] of [ [[2], [0]], [[1], [0x40]], [[2, 3], [0x18]], [[1, 1], [0xa0]], [[1, 1, 1], [0xa8]] ] as const) {
        expect([...encodeHuffmanRle(values).tx]).toEqual([...bytes]);
        expect([...decodeHuffmanRle(Uint8Array.from(bytes), values.length)]).toEqual([...values]);
    }
    for (let value = 1; value <= 9; value++) for (const count of [1, 2, 3, 7, 8, 15, 16, 31, 32, 1024, 11796, 16384]) {
        const sizes = Array(count).fill(value), encoded = encodeHuffmanRle(sizes);
        validateHuffmanRle(encoded.tx, count);
        expect([...decodeHuffmanRle(encoded.tx, count)]).toEqual(sizes);
    }
    const escape = encodeHuffmanRle(Array(50000).fill(9)); expect(escape.escapes).toBe(1);
    expect(decodeHuffmanRle(escape.tx, 50000).every(v => v === 9)).toBe(true);
    expect(() => validateHuffmanRle(new Uint8Array(), 1)).toThrow();
    expect(() => validateHuffmanRle(new Uint8Array([0, 0]), 1)).toThrow();
    expect(() => validateHuffmanRle(new Uint8Array([1]), 1)).toThrow();
    expect(() => validateHuffmanRle(escape.tx.slice(0, -1), 50000)).toThrow();
    expect(() => validateHuffmanRle(new Uint8Array(), 4000001)).toThrow();
});

test('adaptive encoding preserves legacy domain, and typed MondrianLayout matches ordinary arrays', () => {
    const inputs = [[], [1], [10, 15, 9], Array(200).fill(1), Array.from({ length: 1000 }, (_, i) => i % 9 + 1)];
    for (const sizes of inputs) {
        const old = encodeSizes(0, sizes), record = encodeAdaptiveSizes(0, sizes);
        expect(record.tx.length).toBeLessThanOrEqual(old.tx.length);
        expect(decodeSizes(record)).toEqual(sizes);
        const typed = decodeParcelSizes(record);
        expect(new MondrianLayout(typed).slots).toEqual(new MondrianLayout(sizes).slots);
    }
    expect(encodeAdaptiveSizes(0, Array(200).fill(1)).encoding).toBe(4);
    expect(encodeAdaptiveSizes(0, [10, 15]).encoding).toBeUndefined();
});

test('v9 streams authenticated Huffman before EOF, rejects old-header interpretation and corrupted frames', async () => {
    const codec = createProtoCodec(protobuf);
    const records = [encodeAdaptiveSizes(99, Array(200).fill(1)), encodeAdaptiveSizes(0, [15, 10]), encodeAdaptiveSizes(4, Array(70).fill(2))];
    const built = await codec.buildChainedPack(records, -1, 3, 13, 9);
    expect(built.descriptor.format).toBe(HUFFMAN_FORMAT);
    expect(built.descriptor.ids).toEqual([0, 4, 99]);
    for (let cut = 0; cut <= built.wire.length; cut++) {
        async function* stream() { yield built.wire.slice(0, cut); yield built.wire.slice(cut); }
        const decoded = []; for await (const r of codec.parsePack(stream(), built.descriptor)) decoded.push(r);
        expect(decoded).toEqual(records);
    }
    const reader = protobuf.Reader.create(built.wire), frames: Uint8Array[] = [];
    while (reader.pos < reader.len) { const start = reader.pos, n = reader.uint32(); reader.pos += n; frames.push(built.wire.slice(start, reader.pos)); }
    let tailRead = false;
    async function* withheld() { yield frames[0]; yield frames[1]; tailRead = true; for (const f of frames.slice(2)) yield f; }
    const iterator = codec.parsePack(withheld(), built.descriptor);
    expect((await iterator.next()).value).toEqual(records[0]); expect(tailRead).toBe(false); await iterator.return(undefined);
    await expect(codec.buildChainedPack(records, -1, 3, 13, 6)).rejects.toThrow('v9');
    const collect = async (wire: Uint8Array, descriptor = built.descriptor) => { for await (const _ of codec.parsePack((async function* () { yield wire; })(), descriptor)) {} };
    await expect(collect(built.wire, { ...built.descriptor, format: 'bitmap-http-protobuf-v6' })).rejects.toThrow();
    const bad = new Uint8Array(built.wire); bad[bad.length - 1] ^= 1; await expect(collect(bad)).rejects.toThrow();
    await expect(collect(built.wire.slice(0, -1))).rejects.toThrow();
});
