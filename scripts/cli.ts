import { resolve } from 'node:path';
import { projectRoot } from './paths';
import { open } from 'node:fs/promises';

export function argumentsFor(args: string[], names: string[]): Record<string, string> {
    const options: Record<string, string> = {};
    for (let i = 0; i < args.length; i += 2) {
        const name = args[i], value = args[i + 1];
        if (!names.includes(name) || name in options || !value || value.startsWith('--')) {
            throw new Error(`Invalid/duplicate option: ${name}. Options: ${names.join(', ')}`);
        }
        options[name] = value;
    }
    return options;
}

export async function runTool(script: string, args: string[], options: { log?: string; onLine?: (line: string) => void; forwardStdout?: boolean; env?: Record<string, string> } = {}): Promise<void> {
    // Include environment changes made by the caller, not just Bun's startup environment.
    const output = options.log ? await open(options.log, 'a') : undefined;
    const child = Bun.spawn([process.execPath, resolve(projectRoot, script), ...args], {
        cwd: projectRoot, env: { ...process.env, ...options.env }, stdin: 'inherit',
        stdout: options.onLine ? 'pipe' : output?.fd ?? 'inherit', stderr: options.onLine ? 'pipe' : output?.fd ?? 'inherit',
    });
    const stop = () => child.kill('SIGTERM');
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    try {
        async function drain(stream: ReadableStream<Uint8Array>, stdout: boolean) {
            const decoder = new TextDecoder(); let pending = '', dropping = false;
            function lines(text: string, final = false) {
                let start = 0, end: number;
                while ((end = text.indexOf('\n', start)) !== -1) {
                    const part = text.slice(start, end);
                    if (!dropping && pending.length + part.length <= 65536) options.onLine?.((pending + part).replace(/\r$/, ''));
                    pending = ''; dropping = false; start = end + 1;
                }
                const tail = text.slice(start);
                if (!dropping && pending.length + tail.length <= 65536) pending += tail;
                else { pending = ''; dropping = true; }
                if (final && !dropping && pending) options.onLine?.(pending.replace(/\r$/, ''));
            }
            try {
                for await (const bytes of stream) {
                    if (output) await output.writeFile(bytes);
                    else if (!stdout || options.forwardStdout !== false) (stdout ? process.stdout : process.stderr).write(bytes);
                    if (stdout) lines(decoder.decode(bytes, { stream: true }));
                }
                if (stdout) lines(decoder.decode(), true);
            } catch (error) { stop(); throw error; }
        }
        const streams = options.onLine ? [child.stdout, child.stderr].map((stream, index) => {
            if (!(stream instanceof ReadableStream)) throw Error('Expected piped tool output.');
            return drain(stream, index === 0);
        }) : [];
        const results = await Promise.allSettled([child.exited, ...streams]);
        for (const result of results) if (result.status === 'rejected') throw result.reason;
        if (results[0].status === 'fulfilled' && results[0].value !== 0) throw new Error(`Failed: ${script}${options.log ? `. Details: ${options.log}` : ''}`);
    } finally {
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
        await output?.close();
    }
}
