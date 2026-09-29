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

## Lane A: textiles

## Lane B: concrete, terrazzo, floor paint

## Lane C: masonry and tile

### 2026-09-28 — C: CMU and tile recipes, D6 / D14 / D15, world block variation, CMU_RAW placement — APPLIED
- **Status:** APPLIED by lane C on its branch. No `src/core/*` change: `LAYER_DEFS` rows 8, 12, 13, 14 and 28 keep
  their numbers (the recipes are trimmed to them).
- **Channels:** CMU_PAINTED and CMU_RAW use aux `'detailMask'` (ormh.a 1 on faces, 0.3 in the joints; the masonry hooks
  also read it as the face / joint share). POOL_TILE and POOL_MOSAIC use aux `'mask'` = grout coverage (the tile hooks
  colour the grout along its lines in world space and the tile grime reads it instead of the roughness heuristic).
- **Detail slots:** D14 CMU_FACE and D15 CMU_RAW filled (rms slope 0.375 / 0.44); D6 GLAZE rewritten (waviness at 25 and
  12 mm, rms slope 0.0046, sparse pinholes; heightScale 0.00018, S 0.02, roughK 0.1, cavity 0.3).
- **SurfacePhys:** CMU_PAINTED `det: 14, detS: 1, pomTop: 0.95, sigma: 0.3, dirt: [0.45, 0.41, 0.35, 1]`; CMU_RAW
  `det: 15, detS: 1, pomTop: 0.95, tok: 0.8, sigma: 0.45, dirt: [0.55, 0.52, 0.46, 1]` (sigma and dirt take effect with
  0b); POOL_TILE `pomTop: 0.76, roughComp: 0.8`; POOL_MOSAIC `pomTop: 0.8, roughComp: 0.8`; VINYL_VCT `glaze: 0.22,
  roughComp: 0.7`.
- **World output:** PIPEWORKS' palette (`wallMat`, `trimMat`) and the transition service corridors / loading bays
  (`transitions.ts`) use CMU_RAW; tests/world/golden.json regenerated. `world/content/decals.ts` places wall CRACK
  decals only on CONCRETE_WALL and CMU_PAINTED, so PIPEWORKS walls lost theirs (not lane C's file; adding CMU_RAW to
  that filter restores them).
- **Hooks (chunks/family/masonry.ts):** main-scope names `brMsOn`, `brMsJ`, `brMsDet`, `brMsTilt` (postSample; read by
  postDetail, grime, normal); `brMsKey()` in pars. postDetail applies `brAux` as the detail strength on CMU while
  `DETAIL_MASK_SHIM = 1`: **set it to 0 when 0b's detail block applies the 'detailMask' channel itself**, or the joints
  get the mask twice. The rough hook adds D14 / D15's E[s^2] (0.12 / 0.18) to alpha^2 under `#ifndef BR_DETAIL_MAPS`.
- **Core issue found (lane 0):** `FRAG_NORMAL_GLSL`'s cotangent frame keeps |T| : |B| = |grad u| : |grad v|, so on
  vertical faces of layers with repeatY != repeat every metric slope along u is scaled by repeatY / repeat (CMU 0.42,
  CONCRETE_WALL 0.63, CONCRETE_FLOOR / CEIL on walls 0.63, METAL_PAINTED 0.83). The masonry postSample undoes it for the
  CMU layers (`brNrm.x *= brLB.x / brLB.y`); **remove that line if the core frame gets normalised per axis.**
- **Hooks (chunks/family/tile.ts):** pars defines `BR_M_POOL_MOSAIC`, `BR_M_VINYL_VCT`; postSample declares
  `brTlWear` (read by rough). VCT lane wear reads mask A on up-facing VINYL_VCT: dormant until the hard-floor wear bake
  (lane B) writes A there (`VCT_SYNTH_WEAR` is a development switch).
- **Consumers affected:** lane 0 (the shim, the frame issue), lane B (mask A on VCT floors), the integrator (golden).

## Lane D: walls and ceilings

## Lane E: props
