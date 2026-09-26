# Contract changes — R4 rendering performance

Goal: headroom for higher graphics quality. The frame's GPU cost fell 2x at high and 4-5x at ultra with the same
image (docs/PERFORMANCE_AUDIT.md, "Rendering overhaul"). All contract changes are additive or values only.

## 2026-09-26 — `TileMaterials.depth`, `TileMaterials.depthProps` (core/runtime.ts, additive)
- **Change:** `interface TileMaterials { ...; depth: THREE.Material; depthProps: THREE.Material }`: the tile's
  depth-prepass materials (materials/DepthMaterial.ts, one program). The shell and props materials point to them
  through `userData.brDepth`; `dispose()` disposes them.
- **Rationale:** materials/prepass.ts draws depth first and shades with depth writes locked off. The depth program
  must share the tile's fade uniform object (dithered fade-in) and reproduce the alpha test and the reflection
  pass's props cull, so each tile needs its own instance.
- **Consumers:** materials/MaterialSystem.ts, materials/warmup.ts (the program is warmed with the others),
  materials/prepass.ts, post/ScenePass.ts, materials/PlanarReflection.ts.

## 2026-09-26 — Surface vertex stage: `invariant gl_Position`, flat per-face varyings
- **Change:** the surface vertex shader declares `invariant gl_Position` (so the depth program's depth matches
  bit for bit). `vBrTint`, `vBrAux4` and `vBrEmit` are `flat`, like `vBrLayer` / `vBrFlags`.
- **Rationale / invariant:** the mesh writers set layer, flags, tint, emit and aux per face; every triangle of real
  tiles carries equal values on its three vertices (tests/materials/depthPrepass.test.ts). DECAL-flag (alpha-tested)
  surfaces use layers without rotated or stochastic sampling (same test), which the depth program relies on.
- **Consumers:** materials/chunks/vertex.ts, materials/SurfaceMaterial.ts.

## 2026-09-26 — Post pass 2: `AmbientOcclusionPass` replaces `N8AOPostPass`
- **Change:** `POST_PASSES[1].name = 'AmbientOcclusionPass'`; `PostInternals.n8ao` → `PostInternals.ao`. The
  `n8ao` dependency and src/types/n8ao.d.ts are removed. `QualityConfig.ao` keeps its values; they select 8 / 10 /
  12 / 16 samples per AO texel (PostStack `AO_SAMPLES`).
- **Rationale:** N8AO's High mode cost 9.5 ms of the 15.8 ms ultra frame. The new pass keeps N8AO's estimator and
  composite (atmosphere intensities and colours unchanged) at a fraction of the cost.
- **Consumers:** post/PostStack.ts, harness/post.ts (`results.ao`), tests/post.

## 2026-09-26 — Quality values
- `aoHalfRes: true` on every preset (high and ultra were full resolution; captures matched).
- ultra `planarReflectionScale` 1 → 0.67 (the mirrored view at about the display resolution instead of the full
  1.5x supersampled buffer).

## 2026-09-26 — Debug API: `gpuBench?(repeats)`, `gpuProfile?(seconds)` (core/debug.ts, additive)
- `gpuBench` renders the current frame's GPU work (reflection + post stack) `repeats` times back to back inside one
  timer query, median of 7 rounds. `gpuProfile` reports the mean GPU ms of every pass over normal frames
  (app/gpuProfile.ts). The `perf` QA preset records `gpuProfile`.

## 2026-09-26 — Automation readiness (screenshot / QA runs)
- **`WorkerRequest` build: `lighting?: 'full'`** (core/worker.ts, additive): the worker bakes the FULL lightmap in
  place of the preview (same `bakeTile(..., 'full')` call as the bake job; byte-identical result). The streamer
  treats such a build as fully baked and submits no bake job.
- **`StreamerOptions.fullBakeRing?: number`** (stream/ChunkStreamer.ts, additive; default -1): tiles in chunk rings
  <= this build with full lighting, and their jobs run 500 priority units ahead of other tile work. boot.ts sets 1
  for `bake=full` (the automation gate); the player gates keep the WP10 order.
- **`WorldStreamer.processUploads(renderer, budgetMs, burst?)`** (core/runtime.ts, additive): `burst` lifts the
  one-step-per-frame limit within the budget and shows arriving / fading tiles at once. loop.ts passes it (with a
  50 ms budget) only while an automation gate (`bake=full`) is closed.
- **Worker result cache for tool runs** (src/workers/tileCache.ts, tools/viteTileCache.ts): `__BR_TILE_CACHE__`
  (a hash of the worker's source import graph, '' outside tool runs) and the dev-server endpoint
  `/__tilecache/<sha1>`. The worker handles messages strictly in order in either mode (the pool's FIFO rule).
- **tools/shoot.mjs:** `--wait` default 4000 → 250 ms.
