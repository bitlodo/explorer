import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import readline from 'node:readline';
const transpiler = new Bun.Transpiler({ loader: 'ts', target: 'browser' });
import MondrianLayout from '../src/shared/MondrianLayout.ts';
import { sharedModuleUrl, loadShared } from './helpers/load-shared.ts';

test('the actual official parcel worker uses MondrianLayout and preserves raw/RLE protocol and every parcel', async () => {
    const source = fs.readFileSync(new URL('../src/map/workers/neighborhoodBitmapWorker.ts', import.meta.url), 'utf8');
    assert.match(source, /import\('@shared\/MondrianLayout\.ts'\)/);
    const layoutModuleUrl = await sharedModuleUrl('../../src/shared/MondrianLayout.ts');
    const codecUrl = await sharedModuleUrl('../../src/shared/httpPack.ts');
    const { encodeSizes } = await loadShared('../../src/shared/httpPack.ts');
    const compiled = transpiler.transformSync(source)
        .replaceAll('"@shared/MondrianLayout.ts"', JSON.stringify(layoutModuleUrl))
        .replaceAll('"@shared/httpPack"', JSON.stringify(codecUrl));
    assert.ok(!compiled.includes('@shared/'), 'Resolve the real MondrianLayout module, not a substitute implementation');
    const previousSelf = globalThis.self, messages = [];
    globalThis.self = { postMessage: message => messages.push(message) };
    try {
        await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64'));
        const onmessage = globalThis.self.onmessage;
        async function check(id, tx) {
            await onmessage({ data: { protocol: 'parcel-worker-batch-v1', batchId: id, records: [encodeSizes(id, tx)] } });
            const batch = messages.pop();
            assert.equal(batch.batchId, id);
            assert.deepEqual([...batch.results[0].rects], new MondrianLayout(tx).slots.flatMap(r => [r.x,r.y,r.width,r.height]));
        }
        for (const tx of [[], [1], [10], [10, 1, 9, 2, 10], Array(49).fill(1).concat([10, 2, 10, 2, 3])]) await check(123, tx);
        const wanted = new Set([806401, 806402, 807408, 808415]);
        const input = fs.createReadStream(new URL('./fixtures/real-blocks.ndjson', import.meta.url));
        const lines = readline.createInterface({ input, crlfDelay: Infinity });
        let checked = 0;
        try {
            for await (const line of lines) {
                const {bitmap: id, tx} = JSON.parse(line);
                if (!wanted.has(id)) continue;
                await check(id, tx); checked++;
            }
        } finally { lines.close(); input.destroy(); }
        assert.equal(checked, 4);
        const records = [[10, 15, 1, 2], [], Array(48).fill(5)].map((tx, i) => encodeSizes(i, tx));
        await onmessage({ data: { protocol: 'parcel-worker-batch-v1', batchId: 7, records } });
        const batch = messages.pop();
        assert.equal(batch.protocol, 'parcel-worker-batch-v1'); assert.equal(batch.batchId, 7);
        for (let i = 0; i < records.length; i++) {
            const sizes = i === 0 ? [10,15,1,2] : i === 1 ? [] : Array(48).fill(5);
            const expected = new MondrianLayout(sizes).slots.flatMap(r => [r.x,r.y,r.width,r.height]);
            assert.deepEqual([...batch.results[i].rects], expected);
            assert.equal(batch.results[i].id, i);
        }
        // A bad zero-size parcel must report an error with its ID, not hang.
        await onmessage({ data: { protocol: 'parcel-worker-batch-v1', batchId: 9, records: [{id:999,txCount:1,tx:new Uint8Array([0]),rle:false}] } });
        assert.equal(messages[0].results[0].id, 999); assert.equal(typeof messages[0].results[0].error, 'string');messages.length=0;
        await onmessage({data:{protocol:'parcel-worker-wishes-v1',ids:[1]}});
        await onmessage({data:{protocol:'parcel-worker-batch-v1',batchId:10,records:[{id:0,txCount:1,tx:new Uint8Array([0]),rle:false},encodeSizes(1,[1])]}});
        assert.deepEqual(messages[0].results[0],{id:0,cancelled:true});assert.equal(messages[0].results[1].rects.length,4);
    } finally {
        if (previousSelf === undefined) delete globalThis.self;
        else globalThis.self = previousSelf;
    }
});

test('parcel worker batches cheap layouts, yields on a work budget and honors wishes at each yield',async()=>{
    const source=fs.readFileSync(new URL('../src/map/workers/neighborhoodBitmapWorker.ts',import.meta.url),'utf8');
    const compiled=transpiler.transformSync(source)
        .replaceAll('"@shared/MondrianLayout.ts"',JSON.stringify(await sharedModuleUrl('../../src/shared/MondrianLayout.ts')))
        .replaceAll('"@shared/httpPack"',JSON.stringify(await sharedModuleUrl('../../src/shared/httpPack.ts')));
    // Module-local scheduling controls test the real handler without changing
    // global timers or making assertions about machine speed.
    const fixture=`
        export const clock={value:0,step:0,yields:0,cancel:false};
        export const messages=[];
        export const self={postMessage:message=>messages.push(message)};
        const performance={now:()=>{const n=clock.value;clock.value+=clock.step;return n;}};
        const setTimeout=callback=>{clock.yields++;if(clock.cancel)self.onmessage({data:{protocol:'parcel-worker-wishes-v1',ids:[]}});queueMicrotask(callback);};
    `;
    const worker=await import('data:text/javascript;base64,'+Buffer.from(fixture+compiled).toString('base64'));
    const records=()=>Array.from({length:1024},(_,id)=>({id,txCount:1,rle:false,tx:new Uint8Array([16])}));
    const run=async batchId=>{
        worker.messages.length=0;worker.clock.yields=0;
        await worker.self.onmessage({data:{protocol:'parcel-worker-wishes-v1',ids:Array.from({length:1024},(_,id)=>id)}});
        await worker.self.onmessage({data:{protocol:'parcel-worker-batch-v1',batchId,records:records()}});
        assert.equal(worker.messages.length,1);assert.equal(worker.messages[0].batchId,batchId);
        return worker.messages[0].results;
    };
    const results=await run(1);
    assert.ok(worker.clock.yields>0&&worker.clock.yields<32,'Cheap records must not pay one timer delay each');
    assert.equal(results.length,1024);
    for(let id=0;id<results.length;id++){
        assert.equal(results[id].id,id);assert.equal(results[id].width,1);assert.equal(results[id].height,1);
        assert.deepEqual([...results[id].rects],[0,0,1,1]);
    }
    worker.clock.cancel=true;
    const cancelled=await run(2),completed=cancelled.filter(result=>result.rects);
    assert.ok(completed.length>0&&completed.length<128,'Updated wishes stop obsolete layouts after a bounded slice');
    assert.ok(cancelled.slice(completed.length).every(result=>result.cancelled===true));
    worker.clock.cancel=false;worker.clock.step=1;
    const budgeted=await run(3);
    assert.equal(budgeted.length,1024);
    assert.ok(worker.clock.yields>128&&worker.clock.yields<1024,'Time-consuming records yield before filling a count-based slice');
});
