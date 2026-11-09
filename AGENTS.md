# Repository guidance

- Use English for all new code, comments, UI text, tests and documentation.
- Read [docs/codebase.md](docs/codebase.md) before investigating architecture,
  navigation, rendering, layouts, data or cache. Follow imports from `src/App.tsx`
  and verify behavior in current code. Read [docs/performance.md](docs/performance.md)
  before making browser performance or indexing decisions. Proposals are not
  implemented features; functional tests do not establish real performance.
- Preserve unrelated local changes. Use Git history for source recovery, branches
  for experiments and worktrees only for simultaneous versions. Do not create
  source copies, `.bak` files, tarballs or duplicate application trees. Do not
  commit or push unless asked. Before deleting old local recovery copies, verify
  unique contents are committed or explicitly waived. Uncommitted files are not
  protected by Git.
- Data preservation is separate from source history. Canonical databases stay in
  `data/databases`, distributed authenticated geometry in `public/map-data`, and
  new offline output in `.cache/maintenance`. The standard `map:generate` command
  uses Git-ignored `.tmp/generation-*` staging and deletes it after success or
  failure; its previous dataset exists only temporarily for replacement rollback.
  Converters require new destinations
  and preserve the source. Do not delete local data recovery revisions as cleanup.
  The AWS importer is separate: it updates its own DuckDB reference and
  sync tables in `data/db`, stages transactions in `data/aws/bitcoin`, and may
  delete only those temporary inputs after their partition commits. Preserve the
  original DuckDB reference. See [docs/aws-bitmap-sync.md](docs/aws-bitmap-sync.md).
- One root package/lockfile defines Bun 1.4.4+, TypeScript 7 and Vite 8. `src`
  contains the app and `src/shared` reusable TypeScript contracts/algorithms.
  `scripts` contains build/data tools; `server` is only an optional static server.
  Dev/build read source and public assets, not databases or maintenance revisions.
  `dist` is the sole publishable output. Preserve build staging, validation and
  rollback. Build only the current application and selected dataset; never merge
  cached releases or old build output into `dist`. Git owns source version history.
  Normal native builds verify metadata, references, lengths and hashes while
  copying. Deep geometry/parcel/filter checks belong to generation or explicit
  `build --validation full` audits; do not repeat them for every application build.
  Do not use deploy workflows as local validation.
- Vite owns dev serving, React Fast Refresh and CSS. Keep literal worker URLs in
  `src/workerUrls.ts`; do not add custom reload/SSE or intermediate CSS pipelines.
- A Bitcoin block is a bitmap, a transaction is a parcel, and a neighborhood groups
  up to 2,016 consecutive blocks. Preserve heights, transaction indices, order,
  coordinates, dimensions and cursor/collision behavior. Layout, format and cache
  changes need explicit versioning. Do not regenerate neighborhoods to change
  global projection. Dataset `layout` is source metadata, not an algorithm switch.
- `MapCanvas → MapRuntime → MapController` is the only map runtime/controller path.
  `MapUI` is a canvas sibling using only `MapControls`. Keep React presentation
  outside runtime. `src/shared/SpiralLayout.ts` is the sole Tight v3 implementation,
  identity `tight-neighborhood-spiral-v3-guided-inner-edge`; preserve its internal
  reference, corners and natural dimensions. Do not restore discarded layouts.
- `src/shared/MondrianLayout.ts` is the sole square/rectangle packing implementation.
  Invalid inputs and budget overflows fail explicitly; do not add legacy fallback.
- The application is 2D only. Do not restore the removed mountain view.
- Preserve all five logarithmic zoom stops and continuous LOD. Zoom preserves the
  target; only Home/search intentionally recenter, using canonical bitmap 0 for
  opening/Home. Pan constraints run on actual pan/resize, not zoom frames.
- Preserve linear preview/vector blending at 4↔3, fixed owner-cell coverage,
  independently arriving 600 ms geometry, and resident/known-empty coverage on
  reverse zoom. Do not restart resident arrivals on pan or add preview at 3↔2.
  Bound new parcel requests to the stop-2 frustum during 3↔2; use the actual view
  below stop 2. Keep rendering selection separate from new-download selection.
- Compact parcels are the default (18 bytes per capacity); preserve `?parcels=legacy`
  comparison. Bitmap vectors use Uint32 IDs and 24 bytes/bitmap. Preserve the shared
  R8 per-bitmap arrival atlas and complementary base opacity; settled frames must
  not upload it. Debug selection changes visibility, retaining buffers in None;
  retain the selection and honor `?chunks=off`.
- Preserve lazy spatial pages, four geometry downloads, 24 selected detail regions,
  texture/vector budgets and top-left chunk ownership. Do not load all neighborhoods
  or pack members at startup. Full layouts are generated in workers and validated
  by canonical output hash. Keep supported intermediate/export readers and tests.
- The canonical logical contract is JSON manifest v9 / `typed-protobuf-v2`.
  `public/map-data/release.json` declares the native physical
  `bitmap-semantic-dataset-v1` layout, used directly by dev and offline readers;
  preserve its authenticated routes and retained immutable history. Payloads and
  indices are Protobuf. Keep the frozen `tx-huffman-rle-v1-840k-20261029` table and
  encoding/cache identities immutable. New blocks reuse the table without training.
  See [docs/data-formats.md](docs/data-formats.md).
- Run relevant checks from [docs/testing.md](docs/testing.md). Report browser,
  export, GPU and publication evidence separately. Do not claim device FPS from
  CPU benchmarks, attribute reductions or SwiftShader tests.
