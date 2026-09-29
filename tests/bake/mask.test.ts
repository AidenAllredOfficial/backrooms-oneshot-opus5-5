// tests/bake/mask.test.ts — surface mask (WP7 bake/mask.ts) details that the lightmap-level tests do not isolate: the
// pool splash zone (package B): wet deck within 1.2 m of a pool's water edge, nothing on the pool's own floor or far
// from it, and the same value at the same world point whichever tile's bake evaluates it (seamless tiles); the
// hard-floor traffic wear of texture realism v2 lane B (corridor wear at 0.8 x carpet, rack-aisle wheel tracks, entry
// fans from the doors).

import { describe, expect, it } from 'vitest';
import { CELL } from '../../src/core/constants.ts';
import { EdgeKind, Mat, PropKind } from '../../src/core/ids.ts';
import type { TileKey } from '../../src/core/grid.ts';
import { cellIdx } from '../../src/core/grid.ts';
import { createJob } from '../../src/bake/job.ts';
import { createMaskCache, maskAt, maskOut } from '../../src/bake/mask.ts';
import { carveRoom, handNeighborhood, Q_HIGH, setEx, solidLayout } from './helpers.ts';

describe('surface mask: pool splash zone', () => {
  const l = solidLayout({ s: 0, cx: 0, cz: 0 });
  carveRoom(l, 2, 2, 30, 30);
  for (let c = 0; c < 1024; c++) { l.decay[c] = 0; l.humidity[c] = 0; } // no humidity puddles: splash only
  // a pool of cells i 12..16 (x 14.4 .. 19.2 m: its east edge is the q0 | q1 tile line), j 10..20
  for (let j = 10; j < 20; j++) for (let i = 12; i < 16; i++) { l.floorCm[cellIdx(i, j)] = -150; l.waterCm[cellIdx(i, j)] = -20; }
  l.water.push({ x0: 12 * CELL, z0: 10 * CELL, x1: 16 * CELL, z1: 20 * CELL, y: -0.2, floorY: -1.5, kind: 0 });
  const nb = handNeighborhood(l);
  const tiles: TileKey[] = [{ s: 0, cx: 0, cz: 0, q: 0 }, { s: 0, cx: 0, cz: 0, q: 1 }];
  const jobs = tiles.map((t) => createJob(nb, t, Q_HIGH, null));
  const caches = jobs.map((j) => createMaskCache(j));
  /** Mask B of an up-facing floor texel at world (chunk-local) metres (x, z), evaluated by tile k's bake. */
  const wetAt = (k: number, x: number, z: number): number => {
    const g = jobs[k].g;
    const hx = x / CELL - g.gi0, hz = z / CELL - g.gj0;
    const c = Math.floor(hz) * g.n + Math.floor(hx);
    maskAt(jobs[k], caches[k], hx, g.floor[c], hz, 0, 1, 0, c, 1, 9);
    return maskOut.b;
  };

  it('wets the deck next to the water, fading out by 1.2 m, and leaves the pool floor and far floors dry', () => {
    let near = 0;
    for (let z = 12.1; z < 23.9; z += 0.37) near = Math.max(near, wetAt(1, 19.2 + 0.05, z));
    expect(near).toBeGreaterThan(0.4);
    expect(near).toBeLessThanOrEqual(0.75 + 1e-9);
    for (let z = 12.1; z < 23.9; z += 0.37) expect(wetAt(1, 19.2 + 1.25, z)).toBe(0);
    expect(wetAt(0, 16.5, 18)).toBe(0); // the submerged pool floor (below the water line)
    expect(wetAt(1, 30, 18)).toBe(0);
  });

  it('is seamless: both tiles bake the same value at the same world point', () => {
    let n = 0;
    for (let x = 18.5; x < 20.4; x += 0.13) {
      for (let z = 11.5; z < 24.5; z += 0.29) {
        expect(wetAt(0, x, z), `(${x}, ${z})`).toBeCloseTo(wetAt(1, x, z), 9); // (the mask is stored as bytes)
        if (wetAt(0, x, z) > 0) n++;
      }
    }
    expect(n).toBeGreaterThan(20);
  });
});

describe('surface mask: hard-floor traffic wear (texture realism v2 lane B)', () => {
  /** Mask A of an up-facing floor texel at chunk-local metres (x, z) of layout l (tile q0). */
  const wearAt = (l: ReturnType<typeof solidLayout>, x: number, z: number): number => {
    const job = createJob(handNeighborhood(l), { s: 0, cx: 0, cz: 0, q: 0 }, Q_HIGH, null);
    const cache = createMaskCache(job);
    const g = job.g;
    const hx = x / CELL - g.gi0, hz = z / CELL - g.gj0;
    const c = Math.floor(hz) * g.n + Math.floor(hx);
    maskAt(job, cache, hx, g.floor[c], hz, 0, 1, 0, c, 1, 9);
    return maskOut.a;
  };
  const corridor = (mat: number): ReturnType<typeof solidLayout> => {
    const l = solidLayout({ s: 0, cx: 0, cz: 0 });
    carveRoom(l, 2, 10, 14, 12); // a 2-cell corridor along x
    for (let c = 0; c < 1024; c++) { l.decay[c] = 128; l.humidity[c] = 0; l.floorMat[c] = mat; }
    return l;
  };

  it('concrete, terrazzo and VCT corridors wear like carpet at 0.8 x its amplitude', () => {
    const z = 11 * CELL, carpet = corridor(Mat.CARPET_L0);
    let n = 0;
    for (let x = 4.1; x < 15; x += 0.53) {
      const ref = wearAt(carpet, x, z);
      if (ref > 0) n++;
      for (const m of [Mat.CONCRETE_FLOOR, Mat.TERRAZZO, Mat.VINYL_VCT]) expect(wearAt(corridor(m), x, z), `${m} x ${x}`).toBeCloseTo(0.8 * ref, 2);
    }
    expect(n).toBeGreaterThan(5);
    expect(wearAt(corridor(Mat.POOL_TILE), 8, z)).toBe(0); // other floors: no traffic wear
  });

  it('rack aisles on concrete get two wheel tracks, nothing under the racks or in open floor', () => {
    const l = solidLayout({ s: 0, cx: 0, cz: 0 });
    carveRoom(l, 1, 1, 30, 30);
    for (let c = 0; c < 1024; c++) { l.decay[c] = 0; l.humidity[c] = 0; l.floorMat[c] = Mat.CONCRETE_FLOOR; }
    // two rows of shelf racks (2.4 x 1.1 m, long axis along x) either side of a 1.9 m aisle at z = 13.5
    for (const zr of [12.0, 15.0]) for (let x = 6.0; x < 16; x += 2.4) {
      l.props.push({ kind: PropKind.SHELF_RACK, variant: 0, x, y: 0, z: zr, yaw: 0, scale: 1, flags: 0, seed: 1 });
    }
    expect(wearAt(l, 8.4, 12.0)).toBe(0); // under a rack
    expect(wearAt(l, 25, 25)).toBe(0); // open floor, no racks
    const track = Math.max(wearAt(l, 9.1, 13.05), wearAt(l, 9.1, 13.95));
    expect(track).toBeGreaterThan(0.4);
    expect(wearAt(l, 9.1, 13.5)).toBeLessThan(0.6 * track); // between the tracks
    expect(wearAt(l, 9.1, 12.62)).toBeLessThan(0.5 * track); // next to the rack face
    // carpet keeps its own (corridor / threshold / lane) wear: no aisle tracks
    for (let c = 0; c < 1024; c++) l.floorMat[c] = Mat.CARPET_L0;
    expect(wearAt(l, 9.1, 13.05)).toBe(0);
  });

  it('hard floors wear in a fan from each door into the room', () => {
    const l = solidLayout({ s: 0, cx: 0, cz: 0 });
    carveRoom(l, 2, 2, 10, 12);
    carveRoom(l, 10, 2, 20, 12);
    setEx(l, 10, 6, EdgeKind.DOORWAY); // the door: line x = 12 m, z 7.2-8.4 m
    for (let c = 0; c < 1024; c++) { l.decay[c] = 128; l.humidity[c] = 0; l.floorMat[c] = Mat.TERRAZZO; }
    const zd = 6.5 * CELL;
    const near = wearAt(l, 12 + 1.0, zd), mid = wearAt(l, 12 + 2.0, zd), far = wearAt(l, 12 + 4.5, zd);
    expect(near).toBeGreaterThan(0.2);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(near);
    expect(far).toBe(0);
    expect(wearAt(l, 12 + 1.0, zd + 2.2)).toBe(0); // beside the fan
    expect(wearAt(l, 12 - 1.0, zd)).toBeGreaterThan(0.2); // both rooms
  });
});
