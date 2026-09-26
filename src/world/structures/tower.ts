// src/world/structures/tower.ts — stair tower stamping and its periodic geometry (WP4).
//
// Geometry per DESIGN §2.4 (tower-local frame: u across W = 3 cells, v along L = 5 cells):
//   u = 0 lane A (end0 -> end1, -1.5 m), u = 1 lane B (end1 -> end0, another -1.5 m), u = 2 vestibule strip.
//   Landings: end0 (v = 0) at y = 0, end1 (v = 4) at y = -1.5 (= +1.5 one period up).
//   Door D (landing end0 -> vestibule) on the u = 2 line at v = 0; exit X (vestibule -> storey) is the perimeter
//   DOORWAY edge on the u = 3 line at v = 4. Interior walls are periodic SOLIDS; perimeter walls are edges.
// Everything is authored in natural coordinates (end0 at y = 0, vestibule floor 0 / ceiling 2.7, door D hole
// 0.9 x 2.1 at y in [0, 2.1]) and folded into the fundamental period [-1.5, 1.5) by wrapToPeriod().

import { CELL, STOREY_PITCH, TOWER, TOWER_SPAN, WALL_T } from '../../core/constants.ts';
import { CeilKind, CellFlag, EdgeKind, FixtureKind, Mat, PropKind, SignKind, SolidFlag, StructureKind, AnomalyKind } from '../../core/index.ts';
import { fixtureSeed, hash3, NO_WATER, SALT, structureFixtureId, STRUCTURE_ZONE } from '../../core/index.ts';
import type { ChunkGrid, DistributiveOmit, Fixture, MatId, PortalSpec, PropPlacement, Solid, TowerSite } from '../../core/index.ts';
import { kelvinToLinearRGB } from '../content/kelvin.ts';
import { placeLeaf } from './doors.ts';
import { Frame } from './frame.ts';

const W = TOWER.W_CELLS; // 3
const L = TOWER.L_CELLS; // 5
const HALF = STOREY_PITCH / 2; // 1.5
const T2 = WALL_T / 2;
const C = CELL;

/** Door D hole along v (frame metres): flush with the v = 0 perimeter wall face, 0.9 wide. Off-centre on purpose:
 * it maximises the angle between D and the exit X, so no line from the shaft passes through D and then X. */
export const TOWER_DOOR_D = { v0: T2, v1: T2 + 0.9, head: 2.1 } as const;
/** Vestibule floor / ceiling (natural coordinates). */
export const TOWER_VESTIBULE = { floor: 0, ceil: 2.7, slab: 0.2 } as const;
/** Landing slab thickness. */
export const TOWER_LANDING_T = 0.2;
/** Visual risers per flight (12 treads x 0.30 m). */
export const TOWER_STEPS = TOWER.TREADS + 1;

/** Bake group / structure id / portal.towerId of a tower. Storey-free. */
export const towerIdOf = (site: Pick<TowerSite, 'id'>): number => (site.id & 0x7fffffff) | 1;

export const towerFrame = (site: TowerSite): Frame => new Frame(site.i0, site.j0, W, L, site.rot);

const r4 = (v: number): number => Math.round(v * 1e4) / 1e4;

/** Split [y0, y1] at the period boundaries 1.5 + 3n and shift every piece into [-1.5, 1.5]. Input length <= 3. */
export function wrapToPeriod(y0: number, y1: number): [number, number][] {
  const out: [number, number][] = [];
  let a = y0;
  let guard = 0;
  while (a < y1 - 1e-9 && guard++ < 8) {
    const n = Math.floor((a + HALF) / STOREY_PITCH + 1e-9);
    const end = Math.min(y1, HALF + n * STOREY_PITCH);
    const lo = r4(a - n * STOREY_PITCH), hi = r4(end - n * STOREY_PITCH);
    if (hi > lo) out.push([lo, hi]);
    a = end;
  }
  return out;
}

type SolidIn = DistributiveOmit<Solid, 'id'>;
type FixtureIn = Omit<Fixture, 'id' | 'seed' | 'dynamic'>;

/** Chunk-local, one period; fixture i gets id structureFixtureId(towerId, SALT.TOWER, i). */
export function towerPeriodSolids(site: TowerSite, seed: number): { solids: DistributiveOmit<Solid, 'id'>[]; fixtures: Omit<Fixture, 'id' | 'seed' | 'dynamic'>[]; props: PropPlacement[] } {
  const f = towerFrame(site);
  const bakeGroup = towerIdOf(site);
  const solids: SolidIn[] = [];
  const WALK = SolidFlag.WALKABLE_TOP | SolidFlag.COLLIDE | SolidFlag.OCCLUDE | SolidFlag.RENDER;
  const WALLF = SolidFlag.COLLIDE | SolidFlag.OCCLUDE | SolidFlag.RENDER;

  /** Box in frame metres, natural y range, wrapped into the period. */
  const box = (um0: number, vm0: number, um1: number, vm1: number, y0: number, y1: number, mat: MatId, flags: number): void => {
    for (const [a, b] of wrapToPeriod(y0, y1)) {
      const bb = f.box(um0, vm0, um1, vm1, a, b);
      solids.push({ kind: 'box', min: bb.min, max: bb.max, mat, flags, bakeGroup });
    }
  };
  /** Ramp over frame cells column u, v in [1, 4): ascent toward -v (dirV = -1) or +v (dirV = +1). */
  const ramp = (u: number, dirV: -1 | 1, yLow: number, yHigh: number): void => {
    const bb = f.box(u * C, 1 * C, (u + 1) * C, 4 * C, yLow, yHigh);
    const [dx, dz] = f.dir(0, dirV);
    const dir: 0 | 1 | 2 | 3 = dx > 0 ? 0 : dx < 0 ? 1 : dz > 0 ? 2 : 3;
    solids.push({
      kind: 'ramp', x0: bb.min[0], z0: bb.min[2], x1: bb.max[0], z1: bb.max[2], y0: yLow, y1: yHigh, dir,
      steps: TOWER_STEPS, mat: Mat.CONCRETE_FLOOR, flags: WALK, bakeGroup,
    });
  };

  // landings (0.2 m slabs): end0 at y = 0, end1 at y = -1.5 (wraps to +1.5)
  box(0, 0, 2 * C, 1 * C, -TOWER_LANDING_T, 0, Mat.CONCRETE_FLOOR, WALK);
  box(0, 4 * C, 2 * C, 5 * C, -TOWER.FLIGHT_RISE - TOWER_LANDING_T, -TOWER.FLIGHT_RISE, Mat.CONCRETE_FLOOR, WALK);
  // lane A: end0 (y = 0, v = 1 side) down to end1 (y = -1.5, v = 4 side): ascends toward -v
  ramp(0, -1, -TOWER.FLIGHT_RISE, 0);
  // lane B: end1 (+1.5, v = 4 side) down to end0 (0, v = 1 side): ascends toward +v
  ramp(1, 1, 0, TOWER.FLIGHT_RISE);
  // central wall on the u = 1 line, v in [1, 4), full period height
  box(C - T2, 1 * C, C + T2, 4 * C, -HALF, HALF, Mat.CMU_PAINTED, WALLF);
  // shaft | vestibule wall on the u = 2 line: solid for v in [1, 5)
  box(2 * C - T2, 1 * C, 2 * C + T2, 5 * C, -HALF, HALF, Mat.CMU_PAINTED, WALLF);
  // ... far jamb of door D (the near side of the hole is the v = 0 perimeter wall face)
  box(2 * C - T2, TOWER_DOOR_D.v1, 2 * C + T2, 1 * C, -HALF, HALF, Mat.CMU_PAINTED, WALLF);
  // ... lintel over D: natural y in [2.1, 3.0] (wraps to [-0.9, 0])
  box(2 * C - T2, 0, 2 * C + T2, TOWER_DOOR_D.v1, TOWER_DOOR_D.head, STOREY_PITCH, Mat.CMU_PAINTED, WALLF);
  // vestibule floor slab [-0.2, 0] and ceiling slab [2.7, 2.9] (wrapped to [-0.3, -0.1]) merged: [-0.3, 0]
  const vFloor = [TOWER_VESTIBULE.floor - TOWER_VESTIBULE.slab, TOWER_VESTIBULE.floor] as const;
  const vCeil = wrapToPeriod(TOWER_VESTIBULE.ceil, TOWER_VESTIBULE.ceil + TOWER_VESTIBULE.slab)[0];
  box(2 * C, 0, 3 * C, 5 * C, Math.min(vFloor[0], vCeil[0]), Math.max(vFloor[1], vCeil[1]), Mat.CONCRETE_FLOOR, WALK);

  // one CAGE_BULB per landing per period, hanging 0.15 m under the landing above
  const color = kelvinToLinearRGB(3000, 0);
  const bulb = (vm: number, landingY: number): FixtureIn => {
    const [x, z] = f.point(C, vm);
    const yNat = landingY + STOREY_PITCH - TOWER_LANDING_T - 0.15;
    const y = wrapToPeriod(yNat, yNat + 1e-3)[0][0];
    return {
      kind: FixtureKind.CAGE_BULB, state: 0, shape: 1, px: x, py: y, pz: z, nx: 0, ny: -1, nz: 0, tx: 1, ty: 0, tz: 0,
      w: 0.1, h: 0.1, color: [color[0], color[1], color[2]], luminance: 64, hum: 0.6, bakeGroup,
    };
  };
  const fixtures: FixtureIn[] = [bulb(0.5 * C, 0), bulb(4.5 * C, -TOWER.FLIGHT_RISE)];
  // (WP4 addition) a third bulb in the vestibule, over the exit X: the storey sees a lit stairwell lobby through
  // the doorway instead of a black hole. Its sealed copies at y +- 3k are lit identically (periodic like the rest).
  {
    const [x, z] = f.point(2.5 * C, 4.25 * C);
    const yNat = TOWER_VESTIBULE.ceil - 0.3;
    fixtures.push({
      kind: FixtureKind.CAGE_BULB, state: 0, shape: 1, px: x, py: wrapToPeriod(yNat, yNat + 1e-3)[0][0], pz: z, nx: 0, ny: -1, nz: 0,
      tx: 1, ty: 0, tz: 0, w: 0.1, h: 0.1, color: [color[0], color[1], color[2]], luminance: 85, hum: 0.5, bakeGroup,
    });
  }

  // handrails (HANDRAIL: back +Z against the wall), one 1.2 m segment per flight cell, base at the flight height
  const props: PropPlacement[] = [];
  const rail = (um: number, vmC: number, y: number, du: number, i: number): void => {
    const [x, z] = f.point(um, vmC);
    props.push({
      kind: PropKind.HANDRAIL, variant: 0, x, y: r4(y), z, yaw: f.yaw(du, 0), scale: 1,
      flags: 0, seed: hash3(bakeGroup, SALT.TOWER, 1000 + i),
    });
  };
  for (let k = 0; k < 3; k++) {
    const vm = (1.5 + k) * C;
    const t = (vm - C) / (3 * C); // 0 at the end0 side, 1 at the end1 side
    rail(T2 + 0.04, vm, -TOWER.FLIGHT_RISE * t, 1, k); // lane A along the u = 0 perimeter wall
    rail(2 * C - T2 - 0.04, vm, TOWER.FLIGHT_RISE * t, -1, 3 + k); // lane B along the shaft|vestibule wall
  }
  void seed;
  return { solids, fixtures, props };
}

export function stampTower(g: ChunkGrid, site: TowerSite, seed: number): void {
  const f = towerFrame(site);
  const id = towerIdOf(site);
  const l = g.layout;
  const [ri0, rj0, ri1, rj1] = f.rect();

  // cells: TOWER|RESERVED, floor -600, ceil +600, OPEN_DARK, STRUCTURE_ZONE
  g.setCells(ri0, rj0, ri1, rj1, {
    floorCm: -TOWER_SPAN * 100, ceilCm: TOWER_SPAN * 100, ceilKind: CeilKind.OPEN_DARK, cellZone: STRUCTURE_ZONE,
    floorMat: Mat.CONCRETE_FLOOR, ceilMat: Mat.CONCRETE_CEIL, waterCm: NO_WATER, blockCm: 0,
    flagsSet: CellFlag.TOWER | CellFlag.RESERVED,
    flagsClear: CellFlag.SOLID | CellFlag.VOID | CellFlag.NOWALK | CellFlag.WET | CellFlag.NO_CEIL | CellFlag.SPAWN_OK | CellFlag.ARTERY | CellFlag.LANDMARK | CellFlag.SEALED,
  }, true);
  for (let lj = rj0; lj < rj1; lj++) {
    for (let li = ri0; li < ri1; li++) {
      const c = lj * 32 + li;
      l.wallMat[c] = Mat.CMU_PAINTED;
      l.trimMat[c] = Mat.CMU_PAINTED;
      l.tiles[c] = 0;
    }
  }

  // edges: interior OPEN (interior walls are periodic solids), perimeter WALL (CMU_PAINTED, no trims), exit X DOORWAY
  const cmu = Mat.CMU_PAINTED;
  for (let v = 0; v < L; v++) {
    for (let u = 0; u < W; u++) {
      if (u + 1 < W) f.setEdge(g, u, v, u + 1, v, EdgeKind.OPEN, cmu, cmu, { trim: 0 });
      if (v + 1 < L) f.setEdge(g, u, v, u, v + 1, EdgeKind.OPEN, cmu, cmu, { trim: 0 });
    }
  }
  for (let v = 0; v < L; v++) {
    f.setEdge(g, 0, v, -1, v, EdgeKind.WALL, cmu, cmu, { trim: 0 });
    const exit = v === L - 1;
    f.setEdge(g, W - 1, v, W, v, exit ? EdgeKind.DOORWAY : EdgeKind.WALL, cmu, cmu, { trim: 0, hA: exit ? 210 : 0, hB: 0 });
  }
  for (let u = 0; u < W; u++) {
    f.setEdge(g, u, 0, u, -1, EdgeKind.WALL, cmu, cmu, { trim: 0 });
    f.setEdge(g, u, L - 1, u, L, EdgeKind.WALL, cmu, cmu, { trim: 0 });
  }

  // periodic content (every solid / fixture carries bakeGroup = towerId)
  const p = towerPeriodSolids(site, seed);
  for (const s of p.solids) g.addSolid(s);
  p.fixtures.forEach((fx, i) => {
    const fid = structureFixtureId(id, SALT.TOWER, i);
    g.addFixture(fx, { id: fid, seed: fixtureSeed(fid) });
  });
  for (const pr of p.props) g.addProp(pr);

  // signage: storey-side faces only (sign text breaks periodicity)
  const [oi, oj] = f.cell(W, L - 1); // exit cell
  if (oi >= 0 && oj >= 0 && oi < 32 && oj < 32) {
    const oc = oj * 32 + oi;
    const floor = l.floorCm[oc] / 100, ceil = l.ceilCm[oc] / 100;
    const level = [SignKind.L0, SignKind.B1, SignKind.B2][g.key.s];
    const above = f.facePoint(W, L - 1, W - 1, L - 1, 0.5); // lintel face over X, looking into the storey
    if (ceil - floor >= 2.45) {
      g.addDecal({ kind: level, sign: true, px: above.x, py: floor + 2.26, pz: above.z, nx: above.nx, ny: 0, nz: above.nz, rot: 0, w: 0.45, h: 0.28, alpha: 1 });
    }
    const [si, sj] = f.cell(W, L - 2);
    if (si >= 0 && sj >= 0 && si < 32 && sj < 32) {
      const side = f.facePoint(W, L - 2, W - 1, L - 2, 0.62);
      const sf = l.floorCm[sj * 32 + si] / 100;
      g.addDecal({ kind: SignKind.STAIRS, sign: true, px: side.x, py: sf + 1.55, pz: side.z, nx: side.nx, ny: 0, nz: side.nz, rot: 0, w: 0.4, h: 0.4, alpha: 1 });
      if (ceil - floor < 2.45) {
        g.addDecal({ kind: level, sign: true, px: side.x, py: sf + 1.12, pz: side.z, nx: side.nx, ny: 0, nz: side.nz, rot: 0, w: 0.4, h: 0.25, alpha: 1 });
      }
    }
  }

  // (R2) discoverability from the storey side: a caged emergency bulb over the exit and the exit's door leaf propped
  // wide open, flat against the tower's outer wall (hinged on the jamb toward v = 0 so it stays on the tower face).
  towerEntrance(g, site, id);

  const portal: PortalSpec = {
    kind: 'tower', min: [ri0 * C, -TOWER_SPAN, rj0 * C], max: [ri1 * C, TOWER_SPAN, rj1 * C], towerId: id, endless: site.endless,
  };
  g.addStructure(StructureKind.TOWER, ri0, rj0, ri1, rj1, site.rot, portal);
  if (site.endless) {
    const [cx, cz] = f.point(1.5 * C, 2.5 * C);
    g.addAnomaly(AnomalyKind.ENDLESS_STAIRS, cx, cz, 3);
  }
}

/** Storey-side dressing of the exit X: a CAGE_BULB (storey fixture, bakeGroup 0, id structureFixtureId(towerId,
 * SALT.TOWER, 64)) 16 cm off the wall over the door, and a DOOR_LEAF propped open ~172 deg along the outer wall. */
export const TOWER_ENTRANCE_BULB = 64;
function towerEntrance(g: ChunkGrid, site: TowerSite, id: number): void {
  const f = towerFrame(site);
  const l = g.layout;
  const [oi, oj] = f.cell(W, L - 1);
  if (oi < 0 || oj < 0 || oi >= 32 || oj >= 32) return;
  const oc = oj * 32 + oi;
  const floor = l.floorCm[oc] / 100, ceil = l.ceilCm[oc] / 100;
  const face = f.facePoint(W, L - 1, W - 1, L - 1, 0.5);
  if (ceil - floor >= 2.5) {
    const y = floor + Math.min(2.38, ceil - floor - 0.18);
    const c = kelvinToLinearRGB(2900, 0);
    const fid = structureFixtureId(id, SALT.TOWER, TOWER_ENTRANCE_BULB);
    g.addFixture({
      kind: FixtureKind.CAGE_BULB, state: 0, shape: 1, px: face.x + face.nx * 0.16, py: y, pz: face.z + face.nz * 0.16,
      nx: face.nx, ny: 0, nz: face.nz, tx: face.nz !== 0 ? 1 : 0, ty: 0, tz: face.nx !== 0 ? 1 : 0,
      w: 0.1, h: 0.1, color: [c[0], c[1], c[2]], luminance: 95, hum: 0.6, bakeGroup: 0,
    }, { id: fid, seed: fixtureSeed(fid) });
  }
  const e = f.edge(W - 1, L - 1, W, L - 1);
  const side: -1 | 1 = e.aIsNeg ? 1 : -1; // the storey cell (B) is on the positive side when the tower cell is negative
  const [dx, dz] = f.dir(0, -1);
  const hinge: -1 | 1 = (e.axis === 'x' ? dz : dx) < 0 ? -1 : 1;
  placeLeaf(g, e.axis, e.i, e.j, side, hinge, 172, 2, hash3(id, SALT.TOWER, 2000));
}

/** Yaw facing -u (into the tower) per footprint rot (u: rot0 +x, rot1 +z, rot2 -x, rot3 -z). */
const EXIT_YAW: readonly number[] = [Math.PI / 2, 0, -Math.PI / 2, Math.PI];

/** Outside the exit doorway (cell u = 3, v = 4 of the tower frame), facing in. */
export function towerExitCell(site: TowerSite): { li: number; lj: number; yaw: number } {
  const [li, lj] = towerFrame(site).cell(W, L - 1);
  return { li, lj, yaw: EXIT_YAW[site.rot] };
}
