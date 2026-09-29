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

### 2026-09-28 — lane B: layer rows, stripe decal uv, hard-floor traffic wear, D12 / D13 — APPLIED
- **Status:** APPLIED by lane B on its branch (for the integrator).
- **`src/core/materials.ts` LAYER_DEFS** (lane B rows only):
  - CONCRETE_FLOOR (9): `repeat` 4.8 → 2.4 (`repeatY` 3.0 kept for the tower risers), `hexTile` 2.4 → 1.2. The recipe
    row declares `frame: [2.4, 2.4]`.
  - CONCRETE_WALL (10): `roughness` 0.85 → 0.78 (the satin plywood-formed skin; torn skin and streaks stay matte).
    Its recipe row moves the face to height 0.84 and `pomTop` 0.92 → 0.96, so the relief top covers the new fins,
    lippage and stud pillowing (no false POM self-shadows).
  - CONCRETE_CEIL (11): `repeat` 4.8 → 2.4 (`repeatY` 3.0 kept), `frame: [2.4, 2.4]`.
  - TERRAZZO (26): `repeat` 2.4 → 1.2, `tileSize` 0 → 0.6 (precast tiles: the shader rotates / flips whole tiles).
  - `albedoMean` unchanged on every row (the bake still bounces the same colours); the trims are re-measured.
- **Mesh output (`src/mesh/decals.ts`, DECAL_PAINT_STRIPE only):** stripe uv is stripe-local metres / repeat: u runs
  across the stripe from 0 at one painted edge to width / repeat, v along it from a per-stripe hashed offset (tile
  independent: hashed from the placement). `aux.x` = the stripe width in mm (1-255; 255 = 255 mm or wider, no edge
  flakes). Other decals are unchanged. Consumer: `chunks/family/concrete.ts` (edge flakes); tests/mesh/decals.test.ts.
- **WP7 mask A (`src/bake/mask.ts`, the floor damage block):** the carpet traffic wear (corridors, thresholds, lanes
  between openings) also runs on CONCRETE_FLOOR, TERRAZZO and VINYL_VCT at 0.8 x the carpet amplitude; on those hard
  floors every opening also wears an entry fan into its rooms (3 m deep, widening from the door), and texels in a rack
  aisle (1.0-4.2 m between occluder boxes reaching 1-2.5 m above the floor and at least
  0.9 m long along the aisle, near occluders over 1.8 m) get two wheel tracks 0.45 m either side of the aisle centre
  (one in aisles under 1.6 m), at (0.7 + 0.3 decay) amplitude. Under a rack: 0. Consumers: the concrete (burnished
  lanes) and terrazzo (polish loss) responses in `chunks/family/concrete.ts`; VINYL_VCT's response is lane C's.
- **Detail maps:** D12 SLAB (heightScale 0.6 mm, S 0.3, roughK 0.3, cavity 1) and D13 POLISH (20 µm, S 0.05) replace
  their neutral placeholders; D4 CONCRETE_FINE gets stronger grains (±15 %) and more, larger pinholes (4 %, r × 1.3),
  which also reaches its other users (PLENUM, METAL_RUST and the CMU_RAW placeholder).
- **Samplers:** the decal variant references `uBrDetail` (FLOOR_PAINT stripes fetch D12, world-anchored, under
  BR_DETAIL_MAPS): 15 → 16 units at high / ultra. The shell, props and water variants are unchanged.
- **SurfacePhys v2 fields set** (neutral until the 0b shading block reads them): `sigma` CONCRETE_FLOOR 0.25,
  CONCRETE_WALL and CONCRETE_CEIL 0.35, TERRAZZO 0; `dirt` on CONCRETE_FLOOR, CONCRETE_WALL, CONCRETE_CEIL, TERRAZZO.
- **Hook-local names:** the concrete family's pars declares `BRC_*` defines and `brc*` functions (`brcSlab`,
  `brcJoint`, `brcKerfTap`, `brcSpall`, `brcSlabCrack`); main-scope hook locals are `brc`-prefixed.

## Lane C: masonry and tile

## Lane D: walls and ceilings

## Lane E: props
