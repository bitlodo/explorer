import protobuf from 'protobufjs';
import { chunkShuffleOrder } from '../src/shared/chunkShuffle';
import { decodeSizes, encodeSizes, encodeAdaptiveSizes,check, type ParcelRecord } from '../src/shared/httpPack';
import { createProtoCodec } from '../src/shared/protobufChunks';
const codec=createProtoCodec(protobuf);
export const PARCEL_SEGMENT_POLICY='cell-neighborhood-shuffle-v1';
/** Fixed cell × 2016-block bands. Append size never changes historical boundaries. */
export async function buildParcelSegments(records:ParcelRecord[],x:number,y:number,seed:number,frameBytes:number,target:number){
    const bands=new Map<number,ParcelRecord[]>();
    for(const input of [...records].sort((a,b)=>a.id-b.id)){
        const record=encodeSizes(input.id,decodeSizes(input)),band=Math.floor(record.id/2016);
        if(!bands.has(band))bands.set(band,[]);bands.get(band)!.push(record);
    }
    const result:Awaited<ReturnType<typeof codec.buildChainedPack>>[]=[];
    for(const rows of bands.values()){
        let batch:ParcelRecord[]=[],logical=64;
        const flush=async()=>{
            if(!batch.length)return;
            const built=await codec.buildChainedPack(batch.map(r=>encodeAdaptiveSizes(r.id,decodeSizes(r))),x,y,frameBytes,9),ref={...built.descriptor,url:built.descriptor.sha256+'.pb'};
            async function* input(){yield built.wire;}
            let index=0;
            for await(const record of codec.parsePack(input(),ref)){
                const original=batch[index++],expected=decodeSizes(original),actual=decodeSizes(record);
                check(record.id===original.id&&record.txCount===original.txCount&&actual.length===expected.length&&actual.every((v,i)=>v===expected[i]),'Parcel segment round-trip differs');
            }
            check(index===batch.length,'Parcel segment coverage differs');result.push(built);batch=[];logical=64;
        };
        for(const i of chunkShuffleOrder(rows.length,seed,x,y)){
            const row=rows[i],length=codec.encodeRecord(row).length,cost=length+64*Math.ceil(length/frameBytes);
            if(batch.length&&(logical+cost>target||batch.length===65536))await flush();
            batch.push(row);logical+=cost;
        }
        await flush();
    }
    return result;
}
