import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createServer} from 'vite';
import {clientConfig} from '../vite.config.ts';
import {browserHarness} from './helpers/browser.mjs';
const port=Number(process.env.MAP_DEV_TEST_PORT||5393),origin=`http://127.0.0.1:${port}`,config=clientConfig();
const server=await createServer({...config,configFile:false,server:{...config.server,port,strictPort:true}});
let browser;const report={requests:[],samples:[]};
try{
    await server.listen();browser=await browserHarness({development:true});const ws=await browser.start(),byId=new Map();
    ws.addEventListener('message',event=>{const m=JSON.parse(event.data),p=m.params;
        if(m.method==='Network.requestWillBeSent'&&p.request.url.startsWith(origin+'/map-data/')){const r={path:new URL(p.request.url).pathname,bytes:0};report.requests.push(r);byId.set(p.requestId,r);}
        if(m.method==='Network.dataReceived'&&byId.has(p.requestId))byId.get(p.requestId).bytes+=p.dataLength;
        if(m.method==='Network.loadingFinished'&&byId.has(p.requestId))byId.get(p.requestId).wireBytes=p.encodedDataLength;
    });
    const {cdp,evaluate,wait,delay}=browser;await cdp('Network.enable');await cdp('Emulation.setDeviceMetricsOverride',{width:1600,height:1000,deviceScaleFactor:1,mobile:false});await cdp('Page.navigate',{url:origin+'/'});
    await wait("!!document.getElementById('mapCanvas')");await evaluate(`window.state=()=>{const e=document.getElementById('mapCanvas'),key=Object.keys(e).find(k=>k.startsWith('__reactFiber$'));for(let f=e[key];f;f=f.return)for(let h=f.memoizedState;h;h=h.next){const r=h.memoizedState?.current??h.memoizedState;if(r?.controller)return r.controller;}};`);
    await wait('state()?.getState().ready&&!state().getState().renderingBusy');await evaluate("state().setRenderingMode('size')");
    const at5=report.requests.length;await evaluate('state().setParcelRange(9,9)');await browser.frame();
    assert.equal(await evaluate('state().getState().parcelMatches===state().layerAnalysis.parcel.counts[8]'),true,'Global selected parcel count remains exact');
    const far=report.requests.slice(at5);assert.equal(far.some(r=>/\/range-|\/metrics\/values\/|\/summaries\/n\d/.test(r.path)),false,'Stop 5 filter needs only compact exact totals');
    report.stop5={bytes:far.reduce((s,r)=>s+r.bytes,0),requests:far.length};
    await evaluate('state().setParcelRange(1,9)');await evaluate('state().setZoom(state().distanceLevels()[3],"drag")');
    const settle=async()=>{await browser.frame();await wait(`(()=>{const s=state(),p=s.preview.spatial,st=p.stats;return !s.zoomDamping.active&&st.wanted>0&&st.active===0&&st.visibleRegions===st.wanted&&(!p.rangeKey||(p.filterIndexes.has(p.rangeKey)&&!p.filterLoad&&[...p.filterWanted.keys()].every(k=>p.filterBatches.has(k))));})()`);await browser.frame();};
    await settle();
    const range=async(low,high)=>{const start=report.requests.length;await evaluate(`state().setParcelRange(${low},${high})`);await settle();await delay(50);
        const sample=await evaluate(`(()=>{const s=state(),p=s.preview.spatial,k=p.rangeKey,index=p.filterIndexes.get(k),b=s.groundBounds(),px=s.pixelsPerWorld(),ids=s.overview.slots.flatMap((r,id)=>r.x<b.x+b.width&&r.x+r.width>b.x&&r.y<b.y+b.height&&r.y+r.height>b.y&&Math.max(r.width,r.height)*px>=8?[id]:[]);return {range:s.snapshot.parcelRange,view:ids,visible:p.stats.visibleRegions,matching:index.matchingRegions,batches:index.batches.map(r=>({path:'/map-data/'+r.url,ids:r.ids})),local:s.localReady.size,matches:s.snapshot.parcelMatches,bitmapMatches:s.snapshot.filterMatches};})()`);
        const requests=report.requests.slice(start),batches=requests.filter(r=>/\/range-.*\/t\d/.test(r.path));
        for(const r of batches){const ref=sample.batches.find(b=>b.path===r.path);assert.ok(ref&&ref.ids.some(id=>sample.view.includes(id)&&(!sample.matching||sample.matching.includes(id))),'Every downloaded batch serves the actual viewport');}
        assert.ok(batches.length<81,'A filter does not download the whole-map range');assert.equal(sample.local,0,'Stop 4 does not load per-bitmap class pages');
        report.samples.push({...sample,requests:requests.length,filterBatches:batches.length,bytes:requests.reduce((s,r)=>s+r.bytes,0)});
    };
    await range(9,9);await range(7,9);const before=report.requests.length;await range(7,9);assert.equal(report.requests.length,before,'Repeating a range reuses its content');
    await evaluate('Promise.all([state().setParcelRange(1,3),state().setParcelRange(4,6),state().setParcelRange(5,9)])');await settle();assert.deepEqual(await evaluate('state().getState().parcelRange'),[5,9]);
    assert.equal(report.requests.some(r=>/\/range-01-03\/|\/range-04-06\//.test(r.path)),false,'Replaced slider ranges do not start spatial downloads');
    const stop4End=report.requests.length;
    assert.equal(report.requests.some(r=>r.path.includes('7177dfe70c0d37f53c060f3ea53d86d753e6a9c0d7d8d25dc39f81637df4f109')),false,'The 10 MB global class array is never requested');
    assert.equal(report.requests.some(r=>/\/summaries\/n\d|\/metrics\/values\//.test(r.path)),false,'Overview filters need neither membership nor bitmap classes');
    assert.ok(report.requests.every(r=>(r.wireBytes??0)<=200*1024),'Every overview/filter transfer is below 200 KiB: '+JSON.stringify(report.requests.filter(r=>(r.wireBytes??0)>200*1024)));
    assert.ok(report.requests.filter(r=>r.path.includes('/parcel-filters/')).every(r=>r.bytes<=100*1024),'Spatial filter files fit below 100 KiB even without compression');
    const seen=await evaluate('[...state().preview.spatial.filterBatches.keys()]');
    await evaluate(`(()=>{const s=state(),r=s.overview.slots[450];s.scene.camera.position.set(r.x+r.width/2,s.distanceLevels()[3],r.y+r.height/2);s.scene.controls.target.set(r.x+r.width/2,0,r.y+r.height/2);s.scene.controls.update();s.requestUpdate();})()`);await browser.frame();await settle();
    assert.ok((await evaluate('[...state().preview.spatial.filterBatches.keys()]')).length>=seen.length);
    await fs.writeFile('/tmp/bitmap-parcel-filter-streaming.png',Buffer.from((await cdp('Page.captureScreenshot',{format:'png'})).data,'base64'));
    await evaluate('state().setZoom(state().distanceLevels()[2],"drag")');await wait('!state().zoomDamping.active&&state().localReady.size>0');
    const local=await evaluate(`(async()=>{const s=state(),id=[...s.localReady][0],page=await s.source.getSpatialMetricPage(id,new AbortController().signal),low=s.snapshot.parcelRange[0],high=s.snapshot.parcelRange[1];for(let i=0;i<page.count.length;i++){let total=0,chosen=0,sum=0;for(let j=0;j<9;j++){const a=page.classes[i*9+j]*(j+1)**2;total+=a;if(j+1>=low&&j+1<=high){chosen+=a;sum+=a*(j+1);}}const global=id*2016+i;if(s.parcelResult.pixels[global*2]!==Math.fround(chosen?sum/chosen:1)||s.parcelResult.pixels[global*2+1]!==Math.fround(chosen/total))throw Error('Incorrect local class filter');}return page.count.length;})()`);
    assert.ok(local>0);assert.equal(report.requests.some(r=>r.path.includes('7177dfe70c0d37f53c060f3ea53d86d753e6a9c0d7d8d25dc39f81637df4f109')),false);
    assert.equal(browser.errors.length,0,JSON.stringify(browser.errors));report.stop4Requests=stop4End;report.errors=browser.errors;
    await fs.writeFile('/tmp/bitmap-parcel-filter-streaming.json',JSON.stringify(report,null,2));console.log(JSON.stringify({status:'passed',stop5:report.stop5,samples:report.samples.map(s=>({range:s.range,bytes:s.bytes,batches:s.filterBatches,visible:s.visible})),local,exceptions:browser.errors.length}));
}catch(error){await fs.writeFile('/tmp/bitmap-parcel-filter-streaming-partial.json',JSON.stringify(report,null,2));if(browser)console.error(JSON.stringify(await browser.evaluate(`(()=>{const s=state(),p=s?.preview?.spatial;return {status:s?.getState(),stats:p?.stats,range:p?.rangeKey,filters:p?[...p.filterIndexes.keys()]:[],active:p?[...p.filterActive.keys()]:[],failures:p?[...p.retry.failures]:[]};})()`).catch(()=>null)));throw error;}
finally{if(browser)await browser.close();await server.close();}
