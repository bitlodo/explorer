import type * as THREE from 'three';
import type Stats from 'stats.js';
import type MapSceneBase from './MapSceneBase';
import MapController from './MapController';

/** Owns the renderer and frame loop; the controller owns scenes and map data. */
export default class MapRuntime {
    readonly controller: MapController;
    scene?: MapSceneBase;

    private animationFrame = 0;
    private started = false;
    private disposed = false;
    private stats?: Stats;

    constructor(readonly renderer: THREE.WebGLRenderer) {
        this.controller = new MapController(this);
        renderer.setPixelRatio(1);
        if(new URLSearchParams(window.location.search).get('stats')==='on')void this.loadStats();
    }

    start(): void {
        if (this.disposed) throw new Error('Map is disposed.');
        if (this.started) return;
        this.started = true;
        this.controller.start();
        if (!this.disposed) this.animationFrame = requestAnimationFrame(this.animate);
    }

    private readonly animate = () => {
        if (this.disposed) return;
        this.stats?.begin();
        this.controller.update();
        this.scene?.render();
        this.stats?.end();
        if (!this.disposed) this.animationFrame = requestAnimationFrame(this.animate);
    };

    private async loadStats(): Promise<void> {
        const { default: Stats } = await import('stats.js');
        if (this.disposed) return;
        this.stats = new Stats();
        this.stats.showPanel(0);
        Object.assign(this.stats.dom.style, { position: 'absolute', top: '', bottom: '0px' });
        this.renderer.domElement.parentElement?.appendChild(this.stats.dom);
    }

    resizeWindow(width: number, height: number): void {
        if (this.disposed || width <= 0 || height <= 0) return;
        this.renderer.setSize(width, height);
        this.scene?.resizeWindow(width, height);
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        cancelAnimationFrame(this.animationFrame);
        try {
            this.controller.dispose();
        } finally {
            this.scene = undefined;
            this.stats?.dom.remove();
            this.renderer.dispose();
        }
    }
}
