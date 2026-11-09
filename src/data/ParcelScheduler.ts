import RetryPolicy from './RetryPolicy';
import type { MapDataSource, ParcelJob } from './MapDataSource';
import type { ParcelRecord } from '../shared/httpPack';
export const PARCEL_BATCH_RECORDS = 1024;
export const PARCEL_BATCH_PARCELS = 32768;
/** Spatial selection is independent from continuous, content-keyed download draining. */
export default class ParcelScheduler {
    private desired = new Set<number>();
    private jobs: ParcelJob[] = [];
    private active = new Map<string, { controller: AbortController; job: ParcelJob }>();
    private failures = new RetryPolicy();
    private selection?:AbortController;
    onDesired?: (ids:readonly number[])=>void;
    private closed = false;
    private selecting = false;
    private revision = 0;
    private selectedRevision = -1;
    private retry?: ReturnType<typeof setTimeout>;
    readonly stats = { batches: 0, records: 0, maxBatchParcels: 0, discardedPayloadBytes: 0, maxConcurrentDownloads: 0 };
    constructor(private source: MapDataSource, private resident: (id: number) => boolean,
        private consume: (records: ParcelRecord[]) => Promise<void>, private report: (error: unknown) => void, private concurrency = 2) {}
    setDesired(ids: number[]) {
        if (this.closed) return;
        const previous = [...this.desired];
        if (ids.length === previous.length && ids.every((id, i) => id === previous[i])) { this.pump(); return; }
        this.desired = new Set(ids); this.revision++;this.selection?.abort();this.onDesired?.(ids);
        for (const { controller, job } of this.active.values()) {
            if (!(job.contains ? ids.some(job.contains) : job.pack?.ids ? job.pack.ids.some(id => this.desired.has(id)) : ids.some(id => id >= job.first && id <= job.last))) controller.abort();
        }
        void this.selectJobs();
    }
    wants(id: number) { return this.desired.has(id); }
    get desiredCount(){return this.desired.size;}
    private async selectJobs() {
        if (this.closed || this.selecting) return;
        this.selecting = true;
        try {
            while (!this.closed && this.selectedRevision !== this.revision) {
                this.selection=new AbortController();const revision = this.revision, ids = [...this.desired].filter(id => !this.resident(id));
                let jobs: ParcelJob[];
                if (this.source.getParcelJobs) jobs = await this.source.getParcelJobs(ids,this.selection!.signal);
                else {
                    const regions = new Map<number, number[]>();
                    for (const id of ids) { const n = Math.floor(id / 2016), list = regions.get(n) || []; list.push(id); regions.set(n, list); }
                    jobs = [...regions].map(([n, ids]) => ({ key: `legacy:${n}`, first: n * 2016, last: (n + 1) * 2016 - 1, neighborhood: n, ids }));
                }
                if (revision !== this.revision) continue;
                this.jobs = jobs; this.selectedRevision = revision;
            }
        } catch (error) {
            if (!this.closed&&!this.selection?.signal.aborted) this.report(error);
        } finally { const cancelled=this.selection?.signal.aborted;this.selecting = false;if(cancelled&&!this.closed)void this.selectJobs();else this.pump(); }
    }
    private pump() {
        if (this.closed || this.selectedRevision !== this.revision) return;
        for (const job of this.jobs) {
            if (this.active.size >= this.concurrency) break;
            if (this.active.has(job.key) || !this.failures.ready(job.key)) continue;
            const ids = job.ids.filter(id => this.wants(id) && !this.resident(id));
            if (!ids.length) continue;
            const controller = new AbortController();
            this.active.set(job.key, { controller, job });
            this.stats.maxConcurrentDownloads = Math.max(this.stats.maxConcurrentDownloads, this.active.size);
            void this.run({ ...job, ids }, controller).then(()=>this.failures.success(job.key)).catch(error => {
                if (!this.closed && (error as Error)?.name!=='AbortError') {
                    this.failures.fail(job.key,error); this.report(error);
                }
            }).finally(() => {
                this.active.delete(job.key);
                // Geometry/wishes may expand while a pack is streaming. Resolve
                // remaining IDs again so authenticated RAM hits replace a replay
                // of the entire old pack job.
                if(!this.closed&&[...this.desired].some(id=>!this.resident(id))){this.revision++;void this.selectJobs();}
                else this.pump();
            });
        }
        const waits=this.jobs.filter(job=>job.ids.some(id=>this.wants(id)&&!this.resident(id))).map(job=>this.failures.delay(job.key)).filter((delay):delay is number=>delay!==undefined);
        if(waits.length&&!this.retry)this.retry=setTimeout(()=>{this.retry=undefined;this.pump();},Math.min(...waits));
    }
    private async run(job: ParcelJob, controller: AbortController) {
        let batch: ParcelRecord[] = [], parcels = 0, batchStarted = 0;
        const flush = async () => {
            if (!batch.length) return;
            controller.signal.throwIfAborted();
            const ready = batch.filter(record => this.wants(record.id) && !this.resident(record.id));
            batch = []; parcels = 0; batchStarted = 0;
            if (!ready.length) return;
            const count = ready.reduce((sum, record) => sum + record.txCount, 0);
            this.stats.batches++; this.stats.records += ready.length; this.stats.maxBatchParcels = Math.max(this.stats.maxBatchParcels, count);
            await this.consume(ready);
        };
        const stream = this.source.streamParcelJob
            ? this.source.streamParcelJob({...job,accept:id=>this.wants(id)&&!this.resident(id)}, controller.signal)
            : this.source.streamParcels(job.neighborhood!, job.ids, controller.signal);
        const iterator = stream[Symbol.asyncIterator]();
        let next = iterator.next();
        // A next() can reject while the worker is busy. Attach a handler immediately;
        // awaiting the original promise below still propagates that rejection.
        const watch = () => { void next.catch(() => {}); }; watch();
        try {
            while (true) {
                const result = batch.length ? await new Promise<IteratorResult<ParcelRecord> | undefined>((resolve, reject) => {
                    const timer = setTimeout(() => resolve(undefined), Math.min(8, Math.max(0, 32 - (performance.now() - batchStarted))));
                    next.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
                }) : await next;
                if (!result) { await flush(); continue; }
                if (result.done) { await flush(); break; }
                const record = result.value;
                next = iterator.next(); watch();
                if (!this.wants(record.id) || this.resident(record.id)) { this.stats.discardedPayloadBytes += record.tx.length; continue; }
                if (batch.length && parcels + record.txCount > PARCEL_BATCH_PARCELS) await flush();
                if (!batch.length) batchStarted = performance.now();
                batch.push(record); parcels += record.txCount;
                if (batch.length >= PARCEL_BATCH_RECORDS || parcels >= PARCEL_BATCH_PARCELS) await flush();
            }
        } finally {
            controller.abort(); await next.catch(() => {}); await iterator.return?.();
        }
    }
    close() {
        this.closed = true; this.selection?.abort();clearTimeout(this.retry);
        for (const { controller } of this.active.values()) controller.abort();
        this.desired.clear(); this.jobs = [];
    }
}
