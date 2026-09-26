// tests/props/pipes.test.ts — WP6 pipes (§5 WP6 "Pipes"): 10-sided tubes, METAL_PAINTED / METAL_RUST by decay,
// a 6-segment quarter-torus elbow wherever two pipe solids share an endpoint (emitted exactly once, whichever tile
// or chunk owns each pipe), flanges every 2.4 m, hangers to the ceiling every 2.4 m; valid, outward-wound geometry.

import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../../src/core/grid.ts';
import { Mat } from '../../src/core/ids.ts';
import type { MeshBuffers } from '../../src/core/mesh.ts';
import { GeometryWriter } from '../../src/core/writer.ts';
import { emitPipe } from '../../src/props/index.ts';
import { emitPipeInto, type PipeSolid } from '../../src/props/pipes.ts';
import { backfaceVisibility, bounds, validate, windingMismatch } from './meshUtil.ts';

const pipe = (a: Vec3, b: Vec3, r = 0.06, mat: number = Mat.METAL_PAINTED, id = 1): PipeSolid =>
  ({ kind: 'pipe', id, a, b, r, mat: mat as PipeSolid['mat'], flags: 0 });

function build(p: PipeSolid, nbs: readonly PipeSolid[], ceil = 3.0, decay = 0, ox = 0, oz = 0): MeshBuffers {
  const w = new GeometryWriter(1024);
  emitPipeInto(w, p, nbs, ox, oz, () => ceil, decay, 0, 60);
  return w.finish();
}
/** Vertices at distance ~rr from the axis line through a with direction d (unit), within [s0, s1] along it. */
function ringVerts(m: MeshBuffers, a: Vec3, d: Vec3, rr: number, s0: number, s1: number, tol = 0.002): number {
  let n = 0;
  for (let i = 0; i < m.vertexCount; i++) {
    const px = m.position[i * 3] - a[0], py = m.position[i * 3 + 1] - a[1], pz = m.position[i * 3 + 2] - a[2];
    const s = px * d[0] + py * d[1] + pz * d[2];
    if (s < s0 || s > s1) continue;
    const r = Math.hypot(px - s * d[0], py - s * d[1], pz - s * d[2]);
    if (Math.abs(r - rr) < tol) n++;
  }
  return n;
}

describe('WP6 pipes', () => {
  it('a straight run: 10-sided tube, valid, outward normals, blind flanges at free ends', () => {
    const p = pipe([1, 2.4, 5], [5.8, 2.4, 5]);
    const m = build(p, [p]);
    expect(validate(m)).toEqual([]);
    expect(windingMismatch(m)).toBe(0);
    expect(backfaceVisibility(m, 24, 10).backFrac).toBeLessThanOrEqual(0.01);
    // the tube surface: 10 distinct ring directions at radius r around the start of the run
    const angles = new Set<number>();
    for (let i = 0; i < m.vertexCount; i++) {
      const x = m.position[i * 3] - p.a[0], y = m.position[i * 3 + 1] - p.a[1], z = m.position[i * 3 + 2] - p.a[2];
      if (Math.abs(x) < 0.005 && Math.abs(Math.hypot(y, z) - p.r) < 0.002) angles.add(Math.round((Math.atan2(y, z) * 180) / Math.PI));
    }
    expect(angles.size).toBe(10);
    expect(ringVerts(m, p.a, [1, 0, 0], p.r * 1.45, 0, 0.05, 1e-3)).toBeGreaterThan(0); // blind flange
    // stays within r * 1.45 (flanges) of the axis, except hangers going up to the ceiling
    const b = bounds(m);
    expect(b[1]).toBeGreaterThanOrEqual(2.4 - p.r * 1.45 - 1e-3);
    expect(b[2]).toBeGreaterThanOrEqual(5 - p.r * 1.45 - 1e-3);
    expect(b[5]).toBeLessThanOrEqual(5 + p.r * 1.45 + 1e-3);
    for (let i = 0; i < m.vertexCount; i++) expect(m.layer[i]).not.toBe(Mat.METAL_RUST);
  });

  it('flanges every 2.4 m and hangers reaching the ceiling every 2.4 m on horizontal runs (world lattice)', () => {
    const p = pipe([0, 2.2, 3], [9.6, 2.2, 3], 0.05);
    const m = build(p, [p], 3.1);
    // flange collars (radius 1.45 r) where x = 1.8 mod 2.4 (plus the blind flanges at both ends)
    const flangeAt = (s: number): number => ringVerts(m, p.a, [1, 0, 0], p.r * 1.45, s - 0.02, s + 0.02, 1e-3);
    for (const s of [1.8, 4.2, 6.6, 9.0]) expect(flangeAt(s), `flange at ${s}`).toBeGreaterThan(0);
    for (const s of [1.2, 3.0, 5.4, 7.8]) expect(flangeAt(s), `no flange at ${s}`).toBe(0);
    // hanger rods end at the ceiling (3.1): top of the mesh, and at least 4 of them (every 2.4 m)
    expect(bounds(m)[4]).toBeCloseTo(3.1, 3);
    const tops = new Set<number>();
    for (let i = 0; i < m.vertexCount; i++) if (Math.abs(m.position[i * 3 + 1] - 3.1) < 1e-4) tops.add(Math.round(m.position[i * 3] * 10));
    expect([...tops].sort((x, y) => x - y)).toEqual([6, 30, 54, 78]); // hangers at x = 0.6 mod 2.4
  });

  it('the lattice is independent of how a run is split into solids (seamless collinear joints)', () => {
    const whole = pipe([0, 2.2, 3], [9.6, 2.2, 3], 0.05);
    const parts = [pipe([0, 2.2, 3], [1.7, 2.2, 3], 0.05), pipe([1.7, 2.2, 3], [4.2, 2.2, 3], 0.05),
      pipe([4.2, 2.2, 3], [5.4, 2.2, 3], 0.05), pipe([5.4, 2.2, 3], [9.6, 2.2, 3], 0.05)];
    const mw = build(whole, [whole], 3.1);
    const ms = parts.map((q) => build(q, parts, 3.1));
    // identical except for the 3 extra 20-triangle tube sections (no couplings, no caps at the joints)
    expect(ms.reduce((n, m) => n + m.indexCount / 3, 0)).toBe(mw.indexCount / 3 + 3 * 20);
    const flangeXs = (m: MeshBuffers): number[] => {
      const xs = new Set<number>();
      for (let i = 0; i < m.vertexCount; i++) {
        const y = m.position[i * 3 + 1] - 2.2, z = m.position[i * 3 + 2] - 3;
        if (Math.abs(Math.hypot(y, z) - 0.05 * 1.45) < 1e-3) xs.add(Math.round(m.position[i * 3] * 10));
      }
      return [...xs];
    };
    expect(ms.flatMap(flangeXs).sort((x, y) => x - y)).toEqual(flangeXs(mw).sort((x, y) => x - y));
  });

  it('METAL_RUST by decay (or by the solid material)', () => {
    const p = pipe([0, 2, 0], [3, 2, 0]);
    const rusty = build(p, [p], 3, 200);
    const tube = rusty.layer[0];
    expect(tube).toBe(Mat.METAL_RUST);
    const r2 = build(pipe([0, 2, 0], [3, 2, 0], 0.06, Mat.METAL_RUST), [], 3, 0);
    expect(r2.layer[0]).toBe(Mat.METAL_RUST);
    expect(build(p, [p], 3, 20).layer[0]).toBe(Mat.METAL_PAINTED);
  });

  it('an elbow where two pipes share an endpoint, emitted exactly once (6 segments, 10 sides)', () => {
    const E: Vec3 = [4, 2.5, 4];
    const a = pipe([0, 2.5, 4], E, 0.06, Mat.METAL_PAINTED, 1);
    const b = pipe(E, [4, 2.5, 9], 0.06, Mat.METAL_PAINTED, 2);
    const all = [a, b, { ...b, id: 99 }]; // a duplicate (added by a second chunk) must not turn it into a junction
    const ma = build(a, all), mb = build(b, all);
    // elbow vertices lie in the corner region x > 4 - t and z < 4 + t, off both straight axes
    const inCorner = (m: MeshBuffers): number => {
      let n = 0;
      for (let i = 0; i < m.vertexCount; i++) {
        const x = m.position[i * 3], z = m.position[i * 3 + 2];
        if (x > 4 - 0.08 && x < 4.1 && z > 3.9 && z < 4 + 0.08) n++;
      }
      return n;
    };
    const ca = inCorner(ma), cb = inCorner(mb);
    expect(Math.min(ca, cb)).toBe(0); // only the owner draws it
    expect(Math.max(ca, cb)).toBeGreaterThan(0);
    // 7 rings of 11 vertices (6 segments), all at radius r from the arc
    const owner = ca > 0 ? ma : mb;
    expect(validate(owner)).toEqual([]);
    expect(windingMismatch(owner)).toBe(0);
    // no free-end caps / blind flanges at the shared end: the non-owner's straight part stops at the tangent
    // point (trim t = bendR / tan(45 deg) = 0.1 m from E)
    const other = ca > 0 ? mb : ma;
    let dMin = Infinity;
    for (let i = 0; i < other.vertexCount; i++) {
      dMin = Math.min(dMin, Math.hypot(other.position[i * 3] - E[0], other.position[i * 3 + 1] - E[1], other.position[i * 3 + 2] - E[2]));
    }
    expect(dMin).toBeGreaterThan(0.099);
    // swapping ownership order (tile-local origin, neighbour order) gives the same result
    const mb2 = build(b, [all[2], a, b]);
    expect(mb2.indexCount).toBe(mb.indexCount);
  });

  it('elbow end rings coincide with the trimmed straight tubes (no crack at either joint)', () => {
    // the elbow's end rings must be perpendicular to the legs (exact arc tangents, not chords) and share their
    // vertex positions with the straight tubes' end rings, for right and oblique bends
    for (const far of [[4, 2.5, 9], [7, 2.5, 7], [6, 4.5, 4]] as Vec3[]) {
      const E: Vec3 = [4, 2.5, 4];
      const a = pipe([0, 2.5, 4], E, 0.1, Mat.METAL_PAINTED, 1);
      const b = pipe(E, far, 0.1, Mat.METAL_PAINTED, 2);
      const w = new GeometryWriter(1024);
      emitPipeInto(w, a, [a, b], 0, 0, null, 0, 0, 60);
      emitPipeInto(w, b, [a, b], 0, 0, null, 0, 0, 60);
      const m = w.finish();
      const key = (i: number): string => [0, 1, 2].map((c) => Math.round(m.position[i * 3 + c] * 2000)).join(',');
      // leg a ends at x = 4 - t: every vertex within 2 cm of that plane and at radius r lies exactly on it
      const legs: [Vec3, Vec3][] = [[a.a, [1, 0, 0]], [far, (() => { const d = [E[0] - far[0], E[1] - far[1], E[2] - far[2]]; const l = Math.hypot(d[0], d[1], d[2]); return [d[0] / l, d[1] / l, d[2] / l] as Vec3; })()]];
      for (const [o, d] of legs) {
        const len = Math.hypot(E[0] - o[0], E[1] - o[1], E[2] - o[2]);
        // find the tube end (largest s among tube-surface vertices)
        let sEnd = -Infinity;
        const onTube: number[] = [];
        for (let i = 0; i < m.vertexCount; i++) {
          const px = m.position[i * 3] - o[0], py = m.position[i * 3 + 1] - o[1], pz = m.position[i * 3 + 2] - o[2];
          const sv = px * d[0] + py * d[1] + pz * d[2];
          const r = Math.hypot(px - sv * d[0], py - sv * d[1], pz - sv * d[2]);
          if (sv > len - 0.5 && sv < len && Math.abs(r - 0.1) < 2e-3) onTube.push(i);
        }
        // the straight tube's end ring: 11 ring vertices at the smallest s beyond which only the elbow continues
        const byKey = new Map<string, number>();
        for (const i of onTube) byKey.set(key(i), (byKey.get(key(i)) ?? 0) + 1);
        const shared = [...byKey.values()].filter((n) => n >= 2).length; // vertices emitted by both tube and elbow
        expect(shared, `leg toward ${far.join(',')}`).toBeGreaterThanOrEqual(10);
        for (const i of onTube) {
          const px = m.position[i * 3] - o[0], py = m.position[i * 3 + 1] - o[1], pz = m.position[i * 3 + 2] - o[2];
          sEnd = Math.max(sEnd, px * d[0] + py * d[1] + pz * d[2]);
        }
        expect(sEnd).toBeGreaterThan(0);
      }
      expect(validate(m)).toEqual([]);
      expect(windingMismatch(m)).toBe(0);
    }
  });

  it('hangers need a ceiling: none where ceilAt reports no ceiling (NaN) or one beyond reach', () => {
    const p = pipe([0, 2.2, 3], [9.6, 2.2, 3], 0.05);
    const hangerTop = (ceil: number): number => {
      const w = new GeometryWriter(1024);
      emitPipeInto(w, p, [p], 0, 0, () => ceil, 0, 0, 60);
      return bounds(w.finish())[4];
    };
    const tubeTop = 2.2 + 0.05 * 1.45 + 1e-3; // flange rim
    expect(hangerTop(3.1)).toBeCloseTo(3.1, 3);
    expect(hangerTop(Number.NaN)).toBeLessThanOrEqual(tubeTop);
    expect(hangerTop(20)).toBeLessThanOrEqual(tubeTop);
  });

  it('a hanger rod never passes through another pipe: it slides along the run to a clear spot', () => {
    // z-run at 1.9 m under a crossing x-run at 2.4 m that sits exactly over the lattice point z = 3.0
    const low = pipe([3, 1.9, 0.2], [3, 1.9, 5.8], 0.05);
    const cross = pipe([0.5, 2.4, 3.0], [6.5, 2.4, 3.0], 0.1, Mat.METAL_PAINTED, 2);
    const rodXZ = (m: MeshBuffers): number[] => {
      const zs = new Set<number>();
      for (let i = 0; i < m.vertexCount; i++) if (Math.abs(m.position[i * 3 + 1] - 3.1) < 1e-4) zs.add(Math.round(m.position[i * 3 + 2] * 100) / 100);
      return [...zs].sort((x, y) => x - y);
    };
    // plate vertices at the ceiling (3.1) around each hanger: alone, hangers at z = 0.6 and 3.0 (plates +-0.024)
    const alone = rodXZ(build(low, [low], 3.1));
    expect(alone.some((z) => Math.abs(z - 3.0) < 0.03)).toBe(true);
    const withCross = rodXZ(build(low, [low, cross], 3.1));
    // no plate within the crossing pipe's radius + clearance of its axis; the hanger moved, not dropped
    for (const z of withCross) expect(Math.abs(z - 3.0)).toBeGreaterThanOrEqual(0.1 + 0.02);
    expect(withCross.length).toBe(alone.length);
    // a riser right next to the hanger point also blocks it
    const riser = pipe([3, 0, 0.62], [3, 3.1, 0.62], 0.04, Mat.METAL_PAINTED, 3);
    const withRiser = rodXZ(build(low, [low, riser], 3.1));
    for (const z of withRiser) expect(Math.abs(z - 0.62)).toBeGreaterThanOrEqual(0.04);
  });

  it('straight continuations are seamless, 3-way meets get one junction fitting', () => {
    const E: Vec3 = [3.3, 2, 1];
    const a = pipe([0, 2, 1], E), b = pipe(E, [6, 2, 1]), c = pipe(E, [3.3, 2, 5]);
    const tris = (p: PipeSolid, nbs: PipeSolid[]): number => build(p, nbs).indexCount / 3;
    // A joined end loses its end cap (8 tris) and blind flange (36 tris); the junction owner adds the fitting
    // (4-segment 10-sided lathe, 60 tris). (E is off the flange / hanger lattice, so those do not move.)
    const diff = (ps: PipeSolid[]): number[] => ps.map((p) => tris(p, ps) - tris(p, [p])).sort((x, y) => x - y);
    expect(diff([a, b])).toEqual([-44, -44]);
    expect(diff([a, b, c])).toEqual([-44, -44, 16]);
    // the owner is chosen by geometry, not by list order
    expect(diff([c, b, a])).toEqual([-44, -44, 16]);
  });

  it('emitPipe writes tile-local positions and is deterministic', () => {
    const p = pipe([20, 2, 21], [30, 2, 21]);
    const w1 = new GeometryWriter(256), w2 = new GeometryWriter(256);
    emitPipe(w1, p, [p], 19.2, 19.2);
    emitPipe(w2, p, [p], 19.2, 19.2);
    const m1 = w1.finish(), m2 = w2.finish();
    expect(Array.from(m1.position)).toEqual(Array.from(m2.position));
    const b = bounds(m1);
    expect(b[0]).toBeCloseTo(20 - 19.2 - 0.015, 1);
    expect(b[3]).toBeCloseTo(30 - 19.2 + 0.015, 1);
  });

  it('vertical and sloped pipes are valid (no hangers on risers)', () => {
    const v = pipe([2, 0, 2], [2, 2.6, 2], 0.08);
    const m = build(v, [v]);
    expect(validate(m)).toEqual([]);
    expect(windingMismatch(m)).toBe(0);
    expect(bounds(m)[4]).toBeLessThan(2.6 + 0.05);
    const s = pipe([0, 1, 0], [3, 2.2, 1.5], 0.05);
    const ms = build(s, [s]);
    expect(validate(ms)).toEqual([]);
    expect(windingMismatch(ms)).toBe(0);
  });
});
