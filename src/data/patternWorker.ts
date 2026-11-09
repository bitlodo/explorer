import {decodeMetric} from '../shared/mapAnalytics';
import {decodePatternReference,catalogPatterns,filterPatterns,patternScore,type PatternInputs} from '../shared/patterns';
import {decodeParcelSizes,type ParcelRecord} from '../shared/httpPack';
import MondrianLayout from '../shared/MondrianLayout';
let patterns:Uint32Array,counts:Float32Array;
type Message={id:number}&({kind:'init';inputs:PatternInputs}|{kind:'filter';transactions?:number;pattern?:number}|{kind:'preview';record:ParcelRecord});
self.onmessage=(event:MessageEvent<Message>)=>{
    const message=event.data;
    try{
        if(message.kind==='init'){
            const {inputs}=message;patterns=decodePatternReference(inputs.patternBytes,inputs.snapshot,inputs.count);counts=decodeMetric(inputs.countBytes,inputs.count);
            const catalog=catalogPatterns(patterns,counts),values=Float32Array.from({length:inputs.count},(_,id)=>patternScore(id));
            self.postMessage({id:message.id,value:{...catalog,values}}, {transfer:[values.buffer]});
        }else if(message.kind==='filter'){
            const value=filterPatterns(patterns,counts,message.transactions,message.pattern);
            self.postMessage({id:message.id,value},{transfer:[value.scores.buffer,value.summaries.buffer]});
        }else{
            const layout=new MondrianLayout(decodeParcelSizes(message.record)),rects=new Float64Array(layout.slots.length*4);
            let width=0,height=0;layout.slots.forEach((r,i)=>{rects.set([r.x,r.y,r.width,r.height],i*4);width=Math.max(width,r.x+r.width);height=Math.max(height,r.y+r.height);});
            self.postMessage({id:message.id,value:{id:message.record.id,width,height,rects}},{transfer:[rects.buffer]});
        }
    }catch(error){self.postMessage({id:message.id,error:error instanceof Error?error.message:String(error)});}
};
