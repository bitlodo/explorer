import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { browserHarness } from './helpers/browser.mjs';
const browser=await browserHarness();
const {cdp,evaluate,wait,delay,requests,errors}=browser;
try{
    await browser.start();
    await cdp('Emulation.setDeviceMetricsOverride',{width:1600,height:1000,deviceScaleFactor:1,mobile:false});
    await cdp('Page.navigate',{url:browser.origin+'/repository/'});
    await wait("!!document.getElementById('mapCanvas')");
    await evaluate(`window.state=()=>{const e=document.getElementById('mapCanvas'),key=Object.keys(e).find(k=>k.startsWith('__reactFiber$'));for(let f=e[key];f;f=f.return)for(let h=f.memoizedState;h;h=h.next){const r=h.memoizedState?.current??h.memoizedState;if(r?.controller)return r.controller;}};`);
    await wait('state()?.getState().ready&&!state().getState().renderingBusy&&state().preview?.rootsReady');
    await delay(750);
    assert.equal(requests.filter(p=>p.includes('/lod4')).length,0,'Opening zoom 5 downloads no LOD4 data');
    const areaHash=await evaluate('state().layerAnalysis.area.values.sha256');
    const areaRequests=()=>requests.filter(p=>p.endsWith('/colors/'+areaHash+'.pb')).length;
    assert.equal(areaRequests(),0,'Opening Bitmap Area uses metadata without the full per-bitmap array');
    const layouts=await evaluate('state().source.stats.neighborhoodLayouts');
    await evaluate('state().setZoom(Math.sqrt(state().getZoom().stops[3]*state().getZoom().stops[4]),"drag")');
    await wait('!state().zoomDamping.active');await delay(300);
    assert.equal(requests.filter(p=>p.includes('/lod4')).length,0,'Approaching stop 4 starts no addon discovery or pages');
    await evaluate('state().setZoom(state().getZoom().stops[3],"drag")');
    await wait('state().preview.spatialStats.visibleRegions===state().preview.spatialStats.wanted&&state().preview.spatialStats.wanted>0&&state().preview.spatialStats.active===0&&!state().zoomDamping.active');
    await delay(1200);
    const initial=await evaluate('state().preview.spatialStats');
    assert.ok(initial.loaded<=521&&initial.decodedBytes<=24*1024*1024&&initial.budgetLimited===0&&initial.cells>initial.visibleRegions,'Zoom 4 refines every resolvable visible region within its byte budget');
    assert.equal(await evaluate('state().source.stats.neighborhoodLayouts'),layouts,'Zoom 4 does not build exact neighborhood layouts');
    assert.equal(requests.some(p=>p.includes('/bitmap-chunks/')),false,'Zoom 4 does not download exact bitmap geometry');
    assert.equal(areaRequests(),0,'LOD4 pages provide their own bitmap areas without a global array download');
    const screenshot=async name=>fs.writeFile(`/tmp/bitmap-lod4-${name}.png`,Buffer.from((await cdp('Page.captureScreenshot',{format:'png'})).data,'base64'));
    await screenshot('area');
    const checkCells=async()=>evaluate(`(()=>{
        const s=state(),host=s.preview.spatial,spatial=host.useExact?host.exact:host,metric=spatial.metric;
        for(const [id,r] of spatial.records){
            if(!r.layer?.visible)continue;
            const p=r.page,step=r.step,rowStep=r.rowStep,output=r.layer.summaries;
            let cell=0;
            if(!p.bitmapAreas){
                const noMatches=host.rangeKey&&host.filterIndexes.get(host.rangeKey)?.matchingRegions&&!host.filterIndexes.get(host.rangeKey).matchingRegions.includes(p.id);
                const selected=noMatches?{means:new Float32Array(p.means.length).fill(1),weights:new Float32Array(p.weights.length)}:host.rangeKey?host.filterRecords.get(host.rangeKey+':'+p.id)?.page:undefined;
                if(host.rangeKey&&!selected)throw Error('Missing visible filtered grid');
                for(let row=0;row<p.rows;row+=rowStep)for(let col=0;col<p.columns;col+=step,cell++){
                    let sum=0,weight=0,total=0;
                    for(let y=row;y<Math.min(p.rows,row+rowStep);y++)for(let x=col;x<Math.min(p.columns,col+step);x++){
                        const c=y*p.columns+x,w=selected?.weights[c]??p.weights[c];sum+=(selected?.means[c]??p.means[c])*w;weight+=w;total+=p.weights[c];
                    }
                    let score=weight?sum/weight:1;
                    if(metric.kind==='scalar'&&weight){const f=metric.summary.scale==='log'?Math.log1p:v=>v,span=f(metric.summary.max)-f(metric.summary.min);score=1+8*(span?Math.max(0,Math.min(1,(f(score)-f(metric.summary.min))/span)):0);}
                    if(Math.abs(output[cell*2]-score)>2e-6||Math.abs(output[cell*2+1]-(total?Math.min(1,weight/total):0))>1e-6)throw Error('Incorrect precomputed summary');
                }
                continue;
            }
            for(let row=0;row<p.rows;row+=rowStep)for(let col=0;col<p.columns;col+=step,cell++){
                let total=0,chosen=0,sum=0;
                for(let y=row;y<Math.min(p.rows,row+rowStep);y++)for(let x=col;x<Math.min(p.columns,col+step);x++){
                    const original=y*p.columns+x;let bitmap=0;
                    for(let i=p.cellOffsets[original];i<p.cellOffsets[original+1];i++){
                        bitmap+=p.memberDeltas[i];const global=id*2016+bitmap,fraction=p.overlapAreas[i]/p.bitmapAreas[bitmap];
                        if(metric.kind==='parcel'){
                            const area=metric.occupiedAreas[global],selected=area*metric.pixels[global*2+1];total+=area*fraction;chosen+=selected*fraction;sum+=selected*metric.pixels[global*2]*fraction;
                        }else{
                            const value=metric.values?metric.values[global]:p.bitmapAreas[bitmap];
                            const transform=metric.summary.scale==='log'?Math.log1p:v=>v;
                            const min=transform(metric.summary.min),span=transform(metric.summary.max)-min;
                            const score=metric.scores?metric.scores[global]:Math.fround(1+8*(span?(transform(value)-min)/span:0));
                            total+=fraction;
                            if(score>=metric.low-.000001&&score<=metric.high+.000001){chosen+=fraction;sum+=value*fraction;}
                        }
                    }
                }
                const share=total?chosen/total:0;
                if(Math.abs(output[cell*2+1]-share)>1e-6)throw Error('Incorrect spatial matching share');
                if(chosen){let score=sum/chosen;if(metric.kind==='scalar'){
                    const f=metric.summary.scale==='log'?Math.log1p:v=>v,span=f(metric.summary.max)-f(metric.summary.min);
                    score=1+8*(span?Math.max(0,Math.min(1,(f(score)-f(metric.summary.min))/span)):0);
                }if(Math.abs(output[cell*2]-score)>1e-6)throw Error('Incorrect spatial raw-value mean');}
            }
        }
        return spatial.stats;
    })()`);
    const stats={area:await checkCells()};
    await evaluate('state().setMetricFilter(.2,.7)');await browser.frame();await checkCells();
    assert.equal(areaRequests(),1,'The full area array is loaded only for explicit filtering');
    await evaluate('state().setMetricFilter(0,1)');await browser.frame();await checkCells();assert.equal(areaRequests(),1,'Reset reuses metadata and cached values');
    for(const mode of ['count','diversity','occupancy','size']){
        await evaluate(`state().setRenderingMode('${mode}')`);await wait('!state().getState().renderingBusy');await browser.frame();
        if(mode==='size')await evaluate('state().setParcelRange(7,9)');else await evaluate('state().setMetricFilter(.2,.7)');
        await browser.frame();stats[mode]=await checkCells();await screenshot(mode);
    }
    // Settled pan/zoom state must not rewrite any instance attributes.
    await delay(1200);
    const versions=()=>evaluate(`(()=>{const host=state().preview.spatial,s=host.useExact?host.exact:host;return [...s.records.values()].flatMap(r=>r.layer?[...Object.values(r.layer.mesh.geometry.attributes)].map(a=>a.version):[]);})()`);
    const before=await versions();await delay(400);assert.deepEqual(await versions(),before,'Settled cells do not upload instance buffers');
    await evaluate("state().setRenderingMode('count')");await wait('!state().getState().renderingBusy');
    await evaluate('state().setMetricFilter(0,0)');await browser.frame();await checkCells();await screenshot('one-tx');
    for(const [width,height] of [[2048,1152],[1024,768],[1600,1000]]){
        await cdp('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});await browser.frame();
        await evaluate('state().setZoom(state().getZoom().stops[3],"drag")');await wait('!state().zoomDamping.active');
        await wait('state().preview.spatialStats.visibleRegions===state().preview.spatialStats.wanted&&state().preview.spatialStats.active===0');
        await wait(`(()=>{const s=state(),b=s.groundBounds(),p=s.pixelsPerWorld(),host=s.preview.spatial,sp=host.useExact?host.exact:host;const ids=s.overview.slots.flatMap((r,id)=>r.x<b.x+b.width&&r.x+r.width>b.x&&r.y<b.y+b.height&&r.y+r.height>b.y&&Math.max(r.width,r.height)*p>=8?[id]:[]);return sp.stats.active===0&&sp.stats.wanted===ids.length&&ids.every(id=>sp.records.get(id)?.layer?.visible);})()`);
        const coverage=await evaluate(`(()=>{const s=state(),b=s.groundBounds(),p=s.pixelsPerWorld(),host=s.preview.spatial,sp=host.useExact?host.exact:host;const ids=s.overview.slots.flatMap((r,id)=>r.x<b.x+b.width&&r.x+r.width>b.x&&r.y<b.y+b.height&&r.y+r.height>b.y&&Math.max(r.width,r.height)*p>=8?[id]:[]);return{expected:ids.length,missing:ids.filter(id=>!sp.records.get(id)?.layer?.visible),stats:sp.stats};})()`);
        assert.deepEqual(coverage.missing,[],`Every resolvable neighborhood is refined at ${width}x${height}`);assert.equal(coverage.stats.wanted,coverage.expected);
        await checkCells();
    }
    await evaluate('state().setZoom(state().getZoom().stops[2],"drag")');await delay(1800);
    await wait('state().neighborhoodChunks.ready(state().geometryBounds())');await delay(1500);await screenshot('exact');
    await evaluate('state().setZoom(state().getZoom().stops[3],"drag")');
    await wait('!state().zoomDamping.active&&state().preview.spatialStats.active===0');await delay(700);await checkCells();await screenshot('reverse');
    assert.ok(await evaluate('state().runtime.renderer.info.programs.every(p=>p.diagnostics?.runnable!==false)'),'All LOD shaders compile');
    assert.equal(errors.length,0,JSON.stringify(errors));
    console.log(JSON.stringify({initial,stats,pages:requests.filter(p=>p.includes('/lod4/regions/')).length,exceptions:errors.length}));
}catch(error){
    console.error(JSON.stringify(await evaluate(`(()=>{const s=state(),p=s.preview.spatial;return{status:{mode:s.snapshot.renderingMode,error:s.snapshot.renderingError,filter:s.snapshot.filter},spatial:p.stats,global:s.globalMetric,mode:s.renderingMode,failed:[...p.retry.failures],wanted:[...p.wanted],missing:[...p.wanted].filter(id=>!p.records.get(id)?.layer?.visible),records:[...p.records].filter(([id])=>p.wanted.has(id)).map(([id,r])=>({id,visible:r.layer?.visible,ready:p.metric?.ready?.(id)})),bounds:s.groundBounds(),distance:s.scene.camera.position.y,stops:s.distanceLevels()};})()`)));
    throw error;
}finally{await browser.close();}
