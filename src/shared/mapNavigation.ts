import type {NeighborhoodRect} from './NeighborhoodLayout';

// Half of each smaller dimension gives at least a quarter of its rectangle.
export const MAP_MIN_VISIBLE_AXIS = .5;
type Center = {x:number;y:number};
type Viewport = {width:number;height:number};
type Range = {left:number;right:number;top:number;bottom:number};

function centerRange(rect:NeighborhoodRect,view:Viewport):Range {
    const overlapX=Math.min(rect.width,view.width)*MAP_MIN_VISIBLE_AXIS;
    const overlapY=Math.min(rect.height,view.height)*MAP_MIN_VISIBLE_AXIS;
    return {
        left:rect.x+overlapX-view.width/2,
        right:rect.x+rect.width-overlapX+view.width/2,
        top:rect.y+overlapY-view.height/2,
        bottom:rect.y+rect.height-overlapY+view.height/2,
    };
}

/** Clamp only to the occupied outer bounds, leaving internal gaps traversable.
 * Debug tiles and the symmetric layout frame are deliberately excluded. Limits
 * only expand on zoom-out, so a valid center never moves when retreating.
 */
export function constrainMapCenter(center:Center,view:Viewport,bounds:NeighborhoodRect):Center {
    if(view.width<=0||view.height<=0||bounds.width<=0||bounds.height<=0)return center;
    const outer=centerRange(bounds,view);
    const x=Math.max(outer.left,Math.min(outer.right,center.x));
    const y=Math.max(outer.top,Math.min(outer.bottom,center.y));
    return x===center.x&&y===center.y?center:{x,y};
}
