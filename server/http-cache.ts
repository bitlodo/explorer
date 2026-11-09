/** Mutable discovery validates on each use; content-hash URLs never change. */
export function artifactHeaders(path:string,size:number,modified:number,encoding?:string){
    const hash=path.match(/([a-f0-9]{64})\.(?:json|pb|nbc|bin|means)$/)?.[1];
    const immutable=/(?:^|[./])[a-f0-9]{64}\.(?:json|pb|bin|nbc|means)$/.test(path)||/\/assets\/.+-[\w-]{8,}\./.test(path);
    return {
        'Cache-Control':immutable?'public, max-age=31536000, immutable':'no-cache',
        ETag:hash?`"${hash}${encoding?'-'+encoding:''}"`:`W/"${size}-${Math.trunc(modified)}${encoding?'-'+encoding:''}"`,
        Vary:'Accept-Encoding',
    };
}
