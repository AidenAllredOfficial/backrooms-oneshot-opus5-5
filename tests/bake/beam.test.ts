// tests/bake/beam.test.ts — the ray-free beam early-out of the classification (src/bake/beam.ts):
//   - conservative: whenever beamClear says "clear", every segment from the receiver box to the emitter (random
//     points, emitter corners, shadow samples) is unoccluded for the DDA;
//   - exact: the full bake is byte-identical with and without the beam (it only skips rays whose result is known),
//     and it removes classification rays in a furnished zone.

import { describe, expect, it } from 'vitest';
import { CELL } from '../../src/core/constants.ts';
import type { TileKey } from '../../src/core/grid.ts';
import { Zone } from '../../src/core/ids.ts';
import type { LightmapData } from '../../src/core/mesh.ts';
import { emitterCorner, emitterSample, sampleRotation, sp } from '../../src/bake/areaLight.ts';
import { beamAdd, beamClear, beamOpts, beamReset } from '../../src/bake/beam.ts';
import { occluded } from '../../src/bake/dda.ts';
import { bakeTile, createBakeCache, lastBake } from '../../src/bake/index.ts';
import { createJob } from '../../src/bake/job.ts';
import { CellFlag } from '../../src/core/ids.ts';
import { HALO_OFF } from '../../src/bake/util.ts';
import { Q_HIGH, surfacesOf, zoneNeighborhood } from './helpers.ts';

/** Small deterministic PRNG (tests only). */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

function sameBytes(a: LightmapData, b: LightmapData): boolean {
  const eq = (x: ArrayLike<number> | null, y: ArrayLike<number> | null): boolean => {
    if (x === null || y === null) return x === y;
    if (x.length !== y.length) return false;
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
    return true;
  };
  return eq(a.irr, b.irr) && eq(a.dir, b.dir) && eq(a.flick, b.flick) && eq(a.mask, b.mask) && eq(a.emission, b.emission) &&
    eq(a.volume.a, b.volume.a) && eq(a.volume.b, b.volume.b) && eq(a.volume.c, b.volume.c) && eq(a.volume.wallMask, b.volume.wallMask);
}

describe('beam early-out (OFFICE: desks, cubicle partitions)', () => {
  const nb = zoneNeighborhood(Zone.OFFICE, 0, 0, 0, { lights: 'default' });
  const tile: TileKey = { s: 0, cx: 0, cz: 0, q: 1 };

  it('is conservative against the DDA', () => {
    const job = createJob(nb, tile, Q_HIGH, null);
    const g = job.g, L = job.L, n = g.n;
    const rnd = lcg(12345);
    let clear = 0, tested = 0;
    for (let trial = 0; trial < 600; trial++) {
      // a random receiver box inside a random open cell of the tile (+ margin), up to a cell wide
      const ci = HALO_OFF - 2 + Math.floor(rnd() * 20), cj = HALO_OFF - 2 + Math.floor(rnd() * 20);
      const c = cj * n + ci;
      if ((g.flags[c] & CellFlag.SOLID) !== 0 || g.group[c] !== 0) continue;
      const fl = Math.max(g.floor[c], g.blockTop[c]), ce = g.ceil[c];
      const sx = rnd() * 0.9, sz = rnd() * 0.9, sy = rnd() * (ce - fl - 0.1);
      const x0 = ci + 0.02 + rnd() * (0.96 - sx), z0 = cj + 0.02 + rnd() * (0.96 - sz), y0 = fl + 0.03 + rnd() * (ce - fl - 0.06 - sy);
      for (let l = 0; l < L.n; l++) {
        if (L.group[l] !== 0) continue;
        const o = l * 3;
        if (Math.hypot((L.pos[o] - x0) * CELL, (L.pos[o + 2] - z0) * CELL) > L.R[l]) continue;
        beamReset(); beamAdd(x0, y0, z0); beamAdd(x0 + sx, y0 + sy, z0 + sz);
        tested++;
        if (!beamClear(job, l, 0)) continue;
        clear++;
        for (let k = 0; k < 24; k++) {
          const px = x0 + rnd() * sx, py = y0 + rnd() * sy, pz = z0 + rnd() * sz;
          if (k < 4) emitterCorner(L, l, k);
          else if (k < 20) { sampleRotation(k, trial, l, L.uid[l]); emitterSample(L, l, k & 3, px, py, pz); }
          else { sp.x = L.vis[o]; sp.y = L.vis[o + 1]; sp.z = L.vis[o + 2]; }
          const blocked = occluded(g, px, py, pz, sp.x, sp.y, sp.z, 0, true);
          if (blocked) expect.fail(`trial ${trial}: light ${L.key[l]} from (${px.toFixed(3)}, ${py.toFixed(3)}, ${pz.toFixed(3)}) is occluded`);
        }
      }
    }
    expect(tested).toBeGreaterThan(5000);
    expect(clear).toBeGreaterThan(200); // the beam does fire in a furnished zone
  });

  it('does not change the bake output and saves classification rays', { tags: ['sweep'] }, () => {
    const s = surfacesOf(nb, tile, 12);
    beamOpts.enabled = false;
    let off: LightmapData, raysOff: number;
    try {
      off = bakeTile(nb, tile, s, 'full', Q_HIGH, 'all', createBakeCache());
      raysOff = lastBake.rays;
    } finally { beamOpts.enabled = true; }
    const on = bakeTile(nb, tile, s, 'full', Q_HIGH, 'all', createBakeCache());
    expect(sameBytes(off, on)).toBe(true);
    expect(lastBake.rays).toBeLessThan(raysOff);
  });
});
