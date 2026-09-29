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

### 2026-09-28 — textiles: pile visibility, nap, rebuilt carpet / fabric recipes and D0 / D1 / D7 — APPLIED
- **Status:** APPLIED by lane A on its branch (merge pending). EON sigma (task 4) waits for 0b (`sigma` stays 0).
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
  - the Level 0 pile trap moved from `gl_FragColor` (preFog, now empty) to the diffuse (T 0.63 × chroma^0.3);
  - postDetail sets `brAm = 1` on pile layers (their detail multiplier is applied as visibility in matPost);
  - a lane that wants to scale a punctual light's diffuse apart from the baked light's (the planned torch retro term)
    needs a core hook between lights_fragment_begin and the baked light; none exists, so lane A left it out;
  - the carpet grime branch overrides `wet` / `brWet` with a narrow wicking front (the porosity model's absorption
    therefore follows it on carpets) and writes `brOrmh.r` in worn lanes;
  - `brPileLean` (surface.ts) is no longer written; the sheen roughness no longer follows the lean (TUNE
    `CARPET_PILE_SHADE`, `CARPET_PILE_CELL`, `SHEEN_LEAN_ROUGH`, `CARPET_WEAR_LIGHTEN` are now unused);
  - debug view 25 `textile`: r = Dv, g = nap diffuse factor / 2, b = 0.5 + 0.5 s.
- **Stale WP9 text (lane 0's paragraphs):** the WP9 sheen sentence ("colour = amount · sqrt(albedo) …, roughness
  from the pile lean") and the carpet grime bullet describe the old model; DESIGN.md WP8 "Lane A: textiles" has the
  current one.
- **Budget:** the opaque pass measured +0.11-0.14 ms at high (noise ±0.1-0.2 ms), over the lane's +0.03 ms; ultra
  not measured; generation times unchanged within noise; 0 MB (DESIGN.md WP8 lane A, Cost).
- **Consumers affected:** lane 0b (EON: textile `sigma` to be set by lane A after the merge; FRAG_DIRVIS must skip
  `pile.x > 0` as planned, Dv replaces it); the integrator (gallery calibration: gallery 11 carpet / wall ratio is
  within 1 % of a5c03e1 at high and medium).

## Lane B: concrete, terrazzo, floor paint

## Lane C: masonry and tile

## Lane D: walls and ceilings

## Lane E: props
