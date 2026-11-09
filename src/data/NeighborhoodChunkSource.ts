import {chunkIntersects,decodeNeighborhoodChunk,decodeNeighborhoodChunkIndex,decodeNeighborhoodChunkPage,NEIGHBORHOOD_CHUNK_LIMIT,type ChunkBounds,type NeighborhoodChunkIndex,type NeighborhoodChunkRef} from '@shared/neighborhoodChunks';
import type {FileRef,Manifest} from '@shared/httpPack';
/** Paged geometry transport, independent of parcel packs and whole-neighborhood layouts. */
export default class NeighborhoodChunkSource {
    private root?:Promise<NeighborhoodChunkIndex|undefined>;
    private pages=new Map<string,NeighborhoodChunkRef[]>();
    constructor(private manifest:()=>Promise<Manifest>,private small:(path:string,limit:number,signal?:AbortSignal)=>Promise<Uint8Array>,private file:(ref:FileRef,signal?:AbortSignal)=>Promise<Uint8Array>){}
    private index(){return this.root??=(async()=>{const manifest=await this.manifest();try{return await decodeNeighborhoodChunkIndex(await this.small('neighborhood-chunks.json',128*1024),manifest.snapshot);}catch(error){if((error as {status?:number}).status===404)return undefined;this.root=undefined;throw error;}})();}
    async refs(bounds:ChunkBounds,signal:AbortSignal){
        const index=await this.index();signal.throwIfAborted();if(!index)return undefined;
        const result:NeighborhoodChunkRef[]=[];
        // Preview patches are fixed owner-cell pieces. Query their whole cells,
        // including possible incoming bitmaps, so a later pan within a cell
        // cannot reveal a new dependency and revoke already certified coverage.
        const x=Math.floor(bounds.x/index.size)*index.size,y=Math.floor(bounds.y/index.size)*index.size;
        const coverage={x,y,width:Math.ceil((bounds.x+bounds.width)/index.size)*index.size-x,height:Math.ceil((bounds.y+bounds.height)/index.size)*index.size-y};
        // Sequential pages keep metadata requests/buffers bounded. Pages are tiny
        // and reused while panning; only two dozen decoded pages stay resident.
        for(const ref of index.pages){if(!chunkIntersects(ref,index.size*index.side,coverage,index.maxWidth,index.maxHeight))continue;
            let chunks=this.pages.get(ref.sha256);if(!chunks){chunks=decodeNeighborhoodChunkPage(await this.file(ref,signal),ref,index);this.pages.set(ref.sha256,chunks);while(this.pages.size>24)this.pages.delete(this.pages.keys().next().value!);}
            for(const c of chunks)if(chunkIntersects(c,index.size,coverage,index.maxWidth,index.maxHeight))result.push({...c,coverageBounds:{x:c.x*index.size,y:c.y*index.size,width:index.size+index.maxWidth,height:index.size+index.maxHeight}});
        }
        signal.throwIfAborted();return result.sort((a,b)=>(a.x*index.size-bounds.x-bounds.width/2)**2+(a.y*index.size-bounds.y-bounds.height/2)**2-(b.x*index.size-bounds.x-bounds.width/2)**2-(b.y*index.size-bounds.y-bounds.height/2)**2);
    }
    async load(ref:NeighborhoodChunkRef,signal:AbortSignal){const index=await this.index();if(!index)throw Error('Neighborhood chunks unavailable');const manifest=await this.manifest(),bytes=await this.file(ref,signal);signal.throwIfAborted();if(bytes.length>NEIGHBORHOOD_CHUNK_LIMIT)throw Error('Neighborhood chunk exceeds budget');return decodeNeighborhoodChunk(bytes,ref,index,manifest.publishedHeight);}
    close(){this.pages.clear();}
}
