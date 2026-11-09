import {datasetPath} from './dataset-path';
import { existsSync, readFileSync } from 'node:fs';
import { decodeMapManifest } from '../src/shared/mapManifest';
export async function readMapManifest(root: string) {
    const entry = existsSync(datasetPath(root, 'manifest.json')) ? 'manifest.json' : 'manifest.pb';
    const filename = datasetPath(root, entry), bytes = readFileSync(filename);
    return { filename, bytes, entry, manifest: await decodeMapManifest(bytes, entry) };
}
