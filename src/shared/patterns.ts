import protobuf from 'protobufjs';
import {check,integer} from './httpPack';

export const PATTERN_COLOR_POLICY='pattern-chronology-loop-v2';
export const PATTERN_CYCLE=200*2016;
export const PATTERN_COLORS=['#396b72','#4e8585','#81a49a','#b9c3a6','#d4c3a1','#b2a78f','#7e9690','#527b7e','#396b72'] as const;
export const patternScore=(height:number)=>1+8*(height%PATTERN_CYCLE)/PATTERN_CYCLE;
export type PatternEntry={id:number;transactions:number;occurrences:number};
export type PatternGroup={transactions:number;patterns:number;bitmaps:number};
export type PatternPreview={id:number;width:number;height:number;rects:Float64Array};
export type PatternInputs={snapshot:string;count:number;patternBytes:Uint8Array;countBytes:Uint8Array};
export type PatternFilter={scores:Float32Array;summaries:Float32Array;matches:number};
const reference=protobuf.Root.fromJSON({nested:{Reference:{fields:{version:{type:'uint32',id:1},sourceSnapshot:{type:'string',id:2},patterns:{rule:'repeated',type:'uint32',id:3,options:{packed:true}}}}}}).lookupType('Reference');
export function decodePatternReference(bytes:Uint8Array,snapshot:string,count:number):Uint32Array{
    check(integer(count,1,1048576)&&bytes.length<=count*5+1024,'Pattern reference exceeds budget');
    const r=reference.toObject(reference.decode(bytes),{arrays:true,defaults:true});
    check(r.version===1&&r.sourceSnapshot===snapshot&&r.patterns.length===count,'Pattern reference snapshot mismatch');
    const patterns=Uint32Array.from(r.patterns);
    for(let id=0;id<count;id++)check(integer(r.patterns[id],0,id)&&patterns[patterns[id]]===patterns[id],'Invalid canonical pattern');
    return patterns;
}
export function catalogPatterns(patterns:Uint32Array,counts:Float32Array){
    check(patterns.length===counts.length,'Pattern count coverage mismatch');
    const frequencies=new Uint32Array(patterns.length),totals=new Map<number,number>();
    for(let id=0;id<patterns.length;id++){
        check(integer(counts[id],1,262144)&&patterns[id]<=id&&patterns[patterns[id]]===patterns[id]&&counts[id]===counts[patterns[id]],'Invalid pattern transaction count');
        frequencies[patterns[id]]++;totals.set(counts[id],(totals.get(counts[id])??0)+1);
    }
    const entries:PatternEntry[]=[],groups=new Map<number,PatternGroup>();
    for(let id=0;id<patterns.length;id++)if(frequencies[id]>1){
        const transactions=counts[id];entries.push({id,transactions,occurrences:frequencies[id]});
        const group=groups.get(transactions)??{transactions,patterns:0,bitmaps:totals.get(transactions)!};group.patterns++;groups.set(transactions,group);
    }
    entries.sort((a,b)=>a.transactions-b.transactions||a.id-b.id);
    return {entries,groups:[...groups.values()].sort((a,b)=>a.transactions-b.transactions)};
}
/** Filtering changes membership only; selected scores are always the original chronology. */
export function filterPatterns(patterns:Uint32Array,counts:Float32Array,transactions?:number,pattern?:number):PatternFilter{
    check(patterns.length===counts.length&&(transactions===undefined||integer(transactions,1,262144)),'Invalid pattern filter');
    check(pattern===undefined||integer(pattern,0,patterns.length-1)&&patterns[pattern]===pattern,'Invalid pattern selection');
    const scores=new Float32Array(Math.ceil(patterns.length/1024)*1024).fill(-1),summaries=new Float32Array(Math.ceil(patterns.length/2016)*2);
    let matches=0;
    for(let region=0;region<summaries.length/2;region++){
        const first=region*2016,end=Math.min(first+2016,patterns.length);let selected=0,sum=0;
        for(let id=first;id<end;id++){
            const score=Math.fround(patternScore(id));sum+=score;
            if((transactions===undefined||counts[id]===transactions)&&(pattern===undefined||patterns[id]===pattern)){scores[id]=score;selected++;}
        }
        summaries[region*2]=sum/(end-first);
        summaries[region*2+1]=selected?1:0;matches+=selected;
    }
    return {scores,summaries,matches};
}
