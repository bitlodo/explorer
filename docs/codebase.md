# Architecture

This guide describes the active implementation. Start at `src/App.tsx` and
follow imports when checking behavior.

## Application and ownership

```text
src/main.tsx → App.tsx
  ├─ MapUI → MapControls
  └─ map/MapCanvas → MapRuntime → MapController
      ├─ scenes/SceneNeighborhoodMap
      ├─ layers/*
      ├─ data/StaticHttpDataSource → ParcelScheduler / PackCache
      └─ workers → shared layout algorithms
```

| Module | Responsibility |
| --- | --- |
| `src/MapUI.tsx`, `src/GUI/` | React controls and status presentation |
| `src/map/MapControls.ts` | Commands, immutable snapshots and subscriptions |
| `src/map/MapCanvas.tsx` | Canvas, resize observer and runtime lifetime |
| `src/map/MapRuntime.ts` | Renderer, frame loop, active scene and disposal |
| `src/map/MapController.ts` | Navigation, selection, LOD, data and scene coordination |
| `src/map/MapSceneBase.ts` | Shared scene interface, resize and ground raycasting |
| `src/map/layers/` | GPU geometry, analytical region summaries, previews, colors, fades and debug outlines |
| `src/data/` | HTTP transport, workers, caches and scheduling |
| `src/shared/` | Pure layout algorithms, codecs, schemas and resource limits |
| `src/workerUrls.ts` | Literal worker URLs bundled by Vite |
| `scripts/build.ts` | Validated staging and replacement of `dist` |
| `scripts/build-progress.ts` | Build-stage counters, elapsed times and parent-process heartbeat |
| `scripts/build-version.ts`, `build-version.json` | Serialized successful application build counter and timestamp |
| `scripts/map-status.ts`, `src/shared/siteMetadata.ts` | Dataset-bound sync/publication observations for the UI |
| `scripts/generate-lod4.ts`, `scripts/validate-lod4.ts`, `scripts/install-lod4.ts` | Zoom-4 spatial Protobuf addon generation, canonical validation and installation |
| `scripts/generate-lod4-summaries.ts` | Precomputed 16x16 mode summaries in spatial batches with direct authenticated references |
| `scripts/published-map.ts` | Authenticated canonical geometry for offline tools |
| `scripts/database-neighborhood.ts` | Ordered reference dimensions and geometry for new complete neighborhoods |
| `scripts/generate.ts` | Interactive generation, semantic source conversion, temporary staging/cleanup, validation and atomic replacement |
| `scripts/semantic-dataset.ts`, `scripts/migrate-map-data.ts` | Native semantic source conversion, addon edits and preservation of existing data |
| `scripts/update-static.ts` | Append complete neighborhoods, reusing published packs and merging shared spatial chunks |
| `scripts/vite-map-data.ts` | Live map asset serving across atomic dataset replacement in Vite |
| `scripts/restore-bitmaps.ts` | Authenticated Protobuf prefix restoration before AWS sync |
| `scripts/reference-snapshot.ts` | Deterministic offline pattern metadata for database restoration |
| `scripts/decode-block.ts` | Standalone Bitcoin block hex decoder; no dataset writes |
| `scripts/sync-aws-transactions.ts` | Incremental AWS transactions → DuckDB bitmap reference |
| `scripts/duckdb.ts` | Maintained DuckDB LTS client shared by sync and offline tools |
| `scripts/bitmap-reference.ts` | Parcel conversion, occupied bounds, visual patterns and atomic imports |
| `scripts/import-bitmaps.ts` | Ordered reference import, baseline coverage and lazy pattern candidates |
| `server/index.ts` | Optional static GET/HEAD server |

React owns presentation and uses only `MapControls`. The canvas and UI are
siblings. `useSyncExternalStore` receives map snapshots; the runtime has no
React dependency. Neighborhood geometry reaches rendering as decoded objects;
the controller copies scene coordinates without mutating the source cache.

## Geometry and identity

A block height identifies a bitmap; a transaction index identifies a parcel
within that bitmap. Neighborhood `id = floor(blockHeight / 2016)` groups up to
2,016 consecutive blocks. Layout `(x, y)` maps to Three.js `(x, z)`.

`src/shared/MondrianLayout.ts` is the single Mondrian implementation. It accepts
square sizes (`number[]` or `Uint8Array`) or rectangle pairs, preserving order,
coordinates, dimensions and slot identity. Invalid inputs and resource overflows
fail explicitly. Parcel and neighborhood workers use this implementation.

`src/shared/SpiralLayout.ts` is the single Tight neighborhood spiral, identified
by `tight-neighborhood-spiral-v3-guided-inner-edge`. Preserve its guided inner
edge, corners and natural rectangle sizes. Dataset `layout` is source metadata;
authenticated source positions locate packs and translate previews while the
client draws the official spiral. Projection changes must not rewrite geometry.

The application uses a single 2D map scene.

## Application version and data freshness

Each successful `bun run build` increments the root `build-version.json` counter.
The build reserves its number under a process lock, embeds it and its UTC timestamp
in the client and `build-info.json`, and commits the counter only after installing
the validated output. Failed builds retain the previous output and counter.
Keep this small file when transferring the build workspace; fresh independent
checkouts have independent counters unless they share its latest saved state.
Development displays the last successful version with a `dev` suffix.

Builds prepare a fresh site from current source code and only the selected map
release's authenticated dependencies. Native builds authenticate references, file
sizes and SHA-256 during copying; deep data validation is explicit through
`--validation full` and remains in generation. They never read or merge maintenance
release stores or reuse old `dist` files. The native selector and release
identity are copied unchanged; source dataset history remains outside the site.
A validated replacement discards the old build after success. Git manages source
version history. The temporary previous output exists only for rollback.

The footer's update date is the application build time. Data freshness is separate:
the footer totals and map cursor come from the active authenticated manifest.
Only complete 2,016-bitmap neighborhoods are published. `map-data/status.json`
(`bitmap-map-status-v1`) records the observed contiguous database prefix, last
AWS partition processing time and known generation time, bound to the exact
snapshot and published height. Unknown dates remain null rather than using file
modification times. The UI ignores a sidecar for a different dataset and reports
pending partial blocks or complete neighborhoods waiting for generation.

Successful default `db:sync` updates this sidecar using its existing database
connection; dry runs and custom databases do not change public metadata.
`map:generate` updates it even when no new complete neighborhood is available,
without regenerating any Protobuf. Builds read only source/assets and this
sidecar, never the database. The sidecar is informational and excluded from
authenticated release identity; geometry, caches and immutable history are
unchanged. Static hosting receives its saved observations on the next deployment.

## Data loading

Development reads `public/map-data/release.json` (`bitmap-semantic-dataset-v1`)
then pins its immutable descriptor. The physical source tree uses `bitmaps/`,
`parcels/`, `neighborhoods/`, `metrics/`, `manifests/`, `routing/` and `releases/`.
No build or legacy physical aliases are needed for `bun dev`. Production HTML
pins the descriptor explicitly. Authenticated bindings select the canonical
manifest and addon roots; small routing shards resolve logical references to
semantic paths lazily. `scripts/dataset-path.ts` gives offline generators,
restoration and validators the same authenticated view. Historical semantic
files survive source updates. See [immutable releases](immutable-releases.md).
The selected manifest is an authenticated, small JSON root
for `bitmap-http-protobuf-v9` with `storageLayout: typed-protobuf-v2`.
Spatial index pages and payloads load on demand. Opening the map does not fetch
all pack members or generate all neighborhoods.

`StaticHttpDataSource` authenticates files and shares work across consumers. One
four-body transport budget prioritizes prerequisites across subsystems. Scoped
consumers cancel abandoned analysis and index work before decoding; body counters
include aborted prefixes. Namespace quotas share a coordinated aggregate policy,
and persisted access times are batched.
`SpatialSummaryLayer` uses mode-specific 16x16 aggregates in six-neighborhood
Protobuf batches with direct authenticated references. Unfiltered stop-4 views
need neither membership pages nor raw bitmap metric pages. Scalar filters
delegate to `SpatialLod4Layer`; datasets without the optional aggregate addon
retain its original path. Parcel size filters use compact exact mask/count metadata
and only the visible precomputed filtered grids; local bitmap classes wait for
the vector band. See [LOD4](lod4.md).
`NeighborhoodLayoutClient` generates full neighborhoods from ordered width/height
pairs in a worker and requires the canonical output hash. Search and detail reuse these layouts. `?neighborhoods=server` reads stored canonical geometry for
comparison; it still uses static HTTP.

`NeighborhoodChunkSource` loads spatial bitmap chunks independently of parcel
packs. `NeighborhoodChunkLoader` limits geometry downloads to four and cancels
obsolete work while retaining shared requests. Missing addons or translated
source positions use canonical regional geometry instead. Source-space chunk
ownership must not be used to draw a different projection. Corrupted data fails
validation.

`ParcelScheduler` deduplicates jobs, prioritizes search, limits concurrency and
applies backpressure. GPU eviction does not delete authenticated payloads.
Caches are bounded and keyed by content; v9 packs use `http-pack-cache-v9`, and
derived layouts use `http-neighborhood-layout-v1` plus canonical hash validation.
See [data formats](data-formats.md) for codecs, schemas and offline tools.

## Navigation and detail

The perspective camera has five logarithmic zoom stops (FOV 15°):

| Stop | Content |
| --- | --- |
| 5 | Solid analytical region summaries at full strength, with density-based intensity |
| 4 | Solid analytical region summaries at full strength |
| 3 | Exact bitmap vectors, with preview support until coverage arrives |
| 2–1 | Parcels in up to 24 selected regions; bitmap vectors elsewhere |

The closest stop uses six render pixels per world unit, recalculated from the
canvas height and camera FOV on resize. A size-1 parcel therefore repeats every
six pixels, with three pixels of fill and three of trailing gap. The even pixel
pitch avoids beats from fractional spacing at the maximum zoom. At this settled
stop, a projection offset aligns half-unit coordinates to pixel boundaries.
The visible pan advances by whole pixels while OrbitControls retains fractional
input and the camera target stays continuous. Raycasting uses that same
projection, and download bounds include its offset. Zoom transitions clear the
offset and retain continuous filtering.

The slider, zoom buttons and keyboard preserve the current target, including
after refresh and over natural spiral gaps. Mouse wheel zoom keeps the ground
point under the cursor at the same screen position throughout its animation.
Middle drag anchors to the initial press position. Application chrome does not
select text. Inputs, bitmap/pattern IDs, inspector/comparison values, footer
totals and error details explicitly permit whole-value selection for copying. Canvas pointer-down clears
text selections, prevents browser selection/drag defaults and focuses the map;
Ctrl+A on the focused map does not select the page. Pan constraints run on actual
pan and resize, using only the occupied
outer bounding rectangle. Internal gaps and empty corners are traversable at
every zoom, including when no neighborhood fits within the viewport. Opening and Home
center canonical bitmap 0 while fitting the whole map with a margin. Only Home
and search intentionally change the center during a distance tween.

Wheel input selects one adjacent stop per gesture, requiring at least three
nonzero finite samples and a strict majority of direction votes. Each event has
one vote regardless of delta magnitude. A 60 ms direction window allows early
inverted samples to be outvoted; time alone never commits one or two events.
Capped absolute motion must also total 80 pixels to reject tiny noise, but does
not determine the direction. Tied votes wait for more input. Momentum stays in the same
gesture until a 220 ms pause, including after the animation has settled. A fresh
gesture during an animation advances from its pending stop. An incomplete scroll
leaves the camera in its current state. Wheel zoom and released slider/middle
zoom always settle at one of the five stops, never at a fractional resting scale.
Animations and LOD remain continuous between those states.

Parcel-detail groups are hidden at stop 3 and farther based on the camera band,
even if their independent LOD is catching up. Their resident buffers and arrival
clocks remain intact for the return journey. Compact parcel groups also disable
their own visibility at zero parcel opacity. The stop-3 bitmap vectors retain
their linear blend with the stop-4 preview.

During that blend, a settled whole-region coverage proof supplies the same
coverage to all child preview cells. Partially covered regions keep the existing
per-cell checks; zero-opacity vectors do not trigger coverage scans. Coverage
ownership and eviction rules are unchanged, and wanted-owner coordinates are
parsed once per request selection rather than for each preview patch.

Wheel zoom uses the pointer captured by each scroll event in both directions.
Moving the pointer without scrolling does not steer the unfinished animation.
Slider, middle drag, search and Home reset wheel accumulation when taking over.

The preview/vector blend from 4 to 3 follows the slider's logarithmic position
linearly, with no global wait or post-gesture animation. Coverage uses fixed
tile × neighborhood × owner-cell pieces sharing textures and materials. Pan
and slider changes do not rewrite coverage attributes. Resident owner cells and
certified empty cells remain valid during zoom-out; unknown coverage retains
preview support. There is no third preview band between 3 and 2.

`preview-stops-v10-deferred-coverage-uploads` also certifies a canonical region when
all of its 2,016 authenticated bitmap IDs are resident across owner chunks.
Fixed preview pieces retain their highest arrival coverage and the resident
owners that established it. New query results cannot revoke that handoff;
evicting a contributing owner invalidates only its dependent proofs. The CPU
proof cache is bounded to 2,048 pieces and is cleared when the layout changes.
Its natural empty cells follow the same linear zoom blend. During cold loading,
bitmap vectors arrive over 600 ms with transparent margins; their preview remains
opaque until geometry is opaque, then exits independently over 300 ms. This avoids
painted black borders over the summary and keeps empty cells from cutting away.
Settled regions do not wait for unrelated owners outside the frustum. Eviction
invalidates this proof; incomplete regions retain conservative cell coverage.
Near-integer LOD values are normalized at stop boundaries to avoid cutting the
preview because of floating-point residue.

Geometry index queries certify the complete owner cells touched by the stop-3
download window, including possible incoming owners. Pending coverage uses the
authenticated index's maximum bitmap dimensions, rather than neighborhood sizes.
This prevents a new query from restoring preview over settled resident geometry.
Index-derived extents are runtime metadata; distributed files remain unchanged.
Region-wide completeness is an additional proof and cannot lower a settled local
owner-cell proof when another part of that neighborhood arrives.

Coverage attribute writes remain pending until an actual GPU upload, including
while a preview mesh is hidden. New patch writes merge with that pending span
instead of replacing it; the upload callback clears the span for both initial
allocation and later updates. This prevents a newly visible preview from using
stale GPU coverage over resident bitmaps. Each attribute retains at most one
pending span; settled frames do not create uploads.

At full vector opacity, spatial summary layers check the existing whole-region
coverage proof before constructing or updating cell previews. A completely
covered region retains its resident summary data but does no cell work. Regional
fallbacks with zero display weight also skip patch coverage queries. Partial
coverage, reverse zoom and eviction continue through the normal preview path.

During 3↔2, `parcelDownloadView()` limits new parcel requests to the stop-2
frustum, preserving target, aspect and FOV. Below stop 2 it uses the actual view.
Canonical detail layouts and parcel requests start as the camera enters this
band, overlapping the zoom animation instead of waiting for the stop-2 endpoint.
Idle stop 3 starts no parcel work. The detail blend does not wait for every
neighboring layout: each ready bitmap uses its own arrival clock and retains its
opaque base until its parcels arrive.
`wantedGeometry` controls rendered selection/residency; `wantedParcelGeometry`
controls new detail requests and prerequisite layout wishes.

## Rendering and colors

`CompactParcelLayer` is the default 2D parcel renderer: vertex expansion,
18 bytes per instance capacity and hover through a uniform. `?parcels=legacy`
retains the comparison renderer. Bitmap vectors use Uint32 IDs and 24 bytes per
bitmap; chunk and regional paths share mesh construction. Instance scores,
parcel sizes, selection and arrival gains use flat shader varyings: perspective
interpolation must not alter filter membership inside one rectangle.

`RectangleCoverage` filters the visual gaps in compact parcels and bitmap vectors
using fragment derivatives. Shaders average the original fill and trailing gap
over the pixel footprint. Both compact parcels and bitmap vectors fade their
alpha margins toward their own fill based on each rectangle's smaller projected
axis, through the 2.5–4.5 pixel range. Tiny size-1 parcel grids therefore merge
continuously at stop 2 instead of aliasing into dark bands. Larger parcels retain
their visible gaps, and size-1 parcels recover the full gap at maximum zoom.
Filtering transitions back to the original inset geometry and native MSAA for
resolved gaps between 1.25 and 2 pixels. Packed
rectangles, canonical geometry, picking, arrival gains and buffer budgets retain
their existing contracts. The internal `rectangleSmoothing` uniform permits
browser comparisons with the previous hard
inset rendering; the legacy parcel renderer keeps its original hard insets.

The bitmap active in the inspector renders white through an independent global-ID
uniform in bitmap vectors and compact parcels. It persists across palette/mode
changes and newly arriving geometry; clearing inspection restores normal colors.
The active selection can override filter gray, while hover alone still respects
exclusion. Parcel boundaries, arrival opacity and instance buffers are unchanged.

Chunks and regions arrive independently over 600 ms through `ArrivalFade`.
`BitmapArrivalFades` uses a shared R8 progress atlas
(`bitmap-arrival-progress-v3-responsive-base`). Parcels fade in over 180 ms while
the exact bitmap base remains opaque, then the base exits over 120 ms: a 300 ms
handoff after parcel upload, independent of neighborhood-vector arrival. Alpha-over
therefore cannot darken filled interiors during arrival. The global parcel LOD
blend remains continuous. Pan does not restart resident fades. Eviction
resets the affected detail; settled frames do not upload the atlas.

Bitmap-base visual margins target at least one screen pixel so neighboring
bitmaps remain distinct, including unloaded bases at stops 2 and 1. Parcel
geometry retains its own original inset as it replaces each base. Bitmap-base
insets are capped at half the smallest bitmap axis;
canonical rectangles, IDs, picking and buffer budgets remain unchanged.
Bitmap margins use alpha coverage rather than painting the background color over
preview support. The dark separation emerges as the preview exits; completed
geometry retains the one-pixel gap without a black overlay during arrival.
At distant scales, subpixel margin coverage fades toward the bitmap fill so many
subdivisions do not darken the view. The full gap returns as the margin becomes
resolvable.

`AnalyticalRegionPreviewLayer` implements `analytical-region-summary-v11-original-value-means`: solid
canonical region rectangles. `src/shared/layerPresentation.ts` owns the six visible
modes, default Patterns, independent three-anchor palettes and regional styles.
Transactions, Size diversity and Occupancy average original matching values
before applying their display scale, and retain exact matching bitmap shares.
A logarithmic palette does not change arithmetic means into means of logarithms. Parcel size uses the selected area-weighted mean and occupied-area
share. Density dims the original linear RGB color from 100% toward 20%, with a
palette-dependent contrast floor separating matches from neutral gray. It never
brightens the palette color. Bitmap Area uses `log(1 + area)` for its palette, histogram intervals and range
filter, matching Transactions. It uses the arithmetic mean of matching areas and exact matching
bitmap share, without a maximum-value or binary-presence override. All modes use full opacity
at stops 4 and 5. Parcel bitmap bases use selected occupied-area share instead of binary full
intensity, through the same density color function as regional summaries. Exact
parcel membership uses zero/one share, preserving its original colors and filters.
Unfiltered Bitmap Area opens from the small layer-analysis metadata's regional
means and histogram, without downloading the full per-bitmap area array. LOD4
uses the bitmap areas in its own authenticated pages, and vectors derive area
from canonical dimensions. The global area array is fetched lazily on the first
explicit area filter to compute exact match counts and regional shares. Rapid
filter changes share the request; stale responses cannot overwrite a reset or
mode change. Reset to All uses metadata without triggering a download.
It uses fixed region × owner-cell patches for the same preview/vector handoff.
Each summary has an antialiased one-screen-pixel trailing inset, measured in the
original neighborhood's UV space. All owner-cell pieces share those coordinates,
so internal coverage boundaries produce no visible seams. The inset is capped
at half each region axis for tiny summaries. Camera changes update the shader's
pixel footprint without rewriting the canonical rectangles or coverage buffers.
The [zoom-4 spatial addon](lod4.md) refines these summaries into canonical grid
cells through `SpatialLod4Layer`. Its optional discovery and hashed Protobuf pages
load lazily through `StaticHttpDataSource` only at stop 4 or closer. Opening stop
5 and the initial approach toward stop 4 request none, even with floating-point
residue in the visual blend. Resident cells still blend during reverse zoom. It uses
the same means, filters, palettes and owner-cell coverage as regional summaries.
Four concurrent requests and a 24 MiB decoded Uint32 budget bound this refinement.
Selection covers the actual resized canvas frustum without a nearest-region count
cutoff. Cells merge independently by projected width and height, blending at 5↔4 and into the existing
4↔3 geometry handoff; no exact neighborhood layout or bitmap geometry is loaded
just to show cells at stop 4. Settled attributes are retained.
No spatially averaged raster is displayed for analytical layers, and no preview
tiles or textures are loaded for them. The authenticated preview indices still
supply LOD metadata. Legacy raster readers remain supported.

Legacy preview tiles use side 16,384 and resolution 96, capped at four downloads and
64 resident textures. New bitmap vectors use the explicitly declared 2,048-unit owner grid; older grids
remain readable. Bitmap vectors are capped at 2,048 resident chunks and 32 MiB of
attributes. Parcel geometry has its own capacity/residency budget. These figures
exclude driver overhead and do not establish FPS.

Patterns is first in the selector and uses the versioned
`pattern-chronology-loop-v2` presentation: a fixed multicolor loop every 200
neighborhoods, with filter-independent colors and shared excluded gray. Opening Patterns, including the default page load,
loads the existing authenticated pattern reference and transaction
counts into `patternWorker`; the worker builds repeated-pattern metadata and
exact filters. `PatternBrowser` requests pages of 12 with bounded mounted rows;
`PatternsClient` admits two preview consumers, caches at most 64 layouts / 4 MiB
and cancels them on mode exit. Preview geometry uses the canonical Mondrian
implementation. Spatial summaries use the lazy exact LOD4 path; the default page load initializes the pattern catalog while spatial geometry
remains lazy. Distributed geometry/cache contracts are unchanged.

The analytical workspace uses a top search bar, layer sidebar, bitmap inspector
and status footer, opening in Patterns on graphite. UI labels call neighborhood
groups Regions; internal identifiers and data contracts retain their names.
`MapUI` owns session pins independently of runtime selection. `PinnedBitmaps`
shows the lower-left pinned list or a compact bottom panel with horizontally
scrolling comparison cards. Removing a comparison card unpins its bitmap.
Focus uses only `MapControls.goToBitmap` and also opens the inspector. The footer places build metadata
on the left, full dataset totals in the center and attribution on the right;
compact widths use two rows. Patterns uses 60-pixel square previews in 80-pixel
virtual rows and keeps its filter copy brief. See
[analytics](analytics.md) for the six visible layers, histogram filters, pattern
matching, comparison and optional authenticated addons.
Parcel size uses nine classes interpolated from three colors and area-weighted class scores, with exact
class filters at every zoom level; Bitmap Area uses three
anchors and canonical `width × height` before visual margins. Region summaries
are aggregates, not exact bitmap positions. Layer palettes are independent and retained for the session. Unfiltered scalar modes use metadata regional means; unfiltered Parcel size uses
metadata area-weighted regional means. At stop 4 or closer, small authenticated
neighborhood metric pages supply local values and classes without transaction
packs. Missing values retain regional support and use the same dark neutral as
excluded items, while their negative loading sentinel remains distinct. Exact
global filters explicitly load global values/classes, with persistent content reuse.
New inspection pages exclude global recurrence; inverted pattern pages supply
exact occurrences and membership on demand. Excluded items
share `MAP_DISABLED_COLOR` (`#24272d`) across scalar, parcel-class and regional
rendering; the active palette contributes no color when membership is zero.

Debug outlines sit above the map: yellow for bitmaps/heatmap, white for parcels.
The selector changes existing layer visibility; None preserves buffers/counts.
`?chunks=off` disables outlines.

## Build and validation boundaries

One root `package.json` and lockfile define Bun, TypeScript, Vite and React.
Vite serves source and public assets directly with Fast Refresh and ESM workers.
The map-data middleware reads current files from disk instead of relying on
Vite's startup public-file index, which can become stale when generation replaces
the dataset directory. Missing map assets return 404 for every Accept header;
they never fall through to the application's HTML. This also applies to a
configured base path. Source transforms and reloads remain owned by Vite.
The build typechecks, compiles in staging, validates hashes, identity, ownership
and coverage, then replaces `dist` with rollback on failure. Development/build
read no maintenance database and require no previous build.

See [testing](testing.md) for regression commands and [performance](performance.md)
for measurement limits. Functional tests and attribute counts do not demonstrate
real GPU performance, device memory, hosted transfer speed or deployment.

## Historical bitmap reference

The [AWS importer](aws-bitmap-sync.md) restores shipped Protobufs when its database
is missing/empty, then processes newer daily transaction partitions into
`data/db/bitmaps.db` with DuckDB. The same database tracks
source object versions, completed dates and pending downloads. It recreates the
four reference fields and deletes temporary Parquet inputs after commit. `bitmaps`
contains only `bitmap`, `tx`, `size` and `pattern`. Geometry hashes are stored once
per pattern, and height ranges once per daily partition; block hashes are discarded
after validation. Sync reads five scalar Parquet columns through HTTP ranges;
no SQLite migration is supported.
An existing DuckDB reference can seed a complete prefix through `bun scripts/import-bitmaps.ts`.
Its rows are copied in ascending height order and verified, while a compact
per-pattern candidate index avoids recomputing all historical layouts. Stored
baseline height/date settings bound subsequent AWS sync; imported rows are trusted
and only newer heights are processed. Existing newer rows and checkpoints remain.
The importer uses the shared Mondrian without changing the published map, its data
contracts or the existing read-only DuckDB reference. Offline `bun scripts/generate-static.ts`
and `bun scripts/tools/export-http-packs.ts` use `data/db/bitmaps.db` as their default READ_ONLY source.
Generation preserves published neighborhood geometry, appends complete new
neighborhoods from ordered `size` pairs and recalculates parcel colors from `tx`.
It writes a separate maintenance revision; publication remains a build step.
`bun run map:generate` offers continue/rebuild modes and validates a staged dataset
before replacing `public/map-data`. Its ignored `.tmp/generation-*` working
directory is deleted after success or failure; continuation uses the published
manifest rather than persistent stage checkpoints.
Continue reads the published bitmap/neighborhood cursor from the manifest and
compares scalar database height/count metadata. It appends only complete new
neighborhoods, without auditing historical transaction content. No new complete
neighborhood means no payload reads or regeneration, including in fresh checkouts
without a maintenance cache. Shared spatial chunks merge existing Protobuf rows
with new database rows; other packs and canonical geometry are reused. Previews
and bitmap vector indexes are refreshed for a changed root. Historical corrections
require rebuild mode.
Incremental validation uses the existing public manifest as its baseline. It
checks every index entry, inherited file identity/presence/length and global
coverage, decodes changed parcel/bitmap chunks and previews, and recomputes only
new neighborhood layouts. Unchanged canonical rectangles are read on demand when
checking an affected bitmap chunk. Full rebuild and explicit
`build --validation full` audits retain deep validation. Routine native builds
verify current metadata, references, file sizes and hashes without recomputing
geometry, decoding all parcels or recalculating filters.
It retains the previous dataset only during replacement for rollback, removes it
after success, and never resets the database. A recovery journal covers interrupted
replacements and is cleared after recovery.
Building/deploying `dist` remains separate. Temporary directory names, timestamps
and machine paths are excluded from deterministic Protobuf payloads and filenames.

New parcel generation partitions by fixed cell and neighborhood band. Independent
spatial page version 10 stores local height instead of global progress; v8/v9
pages remain readable. Canonical geometry and v9 TX encoding are unchanged.
