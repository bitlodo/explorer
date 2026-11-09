import type {ParcelRecord} from '../shared/httpPack';
/** Verified small records only, bounded by both payload bytes and entry count. */
export default class SmallRecordCache {
    private records=new Map<number,ParcelRecord>();
    bytes=0;
    get(id:number){const record=this.records.get(id);if(record){this.records.delete(id);this.records.set(id,record);}return record;}
    set(record:ParcelRecord){
        if(record.tx.length>4096)return;
        const old=this.records.get(record.id);if(old)this.bytes-=old.tx.length+32;
        this.records.delete(record.id);this.records.set(record.id,{...record,tx:record.tx.slice()});this.bytes+=record.tx.length+32;
        while(this.bytes>4*1024*1024||this.records.size>4096){const [id,value]=this.records.entries().next().value!;this.records.delete(id);this.bytes-=value.tx.length+32;}
    }
    clear(){this.records.clear();this.bytes=0;}
}
