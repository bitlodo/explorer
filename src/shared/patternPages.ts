import protobuf from 'protobufjs';
import {check,integer} from './httpPack';
const type=protobuf.Root.fromJSON({nested:{Patterns:{fields:{version:{type:'uint32',id:1},bucket:{type:'uint32',id:2},patterns:{rule:'repeated',type:'uint32',id:3,options:{packed:true}},offsets:{rule:'repeated',type:'uint32',id:4,options:{packed:true}},deltas:{rule:'repeated',type:'uint32',id:5,options:{packed:true}}}}}}).lookupType('Patterns');
export function encodePatternPage(bucket:number,entries:Map<number,number[]>){
    const patterns:number[]=[],offsets=[0],deltas:number[]=[];
    for(const [pattern,ids] of [...entries].sort((a,b)=>a[0]-b[0])){patterns.push(pattern);ids.forEach((id,i)=>deltas.push(i?id-ids[i-1]:id));offsets.push(deltas.length);}
    return type.encode({version:1,bucket,patterns,offsets,deltas}).finish();
}
export function decodePatternPage(bytes:Uint8Array,bucket:number,count:number){
    check(bytes.length<=count*5+16384,'Pattern page exceeds budget');const r=type.toObject(type.decode(bytes),{arrays:true,defaults:true});
    check(r.version===1&&r.bucket===bucket&&r.patterns.length<=1024&&r.offsets.length===r.patterns.length+1&&r.offsets[0]===0&&r.offsets.at(-1)===r.deltas.length,'Invalid pattern page');
    const result=new Map<number,number[]>();let previous=-1;
    for(let i=0;i<r.patterns.length;i++){
        const pattern=r.patterns[i];check(integer(pattern,previous+1,count-1)&&Math.floor(pattern/1024)===bucket,'Invalid pattern page owner');previous=pattern;
        const start=r.offsets[i],end=r.offsets[i+1];check(integer(end,start+1,r.deltas.length),'Invalid pattern offsets');
        const ids:number[]=[];let id=0;
        for(let j=start;j<end;j++){const delta=r.deltas[j];check(integer(delta,j===start?0:1,count-1),'Invalid pattern delta');id+=delta;check(id<count&&id>=pattern,'Invalid pattern member');ids.push(id);}
        check(ids[0]===pattern,'Missing canonical pattern');result.set(pattern,ids);
    }
    return result;
}
