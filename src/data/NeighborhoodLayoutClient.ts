import type { NeighborhoodLayoutRequest, NeighborhoodLayoutResult } from '../shared/computeNeighborhoodLayout';
import { mapWorker } from '../workerUrls';

type Job = { request: NeighborhoodLayoutRequest; priority: number; resolve: (value: NeighborhoodLayoutResult) => void; reject: (error: unknown) => void; signal: AbortSignal; abort: () => void };
const aborted = () => new DOMException('Neighborhood layout cancelled', 'AbortError');

/** A single lazy worker. One transferred input/output at a time; bounded queue. */
export default class NeighborhoodLayoutClient {
    private worker?: Worker;
    private active?: Job;
    private queue: Job[] = [];
    private serial = 0;
    private closed = false;
    private timer?: ReturnType<typeof setTimeout>;
    readonly stats = { completed: 0, cancelled: 0, restarts: 0, durationMs: 0 };
    constructor(private createWorker = () => mapWorker('neighborhoodLayoutWorker'), private timeoutMs = 30000) {}

    generate(request: Omit<NeighborhoodLayoutRequest, 'job'>, signal: AbortSignal, priority = 0): Promise<NeighborhoodLayoutResult> {
        if (this.closed || signal.aborted) return Promise.reject(aborted());
        if (this.queue.length >= 32) return Promise.reject(new Error('Neighborhood layout queue is full'));
        return new Promise((resolve, reject) => {
            const job: Job = { request: { ...request, job: ++this.serial }, priority, resolve, reject, signal, abort: () => this.cancel(job) };
            this.queue.push(job); this.queue.sort((a, b) => b.priority - a.priority || a.request.job - b.request.job);
            signal.addEventListener('abort', job.abort, { once: true });
            this.pump();
        });
    }
    prioritize(id: number) {
        for (const job of this.queue) job.priority = job.request.expected.id === id ? 100 : 0;
        this.queue.sort((a, b) => b.priority - a.priority || a.request.job - b.request.job);
    }
    private cancel(job: Job) {
        if (this.active === job) {
            // Sync packing cannot process a cancellation message. Terminate it,
            // then lazily recreate the worker for the next live request.
            clearTimeout(this.timer); this.worker?.terminate(); this.worker = undefined; this.active = undefined;
            this.stats.restarts++;
        } else {
            const index = this.queue.indexOf(job);
            if (index < 0) return;
            this.queue.splice(index, 1);
        }
        job.signal.removeEventListener('abort', job.abort); this.stats.cancelled++; job.reject(aborted()); this.pump();
    }
    private fail(error: unknown) {
        clearTimeout(this.timer);
        this.worker?.terminate(); this.worker = undefined;
        const active = this.active; this.active = undefined;
        if (active) { active.signal.removeEventListener('abort', active.abort); active.reject(error); }
        // Restart only for subsequent work, not for an automatic retry loop.
        for (const job of this.queue.splice(0)) { job.signal.removeEventListener('abort', job.abort); job.reject(error); }
    }
    private pump() {
        if (this.closed || this.active || !this.queue.length) return;
        const job = this.queue.shift()!; this.active = job;
        try {
            if (!this.worker) {
                const worker = this.createWorker(); this.worker = worker;
                worker.onmessage = (event: MessageEvent<NeighborhoodLayoutResult & { error?: string }>) => {
                    if (this.worker !== worker) return;
                    const active = this.active;
                    if (!active || event.data.job !== active.request.job) { this.fail(new Error('Invalid neighborhood worker response')); return; }
                    clearTimeout(this.timer); this.active = undefined; active.signal.removeEventListener('abort', active.abort);
                    if (event.data.error) active.reject(new Error(event.data.error));
                    else { this.stats.completed++; this.stats.durationMs += event.data.durationMs; active.resolve(event.data); }
                    this.pump();
                };
                worker.onerror = event => { if (this.worker !== worker) return; event.preventDefault(); this.fail(new Error(event.message || 'Neighborhood worker failed')); };
                worker.onmessageerror = () => { if (this.worker === worker) this.fail(new Error('Invalid neighborhood worker message')); };
            }
            // The caller supplies a private copy: no cached input is detached.
            this.timer = setTimeout(() => this.fail(new Error('Neighborhood layout worker timed out')), this.timeoutMs);
            this.worker.postMessage(job.request, [job.request.dimensions.buffer]);
        } catch (error) { this.fail(error); }
    }
    close() {
        clearTimeout(this.timer);
        this.closed = true; this.worker?.terminate(); this.worker = undefined;
        const jobs = [...(this.active ? [this.active] : []), ...this.queue]; this.active = undefined; this.queue = [];
        for (const job of jobs) { job.signal.removeEventListener('abort', job.abort); job.reject(aborted()); }
    }
}
