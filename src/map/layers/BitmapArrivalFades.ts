import * as THREE from 'three';
import {BITMAP_ARRIVAL_ATLAS_FORMAT,BITMAP_ARRIVAL_TOTAL_SECONDS,parcelArrivalOpacity,bitmapBaseOpacity,bitmapArrivalProgress} from '@shared/bitmapArrival';
export {BITMAP_ARRIVAL_FADE_SECONDS} from '@shared/bitmapArrival';

/** One byte per block, shared by the bitmap base and both parcel renderers.
 * Arrival fades run once per resident bitmap. Visibility only gates the result;
 * panning away/back never replays arrival. Settled frames upload nothing.
 */
export default class BitmapArrivalFades {
    readonly formatVersion=BITMAP_ARRIVAL_ATLAS_FORMAT;
    readonly texture:THREE.DataTexture;
    readonly size=new THREE.Vector2(1,1);
    private pixels=new Uint8Array(1);
    private arrivals=new Uint8Array(1);
    private active=new Map<number,number>();
    private regions=new Map<number,{ids:Set<number>;gain:number}>();
    private wanted=new Set<number>();
    private lastTime?:number;
    private dirty=false;
    private closed=false;
    constructor(count:number,private maxSize=4096){
        this.texture=new THREE.DataTexture(this.pixels,1,1,THREE.RedFormat,THREE.UnsignedByteType);
        this.texture.minFilter=this.texture.magFilter=THREE.NearestFilter;this.texture.generateMipmaps=false;
        this.ensureCount(count);
    }
    ensureCount(count:number){
        if(count<=this.pixels.length)return;
        const width=Math.min(2048,this.maxSize),height=2**Math.ceil(Math.log2(Math.ceil(count/width)));
        if(height>this.maxSize)throw Error('Bitmap fade atlas exceeds GPU texture limit');
        const pixels=new Uint8Array(width*height),arrivals=new Uint8Array(width*height);pixels.set(this.pixels);arrivals.set(this.arrivals);
        this.pixels=pixels;this.arrivals=arrivals;this.size.set(width,height);
        // Preserve the texture object used by shader uniforms, reallocating its storage.
        this.texture.dispose();this.texture.image={data:pixels,width,height};this.dirty=true;
    }
    bind(uniforms:Record<string,THREE.IUniform>,first=0){
        uniforms.arrivalMap={value:this.texture};uniforms.arrivalMapSize={value:this.size};uniforms.arrivalEnabled={value:1};uniforms.arrivalBitmapBase={value:first};
    }
    begin(id:number){
        if(this.closed||id<0||id>=this.pixels.length||this.active.has(id)||this.arrivals[id])return;
        const region=Math.floor(id/2016);let group=this.regions.get(region);
        if(!group){group={ids:new Set(),gain:0};this.regions.set(region,group);}
        group.ids.add(id);this.active.set(id,0);
    }
    setVisibleNeighborhoods(ids:Iterable<number>){this.wanted=new Set(ids);}
    regionGain(id:number){return this.regions.get(id)?.gain||0;}
    opacityFor(id:number){return parcelArrivalOpacity((this.pixels[id]||0)/255);}
    baseOpacityFor(id:number){return bitmapBaseOpacity((this.pixels[id]||0)/255);}
    get activeCount(){return this.active.size;}
    update(now:number){
        if(this.closed)return;
        const dt=this.lastTime===undefined?0:Math.max(0,Math.min(.05,(now-this.lastTime)/1000));this.lastTime=now;
        const write=(id:number,gain:number)=>{const alpha=Math.round(this.arrivals[id]*gain);if(this.pixels[id]!==alpha){this.pixels[id]=alpha;this.dirty=true;}};
        for(const [region,group] of this.regions){const next=this.wanted.has(region)?1:0;
            if(next!==group.gain){group.gain=next;for(const id of group.ids)write(id,next);}}
        for(const [id,previous] of this.active){const elapsed=Math.min(BITMAP_ARRIVAL_TOTAL_SECONDS,previous+dt);this.arrivals[id]=Math.round(255*bitmapArrivalProgress(elapsed));write(id,this.regionGain(Math.floor(id/2016)));if(elapsed===BITMAP_ARRIVAL_TOTAL_SECONDS)this.active.delete(id);else this.active.set(id,elapsed);}
        if(this.dirty){this.texture.needsUpdate=true;this.dirty=false;}
    }
    resetNeighborhood(region:number){
        const group=this.regions.get(region);if(!group)return;
        for(const id of group.ids){this.active.delete(id);this.arrivals[id]=0;if(this.pixels[id]){this.pixels[id]=0;this.dirty=true;}}
        this.regions.delete(region);
        if(this.dirty){this.texture.needsUpdate=true;this.dirty=false;}
    }
    dispose(){if(this.closed)return;this.closed=true;this.texture.dispose();this.active.clear();this.regions.clear();this.wanted.clear();}
}
