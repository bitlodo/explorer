import { readdir, lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { mapDataRoot } from './paths';

const root = resolve(process.argv[2] || mapDataRoot);
const totals = new Map<string, { files: number; bytes: number }>();
async function walk(directory: string, group = 'metadata') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const file = resolve(directory, entry.name);
        if (entry.isSymbolicLink()) throw Error('Dataset must not contain symlinks');
        if (entry.isDirectory()) await walk(file, group === 'metadata' ? entry.name : group);
        else if (entry.isFile()) {
            const total = totals.get(group) ?? { files: 0, bytes: 0 };
            total.files++; total.bytes += (await lstat(file)).size; totals.set(group, total);
        }
    }
}
await walk(root);
console.table([...totals].sort((a, b) => b[1].bytes - a[1].bytes).map(([type, total]) => ({ type, files: total.files, bytes: total.bytes, MiB: (total.bytes / 1048576).toFixed(2) })));
console.log(`Total: ${[...totals.values()].reduce((n, t) => n + t.bytes, 0)} bytes`);
