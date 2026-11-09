export type BuildProgress = {
    phase: string;
    completed?: number;
    total?: number;
    unit?: string;
    bytes?: number;
};

export const buildProgressEnabled = () => process.env.BITMAP_BUILD_PROGRESS === '1';
let lastReport = 0, lastPhase = '';

/** Child processes report real completed work; the parent supplies the heartbeat. */
export function reportBuildProgress(event: BuildProgress) {
    if (!buildProgressEnabled()) return;
    const now = performance.now();
    if (event.phase === lastPhase && event.completed !== event.total && now - lastReport < 100) return;
    lastPhase = event.phase;
    lastReport = now;
    console.log(JSON.stringify({ buildProgress: event }));
}

/** Keep progress visible even while the validation subprocess is busy with CPU work. */
export function createBuildProgress(options: {
    output?: { write: (text: string) => unknown; isTTY?: boolean };
    now?: () => number;
    refreshMs?: number;
} = {}) {
    const output = options.output ?? process.stderr, now = options.now ?? (() => performance.now());
    const started = now(), refreshMs = options.refreshMs ?? (output.isTTY ? 1000 : 5000);
    let event: BuildProgress | undefined, phaseStarted = started, closed = false, lastLine = '';
    const elapsed = (start: number) => `${((now() - start) / 1000).toFixed(1)}s`;
    function render(done = false) {
        if (!event || closed) return;
        const fields = [`[build] ${event.phase}${done ? ' complete' : ''}`];
        if (event.completed !== undefined) {
            let count = event.completed.toLocaleString('en-US');
            if (event.total !== undefined) {
                const percent = event.total === 0 ? 100 : Math.min(100, event.completed * 100 / event.total);
                count += ` / ${event.total.toLocaleString('en-US')} (${percent.toFixed(1)}%)`;
            }
            fields.push(`${count}${event.unit ? ' ' + event.unit : ''}`);
        }
        if (event.bytes !== undefined) fields.push(`${(event.bytes / 1e6).toFixed(1)} MB`);
        fields.push(`${elapsed(phaseStarted)} stage`, `${elapsed(started)} total`);
        const line = fields.join(' | ') + '\n';
        if (line !== lastLine) output.write(line);
        lastLine = line;
    }
    function update(next: BuildProgress) {
        if (closed) return;
        if (next.phase !== event?.phase) {
            render(true);
            phaseStarted = now();
            event = next;
            render();
        } else event = next;
    }
    const timer = setInterval(() => render(), refreshMs);
    timer.unref();
    return {
        update,
        consume(line: string) {
            if (!line.startsWith('{"buildProgress":')) return false;
            try {
                const next = JSON.parse(line).buildProgress as BuildProgress;
                if (!next || typeof next.phase !== 'string') return false;
                update(next);
                return true;
            } catch { return false; }
        },
        close() {
            if (closed) return;
            clearInterval(timer);
            render();
            closed = true;
        },
    };
}
