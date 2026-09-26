// src/world/structures/doors.ts — R2 door leaves on DOORWAY edges (called from MANILA / OFFICE / CONCRETE generate()
// and by the zone-transition connectors). A DOORWAY edge is a framed 0.9 m hole; a DOOR_LEAF prop hung in it reads as
// a real door. States (per edge, hashed):
//   open  70 %: swung 85-100 deg into the room on the side with free floor, preferring the hinge side whose
//               neighbouring wall the leaf can rest against; collision stays on (it snaps to 90 deg along the jamb);
//   ajar  20 %: 15-40 deg, and CLOSED 10 %: in the door plane — both only where one side is a dead end (a pocket of
//               <= DEAD_END_MAX cells without ports reached only through this door), swung into / closing off that
//               pocket, so a stuck door never cuts the walkable graph that matters (the pocket stays connected
//               logically; the door rattles when used, WP13).
// Leaves are never hung over ramps, blockers, water or cells that already hold a prop in the swing quadrant.

import { CELL, WALL_T } from '../../core/constants.ts';
import { cellIdx } from '../../core/grid.ts';
import { CellFlag, EdgeKind, PropKind } from '../../core/ids.ts';
import type { ChunkLayout } from '../../core/layout.ts';
import { hash01, hash2, hash5, SALT } from '../../core/rng.ts';
import type { ChunkGrid, ZoneGenContext } from '../../core/world.ts';
import { cellWalkable, edgePassable, portCells } from '../connectivity.ts';
import { edgeKindAt, N, solidsInRect } from './util.ts';

export const DEAD_END_MAX = 24;
export const DoorState = { OPEN: 0, AJAR: 1, CLOSED: 2 } as const;
const LEAF_HALF = 0.44; // DOOR_LEAF is 0.88 m wide (hinge knuckles on its -x edge)

export interface DoorOpts {
  p: number; // share of DOORWAY edges that get a leaf
  variant: (h: number) => number; // DOOR_LEAF variant from a hash (0 / 3 wood, 1 painted, 2 metal)
  tag: number; // hash tag (per zone family)
  /** optional filter on the edge (axis, i, j) */
  filter?: (axis: 'x' | 'z', i: number, j: number) => boolean;
}
export interface DoorCounts { doorways: number; leaves: number; open: number; ajar: number; closed: number }

/** Cells reached from `start` without crossing edge (axis, i, j), stopping at `max` + 1. Returns the count, or
 * Infinity if a port cell is reached (the pocket is not a dead end). */
function pocketSize(l: ChunkLayout, start: number, axis: 'x' | 'z', i: number, j: number, max: number, ports: Uint8Array, seen: Uint8Array, q: Int32Array): number {
  seen.fill(0);
  let head = 0, tail = 0;
  seen[start] = 1; q[tail++] = start;
  while (head < tail) {
    const c = q[head++];
    if (ports[c]) return Infinity;
    if (tail > max) return Infinity;
    const li = c & 31, lj = c >> 5;
    const go = (n: number, ax: 'x' | 'z', ei: number, ej: number): void => {
      if (seen[n] || (ax === axis && ei === i && ej === j)) return;
      if (!cellWalkable(l, n) || !edgePassable(l, ax, ei, ej)) return;
      seen[n] = 1; q[tail++] = n;
    };
    if (li > 0) go(c - 1, 'x', li, lj);
    if (li < N - 1) go(c + 1, 'x', li + 1, lj);
    if (lj > 0) go(c - N, 'z', li, lj);
    if (lj < N - 1) go(c + N, 'z', li, lj + 1);
  }
  return tail;
}

/** Hangs leaves on interior DOORWAY edges. Returns counts (for tests / debug). */
export function hangDoors(ctx: ZoneGenContext, o: DoorOpts): DoorCounts {
  const g = ctx.grid, l = g.layout;
  const out: DoorCounts = { doorways: 0, leaves: 0, open: 0, ajar: 0, closed: 0 };
  const ports = new Uint8Array(N * N);
  for (const c of portCells(l)) ports[c] = 1;
  const seen = new Uint8Array(N * N), q = new Int32Array(N * N);
  for (const axis of ['x', 'z'] as const) {
    for (let a = 1; a < N; a++) {
      for (let b = 0; b < N; b++) {
        const i = axis === 'x' ? a : b, j = axis === 'x' ? b : a;
        if (edgeKindAt(l, axis, i, j) !== EdgeKind.DOORWAY) continue;
        if (g.isFrozenEdge(axis, i, j)) continue;
        const ca = axis === 'x' ? cellIdx(i - 1, j) : cellIdx(i, j - 1), cb = cellIdx(i, j);
        if ((l.flags[ca] & CellFlag.RESERVED) !== 0 || (l.flags[cb] & CellFlag.RESERVED) !== 0) continue;
        if (!cellWalkable(l, ca) || !cellWalkable(l, cb)) continue;
        if (o.filter && !o.filter(axis, i, j)) continue;
        out.doorways++;
        // a leaf already hangs here (closet programs, connectors)
        const ex = axis === 'x' ? i * CELL : (i + 0.5) * CELL, ez = axis === 'x' ? (j + 0.5) * CELL : j * CELL;
        if (l.props.some((pp) => pp.kind === PropKind.DOOR_LEAF && Math.abs(pp.x - ex) < 0.9 && Math.abs(pp.z - ez) < 0.9)) continue;
        const gi = g.gi0 + i, gj = g.gj0 + j;
        const h = hash5(ctx.seed, SALT.PROP, o.tag, axis === 'x' ? gi * 2 : gi * 2 + 1, gj);
        if (hash01(h) >= o.p) continue;
        const u = hash01(hash2(h, 1));
        let state: number = u < 0.7 ? DoorState.OPEN : u < 0.9 ? DoorState.AJAR : DoorState.CLOSED;
        // dead-end side for the stuck states
        let deadSide = 0; // -1: the negative-side cell's pocket, +1: the positive side
        if (state !== DoorState.OPEN) {
          const pa = pocketSize(l, ca, axis, i, j, DEAD_END_MAX, ports, seen, q);
          const pb = pocketSize(l, cb, axis, i, j, DEAD_END_MAX, ports, seen, q);
          if (pb <= DEAD_END_MAX) deadSide = 1; else if (pa <= DEAD_END_MAX) deadSide = -1;
          if (deadSide === 0) state = DoorState.OPEN;
        }
        // swing side: into the dead end for stuck doors, else the free side (prefer the room over the corridor)
        const free = (side: -1 | 1, hinge: -1 | 1): boolean => swingFree(l, axis, i, j, side, hinge);
        let side: -1 | 1 = deadSide !== 0 ? (deadSide as -1 | 1) : hash01(hash2(h, 2)) < 0.5 ? -1 : 1;
        let hinge: -1 | 1 = hash01(hash2(h, 3)) < 0.5 ? -1 : 1;
        if (state === DoorState.OPEN) {
          // prefer a hinge whose leaf can rest against a wall; then any free quadrant
          const opts: [-1 | 1, -1 | 1][] = [[side, hinge], [side, (-hinge) as -1 | 1], [(-side) as -1 | 1, hinge], [(-side) as -1 | 1, (-hinge) as -1 | 1]];
          let best: [-1 | 1, -1 | 1] | null = null;
          for (const [s, hh] of opts) {
            if (!free(s, hh) || !leafClear(l, axis, i, j, s, hh)) continue;
            if (best === null) best = [s, hh];
            if (restsOnWall(l, axis, i, j, s, hh)) { best = [s, hh]; break; }
          }
          if (!best) continue;
          [side, hinge] = best;
        } else if (!free(side, hinge)) {
          hinge = (-hinge) as -1 | 1;
          if (!free(side, hinge)) continue;
        }
        const deg = state === DoorState.OPEN ? 85 + 15 * hash01(hash2(h, 4)) : state === DoorState.AJAR ? 15 + 25 * hash01(hash2(h, 4)) : 0;
        placeLeaf(g, axis, i, j, side, hinge, deg, o.variant(h), h);
        out.leaves++;
        if (state === DoorState.OPEN) out.open++; else if (state === DoorState.AJAR) out.ajar++; else out.closed++;
      }
    }
  }
  return out;
}

/** The quadrant the leaf sweeps (cell on `side`, half toward the hinge) is plain floor: no ramp / box solid, blocker,
 * water or prop there, and the floors on both sides are level. */
export function swingFree(l: ChunkLayout, axis: 'x' | 'z', i: number, j: number, side: -1 | 1, hinge: -1 | 1): boolean {
  const ci = axis === 'x' ? (side < 0 ? i - 1 : i) : i, cj = axis === 'x' ? j : (side < 0 ? j - 1 : j);
  const c = cellIdx(ci, cj);
  if (!cellWalkable(l, c) || l.blockCm[c] > 0 || l.waterCm[c] > l.floorCm[c] + 3) return false;
  const oa = axis === 'x' ? cellIdx(i - 1, j) : cellIdx(i, j - 1), ob = cellIdx(i, j);
  if (Math.abs(l.floorCm[oa] - l.floorCm[ob]) > 2) return false;
  if (solidsInRect(l, ci, cj, ci + 1, cj + 1)) return false;
  // props in the swing quadrant (half cell toward the hinge, within 1.0 m of the door line)
  const lineM = (axis === 'x' ? i : j) * CELL, midM = ((axis === 'x' ? j : i) + 0.5) * CELL;
  for (const p of l.props) {
    const pl = axis === 'x' ? p.x : p.z, pw = axis === 'x' ? p.z : p.x;
    const d = (pl - lineM) * side;
    if (d < -0.05 || d > 1.05) continue;
    const t = (pw - midM) * hinge;
    if (t > -0.25 && t < 0.75) return false;
  }
  return true;
}

/** An open leaf (~90 deg) sticks 0.9 m into the swing cell next to its hinge jamb. That only reads (and walks) like a
 * real door if it rests against a wall there, or if the space continues past the leaf's free edge (the swing cell's far
 * edge is passable into walkable floor). Swung into a 1-cell corridor running along the door line it would wall the
 * corridor off for the player (the graph would still call it connected). */
export function leafClear(l: ChunkLayout, axis: 'x' | 'z', i: number, j: number, side: -1 | 1, hinge: -1 | 1): boolean {
  if (restsOnWall(l, axis, i, j, side, hinge)) return true;
  if (axis === 'x') {
    const far = side < 0 ? i - 1 : i + 1, bi = side < 0 ? i - 2 : i + 1;
    if (bi < 0 || bi >= N) return false;
    return edgePassable(l, 'x', far, j) && cellWalkable(l, cellIdx(bi, j)) && l.blockCm[cellIdx(bi, j)] === 0;
  }
  const far = side < 0 ? j - 1 : j + 1, bj = side < 0 ? j - 2 : j + 1;
  if (bj < 0 || bj >= N) return false;
  return edgePassable(l, 'z', i, far) && cellWalkable(l, cellIdx(i, bj)) && l.blockCm[cellIdx(i, bj)] === 0;
}

/** Whether the edge next to the hinge jamb, perpendicular to the door line on the swing side, is a wall-like edge. */
function restsOnWall(l: ChunkLayout, axis: 'x' | 'z', i: number, j: number, side: -1 | 1, hinge: -1 | 1): boolean {
  // swing cell and the perpendicular edge on its hinge side
  if (axis === 'x') {
    const ci = side < 0 ? i - 1 : i;
    const k = edgeKindAt(l, 'z', ci, hinge < 0 ? j : j + 1);
    return k === EdgeKind.WALL || k === EdgeKind.WINDOW || k === EdgeKind.PARTITION;
  }
  const cj = side < 0 ? j - 1 : j;
  const k = edgeKindAt(l, 'x', hinge < 0 ? i : i + 1, cj);
  return k === EdgeKind.WALL || k === EdgeKind.WINDOW || k === EdgeKind.PARTITION;
}

/** DOOR_LEAF prop hinged at the jamb on `hinge` side of the doorway (axis, i, j), opened `deg` degrees toward
 * `side`. The leaf's local +x runs from its hinge edge to its free edge; yaw maps local +x to (cos yaw, -sin yaw). */
export function placeLeaf(g: ChunkGrid, axis: 'x' | 'z', i: number, j: number, side: -1 | 1, hinge: -1 | 1, deg: number, variant: number, seed: number, flags?: number): void {
  const l = g.layout;
  const lineM = (axis === 'x' ? i : j) * CELL, midM = ((axis === 'x' ? j : i) + 0.5) * CELL;
  // frame axes: n = across the door line (toward `side`), t = along it (toward the hinge)
  const hingeT = midM + hinge * (0.45 - 0.01), hingeN = lineM + side * (WALL_T / 2 - 0.035);
  const th = (deg * Math.PI) / 180;
  // closed leaf points from the hinge toward the other jamb (-hinge along t); opening rotates it toward `side`
  const dT = -hinge * Math.cos(th), dN = side * Math.sin(th);
  let cT = hingeT + dT * LEAF_HALF, cN = hingeN + dN * LEAF_HALF;
  // keep the leaf's thickness off the jamb / wall it rests against when wide open
  cT += hinge * 0.03 * Math.sin(th);
  const x = axis === 'x' ? cN : cT, z = axis === 'x' ? cT : cN;
  const dx = axis === 'x' ? dN : dT, dz = axis === 'x' ? dT : dN;
  const yaw = Math.atan2(-dz, dx);
  const ci = axis === 'x' ? (side < 0 ? i - 1 : i) : i, cj = axis === 'x' ? j : (side < 0 ? j - 1 : j);
  const y = l.floorCm[cellIdx(ci, cj)] / 100;
  g.addProp({
    kind: PropKind.DOOR_LEAF, variant, x, y, z, yaw, scale: 1,
    flags: flags ?? 1 /* SolidFlag.COLLIDE */, seed: seed >>> 0,
  });
}
