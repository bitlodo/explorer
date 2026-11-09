# Maintenance

For normal updates, run these commands from the project root:

```sh
bun run db:sync
bun run map:generate
```

Running or building the application only needs the included `public/map-data`.
Database restoration, AWS downloads and map generation are optional maintenance
work; they are never started by `dev` or `build`.

## Update an existing checkout

With your local changes saved and a clean working tree:

```sh
git pull --ff-only
bun install --frozen-lockfile
bun run dev
```

This uses the dataset from the repository. To advance it beyond the checked-out
version, run the two maintenance commands above. Keep the local database between
updates so that sync can reuse its checkpoints. A downloaded ZIP has no Git
history; download a new copy for source updates and preserve your local databases
when transferring workspaces.

## Database sync

`db:sync` restores a missing or empty `data/db/bitmaps.db` from authenticated
Protobuf data, then imports newer public Bitcoin blockchain transactions from
AWS Parquet files. It needs internet access but no AWS credentials or `.env` file.
An existing nonempty database is preserved. Downloads and imports report live
progress; successfully committed temporary Parquet inputs are removed.

Useful inspection commands:

```sh
bun run db:status
bun run db:sync --dry-run true
bun scripts/query-bitmap-db.ts --block 170
bun scripts/validate-bitmap-db.ts
bun scripts/data-stats.ts
```

The dry run lists remote metadata without importing rows or restoring the
database. Validation compares local rows against their recorded Protobuf or
DuckDB reference. Dataset statistics report file counts and disk usage.

To restore without downloading AWS transactions:

```sh
bun scripts/restore-bitmaps.ts
```

The initial restore resolves the boundary block's UTC date through the public
Mempool API, with Blockstream Esplora as a fallback. For offline restoration,
use `bun scripts/restore-bitmaps.ts --from YYYY-MM-DD` with a conservative date
covering the last distributed block. Datasets without the reference-pattern addon
are supported, but reconstructing patterns requires additional CPU work.

Use `--db FILE` to select another database. `DB_BITMAP` in an optional local
`.env` also selects the generation database; `.env.template` documents the default.
See [AWS sync](aws-bitmap-sync.md) for sync-specific options, date ranges,
reference imports and storage details.

## Map generation

`map:generate` asks for a mode in an interactive terminal. Automation must select
one explicitly:

```sh
bun run map:generate --mode continue
bun run map:generate --mode restart
```

- **Continue** reads the published cursor and appends only newer complete
  neighborhoods. It trusts existing history instead of auditing old payloads or
  scanning historical transactions. If the database has only 2,000 of the next
  2,016 blocks, it reports 16 missing and creates no new neighborhood.
- **Restart** reruns every generation stage from the local database. Use it after
  correcting historical rows. The database and AWS checkpoints are preserved.

The standard pipeline creates the required geometry, vectors, previews,
analytical data, zoom-4 summaries and parcel filters. Continue refreshes the
installed addons for the new revision. You do not need to run these stages
separately for routine updates. The output uses the native semantic source layout
and retains existing immutable semantic history.

Before replacing `public/map-data`, continuation validates new/changed payloads
and complete index coverage against the published snapshot. Unchanged artifacts
keep their authenticated identities and receive existence/length checks, without
decoding old parcels or recomputing old neighborhood layouts. Rebuild and
explicit `build --validation full` audits perform the complete validation.
Generation uses an ignored `.tmp/generation-*` directory and deletes it after
success or failure, including intermediate files, logs and the replaced dataset.
A failed update keeps the previous public data through rollback. A recovery
journal protects an interrupted replacement and is removed when recovery finishes.
Vite reads the replacement dataset immediately. Reload an already open map after
generation to load its new manifest; each map session pins its selected revision.
New complete neighborhoods are added without repacking existing canonical
geometry. An incomplete final neighborhood stays in the database for the next run.
Previews and bitmap vector indexes are refreshed for a changed revision.
An interrupted attempt continues from the last published neighborhood on its next
run; unfinished temporary work is regenerated rather than kept as a cache.
Continuation works from the public manifest without a generation cache or an extra
progress file. If only 2,000 of the next 2,016 bitmaps exist, it reports 16 missing
and creates nothing. Use rebuild after correcting historical database rows.
Spatial chunks shared by old and new neighborhoods reuse their old Protobuf
records and read only the additions from the database.

Progress streams live to the terminal with the current operation, each processed
neighborhood ID, chunks written, unique bitmaps written and fully completed
neighborhoods. Counters and percentages increase within each named operation.
Chunk writing follows spatial order, so bitmap counts measure completed work
rather than the highest block height encountered. Neighborhood IDs identify
individual results; they are separate from the progress counters. Detailed output
is streamed to the terminal. Failure details are shown before temporary logs are deleted.

Filenames use **SHA-256 of file content**, never random IDs. The same reference
rows and generator version produce the same `.pb` names and bytes on another
computer. Temporary work directory names do not enter the Protobuf payloads.
Commit the complete `public/map-data` dataset after generation; databases and
maintenance outputs are ignored by Git. Building/publishing remains separate.

## Build the current project

After an update, review and commit the complete `public/map-data` change when you
want others to receive it. Databases, temporary AWS inputs and maintenance outputs
are outside Git. Keep `build-version.json` when transferring a build workspace;
each successful build advances its counter.

Build and publication are separate from data maintenance:

```sh
bun run build
bun run check:site
bun run preview
```

Builds create a fresh `dist` from current source code and the selected dataset.
The build copies only the active release, its authenticated metadata and its
referenced files. Cached releases, earlier build output and unreferenced source
history are excluded. Git manages source version history; no release store or
`--store` option is needed.

Validation runs before replacement. Staging and rollback preserve the previous
site and build counter if validation or the optional size cap fails. Publish the
entire `dist`. See [dataset publication](immutable-releases.md) and
[the static server](../server/README.md) for optional Bun hosting.

Vite's completion message covers client compilation. A normal build then checks
manifest/release bindings and every selected file's path, size and SHA-256 while
copying. It does not regenerate geometry, decode all transactions or recompute
filters. Missing files, mismatched lengths and same-size corruption still fail
before replacing `dist`. Integrity is checked on every build without a cached
validation result.

Deep validation remains in map generation and can be requested explicitly:

```sh
bun run build --validation full
```

That audit also recomputes canonical geometry and validates parcel membership,
mode summaries and parcel filters, so it can take several minutes. Explicit
legacy intermediate inputs retain deep validation. `build-info.json` records
which mode was used.

`[build]` lines show stages, real completed units, copied MB and elapsed times.
The parent heartbeat updates once per second in a terminal and every five
seconds in redirected logs, including during CPU-heavy full audits. Percentages
apply to the named stage rather than the entire build.

Precompressed `.gz` copies are disabled by default; `--precompress true` enables
them for the optional Bun server. Map payloads retain their original bytes and
names, so this build change does not require `map:generate`.

For a Pages build with a total size cap:

```sh
bun run build --base /REPOSITORY/ --max-bytes 1000000000
```

| Local path | Role |
| --- | --- |
| `data/databases/` | Preserved maintenance/reference databases |
| `data/db/bitmaps.db` | DuckDB generation source and AWS sync checkpoints |
| `data/aws/bitcoin/` | Temporary AWS transaction Parquet files |
| `.cache/maintenance/` | Separate offline outputs, releases and preserved data revisions |
| `.tmp/generation-*` | Automatic staging, removed after success or failure |

Do not delete original databases or local data recovery revisions as cleanup.
Generation's temporary rollback copy is not a permanent recovery archive.

## Advanced tools and command audit

The package keeps ten everyday commands. The former aliases below were removed
from `package.json` because they are diagnostics or individual pipeline tools,
not because their implementations are deprecated. Their scripts and tests remain.
Use the explicit commands when investigating data or changing a format.

| Former alias | Current invocation | Role |
| --- | --- | --- |
| `db:plan` | `bun run db:sync --dry-run true` | Preview remote metadata |
| `db:bitmap` | `bun scripts/query-bitmap-db.ts --block HEIGHT` | Inspect one local bitmap |
| `db:validate` | `bun scripts/validate-bitmap-db.ts` | Compare the DB with its reference |
| `db:restore` | `bun scripts/restore-bitmaps.ts` | Restore without AWS transactions |
| `map:stats` | `bun scripts/data-stats.ts` | Inspect dataset size |
| `map:lod4` | `bun scripts/generate-lod4.ts` | Generate a spatial addon |
| `map:summaries` | `bun scripts/generate-lod4-summaries.ts` | Generate mode summaries |
| `map:parcel-filters` | `bun scripts/generate-parcel-filters.ts` | Generate exact parcel filter grids |
| `map:lod4:validate` | `bun scripts/validate-lod4.ts` | Validate a spatial addon |
| `map:lod4:install` | `bun scripts/install-lod4.ts` | Install a validated spatial addon |
| `map:metrics` | `bun scripts/generate-spatial-metrics.ts` | Convert existing analytical pages |
| `map:vectors` | `bun scripts/tools/prepare-neighborhood-chunks.ts` | Generate bitmap vector chunks |
| `map:vectors:install` | `bun scripts/install-bitmap-chunks.ts` | Install bitmap vector chunks |
| `map:release` | `bun scripts/publish-release.ts` | Prepare a validated immutable release |
| `map:migrate` | `bun scripts/migrate-map-data.ts` | Convert physical dataset paths |
| `test:infra` | `bun test --timeout 60000 ./server ./scripts` | Focused infrastructure tests |
| `test:client` | `bun test --timeout 60000 ./test` | Focused client tests |

Generation and conversion tools require their own input/output options. See
[LOD4](lod4.md), [data tools](data-formats.md#tools) and
[immutable releases](immutable-releases.md) for complete commands.

Prepare a separate revision without replacing public data:

```sh
bun scripts/generate-static.ts --out .cache/maintenance/NEW_REVISION
bun run build --data .cache/maintenance/NEW_REVISION/map-data --out /tmp/bitmap-review
```

Convert existing addons into separate new destinations:

```sh
bun scripts/generate-spatial-metrics.ts --source public/map-data --out .cache/maintenance/NEW_METRICS --install true
bun scripts/tools/prepare-neighborhood-chunks.ts public/map-data .cache/maintenance/NEW_VECTORS
bun scripts/install-bitmap-chunks.ts --source .cache/maintenance/NEW_VECTORS --target public/map-data
```

These installers validate before replacing discovery and preserve canonical
rectangles and earlier payloads. A site build remains a separate step.

For independent raw Bitcoin block inspection:

```sh
bun scripts/decode-block.ts --out .cache/maintenance/block-840000.json
```

This defaults to the Ordinals block-840000 endpoint and also accepts a block
height/hash, custom URL or saved response; see
[block decoding](data-formats.md#decode-a-bitcoin-block).
