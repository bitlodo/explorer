# Performance and browser indexing

The map targets responsive 2D navigation on modest desktop devices. Evaluate
pixels, CPU/GPU memory, transfer and main-thread work alongside frame rate.

The [streaming and publication audit](streaming-audit.md) records the measured
navigation matrix, cache/lifecycle findings and the proposed deterministic,
append-only storage contract. Its follow-up section distinguishes implemented controls from optional transport
experiments and physical-device profiling still required.

## Implemented resource controls

- Parcel and neighborhood layout run in workers.
- Parcel layout yields between slices of at most 64 records or 4 ms of work,
  checking updated wishes after yielding. It does not create a timer for every
  bitmap. Individual layouts remain indivisible, and the main-thread upload
  budget remains 3 ms per frame.
- The small root and spatial pages avoid downloading every pack index at startup.
- Authenticated payloads and derived layouts use bounded content caches.
- Requests are deduplicated, prioritized, cancelled and subject to backpressure.
  A four-body session coordinator covers all subsystems.
- Unfiltered scalar and parcel overviews use metadata and precomputed spatial
  summaries. Raw local values and classes use neighborhood pages on the vector
  approach, with 64 decoded pages retained. Legacy LOD4 datasets request them
  at stop 4 or closer.
  Parcel size ranges use compact exact global totals and viewport-selected
  precomputed grids. Scalar filters retain exact global statistics and reuse
  authenticated persistent payloads.
- Disk quotas are namespace-aware and cleanup is serialized, with batched access
  times and a 1 GiB / 20% browser-quota aggregate cap.
- New vector generation uses the versioned 2,048-unit owner grid. The audit
  compares complete transfer footprints, including dense cells; the reduction
  for its small viewport is not an FPS or general hosting-speed measurement.
- Analytical region summaries use no raster tiles or preview textures.
- Patterns is the default mode. Opening it loads the authenticated canonical-pattern
  reference and global TX counts for its worker catalog and exact filters. Preview
  consumers and spatial geometry remain bounded and lazy.
- Unfiltered Bitmap Area uses metadata regional means and histograms. Its full
  per-bitmap array loads only for explicit filtering; LOD4 pages already carry
  their own bitmap areas. Reset and ordinary zoom do not trigger that array.
- Unfiltered zoom-4 summaries use precomputed 16x16 cells in mode-specific spatial
  batches of up to six neighborhoods and 20 KiB. Direct authenticated index paths
  eliminate per-summary routing. Raw bitmap metric pages wait for the vector
  approach; scalar filters retain the original membership path. Parcel size
  filters use range-specific grids only in the visible frustum. Aggregate numeric
  residency is bounded at 8 MiB, excluding object/GPU overhead. See [LOD4](lod4.md).
- Exact-filter zoom-4 spatial summaries use lazy Protobuf pages, four downloads and a 24 MiB
  decoded Uint32 budget, excluding object/GPU
  overhead. They load no exact bitmap geometry at stop 4. Addon discovery and
  pages start only at stop 4 or closer, independently of the visual blend;
  stop 5 and the initial 5↔4 approach start no downloads.
  Selection covers the current canvas frustum; there is no nearest-region count
  cutoff. Cell merging uses projected width and height independently, and settled
  instance buffers are retained. Byte-budget eviction defers excess visible pages
  instead of repeatedly downloading them.
- Spatial bitmap chunks, legacy preview textures and parcel buffers have residency limits.
- Compact parcels use 18 bytes per instance capacity; vectors use 24 bytes/bitmap.
- Resident geometry and certified empty coverage survive pan and reverse zoom.
- At the exact vector stop, a completed whole-region coverage proof bypasses
  spatial preview cell construction and coverage queries. Zero-weight regional
  fallbacks skip coverage work too. Partial arrivals and reverse zoom retain
  their existing preview blend; geometry eviction restores the fallback through
  the existing coverage proofs, without increasing the proof-cache budget.
- Entering 3↔2 starts bounded detail prerequisites during the zoom animation.
  Parcel requests still use only the final stop-2 frustum, or the actual smaller
  view below stop 2. A missing neighboring layout does not delay ready parcel
  arrivals; idle stop 3 requests none. This removes a scheduling wait without
  increasing the detail-region cap or changing arrival fades.

Persistent payloads, decoded layouts and GPU residency are distinct states.
Discarding GPU geometry does not discard the persistent cache. Attribute sizes
exclude textures, temporary allocations, driver memory and duplicated buffers.

## Measurement

Use a fixed dataset and viewport. Measure cold opening, zoom, pan, distant search,
return, cached reload and offline reconstruction. Record network bytes, time to a
useful map, long tasks, frame p50/p95, instance counts, CPU memory and GPU attributes.
Run on actual target devices and distinguish network latency from CPU/GPU work.

The Mondrian and compact-parcel benchmarks in `test/` measure CPU work and
attribute allocation. Chrome/SwiftShader harnesses provide functional evidence.
Neither establishes real-device FPS, VRAM use, storage quota or hosting speed.
Do not infer transaction count from area: `[2]` and `[1,1,1,1]` can occupy the same
area. Appending to a partial neighborhood can change its dimensions and requires
an identifiable data revision.

Mobile layouts and pointer-based touch navigation use the existing bounded
streaming and continuous LOD. Pinch releases snap to the five zoom stops.
Rendering only on demand and device memory instrumentation remain future work.
Emulated touch checks do not establish physical-phone performance.

## Central stop-3 pan observation

On 2026-11-08, four native horizontal drags in the connected Chrome reproduced
long preview-coverage tasks in the central region. At 2560×1254, ANGLE reported
an NVIDIA GeForce GTX 960 with OpenGL ES 3.2. Fully resident vectors still caused
thousands of spatial summary cells to refresh coverage when pan changed the query.
The vector shader/render submission was not the dominant measured CPU task.

| Observed metric | Before | After |
| --- | --- | --- |
| Maximum preview update | 115.3 ms | 3.2 ms |
| Maximum recorded frame interval | 122 ms | 26 ms |
| Recorded frame intervals above 33.4 ms | 5 / 810 | 0 / 727 |
| Median / p95 frame interval | 16.7 / 17.5 ms | 16.7 / 17.8 ms |

Both runs used the same target, stop, viewport and four native drag paths, with
346,820 rendered triangles and 24 visible vector chunks. They used development
code with instrumentation/tracing. HMR reloaded the resident caches, and the
observation durations differ. These samples establish the removed CPU spikes on
this machine; they do not establish a general FPS gain, cold-load performance or
performance on other GPUs. The local report is
`.cache/maintenance/performance/central-pan-2026-11-08.json`; raw traces use
`/tmp/bitmap-central-pan-{before,after}.json.gz`.

## Bitmap 26816 search observation

On 2026-11-08, the connected Chrome reproduced delayed parcel refinement after
searching for bitmap 26816. The camera reached its destination in about 0.5 s,
but the parcel worker waited on a timer before every bitmap layout. Its 1,498
timer callbacks accumulated 6,030 ms of waiting, with a median delay of 4.061 ms.
There were no observed main-thread tasks of 50 ms or longer during the search;
cached data was already available. The resident-preview FPS bypass was not the
measured bottleneck.

The worker now checks wishes between slices bounded by 64 records or 4 ms of
work. Canonical packing, batch IDs, transferable geometry, per-bitmap cancellation
results and the main-thread 3 ms upload budget retain their existing contracts.
An individual large bitmap layout remains indivisible.

| Observed milestone | Before | After |
| --- | --- | --- |
| Bitmap 26816 parcel geometry uploaded | 4,866 ms | 1,007 ms |
| All 1,498 desired bitmap geometries uploaded | 6,768 ms | 1,208 ms |
| Parcel-worker timer callbacks | 1,498 | 18 |
| Sum of parcel-worker timer waits | 6,030 ms | 1.4 ms |
| Observed main-thread tasks at least 50 ms long | 0 | 0 |

Both observations used the same local static origin, snapshot, 2021×900 viewport
and connected NVIDIA GeForce GTX 960. CPU throttling was 1x and network throttling
was disabled. Each search began at Home without resident parcel geometry; the
updated build reloaded the controller while retaining persistent caches. Milestones
were sampled about every 100 ms and refer to uploaded geometry, before the
existing arrival fade finishes. Different processing speeds also changed streaming
batch sizes. This is one local loading comparison with cached data, not a cold
network benchmark, hosted latency measurement or new FPS claim. No Protobuf
regeneration was required.

The report is `.cache/maintenance/performance/search-26816-2026-11-08.json`.
Raw traces and sampled observations use `/tmp/bitmap-search-26816-{before,after}`
with `.json.gz` and `-observation.json` suffixes; the final screenshot is
`/tmp/bitmap-search-26816-after.png`.
