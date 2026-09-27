# Performance audits, September 26, 2026

Two passes. The second (rendering overhaul) cut the GPU cost of a frame by 2x at high and 4-5x at ultra without
changing the image, and made screenshot / QA runs 3-9x faster; the first removed rebuilds and startup
serialisation.

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
