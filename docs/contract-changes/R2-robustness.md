# R2 robustness & automation (batch B9)

Goal: never silently degrade the image, reach play faster, spend the GPU headroom on visible fidelity, and make QA
shots show what they claim, keeping the soak / streaming / teleport strengths.

`src/core/*` changes are additive (logged in STATUS.md): `core/debug.ts` (LaunchParams.bake `'interactive'`,
`MemoryStats`, `DebugStats.memory?`, `AutowalkReport.frameMsMax?` / `displacement?`, `autowalk({ heading })`,
`flickerWindow?()`), `core/quality.ts` (preset values, doc comments; no new fields).

## 1. Dynamic resolution: cost relative to the refresh (post/DynamicResolution.ts, app/loop.ts, app/perf.ts)

The WP11 controller read the frame INTERVAL: a 50 Hz display or a 30 fps throttle (p95 20 / 33 ms > 18 ms) scaled
1.0 -> 0.6 in 9 s with the GPU at 1.4 ms, and never recovered at 60 Hz (needed p95 < 12 ms).

Now `dynRes.update(frameMs, cpuMs, gpuMs)` (loop: `core.cpuMs`, `core.gpu.consume()` = a GPU timer result only when
a new one arrived). Every 2 s window:

| | rule |
|---|---|
| refresh | 20th percentile of the intervals, clamped 6.9-33.4 ms; tracked across windows (down at once, up by 25 %/window, prior 60 Hz) |
| with GPU timer (results in >= half the frames) | load = max(p90 gpu, p90 cpu); down 0.1 if load > 0.85 x refresh, up 0.05 if < 0.55 x refresh |
| without | down only if p50 interval > 1.25 x refresh AND p90 cpu > 0.5 x refresh; up if p95 interval <= 1.05 x refresh |
| missed vsyncs (both, checked first; verifier addition) | down 0.1 when, in 2 windows in a row, the display estimate is stable (p20 <= 1.1 x refresh), p90 cpu < 0.5 x refresh and > 8 % of the frames took > 1.5 x refresh; the scale that missed becomes a ceiling for up-steps for 15 windows (30 s), doubling (max 60) each time a probe after expiry misses again; no up-step while a miss window awaits confirmation |

Relative thresholds only (a GPU downclocks under light load: 3.2 ms at scale 0.8 vs 1.4 ms at 1.0). Range
[0.6, preset renderScale] (ultra: 1.5, supersampling). The applied pixel ratio is capped at `MAX_PIXEL_RATIO = 2`
(`maxScaleFor`; ultra on a 2x display renders 2x, not 3x). `push(frameMs)` without cost keeps the old absolute rule
(legacy callers; tests/post/exposure.test.ts still exercises it). `applyQuality` starts the new controller at the
preset's (capped) scale. Measured (audit dynres / dynres2): 20 ms and 33 ms intervals keep 1.0 for 14 s (before:
0.6); a 4 s 33 ms stretch followed by clean 60 Hz stays at 1.0 (before: 0.8 for good).

Verifier finding (missed-vsync rule): the TIME_ELAPSED query does not see all of a frame's GPU cost (compositor
downscale / resolve work of a supersampled canvas). Ultra at 1.5x read 7 ms GPU and ~4 ms CPU, far under the 0.85 x
16.7 ms threshold, yet ran 47-54 fps (p95 33 ms, ~11 % of frames took two intervals) at spawn and in the Poolrooms;
the cost-only controller held 1.5 and never reacted (before B9, ultra at 1.0: 60 fps). A fixed scale=1.25 ran a clean
60 fps. With the missed-vsync rule ultra settles at 1.3-1.4 at 60 fps (audit settle: spawn 1.4, Poolrooms 1.3) and
probes back up after the hold; the throttle cases (20 / 33 ms intervals, a throttle starting mid-window) still keep
the scale (tests/post/dynamicResolution.test.ts).

## 2. Faster ready (app/loop.ts, app/urlParams.ts, app/boot.ts, stream/priorities.ts, stream/WorkerPool.ts)

- `bake` launch param: `'full'` (default with `autostart=1`: automation / QA, unchanged), `'interactive'` (default
  without autostart: the title boot and ENTER / Continue teleports) = radius-1 previews + full bakes of the player's
  own chunk (`streamReadyFor`), `'preview'` = radius-1 previews only.
- Job priorities: layout -90, build -70 (was -60 / -40): every ring-1 build (even behind the player) precedes every
  ring-1 bake; in-frustum bakes get -10 (they lead the other bakes of their ring by 40). With -40 the in-view bakes ran
  before the builds behind the player and cost ~2 s of the gate.
- Boot overlap: the worker pool starts (module load + world init) and resolves the spawn (`poolQueries`) while the
  main thread generates textures and compiles shaders (performance marks `br:*`).
- Boot pool: `bootPoolSizeFor` = steady size + 2 while the first radius generates, only with spare threads
  (hardwareConcurrency - 4 beyond the steady size) and deviceMemory >= 8; `pool.resize(poolTarget)` at the boot gate
  (idle workers stop at once, busy ones after their job). The QA tools report hc 8, so their pool stays at 4.

Measured (seed 1, 4 workers, dev server, machine under load from parallel agents): interactive ready 5.5-6.4 s
(before: 7.2 s with bake=preview, 10.6 s full); bake=full 10.6 s (unchanged semantics). The remaining floor is the
preview bake inside each of the 36 ring-1 builds (~250 ms each) plus the 4 own-chunk full bakes (~0.9 s each).

## 3. Gate snap race (app/loop.ts)

`createGate` keeps a generation counter (`open()` increments it); a `findNearest` answer of an older teleport is
ignored, and a snap is applied only while the player is still within 1 m (and on the same storey) of the position it
was asked for.

## 4. VRAM (stream/ChunkStreamer.ts, app/qualityAuto.ts, app/debugApi.ts)

- (a) `LEFT_STOREY_KEEPALIVE_MS = 2000`: after a completed storey switch the storey left behind keeps 2 s of
  prefetch keep-alive (was 10 s); the tower / elevator proximity prefetch (every 0.25 s) keeps it alive while the
  player stays there.
- (b) `RESIDENT_BUDGET_BYTES` low 450 / medium 700 / high 900 / ultra 1400 MB of tile textures (live) + geometry:
  over it, `sweep()` evicts the farthest resident chunk outside the desired set (the hysteresis ring; never live
  prefetch data, never the desired set) every 8 frames, net of what is already queued for disposal.
- (c) auto quality: GeForce MX / GT / GTX 7x0-10x0 / Quadro K/M/P -> medium.
- (d) `stats().memory = { heapMB, texBytes, geoBytes, pooledBytes }`.
- Deferred: lightmap format compression.

Measured: high at spawn 615 MB tex + 148 MB geo; 1.5 km soak peak 1.03 GB (while walking at 6 m/s), end 0.89 GB
(budget-bounded). Ultra
(radius 3) holds ~1.13 GB of textures + ~0.28 GB geometry for its 196 desired tiles: the budget then only trims
the hysteresis ring.

## 5. Bake workers (stream/WorkerPool.ts, workers/layoutCache.ts, core/quality.ts)

`poolSizeFor(q, hc, deviceMemory)` = max(2, min(q.bakeWorkers, hc - 4, max(2, floor(deviceMemory ?? 8)))); high and
ultra `bakeWorkers` 12 -> 8; `LAYOUT_LRU_SIZE` 96 -> 48 per worker. Startup is not slower (item 2).

## 6. HiDPI (core/quality.ts, app/boot.ts, app/renderer.ts)

`maxDpr`: high 1 -> 1.5, ultra 1.5 -> 2 (the fixed dynamic resolution is the safety net). `watchDevicePixelRatio`
(boot.ts): a `(resolution: Ndppx)` media query re-armed on every change, plus resize events; on a change the post
stack re-reads its base ratio (`post.setQuality(live preset)`), `dynRes.refreshDpr()` re-applies the scale under the
new cap and every target is re-sized. `pixelRatioFor` applies the same cap. Audit dpr: high 1600 -> 2400 px wide at
DPR 2, ultra 3200 (2x, the cap).

## 7. Ultra spends on pixels (core/quality.ts)

ultra: renderScale 1 -> 1.5 with dynamic resolution on (was fixed 1.0), planarReflectionScale 0.75 -> 1.0,
bloomLevels 8 -> 9, maxDpr 2; streamRadius stays 3 (fog end 92 m instead of 61 m: the long Level 0 / pillar-hall /
warehouse perspectives), bounded by the 1.4 GB budget. lmTpc 16 deferred. Pixel diffs (after/12-13, 14-15): spawn
MAD 0.015 (before 0.003), Poolrooms 0.007 (before 0.003); edge energy +12 % / +23 % (sharper wallpaper motif,
ceiling grid, tile grout).

## 8. Runtime quality switch (app/boot.ts, materials/warmup.ts)

`applyQuality` keeps the post passes it creates (AO mode, SMAA preset) disabled while `warmPassMaterials` compiles
their programs with `compileAsync` (KHR_parallel_shader_compile where available) against a HalfFloat target, then
re-enables them. The first-ultra-switch frame measured 330 ms in the audit before R2 and ~85-100 ms now (qswitch
audit, 6 switches: two frames > 50 ms, both at the ultra switches). The remainder is not the new pass programs; the
likely cause (not verified) is the re-allocation of every post target at 1.5x supersampling in the first frame.

## 9. Soak (app/autowalk.ts, tools/qa-presets.json)

`autowalk({ heading })` re-targets the autopilot 60 m ahead along the heading every 10 s of walk time. Reports gain
`frameMsMax` (the old `frameMsMax5s` was never a 5 s window; kept as a deprecated alias) and `displacement`. The soak
preset walks 1.5 km at 6 m/s on heading 0.6 (~800 m of ground, was ~150 m) and fails on frames >= 50 ms, < 400 m
covered, resident tile bytes above the budget + 15 % or growing beyond the tile ratio + 25 % (min of the last 5
samples), and JS heap growth (min of the last 5 samples > max(2 x start + 64, 256) MB). The edge presets read
`frameMsMax`.

## 10. Production build (vite.config.ts, app/debugApi.ts)

`base: './'` (relative asset URLs), harness pages in the rollup inputs only with `BACKROOMS_HARNESS=1` (the dev
server serves them regardless, so shoot / qa need nothing), `sourcemap: 'hidden'`; `layerAlbedoCheck` is imported on
demand. `vite build` emits index.html + main / chunk.worker / dspWorker / albedoCheck chunks only.

## 11. QA views (world/spawn.ts, app/loop.ts, app/debugApi.ts, tools/qa-presets.json)

- tower / elevator / landmark:NAME: `pickSubjectView` scores the cells of the site chunk around the subject x 16
  yaws by the subject cells a 7-ray fan sees (cells entered and faces hit), requires >= 4 m of open view ahead, adds
  a lit-view bonus and the framing penalty; landmarks (any kind, by `LANDMARK_NAMES`) prefer standing at / inside
  their frame looking in (<= 3 m outside), towers / elevators 2.5-9 m from the structure (camera outside it).
- flicker: prefers the FLICKER channel; the target must be visible in 3D (a soffit hides a ceiling lamp from an eye
  whose horizontal ray passes under it), not behind a solid / prop, and the central cone must be open (no wall stub
  0.6 m in front of the lens). `__backrooms.flickerWindow(after)` returns a steady time and a time inside the next
  burst of the FLICKER light in view; every zones flicker shot adds a `burst` capture; views/flicker-burst-pair
  checks the burst frame is darker at a locked exposure.
- zone:NAME: a non-NORMAL-mood district is a fallback while 3 more rings are searched for a NORMAL one.
- clear floor: URL x/z and `teleport()` without y are snapped (gate `snapFloor`) to standable floor
  (`findNearest('clear')`): walkable, clear of prop / solid footprints at body height (a desk), ceiling above
  feet + eye + 0.1 m; the point itself when it already is. A URL x/z without yaw= faces the spot's most open
  direction. seed=6&x=-380&z=-120 now stands on the floor of a meeting room (was y 1.05 on a desk, eye in the
  ceiling). Tower / elevator cells keep the walkability rule only.

## Needs other batches

- B1 (tests/post/exposure.test.ts): the 'dynamic resolution controller' block tests the legacy interval-only rule
  (still supported for callers without cost); it can be dropped in favour of tests/post/dynamicResolution.test.ts.
- B1 (PostStack): `post.renderScale` = pixel ratio / the base ratio stored at `setQuality`; after a live DPR change
  boot.ts calls `post.setQuality(q)` to refresh that base (a cheap no-op for the passes when nothing else changed).
- B7 (App.ts): the resize handler could call `core.sys.dynRes.refreshDpr()` directly (boot.ts listens to resize too).
