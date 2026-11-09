# Analytical 2D atlas

The workspace uses one layer selector and one distribution/filter panel. It is
2D only. Patterns is the default layer. Patterns appears first in the selector. Scalar layers share the legend,
palette editor and range controls, with units appropriate to each metric.
The top bar searches published heights; clicking a bitmap opens
its inspector. The pin icon beside Focus toggles a bitmap in the pinned list
at the lower-left of the map. Compare pinned opens a compact horizontal panel
with one column per bitmap. Removing a column also unpins that bitmap; closing
the panel restores the list. Clicking a pinned bitmap focuses it and opens the
inspector. Pins remain in the current page session. Inspections can also be
exported as CSV. UI labels use Regions for the existing neighborhood grouping.
The horizontal zoom control sits at the top right above the inspector, with
zoom out on the left, five logarithmic stops and zoom in on the right.

| Layer | Definition | Scale |
| --- | --- | --- |
| Patterns | Exact repeated parcel geometry; filter by transaction count and canonical pattern | Chronological loop |
| Parcel size | Side-length classes 1–9, weighted by parcel area at a distance | Class range |
| Bitmap area | Canonical width × height | Logarithmic |
| Transactions | Number of parcels, including coinbase | Logarithmic |
| Size diversity | Shannon entropy of parcel classes | Linear, bits |
| Geometric occupancy | Sum of squared parcel sides / rectangle area | Linear |

## Parcel size

The palette has three editable anchors: purple `#49099e`, magenta `#c03e80`
and yellow `#ffff00`. Linear RGB interpolation supplies all nine side classes,
including the distribution and inspector charts. Restore palette restores these
three anchors.

Small, Medium and Large are presets of the same class filter: 1–3, 4–6 and 7–9.
Click a distribution bar to select a single class, or adjust the two endpoints
for any inclusive range. All restores 1–9. The result shows exact matching parcel
and bitmap counts and the share of parcel area selected across the snapshot.

The distribution and inspector charts use parcel area (`count × side²`), so a
large parcel contributes more than a small one. Distant color scores are
`sum(count × side³) / sum(count × side²)` over the selected classes. They represent
an area-weighted side, not a simple mean biased toward numerous small parcels.
The inspector labels this score explicitly and CSV includes both arithmetic and
area-weighted means.

The distant analytical LOD uses solid canonical neighborhood rectangles, with
a thin screen-space separation between touching neighborhoods even when their
summary colors are identical. Parcel size summarizes the selected parcel area
of each neighborhood and its area-weighted side. Density uses the selected share
of parcel area. Transactions, Size diversity and Occupancy instead use selected
bitmap counts. Nonempty regions retain their palette hue at 20–100% linear RGB
intensity using `0.2 + 0.8 × sqrt(share)`, with a palette-dependent contrast floor
preventing rare matches from approaching excluded gray. This floor only raises
the minimum intensity; it never brightens beyond the original palette color.
Empty regions remain exactly neutral (`#24272d`). All visible modes retain full
opacity at stops 4 and 5. Bitmap Area uses the arithmetic mean of matching areas and their bitmap share,
with equal weight per bitmap; outliers cannot color an entire region as a maximum.

`src/shared/layerPresentation.ts` owns the visible modes, independent three-color
palettes and regional styles. Parcel and inspector bars have no minimum-height floor: their heights follow
occupied-area proportions, including zero for empty classes. The CSS legend samples the same linear RGB
interpolation as the shaders. Parcel bitmap bases also dim by selected occupied-area share; a tiny match
never forces full base intensity. Exact parcel classes, filters and statistics remain
unchanged. Repeated patterns can be filtered from the inspector independently
of the removed recurrence layer.

The runtime policy is `analytical-region-summary-v11-original-value-means`. It allocates no raster
preview textures and downloads no preview tiles for analytical layers. The
existing preview indices still supply LOD metadata. Distributed class-preview
planes, scalar previews and their offline readers remain supported and immutable;
no dataset or cache revision is required for this runtime-only presentation.
Exact bitmap and parcel geometry retain their residency and download limits.
One worker retains at most 9 × 1,048,576 Uint32 class counts (36 MiB); its queue
contains one active calculation and one replaceable pending range. An RG Float32
texture holds the resulting score and membership per bitmap. Switching away
closes the worker; none of these arrays load at startup.

## Other layers

Bitmap area combines the former area heatmap/area options. Its distribution and
range filters use exact canonical areas and emphasize larger values with the
strong end of the palette. Distant regions show the mean matching area, while intensity follows the
fraction of bitmaps selected. One large bitmap does not replace its region
mean or force full intensity. These are navigation hints; zoom in for
exact positions and areas. The palette, histogram intervals and range filter use the same `log(1 + area)`
scale as Transactions. Regional means are calculated in original area units
before normalization. It does
not infer transaction counts from area.
Other metric histograms use equal-width bins in the displayed scale, with
log(count + 1) bar heights, with zero height for empty bins and no minimum-height floor. Clicking a bin or moving a range endpoint dims values
outside the interval. Excluded bitmaps, parcels and regions use the shared
neutral `#24272d`, slightly lighter than the `#17191d` background, without any
contribution from their active palette color. Hover does not brighten excluded
items. Result counts use exact bitmap values. For the other scalar metrics,
distant regions show the normalized arithmetic mean of the original matching values and their fraction of the
region's bitmaps. Membership is evaluated on each bitmap before aggregation, so
averaging two excluded values cannot create a matching region. A region with no
matches stays dim. Every point inside a region has the same color; gaps and
neighboring regions cannot leak color into it. Zoom in for exact positions.

For repeated geometry, the inspector shows the canonical pattern ID, occurrence
count and a Filter action beside the bitmap title. Filter opens Patterns with
the inspected bitmap's exact transaction count and canonical pattern selected.
Unique geometry has no pattern-filter action. Clear pattern keeps the transaction filter; Reset
restores all bitmaps.

Size classes come from the existing logarithmic output-value rule, not byte
sizes or exact BTC amounts. Geometric equality does not imply economic equality.

## Offline data and preservation

The existing `analytics.json` addon and its supported readers remain immutable.
Historical composition, shape, recurrence, chronology and deviation summaries
remain readable for authenticated snapshots and offline tools, but have no UI modes.
`layer-analysis.json` adds the independently versioned
`map-layer-analysis-v1-protobuf` contract: nine parcel counts per bitmap, global
count/area distributions, class previews and bitmap-area metric summaries. It is
bound to the exact published snapshot and height. Payloads and indices remain
content-addressed Protobufs under `colors/` and `parcel-previews/`.

Normal generation builds both addons after organizing the final snapshot.
Incremental generation reuses authenticated inspection summaries for historical
blocks and reads transaction arrays only for appended neighborhoods. The new
class/area addon derives from those summaries without opening the database.
A no-op continue performs no regeneration. Organization preserves and rebinds
both addons; build checks their lengths, hashes, totals, indices and tile payloads.
Neither addon changes manifest v9, layouts, parcel order or existing cache IDs.

To generate only the class/area addon from an existing analytical snapshot:

```sh
bun scripts/generate-layer-analysis.ts --source public/map-data --out .cache/maintenance/NEW_LAYER_ANALYSIS
```

Use a new destination separate from the source. `installLayerAnalysis` verifies
and copies referenced immutable files and replaces its root last, preserving
canonical geometry and the database. Older snapshots retain canonical geometry
when analytical data is unavailable; rebuild analytical data to enable
the full set of filters.

## Validation

```sh
bun test test/parcel-analysis.test.ts test/map-analytics.test.ts
bun run typecheck
bun run test
bun run build --base /repository/ --out /tmp/bitmap-atlas-review
MAP_SMOKE_BUILD_DIR=/tmp/bitmap-atlas-review bun test/atlas-browser.mjs
MAP_SMOKE_BUILD_DIR=/tmp/bitmap-atlas-review bun test/preview-colors-browser.mjs
```

The browser checks the analytical layers, a single selector, removal of 3D, size and area
filters, zero raster textures for analytical summaries, exact counts, search,
inspection, comparison, CSV export, pattern matches and workspace sizing. Screenshots are
written to `/tmp/bitmap-atlas-*.png` and `/tmp/bitmap-analytical-lod-*.png`.
Chrome/SwiftShader establishes functional behavior, not real-device GPU
performance or remote publication. `?stats=on` enables the FPS overlay; `?chunks=off` disables download diagnostics.

To update only an existing Bitmap Area scale and histogram, without regenerating
Protobufs:

```sh
bun -e 'import {updateBitmapAreaScale} from "./scripts/generate-layer-analysis"; await updateBitmapAreaScale("public/map-data", "log");'
```

The update authenticates the existing area values, recalculates all 32 bins and
publishes new metadata while retaining old releases. Use `"linear"` to compare
with the previous scale. New layer-analysis generation defaults to `"log"`.


## Patterns

`pattern-chronology-loop-v2` assigns all bitmaps the same fixed, closed nine-color
palette of muted petrol, sage and sand tones. It calculates the palette position
using `1 + 8 * (height % 403200) / 403200`. The cycle is exactly 200
neighborhoods and does not depend on dataset height, pattern frequency, filters,
randomness or reloads. Filters preserve selected bitmap colors and use the shared
`#24272d` neutral for excluded bitmaps. Regional and spatial summaries retain their
unfiltered chronology color and show whether any member matches; zoom in for exact
positions.

Opening the page in Patterns, or switching back to it, loads the existing authenticated canonical-pattern
reference and transaction-count array. A dedicated worker builds the repeated-pattern
catalog and exact membership masks. No new Protobuf, geometry, format or cache
revision is needed. The default opens with every bitmap visible and no TX or
pattern filter selected. Other modes do not initialize the Patterns worker.

The transaction selector lists counts with repeated patterns and offers a custom
exact count, including counts represented only by unique bitmaps. Without a selected
pattern, every bitmap with that count matches. Selecting a card additionally filters
by canonical pattern; clicking it again removes only the pattern restriction.

Previews use 60-pixel squares in compact 80-pixel rows and append in pages of 12
as the list scrolls. The list fills the remaining sidebar height down to the footer;
only the list scrolls. Tall viewports automatically load enough rows to fill the
visible area. Only nearby rows mount canvases;
two preview consumers share the existing authenticated parcel transport and use the
canonical Mondrian implementation in the worker. The preview cache retains at most
64 layouts and 4 MiB. Switching modes aborts pending previews and terminates the worker.

`bun test test/patterns.test.ts` checks catalog identity, unique transaction matches,
loop determinism, stale selections, worker previews and stable filtered summaries.
After building, `MAP_SMOKE_BUILD_DIR=/tmp/bitmap-patterns-site bun test/patterns-browser.mjs`
checks the real selector, selection/deselection, scrolling, bounded rows, reload
colors and distant/detail rendering. It writes `/tmp/bitmap-patterns-browser.json`
and `.png`. These are functional local-browser checks, not performance measurements.
