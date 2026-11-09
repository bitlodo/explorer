import {test,expect} from 'bun:test';
import {mapStatus,pendingNeighborhoods} from '../src/shared/siteMetadata';

const status={format:'bitmap-map-status-v1' as const,snapshot:'a'.repeat(64),publishedHeight:4031,syncedHeight:5000,
    syncedAt:'2026-11-06T22:24:20.462Z',generatedAt:null,checkedAt:'2026-11-08T18:00:00.000Z'};
test('status metadata must match the exact displayed dataset and cannot understate its published prefix',()=>{
    expect(mapStatus(status,status.snapshot,4031)).toEqual(status);
    expect(mapStatus(status,'b'.repeat(64),4031)).toBeUndefined();
    expect(mapStatus(status,status.snapshot,2015)).toBeUndefined();
    expect(mapStatus({...status,syncedHeight:4030},status.snapshot,4031)).toBeUndefined();
    expect(mapStatus({...status,checkedAt:'invalid'},status.snapshot,4031)).toBeUndefined();
    expect(mapStatus({...status,syncedHeight:null},status.snapshot,4031)?.syncedHeight).toBeNull();
});
test('pending blocks distinguish a partial next neighborhood from complete neighborhoods awaiting generation',()=>{
    expect(pendingNeighborhoods(973727,974864)).toEqual({unpublished:1137,ready:0,progress:1137,remaining:879});
    expect(pendingNeighborhoods(2015,4031)).toEqual({unpublished:2016,ready:1,progress:0,remaining:2016});
    expect(pendingNeighborhoods(2015,6031)).toEqual({unpublished:4016,ready:1,progress:2000,remaining:16});
    expect(pendingNeighborhoods(2015,2015).unpublished).toBe(0);
});
