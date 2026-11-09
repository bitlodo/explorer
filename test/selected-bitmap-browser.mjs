import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createServer} from 'vite';
import {clientConfig} from '../vite.config.ts';
import {browserHarness} from './helpers/browser.mjs';
const port=Number(process.env.MAP_DEV_TEST_PORT||5392),origin=`http://127.0.0.1:${port}`;
process.env.MAP_SMOKE_PORT??='4324';process.env.MAP_SMOKE_DEBUG_PORT??='9352';
const server=await createServer({...clientConfig(),configFile:false,server:{...clientConfig().server,port,strictPort:true}});
let browser;
try{
    await server.listen();browser=await browserHarness({development:true});await browser.start();
    const {evaluate,wait,frame,cdp}=browser;
    await cdp('Page.navigate',{url:origin+'/'});await wait("!!document.getElementById('mapCanvas')");
    await evaluate(`window.state=()=>{const e=document.getElementById('mapCanvas'),key=Object.keys(e).find(k=>k.startsWith('__reactFiber$'));for(let f=e[key];f;f=f.return)for(let h=f.memoizedState;h;h=h.next){const r=h.memoizedState?.current??h.memoizedState;if(r?.controller)return r.controller;}};`);
    await wait('state()?.getState().ready&&!state().getState().renderingBusy');
    const pixels=await evaluate(`(async()=>{
        const s=state(),T=await import(performance.getEntriesByType('resource').find(r=>r.name.includes('/deps/three.js?')).name),renderer=s.runtime.renderer,n=await s.ensureNeighborhood(0);
        const bitmaps=[{x:0,y:0,width:8,height:8},{x:10,y:0,width:8,height:8}],bounds={x:0,y:0,width:18,height:8};
        const parcel=new n.compactParcels.constructor();parcel.setBitmapSizes(bitmaps);parcel.setLOD(6,1,true);bitmaps.forEach((b,i)=>parcel.addBitmap(i,b,[{x:0,y:0,width:8,height:8}]));
        const vector=new s.neighborhoodGeometry.constructor([bounds]);vector.addRegion({neighborhood:0,width:18,height:8,bitmaps},bounds);
        for(let t=0;t<=1000;t+=20)vector.updateView(bounds,1,1,0,t);vector.labels.visible=false;
        const metric=new T.DataTexture(Float32Array.of(-1,-1),2,1,T.RedFormat,T.FloatType);metric.needsUpdate=true;
        const scene=new T.Scene(),camera=new T.OrthographicCamera(-1,19,1,-9,.1,100);camera.position.set(0,10,0);camera.up.set(0,0,-1);camera.lookAt(0,0,0);camera.updateMatrixWorld();
        const target=new T.WebGLRenderTarget(400,200);target.texture.colorSpace=T.LinearSRGBColorSpace;
        const previous=renderer.getRenderTarget(),tone=renderer.toneMapping,results=[];
        const render=()=>{renderer.setRenderTarget(target);renderer.clear();renderer.render(scene,camera);return [4,14].map(x=>{const v=new T.Vector3(x,0,4).project(camera),out=new Uint8Array(4);renderer.readRenderTargetPixels(target,Math.floor((v.x+1)/2*target.width),Math.floor((v.y+1)/2*target.height),1,1,out);return [...out];});};
        try{
            renderer.toneMapping=T.NoToneMapping;
            for(const [name,layer] of [['bitmap',vector],['parcel',parcel]]){
                scene.add(layer);layer.setAnalytic(metric);layer.setInspectedBitmap();const original=render();
                layer.setInspectedBitmap(0);const first=render();layer.setInspectedBitmap(1);const second=render();layer.setInspectedBitmap();const restored=render();
                results.push({name,original,first,second,restored});scene.remove(layer);
            }
            if(renderer.info.programs.some(p=>p.diagnostics?.runnable===false))throw Error('Selection shader failed to compile');return results;
        }finally{renderer.setRenderTarget(previous);renderer.toneMapping=tone;target.dispose();metric.dispose();parcel.dispose();vector.dispose();}
    })()`);
    for(const result of pixels){
        assert.deepEqual(result.first[0],[255,255,255,255],result.name+': inspected geometry is white');
        assert.deepEqual(result.first[1],result.original[1],result.name+': other bitmaps retain their filter color');
        assert.deepEqual(result.second[0],result.original[0]);assert.deepEqual(result.second[1],[255,255,255,255]);
        assert.deepEqual(result.restored,result.original,result.name+': clearing selection restores exact colors');
    }
    await evaluate('state().goToBitmap(170)');await wait('state().getState().selection?.id===170&&state().loadedBitmaps.has(170)&&!state().tween?.isPlaying()');await frame();
    assert.equal(await evaluate('state().neighborhoodGeometry.material.uniforms.inspectedBitmap.value'),170);
    assert.equal(await evaluate('state().neighborhoods.get(0).compactParcels.material.uniforms.inspectedBitmap.value'),170);
    await evaluate("state().setRenderingMode('count')");assert.equal(await evaluate('state().neighborhoodGeometry.material.uniforms.inspectedBitmap.value'),170);
    await fs.writeFile('/tmp/bitmap-selected-white.png',Buffer.from((await cdp('Page.captureScreenshot',{format:'png'})).data,'base64'));
    await evaluate('state().clearSelection()');assert.equal(await evaluate('state().neighborhoodGeometry.material.uniforms.inspectedBitmap.value'),-1);
    assert.equal(await evaluate('state().neighborhoods.get(0).compactParcels.material.uniforms.inspectedBitmap.value'),-1);
    assert.deepEqual(browser.errors,[]);
    const report={status:'passed',pixels,inspectorSelection:true,preservedOnModeChange:true,clearRestoresColors:true,exceptions:0};
    await fs.writeFile('/tmp/bitmap-selected-white.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{if(browser)await browser.close();await server.close();}
