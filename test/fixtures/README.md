# Test fixtures

`real-blocks.ndjson` contains block heights 806401, 806402, 807408 and 808415
with original transaction order and sizes. Tests require no database or full
transaction export.

`mondrian-results.json` captures expected layout hashes for the deterministic
cases in `test/mondrian-cases.mjs`. It stores results, not a second algorithm.
`http-pack-v1.json` and `http-pack-v2.json` provide independent byte/hash fixtures
for the export formats read by the offline pipeline.

Browser tests also use the bundled public dataset; see
[testing](../../docs/testing.md) for setup.

`bitcoin-blocks.json` includes the public genesis block from the
[Ordinals handbook](https://docs.ordinals.com/inscriptions/recursion.html) and a
small synthetic mixed legacy/SegWit block. Synthetic hashes were calculated
independently with Python hashlib. Its output value deliberately exceeds monetary
consensus limits to exercise integer precision; it is a parser fixture, not a
valid Bitcoin block. Tests require no network access.
