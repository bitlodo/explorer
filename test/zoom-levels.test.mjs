import test from 'node:test';
import assert from 'node:assert/strict';
import {loadShared} from './helpers/load-shared.ts';
const {DampedZoom,zoomDistances,nearestZoom,overviewFrame,MAP_FRAMING,parcelDetailDistance,PARCEL_DETAIL_PIXELS}=await loadShared('../../src/shared/zoomLevels.ts');
const pyramid={tileSize:4096,resolution:256,maxLevel:6};
const stops=zoomDistances(3750,pyramid,20,1600000,400000);

test('exactly five stops include both unchanged bounds and use four equal zoom intervals',()=>{
    assert.equal(stops.length,5);assert.equal(stops[0],20);assert.equal(stops.at(-1),400000);
    assert.equal(new Set(stops).size,5);
    const step=Math.log(stops[1]/stops[0]);
    for(let i=1;i<stops.length;i++)assert.ok(Math.abs(Math.log(stops[i]/stops[i-1])-step)<1e-9);
    assert.equal(nearestZoom(250,[100,500]),500);
});

test('all zoom releases settle at one of the five states, including initially fractional distances',()=>{
    const levels=[100,200,400,800,1600];
    for(const start of [110,150,250,550,1000,1300]){
        const zoom=new DampedZoom();zoom.snap(start,0,100,1600);
        assert.ok(Math.abs(zoom.tick(0,levels)-start)<1e-6,'The animation begins without a jump');
        for(let now=10;zoom.active&&now<4000;now+=10)zoom.tick(now,levels);
        assert.equal(zoom.active,false);
        assert.ok(Math.abs(zoom.height-nearestZoom(start,levels))<1e-6,'No resting scale between states');
    }
});

test('a new zoom command interrupts snapping and cancellation stops movement',()=>{
    const zoom=new DampedZoom(),levels=[100,200,400,800,1600];
    zoom.snap(1600,0,100,1600,800);zoom.tick(100,levels);
    const partial=zoom.height;zoom.snap(partial,100,100,1600,400);
    assert.equal(zoom.velocity,0);assert.equal(zoom.snapping,true);
    assert.ok(Math.abs(zoom.targetHeight-400)<1e-6);
    zoom.cancel();assert.equal(zoom.active,false);assert.equal(zoom.tick(5000,levels),zoom.height);
});

test('critical damping is consistent at 30/60/120 Hz and cannot escape distance bounds',()=>{
    const at=fps=>{const zoom=new DampedZoom();zoom.snap(1000,0,20,100000,500);for(let n=1;n<=fps;n++)zoom.tick(n*1000/fps,[20,250,500,1000,100000]);return zoom.height;};
    assert.ok(Math.abs(at(30)-at(120))<.1);assert.ok(Math.abs(at(60)-at(120))<.1);
    for(const delta of [-500,500]){
        const zoom=new DampedZoom();zoom.snap(delta<0?20:1000,0,20,1000,delta<0?1:2000);
        for(let now=0;now<2000;now+=16){const height=zoom.tick(now,[20,100,1000]);assert.ok(height>=20-1e-9&&height<=1000+1e-9);}
    }
});


test('overview fits the occupied map with margin in landscape, portrait and ultrawide windows',()=>{
    const bounds={x:-42000,y:-53000,width:96000,height:102000};
    for(const aspect of [1920/993,900/1200,2400/700]){
        const frame=overviewFrame(bounds,aspect,15),visibleHeight=2*Math.tan(15*Math.PI/360)*frame.height;
        assert.equal(frame.x,bounds.x+bounds.width/2);assert.equal(frame.z,bounds.y+bounds.height/2);
        assert.ok(bounds.height/visibleHeight<=1-2*MAP_FRAMING.margin+1e-9);
        assert.ok(bounds.width/(visibleHeight*aspect)<=1-2*MAP_FRAMING.margin+1e-9);
    }
});

test('zoom animation stays within the closest and whole-map limits',()=>{
    for(const [height,target] of [[20,1],[400000,800000]]){
        const zoom=new DampedZoom();zoom.snap(height,0,20,400000,target);
        for(let now=10;now<2000;now+=10)assert.ok(Math.abs(zoom.tick(now,stops)-height)<1e-6);
        assert.equal(zoom.active,false);
    }
});

test('closest stop resolves size-1 fill and gaps at an even pixel pitch across resolutions',()=>{
    for(const [width,height] of [[320,241],[1920,993],[900,1200],[2400,700],[3840,2160],[7680,4320]]){
        for(const fov of [15,30]){
            const aspect=width/height,min=parcelDetailDistance(height,fov);
            const worldHeight=2*Math.tan(fov*Math.PI/360)*min,pixels=height/worldHeight;
            assert.ok(Math.abs(pixels-6)<1e-10,'Size-1 cells must repeat at six pixels');
            assert.ok(Math.abs(.5*pixels-3)<1e-10,'Both fill and trailing gap must span three pixels');
            assert.equal(PARCEL_DETAIL_PIXELS%2,0);
            const home=overviewFrame({x:-42000,y:-53000,width:96000,height:102000},aspect,fov).height;
            const levels=zoomDistances(height/(2*Math.tan(fov*Math.PI/360)),pyramid,min,home*4,home);
            assert.equal(levels.length,5);assert.equal(levels[0],min);assert.equal(levels.at(-1),home);
            const zoom=new DampedZoom();zoom.snap(min,0,min,home*4,min/2);
            for(let now=10;now<2000;now+=10)assert.ok(zoom.tick(now,levels)>=min-1e-6);
        }
    }
});

test('parcel presentation remains reachable at the new closest distance',async()=>{
    const {cameraDetail}=await loadShared('../../src/shared/heatmapPreview.ts');
    for(const [width,height] of [[1920,993],[900,1200]]){
        const unit=height/(2*Math.tan(15*Math.PI/360)),min=parcelDetailDistance(height,15);
        assert.ok(Math.abs(cameraDetail(min/unit,pyramid,min/unit)-8)<1e-9);
    }
});


test('slider release starts snapping from its current distance without a fake elapsed frame',()=>{
    const zoom=new DampedZoom();zoom.snap(700,1000,100,1000);
    assert.ok(Math.abs(zoom.height-700)<1e-9);assert.equal(zoom.velocity,0);
    const first=zoom.tick(1001,[100,500,1000]);assert.ok(Math.abs(first-700)<1,'First frame must not jump');
    for(let now=1010;zoom.active&&now<5000;now+=10)zoom.tick(now,[100,500,1000]);
    assert.equal(zoom.active,false);assert.ok(Math.abs(zoom.height-500)<1e-6);
});


test('camera levels enforce parcel, neighborhood and preview tiers independently of object size',async()=>{
    const {zoomTier,tierDetail}=await loadShared('../../src/shared/zoomLevels.ts');
    const levels=zoomDistances(3750,pyramid,877,1600000,414000);
    for(let i=0;i<5;i++){
        assert.equal(zoomTier(levels[i],levels),i<2?'parcels':i<3?'neighborhoods':'preview');
        const detail=tierDetail(levels[i],levels,pyramid,levels[i]/3750,false);
        if(i<2)assert.equal(detail,8);else if(i<3)assert.equal(detail,7);else assert.ok(detail<7);
    }
    assert.ok(Math.abs(tierDetail(Math.sqrt(levels[1]*levels[2]),levels,pyramid,1,true)-7.5)<1e-6);
    assert.ok(tierDetail(Math.sqrt(levels[2]*levels[3]),levels,pyramid,1,true)<7);
});

test('heatmap LOD and opacity vary continuously with distance, including when input stops',async()=>{
    const {tierDetail,heatmapStrength}=await loadShared('../../src/shared/zoomLevels.ts');
    const levels=zoomDistances(3750,pyramid,877,1600000,414000);
    let previous=8;
    for(let n=0;n<=4000;n++){
        const distance=levels[0]*(levels.at(-1)/levels[0])**(n/4000),pixelSize=distance/3750;
        const moving=tierDetail(distance,levels,pyramid,pixelSize,true),rest=tierDetail(distance,levels,pyramid,pixelSize,false);
        assert.equal(moving,rest,'Releasing input must not switch to a rounded heatmap resolution');
        assert.equal(tierDetail(distance,levels,{...pyramid,resolution:24},pixelSize,true),moving,'Coarse preview textures must retain the same LOD/world coverage and level-3 handoff');
        assert.ok(moving<=previous+1e-9);assert.ok(Math.abs(moving-previous)<.02);previous=moving;
    }
    assert.equal(heatmapStrength(levels[0],levels),1);
    assert.ok(Math.abs(heatmapStrength(levels.at(-1),levels)-.59)<1e-9);
    assert.equal(tierDetail(levels.at(-1),levels,pyramid,levels.at(-1)/3750,false),3,'Farthest view uses the former intermediate preview');
});


test('grouped previews map stops 5/4 to intermediate/finest tiles, keeping stop 3 exact',async()=>{
    const {tierDetail,heatmapStrength}=await loadShared('../../src/shared/zoomLevels.ts');
    const grouped={tileSize:16384,resolution:96,maxLevel:4},levels=zoomDistances(3750,grouped,877,1600000,414000);
    assert.equal(tierDetail(levels[4],levels,grouped,1,false),3); // tile level 1
    assert.equal(tierDetail(levels[3],levels,grouped,1,false),4); // tile level 0
    assert.equal(tierDetail(levels[2],levels,grouped,1,false),5); // exact, waits at 4 for data
    assert.equal(heatmapStrength(levels[3],levels),1);
});


test('preview to neighborhoods is linear in slider position before reaching stop 3',async()=>{
 const {tierDetail}=await loadShared('../../src/shared/zoomLevels.ts'),grouped={tileSize:16384,resolution:96,maxLevel:4},levels=zoomDistances(3750,grouped,877,1600000,414000);
 for(const fraction of [0,.1,.25,.5,.75,.9,1]){
  const distance=levels[3]*(levels[2]/levels[3])**fraction;
  assert.ok(Math.abs(tierDetail(distance,levels,grouped,1,true)-(4+fraction))<1e-9);
 }
});


test('overview around an explicit bitmap center preserves full-map margins at every aspect',()=>{
 const bounds={x:-42000,y:-53000,width:96000,height:102000},center={x:-111,z:-113};
 for(const aspect of [1920/993,900/1200,2400/700]){
  const frame=overviewFrame(bounds,aspect,15,center),height=2*Math.tan(15*Math.PI/360)*frame.height,width=height*aspect;
  assert.equal(frame.x,center.x);assert.equal(frame.z,center.z);
  for(const x of [bounds.x,bounds.x+bounds.width])assert.ok(Math.abs(x-center.x)/(width/2)<=1-2*MAP_FRAMING.margin+1e-9);
  for(const y of [bounds.y,bounds.y+bounds.height])assert.ok(Math.abs(y-center.z)/(height/2)<=1-2*MAP_FRAMING.margin+1e-9);
 }
});

test('wheel zoom requires at least three samples even when the first sample is large or delayed',async()=>{
 const {WheelZoomGesture}=await loadShared('../../src/shared/zoomLevels.ts');
 const wheel=new WheelZoomGesture(),levels=[100,200,400,800,1600];
 assert.equal(wheel.input(1600,-100,0,levels),undefined);
 assert.equal(wheel.update(59,levels),undefined);
 assert.equal(wheel.update(60,levels),undefined,'Time alone cannot turn one notch into a gesture');
 assert.equal(wheel.input(1600,-10000,100,levels),undefined);
 assert.equal(wheel.update(160,levels),undefined,'Two samples are still insufficient');
 assert.equal(wheel.input(1600,-100,180,levels),800);
 for(let now=200;now<=2000;now+=20)assert.equal(wheel.input(800,-1000,now,levels),undefined,'Momentum stays in the same gesture after animation settles');
 assert.equal(wheel.input(800,-100,2300,levels),undefined);
 assert.equal(wheel.input(800,-100,2316,levels),undefined);
 assert.equal(wheel.input(800,-100,2332,levels),undefined);
 assert.equal(wheel.update(2360,levels),400);
 assert.equal(wheel.input(400,-10000,2370,levels),undefined,'A large delta cannot skip levels');
});

test('tiny wheel deltas need enough motion as well as enough samples and incomplete gestures expire',async()=>{
 const {WheelZoomGesture}=await loadShared('../../src/shared/zoomLevels.ts');
 const wheel=new WheelZoomGesture(),levels=[100,200,400,800,1600];
 assert.equal(wheel.input(400,-5,0,levels),undefined);
 assert.equal(wheel.input(400,5,20,levels),undefined);
 assert.equal(wheel.input(400,-5,40,levels),undefined);
 assert.equal(wheel.update(60,levels),undefined);
 assert.equal(wheel.input(400,-30,80,levels),undefined);
 assert.equal(wheel.input(400,-35,100,levels),200);
 assert.equal(wheel.input(200,1000,120,levels),undefined,'An inverted tail cannot reverse the selected stop');
 assert.equal(wheel.input(200,-40,400,levels),undefined);
 assert.equal(wheel.input(200,-40,700,levels),undefined,'Separate incomplete gestures do not accumulate');
 assert.equal(wheel.input(200,-40,720,levels),undefined);
 assert.equal(wheel.update(760,levels),undefined);
 assert.equal(wheel.input(200,-40,780,levels),100);
});

test('wheel gestures visit all five states, clamp at both ends and reset for another control',async()=>{
 const {WheelZoomGesture}=await loadShared('../../src/shared/zoomLevels.ts');
 const wheel=new WheelZoomGesture(),levels=[100,200,400,800,1600];
 let height=1600,time=0;
 for(const [direction,expectedStates] of [[-1,[800,400,200,100,100]],[1,[200,400,800,1600,1600]]]){
  for(const expected of expectedStates){for(const offset of [0,16,32])wheel.input(height,direction*10000,time+offset,levels);height=wheel.update(time+60,levels);assert.equal(height,expected);time+=300;}
 }
 wheel.reset();wheel.input(400,-100,time,levels);wheel.input(400,-100,time+16,levels);wheel.reset();assert.equal(wheel.update(time+60,levels),undefined);
 for(const offset of [100,116,132])assert.equal(wheel.input(400,-100,time+offset,levels),undefined);
 assert.equal(wheel.update(time+160,levels),200);
 for(const delta of [0,NaN,Infinity,-Infinity])assert.equal(wheel.input(400,delta,time,levels),undefined);
});

test('a new gesture advances from the pending stop while the camera animation remains continuous',async()=>{
 const {WheelZoomGesture}=await loadShared('../../src/shared/zoomLevels.ts');
 const wheel=new WheelZoomGesture(),zoom=new DampedZoom(),levels=[100,200,400,800,1600];
 for(const now of [0,16,32])wheel.input(1600,-100,now,levels);
 const target=wheel.update(60,levels);zoom.snap(1600,60,100,1600,target);
 assert.ok(Math.abs(zoom.tick(60,levels)-1600)<1e-9);
 const partial=zoom.tick(110,levels);assert.ok(partial>800&&partial<1600);
 for(const now of [360,376,392])wheel.input(zoom.targetHeight,-100,now,levels);
 const next=wheel.update(420,levels);assert.equal(next,400);
 zoom.snap(partial,420,100,1600,next);let previous=partial;
 for(let now=430;zoom.active&&now<=4000;now+=10){const height=zoom.tick(now,levels);assert.ok(height<=previous+1e-9&&height>=400-1e-9);previous=height;}
 assert.equal(zoom.active,false);assert.ok(Math.abs(zoom.height-400)<1e-6);
});

test('one inverted first sample or large opposite spike cannot select the wrong zoom direction',async()=>{
 const {WheelZoomGesture}=await loadShared('../../src/shared/zoomLevels.ts'),levels=[100,200,400,800,1600];
 for(const sign of [-1,1]){
  const wheel=new WheelZoomGesture();
  assert.equal(wheel.input(400,-sign*10000,0,levels),undefined);
  assert.equal(wheel.update(60,levels),undefined,'An isolated reversed sample cannot commit before the real samples arrive');
  assert.equal(wheel.input(400,sign*5,100,levels),undefined);
  assert.equal(wheel.input(400,sign*5,180,levels),sign<0?200:800,'Two matching votes outweigh one arbitrarily large inverted vote');
  wheel.reset();
  for(const [now,delta] of [[0,sign*120],[16,-sign*120],[32,sign*120],[48,-sign*120]])assert.equal(wheel.input(400,delta,now,levels),undefined);
  assert.equal(wheel.update(60,levels),undefined,'A tied direction must wait');
  assert.equal(wheel.input(400,sign*120,64,levels),sign<0?200:800);
  wheel.reset();
  assert.equal(wheel.input(400,-sign*120,0,levels),undefined);
  assert.equal(wheel.input(400,sign*120,16,levels),undefined);
  assert.equal(wheel.input(400,sign*120,32,levels),undefined);
  assert.equal(wheel.update(60,levels),sign<0?200:800);
  wheel.reset();const selected=[];
  for(const [now,delta] of [[0,sign*30],[16,sign*30],[32,-sign*1000],[48,sign*30],[64,sign*30],[80,sign*30],[96,sign*30]]){
   const target=wheel.input(400,delta,now,levels);if(target!==undefined)selected.push(target);
  }
  assert.deepEqual(selected,[sign<0?200:800]);
 }
});
