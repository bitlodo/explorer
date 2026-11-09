import { setTimeout as delay } from 'node:timers/promises';

export const AWS_BITCOIN_ENDPOINT = 'https://aws-public-blockchain.s3.us-east-2.amazonaws.com/';
export const TRANSACTION_PREFIX = 'v1.0/btc/transactions/';
export type RemoteObject = { key: string; date: string; size: number; etag: string; modified: string };
export type RequestOptions = { signal: AbortSignal; retries: number; retryDelayMs?: number; timeoutMs?: number; fetcher?: typeof fetch };

export class HttpError extends Error {
    constructor(readonly status: number, readonly retryAfter: string | null, url: string) {
        super(`HTTP ${status}: ${url}`);
    }
}

export async function retry<T>(action: () => Promise<T>, options: RequestOptions): Promise<T> {
    for (let attempt = 0; ; attempt++) {
        options.signal.throwIfAborted();
        try { return await action(); }
        catch (error) {
            if (options.signal.aborted || attempt >= options.retries ||
                error instanceof HttpError && error.status !== 408 && error.status !== 429 && error.status < 500) throw error;
            const after = error instanceof HttpError ? error.retryAfter : null;
            const requested = after ? (/^\d+$/.test(after) ? Number(after) * 1000 : Date.parse(after) - Date.now()) : 0;
            const backoff = Math.min(30_000, (options.retryDelayMs ?? 500) * 2 ** attempt);
            await delay(Math.max(backoff, Number.isFinite(requested) ? Math.max(0, requested) : 0), undefined, { signal: options.signal });
        }
    }
}

export async function request(url: URL, options: RequestOptions, headers?: HeadersInit, method: 'GET' | 'HEAD' = 'GET'): Promise<Response> {
    const response = await (options.fetcher ?? fetch)(url, {
        method, headers, signal: options.timeoutMs === 0 ? options.signal
            : AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs ?? 120_000)]),
    });
    if (!response.ok) {
        await response.body?.cancel();
        throw new HttpError(response.status, response.headers.get('retry-after'), url.href);
    }
    return response;
}

async function text(response: Response): Promise<string> {
    if (!response.body) throw Error('Empty S3 listing response.');
    const chunks: Uint8Array[] = [], reader = response.body.getReader();
    let length = 0;
    try {
        while (true) {
            const { done, value } = await reader.read(); if (done) break;
            length += value.length;
            if (length > 8 * 1024 * 1024) throw Error('S3 listing exceeds the metadata budget.');
            chunks.push(value);
        }
    } finally { await reader.cancel(); }
    return Buffer.concat(chunks).toString('utf8');
}

function xmlValue(xml: string, name: string, optional = false): string {
    const match = xml.match(new RegExp(`<${name}>([^<]*)</${name}>`));
    if (!match) { if (optional) return ''; throw Error(`Missing S3 listing field: ${name}`); }
    const entities: Record<string, string> = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' };
    return match[1].replace(/&(amp|quot|apos|lt|gt);/g, (_, entity: string) => entities[entity]);
}

export function validDate(value: string): boolean {
    return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}

/** S3 ListObjectsV2 response, requested with encoding-type=url and no delimiter. */
export function parseListing(xml: string): { objects: RemoteObject[]; next: string } {
    if (!xml.includes('<ListBucketResult') || !xml.trimEnd().endsWith('</ListBucketResult>') || /<!DOCTYPE|<!ENTITY/i.test(xml))
        throw Error('Invalid S3 listing XML.');
    if (xmlValue(xml, 'EncodingType') !== 'url') throw Error('Expected URL-encoded S3 keys.');
    const objects = [...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)].map(([, item]) => {
        const key = decodeURIComponent(xmlValue(item, 'Key'));
        const match = key.match(/^v1\.0\/btc\/transactions\/date=(\d{4}-\d{2}-\d{2})\/([A-Za-z0-9_.-]+\.parquet)$/);
        if (!match || !validDate(match[1])) throw Error(`Unexpected transaction object key: ${key}`);
        const size = Number(xmlValue(item, 'Size')), etag = xmlValue(item, 'ETag'), modified = xmlValue(item, 'LastModified');
        if (!Number.isSafeInteger(size) || size < 8 || !/^"[A-Za-z0-9-]+"$/.test(etag) || !Number.isFinite(Date.parse(modified)))
            throw Error(`Invalid S3 object metadata: ${key}`);
        return { key, date: match[1], size, etag, modified };
    });
    if (Number(xmlValue(xml, 'KeyCount')) !== objects.length || new Set(objects.map(o => o.key)).size !== objects.length)
        throw Error('Incomplete or duplicate S3 listing.');
    const truncated = xmlValue(xml, 'IsTruncated');
    if (truncated !== 'true' && truncated !== 'false') throw Error('Invalid S3 pagination flag.');
    const next = truncated === 'true' ? xmlValue(xml, 'NextContinuationToken') : '';
    if (truncated === 'true' && !next) throw Error('S3 listing is truncated without a continuation token.');
    return { objects, next };
}

export async function* listTransactions(endpoint: string, from: string | undefined, to: string | undefined, options: RequestOptions) {
    let token = '', lastKey = '';
    const tokens = new Set<string>();
    do {
        const url = new URL(endpoint);
        url.search = new URLSearchParams({ 'list-type': '2', 'encoding-type': 'url', 'max-keys': '1000',
            prefix: TRANSACTION_PREFIX + (from && from === to ? `date=${from}/` : '') }).toString();
        if (token) url.searchParams.set('continuation-token', token);
        else if (from && from !== to) url.searchParams.set('start-after', `${TRANSACTION_PREFIX}date=${from}/`);
        const page = await retry(async () => parseListing(await text(await request(url, options))), options);
        const selected: RemoteObject[] = [];
        for (const object of page.objects) {
            if (object.key <= lastKey) throw Error('S3 object keys are not strictly ordered.');
            lastKey = object.key;
            if (to && object.date > to) { if (selected.length) yield selected; return; }
            if (!from || object.date >= from) selected.push(object);
        }
        if (selected.length) yield selected;
        token = page.next;
        if (token && tokens.has(token)) throw Error('Repeated S3 continuation token.');
        if (token) tokens.add(token);
    } while (token);
}
