# Testing

```sh
bun run typecheck
bun run test
bun run build
bun run check:site
```

The default test command runs infrastructure and client regressions. To narrow
the run, use Bun directly:

```sh
bun test --timeout 60000 ./server ./scripts
bun test --timeout 60000 ./test
```

Tests use temporary output directories and small fixtures; maintenance databases
are not required. Some layout/integrity tests read the bundled public dataset.
HTTP and Vite tests need permission to listen on localhost.

`scripts/build-version.test.ts` verifies exclusive reservations and counter
commit/rollback. `scripts/workflow.test.ts` builds twice with an isolated counter,
checks matching build metadata and preserved data identity, then rejects corrupt
input without changing the previous output or version. `test/site-metadata.test.ts`
checks exact snapshot/cursor binding and complete/partial pending neighborhoods.
Generation tests check that a no-op refresh updates sync coverage while preserving
the known generation time and every Protobuf byte.

`scripts/semantic-dataset.test.ts` also builds native input containing older
source releases over a stale output directory. It checks exact current release
pinning, byte-identical selected files, exclusion of historical and stale files,
and total-budget failure preserving the prior site and version. Integrity builds
reject missing files, same-size corruption and wrong payload lengths even when
the containing routing metadata is correctly hashed. Failures preserve the prior
site and version; explicit full audits remain available. Source history is left
unchanged. The workflow test covers opt-in gzip output and replacement of old
output files by a later build.

`scripts/build-progress.test.ts` checks stage-local counts/timing and a live
parent heartbeat while a child is CPU-bound. It also verifies ordinary diagnostic
forwarding and timer cleanup after completion. The generation-progress suite
continues to cover split UTF-8, bounded lines and complete child-process failure
logs. Build progress is a terminal behavior check, not a performance claim.

After building with `--base /repository/`, `bun test/site-identity-browser.mjs`
checks full integer totals, attribution links, embedded build identity/date,
dataset-bound sync status, search for unpublished blocks, fullscreen entry/exit
and footer fit at 900 px. It writes `/tmp/bitmap-site-identity.json` and `.png`.
Chrome/SwiftShader with an emulated viewport proves the fullscreen API and app
layout, not native window maximization or operating-system behavior.

## Coverage

- Layout results: captured coordinate hashes, four real transaction fixtures and
  comparison with canonical published neighborhoods.
- Codecs: independent byte fixtures, arbitrary stream boundaries, corruption,
  membership, output hashes and compatibility used by intermediate tools.
- Data clients: cache reuse, cancellation, retry, scheduler limits and workers.
- Rendering logic: compact vertices, capacities, hover, arrival fades, coverage
  residency and geometry disposal.
- Build: new output enforcement, source preservation, native reference/length/hash
  integrity, explicit deep audits and rollback to the previous site on failure.
- Reference export: native DuckDB `tx`/`size` lists, explicit database selection
  across parcel/color stages, unchanged canonical geometry, new complete
  neighborhoods, incomplete-tail exclusion and read-only source preservation.
- Interactive generation: independent-path deterministic filenames/bytes,
  continue/rebuild modes, temporary cleanup after success/failure, publication
  recovery and rollback. The advanced static generator retains explicit stage-resume tests.
- Incremental generation: scalar manifest/DB cursor comparison, metadata-only
  writes and missing caches, no payload audit for no-op runs, exactly 2,000/2,016
  pending bitmaps, shared chunks retaining Protobuf history while reading only new
  DB rows, byte-identical full-build comparison, explicit rebuild for historical
  corrections and failed temporary updates retrying from the published cursor.
- Incremental validation: verified/reused payload counts, new-neighborhood-only
  layout checks, corrupted new packs/geometry/bitmap chunks, missing inherited
  files, changed historical root rejection, and complete validation still detecting
  same-size corruption in trusted inherited payloads. Publication cannot use the
  validation-only baseline shortcut.
- Generation status: live child-process streaming, split UTF-8 and final lines,
  complete stdout/stderr logs on failures, unique monotonic counts despite
  spatial block order and once-only completion for each neighborhood ID.
- Protobuf restoration: shuffled delivery to ordered DB rows, exact TX indices,
  pattern addons and older-snapshot reconstruction, cancellation/corruption
  rollback, sample rejection and AWS continuation strictly after the restored prefix.
- Static serving: path/symlink containment, base paths, GET, HEAD and 404.
- Vite map assets: swap the dataset while the server is running, including
  unobserved watcher events; verify new binary bytes, removed-file 404 responses,
  missing-file HTML rejection, GET/HEAD, query strings and symlink containment.

## Browser regressions

`bun test test/mondrian-worker.test.mjs test/parcel-scheduler.test.mjs` verifies
canonical parcel geometry and the actual worker protocol, bounded cooperative
slices, cancellation after updated wishes, scheduler batches and streaming.
The worker test injects a module-local clock/task scheduler: cheap records must
share yields, while expensive slices still process new wishes. It establishes
work/cancellation behavior, not target-device loading time or FPS.

`bun test test/analytical-preview-coverage.test.mjs test/lod4-aggregate-runtime.test.ts test/lod4-runtime.test.ts`
checks that fully covered vector regions bypass spatial preview cells without
new allocations or coverage queries. It also checks zero-weight fallbacks,
partial coverage, reverse zoom and restoration after geometry loss. These are
functional work/visibility regressions; the connected-GPU pan observation and
its measurement limits are recorded in [performance](performance.md).
Reverse zoom also verifies uniform inherited coverage while retaining linear
opacity, including reactivation after eviction. `test/geometry-arrival.test.mjs`
checks settled region proofs without owner scans and retained known-empty cells;
`test/parcel-zoom-readiness.test.mjs` checks immediate detail-group hiding at
stop 3, explicit compact-layer visibility and restoration of resident buffers.

`bun test/zoom-parcel-start-browser.mjs` runs source Vite and isolated Chrome.
It begins at a cold neighborhood boundary at stop 3, delays one canonical layout,
and verifies that bounded parcel bodies start before stop 2 and a ready neighbor
renders without waiting for the delayed layout. Every selected bitmap is audited
against the final stop-2 frustum. Returning to stop 3 cancels new work; stream
concurrency remains two. Reports and screenshots use `/tmp/bitmap-zoom-parcel-start*`.
`MAP_SMOKE_DEVELOPMENT=1 bun test/bounded-parcels-browser.mjs` additionally checks
the native slider, independent arrivals, resident reverse fades and actual pan
using source Vite without a build. These are functional local Chrome checks;
wall-clock measurements are not physical-device or hosting benchmarks.

`bun test/transaction-filter-browser.mjs` checks Transactions filter membership,
selected means, exact counts, density with visible rare matches, exact neutral
empty regions, three editable colors, unchanged brightness on filter activation, stable 1-TX intensity
at stops 4 and 5, and filter reset. Screenshots for the 1-TX filter at stops
3–5 are written to `/tmp/bitmap-transactions-one-tx-zoom-*.png`. It samples rendered pixels and writes
`/tmp/bitmap-transactions-filter.png`.

`bun test/parcel-size-colors-browser.mjs` checks the default palette, its restore
action, weighted unfiltered summaries and density-based matching visibility for 9–9, 7–9
and 5–9 filters. A rare class-9 region must retain its yellow hue while the selected-area
statistic retains its exact small share. Filter screenshots are written to
`/tmp/bitmap-parcel-filter-9.png` and `/tmp/bitmap-parcel-filter-large.png`.

`MAP_SMOKE_DEVELOPMENT=1 bun test/wheel-zoom-browser.mjs` runs Vite and isolated
Chrome to check three-sample scroll accumulation, majority direction independent
of magnitude, isolated/two-sample rejection after the direction window, one
adjacent stop per gesture, momentum latching and both boundaries. Every settled
wheel or slider action must equal one of the five states. Fractional slider
releases also verify that the visible thumb lands on a state marker. The harness
checks cursor anchoring in both directions and that pointer movement alone cannot
steer an unfinished zoom. It exercises both buttons and Home, normalized line/page
deltas, control interruption and three viewport sizes. Without
`MAP_SMOKE_DEVELOPMENT`, it reads the review build. The trace is
`/tmp/bitmap-wheel-zoom.json`; screenshots use `/tmp/bitmap-navigation-*.png`.
Native single/two-event checks verify browser delivery. Controlled multi-event
batches enter the actual canvas handler, avoiding compositor merging or long
delivery gaps between synthetic CDP packets; these are functional checks rather
than measurements of physical mouse hardware.

Requires Chrome at `/usr/bin/google-chrome` or `MAP_SMOKE_CHROME`. Build a review
site with the fixture base; this does not publish it:

```sh
bun run build --base /repository/ --out /tmp/bitmap-browser-site
MAP_SMOKE_BUILD_DIR=/tmp/bitmap-browser-site bun test/zoom-center-browser.mjs
MAP_SMOKE_BUILD_DIR=/tmp/bitmap-browser-site bun test/bounded-parcels-browser.mjs
```

Seven map harnesses share `test/helpers/browser.mjs`: static fixture serving,
optional delayed responses, Chrome/CDP lifecycle, polling and temporary profile
cleanup. The default dataset is the review build's `map-data`. Set
`MAP_SMOKE_SNAPSHOT` to override it, `MAP_SMOKE_PORT` / `MAP_SMOKE_DEBUG_PORT`
to choose ports, and `MAP_LOD_WIDTH` / `MAP_LOD_HEIGHT` to choose the viewport.
Run these harnesses sequentially unless assigning separate ports.

`bun test/parcel-pixel-zoom-browser.mjs` renders dense size-1 parcels at fractional
and integer scales, checks pixel repetition and brightness during slow fractional
pan, and verifies maximum zoom after HD, Full HD, portrait and 4K resizing.
It also checks aligned projection/picking, target preservation when leaving
maximum zoom, and uniform minification of size-1 grids at fractional pixel
scales. Images are written to `/tmp/bitmap-pixel-zoom-comparison.png`,
`/tmp/bitmap-pixel-zoom-map.png` and `/tmp/bitmap-parcel-stop2-filtered.png`.
These are Chrome/SwiftShader rendering checks,
not real-GPU performance measurements.

Harnesses cover navigation, zoom center, bounded parcel requests, color modes
and dense/central loading. Several use the bundled 416-neighborhood snapshot
as a fixture. Bitmap chunk loading, resident coverage, arrival fades and buffer
updates also have deterministic unit regressions. The bundled source positions
are translated to the official spiral; browser checks must allow the resulting
regional geometry fallback rather than wait for disabled source-space chunks.

`bun test/pan-gaps-browser.mjs` finds actual interior gaps in the published layout
and performs native mouse drags into them in both directions at zoom stops 1 and
2. It checks continuous motion, unchanged zoom and target preservation on resize,
including a viewport containing no neighborhood. The outer map limits remain
covered by `test/map-navigation.test.mjs`. The browser trace and screenshot are
written to `/tmp/bitmap-pan-gaps.json` and `/tmp/bitmap-pan-gap.png`.

`bun test/bitmap-handoff-browser.mjs` renders the real bitmap shaders and both
compact/legacy parcel renderers over the shared R8 arrival clock, checking filled
interior pixels throughout arrival and the subsequent base exit. A gap inside
each bitmap must already reveal the fading base by 220 ms and be clear by 320 ms,
for both renderers, while filled interiors stay opaque. It also compares
bitmap outline coverage at the
vector stop against the original inset, checks the same base separation in the
parcel band and pixel-identical completed detail with the base hidden, and
captures bitmap #563559 at stop 3. Reports are written to
`/tmp/bitmap-handoff.json` and `/tmp/bitmap-stop3-outlines.png`.

`bun test/preview-transition-browser.mjs` measures pixels in natural empty cells
of a fully resident neighborhood with unrelated owner downloads still pending.
The 4↔3 fade must remain linear through its endpoint without coverage uploads.
It also exercises the actual neighborhood 178 zoom and rounding immediately past
stop 3, then gates new geometry and performs a native cold pan at fixed stop 3.
Frame pixels verify that margins remain transparent over the preview during
vector arrival, followed by its independent 300 ms exit. Local clocks are stepped
deterministically; this is functional evidence, not a real-device timing or FPS
measurement. Reports use `/tmp/bitmap-preview-transition*`; pan screenshots use
`/tmp/bitmap-cold-pan-*.png`.
The same pan retains a visible resident bitmap while both the index query and new
downloads are delayed: its buffer identity, completed clocks, local coverage and
rendered interior pixels must stay stable, with no repeat request for resident
geometry. Shared edge pixels can include the independently fading neighbor;
the separate resident-preview regression below checks isolated gap pixels.

`bun test/resident-preview-browser.mjs` checks a partially resident neighborhood
when a later query introduces an overlapping conservative owner extent. Gap and
interior pixels must stay unchanged throughout the new arrival, while eviction
of the contributing geometry restores the summary. It also audits every visible
preview patch and resident buffer during 12 consecutive native drags in both
directions at stop 3. Run with `MAP_LOD_TILE_DELAY_MS=150` to delay new data.
Reports and a screenshot use `/tmp/bitmap-resident-preview*`.

`bun test/preview-upload-browser.mjs` reproduces a preview upload deferred while
the entire summary mesh is hidden. After pan reveals a separately arriving
neighbor, the old bitmap gaps must stay black even when a different patch changes
in that same frame. This guards actual GPU pixels rather than only CPU coverage.
It also compares the GPU coverage buffer with the CPU mask during native vertical
and horizontal pans near neighborhoods 447 and 448. Reports use
`/tmp/bitmap-preview-upload*`.

`bun test/huffman-official-browser.mjs` reads `dist` and its recorded base by
default; it checks the real v9 worker, colors, 2D navigation and persistent reuse after
refresh. `bun test/vite-dev-browser.mjs` checks source development, HMR, worker
reload and disposal in a temporary fixture.

These checks establish functional and integrity behavior. They do not establish
real-GPU FPS, hosted/CDN behavior or successful remote publication.

`test/map-analytics.test.ts` covers scalar normalization, independent Protobuf
wire bytes, inspection counts and corrupt/mismatched coverage. The analytical
workspace harness is `bun test/atlas-browser.mjs` after building with the fixture
base above. See [analytics](analytics.md) for its screenshots and validation scope.

`bun test/preview-colors-browser.mjs` checks the Bitmap Area default and solid
analytical region pixels: uniform colors, excluded neighbors, empty gaps,
independent coverage and reverse zoom, with zero raster downloads/textures.
Excluded regional colors must remain identical across scalar and area palettes.
It captures the real map at preview, blended and vector zoom levels using the
same review build and Chrome/SwiftShader setup as the atlas harness.
`test/analytical-lod.test.ts` verifies per-bitmap membership before aggregation;
`test/analytical-preview-coverage.test.mjs` verifies canonical clipping and stable
owner-cell coverage without pan/zoom uploads.

`bun test/neighborhood-borders-browser.mjs` renders touching same-color summaries
at three scales. Their shared boundary remains one pixel wide while internal
owner-cell seams stay filled. It also checks the linear preview/vector fade with
unchanged coverage attributes and captures real zoom stops 5 and 4. Reports and
screenshots use `/tmp/bitmap-neighborhood-borders*`.

`bun test/bitmap-filter-stability-browser.mjs` renders exact area and scalar
filter endpoints in perspective across 20 camera positions per case, for both
compact parcels and bitmap vectors. Every covered interior pixel must retain its
filter membership; excluded cases also guard against widening the filter. It
also verifies that excluded scalar and parcel-class pixels keep the same neutral
color across palettes, values and hover. It uses the standard review build,
writes `/tmp/bitmap-filter-stability.json`, and captures the real maximum-area
bitmap #401265 during small camera movements in
`/tmp/bitmap-area-stability-*.png`. Chrome/SwiftShader is functional pixel evidence,
not a real-device GPU or frame-rate measurement.

`bun test/rectangle-coverage-browser.mjs` compares hard insets with derivative
filtering for compact parcels and bitmap vectors. It pans dense synthetic grids
in fractional-pixel steps through four scales, checks reduced pixel changes and
increased fill for unresolved grids, preserved mean fill/gap coverage for
resolved cells, native coverage at close zoom, shader compilation and no geometry
uploads. It uses a four-sample MSAA render target and writes paired
images (original left, filtered right) to `/tmp/bitmap-coverage-*.png` and metrics
to `/tmp/bitmap-rectangle-coverage.json`. It also captures real bitmap #362030 at
stop 2 with original and filtered edges in `/tmp/bitmap-detail-stop2-*.png`.
These are functional Chrome/SwiftShader comparisons, not real-GPU performance or a perceptual guarantee
for every map pattern.


## Zoom-4 spatial LOD

`bun test test/parcel-spatial-filters.test.ts test/mode-streaming.test.mjs`
compares all 45 Parcel size ranges with the original class-array calculation:
exact global bitmap/parcel counts, occupied areas, regional means, matching
shares and merged 16x16 grids. The controller test forbids global class downloads
and checks rapid range replacement and exact local bitmap values.
`test/lod4-aggregate-runtime.test.ts` also checks viewport-only filter batches,
shared admission and cancellation on pan/range changes. Native generation tests
exercise direct HTTP references, caching, deterministic output and baseline reuse.

`bun test/parcel-filter-streaming-browser.mjs` runs source Vite and isolated
Chrome. It measures stop-5 metadata and settled stop-4 filter changes, verifies
that every requested batch serves the actual viewport, forbids the global class
payload and local class pages at stop 4, checks cached and replaced ranges, and
compares per-bitmap classes on the vector approach. It bounds filter bodies below
100 KiB and overview wire transfers below 200 KiB, including compressed JSON
delivery. Reports and screenshots use `/tmp/bitmap-parcel-filter-streaming*`.
This is functional local-browser evidence, not hosted/CDN or device performance.

`bun test test/lod4-aggregates.test.ts test/lod4-aggregate-runtime.test.ts`
compares precomputed summaries against canonical membership calculations for
all five modes and all independent axis groupings. It covers Protobuf corruption,
path safety, mode coverage, four-request admission, batch sharing, cancellation,
resident reuse and exact-filter switching. Generation and native-source tests
also cover deterministic batches, direct HTTP references, publication validation
and source preservation.

`bun test/lod4-aggregates-browser.mjs` runs Vite and isolated Chrome against
`public/map-data` without a build. It checks no downloads before stop 4, a fixed
stop-4 pan sweep, all five unfiltered modes, absence of summary routing and local
bitmap metric requests, retained 16x16 grids, settled buffer versions, reverse
zoom, exact filters/reset and closer bitmap vectors. Reports and screenshots use
`/tmp/bitmap-lod4-aggregates-*`. This establishes functional browser behavior;
artifact sizes and response-body counts do not establish hosted latency or GPU FPS.

`area-metric-loading.test.mjs` exercises the controller's area-mode setup and
filter commands: no global array on opening/reset, one shared first-filter
request, exact latest-filter results, reset/mode-change races and retry after
failure. `analytical-lod.test.ts` checks the metadata-only regional means.

`bun test test/lod4.test.ts test/lod4-generation.test.mjs` verifies an independent
Protobuf wire fixture, descriptor parity, exact integer intersections, empty and
thin cells, cross-cell weight conservation, deterministic generation, corruption
rejection and source/output/symlink preservation. `bun scripts/validate-lod4.ts`
rebuilds every page from the authenticated source; see [LOD4](lod4.md).
`lod4-summary.test.ts` checks original-value means, fractional bitmap weights,
parcel occupied-area weights and empty cells. `lod4-runtime.test.ts` checks lazy
opening, cancellation, bounded requests and resident reuse. `lod4-source.test.mjs`
checks HTTP integrity, optional discovery, stale roots and payload caching.
Runtime tests also reproduce floating-point blend residue at opening stop 5 and
verify zero discovery/page requests until stop 4, with resident reuse on reverse
zoom. They cover 150 visible regions, widening/narrowing the viewport,
compact residency and no repeat downloads. `lod-viewport.test.mjs` compares the
controller's footprint with independent camera-ray intersections at all five
stops, four canvas aspect ratios and pixel-aligned projection offsets.
`lod4-installation.test.mjs` checks installation, static validation, corruption
rejection and canonical source preservation. Generation tests also verify that
reorganization retains the addon byte for byte when its snapshot is unchanged.

`bun test/lod4-browser.mjs` checks opening without addon downloads, bounded stop-4
refinement without exact geometry/layouts, cell values for all five modes,
metadata-only initial Bitmap Area and a lazy first-filter array download,
settled attribute versions, the 4↔3 return path and shader compilation. It writes
screenshots to `/tmp/bitmap-lod4-*.png` and checks full visible-region coverage at
2048×1152, 1024×768 and 1600×1000. This is functional Chrome/SwiftShader
evidence, not real-device FPS or measured GPU memory.


## Streaming and immutable releases

`test/streaming-lifecycle.test.ts`, `test/geometry-consumers.test.mjs`,
`test/mode-streaming.test.mjs` and
`scripts/streaming-contract.test.ts` cover scoped sharing/cancellation, priority
admission, partial body accounting, metadata-only unfiltered modes, exact lazy
filters, local metrics, fixed-band parcel segments, height-independent page
identities, exclusive publication, addon-root release IDs and retained releases.
Existing generation tests compare independent full and incremental outputs.

`MAP_SMOKE_BUILD_DIR=/tmp/bitmap-streaming-site bun test/streaming-audit-browser.mjs`
uses the normal browser harness and an isolated Chrome profile. It checks real
IndexedDB namespace protection and persisted LRU, production release pinning,
five unfiltered modes at 1280×720, 1920×1080 and 3440×1440, local spatial values,
no global analytical payloads and stop-5 removal of resident spatial draws.
Outputs are `/tmp/bitmap-streaming-audit.json` and `.png`. Run after building with
`--base /repository/`; this is functional SwiftShader evidence.

The offline grid comparison is reproducible with
`bun scripts/benchmark-bitmap-chunks.ts --source public/map-data --audit .cache/maintenance/streaming-audit/browser-navigation.json --out NEW_REPORT.json`.
It measures encoded payload footprints using the complete conservative owner
window, not HTTP compression, GPU timing or target-device performance.


`bun test scripts/semantic-dataset.test.ts scripts/generation.test.ts` covers
semantic source determinism, reader/HTTP parity, source preservation, addon edits,
old-session reuse, full/incremental equivalence, recovery and format-only migration.
`bun test/semantic-dev-browser.mjs` serves the real migrated source with Vite,
checks source-module loading without `dist`, navigates to parcels, and verifies
that no old physical namespace or global analytical array is requested. The
report and screenshot are `/tmp/bitmap-semantic-dev.json` and `.png`. This is
functional Chrome/SwiftShader evidence, not physical-GPU performance.


`bun test test/patterns.test.ts` covers the deterministic 200-neighborhood color
cycle, canonical pattern catalog, exact TX-only and pattern membership, stable
regional/spatial colors, worker previews and stale-filter cancellation.
`MAP_SMOKE_BUILD_DIR=/tmp/bitmap-patterns-site bun test/patterns-browser.mjs` checks
real controls, deselection, automatic pagination with bounded mounted rows and
preview consumers, reload determinism, spatial summaries and parcel detail.
Reports and screenshots use `/tmp/bitmap-patterns-browser.{json,png}`.


`bun test/pinned-browser.mjs` serves source through Vite and runs isolated Chrome.
It verifies Regions labels, removal of the header snapshot badge, selected pin
state, lower-left alignment, focus plus inspector opening, multiple compact
comparison columns, horizontal scrolling, closing back to the list, removal that
also unpins, and the 900-pixel layout. Reports and screenshots use
`/tmp/bitmap-pinned-browser.json`, `/tmp/bitmap-pinned-list.png` and
`/tmp/bitmap-pinned-comparison.png`. These are functional UI checks.


`bun test/text-selection-browser.mjs` runs source Vite and isolated Chrome with
native mouse and keyboard events. It verifies clearing stale text selections,
real panning across the map and sidebar without highlighting text, copyable
inspector metrics, Ctrl+A in inputs, blocked page selection on the focused map
and preserved middle-drag zoom. Report and screenshot use
`/tmp/bitmap-text-selection-browser.{json,png}`. These are functional checks.


`bun test/selected-bitmap-browser.mjs` renders independent bitmap and compact-parcel
fixtures into a linear GPU target. It verifies exact white selection, unchanged
neighbors, color restoration on selection changes/clear, and controller wiring
through inspection, detail arrival and mode changes. Outputs are
`/tmp/bitmap-selected-white.{json,png}`. This is functional pixel validation,
not a performance benchmark.


`bun test/mobile-navigation-browser.mjs` runs source Vite and isolated Chrome
with a mobile user agent and native CDP touch input. It checks continuous pinch
in both directions, midpoint anchoring through five-stop release snapping,
one-finger pan, tap inspection, partial release/cancellation and fresh gestures.
It also verifies scrollable analysis controls, inspector/zoom separation, search
and full integer footer totals at phone, tablet and short landscape sizes, page
scale stability, and the absence of a canvas focus border. Screenshots use
`/tmp/bitmap-mobile-*.png`; the report is
`/tmp/bitmap-mobile-navigation.json`. These are emulated functional checks,
not physical-phone, Safari or real-device performance evidence. Set
`MAP_MOBILE_LAYOUT_ONLY=1` to run only the responsive control checks.
