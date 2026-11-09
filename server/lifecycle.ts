export function shutdownOnSignal(close: () => void | Promise<unknown>): void {
    let stopping = false;
    const stop = async () => {
        if (stopping) return;
        stopping = true;
        try { await close(); process.exit(0); }
        catch (error) { console.error(error); process.exit(1); }
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
}
