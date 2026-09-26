# Contract change proposals — WP9

(none yet — see TEMPLATE.md)

## 2026-09-24 — MaterialGlobals.reflY (reflected plane height)
- **WP:** WP9
- **Change:** in `src/core/runtime.ts` `MaterialGlobals` (after `reflOn`, line 63) add
  `reflY: { value: number }; // world y of the plane currently mirrored by PlanarReflection (valid when reflOn = 1)`
- **Rationale:** the WP9 spec (§5 WP9, "Planar reflection" and "Water material") has shaders compare each surface's plane
  height against `uReflY` (±2 cm) to decide whether to sample `reflTex`. `createPlanarReflection(globals, q)` receives only
  `MaterialGlobals`, which has `reflTex`/`reflMatrix`/`reflOn` but no plane height, so the reflection cannot publish it.
  Workaround until merged: a WP9-private `WeakMap<MaterialGlobals, { value: number }>` shared by PlanarReflection.ts and
  the material factory.
- **Consumers affected:** WP9 only (additive; WP10/WP11 never read it).

## 2026-09-24 — Debug-view output scale (documentation only, no code change)
- **WP:** WP9
- **Change:** document in `src/core/ids.ts` next to `DebugView` (comment only):
  `// Debug views write a display value v in [0,1] as v * 1.2 * 2^PHOTOMETRY.EV100_L0 nits (linear), so they read as v`
  `// through the normal post stack at the L0 reference exposure (EV100 9.4, inside every atmosphere's ev100Range).`
  `// Pages that bypass exposure must multiply by 1 / (1.2 * 2^EV100_L0) (= 1/811) before display.`
- **Rationale:** the game shows debug views (`view=`, F4, QA `views`/`leak-direct` presets) through PostStack with
  auto exposure clamped to ev100Range (e.g. [6.5, 11]); raw 0..1 values would be ~black there. `harness/chunk.html`
  (WP10) currently passes debug views through without exposure (`quadMat.toneMapped = false`), which saturates them
  to white; it should instead apply exposure EV100_L0 for debug views (e.g. keep `toneMapped = true` and set
  `renderer.toneMappingExposure = 1 / (1.2 * 2 ** 9.4)` when `view != final`).
- **Consumers affected:** WP10 (src/harness/chunk.ts debug-view display), WP14 (none: already goes through post).

## 2026-09-24 — PROP_AUX aux.x = per-part roughness override (WP6 already writes it)
- **WP:** WP9 (consumer side of an undocumented WP6 extension)
- **Change:** `src/core/ids.ts` VFlag.PROP_AUX comment: `brAux = (roughness override byte (0 = none; r = x/255), 0, bits, ceilCm/5)`.
- **Rationale:** src/props/builder.ts writes `aux.x = round(rough * 255)` for glossy parts (car paint, CRT glass). WP9's
  props shader now honours it (`roughness = aux.x / 255` when non-zero, before Toksvig); with aux.x = 0 behaviour is
  exactly the contract's.
- **Consumers affected:** WP6 (producer), WP9 (consumer). No other reader of PROP_AUX aux.x exists.

## 2026-09-25 — Spec text alignment for three WP9 shading details (documentation only, no contract/API change)
- **WP:** WP9
- **Change (DESIGN.md §5 WP9 text only):**
  1. *Baked lighting, ambient part.* Replace `irradiance += (1.0 - w) * E + Ef;` with `irradiance += Ef;` and keep
     `iblIrradiance += (1.0 - w) * E; radiance += (1.0 - w) * E / PI;`. In r186 `RE_IndirectSpecular_Physical`
     computes the energy-conserving indirect diffuse from `iblIrradiance` (`indirectDiffuse = diffuse * iblIrradiance / PI`)
     and `RE_IndirectDiffuse_Physical` adds `irradiance` on top, so the spec text doubles the ambient diffuse.
  2. *Emission-map reflection, step 5 (fade).* Replace `1 − smoothstep(0, EMISSION.FADE, distance)` with: fade by the
     horizontal offset between fragment and hit over the last `FADE·(1 − EM_FADE_START_FRAC)` metres of
     `reach = min(EMISSION.FADE + distance(fragment, nearest tile line), EM_MAX_REACH)`. Every accepted hit then still
     lies inside the 88² map (tile ± MARGIN), the reach is continuous across tile lines (no seams), and wet floors in
     tile interiors show long troffer streaks (with the literal 3.6 m fade the streaks are barely visible, which fails
     the "troffer reflection streaks on wet vinyl" acceptance item).
  3. *Emission-map reflection gate.* Replace the hard `roughness < 0.5` with a weight
     `1 − smoothstep(0.5, 0.6, roughness)` (skip when 0). Below 0.5 the result is unchanged; the soft tail stops
     textured roughness from speckling reflections on and off per pixel and gives damp carpet (wet roughness 0.55) a
     faint blurred sheen of the lamps (acceptance: "specular sheen on damp carpet").
  4. *Hex stochastic tiling* also runs on vertical faces of hex layers, on (along-wall, storey-relative y) with an even
     row count per STOREY_PITCH (tower periodicity; see `hexLattice()` in src/materials/chunks/params.ts).
- **Rationale:** the shaders already implement these (src/materials/chunks/lighting.ts, common.ts, surface.ts); the
  spec text should match so later readers do not "fix" them back.
- **Consumers affected:** none (WP9-internal shading).
