import { check, integer, type FileRef } from './httpPack';
/** Physical source format, independent of the canonical v9 logical manifest. */
export const DATASET_REFERENCE_FORMAT='bitmap-semantic-dataset-v1';
export type DatasetReference={format:typeof DATASET_REFERENCE_FORMAT;release:FileRef};
export function validateDatasetReference(value:DatasetReference):DatasetReference{
    const ref=value?.release;
    check(value?.format===DATASET_REFERENCE_FORMAT&&ref&&/^[a-f0-9]{64}$/.test(ref.sha256)&&ref.url===`releases/${ref.sha256}.json`&&integer(ref.bytes,1,256*1024),'Invalid semantic dataset reference');
    return value;
}
