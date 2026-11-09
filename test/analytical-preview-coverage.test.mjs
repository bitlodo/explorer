import test from 'node:test';
import assert from 'node:assert/strict';
import Layer from '../src/map/layers/AnalyticalRegionPreviewLayer.ts';

test('analytical patches stay inside canonical regions and fixed owner cells', () => {
    const slots=[{x:-125,y:25,width:200,height:100},{x:125,y:25,width:50,height:100}];
    const layer=new Layer(slots,Float32Array.of(5,1,9,0));
    try{
        layer.updateView({x:-200,y:0,width:400,height:200},1,{opacity:.5,cellSize:100,revision:1,coverage:b=>b.x<0?1:0});
        for(const patch of layer.patches){
            const r=slots[patch.region],b=patch.bounds;
            assert.ok(b.x>=r.x&&b.y>=r.y&&b.x+b.width<=r.x+r.width&&b.y+b.height<=r.y+r.height);
            assert.equal(Math.floor(b.x/100),Math.ceil((b.x+b.width)/100)-1);
            assert.equal(Math.floor(b.y/100),Math.ceil((b.y+b.height)/100)-1);
        }
        const rect=layer.mesh.geometry.getAttribute('regionRect'),summaries=layer.mesh.geometry.getAttribute('regionSummary');
        for(let i=0;i<rect.count;i++)assert.equal(summaries.getY(i),layer.patches[i].region===0?1:0);
    }finally{layer.dispose();}
});

test('a whole-region proof promotes child coverage without scans and preserves the reverse blend',()=>{
    const layer=new Layer([{x:0,y:0,width:200,height:100}],Float32Array.of(5,1));
    const view={x:0,y:0,width:200,height:100};let queries=0;
    try{
        const geometry={opacity:1,cellSize:100,revision:1,coverage:()=>{queries++;return .25;}};
        layer.updateView(view,1,geometry);assert.equal(queries,2);
        layer.updateView(view,1,{...geometry,opacity:.75,uniformCoverage:1});
        const attribute=layer.mesh.geometry.getAttribute('geometryCoverage');
        assert.deepEqual([...attribute.array],[1,1]);assert.equal(queries,2);
        for(const opacity of [.5,.25,0]){
            layer.updateView(view,1,{...geometry,opacity,uniformCoverage:1});
            assert.equal(layer.material.uniforms.geometryOpacity.value,opacity);assert.equal(layer.visible,true);
        }
        layer.updateView(view,1,{...geometry,opacity:0,revision:2,coverage:()=>{throw Error('Invisible vectors do not need coverage queries');}});
        layer.updateView(view,1,{...geometry,opacity:.5,revision:2,coverage:()=>0});
        assert.deepEqual([...attribute.array],[0,0],'Eviction invalidates the inherited proof when vectors return');
    }finally{layer.dispose();}
});

test('regional LOD preserves independent arrivals without uploads or coverage queries on stable zoom/pan', () => {
    const layer=new Layer([{x:0,y:0,width:200,height:100}],Float32Array.of(5,1));
    const view={x:0,y:0,width:200,height:100};let calls=0,gain=.2;
    const mask={opacity:.5,cellSize:100,revision:1,coverage:b=>{calls++;return b.x>=100?gain:0;}};
    try{
        layer.updateView(view,1,mask);
        const attribute=layer.mesh.geometry.getAttribute('geometryCoverage'),summary=layer.mesh.geometry.getAttribute('regionSummary'),version=attribute.version,queries=calls;
        assert.ok(Math.abs(attribute.getX(1)-.2)<1e-6);
        layer.updateView({x:90,y:0,width:110,height:100},1,{...mask,opacity:.6});
        assert.equal(calls,queries);assert.equal(attribute.version,version);assert.equal(layer.material.uniforms.geometryOpacity.value,.6);
        gain=1;layer.updateView(view,1,{...mask,revision:2});assert.ok(calls>queries);assert.equal(attribute.getX(1),1);
        const summaryVersion=summary.version;
        layer.setSummaries(Float32Array.of(8,.25));
        assert.equal(layer.mesh.geometry.getAttribute('geometryCoverage'),attribute);assert.equal(attribute.getX(1),1);
        assert.ok(summary.version>summaryVersion);assert.equal(summary.getX(0),8);assert.equal(summary.getY(0),.25);
        layer.updateView(view,1,{...mask,opacity:1,revision:2});assert.equal(layer.visible,true,'Missing cells retain the summary');
        layer.updateView({x:100,y:0,width:100,height:100},1,{...mask,opacity:1,revision:2});assert.equal(layer.visible,false,'Resident cells finish the exact handoff');
        layer.updateView(view,1);assert.equal(layer.material.uniforms.geometryOpacity.value,0,'Reverse zoom restores the summary without resetting arrivals');
    }finally{layer.dispose();}
});

test('hidden preview writes remain pending until the GPU upload instead of being replaced by the next patch',()=>{
    const layer=new Layer([{x:0,y:0,width:100,height:100},{x:100,y:0,width:100,height:100}],Float32Array.of(5,1,5,1));
    const left={x:0,y:0,width:100,height:100},both={x:0,y:0,width:200,height:100};
    try{
        const mask={opacity:1,cellSize:100,revision:0,coverage:()=>0};
        layer.updateView(both,1,mask);
        const attribute=layer.mesh.geometry.getAttribute('geometryCoverage'),gpu=new Float32Array(2);
        attribute.onUploadCallback();
        layer.updateView(left,1,{...mask,revision:1,coverage:()=>1});
        assert.equal(layer.visible,false);assert.equal(attribute.getX(0),1);
        layer.updateView(both,1,{...mask,revision:2,coverage:b=>b.x===0?1:.25});
        for(const range of attribute.updateRanges)gpu.set(attribute.array.subarray(range.start,range.start+range.count),range.start);
        assert.deepEqual([...gpu],[1,.25],'The next draw must receive both the old hidden write and the new visible write');
        attribute.onUploadCallback();assert.deepEqual(attribute.updateRanges,[]);
        for(let revision=3;revision<1003;revision++)layer.updateView(both,1,{...mask,revision,coverage:()=>revision%2});
        assert.equal(attribute.updateRanges.length,1,'Deferred writes use bounded metadata across hidden frames');
        attribute.onUploadCallback();assert.deepEqual(attribute.updateRanges,[]);
        const version=attribute.version;
        layer.updateView(both,1,{...mask,revision:1002,coverage:()=>{throw Error('Stable coverage is not queried again');}});
        assert.equal(attribute.version,version);assert.deepEqual(attribute.updateRanges,[]);
    }finally{layer.dispose();}
});

test('zero-weight regions skip coverage work and resume correctly when their preview is needed',()=>{
    const layer=new Layer([{x:0,y:0,width:100,height:100},{x:100,y:0,width:100,height:100}],Float32Array.of(5,1,5,1));
    const view={x:0,y:0,width:200,height:100},queried=[];
    const geometry={opacity:1,cellSize:100,revision:1,coverage:(_bounds,region)=>{queried.push(region);return 1;}};
    try{
        layer.setWeights(Float32Array.of(0,1));
        const weight=layer.mesh.geometry.getAttribute('displayWeight'),version=weight.version;
        layer.setWeights(Float32Array.of(0,1));assert.equal(weight.version,version);
        layer.updateView(view,1,geometry);assert.deepEqual(queried,[1]);assert.equal(layer.visible,false);
        layer.setWeights(Float32Array.of(1,1));layer.updateView(view,1,geometry);
        assert.deepEqual(queried,[1,0],'Previously hidden patches acquire coverage when restored');
        layer.updateView(view,1,{...geometry,opacity:.5});assert.equal(layer.visible,true,'Reverse zoom preserves the linear preview blend');
        layer.updateView(view,1,{...geometry,revision:2,coverage:()=>0});assert.equal(layer.visible,true,'Geometry loss restores the fallback');
    }finally{layer.dispose();}
});
