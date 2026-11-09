import { test,expect } from 'bun:test';
import { buildLod4Region } from '../src/shared/lod4';
import { buildAggregateRegion,summarizeAggregateCells } from '../src/shared/lod4Aggregates';
import { summarizeLod4Cells } from '../src/shared/lod4Summary';
import { parcelClassFilter } from '../src/shared/layerAnalysis';
import { buildParcelFilterGrid, parcelFilterTotals, type ParcelFilterMetadata } from '../src/shared/parcelFilters';

test('all parcel ranges retain exact global counts and canonical selected means without downloading classes',()=>{
    const classes=Uint32Array.from([1,1,0,0,0,0,0,0,0, 0,0,0,3,0,0,0,0,0, 1,0,0,0,0,0,0,0,3, 1,0,0,0,0,0,0,0,0]);
    const page=buildLod4Region({neighborhood:0,width:49,height:35,bitmaps:[{x:0,y:0,width:7,height:35},{x:8,y:0,width:35,height:3},{x:8,y:5,width:30,height:29},{x:44,y:10,width:1,height:1}]},'0'.repeat(64));
    const counts=Array(9).fill(0),masks=Array(512).fill(0);
    for(let id=0;id<4;id++){let mask=0;for(let j=0;j<9;j++){counts[j]+=classes[id*9+j];if(classes[id*9+j])mask|=1<<j;}masks[mask]++;}
    const metadata={count:4,regionCounts:counts,masks} as ParcelFilterMetadata,base=buildAggregateRegion(page,'size',{region:0,classes,count:Float32Array.of(2,3,4,1),diversity:new Float32Array(4),occupancy:new Float32Array(4)});
    for(let low=1;low<=9;low++)for(let high=low;high<=9;high++){
        const expected=parcelClassFilter(classes,4,low,high,true),totals=parcelFilterTotals(metadata,low,high);
        for(const key of ['bitmapMatches','parcelMatches','selectedArea','totalArea','neighborhoodMeans','neighborhoodCoverage'] as const)expect(totals[key]).toEqual(expected[key]);
        const filtered=buildParcelFilterGrid(page,classes,low,high),metric={kind:'parcel' as const,pixels:expected.pixels,occupiedAreas:expected.occupiedAreas!};
        for(const [step,rowStep] of [[1,1],[2,4],[8,2],[16,16]]){
            const actual=summarizeAggregateCells({...base,means:filtered.means,weights:filtered.weights},metric,step,rowStep,base.weights),old=summarizeLod4Cells(page,metric,step,rowStep);
            actual.summaries.forEach((v,i)=>expect(Math.abs(v-old.summaries[i])).toBeLessThan(2e-6));
            actual.coverage.forEach((v,i)=>expect(Math.abs(v-old.coverage[i])).toBeLessThan(2e-7));
        }
    }
});
