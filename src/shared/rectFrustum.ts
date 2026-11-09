type Point={x:number;y:number};
type Rect={x:number;y:number;width:number;height:number};

/** Convex projected viewport vs axis-aligned rectangles; no allocations per test. */
export class RectFrustum {
    readonly bounds:Rect;
    private readonly edges:Float64Array;
    constructor(points:readonly Point[]){
        const left=Math.min(...points.map(p=>p.x)),top=Math.min(...points.map(p=>p.y));
        this.bounds={x:left,y:top,width:Math.max(...points.map(p=>p.x))-left,height:Math.max(...points.map(p=>p.y))-top};
        let area=0;for(let i=0;i<points.length;i++){const p=points[i],q=points[(i+1)%points.length];area+=p.x*q.y-q.x*p.y;}
        const sign=area>=0?1:-1;this.edges=new Float64Array(points.length*3);
        for(let i=0;i<points.length;i++){const p=points[i],q=points[(i+1)%points.length],nx=(q.y-p.y)*sign,ny=(p.x-q.x)*sign;
            this.edges.set([nx,ny,nx*p.x+ny*p.y],i*3);}
    }
    intersects(rect:Rect,offsetX=0,offsetY=0):boolean {
        const x=rect.x+offsetX,y=rect.y+offsetY,right=x+rect.width,bottom=y+rect.height,b=this.bounds;
        if(x>b.x+b.width||right<b.x||y>b.y+b.height||bottom<b.y)return false;
        for(let i=0;i<this.edges.length;i+=3){const nx=this.edges[i],ny=this.edges[i+1];
            if(nx*(nx>=0?x:right)+ny*(ny>=0?y:bottom)>this.edges[i+2])return false;}
        return true;
    }
    contains(rect:Rect,offsetX=0,offsetY=0):boolean {
        const x=rect.x+offsetX,y=rect.y+offsetY,right=x+rect.width,bottom=y+rect.height;
        for(let i=0;i<this.edges.length;i+=3){const nx=this.edges[i],ny=this.edges[i+1];
            if(nx*(nx>=0?right:x)+ny*(ny>=0?bottom:y)>this.edges[i+2])return false;}
        return true;
    }
}

/** Visit every item once, retaining spatial round-robin order for unequal queues. */
export function interleaveSpatial<T>(queues:readonly (readonly T[])[]):T[]{
    const result:T[]=[],cursors=new Uint32Array(queues.length);let active=queues.map((_,i)=>i).filter(i=>queues[i].length);
    while(active.length){const next:number[]=[];for(const i of active){result.push(queues[i][cursors[i]++]);if(cursors[i]<queues[i].length)next.push(i);}active=next;}
    return result;
}
