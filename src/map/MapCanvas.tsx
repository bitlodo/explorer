import { useEffect, useRef } from 'react';
import { WebGLRenderer } from 'three';
import { cn } from '@/lib/utils';
import MapRuntime from './MapRuntime';
import type { MapControls } from './MapControls';

export default function MapCanvas({ onReady, className }: {
    onReady: (map: MapControls | null) => void;
    className?: string;
}) {
    const canvasRef = useRef<HTMLDivElement>(null);
    const runtimeRef = useRef<MapRuntime | null>(null);

    useEffect(() => {
        const container = canvasRef.current;
        if (!container) return;

        const renderer = new WebGLRenderer({ antialias: true });
        const canvas=renderer.domElement;
        canvas.tabIndex=0;
        canvas.setAttribute('aria-label','Bitmap map');
        const clearTextSelection=()=>window.getSelection()?.removeAllRanges();
        const beginMapInteraction=(event:PointerEvent)=>{
            event.preventDefault();
            clearTextSelection();
            canvas.focus({preventScroll:true});
        };
        const preventTextSelection=(event:Event)=>event.preventDefault();
        const onMapKeyDown=(event:KeyboardEvent)=>{
            if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='a'){
                event.preventDefault();clearTextSelection();
            }
        };
        canvas.addEventListener('pointerdown',beginMapInteraction,true);
        canvas.addEventListener('selectstart',preventTextSelection);
        canvas.addEventListener('dragstart',preventTextSelection);
        canvas.addEventListener('keydown',onMapKeyDown);
        container.appendChild(renderer.domElement);
        const runtime = new MapRuntime(renderer);
        const resize = () => runtime.resizeWindow(container.clientWidth, container.clientHeight);
        const observer = new ResizeObserver(resize);
        const cleanup = () => {
            observer.disconnect();
            canvas.removeEventListener('pointerdown',beginMapInteraction,true);
            canvas.removeEventListener('selectstart',preventTextSelection);
            canvas.removeEventListener('dragstart',preventTextSelection);
            canvas.removeEventListener('keydown',onMapKeyDown);
            try { runtime.dispose(); }
            finally {
                runtimeRef.current = null;
                renderer.domElement.remove();
                onReady(null);
            }
        };

        try {
            resize();
            runtime.start();
            observer.observe(container);
            runtimeRef.current = runtime;
            onReady(runtime.controller);
        } catch (error) {
            cleanup();
            throw error;
        }
        return cleanup;
    }, [onReady]);

    return <div id="mapCanvas" ref={canvasRef} className={cn('relative w-full h-full', className)} />;
}
