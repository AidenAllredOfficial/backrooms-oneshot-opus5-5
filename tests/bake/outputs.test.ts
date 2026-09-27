// tests/bake/outputs.test.ts — WP7 secondary outputs: floor-reflection emission map (radiance, region keys, dynamic
// negation), light volume (index order, direction, solid dilation), wall mask bits, and the surface mask (leak
// stains, wetness, grime).

import { describe, expect, it } from 'vitest';
import { CELL, EMISSION, LV, regionKey } from '../../src/core/constants.ts';
import { fromHalf } from '../../src/core/half.ts';
import { CellFlag, EdgeKind, FixtureKind, LightState } from '../../src/core/ids.ts';
import type { TileKey } from '../../src/core/grid.ts';
import { ChartKind } from '../../src/core/mesh.ts';
import { bakeTile } from '../../src/bake/index.ts';
import { fixtureRadiance, towerGroups, type ChunkLayout } from '../../src/core/layout.ts';
import { makeNeighborhood } from '../../src/world/neighborhood.ts';
import { testSceneChunk } from '../../src/world/testScenes.ts';
import { Q_HIGH, addLight, carveRoom, findChart, gridTexel, handNeighborhood, setEx, solidLayout, surfacesOf } from './helpers.ts';

const TILE: TileKey = { s: 0, cx: 0, cz: 0, q: 0 };

describe('emission map', () => {
  const l = solidLayout({ s: 0, cx: 0, cz: 0 });
  carveRoom(l, 1, 1, 15, 15);
  addLight(l, { px: 6.0, pz: 6.0, luminance: 3000, w: 1.2, h: 0.6 }); // x [5.4, 6.6], z [5.7, 6.3]
  addLight(l, { px: 12.0, pz: 12.0, luminance: 2000, state: LightState.FLICKER, dynamic: true });
  addLight(l, { kind: FixtureKind.EXIT_SIGN, px: 3.0, py: 2.1, pz: 1.3, nx: 0, ny: 0, nz: 1, w: 0.3, h: 0.15, luminance: 80 });
  const nb = handNeighborhood(l);
  const lm = bakeTile(nb, TILE, surfacesOf(nb, TILE, 12), 'preview', Q_HIGH, 'all');
  const at = (x: number, z: number): [number, number] => {
    const i = Math.floor((x + EMISSION.MARGIN) / EMISSION.TEXEL), j = Math.floor((z + EMISSION.MARGIN) / EMISSION.TEXEL);
    const o = (j * EMISSION.RES + i) * 4;
    return [fromHalf(lm.emission[o + 1]), fromHalf(lm.emission[o + 3])];
  };
  it('covers the emitter footprint with its radiance and the region key', () => {
    const [e, a] = at(6.0, 6.0);
    expect(e).toBeGreaterThan(2900);
    expect(e).toBeLessThan(3100);
    expect(a).toBe(regionKey(nb.region(5, 5)));
    expect(a).toBeGreaterThan(0);
    const [e2] = at(6.0, 7.2); // outside the 0.6 m wide footprint
    expect(e2).toBe(0);
    const [e3] = at(3.0, 1.35); // vertical exit sign: not in the map
    expect(e3).toBe(0);
  });
  it('dynamic emitters at intensity 1 with a negated key', () => {
    const [e, a] = at(12.0, 12.0);
    expect(e).toBeGreaterThan(1900);
    expect(a).toBe(-regionKey(nb.region(10, 10)));
  });
});

describe('emission map: periodic tower lights', () => {
  // A tower lamp is in the light set once per storey replica (y + 3k); the 2D map must count it once.
  const ls: ChunkLayout[] = [];
  for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) ls.push(testSceneChunk('tower', { s: 0, cx: dx, cz: dz }, 1));
  const nb = makeNeighborhood(ls);
  it('a tower lamp is not summed once per replica', () => {
    const c = nb.center;
    const groups = towerGroups(c);
    // one period of downward RECT tower lamps whose centre lies in tile q = 0 (+ the emission margin)
    const lamps = c.fixtures.filter((f) => groups.includes(f.bakeGroup) && (f.shape === 1 || f.ny < -0.5) && f.state !== LightState.OFF &&
      f.px > -EMISSION.MARGIN && f.px < 19.2 + EMISSION.MARGIN && f.pz > -EMISSION.MARGIN && f.pz < 19.2 + EMISSION.MARGIN);
    expect(lamps.length).toBeGreaterThan(0);
    const lm = bakeTile(nb, TILE, surfacesOf(nb, TILE, 12), 'preview', Q_HIGH, 'all');
    const T2 = EMISSION.TEXEL * EMISSION.TEXEL;
    for (const f of lamps) {
      // green-channel flux (nits x m^2) over the 3 x 3 texels around the lamp ...
      const i = Math.floor((f.px + EMISSION.MARGIN) / EMISSION.TEXEL), j = Math.floor((f.pz + EMISSION.MARGIN) / EMISSION.TEXEL);
      let flux = 0;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) flux += fromHalf(lm.emission[((j + dj) * EMISSION.RES + i + di) * 4 + 1]) * T2;
      // ... equals the flux of the lamps of ONE period there (a bulb: I x colour; a panel: L x A x colour)
      let want = 0;
      for (const g of c.fixtures) {
        if (g.state === LightState.OFF || Math.abs(g.px - f.px) > 0.3 || Math.abs(g.pz - f.pz) > 0.3) continue;
        want += g.shape === 0 ? fixtureRadiance(g) * g.w * g.h * g.color[1] : g.luminance * g.color[1];
      }
      expect(want).toBeGreaterThan(0);
      expect(flux).toBeGreaterThan(0.97 * want);
      expect(flux).toBeLessThan(1.03 * want);
    }
  });
});

describe('light volume and wall mask', () => {
  const l = solidLayout({ s: 0, cx: 0, cz: 0 });
  carveRoom(l, 1, 1, 12, 12);
  l.flags[6 * 32 + 6] = CellFlag.SOLID; // a pillar
  setEx(l, 4, 3, EdgeKind.WALL);
  addLight(l, { px: 3.0, pz: 3.0 });
  const nb = handNeighborhood(l);
  const lm = bakeTile(nb, TILE, surfacesOf(nb, TILE, 12), 'full', Q_HIGH, 'all');
  const idx = (i: number, k: number, j: number): number => ((j * LV.NY + k) * LV.NX + i) * 4;
  it('uses the ((j * NY + k) * NX + i) order and points at the light', () => {
    // sample (i, j) = cell (2, 2) area under the light at 3.0, 3.0: i = floor(3.0 / 0.6) = 5, level 1 (0.8 m)
    const o = idx(5, 1, 5);
    const e = fromHalf(lm.volume.a[o + 1]);
    expect(e).toBeGreaterThan(100);
    const dy = lm.volume.b[o + 1] / 255 * 2 - 1;
    expect(dy).toBeGreaterThan(0.7);
    expect(lm.volume.b[o + 3]).toBeGreaterThan(100); // strongly directional
    const ao = fromHalf(lm.volume.a[o + 3]);
    expect(ao).toBeGreaterThan(0.3);
    expect(ao).toBeLessThanOrEqual(1);
    // far corner of the room is dimmer
    expect(fromHalf(lm.volume.a[idx(20, 1, 20) + 1])).toBeLessThan(e);
  });
  it('dilates samples inside solids', () => {
    const o = idx(Math.floor((6.5 * CELL) / LV.STEP), 2, Math.floor((6.5 * CELL) / LV.STEP)); // inside the pillar
    expect(fromHalf(lm.volume.a[o + 1])).toBeGreaterThan(0);
  });
  it('wall mask bits N1 E2 S4 W8', () => {
    const bits = (li: number, lj: number): number => lm.volume.wallMask[((lj + 1) * 18 + (li + 1)) * 4];
    expect(bits(1, 1) & 1).toBe(1); // north wall of the room
    expect(bits(1, 1) & 8).toBe(8); // west wall
    expect(bits(3, 3) & 2).toBe(2); // the wall on line x = 4, row 3 is east of cell (3, 3)
    expect(bits(4, 3) & 8).toBe(8); // ...and west of cell (4, 3)
    expect(bits(5, 6) & 2).toBe(2); // the pillar east of cell (5, 6)
    expect(bits(3, 5)).toBe(0); // open cell
  });
});

describe('light volume dilation stays inside the cell', () => {
  // Room A (floor 0, lit) and room B (floor 0.6 m, dark) separated by a WALL on line 8. B's LV samples at
  // y = 0.2 m are below its floor (invalid, dilated): they must take B's own column, not A's lit samples across
  // the wall (the props shader interpolates in y inside the fragment's own cell).
  const l = solidLayout({ s: 0, cx: 0, cz: 0 });
  carveRoom(l, 2, 2, 8, 10);
  carveRoom(l, 8, 2, 14, 10);
  for (let j = 2; j < 10; j++) for (let i = 8; i < 14; i++) l.floorCm[j * 32 + i] = 60;
  for (let j = 2; j < 10; j++) setEx(l, 8, j, EdgeKind.WALL);
  addLight(l, { px: 8 * CELL - 1.2, pz: 6 * CELL, tx: 0, tz: 1 });
  const nb = handNeighborhood(l);
  for (const variant of ['preview', 'full'] as const) {
    it(`B's sub-floor samples stay dark (${variant})`, () => {
      const lm = bakeTile(nb, TILE, surfacesOf(nb, TILE, 12), variant, Q_HIGH, 'all');
      const lum = (i: number, k: number, j: number): number => {
        const o = ((j * LV.NY + k) * LV.NX + i) * 4;
        return 0.2126 * fromHalf(lm.volume.a[o]) + 0.7152 * fromHalf(lm.volume.a[o + 1]) + 0.0722 * fromHalf(lm.volume.a[o + 2]);
      };
      let maxA = 0, maxB = 0;
      for (let j = 4; j < 20; j++) {
        for (let k = 0; k < 3; k++) {
          for (let i = 4; i < 16; i++) maxA = Math.max(maxA, lum(i, k, j));
          for (let i = 16; i < 28; i++) maxB = Math.max(maxB, lum(i, k, j));
        }
      }
      expect(maxA).toBeGreaterThan(50);
      expect(maxB).toBeLessThan(1e-4 * maxA);
    });
  }
});

describe('surface mask', () => {
  const l = solidLayout({ s: 0, cx: 0, cz: 0 });
  carveRoom(l, 1, 1, 12, 12);
  for (let c = 0; c < 1024; c++) { l.decay[c] = 200; l.humidity[c] = 180; }
  l.flags[8 * 32 + 8] |= CellFlag.WET;
  l.leaks.push({ x: 1.2 + 0.4, y: 2.7, z: 6.0, strength: 1 }); // next to the west wall (x = 1.2)
  addLight(l, { px: 7.0, pz: 7.0 });
  const nb = handNeighborhood(l);
  const s = surfacesOf(nb, TILE, 12);
  const lm = bakeTile(nb, TILE, s, 'full', Q_HIGH, 'all');
  it('wet cells, leak puddles and stains', () => {
    const floor = findChart(s, ChartKind.FLOOR_GRID);
    const m = (x: number, z: number, k: number): number => { const [u, v] = gridTexel(floor, 12, x, z); return lm.mask[(v * lm.width + u) * 4 + k]; };
    expect(m(8.5 * CELL, 8.5 * CELL, 2)).toBeGreaterThan(150); // WET cell
    expect(m(1.7, 6.0, 2)).toBeGreaterThan(150); // puddle under the leak
    // west wall texels near the leak carry the tide-line stain (R) near the ceiling
    let stain = 0;
    for (const ch of s.charts) {
      if (ch.kind !== ChartKind.WALL || Math.abs(ch.normal[0] - 1) > 1e-6) continue;
      for (let v = 0; v < ch.h; v++) for (let u = 0; u < ch.w; u++) {
        const z = ch.origin[2] + (u + 0.5) * ch.axisU[2] + (v + 0.5) * ch.axisV[2];
        const y = ch.origin[1] + (u + 0.5) * ch.axisU[1] + (v + 0.5) * ch.axisV[1];
        if (Math.abs(z - 6.0) < 0.5 && y > 2.2) stain = Math.max(stain, lm.mask[((ch.y + v) * lm.width + ch.x + u) * 4]);
      }
    }
    expect(stain).toBeGreaterThan(80);
    // grime in a corner vs. the middle of the floor
    expect(m(1.3, 1.3, 1)).toBeGreaterThan(m(7.0, 7.0, 1));
  });
});

describe('wall mask water channels (package E)', () => {
  // a pool (cells 3..5 x 3..4: floor -60, water -10, kind 0) and a flooded strip (cells 8..10 x 8: floor 0, water
  // +25, kind 1) in one room; everything else dry
  const l = solidLayout({ s: 0, cx: 0, cz: 0 });
  carveRoom(l, 1, 1, 15, 15);
  for (let j = 3; j < 5; j++) for (let i = 3; i < 6; i++) { l.floorCm[j * 32 + i] = -60; l.waterCm[j * 32 + i] = -10; }
  l.water.push({ x0: 3 * CELL, z0: 3 * CELL, x1: 6 * CELL, z1: 5 * CELL, y: -0.1, floorY: -0.6, kind: 0 });
  for (let i = 8; i < 11; i++) l.waterCm[8 * 32 + i] = 25;
  l.water.push({ x0: 8 * CELL, z0: 8 * CELL, x1: 11 * CELL, z1: 9 * CELL, y: 0.25, floorY: 0, kind: 1 });
  addLight(l, { px: 7.0, pz: 7.0 });
  const nb = handNeighborhood(l);
  const lm = bakeTile(nb, TILE, surfacesOf(nb, TILE, 12), 'preview', Q_HIGH, 'all');
  const cell = (li: number, lj: number): { wy: number | null; kind: number } => {
    const o = ((lj + 1) * 18 + (li + 1)) * 4, m = lm.volume.wallMask;
    if (m[o + 2] === 0) return { wy: null, kind: -1 };
    return { wy: (m[o + 1] * 256 + m[o + 3] - 32768) / 100, kind: m[o + 2] - 1 };
  };
  it('g/a decode to the water surface and b to kind + 1', () => {
    expect(cell(3, 3)).toEqual({ wy: -0.1, kind: 0 });
    expect(cell(5, 4)).toEqual({ wy: -0.1, kind: 0 });
    expect(cell(9, 8)).toEqual({ wy: 0.25, kind: 1 });
  });
  it('dry and SOLID cells have b = 0 (and the wall bits in r are unchanged)', () => {
    expect(cell(6, 3).kind).toBe(-1);
    expect(cell(0, 0).kind).toBe(-1); // SOLID ring
    expect(lm.volume.wallMask[((1 + 1) * 18 + (1 + 1)) * 4] & 9).toBe(9); // N and W walls of cell (1, 1)
  });
});
