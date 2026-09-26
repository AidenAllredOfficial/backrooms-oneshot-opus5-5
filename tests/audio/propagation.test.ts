// tests/audio/propagation.test.ts — WP13 propagation acceptance: in an L-shaped corridor the apparent source lies
// at the doorway cell, the path excess is correct and the bend count is 1; unreachable sources are flagged.

import { describe, expect, it } from 'vitest';
import { CELL } from '../../src/core/constants.ts';
import {
  airCutoff, createPropagationField, createResolution, fieldIndex, occlusionCutoff, propagate, resolveSource, SourceKind,
  type PropagationGrid, type SightTest,
} from '../../src/audio/propagation.ts';

/** Grid fixture from a set of walkable cells and optional per-edge overrides. */
function fixture(cells: [number, number][], edges: Record<string, number> = {}): { grid: PropagationGrid; sight: SightTest; walk: (i: number, j: number) => boolean } {
  const set = new Set(cells.map(([i, j]) => `${i},${j}`));
  const walk = (i: number, j: number): boolean => set.has(`${i},${j}`);
  const edge = (axis: 'x' | 'z', gi: number, gj: number): number => {
    const k = `${axis}${gi},${gj}`;
    if (k in edges) return edges[k];
    const a = axis === 'x' ? walk(gi - 1, gj) : walk(gi, gj - 1);
    return a && walk(gi, gj) ? 1 : 0;
  };
  const grid: PropagationGrid = { walkable: walk, edge };
  // sight: march the segment; every visited cell must be walkable and every crossed edge passable
  const sight: SightTest = (ax, _ay, az, bx, _by, bz) => {
    const len = Math.hypot(bx - ax, bz - az);
    const n = Math.max(2, Math.ceil(len / 0.02));
    let pi = Math.floor(ax / CELL), pj = Math.floor(az / CELL);
    if (!walk(pi, pj)) return false;
    for (let s = 1; s <= n; s++) {
      const x = ax + ((bx - ax) * s) / n, z = az + ((bz - az) * s) / n;
      const ci = Math.floor(x / CELL), cj = Math.floor(z / CELL);
      if (ci === pi && cj === pj) continue;
      if (!walk(ci, cj)) return false;
      if (ci !== pi && edge('x', Math.max(ci, pi), pj) <= 0) return false;
      if (cj !== pj && edge('z', ci, Math.max(cj, pj)) <= 0) return false;
      pi = ci; pj = cj;
    }
    return true;
  };
  return { grid, sight, walk };
}

const centre = (i: number): number => (i + 0.5) * CELL;

describe('propagate (L-shaped corridor)', () => {
  // horizontal arm gj = 0, gi = 0..9; a DOORWAY edge (0.9) on line x = 10 into the corner cell (10, 0);
  // vertical arm gi = 10, gj = 0..10. A sealed pocket at (5, 5).
  const cells: [number, number][] = [];
  for (let i = 0; i <= 9; i++) cells.push([i, 0]);
  for (let j = 0; j <= 10; j++) cells.push([10, j]);
  cells.push([5, 5]);
  const { grid, sight } = fixture(cells, { 'x10,0': 0.9 });
  const f = createPropagationField(24);
  propagate(grid, [2, 0], 24, f);

  it('computes path lengths in cells and prev chains to the listener', () => {
    expect(f.size).toBe(49);
    expect(f.gi0).toBe(2 - 24);
    expect(f.dist[fieldIndex(f, 2, 0)]).toBe(0);
    expect(f.dist[fieldIndex(f, 9, 0)]).toBe(7);
    expect(f.dist[fieldIndex(f, 10, 0)]).toBe(8);
    expect(f.dist[fieldIndex(f, 10, 8)]).toBe(16);
    // walk the chain back from the source to the listener
    let k = fieldIndex(f, 10, 8), steps = 0;
    while (f.prev[k] >= 0) { k = f.prev[k]; steps++; }
    expect(k).toBe(fieldIndex(f, 2, 0));
    expect(steps).toBe(16);
  });

  it('counts bends: 0 along the first arm, 1 around the corner', () => {
    expect(f.bends[fieldIndex(f, 9, 0)]).toBe(0);
    expect(f.bends[fieldIndex(f, 10, 0)]).toBe(0);
    expect(f.bends[fieldIndex(f, 10, 1)]).toBe(1);
    expect(f.bends[fieldIndex(f, 10, 8)]).toBe(1);
  });

  it('flags unreachable cells (sealed pocket, walls)', () => {
    expect(f.dist[fieldIndex(f, 5, 5)]).toBe(Infinity);
    expect(f.prev[fieldIndex(f, 5, 5)]).toBe(-1);
    expect(f.dist[fieldIndex(f, 5, 1)]).toBe(Infinity);
  });

  it('places the apparent source at the doorway cell with the correct path excess', () => {
    const r = createResolution();
    const lx = centre(2), ly = 1.6, lz = centre(0);
    const sx = centre(10), sz = centre(8);
    resolveSource(f, sight, lx, ly, lz, sx, ly, sz, r);
    expect(r.kind).toBe(SourceKind.OCCLUDED);
    expect(r.portalIdx).toBe(fieldIndex(f, 10, 0)); // the doorway cell
    const lp = centre(10) - lx; // listener -> portal (same row)
    const tail = 8 * CELL; // portal -> source along the vertical arm
    const euclid = Math.hypot(sx - lx, sz - lz);
    expect(r.path).toBeCloseTo(lp + tail, 6);
    expect(r.euclid).toBeCloseTo(euclid, 6);
    expect(r.excess).toBeCloseTo(lp + tail - euclid, 6);
    expect(r.bends).toBe(1);
    // apparent position: listener + dir(portal) * path  (the portal is straight down the corridor, +x)
    expect(r.x).toBeCloseTo(lx + r.path, 6);
    expect(r.z).toBeCloseTo(lz, 6);
    // occlusion low-pass from the excess (and air absorption over the path), -3 dB per bend
    expect(r.cutoff).toBeCloseTo(Math.min(occlusionCutoff(r.excess), airCutoff(r.path)), 6);
    expect(r.cutoff).toBeCloseTo(Math.max(500, 20000 * Math.exp(-0.35 * r.excess)), 6);
    expect(20 * Math.log10(r.gain)).toBeCloseTo(-3, 6);
  });

  it('line-of-sight sources keep their true position with air absorption only', () => {
    const r = createResolution();
    resolveSource(f, sight, centre(2), 1.6, centre(0), centre(9), 1.6, centre(0), r);
    expect(r.kind).toBe(SourceKind.LOS);
    expect(r.x).toBeCloseTo(centre(9), 6);
    expect(r.excess).toBe(0);
    expect(r.gain).toBe(1);
    expect(r.cutoff).toBeCloseTo(Math.max(2000, 20000 * Math.exp(-(7 * CELL) / 40)), 6);
  });

  it('unreachable sources: true position, 300 Hz low-pass, -18 dB', () => {
    const r = createResolution();
    resolveSource(f, sight, centre(2), 1.6, centre(0), centre(5), 1.6, centre(5), r);
    expect(r.kind).toBe(SourceKind.UNREACHABLE);
    expect(r.x).toBeCloseTo(centre(5), 6);
    expect(r.z).toBeCloseTo(centre(5), 6);
    expect(r.cutoff).toBe(300);
    expect(20 * Math.log10(r.gain)).toBeCloseTo(-18, 6);
  });

  it('sources outside the window are flagged OUTSIDE', () => {
    const r = createResolution();
    resolveSource(f, sight, centre(2), 1.6, centre(0), centre(60), 1.6, centre(40), r);
    expect(r.kind).toBe(SourceKind.OUTSIDE);
  });

  it('a closed door (edge 0) makes the far arm unreachable', () => {
    const g2 = fixture(cells, { 'x10,0': 0 });
    const f2 = createPropagationField(24);
    propagate(g2.grid, [2, 0], 24, f2);
    expect(f2.dist[fieldIndex(f2, 10, 8)]).toBe(Infinity);
    const r = createResolution();
    resolveSource(f2, g2.sight, centre(2), 1.6, centre(0), centre(10), 1.6, centre(8), r);
    expect(r.kind).toBe(SourceKind.UNREACHABLE);
  });
});

describe('propagate (open room, two turns)', () => {
  it('prefers the fewest-bend path among equal-length ones', () => {
    const cells: [number, number][] = [];
    for (let i = 0; i < 12; i++) for (let j = 0; j < 12; j++) cells.push([i, j]);
    const { grid } = fixture(cells);
    const f = createPropagationField(24);
    propagate(grid, [0, 0], 24, f);
    expect(f.dist[fieldIndex(f, 7, 5)]).toBe(12);
    expect(f.bends[fieldIndex(f, 7, 5)]).toBe(1);
    expect(f.bends[fieldIndex(f, 7, 0)]).toBe(0);
  });
  it('Z-shaped corridor counts 2 bends and the portal is the first visible cell', () => {
    // (0..5, 0) -> (5, 0..5) -> (5..10, 5)
    const cells: [number, number][] = [];
    for (let i = 0; i <= 5; i++) cells.push([i, 0]);
    for (let j = 1; j <= 5; j++) cells.push([5, j]);
    for (let i = 6; i <= 10; i++) cells.push([i, 5]);
    const { grid, sight } = fixture(cells);
    const f = createPropagationField(24);
    propagate(grid, [0, 0], 24, f);
    expect(f.bends[fieldIndex(f, 10, 5)]).toBe(2);
    const r = createResolution();
    resolveSource(f, sight, centre(0), 1.6, centre(0), centre(10), 1.6, centre(5), r);
    expect(r.kind).toBe(SourceKind.OCCLUDED);
    expect(r.portalIdx).toBe(fieldIndex(f, 5, 0));
    expect(r.path).toBeCloseTo(5 * CELL + 10 * CELL, 6);
    expect(20 * Math.log10(r.gain)).toBeCloseTo(-6, 6);
  });
  it('does not allocate a new field and tolerates radius > capacity', () => {
    const { grid } = fixture([[0, 0], [1, 0]]);
    const f = createPropagationField(4);
    propagate(grid, [0, 0], 24, f);
    expect(f.size).toBe(9);
    expect(f.dist[fieldIndex(f, 1, 0)]).toBe(1);
  });
});
