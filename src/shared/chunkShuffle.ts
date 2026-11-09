/** Serialized order only. Canonical block IDs and transaction order never change. */
export const CHUNK_SHUFFLE = 'chunk-fisher-yates-xorshift32-v1';
export const DEFAULT_SHUFFLE_SEED = 20261023;

export function chunkShuffleOrder(count:number,seed:number,x:number,y:number):Uint32Array {
    let state=(seed^Math.imul(x,0x9e3779b1)^Math.imul(y,0x85ebca6b))>>>0;
    state^=state>>>16;state=Math.imul(state,0x7feb352d);state^=state>>>15;
    state=Math.imul(state,0x846ca68b);state=(state^(state>>>16))>>>0;
    if(!state)state=0x6d2b79f5;
    const random=()=>{state^=state<<13;state^=state>>>17;state^=state<<5;return state>>>0;};
    const order=Uint32Array.from({length:count},(_,i)=>i);
    for(let i=count-1;i>0;i--){
        const bound=i+1,limit=0x100000000-(0x100000000%bound);
        let n;do{n=random();}while(n>=limit);
        const j=n%bound,value=order[i];order[i]=order[j];order[j]=value;
    }
    return order;
}
