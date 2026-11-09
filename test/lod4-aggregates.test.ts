import { test, expect } from 'bun:test';
import { buildLod4Region } from '../src/shared/lod4';
import { summarizeLod4Cells, type Lod4Metric } from '../src/shared/lod4Summary';
import { sha256 } from '../src/shared/httpPack';
import { LOD4_AGGREGATES_FORMAT, LOD4_MODES, aggregateBatchPath, aggregateIndexPath, buildAggregateRegion,
    encodeAggregateBatch, decodeAggregateBatch, encodeAggregateIndex, decodeAggregateIndex, summarizeAggregateCells,
    validateAggregateIndex, validAggregatePath, type AggregateIndex, type Lod4Mode } from '../src/shared/lod4Aggregates';
import type { SpatialMetricPage } from '../src/shared/spatialMetrics';

const hash='0'.repeat(64);
const page=buildLod4Region({neighborhood:0,width:49,height:35,bitmaps:[{x:0,y:0,width:7,height:35},{x:8,y:0,width:35,height:3},{x:8,y:5,width:30,height:29},{x:44,y:10,width:1,height:1}]},hash);
const metrics:SpatialMetricPage={region:0,count:Float32Array.of(2,3,4,1),diversity:Float32Array.of(.7,.1,1.7,0),occupancy:Float32Array.of(.2,.8,.9,1),classes:Uint32Array.from([1,1,0,0,0,0,0,0,0, 0,0,0,3,0,0,0,0,0, 1,0,0,0,0,0,0,0,3, 1,0,0,0,0,0,0,0,0])};
function metric(mode:Lod4Mode):Lod4Metric{
    if(mode==='size'){
        const pixels=new Float32Array(8),occupiedAreas=new Float32Array(4);
        for(let id=0;id<4;id++){let weight=0,sum=0;for(let j=0;j<9;j++){const a=metrics.classes[id*9+j]*(j+1)**2;weight+=a;sum+=a*(j+1);}occupiedAreas[id]=weight;pixels[id*2]=sum/weight;pixels[id*2+1]=1;}
        return {mode,kind:'parcel',pixels,occupiedAreas};
    }
    return {mode,kind:'scalar',summary:{min:mode==='diversity'?0:1,max:mode==='area'?1715:mode==='count'?4:mode==='diversity'?2:1,scale:mode==='count'?'log':'linear'},values:mode==='area'?undefined:metrics[mode],low:1,high:9};
}
test('precomputed 16x16 means, coverage and anisotropic merging match canonical membership summaries',()=>{
    for(const mode of LOD4_MODES){
        const aggregate=buildAggregateRegion(page,mode,metrics),m=metric(mode);
        expect(aggregate.columns).toBe(16);expect(aggregate.rows).toBe(16);
        for(const step of [1,2,4,8,16])for(const rowStep of [1,2,4,8,16]){
            const actual=summarizeAggregateCells(aggregate,m,step,rowStep),expected=summarizeLod4Cells(page,m,step,rowStep);
            expect(actual.bounds).toEqual(expected.bounds);
            actual.summaries.forEach((v,i)=>expect(Math.abs(v-expected.summaries[i])).toBeLessThan(2e-6));
            actual.coverage.forEach((v,i)=>expect(Math.abs(v-expected.coverage[i])).toBeLessThan(2e-7));
        }
    }
});
test('versioned aggregate Protobuf rejects corruption, traversal, foreign batches and incomplete coverage',async()=>{
    const batches=[];
    for(const mode of LOD4_MODES){const bytes=encodeAggregateBatch(mode,0,[buildAggregateRegion(page,mode,metrics)]),sha=await sha256(bytes);batches.push({mode,tile:0,ids:[0],url:aggregateBatchPath(mode,0,sha),sha256:sha,bytes:bytes.length});}
    const index:AggregateIndex={version:2,format:LOD4_AGGREGATES_FORMAT,sourceSnapshot:hash,gridSide:16,regions:[{id:0,width:49,height:35,geometrySha256:hash,metricsSha256:hash}],batches};
    const bytes=encodeAggregateIndex(index),sha=await sha256(bytes),ref={url:aggregateIndexPath(sha),sha256:sha,bytes:bytes.length};expect(await decodeAggregateIndex(bytes,hash,ref)).toEqual(index);
    const batch=encodeAggregateBatch('area',0,[buildAggregateRegion(page,'area',metrics)]);expect((await decodeAggregateBatch(batch,batches[0],index))[0].means).toEqual(buildAggregateRegion(page,'area',metrics).means);
    const corrupt=batch.slice();corrupt[corrupt.length-1]^=1;await expect(decodeAggregateBatch(corrupt,batches[0],index)).rejects.toThrow('integrity');
    await expect(decodeAggregateBatch(batch,{...batches[0],ids:[1]},index)).rejects.toThrow('absent');
    expect(()=>validateAggregateIndex({...index,batches:index.batches.slice(1)},hash)).toThrow('Missing');
    expect(validAggregatePath('../'+batches[0].url,batches[0].sha256)).toBe(false);
    expect(validAggregatePath('https://example.com/'+ref.url,sha)).toBe(false);
});
