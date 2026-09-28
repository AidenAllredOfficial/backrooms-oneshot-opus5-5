# Screenshots, QA and A/B captures

This page covers the capture tools (`tools/shoot.mjs`, `tools/qa.mjs`, `tools/ab.mjs`), the capture daemon behind
them (`tools/rsd/`), and the memory rules every tool browser, build and test run follows (`tools/lib/budget.mjs`).
The README has the short version.

## Why a daemon

A warm screenshot needs about 0.5-0.8 s of real work: fetch and upload the cached tiles around the camera, render
10-20 settle frames, read back and encode. Until September 2026 each `shoot.mjs` call also paid for things that
never change between calls:

- 1.7 s per call to start Vite (through npx), launch Chromium and absorb the GPU's first-context loss;
- 1.2-1.5 s per shot to boot a fresh page, 0.45 s of it waiting for a context loss the browser had already absorbed;
- 0.48 s per PNG at the default zlib level;
- a fixed 250 ms wait after ready;
- a queue position behind every other agent's whole run, because each call held the only browser slot from start
  to exit.

A typical 14-shot iteration (4 locations, a few poses each) took 37 s warm. The 12-shot D2 benchmark took 33.6 s,
and 4 agents asking for 3 shots each finished after 38 s.

The capture daemon keeps one browser warm for the whole machine, renders content-addressed builds of any source
tree, and queues shots from all clients fairly. On pages with capture contract v2 it moves one page from shot to
shot instead of booting a new one. The 14-shot iteration then takes 7.5 s (15.6 s on trees without contract v2),
and D2 13.2 s. An unchanged re-shoot comes from the capture memo in 0.03 s (0.3 s including Node start). The
4-agent case finishes in 14-17 s. Measurements are at the end of this page.

## Commands

```sh
node tools/shoot.mjs --out /tmp/shots --params "seed=7&zone=LOBBY&time=10&noaudio=1"   # through the daemon
node tools/shoot.mjs --direct --params "seed=7&zone=LOBBY"                             # in this process
node tools/qa.mjs --preset zones --out /tmp/qa                                         # QA through the daemon
node tools/ab.mjs --base HEAD~1 --shots zones --out /tmp/ab                            # A/B against a revision
node tools/rsd/client.mjs status                                                       # daemon, lanes, memory, memo
node tools/rsd/client.mjs stop
node tools/lib/budget.mjs --status                                                     # who holds how much memory
```

The first call starts the daemon on its own. It exits after 10 idle minutes.

## The capture daemon

`tools/rsd/server.mjs` runs as one process per machine. Clients find it through `/tmp/backrooms-render/daemon.json`
(`{ pid, port, version }`). It listens on 127.0.0.1 only.

**Builds.** For each request the daemon hashes the tree's build inputs (`src`, `harness`, `public`, `index.html`,
`vite.config.ts`, `package.json`, `package-lock.json`, `tsconfig.json`, `tools/viteTileCache.ts`), which takes
10-35 ms. A new hash is copied to `/var/tmp/backrooms-render/trees/<hash>` with a `node_modules` symlink and built
there, so nothing is written into your worktree. `vite build` runs with `NODE_ENV=development` and the harness
pages. That keeps `import.meta.env.DEV`, so payload validation and the sampler-budget error that QA relies on stay
in, and the daemon refuses a build whose output lacks `validate:!0`. A build takes 0.85-1.5 s and needs a 950 MB
lease. One build runs at a time on the machine, and concurrent requests for the same tree share it. The daemon
keeps the 20 most recently used builds.

**Serving.** Each build is served at `/b/<distHash>/`, where `distHash` is the SHA-1 of its output files. The tile
cache (`tools/viteTileCache.ts`) is mounted next to it. Every tile-cache setting (`BACKROOMS_TILE_CACHE_DIR`,
`BACKROOMS_TILE_CACHE_MB`) gets its own origin, because the worker addresses `/__tilecache/` on its page's origin.
Requests are routed to the middleware of the tree that made them, found through the `Referer` header, so a tree
with a newer cache protocol never talks to an older middleware.

**Browser.** One headless Chromium with the usual flags (ANGLE/Vulkan, `BACKROOMS_HC` bake workers). It is launched
once and GPU-warmed. It holds a `browser` lease (700 MB and the machine's browser slot) only while it is open. It
is recycled after 200 shots, at 1.2 GB GPU-process RSS, or when the process tree passes 3.2 GB PSS between jobs.

**Queue and lanes.** Shots from all clients go into one queue served round-robin by client. Lane 0 is always
available. Lane 1, a second page in the same browser, opens only when all of these hold:
- the budget admits another 1000 MB page;
- the shot is at quality high or lower and at most 1920x1080;
- lane 0 does not hold a heavy page (ultra, 1440p and up, or a build not yet known to hit the tile cache, all
  weighted 1600 MB); together they reached 3.33 GB PSS;
- recent tile-cache requests of the shot's own build and cache directory show a warm cache (20 or more GETs, 75 % or
  more hits). The window is kept per build: after a worker edit the new build misses every tile, however warm the
  previous build's window was (a global window opened lane 1 on a cold build and the tree reached 3.44 GB PSS). Two
  cold pages would split the memory-bandwidth-bound bake between 8 workers for no gain;
- while a single client has work queued, the shot's boot key differs from the one lane 0 moves through in place.
  A second page of the same key only competes for tile uploads (D2: 13.5 s at 3.21 GB PSS against 14.0 s at
  1.92 GB on one lane). With several clients, lane 0 switches keys between them and lane 1 does help (4 clients x
  3 shots: 16.9 s against 20.6 s).

Shots with evals, and the long presets (`soak`, `stress`, `perf`, `edge`), run alone in the browser. They start only
when no other lane is busy, the other lane's idle warm page is closed first (it keeps rendering frames), and nothing
starts beside them. Their checks measure frame times and behaviour, and a
second page booting next to the tower walk pushed its longest frame from 50 ms to 66-83 ms.

**In-place shots.** When a page reports capture contract v2 (`__backrooms.captureGate >= 2` and `load()`) and
streams only the capture set (`stream=capture`), the lane keeps it after a shot. The next shot with the same boot key
(quality, scale, radius, bake, camcorder, hud, debug, noaudio, autostart, noprime, stream, page, size, HC) is applied
with `__backrooms.load(search)` instead of a new boot. A move to a nearby pose costs 0.3-0.6 s and a move to a new
location 1-2 s, against 2-2.5 s for a fresh page. Within a request, shots are grouped by boot key and sorted by seed,
storey, x and z. Files keep the original indices, and a lane prefers queued shots that match its warm page.

`shoot.mjs` and `ab.mjs` add `stream=capture` to game shots without evals. QA does not: its draw-call and tile checks
must see full streaming. With full streaming a moved page re-streams its whole radius and grows to the 3.2 GB tree
cap, so QA zones took 98 s in place against 86 s on fresh pages. QA therefore always boots fresh pages. These shots
also always boot their own page:
- harness pages and `autostart=0`;
- the `soak`, `stress`, `perf`, `edge` and `ui` presets;
- shots marked `fresh: true` (`spawn-determinism`, so QA still tests boot determinism);
- the shot after an eval or capture error;
- every shot with `--fresh-pages`.

A warm page is recycled after 40 shots, or when the tree PSS, sampled after each job, is over 3.2 GB. At most one
idle warm page is kept.

The warm-cache window cannot predict a cold location on a warm build, and the checks after each job cannot see a
peak inside one. Two pages baking cold QA zones at once reached 4.1 GB PSS, and both became so slow that two shots
failed QA's 20 s readiness limit. So while both lanes run, the tree is also checked every 0.5 s: over 3.2 GB PSS,
lane 1 hands its shot back (its page closes, lane 0 renders the shot later) and rests for 15 s. Cold QA zones on the
contract-v2 tree then peaked at 3.30 GB and passed 36 of 36, with images identical to the warm run.

**Memo.** A finished shot is stored in `/var/tmp/backrooms-render/memo`, keyed by SHA-1 of:
- the build's `distHash`;
- the canonical shot (final launch params sorted, minus `autostart` and `noprime`, plus page, size, wait, evals,
  captures, expect and diff);
- page HC;
- the Chromium version, the GPU renderer string and the browser settings (`CHROMIUM`, `BACKROOMS_GPU`,
  `BACKROOMS_UNCAPPED`);
- a hash of the capture code (`tools/lib/capture.mjs`, `png.mjs`) and the daemon version (every `tools/rsd` and
  `tools/lib` module).

A new build, browser, GPU or tool code therefore never hits an old entry. The memo is capped at 2 GB and evicts the
least recently used entries first. It is never used for `fresh: true` shots, the `perf`, `soak`, `stress`, `edge`
and `ui` presets, or shots with evals, which may measure time. QA only reads it with `--memo`, and readiness-time
checks never apply to a memo hit. `--fresh` re-renders and stores the result. `--no-memo` neither reads nor stores.

**Failures.** Every job has a timeout; a timed-out job's pages are closed and the abandoned run can neither retry
nor keep its page. Screenshots time out after 30 s. A crashed page or a lost GPU context retries once on a fresh
page. A page that does not close within 15 s gets its browser killed. Only the Chromium this daemon launched is ever killed.

**Idle.** Warm pages close after 90 s idle and the browser after 3 minutes. If another tool is waiting for the
browser slot, the idle browser closes within 2 s. The daemon exits after 10 idle minutes. Status polls do not count
as activity.

**Versions.** The daemon's version is a hash of `tools/rsd/*.mjs` and `tools/lib/*.mjs`. A client from a tree with
different tool code asks the running daemon to retire. It finishes its queued jobs and exits, and the client starts
its own daemon. Clients of the retiring daemon's own code wait for it to exit and then start a new one (they do not
fail). A daemon accepts renders for 3 s after it starts even when asked to retire, so the client that started it
always gets its request in and two tool versions cannot retire each other's daemons forever.

**Priming.** A fresh headless browser loses its first WebGL context about 0.5 s after creating it. The daemon
absorbs that loss once per browser. Game pages without evals then get `noprime=1`, which saves 0.45 s per boot.
Shots with evals keep the players' boot. Without the priming wait, ready comes earlier relative to background
streaming. The tower walk and the elevator ride then started before the upper storey had streamed in, and both
failed, although they pass at 5c3ea7d. `BACKROOMS_NOPRIME=0` lets every page prime itself.

**Direct mode.** `--direct` (or `--url <server>`, or `BACKROOMS_RSD=0`) captures in the calling process with the same
capture code: a Vite dev server started with node (no npx) and a browser, launched in parallel under one budget
lease. Use it to capture unbundled dev-server code, or with `--url` against a server you already run. Before capture
contract v2, dev-server captures can differ from daemon captures by timing noise (see below).

## Flags

`shoot.mjs` and `qa.mjs` keep their old flags (`--params`, `--out`, `--size`, `--eval`, `--page`, `--preset`, `--wait`,
`--url`; QA also `--baseline`, `--only`, `--list`). New:

| Flag | Tools | Meaning |
|---|---|---|
| `--direct` | shoot, qa | Capture in this process instead of the daemon. |
| `--tree <path>` | shoot | Render another source tree (a worktree or checkout). |
| `--wait <ms>` | shoot, qa | Wait after ready. Default 250 ms, or 0 on pages that report `captureGate >= 2`. An explicit value always wins. |
| `--draft` | shoot, qa | `bake=preview`: approximate lighting, much faster on cold locations. Entries get `draft: true`; QA refuses `--baseline`. |
| `--fresh` | shoot, ab | Re-render even if the memo has the shot. |
| `--fresh-pages` | shoot, qa | Boot every shot on its own page (no in-place moves). |
| `--no-memo` | shoot | Neither read nor store the memo. |
| `--memo` | qa | Serve unchanged shots from the memo. |
| `--stream full` | shoot | Do not add `stream=capture`. By default it is added to game shots without `--eval` when the tree accepts the parameter. QA never adds it. |
| `--progress` | qa | One progress line per finished shot on stderr. |

`shoot.mjs` prints the same JSON report as before, plus `t` (per-shot timings in ms: page, load, ready, wait, evals,
stats, raf, shot, close, total, and the page's `br:*` marks), `captureGate`, and `memo` / `inPlace` / `draft` when they
apply. `qa.mjs --baseline` now also reports full-resolution changed pixels, pixels more than 8 levels off, and the
largest difference, next to the 64x36 MAD.

### A/B: `tools/ab.mjs`

```sh
node tools/ab.mjs --base HEAD --shots zones                        # uncommitted changes vs HEAD
node tools/ab.mjs --base main --test ../other-worktree --shots /tmp/shots.json --crop 600,300,400,300
node tools/ab.mjs baseline set before-grade                        # pin this tree as a named base
node tools/ab.mjs --base before-grade --shots zones,landmarks --expect same
```

- **`--base`** is a git revision (extracted with `git archive`, no worktree), a tree path, or a named baseline.
  `--test` defaults to this tree.
- **Shots** come from `--shots` (presets, or a JSON file of `{params, ...}` objects or strings) or from repeated
  `--params`.
- **Rendering.** Both trees go to the daemon as one job, interleaved so the two lanes render base and test of the
  same framing together. An unchanged base usually comes from the build cache and the memo.
- **Per pair** it reports changed pixels, pixels more than 8 levels off, the largest difference, MAD, and a
  verdict. `same` means 0 px. `noise` means within the noise floor of `--noise N` fresh base repeats, or, without
  repeats, at most 0.01 % of pixels and at most 2 levels off. Anything else is `changed`.
- **Output.** `contact-N.png` sheets (at most 2000 px tall) show rows of base, test and diff x4 at 1/`--scale`
  (default 5). Pixels more than 8 levels off are red, and each row has a label strip. `--crop x,y,w,h` writes
  full-resolution crops. `ab.json` has every number.
- **`--expect same`** exits 1 if any pair changed.

Named baselines live in `/var/tmp/backrooms-render/baselines`. Their builds and memo entries are never evicted.

## Memory policy

A previous parallel measurement OOM-killed the whole desktop session. The tools now bound their memory
structurally, in layers.

**Budget ledger (`tools/lib/budget.mjs`).** Every heavy job takes a lease with a declared weight before it starts. The
ledger lives in `/tmp/backrooms-budget`: one JSON file per lease, updated under a lock directory. A lease is
admitted when:
- the sum of live weights plus its own is at most `BACKROOMS_BUDGET_MB` (7000);
- MemAvailable minus its weight is at least `BACKROOMS_MIN_FREE_MB` (4500).

Otherwise the job waits and prints the holders once. A `browser` lease also takes one of `BACKROOMS_BROWSER_SLOTS`
(1) lock directories in `/tmp/backrooms-browser-slots`, the same directories older tool versions use, so old and new
tools never run two browsers. A slot held by an older tool counts as 1700 MB. Only one `build` lease exists at a
time. Leases of dead processes are reclaimed; the ledger compares process start times, so a reused pid does not
count. Waiting jobs register too, and the capture daemon releases an idle browser when another tool waits for one.

| Weight (MB) | Job |
|---|---|
| 700 | browser (idle headless Chromium) |
| 1000 | capture page, quality high, up to 1080p |
| 1600 | capture page, ultra, 1440p and up, or cold |
| 500 | Vite dev server |
| 950 | `vite build` |
| 550 | `tsc` |
| 300 + 700 per fork | vitest |

`node tools/lib/budget.mjs --status` lists holders and waiters. The API (`acquire`, `status`, `WEIGHTS`,
`pageWeight`) is typed in `tools/lib/budget.d.mts`. Test runs take a lease as well (300 MB + 700 MB per fork).

**Governor (`tools/lib/procmem.mjs`).** Each capture tool samples its own process tree: RSS every 0.5 s, PSS every
5 s. It acts only on processes it started:
- below 3500 MB MemAvailable it closes idle pages, keeps one lane, and starts no new page until MemAvailable is
  back to 4000 MB;
- below 2500 MB it closes its browser at once. Running shots fail with "memory guard", and nothing restarts until
  4500 MB is free;
- above 3200 MB tree PSS it recycles its page or browser between jobs.

**Structural limits.** One tool browser on the machine, at most 2 pages in it, 4 bake workers per page
(`BACKROOMS_HC=8`), one build at a time.

**Idle.** An idle daemon holds 0.9 GB RSS / 0.5 GB PSS with the browser open (for at most 3 minutes) and 0.17 GB RSS
/ 0.12 GB PSS after it closes.

The last resort stays outside the repository: an ad-hoc OOM guard script run by whoever measures.

## Determinism and parity

- **PNG path.** CDP `Page.captureScreenshot` with `optimizeForSpeed` takes 115-160 ms against 260-710 ms for
  `page.screenshot`. PNG is lossless. On a settled page the two decode to the same RGBA. Where two back-to-back
  captures differed, two consecutive fast captures differed by the same pixels, so the frame changed, not the
  encoding. Harness and title pages keep `page.screenshot`.
- **Daemon vs `shoot.mjs` at 5c3ea7d.** The old tool used a dev server, priming and a 250 ms wait; the daemon uses a
  development build, `noprime=1` and the same 250 ms wait. They give 0 px different on 11 of 12 D2 shots. Ultra
  PARKING differs by 692 px, and two runs of the old tool differ from each other by 629 px on that shot.
- **Direct mode before contract v2.** `noprime` shortens the boot by about 0.4 s, and on the dev server that moves
  when far tiles arrive relative to ready. That changed 1.6k-33k px on 5 of 12 D2 shots. This is the known
  timing dependence of the old ready gate. Capture contract v2 (a position-defined capture set, a frame-counted
  settle and the exposure snap) removes it.
- **QA verdicts.** The 76-shot list `zones,landmarks,views,dark,pools,leak,cornell,spawn,decals,tower,materials,post`
  gave identical pass/fail results and fail messages through the daemon, through `--direct`, and through `qa.mjs`
  at 5c3ea7d, on a warm cache. The comparison ignores readyMs values and the tower's two 50 ms frame-time checks.
  Those checks are flaky under load in every version: the old tool failed them at 50.0-66.7 ms in 3 of 4 runs.
- **With contract v2** (Lane 2's branch merged with this one), D2 at high, ultra and medium was 0 px different
  between in place and fresh pages, daemon build and `--direct` dev server, memo and re-render, and cold and warm
  tile cache.

## Files and environment

| Path | Contents |
|---|---|
| `/tmp/backrooms-render/daemon.json`, `daemon.log`, `browser.json` | Discovery, log, last browser version and GPU |
| `/var/tmp/backrooms-render/trees/`, `builds/` | Staged trees and builds (20 kept) |
| `/var/tmp/backrooms-render/memo/` | Capture memo (2 GB cap) |
| `/var/tmp/backrooms-render/baselines/` | Named A/B baselines |
| `/tmp/backrooms-budget/` | Budget ledger |

| Variable | Default | Meaning |
|---|---|---|
| `BACKROOMS_BUDGET_MB` | 7000 | Sum of lease weights allowed at once. |
| `BACKROOMS_MIN_FREE_MB` | 4500 | MemAvailable that must remain after a lease's weight. |
| `BACKROOMS_BROWSER_SLOTS` | 1 | Tool browsers allowed at once, machine-wide. |
| `BACKROOMS_HC` | 8 | `navigator.hardwareConcurrency` for pages (4 bake workers). |
| `BACKROOMS_RSD` | on | `0` makes shoot/qa capture in-process (`--direct`). |
| `BACKROOMS_NOPRIME` | on | `0`: never add `noprime=1` (every page primes its own GPU context). |
| `BACKROOMS_RSD_LANES` | 2 | Upper limit on daemon lanes (the second still needs the budget). |
| `BACKROOMS_MEMO_MB` | 2048 | Capture memo cap. |
| `BACKROOMS_RSD_IDLE_PAGE_MS`, `_BROWSER_MS`, `_EXIT_MS` | 90000, 180000, 600000 | Idle timers. |
| `BACKROOMS_RENDER_DIR` / `BACKROOMS_RSD_DIR` | `/var/tmp/backrooms-render` / `/tmp/backrooms-render` | Build and memo store / discovery directory. |
| `BACKROOMS_TILE_CACHE`, `_DIR`, `_MB` | on, `~/.cache/backrooms-tilecache`, 8192 | Tile cache per client (the daemon serves each setting separately). |
| `CHROMIUM`, `BACKROOMS_GPU`, `BACKROOMS_UNCAPPED` | | Browser settings. The daemon refuses a request whose settings differ from its browser's; use `--direct`. |

The daemon inherits the environment of the client that started it. Per request it takes the tile-cache settings,
`BACKROOMS_HC` and the eval timeout, and it checks the browser settings. Everything else is daemon-wide until it
exits: the budget variables, `BACKROOMS_RSD_LANES`, the idle timers, `BACKROOMS_NOPRIME`, `BACKROOMS_MEMO_MB` and
`BACKROOMS_RECYCLE_PSS_MB`. To change them, `stop` the daemon and start it again with the new values.

**Troubleshooting.**
- `node tools/rsd/client.mjs log` shows the last daemon log lines.
- `stop` ends the daemon; the next call starts a fresh one.
- `--direct` always works without it.
- Deleting `/var/tmp/backrooms-render` clears builds, memo and baselines.

## Measurements

All runs: 1600x900, the 12-shot D2 list (seed 7; 9 high, 2 ultra, 1 medium), one browser on the machine, a tile cache
warmed beforehand, a free browser slot at the start. Memory is the peak of the measured process tree, sampled every
0.25 s. All runs used the same 250 ms wait as the old tool, because contract v2 has not landed at HEAD.

| Run | Wall | Per shot | Peak tree RSS / PSS |
|---|---|---|---|
| `shoot.mjs` at 5c3ea7d | 33.6 s | 2.8 s | 2.94 / 2.26 GB (incl. Vite) |
| `shoot.mjs --direct` | 26.6 s | 1.9-2.3 s | 3.45 / 2.81 GB (incl. Vite) |
| daemon, 1 lane, first call (build 0.85 s, browser 0.9 s) | 23.9 s | | |
| daemon, 1 lane, warm | 23.0 s | 1.6-2.2 s | 2.21 / 1.58 GB |
| daemon, 2 lanes, warm | 14.9 s | | 3.24 / 2.36 GB |
| daemon, memo repeat | 0.04 s in the tool, 0.3 s with Node start | | |
| 4 clients x 3 shots, 2 lanes | 13.9 s makespan (38.3 s before) | | 3.34 / 2.45 GB |
| A/B of 12 framings, base memoized, test built | 18.7 s | | |
| `qa.mjs --preset zones`, warm, 2 lanes (1.7 min before) | 73.6 s | | QA client 0.14 GB RSS |
| `qa.mjs --preset zones`, cold, 1 lane | 357 s of shots (lane 3's vitest running alongside) | 9.1 s mean ready | 3.19 / 2.53 GB incl. daemon |
| 76-shot QA parity list, warm: 5c3ea7d / `--direct` / daemon | 294 s / 283 s / 226 s | | 4.33 / 3.63, 3.86 / 3.23, 3.64 / 2.96 GB |
| 14-shot iteration: `shoot.mjs` at 5c3ea7d / daemon (this branch) | 37.2 s / 15.6-17.2 s | | 3.03 / 2.34, 3.60 / 2.17 GB |

With contract v2 (Lane 2's branch at c2bacfc merged with this one in a scratch tree; tile cache warmed once; same
conditions otherwise):

| Run | Wall | Peak daemon tree RSS / PSS |
|---|---|---|
| 14-shot iteration, warm daemon (in place; 9.4 s on its first request) | 7.5 s | |
| D2, 2 lanes, first request (browser launch, 3 boots) | 15.6 s | |
| D2, 2 lanes, second request (10 of 12 in place) | 13.2 s | 3.44 / 2.61 GB |
| D2, 1 lane, second request | 14.0 s | 2.52 / 1.92 GB |
| D2 on fresh pages (`--fresh-pages`), 2 lanes | 15.5 s | |
| D2 through `--direct` (dev server, in place) | 16.4 s | |
| D2 from the memo | 0.03 s in the tool, 0.27 s with Node start | |
| 4 clients x 3 shots, 2 lanes | 14.7-17.9 s | 3.64 / 2.74 GB |
| QA zones warm (fresh pages, 2 lanes) | 52.8 s | 3.24 / 2.37 GB |
| QA zones cold (1 lane) | 303 s | |

On that tree the D2 captures were 0 px different between in place and fresh pages, daemon build and `--direct` dev
server, memo and re-render, and cold and warm cache, at high, ultra and medium.

Most runs shared the machine with the other lanes' test runs and captures. The cold QA numbers suffer most: the
bake is bandwidth bound.

The fresh-page shot on the daemon breaks down as: new page 0.05 s, page load 0.33-0.42 s, then ready at
0.7-1.2 s. The page's own boot marks come at textures 0.1 s, shaders 0.55-0.7 s, spawn 0.62-0.84 s and ready
1.05-1.53 s. After that come the wait (0.25 s), stats and two frames (0.05 s), the PNG (0.13-0.16 s) and closing
the page (0.02 s). Against Lane 2's in-progress contract-v2 tree, shots taken in place cost 1.1-1.7 s against
2.0-2.5 s on fresh pages, with no wall-clock wait.

Review re-measurements (Lane 2 at 26c4689 merged with this branch, review fixes applied; same conditions):

| Run | Wall | Peak daemon tree RSS / PSS |
|---|---|---|
| D2 at 5c3ea7d: `shoot.mjs` / daemon 2 lanes warm / memo | 32.9 s / 14.1-14.2 s / 0.32 s | 2.97 / 2.29 (old tool), 3.24 / 2.36 GB |
| 14-shot iteration at 5c3ea7d: `shoot.mjs` / daemon | 39.1 s / 17.8 s | |
| D2 contract v2: in place warm / `--fresh-pages` / `--direct` | 11.5-13.1 s / 13.7 s / 15.7 s | 3.50 / 2.65 GB |
| D2 contract v2, cold cache after a warm build (lane 1 stays closed) | 71.4 s | 3.81 / 3.23 GB |
| 14-shot iteration, contract v2, warm / memo | 7.9-8.0 s / 0.32 s | 2.98 / 2.33 GB |
| 4 clients x 3 shots: 5c3ea7d / contract v2 | 14.2 s / 13.3 s | 3.44 / 2.56 GB |
| QA zones, contract v2: cold (cap guard) / warm | 243 s / 49.4 s | 4.14 / 3.30, 3.52 / 2.65 GB |

D2 with contract v2 was 0 px different, 12 of 12, between cold and warm cache, in place and fresh pages, daemon build
and `--direct`, and memo and re-render. At 5c3ea7d the daemon matched the old tool on 11 of 12 (ultra PARKING
differs by 500-900 px between any two runs, the old tool's included).

Scripts and raw data are in `/tmp/gfx/lane1` (`d2.sh`, `daemonrun.sh`, `multi.sh`, `measure.sh`, `runs/*.mem`).
The review's are in `/tmp/gfx/rev1` (`d2.sh`, `loop14.sh`, `multi.sh`, `qa.sh`, `run.sh`, `runs/`). They are not
part of the repository.
