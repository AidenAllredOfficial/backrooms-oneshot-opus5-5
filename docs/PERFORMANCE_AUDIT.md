# Performance audit, September 26, 2026

The largest avoidable costs were rebuilding the application for every seed, serial startup work, and a stale device-pixel ratio during initialization. This pass fixes those costs and removes redundant rendering work. It keeps the existing quality presets, world generation, lighting sample counts and streaming distances.

## Measurements

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

## Changes

### Reuse the application when loading a seed

The title seed field, pause menu's New tape action and Continue on a different seed now reset the world in place. Previously they navigated the page, creating another renderer and worker pool, generating all procedural textures, compiling programs and synthesizing audio again.

The transition retains the renderer, material system, postprocessing targets, audio context and synthesized audio buffers. It reinitializes worker world state, evicts the old geometry, reuses the bounded lightmap texture pool and ignores results from evicted tiles. Lighting overrides, anomalies, audio propagation, interactions, discovery state, timers and water-plane caches reset for the new world. The existing spawn and readiness rules still apply.

Footstep echo and foley nodes are reused. Old ambience and wading nodes disconnect when stopped, so repeated seed changes do not accumulate silent audio connections.

`__backrooms.newSeed(seed)` exercises the same path. `br:newSeed` measures reset-to-ready, and `br:ready` marks readiness with the gate reason.

### Overlap world construction with GPU initialization

Once spawn resolution finishes, the worker pool starts the surrounding nine layouts and 36 geometry/preview-lighting jobs while the main thread generates textures and prepares shaders. A small startup-job adapter hands each original job handle to the streamer exactly once. Completed results are retained without another transfer or rebuild. Unclaimed work is canceled when the live streamer takes over.

The texture baker's final GPU completion check now uses asynchronous readback, so waiting for the GPU does not synchronously block the main thread.

### Apply resolution limits consistently

Initial renderer setup, postprocessing quality changes and the resolution controller now use the same DPR and render-scale limits. Fixed resolution reapplies the current DPR after boot and monitor/zoom changes, just as automatic resolution does.

### Remove rendering work that contributes no pixels

Normal frames write the final postprocessing pass directly to the canvas. The extra display target and full-screen copy are used only when a screenshot is requested. The grain pass still performs the same color encoding in both paths.

Reflection rendering hides water meshes and prop meshes whose bounding spheres lie entirely beyond the existing reflection distance limit. Previously those meshes were submitted and rejected in fragment shaders. Props crossing the boundary retain the exact shader test. Visibility and renderer state are restored even if rendering throws.

### Reduce baker arithmetic overhead

CPU profiling identified polygon form-factor evaluation as a hot path. Bounded local vectors now use `sqrt(x*x + y*y + z*z)` instead of the general overflow-safe `Math.hypot` implementation. The final isolated worker run improved median preview/full bake times by about 2.3%/3.3%. Earlier runs varied more; the smaller isolated result is the useful estimate.

`tools/workerbench.ts` records cold spawn, geometry and both lighting stages for four tiles per seed. It complements the existing bake-only benchmark.

## Verification

- Production build and TypeScript checks pass.
- The full test suite passed during implementation: 1,071 tests, with five existing skips. Final focused validation passed all 67 tests across app runtime, audio, reflection, resolution, startup jobs and residency.
- Added regressions cover completed startup-job reuse, cancellation, reinitialization, stale worker results at identical tile coordinates, fixed-resolution DPR changes, reflection bounds/state restoration and retaining synthesized audio across resets.
- Browser checks covered the title seed field, pause-menu New tape, Continue into another seed at its saved position, repeated seed changes, quality switching, lobby and Poolrooms rendering, capture readback and an automated walk. The recorded game error lists were empty. A final run of the five affected non-audio suites passed all 54 tests after the last gate adjustment.

## Reproduce

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

## Remaining costs

First-page startup still generates procedural textures and compiles GPU programs. World changes still generate and bake nearby tiles. Background full-quality bakes continue after the player can enter. Ambient occlusion was the largest measured postprocessing cost: disabling it in the original oversized-buffer scene reduced GPU time from about 11.6 ms to 6.8 ms, but changes the image.

Further substantial gains would need another architectural change, such as persistent texture caching or a different lighting baker, or a visual tradeoff in AO, reflections or resolution. Those are possible improvements, but this audit does not establish that they would preserve the current output and improve performance across hardware. The measured avoidable rebuilds, duplicate draws and resolution bug are addressed here.
