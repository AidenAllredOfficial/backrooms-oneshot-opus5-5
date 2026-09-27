// tests/bake/multibounce.test.ts — per-channel (RGB) multi-bounce (bake/probes.ts RGB rho, bake/indirect.ts): a grey
// room gets exactly the luma formula, a yellow room's indirect light is more saturated than with the luma gain.

import { describe, expect, it } from 'vitest';
import { CELL } from '../../src/core/constants.ts';
import type { TileKey } from '../../src/core/grid.ts';
import { Mat } from '../../src/core/ids.ts';
import type { ChunkLayout } from '../../src/core/layout.ts';
import { indirectAt, indirectOut, interp, multiBounce } from '../../src/bake/indirect.ts';
import { createJob } from '../../src/bake/job.ts';
import { computeProbes } from '../../src/bake/probes.ts';
import { HALO_OFF, luma } from '../../src/bake/util.ts';
import { Q_HIGH, addLight, carveRoom, handNeighborhood, solidLayout } from './helpers.ts';

const TILE: TileKey = { s: 0, cx: 0, cz: 0, q: 0 };

function room(floor: number, wall: number, ceil: number): ChunkLayout {
  const l = solidLayout({ s: 0, cx: 0, cz: 0 });
  carveRoom(l, 2, 2, 9, 9);
  l.floorMat.fill(floor); l.ceilMat.fill(ceil); l.wallMat.fill(wall);
  for (const e of [l.ex, l.ez]) { e.matNeg.fill(wall); e.matPos.fill(wall); }
  addLight(l, { px: 6.6, pz: 6.6, py: 2.7 });
  return l;
}

/** Indirect irradiance (RGB) on the floor at the room centre, the per-channel gains and the luma gain. */
function centre(l: ChunkLayout): { e: number[]; mb: number[]; mbL: number; rho: number[] } {
  const job = createJob(handNeighborhood(l), TILE, Q_HIGH, null);
  const P = computeProbes(job, false);
  const x = HALO_OFF + 6.65 / CELL, z = HALO_OFF + 6.65 / CELL;
  const c = Math.floor(z) * job.g.n + Math.floor(x);
  const out = new Float64Array(3);
  indirectAt(job, P, x, 0.02, z, 0, 1, 0, c, out);
  return { e: Array.from(out), mb: Array.from(indirectOut.mb), mbL: indirectOut.mbL, rho: Array.from(interp.rho3) };
}

describe('RGB multi-bounce', () => {
  it('multiBounce: 1 / (1 - min(0.6, 0.55 rho))', () => {
    expect(multiBounce(0)).toBe(1);
    expect(multiBounce(0.5)).toBeCloseTo(1 / (1 - 0.275), 12);
    expect(multiBounce(1.5)).toBeCloseTo(2.5, 12); // capped
  });

  it('a grey room gets the luma formula in every channel (within 1e-6)', () => {
    const r = centre(room(Mat.METAL_GRATE, Mat.METAL_GRATE, Mat.METAL_GRATE)); // albedo (0.2, 0.2, 0.2)
    expect(r.e[1]).toBeGreaterThan(0.1);
    for (let k = 0; k < 3; k++) {
      expect(Math.abs(r.rho[k] - luma(r.rho[0], r.rho[1], r.rho[2]))).toBeLessThan(1e-6);
      expect(Math.abs(r.mb[k] - r.mbL)).toBeLessThan(1e-6);
    }
  });

  it('a yellow-wallpapered room: the indirect light is warmer than with the luma gain', () => {
    const r = centre(room(Mat.CARPET_L0, Mat.WALLPAPER_L0, Mat.CEILING_TILE));
    expect(r.rho[0]).toBeGreaterThan(r.rho[2]);
    expect(r.mb[0]).toBeGreaterThan(r.mbL);
    expect(r.mb[2]).toBeLessThan(r.mbL);
    // luma formula: every channel divided back by its own gain and multiplied by the luma gain
    const rbRgb = r.e[0] / r.e[2], rbLuma = (r.e[0] / r.mb[0]) / (r.e[2] / r.mb[2]);
    expect(rbRgb).toBeGreaterThan(1.05 * rbLuma);
  });
});
