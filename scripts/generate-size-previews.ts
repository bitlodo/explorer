#!/usr/bin/env bun
import { readMapManifest } from './read-map-manifest';
import fs from 'node:fs/promises';
import path from 'node:path';
import {decodeParcelMeans,validateMeansRef,PARCEL_MEANS_PROTO} from '../src/shared/parcelMeans';
import {generatePreviews} from './generate-previews';
import {check,sha256} from '../src/shared/httpPack';
const args=process.argv.slice(2);
check(args.length===4&&args[0]==='--source'&&args[2]==='--summary','Use --source SNAPSHOT --summary SUMMARY_DIR');
const out=path.resolve(args[3]),root=JSON.parse(await fs.readFile(path.join(out,'parcel-colors.json'),'utf8'));
const manifest=(await readMapManifest(args[1])).manifest;
check((root.format==='parcel-size-means-v1'||root.format===PARCEL_MEANS_PROTO)&&root.sourceSnapshot===manifest.snapshot&&root.count===manifest.publishedHeight+1,'Summary belongs to another snapshot');
validateMeansRef(root.means,root.count,root.format);check(root.preview==='parcel-size-preview.pb','Invalid summary paths');
const bytes=new Uint8Array(await fs.readFile(path.join(out,root.means.url)));
check(bytes.length===root.means.bytes&&await sha256(bytes)===root.means.sha256,'Invalid summary hash');
const means=decodeParcelMeans(bytes,root.count,root.format);
await generatePreviews({source:args[1],out,means,indexName:root.preview});
