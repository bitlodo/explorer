import {sha256 as digest} from '@noble/hashes/sha2.js';
import {bytesToHex} from '@noble/hashes/utils.js';
import {sha256} from '../shared/httpPack';

/** Same SHA-256. Avoid a native async operation for every tiny authenticated record. */
export function frameHash(bytes:Uint8Array):string|Promise<string>{
    return bytes.length<=16384?bytesToHex(digest(bytes)):sha256(bytes);
}
