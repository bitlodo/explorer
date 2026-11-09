import * as THREE from 'three';

export default abstract class MapSceneBase extends THREE.Scene {
    protected renderer: THREE.WebGLRenderer;
    public raycaster: THREE.Raycaster;
    public abstract camera: THREE.PerspectiveCamera;
    constructor(renderer: THREE.WebGLRenderer) {
        super();
        this.renderer = renderer;
        this.raycaster = new THREE.Raycaster();
    }

    public resizeWindow(width: number, height: number): void {
        if (!this.camera) return;
        this.camera.aspect = width / height;
        this.camera.updateProjectionMatrix();
    }

    public getPointerRaycast(pointerPosition: THREE.Vector2): THREE.Vector3 {
        this.raycaster.setFromCamera(pointerPosition, this.camera);
        const currentPosition = new THREE.Vector3();
        const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
        this.raycaster.ray.intersectPlane(plane, currentPosition);
        return currentPosition;
    }

    public abstract start(): void;

    public abstract render(): void;

    public abstract dispose(): void;
}
