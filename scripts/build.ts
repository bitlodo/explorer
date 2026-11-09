import {readMapManifest} from './read-map-manifest';
import { gzipSync } from 'node:zlib';
import { artifactFiles, appendFile } from './publish-release';
import { lstat, mkdir, mkdtemp, realpath, rename, rm } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { build } from 'vite';
import { clientConfig } from '../vite.config';
import { argumentsFor, runTool } from './cli';
import { srcRoot, publicRoot, distRoot, mapDataRoot, projectRoot, siteBase } from './paths';
import {reserveBuildVersion} from './build-version';
import {readMapStatus} from './map-status';
import {isSemanticDataset} from './dataset-path';
import {validateDatasetReference} from '../src/shared/datasetReference';
import {createBuildProgress} from './build-progress';

export async function buildSite(options: { out?: string; data?: string; base?: string; allowSample?: boolean; versionFile?:string; precompress?:boolean; maxBytes?:number; validation?:'integrity'|'full' } = {}) {
    if(options.maxBytes!==undefined&&(!Number.isSafeInteger(options.maxBytes)||options.maxBytes<1))throw Error('--max-bytes must be a positive safe integer.');
    if(options.validation!==undefined&&!['integrity','full'].includes(options.validation))throw Error('--validation must be integrity or full.');
    const out = resolve(options.out || distRoot), data = await realpath(options.data || mapDataRoot);
    const validation=options.validation==='full'||!isSemanticDataset(data)?'full':'integrity';
    const base = siteBase(options.base);
    // Replacing a source tree or an arbitrary existing directory is never a build operation.
    const protectedRoots = [srcRoot, publicRoot, ...['server', 'scripts', 'shared', 'data', 'test'].map(name => resolve(projectRoot, name))];
    if (out === projectRoot || projectRoot.startsWith(out + sep) || protectedRoots.some(root => out === root || out.startsWith(root + sep))
        || out === data || data.startsWith(out + sep) || out.startsWith(data + sep)) throw new Error('Build output must be separate from sources and map data.');
    const existing = await lstat(out).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (existing && (existing.isSymbolicLink() || !existing.isDirectory() || !await Bun.file(resolve(out, 'build-info.json')).exists())) {
        throw new Error('Existing output is not a Bun site build. Choose a new --out directory.');
    }
    await mkdir(dirname(out), { recursive: true });
    const parent = await realpath(dirname(out));
    if (parent !== dirname(out)) throw new Error('Build output must not traverse a symlink.');
    const work = await mkdtemp(resolve(parent, '.explorer-build-'));
    const app = resolve(work, 'app'), site = resolve(work, 'site'), previous = resolve(work, 'previous');
    const version=await reserveBuildVersion(options.versionFile).catch(async error=>{await rm(work,{recursive:true,force:true});throw error;});
    const progress=createBuildProgress();
    let published = false;
    try {
        progress.update({phase:'Compiling application'});
        await build({ ...clientConfig({ base,siteBuild:version.next }), configFile: false, mode: 'production',
            build: { outDir: app, emptyOutDir: true } });
        progress.update({phase:validation==='full'?'Validating map dataset':'Checking dataset integrity'});
        await runTool('scripts/tools/prepare-pages.ts', [data, app, site, ...(options.allowSample ? ['--allow-sample'] : []),...(validation==='integrity'?['--integrity-only']:[])], {
            env:{BITMAP_BUILD_PROGRESS:'1'},forwardStdout:false,
            onLine:line=>{if(!progress.consume(line))console.log(line);},
        });
        progress.update({phase:'Writing build metadata'});
        const {manifest}=await readMapManifest(resolve(site,'map-data'));
        const release=isSemanticDataset(resolve(site,'map-data'))
            ?validateDatasetReference(await Bun.file(resolve(site,'map-data/release.json')).json()).release.url
            :undefined;
        const status=await readMapStatus(data,manifest.snapshot,manifest.publishedHeight)??{
            format:'bitmap-map-status-v1',snapshot:manifest.snapshot,publishedHeight:manifest.publishedHeight,
            syncedHeight:null,syncedAt:null,generatedAt:null,checkedAt:version.next.builtAt};
        await Bun.write(resolve(site,'map-data/status.json'),JSON.stringify(status,null,2)+'\n');
        const html=await Bun.file(resolve(site,'index.html')).text();
        await Bun.write(resolve(site,'index.html'),release?html.replace('<head>',`<head><meta name="bitmap-release" content="${release}">`):html);
        // Precompressed variants are optional delivery assets; canonical hashes
        // continue to authenticate the decompressed response body.
        if(options.precompress)for(const path of await artifactFiles(site))if(/\.(?:js|css|json|pb)$/.test(path)){
            progress.update({phase:'Creating optional gzip files'});
            const bytes=await Bun.file(resolve(site,path)).bytes();if(bytes.length<1024)continue;
            const compressed=gzipSync(bytes,{level:9});compressed.fill(0,4,8);compressed[9]=255;if(compressed.length<bytes.length*.95)await appendFile(site,path+'.gz',compressed);
        }
        progress.update({phase:'Checking publication size'});
        let publicationBytes=0;const publicationFiles=await artifactFiles(site);for(const path of publicationFiles)publicationBytes+=Bun.file(resolve(site,path)).size;
        const info = { validation,compression:options.precompress?{format:'gzip-v1',level:9,mtime:0,os:255,encoder:process.versions.zlib??'unknown'}:{format:'none'},publicationBytes,publicationFiles:publicationFiles.length,release, format: 'explorer-bun-site-v1', base, ...version.next };
        await Bun.write(resolve(site, 'build-info.json'), JSON.stringify(info, null, 2) + '\n');
        const totalBytes=publicationBytes+Bun.file(resolve(site,'build-info.json')).size;
        if(options.maxBytes!==undefined&&totalBytes>options.maxBytes)throw Error(`Publication exceeds --max-bytes: ${totalBytes} > ${options.maxBytes}. The previous site and build version were preserved.`);
        progress.update({phase:'Installing current build'});
        if (existing) await rename(out, previous);
        let installed=false;
        try { await rename(site, out);installed=true;await version.commit();published = true; }
        catch (error) { if(installed)await rename(out,site);if (existing) await rename(previous, out); throw error; }
        progress.update({phase:'Build finished',completed:publicationFiles.length,total:publicationFiles.length,unit:'files',bytes:publicationBytes});
        console.log(`Static site ready: ${out} (${base}); ${publicationFiles.length} files, ${publicationBytes} bytes.`);
        return info;
    } finally {
        progress.close();
        // A failed build leaves the previously served directory untouched.
        try{if (published || !await Bun.file(resolve(previous, 'index.html')).exists()) await rm(work, { recursive: true, force: true });}
        finally{await version.release();}
    }
}

if (import.meta.main) {
    const options = argumentsFor(process.argv.slice(2), ['--out', '--data', '--base', '--allow-sample','--precompress','--max-bytes','--validation']);
    if (options['--allow-sample'] && options['--allow-sample'] !== 'true') throw new Error('--allow-sample must be true.');
    if(options['--precompress']&&!['true','false'].includes(options['--precompress']))throw Error('--precompress must be true or false.');
    if(options['--validation']&&!['integrity','full'].includes(options['--validation']))throw Error('--validation must be integrity or full.');
    await buildSite({ out: options['--out'], data: options['--data'], base: options['--base'], allowSample: options['--allow-sample'] === 'true',precompress:options['--precompress']==='true',maxBytes:options['--max-bytes']===undefined?undefined:Number(options['--max-bytes']),validation:options['--validation'] as 'integrity'|'full'|undefined });
}
