import { decodeParcelClasses, parcelClassFilter } from '../shared/layerAnalysis';
let counts:Uint32Array|undefined,count=0;
self.onmessage=(event:MessageEvent<{id:number;bytes?:Uint8Array;count:number;low:number;high:number}>)=>{
    const request=event.data;
    try{
        if(request.bytes){count=request.count;counts=decodeParcelClasses(request.bytes,count);}
        if(!counts)throw Error('Parcel analysis is not initialized');
        const result=parcelClassFilter(counts,count,request.low,request.high,!!request.bytes);
        const transfer:Transferable[]=[result.pixels.buffer];if(result.occupiedAreas)transfer.push(result.occupiedAreas.buffer);
        self.postMessage({id:request.id,result},{transfer});
    }catch(error){self.postMessage({id:request.id,error:error instanceof Error?error.message:String(error)});}
};
