/** Bounded content cache: complete packs, authenticated prefixes and legacy frames. */
export default class PackCache {
    private db?: IDBDatabase;
    private memory = new Map<string, Uint8Array>();
    private memoryBytes = 0;
    private closed = false;
    private cleanupRunning?:Promise<void>;
    private static cleanupQueue: Promise<void> = Promise.resolve();
    private static budgets = new Map<string, number>();
    private touches = new Map<string, number>();
    private touchTimer?: ReturnType<typeof setTimeout>;
    /** All namespaces share at most 1 GiB, or 20% of the browser quota. */
    static readonly diskBudget = 1024 * 1024 * 1024;
    readonly ready: Promise<void>;
    constructor(private memoryLimit = 16 * 1024 * 1024, private diskLimit = 256 * 1024 * 1024, readonly namespace = 'http-pack-cache-v1') {
        PackCache.budgets.set(namespace, diskLimit);
        this.ready = this.open().catch(error => console.warn('Pack disk cache unavailable; using bounded memory.', error));
    }
    private async open() {
        if (typeof indexedDB === 'undefined') return;
        await new Promise<void>((resolve, reject) => {
            const request = indexedDB.open('bitmapExplorerPacks', 1);
            request.onupgradeneeded = () => {
                const store=request.result.objectStoreNames.contains('content')?request.transaction!.objectStore('content'):request.result.createObjectStore('content',{keyPath:'key'});
                if(!store.indexNames.contains('time'))store.createIndex('time','time');
            };
            request.onerror = () => reject(request.error);
            request.onblocked = () => reject(new Error('Pack cache upgrade blocked'));
            request.onsuccess = () => {
                if (this.closed) request.result.close();
                else { this.db = request.result; this.db.onversionchange = () => { this.db?.close(); this.db = undefined; }; }
                resolve();
            };
        });
    }
    private remember(key: string, bytes: Uint8Array) {
        const old = this.memory.get(key); if (old) this.memoryBytes -= old.length;
        this.memory.delete(key);
        if (bytes.length <= this.memoryLimit) { this.memory.set(key, bytes); this.memoryBytes += bytes.length; }
        while (this.memoryBytes > this.memoryLimit) { const key = this.memory.keys().next().value!; this.memoryBytes -= this.memory.get(key)!.length; this.memory.delete(key); }
    }
    peek(hash:string){return this.memory.get(this.namespace+':'+hash);}
    async get(hash: string): Promise<Uint8Array | undefined> {
        if (this.closed) return;
        const key = this.namespace + ':' + hash, value = this.memory.get(key);
        if (value) { this.touch(key); this.memory.delete(key); this.memory.set(key, value); return value; }
        await this.ready; if (!this.db) return;
        try {
            const result = await new Promise<Uint8Array | undefined>((resolve, reject) => {
                const tx = this.db!.transaction('content', 'readonly'), request = tx.objectStore('content').get(key);
                let bytes: Uint8Array | undefined;
                request.onsuccess = () => { bytes = request.result?.bytes; };
                tx.oncomplete = () => resolve(bytes); tx.onabort = tx.onerror = () => reject(tx.error);
            });
            if (result && !this.closed) { this.remember(key, result); this.touch(key); } return result;
        } catch { return undefined; }
    }
    async putMany(entries: { hash: string; bytes: Uint8Array }[]): Promise<boolean> {
        if (this.closed) return false;
        for (const entry of entries) this.remember(this.namespace + ':' + entry.hash, entry.bytes);
        await this.ready; if (!this.db || this.closed) return false;
        try {
            await new Promise<void>((resolve, reject) => {
                const tx = this.db!.transaction('content', 'readwrite');
                for (const { hash, bytes } of entries) tx.objectStore('content').put({ key: this.namespace + ':' + hash, namespace: this.namespace, budget: this.diskLimit, bytes, size: bytes.length, time: Date.now() });
                tx.oncomplete = () => resolve(); tx.onabort = tx.onerror = () => reject(tx.error || new Error('Cache transaction failed'));
            });
            this.startCleanup();
            return true;
        } catch (error) {
            console.warn('Pack cache write failed; continuing with bounded memory.', error);
            this.startCleanup(true); return false;
        }
    }
    private touch(key: string) {
        this.touches.set(key, Date.now());
        if (!this.touchTimer) this.touchTimer = setTimeout(() => { this.touchTimer = undefined; void this.flushTouches(); }, 1000);
    }
    private async flushTouches() {
        const touches = this.touches; this.touches = new Map();
        if (!this.db || this.closed || !touches.size) return;
        await new Promise<void>(resolve => {
            const tx = this.db!.transaction('content', 'readwrite'), store = tx.objectStore('content');
            for (const [key, time] of touches) {
                const request = store.get(key);
                request.onsuccess = () => { if (request.result) store.put({ ...request.result, time: Math.max(time, request.result.time) }); };
            }
            tx.oncomplete = tx.onabort = tx.onerror = () => resolve();
        });
    }
    private startCleanup(pressure = false) {
        if (this.cleanupRunning || this.closed) return;
        const work = PackCache.cleanupQueue.then(() => this.cleanup(pressure));
        PackCache.cleanupQueue = work.catch(() => {});
        this.cleanupRunning = work.catch(() => {}).finally(() => { this.cleanupRunning = undefined; });
    }
    /** Public so maintenance/tests can wait for an actual disk quota pass. */
    async compact() { await this.ready; this.startCleanup(); await this.cleanupRunning; }
    private async cleanup(pressure = false) {
        if (!this.db || this.closed) return;
        await this.flushTouches();
        const quota = await globalThis.navigator?.storage?.estimate?.().catch(() => undefined);
        const aggregate = Math.min(PackCache.diskBudget, quota?.quota ? Math.floor(quota.quota * .2) : PackCache.diskBudget);
        // Persisted budgets include inactive namespaces. Old v1 entries keep their
        // namespace, so opening a small cache never applies its quota to all packs.
        const budgets = new Map(PackCache.budgets);
        let policyAfter:IDBValidKey|undefined,policiesDone=false;
        while(!policiesDone&&!this.closed&&this.db){
            await new Promise<void>((resolve,reject)=>{
                const tx=this.db!.transaction('content','readonly'),cursor=tx.objectStore('content').openCursor(policyAfter===undefined?null:IDBKeyRange.lowerBound(policyAfter,true));let count=0,bytes=0;
                cursor.onsuccess=()=>{const row=cursor.result;if(!row){policiesDone=true;return;}
                    const value=row.value,namespace=value.namespace??String(value.key).slice(0,String(value.key).indexOf(':'));
                    if(!budgets.has(namespace))budgets.set(namespace,value.budget??256*1024*1024);
                    policyAfter=row.primaryKey;bytes+=value.size;if(++count<128&&bytes<1024*1024)row.continue();
                };
                tx.oncomplete=()=>resolve();tx.onabort=tx.onerror=()=>reject(tx.error);
            });
            if(!policiesDone)await new Promise(resolve=>setTimeout(resolve,16));
        }
        const total = [...budgets.values()].reduce((a, b) => a + b, 0), factor = Math.min(1, aggregate / Math.max(1, total));
        const used = new Map<string, number>();
        let after:{time:IDBValidKey;key:IDBValidKey}|undefined,finished=false;
        while(!finished&&!this.closed&&this.db){
            await new Promise<void>((resolve,reject)=>{
                const tx=this.db!.transaction('content','readwrite'),cursor=tx.objectStore('content').index('time').openCursor(after===undefined?null:IDBKeyRange.upperBound(after.time),'prev');let count=0,bytes=0;
                cursor.onsuccess=()=>{const row=cursor.result;if(!row){finished=true;return;}
                    if(after&&indexedDB.cmp(row.key,after.time)===0&&indexedDB.cmp(row.primaryKey,after.key)>=0){if(indexedDB.cmp(row.primaryKey,after.key)>0)row.continuePrimaryKey(after.time,after.key);else row.continue();return;}
                    const value=row.value,namespace=value.namespace??String(value.key).slice(0,String(value.key).indexOf(':'));
                    const size=(used.get(namespace)??0)+value.size;
                    const limit=(budgets.get(namespace)??0)*factor*(pressure&&namespace===this.namespace ? .5 : 1);
                    if(size>limit)row.delete();else used.set(namespace,size);
                    after={time:row.key,key:row.primaryKey};bytes+=value.size;if(++count<128&&bytes<1024*1024)row.continue();
                };
                tx.oncomplete=()=>resolve();tx.onabort=tx.onerror=()=>reject(tx.error);
            });
            if(!finished)await new Promise(resolve=>setTimeout(resolve,16));
        }
    }
    close() { this.closed = true; clearTimeout(this.touchTimer); this.touches.clear(); this.db?.close(); this.db = undefined; this.memory.clear(); this.memoryBytes = 0; }
}
