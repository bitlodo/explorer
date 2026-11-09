import protobuf from 'protobufjs';
import { check, integer, type FileRef } from './httpPack';
import type { BitmapInspection } from './mapAnalytics';
export const SPATIAL_METRICS_FORMAT = 'spatial-metrics-v1-protobuf';
export type SpatialMetricsIndex = { format: typeof SPATIAL_METRICS_FORMAT; sourceSnapshot: string; count: number; regions: FileRef[]; parcelMeans: number[] };
export type SpatialMetricPage = { region: number; count: Float32Array; diversity: Float32Array; occupancy: Float32Array; classes: Uint32Array };
const type = protobuf.Root.fromJSON({nested:{Page:{fields:{
    version:{type:'uint32',id:1},region:{type:'uint32',id:2},
    count:{rule:'repeated',type:'uint32',id:3,options:{packed:true}},
    diversity:{rule:'repeated',type:'float',id:4,options:{packed:true}},
    occupancy:{rule:'repeated',type:'float',id:5,options:{packed:true}},
    classes:{rule:'repeated',type:'uint32',id:6,options:{packed:true}},
}}}}).lookupType('Page');
export function metricRegionPath(region:number,hash:string) {
    check(integer(region,0,520)&&/^[a-f0-9]{64}$/.test(hash),'Invalid metric page path');
    return `metrics/values/n${String(region).padStart(6,'0')}.${hash}.pb`;
}
export function encodeSpatialMetricPage(region:number,rows:BitmapInspection[]) {
    return type.encode({version:1,region,count:rows.map(r=>r.count),diversity:rows.map(r=>r.diversity),occupancy:rows.map(r=>r.occupancy),classes:rows.flatMap(r=>r.histogram)}).finish();
}
export function decodeSpatialMetricPage(bytes:Uint8Array,region:number,count:number):SpatialMetricPage {
    check(bytes.length<=128*1024&&integer(count,1,2016),'Metric page exceeds budget');
    const r=type.toObject(type.decode(bytes),{arrays:true,defaults:true});
    check(r.version===1&&r.region===region&&r.count.length===count&&r.diversity.length===count&&r.occupancy.length===count&&r.classes.length===count*9,'Metric page coverage mismatch');
    for(let i=0;i<count;i++) {
        check(integer(r.count[i],1,262144)&&Number.isFinite(r.diversity[i])&&r.diversity[i]>=0&&r.diversity[i]<=Math.log2(9)+1e-6&&Number.isFinite(r.occupancy[i])&&r.occupancy[i]>0&&r.occupancy[i]<=1.000001,'Invalid local metric');
        let sum=0;for(let j=0;j<9;j++){check(integer(r.classes[i*9+j],0,262144),'Invalid local class');sum+=r.classes[i*9+j];}check(sum===r.count[i],'Local class count mismatch');
    }
    return {region,count:Float32Array.from(r.count),diversity:Float32Array.from(r.diversity),occupancy:Float32Array.from(r.occupancy),classes:Uint32Array.from(r.classes)};
}
export function validateSpatialMetricsIndex(root:SpatialMetricsIndex,snapshot:string,count:number) {
    check(root?.format===SPATIAL_METRICS_FORMAT&&root.sourceSnapshot===snapshot&&root.count===count,'Spatial metric snapshot mismatch');
    const n=Math.ceil(count/2016);
    check(root.regions?.length===n&&root.parcelMeans?.length===n&&root.parcelMeans.every(v=>Number.isFinite(v)&&v>=1&&v<=9),'Invalid metric regions');
    root.regions.forEach((r,id)=>check(r.url===metricRegionPath(id,r.sha256)&&integer(r.bytes,1,128*1024),'Invalid metric reference'));
}
