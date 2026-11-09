import descriptor from './proto/neighborhood_descriptor.json';
import MondrianLayout from './MondrianLayout.ts';
import { check, sha256 } from './httpPack';
import { createDimensionsCodec, type LayoutExpectation } from './neighborhoodDimensions';

export type NeighborhoodLayoutRequest = { job: number; expected: LayoutExpectation; dimensionsHash: string; dimensions: Uint8Array };
export type NeighborhoodLayoutResult = { job: number; wire: Uint8Array; durationMs: number };

/** Used only in the layout worker and offline validation, never on the UI thread. */
export function createNeighborhoodLayoutComputer(protobuf: any) {
    const codec = createDimensionsCodec(protobuf);
    const type = protobuf.Root.fromJSON(descriptor).lookupType('Neighborhood');
    return async function computeNeighborhoodLayout(request: NeighborhoodLayoutRequest): Promise<NeighborhoodLayoutResult> {
        const { expected } = request;
        check(await sha256(request.dimensions) === request.dimensionsHash, 'Neighborhood dimensions integrity mismatch');
        const sizes = codec.decode(request.dimensions, expected), input: [number, number][] = [];
        for (let i = 0; i < sizes.length; i += 2) input.push([sizes[i], sizes[i + 1]]);
        const start = performance.now(), layout = new MondrianLayout(input), durationMs = performance.now() - start;
        check(layout.strategy === 'indexed-rectangles' && layout.width === expected.width && layout.height === expected.height, 'Generated neighborhood bounds differ from manifest');
        const wire = new Uint8Array(type.encode({ neighborhood: expected.id, width: layout.width, height: layout.height, bitmaps: layout.slots }).finish());
        check(wire.length === expected.bytes && await sha256(wire) === expected.sha256, 'Generated neighborhood differs from canonical geometry');
        return { job: request.job, wire, durationMs };
    };
}
