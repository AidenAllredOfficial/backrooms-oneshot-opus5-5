// tests/bake/sun.test.ts — direct sunlight through SKYLIGHT_HALL glazing (bake/lights.ts gatherSun, direct.ts sunAt):
//   - the hall's neighbourhood has sun apertures, a plain zone has none;
//   - part of the hall floor is in sun patches at the analytic irradiance SUN.e * SUN.glazing * sin(elevation), the
//     rest (ribs, margins) is not; nothing outside the hall's walls is sunlit;
//   - sunAt is a pure function of the world position: two tiles of the same neighbourhood agree exactly;
//   - the full bake puts the sun into the lightmap (sunlit floor texels far above the shaded ones).

import { describe, expect, it } from 'vitest';
import { CELL } from '../../src/core/constants.ts';
import type { TileKey } from '../../src/core/grid.ts';
import { CellFlag, LandmarkKind, Storey, Zone } from '../../src/core/ids.ts';
import { ChartKind } from '../../src/core/mesh.ts';
import { sunAt, sunOut, SUN_SAMPLES } from '../../src/bake/direct.ts';
import { bakeTile } from '../../src/bake/index.ts';
import { createJob } from '../../src/bake/job.ts';
import { SUN } from '../../src/bake/lights.ts';
import { Q_HIGH, findChart, gridTexel, surfacesOf, texelLum, worldNeighborhood, worldOpts, zoneNeighborhood } from './helpers.ts';

describe('sun through SKYLIGHT_HALL glazing', () => {
  const nb = worldNeighborhood(worldOpts({ forceLandmark: LandmarkKind.SKYLIGHT_HALL, lights: 'on' }), Storey.POOLROOMS, 0, 0);
  const l = nb.get(0, 0);
  const lm = l.landmarks.find((m) => m.kind === LandmarkKind.SKYLIGHT_HALL)!;
  // the render tile holding the hall centre
  const ci = (lm.i0 + lm.i1) >> 1, cj = (lm.j0 + lm.j1) >> 1;
  const tile: TileKey = { s: Storey.POOLROOMS, cx: 0, cz: 0, q: ((ci >= 16 ? 1 : 0) + (cj >= 16 ? 2 : 0)) as 0 | 1 | 2 | 3 };
  const job = createJob(nb, tile, Q_HIGH, null);
  const g = job.g;
  const hx = (li: number): number => li - g.hl0, hz = (lj: number): number => lj - g.hm0;
  const expectedE = SUN.e * SUN.glazing * Math.sin(SUN.elev) * (0.2126 * SUN.color[0] + 0.7152 * SUN.color[1] + 0.0722 * SUN.color[2]);

  it('has apertures (and a plain zone has none)', () => {
    expect(lm).toBeTruthy();
    expect(job.sun).not.toBeNull();
    const plain = createJob(zoneNeighborhood(Zone.LOBBY), { s: 0, cx: 0, cz: 0, q: 0 }, Q_HIGH, null);
    expect(plain.sun).toBeNull();
  });

  it('lights part of the hall floor at the analytic irradiance, nothing outside the hall', () => {
    let lit = 0, total = 0, outside = 0;
    for (let lj = lm.j0; lj < lm.j1; lj++) {
      for (let li = lm.i0; li < lm.i1; li++) {
        for (const [fx, fz] of [[0.25, 0.25], [0.75, 0.75]]) {
          const x = hx(li + fx), z = hz(lj + fz);
          const c = Math.floor(z) * g.n + Math.floor(x);
          sunAt(job, x, g.floor[c] + 0.02, z, 0, 1, 0, 0, SUN_SAMPLES);
          total++;
          if (sunOut.frac >= 1) { lit++; expect(Math.abs(sunOut.lum / expectedE - 1)).toBeLessThan(1e-6); }
        }
      }
    }
    expect(lit / total).toBeGreaterThan(0.05); // 19% of the ceiling is glazed; part of each beam lands on the walls
    expect(lit / total).toBeLessThan(0.6);
    // a ring of floor cells just outside the hall (behind its walls)
    for (let li = lm.i0 - 2; li < lm.i1 + 2; li++) {
      for (const lj of [lm.j0 - 2, lm.j1 + 1]) {
        if (li < 0 || lj < 0 || li >= 32 || lj >= 32) continue;
        if ((l.flags[lj * 32 + li] & (CellFlag.SOLID | CellFlag.LANDMARK)) !== 0) continue;
        const x = hx(li + 0.5), z = hz(lj + 0.5);
        const c = Math.floor(z) * g.n + Math.floor(x);
        sunAt(job, x, g.floor[c] + 0.02, z, 0, 1, 0, 0, SUN_SAMPLES);
        outside += sunOut.lum;
      }
    }
    expect(outside).toBe(0);
  });

  it('is a pure function of the world position (two tiles agree)', () => {
    const other = createJob(nb, { ...tile, q: (tile.q ^ 1) as 0 | 1 | 2 | 3 }, Q_HIGH, null);
    const og = other.g;
    for (let k = 0; k < 200; k++) {
      const li = lm.i0 + (k * 7919 % 997) / 997 * (lm.i1 - lm.i0), lj = lm.j0 + (k * 104729 % 991) / 991 * (lm.j1 - lm.j0);
      sunAt(job, li - g.hl0, 0.02, lj - g.hm0, 0, 1, 0, 0, SUN_SAMPLES);
      const a = sunOut.lum;
      sunAt(other, li - og.hl0, 0.02, lj - og.hm0, 0, 1, 0, 0, SUN_SAMPLES);
      expect(sunOut.lum).toBe(a);
    }
  });

  it('reaches the lightmap: sunlit floor texels are far brighter than the shaded ones', () => {
    const s = surfacesOf(nb, tile, 12);
    const lmap = bakeTile(nb, tile, s, 'full', Q_HIGH, 'direct');
    const floor = findChart(s, ChartKind.FLOOR_GRID);
    const litE: number[] = [], shadeE: number[] = [];
    const ox = (tile.q & 1) * 16 * CELL, oz = (tile.q >> 1) * 16 * CELL;
    for (let k = 0; k < 400; k++) {
      const x = lm.i0 * CELL + 0.3 + ((k * 37) % 97) / 97 * ((lm.i1 - lm.i0) * CELL - 0.6);
      const z = lm.j0 * CELL + 0.3 + ((k * 61) % 89) / 89 * ((lm.j1 - lm.j0) * CELL - 0.6);
      if (x < ox || z < oz || x >= ox + 16 * CELL || z >= oz + 16 * CELL) continue;
      sunAt(job, x / CELL - g.hl0, 0.02, z / CELL - g.hm0, 0, 1, 0, 0, SUN_SAMPLES);
      if (sunOut.frac !== 0 && sunOut.frac !== 1) continue;
      const [u, v] = gridTexel(floor, 12, x - ox, z - oz); // tile-local metres
      (sunOut.frac === 1 ? litE : shadeE).push(texelLum(lmap, u, v));
    }
    expect(litE.length).toBeGreaterThan(10);
    expect(shadeE.length).toBeGreaterThan(10);
    const mean = (a: number[]): number => a.reduce((p, q) => p + q, 0) / a.length;
    expect(mean(litE)).toBeGreaterThan(mean(shadeE) + 0.8 * expectedE);
  });
});
