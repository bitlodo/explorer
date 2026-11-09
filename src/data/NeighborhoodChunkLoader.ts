import RetryPolicy from './RetryPolicy';
import type {ChunkBounds,NeighborhoodChunk,NeighborhoodChunkRef} from '@shared/neighborhoodChunks';
import type {MapDataSource} from './MapDataSource';
import type NeighborhoodGeometryLayer from '@/map/layers/NeighborhoodGeometryLayer';
/** Four geometry downloads at a time; obsolete work is cancelled on pan/zoom. */
export default class NeighborhoodChunkLoader {
    mode:boolean|undefined;
    private closed=false;
    private retry=new RetryPolicy();
    private signature='';
    private queried='';
    private query?:AbortController;
    private wanted=new Map<string,NeighborhoodChunkRef>();
    private active=new Map<string,AbortController>();
    constructor(private source:MapDataSource,private layer:NeighborhoodGeometryLayer,private changed:()=>void,private loaded:(chunk:NeighborhoodChunk)=>void,private error:(error:unknown)=>void){if(!source.getNeighborhoodChunkRefs||!source.getNeighborhoodChunk)this.mode=false;}
    private queryBounds(bounds:ChunkBounds){
        // Align outward so tiny camera/OrbitControls changes reuse a covering
        // query instead of repeatedly cancelling the same geometry downloads.
        const step=128,x=Math.floor(bounds.x/step)*step,y=Math.floor(bounds.y/step)*step;
        return{x,y,width:Math.ceil((bounds.x+bounds.width)/step)*step-x,height:Math.ceil((bounds.y+bounds.height)/step)*step-y};
    }
    private key(bounds:ChunkBounds){const b=this.queryBounds(bounds);return`${b.x},${b.y},${b.width},${b.height}`;}
    ready(bounds:ChunkBounds){return this.mode===true&&this.queried===this.key(bounds)&&this.wanted.size<=this.layer.chunkCapacity&&[...this.wanted.keys()].every(key=>this.layer.hasChunk(key));}
    update(bounds?:ChunkBounds){
        if(this.closed||this.mode===false)return;
        const signature=bounds?this.key(bounds):'';
        if(signature!==this.signature&&this.retry.ready('query:'+signature)){
            this.signature=signature;this.queried='';this.query?.abort();this.query=undefined;
            if(!bounds){
                this.wanted.clear();this.layer.setWantedChunks([]);for(const c of this.active.values())c.abort();this.active.clear();
            }
            if(bounds){const controller=new AbortController();this.query=controller;
                void this.source.getNeighborhoodChunkRefs!(this.queryBounds(bounds),controller.signal).then(refs=>{
                    if(this.closed||controller.signal.aborted)return;this.retry.success('query:'+signature);this.mode=refs!==undefined;this.queried=signature;
                    this.wanted=new Map((refs||[]).map(ref=>[`${ref.x},${ref.y}`,ref]));
                    // Keep shared downloads and resident coverage while resolving
                    // the new view. Cancel only work proven outside that view.
                    for(const [key,c] of this.active)if(!this.wanted.has(key)){c.abort();this.active.delete(key);}
                    const extents=new Map((refs||[]).filter(ref=>ref.coverageBounds).map(ref=>[`${ref.x},${ref.y}`,ref.coverageBounds!]));
                    this.layer.setWantedChunks(this.wanted.keys(),this.queryBounds(bounds),extents);this.pump();this.changed();
                }).catch(error=>{if(!controller.signal.aborted&&!this.closed){this.retry.fail('query:'+signature,error);this.signature='';this.error(error);}});
            }
        }
        this.pump();
    }
    private pump(){
        if(this.closed||this.mode!==true)return;
        for(const [key,ref] of this.wanted){
            if(this.active.size>=4)break;if(this.layer.hasChunk(key)||this.active.has(key)||!this.retry.ready(key))continue;
            const controller=new AbortController();this.active.set(key,controller);let progressed=false;
            void this.source.getNeighborhoodChunk!(ref,controller.signal).then(chunk=>{
                if(this.closed||controller.signal.aborted||!this.wanted.has(key))return;
                this.retry.success(key);if(this.layer.addChunk(chunk)){progressed=true;this.loaded(chunk);}
            }).catch(error=>{if(!controller.signal.aborted&&!this.closed){this.retry.fail(key,error);this.error(error);}}).finally(()=>{if(this.active.get(key)===controller)this.active.delete(key);if(!this.closed){this.changed();if(progressed)this.pump();}});
        }
    }
    close(){this.closed=true;this.query?.abort();for(const c of this.active.values())c.abort();this.active.clear();this.wanted.clear();}
}
