# Data formats and offline tools

Unfiltered zoom-4 views additionally use optional `bitmap-lod4-aggregates-v2`.
`lod4-summary.json` binds a Protobuf index with direct immutable references to
mode-specific batches of up to six 16x16 neighborhoods, bounded at 20 KiB.
Each cell retains Float32 raw mean, weight and coverage. Scalar filters keep the
original membership addon. Parcel size filters use `parcel-spatial-filters-v1`,
with exact mask/count metadata and independent viewport-selected range grids. See [LOD4](lod4.md) and
`src/shared/lod4Aggregates.ts` for the versioned contract and validation.

The distributed dataset uses `bitmap-http-protobuf-v9`,
`manifestEncoding: bitmap-manifest-json-v1` and `storageLayout: typed-protobuf-v2`.
These are wire/cache contract identifiers, independent of the application release.

| Content | Format | Directory |
| --- | --- | --- |
| Main manifest and addon roots | JSON | `map-data/` root |
| Canonical neighborhood geometry | Protobuf | `geometry/` |
| Ordered width/height pairs | Protobuf | `dimensions/` |
| Spatial parcel index pages | Protobuf | `parcel-index/` |
| Transaction packs | Protobuf | `parcels/` |
| Area preview index and tiles | Protobuf | `previews/` |
| Parcel-size preview index and tiles | Protobuf | `parcel-previews/` |
| Bitmap vector chunks and pages | Protobuf | `bitmap-chunks/` |
| Parcel-size means | Protobuf | `colors/` |
| Offline reference patterns | Protobuf with `bitmap-reference.json` root | `map-data/` root |

## Integrity

`src/shared/mapManifest.ts` hashes canonical JSON without its `snapshot` field.
Object keys are sorted, arrays preserve order and numbers must be finite.
Whitespace and key ordering in the file do not change the revision. The reader
limits the root to 1 MiB and validates normalized fields, URLs, identity,
dimensions, pages and coverage. Invalid hashes, extra fields and unknown
contracts are rejected. The root does not list every pack member.

Files carry SHA-256 and byte counts. Parsers validate framing, membership,
transaction counts and EOF before accepting complete coverage. Streaming can
release individually authenticated records before the whole response completes.
Cancellation retains only authenticated cache entries.

Schemas and checked-in runtime descriptors live in `src/shared/proto/`:

- `map_snapshot.proto`: parcel packs, index pages and snapshot metadata.
- `neighborhood_dimensions.proto`: ordered dimensions for client layout.
- `map_addons.proto`: bitmap chunks/pages and parcel means.
- `heatmap_preview.proto`: preview indices and tiles.
- `map_analytics.proto`: optional snapshot-bound scalar metrics and bitmap inspection summaries; see [analytics](analytics.md).
- `neighborhood_descriptor.json`: canonical neighborhood geometry.
- `bitmap_reference.proto`: optional pattern IDs for offline database restoration.
  Maintenance tools load this schema directly; it has no duplicate runtime descriptor.

Keep field numbers and types compatible. Regenerate a descriptor when its schema
changes; tests compare the active schema with its descriptor.

## Transaction encoding

`src/shared/txHuffmanRleModel.json` contains the frozen model
`tx-huffman-rle-v1-840k-20261029`. Encoding 4 uses Huffman/RLE; each bitmap selects
the smallest payload among Huffman/RLE, raw4 and RLE4. Unseen runs use an escape;
sizes 10–15 use existing encodings. New blocks reuse the model without training.
Never replace the table under the same identifier.

`httpPack.ts` and `protobufChunks.ts` also read the intermediate/export formats
used by the offline pipeline. Their regression tests remain relevant even though
the distributed dataset is v9. Flat storage, `typed-directories-v1`, binary
manifest roots and v1 `.nbc`/`.means` addons have readers. Missing-entry fallback
must not hide corruption. Manifests containing removed implementation metadata
are rejected.

## Bitmap chunks and summaries

`neighborhood-chunks.json` authenticates pages of 8×8 owner cells. The grid uses
origin (0,0) and top-left ownership: `floor(worldX / size), floor(worldY / size)`.
Its side is ten times the parcel grid side (10,240 versus 1,024 in the bundled
dataset). A chunk may mix neighborhoods; records crossing a cell boundary remain
owned once. Queries include adjacent owners according to maximum bitmap size.

`neighborhood-bitmap-chunks-v2-protobuf` uses packed Uint32 IDs/dimensions and
double coordinates. Generation reads canonical geometry without recalculating
Mondrian; build validation compares all identities, owners and coverage.

`parcel-colors.json` authenticates `parcel-size-means-v2-protobuf`: packed
Float32 means in block-height order. Means average parcel side lengths, not
areas. Preview pixels weight bitmap means by intersected area; neighborhoods
average their bitmap means. CPU values and the R32F GPU texture are additional
memory beyond parcel instance attributes. `bitmap-area-colors.json` stores
snapshot-wide maximum area and neighborhood area means.

## Tools

The standard command is `bun run map:generate`. It asks whether to continue or rebuild
from scratch. `--mode continue` and `--mode restart` select the same modes in CI.
Continuing reads `publishedHeight` and the last neighborhood from the manifest,
compares them with scalar database height/count metadata, and appends only new
complete neighborhoods. It trusts the published prefix without auditing old packs
or scanning historical transaction lists. With no new complete neighborhood, it
exits without generating files or reading the payloads. With 2,000 new bitmaps it
reports 16 missing and waits until all 2,016 exist. Existing parcel packs are copied;
shared spatial chunks merge their old Protobuf records with new database rows.
Previews, bitmap vector indexes and color summaries are refreshed for the new root.
Rebuilding starts a separate
revision and reruns every stage; it never deletes the database or its AWS state.
Revisions rebuild transport packs and previews while preserving existing canonical
neighborhood geometry. When no geometry exists, it is created from ordered DB sizes.

The command owns a generation lock and the database sync lock. Its working files
live under the Git-ignored `.tmp/generation-*` directory. It validates the staged
dataset, replaces `public/map-data` with rollback and a recovery journal, and
deletes its temporary files after success or failure, including the previous
dataset after a successful replacement. Failure details are printed before the
temporary log is removed. An interrupted replacement is recovered on the next run.
Building/deploying remains a separate operation.

For continuation, `prepare-pages --validate-only --baseline=MAP_DATA` validates
the changed dataset against its exact published source snapshot. It requires
unchanged historical regions and matching format/layout/codec/grid contracts.
All parcel index memberships, global coverage and owner cells are checked.
Inherited immutable payloads retain their descriptors and receive file
existence/length checks; their historical bytes are trusted rather than decoded
again. Changed packs, bitmap chunks and preview tiles are authenticated and
decoded; new neighborhood dimensions are recomputed and checked against canonical
geometry. Changed bitmap chunks resolve retained canonical rectangles on demand.
Reference metadata and color summaries are validated for the new root as well.
The baseline option is rejected for publication. Full rebuild and explicit
`build --validation full` audits validate all payloads and neighborhood layouts,
including historical file corruption. Normal native builds verify references,
lengths and hashes while copying, without rerunning semantic data calculations.

The public manifest is the continuation cursor; no extra fingerprint/progress
sidecar or maintenance cache is needed. Historical corrections require rebuild
mode. Interrupted attempts restart unfinished work from that published cursor;
the standard command keeps no persistent generation cache or database file stamps.
The advanced `bun scripts/generate-static.ts --resume true` tool still supports explicitly
requested maintenance revisions independently of this temporary workflow.

Generation progress is streamed from the actual writers and validators to the
terminal. Neighborhood geometry/dimensions report each neighborhood ID as it is
created, reused or verified. Parcel chunks, compression, bitmap vector chunks,
file organization and validation report monotonic unique bitmap counts, completed
chunks/packs and completed neighborhoods for their own phase. A neighborhood is
announced complete only after all 2,016 of its bitmaps have finished that phase.
The highest encountered block height is not a completion cursor: spatial order
can leave earlier blocks unfinished. IDs are displayed separately as identities.
Preview tiles report per-level totals; resumed stages are explicitly marked as
reused. Full stdout/stderr remain in `generation.log`, including on failure.

All immutable filenames are deterministic SHA-256 hashes of their exact content.
Canonical block/transaction order, fixed shuffle seed and the frozen Huffman model
ensure repeated generation from the same rows produces identical names and bytes.
Work paths, clocks, source database paths and checkpoint IDs only occur in local
reports/checkpoints, never in Protobuf payloads. Tests compare complete outputs
from different database paths and independent work directories.

Static-map converters require new destinations and preserve their input. Their
source databases are opened READ_ONLY, and generated revisions belong in
`.cache/maintenance/`. The separate [AWS bitmap importer](aws-bitmap-sync.md)
updates its own DuckDB reference under `data/db/` and deletes processed temporary
Parquet files only after commit.

```sh
bun scripts/generate-static.ts --out .cache/maintenance/NEW_REVISION
bun scripts/tools/export-http-packs.ts --out .cache/maintenance/EXPORT --regions all --format v2 --validation grid
bun scripts/prepare-huffman-rle.ts --source MAP_DATA --out .cache/maintenance/HUFFMAN
bun scripts/organize-map-data.ts --source MAP_DATA --out .cache/maintenance/ORGANIZED
bun scripts/data-stats.ts
```

`bun scripts/generate-static.ts` reads `data/db/bitmaps.db` with DuckDB READ_ONLY. `--db FILE`
overrides `DB_BITMAP` from `.env`, which overrides that default. Both the parcel
export and color summary exporter receive the same resolved database path.
Stop AWS sync before generation so the source remains stable across stages.

The source `bitmaps` table supplies `bitmap`, ordered `tx` arrays and occupied
`size` pairs. `pattern` is exported separately for database restoration; AWS
auxiliary tables are not included in the distributed data.
For existing neighborhoods, the exporter copies authenticated geometry bytes and
compares every selected bitmap's `size` with its canonical width/height. Grid
validation checks parcel bounds and transport round-trips without recomputing
parcel layouts. `bun scripts/tools/export-http-packs.ts --validation exact` additionally recomputes their
occupied Mondrian bounds. `--grid-db FILE` remains an optional comparison with
an older width/height database; it is not needed for generation.

New complete neighborhoods are packed from ordered `size` pairs using the shared
Mondrian implementation. Appending requires a complete reference prefix from
block 0; gaps fail explicitly. Existing neighborhoods are never repacked.
The incomplete final neighborhood is excluded and recorded in `report.json`;
its rows remain in the source database. The result creates spatial packs,
dimensions, previews and addons, and finishes as JSON manifest v9 with
`typed-protobuf-v2` storage and the unchanged frozen Huffman model.

`--regions IDS` restricts parcel coverage while retaining all neighborhood
geometry. `--source EXPORT` accepts a validated export instead of reading
transactions from the database. Database-based generation recalculates parcel
means and previews by default; `--colors-from MAP_DATA` explicitly reuses
compatible summaries and `--colors-from none` omits them. With `--source EXPORT`,
the default still reuses public summaries so that conversion needs no database;
use `--colors-from database --db FILE` to recalculate them.
`--resume true` resumes a matching `bun scripts/generate-static.ts` output directory; changed
inputs are rejected. Incomplete stage output is retained under that revision
before the stage is retried. The interactive command chooses paths automatically.

## Restore a database from distributed Protobufs

`bun run db:sync` automatically restores a missing/empty database from complete
`public/map-data` coverage before reading newer AWS rows. `bun scripts/restore-bitmaps.ts`
performs only the restore. Readers authenticate every artifact, reject duplicate
or missing IDs and preserve TX index order and canonical occupied dimensions.
Insertion is transactional and storage is reordered by block height after the
spatial pack traversal. Decoded batches are bounded independently of pack compression.

`bitmap-reference.json` identifies `bitmap-reference-protobuf-v1`, its source
manifest snapshot, bitmap count and a SHA-256/byte-counted Protobuf reference.
The `Reference` message contains version 1, the source snapshot and packed Uint32
pattern IDs in block-height order. It contains no date or machine metadata.
Each pattern points to its own representative at or before the bitmap's height.
This optional offline addon leaves the map v9 / typed-protobuf-v2 contracts intact.
Build validation verifies and includes it when present. Older snapshots reconstruct
exact geometry equivalence from TX arrays before committing the restored baseline.

The AWS continuation boundary is resolved once from public block metadata or an
explicit `bun scripts/restore-bitmaps.ts --from YYYY-MM-DD`; it is stored locally in DuckDB settings.
See [AWS restoration](aws-bitmap-sync.md#fresh-checkout-restore-protobufs-then-continue-with-aws).

`bun scripts/organize-map-data.ts` verifies source payloads and converts storage/addons, writing the
manifest last. It preserves geometry, transaction order, packs and preview pixels.
Intermediate tools under `scripts/tools/` support the full pipeline and tests.
Huffman training utilities are offline research tools; running the application
or adding blocks does not invoke them.

## Decode a Bitcoin block

`scripts/decode-block.ts` is a standalone inspection tool. By default it fetches
block 840000 from `https://ordinals.com/r/block/840000`. The
[Ordinals endpoint](https://docs.ordinals.com/inscriptions/recursion.html) returns
a JSON string containing serialized block hex.

```sh
bun scripts/decode-block.ts --out .cache/maintenance/block-840000.json
bun scripts/decode-block.ts --block 840001 --out .cache/maintenance/block-840001.json
bun scripts/decode-block.ts --input /tmp/block.hex --out /tmp/decoded-block.json
```

`--block` accepts a height or block hash. `--url URL` selects another endpoint
returning the same JSON-string or plain-hex format. `--input FILE` accepts saved
plain hex or the saved Ordinals response. Without `--out`, JSON goes to stdout;
existing output files are never overwritten.

Output includes the block header/hash, ordered transactions, TXIDs/WTXIDs,
inputs, outputs, scripts and witness stacks. Output values use exact decimal
satoshi strings. Sizes, stripped sizes, weights and transaction virtual sizes
follow [BIP 141](https://github.com/bitcoin/bips/blob/master/bip-0141.mediawiki).
The parser checks canonical CompactSize encoding, truncation, trailing bytes,
resource limits and the transaction Merkle root. This is not full consensus
validation: proof of work, witness commitments, scripts and UTXOs are not checked.
The tool does not modify databases or the published map dataset.

## DuckDB bitmap reference

[The AWS importer](aws-bitmap-sync.md) reconstructs `bitmap`, `tx`, `size` and
`pattern` in `data/db/bitmaps.db`, with auxiliary sync/pattern tables in the
same DuckDB file. `tx` is `UTINYINT[]`, `size` is `UINTEGER[]`, and `bitmap` is a
`UINTEGER` primary key. `pattern` is `BIGINT`; temporary negative group IDs exist
only inside a transaction. Block heights and transaction positions stay unchanged.
The format identity is `bitmap-reference-duckdb-v1`, with one geometry hash per
pattern and height ranges once per daily partition. There is no per-bitmap sync
metadata or persisted block hash. Earlier SQLite files are not migrated; start
with a fresh generated database. Parcel and geometry-hash rules have explicit
stored identities. This is independent of the published map's transport formats.

Optional `seed_height`, `seed_from_date` and `seed_source` settings identify a
trusted imported prefix. `seed_patterns(first_bitmap,fingerprint)` stores one
candidate per imported pattern, indexed by a stable 64-bit MD5-derived signature
of dimensions and sorted parcel counts. Candidates are compared using the full
geometry SHA-256 before reuse; a signature collision cannot merge patterns.
Resolved candidates move into `patterns`. No seed metadata is repeated per bitmap.


## Zoom-4 spatial addon

`bitmap-lod4-spatial-cells-v1` uses its own `lod4.pb` root and lazy hashed
Protobuf region pages. It stores canonical integer cell intersections and bitmap
associations, independently of palettes and metrics. Generate new offline bundles
with `bun scripts/generate-lod4.ts --source MAP_DATA --out NEW_MAINTENANCE_DIRECTORY`.
Install with `bun scripts/install-lod4.ts --source MAP_DATA --bundle BUNDLE`.
Optional `lod4.json` discovery identifies the hashed `lod4/<sha256>.pb` root,
which authenticates `lod4/regions/<sha256>.pb` pages. The runtime loads these
lazily near stop 4; a missing addon retains regional summaries. Standard generation
and static builds include the addon without changing the canonical v9 contract.
See [LOD4 format, runtime and validation](lod4.md).


## Immutable release and streaming addons

[Immutable releases](immutable-releases.md) pin JSON v9 and every addon root via
`bitmap-immutable-release-v1` / `semantic-aliases-v1`, preserving old URLs and
payload encodings. Root/discovery bindings and routing identities participate in
the release hash. Coordinate/band/hash physical names use declared fixed world
grids, not viewport coordinates. This does not alter the frozen Huffman table.

New parcel spatial pages use independently versioned Protobuf page 10: the height
field is the maximum local chunk height, bounded by the root's published height.
Pages 8/9 remain readable. New packs partition a cell by fixed 2,016-block bands
under `cell-neighborhood-shuffle-v1`; their v9 wire encoding stays unchanged.

`spatial-metrics-v1-protobuf` in `metrics.json` references
`metrics/values/nNNNNNN.<sha>.pb` pages with local transaction counts, diversity,
occupancy and nine class counts. Metadata includes unfiltered exact area-weighted
regional parcel means. Pages omit snapshot and global recurrence, preserving
historical identity on append. `spatial_metrics.proto` defines their wire schema
and inverted pattern buckets. Explicit global filters still use authenticated
global arrays; local/missing pages never change exact global statistics.

`inspection-local-v2` uses AnalyticsRegion version 2 with an empty occurrence
column. Its `analytics.json` root binds inverted pattern pages for exact current
occurrences and matches. Legacy version 1 inspection remains readable.
New bitmap-vector roots declare `bitmap-owner-grid-v1-2048`; cells retain top-left
ownership, exact coordinates/dimensions and conservative incoming-owner proofs.
Earlier grid roots and payloads remain readable and retained during publication.


## Native semantic source

`public/map-data/release.json` declares `bitmap-semantic-dataset-v1` and references
one authenticated `releases/<sha>.json` descriptor. All actual files live under
`bitmaps`, `parcels`, `neighborhoods`, `metrics`, `manifests`, `routing` and
`releases`; there are no legacy physical aliases in the active source.
The canonical logical v9 / typed-protobuf-v2 wire format remains unchanged.
Both the runtime and offline tools resolve its references through authenticated
routing shards. Conversion preserves every selected payload byte and canonical
snapshot; new source versions retain existing immutable history.

`map:generate` emits this source format, including a format-only migration in
continue mode when no new complete neighborhood exists. `scripts/migrate-map-data.ts` converts
an existing dataset without database access or layout regeneration. Native addon
installs preserve the format. The legacy source tree is archived on initial
installation; only temporary validated staging is cleaned automatically.
