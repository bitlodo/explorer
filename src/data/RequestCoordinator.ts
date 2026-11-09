/** One session-wide transport budget, held until the response body closes. */
export default class RequestCoordinator {
    private active = 0;
    private serial = 0;
    private queue: { priority: number; serial: number; start: () => void }[] = [];
    constructor(readonly limit = 4) {}
    acquire(signal: AbortSignal, priority = 0): Promise<() => void> {
        signal.throwIfAborted();
        return new Promise((resolve, reject) => {
            const job = { priority, serial: this.serial++, start: () => {
                signal.removeEventListener('abort', abort);
                this.active++;
                let released = false;
                resolve(() => { if (!released) { released = true; this.active--; this.pump(); } });
            } };
            const abort = () => { this.queue = this.queue.filter(item => item !== job); reject(signal.reason); };
            signal.addEventListener('abort', abort, { once: true });
            this.queue.push(job); this.pump();
        });
    }
    private pump() {
        this.queue.sort((a, b) => b.priority - a.priority || a.serial - b.serial);
        while (this.active < this.limit && this.queue.length) this.queue.shift()!.start();
    }
}

/** Shared work stops only when its last live consumer leaves. */
export class SharedRequests<T> {
    private pending = new Map<string, { controller: AbortController; consumers: number; promise: Promise<T> }>();
    run(key: string, signal: AbortSignal, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
        signal.throwIfAborted();
        let entry = this.pending.get(key);
        if (!entry || entry.controller.signal.aborted) {
            const controller = new AbortController();
            entry = { controller, consumers: 0, promise: Promise.resolve().then(() => { controller.signal.throwIfAborted(); return work(controller.signal); }) };
            this.pending.set(key, entry);
            const current = entry;
            void entry.promise.finally(() => { if (this.pending.get(key) === current) this.pending.delete(key); }).catch(() => {});
        }
        entry.consumers++;
        const current = entry;
        return new Promise((resolve, reject) => {
            let finished = false;
            const finish = (callback: () => void) => {
                if (finished) return; finished = true;
                signal.removeEventListener('abort', abort);
                if (--current.consumers === 0) current.controller.abort();
                callback();
            };
            const abort = () => finish(() => reject(signal.reason));
            signal.addEventListener('abort', abort, { once: true });
            current.promise.then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
        });
    }
}
