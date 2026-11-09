import { openPublishedMap } from '../scripts/published-map.ts';
// Offline, read-only comparison. Never imports server startup or regenerates data.
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import protobuf from 'protobufjs';
import descriptor from '../src/shared/proto/neighborhood_descriptor.json' with { type: 'json' };
import MondrianLayout from '../src/shared/MondrianLayout.ts';

const args = process.argv.slice(2);
if (args.length % 2) throw Error('Use [--regions all|0,400] [--baseline 0,21,100,400,415] [--repeats 3] --report FILE');
const opts = Object.fromEntries(Array.from({ length: args.length / 2 }, (_, i) => [args[i * 2], args[i * 2 + 1]]));
for (const key of Object.keys(opts)) if (!['--regions', '--baseline', '--repeats', '--report'].includes(key)) throw Error('Unknown option ' + key);
const repeats = Number(opts['--repeats'] || 3);
if (!Number.isSafeInteger(repeats) || repeats < 1 || repeats > 20 || !opts['--report']) throw Error('Supply --report and repeats 1..20');
const source = await openPublishedMap();
const type = protobuf.Root.fromJSON(descriptor).lookupType('Neighborhood');
const available = source.manifest.regions.map(r => r.id);
const parseIds = value => value.split(',').map(Number);
const selected = !opts['--regions'] || opts['--regions'] === 'all' ? available : parseIds(opts['--regions']);
const baseline = parseIds(opts['--baseline'] || '0,21,100,400,415');
assert(selected.length && new Set(selected).size === selected.length && selected.every(id => available.includes(id)), 'Invalid regions');
assert(new Set(baseline).size === baseline.length && baseline.every(id => selected.includes(id)), 'Baseline must be selected');
const inputs = crypto.createHash('sha256'), published = crypto.createHash('sha256');
const report = {
    status: 'running', runtime: process.version,
    platform: `${process.platform}/${process.arch}`,
    validation: { canonical: 'every rectangle and neighborhood size, in block-index order', dataAccess: 'read-only Protobuf; no DB or server startup' },
    repetitions: repeats, regions: [], baselines: [],
};
const timed = (Layout, input) => { const start = performance.now(); const layout = new Layout(input); return { layout, ms: performance.now() - start }; };
const summary = values => { const sorted = [...values].sort((a, b) => a - b); return { medianMs: sorted[Math.floor(sorted.length / 2)], minMs: sorted[0], maxMs: sorted.at(-1) }; };
const checked = (a, b, id) => {
    assert.deepEqual(a.getSize(), b.getSize(), `neighborhood ${id} bounds`);
    assert.deepEqual(a.slots, b.slots, `neighborhood ${id} rectangles`);
};
const samples = new Map();
for (let i = 0; i < selected.length; i++) {
    const id = selected[i], { bytes, data, ref } = source.neighborhood(id), file = ref.url;
    const input = data.bitmaps.map(({ width, height }) => [width, height]);
    inputs.update(JSON.stringify({ id, input })); published.update(file); published.update(bytes);
    const { layout, ms } = timed(MondrianLayout, input);
    assert.equal(layout.strategy, 'indexed-rectangles');
    checked(layout, { getSize: () => ({ width: data.width, height: data.height }), slots: data.bitmaps.map(({ x, y, width, height }) => ({ x, y, width, height })) }, id);
    const encoded = type.encode({ neighborhood: data.neighborhood, width: layout.width, height: layout.height, bitmaps: layout.slots }).finish();
    assert(Buffer.from(encoded).equals(bytes), `neighborhood ${id} Protobuf bytes changed`);
    report.regions.push({ id, bitmaps: input.length, width: layout.width, height: layout.height, layoutMs: ms, differences: 0, protobufByteIdentical: true });
    if (baseline.includes(id)) samples.set(id, input);
    if ((i + 1) % 32 === 0 || i + 1 === selected.length) console.log(JSON.stringify({ canonicalChecked: i + 1, total: selected.length }));
}
for (const id of baseline) {
    const input = samples.get(id);
    const expected = new MondrianLayout(input), times = [];
    for (let i = 0; i < repeats; i++) {
        const run = timed(MondrianLayout, input); checked(run.layout, expected, id); times.push(run.ms);
    }
    const result = { id, bitmaps: input.length, layout: summary(times), times };
    report.baselines.push(result); console.log(JSON.stringify(result));
}
source.assertUnchanged();
report.status = 'complete';
report.inputSha256 = inputs.digest('hex'); report.canonicalSha256 = published.digest('hex');
report.totals = {
    neighborhoods: report.regions.length, bitmaps: report.regions.reduce((sum, r) => sum + r.bitmaps, 0),
    canonicalLayoutMs: report.regions.reduce((sum, r) => sum + r.layoutMs, 0),
    sampleMedianSumMs: report.baselines.reduce((sum, r) => sum + r.layout.medianMs, 0),
    differences: 0,
};
await fs.writeFile(opts['--report'], JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ status: report.status, totals: report.totals, report: opts['--report'] }));
