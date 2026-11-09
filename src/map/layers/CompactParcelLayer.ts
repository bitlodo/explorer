import * as THREE from 'three';
import type BitmapArrivalFades from './BitmapArrivalFades';
import {bitmapArrivalGLSL} from '@shared/bitmapArrival';
import { rectangleCoverageVertexGLSL, rectangleCoverageFragmentGLSL } from './RectangleCoverage';

import {colorUniforms,sizeColorGLSL,setColors,setMetricUniforms,setParcelUniforms,MAP_BASE_COLOR} from './ParcelSizeColors';
export {PARCEL_SIZE_COLORS} from './ParcelSizeColors';

export const COMPACT_PARCEL_FORMAT = 'compact-parcels-v1-rect4f-block16';
export const COMPACT_PARCEL_BYTES = 18; // rect: 4 Float32; neighborhood-local bitmap: Uint16
type Rect = { x: number; y: number; width: number; height: number };
type Chunk = THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>;
type Range = { chunk: Chunk; start: number; end: number; firstParcel: number };

/** GPU-expanded quads. No instanceMatrix, per-instance color, or CPU vertex expansion. */
export default class CompactParcelLayer extends THREE.Group {
    readonly formatVersion = COMPACT_PARCEL_FORMAT;
    readonly chunks: Chunk[] = [];
    readonly material: THREE.ShaderMaterial;
    private readonly capacity: number;
    private readonly margin: number;
    private readonly bitmaps = new Map<number, { ranges: Range[]; count: number }>();
    private disposed = false;
    private sizeTexture?: THREE.DataTexture;

    constructor(capacity = 100000, margin = 0.5) {
        super();
        if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error('Invalid parcel chunk capacity.');
        if (!Number.isFinite(margin) || margin < 0) throw new Error('Invalid parcel margin.');
        this.capacity = capacity;
        this.margin = margin;
        this.name = 'compact-parcels';
        this.material = new THREE.ShaderMaterial({
            depthTest: false, depthWrite: false, transparent: true,
            uniforms: {
                rectangleSmoothing: { value: 1 },
                rectanglePixelsPerWorld: { value: 1 },
                selectedBitmap: { value: -1 },
                inspectedBitmap: { value: -1 },
                bitmapSizes: { value: null }, pixelsPerWorld: { value: 1 }, lodEnabled: { value: 0 }, layerOpacity: { value: 1 },
                arrivalMap:{value:null},arrivalMapSize:{value:new THREE.Vector2(1,1)},arrivalEnabled:{value:0},arrivalBitmapBase:{value:0},
                ...colorUniforms(),
                baseColor: { value: new THREE.Color(MAP_BASE_COLOR) },
                selectedColor: { value: new THREE.Color('#ffe0aa') },
            },
            // Per-instance values must remain constant: perspective interpolation
            // can move an exact filter endpoint across its threshold within a quad.
            vertexShader: `
                ${rectangleCoverageVertexGLSL}
                ${bitmapArrivalGLSL}
                attribute vec4 parcelRect;
                attribute float bitmapIndex;
                uniform float selectedBitmap;uniform float inspectedBitmap;
                flat varying float vSelected;
                flat varying float vInspected;
                flat varying float vOpacity;
                flat varying float vParcelSize;
                flat varying float vParcelPixels;
                flat varying float vBitmapArea;flat varying float vMetric;
                uniform float metricEnabled;uniform sampler2D metricValues;uniform vec2 metricTextureSize;
                uniform sampler2D bitmapSizes;uniform float pixelsPerWorld;uniform float lodEnabled;uniform float layerOpacity;
                uniform sampler2D arrivalMap;uniform vec2 arrivalMapSize;uniform float arrivalEnabled;uniform float arrivalBitmapBase;
                void main() {
                    vec2 offset = rectanglePosition(position.xz, parcelRect.zw, ${this.margin.toFixed(6)});
                    vec3 local = vec3(parcelRect.x + offset.x, 0.0, parcelRect.y + offset.y);
                    float size=lodEnabled>.5?texture2D(bitmapSizes,vec2((bitmapIndex+.5)/2016.0,.5)).r:1.0;
                    vOpacity=layerOpacity*(lodEnabled>.5?smoothstep(24.0,64.0,size*pixelsPerWorld):1.0);
                    float id=arrivalBitmapBase+bitmapIndex;vInspected=abs(id-inspectedBitmap)<.5?1.:0.;
                    vMetric=metricEnabled>.5?texture2D(metricValues,(vec2(mod(id,metricTextureSize.x),floor(id/metricTextureSize.x))+.5)/metricTextureSize).r:1.;
                    if(arrivalEnabled>.5)vOpacity*=parcelArrivalOpacity(texture2D(arrivalMap,(vec2(mod(id,arrivalMapSize.x),floor(id/arrivalMapSize.x))+.5)/arrivalMapSize).r);
                    vBitmapArea=texture2D(bitmapSizes,vec2((bitmapIndex+.5)/2016.0,.5)).g;
                    vParcelSize = parcelRect.z + ${this.margin.toFixed(6)};
                    vParcelPixels = (min(parcelRect.z, parcelRect.w) + ${this.margin.toFixed(6)}) * rectanglePixelsPerWorld;
                    vSelected = abs(bitmapIndex - selectedBitmap) < 0.5 ? 1.0 : 0.0;
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(local, 1.0);
                }
            `,
            fragmentShader: `
                ${rectangleCoverageFragmentGLSL}
                uniform vec3 baseColor;
                uniform vec3 selectedColor;
                uniform float sizeColorMode;
                ${sizeColorGLSL}
                flat varying float vSelected;
                flat varying float vInspected;
                flat varying float vOpacity;
                flat varying float vParcelSize;
                flat varying float vParcelPixels;
                flat varying float vBitmapArea;flat varying float vMetric;
                void main() {
                    vec3 sizeColor = parcelSizeColor(vParcelSize);
                    vec3 color = parcelClassMode>.5?parcelCoverageColor(sizeColor,parcelClassWeight(vParcelSize,1.)):(metricEnabled>.5?filterColor(parcelSizeColor(vMetric),vMetric):(sizeColorMode>1.5?filterColor(bitmapAreaColor(vBitmapArea),bitmapAreaScore(vBitmapArea)):(sizeColorMode>.5?sizeColor:(heatmapEnabled>.5?parcelSizeColor(1.+clamp((vBitmapArea-1.)/145907.,0.,1.)*8.):baseColor))));
                    float selected=vSelected;
                    if(parcelClassMode>.5)selected*=.25*parcelClassWeight(vParcelSize,1.);
                    else if(metricEnabled>.5)selected*=.25*step(filterMin-.000001,vMetric)*step(vMetric,filterMax+.000001);
                    else if(sizeColorMode>1.5){float areaScore=bitmapAreaScore(vBitmapArea);selected*=.25*step(filterMin-.000001,areaScore)*step(areaScore,filterMax+.000001);}
                    gl_FragColor = vec4(vInspected>.5?vec3(1.):mix(color, selectedColor, selected), vOpacity * rectangleDetailCoverage(${this.margin.toFixed(6)}, vParcelPixels));
                    #include <tonemapping_fragment>
                    #include <colorspace_fragment>
                }
            `,
        });
    }

    setParcelClasses(texture?:THREE.DataTexture,low=1,high=9){setParcelUniforms(this.material.uniforms,texture,low,high);}
    setAnalytic(texture?:THREE.DataTexture,low=1,high=9){setMetricUniforms(this.material.uniforms,texture,low,high);}
    setInspectedBitmap(id=-1){this.material.uniforms.inspectedBitmap.value=id;}
    setHeatmap(enabled:boolean){this.material.uniforms.heatmapEnabled.value=enabled?1:0;}
    setSizeColors(colors:readonly string[]) {setColors(this.material.uniforms,colors);}
    setBitmapAreaMode(enabled:boolean,maxArea=145908,minArea=1,logarithmic=false){this.material.uniforms.bitmapAreaLog.value=logarithmic?1:0;this.material.uniforms.bitmapAreaMax.value=maxArea;this.material.uniforms.bitmapAreaMin.value=minArea;if(enabled)this.material.uniforms.sizeColorMode.value=2;}
    setSizeColorMode(enabled:boolean) { this.material.uniforms.sizeColorMode.value = enabled ? 1 : 0; }

    setBitmapSizes(bitmaps:readonly Rect[]) {
        this.sizeTexture?.dispose();
        const sizes=new Float32Array(2016*4);
        bitmaps.forEach((r,i)=>{sizes[i*4]=Math.min(r.width,r.height);sizes[i*4+1]=r.width*r.height;});
        this.sizeTexture=new THREE.DataTexture(sizes,2016,1,THREE.RGBAFormat,THREE.FloatType);
        this.sizeTexture.minFilter=this.sizeTexture.magFilter=THREE.NearestFilter;this.sizeTexture.needsUpdate=true;
        this.material.uniforms.bitmapSizes.value=this.sizeTexture;this.material.uniforms.lodEnabled.value=1;
    }
    setLOD(pixelsPerWorld:number,opacity:number,showAll=false) {this.material.uniforms.pixelsPerWorld.value=pixelsPerWorld;this.material.uniforms.rectanglePixelsPerWorld.value=pixelsPerWorld;this.material.uniforms.layerOpacity.value=opacity;this.material.uniforms.lodEnabled.value=showAll?0:(this.sizeTexture?1:0);}
    setArrivalFades(fades:BitmapArrivalFades,neighborhood:number){fades.bind(this.material.uniforms,neighborhood*2016);}

    addBitmap(localBitmap: number, bitmap: Rect, slots: readonly Rect[]) {
        if (this.disposed) throw new Error('Parcel layer disposed.');
        if (!Number.isInteger(localBitmap) || localBitmap < 0 || localBitmap >= 2016)
            throw new Error('Invalid neighborhood-local bitmap index.');
        if (this.bitmaps.has(localBitmap)) return; // idempotent; never duplicate transaction identities
        if (![bitmap.x, bitmap.y].every(Number.isFinite) || !Array.isArray(slots)) throw new Error('Invalid bitmap geometry.');
        // Validate before publishing a partial bitmap. Real Mondrians use positive integer sizes.
        for (const slot of slots) {
            if (![slot.x, slot.y, slot.width, slot.height].every(Number.isFinite)
                || slot.width <= this.margin || slot.height <= this.margin)
                throw new Error('Invalid parcel rectangle.');
        }
        const ranges: Range[] = [];
        let offset = 0;
        while (offset < slots.length) {
            let chunk = this.chunks[this.chunks.length - 1];
            if (!chunk || chunk.geometry.instanceCount === this.capacity) chunk = this.createChunk(this.capacityFor(Math.min(this.capacity,slots.length-offset)));
            else {
                const required=Math.min(this.capacity,chunk.geometry.instanceCount+slots.length-offset);
                if(required>chunk.geometry.getAttribute('bitmapIndex').count)this.growChunk(chunk,this.capacityFor(required));
            }
            const geometry = chunk.geometry;
            const rects = geometry.getAttribute('parcelRect') as THREE.InstancedBufferAttribute;
            const ids = geometry.getAttribute('bitmapIndex') as THREE.InstancedBufferAttribute;
            const start = geometry.instanceCount;
            const count = Math.min(ids.count - start, slots.length - offset);
            const array = rects.array as Float32Array;
            const indices = ids.array as Uint16Array;
            const bounds = geometry.boundingBox!;
            for (let i = 0; i < count; i++) {
                const slot = slots[offset + i], index = start + i, base = index * 4;
                const x = bitmap.x + slot.x, z = bitmap.y + slot.y;
                const width = slot.width - this.margin, height = slot.height - this.margin;
                array[base] = x; array[base + 1] = z; array[base + 2] = width; array[base + 3] = height;
                indices[index] = localBitmap;
                bounds.min.x = Math.min(bounds.min.x, x); bounds.min.y = 0; bounds.min.z = Math.min(bounds.min.z, z);
                bounds.max.x = Math.max(bounds.max.x, x + slot.width); bounds.max.y = 0; bounds.max.z = Math.max(bounds.max.z, z + slot.height);
            }
            geometry.instanceCount += count;
            bounds.getBoundingSphere(geometry.boundingSphere!);
            geometry.boundingSphere!.radius += Math.max(1e-6, geometry.boundingSphere!.radius * 1e-7);
            this.markRange(rects, start * 4, count * 4);
            this.markRange(ids, start, count);
            ranges.push({ chunk, start, end: start + count - 1, firstParcel: offset });
            offset += count;
        }
        this.bitmaps.set(localBitmap, { ranges, count: slots.length });
    }

    setBitmapSelected(localBitmap: number, selected: boolean) {
        const uniform = this.material.uniforms.selectedBitmap;
        if (selected) uniform.value = localBitmap;
        else if (uniform.value === localBitmap) uniform.value = -1;
        // No instance colors or buffer upload on hover.
    }

    getBitmapInfo(localBitmap: number) {
        const info = this.bitmaps.get(localBitmap);
        return info ? { ...info.ranges[0], ...info } : undefined;
    }

    get stats() {
        let count = 0;
        for (const chunk of this.chunks) count += chunk.geometry.instanceCount;
        return { format: this.formatVersion, parcels: count, chunks: this.chunks.length,
            bytesPerParcel: COMPACT_PARCEL_BYTES, allocatedInstanceBytes: this.chunks.reduce((n,c)=>n+c.geometry.getAttribute('bitmapIndex').count*COMPACT_PARCEL_BYTES,0) };
    }

    private capacityFor(required:number){return Math.min(this.capacity,Math.max(Math.min(2048,this.capacity),2**Math.ceil(Math.log2(Math.max(1,required)))));}

    estimateBytes(additional:number){
        let bytes=this.stats.allocatedInstanceBytes,remaining=additional;
        const last=this.chunks[this.chunks.length-1];
        if(last){const used=last.geometry.instanceCount,capacity=last.geometry.getAttribute('bitmapIndex').count,take=Math.min(remaining,this.capacity-used);
            bytes+=(this.capacityFor(used+take)-capacity)*COMPACT_PARCEL_BYTES;remaining-=take;}
        while(remaining>0){const take=Math.min(remaining,this.capacity);bytes+=this.capacityFor(take)*COMPACT_PARCEL_BYTES;remaining-=take;}
        return bytes;
    }

    private growChunk(chunk:Chunk,capacity:number){
        const old=chunk.geometry,g=new THREE.InstancedBufferGeometry();
        g.setAttribute('position',old.getAttribute('position'));g.setIndex(old.index);
        const rects=new THREE.InstancedBufferAttribute(new Float32Array(capacity*4),4).setUsage(THREE.DynamicDrawUsage);
        const ids=new THREE.InstancedBufferAttribute(new Uint16Array(capacity),1).setUsage(THREE.DynamicDrawUsage);
        (rects.array as Float32Array).set(old.getAttribute('parcelRect').array as Float32Array);
        (ids.array as Uint16Array).set(old.getAttribute('bitmapIndex').array as Uint16Array);
        rects.onUpload(()=>rects.clearUpdateRanges());ids.onUpload(()=>ids.clearUpdateRanges());
        g.setAttribute('parcelRect',rects);g.setAttribute('bitmapIndex',ids);g.instanceCount=old.instanceCount;
        g.boundingBox=old.boundingBox!.clone();g.boundingSphere=old.boundingSphere!.clone();chunk.geometry=g;old.dispose();
    }

    private createChunk(capacity:number) {
        const geometry = new THREE.InstancedBufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 1], 3));
        geometry.setIndex([0, 2, 1, 2, 3, 1]);
        const rects = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4).setUsage(THREE.DynamicDrawUsage);
        const ids = new THREE.InstancedBufferAttribute(new Uint16Array(capacity), 1).setUsage(THREE.DynamicDrawUsage);
        rects.onUpload(() => rects.clearUpdateRanges());
        ids.onUpload(() => ids.clearUpdateRanges());
        geometry.setAttribute('parcelRect', rects);
        geometry.setAttribute('bitmapIndex', ids);
        geometry.instanceCount = 0;
        geometry.boundingBox = new THREE.Box3(); geometry.boundingSphere = new THREE.Sphere();
        const chunk = new THREE.Mesh(geometry, this.material);
        chunk.name = `compact-parcel-chunk-${this.chunks.length}`;
        chunk.renderOrder = 3;
        // Generic Mesh.raycast sees the unexpanded unit quad, not the shader's
        // rectangles. The existing neighborhood quadtree remains authoritative.
        chunk.raycast = () => {};
        this.chunks.push(chunk); this.add(chunk);
        return chunk;
    }

    private markRange(attribute: THREE.InstancedBufferAttribute, start: number, count: number) {
        const ranges = attribute.updateRanges;
        const last = ranges[ranges.length - 1];
        if (last && last.start + last.count === start) last.count += count;
        else attribute.addUpdateRange(start, count);
        attribute.needsUpdate = true;
    }

    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        for (const chunk of this.chunks) chunk.geometry.dispose();
        this.material.dispose();
        this.sizeTexture?.dispose();
        this.chunks.length = 0; this.bitmaps.clear();
        this.clear(); this.removeFromParent();
    }
}
