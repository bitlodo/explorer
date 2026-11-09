import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type UserConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { mapDataAssets } from './scripts/vite-map-data';
import type {SiteBuild} from './src/shared/siteMetadata';

const root = fileURLToPath(new URL('.', import.meta.url));

/** Vite owns source/HMR; map assets remain available across atomic dataset replacement. */
export function clientConfig(options: { base?: string; siteBuild?:SiteBuild } = {}): UserConfig {
    return {
        root,
        base: options.base || process.env.SITE_BASE || '/',
        publicDir: resolve(root, 'public'),
        cacheDir: resolve(root, '.cache/vite'),
        plugins: [mapDataAssets(), react()],
        define:options.siteBuild?{__SITE_BUILD__:JSON.stringify(options.siteBuild)}:undefined,
        resolve: {
            alias: { '@': resolve(root, 'src'), '@shared': resolve(root, 'src/shared') },
        },
        worker: { format: 'es' },
        server: {
            host: process.env.HOST || '127.0.0.1',
            strictPort: true,
            watch: { ignored: ['**/data/databases/**', '**/data/aws/**', '**/data/db/**', '**/.cache/**', '**/.explorer-build-*/**'] },
            fs: { deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/.aws/**', '**/.agents/**', '**/.codex/**',
                '**/data/databases/**', '**/data/aws/**', '**/data/db/**', '**/.cache/**', '**/.explorer-build-*/**'] },
        },
        build: { outDir: resolve(root, 'dist') },
    };
}

export default defineConfig(clientConfig());
