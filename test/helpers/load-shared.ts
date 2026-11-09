// Bun-only helpers for testing actual modules and browser-worker bundles.
import { fileURLToPath } from 'node:url';
export async function sharedModuleUrl(relative: string) {
    const result = await Bun.build({ entrypoints: [fileURLToPath(new URL(relative, import.meta.url))], target: 'bun', format: 'esm' });
    if (!result.success) throw new Error('Shared module build failed: ' + result.logs.map(String).join('\n'));
    return 'data:text/javascript;base64,' + Buffer.from(await result.outputs[0].arrayBuffer()).toString('base64');
}

export async function loadShared(relative: string) { return import(new URL(relative, import.meta.url).href); }
