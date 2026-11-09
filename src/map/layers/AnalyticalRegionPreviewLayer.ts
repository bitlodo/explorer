import * as THREE from 'three';
import type { NeighborhoodSlot } from '@shared/NeighborhoodLayout';
import { type RegionStyle } from '@shared/layerPresentation';
import { ANALYTICAL_LOD_POLICY, type RegionSummaries } from '@shared/analyticalLod';
import { check } from '@shared/httpPack';
import { CreateBufferPlaneGeometry } from './planeGeometry';
import { colorUniforms, setColors, sizeColorGLSL } from './ParcelSizeColors';
import { queueAttributeUpdateRange } from './attributeUpdates';

type Bounds = { x: number; y: number; width: number; height: number };
export type PreviewGeometryCoverage = {
    opacity: number; cellSize?: number; revision?: number; uniformCoverage?:1; coverage: (bounds: Bounds, region?:number) => number;
};
export type AnalyticalPreviewOptions = { owners?:readonly number[]; parents?:readonly NeighborhoodSlot[]; contentCoverage?:Float32Array; baseSummary?:readonly [number,number] };
type Patch = { region: number; bounds: Bounds; coverage: number; revision?: number };
const intersects = (a: Bounds, b: Bounds) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

/** Solid analytical summaries, clipped to canonical region bounds. No raster samples. */
export default class AnalyticalRegionPreviewLayer extends THREE.Group {
    readonly policy = ANALYTICAL_LOD_POLICY;
    private slots: readonly NeighborhoodSlot[];
    private summaries: RegionSummaries;
    private cellSize = 0;
    private weights:Float32Array;
    private patches: Patch[] = [];
    private mesh: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>;
    private material = new THREE.ShaderMaterial({
        transparent: true, depthTest: false, depthWrite: false,
        uniforms: { ...colorUniforms(), opacity: { value: 0 }, geometryOpacity: { value: 0 }, regionStyle: { value: 0 }, borderPixels: { value: 1 }, baseSummary:{value:new THREE.Vector2()}, useBaseSummary:{value:0}, spatialBlend:{value:0}, spatialArrival:{value:1} },
        vertexShader: `attribute vec4 regionRect;attribute vec4 regionUvRect;attribute vec2 regionSummary;attribute float geometryCoverage;attribute float contentCoverage;attribute float displayWeight;
            varying vec2 summary;varying float exactCoverage;varying vec2 regionUv;varying float cellCoverage;varying float weight;
            void main(){summary=regionSummary;exactCoverage=geometryCoverage;cellCoverage=contentCoverage;weight=displayWeight;
                regionUv=regionUvRect.xy+position.xz*regionUvRect.zw;
                vec3 p=vec3(regionRect.x+position.x*regionRect.z,0.,regionRect.y+position.z*regionRect.w);
                gl_Position=projectionMatrix*modelViewMatrix*vec4(p,1.);}`,
        fragmentShader: `${sizeColorGLSL}
            uniform float opacity;uniform float geometryOpacity;uniform float regionStyle;uniform float borderPixels;uniform vec2 baseSummary;uniform float useBaseSummary;uniform float spatialBlend;uniform float spatialArrival;
            varying vec2 summary;varying float exactCoverage;varying vec2 regionUv;varying float cellCoverage;varying float weight;
            void main(){
                vec3 color=parcelSizeColor(summary.x);
                if(regionStyle>1.5)color=densityColor(color,summary.y);
                else color=mix(disabledColor,color,clamp(summary.y,0.,1.));
                vec3 base=parcelSizeColor(baseSummary.x);
                if(regionStyle>1.5)base=densityColor(base,baseSummary.y);else base=mix(disabledColor,base,clamp(baseSummary.y,0.,1.));
                float mixGain=useBaseSummary>.5?clamp(spatialBlend*spatialArrival,0.,1.):1.;
                if(useBaseSummary>.5)color=mix(base,color,mixGain);
                float borderCoverage=1.;
                if(borderPixels>0.){
                    // Measure the original neighborhood, not its owner-cell pieces.
                    // A trailing one-pixel inset separates touching regions without
                    // drawing artificial lines at internal coverage boundaries.
                    vec2 footprint=max(fwidth(regionUv),vec2(.000001));
                    vec2 margin=min(footprint*borderPixels,vec2(.5));
                    vec2 fill=clamp((vec2(1.)-margin-regionUv)/footprint+.5,0.,1.);
                    borderCoverage=fill.x*fill.y;
                }
                gl_FragColor=vec4(color,opacity*(1.-geometryOpacity*exactCoverage)*borderCoverage*weight*mix(1.,cellCoverage,mixGain));
                #include <tonemapping_fragment>
                #include <colorspace_fragment>
            }`,
    });

    constructor(slots: readonly NeighborhoodSlot[], summaries: RegionSummaries, private options:AnalyticalPreviewOptions={}) {
        super();this.weights=new Float32Array(slots.length).fill(1);if(options.baseSummary){this.material.uniforms.useBaseSummary.value=1;this.material.uniforms.baseSummary.value.set(...options.baseSummary);}
        this.name = 'analytical-region-summary'; this.slots = slots; this.summaries = summaries;
        this.mesh = new THREE.Mesh(new THREE.InstancedBufferGeometry(), this.material);
        this.mesh.renderOrder = .5; this.mesh.position.y = .01; this.mesh.frustumCulled = false; this.mesh.raycast = () => {};
        this.add(this.mesh); this.rebuild();
    }
    setLayout(slots: readonly NeighborhoodSlot[]) {
        if (slots.length * 2 !== this.summaries.length) {
            const summaries = new Float32Array(slots.length * 2);
            for (let i = 0; i < slots.length; i++) summaries[i * 2] = 1;
            summaries.set(this.summaries.subarray(0, summaries.length)); this.summaries = summaries;
        }
        this.slots = slots;if(this.weights.length!==slots.length)this.weights=new Float32Array(slots.length).fill(1); this.rebuild();
    }
    setSpatialMix(blend:number,arrival:number){this.material.uniforms.spatialBlend.value=blend;this.material.uniforms.spatialArrival.value=arrival;}
    setBaseSummary(score:number,share:number){this.material.uniforms.baseSummary.value.set(score,share);}
    setWeights(weights:Float32Array){
        check(weights.length===this.slots.length,'Invalid analytical visibility weights');
        let equal=true;for(let i=0;i<weights.length;i++)if(weights[i]!==this.weights[i]){equal=false;break;}if(equal)return;
        const attribute=this.mesh.geometry.getAttribute('displayWeight') as THREE.InstancedBufferAttribute;let changed=false;
        for(let i=0;i<this.patches.length;i++){const value=weights[this.patches[i].region];if(attribute.getX(i)!==value){attribute.setX(i,value);queueAttributeUpdateRange(attribute,i,1);changed=true;}}
        if(changed)attribute.needsUpdate=true;this.weights.set(weights);
    }
    setRegionStyle(style: RegionStyle) { this.material.uniforms.regionStyle.value = style === 'density' ? 2 : 0; }
    setColors(colors: readonly string[]) { setColors(this.material.uniforms, colors); }
    setSummaries(summaries: RegionSummaries) {
        check(summaries.length === this.slots.length * 2, 'Analytical summaries do not match the map');
        this.summaries = summaries;
        const attribute = this.mesh.geometry.getAttribute('regionSummary') as THREE.InstancedBufferAttribute;
        for (let i = 0; i < this.patches.length; i++) attribute.setXY(i, summaries[this.patches[i].region * 2], summaries[this.patches[i].region * 2 + 1]);
        attribute.needsUpdate = true;
    }
    private rebuild() {
        check(this.summaries.length === this.slots.length * 2, 'Analytical summaries do not match the map');
        const rects: number[] = [], uvs: number[] = [], values: number[] = [], contents:number[]=[],weights:number[]=[], cell = this.cellSize;
        this.patches = [];
        for (const [region, r] of this.slots.entries()) {
            const firstX = cell ? Math.floor(r.x / cell) : 0, lastX = cell ? Math.ceil((r.x + r.width) / cell) - 1 : 0;
            const firstY = cell ? Math.floor(r.y / cell) : 0, lastY = cell ? Math.ceil((r.y + r.height) / cell) - 1 : 0;
            for (let row = firstY; row <= lastY; row++) for (let col = firstX; col <= lastX; col++) {
                const x = cell ? Math.max(r.x, col * cell) : r.x, y = cell ? Math.max(r.y, row * cell) : r.y;
                const width = (cell ? Math.min(r.x + r.width, (col + 1) * cell) : r.x + r.width) - x;
                const height = (cell ? Math.min(r.y + r.height, (row + 1) * cell) : r.y + r.height) - y;
                rects.push(x, y, width, height); values.push(this.summaries[region * 2], this.summaries[region * 2 + 1]);
                const parent=this.options.parents?.[this.options.owners?.[region]??region]??r;
                uvs.push((x-parent.x)/parent.width,(y-parent.y)/parent.height,width/parent.width,height/parent.height);
                contents.push(this.options.contentCoverage?.[region]??1);weights.push(this.weights[region]);
                this.patches.push({ region, bounds: { x, y, width, height }, coverage: 0 });
            }
        }
        const plane = CreateBufferPlaneGeometry(), geometry = new THREE.InstancedBufferGeometry();
        geometry.setIndex(plane.index); geometry.setAttribute('position', plane.getAttribute('position'));
        geometry.setAttribute('regionRect', new THREE.InstancedBufferAttribute(new Float32Array(rects), 4));
        geometry.setAttribute('contentCoverage',new THREE.InstancedBufferAttribute(new Float32Array(contents),1));
        const visibility=new THREE.InstancedBufferAttribute(new Float32Array(weights),1).setUsage(THREE.DynamicDrawUsage);visibility.onUpload(()=>visibility.clearUpdateRanges());geometry.setAttribute('displayWeight',visibility);
        geometry.setAttribute('regionUvRect',new THREE.InstancedBufferAttribute(new Float32Array(uvs),4));
        geometry.setAttribute('regionSummary', new THREE.InstancedBufferAttribute(new Float32Array(values), 2).setUsage(THREE.DynamicDrawUsage));
        const coverage=new THREE.InstancedBufferAttribute(new Float32Array(this.patches.length),1).setUsage(THREE.DynamicDrawUsage);
        coverage.onUpload(()=>coverage.clearUpdateRanges());
        geometry.setAttribute('geometryCoverage',coverage);
        geometry.instanceCount = this.patches.length;
        this.mesh.geometry.dispose(); this.mesh.geometry = geometry;
    }
    updateView(bounds: Bounds, strength: number, geometry?: PreviewGeometryCoverage) {
        if (geometry?.cellSize && geometry.cellSize !== this.cellSize) { this.cellSize = geometry.cellSize; this.rebuild(); }
        const attribute = this.mesh.geometry.getAttribute('geometryCoverage') as THREE.InstancedBufferAttribute;
        let changed = false, visible = false;
        for (let i = 0; i < this.patches.length; i++) {
            const patch = this.patches[i]; if (this.weights[patch.region]===0||!intersects(patch.bounds, bounds)) continue;
            if (geometry && geometry.opacity>0 && (geometry.revision === undefined || patch.revision !== geometry.revision || geometry.uniformCoverage===1&&patch.coverage!==1)) {
                const coverage = geometry.uniformCoverage??geometry.coverage(patch.bounds,this.options.owners?.[patch.region]??patch.region); patch.revision = geometry.revision;
                if (coverage !== patch.coverage) {
                    changed = true; patch.coverage = coverage;
                    attribute.setX(i, coverage); queueAttributeUpdateRange(attribute,i,1);
                }
            }
            visible ||= !geometry || 1 - geometry.opacity * patch.coverage > 0;
        }
        if (changed) attribute.needsUpdate = true;
        this.material.uniforms.opacity.value = strength;
        this.material.uniforms.geometryOpacity.value = geometry?.opacity ?? 0;
        this.visible = visible && strength > 0;
    }
    dispose() { this.mesh.geometry.dispose(); this.material.dispose(); this.clear(); this.removeFromParent(); }
}
