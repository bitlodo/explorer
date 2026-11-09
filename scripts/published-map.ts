import {datasetPath,isSemanticDataset} from './dataset-path';
import { readMapManifest } from './read-map-manifest';
import { validArtifactPath } from '../src/shared/dataStorage';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import protobuf from 'protobufjs';
import type { FileRef } from '../src/shared/httpPack';
import descriptor from '../src/shared/proto/neighborhood_descriptor.json';
import { mapDataRoot } from './paths';

type Rectangle = { x: number; y: number; width: number; height: number };
type Neighborhood = { neighborhood: number; width: number; height: number; bitmaps: Rectangle[] };
const geometryType = protobuf.Root.fromJSON(descriptor).lookupType('Neighborhood');
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Read-only maintenance access to the same authenticated geometry used by the site. */
export async function openPublishedMap(directory = mapDataRoot) {
    const root = realpathSync(resolve(directory));
    const {filename,bytes,manifest}=await readMapManifest(root),manifestHash=hash(bytes);
    const identityFile=isSemanticDataset(root)?resolve(root,'release.json'):filename,identityHash=hash(readFileSync(identityFile));
    function read(ref: FileRef) {
        if (!validArtifactPath(ref.url, ref.sha256) || !ref.url.endsWith('.pb')) throw Error('Invalid geometry reference');
        const file = realpathSync(datasetPath(root, ref.url));
        if (!file.startsWith(root + sep)) throw Error('Geometry must remain inside the published dataset');
        const bytes = readFileSync(file);
        if (bytes.length !== ref.bytes || hash(bytes) !== ref.sha256) throw Error(`Geometry integrity failure: ${ref.url}`);
        return { bytes, file };
    }
    function neighborhood(id: number) {
        const region = manifest.regions[id];
        if (!Number.isSafeInteger(id) || !region || region.id !== id) throw Error(`Invalid neighborhood: ${id}`);
        const { bytes, file } = read(region.geometry);
        const data = geometryType.decode(bytes) as unknown as Neighborhood;
        if (data.neighborhood !== id || data.width !== region.width || data.height !== region.height || data.bitmaps.length !== 2016) {
            throw Error(`Published geometry identity/dimensions mismatch: ${id}`);
        }
        for (const r of data.bitmaps) {
            if (![r.x, r.y, r.width, r.height].every(Number.isSafeInteger) || r.x < 0 || r.y < 0 || r.width <= 0 || r.height <= 0
                || r.x + r.width > data.width || r.y + r.height > data.height) throw Error(`Invalid published bitmap bounds: ${id}`);
        }
        return { bytes, file, data, ref: region.geometry };
    }
    function assertUnchanged() {
        if (hash(readFileSync(identityFile)) !== identityHash||hash(readFileSync(filename))!==manifestHash) throw Error('Published manifest changed during maintenance');
    }
    return { root, filename, manifest, manifestHash, neighborhood, assertUnchanged };
}
