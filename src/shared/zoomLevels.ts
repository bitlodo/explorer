import {smooth,type PreviewIndex} from './heatmapPreview';

export const ZOOM_DAMPING = {snapFrequency:16,swipeSensitivity:.004};
export const WHEEL_ZOOM = {minimumSamples:3,thresholdPixels:80,directionWindowMs:60,idleMs:220};
export const ZOOM_LEVEL_COUNT = 5;
// Even spacing gives size-1 parcels integer fill and gap widths (0.5 units each).
export const PARCEL_DETAIL_PIXELS = 6;
export const MAP_FRAMING = {margin:.05,overscrollMultiplier:4};
type Pyramid=Pick<PreviewIndex,'tileSize'|'resolution'|'maxLevel'>;

/** Keep the closest stop at a fixed pixel scale across viewport sizes. */
export function parcelDetailDistance(viewportHeight:number,fov:number){
    return viewportHeight/(2*Math.tan(fov*Math.PI/360)*PARCEL_DETAIL_PIXELS);
}

/** Reference scale only: no padding, centering or changes to the world layout. */
export function neighborhoodFitDistance(size:{width:number;height:number},aspect:number,fov:number){
    return Math.max(size.height,size.width/aspect)/(2*Math.tan(fov*Math.PI/360));
}

export function overviewFrame(bounds:{x:number;y:number;width:number;height:number},aspect:number,fov:number,center={x:bounds.x+bounds.width/2,z:bounds.y+bounds.height/2}){
    const width=2*Math.max(Math.abs(bounds.x-center.x),Math.abs(bounds.x+bounds.width-center.x));
    const span=2*Math.max(Math.abs(bounds.y-center.z),Math.abs(bounds.y+bounds.height-center.z));
    const height=Math.max(span,width/aspect)/(2*Math.tan(fov*Math.PI/360))/(1-2*MAP_FRAMING.margin);
    return {...center,height:Math.max(20,height)};
}

export function damp(value:number,target:number,velocity:number,dt:number,frequency:number){
    const offset=value-target,impulse=(velocity+frequency*offset)*dt,decay=Math.exp(-frequency*dt);
    return {value:target+(offset+impulse)*decay,velocity:(velocity-frequency*impulse)*decay};
}

/** Five stops including both endpoints, evenly spaced along the zoom scale. */
export function zoomDistances(_unit:number,_pyramid:Pyramid,min:number,max:number,home:number):number[] {
    const restMax=Math.min(max,home),ratio=restMax/min;
    return Array.from({length:ZOOM_LEVEL_COUNT},(_,index)=>index===0?min:index===ZOOM_LEVEL_COUNT-1?restMax:min*ratio**(index/(ZOOM_LEVEL_COUNT-1)));
}

/** Zoom is multiplicative; nearest uses log distance, not a bias toward small heights. */
export function nearestZoom(distance:number,stops:readonly number[]):number {
    return stops.reduce((best,stop)=>Math.abs(Math.log(stop/distance))<Math.abs(Math.log(best/distance))?stop:best,stops[0]);
}

/** Require several wheel samples and use their majority direction for one adjacent stop. */
export class WheelZoomGesture {
    private previous?:number;
    private motion=0;
    private samples=0;
    private votes=0;
    private anchor=0;
    private consumed=false;
    private started=0;
    get pending(){return !this.consumed&&this.samples>=WHEEL_ZOOM.minimumSamples&&this.votes!==0&&this.motion>=WHEEL_ZOOM.thresholdPixels;}
    input(height:number,delta:number,now:number,stops:readonly number[]):number|undefined {
        if(!Number.isFinite(delta)||delta===0||stops.length===0)return;
        if(this.previous===undefined||now-this.previous>=WHEEL_ZOOM.idleMs){
            this.motion=0;this.samples=0;this.votes=0;this.anchor=nearestZoom(height,stops);this.consumed=false;this.started=now;
        }
        this.previous=now;
        if(this.consumed)return;
        // Magnitude only filters tiny motion. Every event has one direction vote,
        // so a single large or inverted sample cannot determine the zoom direction.
        this.motion+=Math.min(WHEEL_ZOOM.thresholdPixels,Math.abs(delta));
        this.samples++;this.votes+=Math.sign(delta);
        return this.update(now,stops);
    }
    update(now:number,stops:readonly number[]):number|undefined {
        if(!this.pending||now-this.started<WHEEL_ZOOM.directionWindowMs||stops.length===0)return;
        this.consumed=true;
        const index=stops.indexOf(nearestZoom(this.anchor,stops));
        return stops[Math.max(0,Math.min(stops.length-1,index+Math.sign(this.votes)))];
    }
    reset(){this.previous=undefined;this.motion=0;this.samples=0;this.votes=0;this.consumed=false;}
}

export function zoomPosition(distance:number,stops:readonly number[]):number {
    return Math.max(0,Math.min(stops.length-1,Math.log(distance/stops[0])/Math.log(stops[stops.length-1]/stops[0])*(stops.length-1)));
}
/** Download eligibility is independent of the visual blend and its rounding. */
export function lod4DownloadsAllowed(distance:number,stops:readonly number[]):boolean {
    const limit=stops[3];
    return Number.isFinite(distance)&&distance>0&&Number.isFinite(limit)&&limit>0&&distance<=limit*(1+1e-6);
}
export function zoomTier(distance:number,stops:readonly number[]):'parcels'|'neighborhoods'|'preview' {
    const level=Math.round(zoomPosition(distance,stops));
    return level<=1?'parcels':level<=2?'neighborhoods':'preview';
}
export function tierDetail(distance:number,stops:readonly number[],index:Pyramid,_worldPerPixel:number,_moving:boolean):number {
    const max=index.maxLevel,position=zoomPosition(distance,stops);
    const q=Math.abs(position-Math.round(position))<1e-6?Math.round(position):position;
    if(q<=1)return max+2;
    if(q<2)return max+2-smooth(1,2,q);
    // Stop 3: exact geometry; stop 4: finest grouped preview; stop 5:
    // the previous intermediate preview. The slider directly controls the preview/exact blend;
    // individual geometry arrivals retain their preview independently.
    if(q<=3)return max+3-q;
    const overviewLevel=Math.max(0,max-3);
    return max-overviewLevel*smooth(3,4,q);
}
export const heatmapStrength=(distance:number,stops:readonly number[])=>1-.41*smooth(3,4,zoomPosition(distance,stops));

/** A critically damped spring in log distance. No timers or per-event tween restarts. */
export class DampedZoom {
    active=false;
    snapping=false;
    velocity=0;
    private position=0;
    private intent=0;
    private goal=0;
    private tickTime=0;
    private min=20;
    private max=20;
    get height(){return Math.exp(this.position);}
    get intentHeight(){return Math.exp(this.intent);}
    get targetHeight(){return Math.exp(this.goal);}

    tick(now:number,stops:readonly number[]):number {
        if(!this.active)return this.height;
        const dt=Math.min(.1,Math.max(0,(now-this.tickTime)/1000));this.tickTime=now;
        this.goal=Math.log(nearestZoom(this.intentHeight,stops));
        const next=damp(this.position,this.goal,this.velocity,dt,ZOOM_DAMPING.snapFrequency);
        this.position=next.value;this.velocity=next.velocity;
        const clamped=Math.max(Math.log(this.min),Math.min(Math.log(this.max),this.position));
        if(clamped!==this.position){this.position=clamped;this.velocity=0;}
        if(Math.abs(this.position-this.goal)<1e-5&&Math.abs(this.velocity)<1e-4){this.position=this.goal;this.velocity=0;this.active=false;}
        return this.height;
    }
    snap(height:number,now:number,min:number,max:number,target=height){
        this.position=Math.log(Math.max(min,Math.min(max,height)));
        this.intent=this.goal=Math.log(Math.max(min,Math.min(max,target)));
        this.min=min;this.max=max;this.velocity=0;this.tickTime=now;
        this.active=true;this.snapping=true;
    }
    cancel(){this.active=false;this.snapping=false;this.velocity=0;}
}
