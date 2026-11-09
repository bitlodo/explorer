#!/usr/bin/env bun
import { createHash } from 'node:crypto';
import { mkdir, open } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { argumentsFor } from './cli';

const MAX_BLOCK_BYTES = 4_000_000;
const MAX_RESPONSE_BYTES = MAX_BLOCK_BYTES * 2 + 128;
const doubleSHA256 = (bytes: Uint8Array) => createHash('sha256').update(createHash('sha256').update(bytes).digest()).digest();
const displayHash = (bytes: Uint8Array) => Buffer.from(bytes).reverse().toString('hex');

class Reader {
    offset = 0;
    constructor(readonly bytes: Buffer) {}
    get remaining() { return this.bytes.length - this.offset; }
    take(length: number): Buffer {
        if (!Number.isSafeInteger(length) || length < 0 || length > this.remaining)
            throw Error(`Truncated block at byte ${this.offset}: requested ${length}, available ${this.remaining}.`);
        const value = this.bytes.subarray(this.offset, this.offset + length);
        this.offset += length;
        return value;
    }
    u32() { return this.take(4).readUInt32LE(); }
    compactSize(): number {
        const prefix = this.take(1)[0];
        if (prefix < 253) return prefix;
        const value = prefix === 253 ? BigInt(this.take(2).readUInt16LE())
            : prefix === 254 ? BigInt(this.u32()) : this.take(8).readBigUInt64LE();
        const minimum = prefix === 253 ? 253n : prefix === 254 ? 65536n : 4294967296n;
        if (value < minimum) throw Error('Non-canonical CompactSize integer.');
        if (value > BigInt(MAX_BLOCK_BYTES)) throw Error('CompactSize exceeds the block resource limit.');
        return Number(value);
    }
    count(minimumBytes: number, label: string): number {
        const count = this.compactSize();
        if (count > Math.floor(this.remaining / minimumBytes)) throw Error(`Invalid ${label} count for remaining block bytes.`);
        return count;
    }
    script() { return this.take(this.compactSize()).toString('hex'); }
}

export interface DecodedInput {
    previousTxid: string;
    outputIndex: number;
    scriptSig: string;
    sequence: number;
    witness: string[];
}

export interface DecodedTransaction {
    index: number;
    txid: string;
    wtxid: string;
    version: number;
    lockTime: number;
    coinbase: boolean;
    segwit: boolean;
    size: number;
    strippedSize: number;
    weight: number;
    vsize: number;
    inputs: DecodedInput[];
    outputs: { index: number; valueSats: string; scriptPubKey: string }[];
}

function transaction(reader: Reader, index: number): DecodedTransaction {
    const start = reader.offset;
    const version = reader.take(4).readInt32LE();
    const segwit = reader.bytes[reader.offset] === 0;
    if (segwit) {
        reader.take(1);
        if (reader.take(1)[0] !== 1) throw Error('Unsupported SegWit transaction flags.');
    }
    const bodyStart = reader.offset, inputs: DecodedInput[] = [];
    const inputCount = reader.count(41, 'input');
    if (!inputCount) throw Error('Transaction must contain inputs.');
    for (let i = 0; i < inputCount; i++) {
        inputs.push({ previousTxid: displayHash(reader.take(32)), outputIndex: reader.u32(),
            scriptSig: reader.script(), sequence: reader.u32(), witness: [] });
    }
    const outputs: DecodedTransaction['outputs'] = [];
    const outputCount = reader.count(9, 'output');
    if (!outputCount) throw Error('Transaction must contain outputs.');
    for (let i = 0; i < outputCount; i++) {
        const value = reader.take(8).readBigInt64LE();
        if (value < 0n) throw Error('Negative transaction output value.');
        outputs.push({ index: i, valueSats: value.toString(), scriptPubKey: reader.script() });
    }
    const bodyEnd = reader.offset;
    if (segwit) {
        let hasWitness = false;
        for (const input of inputs) {
            const count = reader.count(1, 'witness item');
            hasWitness ||= count > 0;
            for (let i = 0; i < count; i++) input.witness.push(reader.script());
        }
        if (!hasWitness) throw Error('Superfluous witness serialization.');
    }
    const lockStart = reader.offset, lockTime = reader.u32();
    const raw = reader.bytes.subarray(start, reader.offset);
    const stripped = segwit ? Buffer.concat([
        reader.bytes.subarray(start, start + 4), reader.bytes.subarray(bodyStart, bodyEnd),
        reader.bytes.subarray(lockStart, reader.offset),
    ]) : raw;
    const txid = displayHash(doubleSHA256(stripped)), size = raw.length, strippedSize = stripped.length;
    const weight = strippedSize * 3 + size;
    return { index, txid, wtxid: segwit ? displayHash(doubleSHA256(raw)) : txid, version, lockTime,
        coinbase: inputs.length === 1 && inputs[0].previousTxid === '0'.repeat(64) && inputs[0].outputIndex === 0xffffffff,
        segwit, size, strippedSize, weight, vsize: Math.ceil(weight / 4), inputs, outputs };
}

function merkleRoot(transactions: DecodedTransaction[]): string {
    let level: Buffer[] = transactions.map(tx => Buffer.from(tx.txid, 'hex').reverse());
    while (level.length > 1) {
        const next: Buffer[] = [];
        for (let i = 0; i < level.length; i += 2)
            next.push(doubleSHA256(Buffer.concat([level[i], level[i + 1] ?? level[i]])));
        level = next;
    }
    return displayHash(level[0]);
}

/** Decode Bitcoin wire serialization. Merkle checking is not full consensus validation. */
export function decodeBlockHex(hex: string) {
    const text = hex.trim();
    if (text.length > MAX_BLOCK_BYTES * 2 || text.length < 162 || text.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(text))
        throw Error('Expected an even-length block hex string of at most 4,000,000 bytes.');
    const reader = new Reader(Buffer.from(text, 'hex'));
    const header = reader.take(80);
    const version = header.readInt32LE(0), previousBlockHash = displayHash(header.subarray(4, 36));
    const expectedMerkleRoot = displayHash(header.subarray(36, 68)), timestamp = header.readUInt32LE(68);
    const bits = header.readUInt32LE(72).toString(16).padStart(8, '0'), nonce = header.readUInt32LE(76);
    const transactionCount = reader.count(60, 'transaction');
    if (!transactionCount) throw Error('Block must contain transactions.');
    let strippedSize = reader.offset;
    const transactions: DecodedTransaction[] = [];
    for (let i = 0; i < transactionCount; i++) {
        const tx = transaction(reader, i);
        transactions.push(tx); strippedSize += tx.strippedSize;
    }
    if (reader.remaining) throw Error(`Unexpected ${reader.remaining} trailing block bytes.`);
    if (merkleRoot(transactions) !== expectedMerkleRoot) throw Error('Transaction Merkle root does not match the block header.');
    const size = reader.bytes.length, weight = strippedSize * 3 + size;
    if (weight > MAX_BLOCK_BYTES) throw Error('Block weight exceeds 4,000,000 weight units.');
    return { hash: displayHash(doubleSHA256(header)), version, previousBlockHash, merkleRoot: expectedMerkleRoot,
        timestamp, timestampISO: new Date(timestamp * 1000).toISOString(), bits, nonce,
        size, strippedSize, weight, transactionCount, merkleRootVerified: true, transactions };
}

/** Ordinals returns a JSON string; local input may also contain plain hex. */
export function blockHexResponse(text: string): string {
    const trimmed = text.trim(), value: unknown = trimmed.startsWith('"') ? JSON.parse(trimmed) : trimmed;
    if (typeof value !== 'string') throw Error('Expected block hex or a JSON string containing block hex.');
    return value;
}

export async function fetchBlockHex(url: string): Promise<string> {
    const response = await fetch(url, { signal: AbortSignal.timeout(60_000), headers: { Accept: 'application/json, text/plain' } });
    if (!response.ok) { await response.body?.cancel(); throw Error(`Block request failed: HTTP ${response.status} (${url}).`); }
    if (!response.body) throw Error('Empty block response.');
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let length = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            length += value.length;
            if (length > MAX_RESPONSE_BYTES) throw Error('Block hex response exceeds the resource limit.');
            chunks.push(value);
        }
    } finally { await reader.cancel(); }
    return blockHexResponse(Buffer.concat(chunks).toString('utf8'));
}

export async function decodeBlockCommand(args: string[]) {
    const options = argumentsFor(args, ['--block', '--url', '--input', '--out']);
    if (options['--input'] && (options['--block'] || options['--url'])) throw Error('Use --input or --block/--url, not both.');
    if (options['--url'] && options['--block']) throw Error('Use --block or --url, not both.');
    const block = options['--block'] || '840000';
    if (!/^(?:0|[1-9][0-9]{0,9}|[0-9a-fA-F]{64})$/.test(block) || (block.length !== 64 && Number(block) > 0xffffffff))
        throw Error('--block must be a nonnegative block height or a 64-character block hash.');
    const url = options['--url'] || `https://ordinals.com/r/block/${block}`;
    const source = options['--input'] ? { file: resolve(options['--input']) } : { url };
    let hex: string;
    if (options['--input']) {
        const file = Bun.file(options['--input']);
        if (file.size > MAX_RESPONSE_BYTES) throw Error('Input block hex exceeds the resource limit.');
        hex = blockHexResponse(await file.text());
    } else hex = await fetchBlockHex(url);
    const decoded = decodeBlockHex(hex);
    if (!options['--input'] && !options['--url'] && block.length === 64 && decoded.hash !== block.toLowerCase())
        throw Error('Decoded block hash differs from the requested hash.');
    const json = JSON.stringify({ source, ...decoded }, null, 2) + '\n';
    if (options['--out']) {
        const out = resolve(options['--out']);
        await mkdir(dirname(out), { recursive: true });
        const file = await open(out, 'wx');
        try { await file.writeFile(json); } finally { await file.close(); }
        console.error(`Decoded ${decoded.hash}: ${decoded.transactionCount} transactions → ${out}`);
    } else await Bun.write(Bun.stdout, json);
    return decoded;
}

if (import.meta.main) {
    try { await decodeBlockCommand(process.argv.slice(2)); }
    catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }
}
