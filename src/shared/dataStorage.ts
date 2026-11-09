/** Versioned distribution layout; canonical geometry and transaction pack encodings stay unchanged. */
export const DATA_STORAGE = 'typed-protobuf-v2';
export const DIRECTORY_STORAGE = 'typed-directories-v1';
export type DataKind = 'geometry' | 'dimensions' | 'parcel-index' | 'parcels' | 'previews' | 'parcel-previews' | 'bitmap-chunks' | 'colors';
export function dataPath(storage: string | undefined, kind: DataKind, name: string): string {
    if (storage && storage !== DATA_STORAGE && storage !== DIRECTORY_STORAGE) throw Error('Unsupported map data storage layout');
    if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(name) || name.includes('..')) throw Error('Invalid data filename');
    return storage ? `${kind}/${name}` : name;
}
export function validArtifactPath(url: string, hash: string): boolean {
    return /^[a-f0-9]{64}$/.test(hash) && /^(?:(?:geometry|dimensions|parcel-index|parcels|previews|parcel-previews|bitmap-chunks|colors)\/)?[a-f0-9]{64}\.(pb|nbc|means|json|bin)$/.test(url)
        && url.split('/').at(-1)!.startsWith(hash + '.');
}
