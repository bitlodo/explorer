# Rebuild the bitmap reference from AWS

The importer restores the shipped Protobuf prefix, reads newer AWS
**transaction** data and writes `data/db/bitmaps.db` as a DuckDB database. It does not
require Bitcoin Core, bitcoin-cli, an AWS account or the AWS CLI.

The source is the public S3 prefix
`s3://aws-public-blockchain/v1.0/btc/transactions/`, organized as
`date=YYYY-MM-DD/part-*.parquet`. A date can contain multiple files; the importer
assembles the whole date before committing it. See the
[AWS dataset registry](https://registry.opendata.aws/aws-public-blockchain/).

## Fresh checkout: restore Protobufs, then continue with AWS

Run `bun run db:sync`. If the database is missing or its `bitmaps` table is empty,
the command first restores `public/map-data` inside one DuckDB transaction.
Every manifest, index page, pack, frame, bitmap ID and geometry file is validated.
Transaction arrays retain their original index order and occupied dimensions come
from authenticated canonical geometry. Sample datasets are rejected as baselines.
An existing nonempty database is never replaced by this automatic restore.

New generations include `bitmap-reference.json` and a small content-addressed
Protobuf of pattern IDs. Older datasets without this addon are supported by
reconstructing exact geometry hashes, grouping identical layouts and recording
the lowest matching height. This fallback can take longer. A cancelled/failed
restore rolls back its rows; rerunning retries the restore.

The boundary date comes from the published height's public
[Mempool block metadata](https://mempool.space/docs/api/rest), with
[Blockstream Esplora](https://github.com/Blockstream/esplora/blob/master/API.md) as
a fallback. The returned block hash and height must match the requested identity.
The importer starts conservatively one UTC day before the earlier of its block
time and median time, then filters AWS transaction rows to heights strictly above
the restored prefix. It saves `seed_height`, `seed_from_date`, `seed_source` and
`seed_snapshot` in `settings`. No old daily Parquet history is backfilled.

`bun scripts/restore-bitmaps.ts` restores the database without running AWS downloads.
`bun scripts/restore-bitmaps.ts --from YYYY-MM-DD` sets a conservative boundary explicitly
and restores entirely from local files, without a block metadata request.
`--source MAP_DATA` selects another complete Protobuf dataset for either command.
`db:sync --bootstrap false` deliberately skips Protobuf restoration; without a
database it starts an AWS backfill from the requested date or genesis.
Dry runs and status inspection never restore or modify the database.

`scripts/validate-bitmap-db.ts` compares the database with its recorded Protobuf/DuckDB source.
For Protobufs it checks every available TX and size, reports missing rows and
checks pattern IDs when the reference addon is available. Newer local rows are
counted separately. An explicit `--reference` overrides the recorded source.

## Commands

```sh
# Metadata only: estimate files and bytes not yet processed.
bun run db:sync --dry-run true

# Download, process and delete each committed day's input files.
# Running this again skips unchanged imported partitions.
bun run db:sync

# Select an inclusive date range for a smaller import.
bun run db:sync --from 2009-01-03 --to 2009-01-12

# Inspect local progress and one reconstructed bitmap.
bun run db:status
bun scripts/query-bitmap-db.ts --block 170

# Compare restored rows with the recorded Protobuf or DuckDB reference.
bun scripts/validate-bitmap-db.ts
```

To start from an existing DuckDB reference instead of downloading its history:

```sh
bun scripts/import-bitmaps.ts --source data_old/bitmaps_simples.duck --from 2024-04-24
bun run db:sync
```

Stop any running sync first. The import opens the source read-only, copies all
four fields with `ORDER BY bitmap ASC`, verifies every copied row and commits
atomically. Transaction arrays retain their original order. Matching existing
rows and newer progress are preserved; differences in transaction data or bounds
stop the import. Reference pattern IDs replace later overlapping matches, and
cached pattern entries are updated to agree with the imported first occurrence.

The source must be a complete prefix starting at block 0. `--from` is the UTC date
covering its last block; use an earlier date if the boundary is uncertain. Sync
lists from that date and imports only heights after the saved baseline. The
baseline is trusted local history and is not fetched again to detect old AWS
corrections. Missing baseline rows require rerunning `bun scripts/import-bitmaps.ts`.

An index of dimensions and parcel counts is built once per imported pattern.
Geometry hashes are resolved lazily and checked against full Mondrian geometry,
so the import does not have to regenerate every bitmap layout. You can verify
the copied reference independently with:

```sh
bun scripts/validate-bitmap-db.ts --reference data_old/bitmaps_simples.duck
```

After an import, `scripts/validate-bitmap-db.ts` uses the recorded seed source by default; an
explicit `--reference` overrides it.

`--db data/db/OTHER.db` selects another DuckDB destination. `--concurrency 2`
controls simultaneous downloads within a day (1–8); `--retries 4` bounds retries.
`--keep-parquet true` retains successfully processed inputs for inspection.
All scripts and output text use English.

The full source listed on 30 October 2026 contained roughly 2.20 TB of Parquet
files. This is the full source size; selective transfer is much smaller. Default processing
keeps only one day's files plus bounded query spill and the DuckDB database.
No full backfill is started automatically by development or build commands.

The first sync creates `data/`, `data/db/` and the temporary directories when
starting from a fresh checkout. No database or data folder needs to ship in Git.

Progress starts with the saved block on resume, then shows only newly imported
work, for example:

```text
Block 23,257 | Resuming sync
Block 23,400 | 2009-09-20 | +143 blocks | +143 tx | 0.05 MB downloaded
Done: 143 blocks, 143 tx; 255 days unchanged. Downloaded 0.05 MB.
```

During listing, saved-progress checks, downloads and import, a live terminal line
updates every second with the current stage and elapsed stage time. Downloads
also show ready files (including reused files) and confirmed downloaded MB for
the current date. DuckDB measures bytes when each file's projection completes,
so MB advances at file completion while the elapsed time keeps updating during
an individual file. The live line is replaced by the completed date's log.
Redirected output uses plain-text updates on stage changes and every 15 seconds;
`--json true` includes structured `activity` events without terminal escapes.

Unchanged dates do not produce completed-date logs. Ctrl+C saves completed work and prints
`Stopped. Progress saved; rerun to resume.` Use `--json true` when structured
progress and the full report are needed by another tool.
Each imported date shows its downloaded Parquet MB, and the summary totals the
current run. MB means 1,000,000 bytes. Reused cached files add zero download bytes.

## Reference fields

| Field | Stored value |
| --- | --- |
| `bitmap` | Block height, primary key |
| `tx` | Native `UTINYINT[]` of parcel side lengths in transaction index order |
| `size` | Native `UINTEGER[]` `[width,height]` for the occupied Mondrian bounds |
| `pattern` | Lowest imported block height with identical rendered geometry |

AWS `block_number`, `block_hash` and `index` establish each transaction's block
and position. `bitmaps` contains only the four reference fields above.
There is no per-bitmap sync metadata table. Source block hashes are validated
during import and then discarded; geometry hashes are stored once per pattern.
The target contains the reference data, not complete transaction scripts or
outputs; transaction index is the position in `tx`.

Parcel side length is `max(1,ceil(log10(total output satoshis))-5)`. AWS
`output_value` is the transaction output total in BTC; it is converted to
eight-decimal fixed point and then integer satoshis. Integer thresholds implement the sizing rule without floating-point
logarithms at powers of ten. Byte size and virtual size do not determine parcels.

`src/shared/MondrianLayout.ts` supplies the existing packing algorithm. Bounds
use `max(x+width)` and `max(y+height)`, excluding unused initial-bin margins.
The geometry hash is SHA-256 of the rectangles sorted by side, X and Y, encoded as
Uint32 triplets. It compares arrangements rather than the input transaction
sequence. For example, reference blocks 100525 (`[5,5,5,1,2,1]`) and 101965
(`[5,5,1,2,1,5]`) both occupy `[9,15]` and share `pattern=100525`. The source order in `tx` is never sorted or changed.

`pattern` means the earliest match **among imported blocks**. Import from genesis
to establish the global first occurrence. Importing an older block later updates
previous matches; replacing an early pattern also repairs affected later rows.

## Incremental state and failure recovery

The same DuckDB file contains these auxiliary tables:

- `settings`: format, source, parcel rule and pattern rule identities.
- `patterns`: one geometry hash per distinct pattern and its earliest imported block.
- `seed_patterns`: compact candidates for imported patterns whose hashes are not yet cached.
- `aws_partitions`: completed date fingerprints, row counts, height ranges and processing times.
- `aws_files`: keys, ETags, byte counts, timestamps and SHA-256 of processed inputs.
- `aws_downloads`: completed downloads retained while a partition is unfinished.

Earlier SQLite files are not migrated. Remove the generated SQLite file before
starting a fresh DuckDB sync. The original DuckDB reference is preserved.

Each run lists remote metadata again, including old dates, so historical source
corrections are detected. An unchanged date is skipped using its sorted key/ETag/
size fingerprint and local block count; its Parquet files need not exist anymore.
A partition stores its imported height ranges once, for example `[[0,142]]`.
Multiple ranges preserve gaps without claiming heights owned by other dates.
Counts are checked against the actual bitmap rows, so a missing imported block
causes its partition to be downloaded again. `db:status` reports `missingBitmaps`
as `MAX(bitmap) + 1 - COUNT(*)`, or zero for an empty database. A complete prefix
starting at block 0 has zero missing blocks.
A changed date is rebuilt and replaces that date atomically. Dates absent from a
listing do not automatically erase already committed reference data.

A day can span listing pages and Parquet files. Transactions are combined by block
and ordered by index. Duplicate/missing indices, inconsistent block hashes,
invalid values and mismatched source dates fail the import. Checkpoints and all
bitmap/pattern updates commit in one DuckDB transaction.
Only after that commit are processed files deleted.
Empty date folders are removed after cleanup. Startup also prunes leftover empty
date folders; folders containing retained, unfinished or unknown files are preserved.

An interruption preserves committed dates. Completed projected files for an
unfinished date are verified and reused on the next run. A partial projection
restarts. Only these source columns are fetched: `block_number`, `block_hash`,
`index`, `date` and `output_value`. DuckDB reads Parquet metadata and required
column chunks through HTTP range requests, then writes a small local Parquet.
The full source object is not downloaded. Source ETag and size are checked before
and after projection; local size and SHA-256 protect reuse and cleanup. A source
replacement fails the projection. Throttling/transient failures use bounded retries.

The maintained `@duckdb/node-api` LTS package includes the platform binary through
normal `bun install`; a separate DuckDB CLI or service is not needed. On first
remote read, the official `httpfs` extension is installed into
`data/aws/bitcoin/.duckdb-extensions`, then reused. Native dependencies do not
require install scripts or a local compiler on supported platforms.

Temporary files stay under `data/aws/bitcoin`; sync state stays under `data/db`.
Both are ignored by Git and excluded from Vite serving. `--json true` reports
`bytesDownloaded` for completed remote Parquet reads and `dayBytesDownloaded`
for the current partition, using DuckDB's measured byte counter. This includes
Parquet metadata and column chunks, excluding HTTP headers, S3 listings and
extension installation. `bytesStaged` is the separate projected size on disk.
`db:sync --dry-run true` lists remote object metadata only, so `sourceBytesPlanned`
is an upper bound based on whole source files, not selective transfer.
The existing `data/databases/bitmaps_simples.duck` remains read-only.

The static Protobuf generation tools use `data/db/bitmaps.db` by default. Run
`bun run map:generate` after sync. It opens the reference READ_ONLY, locks out
concurrent sync, preserves published geometry and adds complete neighborhoods.
See [data tools](data-formats.md#tools). AWS sync itself does not generate or
publish map data. `scripts/validate-bitmap-db.ts` reports differences
in all four reference fields; rows newer than the reference are counted
separately. A partial history can differ in `pattern` because earlier occurrences
have not been imported.
