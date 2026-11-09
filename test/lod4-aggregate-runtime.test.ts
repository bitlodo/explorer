import { test, expect } from 'bun:test';
import SpatialSummaryLayer from '../src/map/layers/SpatialSummaryLayer';
import type { MapDataSource } from '../src/data/MapDataSource';
import type { NeighborhoodSlot } from '../src/shared/NeighborhoodLayout';
import type { AggregateIndex, AggregateBatchRef, AggregateRegion } from '../src/shared/lod4Aggregates';
import { buildLod4Region } from '../src/shared/lod4';
const flush=()=>new Promise(resolve=>setTimeout(resolve,0));
const slots:NeighborhoodSlot[]=Array.from({length:36},(_,id)=>({x:(id%12)*100,y:Math.floor(id/12)*100,width:80,height:80,crown:0,side:'center'}));
const view={x:0,y:0,width:1200,height:300};
const scalar={mode:'area' as const,kind:'scalar' as const,summary:{min:1,max:6400,scale:'linear' as const},low:1,high:9};
const page=(id:number):AggregateRegion=>({id,width:80,height:80,columns:16,rows:16,means:new Float32Array(256).fill(2),weights:new Float32Array(256).fill(1),coverage:new Float32Array(256).fill(1)});

test('completed vector regions bypass aggregate cells while reverse zoom and geometry loss restore previews',async()=>{
    const slot=slots[0],bounds={x:0,y:0,width:80,height:80};
    const source={getLod4SummaryIndex:async()=>({batches:[{mode:'area',tile:0,ids:[0],url:'base'}]}),getLod4SummaryBatch:async()=>[page(0)]} as unknown as MapDataSource;
    const layer=new SpatialSummaryLayer(source,[slot],()=>{},e=>{throw e;});layer.setColors(['#007eff','#58c059','#ffa100']);layer.setMetric(scalar);layer.setSummaries(Float32Array.of(2,1));
    try{
        for(let n=0;n<4;n++){layer.updateView(bounds,bounds,1,1,1,undefined,true);await flush();}
        const record=(layer as any).records.get('area:0'),preview=record.layer,buffer=preview.mesh.geometry;
        let cells=0,whole=0,covered=true;
        const geometry={opacity:1,cellSize:100,revision:1,coverage:(b:any,id?:number)=>{expect(id).toBe(0);if(b===slot){whole++;return covered?1:0;}cells++;return covered?1:0;}};
        layer.updateView(bounds,bounds,1,1,1,geometry,true);
        expect(whole).toBe(1);expect(cells).toBe(0);expect(preview.visible).toBe(false);expect(preview.mesh.geometry).toBe(buffer);
        // A newly resident summary must not allocate a mesh under complete vectors.
        preview.dispose();record.layer=undefined;layer.updateView(bounds,bounds,1,1,1,{...geometry,revision:2},true);
        expect(record.layer).toBeUndefined();expect(cells).toBe(0);expect(layer.stats.wanted).toBe(0);
        layer.updateView(bounds,bounds,1,1,1,{...geometry,opacity:.5},true);
        expect(record.layer.visible).toBe(true);expect(cells).toBe(0);
        expect(record.layer.material.uniforms.geometryOpacity.value).toBe(.5);
        expect([...record.layer.mesh.geometry.getAttribute('geometryCoverage').array].every(v=>v===1)).toBe(true);
        for(const pixels of [.9,.5,.2])layer.updateView(bounds,bounds,.5,pixels,1,{...geometry,opacity:.25},false);
        expect(cells).toBe(0);
        covered=false;layer.updateView(bounds,bounds,1,1,1,{...geometry,revision:3},true);
        expect(cells).toBeGreaterThan(0);
        expect(record.layer.visible).toBe(true);expect(record.layer.material.uniforms.geometryOpacity.value).toBe(1);
        expect(layer.stats.visibleRegions).toBe(1);
    }finally{layer.dispose();}
});

test('aggregate batches are lazy, shared across visible regions, cancelled on pan and retained across reverse zoom',async()=>{
    let roots=0,requests=0,peak=0,active=0,exact=0;
    const batches=Array.from({length:6},(_,tile)=>({mode:'area',tile,ids:Array.from({length:6},(_,j)=>tile*6+j),url:'tile-'+tile})) as AggregateBatchRef[];
    const pending=new Map<string,{resolve:(p:AggregateRegion[])=>void;signal:AbortSignal}>();
    const source={getLod4SummaryIndex:async()=>{roots++;return {batches} as AggregateIndex;},getLod4SummaryBatch:async(_index:AggregateIndex,ref:AggregateBatchRef,signal:AbortSignal)=>{
        requests++;peak=Math.max(peak,++active);return new Promise<AggregateRegion[]>((resolve,reject)=>{pending.set(ref.url,{resolve,signal});signal.addEventListener('abort',()=>reject(new DOMException('Cancelled','AbortError')),{once:true});}).finally(()=>active--);
    },getLod4Index:async()=>{exact++;throw Error('Unexpected exact discovery');}} as unknown as MapDataSource;
    const layer=new SpatialSummaryLayer(source,slots,()=>{},e=>{throw e;});layer.setColors(['#007eff','#58c059','#ffa100']);layer.setMetric(scalar);layer.setSummaries(new Float32Array(72).fill(1));
    try{
        layer.updateView(view,view,1,1,1,undefined,false);await flush();expect(roots).toBe(0);
        layer.updateView(view,view,1,1,1,undefined,true);await flush();layer.updateView(view,view,1,1,1,undefined,true);expect(requests).toBe(4);expect(peak).toBe(4);
        for(const ref of batches.filter(ref=>pending.has(ref.url)))pending.get(ref.url)!.resolve(ref.ids.map(page));await flush();
        for(const ref of batches.filter(ref=>pending.has(ref.url)))pending.get(ref.url)!.resolve(ref.ids.map(page));await flush();
        const weights=layer.updateView(view,view,1,1,1,undefined,true);expect([...weights].every(w=>w===0)).toBe(true);expect(layer.stats.visibleRegions).toBe(36);expect(requests).toBe(6);expect(exact).toBe(0);
        const before=requests;layer.updateView(view,view,.3,.1,1,undefined,false);layer.updateView(view,view,1,1,1,undefined,true);expect(requests).toBe(before);
        expect((layer as any).records.values().next().value.page.columns).toBe(16);
    }finally{layer.dispose();}
});
test('mode changes abort obsolete batches and exact filters switch to the original membership path',async()=>{
    const cancelled:AbortSignal[]=[];let exact=0;
    const source={getLod4SummaryIndex:async()=>({batches:[{mode:'area',tile:0,ids:[0],url:'area'}]}) as AggregateIndex,
        getLod4SummaryBatch:async(_index:AggregateIndex,_ref:AggregateBatchRef,signal:AbortSignal)=>{cancelled.push(signal);return new Promise<AggregateRegion[]>((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('Cancelled','AbortError')),{once:true}));},
        getLod4Index:async()=>{exact++;return {} as any;},getLod4Region:async()=>buildLod4Region({neighborhood:0,width:80,height:80,bitmaps:[{x:0,y:0,width:80,height:80}]},'0'.repeat(64))} as unknown as MapDataSource;
    const layer=new SpatialSummaryLayer(source,[slots[0]],()=>{},e=>{throw e;});layer.setColors(['#007eff','#58c059','#ffa100']);layer.setMetric(scalar);layer.setSummaries(Float32Array.of(1,1));
    try{
        layer.updateView(view,view,1,1,1,undefined,true);await flush();layer.updateView(view,view,1,1,1,undefined,true);expect(cancelled.length).toBe(1);
        layer.setMetric({...scalar,mode:'count'});layer.updateView(view,view,1,1,1,undefined,true);await flush();expect(cancelled[0].aborted).toBe(true);expect(exact).toBe(0);
        layer.setMetric({...scalar,filtered:true,low:2});layer.updateView(view,view,1,1,1,undefined,true);await flush();expect(exact).toBe(1);
        layer.updateView(view,view,1,1,1,undefined,true);expect(layer.stats.visibleRegions).toBe(1);
    }finally{layer.dispose();}
});
test('filtered Parcel size requests only visible batches, shares admission and cancels obsolete views and ranges',async()=>{
    const batches=Array.from({length:6},(_,tile)=>({mode:'size',tile,ids:Array.from({length:6},(_,j)=>tile*6+j),url:'base-'+tile})) as AggregateBatchRef[];
    const pending=new Map<string,{ref:any;signal:AbortSignal;resolve:(pages:any[])=>void}>();let active=0,peak=0,exact=0;
    const source={getLod4SummaryIndex:async()=>({batches}) as AggregateIndex,getLod4SummaryBatch:async(_index:AggregateIndex,ref:AggregateBatchRef)=>ref.ids.map(page),
        getParcelFilterIndex:async(low:number,high:number)=>({low,high,batches:batches.map(b=>({...b,url:`${low}-${high}-${b.tile}`}))}),
        getParcelFilterBatch:async(_index:any,ref:any,signal:AbortSignal)=>{peak=Math.max(peak,++active);return new Promise<any[]>((resolve,reject)=>{pending.set(ref.url,{ref,signal,resolve});signal.addEventListener('abort',()=>reject(new DOMException('Cancelled','AbortError')),{once:true});}).finally(()=>active--);},
        getLod4Index:async()=>{exact++;throw Error('Unexpected full membership download');}} as unknown as MapDataSource;
    const layer=new SpatialSummaryLayer(source,slots,()=>{},e=>{throw e;});layer.setColors(['#49099e','#c03e80','#ffff00']);layer.setSummaries(new Float32Array(72).fill(1));
    const set=(low:number,high:number)=>layer.setMetric({mode:'size',filtered:true,range:[low,high],kind:'parcel',pixels:new Float32Array(2),occupiedAreas:new Float32Array(1)});
    const left={...view,width:90},right={...left,x:1100},update=async(bounds=left)=>{layer.updateView(bounds,bounds,1,1,1,undefined,true);await flush();};
    try{
        set(7,9);for(let i=0;i<5;i++)await update();expect(pending.size).toBe(3);expect([...pending.values()].every(p=>p.ref.ids.some((id:number)=>id%12===0))).toBe(true);
        await update(right);for(let i=0;i<3;i++)await update(right);expect([...pending.entries()].filter(([key])=>['7-9-0','7-9-2','7-9-4'].includes(key)).every(([,p])=>p.signal.aborted)).toBe(true);
        set(9,9);for(let i=0;i<5;i++)await update(right);expect([...pending.entries()].filter(([key])=>key.startsWith('7-9')).every(([,p])=>p.signal.aborted)).toBe(true);
        for(const [key,p] of pending)if(key.startsWith('9-9')&&!p.signal.aborted)p.resolve(p.ref.ids.map((id:number)=>({id,means:new Float32Array(256).fill(9),weights:new Float32Array(256).fill(.25)})));
        await flush();await update(right);expect(layer.stats.visibleRegions).toBe(3);expect(peak).toBeLessThanOrEqual(4);expect(exact).toBe(0);
    }finally{layer.dispose();await flush();}
});
test('exact empty-region metadata avoids filtered-grid downloads while preserving neutral coverage',async()=>{
    let filters=0;
    const source={getLod4SummaryIndex:async()=>({batches:[{mode:'size',tile:0,ids:[0],url:'base'}]}),getLod4SummaryBatch:async()=>[page(0)],
        getParcelFilterIndex:async()=>({low:9,high:9,matchingRegions:[],batches:[{tile:0,ids:[0],url:'empty'}]}),getParcelFilterBatch:async()=>{filters++;throw Error('Known-empty grid must not download');}} as unknown as MapDataSource;
    const layer=new SpatialSummaryLayer(source,[slots[0]],()=>{},e=>{throw e;});layer.setColors(['#49099e','#c03e80','#ffff00']);layer.setSummaries(Float32Array.of(1,0));
    layer.setMetric({mode:'size',filtered:true,range:[9,9],kind:'parcel',pixels:new Float32Array(2),occupiedAreas:new Float32Array(1)});
    try{for(let i=0;i<6;i++){layer.updateView(view,view,1,1,1,undefined,true);await flush();}expect(filters).toBe(0);expect(layer.stats.visibleRegions).toBe(1);
        const summary=(layer as any).records.get('size:0').layer.summaries;expect(Array.from(summary as Float32Array).filter((_v,i)=>i%2===1).every(v=>v===0)).toBe(true);
    }finally{layer.dispose();}
});
