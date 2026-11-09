# Zoom-4 spatial LOD addon

## Precomputed 16x16 overview

Unfiltered Bitmap Area, Transactions, Size diversity, Occupancy and Parcel size
use `bitmap-lod4-aggregates-v2`. The grid remains 16x16. Each mode has independent
Protobuf batches of up to six nearby neighborhoods, ordered by the Morton codes
of their Tight v3 centers. Each batch is bounded at 20 KiB. Selecting a mode does
not download batches belonging to other modes.

`lod4-summary.json` authenticates a Protobuf index containing direct immutable
`bitmaps/summaries/aggregates/<mode>/tNNNN.<hash>.pb` references. These references
need no release-routing downloads. The index binds canonical geometry hashes,
local metric hashes, region dimensions and complete per-mode batch membership.
Invalid or corrupted v2 data fails explicitly. Releases without the optional
v2 root retain the original v1 path described below.

Each cell stores its raw-value mean, aggregation weight and occupied coverage
as Float32 values. Scalar weights retain the original overlap/bitmap-area rule;
Parcel size retains occupied-area weights and the existing per-bitmap Float32
side means. Coarser screen groupings merge weighted raw means before normalization.
Palettes remain editable. These display aggregates do not replace exact global
statistics or bitmap membership. Scalar filters lazily use the v1 membership
pages and existing exact metric arrays. Parcel size filters use the spatial
filter addon below. Reset returns to retained aggregates.

At stop 4, unfiltered modes do not request `metrics/values` bitmap pages. Those
pages begin when approaching the vector band. Discovery still waits for stop 4;
the four-request limit, cancellation, 600 ms arrivals, parent coverage, linear
4-to-3 handoff and resident reverse zoom are retained. Numeric aggregate residency
is bounded at 8 MiB, excluding JS/GPU overhead; payload caches use 8 MiB memory
and 16 MiB persistent storage in `http-lod4-aggregates-v2`.

Standard generation includes both v2 aggregates and v1 exact-filter support.
To add aggregates to an existing dataset without rebuilding geometry, use a new
output directory:

```sh
bun scripts/generate-lod4-summaries.ts --source public/map-data --out .cache/maintenance/NEW_SUMMARIES --install true
bun dev
```

Installation validates each batch against authenticated geometry and metric
pages, retains previous immutable releases, and replaces discovery atomically.
Build validation repeats the comparison; incremental validation may reuse
unchanged batches only when their geometry and metric bindings match its baseline.

For snapshot `a6552d4952ffe1f0c2ad54beccd82763c30b51d6e2a20e248dec9703376f45a3`,
the installed v2 bundle has 81 batches per mode. Bitmap Area batches total
1,496,533 bytes, ranging from 9,301 to 18,592 bytes. The shared index is
153,248 bytes. The old membership pages total 7,244,415 bytes in 483 files,
with up to 3,769,747 additional bytes in 219 routing shards for a complete cold
traversal. These are uncompressed artifact sizes, excluding HTTP headers and
unrelated application metadata. They are not hosted transfer or latency measurements.

## Spatial Parcel size filters

`parcel-spatial-filters-v1` replaces the global class-array download for every
Parcel size range. `parcel-filters.json` authenticates a compact Protobuf metadata
file containing nine class counts per neighborhood and a 512-entry global
histogram of bitmap class-presence masks. These statistics give exact bitmap
counts, parcel counts, selected/total occupied areas, regional means and regional
shares for all 45 contiguous ranges, without per-bitmap class arrays.

Each of the 44 filtered ranges has a small independent Protobuf index, requested
only when that range is active at stop 4 or closer. Its direct references select
six-neighborhood batches only where they intersect the actual viewport. Each
16x16 cell stores the selected mean and selected occupied-area weight. The
unfiltered size grid supplies total weights and coverage, preserving the existing
mean/share calculation and independently merged screen axes. Replaced slider
ranges cancel their consumers; a range never starts a whole-map download.
Exact regional class totals also certify no-match neighborhoods, which render
neutral with the existing coverage and request no filtered cell data.

The source snapshot above has 18,978 bytes of filter metadata. Batches contain
at most 12,368 bytes; the complete 7–9 range has 81 batches and 995,500 bytes,
but navigation requests only batches serving the current frustum. Every filter
file is bounded at 100 KiB; cell batches have a stricter 20 KiB limit. Decoded
filtered grids have a separate 8 MiB numeric budget. Payload caching uses
4 MiB memory / 64 MiB disk in `http-parcel-spatial-filters-v1`.

Closer bitmap vectors use authenticated local metric pages. Range changes
recompute only resident pages and request missing visible pages; sparse unknown
values retain the loading color. Global totals continue to come from the exact
metadata. The global parcel class file is retained for offline/export readers
and old releases, and is not used by interactive Parcel size filtering.

Standard generation includes this addon. To install it separately on a dataset
that already has the unfiltered aggregate addon:

```sh
bun scripts/generate-parcel-filters.ts --source public/map-data --out .cache/maintenance/NEW_PARCEL_FILTERS --install true
```

Installation and full publication validation rebuild masks, totals and every
grid from authenticated geometry and local classes. Incremental validation can
reuse unchanged regions and batches only when their input hashes match.

## Exact membership addon

`bitmap-lod4-spatial-cells-v1` is a standalone, palette-independent Protobuf
addon derived from authenticated canonical neighborhood geometry. It does not
change manifest v9, layouts, bitmap IDs, coordinates, dimensions, parcel packs
or existing cache identities. The analytical renderer consumes it lazily near
zoom stop 4, between whole-neighborhood summaries and exact bitmap vectors.
Generation is read-only with respect to the source dataset and all databases.

## Generate and validate

Use a new output directory outside the source dataset. New offline output belongs
under `.cache/maintenance`; generation refuses existing destinations, source
ancestors/descendants and symlink aliases into the source.

```sh
bun scripts/generate-lod4.ts --source public/map-data --out .cache/maintenance/NEW_LOD4
bun scripts/validate-lod4.ts --source public/map-data --bundle .cache/maintenance/NEW_LOD4
bun scripts/install-lod4.ts --source public/map-data --bundle .cache/maintenance/NEW_LOD4
```

The generator writes:

- `lod4.pb`: small versioned root index, source snapshot, grid side, bitmap count,
  and ordered page references with hashes, sizes and canonical geometry hashes.
- `regions/<sha256>.pb`: one immutable page per neighborhood, suitable for lazy
  HTTP requests. Local coordinates are independent of global map projection.
- `lod4-report.json`: validation results, root hash and measured payload sizes.

Pages are completed and validated before the discoverable root is written.
The validator checks every hash and rebuilds every page from canonical geometry.
A changed source snapshot requires a new root. Unchanged pages remain identical
because their identity depends on local geometry rather than the global snapshot.
Generation and validation do not install or publish anything. Installation first
validates the bundle, copies immutable files under `MAP_DATA/lod4/`, then atomically
writes `lod4.json`. It preserves canonical payloads. The offline bundle needs both
the root and its sibling `regions/` directory.

`map:generate` and updates with analytics include generation and installation in
their existing staging pipeline. Reorganization preserves pages and rebinds the
root when the source snapshot changes. Static builds validate, copy and publish
the addon with the dataset; full validation rebuilds its canonical associations.

## Runtime integration

`StaticHttpDataSource` reads optional `lod4.json` only on demand. A missing addon
retains whole-neighborhood summaries. Invalid hashes, snapshots or geometry
identities fail explicitly. The discovery authenticates the hashed Protobuf root;
the root authenticates each page. This is content integrity, not a digital signature.

`SpatialLod4Layer` serves Bitmap Area, Transactions, Size diversity, Occupancy and
Parcel size using the existing palettes and filter rules. Original-value means
and exact matching shares are recomputed on filter changes. Parcel occupied areas
are returned once by the analysis worker and reused for subsequent filters.

The opening stop 5 requests no addon files. Discovery and page requests are gated
by actual camera distance: they begin only at stop 4 or closer, independently of
the visual blend. A tiny floating-point blend at stop 5 cannot start downloads.
Resident cells blend continuously between stops 5 and 4 without new requests;
the first visit to stop 4 retains the regional summary until pages arrive.
Cells retain the existing linear preview/vector handoff at 4↔3. New
pages fade in over 600 ms; resident pages retain their arrival time through pan.
The cell layer replaces its parent summary without overlaying a second opaque
color. All cells share the parent inset, avoiding artificial internal outlines.
Empty cells remain empty; partial coverage modulates opacity rather than inventing
exact bitmap boundaries. Exact vectors remain responsible for close geometry.

Requests are limited to four and selected across the actual visible frustum at
the current canvas resolution, when at stop 4 or closer. Fully arrived exact
geometry starts no new LOD4 requests. There is no nearest-64-region cutoff.
Uint32 arrays retain up to 24 MiB of decoded numeric payloads; this excludes JS,
Three.js and driver overhead. The format itself permits at most 521 regions.
Projected cell size independently chooses nested 1–16 subdivisions per axis;
resizing or changing aspect ratio refreshes selection and grouping. Offscreen
pages are evicted first. If an exceptional dataset exceeds the byte budget even
within the visible frustum, deferred regions retain their summaries without a
repeated download/eviction loop. The
separate payload cache uses 512 KiB of memory and 16 MiB of persistent storage.
Settled frames update uniforms without uploading unchanged instance attributes.

## Wire contract

The schema is `src/shared/proto/lod4.proto`; the generated JSON descriptor is
checked against it by an independent schema/wire regression. Shared codecs and
geometry validation live in `src/shared/lod4.ts`.

A page partitions the original integer neighborhood bounds into up to 16 × 16
row-major cells. Integer boundaries use `floor(i * extent / divisions)`; narrow
regions reduce their column/row count to avoid zero-size cells. Power-of-two
subdivisions permit later merging into coarser cells without moving boundaries.
The version, 16-cell side limit and exact area semantics are immutable in v1.

Each page stores:

- Original `bitmap_areas` in canonical local bitmap order, at most 2,016 entries.
- CSR `cell_offsets`, including empty cells with equal consecutive offsets.
- Local `member_deltas`, restarting from zero in every cell. Each cell's IDs are
  strictly increasing; the first delta can be zero. Absolute block height is
  `region.id * 2016 + localId`.
- Exact integer `overlap_areas` paired with each member: the intersection of the
  canonical bitmap rectangle and that cell. No metric values or colors are baked.

The root decoder binds the source snapshot. Page references authenticate bytes
and bind the original geometry hash, region identity, dimensions and count.
The root hash is supplied by addon discovery metadata; the report is an offline
validation artifact, not an external trust anchor. Decoding does not need to fetch
the canonical geometry. Full offline
validation additionally proves that every association agrees with that geometry.
Index/page limits are 256 KiB / 4 MiB, dimensions at most 65,535 per axis, and
membership at most `bitmapCount * columns * rows`. Invalid inputs fail explicitly.

## Aggregation without duplicated weights

A bitmap crossing several cells must not acquire extra analytical weight.
Its contribution to one cell is:

```text
bitmap weight = overlapArea / bitmapArea
```

The integer overlap areas across all cells sum exactly to the original bitmap
area. Consequently, every bitmap's fractional weights sum to one. Use these
weights for original-value scalar sums and selected/total matching weights.
Normalize the resulting mean only after aggregation. Keep global filter counts
computed from the original metric arrays; never sum duplicated membership IDs.

For Parcel size, distribute the existing per-bitmap parcel class areas using the
same fraction, retaining area-weighted side means and selected-area shares.
This is a coarse approximation inside a bitmap; the addon does not locate each
individual parcel. Exact parcel positions still belong to closer zoom levels.

Empty cells have no members and must remain empty. Partially occupied cells
expose their exact occupied fraction as `sum(overlapArea) / cellArea`; this is
coverage information, not permission to paint the whole cell as fully occupied.
Exact sub-cell edges are not encoded and still require level-3 geometry.

## Current generated bundle

The bundle for source snapshot
`a6552d4952ffe1f0c2ad54beccd82763c30b51d6e2a20e248dec9703376f45a3` is at
`.cache/maintenance/lod4-a6552d4952ff-v1`:

| Measure | Value |
| --- | ---: |
| Canonical neighborhoods / bitmaps | 483 / 973,728 |
| Grid cells / occupied cells | 123,648 / 123,628 |
| Bitmap-cell intersections | 1,641,706 |
| Root bytes | 72,521 |
| Page bytes | 7,244,415 |
| Total payload bytes | 7,316,936 |

These are measured file counts and byte sizes. They do not establish device FPS,
GPU memory or startup latency. An 8× reduction in potential cell primitives is
not an 8× reduction in transfer bytes; memberships and areas also occupy space.
