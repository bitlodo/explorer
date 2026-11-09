import * as THREE from 'three';
import type { NeighborhoodData, Rect } from '../types';
import SpriteText from 'three-spritetext';
import { Quadtree, Rectangle } from '@timohausmann/quadtree-ts';
import { CreateBufferPlaneGeometry } from '@/map/layers/planeGeometry';
import {PARCEL_SIZE_COLORS,MAP_BASE_COLOR} from './ParcelSizeColors';
import CompactParcelLayer from './CompactParcelLayer';
import type BitmapArrivalFades from './BitmapArrivalFades';
import {bitmapArrivalGLSL,BITMAP_ARRIVAL_ATLAS_FORMAT} from '@shared/bitmapArrival';

export type ParcelRenderer = 'compact' | 'legacy';

export default class NeighborhoodMap extends THREE.Object3D {

    public data: NeighborhoodData;
    private defaultColor = new THREE.Color(MAP_BASE_COLOR);
    private margin = 0.5;
    private txInstanceMaxSize = 100000;

    private bitmapAreaMaterial!: THREE.MeshBasicMaterial;
    private txAreaMaterial!: THREE.MeshBasicMaterial;

    public bitmapAreaInstance!: THREE.InstancedMesh;

    private bitmapChunks: THREE.InstancedMesh[] = [];
    private bitmapInstanceMap: Map<number, { chunk: THREE.InstancedMesh, start: number, end: number }> = new Map();

    public bitmapChunksContainer!: THREE.Group;

    public quadtree!: Quadtree<Rectangle<number>>;

    private readonly parcelRenderer: ParcelRenderer;
    private compactParcels?: CompactParcelLayer;
    private parcelClassTexture?:THREE.DataTexture;
    private parcelClassRange:[number,number]=[1,9];
    private analyticTexture?:THREE.DataTexture;
    private analyticRange:[number,number]=[1,9];
    private heatmapMode=false;
    private sizeColorMode = false;
    private areaColorMode=false;
    private areaMax=145908;
    private areaMin=1;
    private areaLog=false;
    private inspectedBitmap=-1;
    private hoveredBitmap=-1;
    private sizeColors:readonly string[]=PARCEL_SIZE_COLORS;
    public lodOpacity = 0;
    public maxBitmapSize = 0;
    private neighborhoodLabel?: SpriteText;
    private arrivalFades?: BitmapArrivalFades;
    private disposed = false;

    constructor(data: NeighborhoodData, parcelRenderer: ParcelRenderer = 'compact') {
        super();
        this.data = data;
        this.parcelRenderer = parcelRenderer;
        this.init();
    }

    private init() {

        this.quadtree = new Quadtree({
            x: this.data.x,
            y: this.data.y,
            width: this.data.width,
            height: this.data.height,
            maxObjects: 10, // optional, default: 10
            maxLevels: 8    // optional, default:  4
        });

        for (let i = 0; i < this.data.bitmaps.length; i++) {
            const bitmap = this.data.bitmaps[i];
            this.maxBitmapSize=Math.max(this.maxBitmapSize,Math.min(bitmap.width,bitmap.height));
            this.quadtree.insert(new Rectangle({ x: bitmap.x, y: bitmap.y, width: bitmap.width, height: bitmap.height, data: (this.data.neighborhood * 2016) + i }));
        }

        this.renderOrder = 1;

        const myText = new SpriteText(this.data.neighborhood.toString() ?? 'all', 30);
        myText.center = new THREE.Vector2(0, 1);
        myText.position.set(10, 0.2, 10);
        this.neighborhoodLabel=myText;myText.renderOrder=4;
        this.add(myText);

        this.bitmapAreaMaterial = new THREE.MeshBasicMaterial({
            transparent: true,
            depthTest: false,  // Ignora o teste de profundidade
            depthWrite: false,
        });

        this.txAreaMaterial = new THREE.MeshBasicMaterial({
            transparent: true,
            depthTest: false,  // Ignora o teste de profundidade
            depthWrite: false,
        });

        this.bitmapAreaInstance = new THREE.InstancedMesh(CreateBufferPlaneGeometry(), this.bitmapAreaMaterial, this.data.bitmaps.length);
        this.bitmapAreaInstance.frustumCulled = false;
        this.bitmapAreaInstance.renderOrder = 2;
        this.add(this.bitmapAreaInstance);

        this.bitmapChunksContainer = new THREE.Group();
        this.add(this.bitmapChunksContainer);
        if (this.parcelRenderer === 'compact') {
            this.compactParcels = new CompactParcelLayer(this.txInstanceMaxSize, this.margin);
            this.compactParcels.setBitmapSizes(this.data.bitmaps);
            this.compactParcels.setSizeColorMode(this.sizeColorMode);
            this.compactParcels.setBitmapAreaMode(this.areaColorMode,this.areaMax,this.areaMin,this.areaLog);
            this.compactParcels.setSizeColors(this.sizeColors);
            this.compactParcels.setInspectedBitmap(this.inspectedBitmap);
            this.compactParcels.setAnalytic(this.analyticTexture,...this.analyticRange);this.compactParcels.setParcelClasses(this.parcelClassTexture,...this.parcelClassRange);this.compactParcels.setHeatmap(this.heatmapMode);
            this.bitmapChunksContainer.add(this.compactParcels);
            this.txAreaMaterial.dispose(); // the compact layer owns its shader material
        }

        this.generateBitmapBase();

    }

    setParcelClasses(texture?:THREE.DataTexture,low=1,high=9){this.parcelClassTexture=texture;this.parcelClassRange=[low,high];this.compactParcels?.setParcelClasses(texture,low,high);}
    setAnalytic(texture?:THREE.DataTexture,low=1,high=9){this.analyticTexture=texture;this.analyticRange=[low,high];this.compactParcels?.setAnalytic(texture,low,high);}
    setHeatmap(enabled:boolean){this.heatmapMode=enabled;this.compactParcels?.setHeatmap(enabled);}
    setSizeColors(colors:readonly string[]){this.sizeColors=colors;this.compactParcels?.setSizeColors(colors);}
    setBitmapAreaMode(enabled:boolean,maxArea=145908,minArea=1,logarithmic=false){this.areaLog=logarithmic;this.areaColorMode=enabled;this.areaMax=maxArea;this.areaMin=minArea;this.compactParcels?.setBitmapAreaMode(enabled,maxArea,minArea,logarithmic);}
    setSizeColorMode(enabled:boolean) { this.sizeColorMode = enabled;this.areaColorMode=false; this.compactParcels?.setSizeColorMode(enabled); }

    setLOD(pixelsPerWorld:number,opacity:number,parcelOpacity=opacity,showAllParcels=false,showBitmapBase=true) {
        this.lodOpacity=opacity;this.bitmapAreaMaterial.opacity=opacity;
        this.bitmapAreaInstance.visible=showBitmapBase&&opacity>.002;
        if(this.compactParcels)this.compactParcels.visible=parcelOpacity>0;
        this.compactParcels?.setLOD(pixelsPerWorld,parcelOpacity,showAllParcels);
        if(!this.compactParcels)this.txAreaMaterial.opacity=parcelOpacity;
        if(this.neighborhoodLabel){this.neighborhoodLabel.material.opacity=opacity;this.neighborhoodLabel.visible=showBitmapBase&&opacity>.02;}
    }

    setArrivalFades(fades:BitmapArrivalFades){
        this.arrivalFades=fades;this.compactParcels?.setArrivalFades(fades,this.data.neighborhood);
        if(!this.compactParcels){
            this.txAreaMaterial.onBeforeCompile=shader=>{
                fades.bind(shader.uniforms,this.data.neighborhood*2016);
                shader.vertexShader=`${bitmapArrivalGLSL}\nattribute float arrivalBitmap;varying float vArrival;
                uniform sampler2D arrivalMap;uniform vec2 arrivalMapSize;uniform float arrivalBitmapBase;
                `+shader.vertexShader.replace('#include <begin_vertex>',`#include <begin_vertex>
                float arrivalId=arrivalBitmapBase+arrivalBitmap;
                vArrival=parcelArrivalOpacity(texture2D(arrivalMap,(vec2(mod(arrivalId,arrivalMapSize.x),floor(arrivalId/arrivalMapSize.x))+.5)/arrivalMapSize).r);`);
                shader.fragmentShader='varying float vArrival;\n'+shader.fragmentShader.replace('#include <color_fragment>','#include <color_fragment>\ndiffuseColor.a*=vArrival;');
            };
            this.txAreaMaterial.customProgramCacheKey=()=>`legacy-parcel-${BITMAP_ARRIVAL_ATLAS_FORMAT}`;this.txAreaMaterial.needsUpdate=true;
        }
    }

    setInspectedBitmap(bitmap=-1){
        const previous=this.inspectedBitmap;this.inspectedBitmap=bitmap;
        if(this.compactParcels)this.compactParcels.setInspectedBitmap(bitmap);
        else{this.updateLegacyBitmapColor(previous);this.updateLegacyBitmapColor(bitmap);}
    }
    setBitmapSelected(bitmap:number,selected:boolean){
        if(selected)this.hoveredBitmap=bitmap;else if(this.hoveredBitmap===bitmap)this.hoveredBitmap=-1;
        if(this.compactParcels)this.compactParcels.setBitmapSelected(bitmap%2016,selected);
        else this.updateLegacyBitmapColor(bitmap);
    }
    private updateLegacyBitmapColor(bitmap:number){
        const range=this.bitmapInstanceMap.get(bitmap);if(!range)return;
        const color=bitmap===this.inspectedBitmap?new THREE.Color('#ffffff'):bitmap===this.hoveredBitmap?new THREE.Color('orange'):this.defaultColor;
        for(let i=range.start;i<=range.end;i++)range.chunk.setColorAt(i,color);
        range.chunk.instanceColor!.needsUpdate=true;
    }

    private tempMatrix = new THREE.Matrix4();
    AddBitmap(bitmap: number, slots: readonly Rect[]) {
        if (slots.length === 0) return;
        if (this.compactParcels) {
            this.compactParcels.addBitmap(bitmap % 2016, this.data.bitmaps[bitmap % 2016], slots);
            return;
        }

        let currentMesh = this.bitmapChunks[this.bitmapChunks.length - 1] ?? null;

        if (currentMesh === null || currentMesh.count + slots.length > this.txInstanceMaxSize) {

            if (currentMesh) {
                currentMesh.frustumCulled = true;
                currentMesh.computeBoundingBox();
                currentMesh.computeBoundingSphere();
                this.updateChunk(currentMesh)
            }

            currentMesh = new THREE.InstancedMesh(
                CreateBufferPlaneGeometry(),
                this.txAreaMaterial,
                Math.max(this.txInstanceMaxSize, slots.length)
            );
            currentMesh.frustumCulled = false;
            currentMesh.renderOrder = 3;
            currentMesh.count = 0;

            this.bitmapChunks.push(currentMesh);
            this.bitmapChunksContainer.add(currentMesh);
            if(this.arrivalFades)currentMesh.geometry.setAttribute('arrivalBitmap',new THREE.InstancedBufferAttribute(new Uint16Array(currentMesh.instanceMatrix.count),1).setUsage(THREE.DynamicDrawUsage));

        }

        const startIndex = currentMesh.count;
        const arrivalIds=currentMesh.geometry.getAttribute('arrivalBitmap') as THREE.InstancedBufferAttribute|undefined;
        if(arrivalIds){(arrivalIds.array as Uint16Array).fill(bitmap%2016,startIndex,startIndex+slots.length);arrivalIds.addUpdateRange(startIndex,slots.length);arrivalIds.needsUpdate=true;}

        for (let i = 0; i < slots.length; i++) {
            const slot = slots[i];
            const x = this.data.bitmaps[bitmap % 2016].x + slot.x;
            const y = this.data.bitmaps[bitmap % 2016].y + slot.y;
            const widthValue = slot.width - this.margin;
            const heightValue = slot.height - this.margin;

            this.tempMatrix.makeScale(widthValue, 1, heightValue).setPosition(x, 0, y);

            currentMesh.count += 1
            currentMesh.setMatrixAt(startIndex + i, this.tempMatrix);

            currentMesh.setColorAt(startIndex+i,bitmap===this.inspectedBitmap?new THREE.Color('#ffffff'):bitmap===this.hoveredBitmap?new THREE.Color('orange'):this.defaultColor);

        }

        this.bitmapInstanceMap.set(bitmap, {
            chunk: currentMesh,
            start: startIndex,
            end: startIndex + slots.length - 1
        });

        // Publish GPU ranges together; an old delayed matrix upload would let a
        // bitmap's arrival fade advance before its parcels are drawable.
        this.updateChunk(currentMesh);
    }

    private updateChunk(chunk: THREE.InstancedMesh) {
        chunk.instanceMatrix.needsUpdate = true;
        if (chunk.instanceColor) chunk.instanceColor.needsUpdate = true;
    }

    /** Attribute capacity is a CPU and GPU budget unit, not total driver memory. */
    get parcelBytes(): number {
        if (this.compactParcels) return this.compactParcels.stats.allocatedInstanceBytes;
        return this.bitmapChunks.reduce((sum, chunk) => sum + chunk.instanceMatrix.array.byteLength + (chunk.instanceColor?.array.byteLength || 0)+(chunk.geometry.getAttribute('arrivalBitmap')?.array.byteLength||0), 0);
    }

    estimateParcelBytes(additional: number): number {
        if (this.compactParcels) return this.compactParcels.estimateBytes(additional);
        const last = this.bitmapChunks[this.bitmapChunks.length - 1];
        return this.parcelBytes + (!last || last.count + additional > this.txInstanceMaxSize ? Math.max(this.txInstanceMaxSize, additional) * (this.arrivalFades?78:76) : 0);
    }

    clearParcelDetails() {
        this.arrivalFades?.resetNeighborhood(this.data.neighborhood);
        if (this.compactParcels) {
            this.compactParcels.dispose();
            this.compactParcels = new CompactParcelLayer(this.txInstanceMaxSize, this.margin);
            this.compactParcels.setBitmapSizes(this.data.bitmaps);
            this.compactParcels.setSizeColorMode(this.sizeColorMode);
            this.compactParcels.setBitmapAreaMode(this.areaColorMode,this.areaMax,this.areaMin,this.areaLog);
            this.compactParcels.setSizeColors(this.sizeColors);
            this.compactParcels.setInspectedBitmap(this.inspectedBitmap);
            this.compactParcels.setAnalytic(this.analyticTexture,...this.analyticRange);this.compactParcels.setParcelClasses(this.parcelClassTexture,...this.parcelClassRange);this.compactParcels.setHeatmap(this.heatmapMode);
            if(this.arrivalFades)this.compactParcels.setArrivalFades(this.arrivalFades,this.data.neighborhood);
            this.bitmapChunksContainer.add(this.compactParcels);
        }
        for (const chunk of this.bitmapChunks) { chunk.dispose(); chunk.geometry.dispose(); chunk.removeFromParent(); }
        this.bitmapChunks = []; this.bitmapInstanceMap.clear();
    }

    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        this.arrivalFades?.resetNeighborhood(this.data.neighborhood);
        this.compactParcels?.dispose();
        const geometries = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>();
        this.traverse(child => {
            if (child instanceof THREE.InstancedMesh) child.dispose();
            if (child instanceof THREE.Mesh || child instanceof THREE.Sprite) {
                if (child instanceof THREE.Mesh) geometries.add(child.geometry);
                for (const material of Array.isArray(child.material) ? child.material : [child.material]) materials.add(material);
            }
        });
        geometries.forEach(g => g.dispose());
        materials.forEach(m => { (m as THREE.MeshBasicMaterial).map?.dispose(); m.dispose(); });
        this.bitmapChunks = []; this.bitmapInstanceMap.clear(); this.quadtree.clear(); this.clear(); this.removeFromParent();
    }

    getBitmapInfo(bitmap: number) {
        if (this.compactParcels) return this.compactParcels.getBitmapInfo(bitmap % 2016);
        return this.bitmapInstanceMap.get(bitmap);
    }

    private generateBitmapBase() {
        const matrix = new THREE.Matrix4();
        const color = new THREE.Color();
        for (let i = 0; i < this.data.bitmaps.length; i++) {
            const slot = this.data.bitmaps[i];
            color.set(MAP_BASE_COLOR);
            matrix.makeScale(slot.width - this.margin, 1, slot.height - this.margin).setPosition(slot.x, 0, slot.y);
            this.bitmapAreaInstance.setColorAt(i, color);
            this.bitmapAreaInstance.setMatrixAt(i, matrix);
        }
        this.bitmapAreaInstance.computeBoundingBox();
        this.bitmapAreaInstance.computeBoundingSphere();
    }
}
