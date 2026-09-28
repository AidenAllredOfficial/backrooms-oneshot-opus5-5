# BACKROOMS: Final Design Specification (v1)

> **Status:** frozen for implementation. This document is the single source of truth for WP0–WP14.
> **Base:** the "rendering" proposal. It is the base for all three judges.
> **Grafts:** delivery infrastructure from "engineering", world structure from "procgen", audio, feel and comfort from "atmosphere".
> **Contract code:** every block in §4 has been typechecked with the project's TypeScript 7.0.2 under the tsconfig in §4.1, and the pure modules were executed under Node 24.19.
> **Changing the contract:** changes are ADDITIVE ONLY. Each WP proposes them in its OWN file `docs/contract-changes/WP<n>.md` (one writer per file, so parallel agents never race); the orchestrator merges them, applies them and records their status in `docs/contract-changes/STATUS.md`.
> **Revision r2:** this revision resolves the contracts / technical / experience critic rounds (layout transfer, no-leak partitions, tower periodicity, fixture ids, glitch/portal queries, prefetch, bake cost and seams, mesher coverage, decals, water optics, anti-tiling, content and audio breadth). All §4 blocks were re-extracted and re-typechecked; `tests/core/invariants.test.ts` was run under vitest 5.

Contents
1. Vision and key decisions
2. World units, coordinates and constants
3. Module tree and work-package ownership
4. Shared contracts (`src/core/*`: complete source)
5. Work-package specifications (WP0–WP14)
6. Runtime: initialization, frame loop, streaming lifecycle, quality presets
7. Automation contract (URL params, `window.__backrooms`, harness pages, shoot/qa tools)
8. Integration plan, test plan, performance budget, risk register

Appendix A: API facts verified in `node_modules`.

---

## 1. Vision and key decisions

**The product.** A first-person walking simulator through an infinite, deterministic, procedurally generated backrooms. It should look like found footage or a liminal photo:
- soft, leak-free fluorescent light bouncing off mustard wallpaper and damp carpet;
- dim ceilings lit mostly by bounce light, dark corners, and panels that clip into bloom;
- a cheap camera that over-exposes all of this.

**The world.** Three themed strata (Lobby, industrial Sublevel, Poolrooms) are joined by stair towers that are invisible to cross and by elevators. Each stratum is divided into Voronoi districts of about 150 m, each with its own zone. Continuous "power / decay / humidity / warmth" fields cross district borders, so dead sectors, water damage and colour drift look organic.

**Pacing.** A small moment (vignette) every 20–40 s, a new district every 60–150 s, a landmark about every 300 m.

**Sound.** Sound bends around doorways. Dead sectors fall silent. Nothing ever jump-scares you.

### 1.1 Key decisions

| # | Decision | Source |
|---|---|---|
| D1 | **2.5D world model.** Grid of 1.2 m cells; thin walls on cell edges (`WALL_T` 0.15 m); per-cell floor, ceiling, water and blocker heights in integer cm; axis-aligned solids for everything else. One data model feeds the mesher, collision, light-bake visibility and audio. Edge semantics are defined once, in `core/edges.ts`. | rendering + procgen |
| D2 | **Chunks are 32×32 cells (38.4 m)** for generation and streaming. Each chunk is split into **four 16×16-cell render/bake tiles** (19.2 m quadrants). A tile has its own mesh, lightmap atlas, flicker uniforms and material instance, and is the unit of bake jobs. Decided in WP0, never changed. | judges' option 2 |
| D3 | **Baked directional lightmaps**, computed on the CPU in a worker pool.<br>• Visibility: 2.5D height-aware DDA. Partitions, lintels, half walls, soffits and blocker boxes all occlude.<br>• Direct light: analytic polygon irradiance (exact near the emitter, point samples far away).<br>• Indirect light: SH-L1 probes at 3 heights per cell, gathered from an in-job patch cache.<br>• AO: analytic.<br>• Encoding: dominant direction plus directionality, decoded in the shader through `RE_Direct`, and the indirect light's first-order normal response (hemisphere moments of the probes), so normal maps shade the ambient part too.<br>The only runtime light is the flashlight. | rendering (+engineering hybrid form factor) |
| D4 | **No-leak invariant.**<br>• Lightmaps are filtered BILINEAR only.<br>• Floor and ceiling grid charts put texel boundaries on cell lines.<br>• Every occluding edge is at least one texel thick at floor level: `edgeBaseThickness(k) >= LM_TEXEL` for every occluding kind and every allowed density (8 or 12 texels per cell); partitions stand on a 0.15 m plinth. Unit-tested.<br>• Bake samples are clamped `WALL_T/2 + 1 cm` from walls.<br>• There is no bicubic filtering, anywhere. | engineering |
| D5 | **Two bake tiers.**<br>• *preview*: inline with the build job; cell-level visibility plus 2D edge-aware open-edge diffusion. Leak-free, about 50 ms.<br>• *full*: a separate job.<br>The two bakes share one atlas (the chart hash must match) and swap instantly. There is **no LOD1 ring, no dual-lightmap crossfade and no custom TAA** in v1; SMAA is the AA. | judges |
| D6 | **Flicker channels without border rules.**<br>• Generation allows at most one dynamic (FLICKER) light per tile, with window R = 9.5 m.<br>• A light's channel is `(globalTileX&1) + 2*(globalTileZ&1)`, so every texel sees at most one light per channel.<br>• LM_C stores 4 channels; the shader picks the source tile per channel by texel side.<br>• Uniforms hold 9 lights (own tile plus 8 neighbours).<br>• Shadow-correct across tile and chunk borders, with no placement restrictions near borders. | rendering (reworked) |
| D7 | **Seams hide the chunk grid.**<br>• BOUNDARY between different districts: a wall with 1–3 styled openings.<br>• PATTERN: wall runs U(2,10) alternating with open runs U(1,4); 25% of seams are mostly open.<br>• GLOBAL: lattice zones rasterize world-space features.<br>Seams are frozen before zone generation. Every seam has ≥1 port, and a 0-1 BFS repair joins each port inside its chunk, so the world is connected. | procgen + rendering |
| D8 | **Verticality: periodic stair towers.**<br>• The tower is geometry that is identical under a 3 m shift, spanning y ∈ [−6, +6].<br>• It has an isolated bake group, so its lighting is exactly periodic.<br>• The storey switches at \|feetY\| > 1.6 m (hysteresis ±0.2).<br>• One storey is resident; the target storey (layouts, collision and tiles) is prefetched near a tower.<br>• Tower cells use a fixed palette zone (CONCRETE, mood NORMAL) in every storey, tower fixtures have storey-free ids, and tower layers, props and light-volume lookups are 3 m-periodic.<br>• Storeys cycle 0→1→2→0 going down: "the building never ends".<br>• Elevators are a closed-box teleport. | procgen |
| D9 | **GPU procedural textures.**<br>• One full-screen draw per map per layer into three single-attachment `WebGLArrayRenderTarget`s (never array MRT).<br>• `generateMipmaps` is off until the last layer is written.<br>• 28 layers, 1024².<br>• `layerAlbedoCheck` reads back the result and compares it with the `LAYER_DEFS.albedoMean` the baker uses. | rendering + procgen |
| D10 | **One surface material factory**: `MeshStandardMaterial` + `onBeforeCompile`, sampling `sampler2DArray`s.<br>• Custom attributes use the `br*` prefix.<br>• Materials come from a factory per tile; `clone()` is never called.<br>• A constant `customProgramCacheKey`.<br>• Debug views are an int uniform.<br>• Three program variants: shell (lightmapped), props (light volume) and decal (shell lighting, premultiplied soft alpha); water is its own ShaderMaterial. | rendering + engineering |
| D11 | **Post stack (pmndrs).** In order:<br>1. `ScenePass` (R4: `RenderPass` with a depth prepass; graphics-realism A: the frame graph, with the pre-shade SSAO as its first depth hook)<br>2. (no AO pass: the surface shader applies the SSAO to indirect light)<br>3. `AutoExposurePass` (async RGBA8 readback, CPU spring)<br>4. `EffectPass[MotionBlur(CONVOLUTION\|DEPTH), Glare, Exposure, AgX, Grade]` (package C: energy-conserving angular glare replaces bloom + halation)<br>5. `EffectPass[SMAA \| FXAA]`<br>6. `EffectPass[Lens(CONVOLUTION), FilmGrain]`, with dithering (lens distortion/CA/vignette apply to the finished image, bloom included)<br>All shaders clamp radiance to `HDR_CLAMP` before writing the HalfFloat buffer. | rendering (fixed n8ao handling) |
| D12 | **Haze is per-fragment inscatter from local lightmap irradiance**, so dark sectors get dark haze. A separate **edge fog** (0.55R→0.8R of the streaming radius; the desired set is centred 2 s ahead along the player's velocity) hides the world edge without hazing near geometry. The clear colour equals the far colour. | rendering (+edge fog) |
| D13 | **Content.**<br>• 12 zones: 7 Level 0 family (LOBBY, MANILA, DARK, MAZE, LOW_EXPANSE, PILLAR_HALL, OFFICE) and 5 deep (POOLROOMS, PARKING, PIPEWORKS, WAREHOUSE, CONCRETE).<br>• 13 landmarks (≥ 4 per storey), 13 vignettes with a zone weight table, 7 anomaly kinds, split-level features, arteries, onboarding districts.<br>• A spawn composition tuned to the famous photo: the LOBBY recursive-division generator.<br>• No lore overload. | procgen (scoped) |
| D14 | **Audio**, all synthesized:<br>• 5 Hz Dijkstra propagation; the apparent source is placed at the visible portal.<br>• Flicker transients sample-aligned to the pure flicker function.<br>• Sabine room probe selects the impulse response.<br>• The hum bed follows lit-fixture density.<br>• Gated dread events; photosensitivity flicker modes. | atmosphere |
| D15 | **Delivery.**<br>• WP0 walking skeleton: frozen contracts plus stubs, so `npm run dev` walks from day 1.<br>• A pure `handleRequest` plus a Node full-pipeline integration test.<br>• Per-WP harness pages; the `imageStats` / `autowalk` QA API.<br>• three pinned to exactly `0.186.1`.<br>• `erasableSyntaxOnly` and `.ts` import specifiers, so `node tools/*.ts` runs pure modules. | engineering |
| D16 | **Target WebGL2 only.** No floating origin: vertices are tile-local, and `mesh.position` is float64 on the CPU. No IndexedDB caching. No runtime point lights (the flashlight is the only light and always exists). | judges |

### 1.2 Conflicts resolved (one decision each)

| Conflict | Decision |
|---|---|
| Chunk size | 32-cell chunks, with 16-cell tiles as the bake, render and cull unit. |
| Lightmap filter | Bilinear only. Grid charts keep a 1-texel apron **baked with true values** (not dilated), so tiles stay seamless. No per-chart UV clamp is needed because of D4. |
| Texel density | 8 texels per cell (0.15 m) on low and medium, 12 (0.1 m) on high and ultra. `WALL_T` = 0.15. |
| AA | SMAA (FXAA on low). TAA is not in v1. |
| Far LOD | None. Edge fog plus stream radius (1/2/2/3 chunks). |
| Stratum model | Separate planes per storey, one resident. The periodic tower prefetches the target storey; no frustum-gated door. |
| Storey count | 3 themed storeys, cyclic. The ENDLESS_STAIRS anomaly (1 in 20 towers) shifts y without changing storey. |
| Fog | Per-fragment inscatter plus edge fog. No `scene.fog`, no FogExp2. |
| Flicker ownership | `core/flicker.ts` (pure). WP0 writes the stub; WP11 implements it; audio and the renderer both call it. |
| n8ao transparency | Set `pass.autoDetectTransparency = false` after construction. If `configuration.transparencyAware` is true, set it to false. QA asserts the draw-call count. (Setting `transparencyAware=false` alone is a no-op: verified.) |
| SpotLight cookie | Used on all presets. `map` works without `castShadow` in r186 (verified), but the flashlight always casts shadows anyway so it does not leak. |
| Props lighting | Per-tile light volume (32×6×32, 0.6 m) plus an 18×18 per-tile wall-mask texture. Up-facing fragments drop the level below them once it lies `TUNE.LV_BACK_D` (0.1 m) behind their plane and holds their prop's own shadow (1.5–3× darker than the level above; never darkened by the samples under their own prop), and each fragment clamps its lookup ≥ 0.3 m inside its **own** cell on occluding sides, so trilinear filtering never crosses a wall, for any prop size. Tower props wrap y into one period. Both variants get directional specular from the dominant direction and a uniform-environment indirect specular term. |
| Floor reflections | Emission-map reflection (88² per tile, with region-key rejection by `texelFetch` at level 0) on REFLECTIVE glossy surfaces, including props. Dynamic emitters flicker in the reflection. Planar reflection is used only for the water plane nearest the camera. High / ultra replace the emission map by screen-space reflections and the camera-room reflection probe (graphics-realism D; WP11 PostStack). |
| Decals | A separate per-tile `decals` mesh drawn with a third material variant `decal`: premultiplied soft alpha (`CustomBlending(One, OneMinusSrcAlpha)`), `transparent = false`, `depthWrite = false`, `polygonOffset(−1, −4)`, `renderOrder 1`, borrowed lightmap UVs. Non-transparent, so N8AO's transparency path is never triggered. SIGNAGE and CHALK_ARROW keep hard alpha. |
| Mood versus zone | Mood (NORMAL, SPARSE, DYING, DARK) is a per-district axis that multiplies the power field. The DARK zone forces DARK mood. |
| Positions in layouts | Chunk-local metres. Mesh vertices are tile-local. Only runtime queries use world metres. |
| World seed | `hashString(seedText)`: a pure-digit string parses as a uint32, so `seed=1` means 1. |

## 2. World units, coordinates and constants

The authoritative values live in `src/core/constants.ts` (§4.3). This section explains them.

### 2.1 Units and axes
- **Units.** 1 unit = 1 m; seconds; radians.
- **Photometry.** Luminance in nits (cd/m²), illuminance in lux, point intensity in candela.
  - Lightmaps store **irradiance in lux**.
  - Emissive panels are in nits, e.g. a Level 0 troffer is 3300 nits.
  - The flashlight peaks at 5500 cd on its axis (package F optics, `lighting/flashlightOptics.ts`; wave 1 3000, R2-post 2000, was 600).
- **Axes.** Right-handed, **+Y up, +X east, −Z north** (three.js default).
- **Camera.** Euler order `'YXZ'`.
  - **yaw 0 looks along −Z**; **positive yaw turns left** (counter-clockwise seen from above).
  - Positive pitch looks up; pitch is clamped to ±1.5 rad.
  - Forward vector is `(−sin yaw, 0, −cos yaw)`.
  - URL and API angles are radians (`yawDeg` is accepted in the URL).
- **Heights.** Every height in a layout is an Int16 **centimetre** value relative to the storey origin (storey floor datum y = 0). The standard ceiling is 270 cm.

### 2.2 Grid, chunk and tile

| Quantity | Value |
|---|---|
| Cell | `CELL = 1.2` m (two 0.6 m ceiling tiles; a 2×4 troffer is 0.6×1.2 m) |
| Chunk | 32×32 cells = 38.4 m. The generation and streaming unit. |
| Tile ("RTile") | 16×16 cells = 19.2 m. Tiles are the 4 quadrants of a chunk, `q = qx + 2·qz`, and are the render, bake, cull and lightmap unit. |
| District | Voronoi site per 4×4-chunk site cell, jitter ±1.5 chunks, warp amplitude 0.8 chunk. Average ~16 chunks, about 150 m across. |
| Walls | Centred on edge lines. `WALL_T = 0.15`, `PARTITION_T = 0.06` (on a 0.15 m wide, 10 cm tall plinth). Corner posts are 0.15². |
| Openings | DOORWAY: 0.9 m hole, head at 210 cm. HEADER: underside at 220 cm. ARCH: crown at 260 cm, jambs 0.1 m. PARTITION: 150 cm. HALF: 105 cm. RAIL: 100 cm. WINDOW: sill 95, head 200. |
| Player | Radius 0.28, height 1.75, eye 1.62. Crouch: height 1.15, eye 1.0. Step 0.36. |
| Speeds | Walk 1.45, sprint 3.2 (tired: 2.4), crouch 0.75 m/s |
| Storeys | 0 LOBBY, 1 SUBLEVEL, 2 POOLROOMS. Going down: `s → (s+1) % 3`. The tower shift is 3.0 m. |

**Global cell** `gi = floor(x/1.2 + 1e-7)`. **Chunk** `cx = floorDiv(gi, 32)`. **Local** `li = gi − 32·cx`. **Tile** `q = (li>>4) | ((lj>>4)<<1)`. Chunk, local cell and tile are **always derived from `worldToCell`**, never from metres directly (`worldToChunk`, `tileKeyAt` and `tileOfPoint` in `core/grid.ts` do this), so all helpers agree at boundaries.

**Arrays.**
- Cells: `lj*32 + li`.
- x-edges (`ex`, on the line `x = i·CELL` between cells (i−1, lj) and (i, lj)): `lj*33 + i`, with i in 0..32.
- z-edges (`ez`): `j*32 + li`.

**Border lines.** A chunk stores **both** border lines. Border values come from the pure `seam()` function, so neighbouring chunks agree bit-for-bit (tested).

**Face ownership (meshing and lightmaps).** Every rendered face is split at cell lines. The owner of each piece is **the cell it faces**: the cell containing `faceCentre + 1 cm · normal` (for up/down faces, the cell containing the centre). Ownership determines the tile. The result: no duplicate faces, no z-fighting, one owner per texel. (Exception: recessed fixture geometry is emitted whole in the tile `tileOfPoint(centre)`; generation guarantees fixtures never straddle a tile line.)

**Precision.**
- Mesh vertices are **tile-local**, and `group.position` is the tile origin (float64 on the CPU).
- Material UVs are tile-local metres divided by `repeat`; on vertical faces `v = y / repeatY` (`layerRepeatY`, default `repeat`). Every repeat divides 19.2 m (unit-tested), so UVs are seamless.
- World-space shader noise uses `tileLocal + (tileOrigin mod NOISE_WRAP)`, with `NOISE_WRAP = 1228.8`. GLSL noise periods must divide it. Any noise that also uses **y** must be periodic in y with a period dividing `STOREY_PITCH` (3 m), so stair towers stay periodic.
- Shader positions: the tangent frame and haze distance come from view-space position (`vViewPosition`, formed in float64 on the CPU via `modelViewMatrix`), never from float32 world position.

### 2.3 Lightmap geometry (the no-leak rule, D4)

- **Densities.** `tpc` (texels per cell) is 8 or 12, so the texel is 0.15 m or 0.1 m. **Invariant: `CELL/tpc <= WALL_T`**.
- **Grid charts.** Each tile has a FLOOR_GRID and a CEIL_GRID chart of `(16·tpc + 2)²` texels: a 1-texel apron on every side, baked at true positions. Texel `(u,v)` has its centre at tile-local `x = (u − 0.5)·t`, `z = (v − 0.5)·t`.
- **Why nothing leaks.** Edge centre lines fall exactly on texel boundaries. For an occluding edge of floor-level thickness `T = edgeBaseThickness(kind)` (WALL_T for walls, `PARTITION_BASE_T = 0.15` for partitions, whose 6 cm panel stands on a plinth), the nearest visible floor point is `T/2` from the line and the nearest wrong-side texel centre is `t/2` behind it, so the bilinear weight across the edge = `max(0, (t − T)/(2t)) = 0` because `t ≤ T` for every occluding kind and every tpc (unit-tested for all `EdgeKind`s).
- **Sample clamping.** Bake sample points are clamped `WALL_T/2 + 0.01` inside the owner cell.
- **Wall, step, soffit and box charts.** These are separate charts with `LM_PAD = 2` gutters, filled by dilation. At a tile split, the apron is baked at true positions (`Chart.cont` bits).
- **Filtering.** Bilinear only. **Never bicubic.**

### 2.4 Tower geometry (tower-local frame, rot 0; `u` across, `v` along)

```
 footprint 3 x 5 cells (TOWER.W_CELLS x TOWER.L_CELLS), all cells flagged TOWER|RESERVED,
 cell floorCm = -600, ceilCm = +600 so perimeter edge walls extrude over the full span.

   v=0   v=1   v=2   v=3   v=4        u = 0,1: shaft (2.4 m wide)   u = 2: vestibule strip
 +-----+-----+-----+-----+-----+
 | L0  | A=========>A      | L1  |  u=0  lane A: flight from end0 (v=0) down to end1 (v=4), -1.5 m
 |     |-----central wall--|     |       (12 treads x 0.30 m, 13 risers)
 | L0  | B<=========B      | L1  |  u=1  lane B: flight from end1 back to end0, another -1.5 m
 +--D--+-----+-----+-----+-----+       D = DOORWAY landing(end0) -> vestibule (line u=2, v=0)
 | V0    V     V     V     V4  X       X = DOORWAY vestibule -> storey (line u=3, v=4), y=0 copy only
 +-----+-----+-----+-----+-----+
 Landings: end0 at y = 0, ±3, ±6; end1 at y = ±1.5, ±4.5. Lane A descends end0->end1, lane B end1->end0.
 Fundamental period y in [-1.5, 1.5): WP4 emits ONE period of solids + fixtures + props (bakeGroup = towerId).
 Mesher, props, collision and baker replicate at y + 3k (core/layout.ts TOWER_REPLICAS, clipped to |y| <= 6).
 X is a perimeter DOORWAY edge: its hole spans only [max floor = 0, 2.1], so the sill (y<0) and lintel (y>2.1)
 seal the vestibule copies at y = ±3, ±6 automatically. Interior walls (central wall, shaft|vestibule wall with
 door D) are periodic SOLIDS. No straight line from the shaft passes through D and then X (WP4 DDA unit test).
 Switch: feet inside the footprint and feetY < -1.6 => storey (s+1)%3, y += 3; feetY > +1.6 => (s+2)%3, y -= 3.
```

The tower is lit only by its own fixtures: CAGE_BULBs on every landing, state ON, ids `structureFixtureId(towerId, SALT.TOWER, index)` and seeds `fixtureSeed(id)`, never derived from the storey (replicas share the id; consumers keying by id treat them as one source, taking the nearest). It bakes only against its own occluders, **periodically**: every surface has texel rows integral per 3 m, and the light set is replicated at every period within the window. Periodicity also covers everything else a player can see or hear in the shaft:
- **Materials:** tower shell geometry uses only `TOWER_LAYERS`, whose `STOREY_PITCH / repeatY` is integral (tested); no trims inside. GLSL noise in y has a period dividing 3 m.
- **Props:** HANDRAIL and other props inside the footprint are replicated by `expandPeriodicProps` exactly like solids. Their light-volume lookups wrap y into [1.5, 4.5) (`PROP_AUX` tower bit); the baker bakes TOWER-cell LV samples with the tower's bake group.
- **Atlas:** tower charts (bakeGroup ≠ 0) are never density-halved by the overflow rule, so every storey bakes the tower at the same density.
- **Zone and mood:** tower and elevator cells have `cellZone = STRUCTURE_ZONE` (CONCRETE) and mood NORMAL in every storey; atmosphere, ambience and hum follow `WorldQuery.zoneAt/moodAt`, which are cell-based.
- **Streaming:** the target storey's layouts, collision and tiles are prefetched; the tower's own tiles must be full-baked before the switch.

The result is pixel-identical at the switch; QA takes a pixel diff at the mid landing and asserts max frame time < 50 ms across the switch (§8).

## 3. Module tree and work-package ownership

Every file has exactly one owner. A WP may create extra private files **only inside its own directories** (marked `/*`), and tests only under `tests/<its dir>/`. Cross-WP imports go through the exported API listed in §5. Where an implementation is needed before its owner delivers, the WP0 stub is used.

### 3.1 Work packages

| WP | Name | Approx. size | One-line scope |
|---|---|---|---|
| **WP0** | Core contracts and walking skeleton (orchestrator) | ~2.5k | `src/core/*`, tsconfig/package pin, stubs for every export, arch/invariant tests, `docs/contract-changes/` (template + STATUS) |
| WP1 | World structure | ~3.5k | districts, fields, seams, arteries, sites, chunk pipeline, ChunkGrid, connectivity, rooms/regions, validation, spawn/find, ASCII, test scenes, `tools/map.ts` |
| WP2 | Zones: Level 0 family | ~2.5k | LOBBY (+MANILA/DARK), MAZE, LOW_EXPANSE, PILLAR_HALL, OFFICE generators |
| WP3 | Zones: deep | ~2.5k | POOLROOMS, PARKING, PIPEWORKS, WAREHOUSE, CONCRETE generators |
| WP4 | Structures and content | ~3.5k | tower, elevator, glitch walls, pits, 13 landmarks, fixture placement and states, props/vignettes/anomalies/leaks/signs/chalk/decal placement |
| WP5 | Mesher | ~3.5k | surfaces/charts/atlas, walls/floors/ceilings/soffits/solids/stairs/trims/decals/water, tile build |
| WP6 | Prop and fixture geometry | ~3k | procedural meshes for 45 prop kinds, surface fixtures, pipes; per-tile props mesh |
| WP7 | Light baker | ~4k | 2.5D visibility, direct/indirect/AO, flicker channels, surface mask, emission map, light volume, preview bake, bench |
| WP8 | Procedural textures | ~3.5k | GPU texgen of 28 layers, grime/water/cookie, albedo check, materials harness |
| WP9 | Materials and shaders | ~3k | SurfaceMaterial factory (shell/props), shader chunks, water, planar reflection, debug views, warmup |
| WP10 | Streaming and workers | ~3.5k | worker pool, `handleRequest`, validatePayload, streamer and residency, texture pool, tile objects, world queries, chunk harness, Node pipeline test |
| WP11 | Lighting runtime and post | ~3.5k | flicker (pure), lighting runtime, flashlight, atmospheres, post stack, exposure, custom effects, dynamic resolution, capture, post harness |
| WP12 | Player | ~2.5k | controller, collision, collision build, head bob/camera rig, input, traversal (tower/elevator/glitch), autopilot |
| WP13 | Audio | ~3.5k | synthesized DSP, hum voices, footsteps, propagation, room probe and reverb, ambience, dread director, emitters |
| WP14 | App shell, UI, debug and QA | ~3.5k | boot, loop, URL params, settings store, UI screens, `window.__backrooms`, imageStats, perf, autowalk, shoot/qa tools |

### 3.2 File tree

```
index.html                                   WP14
harness/index.html                           WP14   (links to the harness pages)
harness/materials.html                       WP8
harness/chunk.html                           WP10
harness/post.html                            WP11
package.json, tsconfig.json, vite.config.ts  WP0    (WP14 may add harness inputs to vite.config via contract-changes)
docs/DESIGN.md                               orchestrator
docs/contract-changes/WP<n>.md               owned by WP<n> (one file per WP; WP0 creates the empty files + TEMPLATE.md)
docs/contract-changes/STATUS.md              orchestrator (merge log: proposal, decision, applied-in)

src/main.ts                                  WP14
src/types/n8ao.d.ts                          WP0
src/core/constants.ts ids.ts grid.ts rng.ts noise.ts half.ts edges.ts layout.ts world.ts
         materials.ts props.ts zones.ts quality.ts settings.ts events.ts mesh.ts writer.ts
         worker.ts player.ts debug.ts runtime.ts index.ts                          WP0
src/core/flicker.ts                          WP0 stub -> WP11 owns the implementation (signatures frozen)

src/world/worldgen.ts                        WP1  createWorldGen (facade + caches)
src/world/districts.ts                       WP1  sites, warp, zone/mood pick, onboarding, district params cache
src/world/fields.ts                          WP1  createFieldSampler
src/world/seams.ts                           WP1  seam(): BOUNDARY / PATTERN / GLOBAL + artery overrides + port guarantee
src/world/sites.ts                           WP1  towersNear / elevatorsNear / arteriesNear / landmarkAt
src/world/chunkgen.ts                        WP1  generateChunk pipeline (order in §5.WP1)
src/world/chunkGrid.ts                       WP1  createChunkGrid (implements core ChunkGrid)
src/world/arteries.ts                        WP1  artery stamping
src/world/connectivity.ts                    WP1  repairConnectivity
src/world/rooms.ts                           WP1  labelRooms, spawn flags
src/world/neighborhood.ts                    WP1  makeNeighborhood (implements LayoutNeighborhood incl. region())
src/world/validate.ts                        WP1  validateLayout, layoutHash
src/world/spawn.ts                           WP1  findSpawn, findNearest
src/world/ascii.ts                           WP1  layoutToAscii, asciiMap, layoutFromAscii
src/world/testScenes.ts                      WP1  leak / cornell / tower / materials / flicker / grid
src/world/zones/registry.ts                  WP1  ZONE_GENERATORS: Record<baseZone, ZoneGenerator>
src/world/zones/defaultSeam.ts               WP1  default PATTERN seam used when a generator has no seamPattern
src/world/zones/lobby.ts maze.ts lowExpanse.ts pillarHall.ts office.ts l0common.ts            WP2
src/world/zones/poolrooms.ts parking.ts pipeworks.ts warehouse.ts concrete.ts deepcommon.ts   WP3
src/world/structures/tower.ts elevator.ts glitch.ts pit.ts                                    WP4
src/world/landmarks/index.ts redRoom.ts endlessHall.ts atrium.ts chairCathedral.ts
                    floodedHall.ts lockedExit.ts vendingAlcove.ts serverRoom.ts deepEnd.ts
                    skylightHall.ts lockerRoom.ts loadingDock.ts boilerHall.ts                 WP4
src/world/content/fixtures.ts fixtureStates.ts kelvin.ts props.ts vignettes.ts anomalies.ts
                  leaks.ts signs.ts chalk.ts keepClear.ts decals.ts                            WP4

src/mesh/buildTile.ts surfaces.ts atlas.ts walls.ts floors.ts ceilings.ts solids.ts stairs.ts
        trims.ts decals.ts water.ts periodic.ts uv.ts chartHash.ts                             WP5
src/props/index.ts tileProps.ts primitives.ts furniture.ts office.ts industrial.ts pool.ts
         misc.ts fixtures.ts pipes.ts                                                          WP6
src/bake/index.ts context.ts visgrid.ts dda.ts areaLight.ts classify.ts direct.ts patches.ts
        probes.ts sh.ts indirect.ts preview.ts ao.ts channels.ts mask.ts emission.ts volume.ts
        dilate.ts encode.ts visbits.ts cache.ts                                                 WP7
src/textures/TextureBaker.ts registry.ts glsl/noise.ts glsl/common.ts layers/*.ts grime.ts
            cookie.ts waterNormals.ts signage.ts decals.ts albedoCheck.ts                      WP8
src/materials/MaterialSystem.ts SurfaceMaterial.ts chunks/vertex.ts chunks/surface.ts
             chunks/lighting.ts chunks/haze.ts chunks/debug.ts WaterMaterial.ts
             PlanarReflection.ts zeroTextures.ts warmup.ts anchors.ts                          WP9
src/stream/WorkerPool.ts ChunkStreamer.ts TileObject.ts TexturePool.ts geometry.ts
          WorldQueryImpl.ts priorities.ts                                                      WP10
src/workers/chunk.worker.ts handler.ts layoutCache.ts validatePayload.ts                       WP10
src/lighting/LightingRuntime.ts Flashlight.ts atmospheres.ts atmosphereBlend.ts
            anomalyDirector.ts sparks.ts                                                       WP11
src/post/PostStack.ts AutoExposurePass.ts DynamicResolution.ts capture.ts
        effects/LensEffect.ts effects/ExposureEffect.ts effects/ColorGradeEffect.ts
        effects/FilmGrainEffect.ts                                                             WP11
src/player/controller.ts collision.ts collisionBuild.ts headBob.ts cameraRig.ts input.ts
          PlayerSystem.ts autopilot.ts traversal/tower.ts traversal/elevator.ts
          traversal/glitch.ts traversal/pit.ts traversal/doors.ts interact.ts                  WP12
src/audio/AudioEngine.ts graph.ts humVoices.ts footsteps.ts fixtureSfx.ts propagation.ts
         roomProbe.ts reverb.ts ambience.ts dread.ts emitters.ts foley.ts zoneAudio.ts
         dsp/hum.ts dsp/footsteps.ts dsp/fixtures.ts dsp/ir.ts dsp/beds.ts dsp/noise.ts dsp/util.ts
         dsp/oneshots.ts dsp/emitters.ts oneShots.ts                                           WP13
src/app/App.ts boot.ts loop.ts urlParams.ts debugApi.ts imageStats.ts perf.ts autowalk.ts
       qualityAuto.ts settingsStore.ts continueStore.ts clock.ts renderer.ts                   WP14
src/ui/ui.ts title.ts pause.ts settingsPanel.ts loading.ts overlay.ts style.css                WP14
src/harness/materials.ts (WP8)   src/harness/chunk.ts (WP10)   src/harness/post.ts (WP11)

tools/shoot.mjs qa.mjs qa-presets.json       WP14   (shoot.mjs stays backward compatible)
tools/map.ts                                 WP1
tools/bakebench.ts                           WP7

tests/core/* tests/arch/*                    WP0
tests/world/districts|fields|seams|chunkgen|connectivity|spawn|ascii.test.ts   WP1
tests/world/zones-l0.test.ts                 WP2
tests/world/zones-deep.test.ts               WP3
tests/world/structures|content|tower.test.ts WP4
tests/mesh/*                                 WP5
tests/props/*                                WP6
tests/bake/*                                 WP7
tests/textures/*                             WP8   (registry completeness only; GPU checks run in the harness)
tests/materials/*                            WP9   (shader anchors, cache keys)
tests/stream/* tests/workers/* tests/integration/pipeline.test.ts             WP10
tests/lighting/* tests/post/*                WP11
tests/player/*                               WP12
tests/audio/*                                WP13
tests/app/*                                  WP14
```

### 3.3 Import rules (enforced by `tests/arch/imports.test.ts`, §4.26)

- **Pure** (no `three`, `postprocessing`, `n8ao`, DOM, `Math.random`, `Date`, `performance.now`):
  - directories: `src/core/**`, `src/world/**`, `src/mesh/**`, `src/props/**`, `src/bake/**`, `src/workers/**`, `src/audio/dsp/**`;
  - files: `src/player/{controller,collision,collisionBuild,headBob}.ts`, `src/audio/{propagation,roomProbe}.ts`, `src/app/urlParams.ts`.
  - Exceptions:
    - `src/core/runtime.ts` may `import type` from three.
    - `src/workers/*` and `src/bake/index.ts` may call `performance.now()` for timing stats only.
- **Everything else** may import three and pure modules.
- **Import style.** All relative imports end in `.ts`. Type-only imports use `import type` (required by `verbatimModuleSyntax`). No `enum`, `namespace` or parameter properties (`erasableSyntaxOnly`).
- **Workers.** A worker may import only pure modules. The worker file is loaded with `new Worker(new URL('../workers/chunk.worker.ts', import.meta.url), { type: 'module' })`.

## 4. Shared contracts (complete source of `src/core/*`)

WP0 copies every block in this section verbatim. All blocks were compiled together with `tsc` 7.0.2 under the tsconfig below. `constants`, `rng`, `noise`, `half`, `edges`, `layout`, `events` and `writer` were also executed under plain `node` 24.19 (type stripping).

**Ownership of values.** Tables are append-only. Two numeric tables have delegated tuners, who make changes through their own `docs/contract-changes/WP<n>.md`:
- `LAYER_DEFS`: albedoMean and roughness numbers, tuned by WP8.
- `STRATA_WEIGHTS`: tuned by WP1.

### 4.1 Toolchain changes (WP0)

`package.json`:
- Pin `"three": "0.186.1"` **exactly**. postprocessing 6.39.5 has the peer range `>=0.168 <0.187`.
- Pin `"@types/three": "~0.186.0"`.
- Add devDependency `"@types/node": "^24"`.
- Scripts:

```json
{
  "dev": "vite",
  "build": "tsc --noEmit && vite build",
  "typecheck": "tsc --noEmit",
  "test": "vitest run",
  "bench": "BENCH=1 vitest run tests/bake/bench.test.ts",
  "map": "node tools/map.ts",
  "bakebench": "node tools/bakebench.ts",
  "qa": "node tools/qa.mjs"
}
```

`tsconfig.json`: the complete file.

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable", "WebWorker"],
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": false,
    "noFallthroughCasesInSwitch": true,
    "isolatedModules": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "allowImportingTsExtensions": true,
    "erasableSyntaxOnly": true,
    "verbatimModuleSyntax": true,
    "types": ["vite/client", "node"],
    "noEmit": true
  },
  "include": ["src", "tests", "tools"]
}
```

`vite.config.ts`: keep the existing file (`worker: { format: 'es' }`, `test: { include: ['tests/**/*.test.ts'], environment: 'node' }`). Add `build.rollupOptions.input = { main: 'index.html', materials: 'harness/materials.html', chunk: 'harness/chunk.html', post: 'harness/post.html', harness: 'harness/index.html' }`. The dev server serves `harness/*.html` directly.

### 4.2 `src/core/index.ts`

Barrel. Pure modules may import from here or from individual files.

```ts
// src/core/index.ts — barrel (type + value re-exports). Pure modules may import from here.
export * from './constants.ts';
export * from './ids.ts';
export * from './grid.ts';
export * from './rng.ts';
export * from './noise.ts';
export * from './half.ts';
export * from './edges.ts';
export * from './layout.ts';
export * from './world.ts';
export * from './materials.ts';
export * from './props.ts';
export * from './zones.ts';
export * from './quality.ts';
export * from './settings.ts';
export * from './events.ts';
export * from './mesh.ts';
export * from './writer.ts';
export * from './worker.ts';
export * from './flicker.ts';
export * from './player.ts';
export * from './debug.ts';
export type * from './runtime.ts';
```

### 4.3 `src/core/constants.ts`

```ts
// src/core/constants.ts — single source of truth for units, grid sizes and invariants.
// Units: metres, seconds, radians. Photometric: luminance in nits (cd/m^2), illuminance in lux,
// point-light intensity in candela. Heights inside layouts are integer centimetres (Int16).

export const GEN_VERSION = 1; // mixed into every generation hash; bump => update golden hashes

// ---------------------------------------------------------------- grid
export const CELL = 1.2; // m, = two 0.6 m ceiling tiles
export const CEIL_TILE = 0.6; // m
export const CHUNK_CELLS = 32; // generation + streaming unit
export const CHUNK_SIZE = 38.4; // m
export const CHUNK_CELL_COUNT = 1024; // 32*32
export const EDGE_LINES = 33; // lines per axis stored per chunk (both borders)
export const EDGE_COUNT = 1056; // 33*32 edges per axis
export const TILE_CELLS = 16; // render/bake tile ("RTile") = one chunk quadrant
export const TILE_SIZE = 19.2; // m
export const TILES_PER_AXIS = 2; // per chunk
export const TILES_PER_CHUNK = 4;

// ---------------------------------------------------------------- walls / openings (cm unless noted)
export const WALL_T = 0.15; // m, centred on the edge line
export const PARTITION_T = 0.06; // m, panel thickness above the base plinth
export const PARTITION_BASE_T = 0.15; // m, floor plinth under PARTITION panels (keeps the no-leak rule, see below)
export const PARTITION_BASE_CM = 10; // plinth height
export const DOOR_W = 0.9; // m, DOORWAY hole width, centred on the edge
export const DOOR_CM = 210; // default DOORWAY head height
export const HEADER_CM = 220; // default HEADER underside
export const ARCH_CROWN_CM = 260; // default ARCH crown
export const ARCH_JAMB = 0.1; // m per side
export const PARTITION_CM = 150;
export const HALF_WALL_CM = 105;
export const RAIL_CM = 100;
export const STD_CEIL_CM = 270;

// ---------------------------------------------------------------- storeys / verticality
export const STOREY_COUNT = 3; // 0 Lobby, 1 Sublevel (industrial), 2 Poolrooms; down: s -> (s+1)%3
export const STOREY_PITCH = 3.0; // m, y shift applied by the periodic stair tower
export const TOWER_SWITCH_Y = 1.6; // m, |feetY| beyond this inside a tower footprint switches storey
export const TOWER_SPAN = 6.0; // m, tower geometry spans y in [-6, +6] in every storey
export const TOWER = { SUPER_CHUNKS: 4, W_CELLS: 3, L_CELLS: 5, SEAM_MARGIN: 2, FLIGHT_RISE: 1.5, TREADS: 12, TREAD: 0.3 } as const;
export const ELEVATOR = { SUPER_CHUNKS: 8, W_CELLS: 2, L_CELLS: 3, DWELL_S: 3, RIDE_S: 6 } as const;
export const ARTERY = { BAND_CHUNKS: 12, BAND_P: 0.5, SEG_CHUNKS: 8, SEG_P: 0.7, WIDTH_CELLS: 2, SEAM_MARGIN: 3 } as const;

// ---------------------------------------------------------------- districts / fields
export const DISTRICT = { SITE_CHUNKS: 4, JITTER_CHUNKS: 1.5, WARP_AMP_CHUNKS: 0.8, WARP_WAVELENGTH_CHUNKS: 6 } as const;
export const FIELD_WAVELENGTH = { power: 96, decay: 160, humidity: 72, warmth: 400 } as const; // metres

// ---------------------------------------------------------------- player
export const PLAYER = {
  radius: 0.28, height: 1.75, eye: 1.62, crouchHeight: 1.15, crouchEye: 1.0, stepMax: 0.36,
  walk: 1.45, sprint: 3.2, sprintTired: 2.4, crouch: 0.75, gravity: 9.81, wadeMaxDepth: 1.1,
} as const;

// ---------------------------------------------------------------- lightmaps (the no-leak invariant)
// Floor/ceiling charts are whole-tile grids whose texel boundaries lie on cell lines (integer texels per
// cell). With BILINEAR filtering only, a visible floor point is >= T/2 from the line of an occluding edge,
// T = edgeBaseThickness(kind) (core/edges.ts: WALL_T, or PARTITION_BASE_T under partitions), and the nearest
// wrong-side texel centre is LM_TEXEL/2 behind the line, so its bilinear weight is
// max(0, (LM_TEXEL/2 - T/2) / LM_TEXEL) = 0  iff  LM_TEXEL <= T  for EVERY occluding kind.
// (tests/core/invariants.test.ts checks all EdgeKinds x all LM_TPC_ALLOWED.)
export const LM_TPC_ALLOWED = [8, 12] as const; // texels per cell
export type LmTpc = (typeof LM_TPC_ALLOWED)[number];
export const lmTexel = (tpc: LmTpc): number => CELL / tpc;
export const LM_ATLAS_W = 512; // atlas width; height in {256,512,768,1024}
export const LM_PAD = 2; // texels of padding (dilated) around every non-grid chart
export const LM_SAMPLE_WALL_CLEAR = WALL_T / 2 + 0.01; // bake sample points are clamped this far from walls

// ---------------------------------------------------------------- baked lighting
export const LIGHT = {
  R_STATIC: 10, // m, window radius for closed zones: w(d) = (1-(d/R)^4)^2
  R_OPEN: 14, // m, zones with ZONE_INFO.open
  MOUNT_R_EXTRA: 8, // m, per-light R = min(R_MAX, max(zoneR, landmarkR, mountHeightAboveFloor + MOUNT_R_EXTRA))
  R_MAX: 20, // m, hard cap (lights must stay inside the 3x3-chunk neighbourhood + VisGrid halo)
  R_DYN: 9.5, // m, dynamic (flicker) lights; < TILE_SIZE/2 so channel ownership is unambiguous
  DYN_MAX_MOUNT: 6, // m above floor; higher fixtures are never dynamic (R_DYN would not reach the floor)
  MAX_DYN_PER_TILE: 1, // at most one FLICKER light per 16x16 tile (enforced by generation)
  CHANNELS: 4, // flicker channel = (globalTileX & 1) + 2 * (globalTileZ & 1)
  POLY_EXACT_FACTOR: 3, // exact clipped-polygon form factor when d < 3 * emitter long side, else point samples
  K_MAX: 16, // per receiver (texel / patch / LV sample): only the K strongest unoccluded lights are evaluated
  PROBE_RAY_MAX: 8, // m, probe rays are capped; misses use a tile-independent ambient term (WP7)
  HALO_CELLS: 24, // VisGrid halo around the tile (the 3x3 neighbourhood guarantees >= 32)
} as const;
export const PROBE_Y = { LOW: 0.4, TOP_BELOW_CEIL: 0.35 } as const; // probes at 0.4, mid, ceil-0.35 per cell
export const LV = { NX: 32, NY: 6, NZ: 32, STEP: 0.6, Y: [0.2, 0.8, 1.5, 2.3, 3.4, 5.0] } as const; // per-tile prop light volume
export const EMISSION = { RES: 88, TEXEL: 0.3, MARGIN: 3.6, FADE: 3.6 } as const; // floor-reflection emission map per tile
/** Light-region ids are stored in 11+1 bits (floor brAux, emission-map alpha). regionKey maps a region label
 * (0 = solid) to 1..REGION_MASK+1 (exact in half float); WP5, WP7 and WP9 compare keys, never raw labels. */
export const REGION_MASK = 2047;
export const regionKey = (r: number): number => (r === 0 ? 0 : ((r - 1) & REGION_MASK) + 1);

// ---------------------------------------------------------------- streaming / rendering
export const NOISE_WRAP = 1228.8; // m (32 chunks); world-space shader noise uses origin mod NOISE_WRAP
export const UPLOAD = { MAX_STEPS_PER_FRAME: 1, PREFETCH_STEPS_PER_FRAME: 1, FADE_IN_S: 0.5, DISPOSE_DELAY_FRAMES: 1 } as const;
export const EDGE_FOG = { START: 0.55, END: 0.8, LOOKAHEAD_S: 2 } as const; // x R = streamRadius*CHUNK_SIZE; desired-set centre = pos + vel*LOOKAHEAD_S
export const HDR_CLAMP = 32768; // every shader clamps outgoing radiance (nits) to this before writing RGBA16F
export const PHOTOMETRY = { EV100_L0: 9.4, EXPOSURE_CAL: 1.2 } as const; // exposure = 1 / (1.2 * 2^EV100)

// ---------------------------------------------------------------- audio
export const SPEED_OF_SOUND = 343;
```

### 4.4 `src/core/ids.ts`

```ts
// src/core/ids.ts — numeric id tables. `as const` objects + union types (no TS enums: erasableSyntaxOnly).
// Tables are APPEND-ONLY after WP0; never renumber (ids are baked into layouts, vertex data and golden hashes).

export type ValueOf<T> = T[keyof T];

// ---------------------------------------------------------------- storeys
export const Storey = { LOBBY: 0, SUBLEVEL: 1, POOLROOMS: 2 } as const;
export type StoreyId = ValueOf<typeof Storey>;

// ---------------------------------------------------------------- zones
export const Zone = {
  LOBBY: 0, MANILA: 1, DARK: 2, MAZE: 3, LOW_EXPANSE: 4, PILLAR_HALL: 5, OFFICE: 6, // WP2 (Level 0 family)
  POOLROOMS: 7, PARKING: 8, PIPEWORKS: 9, WAREHOUSE: 10, CONCRETE: 11, // WP3 (deep zones)
} as const;
export type ZoneId = ValueOf<typeof Zone>;
export const ZONE_COUNT = 12;
export const ZONE_NAMES: readonly string[] = [
  'LOBBY', 'MANILA', 'DARK', 'MAZE', 'LOW_EXPANSE', 'PILLAR_HALL', 'OFFICE',
  'POOLROOMS', 'PARKING', 'PIPEWORKS', 'WAREHOUSE', 'CONCRETE',
];

export const Mood = { NORMAL: 0, SPARSE: 1, DYING: 2, DARK: 3 } as const;
export type MoodId = ValueOf<typeof Mood>;
export const MOOD_NAMES: readonly string[] = ['NORMAL', 'SPARSE', 'DYING', 'DARK'];

export const SeamMode = { BOUNDARY: 0, PATTERN: 1, GLOBAL: 2 } as const;
export type SeamModeId = ValueOf<typeof SeamMode>;

// ---------------------------------------------------------------- cells / edges
export const CellFlag = {
  SOLID: 1, // full-height mass (floor..ceil)
  VOID: 2, // no floor (pit / shaft); falls
  NOWALK: 4, // walkable=false for connectivity (e.g. deep water edge), still has floor
  RESERVED: 8, // owned by a stamp (tower/elevator/landmark/artery/spawn); zone generators must not touch
  SEALED: 16, // unreachable pocket kept on purpose (heard, not entered)
  TOWER: 32,
  ELEVATOR: 64,
  ARTERY: 128,
  LANDMARK: 256,
  WET: 512, // puddle/film cell (footsteps CARPET_WET, reflective)
  NO_CEIL: 1024, // no rendered ceiling at ceilCm (dark void / truss above)
  SPAWN_OK: 2048, // candidate spawn cell (lit, open, not reserved) - set by WP1 labeling
} as const;

export const EdgeKind = {
  OPEN: 0, WALL: 1, DOORWAY: 2, HEADER: 3, ARCH: 4, PARTITION: 5, HALF: 6, RAIL: 7, WINDOW: 8, GLITCH: 9,
} as const;
export type EdgeKindId = ValueOf<typeof EdgeKind>;
// hA / hB meaning per kind (cm, storey-relative absolute heights):
//   DOORWAY hA=head (default DOOR_CM)  HEADER hA=underside  ARCH hA=crown  PARTITION/HALF/RAIL hA=top
//   WINDOW hA=sill hB=head            others: unused (0)

// THRESHOLD = threshold strip only. ROLLUP = METAL_PAINTED roll-up-door header box on the HEADER piece (WP5).
export const EdgeTrim = { BASEBOARD: 1, CASING: 2, WAINSCOT: 4, THRESHOLD: 8, EXIT_SIGN: 16, ROLLUP: 32 } as const;

export const CeilKind = { TILES: 0, CONCRETE: 1, BEAMS: 2, OPEN_DARK: 3, TILE_GLAZED: 4, TRUSS: 5 } as const;
export type CeilKindId = ValueOf<typeof CeilKind>;

// 4 ceiling tiles per cell, 4 bits each, tile index t = (tz*2 + tx), bits [4t, 4t+3] of layout.tiles[cell]
export const TileState = { NORMAL: 0, STAINED: 1, MISSING: 2, VENT: 3, FIXTURE: 4, SAGGING: 5, NEW: 6, DIRTY: 7 } as const;
export type TileStateId = ValueOf<typeof TileState>;

// ---------------------------------------------------------------- materials (= texture array layer ids)
export const Mat = {
  WALLPAPER_L0: 0, CARPET_L0: 1, CEILING_TILE: 2, PANEL_LENS: 3, TRIM_PAINT: 4, WALLPAPER_MANILA: 5,
  CARPET_OFFICE: 6, DRYWALL: 7, VINYL_VCT: 8, CONCRETE_FLOOR: 9, CONCRETE_WALL: 10, CONCRETE_CEIL: 11,
  CMU_PAINTED: 12, POOL_TILE: 13, POOL_MOSAIC: 14, METAL_PAINTED: 15, METAL_RUST: 16, METAL_GRATE: 17,
  WOOD: 18, PLASTIC: 19, FABRIC_PARTITION: 20, PLENUM: 21, RUBBER: 22, SIGNAGE: 23, DECAL_ATLAS: 24,
  FLOOR_PAINT: 25, TERRAZZO: 26, METAL_DECK: 27, // 27 was SPARE_27: corrugated roof deck (WAREHOUSE TRUSS ceilings)
  // texture realism v2 reserved layers (placeholder recipes; nothing places them in the world until their lanes do)
  CMU_RAW: 28, METAL_BARE: 29,
} as const;
export type MatId = ValueOf<typeof Mat>;
export const MAT_COUNT = 30;

// DECAL_ATLAS / SIGNAGE layers are 4x4 atlases; slot s occupies uv [(s%4)/4, floor(s/4)/4] .. +1/4
export const DecalKind = {
  WATER_STAIN: 0, MOLD: 1, FOOTPRINTS_WET: 2, SCUFF: 3, CRACK: 4, OIL: 5, RUST_STREAK: 6, DRAIN: 7,
  POSTER: 8, CHALK_ARROW: 9, HANDPRINT: 10, DRIP: 11, TALLY: 12, BURN: 13, PAPER: 14, PARKING_NUMBER: 15,
} as const;
export type DecalKindId = ValueOf<typeof DecalKind>;
/** DecalPlacement.kind value for a worn FLOOR_PAINT stripe (parking lines, safety lines): layer FLOOR_PAINT, w x h quad. */
export const DECAL_PAINT_STRIPE = 255;
export const SignKind = {
  EXIT: 0, EXIT_LEFT: 1, EXIT_RIGHT: 2, STAIRS: 3, B1: 4, B2: 5, L0: 6, WET_FLOOR: 7, NO_DIVING: 8,
  LEVEL_P1: 9, LEVEL_P2: 10, ELEVATOR: 11, AUTHORIZED: 12, FIRE: 13, ARROW_UP: 14, BLANK: 15,
} as const;

export const SurfaceSound = {
  CARPET: 0, CARPET_WET: 1, CONCRETE: 2, TILE: 3, METAL: 4, VINYL: 5, WOOD: 6, WATER_SHALLOW: 7,
  WATER_DEEP: 8, STAIR_CONCRETE: 9, GRATE: 10,
} as const;
export type SurfaceSoundId = ValueOf<typeof SurfaceSound>;
export const SURFACE_NAMES: readonly string[] = [
  'carpet', 'carpetWet', 'concrete', 'tile', 'metal', 'vinyl', 'wood', 'waterShallow', 'waterDeep', 'stairConcrete', 'grate',
];

// ---------------------------------------------------------------- lights
export const FixtureKind = {
  TROFFER_2x4: 0, TROFFER_2x2: 1, SKY_PANEL: 2, // recessed: shell geometry (WP5)
  TUBE_STRIP: 3, CAGE_BULB: 4, HIGHBAY: 5, PENDANT_LINEAR: 6, SODIUM: 7, EXIT_SIGN: 8, UNDERWATER: 9,
  VENDING: 10, RED_BULB: 11, // surface-mounted / hanging: prop library geometry (WP6)
} as const;
export type FixtureKindId = ValueOf<typeof FixtureKind>;
export const isRecessedFixture = (k: number): boolean => k <= 2;

export const LightState = { ON: 0, OFF: 1, FLICKER: 2, DYING: 3, BUZZ: 4, ANOMALY: 5 } as const;
export type LightStateId = ValueOf<typeof LightState>;
// ON: static. OFF: dead (grey lens, no light). FLICKER: the tile's single dynamic light (flicker channel).
// DYING: static at DYING_MEAN intensity with pink/green cast + lens shimmer. BUZZ: static on + shimmer + loud hum.
// ANOMALY: dynamic, driven by the director instead of flicker().
export const DYING_MEAN = 0.35;

export const EmitterShape = { RECT: 0, SPHERE: 1 } as const;

// ---------------------------------------------------------------- solids / structures / content
export const SolidFlag = { COLLIDE: 1, OCCLUDE: 2, WALKABLE_TOP: 4, RENDER: 8, NO_LM: 16, FILLED: 32, VIRTUAL: 64 } as const;
// VIRTUAL (collision boxes only): a keep-out box with no rendered surface (NOWALK column, pit catch floor, a
// collide-only solid); it collides, and WorldQuery.raycast looks through it.

export const StructureKind = { TOWER: 0, ELEVATOR: 1, SPAWN_ROOM: 2, PIT: 3, GLITCH: 4 } as const;
export type StructureKindId = ValueOf<typeof StructureKind>;

export const LandmarkKind = {
  RED_ROOM: 0, ENDLESS_HALL: 1, ATRIUM: 2, CHAIR_CATHEDRAL: 3, FLOODED_HALL: 4, LOCKED_EXIT: 5,
  VENDING_ALCOVE: 6, SERVER_ROOM: 7, DEEP_END: 8, SKYLIGHT_HALL: 9, LOCKER_ROOM: 10, LOADING_DOCK: 11, BOILER_HALL: 12,
} as const;
export type LandmarkKindId = ValueOf<typeof LandmarkKind>;
export const LANDMARK_COUNT = 13;
export const LANDMARK_NAMES: readonly string[] = [
  'RED_ROOM', 'ENDLESS_HALL', 'ATRIUM', 'CHAIR_CATHEDRAL', 'FLOODED_HALL', 'LOCKED_EXIT', 'VENDING_ALCOVE', 'SERVER_ROOM',
  'DEEP_END', 'SKYLIGHT_HALL', 'LOCKER_ROOM', 'LOADING_DOCK', 'BOILER_HALL',
];

export const VignetteKind = {
  CHAIR_FACING_WALL: 0, WET_FLOOR_SIGNS: 1, FALLEN_TILES: 2, LONE_DOORFRAME: 3, MATTRESS_CLOSET: 4,
  SPARKING_FIXTURE: 5, RADIO: 6, RINGING_PHONE: 7, BACKPACK_CAMP: 8,
  POOL_FLOAT: 9, OPEN_CAR: 10, COLLAPSED_RACK: 11, STEAM_LEAK: 12,
} as const;
export type VignetteKindId = ValueOf<typeof VignetteKind>;
export const VIGNETTE_NAMES: readonly string[] = [
  'CHAIR_FACING_WALL', 'WET_FLOOR_SIGNS', 'FALLEN_TILES', 'LONE_DOORFRAME', 'MATTRESS_CLOSET',
  'SPARKING_FIXTURE', 'RADIO', 'RINGING_PHONE', 'BACKPACK_CAMP', 'POOL_FLOAT', 'OPEN_CAR', 'COLLAPSED_RACK', 'STEAM_LEAK',
];

// SPARKING: WP11 director reads these sites (spark bursts). REPEATED_ROOM / CEILING_FURNITURE: layout-only visuals.
export const AnomalyKind = {
  LATE_ECHO: 0, ENDLESS_STAIRS: 1, GLITCH_WALL: 2, WRONG_ELEVATOR: 3, SPARKING: 4, REPEATED_ROOM: 5, CEILING_FURNITURE: 6,
} as const;
export type AnomalyKindId = ValueOf<typeof AnomalyKind>;

export const PropKind = {
  CHAIR_STACKING: 0, OFFICE_CHAIR: 1, DESK: 2, FILING_CABINET: 3, CRT_MONITOR: 4, WATER_COOLER: 5,
  VENDING_MACHINE: 6, CONFERENCE_TABLE: 7, CRATE: 8, PALLET: 9, SHELF_RACK: 10, TRASH_CAN: 11, CONE: 12,
  WET_FLOOR_SIGN: 13, WHEEL_STOP: 14, CAR_SEDAN: 15, POOL_LADDER: 16, LOUNGE_CHAIR: 17, LIFEBUOY: 18,
  BENCH_TILED: 19, MATTRESS: 20, PHONE: 21, RADIO: 22, BACKPACK: 23, DOOR_FRAME: 24, DOOR_LEAF: 25,
  ELEVATOR_DOOR: 26, VENT_GRILLE: 27, OUTLET: 28, THERMOSTAT: 29, EXTINGUISHER: 30, PIPE_VALVE: 31,
  BOILER: 32, TANK: 33, HANDRAIL: 34, CEILING_DEBRIS: 35, TILE_FRAGMENT: 36, BOTTLE: 37, SLEEPING_BAG: 38,
  BUCKET: 39, MOP: 40, CARDBOARD_BOX: 41, FLOAT_ROPE: 42, POOL_FLOAT: 43, TOWEL: 44,
} as const;
export type PropKindId = ValueOf<typeof PropKind>;
export const PROP_KIND_COUNT = 45;
/** PropPlacement.flags bits above the SolidFlag overrides. CEILING: mounted upside down, base at y (ceiling). */
export const PropFlag = { CEILING: 256 } as const;

export const EmitterKind = { DRIP: 0, VENT: 1, PIPE: 2, MACHINE: 3, WATER: 4, STEAM: 5, RADIO: 6, PHONE: 7, BUZZ: 8 } as const;
export type EmitterKindId = ValueOf<typeof EmitterKind>;

// ---------------------------------------------------------------- vertex flags (brFlags, u8)
// brAux byte usage (u8x4). A vertex has at most one of FLOOR_AUX / PROP_AUX. DYN_EMIT|SHIMMER vertices always
// store aux.w = LightState and tint.a = fixture.seed & 255 (overrides any other use of aux.w; those faces
// skip emission-map reflections). UNDERWATER vertices store aux.w = clamp((waterCm + 320) / 5, 0, 255).
export const VFlag = {
  DYN_EMIT: 1, // emissive driven by the tile's own flicker channel intensity (uFlick[0])
  SHIMMER: 2, // DYING/BUZZ lens shimmer (emissive only; state from aux.w, 8-bit seed from tint.a)
  NO_GRIME: 4,
  UNDERWATER: 8, // submerged surface: per-channel absorption along the view path + caustics (aux.w = water height)
  REFLECTIVE: 16, // eligible for floor-emission / planar reflection
  DECAL: 32, // shell/props variant: alpha-tested against albedo.a (grates, sign faces); decal variant: soft alpha
  FLOOR_AUX: 64, // brAux = (reflPlaneHeightAboveFloor/5cm, regionKey & 255, regionKey >> 8, water byte or 0)
  PROP_AUX: 128, // brAux = (0, 0, bits: 1 = tower-periodic (wrap y for LV lookup), ceilCm/5 of the anchor cell)
} as const;

// ---------------------------------------------------------------- debug views (int uniform; no recompiles)
// 16-23 belong to the graphics-realism packages (black until their package lands), 24-26 to texture realism v2; the
// materials harness's private anti-tiling rotation view is index 63
export const DebugView = {
  FINAL: 0, ALBEDO: 1, NORMAL: 2, ROUGHNESS: 3, LIGHTMAP: 4, DIRECTIONALITY: 5, AO: 6, FLICKER: 7,
  MASK: 8, LAYER: 9, TEXEL: 10, ZONE: 11, ROOM: 12, UV: 13, EMISSION: 14, LIGHT_VOLUME: 15,
  WETNESS: 16, HEIGHT: 17, VOLUMETRIC: 18, BOUNCE: 19, WATER: 20, PROBE: 21, SPECW: 22, SSAO: 23,
  AUX: 24, TEXTILE: 25, RELIEF: 26,
} as const;
export type DebugViewId = ValueOf<typeof DebugView>;
export const DEBUG_VIEW_NAMES: readonly string[] = [
  'final', 'albedo', 'normal', 'roughness', 'lightmap', 'directionality', 'ao', 'flicker', 'mask', 'layer',
  'texel', 'zone', 'room', 'uv', 'emission', 'lv', 'wetness', 'height', 'volumetric', 'bounce', 'water', 'probe',
  'specw', 'ssao', 'aux', 'textile', 'relief',
];
```

### 4.5 `src/core/grid.ts`

```ts
// src/core/grid.ts — coordinate conventions, keys and index helpers. Pure, no allocation in hot helpers.
//
// Axes: right-handed, +Y up, +X east, -Z north. Camera Euler order 'YXZ'; yaw 0 looks along -Z;
// positive yaw turns LEFT (counter-clockwise seen from above); positive pitch looks up. Radians everywhere.
// Global cell (gi, gj) covers x in [gi*CELL, (gi+1)*CELL), z in [gj*CELL, (gj+1)*CELL).
// Chunk cx = floorDiv(gi, 32); local li = gi - 32*cx. Tile (quadrant) q = qx + 2*qz with qx = li >> 4.
// Cell arrays: index lj*32 + li.
// x-edges ("ex", on lines x = i*CELL, separating cells (i-1, lj) | (i, lj)): index lj*33 + i, i in 0..32.
// z-edges ("ez", on lines z = j*CELL, separating cells (li, j-1) | (li, j)): index j*32 + li, j in 0..32.
// A chunk stores BOTH border lines; border values come from the shared pure seam function so neighbours agree.
// Layout positions (fixtures, solids, props, ...) are CHUNK-LOCAL metres (x,z in [0,38.4)), y storey-relative.
// Mesh vertex positions are TILE-LOCAL metres; mesh.position = tile origin (float64 on CPU => precise).

import { CELL, CHUNK_CELLS, CHUNK_SIZE, TILE_CELLS, TILE_SIZE } from './constants.ts';
import type { StoreyId } from './ids.ts';

export type Vec3 = [number, number, number];

export interface ChunkKey { readonly s: StoreyId; readonly cx: number; readonly cz: number }
export interface TileKey { readonly s: StoreyId; readonly cx: number; readonly cz: number; readonly q: 0 | 1 | 2 | 3 }

export const chunkKeyStr = (k: ChunkKey): string => `${k.s}:${k.cx}:${k.cz}`;
export const tileKeyStr = (k: TileKey): string => `${k.s}:${k.cx}:${k.cz}:${k.q}`;
export function parseChunkKey(str: string): ChunkKey {
  const [s, cx, cz] = str.split(':').map(Number);
  return { s: s as StoreyId, cx, cz };
}
export function parseTileKey(str: string): TileKey {
  const [s, cx, cz, q] = str.split(':').map(Number);
  return { s: s as StoreyId, cx, cz, q: q as 0 | 1 | 2 | 3 };
}
export const tileChunk = (t: TileKey): ChunkKey => ({ s: t.s, cx: t.cx, cz: t.cz });
export const tileQx = (q: number): number => q & 1;
export const tileQz = (q: number): number => q >> 1;
/** Global tile coordinates (used for flicker channel parity). */
export const globalTileX = (t: TileKey): number => t.cx * 2 + (t.q & 1);
export const globalTileZ = (t: TileKey): number => t.cz * 2 + (t.q >> 1);
/** Flicker channel owned by the dynamic light of a tile: (gtx & 1) + 2 * (gtz & 1). */
export const tileChannel = (t: TileKey): number => (globalTileX(t) & 1) + 2 * (globalTileZ(t) & 1);

export const floorDiv = (a: number, b: number): number => Math.floor(a / b);
export const mod = (a: number, b: number): number => ((a % b) + b) % b;
export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
/** Polynomial smoothstep (allowed in layout decisions: no transcendental functions). */
export const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

/** World metres -> global cell. The 1e-7 guards 1.2 not being exactly representable. THE ONLY rounding of
 * metres to the grid: chunk, local cell and tile are all derived from it (never from metres directly). */
export const worldToCell = (m: number): number => Math.floor(m / CELL + 1e-7);
export const cellToChunk = (g: number): number => Math.floor(g / CHUNK_CELLS);
export const worldToChunk = (m: number): number => cellToChunk(worldToCell(m));
export const chunkOriginX = (cx: number): number => cx * CHUNK_SIZE;
export const chunkOriginZ = (cz: number): number => cz * CHUNK_SIZE;
export const tileOriginX = (t: TileKey): number => t.cx * CHUNK_SIZE + (t.q & 1) * TILE_SIZE;
export const tileOriginZ = (t: TileKey): number => t.cz * CHUNK_SIZE + (t.q >> 1) * TILE_SIZE;
/** First local cell (li0, lj0) of tile q inside its chunk. */
export const tileCell0 = (q: number): [number, number] => [(q & 1) * TILE_CELLS, (q >> 1) * TILE_CELLS];
export const tileOfLocalCell = (li: number, lj: number): 0 | 1 | 2 | 3 =>
  (((li >> 4) & 1) | (((lj >> 4) & 1) << 1)) as 0 | 1 | 2 | 3;

export const cellIdx = (li: number, lj: number): number => lj * 32 + li;
export const exIdx = (i: number, lj: number): number => lj * 33 + i;
export const ezIdx = (li: number, j: number): number => j * 32 + li;

export function chunkKeyAt(s: StoreyId, x: number, z: number): ChunkKey {
  return { s, cx: worldToChunk(x), cz: worldToChunk(z) };
}
export function tileKeyAt(s: StoreyId, x: number, z: number): TileKey {
  const gi = worldToCell(x), gj = worldToCell(z);
  const cx = cellToChunk(gi), cz = cellToChunk(gj);
  return { s, cx, cz, q: tileOfLocalCell(gi - cx * CHUNK_CELLS, gj - cz * CHUNK_CELLS) };
}
/** Tile containing a CHUNK-LOCAL point (metres). WP4 (dynamic pick), WP5 (dynLights slots, fixture geometry
 * owner) and WP7 (flicker channel) all use this for "the tile containing the light" (fixture centre). */
export const tileOfPoint = (x: number, z: number): 0 | 1 | 2 | 3 =>
  tileOfLocalCell(clamp(worldToCell(x), 0, CHUNK_CELLS - 1), clamp(worldToCell(z), 0, CHUNK_CELLS - 1));

/** Rotated rectangular footprints (towers, elevators). Local frame: u across (0..W-1), v along (0..L-1).
 * rot 0: u->+x, v->+z   rot 1: u->+z, v->-x   rot 2: u->-x, v->-z   rot 3: u->-z, v->+x  (all proper rotations).
 * (i0, j0) is the MIN corner of the axis-aligned rotated footprint: W x L cells for rot 0/2, L x W for rot 1/3. */
export function footprintRect(i0: number, j0: number, W: number, L: number, rot: 0 | 1 | 2 | 3): [number, number, number, number] {
  return (rot & 1) === 0 ? [i0, j0, i0 + W, j0 + L] : [i0, j0, i0 + L, j0 + W]; // half-open [i0,i1) x [j0,j1)
}
/** Footprint cell (u, v) -> local cell (li, lj). */
export function footprintCell(i0: number, j0: number, W: number, L: number, rot: 0 | 1 | 2 | 3, u: number, v: number): [number, number] {
  switch (rot) {
    case 0: return [i0 + u, j0 + v];
    case 1: return [i0 + (L - 1 - v), j0 + u];
    case 2: return [i0 + (W - 1 - u), j0 + (L - 1 - v)];
    default: return [i0 + v, j0 + (W - 1 - u)];
  }
}
/** Footprint-local metres (um in [0, W*CELL], vm in [0, L*CELL]) -> chunk-local metres [x, z]. Consistent with footprintCell. */
export function footprintPoint(i0: number, j0: number, W: number, L: number, rot: 0 | 1 | 2 | 3, um: number, vm: number): [number, number] {
  const x0 = i0 * CELL, z0 = j0 * CELL;
  switch (rot) {
    case 0: return [x0 + um, z0 + vm];
    case 1: return [x0 + L * CELL - vm, z0 + um];
    case 2: return [x0 + W * CELL - um, z0 + L * CELL - vm];
    default: return [x0 + vm, z0 + W * CELL - um];
  }
}
/** Unit forward vector for yaw (pitch ignored): yaw 0 -> (0,0,-1); yaw +PI/2 -> (-1,0,0). */
export function forwardXZ(yaw: number, out: { x: number; z: number }): void {
  out.x = -Math.sin(yaw);
  out.z = -Math.cos(yaw);
}
export const chebyshev = (ax: number, az: number, bx: number, bz: number): number =>
  Math.max(Math.abs(ax - bx), Math.abs(az - bz));
```

### 4.6 `src/core/rng.ts`

```ts
// src/core/rng.ts — deterministic hashing and RNG. Math.random / Date are BANNED in pure modules
// (core, world, mesh, bake, props, lighting/flicker, player/controller, audio/dsp). Enforced by tests/arch.
// Layout DECISIONS must use only + - * / floor imul sqrt and these helpers (no sin/cos/exp/pow/log).

import { GEN_VERSION } from './constants.ts';

/** One salt per subsystem so adding draws in one subsystem never reshuffles another. Append-only. */
export const SALT = {
  DISTRICT: 1, DISTRICT_ZONE: 2, DISTRICT_PARAMS: 3, MOOD: 4, FIELD_POWER: 5, FIELD_DECAY: 6, FIELD_HUMIDITY: 7,
  FIELD_WARMTH: 8, WARP: 9, SEAM: 10, CHUNK: 11, ZONE_LAYOUT: 12, FIXTURE: 13, FIXTURE_STATE: 14, PROP: 15,
  VIGNETTE: 16, LANDMARK: 17, TOWER: 18, ELEVATOR: 19, ARTERY: 20, LEAK: 21, DECAL: 22, ANOMALY: 23,
  SPAWN: 24, EMITTER: 25, CONNECT: 26, TILE_STATE: 27, FLICKER: 28, AUDIO: 29, BAKE: 30, TEXGEN: 31,
  ONBOARDING: 32, EXIT_SIGN: 33, CHALK: 34, GLOBAL_FEATURE: 35,
} as const;

/** lowbias32 finalizer (Chris Wellons). Returns uint32. */
export function mix32(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return h >>> 0;
}
const step = (h: number, v: number): number => mix32((h ^ Math.imul(v | 0, 0x9e3779b1)) + 0x632be5ab);

/** Hash of up to 6 int32 values, fixed-arity fast paths (no rest-array allocation). */
export const hash1 = (a: number): number => step(0x2545f491 ^ GEN_VERSION, a);
export const hash2 = (a: number, b: number): number => step(hash1(a), b);
export const hash3 = (a: number, b: number, c: number): number => step(hash2(a, b), c);
export const hash4 = (a: number, b: number, c: number, d: number): number => step(hash3(a, b, c), d);
export const hash5 = (a: number, b: number, c: number, d: number, e: number): number => step(hash4(a, b, c, d), e);
export const hash6 = (a: number, b: number, c: number, d: number, e: number, f: number): number =>
  step(hash5(a, b, c, d, e), f);
/** Variadic hash (allocates; not for inner loops). hashN(a,b,c) === hash3(a,b,c). */
export function hashN(...xs: number[]): number {
  let h = 0x2545f491 ^ GEN_VERSION;
  for (let i = 0; i < xs.length; i++) h = step(h, xs[i]);
  return h;
}
/** uint32 -> [0,1) using the top 24 bits (exact in float64). */
export const hash01 = (h: number): number => (h >>> 8) / 16777216;

/** FNV-1a over UTF-16 code units, then mixed. Seed strings made only of digits are parsed as uint32. */
export function hashString(s: string): number {
  if (/^\d{1,9}$/.test(s)) return Number(s) >>> 0;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return mix32(h);
}

/** sfc32 generator. Deterministic across Node and browsers. */
export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;
  constructor(seed: number) {
    this.a = mix32(seed ^ 0xa341316c);
    this.b = mix32(seed ^ 0xc8013ea4);
    this.c = mix32(seed ^ 0xad90777d);
    this.d = mix32(seed ^ 0x7e95761e) | 1;
    for (let i = 0; i < 12; i++) this.next();
  }
  /** uint32 */
  next(): number {
    const t = (((this.a + this.b) | 0) + this.d) | 0;
    this.d = (this.d + 1) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.c = (this.c + t) | 0;
    return t >>> 0;
  }
  /** [0,1) */
  float(): number { return this.next() / 4294967296; }
  /** [lo,hi) float */
  range(lo: number, hi: number): number { return lo + (hi - lo) * this.float(); }
  /** integer in [lo, hi] inclusive */
  int(lo: number, hi: number): number { return lo + Math.floor(this.float() * (hi - lo + 1)); }
  chance(p: number): boolean { return this.float() < p; }
  pick<T>(arr: readonly T[]): T { return arr[Math.floor(this.float() * arr.length)]; }
  /** index chosen with probability proportional to weights[i] (weights >= 0, sum > 0) */
  weighted(weights: readonly number[]): number {
    let sum = 0;
    for (let i = 0; i < weights.length; i++) sum += weights[i];
    let r = this.float() * sum;
    for (let i = 0; i < weights.length; i++) {
      r -= weights[i];
      if (r < 0) return i;
    }
    return weights.length - 1;
  }
  /** in-place Fisher-Yates */
  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.float() * (i + 1));
      const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }
  /** independent child stream; does not advance this stream */
  fork(tag: number): Rng { return new Rng(hash2(this.a ^ this.c, tag)); }
}

/** Rng seeded from a salt and integer coordinates: rngFor(seed, SALT.X, s, cx, cz). */
export function rngFor(seed: number, salt: number, a = 0, b = 0, c = 0, d = 0): Rng {
  return new Rng(hash6(seed, salt, a, b, c, d));
}
```

### 4.7 `src/core/noise.ts`

```ts
// src/core/noise.ts — deterministic CPU noise (value noise on an integer lattice, polynomial fade only).
// Safe for layout decisions (no transcendental functions). GLSL counterparts live in WP8 (textures/glsl/noise.ts).

import { hash3, hash01 } from './rng.ts';

const fade = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10);

/** Value noise in [0,1). Lattice spacing 1 unit. */
export function valueNoise2(seed: number, x: number, z: number): number {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const u = fade(fx), v = fade(fz);
  const a = hash01(hash3(seed, ix, iz));
  const b = hash01(hash3(seed, ix + 1, iz));
  const c = hash01(hash3(seed, ix, iz + 1));
  const d = hash01(hash3(seed, ix + 1, iz + 1));
  const ab = a + (b - a) * u;
  const cd = c + (d - c) * u;
  return ab + (cd - ab) * v;
}

/** Periodic value noise: lattice wraps every `period` units (period integer >= 1). */
export function valueNoise2P(seed: number, x: number, z: number, period: number): number {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const u = fade(fx), v = fade(fz);
  const x0 = ((ix % period) + period) % period, z0 = ((iz % period) + period) % period;
  const x1 = (x0 + 1) % period, z1 = (z0 + 1) % period;
  const a = hash01(hash3(seed, x0, z0));
  const b = hash01(hash3(seed, x1, z0));
  const c = hash01(hash3(seed, x0, z1));
  const d = hash01(hash3(seed, x1, z1));
  const ab = a + (b - a) * u;
  const cd = c + (d - c) * u;
  return ab + (cd - ab) * v;
}

/** Fractal sum normalised to [0,1). lacunarity 2, gain 0.5; octave k uses seed + k*1013. */
export function fbm2(seed: number, x: number, z: number, octaves: number): number {
  let sum = 0, amp = 0.5, norm = 0, f = 1;
  for (let k = 0; k < octaves; k++) {
    sum += amp * valueNoise2(seed + k * 1013, x * f, z * f);
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return sum / norm;
}

/** Contrast curve used by fields: remaps [0,1) around 0.5 with polynomial smoothstep applied `n` times. */
export function contrast(v: number, n: number): number {
  for (let i = 0; i < n; i++) v = v * v * (3 - 2 * v);
  return v;
}
```

### 4.8 `src/core/half.ts`

```ts
// src/core/half.ts — float32 <-> float16 (IEEE binary16) conversion for RGBA16F payloads built in workers.
// Table-based (same algorithm as three's DataUtils), no allocation per call.

const buf = new ArrayBuffer(4);
const f32 = new Float32Array(buf);
const u32 = new Uint32Array(buf);
const baseTable = new Uint32Array(512);
const shiftTable = new Uint32Array(512);
for (let i = 0; i < 256; ++i) {
  const e = i - 127;
  if (e < -27) {
    baseTable[i] = 0x0000; baseTable[i | 0x100] = 0x8000;
    shiftTable[i] = 24; shiftTable[i | 0x100] = 24;
  } else if (e < -14) {
    baseTable[i] = 0x0400 >> (-e - 14); baseTable[i | 0x100] = (0x0400 >> (-e - 14)) | 0x8000;
    shiftTable[i] = -e - 1; shiftTable[i | 0x100] = -e - 1;
  } else if (e <= 15) {
    baseTable[i] = (e + 15) << 10; baseTable[i | 0x100] = ((e + 15) << 10) | 0x8000;
    shiftTable[i] = 13; shiftTable[i | 0x100] = 13;
  } else if (e < 128) {
    baseTable[i] = 0x7c00; baseTable[i | 0x100] = 0xfc00;
    shiftTable[i] = 24; shiftTable[i | 0x100] = 24;
  } else {
    baseTable[i] = 0x7c00; baseTable[i | 0x100] = 0xfc00;
    shiftTable[i] = 13; shiftTable[i | 0x100] = 13;
  }
}

/** float -> half bits (values above 65504 become +Inf; callers clamp to HALF_MAX first). */
export function toHalf(v: number): number {
  f32[0] = v;
  const f = u32[0];
  const e = (f >> 23) & 0x1ff;
  return baseTable[e] + ((f & 0x007fffff) >> shiftTable[e]);
}

export function fromHalf(h: number): number {
  const s = (h & 0x8000) >> 15;
  const e = (h & 0x7c00) >> 10;
  const m = h & 0x03ff;
  if (e === 0) return (s ? -1 : 1) * 5.960464477539063e-8 * m;
  if (e === 0x1f) return m ? NaN : (s ? -Infinity : Infinity);
  return (s ? -1 : 1) * 2 ** (e - 15) * (1 + m / 1024);
}

export const HALF_MAX = 65504;
```

### 4.9 `src/core/edges.ts`

The single definition of edge semantics. The mesher, collision, baker and audio must all use it.

```ts
// src/core/edges.ts — THE single definition of what each edge kind is, used identically by the mesher (WP5),
// collision (WP12), light-bake visibility (WP7) and audio propagation (WP13). If these disagree, light leaks.
// t = metres along the edge from its start (0..CELL) (start = min x for ez edges, min z for ex edges).
// y = metres, storey-relative. hA/hB in centimetres (see EdgeKind comment in ids.ts).

import { ARCH_JAMB, CELL, DOOR_W, PARTITION_BASE_T, PARTITION_T, WALL_T } from './constants.ts';
import { EdgeKind } from './ids.ts';

//                                   OPEN   WALL   DOORWAY HEADER ARCH   PARTIT HALF   RAIL   WINDOW GLITCH
export const EDGE_RENDERS: readonly boolean[] = [false, true, true, true, true, true, true, true, true, true];
// GLITCH collides like a WALL; the noclip transition is a StructureKind.GLITCH portal in front of it (WP4/WP12).
export const EDGE_COLLIDES: readonly boolean[] = [false, true, true, true, true, true, true, true, true, true];
export const EDGE_OCCLUDES: readonly boolean[] = [false, true, true, true, true, true, true, false, true, true];
/** walkable for connectivity/pathing (a GLITCH edge is a secret: not counted). HEADER is passable if hA >= 190. */
export const EDGE_WALKABLE: readonly boolean[] = [true, false, true, true, true, false, false, false, false, false];
/** amplitude transmission for audio propagation (0 = blocks; wall transmission handled separately). */
export const EDGE_SOUND: readonly number[] = [1, 0, 0.9, 1, 1, 0.7, 0.6, 1, 0.8, 0];

export const edgeThickness = (kind: number): number =>
  kind === EdgeKind.OPEN ? 0 : kind === EdgeKind.PARTITION ? PARTITION_T : WALL_T;
/** Thickness at floor level (y < PARTITION_BASE_CM above the higher floor): PARTITION panels stand on a
 * PARTITION_BASE_T plinth that WP5 always emits. The no-leak invariant is stated on this value:
 * EDGE_OCCLUDES[k] => edgeBaseThickness(k) >= lmTexel(tpc) for every tpc (tests/core/invariants.test.ts).
 * Collision and bake visibility use edgeThickness (the plinth is below stepMax and inside the sample clamp). */
export const edgeBaseThickness = (kind: number): number =>
  kind === EdgeKind.PARTITION ? PARTITION_BASE_T : edgeThickness(kind);

/**
 * Solid pieces of an edge as axis-aligned rectangles in the edge plane: (t0,t1,y0,y1) quadruples written to
 * `out` (length >= 16). yLo = MIN floor, ySill = MAX floor, yHi = MAX ceiling of the two adjacent cells (metres).
 * Openings (DOORWAY/HEADER/ARCH/WINDOW) start at ySill: a full-width sill piece [yLo, ySill] closes the part
 * below the higher floor (this also seals the stacked vestibule copies of stair towers).
 * Returns the number of pieces. ARCH returns jambs + the block above the crown; its curved spandrel is
 * described exactly by edgeSolidAt (the mesher emits the curve; collision ignores it: it is above head height).
 */
export function edgePieces(kind: number, hA: number, hB: number, yLo: number, ySill: number, yHi: number, out: Float32Array): number {
  const a = hA / 100, b = hB / 100;
  const j = (CELL - DOOR_W) / 2;
  let n = 0;
  const put = (t0: number, t1: number, y0: number, y1: number): void => {
    if (y1 <= y0 || t1 <= t0) return;
    out[n * 4] = t0; out[n * 4 + 1] = t1; out[n * 4 + 2] = y0; out[n * 4 + 3] = y1; n++;
  };
  switch (kind) {
    case EdgeKind.WALL: case EdgeKind.GLITCH: put(0, CELL, yLo, yHi); break;
    case EdgeKind.DOORWAY: put(0, j, yLo, yHi); put(CELL - j, CELL, yLo, yHi); put(j, CELL - j, a, yHi); put(j, CELL - j, yLo, ySill); break;
    case EdgeKind.HEADER: put(0, CELL, a, yHi); put(0, CELL, yLo, ySill); break;
    case EdgeKind.ARCH: put(0, ARCH_JAMB, yLo, yHi); put(CELL - ARCH_JAMB, CELL, yLo, yHi); put(ARCH_JAMB, CELL - ARCH_JAMB, a, yHi); put(ARCH_JAMB, CELL - ARCH_JAMB, yLo, ySill); break;
    case EdgeKind.PARTITION: case EdgeKind.HALF: case EdgeKind.RAIL: put(0, CELL, yLo, a); break;
    case EdgeKind.WINDOW: put(0, CELL, yLo, Math.max(a, ySill)); put(0, CELL, b, yHi); break;
    default: break;
  }
  return n;
}

/** Point-in-solid test in the edge plane (used by light/sound visibility). Ignores EDGE_OCCLUDES.
 * ySill = MAX floor of the two adjacent cells (openings are solid below it); pass -Infinity if unknown. */
export function edgeSolidAt(kind: number, hA: number, hB: number, t: number, y: number, ySill = -Infinity): boolean {
  const a = hA / 100;
  if (y < ySill && (kind === EdgeKind.DOORWAY || kind === EdgeKind.HEADER || kind === EdgeKind.ARCH || kind === EdgeKind.WINDOW)) return true;
  switch (kind) {
    case EdgeKind.OPEN: return false;
    case EdgeKind.WALL: case EdgeKind.GLITCH: return true;
    case EdgeKind.DOORWAY: return Math.abs(t - CELL / 2) >= DOOR_W / 2 || y >= a;
    case EdgeKind.HEADER: return y >= a;
    case EdgeKind.ARCH: {
      const half = CELL / 2 - ARCH_JAMB; // opening half-width (radius of the round top)
      const dx = Math.abs(t - CELL / 2);
      if (dx >= half) return true;
      const spring = a - half;
      if (y <= spring) return false;
      const dy = y - spring;
      return dx * dx + dy * dy >= half * half;
    }
    case EdgeKind.PARTITION: case EdgeKind.HALF: case EdgeKind.RAIL: return y < a;
    case EdgeKind.WINDOW: return y < a || y >= hB / 100;
    default: return false;
  }
}

/** Light occlusion at a crossing point: EDGE_OCCLUDES[kind] && edgeSolidAt(...). */
export const edgeOccludesAt = (kind: number, hA: number, hB: number, t: number, y: number, ySill = -Infinity): boolean =>
  EDGE_OCCLUDES[kind] && edgeSolidAt(kind, hA, hB, t, y, ySill);

/** Default hA/hB for a kind (cm). */
export function edgeDefaults(kind: number): [number, number] {
  switch (kind) {
    case EdgeKind.DOORWAY: return [210, 0];
    case EdgeKind.HEADER: return [220, 0];
    case EdgeKind.ARCH: return [260, 0];
    case EdgeKind.PARTITION: return [150, 0];
    case EdgeKind.HALF: return [105, 0];
    case EdgeKind.RAIL: return [100, 0];
    case EdgeKind.WINDOW: return [95, 200];
    default: return [0, 0];
  }
}
```

### 4.10 `src/core/layout.ts`

```ts
// src/core/layout.ts — the world data model produced by generation (WP1-4) and consumed by mesher (WP5),
// baker (WP7), collision (WP12), audio (WP13), streaming/queries (WP10) and debug tools (WP14).
// All positions are CHUNK-LOCAL metres (x,z in [0, CHUNK_SIZE)), y storey-relative metres.
// Heights in the per-cell/per-edge arrays are integer centimetres.

import { CHUNK_CELL_COUNT, EDGE_COUNT, GEN_VERSION } from './constants.ts';
import type { ChunkKey, Vec3 } from './grid.ts';
import { hash2, hash3, hash5, SALT } from './rng.ts';
import type {
  AnomalyKindId, EmitterKindId, FixtureKindId, LandmarkKindId, LightStateId, MatId, MoodId, PropKindId,
  StructureKindId, VignetteKindId, ZoneId,
} from './ids.ts';

/** Edge data for one axis (EDGE_COUNT entries; see core/grid.ts for indexing). */
export interface EdgeGrid {
  kind: Uint8Array; // EdgeKind
  hA: Int16Array; // cm, meaning per kind (ids.ts)
  hB: Int16Array; // cm
  matNeg: Uint8Array; // MatId of the face looking toward -axis (the face in cell i-1 / j-1)
  matPos: Uint8Array; // MatId of the face looking toward +axis
  trim: Uint8Array; // EdgeTrim bits
}

/** Rectangular or spherical emitter. RECT: one-sided Lambertian of `luminance` nits on a w x h rectangle
 * centred at p, normal n, long axis t (w along t, h along n x t). SPHERE: isotropic, `luminance` = intensity cd,
 * radius w/2 (HIGHBAY: downward disk of radius w/2, same intensity semantics).
 * RGB radiance of the emitting surface = fixtureRadiance(f) * color (color has max component 1); every consumer
 * (WP5/WP6 lens emit, WP7 bake + emission map) uses exactly this. Flicker `flick` stores luma(E_rgb) with Rec.709
 * weights; WP11 writes color/luma(color) * i, which reproduces E_rgb exactly.
 * Recessed RECT fixtures never straddle a render-tile line (validateLayout); "the tile containing the light" is
 * always tileOfPoint(px, pz). */
export interface Fixture {
  id: number; // fixtureId(...) for lattice/custom fixtures; structureFixtureId(...) for tower/elevator (storey-free). Unique per chunk (validated)
  kind: FixtureKindId;
  state: LightStateId;
  shape: 0 | 1; // EmitterShape
  px: number; py: number; pz: number;
  nx: number; ny: number; nz: number;
  tx: number; ty: number; tz: number;
  w: number; h: number;
  color: Vec3; // linear RGB, max component 1
  luminance: number;
  seed: number; // flicker/shimmer phase seed
  hum: number; // 0..1 audio loudness weight
  bakeGroup: number; // 0 = storey; towerId for tower-internal fixtures
  dynamic: boolean; // true only for the (<=1 per tile) FLICKER/ANOMALY light that owns its tile's channel
}

export type Solid =
  | { kind: 'box'; id: number; min: Vec3; max: Vec3; mat: MatId; flags: number; bakeGroup: number }
  | {
      kind: 'ramp'; id: number; x0: number; z0: number; x1: number; z1: number; // footprint (chunk-local m)
      y0: number; y1: number; // height at the low end / high end
      dir: 0 | 1 | 2 | 3; // ascent direction: 0 +x, 1 -x, 2 +z, 3 -z
      steps: number; // visual risers (0 = smooth ramp)
      mat: MatId; flags: number; bakeGroup: number;
    }
  | { kind: 'pipe'; id: number; a: Vec3; b: Vec3; r: number; mat: MatId; flags: number };

export interface PropPlacement {
  kind: PropKindId; variant: number; x: number; y: number; z: number; yaw: number; scale: number;
  flags: number; // SolidFlag.COLLIDE / OCCLUDE override bits (default from PROP_DEFS) | PropFlag bits (ids.ts)
  seed: number;
}

/** Decal quad. Atlas convention (WP8 draws, WP5 maps): a slot's "up" is +v and every arrow glyph points +v;
 * EXIT_LEFT/RIGHT are left/right when viewed with +v up.
 * rot: floor/ceiling decals (|ny| > 0.9): a yaw in the camera convention, +v points along forwardXZ(rot)
 *      (rot 0 => +v points -Z; positive rot turns counter-clockwise seen from above).
 *      wall decals: rot 0 => +v = +Y; positive rot turns the quad counter-clockwise as seen looking AGAINST the
 *      normal (i.e. by a viewer in front of the wall). Tested by WP5 (tests/mesh/decals.test.ts). */
export interface DecalPlacement {
  kind: number; // DecalKind (atlas slot) or SignKind when sign=true
  sign: boolean; // true: SIGNAGE layer, false: DECAL_ATLAS
  px: number; py: number; pz: number; nx: number; ny: number; nz: number;
  rot: number; w: number; h: number; alpha: number;
  emit?: number; // optional emissive luminance (nits) for the decal's emissive mask (LEDs, glowing signs)
  color?: Vec3; // optional linear tint (emissive colour when emit > 0); default white
}

export interface WaterRect { x0: number; z0: number; x1: number; z1: number; y: number; floorY: number; kind: 0 | 1 | 2 } // pool | flooded | film

export interface PortalSpec {
  kind: 'tower' | 'elevator' | 'pit' | 'glitch';
  min: Vec3; max: Vec3; // trigger volume (chunk-local)
  towerId: number; // tower/elevator id (bakeGroup for towers), 0 otherwise
  endless: boolean; // ENDLESS_STAIRS anomaly: switches y but not storey
  wrong?: boolean; // elevator with a WRONG_ELEVATOR site: the ride goes to (s+2)%3 instead of (s+1)%3
}

export interface StructureInstance {
  id: number; kind: StructureKindId;
  bakeGroup: number; // TOWER/ELEVATOR: nonzero isolated bake group (== portal.towerId); others 0
  i0: number; j0: number; i1: number; j1: number; // local cell rect, half-open
  rot: 0 | 1 | 2 | 3;
  portal: PortalSpec | null;
}

/** A passable opening on a chunk seam; side 'W' = line i=0, 'N' = line j=0, 'E' = i=32, 'S' = j=32. */
export interface Port { side: 'W' | 'N' | 'E' | 'S'; from: number; to: number } // cell range [from,to)

export interface Leak { x: number; y: number; z: number; strength: number } // ceiling leak source (drives stains)
export interface AudioEmitterSpec { kind: EmitterKindId; x: number; y: number; z: number; gain: number; seed: number }
export interface VignetteInstance { kind: VignetteKindId; x: number; z: number; yaw: number; seed: number }
export interface LandmarkInstance { kind: LandmarkKindId; i0: number; j0: number; i1: number; j1: number }
export interface AnomalySite { kind: AnomalyKindId; x: number; z: number; r: number; seed: number }

export interface ChunkLayout {
  key: ChunkKey;
  genVersion: number;
  zone: ZoneId;
  districtId: number;
  mood: MoodId;
  // ---- per cell (CHUNK_CELL_COUNT, index lj*32+li)
  flags: Uint16Array; // CellFlag bits
  floorCm: Int16Array;
  ceilCm: Int16Array;
  waterCm: Int16Array; // water surface, NO_WATER if none
  blockCm: Int16Array; // height above floor of a cell-filling blocker box (racks, counters); 0 none
  floorMat: Uint8Array;
  ceilMat: Uint8Array;
  ceilKind: Uint8Array;
  tiles: Uint16Array; // 4 x TileState nibbles
  cellZone: Uint8Array; // palette zone per cell (arteries/landmarks may differ from `zone`)
  room: Uint16Array; // room label (flood fill separated by walls/doorways); 0 = none (solid)
  power: Uint8Array; decay: Uint8Array; humidity: Uint8Array; warmth: Uint8Array; // fields 0..255
  // ---- edges
  ex: EdgeGrid;
  ez: EdgeGrid;
  // ---- content
  fixtures: Fixture[];
  solids: Solid[];
  props: PropPlacement[];
  decals: DecalPlacement[];
  water: WaterRect[];
  structures: StructureInstance[];
  ports: Port[];
  leaks: Leak[];
  emitters: AudioEmitterSpec[];
  vignettes: VignetteInstance[];
  landmarks: LandmarkInstance[];
  anomalies: AnomalySite[];
  hash: number; // FNV over all arrays + content, set by WP1 finish(); golden-hash tested
}

export const NO_WATER = -32768;

/** Fixture id from the 0.6 m lattice tile containing the fixture CENTRE (latticeI = floor(worldX/0.6),
 * latticeJ = floor(worldZ/0.6), world metres). Two fixtures of one kind may not share a lattice tile. */
export const fixtureId = (seed: number, s: number, latticeI: number, latticeJ: number, kind: number): number =>
  (hash5(seed, SALT.FIXTURE, s, latticeI, latticeJ) ^ kind) >>> 0;
/** Storey-free id for fixtures belonging to a structure (towers: SALT.TOWER, elevators: SALT.ELEVATOR). */
export const structureFixtureId = (structureId: number, salt: number, index: number): number => hash3(structureId, salt, index);
/** Flicker/shimmer phase seed of a fixture (a pure function of its id). Shaders use (seed & 255). */
export const fixtureSeed = (id: number): number => hash2(id, SALT.FLICKER);
/** Emitting-surface luminance (nits) of a fixture: RECT luminance; SPHERE/disk I / (PI r^2), r = w/2. */
export const fixtureRadiance = (f: Pick<Fixture, 'shape' | 'luminance' | 'w'>): number =>
  f.shape === 0 ? f.luminance : f.luminance / (Math.PI * (f.w / 2) * (f.w / 2));

/** Periodic stair towers: solids/fixtures whose bakeGroup belongs to a TOWER structure, and props whose anchor
 * cell is a TOWER cell, describe ONE period (y in [-STOREY_PITCH/2, +STOREY_PITCH/2)). Mesher (WP5), props
 * (WP6, via expandPeriodicProps), collision (WP12) and baker (WP7) replicate them at
 * y + k*STOREY_PITCH for every k in TOWER_REPLICAS (clipped to |y| <= TOWER_SPAN); the baker extends k further
 * as needed for its light window so baked lighting is exactly periodic. */
export const TOWER_REPLICAS = [-2, -1, 0, 1, 2] as const;
export function towerGroups(l: ChunkLayout): number[] {
  const out: number[] = [];
  for (const s of l.structures) if (s.kind === 0 /* StructureKind.TOWER */) out.push(s.bakeGroup);
  return out;
}

export function createEdgeGrid(): EdgeGrid {
  return {
    kind: new Uint8Array(EDGE_COUNT), hA: new Int16Array(EDGE_COUNT), hB: new Int16Array(EDGE_COUNT),
    matNeg: new Uint8Array(EDGE_COUNT), matPos: new Uint8Array(EDGE_COUNT), trim: new Uint8Array(EDGE_COUNT),
  };
}

export function createEmptyLayout(key: ChunkKey, zone: ZoneId, districtId: number, mood: MoodId): ChunkLayout {
  const n = CHUNK_CELL_COUNT;
  const waterCm = new Int16Array(n);
  waterCm.fill(NO_WATER);
  return {
    key, genVersion: GEN_VERSION, zone, districtId, mood,
    flags: new Uint16Array(n), floorCm: new Int16Array(n), ceilCm: new Int16Array(n), waterCm,
    blockCm: new Int16Array(n), floorMat: new Uint8Array(n), ceilMat: new Uint8Array(n), ceilKind: new Uint8Array(n),
    tiles: new Uint16Array(n), cellZone: new Uint8Array(n), room: new Uint16Array(n),
    power: new Uint8Array(n), decay: new Uint8Array(n), humidity: new Uint8Array(n), warmth: new Uint8Array(n),
    ex: createEdgeGrid(), ez: createEdgeGrid(),
    fixtures: [], solids: [], props: [], decals: [], water: [], structures: [], ports: [], leaks: [],
    emitters: [], vignettes: [], landmarks: [], anomalies: [], hash: 0,
  };
}

/** Deep copy of every typed array (content arrays are copied shallowly; postMessage clones their objects). */
export function cloneLayout(l: ChunkLayout): ChunkLayout {
  const eg = (e: EdgeGrid): EdgeGrid => ({
    kind: e.kind.slice(), hA: e.hA.slice(), hB: e.hB.slice(), matNeg: e.matNeg.slice(), matPos: e.matPos.slice(), trim: e.trim.slice(),
  });
  return {
    ...l,
    flags: l.flags.slice(), floorCm: l.floorCm.slice(), ceilCm: l.ceilCm.slice(), waterCm: l.waterCm.slice(),
    blockCm: l.blockCm.slice(), floorMat: l.floorMat.slice(), ceilMat: l.ceilMat.slice(), ceilKind: l.ceilKind.slice(),
    tiles: l.tiles.slice(), cellZone: l.cellZone.slice(), room: l.room.slice(),
    power: l.power.slice(), decay: l.decay.slice(), humidity: l.humidity.slice(), warmth: l.warmth.slice(),
    ex: eg(l.ex), ez: eg(l.ez),
    fixtures: l.fixtures.slice(), solids: l.solids.slice(), props: l.props.slice(), decals: l.decals.slice(),
    water: l.water.slice(), structures: l.structures.slice(), ports: l.ports.slice(), leaks: l.leaks.slice(),
    emitters: l.emitters.slice(), vignettes: l.vignettes.slice(), landmarks: l.landmarks.slice(), anomalies: l.anomalies.slice(),
  };
}

/** Every ArrayBuffer referenced by a layout (for postMessage transfer lists). Transferring DETACHES them:
 * NEVER pass a layout that anything else still references (e.g. the worker LRU). Transfer cloneLayout(l). */
export function layoutTransferables(l: ChunkLayout): ArrayBuffer[] {
  const arrs = [
    l.flags, l.floorCm, l.ceilCm, l.waterCm, l.blockCm, l.floorMat, l.ceilMat, l.ceilKind, l.tiles, l.cellZone,
    l.room, l.power, l.decay, l.humidity, l.warmth,
    l.ex.kind, l.ex.hA, l.ex.hB, l.ex.matNeg, l.ex.matPos, l.ex.trim,
    l.ez.kind, l.ez.hA, l.ez.hB, l.ez.matNeg, l.ez.matPos, l.ez.trim,
  ];
  return arrs.map((a) => a.buffer as ArrayBuffer);
}

/** Ceiling tile state helpers (t = tz*2 + tx). */
export const getTile = (tiles: Uint16Array, cell: number, t: number): number => (tiles[cell] >> (t * 4)) & 15;
export function setTile(tiles: Uint16Array, cell: number, t: number, state: number): void {
  tiles[cell] = (tiles[cell] & ~(15 << (t * 4))) | ((state & 15) << (t * 4));
}
```

### 4.11 `src/core/world.ts`

Generation plug-in contracts.

```ts
// src/core/world.ts — generation-side contracts: districts, fields, seams, zone generator plug-in API,
// the ChunkGrid builder (implemented by WP1, used by WP2/WP3/WP4) and the WorldGen facade.

import { ELEVATOR, TOWER } from './constants.ts';
import { footprintRect, type ChunkKey, type Vec3 } from './grid.ts';
import type {
  AnomalyKindId, CeilKindId, EmitterKindId, FixtureKindId, LandmarkKindId, MatId, MoodId, PropKindId,
  SeamModeId, StoreyId, StructureKindId, VignetteKindId, ZoneId,
} from './ids.ts';
import type {
  ChunkLayout, DecalPlacement, Fixture, Leak, PortalSpec, PropPlacement, Solid, WaterRect,
} from './layout.ts';
import type { Rng } from './rng.ts';

export type TestSceneId = 'leak' | 'cornell' | 'tower' | 'materials' | 'flicker' | 'grid';
export const TEST_SCENES: readonly TestSceneId[] = ['leak', 'cornell', 'tower', 'materials', 'flicker', 'grid'];

export interface WorldGenOptions {
  seed: number; // hashString(seedText)
  seedText: string;
  forceZone: ZoneId | null; // every district becomes this zone
  forceMood: MoodId | null;
  forceLandmark: LandmarkKindId | null; // landmark stamped at chunk (0,0) of every storey
  testScene: TestSceneId | null; // hand-authored layouts around the origin; other chunks empty SOLID
  lights: 'default' | 'on' | 'dead'; // QA override of fixture states (on: all ON, no dynamic lights)
}

export interface DistrictInfo {
  id: number; // hash of (s, site cell); stable
  s: StoreyId;
  zone: ZoneId;
  mood: MoodId;
  siteX: number; siteZ: number; // site position in CHUNK units (float)
  seed: number;
  params: Readonly<Record<string, number>>; // from ZoneGenerator.districtParams; shared by all chunks of the district
}

/** Continuous fields over world metres, each in [0,1). Storey-offset. */
export interface FieldSampler {
  power(x: number, z: number): number;
  decay(x: number, z: number): number;
  humidity(x: number, z: number): number;
  warmth(x: number, z: number): number;
}

/** Edges along one chunk seam line (32 entries, index = cell along the line in increasing x or z). */
export interface SeamEdges { kind: Uint8Array; hA: Int16Array; hB: Int16Array }
export interface SeamSpec extends SeamEdges {
  mode: SeamModeId;
  matNeg: Uint8Array; matPos: Uint8Array; trim: Uint8Array;
}

/** (i0, j0) = MIN corner of the rotated footprint (core/grid.ts footprintRect/footprintCell/footprintPoint).
 * Tower local frame per §2.4 (u across W = 3, v along L = 5); elevator: u across W = 2, v along L = 3 (v = 0,1 cab, v = 2 lobby). */
export interface TowerSite { id: number; cx: number; cz: number; i0: number; j0: number; rot: 0 | 1 | 2 | 3; endless: boolean }
export interface ElevatorSite { id: number; cx: number; cz: number; i0: number; j0: number; rot: 0 | 1 | 2 | 3 }
/** Half-open local cell rect [i0, j0, i1, j1) of a tower / elevator footprint. Used by WP1 (site rejection, seam
 * margins) and WP4 (stamping, exit cells). */
export const towerFootprint = (t: TowerSite): [number, number, number, number] => footprintRect(t.i0, t.j0, TOWER.W_CELLS, TOWER.L_CELLS, t.rot);
export const elevatorFootprint = (e: ElevatorSite): [number, number, number, number] => footprintRect(e.i0, e.j0, ELEVATOR.W_CELLS, ELEVATOR.L_CELLS, e.rot);
/** Endless 2-cell hallway. axis 'x' = runs along x; `row` = global cell index (gj) of its first lane. [g0,g1) global cells along the axis. */
export interface ArterySpan { axis: 'x' | 'z'; row: number; g0: number; g1: number; seed: number }
export interface LandmarkSite { kind: LandmarkKindId; cx: number; cz: number; seed: number }

export interface SpawnPoint {
  s: StoreyId; x: number; y: number; z: number; yaw: number; pitch: number;
  zone: ZoneId; score: number; reason: string;
}

export interface ZonePalette {
  floorMat: MatId; wallMat: MatId; ceilMat: MatId; trimMat: MatId;
  ceilKind: CeilKindId; ceilCm: number; baseboard: boolean;
}

export interface LightingProfile {
  kind: FixtureKindId;
  placement: 'lattice' | 'custom'; // custom: the zone places its own fixtures via grid.addFixture
  lattice: [number, number]; // pitch in 0.6 m ceiling tiles along x, z (global lattice)
  phase: [number, number]; // lattice offset in tiles (from district params)
  axis: 0 | 1; // long axis of rect fixtures: 0 = x, 1 = z
  cctRange: [number, number]; // Kelvin; warmth field interpolates
  luminance: number; // nits (RECT) or cd (SPHERE)
  zoneMul: number; // multiplies the power field (DARK: 0.35)
  mountCm: number; // distance below ceiling of the emitting surface (0 for recessed)
}

export interface PropRule {
  kind: PropKindId;
  where: 'wall' | 'corner' | 'center' | 'wallMounted' | 'aisle' | 'cluster';
  per100m2: number; // expected count per 100 m^2 of walkable room area, x (0.5 + decay)
  variants: number;
  minSpacing: number; // m
  yCm: number; // mount height for wallMounted
}
export interface PropRuleSet { rules: readonly PropRule[] }

/** Mutable builder over a ChunkLayout (WP1 implements; generators use ONLY this API to write). */
export interface CellPatch {
  floorCm?: number; ceilCm?: number; waterCm?: number; blockCm?: number; floorMat?: MatId; ceilMat?: MatId;
  ceilKind?: CeilKindId; cellZone?: ZoneId; flagsSet?: number; flagsClear?: number;
}
export interface EdgeOpts { hA?: number; hB?: number; matNeg?: MatId; matPos?: MatId; trim?: number }
export interface ChunkGrid {
  readonly key: ChunkKey;
  readonly layout: ChunkLayout;
  readonly gi0: number; // global cell of local (0,0)
  readonly gj0: number;
  isReserved(li: number, lj: number): boolean;
  /** seam lines (i=0/32 on 'x', j=0/32 on 'z') are frozen after the seam step */
  isFrozenEdge(axis: 'x' | 'z', i: number, j: number): boolean;
  /** axis 'x': ex edge on line x=i between cells (i-1,j),(i,j); axis 'z': ez edge on line z=j between (i,j-1),(i,j).
   * Returns false (and writes nothing) if frozen or touching a reserved cell unless `force`. */
  setEdge(axis: 'x' | 'z', i: number, j: number, kind: number, o?: EdgeOpts, force?: boolean): boolean;
  getEdge(axis: 'x' | 'z', i: number, j: number): number;
  /** straight run on one line: axis 'x' => line x=line, cells [from,to) along z */
  wallRun(axis: 'x' | 'z', line: number, from: number, to: number, kind: number, o?: EdgeOpts): void;
  /** closed rectangle of edges around cells [li0,li1) x [lj0,lj1) */
  rectWalls(li0: number, lj0: number, li1: number, lj1: number, kind: number, o?: EdgeOpts): void;
  setCells(li0: number, lj0: number, li1: number, lj1: number, p: CellPatch, force?: boolean): void;
  hasFlag(li: number, lj: number, f: number): boolean;
  /** Solids crossing chunk bounds: EVERY chunk whose bounds a solid intersects adds it (clipped or unclipped;
   * ids are chunk-assigned, there are no shared global ids). WP5/WP6 mesh only nb.center's solids, filtered by
   * face ownership (pipes: by midpoint), so no face is emitted twice. WP7 (nb.solids()) and WP12 tolerate the
   * resulting duplicates. */
  addSolid(s: DistributiveOmit<Solid, 'id'>): number;
  /** key: lattice coords of the fixture centre => id = fixtureId(seed, s, latticeI, latticeJ, f.kind), seed =
   * fixtureSeed(id); or an explicit {id, seed} (towers/elevators: structureFixtureId). Returns the id. */
  addFixture(f: Omit<Fixture, 'id' | 'seed' | 'dynamic'>, key: FixtureKey): number;
  addProp(p: PropPlacement): void;
  addDecal(d: DecalPlacement): void;
  addWater(w: WaterRect): void;
  addLeak(l: Leak): void;
  addEmitter(kind: EmitterKindId, x: number, y: number, z: number, gain: number): void;
  addVignette(kind: VignetteKindId, x: number, z: number, yaw: number): void;
  addAnomaly(kind: AnomalyKindId, x: number, z: number, r: number): void;
  addStructure(kind: StructureKindId, i0: number, j0: number, i1: number, j1: number, rot: 0 | 1 | 2 | 3, portal: PortalSpec | null): number;
  addLandmark(kind: LandmarkKindId, i0: number, j0: number, i1: number, j1: number): void;
  cellCenter(li: number, lj: number): [number, number]; // chunk-local metres
}
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type FixtureKey = { latticeI: number; latticeJ: number } | { id: number; seed: number };

export interface ZoneGenContext {
  key: ChunkKey;
  seed: number;
  opts: WorldGenOptions;
  rng: Rng; // rngFor(seed, SALT.ZONE_LAYOUT, s, cx, cz)
  district: DistrictInfo;
  grid: ChunkGrid;
  seams: { W: SeamSpec; N: SeamSpec; E: SeamSpec; S: SeamSpec };
  neighbors: { W: ZoneId; N: ZoneId; E: ZoneId; S: ZoneId };
  fields: FieldSampler;
  palette: ZonePalette;
  lighting: LightingProfile;
  world: WorldGenQuery;
}

/** Read-only queries a generator may make about the world (pure). */
export interface WorldGenQuery {
  districtAt(s: StoreyId, cx: number, cz: number): DistrictInfo;
  arteriesNear(s: StoreyId, cx: number, cz: number): readonly ArterySpan[];
  towersNear(s: StoreyId, cx: number, cz: number): readonly TowerSite[];
}

export interface GlobalSeamQuery {
  seed: number; s: StoreyId; district: DistrictInfo;
  axis: 'x' | 'z'; // 'x' = line x = const (a west/east seam); 'z' = line z = const
  line: number; // global line index (gi for 'x', gj for 'z')
  g0: number; // global cell index of the first of the 32 cells along the line
}

export interface ZoneGenerator {
  id: ZoneId;
  seamMode: 'pattern' | 'global';
  districtParams(rng: Rng, s: StoreyId): Record<string, number>;
  /** PATTERN mode: seam edges from a seam-local rng (shared by both sides). */
  seamPattern?(rng: Rng, d: DistrictInfo): SeamEdges;
  /** GLOBAL mode: rasterize world-space features onto the seam line (must agree with generate()). */
  globalSeam?(q: GlobalSeamQuery): SeamEdges;
  generate(ctx: ZoneGenContext): void;
  palette(s: StoreyId, d: DistrictInfo): ZonePalette;
  lighting(s: StoreyId, d: DistrictInfo): LightingProfile;
  props: PropRuleSet;
}

/** 3x3 chunk neighbourhood; cell coords are relative to the CENTER chunk, valid in [-32, 64). */
export interface LayoutNeighborhood {
  readonly center: ChunkLayout;
  get(dcx: -1 | 0 | 1, dcz: -1 | 0 | 1): ChunkLayout;
  flags(li: number, lj: number): number;
  floorCm(li: number, lj: number): number;
  ceilCm(li: number, lj: number): number;
  blockCm(li: number, lj: number): number;
  waterCm(li: number, lj: number): number;
  room(li: number, lj: number): number; // chunk-local room ids are made unique: (layoutIndex << 12) | room
  /** Light-region label over the whole 96x96 halo: flood fill across edges that do not occlude at y = 1.2 m
   * (and cells not SOLID). Deterministic for a given centre chunk; used by BOTH the mesher (floor brAux) and the
   * baker (emission-map alpha), always through regionKey() (core/constants.ts), so floor-reflection rejection
   * is self-consistent per tile. 0 = solid. */
  region(li: number, lj: number): number;
  exKind(i: number, lj: number): number; // i in [-32, 65)
  ezKind(li: number, j: number): number;
  exH(i: number, lj: number): [number, number];
  ezH(li: number, j: number): [number, number];
  /** fixtures of all 9 layouts whose centre is within r metres (center-chunk-local coords) */
  fixturesNear(x: number, z: number, r: number, out: Fixture[]): number;
  /** solids of all 9 layouts (positions converted to center-chunk-local coords, cached) */
  solids(): readonly Solid[];
}

export interface WorldGen extends WorldGenQuery {
  readonly opts: WorldGenOptions;
  zoneAt(s: StoreyId, cx: number, cz: number): ZoneId;
  fields(s: StoreyId): FieldSampler;
  /** 'x': the WEST line of chunk (cx,cz) (= EAST line of cx-1); 'z': its NORTH line. Pure; both sides call it. */
  seam(s: StoreyId, axis: 'x' | 'z', cx: number, cz: number): SeamSpec;
  elevatorsNear(s: StoreyId, cx: number, cz: number): readonly ElevatorSite[];
  landmarkAt(s: StoreyId, cx: number, cz: number): LandmarkSite | null;
  generateChunk(key: ChunkKey): ChunkLayout;
  findSpawn(s: StoreyId): SpawnPoint;
  /** query: 'zone:NAME' | 'landmark:NAME' | 'vignette:NAME' | 'tower' | 'elevator' | 'dark' | 'spawn' | 'water' | 'flicker'
   *  | 'safe' (nearest walkable, non-reserved cell to `from`; used by glitch/pit traversal and spawn snapping) */
  findNearest(query: string, from: { s: StoreyId; x: number; z: number }, maxChunks: number): SpawnPoint | null;
  asciiMap(s: StoreyId, cx0: number, cz0: number, cx1: number, cz1: number): string;
}

export type { Vec3 };
```

### 4.12 `src/core/materials.ts`

```ts
// src/core/materials.ts — material layer table. Layer index == MatId == texture-array layer.
// albedoMean is AUTHORITATIVE for the baker's bounce colour; WP8 must generate textures whose measured mean
// (1x1 mip, linear) is within 10% per channel (layerAlbedoCheck). WP8 may edit NUMERIC values in this table
// (albedoMean, roughness) via docs/contract-changes/WP8.md; nobody else edits it.
// repeat: metres per texture repeat; MUST divide TILE_SIZE (19.2) so tile-local material UVs are seamless.
// repeatY: metres per repeat in v on VERTICAL shell faces (v = y / repeatY); default = repeat. Horizontal faces use
// (x, z) / repeat. WP8 authors a layer's texture over a frame of repeat (u) x repeatY (v) metres. Layers used by
// periodic stair towers (TOWER_LAYERS) MUST have STOREY_PITCH / repeatY integral (tested) so walls are 3 m-periodic.

import { Mat, type MatId, SurfaceSound, type SurfaceSoundId } from './ids.ts';

export type GrimeProfile = 'carpet' | 'wallpaper' | 'ceilingTile' | 'concrete' | 'tile' | 'metal' | 'paint' | 'masonry' | 'none';

export interface MaterialLayerDef {
  id: MatId;
  name: string;
  repeat: number; // m
  repeatY?: number; // m, vertical-face repeat (default repeat)
  tileSize: number; // m, per-tile hashed rotation/flip cell for anti-tiling (0 = off). ONLY for physical tiles.
  hexTile?: number; // m, offset-only stochastic (hex) tiling cell with feathered blend, for non-tiled layers (0/undefined = off)
  albedoMean: readonly [number, number, number]; // linear
  roughness: number; // mean
  metal: number;
  grime: GrimeProfile;
  sound: SurfaceSoundId;
  absorption: number; // Sabine alpha (mid band)
  reflective: boolean; // default for VFlag.REFLECTIVE on up-facing surfaces
}

const S = SurfaceSound;
export const LAYER_DEFS: readonly MaterialLayerDef[] = [
  { id: 0, name: 'WALLPAPER_L0', repeat: 1.2, tileSize: 0, albedoMean: [0.42, 0.34, 0.12], roughness: 0.8, metal: 0, grime: 'wallpaper', sound: S.CARPET, absorption: 0.1, reflective: false },
  { id: 1, name: 'CARPET_L0', repeat: 2.4, tileSize: 0, hexTile: 1.2, albedoMean: [0.33, 0.25, 0.1], roughness: 0.95, metal: 0, grime: 'carpet', sound: S.CARPET, absorption: 0.35, reflective: true },
  { id: 2, name: 'CEILING_TILE', repeat: 1.2, tileSize: 0.6, albedoMean: [0.6, 0.56, 0.44], roughness: 0.9, metal: 0, grime: 'ceilingTile', sound: S.CARPET, absorption: 0.6, reflective: false },
  { id: 3, name: 'PANEL_LENS', repeat: 0.6, tileSize: 0, albedoMean: [0.7, 0.7, 0.68], roughness: 0.3, metal: 0, grime: 'none', sound: S.METAL, absorption: 0.05, reflective: false },
  { id: 4, name: 'TRIM_PAINT', repeat: 1.2, tileSize: 0, albedoMean: [0.45, 0.4, 0.3], roughness: 0.5, metal: 0, grime: 'paint', sound: S.WOOD, absorption: 0.05, reflective: false },
  { id: 5, name: 'WALLPAPER_MANILA', repeat: 1.2, tileSize: 0, albedoMean: [0.5, 0.42, 0.28], roughness: 0.8, metal: 0, grime: 'wallpaper', sound: S.CARPET, absorption: 0.1, reflective: false },
  { id: 6, name: 'CARPET_OFFICE', repeat: 2.4, tileSize: 0.6, albedoMean: [0.12, 0.13, 0.15], roughness: 0.95, metal: 0, grime: 'carpet', sound: S.CARPET, absorption: 0.3, reflective: false },
  { id: 7, name: 'DRYWALL', repeat: 2.4, tileSize: 0, albedoMean: [0.62, 0.6, 0.55], roughness: 0.85, metal: 0, grime: 'paint', sound: S.CONCRETE, absorption: 0.08, reflective: false },
  { id: 8, name: 'VINYL_VCT', repeat: 1.2, tileSize: 0.3, albedoMean: [0.45, 0.43, 0.38], roughness: 0.35, metal: 0, grime: 'tile', sound: S.VINYL, absorption: 0.03, reflective: true },
  { id: 9, name: 'CONCRETE_FLOOR', repeat: 4.8, repeatY: 3.0, tileSize: 0, hexTile: 2.4, albedoMean: [0.3, 0.29, 0.27], roughness: 0.6, metal: 0, grime: 'concrete', sound: S.CONCRETE, absorption: 0.02, reflective: true },
  { id: 10, name: 'CONCRETE_WALL', repeat: 2.4, repeatY: 1.5, tileSize: 0, albedoMean: [0.35, 0.34, 0.32], roughness: 0.85, metal: 0, grime: 'concrete', sound: S.CONCRETE, absorption: 0.03, reflective: false },
  { id: 11, name: 'CONCRETE_CEIL', repeat: 4.8, repeatY: 3.0, tileSize: 0, albedoMean: [0.33, 0.32, 0.3], roughness: 0.9, metal: 0, grime: 'concrete', sound: S.CONCRETE, absorption: 0.03, reflective: false },
  { id: 12, name: 'CMU_PAINTED', repeat: 2.4, repeatY: 1.0, tileSize: 0, albedoMean: [0.5, 0.5, 0.46], roughness: 0.5, metal: 0, grime: 'masonry', sound: S.CONCRETE, absorption: 0.05, reflective: false },
  { id: 13, name: 'POOL_TILE', repeat: 1.2, tileSize: 0.15, albedoMean: [0.72, 0.76, 0.76], roughness: 0.08, metal: 0, grime: 'tile', sound: S.TILE, absorption: 0.02, reflective: true },
  { id: 14, name: 'POOL_MOSAIC', repeat: 0.6, tileSize: 0.3, albedoMean: [0.35, 0.6, 0.65], roughness: 0.1, metal: 0, grime: 'tile', sound: S.TILE, absorption: 0.02, reflective: true },
  { id: 15, name: 'METAL_PAINTED', repeat: 1.2, repeatY: 1.0, tileSize: 0, albedoMean: [0.4, 0.4, 0.38], roughness: 0.45, metal: 0.2, grime: 'metal', sound: S.METAL, absorption: 0.03, reflective: false },
  { id: 16, name: 'METAL_RUST', repeat: 1.2, tileSize: 0, albedoMean: [0.25, 0.14, 0.08], roughness: 0.75, metal: 0.4, grime: 'metal', sound: S.METAL, absorption: 0.03, reflective: false },
  { id: 17, name: 'METAL_GRATE', repeat: 1.2, tileSize: 0, albedoMean: [0.2, 0.2, 0.2], roughness: 0.55, metal: 0.8, grime: 'metal', sound: S.GRATE, absorption: 0.1, reflective: false },
  { id: 18, name: 'WOOD', repeat: 1.2, tileSize: 0, albedoMean: [0.35, 0.22, 0.12], roughness: 0.55, metal: 0, grime: 'none', sound: S.WOOD, absorption: 0.08, reflective: false },
  { id: 19, name: 'PLASTIC', repeat: 0.6, tileSize: 0, albedoMean: [0.55, 0.53, 0.48], roughness: 0.4, metal: 0, grime: 'none', sound: S.VINYL, absorption: 0.05, reflective: false },
  { id: 20, name: 'FABRIC_PARTITION', repeat: 1.2, tileSize: 0, albedoMean: [0.3, 0.3, 0.32], roughness: 1.0, metal: 0, grime: 'none', sound: S.CARPET, absorption: 0.5, reflective: false },
  { id: 21, name: 'PLENUM', repeat: 2.4, tileSize: 0, albedoMean: [0.08, 0.07, 0.06], roughness: 0.95, metal: 0, grime: 'none', sound: S.CONCRETE, absorption: 0.3, reflective: false },
  { id: 22, name: 'RUBBER', repeat: 1.2, tileSize: 0, albedoMean: [0.05, 0.05, 0.05], roughness: 0.7, metal: 0, grime: 'none', sound: S.VINYL, absorption: 0.05, reflective: false },
  { id: 23, name: 'SIGNAGE', repeat: 1.2, tileSize: 0, albedoMean: [0.5, 0.3, 0.25], roughness: 0.4, metal: 0, grime: 'none', sound: S.METAL, absorption: 0.03, reflective: false },
  { id: 24, name: 'DECAL_ATLAS', repeat: 1.2, tileSize: 0, albedoMean: [0.2, 0.18, 0.14], roughness: 0.7, metal: 0, grime: 'none', sound: S.CONCRETE, absorption: 0.03, reflective: false },
  { id: 25, name: 'FLOOR_PAINT', repeat: 1.2, tileSize: 0, albedoMean: [0.65, 0.6, 0.2], roughness: 0.5, metal: 0, grime: 'concrete', sound: S.CONCRETE, absorption: 0.02, reflective: false },
  { id: 26, name: 'TERRAZZO', repeat: 2.4, tileSize: 0, albedoMean: [0.5, 0.48, 0.44], roughness: 0.25, metal: 0, grime: 'tile', sound: S.TILE, absorption: 0.02, reflective: true },
  { id: 27, name: 'METAL_DECK', repeat: 1.2, tileSize: 0, albedoMean: [0.3, 0.3, 0.29], roughness: 0.5, metal: 0.6, grime: 'metal', sound: S.METAL, absorption: 0.05, reflective: false },
  // texture realism v2 reserved layers (placeholder recipes, not placed in the world yet)
  { id: 28, name: 'CMU_RAW', repeat: 2.4, repeatY: 1.0, tileSize: 0, albedoMean: [0.22, 0.215, 0.2], roughness: 0.9, metal: 0, grime: 'masonry', sound: S.CONCRETE, absorption: 0.07, reflective: false },
  { id: 29, name: 'METAL_BARE', repeat: 0.6, tileSize: 0, albedoMean: [0.56, 0.56, 0.56], roughness: 0.3, metal: 1, grime: 'metal', sound: S.METAL, absorption: 0.03, reflective: false },
];
export const layerRepeatY = (d: MaterialLayerDef): number => d.repeatY ?? d.repeat;
/** The only layers WP4 may use on tower shell geometry (edges and periodic solids). No trims inside towers. */
export const TOWER_LAYERS: readonly MatId[] = [Mat.CMU_PAINTED, Mat.CONCRETE_WALL, Mat.CONCRETE_FLOOR, Mat.CONCRETE_CEIL, Mat.METAL_PAINTED];
```

### 4.13 `src/core/props.ts`

```ts
// src/core/props.ts — prop footprint table shared by placement (WP4), geometry (WP6), collision (WP12),
// the baker (occluders, WP7) and audio. Geometry built by WP6 MUST fit inside `size` (tested).
// Local frame: origin at the base centre, +Y up, FRONT faces -Z at yaw 0. size = [x, y, z] metres.

import type { PropKindId } from './ids.ts';

export interface PropDef {
  kind: PropKindId;
  name: string;
  size: readonly [number, number, number];
  collide: boolean; // player collision AABB (rotated footprint, yaw snapped to 90deg for collision)
  occlude: boolean; // whole-footprint light-bake occluder box (large props; yaw snapped to 90deg), unless the kind
                    // has PROP_OCCLUDERS part boxes (desk tops, seats, car bodies, rack decks, ...), which take precedence
  wallMounted: boolean; // back (+Z face) touches the wall
  maxTris: number;
}

const P = (kind: number, name: string, x: number, y: number, z: number, collide: boolean, occlude: boolean, wallMounted: boolean, maxTris: number): PropDef =>
  ({ kind: kind as PropKindId, name, size: [x, y, z], collide, occlude, wallMounted, maxTris });

export const PROP_DEFS: readonly PropDef[] = [
  P(0, 'CHAIR_STACKING', 0.5, 0.82, 0.52, true, false, false, 400),
  P(1, 'OFFICE_CHAIR', 0.62, 1.05, 0.62, true, false, false, 900),
  P(2, 'DESK', 1.5, 0.75, 0.75, true, false, false, 400),
  P(3, 'FILING_CABINET', 0.47, 1.33, 0.62, true, true, true, 300),
  P(4, 'CRT_MONITOR', 0.4, 0.38, 0.42, false, false, false, 400),
  P(5, 'WATER_COOLER', 0.32, 1.3, 0.32, true, false, true, 500),
  P(6, 'VENDING_MACHINE', 0.9, 1.83, 0.8, true, true, true, 600),
  P(7, 'CONFERENCE_TABLE', 3.0, 0.75, 1.2, true, false, false, 300),
  P(8, 'CRATE', 1.0, 0.8, 1.0, true, true, false, 200),
  P(9, 'PALLET', 1.2, 0.15, 1.0, true, false, false, 300),
  P(10, 'SHELF_RACK', 2.4, 4.2, 1.1, true, true, false, 1500),
  P(11, 'TRASH_CAN', 0.4, 0.6, 0.4, true, false, false, 200),
  P(12, 'CONE', 0.36, 0.7, 0.36, true, false, false, 150),
  P(13, 'WET_FLOOR_SIGN', 0.3, 0.62, 0.35, true, false, false, 120),
  P(14, 'WHEEL_STOP', 1.8, 0.12, 0.18, false, false, false, 60),
  P(15, 'CAR_SEDAN', 1.8, 1.45, 4.6, true, true, false, 2500),
  P(16, 'POOL_LADDER', 0.6, 1.9, 0.5, false, false, true, 600),
  P(17, 'LOUNGE_CHAIR', 0.65, 0.9, 1.9, true, false, false, 600),
  P(18, 'LIFEBUOY', 0.6, 0.6, 0.12, false, false, true, 400),
  P(19, 'BENCH_TILED', 2.4, 0.45, 0.6, true, false, false, 60),
  P(20, 'MATTRESS', 0.9, 0.2, 1.9, false, false, false, 200),
  P(21, 'PHONE', 0.22, 0.12, 0.2, false, false, false, 300),
  P(22, 'RADIO', 0.35, 0.2, 0.12, false, false, false, 300),
  P(23, 'BACKPACK', 0.35, 0.5, 0.25, false, false, false, 400),
  P(24, 'DOOR_FRAME', 1.1, 2.2, 0.15, true, false, false, 120),
  P(25, 'DOOR_LEAF', 0.9, 2.08, 0.045, true, false, false, 120),
  P(26, 'ELEVATOR_DOOR', 1.0, 2.2, 0.05, true, false, false, 60),
  P(27, 'VENT_GRILLE', 0.6, 0.3, 0.05, false, false, true, 200),
  P(28, 'OUTLET', 0.07, 0.12, 0.02, false, false, true, 60),
  P(29, 'THERMOSTAT', 0.1, 0.12, 0.03, false, false, true, 60),
  P(30, 'EXTINGUISHER', 0.5, 0.8, 0.25, false, false, true, 400),
  P(31, 'PIPE_VALVE', 0.3, 0.3, 0.3, false, false, false, 300),
  P(32, 'BOILER', 1.6, 2.2, 1.6, true, true, false, 1200),
  P(33, 'TANK', 1.2, 2.4, 1.2, true, true, false, 800),
  P(34, 'HANDRAIL', 1.2, 1.0, 0.08, false, false, true, 200),
  P(35, 'CEILING_DEBRIS', 1.2, 0.1, 1.2, false, false, false, 300),
  P(36, 'TILE_FRAGMENT', 0.6, 0.02, 0.6, false, false, false, 40),
  P(37, 'BOTTLE', 0.08, 0.3, 0.08, false, false, false, 120),
  P(38, 'SLEEPING_BAG', 0.8, 0.12, 2.0, false, false, false, 200),
  P(39, 'BUCKET', 0.32, 0.35, 0.32, true, false, false, 200),
  P(40, 'MOP', 0.3, 1.3, 0.3, false, false, false, 150),
  P(41, 'CARDBOARD_BOX', 0.5, 0.4, 0.4, true, false, false, 60),
  P(42, 'FLOAT_ROPE', 1.2, 0.12, 0.12, false, false, false, 300), // lane rope + floats across a cell edge at water level
  P(43, 'POOL_FLOAT', 1.1, 0.25, 0.6, false, false, false, 400), // inflatable ring/lounger, floats at water y
  P(44, 'TOWEL', 0.6, 0.03, 1.4, false, false, false, 120),
];

export type Box6 = readonly [number, number, number, number, number, number]; // x0,y0,z0,x1,y1,z1, prop-local metres
/** Part occluder boxes (prop-local frame, yaw snapped to 90deg) for the WP7 VisGrid, light volume, AO and the
 * near-field gather, keyed by PropKind. A part list takes precedence over `occlude` (and the OCCLUDE flag). */
export const PROP_OCCLUDERS: Readonly<Partial<Record<number, readonly Box6[]>>> = {
  // CHAIR_STACKING / OFFICE_CHAIR seats; DESK top, modesty panel, both side panels; CRT_MONITOR housing;
  // WATER_COOLER; CONFERENCE_TABLE top + pedestal legs; PALLET deck; SHELF_RACK 4 uprights + 3 decks (1.2 / 2.4 /
  // 3.6 m); TRASH_CAN; CAR_SEDAN lower body above the sills, cabin, underbody, 4 wheels; LOUNGE_CHAIR frame;
  // BENCH_TILED; MATTRESS; BACKPACK; BUCKET; CARDBOARD_BOX ... (see src/core/props.ts)
};
/** Per-variant replacements (DESK 1/3 drawer pedestal, collapsed SHELF_RACK 2, CAR_SEDAN 3 open door, open /
 * crushed CARDBOARD_BOX). */
export const PROP_OCCLUDER_VARIANTS: Readonly<Partial<Record<number, Readonly<Partial<Record<number, readonly Box6[]>>>>>>;
/** Chair backs: added only when the yaw is within OCC_ALIGN_TOL (0.2 rad) of a quarter turn. */
export const PROP_OCCLUDERS_ALIGNED: Readonly<Partial<Record<number, readonly Box6[]>>>;
export function propOccluders(kind: number, variant: number): readonly Box6[] | undefined;
export function quarterAligned(yaw: number): boolean;
/** Props that respond to the interact key (WP12 targets them, WP13 plays their sound). */
export const INTERACTABLE_PROPS: readonly PropKindId[] = [25 /* DOOR_LEAF */, 21 /* PHONE */, 22 /* RADIO */] as PropKindId[];
```

### 4.14 `src/core/zones.ts`

```ts
// src/core/zones.ts — structural zone metadata shared across WPs. Palettes/lighting/props live in each
// ZoneGenerator (WP2/WP3); atmosphere (fog/exposure/grade) in lighting/atmospheres.ts (WP11);
// acoustics in audio/zoneAudio.ts (WP13). WP1 may edit STRATA_WEIGHTS numbers via contract-changes/WP1.md.

import { LIGHT } from './constants.ts';
import { LandmarkKind, SeamMode, type SeamModeId, type StoreyId, Zone, type ZoneId } from './ids.ts';

export interface ZoneInfo {
  id: ZoneId;
  name: string;
  seamMode: SeamModeId; // for same-district seams (different districts are always BOUNDARY)
  open: boolean; // long sightlines; bake uses LIGHT.R_OPEN
  lightR: number; // bake window radius (m)
  baseZone: ZoneId; // generator that implements it (MANILA/DARK -> LOBBY)
}

const zi = (id: ZoneId, name: string, seamMode: SeamModeId, open: boolean, baseZone: ZoneId): ZoneInfo =>
  ({ id, name, seamMode, open, lightR: open ? LIGHT.R_OPEN : LIGHT.R_STATIC, baseZone });

export const ZONE_INFO: readonly ZoneInfo[] = [
  zi(Zone.LOBBY, 'LOBBY', SeamMode.PATTERN, false, Zone.LOBBY),
  zi(Zone.MANILA, 'MANILA', SeamMode.PATTERN, false, Zone.LOBBY),
  zi(Zone.DARK, 'DARK', SeamMode.PATTERN, false, Zone.LOBBY),
  zi(Zone.MAZE, 'MAZE', SeamMode.PATTERN, false, Zone.MAZE),
  zi(Zone.LOW_EXPANSE, 'LOW_EXPANSE', SeamMode.GLOBAL, true, Zone.LOW_EXPANSE),
  zi(Zone.PILLAR_HALL, 'PILLAR_HALL', SeamMode.GLOBAL, true, Zone.PILLAR_HALL),
  zi(Zone.OFFICE, 'OFFICE', SeamMode.GLOBAL, false, Zone.OFFICE),
  zi(Zone.POOLROOMS, 'POOLROOMS', SeamMode.GLOBAL, true, Zone.POOLROOMS),
  zi(Zone.PARKING, 'PARKING', SeamMode.GLOBAL, true, Zone.PARKING),
  zi(Zone.PIPEWORKS, 'PIPEWORKS', SeamMode.PATTERN, false, Zone.PIPEWORKS),
  zi(Zone.WAREHOUSE, 'WAREHOUSE', SeamMode.GLOBAL, true, Zone.WAREHOUSE),
  zi(Zone.CONCRETE, 'CONCRETE', SeamMode.PATTERN, false, Zone.CONCRETE),
];

/** Per-storey zone weights (index = ZoneId). Storey 0 district nearest the origin is forced LOBBY;
 * the next 4 nearest sites get a seed-permutation of [PILLAR_HALL, LOW_EXPANSE, DARK, OFFICE]. */
export const STRATA_WEIGHTS: Readonly<Record<StoreyId, readonly number[]>> = {
  //   LOBBY MANILA DARK MAZE LOWEXP PILLAR OFFICE POOLS PARKING PIPES WAREHOUSE CONCRETE
  0: [40, 6, 10, 10, 10, 10, 12, 2, 0, 0, 0, 0],
  1: [8, 0, 8, 10, 0, 0, 0, 0, 26, 18, 14, 16],
  2: [0, 4, 0, 0, 10, 16, 0, 70, 0, 0, 0, 0],
};
export const ONBOARDING_ZONES: readonly ZoneId[] = [Zone.PILLAR_HALL, Zone.LOW_EXPANSE, Zone.DARK, Zone.OFFICE];
export const MOOD_WEIGHTS: readonly number[] = [72, 14, 8, 6]; // NORMAL SPARSE DYING DARK (DARK zone forces DARK)
export const MOOD_POWER_MUL: readonly number[] = [1.0, 0.75, 0.6, 0.3];

/** cellZone of every TOWER / ELEVATOR cell in every storey (mood there is always NORMAL): atmosphere, ambience and
 * audio follow cellZone (WorldQuery.zoneAt/moodAt), so nothing crossfades at a storey switch. */
export const STRUCTURE_ZONE: ZoneId = Zone.CONCRETE;
/** Optional per-landmark bake window radius (m) for lights inside the landmark's cells; 0 = default rule. */
export const LANDMARK_LIGHT_R: Readonly<Partial<Record<number, number>>> = {
  [LandmarkKind.ATRIUM]: 20, [LandmarkKind.SKYLIGHT_HALL]: 16, [LandmarkKind.CHAIR_CATHEDRAL]: 14,
};
```

### 4.15 `src/core/quality.ts`

```ts
// src/core/quality.ts — quality presets. `quality=auto` resolves via WEBGL_debug_renderer_info (WP14):
// SwiftShader/llvmpipe/Software -> low; Intel/Mali/Adreno/Apple integrated -> medium; else high.

import type { LmTpc } from './constants.ts';

export type QualityName = 'low' | 'medium' | 'high' | 'ultra';
export const QUALITY_NAMES: readonly QualityName[] = ['low', 'medium', 'high', 'ultra'];

export interface QualityConfig {
  name: QualityName;
  streamRadius: number; // chunks (Chebyshev) kept resident around the player's chunk
  lmTpc: LmTpc; // lightmap texels per cell (8 -> 0.15 m, 12 -> 0.1 m); invariant LM_TEXEL <= WALL_T
  bakeShadowSamples: 1 | 2 | 4 | 6; // stratified emitter samples for PARTIAL pairs
  probeRays: 32 | 64 | 96 | 128;
  bakeWorkers: number; // upper bound; actual = clamp(hardwareConcurrency - 4, 2, bakeWorkers)
  textureSize: 512 | 1024;
  anisotropy: number;
  ao: 'off' | 'Performance' | 'Low' | 'Medium' | 'High';
  aoHalfRes: boolean;
  aa: 'fxaa' | 'smaa';
  smaaPreset: 'LOW' | 'MEDIUM' | 'HIGH' | 'ULTRA';
  bloomLevels: number;
  planarReflectionScale: number; // 0 = off (water uses floor-emission + env tint only)
  floorReflections: boolean; // emission-map glossy floor reflections
  flashlightShadow: 512 | 1024 | 2048; // shadow map size; castShadow is ALWAYS true (constant light/program set)
  renderScale: number;
  dynamicResolution: boolean;
  maxDpr: number;
  propDistance: number; // m, props meshes hidden beyond
  humVoices: number;
  hrtf: boolean;
  uploadBudgetMs: number;
  fogAirlight: boolean; // analytic flashlight beam in haze
}

export const QUALITY: Readonly<Record<QualityName, QualityConfig>> = {
  low: {
    name: 'low', streamRadius: 1, lmTpc: 8, bakeShadowSamples: 1, probeRays: 32, bakeWorkers: 4, textureSize: 512,
    anisotropy: 4, ao: 'off', aoHalfRes: true, aa: 'fxaa', smaaPreset: 'LOW', bloomLevels: 5, planarReflectionScale: 0,
    floorReflections: false, flashlightShadow: 512, renderScale: 0.75, dynamicResolution: true, maxDpr: 1,
    propDistance: 20, humVoices: 4, hrtf: false, uploadBudgetMs: 2, fogAirlight: false,
  },
  medium: {
    name: 'medium', streamRadius: 2, lmTpc: 8, bakeShadowSamples: 2, probeRays: 64, bakeWorkers: 8, textureSize: 1024,
    anisotropy: 8, ao: 'Low', aoHalfRes: true, aa: 'smaa', smaaPreset: 'MEDIUM', bloomLevels: 6, planarReflectionScale: 0.35,
    floorReflections: true, flashlightShadow: 1024, renderScale: 0.9, dynamicResolution: true, maxDpr: 1,
    propDistance: 30, humVoices: 8, hrtf: true, uploadBudgetMs: 2.5, fogAirlight: false,
  },
  high: {
    name: 'high', streamRadius: 2, lmTpc: 12, bakeShadowSamples: 4, probeRays: 96, bakeWorkers: 12, textureSize: 1024,
    anisotropy: 16, ao: 'Medium', aoHalfRes: false, aa: 'smaa', smaaPreset: 'HIGH', bloomLevels: 8, planarReflectionScale: 0.5,
    floorReflections: true, flashlightShadow: 1024, renderScale: 1, dynamicResolution: true, maxDpr: 1,
    propDistance: 45, humVoices: 10, hrtf: true, uploadBudgetMs: 3, fogAirlight: true,
  },
  ultra: {
    name: 'ultra', streamRadius: 3, lmTpc: 12, bakeShadowSamples: 6, probeRays: 128, bakeWorkers: 12, textureSize: 1024,
    anisotropy: 16, ao: 'High', aoHalfRes: false, aa: 'smaa', smaaPreset: 'ULTRA', bloomLevels: 8, planarReflectionScale: 0.75,
    floorReflections: true, flashlightShadow: 2048, renderScale: 1, dynamicResolution: false, maxDpr: 1.5,
    propDistance: 60, humVoices: 12, hrtf: true, uploadBudgetMs: 3, fogAirlight: true,
  },
};

/** Bake parameters derived from a preset (sent to workers in the init message). */
export interface BakeQuality { tpc: LmTpc; shadowSamples: 1 | 2 | 4 | 6; probeRays: 32 | 64 | 96 | 128 }
export const bakeQualityOf = (q: QualityConfig): BakeQuality => ({ tpc: q.lmTpc, shadowSamples: q.bakeShadowSamples, probeRays: q.probeRays });
```

### 4.16 `src/core/settings.ts`

```ts
// src/core/settings.ts — persisted user settings (localStorage 'backrooms.settings.v1'; store/validation in WP14).

import type { QualityConfig, QualityName } from './quality.ts';

export type FlickerMode = 'standard' | 'reduced' | 'off';
// standard: <= 3 area-light transitions/s with depth > 20% (WCAG 2.3.1 general flash); lens may strobe faster.
// reduced: depth <= 40%, <= 2 Hz, no lens strobe. off: steady at the state's mean.

export interface Settings {
  version: 1;
  quality: QualityName | 'auto';
  overrides: Partial<QualityConfig>;
  fov: number; // vertical degrees, 50..90
  mouseSensitivity: number; // rad per pixel
  invertY: boolean;
  headBob: number; // 0..1
  flicker: FlickerMode;
  toggleSprint: boolean;
  toggleCrouch: boolean;
  brightnessEV: number; // -1..+1 exposure bias
  volume: { master: number; ambience: number; hum: number; sfx: number; ui: number };
  film: { grain: number; chromaticAberration: number; vignette: number; distortion: number; camcorder: boolean };
  mainsHz: 50 | 60;
  lastSeed: string;
}

export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  quality: 'auto',
  overrides: {},
  fov: 62,
  mouseSensitivity: 0.0022,
  invertY: false,
  headBob: 1,
  flicker: 'standard',
  toggleSprint: false,
  toggleCrouch: false,
  brightnessEV: 0,
  volume: { master: 0.8, ambience: 0.8, hum: 0.8, sfx: 0.9, ui: 0.6 },
  film: { grain: 1, chromaticAberration: 1, vignette: 1, distortion: 1, camcorder: false },
  mainsHz: 60,
  lastSeed: '',
};
```

### 4.17 `src/core/events.ts`

```ts
// src/core/events.ts — typed synchronous event bus (main thread only). emit() does not allocate.
// Producers own their events: player (WP12) footstep/land/breath/interact; traversal (WP12) storeyChanged/
// transition/glitch (glitch is emitted ONLY by traversal); lighting (WP11) lightToggle/flashlight/anomaly/spark;
// streamer (WP10) tile/chunk events; app (WP14) the rest. WP14 wires 'glitch' -> post.glitch.

import type { StoreyId, SurfaceSoundId, ZoneId, MoodId } from './ids.ts';
import type { Settings } from './settings.ts';

export interface GameEvents {
  footstep: { surface: SurfaceSoundId; intensity: number; foot: 0 | 1; x: number; y: number; z: number; waterDepth: number; settle: boolean };
  land: { surface: SurfaceSoundId; impact: number; x: number; y: number; z: number };
  breath: { rate: number; depth: number }; // sprint fatigue / idle breathing, emitted at 2 Hz while changing
  lightToggle: { lightId: number; on: boolean; x: number; y: number; z: number };
  flashlight: { on: boolean };
  zoneChanged: { from: ZoneId; to: ZoneId; s: StoreyId; mood: MoodId };
  storeyChanged: { from: StoreyId; to: StoreyId; dy: number; via: 'tower' | 'elevator' | 'pit' | 'glitch' };
  transition: { kind: 'tower' | 'elevator' | 'pit' | 'glitch'; phase: 'enter' | 'doorsClosing' | 'ride' | 'switch' | 'doorsOpening' | 'exit'; id: number };
  anomaly: { kind: string; phase: 'start' | 'trigger' | 'end'; x: number; z: number };
  glitch: { seconds: number; strength: number };
  spark: { x: number; y: number; z: number; strength: number }; // SPARKING anomaly burst (visual WP11, crackle WP13)
  /** interact key pressed; propKind = targeted INTERACTABLE_PROPS kind or -1 (nothing within 1.6 m) */
  interact: { propKind: number; x: number; y: number; z: number; yaw: number; seed: number };
  tileLoaded: { key: string };
  tileUnloaded: { key: string };
  chunkLoaded: { key: string };
  chunkUnloaded: { key: string };
  teleport: { s: StoreyId; x: number; y: number; z: number };
  settingsChanged: Settings;
  pause: { paused: boolean };
  ready: { ms: number };
  ui: { name: 'hover' | 'click' | 'open' | 'close' };
}

type Handler<T> = (e: T) => void;

export class EventBus<E extends object> {
  private handlers: { [K in keyof E]?: Handler<E[K]>[] } = {};
  on<K extends keyof E>(k: K, fn: Handler<E[K]>): () => void {
    const list = (this.handlers[k] ??= []);
    list.push(fn);
    return () => {
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    };
  }
  emit<K extends keyof E>(k: K, e: E[K]): void {
    const list = this.handlers[k];
    if (!list) return;
    for (let i = 0; i < list.length; i++) list[i](e);
  }
  clear(): void { this.handlers = {}; }
}

export type GameBus = EventBus<GameEvents>;
export type Emit = <K extends keyof GameEvents>(k: K, e: GameEvents[K]) => void;
```

### 4.18 `src/core/mesh.ts`

Worker payloads.

```ts
// src/core/mesh.ts — worker outputs crossing the worker boundary (all typed arrays are transferable).
// Producer map: surfaces/charts + shell/water meshes: WP5; prop meshes: WP6 via GeometryWriter;
// lightmaps/emission/light volume: WP7; collision: WP12 (pure builder run in the worker).

import type { LmTpc } from './constants.ts';
import type { Vec3 } from './grid.ts';
import type { LightStateId, ValueOf, ZoneId } from './ids.ts';

/** Vertex streams. Shader attribute names: position, normal, uv, brLmUv, brLayer, brFlags, brTint, brEmit, brAux.
 * NEVER name an attribute uv1/uv2 (three declares `attribute vec2 uv1` under USE_UV1). */
export interface MeshBuffers {
  position: Float32Array; // xyz, TILE-LOCAL metres
  normal: Int8Array; // xyzw normalized (w = 0), itemSize 4
  uv: Float32Array; // material uv = tile-local metres / repeat (vertical faces: v = y / layerRepeatY)
  lmUv: Float32Array; // lightmap atlas uv in [0,1] (props: 0,0)
  layer: Uint8Array; // MatId
  flags: Uint8Array; // VFlag bits
  tint: Uint8Array; // rgba8 normalized: rgb albedo tint (emissive colour for lenses), a = variation seed (fixture.seed & 255 on DYN_EMIT/SHIMMER)
  emit: Float32Array; // emissive luminance in nits (0 = none)
  aux: Uint8Array; // u8x4, meaning selected by VFlag.FLOOR_AUX / PROP_AUX
  index: Uint32Array;
  vertexCount: number;
  indexCount: number;
  bounds: [number, number, number, number, number, number]; // tile-local AABB
}

export const ChartKind = { FLOOR_GRID: 0, CEIL_GRID: 1, WALL: 2, STEP: 3, SOFFIT: 4, BOX: 5, PLENUM: 6, RAMP: 7, TRIM_BORROW: 8 } as const;
export type ChartKindId = ValueOf<typeof ChartKind>;

/** One lightmap chart. Texel (u,v) centre = origin + (u+0.5)*axisU + (v+0.5)*axisV (tile-local metres),
 * except FLOOR_GRID/CEIL_GRID where x,z come from that formula and y from the owner cell's floor/ceiling. */
export interface Chart {
  id: number;
  kind: ChartKindId;
  bakeGroup: number;
  x: number; y: number; w: number; h: number; // atlas texel rect INCLUDING the 1-texel apron; LM_PAD gutter lies outside
  origin: Vec3;
  axisU: Vec3; // metres per texel along u
  axisV: Vec3;
  normal: Vec3;
  layer: number; // MatId of the surface (bounce colour, mask profile)
  /** Apron rule: every chart has a 1-texel apron. Bit set => that end CONTINUES into a neighbouring tile's chart
   * (wall run split at a tile boundary, grid charts on all four sides): apron texels are baked at their true
   * positions (seamless bilinear across tiles). Bit clear => apron is filled by dilation.
   * 1: -u end, 2: +u end, 4: -v end, 8: +v end. */
  cont: number;
}

export interface SurfaceSet {
  tileKey: string;
  tpc: LmTpc;
  atlasW: number; // LM_ATLAS_W
  atlasH: number; // 256 | 512 | 768 | 1024
  charts: Chart[];
  hash: number; // FNV over chart rects/origins/axes; build and bake MUST agree (tested)
}

/** Dynamic (flicker-channel) light reference for runtime uniforms. Slot order: (dx,dz) in
 * [(0,0),(-1,0),(1,0),(0,-1),(0,1),(-1,-1),(1,-1),(-1,1),(1,1)] relative to the tile. */
export interface DynLightRef { id: number; state: LightStateId; seed: number; color: Vec3; x: number; y: number; z: number } // world metres
export const DYN_SLOT_OFFSETS: readonly (readonly [number, number])[] = [
  [0, 0], [-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1],
];

export interface TileMesh {
  tileKey: string;
  zone: ZoneId;
  shell: MeshBuffers;
  props: MeshBuffers | null;
  water: MeshBuffers | null;
  decals: MeshBuffers | null; // soft-alpha decals (decal material variant); hard-alpha SIGNAGE/CHALK stays alpha-tested here too
  atlas: { width: number; height: number; tpc: LmTpc; chartHash: number; chartCount: number };
  dynLights: (DynLightRef | null)[]; // length 9, DYN_SLOT_OFFSETS order
  tris: number;
}

export interface LightVolumeData {
  a: Uint16Array; // RGBA16F, LV.NX*LV.NY*LV.NZ: rgb static irradiance (lux), a = AO
  b: Uint8Array; // RGBA8: dominant dir xyz*0.5+0.5, a = directionality
  c: Uint16Array | null; // RGBA16F: per-channel dynamic irradiance luminance (lux)
  /** RGBA8 18x18 (the tile's 16x16 cells + 1-cell ring, index (lj+1)*18 + (li+1)): r = bits N1 E2 S4 W8 of the
   * cell's edges that occlude at y = 1.2 m. The props shader clamps each fragment's LV lookup >= 0.3 m inside its
   * OWN cell on those sides, so trilinear filtering never crosses a wall (any prop size). */
  wallMask: Uint8Array;
}

export interface LightmapData {
  tileKey: string;
  variant: 'preview' | 'full';
  width: number;
  height: number;
  chartHash: number;
  irr: Uint16Array; // RGBA16F: rgb static irradiance (lux; indirect already x AO), a = baked AO
  dir: Uint8Array; // RGBA8, 2 layers stacked (one W x 2H image): layer 0 dominant direction xyz*0.5+0.5 (world),
                   // a = directionality w in [0,1]; layer 1 rg = the indirect gradient (128 + 127 g), ba reserved (128)
  flick: Uint16Array | null; // RGBA16F: channel c = irradiance luminance (lux) of that channel's dynamic light
  mask: Uint8Array; // RGBA8: r stain, g grime, b wetness, a damage
  emission: Uint16Array; // RGBA16F EMISSION.RES^2: rgb emitter radiance (nits, dynamic lights at i = 1),
                          // a = regionKey(nb.region()), NEGATED where the radiance belongs to a dynamic light
  volume: LightVolumeData;
  stats: { ms: number; texels: number; rays: number; lights: number };
}

/** Per-chunk collision acceleration (built by WP12 buildChunkCollision in the worker). Chunk-local metres. */
export interface ChunkCollision {
  chunkKey: string;
  boxes: Float32Array; // n*6: x0,y0,z0,x1,y1,z1 (walls/jambs/posts/solids/props with collide)
  boxFlags: Uint8Array; // n: SolidFlag bits (COLLIDE, WALKABLE_TOP, VIRTUAL)
  cellStart: Uint32Array; // 1025 prefix offsets into cellBoxes
  cellBoxes: Uint32Array; // box indices whose footprint overlaps the cell (expanded by PLAYER.radius)
  ramps: Float32Array; // n*8: x0,z0,x1,z1,y0,y1,dir,filled (1: SolidFlag.FILLED body, solid down to the floor)
}

export function emptyMeshBuffers(): MeshBuffers {
  return {
    position: new Float32Array(0), normal: new Int8Array(0), uv: new Float32Array(0), lmUv: new Float32Array(0),
    layer: new Uint8Array(0), flags: new Uint8Array(0), tint: new Uint8Array(0), emit: new Float32Array(0),
    aux: new Uint8Array(0), index: new Uint32Array(0), vertexCount: 0, indexCount: 0, bounds: [0, 0, 0, 0, 0, 0],
  };
}

export function meshTransferables(m: MeshBuffers | null, out: ArrayBuffer[]): void {
  if (!m) return;
  for (const a of [m.position, m.normal, m.uv, m.lmUv, m.layer, m.flags, m.tint, m.emit, m.aux, m.index]) out.push(a.buffer as ArrayBuffer);
}
```

### 4.19 `src/core/writer.ts`

Fully implemented by WP0.

```ts
// src/core/writer.ts — GeometryWriter: the seam between the architecture mesher (WP5) and prop/fixture/
// structure emitters (WP6). Fully implemented in WP0 (pure, growable typed arrays, no three).
// Usage: w.setState(layer, flags, tint, emit, aux); w.setTransform(yaw, scale, tx, ty, tz);
//        const a = w.vertex(...); ...; w.quad(a, b, c, d); const buf = w.finish();

import type { MeshBuffers } from './mesh.ts';

/** Pack rgba bytes (0..255) into a uint32 (r in the low byte). */
export const packRGBA = (r: number, g: number, b: number, a: number): number =>
  ((r & 255) | ((g & 255) << 8) | ((b & 255) << 16) | ((a & 255) << 24)) >>> 0;
export const WHITE = packRGBA(255, 255, 255, 0);

export class GeometryWriter {
  private cap: number;
  private icap: number;
  private n = 0;
  private ni = 0;
  private pos: Float32Array;
  private nor: Int8Array;
  private uv: Float32Array;
  private lm: Float32Array;
  private layer: Uint8Array;
  private flags: Uint8Array;
  private tint: Uint8Array;
  private emit: Float32Array;
  private aux: Uint8Array;
  private idx: Uint32Array;
  // state
  private sLayer = 0;
  private sFlags = 0;
  private sTint = WHITE;
  private sEmit = 0;
  private sAux = 0;
  // transform: rotation about Y (cos, sin), uniform scale, translation
  private tc = 1;
  private ts = 0;
  private tk = 1;
  private tx = 0;
  private ty = 0;
  private tz = 0;
  private min: [number, number, number] = [Infinity, Infinity, Infinity];
  private max: [number, number, number] = [-Infinity, -Infinity, -Infinity];

  constructor(initialVertices = 4096) {
    this.cap = initialVertices;
    this.icap = initialVertices * 2;
    this.pos = new Float32Array(this.cap * 3);
    this.nor = new Int8Array(this.cap * 4);
    this.uv = new Float32Array(this.cap * 2);
    this.lm = new Float32Array(this.cap * 2);
    this.layer = new Uint8Array(this.cap);
    this.flags = new Uint8Array(this.cap);
    this.tint = new Uint8Array(this.cap * 4);
    this.emit = new Float32Array(this.cap);
    this.aux = new Uint8Array(this.cap * 4);
    this.idx = new Uint32Array(this.icap);
  }

  get vertexCount(): number { return this.n; }
  get indexCount(): number { return this.ni; }

  setState(layer: number, flags: number, tint: number = WHITE, emit = 0, aux = 0): void {
    this.sLayer = layer; this.sFlags = flags; this.sTint = tint; this.sEmit = emit; this.sAux = aux;
  }
  /** Subsequent vertices: p' = R_y(yaw) * (p * scale) + t ; n' = R_y(yaw) * n. yaw 0 = identity. */
  setTransform(yaw: number, scale: number, tx: number, ty: number, tz: number): void {
    this.tc = Math.cos(yaw); this.ts = Math.sin(yaw); this.tk = scale; this.tx = tx; this.ty = ty; this.tz = tz;
  }
  resetTransform(): void { this.setTransform(0, 1, 0, 0, 0); }

  /** Returns the vertex index. (u,v) material uv, (lu,lv) lightmap uv. Normal need not be normalised. */
  vertex(px: number, py: number, pz: number, nx: number, ny: number, nz: number, u: number, v: number, lu = 0, lv = 0): number {
    if (this.n === this.cap) this.growV();
    const i = this.n++;
    const k = this.tk, c = this.tc, s = this.ts;
    // R_y(yaw): x' = c*x + s*z ; z' = -s*x + c*z  (positive yaw turns +X toward -Z, i.e. counter-clockwise from above)
    const x = (c * px + s * pz) * k + this.tx;
    const y = py * k + this.ty;
    const z = (-s * px + c * pz) * k + this.tz;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    const rnx = c * nx + s * nz, rnz = -s * nx + c * nz;
    const len = Math.hypot(rnx, ny, rnz) || 1;
    this.nor[i * 4] = Math.round((rnx / len) * 127);
    this.nor[i * 4 + 1] = Math.round((ny / len) * 127);
    this.nor[i * 4 + 2] = Math.round((rnz / len) * 127);
    this.nor[i * 4 + 3] = 0;
    this.uv[i * 2] = u; this.uv[i * 2 + 1] = v;
    this.lm[i * 2] = lu; this.lm[i * 2 + 1] = lv;
    this.layer[i] = this.sLayer;
    this.flags[i] = this.sFlags;
    const t = this.sTint, a = this.sAux;
    this.tint[i * 4] = t & 255; this.tint[i * 4 + 1] = (t >>> 8) & 255; this.tint[i * 4 + 2] = (t >>> 16) & 255; this.tint[i * 4 + 3] = (t >>> 24) & 255;
    this.aux[i * 4] = a & 255; this.aux[i * 4 + 1] = (a >>> 8) & 255; this.aux[i * 4 + 2] = (a >>> 16) & 255; this.aux[i * 4 + 3] = (a >>> 24) & 255;
    this.emit[i] = this.sEmit;
    if (x < this.min[0]) this.min[0] = x; if (y < this.min[1]) this.min[1] = y; if (z < this.min[2]) this.min[2] = z;
    if (x > this.max[0]) this.max[0] = x; if (y > this.max[1]) this.max[1] = y; if (z > this.max[2]) this.max[2] = z;
    return i;
  }

  /** Counter-clockwise (front face) triangle as seen from the side the normal points to. */
  tri(a: number, b: number, c: number): void {
    if (this.ni + 3 > this.icap) this.growI();
    this.idx[this.ni++] = a; this.idx[this.ni++] = b; this.idx[this.ni++] = c;
  }
  /** Quad a-b-c-d counter-clockwise => triangles (a,b,c) (a,c,d). */
  quad(a: number, b: number, c: number, d: number): void { this.tri(a, b, c); this.tri(a, c, d); }

  finish(): MeshBuffers {
    const n = this.n, ni = this.ni;
    const empty = n === 0;
    return {
      position: this.pos.slice(0, n * 3), normal: this.nor.slice(0, n * 4), uv: this.uv.slice(0, n * 2),
      lmUv: this.lm.slice(0, n * 2), layer: this.layer.slice(0, n), flags: this.flags.slice(0, n),
      tint: this.tint.slice(0, n * 4), emit: this.emit.slice(0, n), aux: this.aux.slice(0, n * 4),
      index: this.idx.slice(0, ni), vertexCount: n, indexCount: ni,
      bounds: empty ? [0, 0, 0, 0, 0, 0] : [this.min[0], this.min[1], this.min[2], this.max[0], this.max[1], this.max[2]],
    };
  }

  private growV(): void {
    const c = this.cap * 2;
    const g = <T extends Float32Array | Int8Array | Uint8Array>(a: T, per: number, make: (n: number) => T): T => {
      const b = make(c * per); b.set(a); return b;
    };
    this.pos = g(this.pos, 3, (k) => new Float32Array(k));
    this.nor = g(this.nor, 4, (k) => new Int8Array(k));
    this.uv = g(this.uv, 2, (k) => new Float32Array(k));
    this.lm = g(this.lm, 2, (k) => new Float32Array(k));
    this.layer = g(this.layer, 1, (k) => new Uint8Array(k));
    this.flags = g(this.flags, 1, (k) => new Uint8Array(k));
    this.tint = g(this.tint, 4, (k) => new Uint8Array(k));
    this.emit = g(this.emit, 1, (k) => new Float32Array(k));
    this.aux = g(this.aux, 4, (k) => new Uint8Array(k));
    this.cap = c;
  }
  private growI(): void {
    const b = new Uint32Array(this.icap * 2); b.set(this.idx); this.idx = b; this.icap *= 2;
  }
}
```

### 4.20 `src/core/worker.ts`

```ts
// src/core/worker.ts — worker protocol. The worker entry (WP10 workers/chunk.worker.ts) is a thin shell around
// the PURE handler `handleRequest(req, state)` (WP10 workers/handler.ts) which also runs in Node tests.

import type { ChunkKey, TileKey } from './grid.ts';
import type { ChunkLayout } from './layout.ts';
import type { ChunkCollision, LightmapData, TileMesh } from './mesh.ts';
import type { BakeQuality } from './quality.ts';
import type { SpawnPoint, WorldGenOptions } from './world.ts';
import type { StoreyId } from './ids.ts';

export type BakeTerm = 'all' | 'direct' | 'indirect'; // debug: bake only one term (leak / cornell QA)

export interface WorkerInit {
  opts: WorldGenOptions;
  bake: BakeQuality;
  bakeTerm: BakeTerm;
  validate: boolean; // dev: run validatePayload before posting
}

export type WorkerRequest =
  | { t: 'init'; job: number; init: WorkerInit }
  | { t: 'layout'; job: number; key: ChunkKey } // -> layout + collision
  | { t: 'build'; job: number; key: TileKey } // -> tile meshes + PREVIEW lightmap (inline, so no tile is ever unlit)
  | { t: 'bake'; job: number; key: TileKey } // -> FULL lightmap (same atlas as build; chartHash must match)
  | { t: 'find'; job: number; query: string; from: { s: StoreyId; x: number; z: number }; maxChunks: number }
  | { t: 'spawn'; job: number; s: StoreyId }
  | { t: 'ascii'; job: number; s: StoreyId; cx0: number; cz0: number; cx1: number; cz1: number };

export type WorkerResponse =
  | { t: 'ready'; job: number }
  | { t: 'layout'; job: number; layout: ChunkLayout /* cloneLayout() of the LRU entry */; collision: ChunkCollision; ms: number }
  | { t: 'build'; job: number; mesh: TileMesh; lightmap: LightmapData; ms: { gen: number; mesh: number; bake: number } }
  | { t: 'bake'; job: number; lightmap: LightmapData; ms: number }
  | { t: 'find'; job: number; result: SpawnPoint | null }
  | { t: 'spawn'; job: number; result: SpawnPoint }
  | { t: 'ascii'; job: number; text: string }
  | { t: 'error'; job: number; message: string; stack: string };

/** `transfer` MUST NOT contain any buffer still referenced by HandlerState (LRU layouts, caches): transfer
 * detaches it. Only freshly built payloads (meshes, lightmaps, collision, cloneLayout copies) are transferred.
 * tests/integration/pipeline.test.ts passes every response through structuredClone(res, { transfer }). */
export interface HandlerResult { res: WorkerResponse; transfer: ArrayBuffer[] }
```

### 4.21 `src/core/player.ts`

```ts
// src/core/player.ts — player state shared by controller (WP12), audio (WP13), lighting (WP11), app/debug (WP14).

import type { StoreyId, SurfaceSoundId } from './ids.ts';

export interface PlayerInput {
  moveX: number; // -1..1 strafe (right +)
  moveZ: number; // -1..1 forward (+)
  lookDX: number; // pixels this frame (already sensitivity-free)
  lookDY: number;
  sprint: boolean;
  crouch: boolean;
  flashlightPressed: boolean; // edge-triggered
  interactPressed: boolean;
}

export interface PlayerState {
  s: StoreyId;
  x: number; y: number; z: number; // feet position, world metres (y storey-relative)
  vx: number; vy: number; vz: number;
  yaw: number; pitch: number;
  crouch: number; // 0 standing .. 1 crouched (smoothed)
  onGround: boolean;
  surface: SurfaceSoundId;
  waterDepth: number; // m of water above feet (0 if dry)
  speed: number; // horizontal m/s
  stridePhase: number; // continuous; footstep at each integer crossing (lowest camera point)
  fatigue: number; // 0..1 (sprint > 10 s raises; drives breathing + sprint speed decay)
  stillFor: number; // seconds without horizontal movement (audio dread gating)
  fly: boolean;
  target: number; // PropKind of the interactable currently targeted (<= 1.6 m, in view), -1 if none (WP14 centre dot)
  // camera rig outputs (world), computed by WP12 CameraRig each frame
  eyeX: number; eyeY: number; eyeZ: number; camYaw: number; camPitch: number; camRoll: number;
}

export function createPlayerState(s: StoreyId, x: number, y: number, z: number, yaw: number, pitch: number): PlayerState {
  return {
    s, x, y, z, vx: 0, vy: 0, vz: 0, yaw, pitch, crouch: 0, onGround: true, surface: 0, waterDepth: 0, speed: 0,
    stridePhase: 0, fatigue: 0, stillFor: 0, fly: false, target: -1, eyeX: x, eyeY: y + 1.62, eyeZ: z, camYaw: yaw, camPitch: pitch, camRoll: 0,
  };
}
```

### 4.22 `src/core/flicker.ts`

A WP0 stub. WP11 replaces the bodies; the signatures are frozen.

```ts
// src/core/flicker.ts — THE pure flicker function shared by lighting uniforms (WP11), panel emissive,
// audio hum/transients (WP13) and QA. OWNERSHIP: WP0 writes this stub; WP11 replaces the bodies
// (signatures frozen). Must be deterministic, frame-rate independent (a pure function of t), allocation-free,
// and honour the photosensitivity mode (see core/settings.ts FlickerMode). Pure: no three, no DOM.

import { DYING_MEAN, LightState } from './ids.ts';
import type { LightStateId } from './ids.ts';
import type { FlickerMode } from './settings.ts';

export interface FlickerSample {
  i: number; // light intensity multiplier in [0, 1.1]
  tint: number; // 0..1 ballast colour shift (pink/green end-glow), used for DYING/FLICKER lenses
  buzz: number; // 0..1 audio buzz level
}

export interface FlickerEvent { t: number; kind: 'tink' | 'strike' | 'pop' | 'off' }

/** Sample light state at absolute time t (seconds). */
export function flicker(state: LightStateId, seed: number, t: number, mode: FlickerMode, out: FlickerSample): void {
  void seed; void t; void mode;
  out.i = state === LightState.OFF ? 0 : state === LightState.DYING ? DYING_MEAN : 1;
  out.tint = 0;
  out.buzz = state === LightState.OFF ? 0 : 0.3;
}

/** Append transient events with time in (t0, t1] to `out`; returns the number appended.
 * Used by audio to schedule sample-aligned tink/strike/pop ~30 ms ahead. Must agree with flicker(). */
export function flickerEvents(state: LightStateId, seed: number, t0: number, t1: number, mode: FlickerMode, out: FlickerEvent[]): number {
  void state; void seed; void t0; void t1; void mode; void out;
  return 0;
}

/** Emissive-only shimmer multiplier for SHIMMER lenses (DYING: 0.5-2 Hz +-10% with dropouts; BUZZ: +-3% at 120 Hz).
 * Uses ONLY the low 8 bits of `seed` (vertices carry tint.a = seed & 255) so CPU and GPU agree bit-for-bit in
 * structure. Must equal LENS_SHIMMER_GLSL's brLensShimmer(state, float(seed & 255), t, modeIndex) within 1e-3. */
export function lensShimmer(state: LightStateId, seed: number, t: number, mode: FlickerMode): number {
  void state; void seed; void t; void mode;
  return 1;
}

/** GLSL twin of lensShimmer, owned by WP11 (implemented together with the TS version), injected verbatim by WP9.
 * Signature frozen: state = LightState (from aux.w), seed8 = tint.a * 255, mode 0 standard / 1 reduced / 2 off.
 * Only float/int arithmetic and hash-by-fract (no textures, no uniforms). */
export const LENS_SHIMMER_GLSL: string = `
float brLensShimmer(int state, float seed8, float t, int mode) { return 1.0; }
`;

/** Mean intensity of a state (used to bake overflow/static states and for mode 'off'). */
export function flickerMean(state: LightStateId): number {
  return state === LightState.OFF ? 0 : state === LightState.DYING ? DYING_MEAN : state === LightState.FLICKER ? 0.8 : 1;
}
```

### 4.23 `src/core/debug.ts`

```ts
// src/core/debug.ts — automation contract: URL launch params and window.__backrooms (installed by WP14).
// tools/shoot.mjs appends `autostart=1` and waits for window.__backrooms.ready === true (60 s timeout).

import type { QualityName } from './quality.ts';
import type { FlickerMode } from './settings.ts';
import type { MoodId, StoreyId, ZoneId, LandmarkKindId } from './ids.ts';
import type { SpawnPoint, TestSceneId } from './world.ts';
import type { BakeTerm } from './worker.ts';

/** Parsed URL params (WP14 app/urlParams.ts: pure, never throws; bad values -> warnings + defaults). */
export interface LaunchParams {
  seedText: string; // 'seed' (default: settings.lastSeed || random 'NNNN-NNNN')
  autostart: boolean;
  s: StoreyId | null; x: number | null; y: number | null; z: number | null; // 's' = storey
  yaw: number | null; pitch: number | null; // radians ('yawDeg' also accepted)
  fov: number | null;
  goto: string | null; // 'zone:NAME' | 'landmark:NAME' | 'vignette:NAME' | 'tower' | 'elevator' | 'dark' | 'water' | 'flicker' | 'spawn'
  zone: ZoneId | null; // shorthand for goto=zone:NAME
  forceZone: ZoneId | null; // every district becomes this zone
  forceMood: MoodId | null;
  forceLandmark: LandmarkKindId | null;
  testScene: TestSceneId | null;
  quality: QualityName | 'auto' | null;
  scale: number | null; // render scale override
  radius: number | null; // stream radius override (chunks)
  view: string; // DEBUG_VIEW_NAMES entry, default 'final'
  time: number | null; // freeze simulation clock at t (flicker, grain, water, bob) + snap exposure
  freeze: boolean; // freeze clock at its value when ready
  exposure: number | 'auto'; // EV100 lock
  flashlight: boolean;
  fly: boolean;
  audio: boolean; // 'noaudio=1' => false
  post: boolean; // 'nopost=1' => false
  ao: boolean; bloom: boolean; grain: boolean; lens: boolean; // 'ao=0' etc.
  flicker: FlickerMode | null;
  lights: 'default' | 'on' | 'dead';
  bake: 'preview' | 'full'; // ready requires full (default) or preview bakes in radius 1
  bakeTerm: BakeTerm;
  camcorder: boolean;
  hud: boolean;
  debug: boolean; // F3 overlay on
  warnings: string[];
}

export interface ImageStats {
  width: number; height: number; // readback size (160x90 unless rect given)
  meanLum: number; p5: number; p50: number; p95: number; // display-referred luma 0..1
  clipped: number; black: number; // fractions (>0.98, <0.02)
  meanRGB: [number, number, number];
  hueDeg: number; sat: number; // of meanRGB
  grid3x3: number[]; // mean luma per third
}

export interface PerfReport {
  seconds: number; frames: number; fps: number;
  frameMs: { avg: number; p50: number; p95: number; p99: number; max: number };
  gpuMs: number | null; // EXT_disjoint_timer_query_webgl2 if present (usually null in Chromium)
  drawCalls: number; triangles: number;
}

export interface AutowalkReport {
  distance: number; seconds: number; footsteps: number; storeyChanges: number;
  frameMsMax5s: number; geometriesStart: number; geometriesEnd: number; texturesStart: number; texturesEnd: number;
  errors: number; stuck: boolean;
}

export interface CellInfo {
  s: StoreyId; gi: number; gj: number; chunk: [number, number]; tile: number; zone: string; mood: string;
  flags: number; floorY: number; ceilY: number; waterY: number | null; room: number;
  power: number; decay: number; humidity: number; warmth: number;
  edges: { W: string; N: string; E: string; S: string };
}

export interface LayerAlbedoReport { layer: number; name: string; measured: [number, number, number]; declared: [number, number, number]; ok: boolean }

export interface DebugStats {
  version: string; seed: string; quality: QualityName; renderScale: number; readyPhase: string; ready: boolean;
  fps: number; frameMs: { avg: number; p95: number; max: number; max5s: number }; cpuMs: number; gpuMs: number | null;
  render: { drawCalls: number; triangles: number; programs: number; textures: number; texturesPooled: number; geometries: number };
  chunks: { resident: number; desired: number; layoutsPending: number };
  tiles: { resident: number; preview: number; full: number; queued: number; inFlight: number; uploadsPending: number; fadingIn: number };
  workers: { count: number; busy: number };
  bake: { lastMs: number; avgMs: number; buildAvgMs: number };
  player: {
    s: StoreyId; x: number; y: number; z: number; yaw: number; pitch: number; zone: string; mood: string;
    surface: string; cell: [number, number]; chunk: [number, number]; onGround: boolean; fly: boolean;
  };
  exposure: { ev100: number; value: number; locked: boolean };
  lights: { dynamicResident: number; flickerMode: FlickerMode };
  audio: { state: string; voices: number; rt60: number } | null;
  timeFrozen: boolean;
  warnings: string[];
  errors: string[];
}

export interface TeleportTarget { x: number; z: number; y?: number; s?: StoreyId; yaw?: number; pitch?: number }

export interface BackroomsDebugAPI {
  ready: boolean;
  isReady(): boolean;
  readyPhase: string; // 'boot'|'textures'|'shaders'|'spawn'|'chunks'|'bake'|'frames'|'ready'
  version: string;
  seed: string;
  stats(): DebugStats;
  /** Resolves when the target is ready again (radius-1 tiles baked per `bake` param) + 10 frames. */
  teleport(t: TeleportTarget): Promise<void>;
  goto(target: string): Promise<boolean>;
  look(yaw: number, pitch: number): void;
  setQuality(q: QualityName): Promise<void>;
  setView(v: string): void;
  setTime(t: number | null): void;
  setExposure(ev100: number | null): void;
  setFlashlight(on: boolean): void;
  setPost(p: Partial<Record<'ao' | 'bloom' | 'lens' | 'grain' | 'smaa' | 'exposure' | 'grade', boolean>>): void;
  setFlicker(mode: FlickerMode): void;
  waitForIdle(timeoutMs?: number): Promise<boolean>; // no queued/in-flight jobs, no pending uploads
  cellAt(x: number, z: number): CellInfo | null;
  zoneAt(x: number, z: number): string;
  findNearest(query: string, maxChunks?: number): Promise<SpawnPoint | null>;
  ascii(radiusCells?: number): string; // resident layouts around the player
  gen: {
    asciiMap(s: StoreyId, cx0: number, cz0: number, cx1: number, cz1: number): Promise<string>;
    districtAt(s: StoreyId, cx: number, cz: number): { id: number; zone: string; mood: string };
  };
  perf(seconds: number): Promise<PerfReport>;
  imageStats(rect?: [number, number, number, number]): Promise<ImageStats>; // rect in 0..1 screen fractions
  autowalk(o: { distance: number; speed?: number; seed?: number }): Promise<AutowalkReport>;
  walk(path: { x: number; z: number }[], speed?: number): Promise<{ footsteps: number; ms: number }>;
  layerAlbedoCheck(): Promise<LayerAlbedoReport[]>;
  audio: { stats(): { state: string; voices: number; rt60: number; ir: number }; recentEvents(): string[] };
  events(): string[]; // last 200 GameEvents + worker errors, stringified
}

/** Minimal surface set by the harness pages (§7.3); shoot.mjs only needs ready/isReady/stats. */
export interface HarnessDebugAPI {
  ready: boolean;
  isReady(): boolean;
  stats(): unknown;
  layerAlbedoCheck?(): Promise<LayerAlbedoReport[]>;
}

declare global {
  interface Window { __backrooms?: BackroomsDebugAPI | HarnessDebugAPI }
}
```

### 4.24 `src/core/runtime.ts`

Main-thread system interfaces (type-only three).

```ts
// src/core/runtime.ts — main-thread system interfaces. The ONLY core file allowed to reference three,
// and only via `import type` (erased at runtime; pure modules may import these types).

import type * as THREE from 'three';
import type { ChunkKey, TileKey } from './grid.ts';
import type { MoodId, PropKindId, StoreyId, SurfaceSoundId, ZoneId } from './ids.ts';
import type { ChunkLayout, Fixture, PortalSpec, AudioEmitterSpec } from './layout.ts';
import type { DynLightRef, MeshBuffers } from './mesh.ts';
import type { PlayerInput, PlayerState } from './player.ts';
import type { QualityConfig } from './quality.ts';
import type { FlickerMode, Settings } from './settings.ts';
import type { GameBus } from './events.ts';
import type { SpawnPoint } from './world.ts';

// ---------------------------------------------------------------- textures (WP8 -> WP9)
export interface TextureSet {
  size: 512 | 1024;
  albedo: THREE.Texture; // sampler2DArray, SRGB8_ALPHA8 (a = decal/sign alpha), mipmapped
  normal: THREE.Texture; // sampler2DArray RGBA8: xyz tangent normal *0.5+0.5, a = height
  ormh: THREE.Texture; // sampler2DArray RGBA8: r AO(cavity), g roughness, b metal, a emissive mask
  grime: THREE.Texture; // 512^2 tileable RGBA8: r tide/stain rings, g speckle/mould, b scuff, a drip streaks
  waterNormals: THREE.Texture; // 512^2 tileable RG normal
  cookie: THREE.Texture; // 512^2 RGBA16F flashlight cookie (package F)
  dispose(): void;
}

// ---------------------------------------------------------------- atmosphere (WP11 table, WP9/WP11 consumers)
export interface ColorGrade {
  temperature: number; tint: number; saturation: number; contrast: number;
  lift: [number, number, number]; gamma: [number, number, number]; gain: [number, number, number];
  shadowTint: [number, number, number]; highlightTint: [number, number, number];
}
export interface AtmosphereParams {
  hazeDensity: number; // 1/m, exponential
  hazeTint: [number, number, number]; // linear multiplier on local-irradiance inscatter
  hazeAlbedo: number; // scattering albedo (inscatter = E * albedo / PI * tint)
  ev100Range: [number, number]; // exposure clamp; dark sectors must stay dark
  exposureBias: number; // EV
  bloomIntensity: number;
  aoIntensity: number;
  aoColor: [number, number, number];
  grain: number;
  grade: ColorGrade;
}
/** Blended per frame at the camera (1.5 s crossfade). */
export interface AtmosphereState extends AtmosphereParams {
  camIrradiance: [number, number, number]; // lux, sampled from the tile light volume at the camera
  edgeFog: [number, number]; // start/end metres of the streaming-edge fog (EDGE_FOG.START*R, EDGE_FOG.END*R; R = streamRadius*CHUNK_SIZE)
}

// ---------------------------------------------------------------- materials (WP9)
export interface MaterialGlobals {
  time: { value: number };
  debugView: { value: number };
  hazeDensity: { value: number };
  hazeTint: { value: THREE.Color };
  hazeAlbedo: { value: number };
  edgeFog: { value: THREE.Vector2 };
  farColor: { value: THREE.Color }; // edge-fog / clear colour (== camera inscatter colour)
  flickerMode: { value: number }; // 0 standard 1 reduced 2 off (GLSL shimmer twin)
  reflTex: { value: THREE.Texture | null };
  reflMatrix: { value: THREE.Matrix4 };
  reflOn: { value: number };
  floorReflOn: { value: number };
}
/** Every per-tile binding is a uniform object. WP9 puts THESE EXACT objects into shader.uniforms (in
 * onBeforeCompile); WP10/WP11 update them only by assigning `.value` (never by replacing the object). */
export interface TileBindings {
  tileOrigin: { value: THREE.Vector3 }; // world metres
  noiseOrigin: { value: THREE.Vector3 }; // tileOrigin mod NOISE_WRAP
  lmIrr: { value: THREE.Texture }; lmDir: { value: THREE.Texture }; lmMask: { value: THREE.Texture };
  lmFlick: { value: THREE.Texture }; // shared zero texture if none
  emission: { value: THREE.Texture };
  volA: { value: THREE.Texture }; volB: { value: THREE.Texture }; volC: { value: THREE.Texture }; // Data3DTexture (volC shared zero if none)
  volMask: { value: THREE.Texture }; // 18x18 RGBA8 LightVolumeData.wallMask
  flick: { value: Float32Array }; // 9 x vec3: DYN_SLOT_OFFSETS order; rgb = color/luma(color) * intensity(t)
  ownParity: { value: THREE.Vector2 }; // (gtx & 1, gtz & 1)
  fade: { value: number }; // 0..1 dithered fade-in
}
export interface TileMaterials {
  shell: THREE.MeshStandardMaterial;
  props: THREE.MeshStandardMaterial;
  decal: THREE.MeshStandardMaterial; // 'decal' variant: premultiplied soft alpha, depthWrite off, polygonOffset
  water: THREE.Material | null;
  bindings: TileBindings;
  dispose(): void; // materials only; textures belong to the TexturePool (WP10)
}
export interface MaterialSystem {
  readonly globals: MaterialGlobals;
  /** Factory: fresh materials + fresh uniform objects per tile. NEVER Material.clone(). */
  createTileMaterials(withWater: boolean): TileMaterials;
  setDebugView(v: number): void;
  setQuality(q: QualityConfig): void; // defines that change programs are applied here only, then warmup again
  zeroTextures: { lm2d: THREE.Texture; vol3d: THREE.Texture };
  /** Compiles AND draws every variant (shell, props, decal, water) into a HalfFloat target with the real scene's
   * light/shadow state (flashlight present), and pins one material per variant for the app's lifetime. */
  warmup(renderer: THREE.WebGLRenderer, camera: THREE.Camera, scene: THREE.Scene): Promise<void>;
}

// ---------------------------------------------------------------- streaming (WP10)
export type TileLifecycle = 'queued' | 'building' | 'received' | 'texUpload' | 'geoUpload' | 'fadingIn' | 'resident' | 'evicting' | 'disposed';
export interface TileRuntime {
  key: TileKey;
  keyStr: string;
  zone: ZoneId;
  group: THREE.Group; // position = tile origin; children: shell, props (optional), water (optional)
  materials: TileMaterials;
  dynLights: (DynLightRef | null)[]; // 9 slots
  bake: 'preview' | 'full';
  state: TileLifecycle;
  visible: boolean; // frustum result from last frame
}
export interface FixtureRef { f: Fixture; wx: number; wy: number; wz: number; tileKey: string }
export interface EmitterRef { e: AudioEmitterSpec; wx: number; wy: number; wz: number }
export interface PortalHit { spec: PortalSpec; ox: number; oz: number } // ox/oz: chunk origin (world)
export interface PropHit { kind: PropKindId; x: number; y: number; z: number; seed: number; cx: number; cz: number } // world metres
export interface DynamicMeshHandle { setOffset(x: number, y: number, z: number): void; dispose(): void }

export interface CollisionWorld {
  readonly storey: StoreyId;
  isLoaded(x: number, z: number): boolean; // unloaded cells are SOLID for collision
  floorAt(x: number, z: number, feetY: number): number; // highest walkable surface <= feetY + stepMax; NaN if unloaded
  ceilingAt(x: number, z: number, y: number): number; // lowest ceiling/overhang above y
  waterAt(x: number, z: number): number | null; // water surface y
  surfaceAt(x: number, z: number, y: number): SurfaceSoundId;
  /** world AABBs (6 floats each) whose footprint intersects the circle; returns count */
  boxesNear(x: number, z: number, r: number, out: Float32Array): number;
  portalAt(x: number, y: number, z: number): PortalHit | null;
  /** portals (layout.structures) whose trigger footprint comes within r of (x,z); returns count written to out */
  portalsNear(x: number, z: number, r: number, out: PortalHit[]): number;
  /** nearest INTERACTABLE_PROPS prop whose footprint the horizontal ray from (x,z) along yaw hits within maxDist */
  propAt(x: number, z: number, yaw: number, maxDist: number): PropHit | null;
}
export interface WorldQuery extends CollisionWorld {
  layoutAt(cx: number, cz: number): ChunkLayout | null;
  /** cellZone of the cell at (x,z) (NOT layout.zone). WP11 atmosphere and WP13 ambience use this. */
  zoneAt(x: number, z: number): ZoneId;
  /** layout.mood, except NORMAL in TOWER/ELEVATOR cells. */
  moodAt(x: number, z: number): MoodId;
  fixturesNear(x: number, z: number, r: number, out: FixtureRef[]): number;
  emittersNear(x: number, z: number, r: number, out: EmitterRef[]): number;
  /** 2.5D line of sight using core/edges semantics (walls, partitions by height, SOLID cells, blockCm). */
  losClear(ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean;
  /** Distance to the first occluder along a horizontal ray at height y (capped at maxDist). */
  rayDistance(x: number, y: number, z: number, dx: number, dz: number, maxDist: number): number;
  /** Package F: 3D ray (unit direction) against the 2.5D world plus collision boxes; true on a hit within maxDist,
   * with the distance, surface normal and albedo written to out. */
  raycast?(x: number, y: number, z: number, dx: number, dy: number, dz: number, maxDist: number, out: RaycastHit): boolean;
  /** audio passability of the edge between global cells: 'x' = line x=gi between (gi-1,gj)|(gi,gj). 0..1 */
  edgeSound(axis: 'x' | 'z', gi: number, gj: number): number;
  cellWalkable(gi: number, gj: number): boolean;
}
export interface StreamStats {
  chunksResident: number; chunksDesired: number; layoutsPending: number;
  tilesResident: number; tilesPreview: number; tilesFull: number; queued: number; inFlight: number;
  uploadsPending: number; fadingIn: number; workers: number; workersBusy: number; texturesPooled: number;
  bakeLastMs: number; bakeAvgMs: number; buildAvgMs: number;
}
export interface WorldStreamer {
  readonly storey: StoreyId;
  /** Always the data set (layouts + collision) of `storey`; layouts are held per storey and switchStorey swaps
   * which set `query` reads in the same call. */
  readonly query: WorldQuery;
  readonly scene: THREE.Group; // add to the main scene once
  /** desired set around (x,z) + smoothed velocity * EDGE_FOG.LOOKAHEAD_S (velocity estimated from successive
   * calls; teleports reset it); priorities (ring, frustum); dispatch; eviction. No uploads here. */
  update(x: number, z: number, viewX: number, viewZ: number, camera: THREE.Camera, frame: number): void;
  /** at most UPLOAD.MAX_STEPS_PER_FRAME residency step(s) within budgetMs (texture step, then geometry step),
   * plus UPLOAD.PREFETCH_STEPS_PER_FRAME step(s) for prefetch groups */
  processUploads(renderer: THREE.WebGLRenderer, budgetMs: number): void;
  tiles(): Iterable<TileRuntime>;
  /** For storey s around (x,z): `layout` jobs for the (2r+1)^2 chunks (registered in storey s's query data) +
   * build/bake/upload of their tiles into s's hidden group. Idempotent; repeated calls refresh a keep-alive. */
  prefetch(s: StoreyId, x: number, z: number, radiusChunks: number): void;
  /** true when, in storey s, the layouts + collision of the chunk containing (x,z) and its 8 neighbours are
   * loaded (chunkLoaded), all their tiles are uploaded (preview is enough), and the tiles of the chunk containing
   * (x,z) are full-baked (so the tower/elevator interior matches the current storey exactly) */
  isPrefetched(s: StoreyId, x: number, z: number): boolean;
  /** instant swap (same frame): group visibility AND `query` data set; evicts the old storey progressively */
  switchStorey(to: StoreyId): void;
  /** WP12 elevator doors: a mesh drawn with the tile's props material inside the tile's group (tile-local
   * vertices). null if the tile is not resident. The handle is disposed automatically on eviction. */
  attachDynamicMesh(tileKey: string, m: MeshBuffers): DynamicMeshHandle | null;
  isReady(radiusChunks: number, needFull: boolean): boolean;
  isIdle(): boolean;
  /** radius change: re-desire; BakeQuality change: await pool.reinit(init) then rebuild everything */
  setQuality(q: QualityConfig): Promise<void>;
  findNearest(query: string, from: { s: StoreyId; x: number; z: number }, maxChunks: number): Promise<SpawnPoint | null>;
  spawn(s: StoreyId): Promise<SpawnPoint>;
  asciiMap(s: StoreyId, cx0: number, cz0: number, cx1: number, cz1: number): Promise<string>;
  chunkLoaded(k: ChunkKey): boolean;
  stats(): StreamStats;
  dispose(): void;
}

// ---------------------------------------------------------------- lighting runtime + post (WP11)
export interface Flashlight {
  readonly light: THREE.SpotLight; // ALWAYS in the scene, castShadow ALWAYS true; off = intensity 0
  on: boolean;
  set(on: boolean): void;
  update(player: PlayerState, camera: THREE.Camera, dt: number): void;
}
export interface LightingRuntime {
  readonly flashlight: Flashlight;
  /** evaluate flicker for all resident tiles' dynamic lights; write TileBindings.flick; emit lightToggle */
  update(t: number, dt: number, tiles: Iterable<TileRuntime>, player: PlayerState, camera: THREE.Camera, world: WorldQuery): void;
  intensityOf(lightId: number): number; // current multiplier (1 for static ON lights)
  /** ANOMALY-state lights: force an intensity multiplier (null = release to the default). Used by the director. */
  setOverride(lightId: number, intensity: number | null): void;
  atmosphere(): AtmosphereState;
  setFlickerMode(m: FlickerMode): void;
  setQuality(q: QualityConfig): void;
}
export interface PostStack {
  /** realDt drives exposure adaptation; t = SIMULATION time (frozen under time=): grain frame = floor(t * 24),
   * glitch and camcorder noise also derive from t, so captures are deterministic. */
  render(realDt: number, t: number): void;
  setSize(w: number, h: number): void;
  setQuality(q: QualityConfig): void;
  setAtmosphere(a: AtmosphereState): void;
  setFilm(f: Settings['film'], brightnessEV: number): void;
  setEnabled(p: Partial<Record<'ao' | 'bloom' | 'lens' | 'grain' | 'smaa' | 'exposure' | 'grade', boolean>>): void;
  setExposureLock(ev100: number | null): void;
  snapExposure(): void;
  glitch(seconds: number, strength: number): void;
  setPaused(p: boolean): void;
  /** Resolves after the next rendered frame with the final display-referred image downsampled to w x h RGBA8 (sRGB). */
  capture(w: number, h: number): Promise<Uint8Array>;
  readonly exposure: { ev100: number; value: number; locked: boolean };
  readonly renderScale: number;
  dispose(): void;
}

// ---------------------------------------------------------------- player (WP12)
export interface PlayerSystem {
  readonly state: PlayerState;
  /** fixed 120 Hz internally; interpolated camera rig output written into state.eyeX..camRoll */
  update(dt: number, input: PlayerInput, world: CollisionWorld, bus: GameBus, frozenTime: boolean): void;
  teleport(s: StoreyId, x: number, y: number | null, z: number, yaw: number, pitch: number): void;
  applyToCamera(camera: THREE.PerspectiveCamera, fovDeg: number): void;
  setFly(on: boolean): void;
}
export interface InputSource {
  poll(out: PlayerInput): void;
  lock(): void;
  readonly locked: boolean;
  dispose(): void;
}

// ---------------------------------------------------------------- audio (WP13)
export interface AudioStats { state: string; voices: number; rt60: number; ir: number }
export interface AudioSystem {
  start(): Promise<void>; // create/resume AudioContext (gesture or autostart)
  update(t: number, dt: number, player: PlayerState, world: WorldQuery, lighting: LightingRuntime): void;
  setVolumes(v: Settings['volume']): void;
  setFlickerMode(m: FlickerMode): void;
  setPaused(p: boolean): void;
  stats(): AudioStats;
  recentEvents(): string[];
  dispose(): void;
}

// ---------------------------------------------------------------- frame context (WP14)
export interface FrameContext {
  t: number; // simulation time (frozen by time=/freeze=)
  dt: number; // simulation dt (0 when frozen)
  realDt: number;
  frame: number;
  quality: QualityConfig;
  settings: Settings;
  player: PlayerState;
  camera: THREE.PerspectiveCamera;
}
```

### 4.25 `src/types/n8ao.d.ts`

```ts
// src/types/n8ao.d.ts — n8ao 2.0.1 ships no typings. Only the surface we use.
declare module 'n8ao' {
  import type { Camera, Color, Scene, Texture, WebGLRenderer, WebGLRenderTarget } from 'three';
  import { Pass } from 'postprocessing';

  export interface N8AOConfiguration {
    aoSamples: number;
    aoRadius: number;
    aoTones: number;
    denoiseSamples: number;
    denoiseRadius: number;
    distanceFalloff: number;
    intensity: number;
    denoiseIterations: number;
    renderMode: 0 | 1 | 2 | 3 | 4;
    color: Color;
    gammaCorrection: boolean;
    screenSpaceRadius: boolean;
    halfRes: boolean;
    depthAwareUpsampling: boolean;
    colorMultiply: boolean;
    transparencyAware: boolean;
    accumulate: boolean;
    neuralDenoise: boolean;
  }

  export class N8AOPostPass extends Pass {
    constructor(scene: Scene, camera: Camera, width?: number, height?: number);
    configuration: N8AOConfiguration;
    /** Public field; set to false to stop the per-frame scene.traverse transparency detection. */
    autoDetectTransparency: boolean;
    autosetGamma: boolean;
    setQualityMode(mode: 'Performance' | 'Low' | 'Medium' | 'High' | 'Ultra' | 'Neural-Low' | 'Neural-Medium' | 'Neural-High'): void;
    setDisplayMode(mode: 'Combined' | 'AO' | 'No AO' | 'Split' | 'Split AO'): void;
    setSize(width: number, height: number): void;
    setDepthTexture(depthTexture: Texture): void;
    render(renderer: WebGLRenderer, inputBuffer: WebGLRenderTarget, outputBuffer: WebGLRenderTarget): void;
    dispose(): void;
  }
}
```

### 4.26 Tests that WP0 ships (verbatim)

`tests/core/invariants.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { CELL, CHUNK_CELLS, CHUNK_SIZE, LIGHT, LM_TPC_ALLOWED, REGION_MASK, STOREY_PITCH, TILE_CELLS, TILE_SIZE, WALL_T, lmTexel, regionKey } from '../../src/core/constants.ts';
import { LAYER_DEFS, TOWER_LAYERS, layerRepeatY } from '../../src/core/materials.ts';
import { EdgeKind, LANDMARK_COUNT, LANDMARK_NAMES, MAT_COUNT, PROP_KIND_COUNT, ZONE_COUNT } from '../../src/core/ids.ts';
import { EDGE_OCCLUDES, edgeBaseThickness } from '../../src/core/edges.ts';
import { cellToChunk, tileKeyAt, tileOfLocalCell, worldToCell, worldToChunk } from '../../src/core/grid.ts';
import { PROP_DEFS } from '../../src/core/props.ts';
import { ZONE_INFO, STRATA_WEIGHTS } from '../../src/core/zones.ts';
import { QUALITY, QUALITY_NAMES } from '../../src/core/quality.ts';
import { hash3, hashN, Rng } from '../../src/core/rng.ts';
import { fromHalf, toHalf } from '../../src/core/half.ts';

const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;
describe('core invariants', () => {
  it('grid sizes are consistent', () => {
    expect(near(CELL * CHUNK_CELLS, CHUNK_SIZE)).toBe(true);
    expect(near(CELL * TILE_CELLS, TILE_SIZE)).toBe(true);
    expect(LIGHT.R_DYN).toBeLessThan(TILE_SIZE / 2);
  });
  it('no-leak invariant: every occluding edge kind is at least one texel thick at floor level', () => {
    for (const t of LM_TPC_ALLOWED) expect(lmTexel(t)).toBeLessThanOrEqual(WALL_T + 1e-9);
    for (const k of Object.values(EdgeKind)) {
      if (!EDGE_OCCLUDES[k]) continue;
      for (const t of LM_TPC_ALLOWED) expect(edgeBaseThickness(k)).toBeGreaterThanOrEqual(lmTexel(t) - 1e-9);
    }
    for (const q of QUALITY_NAMES) expect(LM_TPC_ALLOWED as readonly number[]).toContain(QUALITY[q].lmTpc);
  });
  it('material repeats divide the tile size; tower layers are storey-periodic', () => {
    expect(LAYER_DEFS.length).toBe(MAT_COUNT);
    const isInt = (v: number) => Math.abs(v - Math.round(v)) < 1e-6;
    LAYER_DEFS.forEach((d, i) => {
      expect(d.id).toBe(i);
      expect(isInt(TILE_SIZE / d.repeat)).toBe(true);
    });
    for (const m of TOWER_LAYERS) expect(isInt(STOREY_PITCH / layerRepeatY(LAYER_DEFS[m]))).toBe(true);
  });
  it('grid rounding is consistent at chunk and tile boundaries', () => {
    for (let k = -2000; k <= 2000; k++) {
      for (const d of [-1e-6, 0, 1e-6]) {
        for (const base of [k * CHUNK_SIZE, k * TILE_SIZE, k * CELL]) {
          const x = base + d;
          const gi = worldToCell(x), cx = worldToChunk(x), li = gi - cx * CHUNK_CELLS;
          expect(cx).toBe(cellToChunk(gi));
          expect(li >= 0 && li < CHUNK_CELLS).toBe(true);
          const t = tileKeyAt(0, x, x);
          expect(t.cx).toBe(cx);
          expect(t.q).toBe(tileOfLocalCell(li, li));
        }
      }
    }
  });
  it('region keys fit the packed range', () => {
    expect(regionKey(0)).toBe(0);
    for (const r of [1, 2, 2047, 2048, 2049, 9216]) {
      expect(regionKey(r)).toBeGreaterThanOrEqual(1);
      expect(regionKey(r)).toBeLessThanOrEqual(REGION_MASK + 1);
    }
  });
  it('tables are complete', () => {
    expect(PROP_DEFS.length).toBe(PROP_KIND_COUNT);
    PROP_DEFS.forEach((d, i) => expect(d.kind).toBe(i));
    expect(ZONE_INFO.length).toBe(ZONE_COUNT);
    ZONE_INFO.forEach((z, i) => expect(z.id).toBe(i));
    for (const s of [0, 1, 2] as const) expect(STRATA_WEIGHTS[s].length).toBe(ZONE_COUNT);
    expect(LANDMARK_NAMES.length).toBe(LANDMARK_COUNT);
  });
  it('hash/rng determinism', () => {
    expect(hash3(1, 2, 3)).toBe(hashN(1, 2, 3));
    const a = new Rng(42), b = new Rng(42);
    for (let i = 0; i < 1000; i++) expect(a.next()).toBe(b.next());
  });
  it('half round trip', () => {
    for (const v of [0, 1e-3, 0.5, 1, 326.7, 3300, 65504]) expect(Math.abs(fromHalf(toHalf(v)) - v)).toBeLessThanOrEqual(v * 1e-3 + 1e-6);
  });
});
```

`tests/arch/imports.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const PURE_DIRS = ['src/core', 'src/world', 'src/mesh', 'src/props', 'src/bake', 'src/workers', 'src/audio/dsp'];
const PURE_FILES = ['src/player/controller.ts', 'src/player/collision.ts', 'src/player/collisionBuild.ts', 'src/player/headBob.ts',
  'src/audio/propagation.ts', 'src/audio/roomProbe.ts', 'src/app/urlParams.ts'];
const TYPE_ONLY_THREE_ALLOWED = new Set(['src/core/runtime.ts']);

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out); else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}
const files = [...PURE_DIRS.flatMap((d) => walk(d)), ...PURE_FILES.filter(existsSync)];

describe('architecture rules', () => {
  it('pure modules do not import three/postprocessing/n8ao or touch the DOM', () => {
    const bad: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      const importsThree = /from\s+['"](three|postprocessing|n8ao)(\/[^'"]*)?['"]/.test(src);
      const typeOnly = /import\s+type\s[^;]*from\s+['"]three['"]/.test(src) && !/import\s+(?!type)[^;]*from\s+['"]three['"]/.test(src);
      if (importsThree && !(TYPE_ONLY_THREE_ALLOWED.has(f) && typeOnly)) bad.push(`${f}: imports three/post/n8ao`);
      if (/\b(window|document|localStorage|requestAnimationFrame)\s*[.(]/.test(src)) bad.push(`${f}: DOM access`);
      if (/Math\.random\s*\(|Date\.now\s*\(|new Date\s*\(|performance\.now\s*\(/.test(src) && !f.startsWith('src/workers') && !f.includes('bake/index')) bad.push(`${f}: nondeterminism`);
    }
    expect(bad).toEqual([]);
  });
  it('relative imports use .ts extensions (node type stripping)', () => {
    const bad: string[] = [];
    for (const f of walk('src')) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(/from\s+['"](\.{1,2}\/[^'"]+)['"]/g)) if (!/\.(ts|css|json|glsl)$/.test(m[1]) && !m[1].includes('?')) bad.push(`${f}: ${m[1]}`);
    }
    expect(bad).toEqual([]);
  });
});
```


## 5. Work-package specifications

**Common rules for every WP.**

Definition of done:
- `npm run typecheck` is clean.
- `npm test` passes, including the WP's own tests and `tests/arch`.
- Every WP0 stub in the WP's files has been replaced **with its signature unchanged**.
- Evidence is attached to the WP's final report: harness screenshot, `tools/map.ts` output, or bench numbers.
- No edits outside the WP's owned files.

Other rules:
- Contract changes are additive and go through the WP's own `docs/contract-changes/WP<n>.md` (never another WP's file).
- Hot paths (anything called every frame, and bake inner loops) do not allocate.
- Tests live in `tests/<area>/`.
- **Must NOT touch (applies to every WP):** `src/core/*` (WP0 only; WP11 owns `src/core/flicker.ts`), and other WPs' files. Each WP adds its own specific prohibitions.

---

### WP0: Core contracts and walking skeleton (orchestrator)

**Goal:** after WP0, `npm run dev` shows a walkable room grid. `npm test` and `npm run typecheck` pass. Every exported symbol listed in §5 exists with its exact signature, so all 14 WPs compile against it from minute one.

**Deliverables**
1. `src/core/*` and `src/types/n8ao.d.ts`, verbatim from §4; the toolchain changes in §4.1.
2. `tests/core/invariants.test.ts` and `tests/arch/imports.test.ts` (§4.26); `tests/core/determinism.test.ts`, which pins `hash3(1,2,3) = 2138774330`, `hashString('backrooms') = 1081633719` and `new Rng(1).next() = 2828542811` (values taken from the verified run).
3. **Stubs for every exported function and constant in §5.** A stub has the exact signature and a trivial body. The minimum behaviour for the skeleton:

   | Stub | Behaviour |
   |---|---|
   | `createWorldGen` | Every district is LOBBY/NORMAL. `generateChunk` returns the `grid` test scene pattern for every chunk: 8×8-cell rooms (`rectWalls`) with a centred DOORWAY in each wall, one TROFFER_2x4 per room (ON), floor 0, ceiling 270. `seam()` returns alternating WALL/OPEN runs of 4. `findSpawn` returns (4.2, 0, 4.2, yaw 0). |
   | `makeNeighborhood` | Real implementation required (small). WP1 may refine it. |
   | `buildTile` | Floor and ceiling quad per cell. For each WALL edge, 2 wall quads (no posts). `lmUv` all = (0.5, 0.5) of a 4×4 atlas. `props`, `decals`, `water` null. `dynLights` all null. |
   | `bakeTile` | Constant: irr 300 lux RGB, AO 1, dir (0,1,0) with w 0, mask 0, emission 0, volume constant 300 lux, `wallMask` 0. |
   | `generateTextures` | `DataArrayTexture` 4×4×28 filled with `LAYER_DEFS.albedoMean` (albedo), flat normal, roughness from the table. |
   | `createMaterialSystem` | `MeshStandardMaterial` per tile with `onBeforeCompile` that multiplies diffuse by the texture layer at `brLayer` and adds `lmIrr`. It must declare the `br*` attributes so geometry binds. |
   | `createChunkStreamer` | Uses the real WorkerPool (`chunk.worker.ts` → stub `handleRequest`), radius 1, no residency budget. |
   | `createPostStack` | `render()` calls `renderer.render(scene, camera)`. `capture` resolves a 1×1 grey. |
   | `createLightingRuntime` | Adds the flashlight SpotLight (off). The atmosphere is constant. |
   | `createPlayerSystem` | WASD walking at y = 0 with a pointer-lock look, no collision. |
   | `createAudioSystem` | No-op. |
   | App | Real boot order (§6.1) with the stubs. `window.__backrooms` sets `ready = true` after 30 frames. `stats()` returns zeros plus the player position; `teleport` sets the position. |
4. `docs/contract-changes/TEMPLATE.md` (date, WP, change, rationale), empty `WP1.md`…`WP14.md`, and `STATUS.md` (orchestrator-only merge log).
5. `harness/*.html` shells that load `src/harness/*.ts` stubs rendering a grey quad and setting `__backrooms.ready`.

**Acceptance**
- `node tools/shoot.mjs --params "seed=1"` returns no errors and a screenshot of the grid rooms.
- The arch test and invariant test pass.
- `node -e "import('./src/core/rng.ts')"` works (type stripping).

---

### WP1: World structure (districts, fields, seams, chunk pipeline, connectivity, spawn)

**Goal:** a pure, deterministic `WorldGen`. Any chunk of any storey can be generated independently in 2–6 ms. The chunk grid is invisible (seams), the world is provably connected, and spawn and QA can find anything.

**Files:** see §3.2 (`src/world/*.ts` except `zones/{l0,deep} files`, `structures/*`, `landmarks/*`, `content/*`), plus `tools/map.ts` and `tests/world/{districts,fields,seams,chunkgen,connectivity,spawn,ascii}.test.ts`.

**Exported API** (exact):
```ts
// world/worldgen.ts
export function createWorldGen(opts: WorldGenOptions): WorldGen;
// world/chunkGrid.ts
export function createChunkGrid(layout: ChunkLayout): ChunkGrid & { freezeSeams(): void; setSeam(side: 'W' | 'N' | 'E' | 'S', s: SeamSpec): void };
// world/fields.ts
export function createFieldSampler(seed: number, s: StoreyId): FieldSampler;
// world/neighborhood.ts  (layouts: 9 entries, index (dcz+1)*3 + (dcx+1))
export function makeNeighborhood(layouts: readonly ChunkLayout[]): LayoutNeighborhood;
// world/validate.ts
export function validateLayout(l: ChunkLayout, gen?: WorldGen): string[]; // [] when valid
export function layoutHash(l: ChunkLayout): number;
// world/ascii.ts
export function layoutToAscii(l: ChunkLayout, marks?: { li: number; lj: number; ch: string }[]): string;
export function layoutFromAscii(key: ChunkKey, text: string, palette?: Partial<ZonePalette>): ChunkLayout;
// world/testScenes.ts
export function testSceneChunk(id: TestSceneId, key: ChunkKey, seed: number): ChunkLayout;
// world/connectivity.ts
export function repairConnectivity(g: ChunkGrid, targets: readonly [number, number][], door: 'open' | 'doorway'): { carved: number; sealed: number };
// world/rooms.ts
export function labelRooms(l: ChunkLayout): number; // returns room count; writes l.room
export function markSpawnCells(l: ChunkLayout): void;
export function corridorWidth(l: ChunkLayout, li: number, lj: number): number; // cells; used by WP4 and WP7
// world/zones/registry.ts
export function generatorFor(zone: ZoneId): ZoneGenerator; // via ZONE_INFO[zone].baseZone
// world/zones/defaultSeam.ts
export function defaultPatternSeam(rng: Rng): SeamEdges;
```

**`ChunkGrid` implementation notes.**
- `addFixture(f, key)`: `{latticeI, latticeJ}` → `id = fixtureId(seed, s, latticeI, latticeJ, f.kind)` (core/layout.ts), `seed = fixtureSeed(id)`; `{id, seed}` is taken verbatim. `dynamic = false` (set later by `assignFixtureStates`). WP1 owns no id formula; the formulas live in core.
- `addSolid`: see the duplicate rule in `core/world.ts` (every intersected chunk adds the solid; no shared ids).
- `validateLayout` additionally rejects: duplicate fixture ids within a chunk; recessed RECT fixtures that straddle a render-tile line (`x0 < k·TILE_SIZE < x1` in world coordinates, same for z); dynamic fixtures mounted more than `LIGHT.DYN_MAX_MOUNT` above their floor; TOWER/ELEVATOR cells whose `cellZone` is not `STRUCTURE_ZONE`.

**Consumes:**
- WP2/WP3 generator objects: `lobbyGenerator`, `mazeGenerator`, `lowExpanseGenerator`, `pillarHallGenerator`, `officeGenerator`, `poolroomsGenerator`, `parkingGenerator`, `pipeworksGenerator`, `warehouseGenerator`, `concreteGenerator`.
- WP4: `stampTower`, `stampElevator`, `LANDMARKS`, `placeGlitchWalls`, `placePits`, `placeFixtures`, `assignFixtureStates`, `computeKeepClear`, `placeProps`, `placeVignettes`, `placeAnomalies`, `placeLeaks`, `placeExitSigns`, `placeChalk`, `placeDecals`, `towerExitCell`, `elevatorExitCell`.

**Algorithms**

1. **Districts** (`districtAt(s, cx, cz)`, cached by site cell):
   - **Warp.** `p = (cx+0.5, cz+0.5) + 2·WARP_AMP·(fbm2(seed^SALT.WARP^s·7919, p/6, 2) − 0.5, fbm2(seed^SALT.WARP^(s·7919+1), p/6, 2) − 0.5)`, in chunk units.
   - **Nearest site.** Take the site cell `(sx, sz) = floor(p/4)`. Consider the 3×3 surrounding site cells; each site sits at `(sx·4 + 2 + (hash01(hash4(seed, SALT.DISTRICT, s, sx, sz)) − 0.5)·3, …)`. The nearest site by squared distance wins; ties go to the lower id.
   - **Identity.** `district.id = hash4(seed, SALT.DISTRICT, s, sx·65536 + sz)`.
   - **Zone.** `rngFor(seed, SALT.DISTRICT_ZONE, s, sx, sz).weighted(STRATA_WEIGHTS[s])`.
   - **Onboarding (s = 0).**
     1. Collect the 25 sites of site cells in [−2, 2]², sort by distance to the world origin, and take ranks 0..4.
     2. Rank 0 → LOBBY with mood NORMAL.
     3. Ranks 1–4 → `rngFor(seed, SALT.ONBOARDING).shuffle([...ONBOARDING_ZONES])`.
   - **Mood.** DARK zone → DARK. Otherwise `weighted(MOOD_WEIGHTS)`. Onboarding rank 0 → NORMAL. `forceMood` overrides.
   - **Params.** `generatorFor(zone).districtParams(rngFor(seed, SALT.DISTRICT_PARAMS, s, sx, sz), s)`.
   - **Overrides.** `forceZone` replaces the zone (and the params come from the forced zone's generator).
2. **Fields** (`createFieldSampler(seed, s)`). Each field is `fbm2(hash3(seed, SALT.FIELD_X, s), x/λ, z/λ, octaves)` with λ from `FIELD_WAVELENGTH`:
   - `power`: 2 octaves, `contrast(v, 1)`, plus `0.45·(1 − smoothstep(15, 45, dist(x, z, origin)))` for s = 0 (the spawn is always lit), clamped to [0, 0.999].
   - `decay`: 3 octaves.
   - `humidity`: 3 octaves. For s = 2 add +0.25.
   - `warmth`: 1 octave.

   Sampled at cell centres into Uint8 (`floor(v·256)`).
3. **Seams** (`seam(s, axis, cx, cz)`). A is the chunk on the negative side (cx−1 or cz−1), B = (cx, cz). `rng = rngFor(seed, SALT.SEAM, s, axis === 'x' ? 0 : 1, cx, cz)`.
   - **BOUNDARY** (`dA.id !== dB.id`):
     - **Soft** (with `rng.chance(0.4)` when both zones are `ZONE_INFO.open`, or both are Level 0 family (ids 0–6)): the seam uses the default "mostly open" PATTERN (wall runs `int(1, 3)`, open runs `int(3, 8)`). The zone change is carried by the floorMat threshold strip, the ceiling soffit or bulkhead from the height difference (both already produced by WP5) and the lighting change.
     - **Hard** (otherwise): all 32 edges are WALL with openings: count `rng.int(2, 4)`, positions in [2, 29], minimum spacing 6. Opening width is the style width below, or `rng.int(4, 8)` cells when either zone is open.
     - `styleFor(zA, zB)`:
       - POOLROOMS involved → `arch` (ARCH, 2 cells, crown 260).
       - OFFICE involved → `doorway` (DOORWAY, 1 cell, CASING trim).
       - PARKING or WAREHOUSE involved → `rollup` (HEADER, 3–4 cells, underside 300, trim bit `EdgeTrim.ROLLUP`: WP5 emits the METAL_PAINTED header box).
       - Otherwise → `header` (HEADER, 2 cells, underside 220).
     - Wide openings of an open zone use that zone's opening kind (OPEN for LOW_EXPANSE/PILLAR_HALL/PARKING/WAREHOUSE, ARCH for POOLROOMS).
   - Otherwise, the same district:
     - `ZONE_INFO[zone].seamMode === GLOBAL` → `gen.globalSeam(q)`.
     - Otherwise → `gen.seamPattern?.(rng, d) ?? defaultPatternSeam(rng)`.
   - **Default PATTERN.** Alternate wall runs `rng.int(2, 10)` and open runs `rng.int(1, 4)`, starting with a random phase. With `rng.chance(0.25)` the seam is "mostly open" instead: wall runs `int(1, 3)`, open runs `int(3, 8)`.
   - **Post-rules, applied in this order:**
     1. Artery lanes that cross the line are forced OPEN.
     2. Any WALL run longer than 12 on a PATTERN seam is broken at its middle with a 2-cell OPEN.
     3. If there are 0 walkable edges, `idx = 4 + (hash % 24)` is set OPEN.
     4. `matNeg`/`matPos` come from the A and B palettes; `trim` gets BASEBOARD if the palette has one.
   - Towers and elevators keep ≥ 2 cells from seams (checked on `towerFootprint`/`elevatorFootprint`), so they never touch them. Landmark footprints keep ≥ 2 cells from seam lines too, except ENDLESS_HALL, whose two ends are the artery lane's seam openings.
4. **Sites** (all storey-independent: hashes omit `s`):
   - **Towers.** One per 4×4-chunk super-region.
     - `h = hash3(seed, SALT.TOWER, sr)`. Chunk = `(4·srx + h%4, 4·srz + (h>>2)%4)`, `rot = (h>>4)&3`, `i0, j0 ∈ [2, 32 − 2 − footprint]`.
     - The super-region (0, 0) uses chunk `(h%2, (h>>1)%2)`.
     - `i0, j0` are the min corner of `towerFootprint(site)` (3×5 for rot 0/2, 5×3 for rot 1/3); the range above uses the rotated extent.
     - A site is rejected if its footprint plus a 1-cell apron intersects an artery lane. Retry with `hash(…, attempt)` up to 4 times, then no tower.
     - `endless = hash01(h') < 0.05`, except at the origin super-region.
   - **Elevators.** Same scheme per 8×8 chunks, avoiding tower chunks.
   - **Arteries.** For axis x, band `bz = floorDiv(cz, 12)`:
     - The band has an artery if `hash01(hash4(seed, SALT.ARTERY, 0, bz)) < 0.5`.
     - Row chunk `cza = 12·bz + h%12`; lane `lj ∈ [3, 27]` (so `row = 32·cza + lj`).
     - Segments of 8 chunks exist with p 0.7.
     - The same applies to axis z.
     - **Artery palettes** (per storey, overriding the district palette in lane cells, `cellZone` set accordingly): storey 0 → L0 wallpaper corridor (LOBBY palette, troffers every other cell); storey 1 → CMU service corridor (CONCRETE palette, TUBE_STRIP every 2 cells); storey 2 → tiled corridor (POOLROOMS palette, SKY_PANEL every 3 cells).
   - **Landmarks.** For each 8×8-chunk region, with p 0.8, one landmark at a hashed chunk that has no tower or elevator.
     - Eligibility: a chunk crossed by an artery lane is eligible **only** for ENDLESS_HALL, and ENDLESS_HALL is eligible **only** in such chunks (and only on storeys 0 and 1). Weights are renormalised over the kinds eligible for the candidate chunk; if none is eligible, the region has no landmark.
     - The kind is weighted among `LANDMARKS` whose `storeys` include `s`.
     - Landmarks are at least 4 chunks apart; a candidate is rejected if a neighbouring region's landmark is closer (deterministic: the lower hash wins).
     - `forceLandmark` puts that kind at chunk (0, 0) of every storey.
5. **Chunk pipeline** (`generateChunk`, strict order):
   1. **Test scene?** Return `testSceneChunk`.
   2. **Setup.** Resolve the district, zone and generator. Build `palette` and `lighting`. `layout = createEmptyLayout`. Fill every cell with palette heights and materials, `cellZone`, all tiles NORMAL, interior edges OPEN, edge materials from the palette.
   3. **Fields** per cell.
   4. **Seams** W = `seam(s,'x',cx,cz)`, E = `seam(s,'x',cx+1,cz)`, N = `seam(s,'z',cx,cz)`, S = `seam(s,'z',cx,cz+1)` are written to lines 0/32 → `freezeSeams()`.
   5. **Arteries** (`arteries.ts`):
      - Lane cells get `ARTERY|RESERVED` and the storey's artery palette.
      - Flanking walls go on the lines before and after the lanes, with an OPEN or DOORWAY side door every `U(4, 10)` cells, using an rng seeded from the artery seed and the global cell.
      - Where two arteries cross, their walls are skipped.
   6. **Stamps.** `stampTower` / `stampElevator` for the sites in this chunk (their cells get `cellZone = STRUCTURE_ZONE`), then `LANDMARKS[k].stamp`, which returns `{ entrances }`.
   7. `generatorFor(zone).generate(ctx)`.
   8. `placeGlitchWalls(ctx)`, then `placePits(ctx)`.
   9. **Repair.** `repairConnectivity(grid, targets, door)`. `targets` = the tower/elevator exit cells + the landmark `entrances` returned in step 6. `door` = 'doorway' for OFFICE/MANILA, else 'open'.
   10. `labelRooms`.
   11. **Lights.** `placeFixtures(ctx)` if `lighting.placement === 'lattice'`; then always `assignFixtureStates(ctx)`.
   12. **Content.** `keepClear = computeKeepClear(layout)`, then `placeProps(ctx, gen.props, keepClear)`, `placeVignettes(ctx, keepClear)`, `placeAnomalies`, `placeLeaks`, `placeExitSigns`, `placeChalk`, `placeDecals(ctx)` (last, so it can react to leaks, pipes and props).
   13. `markSpawnCells`, then `ports` from the seams, then `hash = layoutHash`. In dev and tests, run `validateLayout`.
6. **Connectivity repair.**
   - **Walkable cell:** not `SOLID|VOID|NOWALK|TOWER|ELEVATOR` (tower/elevator exit cells are targets), water depth ≤ 1.1 m, and `blockCm === 0`.
   - **Passable edge:** `EDGE_WALKABLE[kind]` (HEADER only if `hA ≥ 190`) and `|Δfloor| ≤ 36 cm`, **or** a ramp solid links the two cells.
   - **Port cells:** the inner cells of walkable seam edges. They are forced walkable first (SOLID cleared, `blockCm = 0`).
   1. Union-find the components.
   2. **main** = the component of the first port in N, E, S, W order.
   3. For each other component that contains a port or target, or has ≥ 3 cells, in ascending lowest-cell-index order: run a 0-1 BFS to main. Costs:
      - passable edge: 0
      - interior non-frozen wall: 1
      - SOLID cell: 3 (cleared)
      - frozen or reserved: ∞

      Carve the path (walls → `door`, SOLID → clear).
   4. Components that remain unreachable: those with < 3 cells → SOLID; otherwise flag `SEALED`.
7. **Rooms and regions.**
   - `labelRooms`: flood fill over walkable cells, separated by edges that are not OPEN/HEADER/ARCH. In doorless zones (LOBBY) a "room" can be hundreds of cells, so `room` is used **only** for probe interpolation (WP7) and acoustics; placement rules use local measures instead (WP4 corridor width test, distance-to-wall maxima).
   - `corridorWidth(l, li, lj)` (exported from `rooms.ts`): the free run through the cell perpendicular to its dominant free axis, in cells. "Corridor" everywhere in this spec means `corridorWidth ≤ 2`.
   - `nb.region`: flood fill over the 96×96 halo across edges that do not occlude at y = 1.2 m and cells that are not SOLID.
   - `markSpawnCells`: walkable, not reserved, ≥ 1 ON fixture within 4 m, and ≥ 5 walkable cells in its 3×3 block → `SPAWN_OK`.
8. **Spawn.**
   - `findSpawn(s)` over the 3×3 chunks around the origin. Score each `SPAWN_OK` cell:
     - `2·(ON fixtures within 4 m)`
     - `+ (walkable cells within Chebyshev 2)/5`
     - `+ longestSightline/5`, from DDA in 8 directions, capped at 30 m, using `edgeSolidAt` at y = 1.6.

     Yaw = direction of the longest sightline (`yaw = atan2(−dx, −dz)`), pitch 0. Deterministic ties go to the lowest cell index.
   - `findNearest(query, from, maxChunks)`: ring search by Chebyshev chunk distance. Matchers:
     - `zone:` uses `districtAt` (no generation).
     - `landmark:` uses `landmarkAt`.
     - `tower` / `elevator` use the site functions; the result stands at the exit cell, facing the door.
     - `dark`: mood DARK, or a cell with power < 0.15.
     - `water`: `layout.water`.
     - `flicker`: a dynamic fixture.
     - `vignette:NAME`: a matching vignette.
     - `spawn` = `findSpawn`.

     Candidates are scored as in `findSpawn` and oriented toward the target.
9. **ASCII.** Each cell is 2×2 characters; the full grid is `(2W+1)×(2H+1)`.
   - Vertices: `+`.
   - Edges: WALL `-`/`|`, DOORWAY `d`, HEADER `h`, ARCH `a`, PARTITION `:`, HALF `=`, RAIL `"`, WINDOW `w`, GLITCH `%`, OPEN ` `.
   - Cell glyphs, highest precedence first: `@` player, `S` tower, `E` elevator, `*` landmark, `L` light ON, `f` dynamic, `y` DYING, `l` OFF, `v` vignette, `p` prop, `~` water, `#` SOLID, ` ` VOID, `.` walkable.
   - `layoutFromAscii` parses the same format; unknown glyphs are ignored.
10. **Test scenes.** Built with `layoutFromAscii` at chunk (0, 0) of storey `s`. Every other chunk is SOLID-filled. The scenes:
    - `leak`: rooms A and B share one WALL; one light, in A only. The spawn is in B facing the wall.
    - `cornell`: a 6×6 room with WALLPAPER_L0 walls, a CARPET_L0 floor, one SKY_PANEL, and one WAREHOUSE-palette (grey) wall for colour-bleed comparison.
    - `tower`: a LOBBY room plus a tower.
    - `materials`: a room with 28 floor patches and wall panels, one per layer.
    - `flicker`: a room with one dynamic light plus 3 DYING lights.
    - `grid`: the WP0 room grid.
11. **`tools/map.ts`.**
    ```
    node tools/map.ts --seed 1 --s 0 --cx0 -2 --cz0 -2 --cx1 2 --cz1 2 [--png out.png] [--zones] [--force ZONE]
    ```
    Prints ASCII. `--png` writes 4 px per cell: zone colour tints, walls black, lights yellow, towers red. It is encoded with `node:zlib` and a hand-written PNG chunk writer.

**Acceptance (vitest)**
- **Determinism.** 200 random keys over all storeys: `generateChunk` gives an identical `hash` whether generated fresh or after 50 other chunks.
- **Seams.** 2000 random adjacent pairs:
  - `A` line 32 equals `B` line 0 for all 6 edge arrays;
  - ≥ 1 walkable port per seam; hard BOUNDARY seams have ≥ 2 openings;
  - soft BOUNDARY seams are 40% ± 5% of eligible district pairs;
  - same-district PATTERN seams never have a WALL run > 12.
- **Sites.** No landmark footprint within 2 cells of a seam (except ENDLESS_HALL); ENDLESS_HALL appears only in artery chunks and every artery-chunk landmark is ENDLESS_HALL; `towerFootprint`/`elevatorFootprint` never touch the seam margin for all 4 `rot`.
- **Connectivity.** Over a 5×5-chunk region of each storey, a global flood from the spawn reaches every port cell, and `validateLayout` returns `[]` for every chunk.
- **Zone mix.** Frequencies over 10k districts outside the onboarding window are within ±3% of `STRATA_WEIGHTS`. Onboarding ranks are correct. `forceZone` holds.
- **Fields.** In [0, 1). Adjacent cells differ by ≤ 0.05 across chunk seams.
- **Performance.** Mean `generateChunk` ≤ 6 ms (p95 ≤ 12 ms) over 100 chunks. This test is enabled once WP2–WP4 land; before that it is marked `.skip` via `process.env.GEN_PERF`.
- **Golden hashes.** 3 chunks per zone, stored in `tests/world/golden.json`. Created during integration and regenerated only by bumping `GEN_VERSION`.
- **ASCII.** Round-trip of the `grid` scene is identical.
- **Map tool.** `node tools/map.ts` for 5×5 chunks runs in < 2 s.

**Screenshot evidence:** `tools/map.ts --png` of storeys 0, 1 and 2 around the origin; with `--zones`, no straight seam walls should be visible.

**Must NOT touch:** zone generator files (WP2/WP3), structure/landmark/content files (WP4), the mesh, bake or render layers.

---

### WP2: Zones, Level 0 family

**Files:** `src/world/zones/{lobby,maze,lowExpanse,pillarHall,office,l0common}.ts`, `tests/world/zones-l0.test.ts`.

**Exported API:**
```ts
export const lobbyGenerator: ZoneGenerator;   // serves LOBBY, MANILA, DARK (variant from ctx.district.zone)
export const mazeGenerator: ZoneGenerator;
export const lowExpanseGenerator: ZoneGenerator;
export const pillarHallGenerator: ZoneGenerator;
export const officeGenerator: ZoneGenerator;
/** Test hook: the recursive-division leaves of the last LOBBY generate() for this chunk (local cell rects). */
export function lobbyLeaves(ctx: ZoneGenContext): { li0: number; lj0: number; li1: number; lj1: number }[];
```

**Consumes:** the `ChunkGrid` API only (all writes), `Rng`, `FieldSampler`, and `ctx.world` for arteries. Palettes switch per storey:
- Storey 1: LOBBY/MAZE/DARK use `CMU_PAINTED` walls, `CONCRETE_FLOOR`, `CONCRETE_CEIL`, CeilKind CONCRETE, and TUBE_STRIP lights at 4000 K / 8600 nits.
- Storey 2: PILLAR_HALL/LOW_EXPANSE/MANILA use `POOL_TILE` everywhere, CeilKind TILE_GLAZED, and SKY_PANEL lights at 6500 K / 2500 nits.

**Palettes and lighting (storey 0)**

| Zone | floor / wall / ceil / trim | ceilCm | Light (kind, lattice in tiles, luminance nits, CCT K) | zoneMul |
|---|---|---|---|---|
| LOBBY | CARPET_L0 / WALLPAPER_L0 / CEILING_TILE / TRIM_PAINT, baseboard | param {260, 270, 270, 280} | TROFFER_2x4, lattice param {[4,4],[4,6],[6,4]}, axis z, 3300, 3700–4600 | 1 |
| MANILA | CARPET_L0 / WALLPAPER_MANILA / CEILING_TILE | 250 | TROFFER_2x2 [4,4], 2600, 3300–3800 | 0.9 |
| DARK | as LOBBY | 270 | as LOBBY | 0.35, decay +0.2 |
| MAZE | CARPET_L0 / WALLPAPER_L0 / CEILING_TILE | 270 | TROFFER_2x4 [4,6] | 1 |
| LOW_EXPANSE | CARPET_L0 / WALLPAPER_L0 / CEILING_TILE | param 210–230 | TROFFER_2x4 [4,4], perfectly regular, 3000 | 1 |
| PILLAR_HALL | TERRAZZO or CARPET_L0 (param) / WALLPAPER_L0 / CEILING_TILE | param 450–700 | PENDANT_LINEAR, hung 320 cm above floor, between pillars, 4200 | 1 |
| OFFICE | CARPET_OFFICE (VINYL_VCT aisles) / DRYWALL / CEILING_TILE | 260 | TROFFER_2x2 [4,4], 3000, 3500–4100 | 1 |

**Algorithms**

**LOBBY** (the famous photo). Seam mode PATTERN, using the default seam. Recursive division over the free (non-reserved) region of the 32×32 grid:
1. **`divide(rect)`.**
   - Stop if `area < U(16, 64)·(1.3 − density)` or `min(w, h) < 4`.
   - Split the longer axis (the shorter one with p 0.3) at `[2, len−2]`, biased toward even offsets.
   - The wall line gets 1–3 openings of width 1/2/3 (weights 0.4/0.4/0.2).
   - With p 0.25 the line covers only 40–80% of the span, which gives L-rooms.
   - Openings are typed OPEN 60%, HEADER 35%, DOORWAY 5%.
   - Recurse.
2. **Erosion.** Delete each wall edge with p 0.08; delete runs of ≤ 2 edges with p 0.3.
3. **Stubs.** At open wall ends, add a perpendicular stub of 1–2 edges with p 0.15. Leaves over 40 cells get a free-standing wall of 2–5 edges with p 0.5.
4. **Thick blocks.** Per leaf, with p 0.1, a 1×1 or 1×2 SOLID block against a wall (the chunky corner). Never adjacent to a port or opening.
5. **Ceiling.** Per leaf, with p 0.12: either a raised bay (+30–60 cm) or a 40 cm bulkhead band (a 1-cell ring at `ceilCm − 40`).
5b. **Sunken room.** Per leaf of ≥ 20 cells, with p 0.06: the leaf interior (inset 1 cell) drops to `floorCm −45` with a 3-step ramp solid (`steps: 3`) at one opening side; ceiling unchanged (taller room).
6. **Variants.**
   - DARK: the same, with `density + 0.15`.
   - MANILA: smaller rooms (stop area `U(9, 30)`), 70% DOORWAY openings.
7. **District params:** `density ∈ [0.3, 0.8]`, `lattice`, `phaseX`, `phaseZ`, `ceilCm`.
8. **Props:**
   - wallMounted OUTLET (0.3 m, 2.5/100 m²), VENT_GRILLE (ceil − 0.35, 0.6);
   - corner TRASH_CAN (0.3);
   - wall CHAIR_STACKING (0.4), WATER_COOLER (0.08).

**MAZE.** PATTERN seams via `seamPattern` at interior passage density.
- District variant `wide` 60% / `narrow` 40%.
- **Wide.**
  - 16×16 macro grid of 2×2 cells with thin walls on macro edges.
  - Wilson's algorithm on the macro grid, braiding each dead end with p 0.35.
  - 2–3 macro rooms (2×2–3×3 macro cells) with p 0.2.
  - Seam: each macro edge is open with p 0.35 (at least 2); any wall run of > 5 macro edges gets its middle opened.
- **Narrow.**
  - Global-parity lattice: cells with odd gi and odd gj are nodes; the rest are SOLID wall cells.
  - A growing-tree carve (newest 50% / random 50%), braid 0.3.
  - Seam ports at node rows with p 0.35 (at least 2).
  - Cells adjacent to a passable seam edge are made walkable connectors.

**LOW_EXPANSE.** GLOBAL seams.
- **Features.** One candidate per 6×6 global cell block (hash offset), kept with p 0.6:
  - 60%: wall segment of 2–6 edges, random axis;
  - 20%: L corner;
  - 15%: SOLID block 1×1–2×2;
  - 5%: closed 3×3–4×5 room with 1 DOORWAY.
- The chunk rasterizes every candidate whose bounds come within 6 cells of the chunk.
- `globalSeam` rasterizes only the edges that lie on the seam line. Because both sides run the same function, both sides agree.
- Denser haze comes from WP11's atmosphere table.

**PILLAR_HALL.** GLOBAL seams.
- **Params:** pitch P ∈ {3, 4, 5} cells, pillar size ∈ {0.5, 0.7, 0.9} m, ceilCm 450–700, lattice offset (ox, oz) ∈ [0, P)², floor variant, humid (humidity field > 0.6).
- **Pillars.**
  - Box solids (COLLIDE|OCCLUDE|RENDER, mat WALLPAPER_L0 or TERRAZZO) centred on the global vertex `(ox + i·P, oz + j·P)`, from floor to ceiling.
  - Each is missing with p 0.04 (hash of the global vertex).
  - A pillar that straddles a seam is added by every chunk it intersects (core `addSolid` duplicate rule; face ownership prevents duplicate faces).
- **Walls.** Sparse wall fragments from the LOW_EXPANSE feature process at p 0.15.
- **Humid districts.** WaterRect kind 2 (2 cm film) over walkable cells with the WET flag.
- `globalSeam`: OPEN except for fragments.

**OFFICE.** GLOBAL seams.
- **Block lattice.** Period 16 global cells. Aisle lanes are global indices ≡ 15 or 0 (mod 16) on both axes. Chunk seams (gi ≡ 0 mod 32) fall between aisle lanes, so `globalSeam` is all OPEN.
- **Block types** by `hash(block)`:
  - **CUBICLES (60%).** Double rows of 2×2 pods separated by 1-cell aisles. Pod walls are PARTITION edges (150 cm, FABRIC_PARTITION). Each pod gets DESK + OFFICE_CHAIR + CRT_MONITOR (+ FILING_CABINET p 0.3). With the decay field, partitions become RAIL (fallen) with p = decay·0.2.
  - **ROOMS (30%).** BSP rooms ≥ 3×4 with DRYWALL WALL edges and DOORWAY doors (CASING trim). Each is a conference room (CONFERENCE_TABLE plus 6–10 chairs) or a private office.
  - **BREAK (10%).** Tables, VENDING_MACHINE, WATER_COOLER.
- **Raised areas.** 10% of ROOMS blocks are a raised floor (+30 cm, VINYL_VCT) with a 2-step ramp at the door.
- Uses `grid.addProp` with explicit yaw (desks face the aisle); `lighting.placement = 'lattice'`.

**Acceptance**
- For 200 seeds × each zone (forced with `forceZone`), `validateLayout = []`.
- Walkable fraction per chunk: LOBBY/MAZE 55–85%, LOW_EXPANSE/PILLAR_HALL ≥ 85%, OFFICE ≥ 60%.
- LOBBY: the mean **recursive-division leaf** area (via `lobbyLeaves`) is 10–40 cells (not `labelRooms` rooms, which merge across doorless openings); ≥ 1 SOLID block per 4 chunks; ≥ 30% of openings are HEADER; ≥ 55% of openings are OPEN or HEADER (the doorless look is kept).
- No PATTERN seam has a wall run > 12.
- GLOBAL seams are computed identically from both sides (property test over 500 pairs).
- `tools/map.ts --force LOBBY` shows irregular rooms with L-shapes, stubs and blocks.
- **Screenshot:** `goto=zone:LOBBY` at seed 1 spawn shows the famous-photo composition (a wall with a chunky corner, doorless openings, a troffer grid).

**Must NOT touch:** seams/pipeline (WP1), fixture/prop placement engines (WP4). Zones only *configure* them via `lighting` and `props`, or place custom fixtures through `grid.addFixture(f, { latticeI, latticeJ })` with the lattice tile of the fixture centre (recessed rects must not straddle a tile line).

---

### WP3: Zones, deep strata

**Files:** `src/world/zones/{poolrooms,parking,pipeworks,warehouse,concrete,deepcommon}.ts`, `tests/world/zones-deep.test.ts`.

**Exported API:** `poolroomsGenerator`, `parkingGenerator`, `pipeworksGenerator`, `warehouseGenerator`, `concreteGenerator` (all `ZoneGenerator`).

| Zone | Seam | Palette | ceilCm | Lights |
|---|---|---|---|---|
| POOLROOMS | GLOBAL | POOL_TILE floor/walls, TILE_GLAZED ceiling (POOL_TILE), POOL_MOSAIC pool bottoms | per room 360–600; "vaulted" district 720 | SKY_PANEL 1.2×1.2, lattice [6,6] tiles, 2500 nits, 6000–6800 K; UNDERWATER lights in pool walls (p 0.3 per pool) |
| PARKING | GLOBAL | CONCRETE_FLOOR / CONCRETE_WALL / CONCRETE_CEIL, CeilKind BEAMS | 260 (beams 220) | TUBE_STRIP (custom along beam bays), 8600 nits, 4000 K; 10% SODIUM 2000 K |
| PIPEWORKS | PATTERN | METAL_GRATE patches + CONCRETE_FLOOR / CMU_PAINTED / CONCRETE_CEIL | 300–420 | CAGE_BULB (SPHERE, 64 cd), 2700 K, every 4–6 cells along corridors (custom), zoneMul 0.7 |
| WAREHOUSE | GLOBAL | CONCRETE_FLOOR / CMU_PAINTED / METAL_DECK (CeilKind TRUSS: corrugated deck rendered at ceilCm) | 800 | HIGHBAY every 10 cells at 700 cm (custom, SPHERE disk 2000 cd, w 0.45; per-light R rule gives ≥ 15 m) |
| CONCRETE | PATTERN | CONCRETE_FLOOR / CMU_PAINTED (WAINSCOT trim) / CONCRETE_CEIL | 300 | TUBE_STRIP along corridors + CAGE_BULB in rooms (custom) |

**Algorithms**

**POOLROOMS.**
- **Room lattice.** Global 8×8-cell rooms. Every wall of the lattice has a global id `(axis, line, index)`.
  - Merge: the wall is removed if `hash01(wallId) < 0.35`.
  - Otherwise it is WALL with 1–3 ARCH openings at positions hashed from the wall id.
  - Seam lines (multiples of 32) lie on lattice lines, so `globalSeam` computes the same wall from the wall id on both sides.
- **Per-room data.** The room id is the hash of its lattice coordinates (merged rooms use the lowest id):
  - pool with p 0.6: inset 1–2 cells, floor −40..−180 cm, `waterCm = −10`;
  - one side gets a stepped entry (ramp solid, 0.3 m steps) plus a POOL_LADDER;
  - deep cells (> 110 cm) are NOWALK; every edge between a wadeable and a NOWALK pool cell gets a FLOAT_ROPE prop at water level (the deep edge is visible, not an invisible wall);
  - flooded with p 0.2: `waterCm` +20..+30 over the whole floor (wadeable);
  - terraces with p 0.25: one side of the room is raised +45 cm (2 cells deep) with a 3-step ramp.
- **Channels.** Where both rooms of an arch have pools, a 1–2-cell sunken channel runs through the arch. Computed from the global room data, so both sides agree.
- **Props.** LOUNGE_CHAIR, LIFEBUOY (wall), BENCH_TILED.
- **Emitters.** WATER per pool; DRIP near leaks.

**PARKING.**
- **Columns.** 0.6 m box solids on a 6×5-cell global vertex lattice.
- **Beams.** Downstand boxes, 40 cm deep, along x at every column row (from `ceil − 40` to `ceil`). Beams crossing a seam are added by every chunk they intersect (core `addSolid` rule).
- **Markings.** Stall stripes as `DECAL_PAINT_STRIPE` decals (0.1×5 m), 3 per 7.2 m bay; PARKING_NUMBER decals on columns.
- **Props.** WHEEL_STOP per stall; CAR_SEDAN in 5% of stalls.
- **Dead-end ramp.** One per ~6 chunks: 4×8 cells rising 1.5 m to a wall, with rails; walkable.
- **Seams.** All OPEN except columns (solids).

**PIPEWORKS.**
- **Corridors.** The narrow-maze lattice with growing-tree carving (straight bias 0.7).
- **Boiler rooms.** 5×5 open rooms with p 0.3, containing a BOILER and TANK.
- **Pipes.** For each maximal straight corridor run, 1–4 `pipe` solids along the walls at 1.8–2.6 m, r 0.04–0.15. Elbows at turns are implied by shared endpoints; vertical risers at junctions. PIPE_VALVE props. Runs are world-anchored (global cell coordinates), and every chunk a pipe intersects adds it.
- **Floors.** Grated patches: `floorMat = METAL_GRATE` (floorCm unchanged). WP5 renders them as an alpha-tested grate over a 0.4 m dark PLENUM pit.
- **Emitters.** STEAM, DRIP, PIPE.
- **Seams.** PATTERN seam at node rows (as in the narrow MAZE).

**WAREHOUSE.**
- **Racks.** SHELF_RACK rows along x on a global row lattice: rack depth 1 cell, 2-cell aisles, rows 10–20 cells long, a cross-aisle every 16 global cells. Racks are props with `occlude` (baker boxes) and COLLIDE. Racks carry CRATE and CARDBOARD_BOX props on their shelves.
- **Roof structure.** Girders (box solids 0.3 × 0.6 m, RENDER|OCCLUDE, METAL_PAINTED) along z every 9.6 m (8 cells, global lattice) and bar joists (0.1 × 0.4 m) along x every 2.4 m, both spanning y ∈ [7.4, 8.0] under the METAL_DECK ceiling. Lit by BOX charts. HIGHBAYs hang from the nearest joist (WP6 draws the drop rod from the fixture up to `ceilCm − 0.6`).
- **Mezzanine** (p 0.3 per district chunk, not on seams): a WALKABLE_TOP|COLLIDE|OCCLUDE|RENDER slab 0.2 m thick at y = 3.0 over a 6×4-cell area, HALF-height rail boxes on its open sides, and a straight stair ramp (`steps: 16`). The top is extra space, not a connectivity target; the area under it stays walkable (headroom 2.8 m).
- **Floor markings.** Safety stripes as paint decals.
- **Seams.** OPEN.

**CONCRETE.**
- **Corridor graph.** Jittered 6-cell node lattice, MST plus 25% extra edges; corridors 1–3 cells wide.
- **Utility rooms.** 20% of nodes grow into rooms of 4×4 to 6×8.
- **Walls.** Two-tone CMU (WAINSCOT trim bit).
- **Loading drop** (20% of utility rooms): half the room is 1.0 m lower, separated by a HALF edge (a rail at the top) with a 1-cell stair ramp at one end.
- **Props.** CRATE/PALLET clusters, EXTINGUISHER on walls.
- **Emitters.** VENT.

**Acceptance:** as for WP2 (`validateLayout`, walkable fraction ≥ 45% for PIPEWORKS/CONCRETE, ≥ 70% for the others), plus:
- POOLROOMS: every pool is reachable via steps.
- POOLROOMS: water cells deeper than 1.1 m are NOWALK, and every wadeable/NOWALK boundary edge carries a FLOAT_ROPE.
- WAREHOUSE: every TRUSS cell lies under at least one joist within 2.4 m; HIGHBAYs are within 1.2 m (xz) of a joist.
- A 500-pair GLOBAL seam agreement test.

**Screenshots:** `goto=zone:POOLROOMS`, `zone:PARKING`, `zone:WAREHOUSE` with `time=10`.

**Must NOT touch:** as WP2.

---

### WP4: Structures and content (towers, elevators, landmarks, fixtures, props, vignettes)

**Files:** `src/world/structures/*`, `src/world/landmarks/*`, `src/world/content/*`, `tests/world/{structures,content,tower}.test.ts`.

**Exported API:**
```ts
// structures/tower.ts
export function stampTower(g: ChunkGrid, site: TowerSite, seed: number): void;
export function towerExitCell(site: TowerSite): { li: number; lj: number; yaw: number }; // outside the exit doorway, facing in
export function towerPeriodSolids(site: TowerSite, seed: number): { solids: DistributiveOmit<Solid, 'id'>[]; fixtures: Omit<Fixture, 'id' | 'seed' | 'dynamic'>[]; props: PropPlacement[] }; // chunk-local, one period; fixture i gets id structureFixtureId(towerId, SALT.TOWER, i)
// structures/elevator.ts
export function stampElevator(g: ChunkGrid, site: ElevatorSite, seed: number): void;
export function elevatorExitCell(site: ElevatorSite): { li: number; lj: number; yaw: number };
// structures/glitch.ts
export function placeGlitchWalls(ctx: ZoneGenContext): void;
// structures/pit.ts
export function placePits(ctx: ZoneGenContext): void;
// landmarks/index.ts
export interface LandmarkGenerator {
  kind: LandmarkKindId; storeys: readonly StoreyId[]; weight: number; footprint: [number, number]; // cells
  /** entrances = walkable local cells just inside the landmark's openings (WP1 connectivity repair targets) */
  stamp(g: ChunkGrid, ctx: ZoneGenContext, site: LandmarkSite): { entrances: [number, number][] };
}
export const LANDMARKS: readonly LandmarkGenerator[]; // index = LandmarkKind
// content/*
export function placeFixtures(ctx: ZoneGenContext): void;
export function assignFixtureStates(ctx: ZoneGenContext): void;
export function kelvinToLinearRGB(kelvin: number, greenTint: number): Vec3; // max component 1
export function computeKeepClear(l: ChunkLayout): Uint8Array; // CHUNK_CELL_COUNT, 1 = keep clear
export function placeProps(ctx: ZoneGenContext, rules: PropRuleSet, keepClear: Uint8Array): void;
export function placeVignettes(ctx: ZoneGenContext, keepClear: Uint8Array): void;
export function vignetteCandidates(seed: number, s: StoreyId, x0: number, z0: number, x1: number, z1: number): { x: number; z: number; kind: VignetteKindId; seed: number }[]; // world metres
export function placeAnomalies(ctx: ZoneGenContext): void;
export function placeLeaks(ctx: ZoneGenContext): void;
export function placeExitSigns(ctx: ZoneGenContext): void;
export function placeChalk(ctx: ZoneGenContext): void;
export function placeDecals(ctx: ZoneGenContext): void;
```

**Tower** (geometry per §2.4; bakeGroup = `towerId` = `(site.id & 0x7fffffff) | 1`):
- **Frame.** The (u, v) → (li, lj) mapping and `(i0, j0)` convention are `footprintCell` / `footprintPoint` / `towerFootprint` (core); never re-derive them.
- **Cells.** The footprint gets `TOWER|RESERVED`, `floorCm −600`, `ceilCm 600`, `ceilKind OPEN_DARK`, `cellZone = STRUCTURE_ZONE`.
- **Materials.** Only `TOWER_LAYERS` on tower edges and solids; no trim bits on tower edges.
- **Perimeter.** WALL edges in CMU_PAINTED; interior edges per the diagram. The exit DOORWAY edge's outer cell stays normal storey space.
- **Perimeter walls are edges**, so they extrude over the tower cells' −6..+6. The exit is the only opening: a DOORWAY on line u=3, v=4. `edgePieces` opens it only from the higher adjacent floor (y = 0) up to 2.10 m. The sill piece (y < 0) and the lintel (y > 2.1) automatically seal the stacked vestibule copies. **Interior walls are periodic solids, never edges**, because edges cannot repeat a hole every 3 m.
- **Authoring.** Author in natural coordinates: end0 landing at y = 0, vestibule floor 0, vestibule ceiling 2.7, D door hole 0.9 × 2.1 at y ∈ [0, 2.1]. Then call `wrapToPeriod()`, which splits boxes at y = ±1.5 and shifts the pieces by ±3 into [−1.5, 1.5).
- **The period contains** (every solid has bakeGroup = towerId):
  - landing slabs 0.2 m thick (WALKABLE_TOP|COLLIDE|OCCLUDE|RENDER), end0 at y = 0 and end1 at y = −1.5;
  - lane A ramp from end0 (y = 0) to end1 (y = −1.5) and lane B ramp from end1 (+1.5) to end0 (0), each with `steps: 13`;
  - the central wall box (u = 1 line, v ∈ [1, 4), 0.15 thick, full period height);
  - the shaft|vestibule wall on the u = 2 line: solid for v ∈ [1, 5), jambs plus lintel around door D at v ∈ [0, 1);
  - vestibule floor slab at 0 and ceiling slab at 2.7 (thickness 0.2 → 2.9), wrapped.
- **Fixtures.** One CAGE_BULB per landing per period (SPHERE, 64 cd, w 0.1, 3000 K, ON, `hum` 0.6), added with `grid.addFixture(f, { id: structureFixtureId(towerId, SALT.TOWER, i), seed: fixtureSeed(id) })`.
- **Handrails.** HANDRAIL props, authored in the fundamental period like solids (anchor cells are TOWER cells); WP5/WP6 replicate them with `expandPeriodicProps`.
- **Signage.** A stencil `SignKind.B1`/`B2`/`L0` decal on the vestibule wall.

  The sign text breaks strict periodicity, so it is placed **only on the storey-side face of the exit** (outside the tower).
- **Portal.** `PortalSpec{kind: 'tower', min/max = footprint AABB y ∈ [−6, 6], towerId, endless}`.
- **Invisibility test.** For eye points sampled in the shaft with |feetY| ≤ 1.6 and eye height +1.62, no segment from the eye to any point of a vestibule exit region (y ∈ [−6, 6], excluding the k = 0 exit seen from inside the k = 0 vestibule) is unobstructed. Additionally, sightlines up and down the stair stack to |y| = TOWER_SPAN must end on tower geometry (ramp soffits, landings, walls), never on the clear colour. Use a local 2.5D DDA over the tower's cells, edges and replicated solids.

**Elevator.**
- **Footprint.** 2×3 cells: a 2×2 cab plus a 2×1 lobby strip. Flags `ELEVATOR|RESERVED`.
- **Frame.** `elevatorFootprint` / `footprintCell` (core): v = 0, 1 is the cab, v = 2 the lobby strip.
- **Cells.** `ELEVATOR|RESERVED`, `cellZone = STRUCTURE_ZONE`.
- **Cab.** Isolated bakeGroup (`id|1`): METAL_PAINTED walls and TROFFER_2x2 at 2000 nits, ids `structureFixtureId(elevatorId, SALT.ELEVATOR, i)` (storey-free, so the cab is identical in every storey). The DOORWAY between cab and lobby is 1 cell wide.
- **Doors.** `stampElevator` does **NOT** add ELEVATOR_DOOR props (they would become static meshes and static collision). WP12 owns the door leaves as dynamic meshes and virtual collision boxes. The cab's lighting is independent of the storey.
- **WRONG_ELEVATOR.** With p 0.1 per elevator (hashed from the elevator id): an `AnomalySite WRONG_ELEVATOR` at the cab and `portal.wrong = true`; WP12 sends that ride to `(s+2)%3` instead of `(s+1)%3`.
- **Portal.** `kind 'elevator'`, trigger = the cab AABB.

**Glitch walls.** With p 0.03 per chunk (0 in the spawn district), pick an interior WALL edge at a dead end and set it GLITCH (it collides like a wall). Add:
- `grid.addStructure(StructureKind.GLITCH, cell rect of the dead-end cell, 0, PortalSpec{kind: 'glitch', min/max = the edge's AABB grown by PLAYER.radius + 0.05 m on the walkable side, y ∈ [floor, floor + 2], towerId: 0, endless: false})`;
- `AnomalySite GLITCH_WALL`;
- a faint BUZZ emitter (gain 0.15) at the wall centre, 1.2 m high. WP5 misregisters the wall's material UVs (hashed 2–6 cm offset) on GLITCH faces: the visual tell.

**Pits** (`placePits`). In districts with decay > 0.7 (the district-mean field), p 0.08 per chunk: a 2×2-cell collapsed floor inside a room of ≥ 5×5 walkable cells, away from ports and keepClear cells. Cells get `VOID`; edges stay OPEN; a CEILING_DEBRIS ring of props around it. `addStructure(StructureKind.PIT, rect, 0, PortalSpec{kind: 'pit', min/max = rect, y ∈ [−6, −1.5]})`. Repair runs after this, so connectivity routes around the hole.

**Landmarks** (each respects frozen seams and reserved cells, keeps ≥ 2 cells from seam lines except ENDLESS_HALL, and returns its `entrances`; footprint in cells):

| Kind | Storeys | Size | Content |
|---|---|---|---|
| RED_ROOM | 0 | 6×6 | CMU_PAINTED walls, 3 RED_BULB (SPHERE 200 cd, colour (1, 0.08, 0.05)), one DOORWAY, a hum emitter. |
| ENDLESS_HALL | 0, 1 | 32×2 | Restyles the artery lane through the chunk (WP1 only offers it in artery chunks): light in every other cell, the flanking artery walls replaced by continuous walls with DOOR_FRAME + DOOR_LEAF fakes every 4 cells. Its ends are the artery's seam openings (already OPEN); entrances = the lane cells at both ends plus any side door. |
| ATRIUM | 2 | 18×18 | Ceiling 1200, central pool, 4 tiled columns, SKY_PANEL grid at 1200, one RED_BULB. |
| CHAIR_CATHEDRAL | 0 | 24×24 | Ceiling 720, all lights OFF except one PENDANT_LINEAR over a lone CHAIR_STACKING in the centre, facing away. |
| FLOODED_HALL | 0, 1 | 12×16 | Water +25 cm everywhere; DYING lights; FLOOR puddles. |
| LOCKED_EXIT | 0 | 8×3 | A lit corridor ending in a DOOR_LEAF inside a DOOR_FRAME, EXIT_SIGN fixture above; an `interact` on the DOOR_LEAF makes WP13 play a locked-door rattle (audio only). Entrance = the corridor's open end. |
| VENDING_ALCOVE | 0, 1 | 4×3 | 2–3 VENDING_MACHINE props, each with a VENDING fixture (RECT 0.7×1.4, 600 nits cold white). |
| SERVER_ROOM | 1 | 8×8 | SHELF_RACK rows used as server racks; tiny emissive LED quads (decals with `emit` 40–200 nits and green/amber `color`); cold 5000 K TUBE_STRIP; a MACHINE emitter. |
| DEEP_END | 2 | 12×12 | A plunge pool (floor −400 cm, water −10) with a tiled diving platform (box solids, WALKABLE_TOP, 1.5 m, ramp stairs), UNDERWATER lights in all four pool walls, FLOAT_ROPE at the deep edge, NO_DIVING sign. |
| SKYLIGHT_HALL | 2 | 16×12 | Ceiling 900, a SKY_PANEL grid at 7000 K / 4000 nits covering 60% of the ceiling (daylight-white), POOL_TILE floor with a shallow film (WaterRect kind 2), LOUNGE_CHAIR rows. |
| LOCKER_ROOM | 2 | 10×8 | PARTITION rows as locker banks (METAL_PAINTED), BENCH_TILED between them, WET cells, TOWEL props, DRIP emitters. |
| LOADING_DOCK | 1 | 14×10 | Two roll-up openings (HEADER + ROLLUP trim) on one wall, a dock floor 1.2 m below the rest behind a HALF edge with a ramp at one end, PALLET/CRATE clusters, SODIUM lights. |
| BOILER_HALL | 1 | 12×12 | Ceiling 600, 3 BOILER + 2 TANK props, a pipe manifold (pipe solids between them), CAGE_BULBs, STEAM + MACHINE + PIPE emitters. |

**Fixture placement** (`placeFixtures`, lattice mode):
- **Candidates.** On the global 0.6 m tile lattice: `tileX = gi·2 + tx`, with `(tileX − phaseX) % latticeX === 0` (same for z). The rect is `w×h` tiles along `lighting.axis`.
- **Rejection.** The rect is rejected if it crosses a non-OPEN edge, a SOLID, RESERVED, TOWER or NO_CEIL cell, or a cell whose ceilCm differs within the rect, **or if it straddles a render-tile line** (`x0 < k·TILE_SIZE < x1` or `z0 < k·TILE_SIZE < z1` in world coordinates). Retry shifted by one tile (+x, then +z); otherwise drop.
- **Rooms without fixtures.** Rooms of ≥ 4 cells with no fixture get one centred fixture with p 0.5.
- **Id and colour.**
  - `grid.addFixture(f, { latticeI, latticeJ })` with the lattice tile of the fixture **centre** (`floor(worldX/0.6)`); the id formula is core's `fixtureId`. Custom placers (WP2/WP3, landmarks, exit signs) use the same call.
  - `color = kelvinToLinearRGB(lerp(cct0, cct1, warmth), 0.02 + 0.03·hash01)`.
  - Luminance ×(1 ± 0.06·hash).
  - Recessed fixtures set the covered ceiling tiles to `TileState.FIXTURE`.

**Fixture states** (`assignFixtureStates`, per fixture):
- `p = power(cell)·lighting.zoneMul·MOOD_POWER_MUL[mood]`, `u = hash01(hash2(id, SALT.FIXTURE_STATE))`.
- p < 0.18: OFF 85%, FLICKER 10%, DYING 5%.
- 0.18 ≤ p < 0.35: OFF 35%, FLICKER 15%, DYING 10%.
- Otherwise: OFF 3%, FLICKER 2%, DYING 2%, BUZZ 3%; the `decay` field adds up to +6% each to OFF and DYING.
- **One dynamic light per tile.** Among the FLICKER fixtures in each tile (tile = `tileOfPoint(px, pz)`), the one with the lowest `u` becomes `dynamic = true`; the others become DYING. Fixtures mounted more than `LIGHT.DYN_MAX_MOUNT` above their floor are never dynamic (FLICKER → DYING).
- **QA overrides.** `opts.lights`: 'on' → all ON, none dynamic. 'dead' → all OFF.
- Tower and elevator fixtures are always ON.

**Props** (`placeProps`):
- **Occupancy.** A 0.3 m bitmap (128×128 per chunk) of walls (dilated by the prop footprint), SOLIDs, keepClear cells and placed props.
- **Rules**, per 8×8-cell window of walkable area (not per `room`), with count = `round(per100m2·area/100·(0.5 + decay))`:
  - `wall`: back against a wall, yaw facing the room, sliding along the wall.
  - `corner`: a cell with 2 perpendicular walls.
  - `center`: the local maximum of the distance-to-wall transform (0.3 m bitmap) nearest to a hashed cell, searched within an 8×8-cell window (never a whole-room centroid: LOBBY "rooms" are huge and irregular).
  - `wallMounted`: on a wall face at `yCm`.
  - `cluster`: 2–5 of a kind within 1.5 m.
- `keepClear` = cells adjacent (Chebyshev 1) to any walkable seam edge, DOORWAY/HEADER/ARCH edges, artery lanes, and tower/elevator exits.
- A final check removes any COLLIDE prop that splits a room's walkable components (flood on the 0.3 m bitmap).

**Vignettes.**
- **Candidates.** On a global 18 m grid: one candidate per grid cell at a hashed position, kind weighted by zone (table below), kept with p 0.45. A candidate is dropped if a kept candidate in a neighbouring grid cell with a lower hash lies within 18 m.
- **Zone weights** (relative; 0 = never). FALLEN_TILES requires `ceilKind TILES`.

| Vignette | L0 family (LOBBY…OFFICE) | POOLROOMS | PARKING | PIPEWORKS | WAREHOUSE | CONCRETE |
|---|---|---|---|---|---|---|
| CHAIR_FACING_WALL | 10 | 3 | 2 | 2 | 2 | 4 |
| WET_FLOOR_SIGNS | 6 | 8 | 3 | 2 | 3 | 3 |
| FALLEN_TILES | 8 | 0 | 0 | 0 | 0 | 0 |
| LONE_DOORFRAME | 5 | 3 | 3 | 1 | 2 | 3 |
| MATTRESS_CLOSET | 4 | 1 | 1 | 3 | 2 | 4 |
| SPARKING_FIXTURE | 4 | 2 | 5 | 5 | 4 | 5 |
| RADIO | 3 | 2 | 3 | 3 | 3 | 3 |
| RINGING_PHONE | 3 | 1 | 2 | 1 | 1 | 2 |
| BACKPACK_CAMP | 3 | 2 | 3 | 4 | 4 | 4 |
| POOL_FLOAT | 0 | 10 | 0 | 0 | 0 | 0 |
| OPEN_CAR | 0 | 0 | 8 | 0 | 0 | 0 |
| COLLAPSED_RACK | 0 | 0 | 0 | 0 | 8 | 1 |
| STEAM_LEAK | 0 | 1 | 1 | 8 | 2 | 4 |
- **Placement.** Only in the chunk containing the candidate, only if the local space fits; otherwise it is skipped (no retry: determinism).
- **Compositions** (chunk-local, yaw from the room geometry):

| Vignette | Composition |
|---|---|
| CHAIR_FACING_WALL | CHAIR_STACKING 0.5 m from a wall, facing it |
| WET_FLOOR_SIGNS | a row of 3–5 WET_FLOOR_SIGN, plus WET cells and a FOOTPRINTS_WET decal |
| FALLEN_TILES | 2–4 ceiling tiles MISSING, plus TILE_FRAGMENT and CEILING_DEBRIS props below |
| LONE_DOORFRAME | a DOOR_FRAME standing free mid-room |
| MATTRESS_CLOSET | a MATTRESS in a ≤ 6-cell room |
| SPARKING_FIXTURE | a fixture set OFF, plus an `AnomalySite SPARKING` at it (WP11 spark bursts via the `spark` event, WP13 crackle) |
| RADIO | a RADIO prop plus a RADIO emitter |
| RINGING_PHONE | a PHONE on the floor plus a PHONE emitter |
| BACKPACK_CAMP | SLEEPING_BAG, BACKPACK, 2 BOTTLE, TALLY decal |
| POOL_FLOAT | a POOL_FLOAT drifting on a pool (y = water) plus a TOWEL draped on a nearby LOUNGE_CHAIR |
| OPEN_CAR | CAR_SEDAN variant 3 (driver door open) with a small interior RED_BULB-style fixture (RECT 0.3×0.1, 80 nits warm, ON) and a BACKPACK beside it |
| COLLAPSED_RACK | a SHELF_RACK variant 2 (collapsed: WP6 builds it tilted against its neighbour), 6–10 CARDBOARD_BOX spilled across the aisle (COLLIDE; the placement check keeps the aisle passable) |
| STEAM_LEAK | a STEAM emitter at a pipe or ceiling point, WET cells + WATER_STAIN decals below, a DRIP emitter |

**Leaks.**
- `count = floor(mean(humidity)·4 + hash01)` per chunk, each at a random walkable cell's ceiling, strength 0.3–1.
- Effects: tiles within 0.9 m become STAINED/SAGGING (p 0.6/0.2) or MISSING (p 0.1); floor cells below get WET with p 0.7; a DRIP emitter.
- The baker's mask uses `layout.leaks`.

**Exit signs.**
- Applies to chunks within 2 chunks of a tower.
- For each DOORWAY/HEADER edge whose crossing direction has `dot(dir, towerDir) > 0.7`, with p 0.35: add an EXIT_SIGN fixture (RECT 0.3×0.15, 150 nits red, facing the approach side, 5 cm below the header/head). **No separate decal:** WP6's EXIT_SIGN geometry carries the emissive SIGNAGE face.

**Chalk.**
- Junction cells (≥ 3 passable edges), p 0.12.
- Add a CHALK_ARROW decal on the floor. It points toward the nearest tower exit 70% of the time (`hash01 < 0.7`); otherwise it points along a random other passable direction. `rot` follows the `DecalPlacement` convention (floor: +v along `forwardXZ(rot)`), i.e. `rot = atan2(−dx, −dz)` for arrow direction (dx, dz).

**Decals** (`placeDecals`, rng `rngFor(seed, SALT.DECAL, s, cx, cz)`, field-driven, ≤ 60 per chunk):
- humidity > 0.55 → WATER_STAIN on wall bases and under leaks; MOLD at wall bases where humidity > 0.75;
- decay → SCUFF on walls at 0.1–0.9 m (p ∝ decay), CRACK on concrete floors/walls, HANDPRINT (rare, p 0.02 per room-window at decay > 0.6);
- PARKING/WAREHOUSE → OIL under stalls and rack aisles, DRAIN every ~12 m on concrete floors;
- RUST_STREAK below pipe solids and on METAL_PAINTED walls; DRIP under leaks;
- OFFICE → POSTER on DRYWALL walls (p 0.1 per wall run), PAPER on floors near desks;
- BURN near SPARKING sites.
Soft-alpha decals go to WP5's `decals` buffer; nothing is placed on keepClear seam edges, TOWER or ELEVATOR cells.

**Anomalies.**
- LATE_ECHO sites (p 0.05 per chunk) on corridor runs ≥ 10 cells long with `corridorWidth ≤ 2`, r = 6 m.
- REPEATED_ROOM (p 0.02 per chunk, L0 family): two adjacent DOORWAY-bounded rooms of equal size get byte-identical content (props, decals, fixture states re-seeded from the first room); the site marks the second room.
- CEILING_FURNITURE (p 0.01 per chunk): one room's chairs/desk are mirrored onto the ceiling (`PropFlag.CEILING`, base at `ceilCm`, no collision, no occluders).

**Acceptance**
- **Tower geometry.**
  - Replicas at k = −2..2 form continuous flights; stepping from landing to landing is ≤ STEP_MAX via ramps.
  - Collision `floorAt` (with WP12's builder) at matching points differs by exactly 3.0 m between replicas.
  - The DDA invisibility test passes.
- **Fixture rules.**
  - No fixture intersects a wall edge or a SOLID cell.
  - ≤ 1 dynamic light per tile, over 1000 chunks.
  - The state mix over 1000 chunks of the spawn storey is within ±3% of the formula's expectation.
- Props never overlap walls, other props or keepClear cells.
- `validateLayout` passes.
- Vignette spacing is ≥ 18 m over a 20×20-chunk region.
- Fixture ids are unique per chunk; no recessed rect straddles a tile line; tower and elevator fixture ids are identical in all 3 storeys.
- Every landmark's `entrances` are walkable and reachable after repair (1000 chunks with `forceLandmark` rotation).
- **Screenshots:** `goto=tower` at the mid landing; `goto=landmark:RED_ROOM`; `goto=vignette:CHAIR_FACING_WALL`; `goto=landmark:DEEP_END`; `goto=vignette:OPEN_CAR`.

**Must NOT touch:** the pipeline order (WP1), zone layouts (WP2/WP3), meshing (WP5). Tower geometry lives only as solids, edges and cells.


---

### WP5: Mesher (surfaces, charts, atlas, shell and water geometry)

**Goal:** turn a `LayoutNeighborhood` plus a tile into tile-local mesh buffers and a deterministic `SurfaceSet` whose chart hash matches in build and bake. Output is watertight, has no duplicate faces, and stays within the triangle budget.

**Files:** `src/mesh/*`, `tests/mesh/*`.

**Exported API:**
```ts
// mesh/buildTile.ts
export function buildTile(nb: LayoutNeighborhood, tile: TileKey, tpc: LmTpc): { mesh: TileMesh; surfaces: SurfaceSet };
// mesh/surfaces.ts: identical charts to buildTile (the bake job calls this; it does NOT build vertex buffers)
export function buildTileSurfaces(nb: LayoutNeighborhood, tile: TileKey, tpc: LmTpc): SurfaceSet;
// mesh/chartHash.ts
export function chartHash(charts: readonly Chart[]): number;
// mesh/periodic.ts: tower replication shared with collision (WP12) and bake (WP7) via import
export function expandPeriodicSolids(l: ChunkLayout, extraK?: number): Solid[];      // replicas at y + 3k, clipped to |y| <= TOWER_SPAN (+extraK periods beyond)
export function expandPeriodicFixtures(l: ChunkLayout, extraK?: number): Fixture[]; // replicas keep the base id and seed
export function expandPeriodicProps(l: ChunkLayout): PropPlacement[]; // props anchored in TOWER cells replicated like solids; others unchanged
```

**Consumes:**
- core (edges, grid, layout, writer, materials);
- WP6 `buildTileProps(nb, tile)` for the props mesh. Recessed fixtures are WP5's own geometry;
- WP1 `nb.region()`.

**Rules and algorithms**

1. **Face ownership** (§2.2). Iterate the tile's cells, plus the edge lines `[li0 .. li0+16]` × cells `[lj0, lj0+16)` (and the equivalent for ez). Every generated face is clipped or split at cell lines. A face is emitted only if its owner cell lies in the tile and is not SOLID. It is also not emitted if it faces a TOWER cell from group 0. Tower-internal faces belong to the tower group. Solids are meshed **only from `nb.center`** (the core duplicate rule guarantees every chunk has the solids that touch it); pipes by midpoint (WP6).
1b. **Solid mass coverage** (everything collision and the bake treat as solid is visible):
   - **SOLID neighbours.** For every edge between a non-SOLID cell and a SOLID cell whose edge has no full-height rendered piece (OPEN, or any kind whose pieces leave a gap), emit a full-height face on the **edge line**, owned by the non-SOLID cell (WALL chart, the palette wall material of that cell, `matNeg/matPos` if set), plus posts where such faces meet other walls. A face on the line is leak-free: the SOLID-side floor texel is invalid and is dilated from the same side.
   - **Blockers.** Cells with `blockCm > 0`: a top face at `floor + blockCm` (BOX chart, owned by the cell) and side faces on the cell lines up to `floor + blockCm` (BOX charts, owned by the neighbour cells), material = the cell's `floorMat` (the floor under a blocker is never visible, so generators set `floorMat` of blocker cells to the blocker's material: WOOD counters, METAL_PAINTED racks, CONCRETE_WALL plinths).
   - **VOID cells** (pits): side faces from the neighbours' floors down to −6 m (STEP charts, owned by the VOID cell's side, i.e. facing into the pit) and a PLENUM-dark bottom quad at −6 m (borrowed dark lmUv). The edge fog/haze makes the bottom read as depth.
2. **Walls.**
   - For every edge with `EDGE_RENDERS`, call `edgePieces(kind, hA, hB, yLo, ySill, yHi)`. `yLo`/`ySill`/`yHi` come from the two adjacent cells; a TOWER cell uses −6/6.
   - Each piece produces two faces at `±edgeThickness/2`. Each face is clipped to its owner cell's vertical span `[floor, ceil]`.
   - **Partition plinth.** Every PARTITION edge also gets a `PARTITION_BASE_T`-wide, `PARTITION_BASE_CM`-tall plinth box (sides + top, TRIM_BORROW lmUv from the partition face above it, material RUBBER). This is what makes the floor-level no-leak invariant hold for partitions (§2.3).
   - **GLITCH faces** use a hashed 2–6 cm material-UV offset (the visual tell); geometry is a normal WALL.
   - **ROLLUP trim** (`EdgeTrim.ROLLUP`): a METAL_PAINTED header box on the HEADER piece (0.3 m deep, full opening width, from `hA − 0.35` to `hA`), BOX/SOFFIT charts, plus a slatted door-bottom strip.
   - **Posts.** At each vertex where rendered edges end, turn, or form a T, add a `WALL_T²` post box whose height is the union of the adjacent spans. Wall faces stop at the post faces (`±WALL_T/2` from the vertex); faces that run straight through a vertex continue.
   - **Openings.** Emit piece caps (tops of HALF/PARTITION/RAIL), lintel/header undersides, jamb reveals and window sills. A face that straddles a line is split at that line.
   - **ARCH.** Intrados with 8 segments along the half-circle; the spandrels are triangulated with the curved cutout.
3. **Wall charts.**
   - One chart per **maximal run**: consecutive collinear faces facing the same side, with the same owner-cell floor/ceil span, `bakeGroup`, and material. A run is broken at posts and at the tile boundary; a break at the tile boundary sets the `cont` bit.
   - The chart covers the full run rectangle (including door holes, whose texels stay unused); lintel and jamb faces coplanar with the run map into it.
   - `axisU` = texel along the run direction, `axisV` = texel up, so texel rows are integral per 3 m (towers). Origin = run start at the owner floor, minus one texel (the apron).
   - Material uv on every vertical face: `u` = along-run metres / `repeat`, `v = y / layerRepeatY(layer)` (towers depend on this).
   - Caps, undersides, reveals and sills get small SOFFIT/BOX charts, at least 2×2 plus the apron.
4. **Floors.**
   - Cells with a floor (not SOLID/VOID/TOWER) are merged into greedy rectangles per `(floorCm, floorMat, WET flag, region, ceilCm)`.
   - `lmUv` comes from the FLOOR_GRID mapping.
   - Flags: `FLOOR_AUX`, plus `REFLECTIVE` if `LAYER_DEFS[mat].reflective` or the cell is WET.
   - `aux = (clamp(reflPlaneCm/5, 0, 255), key & 255, key >> 8, waterByte)` with `key = regionKey(nb.region(cell))` (1..2048) and `reflPlaneCm` = the height above floor of the **emitters** reflected there: the ceiling, or, when the dominant emitters within 3 cells hang below the ceiling (mountCm > 0, e.g. PENDANT_LINEAR, HIGHBAY), their mean emitting-surface height.
   - **Submerged surfaces.** Floors, steps and wall faces below a `WaterRect` surface get `VFlag.UNDERWATER` and `aux.w = clamp((waterCm + 320)/5, 0, 255)` (`waterByte` above).
   - **METAL_GRATE floors**: the floor quad is flagged `DECAL` (alpha-tested holes from `albedo.a`) and a 0.4 m PLENUM pit is emitted below it (4 sides + bottom, lmUv borrowed from the floor grid at the same xz, tint ×0.3). Collision, connectivity and the bake still use `floorCm`.
   - Step faces where the floors of adjacent cells differ and the edge has no full piece: a STEP chart, owned by the lower cell. Pool walls are step faces.
5. **Ceilings.** Per 0.6 m ceiling tile, by `TileState`:
   - NORMAL/STAINED/NEW/DIRTY: a quad at `ceilCm + 0.01` (tiles sit 10 mm above the grid face). `tint` carries a ±3% hashed brightness (NEW +8%, DIRTY −12%). STAINED only sets a tint; the stain rings come from the mask.
   - SAGGING: 4 triangles with the centre 3 cm lower.
   - MISSING: a plenum box 0.5 m deep with PLENUM layer, PLENUM chart kind; a dark duct is optional.
   - VENT: a quad plus a VENT_GRILLE decal.
   - FIXTURE: skipped (the fixture fills it).

   - **T-bar grid** (CeilKind TILES): inverted-T strips 24 mm wide, 12 mm deep on every 0.6 m line (merged per line per tile, TRIM_BORROW lmUv from CEIL_GRID, layer TRIM_PAINT tinted off-white, ~2–4k triangles per tile), skipped where a MISSING tile exposes the plenum on both sides.

   The CEIL_GRID chart covers everything else. CeilKind CONCRETE/TILE_GLAZED use greedy quads; BEAMS uses flat quads (the beams are solids); **TRUSS emits a METAL_DECK corrugated deck** at `ceilCm` (flat quad, the corrugation is in the normal/height map, CEIL_GRID chart); OPEN_DARK and cells flagged NO_CEIL emit nothing.

   **Soffits.** Where the ceilings of adjacent cells differ and the edge is not full-height, add a vertical face owned by the **higher-ceiling** cell (SOFFIT chart).
6. **Recessed fixtures** (TROFFER_2x4, TROFFER_2x2, SKY_PANEL):
   - Emitted **whole** in the tile `tileOfPoint(px, pz)` (an explicit exception to face splitting; generation guarantees the rect never straddles a tile line, so this is also the owner of every piece).
   - Four housing faces, 3 cm deep, plus a 2 cm frame, with lmUv borrowed from CEIL_GRID at their xz (TRIM_BORROW).
   - A lens quad facing down at `ceilY + 0.03`, layer PANEL_LENS, uv 0..1 per 0.6 m, lmUv borrowed from CEIL_GRID at its xz; tint = fixture colour, or a neutral dusty grey (0.55, 0.53, 0.5) for OFF lenses.
   - `emit` = `fixtureRadiance(f)` (colour in tint) for ON/BUZZ; ×`DYING_MEAN` for DYING; full value with `DYN_EMIT` for dynamic lights; 0 for OFF.
   - `SHIMMER` flag for DYING/BUZZ. On every `DYN_EMIT`/`SHIMMER` vertex: `aux.w = state`, `tint.a = fixture.seed & 255` (the GLSL shimmer inputs).
   - **Emitter profile** (graphics-realism C.2, `core/emitterProfile.ts`), on every lens in every state (OFF included): `aux.x = (U−1) | (V−1)<<3 | axis<<6` (lens size in ceiling tiles, axis 1 = lamps along v), `aux.z = profile<<1 | variant<<5` (SKY_PANEL → OPAL; troffers → LOUVER with the zone's `LOUVER_P` (OFFICE 0.85), else PRISM; variant = lamp count − 2 (2x4: 3 lamps at p 0.6, else 2; 2x2 prism: two U-tubes), bit 7 = yellowed lens with the zone's `AGED_P`), `aux.w = state`, `tint.a = seed & 255`. The lens uv runs along world +x / +z (the shader's lens frame).
7. **Solids.**
   - Boxes (after `expandPeriodicSolids`): every face not flush with a floor, ceiling or SOLID cell, BOX charts.
   - Ramps: visual treads and risers plus stringers, all mapped to one RAMP chart (the sloped plane from `(x0, y0)` to `(x1, y1)`; texels are projected by xz), **plus a sloped soffit** (the underside, 0.15 m below the nosing line, SOFFIT chart) so stair stacks are opaque from below. Handrails come from WP6 props.
   - `SolidFlag.FILLED` ramps (built-up bodies: pool terraces, arch steps and pool entries, lobby sunken-area and office aisle steps, daises, pit steps, concrete ramps) have no soffit: their sides and a free-standing back face run down to the floor, each on its own vertical BOX chart (lit as the wall of a block, with its floor contact). The baker makes the whole body an occluder (`rampSlabThickness(…, filled)`: the whole rise plus 0.1 m, under the top line `filledTopLine` through the back edge of every tread, so the face over the top tread stays outside it), so no light passes through it and the hidden floor under it is invalid. Collision and `WorldQuery.raycast` treat it as solid too (the `filled` float of `collision.ramps`: `ceilingAt` inside the body is the query height, rays hit its sides and ends). For rays an open flight is a slab 0.2 m (`RAMP_SLAB`) thick under its walking line: rays rising under it hit the sloped soffit, and its stringers and ends are hit between the soffit and the walking line. Open flights (towers, split-level halls, steel and landmark staircases) keep the soffit; the floor and wall under them are valid texels whose analytic AO includes the slab above (`aoAt`).
   - Pipe solids go to WP6.
8. **Trims.**
   - Baseboards (0.10 m tall, 0.015 m proud) on wall faces whose edge has the `BASEBOARD` trim bit.
   - DOORWAY casings (0.07 m) where the edge has `CASING`.
   - Threshold strips where `floorMat` changes across a passable edge (`EdgeTrim.THRESHOLD` forces one even without a change).
   - All use layer `TRIM_PAINT` (or the palette's trimMat) with lmUv **borrowed** from the wall chart or floor grid behind them (TRIM_BORROW).
9. **Decals** (separate `decals` buffer, drawn with the `decal` material variant; see §1.2).
   - Each `DecalPlacement` becomes a quad offset 2 mm along its normal, flag `DECAL`, layer `DECAL_ATLAS` (or `SIGNAGE` when `sign`), with uv mapped to the atlas slot so that the slot's +v follows the `rot` convention in `core/layout.ts`.
   - `kind === DECAL_PAINT_STRIPE` → layer `FLOOR_PAINT`, uv in metres.
   - lmUv is borrowed from the surface underneath (floor grid, or the wall chart found by line/side lookup).
   - `emit`/`color` from the placement (0 / white by default). No kind has hard-coded emission.
   - Decals whose surface is not in this tile are clipped to the owner tile's cells (quads split at cell lines like faces).
10. **Water.**
    - Each `WaterRect` intersecting the tile becomes quads at `y` with flag REFLECTIVE, lmUv from the FLOOR_GRID at the same xz, `tint = (1, 1, 1, kind)` (0 pool, 1 flooded, 2 film), `aux.x = clamp((y − floorY)·50, 0, 255)` (depth in 2 cm units), `aux.y/z` = the region key of the rect's cells in the tile (0 when they span several regions) and `aux.w = clamp((floorY + reflPlane − y)·20, 0, 255)` (floorAux's emitter plane above the water, 5 cm units). WP9 identifies the mirrored plane by the fragment's own y.
    - These go into the separate `water` buffer. The optics of the water body live on the submerged surfaces (rule 4); the water mesh itself only carries reflection and specular.
11. **Wall tints.** Per run: roll shade `±2%` (hash of run id) times a warmth hue shift of ±4° (warmth field of the owner cell: warm → +R−B).
12. **Atlas** (`atlas.ts`):
    - FLOOR_GRID at (0, 0) and CEIL_GRID at (S + 2·PAD, 0), with `S = 16·tpc + 2`.
    - All other charts are shelf-packed, sorted by (h desc, w desc, id asc), with `LM_PAD = 2` gutters.
    - Height is the smallest of {256, 512, 768, 1024} that fits.
    - **Overflow rule:** repeatedly double `axisU`/`axisV` (halve the density) of the largest remaining non-grid chart **with bakeGroup 0** until the charts fit. Grid charts and tower/elevator charts (bakeGroup ≠ 0) never change, so a tower bakes at the same density in every storey.
13. **Determinism.** Charts are generated in a fixed order (floor grid, ceil grid, walls by line then side then position, steps, soffits, boxes by id, ramps by id, plenums). `chartHash` = FNV over `(kind, x, y, w, h, origin, axes quantized to 1e-5, cont, bakeGroup)`.
14. **Budget.** ≤ 60k triangles per tile shell typical; **hard cap 120k** (tested on the worst zones at tpc 12).
15. **Dynamic lights.** `dynLights`: the 9 slots from `DYN_SLOT_OFFSETS`. For each neighbouring tile, pick the `dynamic` fixture with `tileOfPoint(px, pz)` equal to that tile (from the neighbourhood layouts; `null` if none) and convert it to a `DynLightRef` in world metres.

**Acceptance (vitest; fixtures from `layoutFromAscii` and `generateChunk` for every zone):**
- No NaN; indices in range; no degenerate triangles; normals unit length within 1%.
- Every `lmUv` lies inside its chart rect, or inside a borrowed chart.
- Charts do not overlap; the atlas fits.
- `buildTileSurfaces(...).hash === buildTile(...).surfaces.hash` over 100 tiles.
- **Ownership:** for every face, `centre + 1 cm·normal` lies in a tile cell. Across a 2×2 block of tiles, no two faces coincide (hash of quantized face centres).
- **Watertight walls:** wall faces meet posts with gaps < 1 mm.
- Grid texel boundaries fall on wall lines; the `lmTexel(tpc)` invariant holds.
- Triangle cap respected.
- Tower replicas are identical up to the y offset (shell, and props via `expandPeriodicProps`); tower vertical-face uvs at y and y + 3 m are identical mod 1.
- **Coverage fixtures:** a narrow-maze chunk (SOLID wall cells behind OPEN edges), a SOLID/blocker chunk and a pit chunk: every cell side between walkable and SOLID/blocker/VOID space is covered by a face (ray casts from walkable cells at 0.5/1.5 m in 16 directions never escape to the clear colour).
- **Partitions:** every PARTITION edge has a plinth; no floor texel within `PARTITION_BASE_T/2` of a partition line is visible.
- **Decals:** a floor decal with `rot = 0` has +v along −Z; `rot = π/2` has +v along −X; a wall decal with `rot = 0` has +v = +Y (`tests/mesh/decals.test.ts`).
- **Straddle:** no recessed fixture geometry is split across tiles; `dynLights` slots match `tileOfPoint`.
- Build takes ≤ 20 ms per tile, excluding props.
- **Harness:** `harness/chunk.html?seed=1&cx=0&cz=0&view=lightmap|uv|texel` (WP10's page) shows clean walls, posts and ceilings.

**Must NOT touch:** layouts (read-only input), the baker, props geometry, the material shaders.

---

### WP6: Prop and fixture geometry

**Goal:** believable, low-poly, procedurally modelled props and surface fixtures written through `GeometryWriter`. Merged per tile into one props mesh lit by the tile light volume.

**Files:** `src/props/*`, `tests/props/*`.

**Exported API:**
```ts
// props/index.ts
export function emitProp(w: GeometryWriter, p: PropPlacement, ox: number, oz: number): void; // (ox,oz) = chunk-local origin of the tile
export function emitFixture(w: GeometryWriter, f: Fixture, ox: number, oz: number): void; // non-recessed kinds only
export function emitPipe(w: GeometryWriter, pipe: Extract<Solid, { kind: 'pipe' }>, neighbours: readonly Extract<Solid, { kind: 'pipe' }>[], ox: number, oz: number): void;
export function propTris(kind: PropKindId, variant: number): number;
// props/tileProps.ts
export function buildTileProps(nb: LayoutNeighborhood, tile: TileKey): MeshBuffers | null;
```

**Rules**
- **Local frame** as defined in `PROP_DEFS`: base centre at the origin; the front faces −Z at yaw 0. Use `w.setTransform(yaw, scale, x−ox, y, z−oz)`.
- **Materials per part** go through `w.setState(layer, VFlag.PROP_AUX, tint, emit, aux)`. `aux = (0, 0, bits, ceilByte)`:
  - `bits & 1`: the prop is tower-periodic (anchor cell is a TOWER cell): the shader wraps y for its light-volume lookup;
  - `ceilByte = clamp(ceilCm/5, 0, 255)` of the anchor cell (the cell containing the prop origin): the ceiling plane for emission-map reflections on glossy props;
  - wall clamping is per fragment from the tile's `wallMask` texture (WP7), so no per-prop mask is needed.
  - `aux.y` (0 = none): thin tubes (fixture cables, cords and drop rods, pipe hanger rods; `PartBuilder.wire(r)`) store their radius in 0.1 mm. The surface and depth-prepass vertex shaders push those vertices out along their radial normal until the tube is at least 0.75 px in radius on screen, so a distant cable stays a continuous 1-pixel line instead of breaking into dashes. `aux.y = 255` (`DROP_LENS_AUX`, `PartBuilder.dropLens`) instead marks a 4 mm drop lens (PENDANT_LINEAR) whose down-facing vertices are lowered until the lens is at least 1 px deep, so distant lenses seen edge-on stay lit lines; the pendant housing has only a frame around the lens (a full bottom face just above it z-fought with it beyond ~30 m).
  - **aux.z contract** (graphics-realism C.3, `PartBuilder`): bit 0 = tower. Emissive parts (`emissive(…, ep, variant, param)`): bits 1-4 = emitter profile, bits 5-7 = variant, `aux.x` = the profile parameter (TUBE / DROP / SODIUM: length in cm). Other parts (`mat(…, rough, coat)`): bit 1 = clearcoat, bits 2-7 = dust 0-63 from the prop's `auxBits`, `aux.x` = the roughness override. Profiles: TUBE_STRIP tubes TUBE (v ∈ [−0.5, 0.5] along the tube, variant = tube index), CAGE_BULB BULB (half clear glass), RED_BULB sphere BULB, HIGHBAY disk HIGHBAY (uv = xz / r), PENDANT_LINEAR bottom DROP and SODIUM bottom SODIUM (uv ∈ [0, 1]², u along the long axis); lens sides, signs, vending and pool lights stay legacy, and OFF fixtures keep the legacy dusty lens.
- `PropFlag.CEILING`: emit the prop mirrored in y about its base (winding reversed) with the base at `p.y`.
- **UVs:** part-local metres / `LAYER_DEFS[layer].repeat`, or a profile's own scale after `PartBuilder.uvScale(su, sv)` (until the next `mat` / `emissive`).
- **Bevels:** 1–2 cm chamfers on box primitives, which catch highlights.
- **Budgets:** ≤ `PROP_DEFS.maxTris`. Everything fits inside `PROP_DEFS.size` (tested for every kind, variant and 4 yaws).
- **Primitives** (`primitives.ts`): bevelled box, cylinder (n segments, optional caps), tube-along-polyline with elbows, torus quarter, extruded 2D profile, frame.
- **Kinds (45) and parts.** Part materials in parentheses. Variants change proportions and colour tint.

| Kinds | Parts |
|---|---|
| Office | DESK (WOOD top + METAL_PAINTED legs/modesty panel); OFFICE_CHAIR (FABRIC seat/back, PLASTIC 5-star base, casters); FILING_CABINET (METAL_PAINTED, 4 drawers, handles); CRT_MONITOR (PLASTIC shell, dark glass screen with roughness 0.1); CONFERENCE_TABLE; WATER_COOLER (PLASTIC + a blue-tinted jug) |
| Industrial | CRATE (WOOD slats); PALLET; SHELF_RACK (METAL_PAINTED orange beams + blue uprights, 3 shelves); BOILER; TANK; PIPE_VALVE (wheel); VENT_GRILLE; EXTINGUISHER |
| Pool | POOL_LADDER (chrome METAL_PAINTED tube); LOUNGE_CHAIR; LIFEBUOY; BENCH_TILED |
| Misc | CHAIR_STACKING; TRASH_CAN; CONE; WET_FLOOR_SIGN (yellow PLASTIC + SIGNAGE WET_FLOOR decal); WHEEL_STOP; CAR_SEDAN (≤ 2500 tris, METAL_PAINTED body, dark windows, RUBBER tyres; variant 3 = driver door open); MATTRESS; PHONE; RADIO; BACKPACK; SLEEPING_BAG; BOTTLE; BUCKET; MOP; CARDBOARD_BOX; DOOR_FRAME; DOOR_LEAF; ELEVATOR_DOOR; OUTLET; THERMOSTAT; HANDRAIL; CEILING_DEBRIS; TILE_FRAGMENT |
| Pool extras | FLOAT_ROPE (RUBBER rope + 8 PLASTIC floats, alternating red/white tint); POOL_FLOAT (PLASTIC ring lounger); TOWEL (FABRIC, draped profile) |
| Variants with shape changes | SHELF_RACK variant 2 = collapsed (uprights tilted 25°, shelves hanging) — still inside `size` |

- **Surface fixtures** (`emitFixture`). The emissive part uses `emit = fixtureRadiance(f)` (×`DYING_MEAN` for DYING, 0 for OFF), tint = colour, flags `DYN_EMIT`/`SHIMMER` as in WP5, with `aux.w = state` and `tint.a = seed & 255` on those vertices. SPHERE emissive geometry has radius exactly `f.w/2` (the radius `fixtureRadiance` and the WP7 soft-core clamp assume); HIGHBAY's emissive disk has radius `f.w/2`. A CAGE_BULB (64 cd, w 0.1) therefore shows ≈ 8,150 nits and clips into bloom.

| Fixture | Geometry |
|---|---|
| TUBE_STRIP | 1.2 m batten + 2 tube cylinders |
| CAGE_BULB | base + emissive sphere, r 0.05 + 6-wire cage |
| HIGHBAY | bell reflector + emissive disk + drop rod up to `ceilCm − 0.6` (the joist) |
| PENDANT_LINEAR | 1.2 m aluminium box + emissive bottom + 2 cables to the ceiling |
| SODIUM | box + orange emissive lens |
| EXIT_SIGN | box + SIGNAGE EXIT face, emissive (the only EXIT geometry; WP4 adds no decal) |
| UNDERWATER | flush round lens |
| VENDING | front panel emissive, added to the VENDING_MACHINE |
| RED_BULB | bare emissive bulb |

- **Pipes.** 10-sided tubes (`METAL_PAINTED` or `METAL_RUST` by decay). A quarter-torus elbow wherever two pipe solids share an endpoint (6 segments). Flanges every 2.4 m; hangers to the ceiling every 2.4 m.
- **`buildTileProps`:**
  - props (after `expandPeriodicProps`) whose origin lies in the tile;
  - non-recessed fixtures with `tileOfPoint(px, pz)` = this tile, after `expandPeriodicFixtures`;
  - pipe solids of `nb.center` whose midpoint lies in the tile.

  Returns `null` if the tile has none.

**Acceptance**
- Bounds and triangle budgets hold for all kinds, variants and yaws.
- **Emitter calibration:** for every fixture kind, (emissive nits × projected emissive area) is within 20% of the intensity (SPHERE/disk) or of `L·A` (RECT).
- Normals point outward (sampled ray tests on closed parts).
- No NaN.
- `buildTileProps` is deterministic.
- A per-tile props triangle count is reported; target ≤ 40k.
- **Screenshot:** `testScene=materials` shows one of each prop along the gallery walls; this is WP1's scene, which calls `grid.addProp` for every kind.

**Must NOT touch:** placement logic (WP4), shell geometry (WP5).

---

### WP7: Light baker

**Goal:** leak-free, physically based, deterministic lightmaps for a tile from its 3×3-chunk neighbourhood.
- Preview in ≤ 60 ms.
- Full in **≤ 600 ms** at high (tpc 12, 4 samples, 96 probe rays) on the worst zone, single-threaded on the target CPU, **with a warm per-chunk cache** (see below); ≤ 900 ms cold.
- **Seam-exact:** every quantity that feeds a texel is a pure function of world position and light id, never of which tile is baking.

**Cost model** (why the targets hold in open zones with ~45–107 lights in range): the dominant costs are visibility traces for patches, light-volume samples and classification, which do not depend on `shadowSamples`/`probeRays`. They are removed by (1) one shared per-(cell, light) visibility bitset, (2) the `LIGHT.K_MAX` strongest lights per receiver, (3) coarse far patches, and (4) a per-chunk cache reused by the chunk's 4 tiles (WP10 routes a chunk's jobs to the same worker).

**Files:** `src/bake/*`, `tools/bakebench.ts`, `tests/bake/*`.

**Exported API:**
```ts
// bake/index.ts
export function bakeTile(nb: LayoutNeighborhood, tile: TileKey, surfaces: SurfaceSet, variant: 'preview' | 'full', q: BakeQuality, term: BakeTerm): LightmapData;
// bake/context.ts (test helpers; stable)
export interface BakeContext { readonly tile: TileKey; readonly lights: readonly Fixture[]; readonly originX: number; readonly originZ: number }
export function createBakeContext(nb: LayoutNeighborhood, tile: TileKey, q: BakeQuality): BakeContext;
export function traceVisible(ctx: BakeContext, ax: number, ay: number, az: number, bx: number, by: number, bz: number, group: number): boolean; // tile-local metres
export function irradianceAt(ctx: BakeContext, p: Vec3, n: Vec3, group: number, out: Vec3): void; // direct only, lux
/** Opaque per-worker cache (visibility bitsets + patch radiance per chunk, LRU 16 chunks). Never transferred.
 * bakeTile output is byte-identical with or without it (tested). */
export interface BakeCache { readonly chunks: number; clear(): void }
export function createBakeCache(): BakeCache;
// bakeTile(..., cache?: BakeCache) — optional 7th parameter
```

**Consumes:**
- core edges, layout (`fixtureRadiance`), grid (`tileOfPoint`), materials (`LAYER_DEFS.albedoMean`), props (`PROP_OCCLUDERS`), zones (`ZONE_INFO.lightR`, `LANDMARK_LIGHT_R`), and flicker (`flickerMean`);
- WP5 `expandPeriodicSolids` / `expandPeriodicFixtures` / `expandPeriodicProps`;
- WP1 `nb.region`, `corridorWidth`.

**Algorithms**

1. **VisGrid** (`visgrid.ts`).
   - Flatten the neighbourhood into halo arrays covering the tile rect ± `LIGHT.HALO_CELLS` (24) cells (64×64 cells; the 3×3 neighbourhood always contains it): floor/ceil/block heights, flags, and ex/ez kind/hA/hB, all in metres. Every visibility ray (texel, patch, probe, LV) stays inside the halo because lights are within `R_MAX` and probe rays within `PROBE_RAY_MAX`.
   - Per-cell buckets of occluder boxes:
     - `expandPeriodicSolids` boxes with OCCLUDE;
     - the `PROP_OCCLUDERS` part boxes of every prop that has a part list (desk tops and panels, seats, chair backs near a quarter-turn yaw, car bodies on their wheels, rack uprights and decks…; a part list takes precedence over `occlude`), and the whole footprint of the other props with `PROP_DEFS.occlude` or the OCCLUDE flag, yaw snapped to 90°; prop boxes that abut exactly with the same cross-section (the touching uprights of neighbouring racks) are merged into one box (the same solid, fewer DDA box tests);
     - SOLID cells as blocks.
   - **Shared visibility bitset** (`visbits.ts`): for every (halo cell, light in range) the visibility of the light's centre from the cell centre at 3 heights (floor + 0.4, mid, ceil − 0.35), computed once per chunk neighbourhood and cached per chunk. Used by the patch cache, the light volume, preview classification and as the full-bake classification early-out.
2. **DDA** (`dda.ts`). A 2D Amanatides–Woo walk in xz along the segment, with the height interpolated.
   - Within each cell: occluded if `y < floor` or `y > ceil`; if `y < floor + blockCm` inside a blocker cell; or if the segment hits a bucketed box (slab test).
   - At each edge crossing: `edgeOccludesAt(kind, hA, hB, t, y, ySill)` at the crossing point. Corner (vertex) crossings test both edges.
   - **Group isolation:** a ray from a texel of group g ignores occluders of other groups. Group-0 rays treat TOWER/ELEVATOR cells as solid.
3. **Lights.**
   - All fixtures of the 9 layouts (after `expandPeriodicFixtures`, which for tower groups extends k so that |3k| ≤ TOWER_SPAN + window R).
   - Each light's window R is computed from **its own** chunk only, so neighbouring tiles see the same light set: `R = min(R_MAX, max(ZONE_INFO[layout zone].lightR, LANDMARK_LIGHT_R[landmark containing the light] ?? 0, mountHeightAboveFloor + MOUNT_R_EXTRA))`, where mountHeightAboveFloor = emitter y − floor of the light's cell. Tower lights: 4.5 m. (ATRIUM panels at 12 m get R = 20 m; vaulted POOLROOMS at 7.2 m get 15.2 m.)
   - Keep lights whose centre is within R of the tile rect (plus the apron).
   - **K_MAX.** Per receiver (texel block, patch, LV sample) only the `LIGHT.K_MAX` lights with the largest unshadowed estimate `I_max·w(d)/d²` whose bitset visibility is not zero at all 3 heights are evaluated; the rest are dropped (their sum is < 2% in practice; asserted in the bench).
   - **Static set:** ON, BUZZ, DYING (×DYING_MEAN, colour lerped 20% toward (1, 0.8, 0.85)), and FLICKER/ANOMALY lights that are not dynamic (impossible after WP4, but assert).
   - **Dynamic set:** `dynamic === true` → channel = `tileChannel(tile containing the light)` with that tile = `tileOfPoint(px, pz)` in the light's own chunk, using the `R_DYN` window.
   - **Radiance.** Emitter RGB radiance = `fixtureRadiance(f)·color` for every light (core/layout.ts); SPHERE lights use intensity `luminance` directly.
   - OFF lights emit nothing.
4. **Texel setup** (`context.ts`).
   - **Grid charts:** the texel centre `(u − 0.5)·t` → xz. Owner cell = the cell containing the centre (never on a line, by construction). y = owner floor + 0.02 (floor) or owner ceiling − 0.02 (ceiling). The sample is clamped `LM_SAMPLE_WALL_CLEAR` inside the owner cell on any side whose edge occludes at that height.
   - **Other charts:** `p = origin + (u + 0.5)·axisU + (v + 0.5)·axisV + 0.02·normal`. Owner cell = the cell containing `p + 0.01·normal`.
   - **Invalid texels:** owner cell SOLID/VOID, TOWER for group 0, inside an occluder box, or outside the face extent without a `cont` bit. They are filled by dilation at the end.
   - **Apron texels** with `cont` bits are baked at their true positions.
5. **Direct, full** (`classify.ts`, `direct.ts`, `areaLight.ts`).
   - **Classify per `(receiver patch, light)`.** A patch is the texels of one chart inside one owner cell. Early-out from the bitset: if the owner cell and its 8 neighbours all see the light at all 3 heights → FULL; if none of them sees it at any height → NONE. Otherwise test 16 segments: 4 inset patch corners (inset 0.05) × 4 emitter corners, or 4 sphere-surface points.
     - FULL → evaluate the form factor per texel, no rays.
     - NONE → skip.
     - PARTIAL → per texel, S = `q.shadowSamples` stratified emitter points (Halton, rotated per texel by `hash(quantized world pos)`), visibility fraction × form factor. Adaptive for the dynamic lights and for static lights below 15% of the patch's unshadowed estimate (never at seam texels): when the first quarter of the samples (2 of 4 or 6, 4 of 16; opposite emitter quadrants) agree, the rest are not cast. Measured against a 16-sample bake the lightmap error moves from 0.60% to 0.65% (OFFICE) and 0.38% to 0.42% (WAREHOUSE) mean; adaptive for every light would be 0.81% / 0.53% (ultra p99 up to 15%), for ~4% more bake time saved.
   - **Form factor (hybrid).** If `d < LIGHT.POLY_EXACT_FACTOR · max(w, h)`, use the **exact clipped polygon** (Sutherland–Hodgman clip of the emitter rectangle to the texel's tangent half-space; Lambert polygon formula `E = L/2 · Σ acos(v̂k·v̂k+1)·(n·normalize(vk × vk+1))`). Otherwise use a point or 2-point sample `L·A·max(0, n·ω)·max(0, −nL·ω)/d²`. SPHERE lights: `I·max(0, n·ω)/d²` with a soft-core clamp `d² ≥ r²`.
   - **Window.** Multiply by `(1 − (d/R)⁴)²`.
   - **Adaptive 2×2 refinement** within FULL/NONE-uniform blocks: evaluate block corners, interpolate the interior if the corners differ by < 2%. An off-lattice texel that must be evaluated (some light's shadow edge passes) takes each PARTIAL light's visibility from its lattice neighbours when they agree within 0.5 for that light (their mean; a value already cast for the texel as a sub-block corner comes first), and casts shadow rays only for the lights whose visibility changes around it. Shadow fractions are memoised per (patch texel, light) for static and dynamic lights, and weak-light centre rays too, so sub-block corners evaluated again per texel cost nothing; a texel whose static part interpolated evaluates only its dynamic lights (and the reverse).
   - **Ceilings.** Ceiling texels receive no direct light from coplanar recessed emitters: the emitter's plane culls them, which happens naturally. They still receive light from pendants and hanging fixtures.
   - **Direction.** Accumulate `Σ E_l·ω̂_l` (unit vector to the light's projected centroid) for the dominant direction.
6. **Indirect, full** (`patches.ts`, `probes.ts`, `sh.ts`, `indirect.ts`).
   - **Patch cache.** Patches on a **world-anchored** grid over the floors, walls and ceilings within `PROBE_RAY_MAX` of the tile rect: 0.6 m patches within 5 m of the tile, 1.2 m beyond. Each patch computes direct E from the bitset visibility of its owner cell (nearest height) over its `K_MAX` lights: RECT emitters use the point form factor at the patch centre (exact polygon very close to the emitter); SPHERE and DISK emitters use the patch **mean** `I·Ω/A`, Ω being the solid angle the patch rectangle (on the real floor or ceiling plane when it lies in the patch's height band; a wall band clipped to the cell's open height) subtends at the source (`pointOverRect`; DISK × the emitter cosine toward the patch centre). The centre's `cos/d²` of a cage bulb hung 6.5 cm under a coarse ceiling patch's centre was 60× the patch mean, and every probe ray landing on that 1.2 m patch carried it: firefly probes that the probe interpolation spread into round, glowing 2.4 m blotches on walls. Radiance `B = ρ(layer)·E/π`, where ρ is `LAYER_DEFS.albedoMean`, tinted by the patch's fields: wet ×0.7. Patch radiance is therefore a pure function of world position and is cached per chunk (a tile reuses the patches its neighbours computed on the same worker).
   - **Probes.** At every cell of the tile plus a 1-cell ring, at 3 heights: `floor + 0.4`, the midpoint, `ceil − 0.35`. For tower groups, at the fundamental period heights, then replicated.
     - `q.probeRays` Fibonacci directions rotated by `hash(world pos)`.
     - Trace with the DDA to the first hit, capped at `LIGHT.PROBE_RAY_MAX` (8 m); look up the hit patch radiance. Emitter hits are excluded (already direct).
     - **Misses** (no hit within 8 m) use a tile-independent ambient term: `ρ̄_probe·Ē_cell/π`, where `Ē_cell` is the mean direct irradiance of the probe's own cell floor and `ρ̄_probe` the probe's own hit-weighted albedo.
     - Project to **SH-L1 RGB** (4 coefficients × 3).
     - **Hemisphere tangential moments** (`ProbeSet.mom`, luma, 12 per probe): for each of the 6 axis hemispheres, the
       moments `Σ Y(ω)·ω_t·4π/N` of its rays along its two tangents (`addMoments`; misses with the ambient term, the far
       field too). For a receiver facing +a, `dE/dθ` of its normal tilted toward t is exactly the moment of the radiance
       over its own hemisphere along t (the boundary term vanishes with its cosine). The ambient cube is quadratic in n,
       so without these the indirect light had no first-order response to a normal map at all. Half the full-sphere
       moment (`½(C₊ₜ − C₋ₜ)`) equals it only for fields symmetric about the receiver plane: it also counts what lies
       behind the receiver (a ceiling's own lamp pools, a floor's own light), and against a brute-force hemisphere
       gather from the texels themselves (same patch radiance) it reached slopes of 0.43–0.61 on LOBBY, OFFICE and
       PARKING ceilings and walls and a correlation of 0.06 on LOBBY floors, where the hemisphere moments reach
       0.77–0.89 and 0.49 (the rest is parallax: the probe sits up to 0.6 m from the surface).
   - **Texel indirect.**
     - Bilinear interpolation of the neighbouring cells' probes, with weight 0 across edges occluding at the probe height, across different `room`, or across floor steps > 0.5 m unless both probes (each layer at its own cell's height) lie 1 m over the higher floor (`STEP_CLEAR`: there both cells share the air, so the ceiling over a pool blends across the rim, while a deck's mid layer never takes a pit's); renormalise.
     - Linear interpolation between the height layers.
     - Evaluate SH irradiance at the texel normal.
     - **Indirect gradient** (`indirectGradient`): the receiver's hemisphere first moment `m(n)` blended from the axis
       hemispheres with weights `n_a²` like the cube (normal component: the cube lobe; tangential: the moments), then
       `g = m − (m·n)n`, × the luma multi-bounce gain × AO (× the near-field V where the gather ran). It is interpolated
       for the off-lattice texels and dilated exactly like the indirect irradiance, and stored as `g / E` (E the total
       static luminance) on the face's two in-plane world axes (x, y, z order skipping the normal's dominant axis) in
       the dir map's layer 1. Stored `|g|/E` per radian (medians, seed 1 zone bakes at high): walls 18–55 % (the
       floor bounce below), ceilings 14–35 % (DARK 76 %), floors 2–14 %; grazing-lit texels reach the ±1 clamp.
     - Multi-bounce **per colour channel**: `E_ind,c /= (1 − min(0.6, 0.55·ρ̄_probe,c))`, where `ρ̄_probe` is the mean **RGB** albedo over **that probe's own ray hits** (interpolated with the probe weights), never a per-tile mean. Every extra bounce is tinted again, so enclosed coloured rooms keep their colour in the shadows. The flicker (luminance) channels use the luma of ρ̄.
   - **AO** (`ao.ts`). Analytic `Π(1 − 0.5/(1 + (d/0.25)²))` over the nearby planes: occluding edge faces within 1 cell, floor, ceiling, and box faces (solids and `PROP_OCCLUDERS` parts) within 0.6 m. Plus **contact AO** for every COLLIDE prop footprint: an elliptical falloff reaching 0.3 m beyond the footprint, strength 0.5 at the footprint edge; round bases (`PROP_ROUND_CONTACT`: office chairs' star bases, trash cans, buckets) a disc instead, 0.5 within 0.35 R of its centre (R = the footprint's inscribed radius) fading to 0 at R + 0.3 m (a square under a swivel chair read as a grey tile). Multiplies the indirect term only; stored in `irr.a`. Full bakes with the near-field gather leave out the prop boxes and the contact AO of footprints whose prop has a part box standing on the floor (`VisGrid.contactBox`, bottom within 5 cm of the base): the gather traces them. Props whose part boxes all float (chair seats over their star bases, the lounge chair frame, the pallet deck) keep the contact AO for their untraced legs and bases, so they stay grounded.
   - **Near-field gather** (`nearfield.ts`, full bakes with `q.nearRays` > 0: high 16, ultra 32). The per-cell probe cannot see a desk top 0.7 m above a floor texel. Texels with a prop box within 1.2 m (in front of their plane) trace `nearRays` cosine rays of 1.2 m (a (0,2)-sequence, rotated by the texel's world position): `V` = the probe-SH-radiance-weighted fraction of rays that miss the props, `E_box` = π/N·Σ the hit prop faces' radiance. Prop face radiance comes from world-anchored 0.3 m face sub-patches (1.2 m along the long side of faces narrower than 0.2 m: rack uprights, deck and panel edges; K_MAX lights, form factor and one visibility ray each, cached per bake), not from the shell patch of the cell. `E_cube` blends towards the probes' **far field** by the texel's region weight: every probe also traces its rays with the prop boxes entered within 0.6 m transparent (`NEAR.PROBE_FAR`; the flicker channels' cubes too), so a low probe under a desk top or chair seat does not darken the under-desk floor a second time (the probes with the props gave 0.5× a brute-force reference gather under office desks; the far field 1.17×), while probes away from the region keep the props (racks still shade the aisles). `E_ind = (E_cube·V + E_box)·mb`; `irr.a` gets the geometric visibility. The correction fades out (smoothstep) over the region's outer 0.6 m. It is traced on a world-aligned 4×4-texel sub-lattice and at seam texels and bilinearly interpolated in between (within a patch or between linked cells), so seam texels stay exact and the cost is ~1/3 of tracing every lattice texel. With `nearRays` absent or 0 the bake is byte-identical to the far-field bake.
7. **Preview** (`preview.ts`).
   - Direct: class FULL → 1, NONE → 0, PARTIAL → 0.5, with no per-texel rays, evaluated on 2×2 texel blocks and replicated.
   - Indirect: a **2D edge-aware diffusion**.
     1. Per-cell radiosity B = mean over the cell's floor and walls of `ρ·E_direct/π`.
     2. 8 Jacobi iterations of 4-neighbour averaging, only across edges that do not occlude at 1.2 m. Energy factor 0.85.
     3. Per texel: bilinear with weight 0 across occluding edges, × surface factor (ceiling 1.0, wall 0.8, floor 0.6) × AO.
   - Same atlas, same chart hash, same encoding. Target ≤ 60 ms.
8. **Flicker channels** (`channels.ts`).
   - For each dynamic light: channel c. `flick[c]` = direct irradiance **luminance** Y (Rec.709 luma of the RGB irradiance; with visibility, as in the full or preview direct pass) + a bounce term `0.3·ρ̄_L·Ȳ_L`. `Ȳ_L` and `ρ̄_L` are **per-light** pure functions: the mean direct Y (cell centres, bitset visibility) and mean floor albedo over the cells within `R_DYN` of the light that a flood fill **restricted to that disc** reaches from the light's cell. The same value is used by every tile.
   - Allocate `flick` only if a dynamic light reaches the tile; otherwise `null`.
   - Tiles with `flick` also fill `volume.c`.
9. **Surface mask** (`mask.ts`, RGBA8 per texel, deterministic from world position, fields and leaks).
   - **R (stain).**
     - Walls within 1.2 m horizontally of a leak: a tide-line band from the ceiling down to `ceil − (0.4 + 0.8·strength)` m, with drip streaks (hashed columns 3–8 cm wide).
     - Ceilings within 0.9 m of a leak: concentric rings.
     - Floors: none.
   - **G (grime).** `decay·(0.6·cornerness + 0.4·baseboardBand)`, where cornerness = 1 − AO over nearby walls and the baseboard band is y < 0.25 m.
   - **B (wetness).** `humidity·lowFreqPuddle(hash noise)`, plus WET cells and leak puddles (1.2 m radius under each leak).
   - **A (damage).**
     - Walls: peeling and mould at the base and near leaks, scaled by decay.
     - Carpet floors: traffic wear where the floor texel's distance to the nearest wall is > 0.6 m and `corridorWidth(owner layout, cell) ≤ 2`.
10. **Emission map** (`emission.ts`).
    - 88×88 texels at 0.3 m covering the tile ± 3.6 m.
    - rgb = Σ over emissive fixtures of `fixtureRadiance(f)·color·stateMean` whose emitting surface's **xz footprint** covers the texel (anti-aliased with a 0.3 m box; the emitter's own height is what WP5 writes into the floor `aux.x`). Dynamic lights are written at intensity 1 (the shader multiplies by the live channel).
    - a = `regionKey(nb.region(cell))`, **negated** where the texel's radiance comes from a dynamic light (the shader then multiplies by that light's live intensity; its tile is `tileOfPoint` of the texel).
    - Mipmapped by the renderer (WP10 sets `generateMipmaps`) for the colour lookup; WP9 reads `a` with `texelFetch` at level 0 only.
11. **Light volume** (`volume.ts`).
    - 32×6×32 samples at the tile-local `((i + 0.5)·0.6, LV.Y[k], (j + 0.5)·0.6)`.
    - Samples inside solids (or on a face two occluder boxes share: `visgrid.ts insideOccluder`, a car's body and cabin meet on the 0.8 m level) are marked invalid and dilated.
    - Samples whose cell is a TOWER cell are baked with **that tower's bake group** (isolated, periodic lighting), so the WP9 y-wrap for tower props reads valid values.
    - `wallMask` (18×18, tile cells + ring): r = bits N1 E2 S4 W8 where the cell's edge occludes at y = 1.2 m; g/a = the cell's water surface (`waterCm + 32768`, high / low byte) and b = WaterRect kind + 1 (0 = dry or SOLID), read by the shaders' `brWaterCell`. The tile's water kinds (bit mask 1 pool | 2 flooded | 4 film) become `TileBindings.water` (`uTileWater`).
    - Per sample, accumulate SH-L1 of direct light (each light as a directional delta with visibility) plus indirect (probe SH), with the per-channel multi-bounce.
    - **Near-field samples** (full bake, `q.nearRays` > 0, a prop box within 1.2 m): when the sample's own cell holds a box rising above the sample or above the bitset point at the nearest bit height, lights a box could cut off get one DDA ray from the sample instead of the cell bitset (chairs under desks are shadowed, a monitor above the desk top is lit); the probe SH blends towards the probes' far field, `nearRays` sphere rays correct it where they hit prop faces (delta form), and the stored AO drops by the hit fraction.
    - **Full bakes without near rays** (low, medium): every non-tower sample takes the same per-sample ray test (no sphere rays). With the bitset alone the samples all over a car (its cabin swallows the bit point) and over desk tops baked black, and the samples under a lounge chair's frame missed its shadow. Every full bake (high / ultra too, outside the near-field region) also uses the per-sample rays in cells whose bitset point lies inside a box, so filing cabinets and vending machines around a cell centre are not black. Preview bakes keep the cell bitset alone.
    - Encode:
      - `a.rgb` = L0 irradiance (hemisphere average);
      - `a.a` = AO (analytic, spherical);
      - `b.xyz` = normalized L1 luminance direction;
      - `b.w` = directionality;
      - `c` = per-channel dynamic luminance.
12. **Dilation and encoding.**
    - 4 passes of chart-local dilation fill invalid texels and gutters.
    - rgb clamped to `HALF_MAX` → `toHalf`.
    - `dir.xyz` = normalized dominant direction·0.5 + 0.5; `dir.a` = `w = |Σ E ω̂| / Σ E` in [0, 1].
    - `dir` layer 1 (the rows after layer 0: one W × 2H texture, so the high / ultra shell program stays at 16
      samplers): rg = `128 + 127·clamp(g/E, −1, 1)` (128 is exactly 0; `encodeGrad`, `gradAxes`), ba = 128 (reserved for
      the flicker channels' gradient). Texels outside the charts hold 128. +4 B per lightmap texel.
    - `term !== 'all'` zeroes the other term (the debug bake).
13. **Timing and determinism.** Wrap stats timing in `performance.now()` (allowed in `bake/index.ts` only). No other nondeterminism: all stochastic patterns are seeded by quantized **world** positions, so adjacent tiles and chunks agree.

**Acceptance (vitest)**
- **Leak.** Two rooms separated by a WALL with a light only in A: every valid texel in B has `E < 1e-4 · max(E_A)`, for both variants and both tpc values. The same for a DOORWAY-less PARTITION pair at y < 1.5 (floor B shadowed). **Leak tests evaluate the bilinearly FILTERED lightmap** at visible floor points (≥ `edgeBaseThickness/2` from the line), not raw texels. A HALF wall's shadow length matches the geometry within 1 texel.
- **Furniture shadow.** Floor irradiance under a DESK top is < 35% of the open floor 1 m beside it. Near-field (`tests/bake/nearfield.test.ts`, `volumeNear.test.ts`, `propOccluders.test.ts`): under-desk indirect ≤ 0.5× the open floor; the floor under a car is valid and < 0.3× lit; light passes between rack decks; the region edge is seamless; seam, cache and `nearRays` 0 identities.
- **Tall lights.** Floor E under a 1.2 m SKY_PANEL lattice at 12 m (ATRIUM) is ≥ 85% of the unwindowed sum.
- **Cache.** `bakeTile` with and without a warm `BakeCache` is byte-identical.
- **Analytic.** A floor point under a single 0.6×1.2 panel at 2.7 m is within 2% of the closed-form polygon value (full) and within 10% (preview).
- **Seams.** Two adjacent tiles, in the same chunk and across a chunk seam, baked independently (fresh caches): shared-border texels (the aprons) differ by < 2%. Run on LOBBY, **LOW_EXPANSE, PILLAR_HALL and WAREHOUSE** (the open zones where probe rays and light sets reach farthest).
- **Determinism.** The same input gives byte-identical output.
- **Flicker.** Lights appear only in `flick` and never in `irr`. The channel selection matches `tileChannel`. Two same-channel lights never both reach any texel (asserted during the bake).
- **Directionality** in [0, 1].
- **Tower periodicity.** Texels at y and y + 3 m on tower walls agree within 1e-3 relative.
- **Chart hash.** The bake uses the `SurfaceSet` given; an output `chartHash` mismatch throws.
- **Bench gate** (`BENCH=1`, `tools/bakebench.ts`).
  - Zones: LOBBY, LOW_EXPANSE (dense lattice, R 14), PILLAR_HALL, POOLROOMS (incl. a vaulted district), WAREHOUSE, and `forceLandmark=ATRIUM`.
  - Full bake p95 ≤ 600 ms warm (≤ 900 ms cold) and preview ≤ 60 ms at high on the target machine.
  - **Time-to-ready:** the 36 tiles of a radius-1 neighbourhood, full-baked on 12 workers with chunk affinity (simulated in Node with `worker_threads`), ≤ 2.5 s for each bench zone.
  - Print texels, rays, lights, K_MAX drops and ms per tile.
- **Screenshots** (via WP10's harness and WP14 QA):
  - `testScene=leak&view=lightmap&bakeTerm=direct`: the dark room is black.
  - `testScene=cornell&view=lightmap&bakeTerm=indirect`: yellow bleed on the grey wall.

**Must NOT touch:** chart layout (WP5 owns it; the baker only reads charts), runtime shaders.


---

### WP8: Procedural textures (GPU)

**Goal:** 30 tileable PBR layers (28 placed, 2 reserved by texture realism v2) at 1024² (512² on low) that read as real materials at 1–3 m, generated on the GPU in < 400 ms behind the loading screen. Measured albedo must match `LAYER_DEFS`.

**Files:** `src/textures/*`, `harness/materials.html`, `src/harness/materials.ts`, `tests/textures/*`.

**Exported API:**
```ts
// textures/TextureBaker.ts
export function generateTextures(renderer: THREE.WebGLRenderer, size: 512 | 1024, anisotropy: number,
  onProgress?: (fraction: number) => void): Promise<TextureSet>;
// textures/albedoCheck.ts
export function layerAlbedoCheck(renderer: THREE.WebGLRenderer, set: TextureSet): Promise<LayerAlbedoReport[]>;
export function tileSeamCheck(renderer: THREE.WebGLRenderer, set: TextureSet): Promise<{ layer: number; maxEdgeDelta: number }[]>;
// textures/registry.ts
export interface LayerRecipe { layer: MatId; glsl: string; normalStrength: number; heightScale: number } // glsl defines `void gen(vec2 uv, inout Surf s)`
export const LAYER_RECIPES: readonly LayerRecipe[]; // index = MatId, length MAT_COUNT
// textures/glsl/noise.ts
export const NOISE_GLSL: string; // periodic value/gradient/worley(F1,F2,id)/fbm/ridged/warp, all taking an integer period
// textures/DetailBaker.ts (package B; recipes in textures/detail.ts)
export function generateDetailTextures(renderer: THREE.WebGLRenderer, anisotropy: number): Promise<THREE.Texture>;
```

**Procedure** (verified r186 behaviour):
1. Three `WebGLArrayRenderTarget(S, S, MAT_COUNT)` targets:
   - albedo: `UnsignedByteType`, `colorSpace = SRGBColorSpace` (SRGB8_ALPHA8);
   - normal: RGBA8, linear;
   - ormh: RGBA8, linear.

   Each has `texture.minFilter = LinearMipmapLinearFilter`, `magFilter = LinearFilter`, `wrapS/T = RepeatWrapping`, `anisotropy`, and **`generateMipmaps = false`**. They are **single-attachment**: never `count > 1` (only `textures[0]` becomes an array).
2. A scratch `WebGLRenderTarget(S, S, { type: HalfFloatType, format: RedFormat })` holds the height of the layer being generated.
3. **Programs.** One `ShaderMaterial` per recipe (28) plus the Sobel pass; `uOut` is an **int uniform** (0 HEIGHT, 1 ALBEDO, 2 ORMH), never a define, so there are 29 programs, not ~85. All are created up front and compiled together with `renderer.compileAsync` (KHR_parallel_shader_compile) before the first draw; compile time is logged separately (`textures.compileMs`) from generation time.
   Per layer L, in order, each a full-screen triangle with an orthographic camera:
   1. Recipe with `uOut = HEIGHT` → scratch.
   2. Recipe with `uOut = ALBEDO` → `setRenderTarget(albedoRT, L)`. **Recipes output LINEAR albedo**: the target is SRGB8_ALPHA8 and the hardware encodes on write (three treats render-target output as linear working space). `Surf.albedo` is linear; recipe constants written as sRGB bytes go through `srgbToLinear()` in `glsl/common.ts`.
   3. Recipe with `uOut = ORMH` (cavity AO from the scratch height: horizon-based, along 8 azimuths the steepest rise over radii 1-16 texels, V = 1 − mean(sin² h), the cosine-weighted visibility) → `setRenderTarget(ormhRT, L)`.
   4. Normal pass: a wrap-sampled Sobel over the scratch × `heightScale` × `normalStrength` → `setRenderTarget(normalRT, L)`. `normalStrength` > 1 where the authored height field is smoother than the real surface at its real depth (heightScale also drives POM, the cavity and the puddle shorelines): WALLPAPER_L0 / MANILA ×6, DRYWALL ×10, TRIM_PAINT ×4, CONCRETE_FLOOR ×6, CONCRETE_WALL ×5, CONCRETE_CEIL ×3, which brings their mip-0 slopes from 0.3-1.4° to the 3-5° of embossed vinyl, knockdown and board-formed concrete (tan θ mean ~0.06-0.08; the slab 0.02, manila and trim 0.015). These layers now carry visible wall and slab texture, so props that need a plain matte surface do not borrow them: kraft boxes and bottle labels use PLASTIC with a 0.85 roughness override (on DRYWALL the boxes read as stucco).
4. **Before the final draw into each array target, set `texture.generateMipmaps = true`.** `renderer.render()` then calls `updateRenderTargetMipmap` for the current target: one `generateMipmap(TEXTURE_2D_ARRAY)` per target. Mutable storage was verified via `texImage3D`.
5. `setRenderTarget(null)`. Yield to the main thread every 4 layers (`await new Promise(requestAnimationFrame)`) and report progress.
6. **Signage and decals.**
   - SIGNAGE: 4×4 atlas of EXIT, arrows, STAIRS, B1/B2/L0, WET FLOOR, NO DIVING, P1/P2, ELEVATOR, AUTHORIZED, FIRE, ARROW_UP. Draw it with a Canvas2D `OffscreenCanvas` (bold condensed sans, stencil style), upload as a `CanvasTexture`, and blit into the layer in its ALBEDO pass. Emissive mask in `ormh.a`.
   - DECAL_ATLAS: 16 slots drawn procedurally in GLSL (SDF shapes plus noise). Alpha lives in `albedo.a` (soft edges: stains, oil and footprints use feathered alpha).
   - **Orientation (core `DecalPlacement` convention):** each slot's "up" is +v and every arrow (CHALK_ARROW, EXIT_LEFT/RIGHT, ARROW_UP) points +v. Canvas y runs down, so the canvas is uploaded with `flipY` such that the top of the glyph lands at high v (checked in the harness by sampling the arrow tip).
7. **Grime** (512², tileable RGBA8, 2D): r = tide rings (iso-lines of warped fbm), g = speckle/mould, b = scuff, a = vertical drip streaks.
   **Water normals** (512², RG): 2 octaves of periodic gradient noise.
   **Cookie** (512², RGBA16F; package F): the beam profile of `lighting/flashlightOptics.ts` (`beamProfileGlsl`: a softly square LED-die core, a dark ring, a yellow phosphor ring, corona, flat spill, reflector lip, crisp rim) times lens dirt and a thumb smudge, cool core / warm spill. The texture spans `CONE × MAP_FOCUS` (see WP11 §4).
8. **Detail maps** (package B, only when `QualityConfig.detailMaps`: boot generates them after the layers, a quality
   switch lazily; `TextureSet.detail`). One `WebGLArrayRenderTarget(512, 512, 21)` RGBA8, linear, trilinear + anisotropic,
   repeat, over a 0.3 m frame (divides NOISE_WRAP, STOREY_PITCH and TILE_SIZE). Recipes (`textures/detail.ts`, the layer
   recipe environment): D0 cut pile, D1 loop pile, D2 embossed vinyl paper, D3 rolled paint, D4 fine concrete (sand,
   pinholes), D5 mineral fibre, D6 glaze waviness, D7 basket weave, D8 brushed sheet, D9 open wood grain, D10 haircell, D11
   the puddle ripple, D12-D20 the texture realism v2 slots (below). Per layer: HEIGHT → the shared scratch, then the pack pass (`DETAIL_MAIN`, the normal pass's Scharr
   slope `br_slope`): rg = mean slope / S, b = albedo multiplier × AO × cavity / 2, a = E[|slope|²] / 2S², S about 4 × the
   layer's rms slope (harness `extra=detail`, `stats().detailMoments`). The box-filtered mips keep both slope moments
   exact (LEAN). ~15 MiB, ~15 ms compile + ~20 ms generation.

**Recipes** (`uv.x` ∈ [0,1) spans `repeat` metres and `uv.y` spans `layerRepeatY` metres (or the recipe's generator `frame`, texture realism v2), so layers with `repeatY` are authored in a non-square frame; all noise is periodic with an integer period, so every layer tiles). Output `Surf{ albedo (linear), alpha, height, rough, metal, ao, emissive, aux, lean }` (aux and lean: texture realism v2, below).
- **Sampling limits.** Every periodic feature spans ≥ 3 texels at 1024² (and at 512² on low), or is supersampled 4× inside the generator (box-filtered), so no moiré is baked into the texture.
- **No one-off features in short repeats.** Anything that must not visibly repeat (lifted wallpaper edges, fades, carpet blotches, oil spots) is NOT in the layer texture; it comes from the world-space grime/mask path (WP7 mask, WP9 hashed world features) instead.

| Layer | Recipe essentials |
|---|---|
| WALLPAPER_L0 | Base mustard sRGB ≈ (173,158,97) = linear (0.42, 0.34, 0.12), matching `albedoMean` (decided here; WP7 and WP8 both use the table). Two 0.6 m rolls with ±2% shade offset. Faint damask/chevron SDF motif on a 0.3 m diamond lattice (±4% value, embossed height 0.2 mm). Vertical roll-seam ridge. Paper fibre fbm at 1 mm (supersampled), slight cockle (~0.25 mm over 7 cm). Satin vinyl, roughness 0.63–0.72. (Lifted edges and fading come from the WP7 mask.) |
| CARPET_L0 | Loop-pile micro grid (period 3 mm, **supersampled 4×**: it is below the 2.3 mm texel Nyquist limit, so the texture holds its filtered average plus pile normals) × Worley tufts. Isotropic strand speckle (no directional streaks: the layer uses hex tiling without rotation). Colour mottling (±6%). Roughness 0.95. (Macro blotches come from the mask.) |
| CEILING_TILE | 2×2 tiles of 0.6 m. Mineral-fibre fissures (thresholded warped ridged noise, "worm holes") plus pinholes. Raised 24 mm off-white T-bar grid (roughness 0.45, metal 0.3, height step). Per-tile brightness ±3%. Slight yellowing. |
| PANEL_LENS | Prismatic pyramid grid (4 mm) in the normal map. Two tube hot-stripes in the emissive mask (`ormh.a`, used by the low preset only; scaled so the lens mean matches the old framed texture). One continuous sheet: no frame per 0.6 m repeat (a 2x4 used to read as two squares, a sky panel as four). Albedo pale grey-white. |
| TRIM_PAINT | Semi-gloss paint, orange peel, edge scuffs. |
| WALLPAPER_MANILA | Beige vertical pinstripes, 0.15 m pitch, linen emboss, cockle; satin roughness ~0.72. |
| CARPET_OFFICE | 0.6 m carpet tiles, pile direction rotated per tile (roughness and normal sheen), blue-grey speckle. |
| DRYWALL | Roller stipple, eggshell. |
| VINYL_VCT | 0.3 m tiles, ±4% tint per tile, chips, wax sheen (roughness 0.3–0.45). |
| CONCRETE_FLOOR | Aggregate speckle, a few exposed pebbles, trowel swirls with burnished burns (darker, −0.14 roughness), Worley F2−F1 crack network, curing mottle, chalky laitance, a soft unimodal sheen field (roughness 0.44–0.6). (Oil spots are decals.) Isotropic enough to also serve stair risers (frame 4.8 × 3.0 m). |
| CONCRETE_WALL | Frame 2.4 × 1.5 m: formwork seams every 1.2 m horizontally and 1.5 m vertically, tie holes. heightScale 20 mm with the face at 0.9 (POM top 0.92) and 18 mm deep conical tie holes. |
| CONCRETE_CEIL | Board-form grain. |
| CMU_PAINTED | Frame 2.4 × 1.0 m: 0.4 × 0.2 blocks (6 × 5 courses), recessed mortar with pooled (glossier, darker) paint, paint over pores and bridged voids, each block face tilted ±0.35°. heightScale 14 mm: ~6 mm tooled joints (POM). |
| POOL_TILE | 0.15 m white glazed tiles (roughness 0.06–0.12) with a slight pillow. Per-tile tilt ±0.5° per axis (lippage; ±1.5° scattered the lamps' reflections into single-tile glints), POM top 0.75. Crazing on a quarter of the tiles, a hazy glaze rim at the joint. 3 mm grout, light grey, roughness 0.7. |
| POOL_MOSAIC | 2.5 cm aqua mosaic, per-chip tilt ±0.5°. |
| METAL_PAINTED, METAL_RUST, METAL_GRATE | Chipped paint; rust mask (fbm threshold plus downward streaks); grate with dark holes (albedo plus height). |
| WOOD, PLASTIC, FABRIC_PARTITION, PLENUM, RUBBER | Standard recipes. |
| FLOOR_PAINT | Yellow or white worn paint, alpha from threshold noise. |
| TERRAZZO | Chips in a grey matrix, polished (roughness 0.13–0.2, pits and brass strips rougher). |
| METAL_DECK | Corrugated roof deck: trapezoidal ribs every 0.15 m in the height/normal map, galvanised grey, faint rust at rib bottoms. Frame 1.2 m. |
| METAL_PAINTED | Frame 1.2 × 1.0 m. |

**Acceptance**
- `tests/textures`: `LAYER_RECIPES` covers every `MatId`; every GLSL snippet declares `gen`.
- `harness/materials.html?view=albedo|normal|ormh|lit&layer=N`:
  - `lit` renders each layer on a sphere and a 2 m quad under a moving area-like light (MeshStandardMaterial with the array layer injected).
  - The page calls `__backrooms.layerAlbedoCheck()`, and every layer is within 10% of its `albedoMean` per channel (absolute floor 0.01). The check is a **reduction shader over mip level 0** (decoded to linear before averaging), not the driver's sRGB 1×1 mip (some drivers average sRGB mips in gamma space).
  - `tileSeamCheck` max edge delta < 2/255.
- Generation time < 400 ms at 1024 on the target machine, plus shader compile ≤ 1.5 s under ANGLE (both logged separately and counted in the boot budget).

**Texture realism v2 conventions (TEX2; `docs/contract-changes/TEX2.md`).** The v2 lanes code against these; lane 0
(foundation) set them up without changing a pixel.
- **Recipe rows.** Each family file declares its layers as `RecipeBody = { glsl, normalStrength, heightScale, trim?,
  phys, aux?, aux2?, frame? }` (`textures/layers/types.ts`): the albedo calibration trim (was the `TRIM` table of
  `registry.ts`) and the `SurfacePhys` row (was `SURFACE_PHYS` in `chunks/params.ts`, which now collects the rows from
  `LAYER_RECIPES_FULL`) sit next to the GLSL. Family files: `layers/carpet.ts` (A), `layers/concrete.ts` (B: slabs,
  formwork, soffit, FLOOR_PAINT, TERRAZZO), `layers/masonry.ts` (C: CMU_PAINTED, CMU_RAW), `layers/tile.ts` (C),
  `layers/wallpaper.ts` and `layers/ceiling.ts` (D), `layers/metal.ts` and `layers/misc.ts` (E); SIGNAGE and
  DECAL_ATLAS stay in `signage.ts` / `decals.ts`.
- **SurfacePhys v2 fields**, all neutral by default (`phys(por, {...})`): `sigma` (EON diffuse roughness, 0 = Lambert),
  `pile` [kp, kv] (0 = off; kp > 0 also skips the baked-light cavity visibility), `detRep` (detail repeat scale, 1; the
  repeat 0.3 m × detRep must still divide 19.2, 3.0 and NOISE_WRAP), `detTint` (rgb, 0), `detSO` (detail cavity into
  specular occlusion, 0), `dirt` / `wear` ([r, g, b, amount], amount 0), `reliefM` (metres of full convexity, 0.001).
  They reach the shaders as GLSL const arrays indexed by the layer (`BR_L_SIGMA`, `BR_L_PILE`, `BR_L_DETREP`,
  `BR_L_DETTINT`, `BR_L_DETSO`, `BR_L_DIRT`, `BR_L_WEAR`, `BR_L_RELIEF`, `BR_AUX_KIND`, `BR_L_AUX2`), not uniforms.
- **Generator frame.** `frame?: [w, h]` metres is generator-only (the recipe `FRAME`, the normal pass's texel metres,
  the cavity metric) and defaults to `[repeat, repeatY]`; the mesher's UVs still follow `LAYER_DEFS`, so a floor layer
  can be authored square while its tower walls keep `repeatY` 3.0. Hence `w` = `repeat` and `h` = `repeat` or `repeatY`.
- **Channels.** `Surf` gains `float aux` and `vec2 lean`. ormh.a follows the layer's aux kind (`AuxKind`): `none` 0 (every
  layer before v2 but the two below), `emissive` Surf.emissive (PANEL_LENS, SIGNAGE), `detailMask` Surf.aux (default 1;
  multiplies the detail strength), `wear` Surf.aux as a rank-normalised threshold field (P(W < x) = x), `mask` Surf.aux
  as a family-defined mask, `lean` Surf.lean in [-1, 1]: ormh.b = x · 0.5 + 0.5, ormh.a = y · 0.5 + 0.5 (the shader
  forces metalness to 0 on such layers). albedo.a = Surf.alpha is a second aux channel on layers with `aux2`, allowed
  on every layer but the alpha-tested METAL_GRATE, SIGNAGE, DECAL_ATLAS and FLOOR_PAINT.
- **Reserved layers.** `Mat.CMU_RAW` = 28 (repeat 2.4 × 1.0, albedo 0.22 / 0.215 / 0.20, roughness 0.9, grime
  `masonry`; placeholder: the CMU_PAINTED body at raw grey) and `Mat.METAL_BARE` = 29 (repeat 0.6, albedo 0.56, roughness
  0.3, metal 1; placeholder: flat metal). `MAT_COUNT` 30; nothing places them in the world yet (the `materials` test
  scene keeps its 28 layers). The harness gallery is 7 × 5.
- **Grime profiles** 7 `paint` (DRYWALL, TRIM_PAINT) and 8 `masonry` (CMU_PAINTED, CMU_RAW) start as verbatim copies of
  the wallpaper and concrete branches (WP9 below).
- **Detail slots.** `DETAIL_COUNT` 21; the recipes live in `textures/detailRecipes/{textile, mineral, walls, masonry,
  props}.ts` (ids in `detailRecipes/types.ts` `Det`), `textures/detail.ts` is the index and keeps D11 RIPPLE. D12 SLAB and
  D13 POLISH (B), D14 CMU_FACE and D15 CMU_RAW (C), D16 ROLLER_STIPPLE and D17 LINEN (D), D18 ENAMEL, D19 RUST_GRAIN and
  D20 KRAFT (E) are neutral placeholders (height 0.5, albedo 1, heightScale 1e-4, slope 0.05, no cavity) until their
  lanes fill them. 21 layers of 512² take ~29 MiB (high and ultra only).
- **Ownership.** Each lane edits only its family files, its `LAYER_DEFS` rows and its detail and hook files; the core
  files (`glsl/common.ts`, `programs.ts`, `registry.ts`, `detail.ts`, the bakers, `chunks/surface.ts`,
  `materialPost.ts`, `haze.ts`, `pom.ts`) belong to lane 0.

#### Lane 0: foundation
0a: the file split, the recipe rows, the channels, the reserved ids and slots and the hook points, bit-identical on the
28 gallery framings (high) and 4 medium framings (`node tools/ab.mjs --base a5c03e1 --expect same`).

#### Lane A: textiles

#### Lane B: concrete, terrazzo, floor paint

#### Lane C: masonry and tile

#### Lane D: walls and ceilings

#### Lane E: props

**Must NOT touch:** material shaders (WP9), except that you own the albedo *numbers* via contract-changes.

---

### WP9: Materials and shaders

**Goal:** a tile material factory that turns lightmaps and arrays into the reference look:
- directional lightmap specular;
- normal-mapped carpet and wallpaper;
- grime driven by the baked mask;
- Toksvig roughness;
- per-fragment haze;
- floor emission reflections;
- no leaks.

**Files:** `src/materials/*`, `tests/materials/*`.

**Exported API:**
```ts
export function createMaterialSystem(renderer: THREE.WebGLRenderer, textures: TextureSet, q: QualityConfig): MaterialSystem;
export interface PlanarReflection {
  readonly enabled: boolean;
  /** render the mirrored view if a water plane is visible within 40 m; binds globals.reflTex/reflMatrix/reflOn */
  update(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, waterY: number | null): void;
  setQuality(q: QualityConfig): void;
  dispose(): void;
}
export function createPlanarReflection(globals: MaterialGlobals, q: QualityConfig, waterVisible?: (renderer: THREE.WebGLRenderer) => boolean): PlanarReflection;
export const SHADER_ANCHORS: readonly { stage: 'vertex' | 'fragment'; include: string }[]; // every #include we replace
```

**Material construction.**
- `new MeshStandardMaterial()` per call, built from a factory. **Never `.clone()`**: `Material.copy` does not copy `onBeforeCompile`.
- `onBeforeCompile(shader)` assigns the **shared** global uniform objects (`globals.*`) and **the exact per-tile uniform objects** of `TileBindings` (each is `{ value }`, fresh per tile) into `shader.uniforms`. Nothing is copied by value, so later `.value` assignments by WP10/WP11 always take effect.
- `customProgramCacheKey = () => 'br-surface-v1|' + variant + '|' + definesKey`. Variants are `shell`, `props` and `decal`. Quality defines: `BR_FLOOR_REFL`, `BR_AIRLIGHT`, `BR_LV` (props), plus the graphics-realism defines (section 6.4).
- Water, sparks and motes live on `LAYER_LATE` (layer 1; the main camera and the flashlight enable it) so the frame graph can draw them after the opaque colour copy.
- Do not set `map`, `normalMap`, `lightMap` or `aoMap`; three's `USE_*` paths stay off. `defines.USE_UV` is not needed, because the `uv` attribute is always declared in r186.
- `side = FrontSide`; `transparent = false`.
- **Decal variant:** shell lighting code; output premultiplied (`rgb·a, a`) with `blending = CustomBlending`, `blendSrc = OneFactor`, `blendDst = OneMinusSrcAlphaFactor`, `transparent = false` (three still blends non-NormalBlending opaque materials), `depthWrite = false`, `polygonOffset = true, factor −1, units −4`; meshes `renderOrder = 1`, `castShadow = false`. SIGNAGE and CHALK_ARROW layers use hard alpha (discard < 0.5, then a = 1).
- Water: its own `ShaderMaterial`, `CustomBlending(One, OneMinusSrcAlpha)`. Low / medium: premultiplied, `transparent = true`, `depthWrite = false`. High / ultra (`BR_WATER_REFRACT`): opaque output (alpha 1; the blend is kept for tiles fading in), `transparent = false`, `depthWrite = true` (the late render leaves depth writes to each material, so late sparks and motes behind the surface are hidden; sparks draw at renderOrder 3, after the water's 2).
- **Every** shader we own (surface variants, water, sparks) ends with `gl_FragColor.rgb = min(gl_FragColor.rgb, vec3(HDR_CLAMP))` (32768 nits): a flashlight highlight on glossy pool tile at 0.5 m exceeds half-float range otherwise and the Inf spreads through bloom and SMAA.

**Vertex injection** (after `#include <uv_vertex>` and `#include <worldpos_vertex>`):
- Attributes: `attribute vec2 brLmUv; attribute float brLayer; attribute float brFlags; attribute vec4 brTint; attribute float brEmit; attribute vec4 brAux;`. `brTint`/`brAux` are normalized u8 → 0..1; multiply aux by 255 in the shader.
- Varyings: `vBrUv, vBrLmUv, vBrLocal (tile-local position), vBrTint, vBrAux4, flat vBrLayer, flat vBrFlags, vBrEmit` (+ three's `vViewPosition`). **No float32 world-position varying:** a few km from the origin it has mm-level error. World-anchored lookups use `vBrLocal + uNoiseOrigin` (xz) and `vBrLocal.y` (storey-relative y). Reflection plane intersections and emission-map uvs are done entirely in **tile-local** space (`vBrLocal` + t·direction, directions from view space rotated by the inverse view rotation), so no large coordinate ever enters the shader.

**Fragment replacements** (every anchor listed in `SHADER_ANCHORS` and tested against `ShaderLib.physical`):
- **Main start.** Dithered fade: `if (uFade < 1.0 && bayer4(gl_FragCoord.xy) >= uFade) discard;`.
- **`map_fragment` → surface sampling.** Albedo, normal and ormh are sampled **once** here and stashed in main-scope variables (`brAlb, brNrm (incl. |n̄| before normalisation), brOrmh`) for the later chunks (in r186 `roughnessmap_fragment` runs before `normal_fragment_maps`).
  - **Rotation anti-tiling** only for layers with `tileSize > 0` (physical tiles: CEILING_TILE, VINYL_VCT, POOL_TILE, POOL_MOSAIC, CARPET_OFFICE): `id = floor(worldUv·repeat/tileSize)` → hash → 90° rotation plus flip `M` about the tile centre. Differentiate the continuous (unrotated) uv, then sample with `textureGrad(tex, M·uv', M·dFdx(uv), M·dFdy(uv))` so anisotropic filtering follows the rotated axes. The decoded tangent normal's xy is transformed by `M⁻¹`.
  - **Hex (stochastic) tiling** for layers with `hexTile > 0` (CARPET_L0, CONCRETE_FLOOR): offset-only (no rotation) hashed per hex cell of `hexTile` metres, 3-way blend with a 0.15 m feathered edge, variance-preserving blend; same derivatives for all samples.
  - **Macro variation:** value (±6%) and hue (±2%) only, from low-frequency world noise and the coarse-mip (level ≥ 6) luminance of the layer. No second full-detail sample (it ghosts patterned layers at the wrong scale).
  - **Parallax occlusion mapping** (package B, `BR_POM` 1 high / 2 ultra, shell only, layers with
    `SURFACE_PHYS.pomTop > 0`: CMU 0.8, cast concrete wall 0.92, pool tile 0.9, mosaic 0.7, metal deck 1). The flat face
    is the relief top; the view ray is marched down through `normal.a` from the geometric surface in steps of at most
    1.5 display pixels of visible parallax (2-12 steps on high; 2-16 on ultra, 2.25 render pixels each: 1.6 display
    pixels at its 1.4x scale; the last step is exactly the bottom, so every ray hits), then refined by one secant step. It runs only where
    the parallax exceeds 0.5 px (fading in to 1.5 px), never in the planar mirror pass and never on submerged faces.
    Only the texture lookup moves (`brUv`): depth, discards and silhouettes stay those of the flat face, so the depth
    prepass is unchanged, and the lightmap / mask lookups stay at the unshifted point. The unshifted footprint
    (`brDx/brDy`) keeps the shading gradients continuous; the march's own height lookups use an isotropic LOD of the
    footprint's area (trilinear, not anisotropic: 5-20 lookups per pixel). Rotated physical tiles go through the shared
    `brRotUv`, cached per cell and re-derived when a ray enters another cell, so the march and the shading read the same
    tiles. `pomTop` must cover the per-texel relief maximum (a texel above the top casts false self-shadows). The march
    state (`brPomT/B/N`, depth, hit height, fade) feeds the self-shadow below.
  - **Detail maps** (package B, `BR_DETAIL_MAPS` high / ultra, not the decal variant; `textures/detail.ts`). One 512²
    RGBA8 array of 11 + 1 layers over a 0.3 m repeat (0.59 mm texels): world-anchored on the shell (the tile-local
    `brSurf2D(vBrLocal) / 0.3`: 0.3 m divides TILE_SIZE and STOREY_PITCH, so this is the world pattern at full float
    precision, where `brS2` would reach 4096 uv units), part-local metres on props (`vBrUv · round(repeat / 0.3)`). The
    layer and strength come from `SURFACE_PHYS.det/detS` (`uBrLayerD.xy`). The pack is LEAN: rg = mean slope / S, b =
    albedo multiplier / 2, a = E[|slope|²] / 2S², so the box-filtered mips keep exact first and second moments. The
    shader multiplies the albedo by `t.b / mean.b` (mean-preserving: the 1x1 mip is the layer mean), adds
    `roughK·(1 − am)` roughness in pits and gaps, hands the mean slope to the normal pass and the variance E[s²] −
    |E[s]|² to the roughness. Between 8 and 16 detail texels per pixel the texel fades to the layer mean and the fetch
    is skipped beyond: far away the detail survives as micro-roughness only, never as a fade band or sparkle. Standing
    water drops the detail slope and variance (a film keeps 30 % of the variance) and carries micro-ripples from layer
    D11 on the shell (0.6 m repeat, drifting a few mm/s, normalised slope × `TUNE.RIPPLE` 0.004 on deeper water only,
    faded out between 1.5 and 4 ripple texels per pixel).
  - `diffuseColor.rgb = albedo·vBrTint.rgb`.
  - DECAL flag in the shell/props variants: `if (albedo.a < 0.5) discard;` (grates, sign faces). The decal variant uses soft alpha.
  - **Grime** by `LAYER_DEFS.grime` profile (compiled into a small switch on a per-layer uniform table `uLayerParams[28]`). High-frequency `grime` texture thresholded against `lmMask`:
    - carpet: a dried tide ring at the edge of wet (B) patches, damage (A) = wear paths;
    - wallpaper: stain (R) tide bands (brown-yellow, sharp edge from `grime.r`), baseboard dirt (G), peeling at seams (A);
    - ceilingTile: stain rings (R ∧ rings), sag darkening;
    - concrete: oil patches, saw-cut joints, damp walls with efflorescence;
    - tile: grout grime (G);
    - metal: rust streaks.
  - **Wetness** (package B; Lagarde 2013 porosity model, every profile, every preset). `brWet` = the mask's B field
    thresholded with a wide ramp (1 under water) and `brSoak` = the same field unramped (the ramp would flood whole
    patches evenly). With the layer porosity P (`SURFACE_PHYS`, `uBrLayerC.z`): absorption `smoothstep(0, 0.6, brWet)·P`
    darkens albedo by up to 45 % and raises its saturation by up to 35 %; a water film `smoothstep(0.3 + 0.55P,
    0.6 + 0.35P, brSoak)` forms early on sealed surfaces and only at saturation on porous ones (carpet: soaked cores
    only). `BR_PUDDLES` (medium+): on up-facing layers standing water fills the texture relief
    (`(normal.a − layer mean)·heightScale`) below a level that rises from −1.2 mm to +1.5 mm with `brSoak` (0.5 → 0.95;
    textiles, P ≥ 0.95, only once saturated: 0.92 → 0.99, so a soaked carpet's cores are real mirrors; their coverage is
    sharpened (smoothstep 0.4–0.6: a shore pixel is water or fibre tips, not a part-flattened pile under a near-mirror
    lobe, which sparkled along every shore)), so shorelines
    follow grout, cracks and tilted-tile corners; the shoreline width grows with the texel footprint. Film and puddles
    set the roughness target (0.07 + 0.25P, + 0.3 on textiles, whose fibre tips break the film into a broad sheen;
    puddles 0.03), flatten the normal and drop the Toksvig variance (and a textile's sheen under standing water); puddles on
    porous floors are murky (tint (0.94, 0.9, 0.82) × min(2P, 1)). Decals take the base floor's mean state. The bake
    adds a pool splash zone to B (floors within 1.2 m of a pool's water edge). Debug view `wetness` = (brWet, film,
    puddle), `height` = normal.a.
  - **Prop dust** (package B; props variant, not lite): aux.z bits 2-7 carry a dust level from the anchor cell's decay
    (`props/tileProps.ts`, floats and lifebuoys opt out); up-facing faces get a settled layer with soft drifts (colour
    (0.36, 0.34, 0.30), up to 70 %, roughness 0.92, weaker normals, no metal), vertical faces a faint film. Emissive,
    NO_GRIME and animated parts stay clean; `brDust` also dulls the clearcoat.
- **`roughnessmap_fragment`.** `brOrmh.g` (props: the aux.x override, never on emissive parts). **Toksvig**:
  `r' = sqrt(r² + var·tok)`, `var = (1 − |n̄|)/|n̄|` of the stashed filtered normal and `tok` the layer's share of it that
  is lobe broadening (`uBrLayerC.w`: pool tiles 0.3, VCT 0.5, CMU 0.6, deck 0.7, ceiling tile 0.8, else 1). **Two-lobe
  unmixing** of the bimodal layers (POOL_TILE, POOL_MOSAIC, VINYL_VCT, TERRAZZO; `uBrLayerE` = glaze lobe gz, rough
  component rx): the mip-filtered roughness is the mixture (1 − c)·gz + c·rx, so `brCov = c` weights the specular
  (below) and the lobe keeps `sqrt(min(r, gz)² + 0.25·var)` at every distance instead of averaging into satin. Then
  × the grime multiplier and mixed toward the wet / dust target. With detail maps, the unresolved detail slope variance
  first adds to alpha² (LEAN: `r = (r⁴ + var)^¼`).
- **`metalnessmap_fragment`.** `ormh.b`.
- **`normal_fragment_maps`.** First `vec3 brNg = normal;` (unperturbed; declared at main scope). Then the cotangent frame `brTbn` (main scope) from `dFdx`/`dFdy` of **`-vViewPosition`** (view space, precise) and `vBrUv`; apply the stashed normal (already counter-rotated); strength per layer. With detail maps the detail slope follows in a second
  cotangent frame (of the detail uv: world-anchored on the shell), added to the mapped normal UDN-style with |slope| ≤ 1.
- **After `lights_physical_fragment`** (`chunks/materialPost.ts`, package B; before three computes `material.dfg`, so
  every light path sees it), in this order: water F0 0.02 / F90 1 on film (70 %) and puddle pixels; glaze coverage
  (specular × `1 − brCov·(1 − puddle)`); `USE_SHEEN` (medium+): Charlie sheen for textiles, colour = amount ·
  sqrt(albedo) (less where wet or worn), roughness from the pile lean seen by the camera; `USE_CLEARCOAT` (props):
  clearcoat = coat bit (aux.z bit 1) × (1 − dust), roughness 0.04; `BR_SPEC_AA` (medium+): alpha² += min(0.5·(|dn/dx|² +
  |dn/dy|²), 0.18)·tok on roughness and clearcoat roughness (Tokuyoshi & Kaplanyan 2019).
- **`emissivemap_fragment`.** `totalEmissiveRadiance = vBrEmit · vBrTint.rgb · mix(1.0, ormh.a·1.3, isLens) · dyn · shimmer`.
  - `dyn` = own-channel intensity (luma of `uFlick[0]`, which is exactly the intensity because `color/luma(color)` has luma 1) if `DYN_EMIT`.
  - `shimmer = brLensShimmer(int(aux.w·255), tint.a·255, uTime, uFlickerMode)` if `SHIMMER`, using `LENS_SHIMMER_GLSL` from `core/flicker.ts` injected verbatim (WP11 owns its body; WP9 never re-implements it).
  - **Emitter profiles** (graphics-realism C.2/C.3, `BR_DETAIL == 1` only; `chunks/emitters.ts` `brEmitterShape`, TS twin `core/emitterProfile.ts`): a non-FLOOR_AUX emitter whose `aux.z` bits 1-4 name a profile gets `vBrEmit · tint · brEmitterShape(…)` instead. PRISM: the lamp plane 6.5 cm above the lens seen with parallax, 2-4 lamp bands with per-lamp gain / cast / end blackening (6 % dead lamps), facets tilted across the lamps showing the image shifted by ±D·κ (per-facet sparkle near, the 4-image mean far, anti-aliased by the uv footprint), cavity rim shade and the prismatic angular profile (0.5 at 85°); 2x2 prisms show two U-tubes. LOUVER: parabolic cells with the lamps visible through them, specular blades inside the cutoff; past it the blades mirror the room (a neutral diffuse albedo 0.75 that replaces the lamp-tinted lens diffuse, lit by the baked irradiance: E/π is the mean radiance a mirror at the ceiling sees) under the lamps' semi-specular sheen, which grows toward the blade top (per cell row near, its cell mean far, so distant rows neither alias nor read as flat lamp-coloured panels), plus top-edge glints near the cutoff. OPAL: hot centre, faint LED grid, rim shade. TUBE (caps, blackening, limb), BULB (frosted / clear filament), HIGHBAY (arc lamp with parallax + reflector ring), DROP, SODIUM. Every profile averages 1 seen from the nadir (`EP_NORM`), so the bake stays calibrated. DYING: one bad lamp follows the shimmer and glows orange-pink at its cathodes (tubes: moving striations); DYN_EMIT: `shape · dyn` plus cathode ends that keep glowing while the tube is out; BUZZ shimmer scales the whole shape. OFF recessed lenses (shell PANEL_LENS) get a dark cavity with dead-tube shadows in their diffuse colour; a dead LOUVER shows its aluminium blade grid (`brOffLouver`: dark cells with the dead lamps through them, blades mirroring the room past the cutoff, bottom edges); punctual lights (three's `lights_fragment_begin`: the flashlight) see an albedo of their own on louvers (`brLouverAlb`'s `punct`, swapped into `material.diffuseContribution` by `materialPost` and restored before the baked light): the blades mirror a torch at the eye away (0.07), the reflector 0.2 and the dead lamps' phosphor 0.6 catch it through the cells, so a torch shows a dark grille over lit tubes instead of a white-painted one; a lit louver has the same diffuse albedo (`brLouverAlb`) under its emission, so one whose lamps flicker or are dimmed out (FLICKER bursts, anomaly dips) looks dead rather than showing black cells. The view vector: world axes for shell lenses (their uv runs along +x / +z), the uv cotangent frame on props.
- **`lights_fragment_maps` → baked lighting** (shell variant):
  ```glsl
  vec4 lmA = texture(uLmIrr, vBrLmUv);  vec4 lmB = texture(uLmDir, vBrLmUv);
  vec3 E = lmA.rgb;  float w = lmB.a;  vec3 Lw = normalize(lmB.xyz * 2.0 - 1.0);
  // flicker channels: channel k's source tile offset: sx = (kx == ownPx) ? 0 : sign(local.x - 9.6), same for z
  vec4 fl = texture(uLmFlick, vBrLmUv); vec3 Ef = vec3(0);
  for (int k = 0; k < 4; k++) { ivec2 s = channelSource(k, vBrLocal.xz, uOwnParity); Ef += fl[k] * uFlick[slotIndex(s)]; }
  vec3 Lv = normalize((viewMatrix * vec4(Lw, 0.0)).xyz);
  float ng = max(dot(brNg, Lv), 0.2);  // brNg = unperturbed normal stashed at the top of our normal_fragment_maps
                                       // (in r186 lights_fragment_begin sets geometryNormal = the PERTURBED normal)
  IncidentLight dl; dl.color = w * E / ng; dl.direction = Lv; dl.visible = true;
  float r0 = material.roughness; material.roughness = max(r0, 0.25);
  RE_Direct(dl, geometryPosition, normal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight);
  material.roughness = r0;
  irradiance += (1.0 - w) * E + Ef;                   // ambient part + flicker (added as diffuse irradiance)
  radiance += (1.0 - w) * E / PI;                     // ambient part as a uniform environment: indirect specular
  iblIrradiance += (1.0 - w) * E;                     //   (metals, glossy tile, CRT glass, cars get highlights)
  brIrrLocal = E + Ef;                                // stashed for haze
  ```
  - **The baked lobe is an area estimate** (`chunks/lighting.ts` `LOBE`, TS twin `bakedLobeRoughness`). The sketch's
    `max(r0, 0.25)` is widened for the `RE_Direct` call (base and clearcoat lobe; the diffuse term does not depend on
    the roughness): `α_eff² = max(α, 0.0625)² + K1·(1 − w) + K2·(1 − smoothstep(0, NG_FADE, dot(brNg, Lv)))`, with
    α = roughness², K1 0.25, K2 0.2 and NG_FADE 0.3; variances add. `w·E` averages several lights, and a von
    Mises-Fisher spread with mean resultant length w has an angular variance of about 2(1 − w) around L. A dominant
    direction near the receiver plane stands for a source close to the surface, and it sweeps across the texels. A bulb
    hanging 0.3 m under SHOWER_BLOCK's glossy tile ceiling, blended with the tube lamp's direction, met the mirror
    condition along a curve. That drew a bent 2 m highlight, up to 5× bright through `1/max(n_g·L, 0.2)` (luma 225
    against 116–134 at medium; now 122). Glazed wall tiles lit by a row of troffers no longer sparkle tile by tile in
    that lobe. Glossy floors keep their lamp highlights: 85–106 % of the old peaks in LOBBY, OFFICE and POOLROOMS at
    medium. Reflection passes run the same code, so the probe's capture loses the arc too.
  - **The ambient part follows the normal map** (lightmap path; not the light volume). `brLmDirUv(uv, k)` reads layer
    k of the stacked dir map with its rows clamped to [0.5, H − 0.5] (exactly a separate texture's clamp-to-edge, so
    layer 0 is bit-identical to before), and `brLmGrad` decodes the gradient, restoring the dominant-axis component so
    it is tangent to the geometric world normal (TS twin `lmGradWorld`). Then
    `iblIrradiance += E·SSAO_C·clamp(dot(g, n), −(1 − w), 1 − w)`: zero at n = n_g (flat surfaces and every frame
    mean keep their value: the flat-normal renders are identical and frame means moved by at most 0.25 %), and the
    ambient part never turns negative. Relief (high-passed log luminance, normal-mapped against flat normals):
    PIPEWORKS CMU 6.6 → 13.2 %, the LOBBY ceiling 0.2 → 0.9 %, PARKING's ceiling 0.24 → 0.40 %, goto=dark
    0.7 → 1.0 %; ceiling T-bars and tile bevels now shade. The flicker channels and the uniform environment radiance
    stay normal-independent. Known limit: the stored pair is on the axes of the chart's own normal, and `brLmGrad`
    decodes it on the axes of the face drawing it. Faces that borrow a chart across a different dominant axis (T-bar
    sides, diffuser risers and plenum-hole sides on the ceiling chart; baseboards and wall decals that fall back to the
    floor grid) therefore shade their relief with the chart's gradient on the wrong axes. Their flat normals still
    get zero, and the faces are small.
  - `material.multiScatteringCompensation` is only initialised by three's `lights_fragment_begin` when punctual lights exist; our chunk **sets it itself** from `material.dfg` exactly as r186 does: `material.multiScatteringCompensation = 1.0 + material.specularColorBlended * (1.0 / (material.dfg.x + material.dfg.y) - 1.0);` (`material.dfg` is always set by `lights_fragment_begin`), so harness scenes without the flashlight match the game.
  - The directional part is multiplied by its visibility `brDirVis` (A's contact shadow, then package B's
    `chunks/pom.ts FRAG_DIRVIS_GLSL`): the cavity's visibility cone (not lite): the texture cavity V is the
    cosine-weighted visibility of a cone around the mapped normal, V = sin² α, so the light is seen while
    `N·L > cos α = sqrt(1 − V)` (`smoothstep(cos α ∓ 0.15)`): grout, joints, pile gaps and fissures shadow the baked
    light as it grazes (Chan's `clamp(|N·L| + 2·ao² − 1)` never fired at the textures' V ≥ 0.9);
    on ultra (`BR_POM` 2) the parallax hit also marches up to 4 steps toward the light up to the relief top (step
    midpoints, one per march step length; skipped when the shadow would be under half a pixel long; occlusion × 8 per
    unit of height above the ray, × the parallax fade; not × w: `brDirVis` scales only the directional share already).
  - `RE_IndirectSpecular` (three) then uses `radiance`/`iblIrradiance` with its multiscatter term; `computeSpecularOcclusion` with the baked AO (`aomap_fragment`, below) keeps corners from glowing.
  - The **props** variant samples the light volume instead: `p = vBrLocal`, uvw from `p`.
    - **Tower wrap:** if `PROP_AUX` bit 1 is set, `p.y = 1.5 + mod(p.y − 1.5, 3.0)` (the tower's LV samples are periodic).
    - **Wall clamp (per fragment):** cell = `floor(p.xz / 1.2)`; mask = `texelFetch(uVolMask, cell + 1, 0).r`; for each set bit, clamp the lookup ≥ 0.3 m inside that cell on that side. Works for props of any size.
    - **Up-facing surfaces drop the level behind them** (`brLvK(y, max(n.y, 0))`, TS twins `lvLevels` / `lvLevel` / `lvLookup`): between levels i and i + 1 the level below keeps the trilinear weight `(1 − t)·b`, `b = 1 − smoothstep(0, TUNE.LV_BACK_D, (y − LV.Y[i])·n.y)` (`LV_BACK_D` = 0.1 m), at `k1 = i + t / (t + (1 − t)·b)`. The samples under a prop's occluder boxes hold the light in its shadow, lit from below; blended into a seat top above them they darkened it and turned its baked direction below the seat plane. A seat or desk top reads the first level above it (continuous in y: at a level the lookup is that level); a whole-level shift instead read the light up to 1.1 m above desk tops (+60 %, the CRT's shadow gone, pedestal feet under a table lit). **Gate** (`lvBackGate`, `lvGatePoint`, `brLvUp`): where `k1 > k0` (the plain `i + t`), two extra `uVolA`/`uVolB` fetches at levels i and i + 1, at a point `TUNE.LV_GATE_OFF` (0.3 m) behind the surface in xz (wall-clamped like the lookup), give the light each hands an up-facing receiver (`Ē·(1 − w + w·clamp(d.y / 0.2, 0, 1))`); the lookup is `mix(k0, k1, smoothstep(r0, r1, e(i+1) / e(i)))`. A sloped surface (n.y ≤ `LV_GATE_NY0` 0.75) uses (r0, r1) = (`LV_GATE_LO`, `LV_GATE_HI`) = (1.5, 3): it drops only a level that holds the prop's own shadow (16–100× under a lounge chair's frame at high, ~13× at low/medium), since its drop squeezes the vertical transition into `LV_BACK_D / n.y` of height; a room's own gradient (1–1.8×) and a corner in front of the surface (the hood before a car's windshield, read inside the cabin: ~1.5×; dropping it drew a dark band across the glass) keep plain weights. A flat top (n.y ≥ `LV_GATE_NY1` 0.95) has no transition to squeeze and uses (1, `LV_GATE_FLAT_HI` 1.35): a partial drop left a soft shadow over a lounge chair's seat where the level below brightens away from its frame. Either way a level below that is brighter is kept (a load on a rack deck, whose level above lies under the next deck: the whole-level shift turned those tops black). Down-facing and vertical surfaces keep plain trilinear weights at their own point (moving down read a backrest's own frame shadow in; a sideways offset put dark stripes on thin step faces). Known limit: a seat under a table top reads the level above the table.
    - Decode `Ē`, dominant direction d and directionality w; apply the same `RE_Direct` call as the shell with `dl.color = w·Ē / max(dot(brNg, d), 0.2)`, `irradiance += (1 − w)·Ē + Ef`, and the same `radiance`/`iblIrradiance` terms; channels from `volC` with the same channel selection.
- **Emission-map reflection** (`BR_FLOOR_REFL`, `roughness < 0.5`, and either `FLOOR_AUX && REFLECTIVE` or `PROP_AUX` on an up-facing normal (desk tops, car roofs, CRT glass); skipped on DYN_EMIT/SHIMMER faces):
  1. Reflect the view vector (view space → world orientation).
  2. From `vBrLocal`, intersect it with the plane `y = floorY + aux.x·0.05` (floors: emitter plane from WP5) or `y = aux.w·0.05` (props: anchor ceiling).
  3. `key = texelFetch(uEmission, ivec2(floor(uvHit·RES)), 0).a` (level 0, nearest); reject unless `abs(abs(key) − regionKey) < 0.5`, where regionKey comes from `aux.y + 256·aux.z` (props: accept any key > 0).
  4. Colour: `textureLod(uEmission, uvHit, roughness·5).rgb`; if `key < 0`, multiply by the live intensity of the dynamic light of the tile containing the hit (`uFlick` slot from the hit's tile offset), so reflections flicker with the lamp.
  5. Fade by `1 − smoothstep(0, EMISSION.FADE, distance)`.
  6. Multiply by `F_Schlick(0.04, dotNV)·(1 − roughness)²·lmA.a` (props: LV AO).
  7. Add the result to `reflectedLight.indirectSpecular`.
- **Planar reflection** (`REFLECTIVE && reflOn`, wet tile, and the water surface): only surfaces whose plane height equals the reflected plane (`uReflY`, ±2 cm; water: `aux.w`, floors: floorY) sample `textureLod(reflTex, screenUv + n.xz·0.02, roughness·6)`, then Fresnel. Other planes fall back to the emission-map reflection.
- **`aomap_fragment`.** Specular occlusion: `reflectedLight.indirectSpecular *= computeSpecularOcclusion(dotNV, lmA.a, roughness)`. Indirect diffuse already contains the AO.
- **Submerged surfaces** (`brSubInfo` = depth, kind, surface y from `chunks/water.ts brWaterSubInfo`: `UNDERWATER` shell faces carry the plane in `aux.w = (waterCm + 320)/5`, floors the kind in tint.a, other faces and props use the wall-mask cell). Their lit radiance first loses the downwelling attenuation `exp(−0.8 κ depth)` (the baked light reached them through the water above; not their own emission), `κ = σa + (1 − g)σs` the transport coefficient. Then:
  - **split frames** (`BR_WATER_VOL`, `uWaterVolOn`, seen from above the water, outside the mirror pass, tile faded in: `brDefer`): nothing else, not even the air haze. The water shader sees this radiance through the ColorPyramid and applies the whole view path (see "Water material");
  - otherwise (low, medium, the mirror pass, fly mode under water) the legacy optics: per-kind media `WATER_MEDIA` (`params.ts`: pool σa (0.35, 0.065, 0.03) /m, σs 0.12, g 0.9; flooded σa (0.9, 1.6, 3.4), σs 1.2, g 0.92: humic stains absorb blue, silt scatters forward) along the **refracted** view path `L = depth / cos θt` (Snell, η 0.75; at most ~1.5× the depth): `color = (lit·down + emission)·exp(−κ L) + Lin`, `Lin = σs·Φ·E/π·tint·(1 − e^{−K L})/K`, `K = κ(1 + 0.8 cos θt)`. `Φ` (`WATER_PHI`, `downwellPhi`) is the share of the diffuse downwelling light (Snell's window, n² (1 − F) radiance) that the dual-lobe phase `brPhaseW` (a forward HG of g plus a `BACK` share of a g −0.3 lobe; a local copy until package F's phase.ts) backscatters to a viewer above: 0.03-0.06, where the old `(1 − g)σs` share made flood water milky;
  - caustics (zero-mean, × `E`): 2-octave Voronoi (`brCausticsW`, filament width and cell scale as parameters, mean `brCausticMeanW`) on up-facing submerged faces, and on submerged walls the pattern where the light entered the water (along the refracted baked direction), which draws streaks down pool walls; above **pool** water (`BR_CAUSTICS_FULL`, tiles with `uTileWater` bit 0) ceilings and walls get a softer net magnified with the height, from the bilinear coverage of the 4 nearest wall-mask cells;
  - the flashlight on submerged fragments (`BR_CAUSTICS_FULL`): `chunks/surface.ts` redirects three's `getSpotLightInfo` call in `lights_fragment_begin` to `brSpotInfoW` (`#define` at the end of the emissive chunk, `#undef` at the start of `chunks/lighting.ts`), which absorbs the beam along its refracted in-water path and focuses it into a fine sharp caustic net.
- **`fog_fragment` (replaced; it runs after `colorspace_fragment` in r186 and targets are linear):**
  ```glsl
  float d = length(vViewPosition);
  float fh = 1.0 - exp(-uHazeDensity * d);
  vec3 insc = mix(uFarColor, brIrrLocal * uHazeAlbedo / PI * uHazeTint, 0.5);
  gl_FragColor.rgb = mix(gl_FragColor.rgb, insc, fh);
  gl_FragColor.rgb = mix(gl_FragColor.rgb, uFarColor, smoothstep(uEdgeFog.x, uEdgeFog.y, d));
  // BR_AIRLIGHT: + analytic spotlight airlight integral along the view ray (flashlight beam in haze)
  gl_FragColor.rgb = min(gl_FragColor.rgb, vec3(32768.0));   // HDR_CLAMP
  ```
  That is the analytic path (`brHaze` / `brHazeT` in `chunks/common.ts` HAZE_FUNCS; low, medium, reflection passes).
  Under `BR_VOLUMETRIC` (high / ultra, package F) both dispatch to the froxel volume while it is valid
  (`uVolZ.w`) and outside reflection passes: `brVolFog` applies the analytic haze to the stretch beyond the grid's far
  plane (`T_far`), then `col·v.a + v.rgb` with `v = brVolLookup(viewPos)` (in-scatter and transmittance from the
  camera to the fragment: two bilinear taps in the tiled froxel atlas), then the edge fog; `brHazeT` returns the
  matching `v.a·T_far·(1 − fe)`, so `brHaze(c) = c·brHazeT + brHaze(0)` on both paths (the water layer and the MRT
  specular write rely on it). The airlight is not added there: the torch is in the volume.
- **World-space noise** (macro variation, hashed wear features): xz from `vBrLocal.xz + uNoiseOrigin.xz`; any y input uses noise periodic in y with a period dividing 3.0 m (tower periodicity).
- **Debug views.** Before haze, `if (uDebugView != 0)` outputs the selected term: `DEBUG_VIEW_NAMES` order; TEXEL = checker at lightmap texel frequency; ZONE/ROOM = hash colours from `aux`.

**Water material.** Per-quad kind / depth / emitter plane / region key arrive in flat varyings. Fresnel is the exact dielectric `brFresnelW` (F(1) = 0.0204).
- **Split frames (high / ultra, `BR_WATER_REFRACT` = march steps 8 / 10, "volMode": `uWaterVolOn` and the tile faded in):** the water is opaque, `col = F·refl + spec + (1 − F)·trans`, then `brHaze` (package F's API).
  - Refraction (`chunks/water.ts brWRefract`): the view ray refracted by the wavy normal (η 0.75) is tested first against the rect's flat floor at `D / cos θt` (rects are single-depth: one texel fetch of the pyramid's linear depth); otherwise marched linearly to 1.2× that, then 3 bisections to the crossing, which is classified by the texel's own surface point (`brWScenePos`: exact at grazing angles and in ultra's 0.67 pyramid), then a secant. A sample more than `THIN` (0.25 m) behind a thing on the water (`brWOnWater`: its surface point from `STRIP_DEPTH` below to 1.2 m above the surface over a cell holding water: a lane-rope float, a ladder's rail; the deck at a lip is not) passes behind it and the march goes on (stopping there drew a stand-in patch shaped like each float beyond it); only a ray that ends behind it, or reaches something the texel shows as that thing, is hidden by it. A ray that passes behind something above the water (the deck lip over the near wall, a lounger) or leaves the screen has no data; the crossing is bisected down to a texel. Behind a thing on the water, the scene just outside its two sides along the ray's image (visible again, deeper than `STRIP_DEPTH`, within 64 texels; or the flat-floor target where it lies outside: what the neighbours show) is blended by the target's position across the strip. Otherwise the target is reflected back across the line it disappeared behind (continuous where it reappears, the waves' lensing kept at full strength): behind a pool's near lip (the rim axis from walking the wall-mask cells toward the eye, `brWEdgeAxis`) the flat-floor target is mirrored on the floor across the lip's shadow line, so floor maps to floor at its true perspective, also across a deep end's wide hidden band; else across the lip's image line in screen space; with no rim in reach, about the crossing point; off screen, at the screen edge. The screen-edge mirror copies content from beside the edge, so where it or its neighbourhood (mip 3) is 1.5-2.5× brighter than a reference, its luma is clamped to within 1.15× of it (`STANDIN_*`; the reference: the scene where the ray's image left the screen, mip 3, raised to the stand-in's own surroundings, the least bright of 4 taps 4 % of the screen height away, at most 2×: the exit scene alone left the copy a flat dark hole in the lamp-lit wall): a wall lamp near the screen's bottom edge no longer shows a second, sharp copy of itself and its bezel beside its refracted image (a clamp everywhere drew streaks along the rays; the texel before a lip, in the lip's shade, is no reference for the floor mirrored beyond it). (The earlier morph toward the straight-through view, with a coarsely bisected boundary, drew swirls along near rims.) The tile grid kinks at the waterline, pools look shallower, ripples and waves lens the floor.
  - Water body (`brWVolume`): the scene at the target through the kind's medium: unscattered `exp(−(σa + σs)L)` (sharp), forward-scattered `exp(−κL) − that` (blurred through the pyramid's mips by `BLUR·sqrt(σs L)·L` metres at the target's depth, falling back to sharp where the mip's depth disagrees), plus the ambient in-scatter in closed form `σs·Φ·E/π·tint·(1 − e^{−kL})/k`, `k = σt + 1.25 κ cos θt` (downwelling attenuation with the depth `s cos θt`).
  - Light in water (`BR_WATER_VOLLIGHT` = lamps, 2 high / 4 ultra): the flashlight beam (`brWaterTorch`: 6 samples, the smooth beam profile of `flashlightOptics.ts`, the beam's own transport-attenuated refracted path, the water surface's spot shadow) and the nearest UNDERWATER lamps (`brWaterLamps`: `materials/water/underwaterLights.ts` picks the nearest lit lamps in water in front of the camera every 6 frames and writes them camera-relative each frame; Lambertian, 6-sample tan substitution, faded out between 2.5 and 4 m from the segment) scattered toward the eye with `brPhaseW`. The pool lights are `UNDERWATER_NITS` = 6000 nits over a 26 cm lens (~400 cd, a 1300 lm pool light), so they glow in the water of a lit hall and throw light on the pool's floor and far wall.
- **Otherwise (low, medium, tiles fading in):** reflection, specular and floating matter premultiplied, `alpha = F`, blended `One, OneMinusSrcAlpha` over the (legacy-absorbed) floor with weight `1 − alpha`.
- Surface slope (`chunks/water.ts brWaterSlope`): `BR_WATER_WAVES` analytic gravity-capillary waves (dispersion at the quad's depth, integer wave lattice periodic over NOISE_WRAP, 1.6 → 0.22 m, per-kind slope RMS pool 0.012, flooded 0.004, film 0.0015) plus three drifting octaves of the `waterNormals` slope map (1.2 m, 0.96 m axis-swapped, 1.92 m 3-4-5 rotated; low: two octaves only), footprint-filtered, with the removed variance in the roughness `α = sqrt(α0² + 2 var)`; ripple-window and drip-ring slopes add on top (`BR_WATER_RIPPLE`).
- Reflection: the planar texture when this plane is the mirrored one (fragment y = `uReflY` ± 2 cm; the perturbed reflected ray is projected 3 m behind the surface, so the wobble shrinks with distance). Sharp lookups magnify it with a cubic B-spline (4 taps: a bilinear magnification traced its texel grid in the saturated contour of a bright lamp: "stepped blobs"); rough water (the lobe stretched by 1 / cos θ past 1.5 texels, its streak direction the mirror-texture image of the in-plane direction toward the camera) takes three `textureGrad` lookups over the lobe's ellipse (the mirror texture has anisotropy 8, so the hardware integrates along the streak): two across it round the lateral profile, one over twice the length gives the GGX-like tail: smooth wet-floor streaks. Other planes: package D's box-projected probe when on (`BR_PROBE`; D's `brSsrTrace` slots in first), else the emission-map reflection at the quad's own emitter plane and region over the room average (haze tint). The app loop mirrors the nearest plane with films ranked 8 m farther, so a player on a film-covered deck mirrors the pool beside it. Where the water is the mirror's only reader (high / ultra: SSR and the froxel presets compile the floors' planar path out), the mirror is rendered only while a water draw passed the depth test within the last 0.5 s (`materials/water/waterVisibility.ts`: an `ANY_SAMPLES_PASSED_CONSERVATIVE` query around each water mesh's draw, read a frame or two later; an unanswered query counts as visible): the plane scan does not see walls, so a pool behind a warehouse wall or a dark office cost a mirror every frame (about 0.3 ms at high and 0.5-0.8 ms at ultra in WAREHOUSE, PIPEWORKS and the DARK spawn, in-page A/B).
- Specular: the flashlight GGX at α (glints); the baked dominant direction only where α > 0.08 (on calm water the reflection already holds the emitters).
- `BR_WATER_DEBRIS`: a drifting dust / oil film (it dulls the reflection by up to 30 % and adds a faint diffuse layer; it barely roughens still water), floating flecks on a 0.24 m lattice (ragged, soaked matter; sub-pixel ones fade out), and contact lines where the water meets something: the horizontal distance `e` to the nearest wall / rim / SOLID cell from the tile's wall mask (`brWaterEdge`, every preset) or, in volMode, to whatever the straight view ray meets near the surface (`brWContact`: pillars, chair legs, ladders); a meniscus (the normal tilts away from the contact over max(3 mm, 1.2 px): a thin line reflecting the wall above), a contact shadow on `trans` (30 % within 3 cm) and a ragged scum band (`SCUM_W` 1.2 / 11 / 4 cm pool / flooded / film). Floating matter is lit by the baked light and the flashlight.
- Haze through `brHazeT` / `brHaze`; HDR clamp. Debug view `water` shows α, the ripple height and the slope (volMode: the refracted path L / 2 m, the ripple height, 0.5 where the march found its target + 0.5 on contact lines).

**Water ripples** (`materials/water/WaterRipples.ts`, `rippleSources.ts`). A world-anchored window of `waterRippleRes`² texels of `waterRippleTexel` m (medium 128 × 6 cm, high 256 × 4 cm, ultra 512 × 3 cm) snapped to whole texels around the eye, over the plane the player stands in or the nearest one within 6 m. HalfFloat ping-pong targets hold (h, h_prev, foam); a fixed 1/60 s step (≤ 4 per frame, none while the simulation clock is frozen; a clock jump resets it) integrates `h' = (2h − h_prev + C²∇²h)·damp` (c 0.55 m/s, τ 2.5 s pool / 1.2 s flooded) with reflecting walls from a per-window cell mask (water on the plane, wall bits at plane + 5 cm, dry pillars). Impulses: footsteps in water, zero-volume wading-wake dipoles per leg (+ foam), idle sway, DRIP emitters falling into the window; drips elsewhere within 25 m become analytic rings (`uDrips`). Only the water shader samples `uRipple`; it interpolates the last two steps. A player standing in a film (≤ 3.5 cm) next to a pool or flooded plane simulates that plane (films rank 100 m farther in the scan). Loop step 10, inside the GPU timer ('waterSim' profile segment); the same update drives the in-water lamp picker.

**Planar reflection.**
- A mirrored camera about `y = waterY` with the oblique near-plane clip (the math from `Reflector.js`), rendered at `q.planarReflectionScale`, HalfFloat, with 9 mip levels (`MIRROR_LEVELS`; the water reads up to lod 8) built like the colour pyramid's (`LowPassMips`: a binomial low-pass in fp32, clamped to `HDR_CLAMP`). `gl.generateMipmap` sums the 2 × 2 blocks of an RGBA16F level in half precision on some drivers (NVIDIA GL), so a lamp near `HDR_CLAMP` overflowed to Inf in the coarse mips the rough water reads (white or red blocks); the binomial mips also smooth the stepped contour of blurred lamp reflections. The chain's program is `reflection.materials` (the pyramid's program, already warmed on high and ultra).
- The props layer is excluded beyond 20 m.
- While rendering, `globals.reflOn = 0` (this avoids a feedback loop).
- Called before `post.render`.

**Warmup** (`warmup(renderer, camera, scene)`; the program cache key includes the output colour space and the scene's light/shadow state, so it must match the real frame):
1. Build a scratch group with one mesh per variant (shell, props, decal, water) using dummy bindings and a 1-triangle geometry with every attribute, and add it **temporarily to the real `scene`** (so the flashlight and shadow state are in the key).
2. Bind a HalfFloat render target (the composer's input buffer size class, or a 1×1 HalfFloat RT), call `await renderer.compileAsync(scene, camera, target-bound)`, then do **one real draw** into that target (ANGLE creates pipelines at first draw). The scratch group is hidden while `compileAsync` polls: the app's frames keep rendering meanwhile, and its water triangle (layer 0, not `LAYER_LATE`) would otherwise be drawn into the MRT `sceneRT` of a split frame, which it has no outputs for. `applyQuality` likewise generates package B's detail array before any system switches preset, so no frame pairs the new frame graph with the old surface programs.
3. During warmup frames set the flashlight intensity to 0 with `castShadow = true` and `shadow.needsUpdate = true`, so the spot-shadow depth program is built too.
4. Keep the four warmup materials alive for the app's lifetime (pinned: `releaseProgram` destroys a program when its last user is disposed, e.g. the last water tile).
5. Remove the scratch group. QA asserts `renderer.info.programs.length` is constant from ready through the soak (§8.2).

**Acceptance**
- **`tests/materials/anchors.test.ts`.** Import `ShaderLib` from three (tests may import three) and assert every anchor exists in `ShaderLib.physical.vertexShader` / `fragmentShader`.
- **Cache key.** 100 tile materials give one program per variant: count `renderer.info.programs` in the chunk harness.
- **Bindings.** Replacing `bindings.lmFlick.value` after first render changes the rendered result (harness test).
- **Anti-tiling.** At grazing angles, a rotated-tile layer (VINYL_VCT) shows no per-tile sharpness checkerboard (harness `view=final`, imageStats variance per tile cell < 5%).
- **Harness** (`harness/chunk.html`) with the real bake:
  - `view=lightmap|directionality|ao|mask|layer|texel|emission` all render with no errors;
  - `view=final` shows specular sheen on damp carpet and the troffer reflection streaks on wet vinyl.
- **Leak:** `testScene=leak&view=final`, dark-room luma < 0.02 (WP14 imageStats).

**Texture realism v2 conventions (TEX2).** The shader side of the WP8 conventions above.
- **Channel decode** (`chunks/surface.ts` FRAG_MAP_GLSL, main scope after the base sampling and the alpha test; hex
  blended and rotated like the other channels): `int brAuxK` (`BR_AUX_KIND[brL]`), `float brAux` (ormh.a on
  `detailMask` / `wear` / `mask` layers, 0 on `lean` layers), `float brAux2` (albedo.a on `aux2` layers, else 0),
  `vec2 brLean` (the lean vector in the continuous uv frame, counter-rotated by transpose(M) on rotated-tile layers),
  `mat2 brRotM` (the rotated-tile transform M, identity elsewhere), `vec2 brRotC` (the rotated cell's centre in the
  continuous uv, 0 elsewhere), `brMuH` (the 1 × 1-mip mean height; the puddle block reads it too) and
  `brRel = (brNrm.w − brMuH) · heightScale` (metres above the layer's mean plane). brMuH and brRel are read-only
  expressions (#defines), not variables: each use is a fetch, so read them behind a quad-uniform gate (one
  unconditional fetch per pixel at main scope cost ~0.3 ms per ultra frame). `brMetal` is 0 on `lean`
  layers. `float brAm` (the detail albedo multiplier over its mean, 1 where no detail layer was fetched) is main-scope
  under BR_DETAIL_MAPS.
- **Family hooks** (`chunks/family/index.ts`): `chunks/family/{textile, walls, ceiling, concrete, masonry, tile,
  props}.ts` each export `{ pars, postSample, postDetail, grime, postWet, rough, normal, matPost, postLight, preFog }`,
  concatenated in that family order at fixed points: pars at the end of the fragment common block; postSample after the
  decode, before the detail fetch (may change brA, brOrmh, brNrm, brDetUv, brDetDx, brDetDy); postDetail inside the
  detail block after the fetch, before it is applied (may rescale brAm, brDetSl, brDetVar); grime inside
  `if ( brGrime != 0 )` after the shared lookups, one `else if ( brGrime == BR_G_<PROFILE> )` clause per profile (one
  exclusive chain: separate ifs compiled to different rounding); postWet
  after the wetness and puddle block; rough after the LEAN term; normal after the detail slope; matPost after three
  fills `material` (wet F0 and glaze coverage applied; `bool brCoat` declared), before the specular AA; postLight after
  FRAG_AO_REFL_GLSL; preFog in the fog replacement outside the debug views, before the submerged optics. The grime
  branches moved verbatim: carpet (1) to textile, wallpaper (2) and paint (7, a copy of 2) to walls, ceilingTile (3)
  to ceiling, concrete (4) to concrete, masonry (8, a copy of 4) to masonry, tile (5) to tile, metal (6) to props.
  The textile sheen moved to textile.matPost, the clearcoat fields to props.matPost and the Level 0 pile trap from
  `haze.ts` to textile.preFog. Hooks gate on brL or brGrime (quad-uniform), respect BR_DECAL, BR_LITE and
  BR_DETAIL_MAPS, and skip expensive work when uBrReflPass > 0.5.
- **Debug views** 24 `aux` (r brAux, g brAux2; lean layers show rg = lean · 0.5 + 0.5, b = 1), 25 `textile` (the
  textile family's; black until it shows something) and 26 `relief` (r / b the relief above / below the mean in units
  of `BR_L_RELIEF`, g the cavity 1 − ormh.r). They leave main early where their values exist, through
  `if ( uDebugView == BR_DV_<VIEW> ) BR_DEBUG_EXIT( v )` (`chunks/debug.ts` DEBUG_PARS_GLSL: the fog stage's decal
  premultiply, HDR clamp and empty specular G-buffer), instead of going through the fog-stage view list: a value read
  there stays live through the whole shader, and six of them cost ~0.3 ms per ultra frame (register pressure).

**Must NOT touch:** lightmap encoding (WP7) and post (WP11). All tuning constants live in `materials/chunks/*.ts`.

---

### WP10: Streaming, workers, residency, world queries

**Goal:**
- Hitch-free streaming of tiles around the player: max frame < 50 ms after ready, uploads within budget.
- Correct GPU lifecycle and pooling.
- The worker protocol with a pure handler.
- World queries for collision, audio and debug.
- The Node full-pipeline integration gate.

**Files:** `src/stream/*`, `src/workers/*`, `harness/chunk.html`, `src/harness/chunk.ts`, `tests/stream/*`, `tests/workers/*`, `tests/integration/pipeline.test.ts`.

**Exported API:**
```ts
// workers/handler.ts (PURE; used by chunk.worker.ts and by Node tests)
export interface HandlerState { init: WorkerInit | null; gen: WorldGen | null; layouts: Map<string, ChunkLayout> /* LRU 96, never transferred */; bakeCache: BakeCache }
export function createHandlerState(): HandlerState;
export function handleRequest(req: WorkerRequest, st: HandlerState): HandlerResult;
// workers/validatePayload.ts
export function validateBuild(mesh: TileMesh, lm: LightmapData): string[];
export function validateBake(lm: LightmapData, expectHash: number): string[];
export function validateLayoutPayload(l: ChunkLayout, c: ChunkCollision): string[];
// stream/WorkerPool.ts
export interface JobHandle<R> { readonly id: number; readonly promise: Promise<R>; priority: number; cancel(): void }
export interface WorkerPool {
  readonly size: number;
  /** affinity (chunk key string): soft routing — the job goes to worker hash(affinity) % size when that worker is
   * idle or becomes idle before any other idle worker would take it; otherwise to any idle worker. */
  submit<T extends WorkerRequest['t']>(req: Extract<WorkerRequest, { t: T }>, priority: number, affinity?: string): JobHandle<Extract<WorkerResponse, { t: T }>>;
  /** cancel all queued jobs, drop results of in-flight ones, broadcast `init` to every worker, resolve when all reply 'ready' */
  reinit(init: WorkerInit): Promise<void>;
  queued(): number; busy(): number; dispose(): void;
}
export function createWorkerPool(size: number, init: WorkerInit, factory?: () => Worker): Promise<WorkerPool>;
// stream/ChunkStreamer.ts
export interface StreamerOptions { renderer: THREE.WebGLRenderer; materials: MaterialSystem; quality: QualityConfig; init: WorkerInit; bus: GameBus; pool: WorkerPool; startStorey: StoreyId }
export function createChunkStreamer(o: StreamerOptions): WorldStreamer;
// stream/geometry.ts
export function toBufferGeometry(m: MeshBuffers): THREE.BufferGeometry; // attribute names per core/mesh.ts
// stream/TexturePool.ts
export interface TexturePool {
  acquire2D(w: number, h: number, type: 'half' | 'u8', data: Uint16Array | Uint8Array, mips: boolean): THREE.DataTexture;
  acquire3D(w: number, h: number, d: number, type: 'half' | 'u8', data: Uint16Array | Uint8Array): THREE.Data3DTexture;
  release(t: THREE.Texture): void; stats(): { live: number; pooled: number; bytes: number; pooledBytes: number };
}
// Pool cap: at most 8 pooled textures per (size, type) class; releases beyond the cap are disposed immediately.
export function createTexturePool(renderer: THREE.WebGLRenderer): TexturePool;
```

**Handler** (`handleRequest`):
- `init`: store options; `gen = createWorldGen(opts)`.
- `layout(key)`: `gen.generateChunk` (via the LRU), then `buildChunkCollision` (WP12). Respond with **`cloneLayout(l)`** and transfer `layoutTransferables(clone)` plus the collision buffers. **Never transfer the LRU instance** (transfer detaches its arrays; later `build`/`bake` jobs on this worker would read zero-length arrays).
- `build(tile)`:
  1. Fetch the 9 layouts from the LRU, generating missing ones.
  2. `makeNeighborhood`.
  3. `buildTile(nb, tile, tpc)`.
  4. `bakeTile(nb, tile, surfaces, 'preview', …)`.
  5. Transfer everything.
- `bake(tile)`: `buildTileSurfaces` → `bakeTile(…, 'full', …, st.bakeCache)`.
- `find`, `spawn`, `ascii`: delegate to `gen`.
- Exceptions become `{t: 'error', message, stack}`.
- If `init.validate`, run `validate*`. Violations produce an error response with the message list; the job fails loudly in dev.

**Worker shell:** `self.onmessage = (e) => { const { res, transfer } = handleRequest(e.data, st); postMessage(res, transfer); }`. An `init` request also clears `st.layouts` and `st.bakeCache`.

**Pool:**
- `size = clamp(hardwareConcurrency − 4, 2, quality.bakeWorkers)`.
- The queue is a min-heap by priority, on the main thread. Each worker has one job at a time.
- **Soft chunk affinity:** the streamer passes the chunk key as `affinity` for `layout`, `build` and `bake` jobs, so a chunk's 4 tiles share one worker's layout LRU and bake cache whenever possible.
- `cancel()` removes a queued job; a running job's result is dropped.
- `init` is broadcast before any job; `reinit` re-broadcasts it (quality changes that alter `BakeQuality`, i.e. tpc, samples or rays).

**Streamer.**
- **Desired set.**
  - Chunks within Chebyshev `streamRadius` of the **look-ahead chunk** (the chunk of `position + smoothedVelocity·EDGE_FOG.LOOKAHEAD_S`, so the next ring is requested ~2 s before the player crosses a chunk line) plus the player's own chunk: all 4 tiles each.
  - Hysteresis: evict only at `streamRadius + 1`.
  - Tiles whose nearest point is beyond the edge-fog end (`EDGE_FOG.END·R`) stay resident but `group.visible = false` (they are fully fogged); budgets assume up to 144 resident tiles at radius 2 (6×6 chunks during hysteresis).
  - Layout jobs for resident chunks (collision and queries).
  - Build and bake jobs per tile.
- **Priority** (lower is sooner):
  - Base: `ring·100 + (inFrustum ? 0 : 30) + distance/2`.
  - Job type offsets: `layout −60, build −40, bake +0, prefetch +400`.
  - The player's own chunk: −1000.
- **Residency state machine per tile.** Transitions happen in `processUploads`, **at most `UPLOAD.MAX_STEPS_PER_FRAME` step per frame**, within `budgetMs`:
  ```
  queued → building (build job in flight) → received
  received → texUpload:  TexturePool.acquire* for irr/dir/flick|zero/mask/emission/volA/volB/volC|zero/volMask;
                         renderer.initTexture(each); bindings updated only via `.value`
  texUpload → geoUpload: toBufferGeometry(shell/props/decals/water); materials = materials.createTileMaterials(hasWater);
                         meshes into tile.group (position = tile origin). FORCE the GPU upload now (three uploads
                         geometry lazily at first visible draw, and never for invisible/prefetch groups): move the
                         group into a scratch Scene with `overrideMaterial` = a cheap pinned material (tile
                         materials keep the default `allowOverride = true`), set
                         frustumCulled=false on its meshes, render once into a 1x1 scratch RT, restore
                         frustumCulled, then add the group to its storey group (also for prefetch groups)
  geoUpload → fadingIn (bindings.fade 0→1 over UPLOAD.FADE_IN_S) → resident
  resident + full bake received → texture step only: swap lightmap textures in place (same size ⇒ texSubImage2D via
                         TexturePool reuse; instant swap, no crossfade); bake = 'full'
  evict: resident → evicting (removed from scene) → next frame: dispose geometries + materials, release textures → disposed
  ```
- **Frustum.** Tile groups are culled by three per mesh; mesh `boundingSphere` comes from `MeshBuffers.bounds`. Props meshes hide beyond `q.propDistance`. `castShadow = true` on shell and props (flashlight).
- **Storeys.** One THREE.Group and one query data set (layouts + collision) **per storey**.
  - `prefetch(s, x, z, r)` submits `layout` jobs for the (2r+1)² chunks (registered in storey s's data set) and builds, bakes and uploads their tiles into s's **invisible** group. Prefetch residency steps use their own `UPLOAD.PREFETCH_STEPS_PER_FRAME` slot, so they neither starve nor are starved by current-storey uploads. Prefetched data expires 10 s after the last `prefetch` call for it.
  - `isPrefetched(s, x, z)`: see `core/runtime.ts` (layouts/collision of the 3×3 chunks loaded, their tiles uploaded — preview is enough — and the centre chunk's tiles full-baked; full bakes for the rest swap in later as usual).
  - `switchStorey(to)` flips group visibility **and** swaps which data set `query` reads, in the same call; then re-targets the desired set. The old storey is evicted progressively.
  - WP12 decides what to prefetch (see WP12 traversal).
- **`attachDynamicMesh(tileKey, m)`:** builds a mesh from `m` with the tile's props material, adds it to the tile group, forces its upload like geoUpload, and returns a handle whose `setOffset` moves it (tile-local) and `dispose` removes it; eviction disposes it.
- **`isReady(r, needFull)`:** every tile of chunks within Chebyshev r is resident (fade done), with `bake === 'full'` if `needFull`, and the layouts are loaded.
- **WorldQueryImpl** (world metres; `CHUNK_SIZE` math in float64):
  - `floorAt`: the cell floor (layout), the highest WALKABLE_TOP box top ≤ `feetY + stepMax`, and ramp planes (from `ChunkCollision`). `NaN` if the chunk layout is not loaded.
  - `boxesNear`: collision boxes from the cell buckets.
  - `losClear`/`rayDistance`: 2D DDA with height, using `edgeOccludesAt` and SOLID cells.
  - `raycast` (package F): 2D DDA over the cells along the ray; per cell the floor / ceiling planes (none in TOWER, VOID, NO_CEIL cells), steps and soffits met on a cell line, the cell's collision boxes (walls with their thickness, jambs, posts, SOLID masses, blockers, props; slab test; `SolidFlag.VIRTUAL` boxes skipped) and the chunk's ramps (the walking plane from above; a FILLED body's sides and ends; an open flight's soffit from below and its stringers). The nearest hit inside a cell's span is final. Albedo: `LAYER_DEFS[mat].albedoMean` of the floor / ceiling material, the edge's `matNeg`/`matPos` face material for wall pieces, the floor material on blocker and riser tops, the cell's `wallMat` on SOLID cover faces, 0.3 for props.
  - `edgeSound`: `EDGE_SOUND[kind]`, or 0.
  - `fixturesNear`/`emittersNear` scan layouts; tower fixtures are expanded (replicas share the base id).
  - `portalAt`: structures' portals; `portalsNear(x, z, r, out)`: portals whose trigger footprint is within r (towers, elevators, pits, glitch walls).
  - `propAt(x, z, yaw, maxDist)`: ray vs rotated footprints of `INTERACTABLE_PROPS` in `layout.props` of the loaded chunks.
  - `zoneAt(x, z)` = `cellZone` of the cell (so TOWER/ELEVATOR cells return `STRUCTURE_ZONE` in every storey); `moodAt` = `layout.mood`, NORMAL in TOWER/ELEVATOR cells.
- **Chunk harness** (`harness/chunk.html?seed&s&cx&cz&zone&view&tpc&bake=preview|full`): runs the real worker pipeline for one chunk with an orbit/fly camera, renders it with the MaterialSystem and a minimal post (render only), and sets `__backrooms.ready` when the full bakes are applied. It also exposes `__backrooms.stats()` with triangle and atlas stats.

**Acceptance**
- **`tests/integration/pipeline.test.ts`** (the first-try integration gate).
  - In Node, `handleRequest` runs `init` → `layout`, `build` and `bake` for **50 tiles across all 12 zones** (forceZone rotation), plus the tower and leak test scenes.
  - **Worker boundary simulated:** every response is passed through `structuredClone(res, { transfer })` before the next request, and after each `layout` response a `build` of a tile of the **same chunk** runs on the **same** `HandlerState`; its output must equal a fresh-state build (catches transferred/detached LRU buffers). Also asserts no `transfer` buffer is referenced by `HandlerState`.
  - Every payload passes `validate*`:
    - no NaN;
    - indices in range;
    - lmUv inside the atlas;
    - build chartHash == bake chartHash;
    - texture array lengths = w·h·4;
    - volume sizes;
    - collision prefix sums monotone.
  - Mean full-bake time is logged.
- `tests/stream/priorities.test.ts`: ordering and hysteresis.
- `tests/stream/residency.test.ts`: a pure state-machine test with a fake uploader and a fake worker pool. At most 1 step per frame (+1 prefetch step); evict → dispose next frame; `prefetch` issues layout jobs; `isPrefetched` is false until the 9 layouts are registered; `switchStorey` swaps `query` so `floorAt` in the new storey is finite in the same frame.
- `tests/stream/pool.test.ts`: `reinit` cancels queued jobs, drops in-flight results and resolves after all workers reply; affinity routing prefers the hashed worker.
- **Soak** (WP14 `autowalk` 600 m):
  - `renderer.info.memory.geometries` and `.textures` minus pooled textures stay within resident bounds + 10%; pooled textures ≤ the pool cap;
  - `frameMs.max5s < 50`, including across a tower switch and an elevator ride;
  - `renderer.info.programs.length` is constant;
  - in-flight jobs return to 0 when idle.

**Must NOT touch:** generation, meshing or baking internals; materials; the post stack.

---

### WP11: Lighting runtime, flicker, atmosphere and post-processing

**Goal:**
- flicker that is photosensitivity-safe and shared with audio;
- cross-border flicker uniforms;
- flashlight;
- per-zone atmosphere blending;
- the calibrated post stack: N8AO, auto-exposure, lens, bloom, AgX, grade, SMAA, grain;
- dynamic resolution and frame capture.

**Files:** `src/core/flicker.ts` (implementation only; signatures frozen), `src/lighting/*`, `src/post/*`, `harness/post.html`, `src/harness/post.ts`, `tests/lighting/*`, `tests/post/*`.

**Exported API:**
```ts
// lighting/LightingRuntime.ts
export function createLightingRuntime(scene: THREE.Scene, globals: MaterialGlobals, textures: TextureSet, q: QualityConfig, s: Settings, bus: GameBus): LightingRuntime;
// lighting/atmospheres.ts
export const ATMOSPHERES: Readonly<Record<number, AtmosphereParams>>; // by ZoneId
export const MOOD_MODS: readonly { evShift: number; evMin: number; hazeMul: number; tintMul: [number, number, number] }[]; // by MoodId
// post/PostStack.ts
export function createPostStack(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, q: QualityConfig, s: Settings): PostStack;
// post/DynamicResolution.ts
export function createDynamicResolution(post: PostStack, renderer: THREE.WebGLRenderer, q: QualityConfig): { update(frameMs: number): void; readonly scale: number };
// lighting/anomalyDirector.ts (draws spark bursts into `scene`; never emits 'glitch')
export function createAnomalyDirector(bus: GameBus, lighting: LightingRuntime, scene: THREE.Scene): { update(t: number, dt: number, player: PlayerState, world: WorldQuery): void };
```

**Flicker** (`core/flicker.ts`; pure, t-only, allocation-free):
- **FLICKER (area light `i`).**
  - Epochs of 8 s; `h = hash3(seed, SALT.FLICKER, epoch)`.
  - A burst occurs with p 0.55; burst start `U(0, 6)` s, duration `U(0.3, 2.0)` s.
  - Inside a burst: a slot process with depth `d = U(0.6, 0.95)`.
  - **standard mode:** area changes with depth > 0.2 occur at most every 1/3 s (≤ 3 transitions/s). Between them, micro-flicker with depth ≤ 0.2 in 50 ms slots.
  - Outside bursts: `i = 1 ± 0.5%` slow drift.
  - **reduced:** depth ≤ 0.4, transitions ≤ 2 Hz, no micro-flicker.
  - **off:** `i = flickerMean(FLICKER) = 0.8` constant.
- **DYING (lens shimmer only; area light static in the bake).** `lensShimmer` gives 0.5–2 Hz irregular ±10% plus rare dropouts to 0.6. reduced: ±5%. off: 1.
- **BUZZ.** Shimmer ±3% at 120 Hz aliasing, deterministic.
- **Shimmer twins.** `lensShimmer` (TS) and `LENS_SHIMMER_GLSL` (`brLensShimmer`) are written together by WP11, use only `seed & 255`, and use hash-by-arithmetic that is exact in float32 (no 32-bit integer hashing in GLSL). WP9 injects the GLSL string verbatim.
- **ANOMALY.** Intensity is set externally (`LightingRuntime` overrides per id).
- **`flickerEvents(t0, t1)`:**
  - `strike` when `i` crosses up through 0.5 after ≥ 150 ms below 0.2 (it carries the ballast pitch glide);
  - `tink` for micro drops;
  - `pop` at burst end;
  - `off` when going below 0.05.

  Events must coincide with the edges of `flicker()` sampled at 1 ms (tested).
- **Tests:**
  - determinism and range [0, 1.1];
  - frame-rate independence (sampling at 30/60/144 Hz shows the same edge times ±1 ms);
  - WCAG: in `standard`, a sliding 1 s window over 1e5 s never has > 3 transitions with depth > 0.2;
  - `reduced` constraints;
  - events ⇔ edges.

**LightingRuntime.update:**
1. For each resident tile, fill `bindings.flick.value[k]` in place (9 slots). Evaluate each dynamic light once per frame (cache by id): `color/luma(color)·flicker(...).i` (Rec.709 luma; or the `setOverride` value for ANOMALY lights).
2. Emit `lightToggle` on 0.5 crossings.
3. **Atmosphere** at the camera:
   - target = `ATMOSPHERES[world.zoneAt(eye)]` modified by `MOOD_MODS[world.moodAt(eye)]` (cell-based: stair towers and elevators report `STRUCTURE_ZONE`/NORMAL in every storey, so nothing crossfades at a storey switch), crossfaded over 1.5 s;
   - `camIrradiance` from the player tile's `volA` (the CPU `Uint16Array` via `texture.image.data`, `fromHalf`, trilinear; in TOWER cells y is wrapped like tower props);
   - `farColor = meanIrradiance·hazeAlbedo/π·hazeTint·FAR_WARM` × `FAR_FRACTION` (0.14; `meanIrradiance` = the camera irradiance smoothed over 3 s, `FAR_WARM` = (1.0, 0.9, 0.74)): the streaming edge falls into a warm grey-brown gloom (R2-post);
   - `atmosphere.flashlight` (`FLASH_METER_FOCUS` 0.6 while on: spot metering on the small hot core would crush the spill) and `atmosphere.flickerMode` (0/1/2) are set for the post stack (R2-post, optional fields);
   - `edgeFog = [EDGE_FOG.START, EDGE_FOG.END]·streamRadius·CHUNK_SIZE` (0.55R–0.8R).

   Write `globals.hazeDensity/hazeTint/hazeAlbedo/edgeFog/farColor/flickerMode`, and set `scene.background = farColor`.
4. **Flashlight.**
   - Package F optics: every constant comes from `FLASHLIGHT_OPTICS` (`lighting/flashlightOptics.ts`, the single source for all flashlight consumers): `SpotLight(0xfff4e0, intensity PEAK_CD 5500 cd, distance RANGE 40, angle CONE 0.69 (39.5°), penumbra 0.06, decay 2)`, `map = textures.cookie`; aimed at the view centre 3 m ahead (R2-post). The beam profile I(θ) is a reflector LED torch as a camcorder films it: a softly square, flat-topped hotspot ~9° across at half maximum (`CORE_DEG` 5, exponent 2.2), a faint warm phosphor ring at its edge, a smooth halo into a dim spill (~3 % of the peak, drooping toward the edge) and a soft rim fading between 25° and 37°; no dark ring, lip or hard rim (the wave-1 beam read as a porthole). `beamProfile` in TS, `beamProfileGlsl` in GLSL, ~310 lm, most of it inside 16°; it lives in the cookie, and three's own penumbra ramp lies beyond its rim. The analytic airlight (`BR_AIRLIGHT`) weights its samples by `brBeamSoft`, the smooth twin of the profile.
   - **castShadow = true always.** `shadow.mapSize = q.flashlightShadow`, `shadow.radius = 3`, `shadow.normalBias = 0.02`, `shadow.camera.far = 40` (**equal to `distance`**: outside the shadow frustum three reports "lit", which would light surfaces through walls). `shadow.focus = MAP_FOCUS` (1.1): three looks the cookie up at the normal-biased position, which reads a larger angle than the surface point on near walls; outside the map it skips the cookie, so the map (and the cookie layout) spans the cone plus this margin.
   - Parented to a rig at the eye with offset (0.15, −0.2, 0) and a lagged rotation spring (ω 12). A hand sway (`handSway`: breathing at 0.23 Hz scaled by fatigue, a stride-locked gait swing, a small tremor; < 0.012 rad) moves the aim only; it runs on live frames (0 < dt) and its clock advances only when dt ≤ 0.25, so frozen-time captures never sway.
   - Off: `intensity = 0` and `shadow.autoUpdate = false`. On: `autoUpdate = true`.
   - The light is never removed, so the light count is constant.
   - The renderer uses `PCFShadowMap` (PCFSoft was removed in r186).
5. **Flashlight bounce** (package F, `lighting/FlashlightBounce.ts`, `chunks/bounce.ts`; `QualityConfig.flashlightBounce` 0/1/4/8 VPLs, URL `bounce=0` off).
   - The beam is split into angular bins (4 rays: the core + 3 sectors; 8 rays: an inner (0–16°) and an outer (16–39.5°) sector per quadrant). One `WorldQuery.raycast` per bin along its flux-weighted mean direction finds the lit surface (walls with their thickness, floors, ceilings, SOLID cells, blockers, props, ramps; albedo from `LAYER_DEFS`). Rays become VPL slots through fixed groups (`LAYOUT`, `mergeTargets`: flux-weighted centre, the hits' spread as its size, a shorter mean normal plus an isotropic share `uFbN.w` of the same flux): medium merges the 4 rays into its one VPL (its light lands where the beam's flux does rather than where the axis happens to hit), high keeps 4, ultra merges the upper and the lower pair of each ring into 4 (rays of one ring land at a similar range; pairing a quadrant's inner and outer ray averaged a far core hit with the near spill into one wide VPL metres from both, which left ultra's torch with ~1/6 of high's visible fill) (a VPL costs ~0.07 ms per frame at the 3840 × 2160 ultra buffer); the shader loops over those slots only (`BR_FB_SLOTS`: 1 / 4 / 4 for `BR_BOUNCE_N` 1 / 4 / 8).
   - Each hit becomes a Lambertian VPL 5 cm off the surface: C = bin flux (rendered profile, lm) × light colour × albedo × the bake's multi-bounce gain × three's range window / π. Its patch radius² eps2 = t²·Ω/(π·cos i) (≥ 0.09 m²) softens the fill like a disc source. A flood fill of ≤ 5 steps from the lit cell (doorways and partitions cost 3) gives the room's xz box: an edge passes when the line between the cell centres is clear 1.2 m above the higher of the two floors (stair heads, pit edges) or 0.25 m below the lower ceiling (over partitions and half walls). The shader cuts the fill at the box's walls within their thickness; frozen and hitched frames rebuild the box instead of taking it from the cache, so a capture never uses a box built while a neighbour chunk was still streaming in.
   - Smoothing: position, normal, flux and eps2 follow exponentially (τ 0.08 s) and snap on jumps > 1.5 m, on the first frame and on frozen / hitched frames. Uniforms `uFbP/uFbN/uFbC/uFbBox` (8 each) are camera-relative world (relative to this frame's eye); `uFbOn` gates the whole loop, and reflection passes skip it.
   - Shader: `E += C·max(N·l, 0)·(max(N_k·−l, 0) + iso_k)·(1 − (d/6)⁴)²·box / (d² + eps2)`, added to the diffuse irradiance × `brSsC` after the ambient lines; `view=bounce` shows it (1.0 = 30 lux).
6. **Volumetrics** (package F; `QualityConfig.volumetrics` off/off/high/ultra and `dustMotes` 0/0/3000/6000; URL `vol=0` keeps the analytic haze and hides the motes). The CPU side runs here (the atlas plan, the froxels' atmosphere, the motes' time), the GPU side in the frame graph's afterDepth hooks `lightAtlas` (30) and `volumetrics` (40), which boot registers from `lightingFrameHooks(rt)`.
   - **Light atlas** (`lighting/LightAtlas.ts`): the resident tiles' baked light volumes in one camera-centred toroidal window of 7 × 7 tiles: 3D atlases A (RGBA16F irradiance facing the dominant direction + AO), B (RGBA8 direction + directionality) and C (RGBA16F flicker-channel luminances), 224 × 6 × 224 each, repeat-wrapped in x and z so the atlas coordinate of a world point is `(x / 134.4, lvV(y), z / 134.4)` and trilinear filtering is exact across every tile seam; a 112² R8 mask (the tile's wall bits N1 E2 S4 W8, TOWER 16 for the stair-tower y wrap, VALID 32) and a 16 × 49 RGBA32F table of live flicker colours (per slot, quadrant and channel: the `brChannelSlot` resolution of the tile's `flick` uniforms). `plan()` queues the slots whose tile changed (a new tile, or a preview → full re-upload seen through the textures' versions; a storey switch or a tile leaving clears VALID at once), nearest first; `sync()` copies ≤ 8 tiles per frame with `renderer.copyTextureToTexture` from never-bound wrapper textures (three's CPU `texSubImage3D` path from the retained `image.data` of the pool's 3D volumes) and re-uploads the mask (on change) and the flicker rows. `lightAtlasGlsl()` `brLaSample(rel, E, w, Ld, Ef)` works in vertex and fragment shaders within 56 m of the camera, with the props shader's 0.3 m wall clamp. It returns false outside the 7 × 7 tiles `plan()` keeps around the camera tile (`laInWindow`): beyond them the toroidal wrap would read the slot of a tile 7 tiles away, whose VALID bit passes.
   - **Froxels** (`post/VolumetricFog.ts`): W × H × N over the frustum (high 160 × 90 × 64 to 48 m, ultra 192 × 108 × 80 to 56 m; W follows the aspect), exponential slices from zN 0.5 m, tiled 8 per row into RGBA16F atlases (1280 × 720 / 1536 × 1080). Four passes: **inject** (per froxel: σt = haze + dust + mist; the baked light at the froxel centre `GAIN·σs·[w·E·p(μ) + (2(1 − w)E + Ef)/4π]`, p = the σs-weighted dual Henyey-Greenstein of haze + dust (`lighting/phase.ts`, the zone's forward weight `hazePhase`) and HG(0.75) of mist; the torch over the ray segment through the slice, its inverse square integrated in closed form and two equiangular samples of cookie × cone × window × `sampler2DShadow` visibility (camera-relative shadow matrix in float64; the compare bias is a fixed 2 cm along the light's axis, i.e. `k / w²` in window depth, so shafts are not eroded with distance)), **filter** (a 3 × 3 tent inside each slice from four bilinear taps, which cancels the torch samples' 2 × 2 dither), **scanLocal** (groups of 8 slices folded front to back with the energy-conserving step `S += T·s·(1 − e^(−σD))/σ`, `T *= e^(−σD)`) and **scanCombine** (the earlier groups' totals composed in order). Texel k holds the in-scatter and transmittance from the camera to the slice's far boundary; published as `globals.volTex / volGrid / volZ / volScreen`, with `volZ.w` = 1 only where the atlas holds the camera's own tile (loading, test scenes and the planar mirror keep the analytic haze). No jitter and no history: deterministic under `time=` and without lag for the camera-held torch. `VOL.GAIN` 0.75 keeps the lit zones' mean luminance within 3 % of the analytic haze it replaces (kept by the C.7b grade retune, which thinned the zones' haze and dust instead). `view=volumetric` shows the in-scatter to each surface (1.0 = 8 nits) and its extinction in blue.
   - **Living air** (`lighting/volumetricDensity.ts`): drifting two-octave 3D value-noise dust (2.4 m and 1.2 m lattices, integer-periodic over NOISE_WRAP and 76.8 m vertically, sampled at `rel + (camera + wind·t) mod period` computed in float64), denser near the floor; mist over the ≤ 16 water rects nearest the eye (pool 1, flooded 0.4, film 0 × `mistDensity`), feathered 0.8 m inside the rect, zero below the surface, e-folding every 0.35 m above it and broken into rising wisps. Per zone (`atmospheres.ts VOL_ROWS`): `dustDensity`, `dustNoise`, `mistDensity`, `hazePhase`, `moteDensity`; the mood multiplies the dust (`MOOD_EXTRA.dustMul` 1 / 1.2 / 1.6 / 1.9, capped at 0.03 /m) and a DARK mood shows ≥ 90 % of the motes.
   - **Dust motes** (`lighting/dustMotes.ts`): one `THREE.Points` on `LAYER_LATE` (drawn after the colour pyramid, never in SSR, collapsed in reflection passes), additive HDR, depth-tested against the prepass. Each mote sits at `(fract(seed + (drift − camera mod L)/L) − 0.5)·L` in a 6 m box around the camera (no per-frame CPU work per mote), lit in the vertex shader by the atlas (its lamps' directional light through a strongly forward phase, its diffuse fill at 0.3: a lit room full of bright dots reads as salt noise) with a cross-section calibrated so that a speck in the torch's hotspot reads about as bright as the lit wall and specks in the dim spill fade into the dark and by the shadowed, cookie-shaped torch with occasional glints; each sprite is an energy-conserving gaussian at least as wide as the defocus disc of a small camcorder aperture focused at 2.5 m.

**Initial atmosphere table** (tunable; EV ranges are clamps that keep dark areas dark):

| Zone | hazeDensity | hazeTint | ev100Range | exposureBias | bloom | aoIntensity | grain |
|---|---|---|---|---|---|---|---|
| LOBBY/MAZE | 0.004 / 0.005 | (1.0, 0.93, 0.75) | [4, 11] | +1.35 / +1.2 | 0.5 | 3.0 | 0.8 |
| MANILA | 0.005 | (1.0, 0.95, 0.82) | [4, 11] | +1.0 | 0.5 | 3.0 | 0.8 |
| DARK (zone) | 0.006 | (1.0, 0.93, 0.75) | [6.5, 11] | 0 | 0.5 | 3.0 | 0.8 |
| DARK (mood) | ×1.5 | ×0.8 | [5.5, 10] (evMin 5.5; torch on: 5.0) | ×0.35 | ×1.2 | — | ×1.25 |
| LOW_EXPANSE | 0.006 | (1.0, 0.95, 0.8) | [4, 11] | +1.2 | 0.5 | 2.7 | 0.8 |
| PILLAR_HALL | 0.006 | (0.95, 0.95, 0.9) | [4, 11.5] | +0.8 | 0.45 | 2.7 | 0.7 |
| OFFICE | 0.004 | (0.9, 0.95, 1.0) | [4, 11] | +0.8 | 0.4 | 3.0 | 0.65 |
| POOLROOMS | 0.008 | (0.95, 1.0, 1.0) | [8, 13.5] | +1.6 | 0.6 | 1.5 | 0.45 |
| PARKING/CONCRETE/PIPEWORKS/WAREHOUSE | 0.004 / 0.004 / 0.008 / 0.003 | (1.0, 0.97, 0.9) | [4–5, 11] | +0.15 / +0.25 / +0.15 / +0.2 | 0.3–0.45 | 2.2 | 0.5–0.6 |

(R2-post values, haze and bias retuned in graphics-realism C.7b; see docs/contract-changes/R2-post.md. Non-DARK Level 0 zones floor at EV 4 so an unlit pocket in a NORMAL district reads as a camcorder at max gain, while the SPARSE/DYING/DARK mood floors (6/5.8/5.5) keep dark sectors dark. With the torch on the camcorder meters the beam and may open up `TORCH_EV.DROP` 0.5 EV below the zone × mood floor, never below `TORCH_EV.MIN` 4 (`atmospheres.ts`, applied by LightingRuntime before the landmark floor), so the hotspot and its bounce read as the subject of a dark frame. C.7b halved the froxel air, which read as smoke on high/ultra (WAREHOUSE's dark roof turned grey-brown): dust `dustDensity` LOBBY 0.0012, MANILA/MAZE 0.0015, LOW_EXPANSE/PILLAR_HALL/PARKING/WAREHOUSE 0.002, CONCRETE 0.003, PIPEWORKS 0.006, DARK 0.007 (× the mood's `dustMul`); mist LOW_EXPANSE 0.006, PILLAR_HALL 0.012, PIPEWORKS 0.02, POOLROOMS 0.08; `VOL.GAIN` stays 0.75.)

AO colour for all zones: warm dark (0.12, 0.09, 0.04); retired by the pre-shade SSAO (graphics-realism A.2), whose albedo multi-bounce keeps the hue of occluded corners. `aoIntensity` is now the SSAO exponent on indirect light only, × `POST_TUNING.SSAO_POW_SCALE` 0.8. Every grade has gain (1, 1, 1): emitters clip to pure white. Since C.7b (no halation veil, filmic toe) the grades keep almost no lift, a sensor black `pedestal` of 0.02-0.028 and a toe of 0.5-0.65 with a luma contrast of 1.15-1.46, so deep reveals fall toward black while the mids stay bright. The L0 grade (LOBBY; LOW_EXPANSE with contrast 1.46 / toe 0.65, its open hall has no deep reveals) is the over-exposed sickly yellow: gamma (1.0, 1.08, 0.86), saturation 1.06, contrast 1.38, toe 0.6, pedestal 0.02, at +1.35 EV; MANILA is pale tan-green (gamma (0.97, 1.08, 0.92), saturation 0.88, contrast 1.32); POOL keeps the water's turquoise (saturation 1.06). Measured p5 / p50 of the zone spawn views (imageStats, ultra 1920 × 1080, seed 7, `time=10`, grain off): LOBBY 0.24 / 0.52 (clipped 0.03, hue 43°, sat 0.53), MANILA 0.24 / 0.44, LOW_EXPANSE 0.25 / 0.45, OFFICE 0.22 / 0.43, POOLROOMS 0.33 / 0.54, PARKING 0.17 / 0.36, WAREHOUSE 0.12 / 0.31; the full before / after list is in `atmospheres.ts`.

**PostStack** (pmndrs 6.39.5). `EffectComposer(renderer, { frameBufferType: HalfFloatType, multisampling: 0 })`. The renderer is configured in WP14 with `toneMapping = NoToneMapping` and `outputColorSpace = SRGBColorSpace`. Passes in order:
1. `ScenePass(scene, camera)` (R4, `post/ScenePass.ts` + `materials/prepass.ts`): a depth prepass with the tiles' depth materials (position only, same fade dither / alpha test / reflection props cull, `invariant gl_Position` in both programs), then the shading render with depth writes locked off. Identical output; each visible pixel is shaded once. The water reflection renders the same way. Since graphics-realism A.1 it is the **frame graph**:
   - Order: clear → depth prepass (the flashlight shadow map updates inside it) → `afterDepth` hooks → opaque shading → `ColorPyramid` → `afterOpaque` hooks → MRT composite + depth blit → late render of `LAYER_LATE`. Hooks are `{ name, order, run(ctx) }` added with `addHook(stage, hook)`, sorted by order (afterDepth: ssao 10, hiz 20, lightAtlas 30, volumetrics 40; afterOpaque: ssr 10). `ctx` = `{ renderer, camera, target, depth, width, height, mrt, pyramid, debugView, globals }`; hooks bind their own targets, size them from `ctx`, and read `ctx.depth`, the opaque target's own FloatType depth texture, while it is not bound (the composer's stable copy is filled only after this pass; `needsDepthTexture = true` keeps the composer's depth textures). `renderWithPrepass(renderer, scene, camera, opts?)` takes `afterDepth` / `excludeLayer`; the planar reflection passes none.
   - **MRT frame** (`q.ssr` on, the `ssr` toggle on, no debug view): the opaque view renders into `sceneRT` (3 × RGBA16F + FloatType depth: colour, fallback specular × T with Ws × T, oct view normal + lobe roughness). The colour background clears every attachment inside each render, so attachments 1–2 are zeroed after the prepass and the shading render keeps `autoClearColor` off. Attachment 0 is bilinear (the pyramid's 4-tap box at 0.67 reads it filtered); 1–2 are nearest. `MrtComposite` (`post/frame/MrtComposite.ts`, owned by D) resolves the frame into the input buffer and `blitDepth` copies the depth across: `att0 + att1` where no reflection was traced (an A/B against `ssr=0` up to fp16 rounding), else the screen-space reflection mixed over the fallback by its confidence (below).
   - **Specular G-buffer split** (package D, `chunks/lighting.ts`): on MRT frames a pixel with `brMrtSpec` (the routed lobe's roughness < `SSR.ELIG_ROUGH` 0.7, not an emitter, not submerged, not under a water surface in the wall mask) moves its replaceable specular out of the inline sum: the baked dominant-direction lobe as the difference of `reflectedLight.directSpecular` across the unchanged `RE_Direct` call (so three's sheen and clearcoat terms stay exact) and the environment radiance (the uniform `(1 − w)E/π·brSsK`, mixed toward the reflection probe below). `FRAG_AO_REFL_GLSL` assembles `brFbSpec = env · SS · SO · hor² + lobe` with SS the single-scatter DFG term (dielectric / metal mixed by metalness, × three's sheen energy loss), SO the specular occlusion of the inline terms (baked AO × SSAO × cavity) and `hor = saturate(1 + 1.1·dot(R, N_geom))`; the weight `brWs = luma(SS)·SO·hor²` is what an SSR hit inherits. **Clearcoat pixels** (props with the coat bit: car body and pillar paint, locker enamel; `USE_CLEARCOAT`) route the lacquer instead and keep the base inline: `brFbDir` = the `clearcoatSpecularDirect` difference × clearcoat, `brFbEnv` = the coat's environment, `brWs = luma(EnvironmentBRDF(N_cc, V, 0.04, 1, r_cc))·SO_cc·hor²·clearcoat`, att2 = the coat normal and roughness, so SSR traces the sharp lacquer while three's composition still attenuates the inline base by `1 − clearcoat·Fcc`. Off the G-buffer, `clearcoatRadiance` (which three leaves at 0 because this chunk replaces `lights_fragment_maps`) gets the same coat environment, and the coat's baked lobe is clamped to `DIRECT_MIN_ROUGH` like the base's. `haze.ts` writes the fallback and weight × the haze transmittance and the lobe's normal (`brMrtN`). Level 0 carpet's pile trap no longer darkens a puddle's specular on these pixels. Debug view `specw` (22): r = Ws × 4, g = the routed lobe's roughness, b = the probe's share.
   - **Reflection probe** (package D, `materials/ReflectionProbe.ts`, `lighting/probeBox.ts`, `chunks/probe.ts`; `reflectionProbe` 128 high / 256 ultra, URL `probe=0` off): a cube captured at an anchor at the eye (RGBA32F where float textures filter: `generateMipmap` of an RGBA16F cube overflows to Inf on lamps near HDR_CLAMP on NVIDIA GL; RGBA16F otherwise, and the prefilter drops non-finite samples) (re-anchored after a teleport, seed reset or storey switch, a 2 m move, or when the eye leaves the box; a new anchor's six faces are captured 2 per frame while the previous probe stays published, then switched at once), GGX-prefiltered into K = 5 / 6 mips (level k = roughness k / (K − 1), 32 CPU-generated Hammersley samples with filtered importance sampling into the capture's mips). Each face is one render of the scene (no depth prepass: at 128-256 px it only doubled the main-thread submission; no frame-graph hooks) with the reflection-pass flag (uBrReflPass: far props and water discard; SSAO, contact shadows, POM, detail, the probe itself and the eye-relative flashlight bounce skipped), MRT off, the flashlight at 0, no debug view, layer 0 only (no `LAYER_LATE`), near 0.05 / far 60 m. One face is refreshed every 4th frame round-robin (the rough mips of that face re-filtered; every 2nd frame until the perf pass, which halved the probe's steady main-thread and GPU cost); a tile streaming in or out within 60 m marks every face stale (2 per frame, then every face re-filtered). The room box comes from 12 horizontal `rayDistance` rays at eye height (per axis the median of the three rays within ±30°, so a pillar or a doorway in one of them does not move it; 0.6-40 m), refined so corridors and long halls keep their length: a ±30° ray that meets a side wall of that first guess only bounds its axis from below (one that ran past that wall, out through a doorway or an arch in it, bounds the axis only up to where it crossed the side plane: taking its whole length pushed five of eight boxes surveyed 10-35 m through their far walls, so rooms next door took this anchor's probe at full weight with the wrong parallax, lit-room lamps in a dark neighbour), and the axis itself is the median of three parallel rays (±0.75 m apart, so they pass a pillar but not a 1.2 m doorway); plus the floor under the anchor and the ceiling above it. It is re-estimated every 15 frames. Open-plan halls (POOLROOMS' partial walls with wide gaps) have no single box, and the estimate there is a compromise. Published camera-relative in float64 (`probeMin / Max / Pos`, `probeLod`, `probeOn`). In the surface programs (`BR_PROBE`): influence 1 inside the box fading out 0.25-0.9 m outside it (a room seen through a doorway keeps the legacy fallback), box projection fading to the plain reflection vector with roughness², lightmap normalisation `k = clamp(luma(E_local) / (π·luma(probe roughest mip along N)), 0.15, 1)`, darkening only (a receiver lit more than the anchor does not see a brighter room: the upper clamp of 2 brightened walls near lamps and, wherever the SSR's confidence faded to this fallback, the reflection itself), applied 90 % on rough lobes and on glossy ones at a share growing from 35 % at k = 1 to 90 % at k = 0.15 (a dark, occluded glossy receiver kept 70 % of the anchor's lamps), monotonic in k; the share `brPrW = influence × (1 − smoothstep(0.5, 0.65, r))` fades the baked dominant-direction lobe out and mixes the uniform environment toward the probe radiance, before the G-buffer split, so the probe is the SSR miss fallback; clearcoat lobes take the probe at their own roughness with the full influence. Not in reflection passes (the camera-relative box belongs to the main camera), and not under water (submerged, or a wet floor under a film-water surface in the wall mask: the water mesh reflects the room there, as for the SSR split). Main-thread cost about 0.2-0.3 ms per frame at high (a captured face 0.4-1.3 ms); `gpuProfile` segment `probe`. Debug view `probe` (21): the box-projected, normalised probe as a mirror × its influence, in nits (use `exposure=9.4`); `__backrooms.probe.stats()` / `.faces()`.
   - **Sampler budget swap** (lead decision): under `BR_SSR || BR_PROBE` the surface programs compile out the emission-map reflection (`BR_EM_REFL` in `chunks/common.ts`) and the EMISSION debug view's `uEmission` fetch; SSR and the probe replace it, and `uBrProbe` takes the unit (high / ultra shell 16 together with package F's `uVolTex`). Medium keeps it, and so does the water shader.
   - **Screen-space reflections** (package D, `post/ssr/`, `ssr` half on high / ultra, URL `ssr=0` for the plain path): the afterDepth hook `hiz` (order 20, `HiZ.ts`) builds a half-resolution R32F min device-depth pyramid from the prepass depth (8 levels; each level renders into a scratch target from the level below and is blitted into its mip, so the pyramid is never sampled while attached; the full chain is allocated for completeness), published as `globals.hiZ` / `hiZInfo` = (W/2, H/2, levels, valid). The afterOpaque hook `ssr` (order 10, `SsrTrace.ts`) traces one ray per 2 × 2 block (3 × 3 on ultra's 1.4× buffer: about half the display resolution) from pixels with Ws > 0 below `ssrMaxRoughness` (0.45 / 0.6); each texel stands for its block's lobe (the normals of the block's glossy pixels, 2 × 2 or ultra's 3 × 3, whose roughness lies within 0.15 of the representative's, averaged, their spread widening the cone by Toksvig, so corrugated metal or grout finer than the trace grid does not alias into dots, while a block across a puddle's shore does not blend the mirror with the carpet into a middling lobe that sparkles with the lamps); a block whose normals disagree (1 − |mean| over 0.002–0.02: a normal map finer than the trace grid) is traced along the macro normal (the mean depth normal of the texel and its four neighbours, where they agree with each other (mean length 0.85–0.95) and with the block's mean (cosine 0.7–0.8); one pixel's depth slope at geometry finer than a pixel, a ceiling grid's far T-bars, is no surface, and rays reflected about it sparkled along every far grid line) with that spread kept in the cone, since the mean of a partial rib period changes from block to block and beat against the grid into dashed glints on a corrugated deck beside every high-bay, crawling as the camera moved (the per-pixel Ws still draws the ribs); a ray below the macro surface (fading in over a cosine of 0.03) is not traced (it would copy that surface a cell on; the fallback's horizon term covers it): `ssrGlsl.ts` `brSsrTrace` (shared with the water shader) walks receding rays through the min pyramid (Uludag), marches rays toward the camera linearly (24 steps growing to 16 cells, 5 bisections), accepts a hit 0–(0.15 m + 0.04·z) behind the full-resolution depth whose depth normal (the SSAO's when it ran) faces the ray, and gives up after 10 cells behind a thick occluder. The colour comes from the low-passed pyramid through the lobe's footprint on the hit surface (`brSsrFootprint`): the lobe's edge rays (tan = 1.5 α in the plane of incidence, 1.5 α × N·V across it, since a half-vector tilt out of that plane turns the reflected ray by only 2δ·N·V) are met with the hit's plane (its depth normal; within 0.25-4× the ray length, rays along or away from the plane at 4×) and projected, and one `textureGrad` with those two axes (anisotropy capped at 8) reads the ellipse. That ellipse is centred on the hit, while a plane met obliquely puts the hit far off the footprint's middle, so each axis is at most twice the nearer end's distance (`brSymAxis`); the full length reached past the nearer end onto whatever lay beside the lobe on screen (dashed lamp glints along PILLAR_HALL's T-bars at ultra): glossy floors draw vertical light streaks, and a lamp that is only near the hit on screen, metres behind it, stays out. A second lookup with the microfacet part of α 4× wider (the Toksvig spread of the block's normals unchanged), mixed in at 0.15, stands for GGX's heavy tail: integrated with GGX, a tube lamp over a glossy floor (roughness 0.16-0.25, 1600× the ceiling) keeps a visible streak about twice the core's length, which this mixture matches within ~30 % along the streak. Until September 2026 the footprint was a screen-aligned disc stretched up to 4× along the screen-projected normal over box mips: up to 16× the lobe's area at grazing views, it drew phantom lamp copies in puddles (PARKING), overlong floor streaks and sparkle along tile ceilings and T-bars, most visible in dark rooms. Confidence fades at the screen border (7 %), the roughness cut-off, the last quarter of the 60 m ray, rays toward the camera (R.z 0.25–0.7) and the outer 40 % of the thickness. A metadata attachment (linear depth, normal, roughness) feeds ultra's 3 × 3 bilateral filter (`ssrFilter`, rough > 0.12 only) and the composite's 4-texel bilateral upsample (bilinear × depth × normal⁸ × roughness). Debug: URL `reflView=ssr` (the reflection alone) and `conf` (confidence in grey, misses magenta), through `PostStack.setReflectionDebug`.
   - **Split frame** (`q.colorPyramidScale` > 0, no debug view other than WATER, and an MRT frame or a `LAYER_LATE` mesh whose bounding sphere is in the frustum of a camera that renders that layer, recorded by the prepass): the opaque render leaves `LAYER_LATE` out; `ColorPyramid` (`post/frame/ColorPyramid.ts`: RGBA16F, level 0 at `colorPyramidScale` × the buffer, high 1.0 / ultra 0.67, rgb = opaque HDR before reflections and water clamped to `PYR_MAX` 16000 nits (non-finite texels zeroed), a = linear view depth of the nearest full-resolution texel; 8 levels (`PYR_LEVELS`), each a binomial [1 3 3 1] / 8 low-pass of the level before (`LowPassMips`: 4 bilinear taps 0.75 texels off centre from `textureLod` of level k − 1, fp32 in the shader, into a scratch target of level k's own size, then blitted into level k, as the Hi-Z does; `TEXTURE_MAX_LEVEL` 7 since the coarser levels are not allocated; one scratch per level, together a third of level 0: a single level-1-sized scratch loaded and stored its whole attachment for every level, 0.1-0.2 ms at ultra). The water mirror (`PlanarReflection`) builds its 9 levels the same way. `generateMipmap`'s 2 × 2 box drew 8-32 px staircase blocks in the SSR's anisotropic lookups of lamps, and some drivers sum its blocks in half precision (Inf mips on lamps near HDR_CLAMP)) is published as `globals.sceneColor` / `sceneInvSize` and `ctx.pyramid`; then `LAYER_LATE` draws alone into the input buffer with the shading render's state (no clears, shadow auto-update off; depth writes follow each material: the refracting water writes its surface, sparks and motes do not), in the order the single render would use. `globals.waterVolOn` is 1 from the depth hooks to the end of the late render. Low and medium never split and never use MRT; a switch to them frees the pyramid's target and resets `sceneColor` to null.
   - `gpuProfile` times each hook, `pyramid`, `mrtComposite` and `late` as their own segments; `RenderPass` is then the prepass plus the opaque shading.
2. **Pre-shade SSAO** (graphics-realism A.2; `post/AmbientOcclusionPass.ts` `SsaoPre`, the afterDepth hook `ssao`; R4 replaced `N8AOPostPass`, see docs/contract-changes/R4-render-perf.md).
   - N8AO's estimator: `radius = 0.7`, `distanceFalloff = 0.6` (R2-post). Half resolution (`q.aoHalfRes`), 8 / 10 / 12 / 16 samples for `q.ao` Performance / Low / Medium / High, 4 × 4 interleaved rotations, a separable 5-tap bilateral denoise that filters `.r` and copies the view depth and normal (`.gba`). Never renders the scene. `enabled = q.ao !== 'off'` and the `ao` toggle.
   - Output `aoRT` (r AO, g view Z, ba oct view normal) is published as `globals.ssaoTex` with `ssaoParams` = (on, `aoIntensity × 0.8`, tangent-plane falloff 0.084 m, texel step), `ssaoProj` = (P00, P11, P20, P21) and `ssaoSize`.
   - The surface shader (`chunks/screenspace.ts` `brSsao`, gated by `BR_SSAO`, `uSsaoP.x` and not the reflection pass) upsamples it at the exact fragment (`geometryPosition`, `brNg`: bilinear × tangent-plane distance × normal agreement⁸, a 4 × 4 fallback, 1 on slivers), takes `brSs = ao^pow`, keeps only the part the bake has not already applied (`brSsK = min(1, brSs / brAO)`) and applies it to indirect light only: `iblIrradiance` with the Jimenez albedo multi-bounce `brSsC`, `radiance` and the specular occlusion with `brSsK`, the flicker channels at half strength. Direct light, emitters, haze and water are no longer darkened, and yellow corners keep their colour.
   - **Contact shadows** (A.3, `contactShadowSteps` 0/0/8/8, URL `cs=0`): `brContactShadow` marches from the fragment towards the baked dominant light direction over 0.35 m (growing 2 %/m) through the half-res view depth; a hit 0.6 %·z–0.30 m behind the depth buffer (tested against the AO texel whose representative pixel lies nearest to the sample) shadows the baked directional term (`brDirVis`) by up to 0.9 × (1 − t)², the area-light penumbra, times the share of three samples (the hit, half a step and a step past it) still behind the occluder: an area light swallows a thin occluder's shadow, and a lounger axle that the dithered steps hit on only some pixels no longer draws hard hit / miss hatching. The jitter is stratified within each 2 × 2 pixel quad (offsets u + k/4, u from the quad's IGN) and the march runs in uniform control flow, so the quad averages its four marches through `dFdx` / `dFdy` (`brQuadMean`; the pixel's side of each pair comes from the derivative of its coordinate parity, and where the derivatives are coarse, as AMD's Mesa drivers make a plain `dFdx`, a probe detects it and the per-pixel value stays): the residual hatching of armrests over seats becomes a smooth partial shadow without history or a noise texture; it fades over 10–20 m and with low directionality. The flicker channels and the flashlight (a real shadow map) are not affected. Debug view `ssao`: the SSAO in grey, contact shadows in red.
   - A quality change that alters `q.ao` or `q.aoHalfRes` builds a new helper and disposes the old one including its quad materials (R2-post), so the program count does not ratchet across preset cycles; boot keeps a new helper off until its programs are linked.
3. **`AutoExposurePass`** (custom `Pass`, `needsSwap = false`):
   - Render centre-weighted `log2(max(lum, 1e-4))` (narrowing toward a spot meter while the flashlight is on) of the input buffer into a 64×64 `HalfFloat` target with mipmaps. Per-pixel luminance is clamped at `2^(currentEV100 + 3)`·k so lenses do not dominate.
   - Read the 1×1 mip in a shader into a 1×1 **RGBA8** target (packed 16-bit value).
   - `readRenderTargetPixelsAsync` (RGBA8/UnsignedByte, as verified). At most one read in flight, every 2nd frame.
   - CPU: `EV100 = avgLog2 + log2(100/12.5)`, clamped to the atmosphere `ev100Range`. Adapt with a critically-damped spring with asymmetric τ (0.6 s toward brighter, 2.5 s toward darker, ζ 0.8, so it hunts slightly like a camcorder).
   - `exposure = 1 / (1.2·2^(EV100 − bias − settings.brightnessEV))`.
   - `snapExposure()` sets it immediately. `setExposureLock(ev)` pins it.
4. **`EffectPass(camera, motionBlur, glare, exposure, toneMapping, grade)`** (package C; the old `BloomEffect` and the R2-post halation veil are gone).
   - `MotionBlurEffect` (`CONVOLUTION | DEPTH`, sorted first; reads the composer's depth texture): HDR camera motion blur. Per pixel the previous-frame uv comes from depth and `prevViewProj · inverse(viewProj)`; the blur vector is that displacement × shutter / frame dt (dt clamped to [1/240, 1/10] s), clamped to 0.045·H px, integrated with `q.motionBlurTaps` taps (0/6/8/10) along a centred, IGN-dithered shutter. Camcorder shutter = mix(1/60, 1/30, low-light factor) × `film.motionBlur` (the Comfort-tab slider; 0 = off). Cuts (a jump > 1 m, a turn > 30°, dt > 0.1 s, `snapExposure()`, pause) skip the blur for a frame; a static camera reprojects exactly onto itself, so frozen-time captures are a bit-exact pass-through. The effect exposes the camera's angular velocity (rolling shutter) and its reprojection (the glare prefilter).
   - `GlareEffect`: energy-conserving lens glare, `out = in·(1 − k) + U0·k`, `k = GLARE.K (0.2)·atm.bloomIntensity` (LOBBY 10 %): nothing is thresholded, so light moves instead of being added and dark corners keep their black. The PSF is angular (`post/glareMath.ts`: Gaussian core 0.14° holding 35 % + a `(1 + θ/0.23°)^−2.6` tail; violet near the source, warm far out), so the glow has the same size at every preset and render scale. `GlareChain`: a 13-tap downsample of the full-res nits into `q.bloomLevels` half-res-and-down RGBA16F levels (each tap clamped to 256 exposed units; while the camera moves the first level integrates along the motion-blur path so the glow smears with the image), then a tent up chain adding `w_i·D_i` with the PSF's band weights (sum 1). High/ultra (`glareStreaks`) add a 2-blade-iris aperture star: two ±45° axes × three cascaded 7-tap passes over the part of D1 (D2 on buffers taller than 1500 px, so the arms keep their on-screen width and the cost stays flat) above 12 exposed units, weighted toward compact sources (the hot part of the level three steps coarser tells a bulb or a distant highbay from a near tube strip, whose broad X would stain the ceiling), steps scaled by `(height / 1080) / 2^(level − 1)` so the arms keep one on-screen length at every buffer height and dynamic-resolution scale, wavelength-scaled R/B in the last pass, gain 0.004. Ultra (`glareGhosts`) adds five faint coating-tinted ghosts mirrored/scaled through the frame centre from the next chain levels (gain 0.001, area-normalised). Both are folded into the last up pass, so the full-res composite reads one texture; they scale with `film.flare` and switch off with `lens=0`. Calibrated by `harness/post.html?scene=psf` (energy within 3 %, encircled energy at 0.5/2/8° within 20 % of the target).
   - `ExposureEffect`: custom multiply by `exposure`, after the glare, so the glare is exposed with the image. It also applies the cos⁴ optical vignette in HDR, before the clip, so emitters at the frame edge stay white.
   - `ToneMappingEffect({ mode: ToneMappingMode.AGX })`.
   - `ColorGradeEffect`: custom. Converts to sRGB-encoded space, applies temperature/tint, lift/gamma/gain, a filmic toe (`e = mix(e, e²·1.12/(e + 0.12), toe)`: deep shadows fall toward the pedestal, mids and white stay; package C.7), split-tone (fading to neutral above luma 0.85), saturation (shadow desaturation ramp to luma 0.65), a sensor knee (channels bleach toward their max above 0.8), contrast and the black `pedestal`, then converts back. The zone grades were retuned (C.7b) with every graphics-realism package merged; see the atmosphere table above.
5. `EffectPass(camera, q.aa === 'smaa' ? new SMAAEffect({ preset }) : new FXAAEffect())`: a CONVOLUTION effect, alone in its pass.
6. **`EffectPass(camera, lens, FilmGrainEffect)`** with **`dithering = true`**. The lens is the only CONVOLUTION effect in the pass and grain has no `mainUv`, so they merge; distortion, CA and vignette now apply to the finished image (bloom included), and SMAA saw undistorted edges.
   - `LensEffect`: custom, `EffectAttribute.CONVOLUTION`, **no `mainUv`**. Samples `inputBuffer` at barrel-distorted uv (k −0.02·`film.distortion`), spectral lateral chromatic aberration (1.5 px at the corners·`film.chromaticAberration`; five full-RGB taps at [−1, −0.5, 0, 0.5, 1]× the CA scale with per-channel weights R [0, 0, .1, .35, .55], G [.05, .2, .5, .2, .05], B [.55, .35, .1, 0, 0], so fringes grade purple-green-yellow instead of hard cyan/orange lines), in camcorder mode a CMOS rolling-shutter skew (`st += uRS·(st.y − 0.5)`, uRS from the camera's angular velocity × a 12.5 ms readout; zero on cuts and pause), a lens MTF blur (6-tap ring, 0.6 px centre → 1.4 px corners, 70 % mix) followed by a mild camcorder detail unsharp (0.25), and a glitch displacement uniform. Camcorder mode adds a faint vertical CCD smear through clipped emitters and a slow fluorescent beat band (≤ 2.5 %, halved for flicker Reduced, off for Off). (The vignette moved to `ExposureEffect`.)
   - Luminance-dependent grain, `σ ∝ grain·sqrt(sceneExposure/exposure_ref)` × a low-light gain boost below EV 6.5 (sensor AGC), so dark footage gets noisier; the luma noise is spatially correlated (1.5 px lattice) and chroma noise grows in the deep shadows; the noise sits around the black pedestal with a soft floor.
   - Grain frame index = `floor(t·24)` from the **simulation** time passed to `render(realDt, t)` (deterministic under `time=`); glitch and camcorder noise also use `t`.
   - Camcorder mode (off by default): chroma bleed, faint interlace, a head-switch noise band, and a DOM REC overlay drawn by WP14.

**Capture** (`capture(w, h)`, used by imageStats): on the next frame the last pass renders to an RGBA8 target, which is blitted to the screen and downsampled into a w×h RGBA8 target, then read with `readRenderTargetPixelsAsync`.

**Dynamic resolution:** if frame-time p95 over 2 s > 18 ms, scale −0.1 (min 0.6); if < 12 ms, +0.05 (max = preset `renderScale`). Applied with `renderer.setPixelRatio` and `composer.setSize`.

**Anomaly director** (small, visual and audio events only; it never emits `glitch`, which is reserved for traversal; WP14 wires `glitch` → `post.glitch`):
- `AnomalyKind.SPARKING` sites (from `layout.anomalies` within 20 m): bursts at Poisson λ 1/8 s. Each burst emits `spark {x, y, z, strength}` and draws a small additive particle burst (`sparks.ts`: one permanent mesh added at construction, `drawRange` 0 while idle, 24 quads, `transparent = false`, `AdditiveBlending`, `depthWrite = false`, `renderOrder = 2`, HDR clamp) whose HDR quads (≈ 20,000 nits for 60 ms) bloom into a brief flash (no post glitch). If a dynamic light is within 2 m, it also dips via `lighting.setOverride(id, 0.2)` for the burst.
- "Light dies ahead": with p 1/600 s in DYING/DARK moods, the nearest visible dynamic light goes ANOMALY → 0 over 2 s (`setOverride`), then recovers after 20 s (`setOverride(id, null)`).

**Post harness** (`harness/post.html?scene=panels|dark|psf&preset=high`): a synthetic room (MeshStandardMaterial walls plus emissive 3300-nit panels plus the flashlight) through the real PostStack. Its stock materials carry colorWrite-off depth twins (`userData.brDepth`) so the scene pass's depth prepass keeps their occlusion. `scene=psf` is a black frame with one 3×3 px 20,000-nit source for the glare calibration (`ev=`/`px=`/`src=` change the picture only).

**Acceptance**
- The flicker tests above.
- `tests/post/effects.test.ts`: constructing the EffectPasses with the real pmndrs classes in Node is not possible (needs WebGL), so the harness verifies instead. Assert the effect list order and attributes statically: the lens is CONVOLUTION without `mainUv`; SMAA/FXAA sit alone.
- The harness page renders with no console errors.
- `imageStats` on `scene=panels`: clipped fraction < 3% outside the panels; panels glow (ring luma with glare > 1.25 × without).
- `scene=psf`: the glare's U0 energy matches the source within 3 %; encircled energy at 0.5 / 2 / 8° within 20 % of `glareEE`.
- **AO:** harness `stats()` reports the draw calls with AO on minus off ≤ 3 (R4: the AO pass never renders the scene).
- With `time=10`, two captures are identical (grain deterministic from `t`).
- `harness/post.html?scene=shimmer`: a quad array rendering `brLensShimmer` for 16 seeds × 8 times matches `lensShimmer` within 1e-2 (readback).
- The flashlight never lights a surface behind a wall (harness `scene=dark`: a lit wall 20 m away behind an occluder stays dark).

**Must NOT touch:** material shader chunks (WP9; read the globals only), streaming.


---

### WP12: Player (controller, collision, feel, traversal)

**Goal:** a smooth, grounded walking-sim controller:
- robust collision that never tunnels or sticks;
- stairs and ramps;
- head bob locked to footsteps;
- invisible tower switches;
- the elevator ride;
- glitch walls;
- an autopilot for the title attract mode and autowalk.

**Files:** `src/player/*`, `tests/player/*`.

**Exported API:**
```ts
// player/collisionBuild.ts (PURE, runs in the worker via handleRequest)
export function buildChunkCollision(l: ChunkLayout): ChunkCollision;
// player/controller.ts (PURE)
export interface ControllerConfig { walk: number; sprint: number; sprintTired: number; crouch: number; kAccel: number; kDecel: number; kSprint: number }
export const DEFAULT_CONTROLLER: ControllerConfig; // 1.45, 3.2, 2.4, 0.75, 10, 12, 6
export function stepPlayer(s: PlayerState, i: PlayerInput, dt: number, w: CollisionWorld, cfg: ControllerConfig, emit: Emit, sensitivity: number, invertY: boolean): void;
// player/collision.ts (PURE)
export function moveAndCollide(w: CollisionWorld, s: PlayerState, dx: number, dz: number, height: number, scratch: Float32Array): void;
// player/headBob.ts (PURE)
export interface BobState { phase: number; amp: number; landing: number; landingV: number; eyeY: number; eyeV: number; roll: number; breath: number }
export function updateBob(b: BobState, s: PlayerState, dt: number, headBob: number): { dx: number; dy: number; roll: number; pitch: number };
// player/PlayerSystem.ts
export interface TraversalHost {
  prefetch(s: StoreyId, x: number, z: number, radiusChunks: number): void;
  isPrefetched(s: StoreyId, x: number, z: number): boolean; // -> WorldStreamer.isPrefetched
  switchStorey(to: StoreyId): void;
  findSafeSpawn(s: StoreyId, x: number, z: number): Promise<SpawnPoint | null>; // -> streamer.findNearest('safe', {s,x,z}, 4)
  attachDynamicMesh(tileKey: string, m: MeshBuffers): DynamicMeshHandle | null; // -> WorldStreamer.attachDynamicMesh
}
export function createPlayerSystem(spawn: SpawnPoint, settings: Settings, bus: GameBus, host: TraversalHost): PlayerSystem;
// player/input.ts
export function createInput(canvas: HTMLCanvasElement, settings: Settings): InputSource;
// player/autopilot.ts
export interface Autopilot { next(s: PlayerState, w: WorldQuery, out: PlayerInput): void; setTarget(x: number, z: number): void }
export function createAutopilot(seed: number): Autopilot; // wanders: prefers long sightlines, avoids dead ends, speed 0.6-1.2 m/s
```

**Collision build** (per chunk, chunk-local):
- Boxes from `edgePieces` (pieces with `EDGE_COLLIDES`; thickness `edgeThickness`), posts, SOLID cells (floor..ceil), `blockCm` boxes, and `expandPeriodicSolids` boxes with COLLIDE (ramps go to `ramps`; WALKABLE_TOP is flagged).
- Props: PROP_DEFS footprints with `collide`, yaw snapped to 90°.
- Deep water edges (NOWALK cells) become virtual boxes, flagged `SolidFlag.VIRTUAL` like the pit catch floor under VOID cells and collide-only (not RENDER) solids: nothing is rendered there, so `WorldQuery.raycast` skips them (the flashlight bounce lights the pool floor and walls, not an invisible wall at the pool edge). Risers and soffits stay visible to rays: their faces toward a lower floor or a higher ceiling are the rendered step and bulkhead faces.
- GLITCH edges produce boxes like WALL (`EDGE_COLLIDES[GLITCH]` is true).
- Duplicate solids from neighbouring chunks (core `addSolid` rule) are harmless: each chunk's collision is queried independently.
- `cellBoxes` lists boxes whose footprint, expanded by `PLAYER.radius`, overlaps each cell.

**Controller** (fixed 120 Hz sub-steps with interpolation in PlayerSystem):
- **Velocity.** `v += (target − v)(1 − e^(−k·dt))`, with k = kAccel when speeding up, kDecel when stopping, kSprint when entering a sprint.
- **Movement modifiers.**
  - Wading: `speed × (1 − 0.6·min(depth/1.0, 1))`.
  - Crouch: a 0.22 s smoothstep; standing up is blocked if `ceilingAt < y + height`. **Crouching is blocked while `waterDepth > PLAYER.crouchEye − 0.15`** (the camera never goes under the water surface; there is no underwater rendering).
- **Sprint fatigue.** After 10 s of continuous sprint, speed decays to `sprintTired` over 5 s. It recovers at 2× the rate while walking. There is no bar: `fatigue` drives the breath events.
- **Collision** (`moveAndCollide`).
  - Sub-steps of at most 0.1 m of motion.
  - The player is an XZ circle of r = 0.28. A box blocks if its y-range overlaps `[feet + stepMax, head]`.
  - 3 push-out iterations along the minimum translation vector; the into-wall velocity component is removed (sliding).
  - `floorAt(x, z, feetY)` covers the cell floor, WALKABLE_TOP boxes and ramps (multi-level towers). `ceilingAt` covers an open flight's underside (0.2 m under its walking surface) and, for a FILLED ramp, the whole body under its walking surface (nobody walks or crouches under masonry steps).
  - Step-up ≤ 0.36 m. Drops > 0.05 m apply gravity; a landing emits `land`.
  - **Unloaded cells count as solid.** `floorAt` returns NaN → the player is blocked.
- **Unstuck.** If the player is inside a collision box for > 0.5 s, move them to the nearest walkable cell centre (spiral search, 3 cells).
- **`fly=1`.** Noclip flight at 4 m/s, with vertical movement on Space and C.

**Feel** (`headBob`), numbers from the atmosphere proposal:
- **Stride.** 0.74 m walking, 1.12 m sprinting, 0.52 m crouching. `stridePhase += distance/stride`.
- **Bob shape.**
  - Vertical: `A_v·(sin(π·frac) − 0.637)`, which is zero-mean and lowest at heel strike.
  - Lateral: `A_l·sin(π(step + frac))`, alternating per step.
  - Roll: `R·lateral/A_l`.

  | Gait | A_v | A_l | R |
  |---|---|---|---|
  | walk | 0.028 | 0.018 | 0.4° |
  | sprint | 0.05 | 0.03 | 0.8° |
  | crouch | 0.012 | — | — |

  Amplitude eases (τ 0.15 s) and is scaled by `settings.headBob`.
- **Footsteps.** A `footstep` fires each time `stridePhase` crosses an integer, which is the camera's lowest point. A soft `settle` footstep fires when stopping from > 0.8 m/s.
- **Idle and turning.** Idle breathing: 0.004 m at 0.23 Hz plus 0.12° pitch. Strafe lean 0.6°. Yaw-rate roll ≤ 0.5°.
- **Landing.** A spring dip `min(0.12, 0.03·v_impact)` with k 90, c 14.
- **Stairs.** Camera y follows a critically damped spring (ω = 18).
- **FOV.** Sprint adds up to +3° (τ 0.4 s).
- **Camcorder mode.** Handheld noise: 3-octave value noise at 0.4–1.2 Hz, amplitude 0.2–0.3° (×1.8 while sprinting).

**Input.**
- Pointer lock uses `requestPointerLock({ unadjustedMovement: true })`, with a fallback if unsupported.
- Keys: WASD/arrows move, Shift sprint (hold or toggle), C/Ctrl crouch, F flashlight, E interact, Esc pause, F3 overlay, F4 cycle debug view.
- Gamepad: left stick moves; right stick looks with expo 1.6.
- With `autostart`, the look works without pointer lock.

**Traversal.**
- **Proximity.** Every 0.25 s, `world.portalsNear(x, z, 12, scratch)` (CollisionWorld) lists nearby tower/elevator/pit/glitch portals; this drives prefetching.
- **Tower** (`traversal/tower.ts`).
  - When the feet are inside a tower portal footprint and the portal's y-range, check the switch rule (§2.4) after every sub-step.
  - On a switch: `host.switchStorey(target)` (unless `endless`), `s.y ∓= 3.0`, and snap the camera interpolation (no bob pop).
  - Emits `storeyChanged` and `transition{phase: 'switch'}`.
  - **Prefetch policy.** Within 12 m of a tower: `host.prefetch((s+1)%3, towerX, towerZ, 1)` (down, the common direction). Inside the footprint with `feetY > +0.3` or moving upward on lane B: also `host.prefetch((s+2)%3, …, 1)`. Calls repeat every 0.25 s as keep-alive.
  - If `!host.isPrefetched(target, x, z)` at the switch point, **clamp** the player at feet ∓1.59 (the step is invisible) until it is. The streamer query of the target storey (layouts + collision) is loaded by then, so `floorAt` after the switch is finite.
- **Elevator** (`traversal/elevator.ts`).
  1. On entering the lobby strip: `host.prefetch(target, x, z, 1)`, `target = (s+1)%3`, or `(s+2)%3` if the portal spec has `wrong`.
  2. Standing in the cab for 2 s: `transition{phase: 'doorsClosing'}`; doors close over 1.5 s. The 2 door leaves are built by WP12 with WP6's `emitProp(ELEVATOR_DOOR)` into a `GeometryWriter` and shown with `host.attachDynamicMesh(tileKey, mesh)` (the tile's props material); `setOffset` animates them. Their collision is 2 **virtual boxes** inside WP12's collision step (never static layout props).
  3. `transition{phase: 'ride'}` for 6 s: ±0.2° camera shake (WP13 plays motor, cable rumble and a ding from the transition phases).
  4. At 3 s, when `host.isPrefetched(target, …)` (the ride extends until it is), `switchStorey(target)`; the player stays at the same xz (the cab is identical in every storey).
  5. `transition{phase: 'doorsOpening'}`; doors open.
- **Glitch** (`traversal/glitch.ts`). While the feet are inside a `'glitch'` portal volume (`portalAt`), accumulate push time whenever the move input points into the edge (`dot(inputDir, intoWall) > 0.5`) and the collision response removes ≥ 80% of the motion; reset otherwise. At 1.2 s:
  1. `bus.emit('glitch', {seconds: 0.8, strength: 1})` (the only `glitch` producer).
  2. `host.findSafeSpawn((s+1)%3, x, z)`.
  3. `host.prefetch`, wait until `isPrefetched` (the glitch holds the screen), then teleport.
- **Pit** (`traversal/pit.ts`). VOID cells have no floor: the player falls. Inside a `'pit'` portal with feet below −1.5 m: emit `glitch {seconds: 1.2, strength: 0.6}` (screen holds dark), then the same find-safe-spawn/prefetch/teleport sequence as the glitch into `(s+1)%3`, with `storeyChanged {via: 'pit'}`.
- **Interact** (`interact.ts`). Each frame `state.target = world.propAt(x, z, yaw, 1.6)?.kind ?? −1` (also requires |pitch| < 0.6). On `interactPressed`: emit `interact {propKind, x, y, z, yaw, seed}` (propKind −1 if nothing).

**Acceptance (vitest, synthetic `CollisionWorld` built from `layoutFromAscii` + `buildChunkCollision`):**
- **Walls.** No tunnelling at 20 m/s into a 0.15 m wall. The player stops at `radius` from the wall face ±1 mm and slides along walls at 45°.
- **Steps.** Steps up 0.30 but not 0.45. Walks the tower from end0 y=0 down to the next storey: exactly one switch and y continuity ±1 cm; walking back up switches back with no thrashing (hysteresis).
- **Crouch.** Blocked under a 1.5 m ceiling.
- **Cadence.** Footsteps at a steady 1.45 m/s occur at 1.96 Hz ±2%, and each footstep coincides with the bob minimum (±1 frame).
- **Unloaded chunk.** Walking into an unloaded chunk is blocked.
- **Glitch.** Pushing into a GLITCH edge never passes through it; 1.2 s of push inside the portal triggers exactly one `glitch` event.
- **Water.** Crouch is refused at depth 0.9 m.
- **Unstuck.** Recovers within 1 s.

**Must NOT touch:** streamer internals (use `TraversalHost`), audio, rendering.

---

### WP13: Audio (fully synthesized)

**Goal:**
- Spatial fluorescent hum that bends around doorways.
- Footsteps per surface, locked to the bob.
- Room-accurate reverb.
- Flicker transients sample-aligned with the visuals.
- Dead sectors fall silent.
- Rare, gated dread events; no stingers.

**Files:** `src/audio/*`, `tests/audio/*`.

**Exported API:**
```ts
export function createAudioSystem(bus: GameBus, settings: Settings, q: QualityConfig): AudioSystem;
// pure DSP (src/audio/dsp/*), all return Float32Array channels and take an explicit seed
export function synthHum(variant: number, sampleRate: number, mainsHz: 50 | 60, seconds: number): Float32Array[];
export function synthFootstep(surface: SurfaceSoundId, variant: number, sampleRate: number): Float32Array[];
export function synthFixture(kind: 'tink' | 'strike' | 'pop' | 'off', variant: number, sampleRate: number): Float32Array[];
export function makeIR(rt60: number, dims: [number, number, number], brightness: number, sampleRate: number, seed: number): Float32Array[];
export type BedKind = 'roomTone' | 'hvac' | 'water' | 'pump' | 'drone' | 'breath' | 'officeHvac' | 'fanDrone' | 'roofCreaks' | 'wade';
export function synthBed(kind: BedKind, sampleRate: number, seconds: number, seed: number): Float32Array[];
/** Loopable source for every EmitterKind (DRIP, VENT, PIPE, MACHINE, WATER, STEAM, RADIO, PHONE, BUZZ). */
export function synthEmitter(kind: EmitterKindId, variant: number, sampleRate: number, seconds: number): Float32Array[];
export type OneShotKind =
  | 'doorThud' | 'chairScrape' | 'tileCreak' | 'ballastPop' | 'damperClunk' // L0
  | 'pipeKnock' | 'metalGroan' | 'pumpCycle' | 'chainRattle' // industrial
  | 'dripPlink' | 'drainGurgle' | 'filterPump' // pools
  | 'elevatorMotor' | 'elevatorDing' | 'cableRumble' | 'flashlightClick' | 'doorRattle' | 'phonePickup' | 'radioClick' | 'sparkCrackle';
export function synthOneShot(kind: OneShotKind, variant: number, sampleRate: number): Float32Array[];
// pure helpers
export function propagate(grid: PropagationGrid, listener: [number, number], radius: number, out: PropagationField): void; // Dijkstra
export function sabineRT60(volume: number, surface: number, alpha: number): number;
export interface PropagationGrid { walkable(gi: number, gj: number): boolean; edge(axis: 'x' | 'z', gi: number, gj: number): number }
export interface PropagationField { dist: Float32Array; prev: Int32Array; bends: Uint8Array; size: number; gi0: number; gj0: number }
```

**Graph.**
```
voice: src → gain → BiquadFilter(lowpass, occlusion) → Panner(HRTF on q.hrtf else equalpower; inverse, ref 1.5) → bus
buses: hum, water, amb, foot, foley, sfx, ui(dry)
bus → master; bus → send(g_wet) → preDelay(Delay) → [ConvolverA ⨯fade⨯ ConvolverB] → EQ(low/high shelf) → master
master → DynamicsCompressor(−18 dB, 3:1) → limiter(−1 dBTP) → destination
```
The `AudioContext` is 48 kHz, created on Enter (or immediately with `autostart`; headless runs with an autoplay flag). `noaudio=1` skips audio entirely. The buffer DSP runs at start (≤ 300 ms, chunked with `await` yields).

**DSP recipes.**
- **Hum.** 4 variants, 6 s seamless loops (720 cycles):
  - fundamental 2×mains;
  - harmonics to 1.2 kHz at amplitude n^−1.2;
  - ballast buzz: a 2–6 kHz noise band amplitude-modulated at 2×mains;
  - slow AM (0.2–0.8 Hz, 10%).
- **Fixture sounds.**
  - `tink`: 3 ms click plus a 4 kHz ring.
  - `strike`: thump, zap, then hum onset with a **0.97 → 1.0 pitch glide over 0.3 s**.
  - `pop`: a louder click with a fizz tail.
- **Footsteps.** 8 variants per surface; each is a heel hit plus a toe hit 35–70 ms later.
- **Emitters** (`synthEmitter`, all loopable): DRIP = sparse plinks (Poisson, pitched 1.5–3 kHz with a long tail); VENT = band-limited noise with slow LFO; PIPE = low hum + irregular ticks; MACHINE = 50/60 Hz harmonics + fan noise; WATER = lapping (filtered noise bursts); STEAM = hiss bursts with pressure envelope; RADIO = synthesized muzak chords through a 300–3k band-pass + crackle; PHONE = 2-tone ring cadence (UK/US by mains setting); BUZZ = ballast buzz (2×mains harmonics, gated).
- **One-shots** (`synthOneShot`): door thud (body + room tail), chair scrape (friction noise glide), ceiling-tile creak, distant ballast pop, HVAC damper clunk; modal pipe knock, slow pitch-bent metal groan, pump start/stop, chain rattle; long-tail drip plink, drain gurgle, filter-pump cycling; elevator motor, ding, cable rumble; flashlight click; door rattle; phone pick-up (click + line hiss); radio click-off; spark crackle.

| Surface | Recipe |
|---|---|
| carpet | 900 Hz LP noise + 80 Hz thump + −24 dB fibre fizz |
| carpetWet | carpet + 600→1200 Hz band-pass squelch + bubble chirps |
| concrete | 3 kHz click + 180 Hz body + grit |
| tile | concrete + Q8 ring at 2.2–3.4 kHz |
| metal | 6-mode modal synthesis |
| grate | metal + rattle |
| waterShallow | splash plus bubbles |
| waterDeep | 400 Hz slosh |
| stair | hollow 120 Hz |
| vinyl, wood | variants of the above |

- **IRs.** 6 impulse responses, RT60 ∈ {0.3, 0.6, 1.0, 1.6, 2.5, 4.0} s:
  - early reflections: 12–24 image-source taps from `dims`, gain ∝ 1/t;
  - late tail: noise × `exp(−6.91t/RT60_band)` in 3 bands (the high-band multiplier comes from `brightness`);
  - 10–30 ms fade-in; stereo decorrelated.

**Runtime systems.**
- **Propagation (5 Hz).**
  - Dijkstra over the resident passability grid within 24 cells of the listener. Edge cost is 1 cell over `EDGE_SOUND > 0` edges between walkable cells.
  - For each source:
    - **Line of sight** (`losClear`): true position, no filter.
    - **Reachable but occluded:** walk back along `prev` to the first cell the listener can see (the portal). Place the apparent source at `listener + dir(portal)·pathDist`. Low-pass `f_c = 20000·e^(−0.35·(path − euclid))` (min 500 Hz), −3 dB per bend.
    - **Unreachable:** the true position with a 300 Hz low-pass and −18 dB (heard through the wall).
- **Hum voices** (reallocated at 10 Hz, `q.humVoices` voices).
  - Candidates are ON/BUZZ/DYING/dynamic fixtures with path distance ≤ 18 m. Score = `level·hum/(1 + d²/9)`.
  - The top N get voices, with 300 ms steal fades and `setTargetAtTime(τ 0.08)`.
  - Variant = `id % 4`; playback rate = 0.995–1.005 from `seed`.
  - DYING/BUZZ add buzz gain.
- **Dynamic light transients.** Every frame, call `flickerEvents(state, seed, now + 0.03, now + 0.03 + dt)` for the dynamic lights within 18 m and schedule `AudioBufferSourceNode.start(ctxTime + 0.03 + (t − now))`: sample-aligned with the visual flicker. The voice gain follows `flicker().buzz` through AudioParam automation.
- **Hum bed.** A stereo bed with gain `√(Σ unvoiced lit contributions within 30 m)`. In dead sectors it falls to room tone (−42 dBFS pink/brown).
- **Room probe (4 Hz).**
  1. Cast 24 horizontal `rayDistance` rays (max 40 m) at y = 1.2 → area and mean free path.
  2. With the ceiling height, get V and S.
  3. ā = the surface-weighted `LAYER_DEFS.absorption` of the floor, walls and ceiling materials nearby.
  4. `RT60 = 0.161·V/(S·ā)`.
  5. Pick the nearest IR with hysteresis (±15%), crossfading A/B over 1.5 s.
  6. Pre-delay = `mfp/343` (clamped to 5–60 ms); wet level from openness.
- **Footsteps.** On the `footstep` event: surface buffer, detune ±50 cents, ±1.5 dB, pan ±0.15 per foot. Gain by gait (crouch 0.3, walk 0.6, sprint 1.0; settle steps 0.35). Reverb send 0.35. Water depth overrides the surface.
- **Wading.** A continuous `wade` bed whose gain ∝ `speed·waterDepth` (0 when dry), low-passed by depth.
- **Air absorption.** Every line-of-sight source gets `f_c = 20000·e^(−d/40 m)` (min 2 kHz) in addition to the occlusion filter.
- **Ambience.**
  - Per-zone beds from `zoneAudio.ts`, keyed by `world.zoneAt(listener)` (cell-based: towers/elevators are CONCRETE in every storey): LOBBY/MANILA/MAZE/LOW_EXPANSE/PILLAR_HALL/DARK → `hvac` (DARK at −10 dB); OFFICE → `officeHvac` (quiet HVAC + a faint CRT whine, a narrow band near 8 kHz at −40 dBFS); POOLROOMS → `water`; PARKING → `fanDrone`; WAREHOUSE → `roofCreaks` + `fanDrone`; PIPEWORKS/CONCRETE → `pump`/`drone`. 1.5 s crossfades.
  - Emitters from `layout.emitters` within 25 m: an 8-voice pool using `synthEmitter` for every `EmitterKind`.
  - **Poisson ambient events** with λ L0 1/40 s, industrial 1/25 s, pools 1/20 s; minimum gap 15 s; the same kind never twice in a row. Kinds and weights: L0 {doorThud 3, chairScrape 2, tileCreak 3, ballastPop 2, damperClunk 3}; industrial {pipeKnock 4, metalGroan 2, pumpCycle 3, chainRattle 1}; pools {dripPlink 4, drainGurgle 2, filterPump 2}. They are placed at a reachable cell 25–60 m away through the propagation field. Peak −18 dBFS, attack ≥ 20 ms. **No stingers.**
  - **Event sounds:** `transition` (elevator) → motor on `doorsClosing`/`doorsOpening`, cable rumble through `ride`, ding on `doorsOpening`; `flashlight` → click; `spark` → crackle at the position; `interact` → door rattle (propKind DOOR_LEAF inside a LOCKED_EXIT landmark, found via `world.layoutAt(...).landmarks`), phone pick-up then silence (stops the PHONE emitter), radio click-off (stops the RADIO emitter).
- **Dread director** (`dread.ts`).
  - LATE_ECHO sites: the footstep bus gets an extra 350 ms delayed tap that stops when you stop.
  - "Not your footsteps": only after `stillFor ≥ 20 s` in DARK/DYING mood, with p 0.2 and a 10-minute cooldown. 4–9 steps, 14–22 m away, moving **away**.
  - RINGING_PHONE: audible to 60 m; stops when the player is within 3 m.
  - Glitch/noclip (the `glitch` event, emitted only by traversal): tape-stop (playback rate → 0.3 over 0.4 s), then 0.6 s of silence.
- **Foley.**
  - Breathing after 4 s of sprinting (recovers over 10 s), driven by the `breath` event.
  - Cloth rustle ∝ yaw rate; crouch rustle; landing thumps.
  - Pause muffles everything to −12 dB behind an 800 Hz low-pass.
- **Flicker mode** (`setFlickerMode`) is passed through to `flickerEvents`.

**Acceptance**
- **DSP** (vitest):
  - every `EmitterKind`, `OneShotKind` and `BedKind` renders;
  - deterministic;
  - peak ≤ 1, no NaN;
  - hum loop seam continuous (first and last sample delta < 1e-3);
  - Schroeder-integrated RT60 of `makeIR` within ±15% of the target;
  - spectral-centroid order tile > concrete > carpet.
- **Propagation:** in an L-shaped corridor fixture, the apparent source lies at the doorway cell, the path excess is correct, and the bends count is 1. Unreachable sources are flagged.
- **Room probe:** Sabine output in a 10×10×2.7 carpet room is < 0.6 s and in a parking-like 40×40×2.6 concrete room is > 1.8 s.
- **Headless smoke** (WP14 QA): `audio.stats().state === 'running'`, voices > 0 at the L0 spawn, and RT60 in LOBBY is less than in PARKING.

**Must NOT touch:** the flicker implementation (read-only consumer), world queries, player.

---

### WP14: App shell, UI, settings, debug API, QA tools

**Goal:**
- Boot in the right order.
- A frame loop in the right order.
- A minimal, tasteful UI: title with attract mode, loading, pause, settings, F3 overlay.
- Persistence.
- The complete automation contract (§7) and the QA tooling.

**Files:** `index.html`, `harness/index.html`, `src/main.ts`, `src/app/*`, `src/ui/*`, `tools/{shoot.mjs,qa.mjs,qa-presets.json}`, `tests/app/*`.

**Exported API:**
```ts
// app/urlParams.ts (PURE)
export function parseLaunchParams(search: string, settings: Settings): LaunchParams;
// app/settingsStore.ts
export interface SettingsStore { get(): Settings; set(patch: Partial<Settings>): void; subscribe(fn: (s: Settings) => void): () => void }
// app/continueStore.ts (localStorage 'backrooms.continue.v1')
export interface ContinuePoint { seedText: string; s: StoreyId; x: number; y: number; z: number; yaw: number; savedAt: number }
export function createContinueStore(storage: Storage | null): { load(): ContinuePoint | null; save(p: ContinuePoint): void; clear(): void };
export function createSettingsStore(storage: Storage | null): SettingsStore; // key 'backrooms.settings.v1', validate + clamp + migrate
export function validateSettings(raw: unknown): Settings;
// app/qualityAuto.ts
export function resolveQuality(q: QualityName | 'auto', gl: WebGL2RenderingContext): QualityName;
// app/renderer.ts
export function createRenderer(canvas: HTMLCanvasElement, q: QualityConfig): THREE.WebGLRenderer;
// app/App.ts
export interface App { readonly debug: BackroomsDebugAPI; start(): Promise<void> }
export function createApp(root: HTMLElement): App;
// app/imageStats.ts (pure over pixels)
export function computeImageStats(rgba: Uint8Array, w: number, h: number): ImageStats;
```

**Renderer** (`createRenderer`):
- `new WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false, depth: true })`.
- `toneMapping = NoToneMapping`, `outputColorSpace = SRGBColorSpace`.
- `shadowMap.enabled = true`, `shadowMap.type = PCFShadowMap`.
- `info.autoReset = false` (reset once per frame).
- `setPixelRatio(min(devicePixelRatio, q.maxDpr) · q.renderScale)`.
- Check `EXT_color_buffer_float` at boot; if missing, show an error screen.

**Boot and frame loop:** exactly §6.1–§6.2.

**UI** (DOM + CSS, no framework; a memo/VHS monospace style, restrained):
- **Title.**
  - Starts black. The seed's world fades in behind the menu with the **attract mode**: an autopilot walk at 0.6–1.0 m/s with head bob and a slight blur via CSS backdrop.
  - Menu: `CONTINUE` (only when a saved point exists for any seed; shows seed and storey), `ENTER`, `SEED [____] ↻`, `SETTINGS`, `CONTROLS`, plus a photosensitivity line. CONTINUE feeds the saved `{seedText, s, x, z, yaw}` into the existing explicit-position launch path.
  - On Enter: pointer lock. **The hum fades in 1 s before the picture fades in**, via an audio start and a CSS overlay fade.
- **Loading.** A phase list (textures, shaders, world, lighting) with progress.
- **Pause** (Esc or pointer-lock loss): Resume, Settings, Copy location link (URL with seed/s/x/z/yaw/pitch), Quit to title.
- **Persistence of place:** every 10 s of play and on pause, save `{seedText, s, x, y, z, yaw}` via the continue store (not in `autostart`/QA runs).
- **Settings.**
  - Video: preset/auto, render scale, dynamic resolution, FOV, brightness EV ±1, camcorder, grain, CA, vignette, distortion.
  - Comfort: head bob, **flicker standard/reduced/off**, toggle sprint/crouch.
  - Audio: master/ambience/hum/sfx/ui volumes, mains 50/60 Hz.
  - Controls: sensitivity, invert Y.

  Changes apply live. A texture size change requires a reload; the panel says so.
- **F3 overlay** (4 Hz): fields from `stats()`. **HUD:** empty, except a faint 3 px centre dot while `player.state.target ≥ 0` (an interactable is targeted), and the camcorder REC overlay when enabled.
- **Event wiring** (in `App.ts`): `bus 'glitch'` → `post.glitch(seconds, strength)`; `bus 'pause'` → post/audio pause.

**Debug API** (`window.__backrooms`, the full §7.2 surface):
- `imageStats` → `post.capture(160, 90)` → `computeImageStats`.
- `perf(seconds)` records frame times.
- `autowalk` drives the autopilot with a fixed seed and reports memory/geometry counts and `max5s`.
- `layerAlbedoCheck` → WP8.
- `goto` / `findNearest` → `streamer.findNearest`, then teleport.

**Tools.**
- **`tools/shoot.mjs`.** Stays backward compatible (all current flags, output format, `autostart=1`). Add:
  - `--page <path>`: e.g. `harness/materials.html`, appended to the base URL.
  - `--preset <name>`: loads `tools/qa-presets.json` → a list of `{name, page?, params, size?, wait?, eval?[]}` shots.
- **`tools/qa.mjs`.**
  1. Runs a preset list through the same browser code (it imports shared helpers from `shoot.mjs` by refactoring them into exported functions in the same file).
  2. After each shot, evaluates `__backrooms.imageStats()` and `stats()`.
  3. Applies the thresholds from §8.2.
  4. Writes `shots/qa-report.json` and exits non-zero on failure.

  It also supports `--baseline dir` for 64×36 downsample diffs (flag only, not fail).

**Acceptance**
- **`tests/app/urlParams.test.ts`.** Every parameter parses and clamps; bad values produce warnings; no throws.
- **`tests/app/settings.test.ts`.** Defaults, migration and clamping.
- **`tests/app/imageStats.test.ts`.** Synthetic images give the expected stats.
- **QA.** `node tools/shoot.mjs --params "seed=1"` works unchanged; `--page harness/post.html` works; `npm run qa` runs the full preset list.

**Must NOT touch:** subsystem internals; wire them only through their exported APIs.


---

## 6. Runtime: initialization, frame loop, streaming lifecycle, quality presets

### 6.1 Initialization sequence (WP14 `boot.ts`)

`readyPhase` is shown in brackets at each step.

1. **[boot]**
   1. `settings = createSettingsStore(localStorage)`.
   2. `params = parseLaunchParams(location.search, settings)`.
   3. `q = QUALITY[resolveQuality(params.quality ?? settings.quality, gl)]`, with overrides from settings and params (scale, radius).
   4. `createRenderer`. Create the scene and camera (`PerspectiveCamera(fov, aspect, 0.05, 400)`, Euler order `'YXZ'`).
2. **UI.** If `!autostart`, show the title (black). Otherwise go straight to loading.
3. **[textures]** `textures = await generateTextures(renderer, q.textureSize, q.anisotropy, progress)` (WP8).
4. **[shaders]**
   1. `materials = createMaterialSystem(renderer, textures, q)` (WP9).
   2. `lighting = createLightingRuntime(scene, materials.globals, textures, q, settings, bus)`: adds the flashlight **permanently** (WP11).
   3. `post = createPostStack(renderer, scene, camera, q, settings)`.
   4. `reflection = createPlanarReflection(materials.globals, q)`.
   5. `anomalyDirector = createAnomalyDirector(bus, lighting, scene)` (adds its spark mesh to the scene permanently, so warmup covers its program).
   6. `await materials.warmup(renderer, camera, scene)` (compile **and draw** every variant into a HalfFloat target with the flashlight and its shadow present; see WP9).
5. **[spawn]**
   1. `pool = await createWorkerPool(size, init)`. `init = { opts: {seed, seedText, forceZone, forceMood, forceLandmark, testScene, lights}, bake: bakeQualityOf(q), bakeTerm, validate: import.meta.env ? import.meta.env.DEV : true }` (Node, which has no `import.meta.env`, validates).
   2. `streamer = createChunkStreamer({...})`; add `streamer.scene` to the scene. With `bake=full` it gets `capture: { gateClosed: () => gate.active, scope: params.stream }` (the automation capture gate, §7.5).
   3. Resolve the spawn:
      - explicit `x`/`z` → use them (y = floor via the layout once loaded; `s` from the param);
      - `goto`/`zone` → `await streamer.findNearest(...)` (fallback: spawn);
      - otherwise `await streamer.spawn(s ?? 0)`.

      A spawn inside a wall snaps to the nearest walkable cell.
   4. `player = createPlayerSystem(spawn, settings, bus, host)`; `audio = createAudioSystem(bus, settings, q)`.
6. **[chunks] → [bake]** The frame loop starts (rendering behind the loading overlay). Players (`bake` interactive / preview) wait until `streamer.isReadyNear(20, 40, false)`. Automation (`bake=full`) freezes the clock at `time` as the gate OPENS, then waits for the capture set (§7.5: `getCaptureControl(streamer).isCaptureReady()`).
7. **[frames]** (players) / **[settle]** (automation)
   1. If `time` is set, freeze the simulation clock at `time`; if `freeze`, freeze at the current value.
   2. If `exposure` is a number, call `setExposureLock`.
   3. Apply `view`/`flashlight`/`post` toggles.
   4. Players: `post.snapExposure()`, then render 10 frames. Automation: the probe re-captures its faces, then the settle of §7.5 (quiet frames, exposure metered every frame from a fixed start) and the `br:settled` mark.
   5. **[ready]** `__backrooms.ready = true`; emit `ready`.
   6. With autostart, `audio.start()` (unless `noaudio`).

   Title flow: the attract mode runs from step 6 onward. On Enter: `audio.start()` → hum fade-in → picture fade-in 1 s later → pointer lock.

**Teleport and goto after ready:**
1. `ready = false`, `readyPhase = 'chunks'`.
2. `player.teleport`.
3. `streamer.update` until the stream condition of step 6 holds.
4. Players: `snapExposure`, 10 frames. Automation: the settle. Then `ready = true`.

The promise resolves at that point. `__backrooms.load(search)` (§7.5) is the automation's whole-shot version: it also resets every toggle and re-resolves the pose from the seed's base spawn.

### 6.2 Frame loop order (WP14 `loop.ts`, `renderer.setAnimationLoop`)

```
realDt = min(now − last, 0.1);  t += frozen ? 0 : realDt;  dt = frozen ? 0 : realDt;  renderer.info.reset()
 1. input.poll(inputState)                      (autopilot writes inputState instead when attract/autowalk)
 2. player.update(dt, inputState, streamer.query, bus, frozen)   (120 Hz substeps; traversal may call host.switchStorey/prefetch)
 3. streamer.update(player.x, player.z, viewDirX, viewDirZ, camera, frame)
 4. streamer.processUploads(renderer, q.uploadBudgetMs)           (≤ 1 residency step)
 5. lighting.update(t, dt, streamer.tiles(), player.state, camera, streamer.query)  (flicker uniforms, atmosphere globals, flashlight, bounce VPLs)
 6. anomalyDirector.update(t, dt, player.state, streamer.query)
 7. materials.globals.time.value = t
 8. player.applyToCamera(camera, fov)
 9. audio.update(t, dt, player.state, streamer.query, lighting)
10. reflection.update(renderer, scene, camera, nearestVisibleWaterY)
11. post.setAtmosphere(lighting.atmosphere()); post.render(realDt, t)
12. dynRes.update(frameMs); stats.push(frameMs); ui.overlay(stats) at 4 Hz; resolve pending debug captures
```

Frame budget on the main thread: **≤ 6 ms** at high. Allocations per frame: none in steps 1–11 (use preallocated scratch arrays).

### 6.3 Chunk and tile streaming lifecycle

```
                     main thread                                   worker (pure handleRequest)
desired chunk ──► layout job (affinity = chunk) ───────────────────► generateChunk (LRU 96) + buildChunkCollision
                 ◄── {cloneLayout(layout), collision} (transfer; the LRU copy stays intact)
                     ── registered in that storey's WorldQuery data set (collision, audio, debug)
desired tile  ──► build job (priority) ──────────────────────────► 9 layouts → nb → buildTile → bakeTile(preview)
                 ◄── {TileMesh, LightmapData(preview)} ── state 'received'
                 texUpload step:  TexturePool.acquire (reuse same-size textures; texSubImage) + renderer.initTexture
                 geoUpload step:  BufferGeometry + factory materials → tile.group; forced GPU upload (1x1 scratch
                                  render with overrideMaterial) → storey group
                 fadingIn (0.5 s ordered-dither)  → resident (ring ≤ radius)
                 bake job (priority after builds of ring ≤1) ───────► buildTileSurfaces → bakeTile(full)  (chartHash check)
                 ◄── {LightmapData(full)} ── texture step: in-place swap (instant), bake='full'
leaves radius+1 ─► evicting (removed from scene) ─► next frame: dispose geometry+materials, release textures ─► disposed
storey switch:  prefetch(target) = layout jobs (target storey's query data) + build/bake/upload into the hidden
                storey group (own upload slot) → isPrefetched → switchStorey flips visibility AND query data
                (same frame) → old storey evicted progressively
```

**Throughput at high.** Radius 2 → 25 chunks → 100 tiles.
- Initial ready needs the 36 tiles of the 3×3 chunks: previews ≈ 36 × 60 ms / 12 workers ≈ 0.2 s; full bakes ≈ 36 × 0.45 s / 12 ≈ 1.4 s.
- The remaining 64 tiles fill within ≈ 3 s.
- Sprinting (3.2 m/s) crosses a chunk every 12 s and needs 5 new chunks = 20 tiles ≈ 9 core-seconds, i.e. under one core of steady load. The look-ahead centre requests them ~2 s (6 m) before the crossing, and the edge fog ends at 0.8R, leaving ≥ 1.5 s + 7.7 m of margin at radius 2.
- Chunk affinity keeps a chunk's 4 tiles on one worker when possible (shared layout LRU and bake cache: warm bakes).
- A tower prefetch adds 36 tiles (one storey at radius 1, preview-first); ascending adds the second storey only on demand.

### 6.4 Quality presets (`core/quality.ts`)

| | low | medium | high | ultra |
|---|---|---|---|---|
| Stream radius (chunks) / tiles resident (max with hysteresis) | 1 / 36 (64) | 2 / 100 (144) | 2 / 100 (144) | 3 / 196 (256) |
| Edge fog start–end (m), 0.55R–0.8R | 21–31 | 42–61 | 42–61 | 63–92 |
| LM texels per cell (texel) / shadow samples / probe rays | 8 (0.15 m) / 1 / 32 | 8 / 2 / 64 | 12 (0.10 m) / 4 / 96 | 12 / 6 / 128 |
| Bake workers (max) | 4 | 8 | 12 | 12 |
| Texture size / anisotropy | 512 / 4 | 1024 / 8 | 1024 / 16 | 1024 / 16 |
| AO (R4: half-res, samples per texel) | off | 10 | 12 | 12 |
| AA | off | SMAA medium | SMAA high | SMAA high (supersampled) |
| Bloom levels | 5 | 6 | 8 | 8 |
| Planar reflection (water) | off | 0.35 | 0.5 | 0.5 |
| Floor emission reflections | off | on | on | on |
| Flashlight shadow | 512 | 1024 | 1024 | 2048 |
| Render scale / dynamic res / max DPR | 0.75 / on / 1 | 0.85 / on / 1 | 1.0 / on / 1.5 | 1.4 / on / 2 |
| Props draw distance | 20 m | 30 m | 45 m | 60 m |
| Hum voices / HRTF | 4 / no | 8 / yes | 10 / yes | 12 / yes |
| Upload budget | 2 ms | 2.5 ms | 3 ms | 3 ms |
| Flashlight airlight in haze (analytic path: reflections) | off | off | on | on |
| Froxel volumetrics (package F) | off | off | 160×90×64, 48 m | 192×108×80, 56 m |
| Dust motes (package F) | 0 | 0 | 3000 | 6000 |
| Flashlight bounce rays / VPLs (package F) | 0 | 4 / 1 | 4 / 4 | 8 / 4 |

`setQuality` at runtime:
- **radius:** re-desires the tile set.
- **tpc, shadow samples, probe rays or near-field rays (`BakeQuality`):** `await pool.reinit(newInit)` (cancels queued jobs, drops in-flight results, re-broadcasts init), then every tile is rebuilt (tpc: new atlas) or re-baked.
- **textureSize:** requires a reload (UI notice).
- **AO, AA, bloom, reflection:** applied live. `MaterialSystem.setQuality` changes defines, then warmup runs again.

**Graphics-realism flags (A.0 contract).** `QualityConfig` also carries one field per upgrade, one line per preset
object so each owning package flips only its own lines; until the owner lands a flag stays off. Owners and final
values (low / medium / high / ultra): D `ssr` off/off/half/half, `ssrMaxRoughness`, `ssrSteps`, `ssrFilter`,
`reflectionProbe` 0/0/128/256; A `colorPyramidScale` 0/0/1/0.67, `contactShadowSteps` 0/0/8/8; B `wetPuddles`,
`detailMaps`, `pom` 0/0/1/2, `clothSheen`, `specularAA`; C `motionBlurTaps`, `glareStreaks`, `glareGhosts`; E
`waterRefractionSteps`, `waterWaves`, `waterRippleRes`, `waterRippleTexel`, `waterDebris`, `waterCaustics`,
`waterVolumetrics`; F `volumetrics` off/off/high/ultra, `dustMotes` 0/0/3000/6000, `flashlightBounce`, `bakeNearRays` 0/0/16/32 (live; sent as
`BakeQuality.nearRays` only when > 0, so other presets' worker inputs stay byte-identical). None of them is a resolution-only key. Landed: B `wetPuddles`,
`clothSheen`, `specularAA` (F/T/T/T), `detailMaps` (F/F/T/T) and `pom` (0/0/1/2); E `waterRefractionSteps` 0/0/8/10,
`waterWaves` 0/3/6/8, `waterRippleRes` 0/128/256/512, `waterRippleTexel` 0/0.06/0.04/0.03, `waterDebris` F/T/T/T,
`waterCaustics` basic/basic/full/full, `waterVolumetrics` 0/0/2/4 (and ultra `planarReflectionScale` 0.67 -> 0.5:
the refraction pays for itself). `QualityDefines.waterRefract` is the march step count (0 without the colour pyramid).
`materials/shared.ts qualityDefinesOf` turns them into `QualityDefines` (ssr, probe, ssao = ao != off, cs, puddles,
detail, pom, sheen, coat = !lite, specAA, the water fields, volumetric, bounce), `applySurfaceDefines` maps each to one
define (`BR_SSR`, `BR_PROBE`, `BR_SSAO`, `BR_CS_STEPS=n`, `BR_PUDDLES`, `BR_DETAIL_MAPS`, `BR_POM=n` shell only,
`USE_SHEEN`, `USE_CLEARCOAT` props only, `BR_SPEC_AA`, `BR_WATER_VOL`, `BR_WATER_WETBAND`, `BR_CAUSTICS_FULL`,
`BR_VOLUMETRIC`, `BR_BOUNCE_N=n`), and `definesKey` keeps the `R?A?L?` prefix and appends `.` + short + value for every
field that is not false / 0 (`ssr prb ao cs pud det pom sh cc saa wr ww wp wd wc wv vol fb`). `setQuality` compares the
full key. Every surface / water uniform is declared once in `chunks/common.ts`, every `MaterialGlobals` field starts
inert and is bound by reference, and each package plugs in through a stub chunk file it owns (screenspace, gbuffer: A;
detail, pom, materialPost: B; emitters: C; probe: D; water: E; volumetric, bounce: F). Surface programs may use at
most 16 texture units (`tests/materials/samplerBudget.test.ts`; dev builds also check the linked programs in
`materials/warmup.ts`). `uReflTex` is compiled out under `BR_SSR` and `uVolA` is referenced by the props program only.
At high / ultra the shell and decal programs then use 13 units before the new features: albedo, normal, ormh, grime,
lmIrr, lmDir, lmMask, lmFlick, emission, volMask, the flashlight shadow map and cookie, and three's own `dfgLUT`
(material.dfg in `lights_fragment_begin`). The planned probe, SSAO, froxel volume and detail array make 17, so one
more sampler must go before the last of them lands (props: 12 + 4 = 16; water: 10 with E's `uRipple`). Package A's `uSsaoTex`
(pre-shade SSAO and contact shadows, medium / high / ultra) makes the high / ultra shell 14; the lead's resolution is
that D compiles the emission-map reflection out under `BR_SSR` / `BR_PROBE`, which frees `uEmission`. Package A's
colour pyramid (`uSceneColor`) is read by water and SSR passes only, never by surface programs. Package F's froxel
volume (`uVolTex`) also compiles the shell / props floor planar path (`uReflTex`) out under `BR_VOLUMETRIC`: every
preset with the volume has SSR as well, which supersedes that path, and on its own the high / ultra shell stays at 16.
The detail array (B) has landed: it is referenced by the shell and props programs at high / ultra, never by the
decal program.


---

## 7. Automation contract

### 7.1 URL parameters (`app/urlParams.ts` → `LaunchParams`)

`tools/shoot.mjs` appends `autostart=1`. Unknown or invalid values never throw; they are reported in `stats().warnings`.

| Param | Values | Meaning |
|---|---|---|
| `seed` | any string (digits → uint32) | World seed. Default: settings `lastSeed` or random `NNNN-NNNN`. |
| `autostart` | 1 | Skip the title and pointer lock; audio starts immediately (headless autoplay flag). |
| `s` | 0, 1, 2 | Storey |
| `x`, `z`, `y` | metres | Spawn position. Without `y`: snapped to the floor. Inside a wall: snapped to the nearest walkable cell. |
| `yaw`, `pitch` / `yawDeg` | radians / degrees | View |
| `fov` | 50–90 | Vertical FOV |
| `goto` | `zone:NAME`, `landmark:NAME`, `vignette:NAME`, `tower`, `elevator`, `dark`, `water`, `flicker`, `spawn` | Nearest match via `findNearest` (≤ 24 chunks): a safe cell with a best-view yaw |
| `zone` | ZONE name | Shorthand for `goto=zone:NAME` |
| `forceZone` | ZONE name | Every district becomes this zone |
| `forceMood` | NORMAL, SPARSE, DYING, DARK | Every district's mood |
| `forceLandmark` | LANDMARK name | Stamped at chunk (0, 0) of every storey |
| `testScene` | leak, cornell, tower, materials, flicker, grid | Hand-authored scene at the origin |
| `quality` | low, medium, high, ultra, auto | Preset |
| `scale` | 0.5–2 | Render scale override (disables dynamic resolution) |
| `radius` | 1–4 | Stream radius override |
| `view` | final, albedo, normal, roughness, lightmap, directionality, ao, flicker, mask, layer, texel, zone, room, uv, emission, lv, wetness, height, volumetric, bounce, water, probe, specw, ssao | Debug view (int uniform, no recompile) |
| `time` | seconds | Freeze the simulation clock at t (flicker, grain, water, bob) and snap exposure |
| `freeze` | 1 | Freeze the clock at its value when ready |
| `exposure` | EV100 or `auto` | Lock exposure |
| `flashlight` | 1 | Flashlight on |
| `fly` | 1 | Noclip flight |
| `noaudio` | 1 | No AudioContext |
| `nopost` | 1 | RenderPass only (tone mapping still via a minimal AgX pass so colours stay sane) |
| `ao`, `bloom`, `grain`, `lens` | 0 | Disable that effect |
| `ssr`, `probe`, `cs`, `bounce`, `vol` | 0 | Disable a graphics-realism feature for A/B checks (`Systems.features`; the owning package reads it) |
| `reflView` | off, ssr, conf | SSR debug output: the reflection alone, or its confidence |
| `flicker` | standard, reduced, off | Photosensitivity mode |
| `lights` | default, on, dead | Fixture-state override |
| `bake` | preview, full, interactive | Ready gate: `full` (default with `autostart=1`) = the automation capture contract v2 (§7.5); `interactive` (default without) and `preview` = the player gate |
| `stream` | capture, full | With `bake=full` only: `capture` streams the capture set alone, before and after ready (shoot / ab); `full` (default) streams the whole radius once ready (players, QA) |
| `bakeTerm` | all, direct, indirect | Debug bake (leak and cornell QA) |
| `camcorder` | 1 | Camcorder look (VHS extras, REC overlay) |
| `hud` | 0 | Hide all overlays |
| `debug` | 1 | F3 overlay on |
| `noprime` | 1 | Skip the wait for Chromium's first-context loss (a browser that already absorbed it: the play launcher, tools after `warmGpu`) |

`BOOT_PARAM_KEYS` (`quality`, `scale`, `radius`, `bake`, `camcorder`, `hud`, `debug`, `noaudio`, `autostart`, `noprime`) shape a page at boot: `__backrooms.load()` refuses a search whose values differ, and tools group shots by them. Every other key applies in place.

### 7.2 `window.__backrooms` (`BackroomsDebugAPI` in `core/debug.ts`)

- **Readiness.** `ready` (boolean property) and `isReady()`. `ready === true` requires **all** of:
  1. textures generated;
  2. `compileAsync` warmup done;
  3. spawn resolved;
  4. the stream condition: with `bake=full`, the whole capture set (§7.5) resident, full-baked and uploaded, with its chunks' layouts; for players, the preview-lit tiles within 20 m and in view within 40 m;
  5. with `bake=full`, the settle of §7.5 (quiet frames, probe settled, exposure metered and applied); for players, the exposure snapped and 10 frames rendered.

  It goes `false` during teleport/goto/load until those hold again.
- **`readyPhase`**: one of `boot`, `textures`, `shaders`, `spawn`, `chunks`, `bake`, `settle` (automation), `frames` (players), `ready`.
- **Capture contract v2** (`captureGate === 2`; absent on older builds): `whenReady()` resolves at the next ready (at once when ready); `load(search)` applies a whole shot in place (§7.5); `frames(n)` resolves after n more rendered frames.
- **`stats()` → `DebugStats`**: fps; frameMs {avg, p95, max, max5s}; cpuMs; gpuMs (null when timer queries are unavailable); render {drawCalls, triangles, programs, textures, geometries}; chunks; tiles {resident, preview, full, queued, inFlight, uploadsPending, fadingIn, and with `bake=full` gate, gateReady, scope}; workers; bake timings; player {s, x, y, z, yaw, pitch, zone, mood, surface, cell, chunk, onGround, fly}; exposure; lights; audio; timeFrozen; warnings; errors.
- **Control:**
  - `teleport({x, z, y?, s?, yaw?, pitch?})`: Promise, resolves when ready again;
  - `goto(target)`, `look(yaw, pitch)`;
  - `setQuality(q)`, `setView(v)`, `setTime(t|null)`, `setExposure(ev|null)`, `setFlashlight(on)`, `setPost({...})`, `setFlicker(mode)`;
  - `waitForIdle(ms)`.
- **Queries:**
  - `cellAt(x, z)` → CellInfo;
  - `zoneAt(x, z)`;
  - `findNearest(query, maxChunks)`;
  - `ascii(radiusCells = 24)`: resident layouts with `@` at the player;
  - `gen.asciiMap(s, cx0, cz0, cx1, cz1)` (worker), `gen.districtAt(s, cx, cz)`.
- **Measurement:**
  - `perf(seconds)` → PerfReport;
  - `imageStats(rect?)` → ImageStats (a 160×90 capture of the final image);
  - `autowalk({distance, speed?, seed?})` → AutowalkReport;
  - `walk(path, speed?)`;
  - `layerAlbedoCheck()`;
  - `audio.stats()`, `audio.recentEvents()`, `events()`;
  - `water.poke(dx, dz, amp = 1)` (a footstep-sized ripple impulse × amp at dx m right, dz m ahead of the eye), `water.step(n)` (n 1/60 s ripple steps now: frozen-time captures), `water.stats()` (plane, kind, window, steps, drips); `gpuProfile` reports the ripple simulation as `waterSim`.

### 7.3 Harness pages (each sets `window.__backrooms` to a `HarnessDebugAPI`: `{ ready, isReady(), stats(), layerAlbedoCheck? }`)

| Page | Owner | Params | Purpose |
|---|---|---|---|
| `harness/materials.html` | WP8 | `view=albedo\|normal\|ormh\|lit`, `layer=N` | Texture gallery, `layerAlbedoCheck`, `tileSeamCheck` |
| `harness/chunk.html` | WP10 | `seed`, `s`, `cx`, `cz`, `zone`, `view`, `tpc`, `bake` | One chunk through the real worker pipeline plus materials, fly camera, atlas stats |
| `harness/post.html` | WP11 | `scene=panels\|dark\|shimmer`, `preset` | The post stack on a synthetic HDR scene; the shimmer GLSL/TS parity check |
| `harness/index.html` | WP14 | none | Links to the pages above |

Shot with `node tools/shoot.mjs --page harness/chunk.html --params "seed=1&cx=0&cz=0&view=lightmap"`.

### 7.4 QA presets (`tools/qa-presets.json`, run by `npm run qa`)

All shots use `time=10&noaudio=1` unless noted.

1. **`zones`.** For each of the 12 zones, `seed=7&zone=NAME`, plus `forceZone=NAME` at 2 findNearest views.
2. **`spawn`.** `seed=1` (the famous-photo composition check).
3. **`leak`.** `testScene=leak&view=lightmap&bakeTerm=direct`, then `testScene=leak&view=final`.
4. **`cornell`.** `testScene=cornell&view=lightmap&bakeTerm=indirect`.
5. **`views`.** On L0, `view=albedo|normal|ao|mask|layer|texel|directionality|emission`.
6. **`dark`.** `forceMood=DARK&flashlight=1`, and without the flashlight.
7. **`pools`.** `goto=zone:POOLROOMS` with reflections.
8. **`tower`.** `goto=tower`, eval teleport to the mid-landing before and after the switch (pixel diff), then an eval walk down one full flight through the switch with `perf` running (max frame < 50 ms, `programs` unchanged). The same for an elevator ride.
9. **`landmarks`.** Each landmark via `goto=landmark:NAME`.
10. **`materials`.** `--page harness/materials.html` plus `layerAlbedoCheck`.
11. **`post`.** `--page harness/post.html`.
12. **`perf`.** `quality=high`, size 1600×900, `eval __backrooms.perf(10)` (reported, headed runs are authoritative).
13. **`soak`.** `eval __backrooms.autowalk({distance: 600, speed: 6})`.
14. **`stress`.** 50 teleports (memory returns to baseline ±10%).
15. **`edge`.** `forceZone=LOW_EXPANSE`, `quality=low` and `high`: an eval sprint (3.2 m/s) along an artery for 120 s; sampled `imageStats` of the horizon band never shows the clear colour as a hard edge (fog-end check) and `tiles.fadingIn` never exceeds 8.
16. **`decals`.** `forceZone=PARKING` and `forceMood=DYING` at L0: decals render soft-edged, no z-fighting at 40 m (two captures at slightly different yaw have no flickering stripe pixels).

### 7.5 Capture contract v2 and the tool-run result cache

**Why.** Automation captures used to depend on timing: the old gate waited for chunk ring 1 only, so tiles 38-61 m away kept arriving after ready, each one within the probe's reach re-captured the reflection probe, the exposure was still snapping, and simulation time ran until the gate froze it. The same shot differed by up to 771k px between ready and ready + 250 ms, 15.7k px between a cold and a warm cache, and 12k px between a fresh page and one reused in place; tools slept 250 ms after ready to hide part of it. Gate v2 defines readiness by position and view, and measures it in frames.

**Capture set** (`stream/priorities.ts inCaptureSet`, per tile, recomputed every frame while the gate is closed): chunk ring ≤ 1 always; beyond it only tiles within the edge-fog end (a fogged tile's group is hidden from every pass); within it every tile whose axis-aligned distance from the eye is ≤ `CAPTURE_NEAR_M` = 60 m + 1 m (the reflection probe renders the cube [−60, 60]³ around its anchor: 60 m along each axis, up to 85 m on the diagonals; the light atlas is sampled within 56 m), plus every tile intersecting the view frustum (tested against y −20…20 m, which also covers the planar mirror's reflected frustum). About 44-52 tiles at high and 62-68 at ultra, against 36 before.

**Streaming** (`ChunkStreamer`, `StreamerOptions.capture`): capture tiles are built with full lighting at `GATE_FIRST` priority, and the layouts of their chunks too. While the gate is closed nothing else is submitted, and a gate that closes (a teleport, a `load()`) drops the queued work outside its set, so a shot never waits behind the last one's far ring. `stream=capture` keeps it so after ready: the desired set is the capture chunks, and sweep evicts the rest with no hysteresis ring. `getCaptureControl(streamer)` exposes `isCaptureReady()` (every capture tile resident with its full bake, none rebuilding or queued for upload, every chunk holding one with its layout; failed tiles count as ready, as before), the upload steps of the last frame, `setScope()` and `stats()`.

**Settle** (`app/loop.ts`, pure `settleStep`): a launch gate (boot, seed, load) freezes the clock at `time` when it opens. Once the capture set is complete the launch toggles apply and the probe re-captures all faces (`ReflectionProbe.refresh`). Then `QUIET_FRAMES` = 3 consecutive frames with no residency step, no light-atlas slot left to upload (`atlasPending`) and the probe settled (`info.settled`: anchor captured and prefiltered, no stale face, box re-estimated since the last layout change). Then `settleExposure(post)`: the spring restarts from EV100 9.4, a meter reading in flight is dropped, and the meter reads every frame until `SNAP_MEASUREMENTS` = 3 readings of quiet frames are applied; anything that breaks the calm meanwhile restarts the settle. Ready follows with the `br:settled` performance mark. After 180 frames it warns (QA fails on warnings) and goes ready anyway. Players keep their gate unchanged.

Result on the D2 list (docs/PERFORMANCE_AUDIT.md): the capture at ready equals the one after full idle + 60 frames, with an empty cache, in place after other shots, with `noprime=1` and with `stream=capture`, to the pixel.

**In place: `__backrooms.load(search)`** (`App.ts`) → `{ ok: true, ms }`, or `{ ok: false, reason: 'boot-param', keys }` when a `BOOT_PARAM_KEYS` value differs from the page's (or the preset was changed with `setQuality` since boot), or `{ ok: false, reason: 'busy' | 'lost' }`. It waits for boot and pending quality changes, stops the loop, then:
- resets what the debug API and evals can change: `resetLaunchToggles` (clock running, no exposure lock, view final, flashlight off, the post enable set boot recorded, default feature toggles, reflection debug off, contact shadows and volumetrics on, the flicker mode from the launch or the settings, fly off), the anomaly director, lighting, audio, glitch, drivers and frame hooks, a new dynamic-resolution controller at the preset scale, frame statistics, `stats().warnings` / `errors` and the `events()` log;
- resets the world (`streamer.reset`) only when a world parameter changed (seed, forceZone, forceMood, forceLandmark, testScene, lights, bakeTerm), and switches the stream scope to the shot's `stream`;
- resolves the pose with `resolveSpawn` from the seed's base spawn exactly as a boot does (searching from the current position finds other instances), and makes the streamer forget its last position (`getCaptureControl(streamer).forgetPosition()`: `switchStorey` would otherwise start the new storey around the previous shot's x/z);
- teleports (y re-snapped for an explicit position without `y`), emits `teleport` (probe, ripples, motion blur and bounce reset), restarts the clock and the loop, replaces the history entry, and opens a `load` gate, which behaves like a boot gate;
- shows no curtain, loading screen or title: the DOM stays that of a fresh autostart page at ready.

**Tool-run result cache** (`workers/tileCache.ts`, `tools/viteTileCache.ts`; tool runs only). Layout, build, bake, spawn and find results are pure functions of the worker code, the init and the request, so tool runs share them through the dev server.
- Keys: SHA-1 of canonical JSON (sorted keys) of a code hash, the init and the request without its job id. Layout / spawn / find use the world hash (a tree-shaken, minified rolldown bundle of `workers/worldStage.ts`, which re-exports exactly what those branches run, plus the verbatim source of `handler.ts` and `validatePayload.ts`, whose own code around those calls is not in that bundle) and the world options only, so they survive baker edits and quality changes. Build / bake use the tile hash (the bundle of `chunk.worker.ts`) and the bake settings. Comments, types and render-only code reached through the `core/index.ts` barrel do not change the bundles. Both hashes include the entry codec, the package, rolldown and vite versions and `CACHE_SALT`, and are memoised on a stamp of the worker graph (paths, mtimes, sizes) in memory and in `<cache dir>/.hashmemo.json`. `handler.ts` must import the world-stage symbols only through `worldStage.ts` (tests/workers/worldStage.test.ts).
- A `bake` miss is answered from the `build lighting:'full'` entry of the same tile (the same lightmap; the streamer's chartHash check still guards it).
- Writes: each bake worker transfers the encoded result to its own writer worker (`workers/cacheWriter.worker.ts`), which gzips and PUTs it, so no bake thread waits on compression or uploads (at most 8 entries in flight per writer; beyond that a result is not stored). The writers still share the machine with the memory-bandwidth-bound bakes: on a cold location they cost about 0.6 s against no cache at all, and the reads (key digests, GET misses) about 0.3 s (docs/PERFORMANCE_AUDIT.md). The server also accepts raw PUTs (`X-BR-Raw: 1`) and gzips them at zlib level 1 on the libuv pool behind a queue of 8 (503 when full), but raw uploads from the browser measured slower than gzipping there (`WRITER_RAW` in tileCache.ts).
- Store: `<dir>/<ns>/<key>`, ns = the first 12 hex digits of the code hash in the key; flat legacy keys are still served. All I/O is asynchronous, mtime updates are batched every 5 s, and an in-memory size index drives eviction in batches above cap × 1.05, down to cap × 0.9: legacy files first, then whole namespaces unused for 24 h beyond the 3 most recently used, then least recently used entries. `GET /__tilecache/status` reports the hashes, entries, bytes and PUTs in flight.
- `tileCachePlugin(enabled)` stays a Vite plugin: `config()` injects `__BR_TILE_CACHE__`, `__BR_TILE_CACHE_WORLD__` and `__BR_TILE_CACHE_FEATURES__`, and `configureServer(server)` only calls `server.middlewares.use('/__tilecache/', fn)`, so a plain http server can mount the same store.

---

## 8. Integration plan, test plan, performance budget, risk register

### 8.1 Integration plan

| Phase | Who | Exit gate |
|---|---|---|
| **P0: contracts and skeleton** (≈ half a day) | orchestrator (WP0) | `npm run typecheck && npm test` green; `shoot.mjs --params seed=1` shows the grid rooms; all stubs present |
| **P1: parallel build** | WP1–WP14 | Each WP meets its definition of done. Pure WPs are tested in Node against `layoutFromAscii` fixtures and stubs; visual WPs use their harness pages |
| **P2a: pure integration** | orchestrator | `tests/integration/pipeline.test.ts` green: `handleRequest` gen → mesh → bake over 50 tiles in all zones with `validate*`, the chart-hash check, and bench numbers logged. Merge order: **WP1 → WP4 → WP2/WP3 → WP5/WP6 → WP7 → WP10** |
| **P2b: visual integration** | orchestrator | `harness/chunk.html` renders real chunks (WP8 + WP9 + WP10). Then swap the stubs in `main` one system at a time in this order: streamer, materials, lighting/post, player, audio. Run `npm run qa -- --preset spawn,leak,zones` after each swap |
| **P3: QA loops** | QA/review agents | Iterate on the §7.4 presets with image review against the reference qualities (below). Fixes go to the owning WP files only |

**Look review checklist** (every QA loop compares against the famous photo):
- soft panel penumbrae;
- dark corners (baked AO plus N8AO, no double-dark halos);
- dim ceilings lit by bounce;
- the yellow cast is present but not orange (AgX);
- panels clip and glow with a physically sized halo (no frame-wide veil);
- carpet pile and wallpaper emboss catch the light;
- stains and tide lines look caused, not tiled;
- haze is dark in dark sectors;
- no light through walls;
- no visible chunk-grid walls;
- grain rises in the dark.

### 8.2 Test plan

**Vitest (Node).** Everything below runs in `npm test`. Owners are listed in each WP spec.

| Area | Key tests |
|---|---|
| core | Invariants (no-leak texel rule for every occluding EdgeKind, repeats divide tile, tower layers 3 m-periodic, grid rounding at chunk/tile boundaries ±1e-6, region keys, table completeness); hash/RNG determinism with pinned values; half round-trip; writer transforms; edge pieces vs `edgeSolidAt` consistency (sampled); footprint helpers are rotations |
| arch | Import rules; `.ts` specifiers; nondeterminism ban; shader anchors (WP9) |
| world | Determinism (200 keys); seam equality (2000 pairs); no seam wall run > 12 (PATTERN); ports ≥ 1; soft/hard boundary mix; landmark eligibility and seam margins; global flood connectivity incl. landmark entrances; zone/mood frequencies; onboarding; fields continuity; golden hashes; generation performance; per-zone invariants (LOBBY leaf areas); tower geometry and invisibility DDA (incl. vertical sightlines); fixture rules (≤ 1 dynamic per tile, unique ids, no tile-line straddle, storey-free tower ids); prop and vignette spacing |
| mesh | Buffers valid; lmUv in charts; atlas non-overlap; chart-hash build == bake; ownership/no duplicate faces; watertight posts; SOLID/blocker/VOID coverage; partition plinths; decal +v orientation; triangle cap; tower replicas (shell + props, uv periodic) |
| props | Bounds within `PROP_DEFS`; triangle budgets; outward normals; emitter calibration (nits × area ≈ intensity) |
| bake | Leak on the **filtered** lightmap (both variants, both tpc, WALL and PARTITION); partition/HALF shadows; desk-top shadow; analytic single panel ±2%; tall-light lattice ≥ 85%; tile and chunk seam < 2% (incl. LOW_EXPANSE, PILLAR_HALL, WAREHOUSE); cache transparency; determinism; flicker exclusion and channel uniqueness; directionality range; tower periodicity; bench gate (`BENCH=1`: full p95 ≤ 600 ms warm, preview ≤ 60 ms, radius-1 time-to-ready ≤ 2.5 s) |
| stream/workers | `handleRequest` pipeline over 50 tiles plus test scenes, **through `structuredClone(res, {transfer})`** with same-state rebuilds; `validate*`; priority ordering; residency state machine (≤ 1 step per frame + 1 prefetch step, deferred dispose, prefetch layouts, atomic storey swap); pool reinit and affinity |
| lighting/post | Flicker determinism, frame-rate independence, WCAG windows, reduced mode, events ⇔ edges; effect ordering/attributes |
| player | Tunnelling, sliding, steps, crouch (incl. water block), tower switch continuity and hysteresis, glitch push trigger, footstep cadence ⇔ bob minimum, unloaded = solid, unstuck |
| audio | DSP determinism/peak/NaN for every bed, emitter and one-shot kind; loop seams; IR RT60 ±15%; centroid ordering; propagation portal placement; Sabine sanity |
| app | URL parsing; settings migration; imageStats maths |

**Headless QA thresholds** (`tools/qa.mjs`, applied to every shot unless the preset overrides them):
- no console errors or page errors;
- `readyMs ≤ 20 000`;
- `stats().warnings` empty;
- `drawCalls ≤ 400`.

`imageStats`:
- `meanLum ∈ [0.12, 0.65]` for lit zones; `[0.01, 0.25]` for `forceMood=DARK` without the flashlight; `≥ 0.05` with it;
- `clipped < 0.08` for lit shots (R2-post: emitters clip to white like a real camcorder; was 0.03), `< 0.03` for dark shots; the post harness keeps `< 0.03` clipped outside the emitters on its panels scene;
- `black < 0.25`, except in dark scenes;
- Level 0 zones (LOBBY, MANILA, MAZE, LOW_EXPANSE): `hueDeg ∈ [38, 65]` and `sat ∈ [0.15, 0.6]`; lit, non-DARK shots also need `p5 ≤ 0.30` (package C.7: the old warm veil must not creep back).

Scene-specific checks:
- **Leak scene:** the dark-room rect luma is `< 0.02`.
- **Cornell (indirect view):** the grey wall's mean hue lies in [35, 70] with sat > 0.1 (yellow bleed).
- **Tower:** mid-landing before/after pixel diff: mean absolute difference < 1.5% (grain off, `time` frozen).
- **Determinism:** the same params rendered twice with `time=10` have MAD < 0.5%.
- **Soak:** `frameMs.max5s < 50` after ready (including across tower switches and elevator rides); geometries and non-pooled textures within resident bounds + 10%; `render.programs` constant from ready to the end; errors = 0; in-flight returns to 0.

### 8.3 Performance budget (1080p, high, RTX 5070 Ti Laptop)

| Resource | Budget | Estimate / notes |
|---|---|---|
| GPU frame | **≤ 8 ms** | Scene 2–3 (≈ 100–150 culled draws + shadow); N8AO Medium 1.2; bloom 0.4; SMAA 0.3; exposure/lens/grade/grain 0.3; flashlight shadow 0.3; planar reflection 0.8–2 (pools only). R4 measured (RTX 5070 Ti, saturated): 1.6–2.0 ms at high 1080p, 5.9–6.9 ms at ultra with a 3840 × 2160 buffer (docs/PERFORMANCE_AUDIT.md) |
| Main-thread CPU | **≤ 6 ms** | Render submit 2–3; streamer 0.5 plus uploads ≤ 3 (budgeted); player/lighting/audio 0.7. No per-frame allocations |
| Hitches | max frame < 50 ms after ready | Upload state machine, TexturePool, `initTexture`, deferred dispose, no n8ao traversal, warmup covers every program |
| Draw calls | ≤ 250 typical, ≤ 400 hard | Per tile: shell + props + (decals) + (water); ≤ 144 resident tiles, frustum-culled, tiles beyond the fog end hidden. R4: plus one depth-prepass draw per shell / props mesh (about 1 µs of GPU time each); 109 in the high lobby, 230 in an ultra pool with the reflection |
| Triangles | ≤ 1.5M visible | Shell ≤ 60k per tile typical (hard 120k); props ≤ 40k per tile |
| VRAM | ≈ 1.5 GB (high) | Texture arrays 28 × 3 × 4 MB × 1.33 ≈ 450 MB; lightmaps ≈ 144 tiles × ~4.5 MB ≈ 650 MB (+ 36 prefetch tiles near towers ≈ 160 MB); texture pool ≤ 8 per size class; RTs ≈ 150 MB; geometry ≈ 150 MB. Ultra ≈ 2.2 GB; medium ≈ 0.9 GB; low ≈ 0.35 GB |
| JS heap | ≤ 800 MB | Worker LRUs of 96 layouts × ~50 KB; the main thread keeps layouts plus volume data only |
| Workers | Full bake ≤ 600 ms per tile (p95, warm cache; ≤ 900 ms cold), preview ≤ 60 ms, layout ≤ 6 ms (p95 12), build ≤ 20 ms per tile; radius-1 time-to-ready ≤ 2.5 s | 12 workers on 32 cores, soft chunk affinity |
| Boot to ready | ≤ 10 s headless (target 6 s) | Texture generation 0.4 s + texture shader compile ≤ 1.5 s (29 programs, parallel compile); material warmup (compile + draw) 1–2 s; radius-1 full bakes ≈ 2.5 s |

### 8.4 Risk register

| # | Risk | Likelihood / impact | Mitigation | Owner |
|---|---|---|---|---|
| R1 | Full bake too slow in open or tall zones (many lights per texel) | M/H | Shared per-(cell, light) visibility bitset, K_MAX strongest lights, coarse far patches, per-chunk bake cache with worker affinity, cell-pair classification, hybrid form factor, 2×2 refinement, bench gate (incl. ATRIUM and radius-1 time-to-ready). Preview bake means a tile is never unlit. Fallback (the knobs that dominate cost): R_OPEN 14 → 12, far patches 1.2 → 2.4 m, K_MAX 16 → 10, via contract change | WP7 |
| R2 | Light leaks or seams at wall bases or tile/chunk borders | M/H | The texel invariant (tested); true-value aprons on grid charts and continued wall runs; world-seeded sampling; leak and seam unit tests; `view=lightmap` QA | WP5/WP7 |
| R3 | `onBeforeCompile` anchor drift or program explosion | M/H | three pinned to 0.186.1; anchor test; constant cache key; factory rule; `programs` count check in the harness | WP9 |
| R4 | Build/bake atlas disagreement | L/H | Both call the same deterministic `buildTileSurfaces`; chartHash validated in the handler; pipeline test | WP5/WP10 |
| R5 | Visible storey switch | M/M | Periodic geometry, isolated periodic bake, prefetch plus clamp-until-ready, pixel-diff QA | WP4/WP7/WP12 |
| R6 | Chunk grid visible | M/H | Seam modes, the > 12-run test, districts, arteries, map-tool review | WP1/WP2/WP3 |
| R7 | Main-thread hitches (uploads, GC, n8ao traversal) | M/H | Residency state machine, pool, `autoDetectTransparency = false`, soak test | WP10/WP11 |
| R8 | Too-dark or too-bright calibration (photometric chain) | M/M | EV clamps per zone and mood, imageStats bands, the post harness, a central `atmospheres.ts` table | WP11 |
| R9 | Procedural textures look CG | M/H | Albedo check, anti-tiling, macro variation, mask-driven grime, gallery review each loop | WP8/WP9 |
| R10 | Contract drift across 14 agents | M/H | Frozen core, stubs, additive-only changes, arch tests, the pipeline test as the first gate | orchestrator |
| R11 | N8AO double-darkening over baked AO | M/M | AO intensity from the atmosphere table (~2.0), warm AO colour, `view=ao` review | WP11 |
| R12 | Headless GPU differs from headed Chrome (ANGLE/Vulkan) | M/L | Headless for correctness and look; perf judged by `perf()` headed; `quality=auto` for software GL | WP14 |
| R13 | Flicker photosensitivity | L/H | Standard mode WCAG-limited by default, tested; reduced/off in the comfort settings | WP11 |
| R14 | Tower prefetch cost at an arbitrary moment | L/M | Prefetch one storey (direction of travel) at 12 m, preview-first with its own upload slot; forced geometry upload at geoUpload (no switch-frame upload burst); clamp-until-ready at the switch threshold | WP10/WP12 |
| R15 | Worker transfer detaching cached data | L/H | `cloneLayout` for layout responses; `HandlerResult` rule; pipeline test round-trips every response through `structuredClone(res, {transfer})` | WP10 |
| R16 | Program recompiles mid-game (warmup key mismatch, released programs) | M/M | Warmup in the real scene into a HalfFloat target with one real draw; pinned materials; `programs` constant QA assertion | WP9/WP14 |

---

## Appendix A: API facts verified in `node_modules` (three 0.186.1, postprocessing 6.39.5, n8ao 2.0.1, TS 7.0.2, Node 24.19)

**three**
- **Render-target layers.** `WebGLRenderer.setRenderTarget(rt, activeCubeFace, mip)` binds array/3D layers via `framebufferTextureLayer` for each attachment. `WebGLArrayRenderTarget` with `count > 1` converts only `textures[0]` to an array, so we use single-attachment targets.
- **Render-target mipmaps.** Render-target textures are allocated with mutable `texImage3D`/`texImage2D`. `renderer.render()` ends with `updateRenderTargetMipmap(currentRT)` when `texture.generateMipmaps` is true. So: keep it false while writing layers and enable it before the last draw.
- **Readback.** `readRenderTargetPixelsAsync` requires RGBA/UnsignedByte (or the implementation-defined read format). `initTexture`, `initRenderTarget` and `compileAsync(scene, camera)` exist.
- **Texture re-upload.** A re-upload of an already-allocated texture (`__version` defined, same size) takes the `texSubImage` path (`allocateMemory === false`). That is the basis of the TexturePool reuse.
- **Shader chunk order.** In `meshphysical`, `fog_fragment` comes **after** `colorspace_fragment`. `lights_fragment_maps` adds lightmap irradiance into `irradiance`. `RE_Direct` = `RE_Direct_Physical(IncidentLight{color, direction, visible}, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight)`. `aomap_fragment` scales `indirectDiffuse` and uses `computeSpecularOcclusion`.
- **Attributes.** `WebGLProgram` always declares `attribute vec2 uv`, and declares `attribute vec2 uv1` under `USE_UV1`. Hence the `br*` prefix for custom attributes.
- **Materials.** `Material.copy()` (and so `clone()`) does not copy `onBeforeCompile`. `customProgramCacheKey()` defaults to `onBeforeCompile.toString()`.
- **Shadows.** `WebGLShadowMap`: `PCFSoftShadowMap` has been removed (it warns and falls back to `PCFShadowMap`).
- **Spot cookies.** `WebGLLights`: a spot light with `map` calls `shadow.updateMatrices` even without `castShadow`, so cookies work without shadows. We still cast shadows so the flashlight does not leak.
- **Clustered lighting.** `examples/jsm/lighting/ClusteredLighting.js` imports `three/webgpu`, so it is not usable here.
- **Lazy geometry upload.** `projectObject` returns early for `visible === false` and only frustum-passing meshes reach `objects.update` (which uploads every attribute via `WebGLGeometries.update`). Hence WP10's forced upload render (with `scene.overrideMaterial`, honoured only when `material.allowOverride === true`).
- **Program cache key.** `WebGLPrograms` keys on `outputColorSpace`, which is `renderer.outputColorSpace` with no render target bound but `ColorManagement.workingColorSpace` for any render target: warmup must compile with a render target bound, as the composer does.
- **Multiscatter.** `lights_fragment_begin` sets `material.dfg` always but `material.multiScatteringCompensation` only when punctual lights exist; `RE_Direct_Physical` multiplies specular by it.
- **Blending of opaque materials.** `WebGLState.setMaterial` disables blending only for `NormalBlending && !transparent`; a non-transparent material with `CustomBlending` is blended and stays in the opaque list (sorted by `renderOrder`). The decal variant relies on this.

**postprocessing**
- The peer range is `three >= 0.168 < 0.187`.
- `EffectPass` sorts effects by attributes, highest first (CONVOLUTION = 2 before DEPTH = 1 before NONE), then merges them. It throws `Convolution effects cannot be merged` and `Effects that transform UVs are incompatible with convolution effects` (`mainUv`).
- `SMAAEffect` and `ChromaticAberrationEffect` are CONVOLUTION effects.
- `ToneMappingMode.AGX = 7` is the default mode.
- `BloomEffect` options: `mipmapBlur`, `levels`, `radius`, `intensity`, `luminanceThreshold`, `luminanceSmoothing`; `luminanceMaterial.threshold` is settable.
- `Effect(name, fragmentShader, { attributes, blendFunction, defines: Map, uniforms: Map, extensions, vertexShader })`.
- `EffectComposer` takes `{ frameBufferType, multisampling }`.

**n8ao**
- No `.d.ts` ships with the package.
- **Transparency detection.** The `N8AOPostPass` configuration Proxy disables `autoDetectTransparency` **only when `transparencyAware` changes value** (the default is already false). `detectTransparency()` otherwise traverses the scene every frame and flips on transparency rendering when it sees a transparent material. We therefore set `pass.autoDetectTransparency = false` directly.
- **Gamma.** `gammaCorrection` defaults to true. Setting it clears `autosetGamma`.
- **API.** `setQualityMode('Performance'|'Low'|'Medium'|'High'|'Ultra'|'Neural-*')` and `setDisplayMode('Combined'|'AO'|'No AO'|'Split'|'Split AO')`.

**Toolchain**
- **TypeScript.** `tsc` 7.0.2 accepts `allowImportingTsExtensions`, `erasableSyntaxOnly` and `verbatimModuleSyntax`. The §4 contracts compile under them.
- **Node.** Node 24.19 runs `.ts` modules directly (type stripping) with `.ts` specifiers; the core modules ran under it.
- **Types.** `@types/node` is not installed yet; WP0 adds it.
