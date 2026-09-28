# Performance audits, September 26-28, 2026

Four passes. The fourth (iteration speed) made automation captures final at ready and reproducible across cache
state, shot order and page reuse, and moved the tool cache's costs off the bake threads; the third
(graphics-realism budget) brought the frame back toward its budget after the realism packages; the second
(rendering overhaul) cut the GPU cost of a frame by 2x at high and 4-5x at ultra without changing the image, and
made screenshot / QA runs 3-9x faster; the first removed rebuilds and startup serialisation.

## Iteration speed: capture contract v2 and the tool cache (September 28, 2026)

Screenshots were slow and not reproducible for the same reasons: the automation gate waited for chunk ring 1 only,
so the frame at ready still changed while farther tiles streamed in, and tools slept 250 ms to hide part of it; the
cold path spent a fifth of its time gzipping and uploading cache entries on the bake threads; and 16 of the last
38 commits that touched the worker's import graph threw the whole cache away without changing what the worker
computes. This pass makes readiness a function of position and view (docs/DESIGN.md §7.5), adds an in-place
`__backrooms.load()` for tools that keep one page per boot group, and rebuilds the cache keys and write path.
The game itself is unchanged for players: their gate, `READY_FRAMES` and streaming are as before.

### What made captures depend on timing

Measured on the D2 list (12 shots: 9 high, 2 ultra, 1 medium; 1600 × 900) before the change:

| Comparison | Pixels that differed |
| --- | ---: |
| ready vs ready + 250 ms, POOLROOMS | 771k |
| cold cache vs warm | up to 15.7k (max 125 levels) |
| in-place vs fresh page | up to 12k |
| two full-idle captures | 0 |

Three causes, all fixed:

- **Tiles after ready.** Ring 1 is 36 tiles, but the reflection probe renders a 120 m cube and the light atlas is
  sampled up to 56 m, so tiles 38-61 m away changed the frame when they arrived (each re-captured the probe). The
  capture set now holds every tile that can reach a still frame: 44-52 at high, 62-68 at ultra.
- **Simulation time before the freeze.** `time=` froze the clock only when the stream was ready, so flicker, water
  drips and sway, the anomaly director and breathing ran for however long the stream took, and the probe kept
  faces captured at other times. An automation launch gate now freezes the clock when it opens, and the probe
  re-captures after the launch toggles.
- **Exposure.** The gate snapped the next three meter readings, one every 8 frames, but went ready 10 frames later,
  and the spring then adapted on wall-clock time. The settle meters every frame from a fixed EV once the frame is
  quiet, drops a reading in flight, and waits for three readings.

Also found and fixed: the probe marked itself stale only for tiles within a 60 m circle, not the 60 m cube its
faces render, and re-estimated its room box only every 15 frames after a layout arrived.

### Result: a capture at ready is final

Every comparison below is 0 px on all 12 D2 shots, in two independent runs with separate cache directories:

| Gate-v2 capture at ready, compared with | Differing pixels |
| --- | ---: |
| the same page after full idle + 60 frames | 0 |
| the same shot with an empty cache | 0 |
| `noprime=1` | 0 |
| `stream=capture` (only the capture set streamed) | 0 |
| `load()` in place after 3 other shots (pass 1) and after 9 (pass 2) | 0 |

`converge.mjs` (captures at ready + 0, + 250 ms, + 1 s, full idle, idle + 60 frames on one page) gives 0 px for
every step on POOLROOMS high, PARKING high and PARKING ultra, so tools need no wait after ready. Compared with the
old gate, images change by 0.04-0.65 % of pixels (more tiles present, settled exposure, time frozen from the start):
baselines are refreshed once.

### Speed

Cold shots, the four cold locations of the profiling pass at high, a fresh cache directory per run, variants
interleaved (mean time to ready; job latency p50 of the full builds):

| Variant | Quiet window | Loaded window (load average 7-16) |
| --- | ---: | ---: |
| no cache at all (`BACKROOMS_TILE_CACHE=0`) | 7.6-7.9 s, 573-586 ms | 9.4-9.5 s |
| cache reads only (measurement variant) | 8.0-8.2 s, 605-617 ms | |
| before: gzip + PUT on the bake thread | 9.4-9.5 s, 801 ms | 10.2-12.1 s |
| **after: writer worker per bake worker** | **8.7 s, 687-698 ms** | 11.0-13.2 s |
| raw PUT from the bake thread (server gzips) | 12.9-13.2 s (base 9.4-9.5 in the same rounds) | |
| raw PUT from the writer (server gzips) | | 14.1-14.7 s |
| gate v2 + writer, 191 full bakes instead of 144 | | 13.2-15.6 s (before: 10.2-12.0 s in the same rounds) |

- The writer recovers 0.7-0.8 s of the 1.6-1.9 s the cache used to cost a cold location (job latency p50 801 → 687-698 ms; 573-586 ms without a cache). The rest is the reads (0.3 s:
  key digests and GET misses in front of every job) and the writers' gzip running next to memory-bandwidth-bound
  bakes (bake compute +13 %). Getting it back needs the writes deferred until the gate opens, which would lose
  entries on pages closed right after the capture unless the tools wait for a flush (see Open).
- Gate v2 bakes 33 % more tiles per cold location at high (48 instead of 36). In four interleaved rounds a cold
  location took 10-30 % longer than before the pass (per-job latency fell from 1025-1044 ms to 847-981 ms, but
  there are more jobs); in exchange the image no longer depends on the cache or on timing.

Warm and in place (D2 list; 1600 × 900):

| | Result |
| --- | --- |
| fresh page, warm cache, time to ready (12 shots) | p50 2.05-2.3 s; no wait after ready (was 250 ms, plus 0.07-0.11 s of polling) |
| the settle (`br:captureReady` → `br:settled`) | about 0.15 s |
| full idle, for comparison | +3.0-45.5 s per shot (the far ring, cold) |
| `load()` in place, nearby pose (same capture set) | 0.13-0.29 s |
| `load()` in place, new place, `stream=capture` | p50 1.37 s at load average 10 (1.0-2.1 s); 69 cache entries (was 93-200); 20 misses in 24 loads |
| `load()` in place, new place, full streaming | p50 1.47-1.49 s (0.9-4.7 s: the last shot's far-ring jobs still running) |

### The tool cache

- **Keys from bundles.** The code hash is SHA-1 of a tree-shaken, minified rolldown bundle of `chunk.worker.ts`
  (tile hash) and of `worldStage.ts` (world hash: layout, spawn and find). Over the 38 non-merge commits that
  touched the worker's import graph between September 26 and 28, the raw-source hash invalidated the cache 38 times
  and the tile hash 22 times: 14 render-only commits (presets in `core/quality.ts`, `settings.ts`,
  `emitterProfile.ts`), one comment reflow and one `ids.ts` edit no longer invalidate. The world hash changed on 5
  of them, so layouts, spawns and finds stayed warm through 17 of the 22 tile invalidations. Hashing takes about
  0.3 s cold and 22 ms from the memo (a stamp of the graph's paths, mtimes and sizes).
- **World keys ignore bake settings**, so layouts, spawns and finds are shared between qualities, and a `bake` miss
  is answered from the `build lighting:'full'` entry of the same tile.
- **Writes off the bake threads.** The bake worker transfers the encoded entry to its own writer worker, which gzips
  and uploads it. Raw uploads from the bake thread (the server gzipping at zlib level 1) were slower than the old
  path: mean cold ready 13.0-13.2 s against 9.4-9.5 s, job latency p50 1148 ms against 801 ms with the same compute
  time, so the upload itself blocks the thread. The server still accepts raw PUTs behind a bounded queue.
- **Store.** Namespaced directories (the first 12 hex of the code hash), asynchronous I/O, batched mtime updates, and
  eviction of dead code versions first (legacy flat files, then namespaces unused for 24 h beyond the 3 most
  recent, then LRU), in batches above cap × 1.05.

### Memory

100 in-place `load()` shots on one page at high, cycling through the 9 high D2 shots (warm cache):

| | `stream=capture` | full streaming |
| --- | ---: | ---: |
| Chromium tree PSS, plateau / peak | 1.95-2.1 GB / 2.18 GB | 1.95-2.1 GB / 2.21 GB |
| JS heap, max | 161 MB | 215 MB |
| `load()` p50 / p90 | 0.81 s / 1.25 s | 0.83 s / 1.49 s |
| cache entries per new place | 63-73 (56-131 MB) | 92-125 (up to 167 MB) |
| entries computed (misses with a PUT) | 2 in 100 shots | 0 |
| errors | 0 | 0 |

Captures of the last cycle (after about 90 shots on the page) equal fresh pages to the pixel in both modes. Fresh
pages (Chromium and Vite PSS, sampled every second): 1.5-1.8 GB warm at high, 1.6-2.2 GB at ultra, 1.9-3.0 GB
while baking cold; `stream=capture` keeps 44-68 tiles resident instead of the whole radius (100 at high, 196 at
ultra). Full idle, which the tools no longer need,
reached 3.6-3.8 GB with the ultra radius resident.

### Measured and not changed

- **Raw PUTs** (the server gzips at zlib level 1): slower from the bake thread (cold 12.9-13.2 s against 9.4-9.5 s,
  job latency p50 1148 ms against 801 ms at the same compute time) and from the writer (latency p50 1168-1252 ms:
  the 4-7 MB uploads hold the page's connections while every job's GET waits). The server keeps accepting them.
- **A single capture set for every view** (all tiles within the fog end): the ultra set would grow from 62-68 to
  about 110 tiles for no pixel; the view-dependent band is exact against full idle.
- **Settling on wall-clock time** (the old 250 ms wait): the frame-counted settle costs about 0.15 s and is exact.

### Open

- **Deferred cache writes.** Holding encoded entries while an automation gate is closed and writing them once it
  opens would bring a cold location to the reads-only time (8.0-8.2 s instead of 8.7 s at high). A page closed
  right after its capture would lose the held entries, so the tools would have to wait for a flush first
  (a `__backrooms` flush call), and the held entries cost up to 50 MB per bake worker at high.
- **The remaining in-place misses** (3-4 entries on a first visit to a new place, 0 on the second pass) were a
  storey change: `switchStorey` re-targets the new storey at once at the last x/z (right for stairs and lifts), so
  `load()` started a layout and 3 full builds for the previous shot's place on the new storey before its first
  frame could cancel them (up to three wasted full bakes on a cold cache). `load()` now calls
  `getCaptureControl(streamer).forgetPosition()` first: an in-place load requests exactly the jobs a fresh page does
  (65 of 65 on PARKING after POOLROOMS).

### Methodology

One tool browser at a time (`BACKROOMS_BROWSER_SLOTS=1 BACKROOMS_MIN_FREE_MB=4500`), 4 bake workers, scratch
cache directories, 1600 × 900, CDP `Page.captureScreenshot` with `optimizeForSpeed` (decodes to the same RGBA as a
default PNG). Cold timings are interleaved A/B runs of the four cold locations of the profiling pass (POOLROOMS,
PARKING, OFFICE, WAREHOUSE at high), each with a fresh cache directory; the machine was shared with other agents'
test runs (load average 6-16), so compare within a round. Pixel comparisons count pixels whose largest channel
difference is above 0.


## Graphics-realism budget (third pass, September 27, 2026)

The graphics-realism packages (frame graph and contact shadows, detail maps and POM, glare and grade, screen-space
reflections with the specular G-buffer and the reflection probe, refracting water, froxel volumetrics) made a high
frame 1.5-1.9x and an ultra frame 1.4-1.9x as expensive. The budget: high at 1920 × 1080 within 4 ms, ultra at
2560 × 1440 within 11 ms, low and medium within 10 % of their cost before the packages. Low meets it; high and
medium sit at the line (high water frames 4.0-4.05 ms, medium POOLROOMS +12 %); ultra meets it except on water
frames, which cost 11.3-12.9 ms (see "Open" below).

### The pipeline and what each pass costs

A frame at high or ultra, in order (`__backrooms.gpuProfile` segment names):

1. `waterSim`: the ripple simulation (fixed steps, near zero).
2. `probe`: one face of the reflection probe re-captured and re-filtered every fourth frame.
3. `reflection`: the planar mirror of the nearest water plane (with its own depth prepass), only while water is in
   view (below).
4. `RenderPass`: the depth prepass (with the flashlight shadow map), the afterDepth hooks timed separately (`ssao`,
   `hiz`, `lightAtlas`, `volumetrics`), then shading into the three-attachment G-buffer (colour, fallback specular,
   normal and roughness). Most of the frame.
5. `pyramid`: the colour and depth pyramid (SSR cones, water refraction).
6. `ssr`: the Hi-Z trace (one ray per 2 × 2 display pixels) and its resolve (6 taps on high, 8 on ultra).
7. `mrtComposite`: the fallback specular or the traced reflection added to the colour; the depth copied to the
   composer's buffer.
8. `late`: water, sparks and dust motes over the opaque colour.
9. `AutoExposurePass`, the effect pass (motion blur, glare, exposure, AgX, grade), `SMAA`, the lens and grain pass.

Mean ms per frame over 1.5 s of normal frames. Segments include the GPU's idle gaps while the CPU submits, so they
sum to more than the back-to-back `gpuBench` time of the whole frame (last row):

| Segment | high, OFFICE | high, goto=water | ultra 1.4x, LOBBY | ultra 1.4x, goto=water |
| --- | ---: | ---: | ---: | ---: |
| probe | 0.35 | 0.40 | 0.53 | 0.27 |
| reflection | 0.01 | 1.40 | 0.00 | 1.89 |
| RenderPass (prepass, shadow map, shading) | 2.19 | 2.42 | 6.91 | 5.49 |
| ssao | 0.13 | 0.18 | 0.53 | 0.44 |
| hiz | 0.06 | 0.07 | 0.15 | 0.12 |
| volumetrics | 0.17 | 0.19 | 0.34 | 0.31 |
| pyramid | 0.05 | 0.07 | 0.15 | 0.17 |
| ssr | 0.13 | 0.09 | 0.60 | 0.19 |
| mrtComposite | 0.04 | 0.10 | 0.44 | 0.19 |
| late (water, sparks, motes) | 0.03 | 0.47 | 1.02 | 1.47 |
| effect pass | 0.28 | 0.24 | 0.76 | 0.58 |
| SMAA | 0.15 | 0.23 | 0.46 | 0.30 |
| lens and grain | 0.10 | 0.13 | 0.37 | 0.39 |
| `gpuBench`, whole frame | 3.02 | 4.17 | 9.62 | 12.96 |

In-page A/B (below) put the optional features at: SSR as a whole (G-buffer split, Hi-Z, trace, composite) 1.1-2.5
ms at ultra and 0.3-0.9 ms at high, of which the trace is 0.6-1.4 / 0.2-0.6 ms; the planar mirror 2-3.5 ms at ultra
and 0.7-1.4 ms at high on water frames; contact shadows about 1 ms at ultra; detail maps 0.4-0.9 ms at ultra; the
probe 0.15-0.4 ms at ultra.

### Master and the final state

GPU ms of the whole frame (`gpuBench`, the minimum of three runs per scene, and of two passes where both were
taken). Master is `7c78e9c`, before the realism packages; "before" is the merged packages (`66f0ffb`) before this
pass. Ultra renders 3840 × 2160 at 1.5x and 3584 × 2016 at 1.4x on the 2560 × 1440 display.

| Scene | high: master | high: before | high: final | ultra: master (1.5x) | ultra: final (1.4x) | ultra: final at 1.5x |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| LOBBY | 1.66 | 3.07 | 3.04 | 6.21 | 9.62 | |
| OFFICE | 1.74 | 3.11 | 3.02 | 6.25 | 9.64 | |
| POOLROOMS | 1.80 | 3.73 | 3.66 | 6.83 | 11.41 | 13.01 |
| FLOODED_HALL | 2.48 | 4.08 | 4.01 | 9.27 | 12.25 | 13.56 |
| DEEP_END | 1.73 | 3.64 | 3.56 | 6.84 | 11.29 | |
| PARKING | 2.00 | 3.15 | 3.12 | 7.22 | 9.27 | |
| WAREHOUSE | 2.22 | 3.99 | 3.56 | 7.71 | 10.59 | |
| PIPEWORKS | 1.90 | 3.57 | 3.28 | 6.66 | 9.81 | |
| DARK, flashlight on | 1.92 | 3.39 | 3.10 | 7.25 | 9.04 | |
| `goto=water` | 2.67 | 4.11 | 4.05 | 10.33 | 12.85 | 14.47 |

| Scene | medium: master (0.9) | medium: final (0.85) | low: master | low: final |
| --- | ---: | ---: | ---: | ---: |
| LOBBY | 1.27 | 1.33 | 0.51 | 0.56 |
| POOLROOMS | 1.46 | 1.63 | 0.53 | 0.56 |
| OFFICE | 1.37 | 1.46 | 0.61 | 0.61 |
| `goto=water` | 2.00 | 2.16 | 0.56 | 0.58 |

Before this pass medium cost 1.46 / 1.75 / 1.56 / 2.36 ms at 0.9 (+14-20 %).

### Changes

- **The water mirror waits for visible water** (`materials/water/waterVisibility.ts`). The loop mirrors the nearest
  water plane within 40 m ahead, and that scan does not see walls: in WAREHOUSE, PIPEWORKS and the DARK spawn a pool
  or flooded room behind a wall cost a mirrored render of the scene every frame (about 0.3 ms at high and 0.5-0.8 ms at
  ultra, paired in-page A/B with the loop's own plane scan). An `ANY_SAMPLES_PASSED_CONSERVATIVE` query now brackets
  every water draw, and where the water is the mirror's only reader (high and ultra: SSR and the froxel presets
  compile the floors' planar path out) the mirror renders only while a water draw passed the depth test within the
  last 0.5 s. Results arrive a frame or two late: water coming into view shows its probe reflection for those
  frames; an unanswered query counts as visible. The queries and the poll cost nothing measurable (within ±0.03 ms,
  in-page A/B). High captures of the ten scenes matched the previous build except for scattered pixels (under 2 %,
  mostly 1-4 grey levels: the probe's refresh phase).
- **Reflection probe cadence:** one face every fourth frame instead of every second, halving the steady capture and
  filter (GPU and main thread); flicker reaches a face at most 24 frames late.
- **Ultra: 1.4x supersampling instead of 1.5x** (1.96 instead of 2.25 samples per display pixel; 10-12 % of every
  frame, 1.3-1.6 ms on water frames, together with the next two), with **AO 12 samples** instead of 16 and **SMAA's HIGH search** instead of
  ULTRA, which a supersampled image does not show. Side by side at 2560 × 1440 the images differ in grain and
  sub-pixel edges; wallpaper stripes, grout and carpet stay clean.
- **Medium: render scale 0.85 instead of 0.9.** No single medium feature costs more than 0.1 ms (motion blur, cloth
  sheen, specular AA, puddles, water waves and ripples, water debris and the flashlight bounce were each switched
  off in place); the growth is spread over the shared surface and water code (the shading pass +0.1 ms in LOBBY and
  +0.4-0.5 ms where water is in view, the mirror +0.1-0.2 ms). 11 % fewer pixels bring medium back within 10 %
  except POOLROOMS (+12 %), with a barely softer image; dynamic resolution still lowers it further on weak GPUs.

### Measured and not changed

In-page A/B, paired medians (the SSR and mirror numbers are the most reliable: those states switch every 8-16
frames):

- **SSR:** 48 → 32 trace steps saved 0.07-0.16 ms at high, a roughness cut-off of 0.35-0.4 instead of 0.45 nothing
  measurable, the ultra filter under 0.2 ms: the trace's cost is per ray, not per step. Kept.
- **Mirror:** 0.5 → 0.35 at ultra saved about 0.6 ms on water frames but showed the magnified texel grid in
  saturated lamp reflections (package E's "stepped blobs"); 0.42 saved 0.1-0.3 ms. A scissor to the lower 60 % of
  the mirror saved at most 0.2 ms; rendering it without its depth prepass cost 0.15-0.2 ms more at high (nothing at
  medium); culling shell tiles farther than 25-40 m saved 0.05-0.1 ms; the lite surface path in reflection passes
  (no anti-tiling, macro variation or wallpaper fades) saved nothing.
- **Water shading at ultra** (`late`, 0.6-1.5 ms): 4 → 2 in-water lights, 10 → 8 refraction steps, 8 → 6 waves and
  basic caustics each moved it by less than the noise (0.2 ms).
- **Surface features at ultra:** detail maps off 0.4-0.9 ms, contact shadows off about 1 ms (6 instead of 8 steps:
  nothing), POM 2 → 1 nothing (its steps are finer), texture anisotropy 16 → 4 up to 0.5 ms, the high froxel grid
  under 0.2 ms, the probe off 0.15-0.4 ms. Each is visible, or saves too little.

### Open

- **Ultra water frames** (POOLROOMS, DEEP_END, FLOODED_HALL, `goto=water`) cost 11.3-12.9 ms at 1.4x. The largest
  items are the mirror (about 2-3.5 ms, only partly per pixel: 0.35 of the buffer instead of 0.5 saved 0.6 ms) and
  the water pass (1-1.5 ms).
  Dynamic resolution (on by default) lowers the scale there in play; 1.3x would bring the flooded rooms to about 11
  ms. A cheaper mirror (fewer draws: a coarser proxy of the room, or reusing SSR for the mirrored view) is the next
  step.
- High water frames sit at the 4 ms line (4.0-4.05 ms).

### Methodology

Four agents shared the GPU during this pass (two headless browsers at a time), and the same scene's `gpuBench` time
swung by 30 % between runs. Decisions were made in-page:

- States that switch at runtime (the mirror's scale and prepass, the probe, SSR on / off, the trace program and its
  roughness cut-off, texture anisotropy, the water-visibility gate) were compared inside one frame hook: 40 rounds
  alternating base and variant, each round an untimed warm-up frame and 8-20 frames in one `TIME_ELAPSED` query (as
  `gpuBench` renders them: probe, mirror, composer), the variant against the mean of its neighbouring base rounds,
  median over the rounds.
- Quality rows that recompile programs were switched through the settings path (about 1 s) and alternated with the
  base four times, timed by min-of-rounds benches or by one `gpuProfile` segment; those deltas are good to about
  ±0.3 ms at ultra and ±0.05 ms at medium.
- The absolute table: `BACKROOMS_UNCAPPED=1`, seed 7, `time=10`, `gpuBench` three times per scene, each run started
  only when no other browser held a slot (other agents could still start one during a run: the minimum over two
  passes is reported).

## Rendering overhaul (second pass)

### Measurements

RTX 5070 Ti Laptop GPU, headless Chromium (ANGLE/Vulkan), seed 7, `time=10`, `noaudio=1`, fixed `scale=`. The
numbers are the GPU time of one whole frame's rendering (planar reflection, the composer passes and the final lens
and grain pass), rendered 20 times back to back inside one `EXT_disjoint_timer_query_webgl2` query, median of seven
repeats. Back-to-back rendering keeps the GPU clocked up: timings of single frames at 60-165 Hz are inflated and
noisy, because the GPU downclocks between frames (a 1.0 ms pass reads 1.4-2 ms). The baseline is commit `f309fe2`.

| Scene | Drawing buffer | Before (ms) | After (ms) | Speed-up |
| --- | --- | ---: | ---: | ---: |
| high, LOBBY spawn | 1920 × 1080 | 3.66 | 1.56 | 2.3x |
| high, OFFICE | 1920 × 1080 | 3.19 | 1.61 | 2.0x |
| high, POOLROOMS (reflection on) | 1920 × 1080 | 3.40 | 1.77 | 1.9x |
| high, PARKING, flashlight on | 1920 × 1080 | 3.77 | 1.99 | 1.9x |
| ultra, LOBBY (1080p display) | 2880 × 1620 | 15.79 | 3.32 | 4.8x |
| ultra, POOLROOMS (1080p display) | 2880 × 1620 | 14.74 | 3.86 | 3.8x |
| ultra, LOBBY (1440p display) | 3840 × 2160 | 28.53 | 5.94 | 4.8x |
| ultra, POOLROOMS (1440p display) | 3840 × 2160 | 27.45 | 6.77 | 4.1x |
| ultra, PARKING (1440p display) | 3840 × 2160 | 26.72 | 6.86 | 3.9x |

A 120 m automated walk at high (dynamic resolution on, bake workers busy, uncapped frame rate) went from 110 to
145 fps, with the longest frame 31.3 → 24.6 ms and 7 → 3 frames over 20 ms. Headless Chromium composites in
software and reads the canvas back every frame (see the README); its longest stalls are that readback, which a
GPU-composited browser does not do.

`__backrooms.gpuProfile(seconds)` reports the per-pass split in the running game (the `perf` QA preset records it).

### Changes

#### Ambient occlusion: N8AO replaced (the largest single cost)

N8AO cost 9.5 ms of the 15.8 ms ultra frame at 2880 × 1620 (High mode: 64 samples at full resolution, two
denoise passes, an accumulation copy, a composite and another full-screen copy) and 1.2 ms at high.
`post/AmbientOcclusionPass.ts` keeps N8AO's estimator (hemisphere samples on a Fibonacci disk, the same range check
and radius / falloff) and its composite (`scene × mix(aoColor, 1, ao^intensity)`), so the atmosphere table's
intensities and colours still apply. It reorganises the work:

- AO at half the drawing-buffer resolution for every preset, 8 / 10 / 12 / 16 samples (low / medium / high / ultra),
  rotated by a 4 × 4 interleaved pattern;
- sample taps read a small linear view-depth texture instead of the full-resolution depth buffer, and taps farther
  than 16 texels read a half-size copy (as in scalable AO): the kernel halved at 3840 × 2160, where a 0.7 m radius
  spans hundreds of texels;
- a separable bilateral denoise whose 5-tap weights cancel the 4 × 4 pattern exactly;
- one depth- and normal-aware upsample that multiplies the scene colour in place (blending), with no extra copies
  (the normal test, added later, costs about 0.15 ms at ultra: see `src/post/AmbientOcclusionPass.ts`).

AO now costs 0.20 ms at 1920 × 1080 (high) and 0.91 ms at 3840 × 2160 (ultra). Side-by-side captures against N8AO
showed identical mean luminance and no visible difference; the per-pixel differences sit on thin edges.

#### Depth prepass (main view and water reflection)

Every tile has its own materials, so three.js draws the opaque list in material order rather than front to back,
and the expensive surface shader ran 1.3-1.8 times per pixel. `materials/prepass.ts` first draws every shell and
props mesh with a position-only depth program (`materials/DepthMaterial.ts`), then shades with depth writes locked
off. Both programs declare `invariant gl_Position` and compute it with three's `project_vertex` expressions, and the
depth program repeats the surface program's discards (tile fade dither, alpha test of grates and signs, the
reflection pass's distant-props cull), so the output is bit-identical: captures with the prepass on and off
differed in 0 bytes in eight scenes, including partial tile fades, the flashlight, grates and ultra supersampling.
The shading pass went from 1.8 to 1.0 ms in the lobby at high; the reflection from about 1.0 to 0.8 ms.

The flashlight's shadow map is rendered inside the prepass: with depth writes locked for the shading pass, it
would otherwise stop clearing and updating.

#### Water reflection resolution at ultra

Ultra rendered the mirrored view at the full supersampled buffer (2880 × 1620 on a 1080p display, 2.25 times the
display's pixels). `planarReflectionScale` is now 0.67 (about the display resolution). Roughness mips and ripple
distortion blur the reflection; the captures differed only in sub-pixel edges of reflected light panels.

#### Smaller changes

- Layer, flags, tint, emit and aux are per-face constants, so their varyings are `flat`
  (tests/materials/depthPrepass.test.ts checks every triangle of real tiles).
- The prepass bookkeeping reuses its arrays (no per-frame allocation).
- `tools/shoot.mjs` accepts `BACKROOMS_UNCAPPED=1` (no vsync or frame-rate cap) for stable in-page timings.

### What was measured and not changed

- **Flashlight shadow map:** 0.02-0.1 ms of GPU time when saturated (single-frame timer readings of 0.45 ms were
  downclocking).
- **Draw ordering:** grouping draws by program or sorting front to back made no measurable difference once the
  prepass removed overdraw.
- **Splitting the shell into floor and wall programs:** removing the paths walls cannot take (emission-map
  reflections, caustics, concrete joints) at compile time would save about 5 % of the lobby's fragment work (about
  20 % on wet parking floors), but each tile would need another draw, and a draw of the surface program costs about
  4 µs of GPU time under ANGLE (texture and uniform rebinding for the tile). At 1080p the two roughly cancel.
- **Remaining per-frame cost:** at high, about 0.25 ms of each scene pass is this per-draw overhead (about 50
  draws); the rest of the shading is spread over many small features (compile-time removal of all optional features
  would save 40-50 %, no single one more than 20 %). V8 garbage collection (2-6 ms major collections while chunks
  stream in) is the largest main-thread hitch left; the frame loop itself allocates about 15 KB per frame, mostly
  inside three.js's uniform setters.

### Reproduce

In the browser console of a settled scene (`?seed=7&quality=high&scale=1&noaudio=1&time=10`, `waitForIdle` first):

```js
await __backrooms.gpuBench();     // whole-frame GPU ms, rendered back to back (the table above)
await __backrooms.gpuProfile(4);  // mean GPU ms per pass over 4 s of normal frames (clock-sensitive, see above)
```

Headless: `node tools/shoot.mjs --size 1920x1080 --params "seed=7&quality=ultra&scale=1.5&noaudio=1&time=10"
--eval "(async () => { await __backrooms.waitForIdle(20000); return __backrooms.gpuBench(); })()"`. Run the
baseline and the change on the same machine, one browser at a time.

## Screenshot and QA runs

(Second pass. The fourth pass replaced the gate ring with the capture set and the 250 ms wait with a frame-counted
settle; see the top of this file.)

A QA shot took about 20 s to reach ready (up to 32 s) plus a fixed 4 s wait. Phase marks and tile counts sampled
every 100 ms showed the engine ready after about 2 s; the rest was the bake workers. The automation gate (`bake`
level `full`) waits for the 36 tiles of the 3 × 3 chunk ring to be fully baked, but the job order is tuned for
players, whose gate needs nearby previews only: full bakes (+60) queued behind every build and preview of the next
ring (−70). At ready the workers had built and preview-lit all 100 tiles of the streaming radius and fully baked 60.

- **Gate ring first** (`StreamerOptions.fullBakeRing`, set to 1 for `bake=full` only): the ring's builds and bakes
  run 500 priority units ahead of all other tile work.
- **Full lighting inside the build** (`build` request `lighting: 'full'`): the ring's tiles skip the preview bake, the
  separate bake job and the second texture upload. The result is byte-identical to the bake job's
  (tests/workers/handler.test.ts).
- **Burst uploads** while the automation gate is closed: any number of upload steps in a 50 ms budget and no fade-in
  (players keep one step per frame and the 0.5 s fade).
- **No fixed wait:** the frame at ready was pixel-identical to the frame 4 s later in every scene tested, so the
  default `--wait` is 250 ms.
- **Result cache** for tool runs (README, "QA speed and the result cache"): worker results persist across shots and
  runs, keyed by a hash of the worker's source graph, the settings and the request.

Eight bake workers were no faster than four (full bakes are memory-bandwidth bound like previews), so the pool size
is unchanged.

| `zones` preset, 36 shots | Wall time | Mean time to ready |
| --- | ---: | ---: |
| before (about 20 s to ready + 4 s wait per shot) | about 15 min | about 20 s |
| after, cold cache | 4 min 41 s | 6.6 s |
| after, warm cache | 1 min 42 s | 1.8 s |

Two warm runs produced pixel-identical images. Two runs without the cache differ by up to about 1,400 pixels in
some shots (distant tiles still streaming in at capture time), and cold-versus-warm differences are of the same size.

## First pass: rebuilds, startup and resolution

The largest avoidable costs were rebuilding the application for every seed, serial startup work, and a stale device-pixel ratio during initialization. This pass fixes those costs and removes redundant rendering work. It keeps the existing quality presets, world generation, lighting sample counts and streaming distances.

### Measurements

The baseline was commit `f172555`. Measurements used production builds on a Ryzen 9 8940HX and an NVIDIA RTX 5070 Ti Laptop GPU, Chromium/ANGLE OpenGL, approximately 165 Hz. The game reported a 2019 × 1262 CSS viewport and device-pixel ratio 1. Browser timing tests used high quality, `scale=1`, `noaudio=1`, `bake=interactive` and `noprime=1`. Audio reuse was checked separately in the audio integration test.

These are local observations, not hardware-independent targets. Browser startup numbers include cached browser assets and driver programs. They do not measure a first-ever visit with an empty driver cache.

| Scenario | Before | After |
| --- | ---: | ---: |
| Load seed 42, page navigation to ready versus changing an already loaded seed | 6.77 s | 2.19 s, including the initial curtain transition |
| Initial page load, seed 42 | 6.77 s | 5.94 s |
| Seed 7, reproduced stale-DPR case | 83.9 FPS | 163.6 FPS |
| GPU frame cost in that case | 11.73 ms | 5.97 ms |
| 95th-percentile frame interval in that case | 38.2 ms | 6.2 ms |
| Normal lobby draw calls | 74 | 73 |
| Serial preview bake, median of eight tiles | 176.8 ms | 172.8 ms |
| Serial full bake, median of eight tiles | 436.1 ms | 421.9 ms |

The graphics improvement above primarily fixes an incorrect drawing-buffer size. Before the fix, a DPR change during initialization left the renderer at 1.5 even though the live DPR was 1 and fixed scale was 1. The buffer was 3028 × 1893 instead of 2019 × 1262, about 2.25 times as many pixels. A control run of the old build with its DPR explicitly corrected reached 164.8 FPS and 5.94 ms GPU time. Thus the near-doubling is specific to the reproduced resolution bug; the smaller rendering changes alone did not produce a measurable FPS increase at the display limit.

Further checks:

- Three alternating changes between seeds 7 and 42 took 1.84–1.95 s from world reset to ready, excluding the 180 ms curtain transition.
- The actual title seed field loaded seed 42 in 2.17 s from world reset to ready. The pause menu's random New tape action took 1.55 s for seed `1011-9475`. Both retained the original canvas.
- An 80 m automated walk in seed `1011-9475` completed without getting stuck or recording game errors. A concurrent 20 s sample averaged 164.5 FPS, with 6.2 ms p95/p99 frame intervals and a 24.2 ms maximum.
- A Poolrooms scene with reflections enabled averaged 164.8 FPS and 5.86 ms GPU time, with a 6.2 ms p95 frame interval.
- Returning to fully settled seed 7 repeatedly returned to 307 geometries and 929 textures, with identical estimated geometry and texture bytes. The texture reuse pool remains bounded.
- With audio enabled in the browser, changing from seed 7 to 42 retained exactly one AudioContext. Audio remained running, with 18 active voices after the transition and no recorded errors.

### Changes

#### Reuse the application when loading a seed

The title seed field, pause menu's New tape action and Continue on a different seed now reset the world in place. Previously they navigated the page, creating another renderer and worker pool, generating all procedural textures, compiling programs and synthesizing audio again.

The transition retains the renderer, material system, postprocessing targets, audio context and synthesized audio buffers. It reinitializes worker world state, evicts the old geometry, reuses the bounded lightmap texture pool and ignores results from evicted tiles. Lighting overrides, anomalies, audio propagation, interactions, discovery state, timers and water-plane caches reset for the new world. The existing spawn and readiness rules still apply.

Footstep echo and foley nodes are reused. Old ambience and wading nodes disconnect when stopped, so repeated seed changes do not accumulate silent audio connections.

`__backrooms.newSeed(seed)` exercises the same path. `br:newSeed` measures reset-to-ready, and `br:ready` marks readiness with the gate reason.

#### Overlap world construction with GPU initialization

Once spawn resolution finishes, the worker pool starts the surrounding nine layouts and 36 geometry/preview-lighting jobs while the main thread generates textures and prepares shaders. A small startup-job adapter hands each original job handle to the streamer exactly once. Completed results are retained without another transfer or rebuild. Unclaimed work is canceled when the live streamer takes over.

The texture baker's final GPU completion check now uses asynchronous readback, so waiting for the GPU does not synchronously block the main thread.

#### Apply resolution limits consistently

Initial renderer setup, postprocessing quality changes and the resolution controller now use the same DPR and render-scale limits. Fixed resolution reapplies the current DPR after boot and monitor/zoom changes, just as automatic resolution does.

#### Remove rendering work that contributes no pixels

Normal frames write the final postprocessing pass directly to the canvas. The extra display target and full-screen copy are used only when a screenshot is requested. The grain pass still performs the same color encoding in both paths.

Reflection rendering hides water meshes and prop meshes whose bounding spheres lie entirely beyond the existing reflection distance limit. Previously those meshes were submitted and rejected in fragment shaders. Props crossing the boundary retain the exact shader test. Visibility and renderer state are restored even if rendering throws.

#### Reduce baker arithmetic overhead

CPU profiling identified polygon form-factor evaluation as a hot path. Bounded local vectors now use `sqrt(x*x + y*y + z*z)` instead of the general overflow-safe `Math.hypot` implementation. The final isolated worker run improved median preview/full bake times by about 2.3%/3.3%. Earlier runs varied more; the smaller isolated result is the useful estimate.

`tools/workerbench.ts` records cold spawn, geometry and both lighting stages for four tiles per seed. It complements the existing bake-only benchmark.

### Verification

- Production build and TypeScript checks pass.
- The full test suite passed during implementation: 1,071 tests, with five existing skips. Final focused validation passed all 67 tests across app runtime, audio, reflection, resolution, startup jobs and residency.
- Added regressions cover completed startup-job reuse, cancellation, reinitialization, stale worker results at identical tile coordinates, fixed-resolution DPR changes, reflection bounds/state restoration and retaining synthesized audio across resets.
- Browser checks covered the title seed field, pause-menu New tape, Continue into another seed at its saved position, repeated seed changes, quality switching, lobby and Poolrooms rendering, capture readback and an automated walk. The recorded game error lists were empty. A final run of the five affected non-audio suites passed all 54 tests after the last gate adjustment.

### Reproduce

Build with `npm run build`, serve with `npm run preview`, then open:

```text
/?seed=7&quality=high&scale=1&noaudio=1&autostart=1&bake=interactive&noprime=1
```

For a settled scene in the browser console:

```js
await __backrooms.waitForIdle(60000);
await __backrooms.perf(5);
__backrooms.stats();
await __backrooms.newSeed('42');
performance.getEntriesByName('br:newSeed').at(-1).duration;
```

For worker measurements, stop browser rendering and other CPU-heavy tasks first:

```sh
node tools/workerbench.ts 7 42 > workerbench.json
npm run bakebench -- --zones LOBBY,POOLROOMS --quality high
```

Keep viewport, DPR, GPU, quality, seed, position and readiness mode identical when comparing revisions. `autostart=1` normally waits for full lighting; `bake=interactive` is necessary to measure the player-facing loading gate. Do not run CPU benchmarks alongside the test suite.

### Remaining costs

First-page startup still generates procedural textures and compiles GPU programs. World changes still generate and bake nearby tiles. Background full-quality bakes continue after the player can enter. Ambient occlusion was the largest measured postprocessing cost: disabling it in the original oversized-buffer scene reduced GPU time from about 11.6 ms to 6.8 ms, but changes the image.

Further substantial gains would need another architectural change, such as persistent texture caching or a different lighting baker, or a visual tradeoff in AO, reflections or resolution. Those are possible improvements, but this audit does not establish that they would preserve the current output and improve performance across hardware. The measured avoidable rebuilds, duplicate draws and resolution bug are addressed here.
