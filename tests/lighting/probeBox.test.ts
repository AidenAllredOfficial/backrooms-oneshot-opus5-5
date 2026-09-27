// tests/lighting/probeBox.test.ts — package D: the reflection probe's room box (lighting/probeBox.ts) from 12
// horizontal rays plus parallel axis rays: exact extents in a box room, a single pillar does not shrink it (per-axis
// median), an L-shaped room, corridors (their full length, but never through the doorway at their end), the clamps,
// and the floor / ceiling fallbacks.

import { describe, expect, it } from 'vitest';
import { PROBE_BOX, probeBox } from '../../src/lighting/probeBox.ts';
import type { ProbeBoxQuery } from '../../src/lighting/probeBox.ts';

/** Distance from (x, z) along (dx, dz) to the inside of the axis-aligned rectangle [x0, x1] x [z0, z1]. */
function rectExit(x: number, z: number, dx: number, dz: number, x0: number, x1: number, z0: number, z1: number): number {
  const tx = dx > 1e-9 ? (x1 - x) / dx : dx < -1e-9 ? (x0 - x) / dx : Infinity;
  const tz = dz > 1e-9 ? (z1 - z) / dz : dz < -1e-9 ? (z0 - z) / dz : Infinity;
  return Math.min(tx, tz);
}

/** A room made of rectangles (their union is free space; rays stop where they leave it), a floor and a ceiling. */
function world(rects: [number, number, number, number][], floor = 0, ceil = 3): ProbeBoxQuery & { rays: number } {
  const q = {
    rays: 0,
    rayDistance(x: number, _y: number, z: number, dx: number, dz: number, maxDist: number): number {
      q.rays++;
      // march: the ray is inside while any rectangle contains the point (1 cm steps are exact enough here)
      let t = 0;
      for (; t < maxDist; t += 0.01) {
        const px = x + dx * t, pz = z + dz * t;
        if (!rects.some(([x0, x1, z0, z1]) => px >= x0 && px <= x1 && pz >= z0 && pz <= z1)) break;
      }
      return Math.min(t, maxDist);
    },
    floorAt: () => floor,
    ceilingAt: () => ceil,
  };
  return q;
}

const box = (): Float64Array => new Float64Array(6);

describe('probeBox', () => {
  it('a box room gives its exact extents from any anchor inside it', () => {
    const w = world([[0, 8, 0, 6]], 0, 2.8);
    for (const [x, z] of [[4, 3], [1.5, 2], [6.5, 5]]) {
      const b = probeBox(w, x, 1.62, z, 0, box());
      expect(b[0]).toBeCloseTo(0, 1);
      expect(b[3]).toBeCloseTo(8, 1);
      expect(b[2]).toBeCloseTo(0, 1);
      expect(b[5]).toBeCloseTo(6, 1);
      expect(b[1]).toBe(0);
      expect(b[4]).toBe(2.8);
    }
    // 12 rays + 2 parallel rays per axis
    expect(w.rays).toBe(3 * (PROBE_BOX.RAYS + 8));
    // the analytic exit distances agree with the marcher
    expect(rectExit(4, 3, 1, 0, 0, 8, 0, 6)).toBe(4);
  });

  it('a pillar in one ray does not shrink the box (median of the three rays around each axis)', () => {
    // a 10 x 10 room with a thin pillar 2 m ahead along +x: the +x ray stops at it, its neighbours at +-30 deg do not
    const rects: [number, number, number, number][] = [[0, 10, 0, 4.8], [0, 10, 5.2, 10], [0, 6.9, 4.8, 5.2], [7.3, 10, 4.8, 5.2]];
    const b = probeBox(world(rects), 5, 1.62, 5, 0, box());
    expect(b[3]).toBeCloseTo(10, 1);
  });

  it('an L-shaped room: each axis takes the wall its rays agree on', () => {
    // L = [0, 12] x [0, 4] plus [0, 4] x [0, 12]; the anchor in the corner square
    const w = world([[0, 12, 0, 4], [0, 4, 0, 12]]);
    const b = probeBox(w, 2, 1.62, 2, 0, box());
    expect(b[0]).toBeCloseTo(0, 1);
    expect(b[2]).toBeCloseTo(0, 1);
    // +x: the axis ray reaches 12 m, the +-30 deg rays hit the leg's walls within ~4 m: the median is theirs
    expect(b[3] - 2).toBeGreaterThan(1.5);
    expect(b[3] - 2).toBeLessThan(10);
    expect(b[5] - 2).toBeGreaterThan(1.5);
    expect(b[5] - 2).toBeLessThan(10);
  });

  it('a corridor keeps its length: the +-30 deg rays on the side walls only bound the axis from below', () => {
    // 30 x 2.4 m; the +-30 deg rays meet the side walls 2.1 m ahead, which alone would end the box there
    const w = world([[0, 30, 0, 2.4]]);
    for (const [x, z] of [[5, 1.2], [5, 0.4], [20, 2.0]]) {
      const b = probeBox(w, x, 1.62, z, 0, box());
      expect(b[3], `+x from ${x},${z}`).toBeCloseTo(30, 1);
      expect(b[0], `-x from ${x},${z}`).toBeCloseTo(0, 1);
      expect(b[2]).toBeLessThanOrEqual(0.01);
      expect(b[5]).toBeGreaterThanOrEqual(2.39);
      expect(b[5] - b[2]).toBeLessThan(3.7); // the MIN clamp near a side wall adds at most 0.6 - 0.4
    }
  });

  it('a corridor ending in a doorway: the parallel rays stop at the end wall (no box through the door)', () => {
    // a 0.9 m door in the end wall (30.0-30.2) opening into a 10 x 12 m room; the anchor on the door's axis
    const w = world([[0, 30, 0, 2.4], [29.9, 30.3, 0.75, 1.65], [30.2, 40, -5, 7]]);
    const b = probeBox(w, 5, 1.62, 1.2, 0, box());
    expect(b[3]).toBeCloseTo(30, 1);
  });

  it('a pillar on a corridor\'s axis: the parallel rays pass it', () => {
    const w = world([[0, 10, 0, 2.4], [10.4, 30, 0, 2.4], [10, 10.4, 0, 1.0], [10, 10.4, 1.4, 2.4]]);
    const b = probeBox(w, 5, 1.62, 1.2, 0, box());
    expect(b[3]).toBeCloseTo(30, 1);
  });

  it('clamps the half-extents to [MIN, MAX]', () => {
    const tight = probeBox(world([[0, 0.4, 0, 0.4]]), 0.2, 1.62, 0.2, 0, box());
    expect(tight[3] - 0.2).toBeCloseTo(PROBE_BOX.MIN, 6);
    expect(0.2 - tight[0]).toBeCloseTo(PROBE_BOX.MIN, 6);
    const open: ProbeBoxQuery = { rayDistance: (_x, _y, _z, _dx, _dz, m) => m + 100, floorAt: () => 0, ceilingAt: () => 3 };
    const wide = probeBox(open, 0, 1.62, 0, 0, box());
    // every ray capped at MAX: the median is a +-30 deg ray's projection
    expect(wide[3]).toBeCloseTo(PROBE_BOX.MAX * Math.cos(Math.PI / 6), 9);
    expect(wide[0]).toBeCloseTo(-PROBE_BOX.MAX * Math.cos(Math.PI / 6), 9);
  });

  it('non-finite floor / ceiling answers fall back to the feet / eye + CEIL_FALLBACK, and always bracket the eye', () => {
    const q: ProbeBoxQuery = { rayDistance: () => 3, floorAt: () => NaN, ceilingAt: () => Infinity };
    const b = probeBox(q, 0, 1.62, 0, 0.1, box());
    expect(b[1]).toBe(0.1);
    expect(b[4]).toBeCloseTo(1.62 + PROBE_BOX.CEIL_FALLBACK, 9);
    const inverted: ProbeBoxQuery = { rayDistance: () => 3, floorAt: () => 2.5, ceilingAt: () => 1 };
    const c = probeBox(inverted, 0, 1.62, 0, 0, box());
    expect(c[1]).toBeLessThan(1.62);
    expect(c[4]).toBeGreaterThan(1.62);
  });
});
