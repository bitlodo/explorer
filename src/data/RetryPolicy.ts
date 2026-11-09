export class DownloadError extends Error {
    constructor(message: string, readonly status?: number, readonly retryAfter = 0, readonly permanent = false) { super(message); }
}
/** Bounded exponential retries; cancellation never creates a failure entry. */
export default class RetryPolicy {
    private failures = new Map<string | number, { attempts: number; after: number }>();
    constructor(private now = Date.now) {}
    ready(key: string | number) { const failure = this.failures.get(key); return !failure || this.now() >= failure.after; }
    delay(key:string|number){const after=this.failures.get(key)?.after;return after!==undefined&&Number.isFinite(after)&&after>this.now()?after-this.now():undefined;}
    success(key: string | number) { this.failures.delete(key); }
    fail(key: string | number, error: unknown) {
        if ((error as Error)?.name === 'AbortError') return;
        const attempts = (this.failures.get(key)?.attempts ?? 0) + 1;
        const e = error as DownloadError;
        const permanent = e.permanent || e.status === 404 || (e.status !== undefined && e.status >= 400 && e.status < 500 && ![408, 429].includes(e.status));
        this.failures.set(key, { attempts:attempts>=4?0:attempts, after: permanent ? Infinity : this.now() + Math.max(e.retryAfter || 0, attempts>=4?60000:Math.min(30000, 1000 * 2 ** (attempts - 1))) });
        // Obsolete views must not grow a session-long unbounded failure map.
        while (this.failures.size > 4096) this.failures.delete(this.failures.keys().next().value!);
    }
}
