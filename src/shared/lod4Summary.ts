import { check } from './httpPack';
import { normalizeMetric, type MetricSummary } from './mapAnalytics';
import { lod4CellBounds, type Lod4Region } from './lod4';
import type { Lod4Mode } from './lod4Aggregates';
export type Lod4Metric = ({
    kind: 'scalar' | 'patterns'; summary: Pick<MetricSummary, 'min' | 'max' | 'scale'>;
    values?: Float32Array; scores?: Float32Array; low: number; high: number;
} | { kind: 'parcel'; pixels: Float32Array; occupiedAreas: Float32Array }) & { ready?: (region:number)=>boolean; mode?:Lod4Mode; filtered?:boolean; range?:readonly [number,number] };
export type Lod4Cells = {
    bounds: { x: number; y: number; width: number; height: number }[];
    summaries: Float32Array; coverage: Float32Array;
};

/** Original-value means; crossing bitmaps keep total weight one across the grid. */
export function summarizeLod4Cells(page: Lod4Region<number[] | Uint32Array>, metric: Lod4Metric, step = 1, rowStep = step): Lod4Cells {
    check([1,2,4,8,16].includes(step) && [1,2,4,8,16].includes(rowStep), 'Invalid LOD4 grouping');
    const count=page.bitmapAreas.length,first=page.id*2016;
    const totals=new Float64Array(count),selected=new Float64Array(count),sums=new Float64Array(count);
    for(let local=0;local<count;local++){
        const id=first+local;
        if(metric.kind==='parcel'){
            const area=metric.occupiedAreas[id],share=metric.pixels[id*2+1],mean=metric.pixels[id*2];
            check(Number.isFinite(area)&&area>0&&Number.isFinite(share)&&share>=0&&share<=1&&Number.isFinite(mean),'Invalid LOD4 parcel metric');
            totals[local]=area;selected[local]=area*share;sums[local]=selected[local]*mean;
        }else{
            const value=metric.values?metric.values[id]:page.bitmapAreas[local];
            const score=metric.scores?metric.scores[id]:Math.fround(1+8*normalizeMetric(value,metric.summary));
            check(Number.isFinite(value)&&Number.isFinite(score),'Invalid LOD4 scalar metric');
            totals[local]=1;
            if(metric.kind==='patterns')sums[local]=value;
            if(score>=metric.low-.000001&&score<=metric.high+.000001){selected[local]=1;sums[local]=value;}
        }
    }
    const bounds:Lod4Cells['bounds']=[],values:number[]=[],coverage:number[]=[];
    for(let row=0;row<page.rows;row+=rowStep)for(let col=0;col<page.columns;col+=step){
        const lastRow=Math.min(page.rows,row+rowStep),lastCol=Math.min(page.columns,col+step);
        const a=lod4CellBounds(page,row*page.columns+col),b=lod4CellBounds(page,(lastRow-1)*page.columns+lastCol-1);
        const rect={x:a.x,y:a.y,width:b.x+b.width-a.x,height:b.y+b.height-a.y};
        let total=0,chosen=0,sum=0,occupied=0;
        for(let y=row;y<lastRow;y++)for(let x=col;x<lastCol;x++){
            const cell=y*page.columns+x;let bitmap=0;
            for(let i=page.cellOffsets[cell];i<page.cellOffsets[cell+1];i++){
                bitmap+=page.memberDeltas[i];const area=page.overlapAreas[i],fraction=area/page.bitmapAreas[bitmap];
                total+=totals[bitmap]*fraction;chosen+=selected[bitmap]*fraction;sum+=sums[bitmap]*fraction;occupied+=area;
            }
        }
        let mean=metric.kind==='patterns'&&total?sum/total:chosen?sum/chosen:1;
        if(metric.kind!=='parcel'&&(chosen||metric.kind==='patterns'&&total))mean=1+8*normalizeMetric(mean,metric.summary);
        bounds.push(rect);values.push(mean,metric.kind==='patterns'?(chosen?1:0):(total?chosen/total:0));coverage.push(occupied/(rect.width*rect.height));
    }
    return {bounds,summaries:Float32Array.from(values),coverage:Float32Array.from(coverage)};
}
