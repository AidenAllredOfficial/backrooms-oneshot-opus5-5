// tests/mesh/junctions.test.ts — WP5: closed junctions and clipped replicas.
// - vertical faces reaching a TILES ceiling run up to the tile back (tiles sit 10 mm above the grid face), so no slot
//   opens between the wall top and the ceiling tiles;
// - a wall between two cells of one METAL_GRATE patch closes the plenum pit under it;
// - tower ramp replicas that straddle +-TOWER_SPAN are clipped (clipRamp), not kept whole;
// - T-junctions between shell faces are closed (tjunction.ts).

import { describe, expect, test } from 'vitest';
import { CELL, WALL_T } from '../../src/core/constants.ts';
import { cellIdx, tileCell0 } from '../../src/core/grid.ts';
import { Mat, SolidFlag } from '../../src/core/ids.ts';
import type { ChunkLayout, Solid } from '../../src/core/layout.ts';
import type { LayoutNeighborhood } from '../../src/core/world.ts';
import { buildTile } from '../../src/mesh/buildTile.ts';
import { clipRamp } from '../../src/mesh/periodic.ts';
import { mkFace, state, type Face } from '../../src/mesh/plan.ts';
import { fanStart, repairTJunctions } from '../../src/mesh/tjunction.ts';
import { Scene } from './fixtures.ts';
import { asciiNb, tileKey } from './helpers.ts';
import { TriSoup } from './raycast.ts';

type Ramp = Extract<Solid, { kind: 'ramp' }>;

function chunkSoup(nb: LayoutNeighborhood): TriSoup {
  const soup = new TriSoup();
  for (let q = 0; q < 4; q++) {
    const { mesh } = buildTile(nb, tileKey(0, 0, 0, q), 12);
    const [li0, lj0] = tileCell0(q);
    soup.add(mesh.shell, li0 * CELL, lj0 * CELL);
  }
  return soup;
}

const castTo = (soup: TriSoup, o: number[], p: number[]) => {
  const d = [p[0] - o[0], p[1] - o[1], p[2] - o[2]];
  const l = Math.hypot(d[0], d[1], d[2]);
  return soup.cast(o, [d[0] / l, d[1] / l, d[2] / l], 100);
};

describe('wall / ceiling-tile junction', () => {
  // a room with a TILES ceiling (ascii default) and a thin wall stub inside
  const s = new Scene();
  s.room(2, 2, 12, 12);
  for (let j = 4; j < 7; j++) s.xEdge(6, j, '|');
  const nb = asciiNb(s.text());
  const soup = chunkSoup(nb);
  const ceil = nb.ceilCm(5, 5) / 100;

  test('rays aimed just under the tile back hit the wall face, not the tile / T-bar behind a slot', () => {
    const bad: string[] = [];
    const aim = (o: number[], p: number[], planeAxis: 0 | 2, plane: number, label: string): void => {
      const h = castTo(soup, o, p);
      if (!h) { bad.push(`${label}: escape`); return; }
      const len = Math.hypot(p[0] - o[0], p[1] - o[1], p[2] - o[2]);
      const hitPlane = o[planeAxis] + ((p[planeAxis] - o[planeAxis]) / len) * h.t;
      if (!h.front || Math.abs(h.ny) > 0.1 || Math.abs(hitPlane - plane) > 2e-3) {
        bad.push(`${label}: hit t=${h.t.toFixed(3)} n=(${h.nx.toFixed(2)},${h.ny.toFixed(2)},${h.nz.toFixed(2)}) at ${hitPlane.toFixed(4)}, expected the face at ${plane.toFixed(4)}`);
      }
    };
    // targets avoid the 24 mm T-bar bands on the 0.6 m lines (x, z = 0.6 k +- 12 mm)
    for (const y of [ceil + 0.003, ceil + 0.007]) {
      // perimeter wall on line x = 2 (face plane x = 2.4 + WALL_T/2), seen from inside the room
      aim([5.5 * CELL, 1.6, 5.3 * CELL], [2 * CELL + WALL_T / 2, y, 5.6 * CELL], 0, 2 * CELL + WALL_T / 2, `perimeter y=${y}`);
      // thin wall stub on line x = 6, both sides
      aim([4.5 * CELL, 1.6, 5.2 * CELL], [6 * CELL - WALL_T / 2, y, 5.25 * CELL], 0, 6 * CELL - WALL_T / 2, `stub -x y=${y}`);
      aim([7.5 * CELL, 1.6, 5.2 * CELL], [6 * CELL + WALL_T / 2, y, 5.25 * CELL], 0, 6 * CELL + WALL_T / 2, `stub +x y=${y}`);
      // post at the stub's free end (vertex (6, 7)): its +z face, x in [7.125, 7.275] off the x = 7.2 T-bar band
      aim([7.14, 1.6, 9.5 * CELL], [7.14, y, 7 * CELL + WALL_T / 2], 2, 7 * CELL + WALL_T / 2, `post y=${y}`);
    }
    expect(bad).toEqual([]);
  });
});

describe('METAL_GRATE plenum pit', () => {
  test('a wall between two cells of one grate patch closes the pit under it (both sides)', () => {
    const s = new Scene();
    s.room(2, 2, 12, 12);
    s.xEdge(6, 5, '|'); // wall stub between grate cells (5, 5) and (6, 5)
    const nb = asciiNb(s.text(), undefined, (l: ChunkLayout) => {
      for (let i = 3; i < 9; i++) l.floorMat[cellIdx(i, 5)] = Mat.METAL_GRATE;
    });
    const soup = chunkSoup(nb);
    const bad: string[] = [];
    for (const [ox, dir, plane] of [[4.5, 1, 6 * CELL - WALL_T / 2], [7.5, -1, 6 * CELL + WALL_T / 2]] as const) {
      const o = [ox * CELL, -0.2, 5.5 * CELL + 0.013];
      const h = soup.cast(o, [dir, 0.0001, 0.0002], 100);
      if (!h) { bad.push(`escape from x=${ox}`); continue; }
      const x = o[0] + dir * h.t;
      if (!h.front || Math.abs(x - plane) > 2e-3 || soup.layer[h.tri] !== Mat.PLENUM) {
        bad.push(`from x=${ox}: hit x=${x.toFixed(4)} front=${h.front} layer=${soup.layer[h.tri]}, expected the PLENUM side at ${plane.toFixed(4)}`);
      }
    }
    // the open ends of the patch still have their pit sides on the cell lines
    const h = soup.cast([4.5 * CELL, -0.2, 5.5 * CELL + 0.013], [-1, 0.0001, 0.0002], 100);
    expect(h && h.front ? 4.5 * CELL - h.t : NaN).toBeCloseTo(3 * CELL, 3);
    expect(bad).toEqual([]);
  });
});

describe('clipRamp (tower replicas straddling +-TOWER_SPAN)', () => {
  const base = (dir: 0 | 1 | 2 | 3, y0: number, y1: number, steps: number): Ramp => ({
    kind: 'ramp', id: 9, x0: 1, z0: 2, x1: dir <= 1 ? 5 : 2.2, z1: dir <= 1 ? 3.2 : 6, y0, y1, dir, steps,
    mat: Mat.CONCRETE_FLOOR, flags: SolidFlag.RENDER, bakeGroup: 7,
  });
  /** [low, high] ascent-coordinate footprint in metres from the min side of the ramp's long axis. */
  const along = (r: Ramp): [number, number] => (r.dir <= 1 ? [r.x0, r.x1] : [r.z0, r.z1]);

  test('inside: unchanged (shifted); outside: dropped', () => {
    const r = base(0, 0, 1.5, 12);
    expect(clipRamp(r, 0, 6)).toBe(r);
    expect(clipRamp(r, 3, 6)).toEqual({ ...r, y0: 3, y1: 4.5 });
    expect(clipRamp(r, 6, 6)).toBeNull();
    expect(clipRamp(r, -7.5, 6)).toBeNull();
  });

  test('smooth ramp: cut where the slope crosses the bound, in every ascent direction', () => {
    for (const dir of [0, 1, 2, 3] as const) {
      const r = base(dir, 0, 2, 0); // L = 4 m
      const top = clipRamp(r, 5, 6)!; // y 5..7 -> 5..6: the low half
      expect([top.y0, top.y1]).toEqual([5, 6]);
      const bot = clipRamp(r, -7, 6)!; // y -7..-5 -> -6..-5: the high half
      expect([bot.y0, bot.y1]).toEqual([-6, -5]);
      const lowHalf = dir === 0 || dir === 2 ? [0, 2] : [2, 4]; // ascent toward -x / -z starts at the max side
      const A0 = dir <= 1 ? 1 : 2;
      expect(along(top).map((v) => v - A0)).toEqual(lowHalf);
      expect(along(bot).map((v) => v - A0)).toEqual(lowHalf[0] === 0 ? [2, 4] : [0, 2]);
      expect(top.steps).toBe(0);
    }
  });

  test('stepped flight: whole steps inside the bound, same rise and tread depth', () => {
    // 8 risers over 4 m (7 treads, dep = 4/7), y 4.5..7.5 (rise 0.375): steps 0..3 end at <= 6
    const r = base(0, 0, 3, 8);
    const c = clipRamp(r, 4.5, 6)!;
    const dep = 4 / 7;
    expect(c.steps).toBe(4);
    expect(c.y0).toBeCloseTo(4.5, 9);
    expect(c.y1).toBeCloseTo(6, 9);
    expect(c.x0).toBeCloseTo(1, 6);
    expect(c.x1).toBeCloseTo(1 + 3 * dep, 5);
    expect((c.y1 - c.y0) / c.steps).toBeCloseTo(0.375, 9);
    expect((c.x1 - c.x0) / (c.steps - 1)).toBeCloseTo(dep, 5);
    // bottom clip, ascent toward -x: y -6.9..-5.1, rise 0.45, 4 risers over 4 m (dep 4/3): steps 2..3 remain
    const d = clipRamp(base(1, 0, 1.8, 4), -6.9, 6)!;
    expect(d.steps).toBe(2);
    expect(d.y0).toBeCloseTo(-6, 9);
    expect(d.y1).toBeCloseTo(-5.1, 9);
    // s in [2 dep, 3 dep] measured from x1 = 5 toward -x
    expect(d.x0).toBeCloseTo(5 - 3 * (4 / 3), 5);
    expect(d.x1).toBeCloseTo(5 - 2 * (4 / 3), 5);
    // top clip leaving one riser + its tread: a one-step ramp over [0, dep] (y 5.5..6.7, rise 0.3, dep 4/3)
    const one = clipRamp(base(2, 0, 1.2, 4), 5.5, 6)!;
    expect(one.steps).toBe(1);
    expect(one.y0).toBeCloseTo(5.5, 9);
    expect(one.y1).toBeCloseTo(5.8, 9);
    expect(one.z0).toBeCloseTo(2, 6);
    expect(one.z1).toBeCloseTo(2 + 4 / 3, 5);
    // bottom clip leaving only the top riser (no tread): dropped
    expect(clipRamp(base(0, 0, 1.2, 4), -6.8, 6)).toBeNull();
    // a single-step ramp keeps its tread and shortens its riser; dropped when the tread is out of range
    expect(clipRamp(base(0, 0, 0.3, 1), -6.1, 6)).toMatchObject({ y0: -6, steps: 1 });
    expect(clipRamp(base(0, 0, 0.3, 1), 5.9, 6)).toBeNull();
  });
});

describe('T-junction repair', () => {
  const mk = (p: number[], uv: number[]): Face => mkFace(p, uv, 0, 0, 1, state(Mat.WALLPAPER_L0));

  test('a vertex of a neighbour inside an edge is inserted, uv interpolated, fan non-degenerate', () => {
    // A: tall quad [0,1]x[0,2]; B: [1,2]x[0,1] and C: [1,2]x[1,2] share A's right edge, split at y = 1
    const A = mk([0, 0, 0, 1, 0, 0, 1, 2, 0, 0, 2, 0], [0, 0, 1, 0, 1, 2, 0, 2]);
    const B = mk([1, 0, 0, 2, 0, 0, 2, 1, 0, 1, 1, 0], [1, 0, 2, 0, 2, 1, 1, 1]);
    const C = mk([1, 1, 0, 2, 1, 0, 2, 2, 0, 1, 2, 0], [1, 1, 2, 1, 2, 2, 1, 2]);
    for (const f of [A, B, C]) f.own = true;
    repairTJunctions([A, B, C]);
    expect(A.p).toEqual([0, 0, 0, 1, 0, 0, 1, 1, 0, 1, 2, 0, 0, 2, 0]);
    expect(A.uv).toEqual([0, 0, 1, 0, 1, 1, 1, 2, 0, 2]);
    expect(A.fan).toBeGreaterThanOrEqual(0);
    expect(B.p.length).toBe(12);
    expect(C.p.length).toBe(12);
    // both vertical edges split: no single fan start works, a centre vertex is used
    const D = mk([0, 0, 0, 1, 0, 0, 1, 2, 0, 0, 2, 0], []);
    const E = mk([1, 0.7, 0, 1.5, 0.7, 0, 1.5, 0.8, 0, 1, 0.8, 0], []);
    const F = mk([-1, 1.3, 0, 0, 1.3, 0, 0, 1.4, 0, -1, 1.4, 0], []);
    const G = mk([-1, 0.5, 0, 0, 0.5, 0, 0, 0.6, 0, -1, 0.6, 0], []);
    for (const f of [D, E, F, G]) f.own = true;
    repairTJunctions([D, E, F, G]);
    expect(D.p.length / 3).toBe(10); // 4 corners + 2 on the right edge + 4 on the left edge
    expect(D.fan).toBe(-1);
    expect(fanStart(D.p)).toBe(-1);
  });

  test('wall faces of a doorway / HALF wall scene have no T-junctions on vertical seams', () => {
    const s = new Scene();
    s.room(2, 2, 12, 12);
    s.xEdge(6, 4, '|').xEdge(6, 5, 'd').xEdge(6, 6, '|');
    s.zEdge(8, 7, '=').zEdge(9, 7, '-');
    const nb = asciiNb(s.text());
    const { mesh } = buildTile(nb, tileKey(0, 0, 0, 0), 12);
    const m = mesh.shell;
    const skip = new Set<number>([Mat.TRIM_PAINT, Mat.RUBBER, Mat.PLENUM, Mat.METAL_PAINTED]);
    const wallTri = (t: number): boolean => {
      const v = m.index[t * 3];
      return Math.abs(m.normal[v * 4 + 1]) < 2 && !skip.has(m.layer[v]);
    };
    // vertical lines (x, z) -> y values of wall-triangle vertices
    const lines = new Map<string, number[]>();
    const key = (v: number): string => `${Math.round(m.position[v * 3] * 1e4)},${Math.round(m.position[v * 3 + 2] * 1e4)}`;
    for (let t = 0; t < m.indexCount / 3; t++) {
      if (!wallTri(t)) continue;
      for (let c = 0; c < 3; c++) {
        const v = m.index[t * 3 + c];
        const a = lines.get(key(v)) ?? [];
        a.push(m.position[v * 3 + 1]);
        lines.set(key(v), a);
      }
    }
    const bad: string[] = [];
    for (let t = 0; t < m.indexCount / 3 && bad.length < 10; t++) {
      if (!wallTri(t)) continue;
      for (let c = 0; c < 3; c++) {
        const a = m.index[t * 3 + c], b = m.index[t * 3 + (c + 1) % 3];
        if (key(a) !== key(b)) continue; // not a vertical edge
        const y0 = Math.min(m.position[a * 3 + 1], m.position[b * 3 + 1]), y1 = Math.max(m.position[a * 3 + 1], m.position[b * 3 + 1]);
        for (const y of lines.get(key(a)) ?? []) {
          if (y > y0 + 0.003 && y < y1 - 0.003) bad.push(`edge ${key(a)} [${y0.toFixed(3)}, ${y1.toFixed(3)}] has a T-vertex at y ${y.toFixed(3)}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });
});
