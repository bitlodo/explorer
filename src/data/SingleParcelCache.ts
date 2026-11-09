/** Session-only proof cache: one byte for an already authenticated one-tx bitmap. */
export default class SingleParcelCache {
    private pages=new Map<number,Uint8Array>();
    readonly pageSize=65536;
    constructor(readonly capacity=16){}
    get(id:number){const index=Math.floor(id/this.pageSize),page=this.pages.get(index);if(!page)return 0;this.pages.delete(index);this.pages.set(index,page);return page[id%this.pageSize];}
    set(id:number,size:number){
        const index=Math.floor(id/this.pageSize);let page=this.pages.get(index);
        if(!page){page=new Uint8Array(this.pageSize);this.pages.set(index,page);if(this.pages.size>this.capacity)this.pages.delete(this.pages.keys().next().value!);}
        page[id%this.pageSize]=size;
    }
    get bytes(){return this.pages.size*this.pageSize;}
    clear(){this.pages.clear();}
}
