import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import MapSceneBase from '@/map/MapSceneBase';
import LoadedChunkBounds,{type ChunkDebugMode} from '@/map/layers/LoadedChunkBounds';
import type { LoadedChunk } from '@/data/MapDataSource';
import type {NeighborhoodRect} from '@shared/NeighborhoodLayout';
import {constrainMapCenter} from '@shared/mapNavigation';

/** Official flat-map scene, with 2D pan and no debug frustum. */
export default class SceneNeighborhoodMap extends MapSceneBase {
    camera!: THREE.PerspectiveCamera;
    controls!: OrbitControls;
    private disposed = false;
    private panning = false;
    private panTarget = new THREE.Vector2();
    private occupiedBounds?: NeighborhoodRect;
    readonly chunkBounds = new LoadedChunkBounds();
    readonly neighborhoodBounds = new LoadedChunkBounds(0xffff00, 'loaded-neighborhood-bounds', 1);
    readonly heatmapBounds = new LoadedChunkBounds(0xffff00, 'loaded-heatmap-chunk-bounds', 0);
    private readonly debugBounds = new THREE.Group();
    private readonly pixelAnchor = new THREE.Vector3();

    /** Snap the rendered phase only; OrbitControls retains fractional pan input. */
    alignParcelPixels(enabled:boolean) {
        const camera=this.camera,view=camera.view;
        if(!enabled){if(view?.enabled)camera.clearViewOffset();return;}
        const {width,height}=this.renderer.domElement;
        if(!width||!height)return;
        camera.updateMatrixWorld();
        // Half-unit anchors share the same pixel phase at six pixels per unit.
        this.pixelAnchor.set(Math.round(camera.position.x*2)/2,0,Math.round(camera.position.z*2)/2).project(camera);
        const x=(this.pixelAnchor.x+1)*width/2+(view?.enabled?view.offsetX*width/view.fullWidth:0);
        const y=(1-this.pixelAnchor.y)*height/2+(view?.enabled?view.offsetY*height/view.fullHeight:0);
        const offsetX=x-Math.round(x),offsetY=y-Math.round(y);
        if(view?.enabled&&view.fullWidth===width&&view.fullHeight===height&&Math.abs(view.offsetX-offsetX)<1e-7&&Math.abs(view.offsetY-offsetY)<1e-7)return;
        camera.setViewOffset(width,height,offsetX,offsetY,width,height);
    }

    start() {
        this.background = new THREE.Color('#17191d');
        // Group order dominates the individual mesh orders in Three's
        // transparent queue, keeping both debug layers above map groups.
        this.debugBounds.name = 'map-download-debug';
        this.debugBounds.renderOrder = 1000;
        this.debugBounds.add(this.heatmapBounds, this.neighborhoodBounds, this.chunkBounds);
        this.add(this.debugBounds);
        const aspect = this.renderer.domElement.clientWidth / this.renderer.domElement.clientHeight;
        this.camera = new THREE.PerspectiveCamera(15, aspect || 1, 0.1, 2000000);
        // OrbitControls ground-plane panning uses camera.up to derive its second
        // axis. Keep world Y up; setting Z up turns vertical drags into dolly.
        this.camera.up.set(0, 1, 0);
        this.camera.position.set(0, 10000, 0);
        this.camera.lookAt(0, 0, 0);
        this.controls = new OrbitControls(this.camera, this.renderer.domElement);
        this.controls.enableRotate = false;
        this.controls.enableZoom = false;
        this.controls.screenSpacePanning = false;
        this.controls.mouseButtons.LEFT = THREE.MOUSE.PAN;
        this.controls.mouseButtons.RIGHT = THREE.MOUSE.PAN;
        this.controls.update();
        this.controls.addEventListener('start', this.onPanStart);
        this.controls.addEventListener('change', this.onControlsChange);
        this.controls.addEventListener('end', this.onPanEnd);
    }

    setMapRegions(regions:readonly NeighborhoodRect[]) {
        let x=Infinity,y=Infinity,right=-Infinity,bottom=-Infinity;
        for(const r of regions){x=Math.min(x,r.x);y=Math.min(y,r.y);right=Math.max(right,r.x+r.width);bottom=Math.max(bottom,r.y+r.height);}
        this.occupiedBounds=regions.length?{x,y,width:right-x,height:bottom-y}:undefined;
    }

    private readonly onPanStart = () => {
        this.panning=true;this.panTarget.set(this.controls.target.x,this.controls.target.z);
    };
    private readonly onControlsChange = () => {
        if(!this.panning)return;
        const target=this.controls.target;
        // A distance-only update also emits change. Clamp only a real pan,
        // so zoom can retain its center even in a natural gap in the layout.
        if(target.x!==this.panTarget.x||target.z!==this.panTarget.y)this.constrainPan();
        this.panTarget.set(target.x,target.z);
    };
    private readonly onPanEnd = () => {this.panning=false;};

    resizeWindow(width:number,height:number) {
        super.resizeWindow(width,height);this.constrainPan();
    }

    // Clamp both camera and OrbitControls target by the same translation. This
    // preserves the top-down view, drag speed and height at every screen size.
    readonly constrainPan = () => {
        if(!this.occupiedBounds)return;
        const camera=this.camera;
        const height=2*camera.position.y*Math.tan(THREE.MathUtils.degToRad(camera.fov)/2);
        const center=constrainMapCenter({x:camera.position.x,y:camera.position.z},{width:height*camera.aspect,height},this.occupiedBounds);
        const dx=center.x-camera.position.x,dz=center.y-camera.position.z;
        camera.position.x+=dx;camera.position.z+=dz;
        this.controls.target.x+=dx;this.controls.target.z+=dz;
    };

    setChunkDebugMode(mode:ChunkDebugMode) {
        this.chunkBounds.visible=mode==='all'||mode==='parcels';
        this.neighborhoodBounds.visible=mode==='all'||mode==='bitmaps';
        this.heatmapBounds.visible=mode==='all'||mode==='heatmap';
    }

    showLoadedChunk(chunk: LoadedChunk) {
        if (!this.disposed) this.chunkBounds.addChunk(chunk);
    }

    showLoadedNeighborhoodChunk(chunk: LoadedChunk) {
        if (!this.disposed) this.neighborhoodBounds.addChunk(chunk);
    }

    showLoadedHeatmapChunk(chunk: LoadedChunk) {
        if (!this.disposed) this.heatmapBounds.addChunk(chunk);
    }

    fitDistance(width: number, height: number) {
        const verticalFov = THREE.MathUtils.degToRad(this.camera.fov);
        return Math.max(height, width / this.camera.aspect) / (2 * Math.tan(verticalFov / 2)) * 1.08;
    }

    render() {
        if (this.disposed) return;
        this.controls.update();
        this.renderer.render(this, this.camera);
    }

    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        this.controls?.removeEventListener('start', this.onPanStart);
        this.controls?.removeEventListener('change', this.onControlsChange);
        this.controls?.removeEventListener('end', this.onPanEnd);
        this.controls?.dispose();
        this.occupiedBounds=undefined;
        this.chunkBounds.dispose();
        this.neighborhoodBounds.dispose();
        this.heatmapBounds.dispose();
        this.debugBounds.removeFromParent();
        this.clear();
    }
}
