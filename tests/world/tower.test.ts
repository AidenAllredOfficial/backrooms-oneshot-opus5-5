// WP4 — periodic stair towers (§2.4): period folding, stamping, exit cell, storey-free fixture ids, continuous flights
// across replicas (WP12 collision builder floorAt), the DDA invisibility test (no line from the shaft reaches the
// storey through D and X) and the stair-stack sightline test (rays up / down the stack end on tower geometry).
import { describe, expect, it } from 'vitest';
import { CELL, PLAYER, STOREY_PITCH, TOWER, TOWER_SPAN, WALL_T } from '../../src/core/constants.ts';
import { edgePieces } from '../../src/core/edges.ts';
import { cellIdx, exIdx, ezIdx, forwardXZ } from '../../src/core/grid.ts';
import { CeilKind, CellFlag, EdgeKind, FixtureKind, LightState, PropKind, SignKind, SolidFlag, type StoreyId, StructureKind } from '../../src/core/ids.ts';
import { fixtureSeed, structureFixtureId, type ChunkLayout, type Solid } from '../../src/core/layout.ts';
import { TOWER_LAYERS } from '../../src/core/materials.ts';
import { SALT } from '../../src/core/rng.ts';
import { towerFootprint, type TowerSite } from '../../src/core/world.ts';
import { STRUCTURE_ZONE } from '../../src/core/zones.ts';
import { expandPeriodicSolids } from '../../src/mesh/periodic.ts';
import { buildChunkCollision } from '../../src/player/collisionBuild.ts';
import { createChunkGrid } from '../../src/world/chunkGrid.ts';
import { createWorldGen } from '../../src/world/worldgen.ts';
import { kelvinToLinearRGB } from '../../src/world/content/kelvin.ts';
import {
  stampTower, TOWER_DOOR_D, TOWER_ENTRANCE_BULB, TOWER_STEPS, towerExitCell, towerFrame, towerIdOf, towerPeriodSolids, wrapToPeriod,
} from '../../src/world/structures/tower.ts';
import { floorAt, N, openLayout, opts } from './wp4-helpers.ts';

const HALF = STOREY_PITCH / 2;
const C = CELL;
const T2 = WALL_T / 2;
const R = PLAYER.radius;
const TOWER_SWITCH = 1.6; // |feetY| sampled (TOWER_SWITCH_Y)

function site(rot: 0 | 1 | 2 | 3, id = 0x2468ace1): TowerSite {
  return { id, cx: 0, cz: 0, i0: 12, j0: 11, rot, endless: false };
}
function stamped(rot: 0 | 1 | 2 | 3, s: StoreyId = 0): { l: ChunkLayout; t: TowerSite } {
  const l = openLayout(s, 0, 0);
  const g = createChunkGrid(l, 3);
  const t = site(rot);
  stampTower(g, t, 3);
  return { l, t };
}

/** Walking-surface height (natural, k = 0 period) at frame metres (um, vm) in the shaft (u < 2 cells). */
function surfaceAt(um: number, vm: number): number {
  const rise = TOWER.FLIGHT_RISE;
  if (vm <= C) return 0; // landing end0
  if (vm >= 4 * C) return um < C ? -rise : rise; // landing end1 (-1.5 == +1.5 one period up)
  const t = (vm - C) / (3 * C);
  return um < C ? -rise * t : rise * t; // lane A down, lane B up
}

describe('wrapToPeriod', () => {
  it('splits at y = +-1.5 and folds every piece into [-1.5, 1.5]', () => {
    expect(wrapToPeriod(-0.2, 0)).toEqual([[-0.2, 0]]);
    expect(wrapToPeriod(2.1, 3.0)).toEqual([[-0.9, 0]]);
    expect(wrapToPeriod(-1.7, -1.5)).toEqual([[1.3, 1.5]]);
    expect(wrapToPeriod(2.7, 2.9)).toEqual([[-0.3, -0.1]]);
    const split = wrapToPeriod(1.0, 2.0);
    expect(split).toEqual([[1.0, 1.5], [-1.5, -1.0]]);
    for (const [a, b] of [[-3, 0], [-1.5, 1.5], [0.4, 3.4], [-5.2, -4.1]]) {
      const w = wrapToPeriod(a, b);
      let len = 0;
      for (const [p, q] of w) {
        expect(p).toBeGreaterThanOrEqual(-HALF - 1e-9);
        expect(q).toBeLessThanOrEqual(HALF + 1e-9);
        len += q - p;
      }
      expect(len).toBeCloseTo(b - a, 6);
    }
  });
});

describe('towerPeriodSolids', () => {
  for (const rot of [0, 1, 2, 3] as const) {
    it(`rot ${rot}: one period of tower geometry, bakeGroup = towerId, TOWER_LAYERS only`, () => {
      const t = site(rot);
      const id = towerIdOf(t);
      expect(id).toBe((t.id & 0x7fffffff) | 1);
      const p = towerPeriodSolids(t, 3);
      const [i0, j0, i1, j1] = towerFootprint(t);
      let ramps = 0, landings = 0;
      for (const s of p.solids) {
        expect(s.kind).not.toBe('pipe');
        if (s.kind === 'pipe') continue;
        expect(s.bakeGroup).toBe(id);
        expect(TOWER_LAYERS).toContain(s.mat);
        if (s.kind === 'box') {
          expect(s.min[1]).toBeGreaterThanOrEqual(-HALF - 1e-9);
          expect(s.max[1]).toBeLessThanOrEqual(HALF + 1e-9);
          expect(s.min[0]).toBeGreaterThanOrEqual(i0 * C - 1e-9);
          expect(s.max[0]).toBeLessThanOrEqual(i1 * C + 1e-9);
          expect(s.min[2]).toBeGreaterThanOrEqual(j0 * C - 1e-9);
          expect(s.max[2]).toBeLessThanOrEqual(j1 * C + 1e-9);
          if ((s.flags & SolidFlag.WALKABLE_TOP) && s.max[1] - s.min[1] <= 0.2 + 1e-9) landings++;
        } else {
          ramps++;
          expect(s.steps).toBe(13);
          expect(TOWER_STEPS).toBe(13);
          expect(Math.abs(s.y1 - s.y0)).toBeCloseTo(TOWER.FLIGHT_RISE, 9);
          expect(Math.min(s.y0, s.y1)).toBeGreaterThanOrEqual(-HALF - 1e-9);
          expect(Math.max(s.y0, s.y1)).toBeLessThanOrEqual(HALF + 1e-9);
          expect(s.flags & (SolidFlag.WALKABLE_TOP | SolidFlag.COLLIDE | SolidFlag.OCCLUDE | SolidFlag.RENDER)).toBe(15);
          // 12 treads x 0.30 m
          const run = Math.max(s.x1 - s.x0, s.z1 - s.z0);
          expect(run).toBeCloseTo(TOWER.TREADS * TOWER.TREAD, 9);
        }
      }
      expect(ramps).toBe(2);
      expect(landings).toBeGreaterThanOrEqual(2);
      // one CAGE_BULB per landing per period (64 cd, hum 0.6) + one dimmer bulb over the exit in the vestibule
      expect(p.fixtures.length).toBe(3);
      const col = kelvinToLinearRGB(3000, 0);
      p.fixtures.forEach((f, i) => {
        expect(f.kind).toBe(FixtureKind.CAGE_BULB);
        expect(f.shape).toBe(1);
        expect(f.luminance).toBe(i < 2 ? 64 : 85); // R2: the vestibule bulb spills through the propped exit door
        expect(f.w).toBe(0.1);
        expect(f.hum).toBe(i < 2 ? 0.6 : 0.5);
        expect(f.state).toBe(LightState.ON);
        expect(f.bakeGroup).toBe(id);
        expect(f.color).toEqual([col[0], col[1], col[2]]);
        expect(f.py).toBeGreaterThanOrEqual(-HALF);
        expect(f.py).toBeLessThan(HALF);
        const li = Math.floor(f.px / C), lj = Math.floor(f.pz / C);
        expect(li >= i0 && li < i1 && lj >= j0 && lj < j1).toBe(true);
      });
      // handrails, anchored in tower cells
      expect(p.props.length).toBeGreaterThan(0);
      for (const pr of p.props) {
        expect(pr.kind).toBe(PropKind.HANDRAIL);
        const li = Math.floor(pr.x / C), lj = Math.floor(pr.z / C);
        expect(li >= i0 && li < i1 && lj >= j0 && lj < j1).toBe(true);
      }
    });
  }
});

describe('stampTower', () => {
  for (const rot of [0, 1, 2, 3] as const) {
    it(`rot ${rot}: cells, perimeter walls, the single exit DOORWAY, fixtures, portal, signage, exit cell`, () => {
      const { l, t } = stamped(rot);
      const id = towerIdOf(t);
      const [i0, j0, i1, j1] = towerFootprint(t);
      const inside = (li: number, lj: number): boolean => li >= i0 && li < i1 && lj >= j0 && lj < j1;
      for (let lj = j0; lj < j1; lj++) for (let li = i0; li < i1; li++) {
        const c = cellIdx(li, lj);
        expect(l.flags[c] & (CellFlag.TOWER | CellFlag.RESERVED)).toBe(CellFlag.TOWER | CellFlag.RESERVED);
        expect(l.floorCm[c]).toBe(-600);
        expect(l.ceilCm[c]).toBe(600);
        expect(l.ceilKind[c]).toBe(CeilKind.OPEN_DARK);
        expect(l.cellZone[c]).toBe(STRUCTURE_ZONE);
      }
      // edges: interior OPEN, perimeter WALL except one DOORWAY; no trims; TOWER_LAYERS materials
      let doors = 0, walls = 0;
      for (let lj = j0; lj < j1; lj++) for (let li = i0; li < i1; li++) {
        for (const [axis, i, j, oi, oj] of [['x', li, lj, li - 1, lj], ['x', li + 1, lj, li + 1, lj], ['z', li, lj, li, lj - 1], ['z', li, lj + 1, li, lj + 1]] as const) {
          const e = axis === 'x' ? l.ex : l.ez;
          const k = axis === 'x' ? exIdx(i, j) : ezIdx(i, j);
          if (inside(oi, oj)) { expect(e.kind[k]).toBe(EdgeKind.OPEN); continue; }
          expect(e.trim[k]).toBe(0);
          expect(TOWER_LAYERS).toContain(e.matNeg[k]);
          expect(TOWER_LAYERS).toContain(e.matPos[k]);
          if (e.kind[k] === EdgeKind.DOORWAY) { doors++; expect(e.hA[k]).toBe(210); } else { expect(e.kind[k]).toBe(EdgeKind.WALL); walls++; }
        }
      }
      expect(doors).toBe(1);
      expect(walls).toBe(2 * (TOWER.W_CELLS + TOWER.L_CELLS) - 1);
      // the exit X is on line u = 3 at v = 4
      const f = towerFrame(t);
      const x = f.edge(2, 4, 3, 4);
      expect(x.axis === 'x' ? l.ex.kind[exIdx(x.i, x.j)] : l.ez.kind[ezIdx(x.i, x.j)]).toBe(EdgeKind.DOORWAY);
      // fixtures: storey-free ids structureFixtureId(towerId, SALT.TOWER, i)
      const tf = l.fixtures.filter((fx) => fx.bakeGroup === id);
      expect(tf.length).toBe(3);
      tf.forEach((fx, i) => {
        expect(fx.id).toBe(structureFixtureId(id, SALT.TOWER, i) >>> 0);
        expect(fx.seed).toBe(fixtureSeed(fx.id));
      });
      // structure + portal
      const st = l.structures.find((s) => s.kind === StructureKind.TOWER)!;
      expect(st.bakeGroup).toBe(id);
      expect([st.i0, st.j0, st.i1, st.j1]).toEqual([i0, j0, i1, j1]);
      expect(st.rot).toBe(rot);
      expect(st.portal).toEqual({ kind: 'tower', min: [i0 * C, -TOWER_SPAN, j0 * C], max: [i1 * C, TOWER_SPAN, j1 * C], towerId: id, endless: false });
      // exit cell: outside, in front of X, facing in through the doorway
      const e = towerExitCell(t);
      expect(inside(e.li, e.lj)).toBe(false);
      const [ui, uj] = f.cell(2, 4);
      expect(Math.abs(e.li - ui) + Math.abs(e.lj - uj)).toBe(1);
      const fw = { x: 0, z: 0 };
      forwardXZ(e.yaw, fw);
      expect(e.li + Math.round(fw.x)).toBe(ui);
      expect(e.lj + Math.round(fw.z)).toBe(uj);
      // signage: storey-side faces only (a point 5 cm in front of each sign is outside the footprint)
      const signs = l.decals.filter((d) => d.sign);
      expect(signs.some((d) => d.kind === SignKind.L0)).toBe(true);
      for (const d of signs) {
        const li = Math.floor((d.px + d.nx * 0.05) / C), lj = Math.floor((d.pz + d.nz * 0.05) / C);
        expect(inside(li, lj)).toBe(false);
      }
    });
  }

  it('storey signage: L0 / B1 / B2', () => {
    expect(stamped(1, 1).l.decals.some((d) => d.sign && d.kind === SignKind.B1)).toBe(true);
    expect(stamped(2, 2).l.decals.some((d) => d.sign && d.kind === SignKind.B2)).toBe(true);
  });

  it('ENDLESS_STAIRS sites carry portal.endless and an anomaly', () => {
    const l = openLayout(0, 0, 0);
    stampTower(createChunkGrid(l, 3), { ...site(0), endless: true }, 3);
    expect(l.structures[0].portal!.endless).toBe(true);
    expect(l.anomalies.length).toBe(1);
  });
});

describe('tower fixtures and geometry are identical in all three storeys (worldgen)', () => {
  it('tower chunks of storeys 0, 1, 2 share fixture ids, solids and tower cells', () => {
    const gen = createWorldGen(opts(42));
    const t = gen.towersNear(0, 0, 0)[0];
    expect(t).toBeDefined();
    const per = [0, 1, 2].map((s) => gen.generateChunk({ s: s as StoreyId, cx: t.cx, cz: t.cz }));
    const id = towerIdOf(t);
    const sig = (l: ChunkLayout): string => JSON.stringify({
      f: l.fixtures.filter((f) => f.bakeGroup === id),
      s: l.solids.filter((s) => s.kind !== 'pipe' && s.bakeGroup === id).map((s) => ({ ...s, id: 0 })),
    });
    expect(sig(per[1])).toBe(sig(per[0]));
    expect(sig(per[2])).toBe(sig(per[0]));
    for (const l of per) {
      const tf = l.fixtures.filter((f) => f.bakeGroup === id);
      expect(tf.length).toBe(3);
      for (const f of tf) expect(f.state).toBe(LightState.ON);
    }
  });
});

// ------------------------------------------------------------------------------------------ flights (collision)

describe('continuous flights across replicas (WP12 collision builder)', () => {
  for (const rot of [0, 1, 2, 3] as const) {
    it(`rot ${rot}: floorAt matches the authored surfaces and differs by exactly 3.0 m between replicas`, () => {
      const { l, t } = stamped(rot);
      const col = buildChunkCollision(l);
      const f = towerFrame(t);
      for (let vm = 0.4; vm < 5 * C - 0.35; vm += 0.23) {
        for (const um of [0.45, 0.8, 1.6, 2.0]) {
          if (vm > C + 0.05 && vm < 4 * C - 0.05 && Math.abs(um - C) < 0.3) continue;
          const [x, z] = f.point(um, vm);
          const h = surfaceAt(um, vm);
          for (const k of [-2, -1, 0, 1, 2]) { // TOWER_REPLICAS
            const y = h + k * STOREY_PITCH;
            if (Math.abs(y) > TOWER_SPAN - 0.5) continue;
            expect(floorAt(l, col, x, z, y + 0.01), `rot ${rot} u ${um} v ${vm.toFixed(2)} k ${k}`).toBeCloseTo(y, 3);
          }
        }
      }
      // the vestibule floor at 0 (and its sealed copies at +-3)
      const [vx, vz] = f.point(3.0, 3.0);
      for (const k of [-1, 0, 1]) expect(floorAt(l, col, vx, vz, k * 3 + 0.01)).toBeCloseTo(k * 3, 3);
    });

    it(`rot ${rot}: a full lap (end0 -> lane A -> end1 -> lane B) descends exactly 3.0 m in steps <= STEP_MAX`, () => {
      const { l, t } = stamped(rot);
      const col = buildChunkCollision(l);
      const f = towerFrame(t);
      const path: [number, number][] = [[0.6, 0.6], [0.6, 5.4], [1.8, 5.4], [1.8, 0.6], [0.6, 0.6], [0.6, 5.4], [1.8, 5.4], [1.8, 0.6]];
      let feet = 0;
      let [um, vm] = path[0];
      const lapEnds: number[] = [];
      for (let p = 1; p < path.length; p++) {
        const [u1, v1] = path[p];
        const n = Math.ceil(Math.hypot(u1 - um, v1 - vm) / 0.05);
        for (let s = 1; s <= n; s++) {
          const u = um + ((u1 - um) * s) / n, v = vm + ((v1 - vm) * s) / n;
          const [x, z] = f.point(u, v);
          // descending: the floor may drop (follow it) or rise by at most one step
          const y = floorAt(l, col, x, z, feet); // the highest floor <= feet + stepMax
          expect(Math.abs(y - feet), `rot ${rot} step at u ${u.toFixed(2)} v ${v.toFixed(2)}`).toBeLessThanOrEqual(PLAYER.stepMax);
          feet = y;
        }
        um = u1; vm = v1;
        if (p === 3 || p === 7) lapEnds.push(feet);
      }
      // path points 3 and 7 are the end0 landing one and two periods down (after lane B)
      expect(lapEnds[0]).toBeCloseTo(-3, 6);
      expect(lapEnds[1]).toBeCloseTo(-6, 6);
    });
  }
});

// ------------------------------------------------------------------------------------------ DDA visibility

type Prim =
  | { t: 'box'; x0: number; y0: number; z0: number; x1: number; y1: number; z1: number }
  | { t: 'ramp'; x0: number; z0: number; x1: number; z1: number; y0: number; y1: number; dir: number; lo: number; hi: number };

/** Occluders of the tower: replicated boxes, ramp slabs (between the soffit and the step inner corners, the part of a
 * stair that is solid for any tread geometry) and the perimeter edge pieces (edgePieces, thickness WALL_T). */
function towerPrims(l: ChunkLayout, t: TowerSite): Prim[] {
  const out: Prim[] = [];
  for (const s of expandPeriodicSolids(l)) {
    if (s.kind === 'box') {
      if (!(s.flags & SolidFlag.OCCLUDE)) continue;
      out.push({ t: 'box', x0: s.min[0], y0: s.min[1], z0: s.min[2], x1: s.max[0], y1: s.max[1], z1: s.max[2] });
    } else if (s.kind === 'ramp') {
      const riser = Math.abs(s.y1 - s.y0) / Math.max(1, s.steps);
      out.push({ t: 'ramp', x0: s.x0, z0: s.z0, x1: s.x1, z1: s.z1, y0: s.y0, y1: s.y1, dir: s.dir, lo: -0.15, hi: -riser });
    }
  }
  const [i0, j0, i1, j1] = towerFootprint(t);
  const pieces = new Float32Array(32);
  const edge = (axis: 'x' | 'z', i: number, j: number): void => {
    const e = axis === 'x' ? l.ex : l.ez;
    const k = axis === 'x' ? exIdx(i, j) : ezIdx(i, j);
    const ca = axis === 'x' ? cellIdx(i - 1, j) : cellIdx(i, j - 1), cb = cellIdx(i, j);
    const fa = l.floorCm[ca] / 100, fb = l.floorCm[cb] / 100;
    const n = edgePieces(e.kind[k], e.hA[k], e.hB[k], Math.min(fa, fb), Math.max(fa, fb), Math.max(l.ceilCm[ca], l.ceilCm[cb]) / 100, pieces);
    for (let p = 0; p < n; p++) {
      const t0 = pieces[p * 4] - (pieces[p * 4] <= 1e-6 ? T2 : 0), t1 = pieces[p * 4 + 1] + (pieces[p * 4 + 1] >= C - 1e-4 ? T2 : 0);
      const y0 = pieces[p * 4 + 2], y1 = pieces[p * 4 + 3];
      if (axis === 'x') out.push({ t: 'box', x0: i * C - T2, x1: i * C + T2, z0: j * C + t0, z1: j * C + t1, y0, y1 });
      else out.push({ t: 'box', x0: i * C + t0, x1: i * C + t1, z0: j * C - T2, z1: j * C + T2, y0, y1 });
    }
  };
  for (let lj = j0; lj < j1; lj++) { edge('x', i0, lj); edge('x', i1, lj); }
  for (let li = i0; li < i1; li++) { edge('z', li, j0); edge('z', li, j1); }
  return out;
}

/** Parameter interval [a, b] of segment P + s*D (s in [0, 1]) inside the slab lo <= p <= hi on one axis. */
function clip(p: number, d: number, lo: number, hi: number, a: number, b: number): [number, number] {
  if (Math.abs(d) < 1e-12) return p >= lo && p <= hi ? [a, b] : [1, 0];
  let s0 = (lo - p) / d, s1 = (hi - p) / d;
  if (s0 > s1) { const q = s0; s0 = s1; s1 = q; }
  return [Math.max(a, s0), Math.min(b, s1)];
}

const EPS_S = 1e-7;
/** First hit parameter s in (0, sMax) of the segment against the prims, or Infinity. */
function firstHit(prims: readonly Prim[], px: number, py: number, pz: number, dx: number, dy: number, dz: number, sMax: number): number {
  let best = Infinity;
  for (const q of prims) {
    let [a, b] = clip(px, dx, q.x0, q.x1, EPS_S, sMax - EPS_S);
    if (a > b) continue;
    [a, b] = clip(pz, dz, q.z0, q.z1, a, b);
    if (a > b) continue;
    if (q.t === 'box') {
      [a, b] = clip(py, dy, q.y0, q.y1, a, b);
      if (a < b && a < best) best = a; // positive-length overlap (grazing a face does not occlude)
      continue;
    }
    // ramp: f(s) = y(s) - h(x(s), z(s)) is linear inside the footprint; solid where lo <= f <= hi
    const len = q.dir < 2 ? q.x1 - q.x0 : q.z1 - q.z0;
    const pos = q.dir < 2 ? px : pz, dpos = q.dir < 2 ? dx : dz, base = q.dir < 2 ? q.x0 : q.z0;
    const up = q.dir === 0 || q.dir === 2; // ascent toward +axis
    // h(s) = y0 + (y1 - y0) * tt, tt = (pos - base)/len (up) or 1 - that
    const k = (q.y1 - q.y0) / len * (up ? 1 : -1);
    const h0 = up ? q.y0 + (pos - base) * k : q.y0 + (q.y1 - q.y0) + (pos - base) * k;
    const f0 = py - h0, df = dy - dpos * k;
    [a, b] = clip(f0, df, q.lo, q.hi, a, b);
    if (a < b && a < best) best = a;
  }
  return best;
}

/** Local 2.5D DDA over the tower: prims are binned by the chunk cells their xz footprint overlaps (edge pieces fall
 * into both cells of their line), and a segment walks the cells it crosses in xz order (Amanatides–Woo), testing only
 * the prims of the visited cells. The first hit is final once it lies within the current cell's parameter range. */
class TowerDDA {
  private bins = new Map<number, Prim[]>();
  constructor(prims: readonly Prim[]) {
    for (const q of prims) {
      const i0 = Math.floor(q.x0 / C - 1e-9), i1 = Math.floor(q.x1 / C + 1e-9);
      const j0 = Math.floor(q.z0 / C - 1e-9), j1 = Math.floor(q.z1 / C + 1e-9);
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const k = TowerDDA.key(i, j);
        let b = this.bins.get(k);
        if (!b) this.bins.set(k, (b = []));
        b.push(q);
      }
    }
  }
  private static key(i: number, j: number): number { return (i + 64) * 256 + (j + 64); }
  cellsVisited = 0;
  /** First hit parameter s in (0, sMax) of P + s*D, or Infinity. */
  firstHit(px: number, py: number, pz: number, dx: number, dy: number, dz: number, sMax: number): number {
    let i = Math.floor(px / C), j = Math.floor(pz / C);
    const si = dx > 0 ? 1 : dx < 0 ? -1 : 0, sj = dz > 0 ? 1 : dz < 0 ? -1 : 0;
    const tdx = si !== 0 ? C / Math.abs(dx) : Infinity, tdz = sj !== 0 ? C / Math.abs(dz) : Infinity;
    let tmx = si > 0 ? ((i + 1) * C - px) / dx : si < 0 ? (i * C - px) / dx : Infinity;
    let tmz = sj > 0 ? ((j + 1) * C - pz) / dz : sj < 0 ? (j * C - pz) / dz : Infinity;
    let best = Infinity;
    const tested = new Set<Prim>();
    for (let steps = 0; steps < 256; steps++) {
      this.cellsVisited++;
      const bin = this.bins.get(TowerDDA.key(i, j));
      if (bin) {
        const fresh = bin.filter((q) => !tested.has(q));
        for (const q of fresh) tested.add(q);
        const h = firstHit(fresh, px, py, pz, dx, dy, dz, sMax);
        if (h < best) best = h;
      }
      const exit = Math.min(tmx, tmz, sMax);
      if (best <= exit) return best;
      if (exit >= sMax) return best;
      if (i < -40 || j < -40 || i > 72 || j > 72) return best; // left the local region
      if (tmx < tmz) { i += si; tmx += tdx; } else { j += sj; tmz += tdz; }
    }
    return best;
  }
}

describe('DDA invisibility: no line from the shaft reaches the storey through D and X', () => {
  for (const rot of [0, 1, 2, 3] as const) {
    it(`rot ${rot}`, () => {
      const { l, t } = stamped(rot);
      const f = towerFrame(t);
      const prims = towerPrims(l, t);
      const dda = new TowerDDA(prims);
      // targets: 2 cm beyond the outer face of X, across its hole, over y in [-6, 6] (densest in the hole)
      const targets: [number, number, number][] = [];
      const ys = [-6, -4.5, -3, -1.5, -0.5, 0.05, 0.4, 0.8, 1.2, 1.6, 2.0, 2.3, 3, 4.5, 6];
      for (let tt = 0.16; tt <= 1.04; tt += 0.11) for (const y of ys) {
        const [x, z] = f.point(3 * C + T2 + 0.02, 4 * C + tt);
        targets.push([x, y, z]);
      }
      // eyes: every player position in the shaft (clear of walls by the radius), feet on a walking surface with
      // |feetY| <= 1.6, standing (1.62) and crouched (1.0) eye heights
      let segments = 0, visible = 0;
      const check = (ex: number, ey: number, ez: number): number => {
        let v = 0;
        for (const [x, y, z] of targets) {
          segments++;
          const hit = dda.firstHit(ex, ey, ez, x - ex, y - ey, z - ez, 1);
          if (segments % 13 === 0) expect(hit).toBe(firstHit(prims, ex, ey, ez, x - ex, y - ey, z - ez, 1)); // DDA == brute force
          if (hit === Infinity) v++;
        }
        return v;
      };
      for (let um = T2 + R; um <= 2 * C - T2 - R + 1e-9; um += 0.15) {
        for (let vm = T2 + R; vm <= 5 * C - T2 - R + 1e-9; vm += 0.15) {
          if (vm > C - R && vm < 4 * C + R && Math.abs(um - C) < T2 + R) continue; // inside the central wall
          const [x, z] = f.point(um, vm);
          const h = surfaceAt(um, vm);
          for (const k of [-1, 0, 1]) {
            const feet = h + 3 * k;
            if (Math.abs(feet) > TOWER_SWITCH) continue;
            for (const eye of [PLAYER.eye, PLAYER.crouchEye]) visible += check(x, feet + eye, z);
          }
        }
      }
      expect(segments).toBeGreaterThan(20000);
      expect(visible).toBe(0);
      // sanity: the same test does see X from the k = 0 vestibule and from inside door D
      const [vx, vz] = f.point(3.0, 5.0);
      expect(check(vx, PLAYER.eye, vz)).toBeGreaterThan(0);
      const [dx, dz] = f.point(2 * C, (TOWER_DOOR_D.v0 + TOWER_DOOR_D.v1) / 2);
      expect(check(dx, PLAYER.eye, dz)).toBeGreaterThan(0);
    });
  }
});

describe('stair-stack sightlines end on tower geometry', () => {
  for (const rot of [0, 1, 2, 3] as const) {
    it(`rot ${rot}: rays up and down the stack hit geometry before |y| = TOWER_SPAN`, () => {
      const { l, t } = stamped(rot);
      const f = towerFrame(t);
      const prims = towerPrims(l, t);
      const dda = new TowerDDA(prims);
      const [i0, j0, i1, j1] = towerFootprint(t);
      // directions: a Fibonacci sphere, keeping the ones that climb or fall (|dy| >= 0.15)
      const dirs: [number, number, number][] = [];
      const M = 400;
      for (let i = 0; i < M; i++) {
        const y = 1 - (2 * (i + 0.5)) / M, r = Math.sqrt(1 - y * y), a = i * 2.399963229728653;
        if (Math.abs(y) >= 0.15) dirs.push([Math.cos(a) * r, y, Math.sin(a) * r]);
      }
      let rays = 0, escaped = 0;
      for (let um = 0.4; um <= 2.0; um += 0.4) {
        for (let vm = 0.4; vm <= 5.6; vm += 0.5) {
          if (vm > C - R && vm < 4 * C + R && Math.abs(um - C) < T2 + R) continue;
          const [x, z] = f.point(um, vm);
          const h = surfaceAt(um, vm);
          for (const k of [-1, 0, 1]) {
            const feet = h + 3 * k;
            if (Math.abs(feet) > TOWER_SWITCH) continue;
            const ey = feet + PLAYER.eye;
            for (const [dx, dy, dz] of dirs) {
              rays++;
              // parameter where the ray leaves the tower volume (footprint x |y| <= TOWER_SPAN), for a unit-speed ray
              let [a, b] = clip(x, dx, i0 * C, i1 * C, 0, 100);
              [a, b] = clip(z, dz, j0 * C, j1 * C, a, b);
              [a, b] = clip(ey, dy, -TOWER_SPAN, TOWER_SPAN, a, b);
              const exit = b;
              const hit = dda.firstHit(x, ey, z, dx, dy, dz, 100);
              if (rays % 11 === 0) expect(hit).toBe(firstHit(prims, x, ey, z, dx, dy, dz, 100));
              if (!(hit <= exit + 1e-6)) escaped++;
            }
          }
        }
      }
      expect(rays).toBeGreaterThan(5000);
      expect(escaped).toBe(0);
    });
  }
});

describe('chunk-level sanity', () => {
  it('the tower keeps its footprint inside the chunk and >= 2 cells from the seams for every rot', () => {
    for (const rot of [0, 1, 2, 3] as const) {
      const [i0, j0, i1, j1] = towerFootprint({ ...site(rot), i0: 2, j0: 2 });
      expect(i0).toBeGreaterThanOrEqual(2);
      expect(j0).toBeGreaterThanOrEqual(2);
      expect(i1).toBeLessThanOrEqual(N - 2);
      expect(j1).toBeLessThanOrEqual(N - 2);
    }
  });
  it('solids array ids are chunk-assigned and unique', () => {
    const { l } = stamped(0);
    const ids = new Set(l.solids.map((s: Solid) => s.id));
    expect(ids.size).toBe(l.solids.length);
  });
});

describe('R2 tower discoverability', () => {
  for (const rot of [0, 1, 2, 3] as const) {
    it(`rot ${rot}: a caged emergency bulb over the exit (storey side) and the exit leaf propped open along the outer wall`, () => {
      const { l, t } = stamped(rot);
      const id = towerIdOf(t);
      const [i0, j0, i1, j1] = towerFootprint(t);
      const inside = (x: number, z: number): boolean => x > i0 * C && x < i1 * C && z > j0 * C && z < j1 * C;
      const bulb = l.fixtures.find((f) => f.id === (structureFixtureId(id, SALT.TOWER, TOWER_ENTRANCE_BULB) >>> 0));
      expect(bulb).toBeDefined();
      expect(bulb!.bakeGroup).toBe(0);
      expect(bulb!.kind).toBe(FixtureKind.CAGE_BULB);
      expect(inside(bulb!.px, bulb!.pz)).toBe(false);
      expect(bulb!.py).toBeGreaterThan(2.15); // above the 2.1 m door head
      const e = towerExitCell(t);
      expect(Math.hypot(bulb!.px - (e.li + 0.5) * C, bulb!.pz - (e.lj + 0.5) * C)).toBeLessThan(1.2);
      const leaves = l.props.filter((p) => p.kind === PropKind.DOOR_LEAF);
      expect(leaves.length).toBe(1);
      const p = leaves[0];
      expect(inside(p.x, p.z)).toBe(false); // on the storey side
      // flat against the outer wall: the leaf spans along the wall, within 0.2 m of the wall line, beside the door
      const dx = Math.cos(p.yaw), dz = -Math.sin(p.yaw);
      const alongX = Math.abs(dx) > 0.95, alongZ = Math.abs(dz) > 0.95;
      expect(alongX || alongZ).toBe(true);
      const wallDist = alongZ ? Math.min(Math.abs(p.x - i0 * C), Math.abs(p.x - i1 * C)) : Math.min(Math.abs(p.z - j0 * C), Math.abs(p.z - j1 * C));
      expect(wallDist).toBeLessThan(0.2);
    });
  }
});
