import protobuf from 'protobufjs';
import { check, integer, type FileRef } from './httpPack';
import type { MetricSummary } from './mapAnalytics';

export const LAYER_ANALYSIS_FORMAT = 'map-layer-analysis-v1-protobuf';
export type LayerAnalysis = {
    format: typeof LAYER_ANALYSIS_FORMAT; sourceSnapshot: string; count: number;
    parcel: { classes: FileRef; preview: FileRef; counts: number[]; areas: number[] };
    area: MetricSummary;
};
const type = protobuf.Root.fromJSON({nested:{ParcelClasses:{fields:{
    version:{type:'uint32',id:1},count:{type:'uint32',id:2},
    counts:{rule:'repeated',type:'uint32',id:3,options:{packed:true}},
}}}}).lookupType('ParcelClasses');
export function encodeParcelClasses(counts: Uint32Array, count: number): Uint8Array {
    check(integer(count,1,1048576)&&counts.length===count*9,'Invalid parcel class coverage');
    return type.encode({version:1,count,counts:Array.from(counts)}).finish();
}
export function decodeParcelClasses(bytes:Uint8Array,count:number):Uint32Array {
    check(integer(count,1,1048576)&&bytes.length<=count*45+64,'Parcel classes exceed budget');
    const r=type.toObject(type.decode(bytes),{defaults:true,arrays:true});
    check(r.version===1&&r.count===count&&r.counts.length===count*9,'Invalid parcel class identity');
    const values=Uint32Array.from(r.counts);
    for(let id=0;id<count;id++){let n=0;for(let j=0;j<9;j++)n+=values[id*9+j];check(n>=1&&n<=262144,'Invalid parcel count');}
    return values;
}
export function validateLayerAnalysis(root:LayerAnalysis,snapshot:string,count:number){
    check(root?.format===LAYER_ANALYSIS_FORMAT&&root.sourceSnapshot===snapshot&&root.count===count&&integer(count,1,1048576),'Layer analysis snapshot mismatch');
    const ref=(r:FileRef)=>r&&r.url===r.sha256+'.pb'&&/^[a-f0-9]{64}$/.test(r.sha256)&&integer(r.bytes,1,count*45+1024);
    check(ref(root.parcel?.classes)&&ref(root.parcel.preview)&&root.parcel.counts.length===9&&root.parcel.areas.length===9,'Invalid parcel analysis');
    check(root.parcel.counts.every((n,i)=>integer(n,0,Number.MAX_SAFE_INTEGER)&&root.parcel.areas[i]===n*(i+1)**2),'Invalid parcel area distribution');
    const a=root.area;
    check(a&&ref(a.values)&&ref(a.preview)&&['linear','log'].includes(a.scale)&&[a.min,a.max,a.mean].every(Number.isFinite)&&a.min>=1&&a.min<=a.mean&&a.mean<=a.max&&a.max<=145908&&a.histogram.length===32&&a.histogram.every(n=>integer(n,0,count))&&a.histogram.reduce((x,y)=>x+y,0)===count&&a.neighborhoodMeans.length===Math.ceil(count/2016)&&a.neighborhoodMeans.every(v=>Number.isFinite(v)&&v>=a.min&&v<=a.max),'Invalid bitmap area analysis');
}

export type ParcelFilterResult = {
    pixels: Float32Array; occupiedAreas?: Float32Array; bitmapMatches: number; parcelMatches: number;
    selectedArea: number; totalArea: number;
    neighborhoodMeans: number[]; neighborhoodCoverage: number[];
};
/** Larger parcels contribute in proportion to side², rather than their count. */
export function parcelClassFilter(counts:Uint32Array,count:number,low:number,high:number,includeAreas=false):ParcelFilterResult {
    check(integer(low,1,9)&&integer(high,low,9)&&counts.length===count*9,'Invalid parcel class range');
    const pixels=new Float32Array(Math.ceil(count/1024)*1024*2);
    const occupiedAreas=includeAreas?new Float32Array(count):undefined;
    const regions=Math.ceil(count/2016),sums=new Float64Array(regions),selected=new Float64Array(regions),totals=new Float64Array(regions);
    let bitmapMatches=0,parcelMatches=0,selectedArea=0,totalArea=0;
    for(let id=0;id<count;id++){
        let area=0,chosen=0,score=0,n=0;
        for(let i=0;i<9;i++){const size=i+1,parcels=counts[id*9+i],weight=parcels*size*size;area+=weight;
            if(size>=low&&size<=high){chosen+=weight;score+=weight*size;n+=parcels;}}
        check(area>0,'Empty parcel analysis');if(occupiedAreas)occupiedAreas[id]=area;
        pixels[id*2]=chosen?score/chosen:1;pixels[id*2+1]=chosen/area;
        const region=Math.floor(id/2016);sums[region]+=score;selected[region]+=chosen;totals[region]+=area;
        if(n)bitmapMatches++;parcelMatches+=n;selectedArea+=chosen;totalArea+=area;
    }
    return {pixels,occupiedAreas,bitmapMatches,parcelMatches,selectedArea,totalArea,
        neighborhoodMeans:Array.from(sums,(v,i)=>selected[i]?v/selected[i]:1),
        neighborhoodCoverage:Array.from(selected,(v,i)=>v/totals[i])};
}
