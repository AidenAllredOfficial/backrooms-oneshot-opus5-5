// src/world/content/occupancy.ts — shared placement space for props and vignettes (WP4, private).
//
// Exact checks (walls as 0.15 m thick edge boxes incl. end posts, cells, solids, prop AABBs) decide whether a prop
// fits; a 0.3 m bitmap (128 x 128 per chunk) holds the player configuration space (obstacles grown by the player
// radius, 4-connected) used to reject COLLIDE props that would split walkable space, and a chamfer distance-to-wall
// transform used by 'center' placement. Footprints use the prop's yaw snapped to 90 degrees when the yaw is axis
// aligned, otherwise the footprint's bounding circle (conservative, and free of trigonometry in layout decisions).

import { CELL, PLAYER, WALL_T } from '../../core/constants.ts';
import { ARCH_JAMB, CellFlag, DOOR_W, EdgeKind, PROP_DEFS, PropFlag, SolidFlag, cellIdx, exIdx, ezIdx } from '../../core/index.ts';
import type { ChunkGrid, ChunkLayout, EdgeOpts, MatId, PropKindId, PropPlacement } from '../../core/index.ts';
import { cellWalkable, edgePassable, portCells } from '../connectivity.ts';
import { rectHitsEdges } from './fixtures.ts';
import { edgeKindPassable, isOpenFloor, isWalkableCell, N } from './util.ts';

export const OCC_RES = 0.3;
export const OCC_N = 128;
const R = PLAYER.radius;
const HALF_PI = Math.PI / 2;

export interface Box2 { x0: number; z0: number; x1: number; z1: number }
export interface Box3 extends Box2 { y0: number; y1: number }

/** Quarter turns of an axis-aligned yaw, or -1 for a free yaw. */
export function quarterTurns(yaw: number): number {
  const q = yaw / HALF_PI;
  const r = Math.round(q);
  return Math.abs(q - r) < 1e-6 ? ((r % 4) + 4) % 4 : -1;
}

/** Conservative xz AABB of a prop footprint at (x, z, yaw), optionally padded. */
export function propAABB(kind: PropKindId, x: number, z: number, yaw: number, pad = 0, scale = 1): Box2 {
  const s = PROP_DEFS[kind].size;
  let hx = (s[0] * scale) / 2, hz = (s[2] * scale) / 2;
  const q = quarterTurns(yaw);
  if (q < 0) { const r = Math.sqrt(hx * hx + hz * hz); hx = r; hz = r; }
  else if ((q & 1) === 1) { const t = hx; hx = hz; hz = t; }
  return { x0: x - hx - pad, z0: z - hz - pad, x1: x + hx + pad, z1: z + hz + pad };
}

export interface FitOpts {
  wallMounted?: boolean; // back touches a wall: skip floor/ceiling checks of the cells it overhangs
  allowKeepClear?: boolean;
  ignoreProps?: boolean;
  ceiling?: boolean; // PropFlag.CEILING copy: no floor checks, no split test
  ignoreKinds?: readonly number[]; // props of these kinds do not block (e.g. a car over its stall's wheel stop)
}

export class PlacementSpace {
  readonly l: ChunkLayout;
  readonly keep: Uint8Array;
  /** player configuration space: 1 = the player's centre cannot be here */
  readonly cspace = new Uint8Array(OCC_N * OCC_N);
  private boxes: (Box3 & { kind: number })[] = [];
  private dist: Float32Array | null = null;
  private scratch = new Int32Array(OCC_N * OCC_N);
  private seen = new Uint8Array(OCC_N * OCC_N);

  constructor(l: ChunkLayout, keep: Uint8Array, staticOnly = false) {
    this.l = l;
    this.keep = keep;
    this.buildStatic();
    if (!staticOnly) for (const p of l.props) this.addBox(p);
  }

  // ------------------------------------------------------------------ configuration space
  private markGrown(x0: number, z0: number, x1: number, z1: number, grow: number): void {
    const a = Math.max(0, Math.ceil((x0 - grow) / OCC_RES - 0.5)), b = Math.min(OCC_N - 1, Math.floor((x1 + grow) / OCC_RES - 0.5));
    const c = Math.max(0, Math.ceil((z0 - grow) / OCC_RES - 0.5)), d = Math.min(OCC_N - 1, Math.floor((z1 + grow) / OCC_RES - 0.5));
    for (let pz = c; pz <= d; pz++) for (let px = a; px <= b; px++) this.cspace[pz * OCC_N + px] = 1;
  }
  private buildStatic(): void {
    const l = this.l, T = WALL_T / 2;
    for (let c = 0; c < N * N; c++) {
      if (isWalkableCell(l, c)) continue;
      const li = c & 31, lj = c >> 5;
      this.markGrown(li * CELL, lj * CELL, (li + 1) * CELL, (lj + 1) * CELL, R);
    }
    const jamb = (CELL - DOOR_W) / 2;
    const edge = (kind: number, hA: number, X: number, s0: number, xAxis: boolean, floorStep: boolean): void => {
      const put = (t0: number, t1: number, th: number): void => {
        if (xAxis) this.markGrown(X - th, s0 + t0, X + th, s0 + t1, R);
        else this.markGrown(s0 + t0, X - th, s0 + t1, X + th, R);
      };
      if (kind === EdgeKind.OPEN) { if (floorStep) put(0, CELL, 0); return; }
      if (kind === EdgeKind.DOORWAY) { put(0, jamb, T); put(CELL - jamb, CELL, T); if (floorStep) put(0, CELL, 0); return; }
      if (kind === EdgeKind.ARCH) { put(0, ARCH_JAMB, T); put(CELL - ARCH_JAMB, CELL, T); if (floorStep) put(0, CELL, 0); return; }
      if (kind === EdgeKind.HEADER && edgeKindPassable(kind, hA)) { if (floorStep) put(0, CELL, 0); return; }
      put(0, CELL, T);
    };
    for (let lj = 0; lj < N; lj++) {
      for (let i = 0; i <= N; i++) {
        const k = exIdx(i, lj);
        const step = i > 0 && i < N && Math.abs(l.floorCm[cellIdx(i - 1, lj)] - l.floorCm[cellIdx(i, lj)]) > 36;
        edge(l.ex.kind[k], l.ex.hA[k], i * CELL, lj * CELL, true, step);
      }
    }
    for (let j = 0; j <= N; j++) {
      for (let li = 0; li < N; li++) {
        const k = ezIdx(li, j);
        const step = j > 0 && j < N && Math.abs(l.floorCm[cellIdx(li, j - 1)] - l.floorCm[cellIdx(li, j)]) > 36;
        edge(l.ez.kind[k], l.ez.hA[k], j * CELL, li * CELL, false, step);
      }
    }
    for (const s of l.solids) {
      if (s.kind !== 'box' || (s.flags & SolidFlag.COLLIDE) === 0) continue;
      const cx = Math.min(N - 1, Math.max(0, Math.floor((s.min[0] + s.max[0]) / 2 / CELL)));
      const cz = Math.min(N - 1, Math.max(0, Math.floor((s.min[2] + s.max[2]) / 2 / CELL)));
      const floor = l.floorCm[cellIdx(cx, cz)] / 100;
      if (s.max[1] <= floor + PLAYER.stepMax || s.min[1] >= floor + PLAYER.height) continue;
      this.markGrown(s.min[0], s.min[2], s.max[0], s.max[2], R);
    }
  }
  private addBox(p: PropPlacement): void {
    const def = PROP_DEFS[p.kind];
    if (!def) return;
    const b = propAABB(p.kind, p.x, p.z, p.yaw, 0, p.scale || 1);
    const ceiling = (p.flags & PropFlag.CEILING) !== 0;
    const h = def.size[1] * (p.scale || 1);
    this.boxes.push({ ...b, y0: ceiling ? p.y - h : p.y, y1: ceiling ? p.y : p.y + h, kind: p.kind });
    const collide = !ceiling && (def.collide || (p.flags & SolidFlag.COLLIDE) !== 0);
    // (the distance-to-wall transform only reads static obstacles, so a new prop never invalidates it)
    if (collide) this.markGrown(b.x0, b.z0, b.x1, b.z1, R);
  }

  // ------------------------------------------------------------------ queries
  /** Does the AABB (with y range) fit: inside the chunk, open floor cells, no walls/solids/props/keepClear? */
  fits(kind: PropKindId, x: number, z: number, yaw: number, y: number, o: FitOpts = {}): boolean {
    const l = this.l;
    const def = PROP_DEFS[kind];
    const b = propAABB(kind, x, z, yaw);
    if (b.x0 < 0.02 || b.z0 < 0.02 || b.x1 > N * CELL - 0.02 || b.z1 > N * CELL - 0.02) return false;
    const h = def.size[1];
    const y0 = o.ceiling ? y - h : y, y1 = o.ceiling ? y : y + h;
    const oc = cellIdx(Math.floor(x / CELL), Math.floor(z / CELL));
    const floor = l.floorCm[oc];
    const i0 = Math.floor(b.x0 / CELL), i1 = Math.floor((b.x1 - 1e-6) / CELL);
    const j0 = Math.floor(b.z0 / CELL), j1 = Math.floor((b.z1 - 1e-6) / CELL);
    for (let lj = j0; lj <= j1; lj++) {
      for (let li = i0; li <= i1; li++) {
        const c = cellIdx(li, lj);
        if (!o.allowKeepClear && this.keep[c]) return false;
        if (!o.wallMounted && !o.ceiling) {
          if (!isOpenFloor(l, c) || l.floorCm[c] !== floor) return false;
          if ((l.ceilCm[c] - floor) / 100 < h + 0.05) return false;
        } else if ((l.flags[c] & (CellFlag.TOWER | CellFlag.ELEVATOR | CellFlag.SOLID)) !== 0) return false;
      }
    }
    if (rectHitsEdges(l, b.x0, b.z0, b.x1, b.z1)) return false;
    for (const s of l.solids) {
      let a0: number, a1: number, c0: number, c1: number, s0: number, s1: number;
      if (s.kind === 'box') { a0 = s.min[0]; a1 = s.max[0]; c0 = s.min[2]; c1 = s.max[2]; s0 = s.min[1]; s1 = s.max[1]; }
      else if (s.kind === 'ramp') { a0 = s.x0; a1 = s.x1; c0 = s.z0; c1 = s.z1; s0 = -100; s1 = 100; }
      else {
        a0 = Math.min(s.a[0], s.b[0]) - s.r; a1 = Math.max(s.a[0], s.b[0]) + s.r; c0 = Math.min(s.a[2], s.b[2]) - s.r; c1 = Math.max(s.a[2], s.b[2]) + s.r;
        s0 = Math.min(s.a[1], s.b[1]) - s.r; s1 = Math.max(s.a[1], s.b[1]) + s.r;
      }
      if (a0 < b.x1 && a1 > b.x0 && c0 < b.z1 && c1 > b.z0 && s0 < y1 && s1 > y0) return false;
    }
    if (!o.ignoreProps) {
      for (const q of this.boxes) {
        if (o.ignoreKinds && o.ignoreKinds.includes(q.kind)) continue;
        if (q.x0 < b.x1 && q.x1 > b.x0 && q.z0 < b.z1 && q.z1 > b.z0 && q.y0 < y1 && q.y1 > y0) return false;
      }
    }
    if (!o.ceiling && def.collide && this.wouldSplit(b)) return false;
    return true;
  }

  /** Commit a prop (after `fits`): records its box and updates the configuration space. */
  commit(p: PropPlacement): void {
    this.addBox(p);
  }

  /** Would blocking the grown AABB split walkable configuration space that is connected around it? */
  wouldSplit(b: Box2): boolean {
    const a = Math.max(0, Math.ceil((b.x0 - R) / OCC_RES - 0.5)), bb = Math.min(OCC_N - 1, Math.floor((b.x1 + R) / OCC_RES - 0.5));
    const c = Math.max(0, Math.ceil((b.z0 - R) / OCC_RES - 0.5)), d = Math.min(OCC_N - 1, Math.floor((b.z1 + R) / OCC_RES - 0.5));
    if (a > bb || c > d) return false;
    // ring pixels around [a..bb] x [c..d], in cyclic order
    const ring: number[] = [];
    const push = (px: number, pz: number): void => {
      ring.push(px < 0 || pz < 0 || px >= OCC_N || pz >= OCC_N ? -1 : pz * OCC_N + px);
    };
    for (let px = a - 1; px <= bb + 1; px++) push(px, c - 1);
    for (let pz = c; pz <= d + 1; pz++) push(bb + 1, pz);
    for (let px = bb; px >= a - 1; px--) push(px, d + 1);
    for (let pz = d; pz >= c; pz--) push(a - 1, pz);
    const free = (i: number): boolean => i >= 0 && this.cspace[i] === 0;
    let runs = 0, anyFree = -1;
    for (let k = 0; k < ring.length; k++) {
      const f = free(ring[k]), prev = free(ring[(k + ring.length - 1) % ring.length]);
      if (f) { anyFree = ring[k]; if (!prev) runs++; }
    }
    if (anyFree < 0 || runs <= 1) return false;
    // flood (4-connected) from one free ring pixel, the box blocked; every free ring pixel must be reached
    const inBox = (p: number): boolean => { const px = p & (OCC_N - 1), pz = p >> 7; return px >= a && px <= bb && pz >= c && pz <= d; };
    const seen = this.seen;
    seen.fill(0);
    const q = this.scratch;
    let head = 0, tail = 0;
    q[tail++] = anyFree; seen[anyFree] = 1;
    let need = 0;
    const targets = new Set<number>();
    for (const r of ring) if (free(r) && !targets.has(r)) { targets.add(r); need++; }
    let got = 0;
    while (head < tail) {
      const p = q[head++];
      if (targets.has(p)) { got++; if (got === need) return false; }
      const px = p & (OCC_N - 1), pz = p >> 7;
      if (px > 0) { const n = p - 1; if (!seen[n] && this.cspace[n] === 0 && !inBox(n)) { seen[n] = 1; q[tail++] = n; } }
      if (px < OCC_N - 1) { const n = p + 1; if (!seen[n] && this.cspace[n] === 0 && !inBox(n)) { seen[n] = 1; q[tail++] = n; } }
      if (pz > 0) { const n = p - OCC_N; if (!seen[n] && this.cspace[n] === 0 && !inBox(n)) { seen[n] = 1; q[tail++] = n; } }
      if (pz < OCC_N - 1) { const n = p + OCC_N; if (!seen[n] && this.cspace[n] === 0 && !inBox(n)) { seen[n] = 1; q[tail++] = n; } }
    }
    return got < need;
  }

  /** Chamfer distance (pixels) from the static obstacles (walls, non-walkable cells, solids). */
  distance(): Float32Array {
    if (this.dist) return this.dist;
    const D = new Float32Array(OCC_N * OCC_N);
    const INF = 1e9;
    // obstacles: static cspace only (rebuild without props)
    const stat = new PlacementSpace(this.l, this.keep, true).cspace;
    for (let i = 0; i < D.length; i++) D[i] = stat[i] ? 0 : INF;
    const d1 = 1, d2 = 1.4142;
    for (let pz = 0; pz < OCC_N; pz++) {
      for (let px = 0; px < OCC_N; px++) {
        const i = pz * OCC_N + px;
        let v = D[i];
        if (px > 0) v = Math.min(v, D[i - 1] + d1);
        if (pz > 0) {
          v = Math.min(v, D[i - OCC_N] + d1);
          if (px > 0) v = Math.min(v, D[i - OCC_N - 1] + d2);
          if (px < OCC_N - 1) v = Math.min(v, D[i - OCC_N + 1] + d2);
        }
        D[i] = v;
      }
    }
    for (let pz = OCC_N - 1; pz >= 0; pz--) {
      for (let px = OCC_N - 1; px >= 0; px--) {
        const i = pz * OCC_N + px;
        let v = D[i];
        if (px < OCC_N - 1) v = Math.min(v, D[i + 1] + d1);
        if (pz < OCC_N - 1) {
          v = Math.min(v, D[i + OCC_N] + d1);
          if (px < OCC_N - 1) v = Math.min(v, D[i + OCC_N + 1] + d2);
          if (px > 0) v = Math.min(v, D[i + OCC_N - 1] + d2);
        }
        D[i] = v;
      }
    }
    this.dist = D;
    return D;
  }


}

// ------------------------------------------------------------------ R2 (B6): revertible edge edits + reachability
// Content that carves rooms after connectivity repair (mattress closets, stamped REPEATED_ROOM pairs) writes edges
// through the grid API, checks that every cell reachable from the ports before is still reachable, and reverts
// otherwise. Seam lines are never touched (they are frozen and shared with the neighbour).

interface EdgeRec { axis: 'x' | 'z'; i: number; j: number; kind: number; hA: number; hB: number; matNeg: number; matPos: number; trim: number }

export class EdgeEdits {
  private readonly saved: EdgeRec[] = [];
  private readonly g: ChunkGrid;
  constructor(g: ChunkGrid) { this.g = g; }
  get count(): number { return this.saved.length; }
  /** Write an interior edge (false for seam lines / refused edges). The first write of an edge records its state. */
  set(axis: 'x' | 'z', i: number, j: number, kind: number, o: EdgeOpts = {}): boolean {
    if (axis === 'x' ? i <= 0 || i >= N || j < 0 || j >= N : j <= 0 || j >= N || i < 0 || i >= N) return false;
    const l = this.g.layout;
    const e = axis === 'x' ? l.ex : l.ez;
    const k = axis === 'x' ? exIdx(i, j) : ezIdx(i, j);
    if (!this.saved.some((r) => r.axis === axis && r.i === i && r.j === j)) {
      this.saved.push({ axis, i, j, kind: e.kind[k], hA: e.hA[k], hB: e.hB[k], matNeg: e.matNeg[k], matPos: e.matPos[k], trim: e.trim[k] });
    }
    return this.g.setEdge(axis, i, j, kind, o);
  }
  revert(): void {
    for (let n = this.saved.length - 1; n >= 0; n--) {
      const r = this.saved[n];
      this.g.setEdge(r.axis, r.i, r.j, r.kind, { hA: r.hA, hB: r.hB, matNeg: r.matNeg as MatId, matPos: r.matPos as MatId, trim: r.trim }, true);
    }
    this.saved.length = 0;
  }
}

/** Cells reachable from the walkable port cells (validateLayout's rule: walkable cells, passable interior edges). */
export function portReach(l: ChunkLayout): Uint8Array {
  const seen = new Uint8Array(N * N);
  const stack: number[] = [];
  for (const c of portCells(l)) if (cellWalkable(l, c) && !seen[c]) { seen[c] = 1; stack.push(c); }
  while (stack.length > 0) {
    const c = stack.pop() as number;
    const li = c & 31, lj = c >> 5;
    const go = (n: number, axis: 'x' | 'z', i: number, j: number): void => {
      if (!seen[n] && cellWalkable(l, n) && edgePassable(l, axis, i, j)) { seen[n] = 1; stack.push(n); }
    };
    if (li > 0) go(c - 1, 'x', li, lj);
    if (li < N - 1) go(c + 1, 'x', li + 1, lj);
    if (lj > 0) go(c - N, 'z', li, lj);
    if (lj < N - 1) go(c + N, 'z', li, lj + 1);
  }
  return seen;
}
/** Every cell reached in `before` is reached in `after`. */
export function reachKept(before: Uint8Array, after: Uint8Array): boolean {
  for (let c = 0; c < before.length; c++) if (before[c] && !after[c]) return false;
  return true;
}

/** Does any prop footprint (non-ceiling) overlap the xz rect? */
export function propsInRect(l: ChunkLayout, x0: number, z0: number, x1: number, z1: number): PropPlacement[] {
  const out: PropPlacement[] = [];
  for (const p of l.props) {
    if ((p.flags & PropFlag.CEILING) !== 0 || !PROP_DEFS[p.kind]) continue;
    const b = propAABB(p.kind, p.x, p.z, p.yaw, 0, p.scale || 1);
    if (b.x0 < x1 && b.x1 > x0 && b.z0 < z1 && b.z1 > z0) out.push(p);
  }
  return out;
}
