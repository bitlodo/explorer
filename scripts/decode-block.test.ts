import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import fixtures from '../test/fixtures/bitcoin-blocks.json';
import { blockHexResponse, decodeBlockCommand, decodeBlockHex, fetchBlockHex } from './decode-block';

const { genesis, mixed, expectedMixed } = fixtures;

test('decodes the public genesis block, header byte order and coinbase transaction', () => {
    const block = decodeBlockHex(genesis);
    expect(block.hash).toBe('000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f');
    expect(block.previousBlockHash).toBe('0'.repeat(64));
    expect(block.merkleRoot).toBe('4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b');
    expect(block.timestampISO).toBe('2009-01-03T18:15:05.000Z');
    expect(block.bits).toBe('1d00ffff'); expect(block.nonce).toBe(2083236893);
    expect(block.size).toBe(285); expect(block.strippedSize).toBe(285); expect(block.weight).toBe(1140);
    expect(block.transactionCount).toBe(1); expect(block.merkleRootVerified).toBe(true);
    const tx = block.transactions[0];
    expect(tx.txid).toBe(block.merkleRoot); expect(tx.wtxid).toBe(tx.txid);
    expect(tx.coinbase).toBe(true); expect(tx.segwit).toBe(false);
    expect(tx.inputs[0].outputIndex).toBe(0xffffffff); expect(tx.inputs[0].witness).toEqual([]);
    expect(tx.outputs[0].valueSats).toBe('5000000000');
    expect(tx.outputs[0].scriptPubKey).toStartWith('4104678afd');
});

test('mixed legacy/SegWit fixture preserves order, exact integers, odd Merkle branches and stripped hashes', () => {
    const block = decodeBlockHex(mixed);
    expect(block.hash).toBe(expectedMixed.hash); expect(block.merkleRoot).toBe(expectedMixed.merkleRoot);
    expect(block.size).toBe(expectedMixed.size); expect(block.strippedSize).toBe(expectedMixed.strippedSize);
    expect(block.weight).toBe(1076); expect(block.transactions.map(tx => tx.index)).toEqual([0, 1, 2]);
    expect(block.transactions.map(tx => tx.txid)).toEqual(expectedMixed.txids);
    const tx = block.transactions[0];
    expect(tx.wtxid).toBe(expectedMixed.wtxid); expect(tx.wtxid).not.toBe(tx.txid);
    expect(tx.segwit).toBe(true); expect(tx.inputs[0].witness).toEqual(['010203', '']);
    // Deliberately outside monetary consensus limits to test lossless wire decoding.
    expect(tx.outputs[0].valueSats).toBe('9007199254740993');
    expect(tx.size).toBe(70); expect(tx.strippedSize).toBe(62); expect(tx.weight).toBe(256); expect(tx.vsize).toBe(64);
    expect(block.transactions.slice(1).every(t => !t.segwit && t.wtxid === t.txid)).toBe(true);
    const witnessChanged = decodeBlockHex(mixed.replace('020301020300', '020301020400'));
    expect(witnessChanged.transactions[0].txid).toBe(tx.txid);
    expect(witnessChanged.transactions[0].wtxid).not.toBe(tx.wtxid);
});

test('accepts Ordinals JSON strings and plain hex and rejects malformed, truncated and trailing data', () => {
    expect(decodeBlockHex(blockHexResponse(JSON.stringify(genesis))).hash).toBe(decodeBlockHex(genesis).hash);
    expect(blockHexResponse('  ' + genesis + '\n')).toBe(genesis);
    expect(() => blockHexResponse('"unfinished')).toThrow();
    for (const hex of ['', 'zz', genesis + '0', '0x' + genesis, '{}' ]) expect(() => decodeBlockHex(hex)).toThrow();
    for (let end = 0; end < genesis.length; end += 2) expect(() => decodeBlockHex(genesis.slice(0, end))).toThrow();
    expect(() => decodeBlockHex(genesis + '00')).toThrow('trailing');
    expect(() => decodeBlockHex(genesis.slice(0, -2) + '01')).toThrow('Merkle root');
    expect(() => decodeBlockHex('00'.repeat(4_000_001))).toThrow('at most');
});

test('rejects invalid CompactSize counts, unsupported witness flags and empty witness serialization', () => {
    for (const count of ['fd0100', 'fe01000000', 'ff0100000000000000'])
        expect(() => decodeBlockHex(genesis.slice(0, 160) + count + genesis.slice(162))).toThrow('Non-canonical');
    for (const count of ['fe00000100', 'ffffffffffffffffff'])
        expect(() => decodeBlockHex(genesis.slice(0, 160) + count + genesis.slice(162))).toThrow();
    expect(() => decodeBlockHex(mixed.replace('020000000001', '020000000002'))).toThrow('flags');
    expect(() => decodeBlockHex(mixed.replace('020301020300', '00'))).toThrow('Superfluous witness');
});

test('CLI reads saved responses, creates a new output, and preserves input and existing files', async () => {
    const directory = await mkdtemp('/tmp/bitmap-decode-test-');
    try {
        const input = join(directory, 'block.json'), out = join(directory, 'decoded.json');
        const original = JSON.stringify(genesis); await writeFile(input, original);
        await decodeBlockCommand(['--input', input, '--out', out]);
        const decoded = JSON.parse(await readFile(out, 'utf8'));
        expect(decoded.transactionCount).toBe(1); expect(decoded.source.file).toBe(input);
        await expect(decodeBlockCommand(['--input', input, '--out', out])).rejects.toThrow('EEXIST');
        expect(await readFile(input, 'utf8')).toBe(original);
        expect(JSON.parse(await readFile(out, 'utf8'))).toEqual(decoded);
        for (const args of [['--block', '-1'], ['--block', '4294967296'], ['--block', 'NaN'],
            ['--input', input, '--block', '0'], ['--url', 'https://example.com', '--block', '0'], ['--unknown', '0']])
            await expect(decodeBlockCommand(args)).rejects.toThrow();
    } finally { await rm(directory, { recursive: true, force: true }); }
});

test('HTTP loading handles the JSON-string contract, status errors and bounded streamed responses', async () => {
    const original = globalThis.fetch;
    try {
        globalThis.fetch = Object.assign(async () => Response.json(genesis), { preconnect: original.preconnect });
        expect(await fetchBlockHex('https://example.com/r/block/0')).toBe(genesis);
        globalThis.fetch = Object.assign(async () => new Response('denied', { status: 403 }), { preconnect: original.preconnect });
        await expect(fetchBlockHex('https://example.com/r/block/0')).rejects.toThrow('HTTP 403');
        globalThis.fetch = Object.assign(async () => new Response(new Uint8Array(8_000_129)), { preconnect: original.preconnect });
        await expect(fetchBlockHex('https://example.com/r/block/0')).rejects.toThrow('resource limit');
    } finally { globalThis.fetch = original; }
});
