# Streaming, download, caching and publication audit

Date: 2026-11-06. Dataset: 973,728 bitmaps, 483 neighborhoods, snapshot
`a6552d4952ffe1f0c2ad54beccd82763c30b51d6e2a20e248dec9703376f45a3`.

Status: original measurements followed by the implementation described below.
Publication policy updated on 2026-11-09: builds now contain only the current
application and selected dataset. The append-only deployment proposal later in
this historical audit is superseded by [current publication](immutable-releases.md#current-dataset-publication).
The findings and byte counts in this audit describe the pre-change application. Temporary
browser experiments used isolated contexts; the user's existing tabs and caches
were preserved. Results live in `.cache/maintenance/streaming-audit/`.

## Implemented follow-up

The runtime now opens every unfiltered analytical mode from metadata. Scalar
values and nine-class counts arrive in authenticated neighborhood pages only at
stop 4 or closer. `spatial-metrics-v1-protobuf` pages contain count, diversity,
occupancy and class counts together; they exclude snapshot/global recurrence.
`metrics.json` binds local pages and exact unfiltered parcel regional means to
the canonical snapshot. Missing values retain regional summaries and a separate
negative loading sentinel; their displayed color matches the dark excluded-item
neutral (`#24272d`). The loader has four
requests and retains 64 decoded pages; installed sparse score arrays remain
bounded by the existing 1,048,576-bitmap contract. Exact global filters still load
the required full information explicitly, with shared cancellation and persistent
content-keyed reuse. No viewport statistic replaces a global count.

Transport now has one four-body session budget, with prerequisite priority and
independent existing subsystem caps. Shared payloads retain only live consumers.
Mode/filter changes cancel obsolete consumers before decoding/worker admission;
view changes cancel pending parcel index and canonical neighborhood work. Current
searches retain their own geometry wish until completion/cancellation. Parcel workers recheck current
wishes between indivisible bitmap layouts. Retry policies distinguish cancellation,
transient/rate-limit failures and permanent absence/corruption. Transient attempts
use backoff and a one-minute cooldown after four failures, rather than a session
hole or a frame-driven retry loop. The source counts body bytes while reading,
including abandoned prefixes, and keeps a bounded 256-entry request ledger with
purpose, mode/view revisions, cache tier, completion and cancellation reason.
These counters describe response bodies, not compressed wire transfer or FPS.

Disk cleanup is serialized across namespaces. Each namespace has its own budget;
their aggregate is at most 1 GiB or 20% of the reported browser quota, whichever
is smaller. Under aggregate pressure allowances scale proportionally; a small
cache never imposes its own limit on other namespaces. Old entries retain their
namespace. Persisted access times are batched and cleanup yields between bounded
transactions. Stop-5 visual endpoints are normalized as well as download gates,
so resident spatial pages no longer remain drawable because of float residue.

An offline comparison of 10,240 / 4,096 / 2,048 / 1,024-unit vector grids retained
every canonical rectangle and the conservative whole-owner dependency window.
For the audit's 116-visible-bitmap view, the 2,048-unit grid selects 1,906 records
and 40,667 bytes across six owners, versus 27,827 records and 595,151 bytes across
four old owners. This is a **93.2% smaller potential cold payload** for that view,
not measured hosted traffic or GPU performance. Dense cells were included: the
new largest chunk is 752,241 bytes. Total vector bytes change from 20,769,891 to
20,824,490. The default generator now declares `bitmap-owner-grid-v1-2048`;
old grid readers remain supported. The installed addon was checked against all
973,728 canonical IDs, coordinates and dimensions. Earlier payloads were retained.
The study is `.cache/maintenance/streaming-audit/finer-grid-study.json`.

Unfiltered stop-4 previews now use `bitmap-lod4-aggregates-v2` with the original
16x16 grid. Mode-specific batches group six spatial neighbors into at most
20 KiB; direct Protobuf index references avoid per-summary routing. Bitmap Area
has 81 batches totaling 1,496,533 bytes, versus 483 membership pages totaling
7,244,415 bytes. Its shared index is 153,248 bytes. A source-Vite browser sweep
requested all 81 area batches and counted 1,650,116 aggregate response-body bytes,
including discovery and index. It requested no local bitmap metric pages at
stop 4. The same harness checked all five modes, reverse zoom, exact filters and
the vector approach. Scalar filters retain v1 membership data; closer vectors
retain local metric pages. See [LOD4](lod4.md) for byte scopes and contracts.

Parcel size ranges additionally use `parcel-spatial-filters-v1`: 18,978 bytes of
exact global count/mask metadata and independent visible-range grids of at most
12,368 bytes per batch. Interactive filtering no longer requests the 10,944,718-byte
global class array. Stop 5 uses only compact totals; stop 4 selects filtered 16x16
grids by the current frustum, while closer vectors use local class pages. The
global payload remains available for offline/export readers and retained releases.

New parcel generation uses `cell-neighborhood-shuffle-v1`: fixed cell × 2,016-block
segments with deterministic in-band order and boundaries. New spatial index
pages use independently versioned page **10**, whose height is the maximum local
chunk height, while v8/v9 readers remain available. The outer JSON v9 manifest,
Tight v3 and frozen v9 Huffman pack encoding remain unchanged. Historical v9
pages/packs have a one-time migration when rewritten; newly generated bands then
remain reusable. Full and incremental paths share the segment builder.
New inspection pages use `inspection-local-v2`, excluding global occurrences;
paged inverted pattern membership supplies exact recurrence and match queries.

Publication uses `bitmap-immutable-release-v1` / `semantic-aliases-v1`, described
in [immutable releases](immutable-releases.md). Following the 2026-11-09 policy
change, the build validates and copies only the current dataset's authenticated
dependencies. The HTML pins the source descriptor. Previous builds, external
release stores and unreferenced source history are excluded from `dist`; output
replacement retains staging and rollback. Readable coordinate/neighborhood/hash
paths and authenticated routing shards retain their identities.

The source in `public/map-data` uses semantic paths directly through
`bitmap-semantic-dataset-v1`; `bun dev` needs no build. Generation installs the
converted source, including format-only migration on a legacy no-op. Offline
readers resolve the same roots, and the original legacy tree is archived intact.
Local HTTP serving distinguishes immutable assets from mutable discovery,
supports ETag validation and optionally serves precompressed gzip variants.
Hosted/CDN behavior still needs verification.

Optional Range resumption and adaptive pack draining remain experiments requiring
host measurements. Parcel upload admission remains bounded by the existing
262,144-parcel indivisible-record limit and 3 ms between-record loop; it is not a
hard per-frame GPU-time guarantee. Subdividing an admitted bitmap upload safely,
production bundle splitting and physical-device profiling remain follow-up work.
No device FPS, VRAM or remote-publication claim follows from these changes.

## Follow-up validation

`streaming-lifecycle.test.ts`, `mode-streaming.test.mjs` and
`streaming-contract.test.ts` cover shared cancellation/admission, aborted byte
accounting, exact lazy filters, segment/page stability, exclusive writes, addon
release identity and retention. Existing generation tests compare full versus
incremental artifacts. `streaming-audit-browser.mjs` uses an isolated Chrome
profile to reproduce namespace protection and persistent LRU, check all five
unfiltered modes at three viewport sizes, and return resident pages to stop 5.
Its report and screenshot use `/tmp/bitmap-streaming-audit*`. This establishes
functional Chrome/SwiftShader behavior, independently of real-device performance.

## Outcome

Parcel selection already follows the visible map and its zoom gates. The complete
application does not yet meet the slow-network objective. Global analytical arrays,
obsolete mode downloads, cross-namespace disk eviction and coarse bitmap chunks
are the principal gaps. Compressing the area array alone cannot resolve them.

The target is spatial demand loading at every level, explicit global analytical
work only when necessary, bounded decoding/upload work, reusable authenticated
content and deterministic append-only releases.

## Evidence and boundaries

The active route was traced from `App.tsx` through `MapCanvas`, `MapRuntime`,
`MapController`, the data sources, schedulers, workers, GPU admission and disposal.
The generators, storage-path codecs, validators, static server and site publication
were also reviewed.

Live Chrome tests used `http://localhost:5173/` in an isolated browser context:

| Browser viewport | Actual map canvas | Mode/zoom/direction samples |
| --- | --- | ---: |
| 1920 × 1080 | 1632 × 978 | 100 |
| 1280 × 720 | 992 × 618 | 100 |
| 3440 × 1440 | 3152 × 1338 | 100 |

Each set covered Bitmap Area, Transactions, Size diversity, Occupancy and Parcel
size; zoom stops 5 through 1; and center, right, left and return positions. These
300 samples used Fast 4G emulation and live controller navigation. They sampled
streaming while the map was in use rather than waiting for every request to settle.
They are not 300 independent cold-cache tests.

Additional trusted mouse drags exercised OrbitControls at all five stops. Further
drags into neighborhood 400 used Slow 4G, including a reverse drag. Eight native
pan gestures were recorded. A separate Slow 4G context tested rapid mode changes.
Another isolated context reproduced the disk-cache eviction problem.

Across the 300 matrix samples, no selected parcel ID was outside the actual parcel
frustum and no wanted LOD4 region was outside the actual canvas bounds. Native
pan samples after frame processing also retained correct selection. Immediate
same-JavaScript-task snapshots before a frame are not selection assertions.

The first opening requested 366,921 bytes of map payloads: manifest, neighborhood-0
dimensions, preview index and layer metadata. No global area array, LOD4 page or
parcel pack was requested. This excludes application scripts, workers and headers.

This was Vite development serving. Its unbundled JavaScript cold-start duration
must not be reported as production startup performance. A separate existing build
has a 1,029,564-byte main JS bundle; local gzip measurement gives 282,880 bytes,
but gzip delivery by the deployment was not established. Browser GPU FPS, VRAM,
hosting/CDN performance and sustained behavior on physical slow links were not
benchmarked.

`networkBytes` currently counts response bodies rather than complete wire traffic
and omits aborted partial `small()` reads. The initial ResourceTiming buffer was
not enlarged, so its retained entries are not a complete network ledger. The audit
also recorded fetch starts, source counters and declared immutable payload sizes.

## Current loading policy

| Level/action | Current behavior | Assessment |
| --- | --- | --- |
| Opening / stop 5, Bitmap Area | Metadata means and histogram; canonical focus from neighborhood 0 | Appropriate; no full area array |
| Stop 4 | Visible-neighborhood spatial-summary pages, up to four requests | Spatial and resolution-aware |
| Stop 3 | Paged bitmap vectors with independent arrivals and coverage proofs | Correct selection; coarse physical chunks |
| Stops 2–1 | Parcels for intersecting bitmaps in selected detail regions | Correct viewport selection; two parcel streams |
| Palette edit | Existing uniforms and session palette state | No data download required |
| Scalar mode selection | One global Float32 array per mode | Excessive for unfiltered overview/local viewing |
| Parcel size selection | One global nine-class array | Largest routine analytical request |
| Explicit area filter | Lazy global area array | Deliberate global operation; still compressible |
| Inspection | One neighborhood inspection page; four decoded pages retained | Bounded, but no persistent analytical payload cache |
| Pattern matches | Full global pattern reference | Explicit global action; repeatedly fetched |

Some bytes outside the viewport are inherent in a shared spatial pack. Current
parcel packs have 1024-unit top-left ownership. Their entire authenticated stream
may contain nearby unselected bitmaps. The application does not lay out every
record merely because its pack is downloaded. This differs from requesting the
parcels of an unrelated distant corner.

## Findings

### 1. Global analytical arrays dominate routine mode traffic

`StaticHttpDataSource.getAnalyticsMetric()` downloads and decodes the entire
selected array. `MapController.setRenderingMode()` then scans it to create scores,
regional summaries and a global texture. These operations do not depend on the
current viewport.

| Payload | Current bytes per request |
| --- | ---: |
| Transactions | 3,894,919 |
| Size diversity | 3,894,919 |
| Occupancy | 3,894,919 |
| Bitmap Area, explicit filtering | 3,894,919 |
| Parcel class counts | 10,944,718 |
| Pattern membership reference | 2,730,100 |

In the sequential navigation matrix, the three scalar arrays loaded once each
and parcel class counts loaded three times. These arrays account for 44,518,911
body bytes out of approximately 51.9 MB counted by the source during the audit.
The global area array was requested zero times. Re-entering Parcel size closes
and recreates its worker; its class payload has no persistent analytical cache.

For unfiltered scalar overviews, existing metadata already supplies the regional
means. It should be used immediately, as Bitmap Area now does. Closer views need
small spatial or neighborhood pages of raw metric values. Parcel size additionally
needs small regional class summaries in its metadata instead of deriving them by
loading all nine classes for every bitmap.

Exact global filters require a separate information contract. A regional average
and a 32-bin histogram cannot recover arbitrary exact counts or selected means.
Use exact value distributions/sufficient statistics where compact, or explicitly
load the required global data for a global operation. Do not silently replace
global counts with viewport counts or approximate matches.

The area-only dictionary + gzip prototype reduced 3,894,919 bytes to 1,216,797
bytes and reconstructed all 973,728 values exactly. That prototype remains
uninstalled. Compression reduces transfer size; it does not replace spatial paging
or eliminate the decoded arrays' memory cost.

Sources: `src/data/StaticHttpDataSource.ts:179`,
`src/map/MapController.ts:260`, `src/data/ParcelAnalysisClient.ts:23`.

### 2. Abandoned mode requests continue downloading and decoding

On Slow 4G, selecting count, diversity, size and then area at 150 ms intervals
returned the UI to Bitmap Area. Two 3,894,919-byte arrays and the 10,944,718-byte
class payload still completed: about 18.7 MB of abandoned array data, excluding
metadata/previews. The scalar downloads started after their mode had already
been abandoned. Completed scalar requests took about 65.5 seconds and the class
request about 105.3 seconds in this shared-bandwidth experiment.

Revision checks prevent stale rendering commits, but they happen after transport
and decoding. `analyticsFile()` uses only the session-wide abort signal. Closing
the parcel analysis client does not abort its preceding class download.

Introduce request-scoped consumers and cancellation through metadata, body reads,
decoding and worker admission. Check the mode revision before starting expensive
work after each await. Shared requests should remain alive only while a current
consumer needs them. A completed verified payload may be retained without building
an obsolete texture or worker result.

The generic `file()` helper cannot simply replace `analyticsFile()`: it currently
enforces a 2 MiB metadata cap. Introduce a bounded per-payload-kind transport/cache
path; do not relax every metadata limit to accommodate a large analytical file.

Sources: `src/map/MapController.ts:266`,
`src/data/StaticHttpDataSource.ts:67`, `src/data/ParcelAnalysisClient.ts:25`.

### 3. Disk eviction crosses cache namespaces

All `PackCache` instances share the `bitmapExplorerPacks/content` store. Keys are
namespaced, but cleanup scans the entire time index and applies the calling
instance's disk limit to every entry. The 16 MiB layout or LOD cache can therefore
delete parcel data belonging to the nominal 256 MiB pack cache.

The browser reproduction created a 128 KiB-budget namespace containing 4096 bytes,
then wrote 16 bytes into a separate 1 KiB-budget namespace. The first namespace's
4096-byte entry disappeared during the second namespace's cleanup.

Enforce namespace ownership during eviction and define one explicit aggregate
quota policy. Coordinate cleanups instead of letting differently sized caches
race over the same store. Disk reads currently do not refresh persisted access
time, so eviction is based on writes rather than true disk LRU; batch access-time
updates without writing on every frame.

Sources: `src/data/PackCache.ts:16`, `src/data/PackCache.ts:37`,
`src/data/PackCache.ts:74`.

### 4. Bitmap-vector chunks are coarse for a small viewport

The vector index uses 10,240-unit cells; parcel ownership uses 1024-unit cells.
Bitmap chunk payloads have a median of 143,590 bytes, a p95 of 346,737 bytes and a
maximum of 1,449,623 bytes. LOD4 pages are much smaller: typically about 15 KiB.
Parcel packs have a median of 38,734 bytes, p95 56,857 and maximum 358,560 bytes.

One inspected stop-2 viewport contained 116 visible bitmap rectangles. Its four
wanted vector chunks represented 27,827 rectangles and 595,151 bytes. Two chunks
contained no rectangle intersecting that exact viewport. These chunks were already
resident: 595,151 bytes is the selected footprint's potential cold cost, not a new
download on that warm observation.

The conservative owner-cell halo and completeness proofs intentionally load more
than the exact camera rectangle. Simply clipping requests to visible owners could
break incoming bitmap coverage, stable empty-space proofs and reverse zoom.
Measure finer cells or bounded subpages, including dense central cells, while
preserving top-left ownership and all existing arrival/proof regressions.

Sources: `src/data/NeighborhoodChunkSource.ts:15`,
`src/data/NeighborhoodChunkLoader.ts:44`, `src/shared/neighborhoodChunks.ts`.

### 5. Resident spatial LOD still costs draws at stop 5

The download gate correctly blocks new stop-5 LOD4 requests. However, a visual
blend residue of `3.019806626980426e-13` kept 104 resident spatial layers and
6624 cells active after zooming out. Renderer calls were 106. A temporary
browser-only epsilon clamp produced the same regional-summary representation
with 2 calls and no spatial cells. A 1632 × 978 canvas comparison changed only
25 color channels, each by one 8-bit unit; the images were not byte-identical.
The experiment was restored afterward.

Normalize the visual endpoints as well as the request gate. This is a measured
draw-count reduction opportunity, not an FPS or GPU-time claim.

Sources: `src/map/MapController.ts:802`,
`src/map/layers/SpatialLod4Layer.ts:91`.

### 6. Request limits are per subsystem, not a shared network policy

Bitmap geometry permits four downloads, LOD4 four and parcels two. Parcel index
pages have another two-slot queue. Analytical downloads use a separate path.
These limits are individually useful but do not impose a global bandwidth or
priority budget during transitions and mode changes.

Prioritize live visible work and its prerequisites through one bounded request
coordinator, preserving deduplication and the existing maximum geometry limits.
Slow-network concurrency should be measured rather than inferred from desktop
defaults. Obsolete queued parcel index work currently has no view-specific abort
signal; canonical neighborhood loads use a session-wide geometry abort signal.

Sources: `src/data/ParcelScheduler.ts:38`,
`src/data/StaticHttpDataSource.ts:425`, `src/map/MapController.ts:598`.

### 7. Cache reuse works locally, but HTTP and analytical reuse are incomplete

The Slow 4G native reverse drag added zero fetches and zero source body bytes.
Authenticated complete parcel packs, small records, derived geometry and resident
GPU buffers provide useful reuse. Keep these paths.

Analytical payloads bypass persistent `PackCache`. Repeated Parcel size entry
downloads its 10.9 MB class file again. Inspection retains only four decoded
regions, with no persistent analytical payload reuse. Pattern matching fetches the
whole membership table on each action; an inverted, paged pattern-to-members
index would better match that query.

The provided static server and Vite data middleware send `Cache-Control: no-cache`
for hashed files and mutable roots alike, with no explicit conditional validator
or compression implementation. Immutable payloads should receive long-lived
immutable caching; mutable discovery, if any, requires a separate policy. Actual
hosting/CDN headers still need independent verification.

Sources: `src/data/StaticHttpDataSource.ts:179`,
`src/data/StaticHttpDataSource.ts:159`, `server/index.ts:21`,
`scripts/vite-map-data.ts:37`.

### 8. Resume, retry and CPU admission need consistent policies

- Verified parcel prefixes are reused by the parser, but the network fetch starts
  at byte zero and discards the repeated prefix. The client sends no Range header
  and its response helper accepts only status 200. Byte-range resumption needs
  explicit 206/Content-Range validation, authentication and a safe full-response
  fallback when the host does not support it.
- Parcel streams drain a selected shared pack to completion even when its useful
  records have already arrived. This benefits future cache hits but consumes
  bandwidth. Measure an adaptive finish-versus-abort policy against the remaining
  bytes; preserve verified prefixes and shared consumers.
- Geometry chunk failures can retry on subsequent updates without a cooldown;
  LOD4 failures suppress that region for the session. Add a common bounded retry
  policy distinguishing cancellation, transient transport failure, corruption and
  permanent absence. Preserve Retry-After/status information for rate limiting.
- Parcel worker results are checked against current wishes before GPU upload,
  which is good. Queued layout computation is not cancelled by a view change.
  The 3 ms upload loop only yields between individual bitmap uploads, so one
  large upload can exceed the target. Worker admission and large uploads require
  their own measured budgets.
- `small()` counts bytes only after successful completion. Log partial aborted
  reads, cache tier, request purpose, view/mode revision and cancellation reason.
  Separate response-body bytes from compressed transfer and HTTP cache hits.

Sources: `src/data/StaticHttpDataSource.ts:75`,
`src/data/StaticHttpDataSource.ts:588`, `src/data/ParcelScheduler.ts:80`,
`src/map/MapController.ts:428`, `src/map/MapController.ts:463`.

## Deterministic storage and append-only upgrades

### Requirements

Use names describing data, not a current zoom stop. Replace the proposed future
layout's `lod4/` concept with `bitmaps/summaries/`; those spatial summaries may be
used at several distances. Keep coordinates or neighborhood IDs visible in names,
with the full content hash preserving immutable identity.

Suggested future tree, not an active format:

```text
map-data/
  releases/<release-sha>.json
  manifests/<manifest-sha>.json
  bitmaps/
    summaries/index.<sha>.pb
    summaries/n000320.<sha>.pb
    index/x-0001_y+0002.<sha>.pb
    chunks/x-0004_y+0017_n000320_p000.<sha>.pb
  parcels/
    index/x-0006_y+0002.<sha>.pb
    chunks/x-0042_y+0017_n000320_p000.<sha>.pb
  metrics/
    index.<sha>.json
    area/n000320.<sha>.pb
    transactions/n000320.<sha>.pb
    diversity/n000320.<sha>.pb
    occupancy/n000320.<sha>.pb
    parcel-size/n000320.<sha>.pb
  neighborhoods/
    dimensions/n000320.<sha>.pb
    geometry/n000320.<sha>.pb
```

`x` and `y` are signed cell indices in the collection's fixed, versioned world
grid. They are never screen coordinates, viewport-normalized coordinates or
indices renumbered by map bounds. Use `floor(world / cellSize)`, including negative
coordinates. For a 1024-unit grid, `x-0042_y+0017` starts at world
`(-43008, 17408)`. Different collections must declare their grid sizes explicitly.
Padding is formatting only; never truncate a larger coordinate or ID.

`n000320` identifies a fixed neighborhood/height band. `p000` is a part within
that fixed cell-and-band partition, not a global sequential counter. Hashes are
computed from canonical payload bytes; generation time, local path, machine and
viewport must not affect those bytes or names. A short hash alone is not the
recommended identity; readable prefixes already make the full-hash name debuggable.
Compression headers, codec parameters and encoder identity must also be stable;
do not include gzip timestamps or machine-specific metadata.

Growth does not guarantee that every new bitmap occupies a previously unused
cell. New neighborhoods can intersect an existing coarse cell. Consequently a
coordinate alone cannot be both the filename and an immutable content identity.
Changed content gets a new hash/name; the old file is retained.

### Current barriers to append-only behavior

1. `dataStorage.ts` and publication validators accept the current typed directories
   and hash-only filenames. A directory rename alone breaks readers, path
   derivation and integrity validation. Protobuf File messages usually store hash
   and size, not a free-form URL. Implement a versioned path/coordinate contract
   across generators, indices, readers and validators together.
2. Parcel index pages embed global `publishedHeight`. Re-encoding all 172 existing
   pages with identical chunks and only that height increased by 2016 changed
   **172/172 hashes**, covering 2,349,806 bytes. Baseline re-encoding reproduced
   all 172 original hashes. Local immutable pages should not embed unrelated
   global progress; the release/root should bind them to a snapshot.
3. Appending records to an existing parcel cell currently reshuffles/rebuilds its
   packs. Publish immutable segments partitioned by fixed height bands and cells
   if historical packs must remain reusable. Segment boundaries must be independent
   of the number of records added in a particular maintenance run, so full and
   incremental generation remain byte-identical.
4. Inspection pages combine local immutable metrics with global pattern occurrence
   counts. Appended occurrences can change historical pages. Separate local
   metrics from versioned global pattern statistics.
5. `generate.ts` currently replaces the whole published dataset and deletes the
   temporary previous tree after success. `prepare-pages` publishes references for
   the current snapshot. Retaining old files in one source directory alone is
   insufficient if a subsequent site build omits them from `dist`.

Sources: `src/shared/dataStorage.ts`, `src/shared/protobufChunks.ts:112`,
`scripts/update-static.ts:131`, `scripts/generate-analytics.ts:59`,
`scripts/generate.ts:38`, `scripts/generate.ts:147`.

### Release discovery without overwriting map-data

Publish immutable manifests and addon roots, then an immutable release descriptor
referencing their exact hashes and encodings. The release ID must include **all**
referenced roots and storage versions, not just the canonical geometry snapshot:
an addon can change while the geometry snapshot remains unchanged.

For the strict no-overwrite requirement, the app build receives the chosen release
reference and pins it for the session. A new app release selects a new descriptor;
old app sessions can continue requesting the old paths. Discovering a new latest
release automatically without a new app build would require a mutable pointer
somewhere. That is an explicit alternative, not an append-only data file.

The append publisher should:

1. Generate into a new maintenance/staging destination and validate all new data.
2. Create immutable target files exclusively. If a path exists, verify identical
   content and reuse it; different bytes at the same path are an error.
3. Publish the new release descriptor only after all referenced files are present.
4. Preserve all earlier releases and payloads through site builds and deployments.
5. Make a retry idempotent and retain the current build staging/rollback guarantees.
6. Perform no automatic old-data deletion. Any future garbage collection must be
   a separate explicitly authorized policy over retained releases.

Migration must preserve old URLs. A new physical naming scheme can add readable
paths while leaving the old release's tree available; account for any one-time
duplicate storage. It must not rename or remove files still used by old sessions.
The current deployment publishes `dist`, so the retained store must be included
there or served from separately persistent immutable asset storage.

A changed storage/index schema needs explicit versioning. Preserve canonical
coordinates, IDs, transaction order, Tight v3, the frozen Huffman table, and the
existing geometry/parcel format semantics unless a specifically versioned change
requires otherwise. Do not regenerate neighborhood packing to change filenames.

## Recommended implementation order

1. **Correct lifecycle and cache behavior:** namespace-safe disk eviction,
   coordinated quotas, cancellation before/after every expensive await, coherent
   transient retry rules, accurate aborted-byte counters, and stop-5 visual
   endpoint normalization. These do not require regenerating canonical data.
2. **Define the immutable release/storage contract before writing new payloads:**
   semantic directories, coordinate/band/hash names, content-local page identity,
   immutable release discovery, append publication and retained old URLs.
3. **Page analytical values and class data:** metadata-only unfiltered overviews;
   local raw-value pages at closer levels; independent exact global filter
   information; persistent content-keyed reuse. Keep loading state distinct from
   filtered-out neutral state and preserve existing density/color semantics.
4. **Tune physical granularity and transport:** smaller dense bitmap chunks,
   compression, optional authenticated Range resume, and a shared priority budget.
   Keep parcel packs spatial, bounded and compatible with current validation.
5. **Profile CPU/upload and production delivery:** stale worker cancellation,
   large-upload admission, bundle splitting, immutable HTTP headers and deployment
   compression. Measure real target devices before claiming FPS improvements.

Do not solve paging by downloading every neighborhood into a worker. Do not
preload all analytical arrays in the background. Do not change exact global
statistics into viewport statistics or treat missing data as excluded data.

## Acceptance checks

- Opening and unfiltered distant modes start no global value/class download.
- Across window sizes, only intersecting spatial owners and their necessary
  boundary dependencies become new wishes; rendered residency remains independent.
- Departed modes/views stop consuming network/decoding unless another current
  consumer needs the shared request.
- Cached reverse pan starts no new payload transfer unless a documented eviction
  occurred; one cache's cleanup cannot delete another namespace's protected entries.
- Stop 5 returns to regional-summary rendering regardless of resident LOD4 pages.
- A transient failed chunk can recover without retry storms or a permanent hole.
- Appending a complete neighborhood preserves names/bytes of unaffected local
  pages; unchanged index pages are not invalidated by global height alone.
- Full generation and equivalent incremental generation produce the same artifact
  names and bytes. New publication never overwrites old artifact bytes.
- The previous release and an already-open old session remain usable after upgrade.
- Canonical geometry, collision/picking, exact filters, arrival fades, reverse
  coverage proofs and all five zoom stops retain their existing regression checks.

Raw evidence: `browser-navigation.json`, `mode-volumes.json`,
`rapid-mode-and-cache-proof.json`, `resident-stop5-rendering.json`,
`file-inventory.json` and `index-stability.json` under
`.cache/maintenance/streaming-audit/`. The area compression prototype is separately
recorded under `.cache/maintenance/area-size-study/`.
