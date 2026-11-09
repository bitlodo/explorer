/** Frozen v1 codec: Huffman(value, log2(run length)) + binary suffix. */
import model from './txHuffmanRleModel.json';
export const TX_CODEC_VERSION = 'tx-huffman-rle-v1-840k-20261029';
export type RunCode = { symbol: number; bits: number; code: string };
const ESCAPE = 288, MAX_TX = 4_000_000, LOOK = 10;
const invalid = (message: string): never => { throw Error(message); };

export function createRunCodec(model: RunCode[]) {
    const widths = new Uint8Array(289), codes = new Uint32Array(289);
    const left: number[] = [-1], right: number[] = [-1], leaves: number[] = [-1];
    for (const row of model) {
        if (row.symbol < 0 || row.symbol > ESCAPE || row.bits < 1 || row.bits > 29 || row.code.length !== row.bits ||
            (row.symbol !== ESCAPE && (row.symbol & 31) > 21)) invalid('Invalid model');
        widths[row.symbol] = row.bits; codes[row.symbol] = parseInt(row.code, 2);
        let node = 0;
        for (const bit of row.code) {
            if (leaves[node] >= 0) invalid('Overlapping code prefix');
            const child = bit === '0' ? left : right;
            if (child[node] < 0) { child[node] = left.length; left.push(-1); right.push(-1); leaves.push(-1); }
            node = child[node];
        }
        if (leaves[node] >= 0 || left[node] >= 0 || right[node] >= 0) invalid('Overlapping code');
        leaves[node] = row.symbol;
    }
    if (!widths[ESCAPE] || left.length >= 32768) invalid('Missing escape or oversized tree');
    const treeLeft = Int16Array.from(left), treeRight = Int16Array.from(right), symbols = Int16Array.from(leaves);
    const table = new Uint16Array(1 << LOOK);
    for (let prefix = 0; prefix < table.length; prefix++) {
        let node = 0, consumed = 0;
        while (symbols[node] < 0 && consumed < LOOK) {
            node = ((prefix >>> (LOOK - 1 - consumed)) & 1) ? treeRight[node] : treeLeft[node]; consumed++;
            if (node < 0) invalid('Incomplete tree');
        }
        table[prefix] = symbols[node] >= 0 ? (consumed << 9) | (symbols[node] + 1) : 0x8000 | node;
    }

    function encode(sizes: ArrayLike<number>) {
        if (sizes.length > MAX_TX) invalid('Oversized transaction list');
        let bits = 0, runs = 0, escapes = 0;
        for (let i = 0; i < sizes.length;) {
            const value = sizes[i];
            if (!Number.isInteger(value) || value < 1 || value > 9) invalid('Unsupported symbol');
            let end = i + 1; while (end < sizes.length && sizes[end] === value) end++;
            const n = end - i, b = 31 - Math.clz32(n), token = (value - 1) * 32 + b;
            if (widths[token]) bits += widths[token] + b;
            else { bits += widths[ESCAPE] + 26; escapes++; }
            i = end; runs++;
        }
        const tx = new Uint8Array(Math.ceil(bits / 8));
        let position = 0;
        const write = (value: number, count: number) => {
            while (count) {
                const space = 8 - (position & 7), take = Math.min(space, count);
                tx[position >>> 3] |= ((value >>> (count - take)) & ((1 << take) - 1)) << (space - take);
                position += take; count -= take;
            }
        };
        for (let i = 0; i < sizes.length;) {
            const value = sizes[i];
            let end = i + 1; while (end < sizes.length && sizes[end] === value) end++;
            const n = end - i, b = 31 - Math.clz32(n), token = (value - 1) * 32 + b;
            if (widths[token]) { write(codes[token], widths[token]); write(n - 2 ** b, b); }
            else { write(codes[ESCAPE], widths[ESCAPE]); write(value, 4); write(n - 1, 22); }
            i = end;
        }
        if (position !== bits) invalid('Encoder bit count mismatch');
        return { tx, bits, runs, escapes };
    }

    function walk(tx: Uint8Array, txCount: number, output?: Uint8Array) {
        if (!Number.isInteger(txCount) || txCount < 0 || txCount > MAX_TX) invalid('Invalid count');
        let cache = 0, available = 0, cursor = 0, consumed = 0, count = 0;
        const read = (bits: number) => {
            if (!bits) return 0;
            while (available < bits) { cache = (cache << 8) | (tx[cursor++] ?? 0); available += 8; }
            available -= bits; consumed += bits;
            return (cache >>> available) & ((1 << bits) - 1);
        };
        while (count < txCount) {
            while (available < LOOK) { cache = (cache << 8) | (tx[cursor++] ?? 0); available += 8; }
            const entry = table[(cache >>> (available - LOOK)) & ((1 << LOOK) - 1)];
            let token: number;
            if (entry & 0x8000) {
                available -= LOOK; consumed += LOOK;
                let node = entry & 0x7fff;
                while (symbols[node] < 0) node = read(1) ? treeRight[node] : treeLeft[node];
                token = symbols[node];
            } else {
                const width = entry >>> 9;
                available -= width; consumed += width; token = (entry & 511) - 1;
            }
            let value: number, length: number;
            if (token === ESCAPE) { value = read(4); length = read(22) + 1; }
            else { value = (token >>> 5) + 1; const b = token & 31; length = (1 << b) + read(b); }
            if (value < 1 || value > 9 || length < 1 || count + length > txCount || consumed > tx.length * 8) invalid('Invalid or truncated run');
            if (output) {
            if (length === 1) output[count] = value;
            else if (length === 2) { output[count] = value; output[count + 1] = value; }
            else if (length <= 16) { const end = count + length; for (let i = count; i < end; i++) output[i] = value; }
            else output.fill(value, count, count + length);
            }
            count += length;
        }
        const padding = tx.length * 8 - consumed;
        if (padding < 0 || padding > 7 || (padding && (tx[tx.length - 1] & ((1 << padding) - 1)))) invalid('Invalid Huffman RLE padding');
        return output;
    }
    const decode = (tx: Uint8Array, count: number) => {
        if (!Number.isInteger(count) || count < 0 || count > MAX_TX) invalid('Invalid count');
        return walk(tx, count, new Uint8Array(count))!;
    };
    const validate = (tx: Uint8Array, count: number) => { walk(tx, count); };
    return { encode, decode, validate, metadata: { lookaheadBits: LOOK, tableEntries: table.length, tableBytes: table.byteLength,
        treeNodes: symbols.length, treeBytes: treeLeft.byteLength + treeRight.byteLength + symbols.byteLength,
        encoderTableBytes: widths.byteLength + codes.byteLength, maxCodeBits: Math.max(...model.map(c => c.bits)) } };
}

const frozenCodec = createRunCodec(model.codes);
export const encodeHuffmanRle = frozenCodec.encode;
export const decodeHuffmanRle = frozenCodec.decode;
export const validateHuffmanRle = frozenCodec.validate;
