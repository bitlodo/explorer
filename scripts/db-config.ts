import path from 'node:path';
import { projectRoot, bitmapDatabasePath } from './paths.ts';

const defaults = {
    DB_BITMAP: bitmapDatabasePath,
};
// Bun loads the root .env. Explicit --db paths remain relative to the caller.
export function databasePath(key: keyof typeof defaults, override?: string) {
    if (override) return path.resolve(override);
    const value = process.env[key];
    if (value) return path.resolve(projectRoot, value);
    return defaults[key];
}
