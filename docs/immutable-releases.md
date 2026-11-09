# Immutable map releases

`bitmap-immutable-release-v1` is the immutable data envelope over the existing JSON v9
manifest, typed Protobuf payloads and independently versioned addons. It does not
change canonical geometry, layout, block/transaction identity or the frozen TX
codec. The physical naming/routing version is `semantic-aliases-v1`.

A release descriptor at `releases/<full-sha256>.json` contains the canonical
snapshot, storage version, declared world grid sizes, exact immutable root
bindings, and up to 256 content-hashed routing shard references. Its ID hashes
canonical JSON bytes including every referenced root and routing identity.
Changing only an addon therefore changes the release ID. Roots such as
`manifest.json`, `analytics.json`, `metrics.json`, preview indices and discovery
are bound to immutable files. The HTML's `bitmap-release` meta tag chooses one
release; the data source pins it for its entire lifetime. There is no latest
pointer inside the authenticated descriptor.

Immutable payloads have readable semantic paths where identity information is
available:

```text
releases/<release-sha>.json
manifests/manifest.<sha>.json
routing/ab.<sha>.json
neighborhoods/geometry/n000320.<sha>.pb
neighborhoods/dimensions/n000320.<sha>.pb
bitmaps/summaries/index.<sha>.pb
bitmaps/summaries/n000320.<sha>.pb
bitmaps/index/x-0001_y+0002.<sha>.pb
bitmaps/chunks/x-0004_y+0017.<sha>.pb
parcels/index/x-0006_y+0002.<sha>.pb
parcels/chunks/x-0042_y+0017_n000320_p000.<sha>.pb
metrics/values/n000320.<sha>.pb
metrics/inspection/n000320.<sha>.pb
metrics/patterns/b0003.<sha>.pb
metrics/global/count-values.<sha>.pb
```

Coordinates are signed fixed world-cell indices, using `floor(world / size)`.
Padding never truncates values. Parcel chunks use the manifest's 1,024-unit grid;
new bitmap vectors declare the 2,048-unit grid. Spatial index coordinates refer to
pages of eight cells per axis. Summary grids retain their existing local cell
contract. Parcel parts belong to a fixed cell and neighborhood band; their local
part ordinal resets for each band. Root hashes bind all grid/schema versions.
Older bitmap chunks spanning neighborhoods retain their coordinate/hash identity;
publication does not repack them to invent a band ID.

## Current dataset publication

Protobuf File messages retain hash/size references. Authenticated routing shards
map those logical URLs to physical semantic URLs. A shard is selected by the
first two hex digits of a requested content hash and authenticated before use.
Opening does not load every shard or parcel index member. Original content
hashes still authenticate each decoded response.

`bun run build` compiles the application, checks the selected native dataset's
metadata and authenticates each file's declared size and SHA-256 while copying
its current selector, release descriptor, root metadata, routing
shards and referenced payloads into a fresh staging tree. Each selected file
keeps its source path and bytes. The HTML pins that same descriptor. Copies are
independent of source files, so editing disposable output cannot modify public
data.

Routine builds do not rerun canonical packing, decode every transaction or
recalculate every analytical filter. These deep checks remain in generation and
`bun run build --validation full`. The existing `prepare-pages.ts --validate-only`
audit also retains deep validation. Explicit intermediate legacy inputs continue
to use deep validation because they do not have a native authenticated file graph.
`build-info.json` records the actual `validation` mode as `integrity` or `full`.

The build does not merge maintenance caches, earlier build output or other
source releases. It creates no duplicate migration aliases. Git manages source
version history. There is no build release store or `--store` option. Source
history can still exist for offline maintenance; it is not part of the published
site unless referenced by the active descriptor.

After validation, the prepared site replaces `dist`. The previous site exists
only temporarily for rollback and is removed after a successful replacement.
Failures preserve the previous site and build counter. Every deployment replaces
the published snapshot; reload an open map to select the deployed release.

Use `bun run build --base /REPOSITORY/ --max-bytes 1000000000` for Pages. The manual
workflow uses this total-size check, including build metadata and optional gzip
copies, before output replacement. Publish the entire resulting `dist`.

`public/map-data` now uses the same semantic paths directly. Its small mutable
`release.json` selector declares `bitmap-semantic-dataset-v1` and authenticates one
immutable descriptor. `bun dev` discovers that selector and pins it for the map
session; it reads no build output or maintenance database. After the first
migration, reload any already-open legacy dev page. Subsequent native source
updates retain old semantic files, so pinned native sessions keep their URLs.

The canonical manifest's `typed-protobuf-v2` references describe the logical
Protobuf contract. They are resolved by authenticated shards, not implemented
as old folders or duplicate aliases on disk. `dataset-path.ts` exposes the same
resolution to offline readers; it verifies metadata/routing hashes, bounds decoded
routing memory and detects changes to the source selector. Canonical bytes,
coordinates, IDs and cache identities do not change during physical conversion.

`bun run map:generate` converts its validated output to native paths before
installing it. Continue mode also migrates an old physical layout when there are
no new complete neighborhoods. Already-native no-op runs still read no payloads.
Immutable native history is retained through subsequent generation. The original
legacy tree is moved intact into `.cache/maintenance/map-data-history` during its
first migration; it is not removed as cleanup. Existing interrupted staging trees
are left untouched.

To migrate a current dataset immediately without regenerating it or building:

```sh
bun scripts/migrate-map-data.ts --source public/map-data --install true
bun dev
```

A separate new output is supported with `--out NEW_DIRECTORY`. Addon installers
use an isolated intermediate view and atomically republish native paths, keeping
old semantic releases. Conversion and installation share the generation lock,
validate before replacement, and preserve rollback/recovery journals.

The standalone `bun scripts/publish-release.ts --source MAP_DATA --store STORE` command is
for publication input; it performs full canonical validation first. The normal
build validates and copies current data directly without invoking this tool. All target files are created exclusively; existing identical
bytes are reused and any conflicting existing bytes fail. A release descriptor
is created only after its dependencies. Complete retries are idempotent; an
incomplete/corrupted existing file is reported as a conflict, never overwritten.

The optional static server and Vite map middleware give full-hash URLs immutable
caching and ETags. Mutable workspace discovery uses revalidation. Additional
precompressed files are disabled by default. `--precompress true` adds gzip
variants with fixed level 9, zero timestamp and OS byte 255; build-info records
the zlib encoder identity; the optional server selects them using
Accept-Encoding. This does not configure GitHub Pages/CDN compression or establish
hosted headers, browser quota, GPU memory or physical-device throughput.
