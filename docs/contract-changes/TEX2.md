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

### 2026-09-28 — textiles: pile visibility, nap, rebuilt carpet / fabric recipes and D0 / D1 / D7 — APPLIED
- **Status:** APPLIED by lane A on its branch (merge pending), on top of 0b (merged into the lane at ff42a23): EON
  `sigma` L0 0.75, office 0.5, fabric 0.4.
- **`src/core/materials.ts` LAYER_DEFS** (world output; `tests/world/golden.json` does not hash material uvs and is
  unchanged): CARPET_L0 `repeat` 2.4 → 1.2, `hexTile` 1.2 → 0.6; CARPET_OFFICE `repeat` 2.4 → 1.2 (tiles stay 0.6 m).
- **Recipe rows (`textures/layers/carpet.ts`):** CARPET_L0 and CARPET_OFFICE `aux: 'lean'` (ormh.b/a = pile lean;
  no metalness), `phys.pile` L0 [1.0, 0.8], office [1.0, 1.2], FABRIC_PARTITION [0.6, 1.5]; sheen L0 0.3 @ 0.42, office
  0.3 @ 0.55, fabric 0.45 @ 0.65; trims 1.03-1.06 (the office palette now hits the table albedo: its 1.46 / 1.36 /
  1.20 trim is gone); ormh.r of the three is the pile visibility V (means 0.61 / 0.78 / 0.88).
- **Detail maps:** D0, D1, D7 rewritten in place (ids, sizes and slots unchanged); their regular periods are 2, 4
  or 8 texels (other periods beat in the box-filtered mips).
- **Shading (`chunks/family/textile.ts`), for the core owners:**
  - matPost scales `material.diffuseContribution` on layers with `pile.x > 0` (before `brDiffRoom` captures it, so the
    punctual lights, the baked light and the ambient all see it) and postLight divides the generic texture-cavity
    multiply (`brCav`) back out of `reflectedLight.indirectDiffuse`; the hooks read the pile rows through generated
    layer compares, not the dynamically indexed `BR_L_PILE` (same data);
  - the Level 0 pile trap moved from `gl_FragColor` (preFog, now empty) to the diffuse (T 0.69 × chroma^0.3);
  - postDetail sets `brAm = 1` on pile layers (their detail multiplier is applied as visibility in matPost);
  - a lane that wants to scale a punctual light's diffuse apart from the baked light's (the planned torch retro term)
    needs a core hook between lights_fragment_begin and the baked light; none exists, so lane A left it out;
  - the carpet grime branch overrides `wet` / `brWet` with a narrow wicking front (the porosity model's absorption
    therefore follows it on carpets) and writes `brOrmh.r` in worn lanes;
  - postWet raises `brOrmh.r` to 1 on pile layers under standing water and a saturated film (`max( brPuddle, brFilm )`),
    so `brCav`, the specular occlusion and the SSR weight see the water surface, not the tuft gaps; Dv reads the V
    saved before it (`brTxVis`);
  - `brPileLean` (surface.ts) is no longer written; the sheen roughness no longer follows the lean (TUNE
    `CARPET_PILE_SHADE`, `CARPET_PILE_CELL`, `SHEEN_LEAN_ROUGH`, `CARPET_WEAR_LIGHTEN` are now unused);
  - debug view 25 `textile`: r = Dv, g = nap diffuse factor / 2, b = 0.5 + 0.5 s.
- **Stale WP9 text (lane 0's paragraphs):** the WP9 sheen sentence ("colour = amount · sqrt(albedo) …, roughness
  from the pile lean") and the carpet grime bullet describe the old model; DESIGN.md WP8 "Lane A: textiles" has the
  current one.
- **Budget (over):** whole frame against tex-integ 3eb5d47 (`gpuBench(20)`): high +0.24 ms on gallery 00, +0.26
  Level 0 straight down, +0.09 EXECUTIVE_SUITE, +0.03 without textiles; ultra +0.55 / +0.65 / +0.18 / ±0.02, against
  +0.03 / +0.07 allowed. About 0.1 ms of a carpet-filled frame at high is SMAA reacting to the pile's contrast.
  Generation times unchanged within noise; 0 MB (DESIGN.md WP8 lane A, Cost).
- **For lane 0:** `BR_L_SIGMA[ brL ]` (materialPost.ts) and `BR_L_PILE[ brL ]` (pom.ts FRAG_DIRVIS) are dynamically
  indexed const arrays; generated compares (as textile.ts does for its pile gate) measured 0.01-0.04 ms cheaper at high
  once rows are non-zero.
- **Pile gaps:** matPost colours the gaps deeper at the same luminance (`pileGap`): the visibility K becomes
  K + (1 − K) 0.15 (c / m − 1) per channel; the calibrations are unchanged.
- **Consumers affected:** lane 0b (FRAG_DIRVIS skips `pile.x > 0` as planned: Dv replaces it); the integrator
  (gallery calibration: gallery 11 carpet / wall ratio −4 % at high, +3 % at medium against a5c03e1).

## Lane B: concrete, terrazzo, floor paint

### 2026-09-28 — lane B: layer rows, stripe decal uv, hard-floor traffic wear, D12 / D13 — APPLIED
- **Status:** APPLIED by lane B on its branch (for the integrator).
- **`src/core/materials.ts` LAYER_DEFS** (lane B rows only):
  - CONCRETE_FLOOR (9): `repeat` 4.8 → 2.4 (`repeatY` 3.0 kept for the tower risers), `hexTile` 2.4 → 1.2. The recipe
    row declares `frame: [2.4, 2.4]`.
  - CONCRETE_WALL (10): `roughness` 0.85 → 0.78 (the satin plywood-formed skin; torn skin and streaks stay matte).
    `pomTop` stays 0.92 with the face at 0.9: the sheets' lippage only sets them back, so the new fins and stud
    pillowing stay within it (a lower face under a higher top cost ultra frames extra POM march steps).
  - CONCRETE_CEIL (11): `repeat` 4.8 → 2.4 (`repeatY` 3.0 kept), `frame: [2.4, 2.4]`.
  - TERRAZZO (26): `repeat` 2.4 → 1.2, `tileSize` 0 → 0.6 (precast tiles: the shader rotates / flips whole tiles).
  - `albedoMean` unchanged on every row (the bake still bounces the same colours); the trims are re-measured.
- **Mesh output (`src/mesh/decals.ts`, DECAL_PAINT_STRIPE only):** stripe uv is stripe-local metres / repeat: u runs
  across the stripe from 0 at one painted edge to width / repeat, v along it: the world coordinate along the line
  plus a hash of the line (its across coordinate and height), modulo the texture period (`stripeV0`), so the pieces
  a layout clips at chunk edges continue one wear pattern and parallel lines differ. `aux.x` = the stripe width in
  mm (1-255; 255 = 255 mm or wider, no edge flakes). Other decals are unchanged. Consumer:
  `chunks/family/concrete.ts` (edge flakes); tests/mesh/decals.test.ts.
- **WP7 mask A (`src/bake/mask.ts`, the floor damage block):** the carpet traffic wear (corridors, thresholds, lanes
  between openings) also runs on CONCRETE_FLOOR, TERRAZZO and VINYL_VCT at 0.8 x the carpet amplitude; on those hard
  floors every opening also wears an entry fan into its rooms (3 m deep, widening from the door), and texels in a rack
  aisle (1.0-4.2 m between occluder boxes reaching 1-2.5 m above the floor and at least 0.9 m long along the aisle,
  near occluders over 1.8 m) get two wheel tracks 0.45 m either side of the aisle centre (one in aisles under 1.6 m),
  at (0.7 + 0.3 decay) amplitude, fading out over 2 m past the end of a rack row. Under a rack: 0. Consumers: the
  concrete (burnished lanes) and terrazzo (polish loss) responses in `chunks/family/concrete.ts`; VINYL_VCT's
  response is lane C's.
- **Detail maps:** D12 SLAB (heightScale 0.6 mm, S 0.15, roughK 0.3, cavity 1) and D13 POLISH (heightScale 0.8 mm,
  exaggerated to carry the unresolved scratches' slope variance; S 0.045, roughK 0, cavity 0) replace their neutral
  placeholders; D4 CONCRETE_FINE gets stronger grains (±15 %) and more, larger pinholes (4 %, r × 1.3), which also
  reaches its other users (PLENUM, METAL_RUST and the CMU_RAW placeholder).
- **Samplers:** the decal variant references `uBrDetail` (FLOOR_PAINT stripes fetch D12, world-anchored, under
  BR_DETAIL_MAPS): 15 → 16 units at high / ultra. The shell, props and water variants are unchanged.
- **SurfacePhys v2 fields set** (read by the 0b shading block): `sigma` CONCRETE_FLOOR 0.25 (scaled by 1 − the
  traffic-lane burnish in the family matPost hook), CONCRETE_WALL and CONCRETE_CEIL 0.35, TERRAZZO 0; `dirt` on
  CONCRETE_FLOOR, CONCRETE_WALL, CONCRETE_CEIL, TERRAZZO.
- **Hook-local names:** the concrete family's pars declares `BRC_*` defines and `brc*` functions (`brcSlab`,
  `brcJoint`, `brcKerfTap`, `brcSpall`, `brcSlabCrack`); main-scope hook locals are `brc`-prefixed.

## Lane C: masonry and tile

### 2026-09-28 — C: CMU and tile recipes, D6 / D14 / D15, world block variation, CMU_RAW placement — APPLIED
- **Status:** APPLIED by lane C on its branch. `LAYER_DEFS` rows 8, 12, 13 and 14 keep their numbers (the recipes are
  trimmed to them). Row 28 CMU_RAW `albedoMean` [0.22, 0.215, 0.2] -> [0.38, 0.372, 0.346] (sRGB 166, 164, 159),
  light natural grey block; at 0.22-0.28 the PIPEWORKS walls read near-black brown under the zone's bulbs. D15's
  albedo multiplier does not lower it: the shader divides it by the detail's 1x1-mip mean, so the rendered face
  averages the table value.
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
  tex-integ, so the remainder is EON (+0.3-0.6 ms at ultra on CMU-filled frames). Review re-measure (one session, 5
  trees interleaved): gallery 08 ultra +0.63 ms against ff42a23 and +0.41-0.66 ms against 9b8a06f (lane B merged), not
  lowered by dropping the CMU sigma or the block key once lane B's sigma has compiled EON in; gallery 09 within noise.
  The integrator should profile the painted-CMU close-up.
- **World output:** PIPEWORKS' palette (`wallMat`, `trimMat`) and the transition service corridors / loading bays
  (`transitions.ts`) use CMU_RAW; tests/world/golden.json regenerated. Raw block reflects three quarters of what the
  painted block did, so PIPEWORKS frames are darker: frame mean -24 % (gallery 09) and -27 % (gallery 10, a wall
  close-up) at high, +6 % under the torch. Closing the rest would take an albedo of ~0.45, too light for raw grey
  block; if the zone should keep its old brightness, its bulbs (lighting, not lane C) are the knob.
  `world/content/decals.ts` places wall CRACK decals only on CONCRETE_WALL and CMU_PAINTED, so PIPEWORKS walls lost
  theirs (not lane C's file; adding CMU_RAW to that filter restores them).
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
  `brTlWear` (read by rough). VCT lane wear reads mask A on up-facing VINYL_VCT, which lane B's hard-floor wear bake
  writes (entry fans and lanes at 0.8 x the carpet amplitude). It shows where A plus its noise passes 0.25, so mainly
  in decayed areas; maintained floors keep their wax (`VCT_SYNTH_WEAR` is a development switch).
- **Consumers affected:** lane 0 (the shim, the frame issue), lane B (mask A on VCT floors), the integrator (golden).

## Lane D: walls and ceilings

## Lane E: props

### 2026-09-29 — E: prop tint headroom, edge coordinates, wear, metals, wood, plastic, kraft, rubber — APPLIED
- **Status:** APPLIED by lane E on its branch.
- **WP6 contract (props/builder.ts):**
  - Tint: non-emissive PROP_AUX parts store `byte(tint / 2)`, at least 1 (`tintByte`); the props family decodes
    `vBrTint.rgb x 2` at the end of postSample (brA is pre-divided by the stored tint, since surface.ts multiplies by
    it after the grime and wetness).
    Emissive parts keep x1. METAL_RUST tints are relative to `RUST_PAINT_REF` 0.3, not the layer mean.
  - lmUv on props (was 0, 0): face-local edge coordinates, `edgeEncode(half mm, s) = 4 max(1, round(half)) + 1 + s`
    per axis (0 = no edge on this axis); decode `h = floor(|x| / 4)`, `s = |x| - 4h - 1`, distance `h (1 - |s|)`. The
    sign of x marks end grain, the sign of y part kind 1 (-0.25 where that axis has no edge). The plan's "aux.y
    part-kind byte" was not usable: aux.y is the thin-tube radius, which the vertex shader widens. `begin()` takes the
    prop scale (edge coordinates are true millimetres); `altKind()` sets part kind 1 until the next material.
  - UVs: GRAIN_LAYERS (WOOD, METAL_PAINTED, METAL_BARE) turn u along each face's longer side; DECORRELATE_LAYERS
    (METAL_PAINTED, METAL_RUST, METAL_BARE, WOOD, PLASTIC, RUBBER) add a hashed per-part offset of up to one repeat
    (emissive parts count as parts, so light states do not shift later offsets); v uses `layerRepeatY` on every layer.
  - Colour tables: DESK_WOOD[2], CONF_WOOD[3] and CRATE_WOOD[3] blue 0.24 / 0.25 -> 0.22 (they clamped at the old
    1x headroom and now fit the 2x one); tests/props/builder.test.ts checks that no prop part clamps.
- **Rows (`LAYER_DEFS`):** METAL_PAINTED roughness 0.45 -> 0.4, metal 0.2 -> 0; METAL_RUST albedo [0.25, 0.14, 0.08] ->
  [0.24, 0.085, 0.028] (the rust palette; paint remnants are runtime), roughness 0.9, metal 0; METAL_GRATE albedo 0.2 ->
  0.095 (20 % bar cover over dark holes), roughness 0.6; WOOD roughness 0.55 -> 0.36; RUBBER albedo 0.05 -> 0.04,
  roughness 0.62. METAL_BARE placed (props only).
- **Channels:** aux 'wear' on METAL_PAINTED (W), METAL_BARE (smudge), METAL_RUST (corrosion order C), WOOD (finish
  wear), PLASTIC (scuffs); 'mask' on RUBBER (bloom); aux2 on METAL_PAINTED (scratch field S).
- **SurfacePhys:** METAL_PAINTED `det 18, detS 1`; METAL_BARE `det 8, detS 1`; METAL_RUST `det 19, detS 1, sigma 0.5`,
  normalStrength 1.5, heightScale 0.003; RUBBER `sigma 0.3`; kraft (PLASTIC part kind 1) sigma 0.5 through the matPost
  hook. Metals sigma 0. No dirt / wear amounts (0b's block stays off for these rows).
- **Detail slots:** D18 ENAMEL (orange peel, heightScale 1.2e-5, S 0.02), D19 RUST_GRAIN (3e-4, S 0.4, roughK 0.1,
  cavity 0.5), D20 KRAFT (8e-5, S 0.05); D10 HAIRCELL 2.5 -> 1.4 mm.
- **Anchor:** `clearcoat_normal_fragment_begin` ('after'; anchors.ts, SurfaceMaterial injectionCode ->
  `PROP_COAT_NORMAL_GLSL`): the props clearcoat uses the shading normal (base map and detail slope).
- **Hooks (chunks/family/props.ts):** one main-scope name, `brWpTop` (postSample; read by grime and matPost); the rest
  of the wear state is scoped inside postSample, which measurably lowered the programs' cost; pars
  `brPropEdgeD`, `brPropEdgeHS`, `brWpExpose` and `BR_M_*` for the prop layers. The rough hook replaces the override
  path for 'wear' layers (their ormh.g already holds the override-scaled topcoat and the exposed layers' roughness).
- **World output:** light-well window band, copier platen and control panel RUBBER -> PLASTIC; children's playroom
  floor RUBBER -> VINYL_VCT; pool lane rope RUBBER -> PLASTIC. tests/world/golden.json is unchanged (the golden chunks
  hash the layout, which these landmarks do not reach at seed 1).
- **Costs:** DESIGN.md lane E (high +0.05 to +0.16 ms whole frame across sessions, RenderPass +0.06 ms; ultra within
  its +-0.5 ms noise; generation +18 to +41 ms). Over the lane budget; the EON sigma on METAL_RUST, RUBBER and kraft is
  the shared presence cost lane B and C already pay.
- **Consumers affected:** lane 0 / WP9 (the new anchor, the props lmUv no longer 0), WP6 (tint and lmUv encoding),
  the integrator.
