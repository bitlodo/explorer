import {useLayoutEffect,useRef,useState} from 'react';
import type {MapControls,ZoomPhase} from '@/map/MapControls';
import type {KeyboardEvent,PointerEvent} from 'react';
import {Home,Plus,Minus} from 'lucide-react';
import './MapZoomSlider.css';

const fraction=(height:number,min:number,max:number)=>Math.max(0,Math.min(1,Math.log(max/height)/Math.log(max/min)));
export default function MapZoomSlider({map}:{map:MapControls}){
    const [stops,setStops]=useState<readonly number[]>([]);
    const levels=useRef<readonly number[]>([]);
    const label=useRef<HTMLOutputElement>(null);
    const input=useRef<HTMLInputElement>(null),panel=useRef<HTMLDivElement>(null),dragging=useRef(false),current=useRef(1);
    const heightAt=(value:number)=>{
        const values=levels.current,min=values[0],max=values[values.length-1];
        return max*Math.exp(-value/1000*Math.log(max/min));
    };
    const describe=(position:number)=>{
        const index=Math.round(position*4);
        return `${['Overview','Regions','Bitmaps','Parcels','Detail'][index]} · ${index+1}/5`;
    };
    const paintPosition=(position:number)=>{
        const description=describe(position);
        input.current?.setAttribute('aria-valuetext',description);
        if(label.current&&label.current.value!==description)label.current.value=description;
        panel.current?.style.setProperty('--zoom-position',`${position*100}%`);
    };
    const paint=(height:number)=>{
        current.current=height;if(dragging.current||levels.current.length<2||!input.current)return;
        const values=levels.current,position=fraction(height,values[0],values[values.length-1]);
        const value=position*1000;
        input.current.value=String(value);
        paintPosition(position);
    };
    useLayoutEffect(()=>{
        const sync=()=>{
            const zoom=map.getZoom();
            if(levels.current!==zoom.stops){levels.current=zoom.stops;setStops(zoom.stops);}
            paint(zoom.height);
        };
        sync();
        const unsubscribe=map.subscribeZoom(sync);
        return()=>{unsubscribe();dragging.current=false;};
    },[map]);
    useLayoutEffect(()=>{paint(map.getZoom().height);},[map,stops]);
    const emit=(height:number,phase:ZoomPhase)=>map.setZoom(height,phase);
    const step=(closer:boolean)=>{
        const values=levels.current,height=current.current;
        const next=closer?[...values].reverse().find(n=>n<height*(1-1e-6)):values.find(n=>n>height*(1+1e-6));
        emit(next??(closer?values[0]:values[values.length-1]),'snap');
    };
    const drag=(event:PointerEvent<HTMLElement>)=>{
        if(!input.current)return;
        const rect=input.current.getBoundingClientRect();
        const value=Math.max(0,Math.min(1000,(event.clientX-rect.left-9)/Math.max(1,rect.width-18)*1000));
        input.current.value=String(value);
        paintPosition(value/1000);
        emit(heightAt(value),'drag');
    };
    const finish=()=>{
        if(!dragging.current||!input.current)return;
        dragging.current=false;emit(heightAt(Number(input.current.value)),'release');
    };
    const keyDown=(event:KeyboardEvent<HTMLInputElement>)=>{
        if(['ArrowUp','ArrowRight','ArrowDown','ArrowLeft','PageUp','PageDown','Home','End'].includes(event.key)){
            event.preventDefault();event.stopPropagation();
            if(event.key==='Home')emit(stops[stops.length-1],'snap');
            else if(event.key==='End')emit(stops[0],'snap');
            else step(['ArrowUp','ArrowRight','PageUp'].includes(event.key));
        }
    };
    if(stops.length<2)return null;
    return <div id="map-zoom-controls" ref={panel} role="group" aria-label="Map zoom controls"
        onPointerDown={event=>event.stopPropagation()} onWheel={event=>event.stopPropagation()}>
        <button type="button" aria-label="Return to genesis" title="Return to genesis (Home)" onClick={()=>map.home()} className="map-zoom-button map-home-button">
            <Home size={19}/>
        </button>
        <span className="map-zoom-divider" aria-hidden="true"/>
        <button type="button" aria-label="Zoom out to next level" title="Zoom out to next level" onClick={()=>step(false)} className="map-zoom-button">
            <Minus size={19}/>
        </button>
        <div className="map-zoom-slider-area">
        <output ref={label} htmlFor="map-zoom-slider" className="map-zoom-label">Overview · 1/5</output>
        <div className="map-zoom-track">
            <div className="map-zoom-line">
                <div className="map-zoom-fill"/>
            </div>
            <div className="map-zoom-stops" aria-hidden="true">
                {stops.map((height,index)=><span key={height} data-zoom-stop={height}
                    className={index===0||index===stops.length-1?'map-zoom-endpoint':undefined}
                    style={{left:`${fraction(height,stops[0],stops[stops.length-1])*100}%`}}/>)}
            </div>
            <input id="map-zoom-slider" ref={input} className="map-zoom-range"
                type="range" min="0" max="1000" step="any" defaultValue="0" aria-label="Map zoom" aria-orientation="horizontal" aria-valuetext="0% zoom"
                title="Drag to zoom · Release to snap · Arrow keys to change level"
                onInput={event=>{
                    const value=Number(event.currentTarget.value);
                    paintPosition(value/1000);
                    emit(heightAt(value),dragging.current?'drag':'snap');
                }}
                onBlur={finish} onKeyDown={keyDown}/>
            <div aria-hidden="true" data-zoom-drag className="map-zoom-drag"
                onPointerDown={event=>{if(event.button!==0)return;event.preventDefault();input.current?.focus({preventScroll:true});dragging.current=true;event.currentTarget.setPointerCapture(event.pointerId);drag(event);}}
                onPointerMove={event=>{if(dragging.current)drag(event);}}
                onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={finish}/>

        </div>
        </div>
        <button type="button" aria-label="Zoom in to next level" title="Zoom in to next level" onClick={()=>step(true)} className="map-zoom-button">
            <Plus size={19}/>
        </button>
    </div>;
}
