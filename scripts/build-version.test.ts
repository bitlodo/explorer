import {test,expect} from 'bun:test';
import {mkdtemp,rm,readdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {reserveBuildVersion} from './build-version';

test('build versions increment only after commit and concurrent builds cannot reserve the same number',async()=>{
    const root=await mkdtemp('/tmp/bitmap-build-version-'),file=resolve(root,'version.json');
    try{
        let reserved=await reserveBuildVersion(file);
        expect(reserved.next.version).toBe(1);expect(Number.isFinite(Date.parse(reserved.next.builtAt!))).toBe(true);
        await expect(reserveBuildVersion(file)).rejects.toThrow('Another site build');
        await reserved.commit();await reserved.release();
        expect((await Bun.file(file).json()).version).toBe(1);
        reserved=await reserveBuildVersion(file);expect(reserved.next.version).toBe(2);await reserved.release();
        expect((await Bun.file(file).json()).version).toBe(1);
        reserved=await reserveBuildVersion(file);expect(reserved.next.version).toBe(2);await reserved.commit();await reserved.release();
        expect((await Bun.file(file).json()).version).toBe(2);expect(await readdir(root)).toEqual(['version.json']);
    }finally{await rm(root,{recursive:true,force:true});}
});
