// tests/bake/nearfield.test.ts — near-field final gather (bake/nearfield.ts, BakeQuality.nearRays): under-desk floors
// lose most of their indirect light, the region boundary is seamless, the output is identical with and without a
// BakeCache and on both sides of a tile seam, and nearRays absent / 0 is exactly the far-field bake.

import { describe, expect, it } from 'vitest';
import type { TileKey } from '../../src/core/grid.ts';
import { fromHalf } from '../../src/core/half.ts';
import { PropKind } from '../../src/core/ids.ts';
import { ChartKind, type LightmapData } from '../../src/core/mesh.ts';
import type { BakeQuality } from '../../src/core/quality.ts';
import type { LayoutNeighborhood } from '../../src/core/world.ts';
import { SAMPLE_U, SAMPLE_V } from '../../src/bake/areaLight.ts';
import { bakeTile, createBakeCache, lastBake } from '../../src/bake/index.ts';
import { setupTexels, TX_VALID } from '../../src/bake/context.ts';
import { createJob } from '../../src/bake/job.ts';
import { NEAR_MAX, NU, NV, nearRegion } from '../../src/bake/nearfield.ts';
import { Q_HIGH, addLight, carveRoom, findChart, gridTexel, handNeighborhood, sampleGrid, solidLayout, surfacesOf, texelLum } from './helpers.ts';

const TILE: TileKey = { s: 0, cx: 0, cz: 0, q: 0 };
const Q16: BakeQuality = { ...Q_HIGH, nearRays: 16 };

function deskRoom(x: number, z: number): LayoutNeighborhood {
  const l = solidLayout({ s: 0, cx: 0, cz: 0 });
  carveRoom(l, 1, 1, 31, 15);
  for (let k = 0; k < 6; k++) addLight(l, { px: 3 + 5.4 * k, pz: 4.2, py: 2.7 });
  for (let k = 0; k < 6; k++) addLight(l, { px: 3 + 5.4 * k, pz: 12.6, py: 2.7 });
  l.props.push({ kind: PropKind.DESK, variant: 0, x, y: 0, z, yaw: 0, scale: 1, flags: 0, seed: 1 });
  return handNeighborhood(l);
}

const same = (a: LightmapData, b: LightmapData): boolean =>
  a.irr.every((v, i) => v === b.irr[i]) && a.dir.every((v, i) => v === b.dir[i]) && a.mask.every((v, i) => v === b.mask[i]) &&
  a.volume.a.every((v, i) => v === b.volume.a[i]) && a.volume.b.every((v, i) => v === b.volume.b[i]);

describe('(0,2)-sequence', () => {
  it('its first 16 points are areaLight SAMPLE_U / SAMPLE_V', () => {
    for (let i = 0; i < 16; i++) { expect(NU[i]).toBe(SAMPLE_U[i]); expect(NV[i]).toBe(SAMPLE_V[i]); }
  });
  it('every power-of-two prefix is a (0, m, 2)-net: one point per elementary interval', () => {
    for (let m = 1; (1 << m) <= NEAR_MAX; m++) {
      const N = 1 << m;
      for (let a = 0; a <= m; a++) {
        const cells = new Uint8Array(N);
        for (let i = 0; i < N; i++) cells[Math.floor(NU[i] * (1 << a)) * (1 << (m - a)) + Math.floor(NV[i] * (1 << (m - a)))]++;
        expect(cells.every((c) => c === 1), `m ${m} a ${a}`).toBe(true);
      }
    }
  });
});

describe('near-field gather', () => {
  const nb = deskRoom(8.4, 8.4);
  const s = surfacesOf(nb, TILE, 12);

  it('the floor under a desk gets <= 0.5x the indirect light of the open floor 2 m away', () => {
    const lm = bakeTile(nb, TILE, s, 'full', Q16, 'indirect');
    expect(lastBake.nearTexels).toBeGreaterThan(20);
    const floor = findChart(s, ChartKind.FLOOR_GRID);
    const under = sampleGrid(lm, floor, 12, 8.4, 8.45);
    const open = sampleGrid(lm, floor, 12, 8.4, 10.45);
    expect(open).toBeGreaterThan(2);
    expect(under).toBeLessThan(0.5 * open);
  });

  it('nearRays absent and 0 give byte-identical output; with near rays, identical with and without a BakeCache', () => {
    const a = bakeTile(nb, TILE, s, 'full', Q_HIGH, 'all');
    const b = bakeTile(nb, TILE, s, 'full', { ...Q_HIGH, nearRays: 0 }, 'all');
    expect(same(a, b)).toBe(true);
    const c = bakeTile(nb, TILE, s, 'full', Q16, 'all');
    const d = bakeTile(nb, TILE, s, 'full', Q16, 'all', createBakeCache());
    expect(same(c, d)).toBe(true);
    expect(same(a, c)).toBe(false);
  });

  it('the region edge is seamless: the near-field correction on both sides of it differs < 1.5%', () => {
    const job = createJob(nb, TILE, Q16, null);
    const T = setupTexels(job, s);
    const lm = bakeTile(nb, TILE, s, 'full', Q16, 'indirect');
    const far = bakeTile(nb, TILE, s, 'full', Q_HIGH, 'indirect'); // (the analytic prop AO reaches 0.6 m only)
    const floor = findChart(s, ChartKind.FLOOR_GRID);
    let checked = 0;
    for (const z of [7.95, 8.45, 8.95]) {
      let prevIn: boolean | null = null, prevRatio = 1;
      for (let x = 9.2; x < 11.5; x += 0.1) { // walking +x away from the desk's right side panel (x 9.11-9.14)
        const [u, v] = gridTexel(floor, 12, x, z);
        const t = T.map[v * s.atlasW + u];
        if (t < 0 || T.state[t] !== TX_VALID) continue;
        const inR = nearRegion(job, T.cell[t], T.x[t], T.y[t], T.z[t], T.nx[t], T.ny[t], T.nz[t], T.group[t], true);
        const ratio = texelLum(lm, u, v) / texelLum(far, u, v);
        if (prevIn === true && !inR) {
          expect(Math.abs(ratio - prevRatio), `z ${z} x ${x.toFixed(2)}`).toBeLessThan(0.015);
          checked++;
        }
        prevIn = inR; prevRatio = ratio;
      }
    }
    expect(checked).toBe(3);
  });
});

describe('seams', () => {
  it('a desk straddling a tile seam: the shared floor texels agree on both tiles', () => {
    const nb = deskRoom(19.2, 8.4); // tile line q0 | q1 at x = 19.2 m
    const tA: TileKey = { s: 0, cx: 0, cz: 0, q: 0 }, tB: TileKey = { s: 0, cx: 0, cz: 0, q: 1 };
    const sA = surfacesOf(nb, tA, 12), sB = surfacesOf(nb, tB, 12);
    const A = bakeTile(nb, tA, sA, 'full', Q16, 'indirect', createBakeCache());
    expect(lastBake.nearTexels).toBeGreaterThan(20);
    const B = bakeTile(nb, tB, sB, 'full', Q16, 'indirect', createBakeCache());
    const ca = findChart(sA, ChartKind.FLOOR_GRID), cb = findChart(sB, ChartKind.FLOOR_GRID);
    const SIDE = 16 * 12 + 2;
    let n = 0, worst = 0;
    for (const [ua, ub] of [[SIDE - 2, 0], [SIDE - 1, 1]]) {
      for (let v = 60; v < 140; v++) { // z 6-14 m: across the desk
        const ia = ((ca.y + v) * A.width + ca.x + ua) * 4, ib = ((cb.y + v) * B.width + cb.x + ub) * 4;
        for (let k = 0; k < 3; k++) {
          const x = fromHalf(A.irr[ia + k]), y = fromHalf(B.irr[ib + k]);
          if (Math.max(x, y) < 0.5) continue;
          n++;
          worst = Math.max(worst, Math.abs(x - y) / Math.max(x, y));
        }
      }
    }
    expect(n).toBeGreaterThan(300);
    expect(worst).toBeLessThan(1e-3);
  });
});
