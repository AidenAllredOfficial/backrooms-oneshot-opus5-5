// tests/materials/params.test.ts (WP9) — the per-layer parameter table, the flicker slot lookup, and the periodicity
// rules of every world-anchored shader lattice (NOISE_WRAP horizontally, STOREY_PITCH vertically: towers stay
// periodic and nothing seams at the noise wrap).

import { describe, expect, it } from 'vitest';
import { EMISSION, NOISE_WRAP, STOREY_PITCH, TILE_SIZE } from '../../src/core/constants.ts';
import { MAT_COUNT, Mat } from '../../src/core/ids.ts';
import { LAYER_DEFS, layerRepeatY } from '../../src/core/materials.ts';
import { DYN_SLOT_OFFSETS } from '../../src/core/mesh.ts';
import {
  buildLayerTable, f, glazeUnmix, glslConstants, glslLayerArrays, GRIME_ID, hexLattice, slotLut, SURFACE_PHYS, TUNE,
} from '../../src/materials/chunks/params.ts';
import { DETAIL_COUNT, DETAIL_RECIPES, DETAIL_REPEAT, DETAIL_RIPPLE } from '../../src/textures/detail.ts';
import { AUX_KIND_ID } from '../../src/textures/layers/types.ts';
import { LAYER_RECIPES, LAYER_RECIPES_FULL } from '../../src/textures/registry.ts';
import { readFileSync } from 'node:fs';
import { ShaderLib } from 'three';
import { buildSurfaceFragment } from '../../src/materials/SurfaceMaterial.ts';
import { waterFragmentGlsl } from '../../src/materials/WaterMaterial.ts';
import { FAMILIES, familyHook, type HookPoint } from '../../src/materials/chunks/family/index.ts';

const divides = (a: number, b: number): boolean => Math.abs(b / a - Math.round(b / a)) < 1e-9;

describe('WP9 parameters', () => {
  it('f() always produces a GLSL float literal', () => {
    expect(f(1)).toBe('1.0');
    expect(f(0.5)).toBe('0.5');
    expect(f(32768)).toBe('32768.0');
    expect(f(-3)).toBe('-3.0');
    expect(f(1e-7)).toBe('1e-7');
  });

  it('layer table: rotation cells only for physical tiles, hex cell for hex layers, grime profile ids', () => {
    const t = buildLayerTable();
    expect(t.a.length).toBe(MAT_COUNT * 4);
    expect(t.b.length).toBe(MAT_COUNT * 4);
    for (const d of LAYER_DEFS) {
      const i = d.id * 4;
      if (d.tileSize > 0) {
        // the rotation cell must tile the texture frame exactly (no partial tiles at the repeat edge)
        expect(divides(d.tileSize, d.repeat), d.name).toBe(true);
        expect(t.a[i]).toBe(Math.round(d.repeat / d.tileSize));
        expect(t.a[i]).toBeGreaterThanOrEqual(1);
      } else {
        expect(t.a[i], d.name).toBe(0);
      }
      expect(t.a[i + 2]).toBeCloseTo(d.hexTile ?? 0, 6);
      if ((d.hexTile ?? 0) > 0) expect(divides(d.hexTile!, NOISE_WRAP), d.name).toBe(true);
      expect(t.a[i + 3]).toBe(GRIME_ID[d.grime]);
      expect(t.b[i]).toBeCloseTo(d.repeat, 6);
      expect(t.b[i + 1]).toBeCloseTo(layerRepeatY(d), 6);
      expect(t.b[i + 2]).toBeGreaterThan(0);
      expect(t.b[i + 3]).toBeGreaterThanOrEqual(0);
    }
    // the physical tiles named by the spec rotate; the hex layers named by the spec stochastic-tile
    for (const m of [Mat.CEILING_TILE, Mat.VINYL_VCT, Mat.POOL_TILE, Mat.POOL_MOSAIC, Mat.CARPET_OFFICE]) expect(t.a[m * 4]).toBeGreaterThan(0);
    for (const m of [Mat.CARPET_L0, Mat.CONCRETE_FLOOR]) expect(t.a[m * 4 + 2]).toBeGreaterThan(0);
    // lenses / signs / decals keep exact colours (no macro variation)
    for (const m of [Mat.PANEL_LENS, Mat.SIGNAGE, Mat.DECAL_ATLAS]) expect(t.b[m * 4 + 3]).toBe(0);
  });

  it('SURFACE_PHYS tables C/D/E: shapes, porosity, POM tops, Toksvig weights, detail ids, sheen and glaze lobes', () => {
    const t = buildLayerTable();
    for (const a of [t.c, t.d, t.e]) expect(a.length).toBe(MAT_COUNT * 4);
    const textiles = new Set<number>([Mat.CARPET_L0, Mat.CARPET_OFFICE, Mat.FABRIC_PARTITION]);
    const alphaTested = new Set<number>([Mat.METAL_GRATE, Mat.SIGNAGE, Mat.DECAL_ATLAS, Mat.FLOOR_PAINT]);
    const bimodal = new Set<number>([Mat.POOL_TILE, Mat.POOL_MOSAIC, Mat.VINYL_VCT, Mat.TERRAZZO]);
    for (const d of LAYER_DEFS) {
      const p = SURFACE_PHYS[d.id];
      const i = d.id * 4;
      // C = (heightScale, pomTop, porosity, tok), D = (det, detS, sheen, sheenR), E = (glaze, roughComp, 0, 0)
      expect(t.c[i]).toBe(Math.fround(LAYER_RECIPES[d.id].heightScale));
      expect([t.c[i + 1], t.c[i + 2], t.c[i + 3]]).toEqual([p.pomTop, p.por, p.tok].map(Math.fround));
      expect([t.d[i], t.d[i + 1], t.d[i + 2], t.d[i + 3]]).toEqual([p.det, p.detS, p.sheen, p.sheenR].map(Math.fround));
      expect([t.e[i], t.e[i + 1], t.e[i + 2], t.e[i + 3]]).toEqual([p.glaze, p.roughComp, 0, 0].map(Math.fround));
      expect(p.por, d.name).toBeGreaterThanOrEqual(0);
      expect(p.por, d.name).toBeLessThanOrEqual(1);
      if (textiles.has(d.id)) expect(p.por, d.name).toBe(1);
      // POM: never on hex-tiled (offset-blended) or alpha-tested layers; a normalised height
      if (p.pomTop > 0) {
        expect((d.hexTile ?? 0) > 0 || alphaTested.has(d.id), d.name).toBe(false);
        expect(p.pomTop, d.name).toBeLessThanOrEqual(1);
      }
      expect(p.tok, d.name).toBeGreaterThan(0);
      expect(p.tok, d.name).toBeLessThanOrEqual(1);
      expect(Number.isInteger(p.det) && p.det >= -1 && p.det < DETAIL_COUNT && p.det !== DETAIL_RIPPLE, d.name).toBe(true);
      if (alphaTested.has(d.id) || d.id === Mat.PANEL_LENS) expect(p.det, d.name).toBe(-1);
      expect(p.detS, d.name).toBe(p.det < 0 ? 0 : p.detS);
      expect(p.detS).toBeGreaterThanOrEqual(0);
      // sheen: fibre layers only
      if (p.sheen > 0) expect(p.por, d.name).toBe(1);
      expect(p.sheenR).toBeGreaterThan(0);
      expect(p.sheenR).toBeLessThanOrEqual(1);
      // two-lobe unmixing: exactly the bimodal glaze layers, 0 < glaze < rough component
      expect(p.glaze > 0, d.name).toBe(bimodal.has(d.id));
      if (p.glaze > 0) expect(p.glaze, d.name).toBeLessThan(p.roughComp);
      else expect(p.roughComp, d.name).toBe(0);
    }
    for (const m of [Mat.POOL_TILE, Mat.POOL_MOSAIC, Mat.VINYL_VCT, Mat.PLASTIC, Mat.METAL_PAINTED]) expect(SURFACE_PHYS[m].por).toBeLessThanOrEqual(0.1);
  });

  it('glaze unmixing twin: coverage 0 at the glaze lobe, 1 at the rough component; the lobe stays the glaze', () => {
    const gz = SURFACE_PHYS[Mat.POOL_TILE].glaze, rx = SURFACE_PHYS[Mat.POOL_TILE].roughComp;
    expect(glazeUnmix(gz, gz, rx)).toEqual({ cov: 0, lobe: gz });
    expect(glazeUnmix(rx, gz, rx).cov).toBeCloseTo(1, 12);
    expect(glazeUnmix(rx, gz, rx).lobe).toBeCloseTo(gz, 12);
    // a mip mixing 4 % grout into the glaze: 4 % coverage, glaze-sharp lobe
    const mix = 0.96 * gz + 0.04 * rx;
    expect(glazeUnmix(mix, gz, rx).cov).toBeCloseTo(0.04, 9);
    // glossier texels keep their own roughness; variance widens the lobe by its tilt share only
    expect(glazeUnmix(0.06, gz, rx).lobe).toBeCloseTo(0.06, 12);
    expect(glazeUnmix(gz, gz, rx, 0.1).lobe).toBeCloseTo(Math.sqrt(gz * gz + TUNE.GLAZE_TOKSVIG * 0.1), 12);
  });

  it('wetness and puddle constants are ordered; prop dust and spec AA constants are sane', () => {
    expect(TUNE.PUDDLE_LO).toBeLessThan(0);
    expect(TUNE.PUDDLE_HI).toBeGreaterThan(0);
    expect(TUNE.PUDDLE_W0).toBeLessThan(TUNE.PUDDLE_W1);
    // textiles: water stands over the pile only near saturation, after their film has formed (0.85 -> 0.95 at P = 1)
    expect(TUNE.PUDDLE_PILE_W0).toBeGreaterThan(0.85);
    expect(TUNE.PUDDLE_PILE_W0).toBeLessThan(TUNE.PUDDLE_PILE_W1);
    expect(TUNE.PUDDLE_PILE_W1).toBeLessThan(1);
    // a textile's film is a broad sheen: past high's SSR roughness cut-off
    expect(TUNE.WET_FILM_ROUGH + TUNE.WET_FILM_ROUGH_POROUS + TUNE.WET_FILM_ROUGH_PILE).toBeGreaterThan(0.45);
    expect(TUNE.PUDDLE_ROUGH).toBeLessThan(TUNE.WET_FILM_ROUGH);
    expect(TUNE.WET_DARK).toBeGreaterThan(0);
    expect(TUNE.WET_DARK).toBeLessThan(1);
    expect(TUNE.DUST_MAX).toBeLessThanOrEqual(1);
    expect(TUNE.SAA_KAPPA).toBeLessThan(1);
    expect(TUNE.CARPET_PILE_SHADE).toBeLessThan(0.07); // the sheen lobe supplies the view dependence now
  });

  it('detail, ripple and POM constants are ordered and emitted', () => {
    expect(TUNE.DETAIL_FAR0).toBeLessThan(TUNE.DETAIL_FAR1);
    expect(TUNE.RIPPLE).toBeGreaterThan(0);
    expect(TUNE.RIPPLE).toBeLessThan(0.05); // still water trembles, it does not wave
    expect(TUNE.POM_MIN_PX).toBeLessThan(TUNE.POM_FULL_PX);
    expect(TUNE.POM_MIN_STEPS).toBeGreaterThanOrEqual(1);
    expect(TUNE.POM_MAX_1).toBeGreaterThanOrEqual(TUNE.POM_MIN_STEPS);
    expect(TUNE.POM_MAX_1).toBeLessThanOrEqual(TUNE.POM_MAX_2);
    expect(TUNE.POM_SH_STEPS).toBeGreaterThan(0);
    const g = glslConstants();
    expect(g).toContain(`const float BR_DETAIL_SLOPE[${DETAIL_COUNT}] = float[${DETAIL_COUNT}](${DETAIL_RECIPES.map((r) => f(r.slope)).join(', ')});`);
    expect(g).toContain(`const float BR_DETAIL_ROUGH_K[${DETAIL_COUNT}]`);
    expect(g).toContain(`#define BR_DETAIL_RIPPLE ${f(DETAIL_RIPPLE)}`);
  });

  it('every grime profile has a distinct id; "none" is 0', () => {
    expect(GRIME_ID.none).toBe(0);
    expect(new Set(Object.values(GRIME_ID)).size).toBe(Object.keys(GRIME_ID).length);
  });

  it('slot lookup inverts DYN_SLOT_OFFSETS', () => {
    const lut = slotLut();
    DYN_SLOT_OFFSETS.forEach(([dx, dz], i) => expect(lut[(dx + 1) + 3 * (dz + 1)]).toBe(i));
    expect(new Set(lut).size).toBe(9);
    expect(lut[4]).toBe(0); // own tile = slot 0
  });

  it('world-noise lattices are periodic over NOISE_WRAP (xz) and STOREY_PITCH (y)', () => {
    for (const c of [TUNE.MACRO_CELL, TUNE.MACRO_CELL * 2, TUNE.GRIME_SCALE_A, TUNE.GRIME_SCALE_B, TUNE.FEATURE_CELL,
      0.6, 0.3 /* caustic cells */, 0.6 * 4, 0.3 * 4 /* caustic warp period */]) {
      expect(divides(c, NOISE_WRAP), `${c} | NOISE_WRAP`).toBe(true);
    }
    for (const c of [TUNE.MACRO_CELL_Y, TUNE.GRIME_SCALE_Y_A, TUNE.GRIME_SCALE_Y_B, TUNE.FEATURE_CELL_Y]) {
      expect(divides(c, STOREY_PITCH), `${c} | STOREY_PITCH`).toBe(true);
    }
    // B3 world lattices: carpet pile lean (and its 2x amplitude cell), broadloom widths, wallpaper rolls, concrete
    // control joints, 0.6 m ceiling tiles / tie holes, flooded-room caustic cells (x CAUSTIC_FLOOD_SCALE) + warp
    for (const c of [TUNE.CARPET_PILE_CELL, TUNE.CARPET_PILE_CELL * 2, TUNE.CARPET_BROADLOOM, TUNE.WALL_ROLL, TUNE.CONCRETE_JOINT, TUNE.DUST_CELL,
      0.6 * TUNE.CAUSTIC_FLOOD_SCALE, 0.3 * TUNE.CAUSTIC_FLOOD_SCALE, 0.6 * TUNE.CAUSTIC_FLOOD_SCALE * 4, 0.3 * TUNE.CAUSTIC_FLOOD_SCALE * 4]) {
      expect(divides(c, NOISE_WRAP), `${c} | NOISE_WRAP`).toBe(true);
    }
    // the macro coarse-mip lookup uses one repeat per MACRO_TEX_SCALE horizontally and per STOREY_PITCH vertically
    expect(divides(TUNE.MACRO_TEX_SCALE, NOISE_WRAP)).toBe(true);
    // integer lattice periods emitted as GLSL ints
    const g = glslConstants();
    expect(g).toContain(`#define BR_MACRO_P ${NOISE_WRAP / TUNE.MACRO_CELL}`);
    expect(g).toContain(`#define BR_MACRO_PY ${STOREY_PITCH / TUNE.MACRO_CELL_Y}`);
    expect(g).toContain(`#define BR_FEATURE_P ${Math.round(NOISE_WRAP / TUNE.FEATURE_CELL)}`);
    expect((NOISE_WRAP / TUNE.MACRO_CELL) % 2).toBe(0); // the half-frequency hue octave uses BR_MACRO_P / 2
  });

  it('the sheared hex lattice is periodic over NOISE_WRAP for every hex-tiled layer (brHexWrap twin)', () => {
    // JS twin of the GLSL: lattice coords of a world xz point and the canonical vertex id
    const hexWrap = (i: number, j: number, px: number, pz: number): [number, number] => {
      const k = Math.floor(j / pz);
      j -= k * pz;
      i += k * (pz / 2);
      i -= px * Math.floor(i / px);
      return [i, j];
    };
    const vertexOf = (x: number, z: number, h: number): [number, number] => {
      const sy = z / (h * TUNE.HEX_ROW);
      return [Math.floor(x / h - 0.5 * sy), Math.floor(sy)];
    };
    const hexLayers = LAYER_DEFS.filter((d) => (d.hexTile ?? 0) > 0);
    expect(hexLayers.length).toBeGreaterThan(0);
    for (const d of hexLayers) {
      const h = d.hexTile as number;
      const px = NOISE_WRAP / h, pz = NOISE_WRAP / (h * TUNE.HEX_ROW);
      expect(divides(h, NOISE_WRAP), d.name).toBe(true);
      expect(Math.abs(pz - Math.round(pz)) < 1e-9 && Math.round(pz) % 2 === 0, `${d.name} Pz even`).toBe(true);
      const Px = Math.round(px), Pz = Math.round(pz);
      for (const [x, z] of [[0.31, 0.47], [5.13, 700.9], [1100.2, 13.7], [612.5, 1200.05]]) {
        const a = vertexOf(x, z, h);
        for (const [sx, sz] of [[NOISE_WRAP, 0], [0, NOISE_WRAP], [NOISE_WRAP, NOISE_WRAP], [-NOISE_WRAP, 2 * NOISE_WRAP]]) {
          const b = vertexOf(x + sx, z + sz, h);
          expect(hexWrap(b[0], b[1], Px, Pz), `${d.name} (${x},${z}) + (${sx},${sz})`).toEqual(hexWrap(a[0], a[1], Px, Pz));
        }
      }
    }
    expect(glslConstants()).toContain(`#define BR_HEX_ROW ${f(TUNE.HEX_ROW)}`);
  });

  it('vertical hex lattice: periodic over NOISE_WRAP along the wall and STOREY_PITCH in y, near-equilateral', () => {
    const hexWrap = (i: number, j: number, px: number, pz: number): [number, number] => {
      const k = Math.floor(j / pz);
      j -= k * pz;
      i += k * (pz / 2);
      i -= px * Math.floor(i / px);
      return [i, j];
    };
    for (const d of LAYER_DEFS.filter((l) => (l.hexTile ?? 0) > 0)) {
      const h = d.hexTile as number;
      // horizontal twin matches the original definition
      const hz = hexLattice(h, false);
      expect(hz.cellX).toBe(h);
      expect(hz.px * hz.cellX).toBeCloseTo(NOISE_WRAP, 6);
      expect(hz.pz * hz.row).toBeCloseTo(NOISE_WRAP, 6);
      const v = hexLattice(h, true);
      expect(v.pz % 2, `${d.name} vertical rows even`).toBe(0);
      expect(v.pz * v.row).toBeCloseTo(STOREY_PITCH, 9);
      expect(v.px * v.cellX).toBeCloseTo(NOISE_WRAP, 6);
      expect(v.row / v.cellX).toBeCloseTo(TUNE.HEX_ROW, 2);
      expect(v.cellX / h).toBeGreaterThan(0.5);
      expect(v.cellX / h).toBeLessThan(1.5);
      const vertexOf = (s: number, y: number): [number, number] => {
        const sy = y / v.row;
        return [Math.floor(s / v.cellX - 0.5 * sy), Math.floor(sy)];
      };
      for (const [s0, y0] of [[0.31, 0.47], [5.13, 2.9], [1100.2, -1.3], [612.5, 7.05]]) {
        const a = vertexOf(s0, y0);
        for (const [ds, dy] of [[NOISE_WRAP, 0], [0, STOREY_PITCH], [0, -2 * STOREY_PITCH], [NOISE_WRAP, 3 * STOREY_PITCH]]) {
          const b = vertexOf(s0 + ds, y0 + dy);
          expect(hexWrap(b[0], b[1], v.px, v.pz), `${d.name} (${s0},${y0}) + (${ds},${dy})`).toEqual(hexWrap(a[0], a[1], v.px, v.pz));
        }
      }
    }
  });

  it('emission-map constants: the map covers the tile +- MARGIN and reflections fade out within it', () => {
    expect(EMISSION.RES * EMISSION.TEXEL).toBeCloseTo(TILE_SIZE + 2 * EMISSION.MARGIN, 9);
    expect(EMISSION.FADE).toBeLessThanOrEqual(EMISSION.MARGIN);
    expect(TUNE.EM_FADE_START_FRAC).toBeGreaterThanOrEqual(0);
    expect(TUNE.EM_FADE_START_FRAC).toBeLessThan(1);
  });

  it('every BR_ token in the surface and water shaders is defined (or is a variant / quality define)', () => {
    // variant + quality defines: SurfaceMaterial.applySurfaceDefines / WaterMaterial.applyWaterDefines (every A.0 flag)
    const switches = new Set(['BR_SHELL', 'BR_PROPS', 'BR_DECAL', 'BR_LV', 'BR_FLOOR_REFL', 'BR_AIRLIGHT', 'BR_WATER', 'BR_LITE',
      'BR_SSR', 'BR_PROBE', 'BR_SSAO', 'BR_CS_STEPS', 'BR_PUDDLES', 'BR_DETAIL_MAPS', 'BR_POM', 'BR_SPEC_AA', 'BR_WATER_VOL',
      'BR_WATER_WETBAND', 'BR_CAUSTICS_FULL', 'BR_VOLUMETRIC', 'BR_BOUNCE_N', 'BR_WATER_WAVES', 'BR_WATER_RIPPLE',
      'BR_WATER_DEBRIS', 'BR_WATER_REFRACT', 'BR_WATER_VOLLIGHT']);
    for (const src of [buildSurfaceFragment(ShaderLib.physical.fragmentShader), waterFragmentGlsl()]) {
      const used = new Set(src.match(/\bBR_[A-Z0-9_]+\b/g) ?? []);
      const defined = new Set([...(src.match(/#define (BR_[A-Z0-9_]+)/g) ?? []).map((x) => x.slice(8)),
        ...(src.match(/const (?:int|float|bool|vec[234]|mat2) (BR_[A-Z0-9_]+)/g) ?? []).map((x) => x.replace(/const (?:int|float|bool|vec[234]|mat2) /, ''))]);
      const missing = [...used].filter((u) => !defined.has(u) && !switches.has(u));
      expect(missing).toEqual([]);
      expect(src).toContain('const float BR_LV_Y[6]');
    }
  });
});

describe('texture realism v2 per-layer constants (recipe rows -> BR_L_* const arrays)', () => {
  const g = glslLayerArrays();
  const arr = (name: string): string[] => {
    const m = new RegExp(`const \\w+ ${name}\\[${MAT_COUNT}\\] = \\w+\\[${MAT_COUNT}\\]\\((.*)\\);`).exec(g);
    expect(m, name).not.toBeNull();
    return m![1].split(/,\s*(?![^()]*\))/); // top-level commas only
  };

  it('SURFACE_PHYS is the recipe rows (layers/*.ts RecipeBody.phys)', () => {
    for (const r of LAYER_RECIPES_FULL) expect(SURFACE_PHYS[r.layer]).toBe(r.phys);
  });

  it('emits one entry per layer, in layer order, from the rows; costs no uniforms', () => {
    const rows = LAYER_RECIPES_FULL.map((r) => r.phys);
    expect(arr('BR_L_SIGMA')).toEqual(rows.map((p) => f(p.sigma)));
    expect(arr('BR_L_PILE')).toEqual(rows.map((p) => `vec2(${p.pile.map(f).join(', ')})`));
    expect(arr('BR_L_DETREP')).toEqual(rows.map((p) => f(p.detRep)));
    expect(arr('BR_L_DETTINT')).toEqual(rows.map((p) => `vec3(${p.detTint.map(f).join(', ')})`));
    expect(arr('BR_L_DETSO')).toEqual(rows.map((p) => f(p.detSO)));
    expect(arr('BR_L_DIRT')).toEqual(rows.map((p) => `vec4(${p.dirt.map(f).join(', ')})`));
    expect(arr('BR_L_WEAR')).toEqual(rows.map((p) => `vec4(${p.wear.map(f).join(', ')})`));
    expect(arr('BR_L_RELIEF')).toEqual(rows.map((p) => f(p.reliefM)));
    expect(arr('BR_AUX_KIND')).toEqual(LAYER_RECIPES_FULL.map((r) => String(AUX_KIND_ID[r.aux])));
    expect(arr('BR_L_AUX2')).toEqual(LAYER_RECIPES_FULL.map((r) => String(r.aux2)));
    expect(g).not.toMatch(/uniform/);
    expect(glslConstants()).toContain(g);
    for (const [k, v] of Object.entries(GRIME_ID)) expect(g).toContain(`#define BR_G_${k.toUpperCase()} ${v}`);
    for (const [k, v] of Object.entries(AUX_KIND_ID)) expect(g).toContain(`#define BR_AUX_${k.toUpperCase()} ${v}`);
  });

  it('v2 parameters stay in range; the detail repeat still divides the world periods', () => {
    for (const r of LAYER_RECIPES_FULL) {
      const p = r.phys, n = LAYER_DEFS[r.layer].name;
      expect(p.sigma >= 0 && p.sigma <= 1, `${n} sigma`).toBe(true);
      expect(p.pile.every((x) => x >= 0), `${n} pile`).toBe(true);
      expect(p.detRep, n).toBeGreaterThan(0);
      for (const span of [TILE_SIZE, STOREY_PITCH, NOISE_WRAP]) {
        const k = span / (DETAIL_REPEAT * p.detRep);
        expect(Math.abs(k - Math.round(k)) < 1e-6, `${n} detRep ${p.detRep} vs ${span}`).toBe(true);
      }
      expect(p.detTint.every((x) => x >= 0 && x <= 1), `${n} detTint`).toBe(true);
      expect(p.detSO >= 0 && p.detSO <= 1, `${n} detSO`).toBe(true);
      for (const c of [p.dirt, p.wear]) expect(c.every((x) => x >= 0 && x <= 1), `${n} dirt / wear`).toBe(true);
      expect(p.reliefM, n).toBeGreaterThan(0);
    }
  });

  it('channel conventions: emissive only on lenses and signs, aux2 never on alpha-tested layers, lean layers are not metal', () => {
    const alphaTested = new Set<number>([Mat.METAL_GRATE, Mat.SIGNAGE, Mat.DECAL_ATLAS, Mat.FLOOR_PAINT]);
    for (const r of LAYER_RECIPES_FULL) {
      const n = LAYER_DEFS[r.layer].name;
      expect(r.aux === 'emissive', n).toBe(r.layer === Mat.PANEL_LENS || r.layer === Mat.SIGNAGE);
      if (r.aux2) expect(alphaTested.has(r.layer), n).toBe(false);
      if (r.aux === 'lean') expect(LAYER_DEFS[r.layer].metal, n).toBe(0);
    }
  });

  it('the relief-aware dirt / wear block compiles in only when some layer sets an amount (all 0 today)', () => {
    const on = LAYER_RECIPES_FULL.some((r) => r.phys.dirt[3] > 0 || r.phys.wear[3] > 0);
    expect(g).toContain(`#define BR_RELIEF_GRIME ${on ? 1 : 0}`);
  });

  it('0b wiring: detail repeat, detail mask and tint, dirt / wear, detail specular occlusion, EON sigma', () => {
    const frag = buildSurfaceFragment(ShaderLib.physical.fragmentShader);
    const at = (s: string): number => { const i = frag.indexOf(s); expect(i, s).toBeGreaterThanOrEqual(0); return i; };
    // the detail uv, footprint and ripple follow BR_L_DETREP before the postSample hooks see them
    expect(at('brDetUv /= brDetRep;')).toBeLessThan(at('// ---- family hooks: postSample'));
    expect(at('brDetDx /= brDetRep;')).toBeGreaterThan(at('vec2 brDetDx = dFdx( brDetUv );'));
    expect(frag).toContain('float brRk = BR_DETAIL_REPEAT / BR_RIPPLE_SCALE * brDetRep;');
    // 'detailMask' layers scale the strength after postSample (which may edit brAux), before the fetch
    expect(at('if ( brAuxK == BR_AUX_DETAILMASK ) brDetL.y *= brAux;')).toBeGreaterThan(at('// ---- family hooks: postSample'));
    expect(at('if ( brAuxK == BR_AUX_DETAILMASK ) brDetL.y *= brAux;')).toBeLessThan(at('vec4 brDt = brDetailFetch('));
    // the tint follows the grey multiplier
    expect(at('brA *= 1.0 + ( brAm - 1.0 ) * brDetL.y * BR_L_DETTINT[ brL ];')).toBeGreaterThan(at('brA *= mix( 1.0, brAm, brDetL.y );'));
    // dirt / wear inside the grime block after every family's profile branch, before the wet band
    expect(at('#if BR_RELIEF_GRIME')).toBeGreaterThan(at('// ---- family props: grime'));
    expect(at('#if BR_RELIEF_GRIME')).toBeLessThan(at('float brBand = brWaterWetBand('));
    // detail specular occlusion after the aomap replacement, before the families' postLight hooks
    expect(at('// ---- detail specular occlusion')).toBeGreaterThan(at('reflectedLight.indirectSpecular += brRefl;'));
    expect(at('// ---- detail specular occlusion')).toBeLessThan(at('// ---- family hooks: postLight'));
    // the EON sigma is set before the family matPost hooks (they may rescale it)
    expect(at('brDiffSigma = min( 1.0, sqrt(')).toBeLessThan(at('// ---- family hooks: matPost'));
  });

  it('grime profiles: paint (7) on DRYWALL and TRIM_PAINT, masonry (8) on CMU', () => {
    expect([GRIME_ID.paint, GRIME_ID.masonry]).toEqual([7, 8]);
    for (const m of [Mat.DRYWALL, Mat.TRIM_PAINT]) expect(LAYER_DEFS[m].grime).toBe('paint');
    for (const m of [Mat.CMU_PAINTED, Mat.CMU_RAW]) expect(LAYER_DEFS[m].grime).toBe('masonry');
  });
});

describe('texture realism v2 family hooks (chunks/family/*.ts)', () => {
  const POINTS: HookPoint[] = ['pars', 'postSample', 'postDetail', 'grime', 'postWet', 'rough', 'normal', 'matPost', 'postLight', 'preFog'];
  const frag = buildSurfaceFragment(ShaderLib.physical.fragmentShader);
  const core = ['src/materials/chunks/surface.ts', 'src/materials/chunks/materialPost.ts', 'src/materials/chunks/haze.ts', 'src/materials/SurfaceMaterial.ts']
    .map((p) => readFileSync(p, 'utf8')).join('\n');

  it('every hook point is concatenated exactly once by the core chunks', () => {
    for (const p of POINTS) expect(core.split(`familyHook('${p}')`).length - 1, p).toBe(1);
    expect(FAMILIES.map(([n]) => n)).toEqual(['textile', 'walls', 'ceiling', 'concrete', 'masonry', 'tile', 'props']);
  });

  it('every grime profile but none has exactly one branch, in its owner family', () => {
    const owner: Record<string, string> = {
      carpet: 'textile', wallpaper: 'walls', paint: 'walls', ceilingTile: 'ceiling', concrete: 'concrete', masonry: 'masonry', tile: 'tile', metal: 'props',
    };
    for (const [k, id] of Object.entries(GRIME_ID)) {
      const tag = `if ( brGrime == BR_G_${k.toUpperCase()} )`;
      expect(frag.split(tag).length - 1, k).toBe(id === 0 ? 0 : 1);
      if (id !== 0) expect(FAMILIES.find(([n]) => n === owner[k])![1].grime, k).toContain(tag);
    }
  });

  it('the hooks sit at their points (the point markers are emitted even where no family has code)', () => {
    const at = (s: string): number => { const i = frag.indexOf(s); expect(i, s).toBeGreaterThanOrEqual(0); return i; };
    const hook = (p: HookPoint): number => at(`// ---- family hooks: ${p}\n`);
    for (const p of POINTS) expect(frag.split(`// ---- family hooks: ${p}\n`).length - 1, p).toBe(1);
    expect(hook('pars')).toBeLessThan(at('void main()'));
    // postSample: after the channel decode and the v2 debug exits, before the detail fetch
    expect(hook('postSample')).toBeGreaterThan(at('if ( uDebugView == BR_DV_RELIEF ) {'));
    expect(hook('postSample')).toBeLessThan(at('vec4 brDt = brDetailFetch('));
    // postDetail: inside the detail block, after the multiplier is known and before it is applied
    expect(hook('postDetail')).toBeGreaterThan(at('brAm = brDt.b / brDmu.b;'));
    expect(hook('postDetail')).toBeLessThan(at('brA *= mix( 1.0, brAm, brDetL.y );'));
    // grime: inside the grime block after the shared lookups, the chain opened by the core
    expect(hook('grime')).toBeGreaterThan(at('float wet = smoothstep( 0.22, 0.62, wetRaw );'));
    expect(hook('grime')).toBeGreaterThan(at('if ( false ) {'));
    expect(hook('grime')).toBeLessThan(at('float brBand = brWaterWetBand('));
    expect(at('// ---- family props: grime')).toBeLessThan(at('float brBand = brWaterWetBand('));
    expect(hook('postWet')).toBeGreaterThan(at('brRoughToW = max( brFilm, brPuddle );'));
    expect(hook('postWet')).toBeLessThan(at('diffuseColor.rgb = brA * vBrTint.rgb;'));
    expect(hook('rough')).toBeGreaterThan(at('brRt = sqrt( sqrt( pow4( brRt ) + brDetVar ) );'));
    expect(hook('rough')).toBeLessThan(at('float roughnessFactor = clamp('));
    expect(hook('normal')).toBeGreaterThan(at('mat3 brTbn = brTangentFrame('));
    expect(hook('normal')).toBeLessThan(at('int brEp = ( brF & BR_F_FLOOR_AUX ) == 0'));
    // matPost: after the glaze coverage, before the specular AA (brCoat declared before it)
    expect(hook('matPost')).toBeGreaterThan(at('// 2. glaze coverage'));
    expect(hook('matPost')).toBeGreaterThan(at('bool brCoat = false;'));
    expect(hook('matPost')).toBeLessThan(at('// 5. specular AA'));
    // postLight: after the aomap replacement, before the fog stage; preFog: outside the debug views, before haze
    expect(hook('postLight')).toBeGreaterThan(at('// ==== WP9 specular occlusion + reflections'));
    expect(hook('postLight')).toBeLessThan(at('// ==== WP9 debug views'));
    expect(hook('preFog')).toBeGreaterThan(at('gl_FragColor.rgb = brDbg * BR_DEBUG_NITS;'));
    expect(hook('preFog')).toBeLessThan(at('bool brDefer = false;'));
    // the channel decode precedes the detail fetch; the detail multiplier is main-scope (postDetail rescales it)
    expect(at('vec2 brLean = ')).toBeLessThan(at('vec4 brDt = brDetailFetch('));
    expect(at('#define brRel ( ( brNrm.w - brMuH ) * uBrLayerC[ brL ].x )')).toBeLessThan(at('void main()'));
    expect(at('float brAm = 1.0;')).toBeLessThan(at('brAm = brDt.b / brDmu.b;'));
    // the v2 debug views leave early: the fog stage's view list never reads their values (they would stay live)
    expect(at('if ( uDebugView == BR_DV_AUX ) BR_DEBUG_EXIT(')).toBeLessThan(at('vec4 brDt = brDetailFetch('));
    const views = frag.slice(at('vec3 brDbg = vec3( 0.0 );'), at('gl_FragColor.rgb = brDbg * BR_DEBUG_NITS;'));
    expect(views).not.toMatch(/\b(brAux|brAux2|brLean|brRel|brMuH)\b/);
  });

  it('hook strings are balanced GLSL', () => {
    const stripComments = (s: string): string => s.replace(/\/\/.*$/gm, '');
    for (const [name, h] of FAMILIES) {
      for (const p of POINTS) {
        let depth = 0;
        for (const ch of stripComments(h[p])) { if (ch === '{') depth++; else if (ch === '}') depth--; expect(depth >= 0, `${name}.${p}`).toBe(true); }
        expect(depth, `${name}.${p}`).toBe(0);
      }
    }
    expect(familyHook('grime')).toContain('// ---- family walls: grime');
    // every point's code ends a line, so a core directive that follows it (#if, #endif) stays at the start of a line
    for (const p of POINTS) expect(familyHook(p).endsWith('\n'), p).toBe(true);
  });
});
