import {check,integer} from './httpPack';

/** Incremental length-delimited protobuf messages, without an async read per byte. */
export default class DelimitedQueue {
    private pieces:Uint8Array[]=[];
    private index=0;
    private offset=0;
    private tail?:Uint8Array;
    private tailUsed=0;
    length=0;
    append(bytes:Uint8Array){
        if(!bytes.length)return;
        this.length+=bytes.length;
        if(bytes.length<1024&&(this.tail||this.pieces.length-this.index>=64)){
            if(!this.tail||this.tail.length-this.tailUsed<bytes.length){this.tail=new Uint8Array(4096);this.tailUsed=0;this.pieces.push(this.tail.subarray(0,0));}
            this.tail.set(bytes,this.tailUsed);this.tailUsed+=bytes.length;this.pieces[this.pieces.length-1]=this.tail.subarray(0,this.tailUsed);
        }else{this.tail=undefined;this.pieces.push(bytes);}
    }
    next(limit:number):Uint8Array|undefined {
        let size=0,factor=1,prefix=0,piece=this.index,offset=this.offset;
        while(prefix<5){
            if(prefix>=this.length)return;
            while(offset===this.pieces[piece].length){piece++;offset=0;}
            const b=this.pieces[piece][offset++];size+=(b&127)*factor;prefix++;
            if(!(b&128)){
                check(integer(size,1,limit),'Invalid protobuf message length');
                if(this.length<prefix+size)return;
                return this.take(prefix+size);
            }
            factor*=128;
        }
        throw Error('Invalid protobuf length varint');
    }
    private take(size:number){
        const first=this.pieces[this.index];let result:Uint8Array;
        if(first.length-this.offset>=size){result=first.subarray(this.offset,this.offset+size);this.offset+=size;}
        else{
            result=new Uint8Array(size);let copied=0;
            while(copied<size){const p=this.pieces[this.index],n=Math.min(p.length-this.offset,size-copied);result.set(p.subarray(this.offset,this.offset+n),copied);copied+=n;this.offset+=n;if(this.offset===p.length){this.index++;this.offset=0;}}
        }
        this.length-=size;
        if(this.index<this.pieces.length&&this.offset===this.pieces[this.index].length){this.index++;this.offset=0;}
        if(!this.length){this.pieces=[];this.index=0;this.offset=0;this.tail=undefined;}
        else if(this.index>128){this.pieces=this.pieces.slice(this.index);this.index=0;}
        return result;
    }
}
