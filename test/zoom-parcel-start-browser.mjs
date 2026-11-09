import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createServer} from 'vite';
import {clientConfig} from '../vite.config.ts';
import {browserHarness} from './helpers/browser.mjs';
const config=clientConfig(),port=Number(process.env.MAP_DEV_TEST_PORT||5396),origin=`http://127.0.0.1:${port}`;
const server=await createServer({...config,configFile:false,server:{...config.server,port,strictPort:true}});let browser;
try{
    await server.listen();browser=await browserHarness({development:true});await browser.start();const {cdp,evaluate,wait,delay}=browser;
    await cdp('Emulation.setDeviceMetricsOverride',{width:1600,height:1000,deviceScaleFactor:1,mobile:false});await cdp('Page.navigate',{url:origin+'/'});
    await wait("!!document.getElementById('mapCanvas')");await evaluate(`window.s=()=>{const e=document.getElementById('mapCanvas'),k=Object.keys(e).find(k=>k.startsWith('__reactFiber$'));for(let f=e[k];f;f=f.return)for(let h=f.memoizedState;h;h=h.next){const r=h.memoizedState?.current??h.memoizedState;if(r?.controller)return r.controller;}};`);
    await wait('s()?.getState().ready&&!s().getState().renderingBusy');
    const setup=await evaluate(`(()=>{
        const c=s(),slots=c.overview.slots,a=slots[350];let edge;
        for(let id=1;id<slots.length&&!edge;id++){
            if(id===350)continue;const b=slots[id],top=Math.max(a.y,b.y),bottom=Math.min(a.y+a.height,b.y+b.height),left=Math.max(a.x,b.x),right=Math.min(a.x+a.width,b.x+b.width);
            if(bottom-top>500&&Math.abs(a.x+a.width-b.x)<1e-6)edge={x:b.x,z:(top+bottom)/2,blocked:id};
            else if(right-left>500&&Math.abs(a.y+a.height-b.y)<1e-6)edge={x:(left+right)/2,z:b.y,blocked:id};
        }
        if(!edge)throw Error('No adjacent boundary fixture');
        c.cancelZoom();c.tween?.stop();c.scene.camera.position.set(edge.x,c.distanceLevels()[2],edge.z);c.scene.controls.target.set(edge.x,0,edge.z);c.scene.controls.update();c.requestUpdate();window.zoomFixture=edge;return edge;
    })()`);
    await wait('s().neighborhoodChunks.ready(s().geometryBounds())');await delay(650);
    assert.equal(await evaluate('s().scheduler.desiredCount'),0,'Idle stop 3 starts no parcel work');assert.equal(await evaluate('s().loadedBitmaps.size'),0);
    await evaluate(`(()=>{
        const c=s();window.zoomTrace={start:performance.now(),audits:[],geometry:[],requests:[],arrivals:[]};const elapsed=()=>performance.now()-zoomTrace.start;
        const geometry=c.source.getNeighborhood.bind(c.source);
        c.source.getNeighborhood=async function(id,signal){
            zoomTrace.geometry.push({id,time:elapsed(),height:c.scene.camera.position.y});
            if(id===zoomFixture.blocked)await new Promise((resolve,reject)=>{window.releaseZoomNeighbor=resolve;signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});
            return geometry(id,signal);
        };
        const desired=c.scheduler.onDesired;c.scheduler.onDesired=function(ids){desired?.(ids);if(!ids.length)return;const f=c.parcelDownloadView().frustum;let outside=0;
            for(const id of ids){const n=c.neighborhoods.get(Math.floor(id/2016)),r=n.data.bitmaps[id%2016];if(!f.intersects(r,n.position.x,n.position.z))outside++;}
            zoomTrace.audits.push({time:elapsed(),height:c.scene.camera.position.y,count:ids.length,outside});
        };
        const stream=c.source.streamParcelJob.bind(c.source);c.source.streamParcelJob=async function*(job,signal){zoomTrace.requests.push({time:elapsed(),height:c.scene.camera.position.y,key:job.key});yield* stream(job,signal);};
        const begin=c.arrivalFades.begin.bind(c.arrivalFades);c.arrivalFades.begin=function(id){zoomTrace.arrivals.push({time:elapsed(),id,height:c.scene.camera.position.y});begin(id);};
        c.zoomDamping.snap(c.scene.camera.position.y,performance.now(),c.closestDistance,c.zoomLevels[3],c.distanceLevels()[1]);c.requestUpdate();
    })()`);
    await wait('s().pendingNeighborhoods.has(zoomFixture.blocked)&&[...s().loadedBitmaps].some(id=>Math.floor(id/2016)!==zoomFixture.blocked&&s().arrivalFades.opacityFor(id)>0&&s().neighborhoods.get(Math.floor(id/2016))?.visible)');
    const independent=await evaluate(`({blocked:zoomFixture.blocked,pending:s().pendingNeighborhoods.has(zoomFixture.blocked),detail:s().lodDetail,vectorStop:s().preview.pyramid.maxLevel+1,loaded:s().loadedBitmaps.size,trace:zoomTrace,stop2:s().distanceLevels()[1],height:s().scene.camera.position.y})`);
    assert.equal(independent.pending,true);assert.ok(independent.detail>independent.vectorStop,'The ready region displays parcels while a neighbor is blocked');
    assert.ok(independent.trace.geometry[0].height>independent.stop2*1.01,'Canonical geometry starts during the zoom approach');
    assert.ok(independent.trace.requests.some(r=>r.height>independent.stop2*1.01),'Parcel bodies start before reaching stop 2');
    assert.ok(independent.trace.audits.every(a=>a.outside===0),'Every anticipated bitmap intersects the final stop-2 frustum');
    await fs.writeFile('/tmp/bitmap-zoom-parcel-start.png',Buffer.from((await cdp('Page.captureScreenshot',{format:'png'})).data,'base64'));
    await evaluate('releaseZoomNeighbor()');await wait('!s().pendingNeighborhoods.has(zoomFixture.blocked)&&!s().zoomDamping.active');
    assert.ok(await evaluate('s().scheduler.stats.maxConcurrentDownloads<=2'));
    const frustum=await evaluate(`(()=>{const c=s(),view=c.parcelDownloadView(),b=c.groundBounds();return{download:view.frustum.bounds,actual:b};})()`);
    assert.ok(Math.abs(frustum.download.height-frustum.actual.height)<1,'At stop 2 the anticipated frustum becomes the actual frustum');
    await evaluate('s().setZoom(s().distanceLevels()[2],"drag")');await browser.frame();await delay(180);assert.equal(await evaluate('s().scheduler.desiredCount'),0,'Returning to idle stop 3 cancels new work');
    const finalTrace=await evaluate('zoomTrace');assert.ok(finalTrace.audits.every(a=>a.outside===0));assert.equal(browser.errors.length,0,JSON.stringify(browser.errors));
    await fs.writeFile('/tmp/bitmap-zoom-parcel-start.json',JSON.stringify({setup,independent,trace:finalTrace,exceptions:browser.errors},null,2));
    console.log(JSON.stringify({status:'passed',firstGeometryMs:finalTrace.geometry[0].time,firstParcelRequestMs:finalTrace.requests[0]?.time,firstArrivalMs:finalTrace.arrivals[0]?.time,independentNeighbor:true,outside:0,exceptions:0}));
}catch(error){if(browser)console.error(JSON.stringify(await browser.evaluate('({status:s()?.getState(),fixture:window.zoomFixture,trace:window.zoomTrace,regions:[...s().neighborhoods.keys()],pending:[...s().pendingNeighborhoods.keys()],desired:s().scheduler.desiredCount,detail:s().lodDetail})').catch(()=>null)));throw error;}
finally{if(browser)await browser.close();await server.close();}
