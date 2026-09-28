// tests/bake/patchMean.test.ts — the patch MEAN of point (SPHERE / DISK) lights (bake/patches.ts, areaLight.ts
// pointOverRect): the analytic mean matches a numerical average, tends to the point factor far away, the coarse
// ceiling patch over a cage bulb hung just under the ceiling gets its mean (not the centre's 1 / d^2 core), and far
// probes of a troffer room barely change when that bulb is added (they got 40x firefly rays before).

import { describe, expect, it } from 'vitest';
import { CELL } from '../../src/core/constants.ts';
import type { TileKey } from '../../src/core/grid.ts';
import { FixtureKind } from '../../src/core/ids.ts';
import type { ChunkLayout } from '../../src/core/layout.ts';
import { pointOverRect } from '../../src/bake/areaLight.ts';
import { createJob } from '../../src/bake/job.ts';
import { PK_CEIL, PK_WALL, patchE, pref } from '../../src/bake/patches.ts';
import { computeProbes } from '../../src/bake/probes.ts';
import { HALO_OFF, PROBE_OFF, PROBE_N, luma, windowDist2, windowW } from '../../src/bake/util.ts';
import { Q_HIGH, addLight, carveRoom, handNeighborhood, solidLayout } from './helpers.ts';

const TILE: TileKey = { s: 0, cx: 0, cz: 0, q: 0 };

/** 64 x 64 midpoint average of cos / d^2 = h / d^3 over [u0, u1] x [v0, v1] seen from height h over the origin. */
function numericMean(h: number, u0: number, u1: number, v0: number, v1: number, N = 64): number {
  let s = 0;
  for (let j = 0; j < N; j++) {
    const v = v0 + ((j + 0.5) / N) * (v1 - v0);
    for (let i = 0; i < N; i++) {
      const u = u0 + ((i + 0.5) / N) * (u1 - u0);
      const d2 = u * u + v * v + h * h;
      s += h / (d2 * Math.sqrt(d2));
    }
  }
  return s / (N * N);
}

describe('pointOverRect (mean point-source factor over a rectangle)', () => {
  it('matches a 64 x 64 numerical average within 2%', () => {
    const cases: [number, number, number, number, number][] = [
      [0.14, -0.6, 0.6, -0.6, 0.6], // cage bulb 0.14 m under a coarse ceiling patch's centre
      [0.14, 0, 0.6, 0, 0.6], // ... under a fine patch's corner
      [0.3, 0.2, 0.8, -0.3, 0.3], // off the patch
      [0.5, -1.4, -0.2, 0.4, 1.0], // off both axes
      [1.5, -0.3, 0.3, -0.3, 0.3],
      [2.2, 1.0, 2.2, 3.0, 4.2],
    ];
    for (const [h, u0, u1, v0, v1] of cases) {
      const a = pointOverRect(h, u0, u1, v0, v1), n = numericMean(h, u0, u1, v0, v1);
      expect(Math.abs(a - n) / n, `h ${h} [${u0},${u1}]x[${v0},${v1}]`).toBeLessThan(0.02);
    }
  });

  it('tends to the centre point factor far away, stays bounded by 2 pi / A close to the plane', () => {
    for (const d of [3, 5, 8]) {
      const h = 0.6 * d, uc = 0.8 * d; // rectangle centre 0.8 d off the foot point
      const a = pointOverRect(h, uc - 0.6, uc + 0.6, -0.6, 0.6);
      const r2 = h * h + uc * uc, point = h / (r2 * Math.sqrt(r2));
      expect(Math.abs(a - point) / point).toBeLessThan((0.6 / d) ** 2); // second order in half-extent / distance
    }
    for (const h of [1e-3, 0.01, 0.05]) expect(pointOverRect(h, -0.6, 0.6, -0.6, 0.6)).toBeLessThanOrEqual((2 * Math.PI) / 1.44);
  });
});

/** A 14 x 14 cell room, optionally lit by a troffer grid, optionally with a 75 cd cage bulb hung 0.14 m under the
 * ceiling at the centre of cell (8, 8) (chunk-local). */
function room(troffers: boolean, bulb: boolean): ChunkLayout {
  const l = solidLayout({ s: 0, cx: 0, cz: 0 });
  carveRoom(l, 2, 2, 16, 16);
  if (troffers) for (let j = 3; j < 16; j += 4) for (let i = 3; i < 16; i += 4) addLight(l, { px: i * CELL, pz: j * CELL, py: 2.7 });
  if (bulb) addLight(l, { kind: FixtureKind.CAGE_BULB, shape: 1, px: 8.5 * CELL, pz: 8.5 * CELL, py: 2.7 - 0.14, w: 0.1, h: 0.1, luminance: 75 });
  return l;
}

describe('patch irradiance of a cage bulb hung under the ceiling', () => {
  const job = createJob(handNeighborhood(room(false, true)), TILE, Q_HIGH, null);
  const L = job.L, hi = HALO_OFF + 8, hj = HALO_OFF + 8, c = hj * job.g.n + hi;
  const I = L.radLum[0];
  const win = (x: number, y: number, z: number): number =>
    windowW(windowDist2((L.pos[0] - x) * CELL, L.pos[1] - y, (L.pos[2] - z) * CELL, L.hAllow[0]), L.invR2[0]);
  const lumOf = (): number => luma(pref.e[pref.o], pref.e[pref.o + 1], pref.e[pref.o + 2]);

  it('the coarse ceiling patch over it gets I * Omega / A (60x below the centre point value it had)', () => {
    patchE(job, PK_CEIL, c, hi + 0.3, 2.7, hj + 0.8, 0, false);
    const e = lumOf();
    const mean = I * numericMean(0.14, -0.6, 0.6, -0.6, 0.6, 256) * win(hi + 0.5, 2.625, hj + 0.5);
    expect(Math.abs(e - mean) / mean).toBeLessThan(0.02);
    // the old centre evaluation: the band centre (2.625 m) is 6.5 cm above the bulb, cos / d^2 = 1 / 0.065^2
    const old = I * (1 / (0.065 * 0.065)) * win(hi + 0.5, 2.625, hj + 0.5);
    expect(e).toBeLessThan(old / 60);
  });

  it('a fine ceiling patch with the bulb under its corner gets its mean, and a wall patch its own', () => {
    patchE(job, PK_CEIL, c, hi + 0.7, 2.7, hj + 0.7, 0, true); // patch [0.5, 1] x [0.5, 1] cells: bulb at its corner
    const mean = I * numericMean(0.14, 0, 0.6, 0, 0.6, 256) * win(hi + 0.75, 2.625, hj + 0.75);
    expect(Math.abs(lumOf() - mean) / mean).toBeLessThan(0.02);
    // a wall 6 cells away (the room's x = 16 wall, facing -x): band 2.4-3.6 m clipped to the 2.7 m ceiling
    const cw = hj * job.g.n + HALO_OFF + 15;
    patchE(job, PK_WALL, cw, HALO_OFF + 15.9, 2.5, hj + 0.5, 1, false);
    const px = HALO_OFF + 15 + 0.921875, h = (px - L.pos[0]) * CELL;
    const wm = I * numericMean(h, -0.6 + (hj + 0.5 - L.pos[2]) * CELL, 0.6 + (hj + 0.5 - L.pos[2]) * CELL, 2.4 - L.pos[1], 2.7 - L.pos[1], 256)
      * win(px, 2.65, hj + 0.5);
    expect(Math.abs(lumOf() - wm) / wm).toBeLessThan(0.02);
  });

  it("far probes of a troffer room change by less than 2x when the bulb is added (no firefly rays)", () => {
    const P0 = computeProbes(createJob(handNeighborhood(room(true, false)), TILE, Q_HIGH, null), false);
    const P1 = computeProbes(createJob(handNeighborhood(room(true, true)), TILE, Q_HIGH, null), false);
    const ax = (P: typeof P0, i: number, a: number): number => luma(P.cube[i * 18 + a * 3], P.cube[i * 18 + a * 3 + 1], P.cube[i * 18 + a * 3 + 2]);
    let worst = 0, checked = 0;
    for (let pj = 0; pj < PROBE_N; pj++) for (let pi = 0; pi < PROBE_N; pi++) {
      const di = PROBE_OFF + pi - hi, dj = PROBE_OFF + pj - hj;
      if (Math.max(Math.abs(di), Math.abs(dj)) < 4) continue; // >= 4.8 m away: its rays reach the bulb's coarse patch
      for (let layer = 0; layer < 3; layer++) {
        const i = (pj * PROBE_N + pi) * 3 + layer;
        if (P0.valid[i] === 0) continue;
        checked++;
        for (let a = 0; a < 6; a++) {
          const r = ax(P1, i, a) / Math.max(ax(P0, i, a), 1);
          if (r > worst) worst = r;
        }
      }
    }
    expect(checked).toBeGreaterThan(100);
    expect(worst).toBeLessThan(2);
  });
});
