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

### 2026-09-28 — C: CMU and tile recipes, D6 / D14 / D15, world block variation, CMU_RAW placement — APPLIED
- **Status:** APPLIED by lane C on its branch. `LAYER_DEFS` rows 8, 12, 13 and 14 keep their numbers (the recipes are
  trimmed to them). Row 28 CMU_RAW `albedoMean` [0.22, 0.215, 0.2] -> [0.28, 0.274, 0.255] (sRGB 144, 143, 138): D15
  folds the grain cavity into its albedo multiplier (mean 0.887), so the rendered face is ~0.25, the middle of natural
  grey block; at 0.22 the PIPEWORKS walls rendered at ~0.195 and read near-black under the zone's bulbs.
- **Channels:** CMU_PAINTED and CMU_RAW use aux `'detailMask'` (ormh.a 1 on faces, 0.3 in the joints; the masonry hooks
  also read it as the face / joint share). POOL_TILE and POOL_MOSAIC use aux `'mask'` = grout coverage (the tile hooks
  colour the grout along its lines in world space and the tile grime reads it instead of the roughness heuristic).
- **Detail slots:** D14 CMU_FACE and D15 CMU_RAW filled (rms slope 0.39 / 0.44, cavity folded in at exponent 1); D6
  GLAZE rewritten (waviness at 25 and 12 mm, rms slope 0.0046, sparse pinholes; heightScale 0.00018, S 0.02, roughK
  0.1, cavity 0.3).
- **SurfacePhys:** CMU_PAINTED `det: 14, detS: 1, pomTop: 0.95, sigma: 0.2`; CMU_RAW `det: 15, detS: 1, pomTop: 0.95,
  tok: 0.8, sigma: 0.3` (sigma is the facet roughness below the detail map: 0b adds the unresolved detail variance, so
  far walls reach ~0.33 / 0.43); POOL_TILE `pomTop: 0.76, roughComp: 0.8`; POOL_MOSAIC `pomTop: 0.8, roughComp: 0.8`;
  VINYL_VCT `glaze: 0.22, roughComp: 0.7`. No `dirt` / `wear`.
- **0b costs measured by lane C** (ultra 2560x1440, gpuProfile RenderPass, 3 interleaved rounds against tex-integ at
  ff42a23): a relief dirt amount on CMU compiled the dirt / wear block into every surface program, +0.63 ms in
  POOLROOMS with no CMU on screen (so lane C sets none); brStainFront on every CMU wall pixel +0.2 ms on a full-screen
  wall (not used); EON on CMU (sigma 0.2) +0.65 ms on a full-screen CMU wall (g08), kept. The integrator budgets EON
  once for the union of layers that set sigma. Final lane head against tex-integ (RenderPass, 3 rounds): high +0.00 to
  +0.08 ms, ultra -0.05 to +0.27 ms on gallery 05, 08, 09 and 12; without the CMU sigma the head measures at or below
  tex-integ, so the remainder is EON (+0.3-0.6 ms at ultra on CMU-filled frames).
- **World output:** PIPEWORKS' palette (`wallMat`, `trimMat`) and the transition service corridors / loading bays
  (`transitions.ts`) use CMU_RAW; tests/world/golden.json regenerated. Raw block reflects about half of what the
  painted block did, so PIPEWORKS frames are darker: frame mean luminance -35 % (gallery 09) and -46 % (gallery 10, a
  wall close-up) at high. That is the material, not a bug; if the zone should keep its old brightness, its bulbs
  (lighting, not lane C) are the knob. `world/content/decals.ts` places wall CRACK
  decals only on CONCRETE_WALL and CMU_PAINTED, so PIPEWORKS walls lost theirs (not lane C's file; adding CMU_RAW to
  that filter restores them).
- **Hooks (chunks/family/masonry.ts):** main-scope names `brMsOn`, `brMsDet` (postSample; read by postDetail and
  grime); `brMsKey()` and `BR_M_CMU_PAINTED` / `BR_M_CMU_RAW` in pars. postDetail scales the detail by the block's
  texture class only (0b's detail block applies the 'detailMask' channel; the pre-0b shim is gone). The rough hook adds
  D14 / D15's E[s^2] (0.12 / 0.18) to alpha^2 under
  `#ifndef BR_DETAIL_MAPS`, then caps painted CMU at `CMU_PAINTED_MAX_ROUGH` = SSR.ELIG_ROUGH - 0.03 (imported from
  `post/ssr/ssrGlsl.ts`): blocks around the G-buffer eligibility cut switched paths per block with distance.
- **Found for the SSR / probe owners:** the probe's roughness fade (ROUGH0 0.5 to ROUGH1 0.65) sits inside painted
  CMU's range (0.52 close, 0.67 far), so small roughness steps become lamp-reflection steps (the inline fallback of a
  0.65 lobe has no lamp reflection at all). Painted CMU's flashing is kept at +-0.05 for it.
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
