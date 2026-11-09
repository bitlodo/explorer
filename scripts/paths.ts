import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
export { distRoot, siteBase } from '../server/paths';

export const projectRoot = resolve(fileURLToPath(new URL('../', import.meta.url)));
export const srcRoot = resolve(projectRoot, 'src');
export const publicRoot = resolve(projectRoot, 'public');
export const mapDataRoot = resolve(publicRoot, 'map-data');
export const dataRoot = resolve(projectRoot, 'data');
export const databasesRoot = resolve(dataRoot, 'databases');
export const bitmapDatabasePath = resolve(dataRoot, 'db/bitmaps.db');
export const maintenanceRoot = resolve(projectRoot, '.cache/maintenance');
export const temporaryRoot = resolve(projectRoot, '.tmp');

