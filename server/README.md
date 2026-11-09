# Static server

From the project root:

```sh
bun run build
bun start
```

The server serves only `dist` at http://127.0.0.1:4174/. It does not compile,
open databases or generate data. `HOST` and `PORT` control the listener; the URL
base comes from `dist/build-info.json`. `bun server/index.ts /other/dist` selects
another prepared site.

GET and HEAD are supported; missing files return 404. Paths and symlinks cannot
escape the served directory. Development uses Vite directly. GitHub Pages can
host the complete `dist` without this server.

See the [project README](../README.md) and [architecture](../docs/codebase.md).
