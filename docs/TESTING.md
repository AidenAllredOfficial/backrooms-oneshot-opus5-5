# Testing

The suite runs on vitest 5.0.1 (pinned) and Node 24, in two tiers. The full gate runs every test at full scale and
belongs before a merge. The quick tier skips the tests tagged `sweep`: statistical and acceptance sweeps, and real
full-bake gates. It runs a few invariant sweeps on a subset instead, and it is what to run after every edit.

## Commands

| Command | What runs | Wall time | Peak RSS of the vitest tree |
|---|---|---|---|
| `npm test` | everything, sweeps at full scale | 61 s at 4 forks, 92 s at 2 (was 210 s) | 2.1-2.3 GB at 4 forks, 1.5 GB at 2 (was 1.9 GB) |
| `npm run test:quick` | everything except `sweep` tests | 26-31 s at 4 forks, 37-46 s at 2 | 1.8-2.0 GB at 4 forks |
| `npm run test:related -- <src files>` | quick-tier tests whose import graph reaches the files | see below | |
| `npm run test:changed` | quick-tier tests reached by uncommitted changes | | |
| `npx vitest run tests/post/ssr.test.ts` | one file, all of its tests; invariant sweeps at quick scale unless `BACKROOMS_TEST_FULL=1` | 0.6 s plus the tests | |

`test:related` after a typical edit, quick tier, 4 forks:

| Edited file | Test files | Before | Now | Peak RSS |
|---|---|---|---|---|
| `src/post/PostStack.ts` | 2 | 1.7 s | 1.7 s | 0.7 GB |
| `src/bake/direct.ts` | 20 | 58.6 s | 11.1 s | 2.4 GB |
| `src/world/zones/parking.ts` | 59 | 174.5 s | 21.7 s | 2.6 GB |

All of these were measured on the 32-core, 16 GB laptop while two other agents were baking and capturing. The load
average was 7-9 during the 4-fork runs and 3-4 during the paired 2-fork runs, and at 7-9 every test ran about 1.5x
slower than at 3-4. The quick tier and the bake-related run also include `tests/workers/tileCache.test.ts`, which
takes 5-6 s and about 600 MB of heap until its round-trip check gets cheaper (another change). Details are at the end.

## For agents

- After each edit, run `npm run test:related -- <the src files you changed>`. A rendering file (post, materials,
  lighting, stream, app) reaches 1-3 test files and takes a few seconds. A world or core file reaches most of the
  suite.
- Before a merge, run `npm test`.
- Run one vitest at a time, and never pass `--maxWorkers`. The run sizes its forks from the memory budget described
  below. To ask for fewer, set `BACKROOMS_TEST_WORKERS=1..4`.
- A failing `sweep` test only shows up in `npm test`. `npx vitest list --tags-filter=sweep` lists them.

## Memory: how many forks a run gets

`vitest.config.ts` sizes the fork pool when the run starts, in `tests/util/forks.ts`.

- A run weighs 300 MB for the main process plus 700 MB per fork. Measured with native loading, the main process
  takes about 160 MB and a fork about 300 MB, just under 1 GB at most.
- When the machine-wide ledger `tools/lib/budget.mjs` exists (the capture tools' memory budget), the run takes the
  most forks, at most 4, whose weight the ledger admits, as a `vitest` lease. The ledger keeps the sum of all live
  leases within `BACKROOMS_BUDGET_MB` (7000) and MemAvailable minus the new weight at or above
  `BACKROOMS_MIN_FREE_MB` (4500). A run waits only when even 1 fork is refused, and says so. Vitest releases the
  lease when it exits.
- Without the ledger, a run takes the most forks, at most 4, that leave MemAvailable minus the weight at or above
  `BACKROOMS_MIN_FREE_MB`.
- While a tool browser runs, a run takes at most 2 forks. A browser is a live `/tmp/backrooms-browser-slots/slot-N`
  or a ledger lease of kind `browser`.
- Concurrent runs share 6 forks machine-wide (`BACKROOMS_TEST_FORKS_TOTAL`). Each run reserves its forks in
  `/tmp/backrooms-test-forks`, one file per run, and runs that died do not count. The first run gets 4, a second
  gets 2 and a third waits. The memory ledger alone would admit two 4-fork runs, since 2 x 3100 MB fits in 7000.
- Watch mode (`npx vitest`) never takes a lease and never waits.
- Every fork runs with `--max-old-space-size=1536`, so a runaway test fails instead of eating the machine. The
  largest heap measured at the end of a file is about 620 MB.

The first line of every run says what it got, for example
`vitest: 4 forks (MemAvailable 11066 MB, budget ledger 3100 MB)`.

## How the runner is set up

- **Native loading.** With `experimental.viteModuleRunner: false`, Node strips the TypeScript types and imports
  `src/` as plain ESM, as the browser does. Vite's module runner had turned every cross-module reference in the world
  and bake code into a getter call, which cost 43% of the suite's CPU. Code under test therefore needs:
  - erasable TypeScript only, which tsconfig already enforces with `erasableSyntaxOnly` and `verbatimModuleSyntax`;
  - no `vi.mock`, which would need the module loader;
  - a guard around `import.meta.env`, which is undefined under Node. Write
    `import.meta.env ? import.meta.env.DEV : true`, as `src/materials/warmup.ts` does. Vite still folds it away in
    production builds.
- **Projects.** The `heavy` project runs every file in a fresh process: tests/world, bake, integration, audio, mesh
  and workers, plus the slow files elsewhere (lighting/flicker, props/props, props/tileProps, player/traversal,
  materials/depthPrepass). The `unit` project runs everything else in shared worker processes (`isolate: false`,
  `unstubGlobals: true`), so a unit test must not leave module state or globals behind. Vitest queues every heavy
  file before any unit file, which is why a slow file belongs in `heavy`: in `unit` it starts last and runs alone.
  `npx vitest run --sequence.shuffle` checks that order does not matter.
- **Timeouts.** Every test and hook gets 60 s, `sweep` tests 600 s. Do not add per-test timeouts. A test that needs
  more than 60 s is a sweep.
- **Compile cache.** `NODE_COMPILE_CACHE` defaults to `node_modules/.cache/node-compile`, so the fresh fork
  processes reuse V8 bytecode for three.js and `src/`. Delete the directory to reset it.
- **Results cache.** Vitest runs failed files first, then the longest, using the durations of earlier runs in
  `node_modules/.vite/vitest/*/results.json`. Without durations it falls back to file size, which started the
  slowest quick-tier files last. Quick-tier runs, meaning any `--tags-filter` that excludes `sweep`, keep their own
  cache under `node_modules/.vite/quick`. They get quick-tier order and never reorder the full run.

## Writing tests

- **Tag sweeps.** Give `{ tags: ['sweep'] }`, on the `it` or its `describe`, to a test that loops over hundreds of
  seeds, chunks or pairs, bakes full lightmaps for many tiles, measures wall-clock performance or checks a
  statistical threshold. A test that reads state built by a tagged test needs the tag too, like `logs bench numbers`
  in `tests/integration/pipeline-*.test.ts`.
- **Invariant sweeps may keep a slice** in the quick tier. `sweepSize(full, quick)` from `tests/scale.ts` runs the
  first `quick` items of the same sequence unless `BACKROOMS_TEST_FULL=1`, which `npm test` sets. Use it only for
  checks that hold per item, or whose aggregate is a minimum or maximum, so the slice can never fail where the full
  sweep passes. Statistical thresholds (rates, means, "appears at least once per N chunks") get the tag instead and
  never run scaled down.
- **Never call `expect()` per cell, edge or sample inside a hot loop.** A call costs about 2.7 µs against 0.003 µs
  for the comparison, and a message template gets built on every call. Guard it so the same matcher and message run
  only on failure (see `tests/util/check.ts`):

  ```ts
  if (!Object.is(a, b)) expect(a, `cell ${c}`).toBe(b);           // toBe is Object.is
  if (!(a >= b)) expect(a).toBeGreaterThanOrEqual(b);             // negated, so NaN still fails
  if (!isDeepStrictEqual(a, b)) expect(a).toEqual(b);            // strict deep equality implies toEqual
  if (LIST.indexOf(x) === -1) expect(LIST).toContain(x);         // toContain on an array is indexOf
  ```

- Free a heavy module-level cache in an `afterAll` after its last user, as `tests/world/content.test.ts` does with
  its 1000-chunk sweep.
- The worker-pipeline gate lives in `tests/integration/pipeline-a/b/c.test.ts`, split by zone index mod 3 into 17, 17
  and 16 full-bake tiles, with the helpers in `pipelineHarness.ts`. Each shard's untagged smoke test keeps the
  worker-boundary checks in the quick tier.
- Audio runtime tests wait for the buffer bank with `audio.idle()` (`BufferBank.idle()`) rather than polling the
  clock, and share synthesis results through `BufferBank.synthMemo`, which stays null in the game.
- When a test reads state that an earlier test of its file built, its `describe` needs `shuffle: false` so
  `--sequence.shuffle` runs keep the order. The pipeline bench logs and zones-deep's seam-arch channel count do this.
- `tests/mesh/perf.test.ts` is a wall-clock gate: the buildTile median must stay at or below 20 ms. It measured
  7-15 ms in normal runs, and 22 ms once, with two full runs and other agents' bakes going at the same time. If it
  fails on a saturated machine, run it alone before suspecting the code.

## Measurements

These were taken on September 28, 2026, on the RTX 5070 Ti laptop (32 cores, 16 GB), while two other agents ran
browsers, bakes and test runs. `/tmp/gfx/tests/mon.sh` summed the RSS of the whole vitest process tree, `npm`
included, every 0.5 s. The vitest JSON reports, RSS samples and logs are in `/tmp/gfx/lane3`.

Paired full runs at 2 forks, back to back, load average 3-4:

| | Old config (5c3ea7d: module runner, maxWorkers 2) | This config |
|---|---|---|
| Wall | 210.0 s | 92.5 s |
| Test time summed over files | 397 s | 171 s |
| Peak tree RSS | 1912 MB | 1514 MB |

By fork count, full runs took 92.5 s and 1.5 GB at 2 forks (load 3.3), 87.4 s and 2.0 GB at 3 (load 11.4), and
61.0 s and 2.3 GB at 4 (load 8.5). All were green with 1450 passed and 5 skipped.

Test time per file, old config at 2 forks against this config at 2 forks:

| File | Before | After |
|---|---|---|
| integration/pipeline, now 3 shards | 59.8 s | 34.6 s |
| world/zones-l0 | 37.0 s | 8.0 s |
| world/content | 33.1 s | 8.9 s |
| world/zones-deep | 26.7 s | 10.3 s |
| world/spawn | 24.9 s | 9.7 s |
| world/pacing | 21.8 s | 7.2 s |
| lighting/flicker | 21.8 s | 6.4 s |
| audio/engine | 21.0 s | 4.2 s |
| world/coverage | 15.1 s | 4.7 s |
| world/seams | 15.1 s | 4.5 s |

Native loading roughly halved every compute-heavy file. Guarding the hot-loop assertions took the zones-l0
invariants from 0.65-2.0 s to 0.08-0.2 s per zone, content's placeProps sweep from 5.7 s to 0.3 s, and flicker's
determinism check from 1.0 s to 15 ms. Waiting on `idle()` instead of 1.5 s stability polls, plus shared synthesis,
took audio/engine from 20 s to 4.4 s. The 50-tile gate now spreads over three forks.

The quick tier took 29.1 and 31.0 s at 4 forks and load 7-9 with its own results cache, and 25.7 s in one run with
`--no-cache`. Its peak was 1.9-2.0 GB. It spent 81-93 s of test time, 5-6 s of it in
`tests/workers/tileCache.test.ts`, whose fork also made the 650 MB peak. At the load of the paired runs the same
tests take about 60% as long, which puts the quick tier near 18-20 s and 1.5 GB once the tile-cache check is cheap.

Two `npm test` started 4 s apart got 4 and 2 forks. Together they peaked at 3.3 GB, and MemAvailable never fell
below 6.3 GB. `tests/audio/engine.test.ts` passed 5 times in a row at load 11-13. Three full runs with
`--sequence.shuffle` (seeds 11, 22 and 33) passed.

Correctness checks:

- `npx vitest list --no-staticParse` lists the 1428 test ids from before minus the 5 of the old pipeline file, plus
  the 12 of its three shards (smoke tests included), 5 `BufferBank` idle tests and 11 fork-sizing tests: 1451 in all.
  `--tags-filter=sweep` lists 53 of them and `--tags-filter='!sweep'` the other 1398.
- Flipping the same expected value in the old and the new version of 18 guarded loops, across 11 files, makes each
  one fail with the same message in both.
- The production bundle is byte-identical before and after the `import.meta.env` guard in
  `src/materials/warmup.ts`, and a development-mode build keeps the sampler-budget check.
