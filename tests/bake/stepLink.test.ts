// tests/bake/stepLink.test.ts — probe interpolation across a floor step (bake/indirect.ts cellsLinked): a step over
// 0.5 m separates the two cells' probes near the floors, but above STEP_CLEAR over the higher floor both cells share
// the air (the ceiling over a pool blends across the rim instead of drawing the pool's outline).

import { describe, expect, it } from 'vitest';
import type { TileKey } from '../../src/core/grid.ts';
import { cellsLinked, STEP_CLEAR } from '../../src/bake/indirect.ts';
import { HALO_OFF } from '../../src/bake/util.ts';
import { buildVisGrid } from '../../src/bake/visgrid.ts';
import { carveRoom, handNeighborhood, solidLayout } from './helpers.ts';

const TILE: TileKey = { s: 0, cx: 0, cz: 0, q: 0 };

describe('probe links across a floor step', () => {
  const l = solidLayout({ s: 0, cx: 0, cz: 0 });
  carveRoom(l, 1, 1, 15, 15, 500);
  // a 4 m deep pit (a pool's deep end) over cells i 6..9, and a 0.3 m step at i 12
  for (let j = 1; j < 15; j++) {
    for (let i = 6; i < 10; i++) l.floorCm[j * 32 + i] = -400;
    l.floorCm[j * 32 + 12] = 30;
  }
  const g = buildVisGrid(handNeighborhood(l), TILE);
  const cell = (i: number, j: number): number => (HALO_OFF + j) * g.n + HALO_OFF + i;
  const at = (a: number, b: number, i: number, y: number): boolean => cellsLinked(g, a, b, HALO_OFF + i, y, HALO_OFF + 5.5);

  it('separates the pit from the deck near the floors', () => {
    expect(at(cell(6, 5), cell(5, 5), 6.1, -2)).toBe(false);
    expect(at(cell(5, 5), cell(6, 5), 5.9, 0.4)).toBe(false);
    expect(at(cell(5, 5), cell(6, 5), 5.9, STEP_CLEAR - 0.05)).toBe(false);
  });
  it('links them in the shared air above the higher floor', () => {
    expect(at(cell(6, 5), cell(5, 5), 6.1, STEP_CLEAR + 0.05)).toBe(true);
    expect(at(cell(5, 5), cell(6, 5), 5.9, 4.65)).toBe(true);
    expect(at(cell(6, 5), cell(5, 5), 6.1, 4.65)).toBe(true);
  });
  it('small steps always link', () => {
    expect(at(cell(12, 5), cell(11, 5), 12.1, 0.35)).toBe(true);
    expect(at(cell(11, 5), cell(12, 5), 11.9, 4.0)).toBe(true);
  });
});
