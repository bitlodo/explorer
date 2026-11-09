import { resolve } from 'node:path';

export const distRoot = resolve(import.meta.dir, '../dist');

export function siteBase(value = process.env.SITE_BASE || '/'): string {
    if (!/^\/(?:[a-zA-Z0-9_-]+\/)*$/.test(value)) throw new Error('SITE_BASE must be / or a path such as /repository/.');
    return value;
}
