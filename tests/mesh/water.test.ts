// tests/mesh/water.test.ts — package E water-surface data (mesh/water.ts): tint.a = WaterRect kind, aux.x = depth in
// 2 cm units, aux.y/z = the rect's light-region key (0 when it spans several), aux.w = the emitter plane above the
// water in 5 cm units (floorAux's reflection plane).

import { describe, expect, it } from 'vitest';
import { regionKey, TILE_CELLS } from '../../src/core/constants.ts';
import { cellIdx } from '../../src/core/grid.ts';
import { buildTile } from '../../src/mesh/buildTile.ts';
import { floorAux } from '../../src/mesh/floors.ts';
import { TileGrid } from '../../src/mesh/tileGrid.ts';
import { waterAux } from '../../src/mesh/water.ts';
import { mixNb } from './fixtures.ts';
import { tileKey } from './helpers.ts';

describe('water surface data (package E)', () => {
  // mixNb: a pool at cells (2..5, 28..29), water y = -0.1, floor -0.6 (tile q = 2: cells 0..15 x 16..31)
  const nb = mixNb();
  const tile = tileKey(0, 0, 0, 2);
  const { mesh } = buildTile(nb, tile, 12);

  it('every water vertex carries the kind in tint.a and the depth in 2 cm units in aux.x', () => {
    const w = mesh.water!;
    expect(w.vertexCount).toBeGreaterThan(0);
    for (let v = 0; v < w.vertexCount; v++) {
      expect(w.tint[v * 4 + 3]).toBe(0); // pool
      expect(w.aux[v * 4]).toBe(25); // (−0.1 − (−0.6)) · 50
    }
  });

  it('aux.y/z hold the region key of the pool cells and aux.w the emitter plane above the water', () => {
    const w = mesh.water!;
    const key = regionKey(nb.region(3, 28));
    expect(key).toBeGreaterThan(0);
    expect(w.aux[1] + 256 * w.aux[2]).toBe(key);
    // no fixture near the pool: floorAux's reflection plane is the ceiling (mixNb ceilings) above the pool floor
    const l = nb.center;
    const ceil = l.ceilCm[cellIdx(3, 28)] / 100;
    expect(w.aux[3] * 0.05).toBeCloseTo(ceil - -0.1, 1);
  });

  it('waterAux: mixed regions give key 0, the plane is the most frequent one, and a 2 cm film is 1', () => {
    const fa = new Uint32Array(TILE_CELLS * TILE_CELLS);
    // three cells: regions 5, 5, 9; reflection planes 60, 60, 40 (x 5 cm above the floor)
    fa[0] = (60 | (5 << 8)) >>> 0;
    fa[1] = (60 | (5 << 8)) >>> 0;
    fa[2] = (40 | (9 << 8)) >>> 0;
    const a = waterAux(0, 3 * 1.2, 0, 1.2, 0.02, 0, fa);
    expect(a & 255).toBe(1); // 2 cm film
    expect((a >>> 8) & 0xffff).toBe(0); // spans two regions
    expect((a >>> 24) * 0.05).toBeCloseTo(60 * 0.05 - 0.02, 1);
    const b = waterAux(0, 2 * 1.2, 0, 1.2, 0.3, 0, fa);
    expect((b >>> 8) & 0xffff).toBe(5);
  });

  it('floorAux agrees with the plane the water quad uses', () => {
    const g = new TileGrid(nb, tile);
    const fa = floorAux(g);
    const a = fa[(28 - 16) * TILE_CELLS + 3];
    const w = mesh.water!;
    expect(w.aux[3] * 0.05).toBeCloseTo(-0.6 + (a & 255) * 0.05 - -0.1, 1);
  });
});
