import * as THREE from 'three';
import { MAP_BASE_COLOR, MAP_DISABLED_COLOR, paletteColors } from './ParcelSizeColors';
import {normalizeMetric,type MetricSummary} from '@shared/mapAnalytics';
import { Quadtree, Rectangle } from '@timohausmann/quadtree-ts';
import type { NeighborhoodRect, NeighborhoodSlot } from '@shared/NeighborhoodLayout.ts';
import { CreateBufferPlaneGeometry } from '@/map/layers/planeGeometry';

/** Official overview and spatial index. Instance IDs are neighborhood IDs. */
export default class NeighborhoodOverviewMap extends THREE.Group {
    readonly quadtree: Quadtree<Rectangle<number>>;
    readonly neighborhoodInstances: THREE.InstancedMesh;

    constructor(readonly slots: NeighborhoodSlot[], readonly bounds: NeighborhoodRect) {
        super();
        this.quadtree = new Quadtree({ ...bounds, maxObjects: 10, maxLevels: 8 });
        this.neighborhoodInstances = new THREE.InstancedMesh(
            CreateBufferPlaneGeometry(),
            new THREE.MeshBasicMaterial({ depthTest: false, depthWrite: false, transparent: true }),
            slots.length,
        );
        this.neighborhoodInstances.renderOrder = 0;
        const transform = new THREE.Matrix4();
        const color = new THREE.Color();
        slots.forEach((slot, id) => {
            transform.makeScale(slot.width, 1, slot.height).setPosition(slot.x, 0, slot.y);
            this.neighborhoodInstances.setMatrixAt(id, transform);
            color.set(MAP_BASE_COLOR).multiplyScalar(.32);
            this.neighborhoodInstances.setColorAt(id, color);
            this.quadtree.insert(new Rectangle({ ...slot, data: id }));
        });
        this.neighborhoodInstances.instanceMatrix.needsUpdate = true;
        if (this.neighborhoodInstances.instanceColor) this.neighborhoodInstances.instanceColor.needsUpdate = true;
        this.neighborhoodInstances.computeBoundingSphere();
        this.add(this.neighborhoodInstances);
    }

    setSizeColors(means:Float32Array|undefined,colors:readonly string[],areas?:{scale?:MetricSummary['scale'];minArea?:number;maxArea:number;neighborhoodMeans:readonly number[]},low=1,high=9){
        const palette=paletteColors(colors),color=new THREE.Color();
        this.slots.forEach((_,id)=>{
            if(areas){const t=normalizeMetric(areas.neighborhoodMeans[id],{min:areas.minArea??1,max:areas.maxArea,scale:areas.scale??'linear'});const v=t*8,a=Math.floor(v);color.copy(palette[a]).lerp(palette[Math.min(8,a+1)],v-a);if(1+t*8<low||1+t*8>high)color.set(MAP_DISABLED_COLOR);}
            else if(means){let total=0;for(let i=0;i<2016;i++)total+=means[id*2016+i];const t=Math.max(0,Math.min(8,total/2016-1)),a=Math.floor(t);color.copy(palette[a]).lerp(palette[Math.min(8,a+1)],t-a);}
            else color.set(MAP_BASE_COLOR).multiplyScalar(.32);
            this.neighborhoodInstances.setColorAt(id,color);
        });if(this.neighborhoodInstances.instanceColor)this.neighborhoodInstances.instanceColor.needsUpdate=true;
    }
    setParcelClasses(means:readonly number[],coverage:readonly number[],colors:readonly string[]){
        const palette=paletteColors(colors),color=new THREE.Color(),dim=new THREE.Color(MAP_DISABLED_COLOR);
        this.slots.forEach((_,id)=>{const v=Math.max(0,Math.min(8,means[id]-1)),a=Math.floor(v);color.copy(palette[a]).lerp(palette[Math.min(8,a+1)],v-a);color.lerp(dim,coverage[id]>0?0:1);this.neighborhoodInstances.setColorAt(id,color);});
        if(this.neighborhoodInstances.instanceColor)this.neighborhoodInstances.instanceColor.needsUpdate=true;
    }
    setAnalytic(summary:MetricSummary,colors:readonly string[],low=1,high=9){
        const palette=paletteColors(colors);const color=new THREE.Color();
        this.slots.forEach((_,id)=>{const v=normalizeMetric(summary.neighborhoodMeans[id],summary)*8,t=Math.floor(v);color.copy(palette[t]).lerp(palette[Math.min(8,t+1)],v-t);if(v+1<low||v+1>high)color.set(MAP_DISABLED_COLOR);this.neighborhoodInstances.setColorAt(id,color);});
        if(this.neighborhoodInstances.instanceColor)this.neighborhoodInstances.instanceColor.needsUpdate=true;
    }
    setOpacity(opacity:number) { (this.neighborhoodInstances.material as THREE.MeshBasicMaterial).opacity=opacity;this.visible=opacity>.002; }

    dispose() {
        this.neighborhoodInstances.dispose();
        this.neighborhoodInstances.geometry.dispose();
        (this.neighborhoodInstances.material as THREE.Material).dispose();
        this.quadtree.clear();
        this.removeFromParent();
    }
}
