import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { browserHarness } from './helpers/browser.mjs';

const browser=await browserHarness();
const {cdp,evaluate,wait,delay}=browser;
try{
    await browser.start();
    await cdp('Emulation.setDeviceMetricsOverride',{width:1600,height:1000,deviceScaleFactor:1,mobile:false});
    await cdp('Page.navigate',{url:process.env.ATLAS_DEV_URL||browser.origin+'/repository/'});
    await wait("!!document.getElementById('mapCanvas')");
    await evaluate(`window.controller=()=>{const e=document.getElementById('mapCanvas');if(!e)return;const key=Object.keys(e).find(k=>k.startsWith('__reactFiber$'));for(let f=e[key];f;f=f.return)for(let h=f.memoizedState;h;h=h.next){const runtime=h.memoizedState?.current??h.memoizedState;if(runtime?.controller)return runtime.controller;}};`);
    await wait("controller()?.getState().ready&&!controller().getState().renderingBusy&&controller().preview?.pyramid");
    assert.equal(await evaluate('controller().getState().renderingMode'),'patterns');
    assert.equal(await evaluate('controller().preview.analyticalPolicy'),'analytical-region-summary-v11-original-value-means');
    assert.equal(await evaluate("Array.from(document.querySelectorAll('#rendering-layer option')).some(e=>e.value==='default')"),false);
    assert.equal(await evaluate('controller().preview.stats.requests'),0,'Analytical LOD never downloads spatially averaged raster tiles');
    const pixels=await evaluate(`(async()=>{
        const T=await import('/test-three.js'),s=controller(),renderer=s.runtime.renderer;
        let downloads=0;
        const index={tileSize:200,resolution:4,maxLevel:0,tiles:[]};
        const slots=[{x:0,y:0,width:90,height:100},{x:110,y:0,width:90,height:100}];
        const layer=new s.preview.constructor({getPreviewIndex:async()=>index,getPreviewTile:async()=>{downloads++;throw Error('Raster tiles must not be requested');}},slots,()=>{},e=>{throw e;});
        // Region 0 has no matching bitmaps, even if its unfiltered average is 5.
        // Region 1 has actual matches; the gap between them must stay empty.
        layer.setRegionSummaries(Float32Array.of(5,0,5,1));layer.setIndex(index);
        layer.setSizeColors(Array(9).fill('#ffffff'));
        const scene=new T.Scene();scene.add(layer);
        const camera=new T.OrthographicCamera(0,200,50,-50,.1,100);camera.position.set(0,10,50);camera.up.set(0,0,-1);camera.lookAt(0,0,50);camera.updateMatrixWorld();
        const target=new T.WebGLRenderTarget(200,100);target.texture.colorSpace=T.LinearSRGBColorSpace;
        const previous=renderer.getRenderTarget(),tone=renderer.toneMapping,clear=renderer.getClearColor(new T.Color()).clone(),alpha=renderer.getClearAlpha();
        try{
            renderer.toneMapping=T.NoToneMapping;renderer.setClearColor(0,0);renderer.setRenderTarget(target);
            const render=geometry=>{layer.updateView({x:0,y:0,width:200,height:100},0,0,1,geometry);renderer.clear();renderer.render(scene,camera);const out=new Uint8Array(200*100*4);renderer.readRenderTargetPixels(target,0,0,200,100,out);return out;};
            const uniform=out=>{const sets=[new Set(),new Set(),new Set()];for(let y=0;y<100;y++)for(let x=0;x<200;x++){const i=(y*200+x)*4,region=x<90?0:x<110?1:2;if(region!==1&&(y<2||y>=98||(region===0?x<2||x>=88:x<112||x>=198)))continue;sets[region].add(Array.from(out.slice(i,i+4)).join(','));}return sets.map(s=>Array.from(s));};
            const opaque=uniform(render());
            layer.setSizeColors(Array(9).fill('#ff0000'));const red=uniform(render());
            layer.setSizeColors(Array(9).fill('#00ff00'));const green=uniform(render());
            layer.setSizeColors(['#0000ff','#ff00ff']);const area=uniform(render());
            layer.setSizeColors(Array(9).fill('#ffffff'));
            const mask={opacity:.5,cellSize:50,revision:1,coverage:b=>b.x>=110?1:0};
            const halfway=uniform(render(mask));
            const restored=uniform(render({...mask,opacity:0}));
            return{opaque,red,green,area,halfway,restored,downloads,textureBytes:layer.stats.textureBytes};
        }finally{renderer.setRenderTarget(previous);renderer.toneMapping=tone;renderer.setClearColor(clear,alpha);target.dispose();layer.dispose();}
    })()`);
    for(const image of ['opaque','halfway','restored']){
        for(const [region,colors] of pixels[image].entries())assert.equal(colors.length,1,`${image}: region ${region} has one flat interior color, without stripes or noise`);
        assert.equal(pixels[image][1][0],'0,0,0,0',`${image}: canonical gaps contain no preview pixels`);
    }
    for(const palette of ['red','green','area']){assert.deepEqual(pixels[palette][0],pixels.opaque[0],`${palette}: excluded region ignores palette changes`);assert.notDeepEqual(pixels[palette][2],pixels.opaque[2],`${palette}: selected region retains its palette color`);}
    assert.equal(pixels.opaque[2][0],'255,255,255,255','Selected region retains a strong highlight inside its thin border');
    assert.equal(pixels.halfway[0][0],pixels.opaque[0][0],'Missing geometry retains its own summary');
    assert.ok(Math.abs(Number(pixels.halfway[2][0].split(',')[3])-128)<=1,'Resident geometry follows the linear halfway blend');
    assert.deepEqual(pixels.restored,pixels.opaque,'Reverse zoom restores the same flat summaries');
    assert.equal(pixels.downloads,0);assert.equal(pixels.textureBytes,0);
    await evaluate(`(()=>{const s=controller(),r=s.overview.slots[239],x=r.x+r.width/2,z=r.y+r.height/2;s.scene.controls.target.set(x,0,z);s.scene.camera.position.x=x;s.scene.camera.position.z=z;s.scene.controls.update();s.setMetricFilter(.496,.525);})()`);
    for(const [name,height] of [['preview','controller().getZoom().stops[3]'],['blend','Math.sqrt(controller().getZoom().stops[2]*controller().getZoom().stops[3])'],['vectors','controller().getZoom().stops[2]']]){
        await evaluate(`controller().setZoom(${height},"drag")`);await delay(1600);
        await fs.writeFile(`/tmp/bitmap-analytical-lod-${name}.png`,Buffer.from((await cdp('Page.captureScreenshot',{format:'png'})).data,'base64'));
    }
    await evaluate('controller().setRenderingMode("diversity")');
    await evaluate('controller().goToBitmap(64400)');
    await wait('controller().getState().selection?.id===64400&&!controller().tween?.isPlaying()');
    await evaluate(`(()=>{const s=controller(),colors=[...s.getState().palette],m=s.getState().layerSummary;colors[0]='#ff0000';s.setPalette(colors);const lo=Math.log1p(m.min),span=Math.log1p(m.max)-lo;s.setMetricFilter((Math.log1p(.33)-lo)/span,(Math.log1p(6.72)-lo)/span);s.setZoom(s.getZoom().stops[2],"drag");s.selectBitmap(-1);})()`);
    await delay(1600);
    await fs.writeFile('/tmp/bitmap-neutral-filter-diversity.png',Buffer.from((await cdp('Page.captureScreenshot',{format:'png'})).data,'base64'));
    assert.equal(browser.errors.length,0,JSON.stringify(browser.errors));
    console.log(JSON.stringify({defaultLayer:'patterns',policy:'analytical-region-summary-v11-original-value-means',previewPixels:pixels,exceptions:browser.errors.length}));
}finally{await browser.close();}
