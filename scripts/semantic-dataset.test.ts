import {test,expect} from 'bun:test';
import {mkdtemp,rm,readdir,cp,symlink} from 'node:fs/promises';
import {resolve} from 'node:path';
import {Database} from './duckdb';
import {generate} from './generate';
import {generateStatic} from './generate-static';
import {convertSemanticDataset,copyCurrentSemanticDataset,editSemanticDataset} from './semantic-dataset';
import {migrateMapData} from './migrate-map-data';
import {updateBitmapAreaScale} from './generate-layer-analysis';
import {datasetPath,isSemanticDataset} from './dataset-path';
import {readMapManifest} from './read-map-manifest';
import {openPublishedMap} from './published-map';
import {exportReferenceSnapshot,readReferenceSnapshot} from './reference-snapshot';
import {generateLod4Summaries} from './generate-lod4-summaries';
import StaticHttpDataSource from '../src/data/StaticHttpDataSource';
import {buildSite} from './build';
import {artifactFiles} from './publish-release';
import {canonicalBytes} from '../src/shared/mapRelease';
import {sha256} from '../src/shared/httpPack';

test('native source is deterministic, serves only semantic paths and preserves old releases on addon edits',async()=>{
    const temp=await mkdtemp('/tmp/map-semantic-source-');let client:StaticHttpDataSource|undefined;
    const originalFetch=globalThis.fetch,originalLocation=Object.getOwnPropertyDescriptor(globalThis,'location');
    try{
        const database=resolve(temp,'bitmaps.db'),db=await Database.create(database);
        try{await db.exec('CREATE TABLE bitmaps(bitmap UINTEGER PRIMARY KEY,tx UTINYINT[],size UINTEGER[],pattern BIGINT)');await db.exec('INSERT INTO bitmaps SELECT i::UINTEGER,[1]::UTINYINT[],[1,1]::UINTEGER[],0::BIGINT FROM range(2016) t(i)');}finally{await db.close();}
        const typed=await generateStatic({db:database,geometry:'none',out:resolve(temp,'generated')});
        const native=resolve(temp,'native'),converted=await convertSemanticDataset(typed,native),before=(await readMapManifest(typed)).manifest;
        expect((await readMapManifest(native)).manifest).toEqual(before);
        expect((await openPublishedMap(native)).neighborhood(0).bytes).toEqual((await openPublishedMap(typed)).neighborhood(0).bytes);
        for(const name of ['colors','geometry','dimensions','lod4','bitmap-chunks','parcel-index','parcel-previews','previews'])expect(await readdir(native)).not.toContain(name);
        expect(await Bun.file(resolve(native,'manifest.json')).exists()).toBe(false);
        const repeated=await convertSemanticDataset(native,resolve(temp,'repeated'));expect(repeated.release).toBe(converted.release);
        const initialAnalysis=await Bun.file(datasetPath(native,'layer-analysis.json')).json();
        expect(initialAnalysis.area.scale).toBe('log');
        const originalAreas=await Bun.file(datasetPath(native,'colors',initialAnalysis.area.values.url)).bytes();
        await updateBitmapAreaScale(native,'linear');
        expect((await Bun.file(datasetPath(native,'layer-analysis.json')).json()).area.scale).toBe('linear');
        await updateBitmapAreaScale(native);
        const logarithmic=await Bun.file(datasetPath(native,'layer-analysis.json')).json();
        expect(logarithmic).toEqual(initialAnalysis);
        expect(logarithmic.area.histogram[0]).toBe(2016);
        expect(await Bun.file(datasetPath(native,'colors',initialAnalysis.area.values.url)).bytes()).toEqual(originalAreas);
        expect(await Bun.file(resolve(native,converted.release)).exists()).toBe(true);
        const out=resolve(temp,'site'),versionFile=resolve(temp,'build-version.json');
        const previousVersion={version:8,builtAt:'2026-11-01T00:00:00.000Z'};
        await Bun.write(versionFile,JSON.stringify(previousVersion));
        await Bun.write(resolve(out,'build-info.json'),JSON.stringify(previousVersion));
        await Bun.write(resolve(out,'index.html'),'previous site');
        await Bun.write(resolve(out,'map-data/previous-version.pb'),Uint8Array.of(1,2,3));
        await expect(buildSite({data:native,out,versionFile,maxBytes:1})).rejects.toThrow('Publication exceeds --max-bytes');
        expect(await Bun.file(resolve(out,'index.html')).text()).toBe('previous site');
        expect(await Bun.file(versionFile).json()).toEqual(previousVersion);
        const reference=await Bun.file(resolve(native,'release.json')).json();
        const selected=await Bun.file(resolve(native,reference.release.url)).json();
        const current=new Set<string>(['release.json',reference.release.url,...Object.values(selected.roots).map((ref:any)=>ref.url),...Object.values(selected.routes).map((ref:any)=>ref.url)]);
        for(const ref of Object.values(selected.routes) as any[]){
            const routes=await Bun.file(resolve(native,ref.url)).json();
            for(const value of Object.values(routes) as any[])current.add(value.url);
        }
        const sourceHistory=(await artifactFiles(native)).filter(path=>path!=='report.json'&&path!=='status.json'&&!current.has(path));
        expect(sourceHistory.length).toBeGreaterThan(0);
        const built=await buildSite({data:native,out,versionFile,maxBytes:100_000_000});
        expect(built.release).toBe(reference.release.url);expect(built.version).toBe(9);
        expect(built.validation).toBe('integrity');
        expect(built.compression.format).toBe('none');
        expect(await Bun.file(resolve(out,'map-data/previous-version.pb')).exists()).toBe(false);
        expect(await artifactFiles(resolve(out,'map-data'))).toEqual([...current,'status.json'].sort());
        for(const path of current){
            expect(await Bun.file(resolve(out,'map-data',path)).bytes()).toEqual(await Bun.file(resolve(native,path)).bytes());
        }
        for(const path of sourceHistory){
            expect(await Bun.file(resolve(native,path)).exists()).toBe(true);
            expect(await Bun.file(resolve(out,'map-data',path)).exists()).toBe(false);
        }
        expect(await Bun.file(resolve(out,'index.html')).text()).toContain(`content="${reference.release.url}"`);
        expect((await artifactFiles(out)).some(path=>path.endsWith('.gz'))).toBe(false);
        const payloadPath=[...current].find(path=>path.startsWith('parcels/chunks/')&&path.endsWith('.pb'))!;
        const payload=await Bun.file(resolve(native,payloadPath)).bytes();
        const installedHtml=await Bun.file(resolve(out,'index.html')).text();
        try{
            const corrupt=payload.slice();corrupt[0]^=1;
            await Bun.write(resolve(native,payloadPath),corrupt);
            await expect(buildSite({data:native,out,versionFile})).rejects.toThrow('Failed');
            expect((await Bun.file(versionFile).json()).version).toBe(9);
            expect(await Bun.file(resolve(out,'index.html')).text()).toBe(installedHtml);
            await rm(resolve(native,payloadPath));
            await expect(copyCurrentSemanticDataset(native,resolve(temp,'missing-payload'))).rejects.toThrow();
        }finally{await Bun.write(resolve(native,payloadPath),payload);}
        // Authenticated routing must still enforce each payload's declared byte length.
        const originalSelector=await Bun.file(resolve(native,'release.json')).bytes();
        const created:string[]=[];
        try{
            const changed=structuredClone(selected);
            for(const [bucket,ref] of Object.entries(selected.routes) as [string,any][]){
                const routes=await Bun.file(resolve(native,ref.url)).json();
                const value=Object.values(routes).find((value:any)=>value.url===payloadPath) as any;
                if(!value)continue;
                value.bytes++;
                const bytes=canonicalBytes(routes),hash=await sha256(bytes),url=ref.url.replace(ref.sha256,hash);
                await Bun.write(resolve(native,url),bytes);created.push(url);
                changed.routes[bucket]={url,sha256:hash,bytes:bytes.length};break;
            }
            expect(created).toHaveLength(1);
            const bytes=canonicalBytes(changed),hash=await sha256(bytes),url=`releases/${hash}.json`;
            await Bun.write(resolve(native,url),bytes);created.push(url);
            await Bun.write(resolve(native,'release.json'),canonicalBytes({...reference,release:{url,sha256:hash,bytes:bytes.length}}));
            await expect(copyCurrentSemanticDataset(native,resolve(temp,'wrong-declared-length'))).rejects.toThrow(/integrity failure|Conflicting publication/);
        }finally{
            await Bun.write(resolve(native,'release.json'),originalSelector);
            for(const path of created)await rm(resolve(native,path));
        }
        const audited=await buildSite({data:native,out,versionFile,validation:'full'});
        expect(audited.validation).toBe('full');expect(audited.release).toBe(built.release);
        await symlink(native,resolve(temp,'alias'));
        await expect(generateLod4Summaries(native,resolve(temp,'alias/new/summary'))).rejects.toThrow('separate');
        expect(await readdir(native)).not.toContain('new');
        const paths:string[]=[];Object.defineProperty(globalThis,'location',{value:{href:'https://native.test/'},configurable:true});
        globalThis.fetch=(async(input:RequestInfo|URL)=>{const url=new URL(String(input));paths.push(url.pathname);try{return new Response(await Bun.file(resolve(native,url.pathname.slice('/map-data/'.length))).bytes());}catch{return new Response(null,{status:404});}}) as unknown as typeof fetch;
        client=new StaticHttpDataSource('https://native.test/map-data/','manifest.json','server',true);
        expect((await client.getManifest()).snapshot).toBe(before.snapshot);expect((await client.getNeighborhood(0)).bitmaps.length).toBe(2016);
        expect((await client.getLayerAnalysis()).count).toBe(2016);expect((await client.getSpatialMetricPage(0,new AbortController().signal)).count[0]).toBe(1);
        const jobs=await client.getParcelJobs([0]);const iterator=client.streamParcelJob({...jobs[0],accept:id=>id===0},new AbortController().signal),item=await iterator.next();expect(item.value?.id).toBe(0);await iterator.return(undefined);
        expect(paths[0]).toBe('/map-data/release.json');expect(paths.some(p=>p.startsWith('/map-data/neighborhoods/geometry/'))).toBe(true);
        expect(paths.some(p=>/^\/map-data\/(colors|geometry|dimensions|lod4|bitmap-chunks|parcel-index|previews|parcel-previews)\//.test(p))).toBe(false);
        const aggregateStart=paths.length,summaryIndex=await client.getLod4SummaryIndex();expect(summaryIndex?.gridSide).toBe(16);
        const summaryRef=summaryIndex!.batches.find(b=>b.mode==='area')!;
        expect((await client.getLod4SummaryBatch(summaryIndex!,summaryRef,new AbortController().signal))[0].id).toBe(0);
        await client.getLod4SummaryBatch(summaryIndex!,summaryRef,new AbortController().signal);
        const aggregatePaths=paths.slice(aggregateStart);expect(aggregatePaths.length).toBe(3);
        expect(aggregatePaths.every(p=>p.startsWith('/map-data/bitmaps/summaries/aggregates/'))).toBe(true);
        const filterStart=paths.length,filterMeta=await client.getParcelFilterMetadata();expect(filterMeta.count).toBe(2016);
        const filterIndex=await client.getParcelFilterIndex(7,9,new AbortController().signal),filterRef=filterIndex.batches[0];
        expect((await client.getParcelFilterBatch(filterIndex,filterRef,new AbortController().signal))[0].weights.every(n=>n===0)).toBe(true);
        await client.getParcelFilterBatch(filterIndex,filterRef,new AbortController().signal);
        expect(paths.slice(filterStart).length).toBe(4);expect(paths.slice(filterStart).every(p=>p.startsWith('/map-data/metrics/parcel-filters/'))).toBe(true);
        const previous=await Bun.file(resolve(native,'release.json')).text();
        await editSemanticDataset(native,async logical=>{const file=resolve(logical,'bitmap-area-colors.json'),value=await Bun.file(file).json();value.note='Changed addon root';await Bun.write(file,JSON.stringify(value));});
        expect(await Bun.file(resolve(native,converted.release)).exists()).toBe(true);expect(await Bun.file(resolve(native,'release.json')).text()).not.toBe(previous);
        // An already open data source retains the prior authenticated root.
        expect((await client.getBitmapAreaData()).maxArea).toBe(1);
        await exportReferenceSnapshot(native,database);
        expect((await readReferenceSnapshot(native,before.snapshot,2016))?.patterns).toEqual(Array(2016).fill(0));
        expect(await Bun.file(resolve(native,'bitmap-reference.json')).exists()).toBe(false);
        expect(await Bun.file(resolve(native,converted.release)).exists()).toBe(true);
        const installed=resolve(temp,'installed');await cp(typed,installed,{recursive:true});await migrateMapData(installed,{workRoot:resolve(temp,'migration-work'),log:()=>{}});expect(isSemanticDataset(installed)).toBe(true);
        const history=await readdir(resolve(temp,'.cache/maintenance/map-data-history'));expect(history.length).toBe(1);expect(await Bun.file(resolve(temp,'.cache/maintenance/map-data-history',history[0],'manifest.json')).exists()).toBe(true);
        expect(await Bun.file(datasetPath(installed,'analytics.json')).exists()).toBe(true);
        const legacy=resolve(temp,'legacy-continue'),messages:string[]=[];await cp(typed,legacy,{recursive:true});
        await generate({mode:'continue',database,target:legacy,workRoot:resolve(temp,'continue-work'),log:text=>messages.push(text)});
        expect(isSemanticDataset(legacy)).toBe(true);expect(messages).toContain('Semantic map data ready for bun dev.');
        const migrated=await Bun.file(resolve(legacy,'release.json')).text();messages.length=0;
        await generate({mode:'continue',database,target:legacy,workRoot:resolve(temp,'continue-work'),log:text=>messages.push(text)});
        expect(await Bun.file(resolve(legacy,'release.json')).text()).toBe(migrated);expect(messages.at(-1)).toContain('No Protobuf files regenerated');
    }finally{client?.close();globalThis.fetch=originalFetch;if(originalLocation)Object.defineProperty(globalThis,'location',originalLocation);else Reflect.deleteProperty(globalThis,'location');await rm(temp,{recursive:true,force:true});}
},60000);
