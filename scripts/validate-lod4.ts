import { argumentsFor } from './cli';
import { validateLod4Bundle } from './generate-lod4';
import { check } from '../src/shared/httpPack';

if (import.meta.main) {
    const args = argumentsFor(process.argv.slice(2), ['--source', '--bundle']);
    check(args['--bundle'], 'Use --bundle LOD4_DIRECTORY');
    const { index, ...stats } = await validateLod4Bundle(args['--bundle'], args['--source']);
    console.log(JSON.stringify({ status: 'passed', sourceSnapshot: index.sourceSnapshot, regions: index.regions.length, bitmaps: index.bitmapCount, ...stats }));
}
