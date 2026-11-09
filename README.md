# Bitmap Explorer

Explore Bitcoin blocks as a continuous analytical 2D map. Each block is a
**bitmap**, each transaction is a **parcel**, and up to 2,016 consecutive blocks
form a **neighborhood**.

Developed by **@bitlodo**, using the packing format developed by
[Bitfeed](https://bitfeed.live).

For more information, visit [Bitlords](http://bitlords.land) and
[Bitmap Metaverse](https://linktr.ee/BitmapMetaverse).

The project uses public Bitcoin blockchain data hosted by AWS in **Parquet**
files. The maintenance tools import those transactions into a local DuckDB
database and generate the map's distributed Protobuf files. See
[the data source and importer](docs/aws-bitmap-sync.md).

The application is a static React/TypeScript site for desktop browsers, with
analytical layers, filters, bitmap inspection, comparison and CSV export.
The dataset is included in `public/map-data`; running or building the site needs
no database, API server, AWS account, API key or `.env` file.

## Run locally

Requires **Bun 1.4.4 or later**. Clone this repository or download and extract its
ZIP, then run these commands from the project directory:

```sh
bun install --frozen-lockfile
bun run dev
```

Open http://localhost:5173/. Search by block height, pan the map and use the
five-stop zoom slider. Keep `public/map-data` complete when downloading the project.

## Normal update workflow

1. Download newer blockchain data into the local database:

   ```sh
   bun run db:sync
   ```

2. Update the distributed map files and choose **Continue updating**:

   ```sh
   bun run map:generate
   ```

3. Check the updated map locally. Open the displayed URL, try search, zoom and
   filters, then stop the development server with Ctrl+C:

   ```sh
   bun dev
   ```

4. Generate and check the production build:

   ```sh
   bun run build
   bun run check:site
   ```

5. Publish the entire `dist` directory to your static host. For GitHub Pages,
   commit and push the updated dataset and source to `main`; the included workflow
   builds and publishes automatically. See [Publish](#publish) for setup.

- `db:sync` restores a missing or empty database from the included map files,
  then imports newer public AWS transactions. Existing databases keep their progress.
- `map:generate` offers **Continue updating** (the usual choice) or **Rebuild from
  scratch**. Continue adds complete neighborhoods; rebuild regenerates all map
  files from the database while preserving the database and sync checkpoints.

Only complete neighborhoods of 2,016 blocks are published; the remaining blocks
wait in the database. The first restore and sync can take time; progress is shown
in the terminal. Reload an open map after generation. Sync and generation do not
build or publish the application.

For unattended updates, use `bun run map:generate --mode continue`.
See [maintenance](docs/maintenance.md) for recovery, validation and advanced tools.

## Develop and build

```sh
bun run typecheck
bun run test
bun run build
bun run check:site
bun run preview
```

Preview serves `dist` at http://localhost:4173/. The build validates the dataset
and replaces `dist` only after successful staging. Each successful build updates
`build-version.json`, which supplies the footer's build number and UTC date.
After Vite finishes compiling, the build checks dataset metadata, references,
file sizes and hashes while copying. It does not recompute layouts or filters.
The terminal shows each stage, completed units and elapsed time. For an explicit
deep audit, use `bun run build --validation full`; that mode can take several minutes.
See [testing](docs/testing.md) for focused suites and browser checks.

The package exposes only these everyday commands:

| Command | Purpose |
| --- | --- |
| `dev` | Develop with Vite and React Fast Refresh |
| `db:sync` | Restore if needed, then import newer AWS transactions |
| `db:status` | Inspect database coverage and sync progress |
| `map:generate` | Update or rebuild the distributed map dataset |
| `typecheck` | Check application and tooling types |
| `test` | Run infrastructure and client regression tests |
| `build` | Validate data and build the static site into `dist` |
| `check:site` | Smoke-check the built site's entry, manifest, HEAD and 404 |
| `preview` | Preview the build with Vite |
| `start` | Serve the build with the optional Bun static server |

Run each with `bun run COMMAND`. Diagnostics and individual generation stages
remain available through explicit script paths in [maintenance](docs/maintenance.md).

## Publish

Publish the **entire `dist` directory** to a static host. For a GitHub project
page, set the repository base path and enforce the complete site's size limit:

```sh
bun run build --base /REPOSITORY/ --max-bytes 1000000000
SITE_BASE=/REPOSITORY/ bun run preview
```

Use `/` for a custom domain or account-level site. Select **GitHub Actions** as
the repository's Pages source. The included **Publish GitHub Pages** workflow
runs on every push to `main`, or manually from Actions. It installs dependencies
from the lockfile, builds with the base path reported by Pages, verifies the site
and publishes `dist` only after those steps succeed. Deployment is restricted to
`main`. It checks the size limit and uses the checked-out dataset; it does not
sync AWS data or regenerate map files.
Each build creates `dist` from the current application and selected map dataset.
It does not include cached releases, old builds or unreferenced dataset history.
Git manages source versions. Additional `.gz` copies are off by default; use
`--precompress true` only for a server that serves them. See
[dataset publication](docs/immutable-releases.md) for validation details.

## Project guide

| Path | Purpose |
| --- | --- |
| `src/` | React UI, map runtime, data clients and workers |
| `src/shared/` | Layout algorithms, codecs and data contracts |
| `public/map-data/` | Complete distributable dataset, included in Git |
| `scripts/` | Build and offline maintenance tools |
| `server/` | Optional Bun static server |
| `test/` | Regression tests and browser harnesses |
| `docs/` | Architecture, data, maintenance and testing guides |
| `data/` | Local databases and temporary AWS inputs, outside Git |
| `.cache/maintenance/` | Offline maintenance outputs, outside Git |
| `dist/` | Generated site; the only directory to publish |

Before changing the implementation, read [architecture](docs/codebase.md),
[data formats](docs/data-formats.md) and [testing](docs/testing.md).
See [analytics](docs/analytics.md) for metric definitions and
[performance](docs/performance.md) before changing rendering or indexing.
