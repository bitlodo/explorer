import type {BufferAttribute} from 'three';

/** Keep every write pending until the renderer uploads the attribute. */
export function queueAttributeUpdateRange(attribute:BufferAttribute,start:number,count:number){
    let first=start,end=start+count;
    for(const range of attribute.updateRanges){first=Math.min(first,range.start);end=Math.max(end,range.start+range.count);}
    // One merged span bounds the queue even through many hidden frames.
    attribute.clearUpdateRanges();
    attribute.addUpdateRange(first,end-first);
}
