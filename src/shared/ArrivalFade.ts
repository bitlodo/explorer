/** Arrival time advances independently of camera/visibility and never restarts on pan. */
export const GEOMETRY_ARRIVAL_SECONDS=.6;
export const GEOMETRY_PREVIEW_EXIT_SECONDS=.3;
export class ArrivalFade {
    private elapsed=0;
    private previous?:number;
    opacity=0;
    constructor(private readonly seconds=GEOMETRY_ARRIVAL_SECONDS){
        if(!Number.isFinite(seconds)||seconds<=0)throw Error('Invalid geometry fade duration.');
    }
    update(now:number){
        if(this.opacity===1)return;
        if(this.previous!==undefined)this.elapsed+=Math.max(0,Math.min(.05,(now-this.previous)/1000));
        this.previous=now;
        const t=Math.min(1,this.elapsed/this.seconds);
        this.opacity=t*t*(3-2*t);
    }
}
