// tests/materials/params.test.ts (WP9) — the per-layer parameter table, the flicker slot lookup, and the periodicity
// rules of every world-anchored shader lattice (NOISE_WRAP horizontally, STOREY_PITCH vertically: towers stay
// periodic and nothing seams at the noise wrap).

import { describe, expect, it } from 'vitest';
import { EMISSION, NOISE_WRAP, STOREY_PITCH, TILE_SIZE } from '../../src/core/constants.ts';
import { MAT_COUNT, Mat } from '../../src/core/ids.ts';
import { LAYER_DEFS, layerRepeatY } from '../../src/core/materials.ts';
import { DYN_SLOT_OFFSETS } from '../../src/core/mesh.ts';
import { buildLayerTable, f, glslConstants, GRIME_ID, hexLattice, slotLut, TUNE } from '../../src/materials/chunks/params.ts';
import { ShaderLib } from 'three';
import { buildSurfaceFragment } from '../../src/materials/SurfaceMaterial.ts';
import { waterFragmentGlsl } from '../../src/materials/WaterMaterial.ts';

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
    for (const c of [TUNE.MACRO_CELL, TUNE.MACRO_CELL * 2, TUNE.GRIME_SCALE_A, TUNE.GRIME_SCALE_B, TUNE.FEATURE_CELL, TUNE.WATER_NORMAL_A,
      TUNE.WATER_NORMAL_B, 0.6, 0.3 /* caustic cells */, 0.6 * 4, 0.3 * 4 /* caustic warp period */]) {
      expect(divides(c, NOISE_WRAP), `${c} | NOISE_WRAP`).toBe(true);
    }
    for (const c of [TUNE.MACRO_CELL_Y, TUNE.GRIME_SCALE_Y_A, TUNE.GRIME_SCALE_Y_B, TUNE.FEATURE_CELL_Y]) {
      expect(divides(c, STOREY_PITCH), `${c} | STOREY_PITCH`).toBe(true);
    }
    // B3 world lattices: carpet pile lean (and its 2x amplitude cell), broadloom widths, wallpaper rolls, concrete
    // control joints, 0.6 m ceiling tiles / tie holes, flooded-room caustic cells (x CAUSTIC_FLOOD_SCALE) + warp
    for (const c of [TUNE.CARPET_PILE_CELL, TUNE.CARPET_PILE_CELL * 2, TUNE.CARPET_BROADLOOM, TUNE.WALL_ROLL, TUNE.CONCRETE_JOINT,
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
    const switches = new Set(['BR_SHELL', 'BR_PROPS', 'BR_DECAL', 'BR_LV', 'BR_FLOOR_REFL', 'BR_AIRLIGHT', 'BR_WATER', 'BR_LITE']);
    for (const src of [buildSurfaceFragment(ShaderLib.physical.fragmentShader), waterFragmentGlsl()]) {
      const used = new Set(src.match(/\bBR_[A-Z0-9_]+\b/g) ?? []);
      const defined = new Set([...(src.match(/#define (BR_[A-Z0-9_]+)/g) ?? []).map((x) => x.slice(8)),
        ...(src.match(/const (?:int|float) (BR_[A-Z0-9_]+)/g) ?? []).map((x) => x.replace(/const (?:int|float) /, ''))]);
      const missing = [...used].filter((u) => !defined.has(u) && !switches.has(u));
      expect(missing).toEqual([]);
      expect(src).toContain('const float BR_LV_Y[6]');
    }
  });
});
