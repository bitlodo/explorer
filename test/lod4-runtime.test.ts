import { expect,test } from 'bun:test';
import SpatialLod4Layer,{LOD4_DECODED_BUDGET} from '../src/map/layers/SpatialLod4Layer';
import { buildLod4Region,type Lod4Index,type Lod4Region } from '../src/shared/lod4';
import type { MapDataSource } from '../src/data/MapDataSource';
import type { NeighborhoodSlot } from '../src/shared/NeighborhoodLayout';
import HeatmapPreviewLayer from '../src/map/layers/HeatmapPreviewLayer';
import { lod4DownloadsAllowed,zoomPosition } from '../src/shared/zoomLevels';
const flush=()=>new Promise(resolve=>setTimeout(resolve,0));
test('exact LOD4 cells stay dormant under complete vectors and restore after eviction or reverse zoom',async()=>{
    const slot={x:0,y:0,width:80,height:80,crown:0,side:'center' as const},bounds={x:0,y:0,width:80,height:80};
    const source={getLod4Index:async()=>({}) as Lod4Index,getLod4Region:async()=>buildLod4Region({neighborhood:0,width:80,height:80,bitmaps:[{x:0,y:0,width:80,height:80}]},'0'.repeat(64))} as unknown as MapDataSource;
    const layer=new SpatialLod4Layer(source,[slot],()=>{},e=>{throw e;});layer.setColors(['#007eff','#58c059','#ffa100']);layer.setMetric({kind:'scalar',summary:{min:1,max:6400,scale:'linear'},low:1,high:9});layer.setSummaries(Float32Array.of(2,1));
    try{
        layer.updateView(bounds,bounds,1,1,1,undefined,true);await flush();
        let calls=0,covered=true;
        const geometry={opacity:1,cellSize:100,revision:1,coverage:(b:any)=>{calls++;if(covered&&b!==slot)throw Error('A whole-region proof must bypass cell coverage');return covered?1:0;}};
        const weights=layer.updateView(bounds,bounds,1,1,1,geometry,true),record=(layer as any).records.get(0);
        expect(weights[0]).toBe(0);expect(calls).toBe(1);expect(record.layer).toBeUndefined();expect(layer.stats.wanted).toBe(0);
        layer.updateView(bounds,bounds,1,1,1,{...geometry,opacity:.5},false);
        expect(calls).toBe(2);expect(record.layer.visible).toBe(true);
        expect(record.layer.material.uniforms.geometryOpacity.value).toBe(.5);
        expect([...record.layer.mesh.geometry.getAttribute('geometryCoverage').array].every(v=>v===1)).toBe(true);
        covered=false;layer.updateView(bounds,bounds,1,1,1,{...geometry,revision:2},true);expect(record.layer.visible).toBe(true);
        layer.updateView(bounds,bounds,1,1,1,{...geometry,opacity:.5},true);expect(record.layer.visible).toBe(true);
    }finally{layer.dispose();}
});
test('LOD4 opens lazily, limits requests, cancels obsolete work and reuses resident pages',async()=>{
    let indexCalls=0,requests=0;const pending=new Map<number,{resolve:(p:Lod4Region)=>void;signal:AbortSignal}>();
    const slots:NeighborhoodSlot[]=Array.from({length:8},(_,i)=>({x:i*100,y:0,width:80,height:80,crown:0,side:'center'}));
    const source={getLod4Index:async()=>{indexCalls++;return {} as Lod4Index;},getLod4Region:async(_index:Lod4Index,id:number,signal:AbortSignal)=>{
        requests++;return new Promise<Lod4Region>((resolve,reject)=>{pending.set(id,{resolve,signal});signal.addEventListener('abort',()=>reject(new DOMException('Cancelled','AbortError')),{once:true});});
    }} as unknown as MapDataSource;
    const layer=new SpatialLod4Layer(source,slots,()=>{},error=>{throw error;});
    layer.setColors(['#007eff','#58c059','#ffa100']);layer.setSummaries(new Float32Array(16).fill(1));layer.setMetric({kind:'scalar',summary:{min:1,max:6400,scale:'linear'},low:1,high:9});
    const view={x:0,y:0,width:800,height:100};
    layer.updateView(view,view,0,1,1,undefined,true);await flush();expect(indexCalls).toBe(0);
    layer.updateView(view,view,1,1,1,undefined,true);await flush();expect(indexCalls).toBe(1);expect(pending.size).toBe(4);expect(layer.stats.active).toBe(4);
    const loadedId=[...pending.keys()][0];
    const page=buildLod4Region({neighborhood:loadedId,width:80,height:80,bitmaps:[{x:0,y:0,width:80,height:80}]},'0'.repeat(64));
    pending.get(loadedId)!.resolve(page);await flush();expect(layer.stats.loaded).toBe(1);
    const weights=layer.updateView(view,view,1,1,1,undefined,true);expect(weights[loadedId]).toBe(0);expect(layer.stats.cells).toBeGreaterThan(1);
    const before=requests;layer.updateView(view,view,1,1,1,undefined,true);expect(requests).toBe(before);
    const moved={x:600,y:0,width:200,height:100};layer.updateView(moved,moved,1,1,1,undefined,true);await flush();
    expect([...pending.entries()].some(([id,r])=>id!==loadedId&&r.signal.aborted)).toBe(true);expect(layer.stats.active).toBeLessThanOrEqual(4);
    layer.dispose();await flush();expect([...pending.entries()].filter(([id])=>id!==loadedId).every(([,r])=>r.signal.aborted)).toBe(true);
});

test('LOD4 covers the full resized viewport beyond 64 regions, with independent axis grouping and compact residency',async()=>{
    const slots:NeighborhoodSlot[]=Array.from({length:150},(_,id)=>({x:(id%15)*100,y:Math.floor(id/15)*100,width:80,height:80,crown:0,side:'center'}));
    let requests=0,active=0,peak=0;
    const source={getLod4Index:async()=>({}) as Lod4Index,getLod4Region:async(_index:Lod4Index,id:number)=>{
        requests++;peak=Math.max(peak,++active);await flush();active--;
        return buildLod4Region({neighborhood:id,width:80,height:80,bitmaps:[{x:0,y:0,width:80,height:80}]},'0'.repeat(64));
    }} as unknown as MapDataSource;
    const layer=new SpatialLod4Layer(source,slots,()=>{},error=>{throw error;});
    layer.setColors(['#007eff','#58c059','#ffa100']);layer.setSummaries(new Float32Array(300).fill(1));layer.setMetric({kind:'scalar',summary:{min:1,max:6400,scale:'linear'},low:1,high:9});
    const settle=async()=>{for(let i=0;i<250;i++){await flush();if(layer.stats.active===0)return;}throw Error('LOD4 requests did not settle');};
    const narrow={x:0,y:0,width:800,height:1000},wide={...narrow,width:1500};
    try{
        layer.updateView(narrow,narrow,1,1,1,undefined,true);await settle();
        let weights=layer.updateView(narrow,narrow,1,1,1,undefined,true);expect(layer.stats.visibleRegions).toBe(80);
        expect([...weights].filter(w=>w===0).length).toBe(80);
        layer.updateView(wide,wide,1,1,1,undefined,true);await settle();weights=layer.updateView(wide,wide,1,1,1,undefined,true);
        expect(layer.stats.visibleRegions).toBe(150);expect(layer.stats.wanted).toBe(150);expect([...weights].every(w=>w===0)).toBe(true);
        expect(requests).toBe(150);expect(peak).toBeLessThanOrEqual(4);expect(layer.stats.decodedBytes).toBe(150*(1+257+256+256)*4);
        expect(layer.stats.decodedBytes).toBeLessThan(LOD4_DECODED_BUDGET);expect(layer.stats.budgetLimited).toBe(0);
        const before=requests;layer.updateView(narrow,narrow,.5,.25,1,undefined,true);layer.updateView(wide,wide,1,1,1,undefined,true);expect(requests).toBe(before);
        layer.updateView(wide,wide,1,1,1,{opacity:1,coverage:()=>1},true);expect(layer.stats.wanted).toBe(0);expect(requests).toBe(before);
    }finally{layer.dispose();}
});

test('LOD4 discovery and pages wait for stop 4 even when opening blend has floating-point residue',async()=>{
    let roots=0,pages=0;
    const slot={x:0,y:0,width:80,height:80,crown:0,side:'center' as const},bounds={x:0,y:0,width:100,height:100};
    const source={getLod4Index:async()=>{roots++;return {} as Lod4Index;},getLod4Region:async()=>{
        pages++;return buildLod4Region({neighborhood:0,width:80,height:80,bitmaps:[{x:0,y:0,width:80,height:80}]},'0'.repeat(64));
    }} as unknown as MapDataSource;
    const preview=new HeatmapPreviewLayer(source,[slot],()=>{},error=>{throw error;});
    preview.setRegionSummaries(Float32Array.of(1,1));preview.setSpatialMetric({kind:'scalar',summary:{min:1,max:6400,scale:'linear'},low:1,high:9});
    const stops=[2,20,200,2000,20000];
    try{
        const opening=stops[4]*(1-5e-13),residue=4-zoomPosition(opening,stops);
        expect(residue).toBeGreaterThan(0);
        for(const distance of [stops[4],opening,Math.sqrt(stops[3]*stops[4]),stops[3]*1.0001]){
            preview.setSpatialView(Math.max(0,4-zoomPosition(distance,stops)),1,bounds,lod4DownloadsAllowed(distance,stops));
            preview.updateView(bounds,0,0);await flush();
            expect(roots).toBe(0);expect(pages).toBe(0);
        }
        preview.setSpatialView(1,1,bounds);preview.updateView(bounds,0,0);await flush();expect(roots).toBe(0);
        preview.setSpatialView(1,1,bounds,lod4DownloadsAllowed(stops[3],stops));preview.updateView(bounds,0,0);await flush();
        expect(roots).toBe(1);expect(pages).toBe(1);
        preview.updateView(bounds,0,0);expect(preview.spatialStats!.visibleRegions).toBe(1);
        preview.setSpatialView(.5,1,bounds,false);preview.updateView(bounds,0,0);await flush();
        expect(preview.spatialStats!.visibleRegions).toBe(1);expect(preview.spatialStats!.wanted).toBe(0);expect(pages).toBe(1);
    }finally{preview.dispose();}
});
