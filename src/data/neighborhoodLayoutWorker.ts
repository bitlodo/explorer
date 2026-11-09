import protobuf from 'protobufjs';
import { createNeighborhoodLayoutComputer, type NeighborhoodLayoutRequest } from '../shared/computeNeighborhoodLayout';

const computeNeighborhoodLayout = createNeighborhoodLayoutComputer(protobuf);

self.onmessage = async (event: MessageEvent<NeighborhoodLayoutRequest>) => {
    try {
        const result = await computeNeighborhoodLayout(event.data);
        self.postMessage(result, { transfer: [result.wire.buffer] });
    } catch (error) {
        self.postMessage({ job: event.data.job, error: error instanceof Error ? error.message : String(error) });
    }
};
