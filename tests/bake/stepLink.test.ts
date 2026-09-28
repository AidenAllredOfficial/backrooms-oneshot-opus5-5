// tests/bake/stepLink.test.ts — probe interpolation across a floor step (bake/indirect.ts): a step over 0.5 m separates
// the two cells' probes near the floors, but above STEP_CLEAR over the higher floor both cells share the air (the
// ceiling over a pool blends across the rim instead of drawing the pool's outline). Each cell's probe layers sit at
// its own heights, so a probe link needs both probes up there: a deck's mid layer never takes a pit's.

import { describe, expect, it } from 'vitest';
import type { TileKey } from '../../src/core/grid.ts';
import { cellsLinked, interp, interpolateProbes, STEP_CLEAR } from '../../src/bake/indirect.ts';
import { createJob } from '../../src/bake/job.ts';
import type { ProbeSet } from '../../src/bake/probes.ts';
import { HALO_OFF, PROBE_N, PROBE_OFF } from '../../src/bake/util.ts';
import { Q_HIGH, carveRoom, handNeighborhood, solidLayout } from './helpers.ts';

const TILE: TileKey = { s: 0, cx: 0, cz: 0, q: 0 };

describe('probe links across a floor step', () => {
  const l = solidLayout({ s: 0, cx: 0, cz: 0 });
  carveRoom(l, 1, 1, 15, 15, 500);
  // a 4 m deep pit (a pool's deep end) over cells i 6..9, and a 0.3 m step at i 12
  for (let j = 1; j < 15; j++) {
    for (let i = 6; i < 10; i++) l.floorCm[j * 32 + i] = -400;
    l.floorCm[j * 32 + 12] = 30;
  }
  const job = createJob(handNeighborhood(l), TILE, Q_HIGH, null);
  const g = job.g;
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

  // probes marked by cell: ambient cube +x = 1 on the pit's probes, 0 elsewhere -> interp.cube[0] = the pit's share
  const count = PROBE_N * PROBE_N * 3;
  const P: ProbeSet = {
    n: PROBE_N, off: PROBE_OFF, sh: new Float32Array(count * 12), cube: new Float32Array(count * 18),
    rho: new Float32Array(count * 3), valid: new Uint8Array(count), dyn: null, farSh: null, farCube: null, farDyn: null,
  };
  for (let pj = 0; pj < PROBE_N; pj++) {
    for (let pi = 0; pi < PROBE_N; pi++) {
      const c = (PROBE_OFF + pj) * g.n + PROBE_OFF + pi;
      for (let layer = 0; layer < 3; layer++) {
        const k = (pj * PROBE_N + pi) * 3 + layer;
        P.valid[k] = 1;
        P.cube[k * 18] = g.floor[c] < -1 ? 1 : 0;
      }
    }
  }
  const pitShare = (i: number, y: number): number => {
    const x = HALO_OFF + i, z = HALO_OFF + 5.5, c = cell(Math.floor(i), 5);
    expect(interpolateProbes(job, P, x, y, z, c, false, true)).toBe(true);
    return interp.cube[0];
  };

  it('the ceiling over the rim blends the pit with the deck', () => {
    const top = job.cellH[cell(5, 5) * 3 + 2];
    expect(pitShare(5.9, top + 0.3)).toBeGreaterThan(0.2);
    expect(pitShare(6.1, top + 0.3)).toBeLessThan(0.8);
  });
  it("the deck's mid layer (2.5 m) does not take the pit's mid-layer probe (0.5 m, below STEP_CLEAR over the deck)", () => {
    const mid = job.cellH[cell(5, 5) * 3 + 1];
    expect(job.cellH[cell(6, 5) * 3 + 1]).toBeLessThan(STEP_CLEAR);
    expect(pitShare(5.9, mid)).toBe(0);
  });
});
