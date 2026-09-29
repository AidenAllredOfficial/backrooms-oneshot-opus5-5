# Contract changes — texture realism v2 (TEX2)

One append-only section per lane; each lane appends entries under its own heading only (format as in TEMPLATE.md:
date, title, change, rationale, consumers). The conventions themselves are in DESIGN.md WP8 / WP9 ("Texture realism
v2 conventions").

## Lane 0: foundation

### 2026-09-28 — 0a: file split, recipe rows, channels, reserved ids and slots, hook points — APPLIED
- **Status:** APPLIED by lane 0 (0a). Bit-identical: `node tools/ab.mjs --base a5c03e1 --expect same` on the 28
  gallery framings at high and 4 at medium reports 0 changed pixels.
- **`src/core/ids.ts`** (append-only):
  - `Mat.CMU_RAW = 28`, `Mat.METAL_BARE = 29`; `MAT_COUNT = 30` (was 28). Nothing places them in the world yet.
  - `DebugView.AUX = 24`, `TEXTILE = 25`, `RELIEF = 26`; `DEBUG_VIEW_NAMES` gains `'aux', 'textile', 'relief'`.
- **`src/core/materials.ts`:**
  - `GrimeProfile` gains `'paint'` (id 7) and `'masonry'` (id 8).
  - Rows: TRIM_PAINT and DRYWALL `grime: 'wallpaper'` → `'paint'`; CMU_PAINTED `'concrete'` → `'masonry'` (the new
    branches are verbatim copies, so nothing renders differently).
  - New rows 28 CMU_RAW (repeat 2.4, repeatY 1.0, albedoMean [0.22, 0.215, 0.20], roughness 0.9, metal 0, grime
    masonry, sound CONCRETE, absorption 0.07) and 29 METAL_BARE (repeat 0.6, albedoMean [0.56, 0.56, 0.56], roughness
    0.3, metal 1, grime metal, sound METAL, absorption 0.03).
- **`src/textures/layers/types.ts`:** `RecipeBody = { glsl, normalStrength, heightScale, trim?, phys, aux?, aux2?, frame? }`,
  `SurfacePhys` (moved from chunks/params.ts) with the v2 fields `sigma`, `pile`, `detRep`, `detTint`, `detSO`, `dirt`,
  `wear`, `reliefM` (neutral defaults through `phys()`), `AuxKind` and `AUX_KIND_ID`. The `TRIM` table of
  `textures/registry.ts` and the `SURFACE_PHYS` literal of `chunks/params.ts` moved into the family recipe files;
  `LAYER_RECIPES_FULL` rows carry `trim`, `phys`, `aux`, `aux2` and the resolved `frame`.
- **Generator:** `Surf` gains `float aux` and `vec2 lean`; ormh.a (and ormh.b on `lean` layers) follows `AUX_KIND`;
  `frame` drives `FRAME`, the normal pass's texel metres and the cavity metric.
- **Detail maps:** `DETAIL_COUNT` 12 → 21, reserved neutral slots D12-D20 (`Det` ids in
  `textures/detailRecipes/types.ts`); recipes split into `textures/detailRecipes/*.ts`.
- **Shaders:** the per-layer const arrays `BR_L_*`, `BR_AUX_KIND`, `BR_L_AUX2`, the grime ids `BR_G_*`, the channel
  decode at main scope (`brAux`, `brAux2`, `brLean`, `brRotM`, `brRotC`, `brAm`; `brMuH` and `brRel` as read-only
  expressions, fetched per use), the debug early exit `BR_DEBUG_EXIT` (views 24-26) and the family hook points
  (`src/materials/chunks/family/*.ts`; each point starts with the marker `// ---- family hooks: <point>`, present even
  when no family has code there, and every hook's code ends a line). No new uniforms or samplers; the five layer
  uniform arrays grow with MAT_COUNT (+10 vec4).
- **Generator frame invariant:** `frame[0]` is the layer's `repeat` and `frame[1]` its `repeat` or `repeatY` (the
  mesher maps u over `repeat` on every face, v over `repeat` on horizontal and `repeatY` on vertical faces), checked by
  tests/textures/registry.test.ts.
- **Consumers affected:** every v2 lane (they code against these); `src/world/testScenes.ts` (the `materials` scene keeps
  its 28 layers); `tests/materials/factory.test.ts` (layer table length from MAT_COUNT).

### 2026-09-28 — 0b: EON diffuse, linear cavity visibility, dirt / wear, detail controls, grime helpers — APPLIED
- **Status:** APPLIED by lane 0 (0b). Every per-layer parameter stays at its neutral default. The one change at the
  defaults is the visibility term, which only moves joints, grout, pits and perforations. With `DIRVIS.LINEAR = false` the 28 gallery framings (high) and
  4 medium framings are bit-identical to 0a.
- **`RE_Direct`** is `brRE_Direct` in every surface program (`chunks/brdf.ts`, defined in the clipping_planes_pars slot):
  three's `RE_Direct_Physical` taken from ShaderChunk at build time, plus EON minus Lambert where the global
  `float brDiffSigma` > 0. It covers the baked lobe and the flashlight. `brDiffSigma` is set in material post from
  `BR_L_SIGMA` and the detail / Toksvig variance; family matPost hooks may rescale it. EON keeps the directional
  albedo at ρ (ρ_ms = ρ).
- **`FRAG_DIRVIS_GLSL`** (`chunks/pom.ts`): `vis = 1 − (1 − V)·g`, linear in the cavity. g is twice the cosine-weighted
  mean sin²θ of a light cap whose resultant length R_d is estimated from w and N_g·L (fitted to full bakes, see DESIGN
  WP9), capped at 2 so the term stays linear down to V = 0.5. It replaces the smoothstep cone and skips layers with
  `BR_L_PILE.x > 0`. POM self-shadow is unchanged, and lighting.ts is not edited.
  - Median joint / face luminance (a5c03e1 → this, cavity components from the relief view): WAREHOUSE CMU g08
    0.884 → 0.789, PIPEWORKS corridor CMU g09 0.743 → 0.851, CONCRETE spawn g05 0.908 → 0.884, POOLROOMS g12
    0.953 → 0.940, RESTROOM tile g13 0.879 → 0.869. The plan's ≤ 0.75 is not met: overhead light reaches most of a
    joint, and a term linear in V cannot draw a pit's hard shadow under raking light. Darker joints are for the
    lanes' dirt (BR_L_DIRT).
  - Flat-face means move 0 to +0.7 %.
  - The same wall patch at 1.5 m and 6 m changes by −1.75 % and −1.80 % (no mip bias; the old cone: −0.77 % and
    −0.15 %).
  - SERVER_ROOM (g20): the perforated rack doors get 14 % brighter than under the cone, which had blacked out their
    holes; auto exposure darkens the rest of that frame by about 1 %.
- **Grime block:** relief-aware dirt / wear after the profile chain, inside `if ( brGrime != 0 )`, compiled in by
  `#define BR_RELIEF_GRIME` (1 once a row sets `dirt[3]` or `wear[3]` > 0). Dirt raises ormh.g by 0.12 × dirt. Wear
  reads `brRel`, the relief above the layer's mean plane, which is not local convexity.
- **Detail block:**
  - `BR_L_DETREP` scales brDetUv, brDetDx and brDetDy before the postSample hooks, and the ripple compensates for it.
  - 'detailMask' layers multiply `brDetL.y` by brAux after postSample.
  - `BR_L_DETTINT` is applied after the grey multiplier.
  - `BR_L_DETSO` scales the inline indirectSpecular after FRAG_AO_REFL, before the postLight hooks.
- **New helpers** (`chunks/grimeLib.ts`, in the common block before the family pars):
  `float brHeightBlend(m, rel, K, E)` and `void brStainFront(s, fine, L0, out inside, out tide)`. brStainFront calls
  fwidth, so use it only in quad-uniform control flow.
- **Harness:** `stats().auxRange` gives, per layer, the aux kind and the min / p2 / p98 / max of ormh.a's 32² cell means
  (checks=range).
- **Tests:** `tests/materials/brdf.test.ts` covers the EON twin and white furnace, the override text, the visibility
  against a ray-marched reference and its R_d estimate against two full bakes (sweep), and the grime helpers.
  samplerBudget pins the high / ultra units (16 / 16 / 15 / 13) and adds a fragment uniform-vector census: at most
  +10 vec4 over a5c03e1, packed ≤ 224. High and ultra pack to 218-219, so 5 vec4 of headroom is left, and nothing in
  v2 may add a uniform. params.test covers the wiring points.
- **Cost** (`__backrooms.gpuBench`, whole frame, 3 interleaved rounds against 0a):
  - At the defaults: +0.01 / −0.02 ms at high (1600x900, g05 / g08), and +0.05 to +0.14 ms at ultra (2560x1440,
    within round-to-round noise). With the bake-fitted R_d estimate (review): +0.011 / +0.017 / −0.004 ms at high
    (g05 / g08 / g15, 2 rounds; 0a itself moved 0.027 ms between rounds).
  - All-zero const arrays let the compiler drop a feature's code. Once any layer sets a parameter, every surface
    program carries that code, and the register pressure costs the whole shader even with no such pixel on
    screen. Presence-only cost at ultra, with the parameter set on the unplaced METAL_BARE: EON +0.16 to +0.28 ms,
    dirt +0.08 to +0.32, wear +0.17 to +0.24 (brRel's 1x1-mip fetch), detSO +0.12 to +0.16, detTint ~0.
  - With all of them on CONCRETE_FLOOR and CMU_PAINTED and in view, high costs +0.05 ms (g05) and +0.12 ms (g08,
    a CMU wall filling the screen).
  - Lanes that switch these on should say so in their cost reports. The integrator should budget the union, since
    each program is shared across layers.
- **Consumers affected:**
  - Lanes A-E set `sigma`, `pile`, `dirt`, `wear`, `reliefM`, `detRep`, `detTint` and `detSO` in their rows.
  - Lane A: a pile layer (`pile.x > 0`) loses the cavity visibility of the baked light, so its textile hooks must
    carry it.
  - The SSR agent: lighting.ts is untouched, but the RE_Direct macro it calls now resolves to `brRE_Direct`.

## Lane A: textiles

## Lane B: concrete, terrazzo, floor paint

## Lane C: masonry and tile

## Lane D: walls and ceilings

### 2026-09-29 — D: wall and ceiling recipes, stain fronts, seepage tongues, wall damage, tile states — APPLIED
- **Status:** APPLIED on the lane branch (not yet merged). World layout output is unchanged (golden.json untouched);
  the bake's mask R and the diffuser throat's vertex tint change.
- **`src/core/materials.ts`** (rows 0 and 7 only): WALLPAPER_L0 roughness 0.7 → 0.52 (satin vinyl), DRYWALL 0.85 →
  0.62 (eggshell). albedoMean unchanged on every row, PLENUM included (props use PLENUM as black).
- **`src/bake/mask.ts`** (R only): R is now the wet extent, not a drawn stain. Wall stains (leak bands, rising damp)
  stay at or below `STAIN_MAX` = 0.65. Seepage runnel zones take `SEEP_R0` = 0.7 .. 1 and encode the runnel's progress
  t as R = SEEP_R0 + (1 − SEEP_R0)(1 − t). Zones are tongues (`seepZoneR`: narrowing down the wall, wandering sides,
  a rounded tip, R falling to 0 over `SEEP_EDGE` = 0.15 m), so the fronts drawn along their outline are organic. The
  ceiling cos rings and the wall tide band are gone; ceilings near a leak get the wet extent (0.5 + 0.5 s)(1 − d / 0.9).
  Exports `STAIN_MAX`, `SEEP_R0`, `SEEP_EDGE`, `SEEP_TIP`, `seepZoneR` (tests/bake/mask.test.ts covers the tongue).
- **Recipes** (`textures/layers/wallpaper.ts`, `ceiling.ts`): WALLPAPER_L0, WALLPAPER_MANILA, DRYWALL, CEILING_TILE
  and PLENUM rewritten; trims re-measured (PLENUM [0.895, 0.905, 0.916]). `SurfacePhys`: σ 0.6 on CEILING_TILE and
  PLENUM (turns on 0b's EON code in every surface program until another lane does); the wall layers stay Lambert and
  no lane D layer sets `dirt` (σ 0.2 on paint and paper and dust in the fissures cost 0.02-0.04 ms at high for a
  barely visible change); WALLPAPER_L0 `detRep` 0.5 (D2) like MANILA (D17); 'detailMask' aux on WALLPAPER_L0 (0.6 on
  ink), DRYWALL (0.6 on joints) and CEILING_TILE (1 − bar).
- **Detail maps** (`detailRecipes/walls.ts`): D2 84 threads at the 0.15 m repeat, D5 grain and pinholes, D16
  ROLLER_STIPPLE and D17 LINEN filled. `slope` (the pack's range) is ~2.5x each map's rms slope: D2 0.18, D5 0.04, D16
  0.12, D17 0.15 (at 0.2-0.45 the RGBA8 variance rounded to 0). D3 PAINT is unchanged (shared with TRIM, CMU and
  METAL_PAINTED).
- **Family hooks** (`chunks/family/walls.ts`, `ceiling.ts`): grime profiles 2 (wallpaper), 7 (paint) and 3
  (ceilingTile). Exports `WALL_STAIN` and `CEIL_STAIN`; `brWlFronts`, `brWlMetricGrad`, `brWlNoise`, `brWlLine`,
  `brWlDot` and `brWlEdgeDist` are GLSL helpers in the walls family's `pars` (the ceiling family calls `brWlFronts`).
  The analytic relief of seams, flaps, cockle, pops, blisters and the tile states is a world-space height gradient
  (`brWlBump`, `brClBump`) added in the `normal` hooks. postSample divides out surface.ts's ±3 % per-roll shade and
  applies ±0.8 % (one dye lot) plus a per-roll sheen. No new uniforms or samplers.
- **`chunks/emitters.ts`** (lens aging only): `brLensAge` on PRISM and OPAL lenses (5-15 insect silhouettes and a dust
  gradient toward one end), divided by its own mean so each lens still emits what the bake assumed.
- **`src/mesh/ceilings.ts`** (plenum throat tint only): the diffuser throat's PLENUM tint 0.08 → 0.35.
- **Cost** (against tex-integ, gpuBench whole frame, gallery 03 / 11 / 14 / LOBBY ceiling): high +0.19 / +0.17 /
  +0.14 / +0.09 ms, ultra +1.84 / +1.37 / +1.17 / +0.55 ms, over the plan's +0.02 / +0.04 ms. Where it goes is in the
  DESIGN.md lane D section (a per-block bisect; part of it is occupancy of the shared surface program). genMs and
  memory unchanged.
- **Consumers affected:**
  - The concrete and masonry grime profiles (lanes B and C) still draw R above their threshold as a flat darkening.
    Seepage zones are now 0.44-0.68 m tongues (the old wall streaks were 8-45 cm), so on CMU and concrete walls they
    read as soft grey tongues (gallery 06, 05). To draw fronts, halo and runnels instead, those profiles can call
    `brWlStain` (walls family `pars`, present in every surface program) or treat R ≥ SEEP_R0 as a runnel zone.
  - Lane E: props borrowing DRYWALL, TRIM_PAINT or PLENUM get the new recipes; PLENUM's mean is unchanged.
  - D3 PAINT is untouched.

## Lane E: props
