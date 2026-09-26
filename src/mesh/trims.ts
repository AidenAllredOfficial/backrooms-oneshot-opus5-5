// src/mesh/trims.ts — WP5 trims (§5 WP5 rules 2 and 8): baseboards (BASEBOARD bit; 0.10 m tall, 0.015 m proud,
// wrapped around posts and jambs), DOORWAY casings (CASING bit, 0.07 m), threshold strips (floorMat change across a
// passable edge or the THRESHOLD bit) and ROLLUP header boxes with a slatted door-bottom strip. Material = the cell's
// palette trimMat (METAL_PAINTED for roll-ups); lightmap uv borrowed from the wall chart or floor grid behind
// (TRIM_BORROW). Pure module.

import { ARCH_JAMB, CELL, DOOR_W, TILE_CELLS, TILE_SIZE } from '../core/constants.ts';
import { EdgeKind, EdgeTrim, Mat, VFlag } from '../core/ids.ts';
import type { ChartKindId } from '../core/mesh.ts';
import { ChartSpec, hQuad, state, vQuad, type Face, type Plan } from './plan.ts';
import { M, cix, edgeCells, eix, type TileGrid } from './tileGrid.ts';
import { kf, q4, tintRGB } from './uv.ts';
import { VFaceIndex } from './faceIndex.ts';
import { POST_H, WallModel, addVSplit, vSpec } from './walls.ts';

/** TRIM_PAINT's table albedo is the bright white of T-bars and troffer frames (B3: [0.72, 0.70, 0.64]); baseboards,
 * casings and thresholds keep their darker aged cream (the old table mean [0.45, 0.40, 0.30]) through the tint. */
const TRIM_AGED: readonly [number, number, number] = [0.625, 0.571, 0.469];
function trimTint(mat: number, r: number, g: number, b: number): number {
  return mat === Mat.TRIM_PAINT ? tintRGB(r * TRIM_AGED[0], g * TRIM_AGED[1], b * TRIM_AGED[2]) : tintRGB(r, g, b);
}

const K_SOFFIT = 4 as ChartKindId, K_BOX = 5 as ChartKindId;
const EPS = 1e-5;
const BB_H = 0.1; // baseboard height
const BB_D = 0.015; // baseboard projection
const CAS_W = 0.07; // casing width
const CAS_D = 0.018; // casing projection
const TH_W = 0.025; // threshold half width
const TH_H = 0.006; // threshold height
const ROLL_D = 0.15; // roll-up header box half depth (0.3 m)
const ROLL_H = 0.35;
const JAMB = (CELL - DOOR_W) / 2;

// ------------------------------------------------------------------------------------------------ baseboards

interface FP { x0: number; x1: number; z0: number; z1: number; el: boolean }

class Baseboards {
  private cache = new Map<number, FP[]>();
  private wm: WallModel;
  private g: TileGrid;
  constructor(wm: WallModel) { this.wm = wm; this.g = wm.g; }

  /** Cells that can carry baseboards (a floor, not tower / void / solid). */
  floorCell(k: number): boolean { return this.g.hasFloor(k); }

  /** Wall footprints (at floor level) inside cell (ci, cj), with baseboard eligibility. */
  footprints(ci: number, cj: number): FP[] {
    const k = cix(ci, cj);
    let out = this.cache.get(k);
    if (out) return out;
    out = [];
    this.cache.set(k, out);
    const g = this.g, wm = this.wm;
    if (!this.floorCell(k)) return out;
    const bot = g.bottom(k);
    const X0 = ci * CELL, Z0 = cj * CELL, X1 = X0 + CELL, Z1 = Z0 + CELL;
    // [a, L, c, side of this cell]
    const edges: [number, number, number, number][] = [[0, ci, cj, 1], [0, ci + 1, cj, 0], [1, cj, ci, 1], [1, cj + 1, ci, 0]];
    for (const [a, L, c, s] of edges) {
      const e = eix(a, L, c);
      if (!wm.ok[e] || !wm.thick[e]) continue;
      const kind = g.eKind[e];
      const part = kind === EdgeKind.PARTITION;
      const d = part ? 0.075 : wm.half[e];
      const el = (g.eTrim[e] & EdgeTrim.BASEBOARD) !== 0 && !part;
      const pr = wm.pieces(e);
      const lc = L * CELL;
      const n0 = s ? lc : lc - d, n1 = s ? lc + d : lc;
      const add = (t0: number, t1: number): void => {
        if (t1 - t0 <= EPS) return;
        const tb = c * CELL;
        if (a === 0) out!.push({ x0: n0, x1: n1, z0: tb + t0, z1: tb + t1, el });
        else out!.push({ x0: tb + t0, x1: tb + t1, z0: n0, z1: n1, el });
      };
      if (part) { add(0, CELL); continue; }
      for (let i = 0; i < wm.pn[e]; i++) {
        if (pr[i * 4 + 2] <= bot + 1e-4 && pr[i * 4 + 3] >= bot + BB_H - 1e-4) add(pr[i * 4], pr[i * 4 + 1]);
      }
    }
    // post quadrants at the 4 corners
    for (const [vi, vj] of [[ci, cj], [ci + 1, cj], [ci, cj + 1], [ci + 1, cj + 1]]) {
      const iv = wm.post(vi, vj);
      if (!iv) continue;
      let cov = false;
      for (let i = 0; i < iv.length; i += 2) if (iv[i] <= bot + 1e-4 && iv[i + 1] >= bot + BB_H - 1e-4) cov = true;
      if (!cov) continue;
      let el = false;
      for (const e of [eix(0, vi, vj - 1), eix(0, vi, vj), eix(1, vj, vi - 1), eix(1, vj, vi)]) {
        if (wm.ok[e] && wm.thick[e] && (g.eTrim[e] & EdgeTrim.BASEBOARD) && g.eKind[e] !== EdgeKind.PARTITION) el = true;
      }
      const X = vi * CELL, Z = vj * CELL;
      out.push({ x0: Math.max(X0, X - POST_H), x1: Math.min(X1, X + POST_H), z0: Math.max(Z0, Z - POST_H), z1: Math.min(Z1, Z + POST_H), el });
    }
    return out;
  }

  /** 0 air, 1 wall, 2 baseboard at a tile-local point inside cell (ci, cj). */
  classify(ci: number, cj: number, x: number, z: number): number {
    if (!this.g.inWin(ci, cj) || ci <= -M || cj <= -M || ci >= TILE_CELLS + M - 1 || cj >= TILE_CELLS + M - 1) return 0;
    const fps = this.footprints(ci, cj);
    let bb = false;
    for (const f of fps) {
      if (x > f.x0 && x < f.x1 && z > f.z0 && z < f.z1) return 1;
      if (f.el && x > f.x0 - BB_D && x < f.x1 + BB_D && z > f.z0 - BB_D && z < f.z1 + BB_D) bb = true;
    }
    return bb ? 2 : 0;
  }
}

function emitBaseboards(plan: Plan, wm: WallModel, idx: VFaceIndex): void {
  const g = wm.g;
  const bb = new Baseboards(wm);
  for (let cj = 0; cj < TILE_CELLS; cj++) {
    for (let ci = 0; ci < TILE_CELLS; ci++) {
      const k = cix(ci, cj);
      if (!bb.floorCell(k) || g.blockCm[k] > 0) continue;
      const fps = bb.footprints(ci, cj);
      const X0 = ci * CELL, Z0 = cj * CELL, X1 = X0 + CELL, Z1 = Z0 + CELL;
      // neighbours whose baseboards may end on our border
      const nbr: [number, number, number][] = [[ci - 1, cj, 0], [ci + 1, cj, 1], [ci, cj - 1, 2], [ci, cj + 1, 3]];
      const nbrHas = nbr.some(([ni, nj]) => bb.footprints(ni, nj).some((f) => f.el));
      if (!fps.some((f) => f.el) && !nbrHas) continue;
      const bot = g.bottom(k), top = g.top(k);
      const xs = [X0, X1], zs = [Z0, Z1];
      for (const f of fps) {
        xs.push(f.x0, f.x1); zs.push(f.z0, f.z1);
        if (f.el) { xs.push(f.x0 - BB_D, f.x1 + BB_D); zs.push(f.z0 - BB_D, f.z1 + BB_D); }
      }
      for (const [ni, nj] of nbr) {
        for (const f of bb.footprints(ni, nj)) {
          xs.push(f.x0, f.x1, f.x0 - BB_D, f.x1 + BB_D); zs.push(f.z0, f.z1, f.z0 - BB_D, f.z1 + BB_D);
        }
      }
      const X = uniq(xs.filter((v) => v >= X0 - EPS && v <= X1 + EPS));
      const Z = uniq(zs.filter((v) => v >= Z0 - EPS && v <= Z1 + EPS));
      const nx = X.length - 1, nz = Z.length - 1;
      const cls = new Uint8Array(nx * nz);
      for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) cls[j * nx + i] = bb.classify(ci, cj, (X[i] + X[i + 1]) / 2, (Z[j] + Z[j + 1]) / 2);
      const mat = g.trimMat[k];
      const st = state(mat, VFlag.NO_GRIME, trimTint(mat, 1, 1, 1));
      const yb = bot, yt = bot + BB_H;
      if (yt > top) continue;
      // tops (merged per row)
      for (let j = 0; j < nz; j++) {
        let i = 0;
        while (i < nx) {
          if (cls[j * nx + i] !== 2) { i++; continue; }
          let e = i;
          while (e < nx && cls[j * nx + e] === 2) e++;
          plan.borrow(hQuad(yt, 1, X[i], X[e], Z[j], Z[j + 1], st), plan.floorGrid);
          i = e;
        }
      }
      const front = (ax: 0 | 2, plane: number, sign: number, t0: number, t1: number, y0: number, y1: number): void => {
        const f = vQuad(ax, plane, sign, t0, t1, y0, y1, st);
        const behind = idx.find(k, ax === 0 ? sign : 0, ax === 2 ? sign : 0, plane - sign * BB_D, (t0 + t1) / 2, (y0 + y1) / 2);
        if (behind) plan.borrowFrom(f, behind);
        else {
          const lm = f.p.slice();
          for (let v = 0; v < lm.length; v += 3) lm[v + ax] += sign * 0.02;
          f.lm = lm;
          plan.borrow(f, plan.floorGrid);
        }
      };
      // fronts between baseboard and air inside the cell: x boundaries (faces normal to x), merged along z
      for (let i = 1; i < nx; i++) {
        let j = 0;
        while (j < nz) {
          const l = cls[j * nx + i - 1], r = cls[j * nx + i];
          const dir = l === 2 && r === 0 ? 1 : l === 0 && r === 2 ? -1 : 0;
          if (!dir) { j++; continue; }
          let e = j + 1;
          while (e < nz) {
            const l2 = cls[e * nx + i - 1], r2 = cls[e * nx + i];
            if ((l2 === 2 && r2 === 0 ? 1 : l2 === 0 && r2 === 2 ? -1 : 0) !== dir) break;
            e++;
          }
          front(0, X[i], dir, Z[j], Z[e], yb, yt);
          j = e;
        }
      }
      for (let j = 1; j < nz; j++) {
        let i = 0;
        while (i < nx) {
          const l = cls[(j - 1) * nx + i], r = cls[j * nx + i];
          const dir = l === 2 && r === 0 ? 1 : l === 0 && r === 2 ? -1 : 0;
          if (!dir) { i++; continue; }
          let e = i + 1;
          while (e < nx) {
            const l2 = cls[(j - 1) * nx + e], r2 = cls[j * nx + e];
            if ((l2 === 2 && r2 === 0 ? 1 : l2 === 0 && r2 === 2 ? -1 : 0) !== dir) break;
            e++;
          }
          front(2, Z[j], dir, X[i], X[e], yb, yt);
          i = e;
        }
      }
      // ends of a neighbour's baseboard on our border (faces into this cell): our side air, their side baseboard
      for (const [ni, nj, side] of nbr) {
        const kn = cix(ni, nj);
        if (!bb.floorCell(kn) || g.isSolid(kn)) continue;
        const nb0 = g.bottom(kn);
        if (nb0 < bot - EPS || nb0 + BB_H > top) continue;
        const ax: 0 | 2 = side < 2 ? 0 : 2;
        const plane = side === 0 ? X0 : side === 1 ? X1 : side === 2 ? Z0 : Z1;
        const sign = side === 0 || side === 2 ? 1 : -1;
        const T = ax === 0 ? Z : X, nT = T.length - 1;
        let s = 0;
        const ours = (m: number): number => (ax === 0 ? cls[m * nx + (side === 0 ? 0 : nx - 1)] : cls[(side === 2 ? 0 : nz - 1) * nx + m]);
        while (s < nT) {
          const tm = (T[s] + T[s + 1]) / 2;
          const theirs = ax === 0 ? bb.classify(ni, nj, plane - sign * 1e-4, tm) : bb.classify(ni, nj, tm, plane - sign * 1e-4);
          const same = Math.abs(nb0 - bot) < EPS;
          const want = theirs === 2 && (same ? ours(s) === 0 : ours(s) !== 1);
          if (!want) { s++; continue; }
          let e = s + 1;
          while (e < nT) {
            const tm2 = (T[e] + T[e + 1]) / 2;
            const th2 = ax === 0 ? bb.classify(ni, nj, plane - sign * 1e-4, tm2) : bb.classify(ni, nj, tm2, plane - sign * 1e-4);
            if (!(th2 === 2 && (same ? ours(e) === 0 : ours(e) !== 1))) break;
            e++;
          }
          if (same || nb0 + BB_H > bot) front(ax, plane, sign, T[s], T[e], Math.max(nb0, bot), nb0 + BB_H);
          s = e;
        }
      }
    }
  }
}

function uniq(v: number[]): number[] {
  v.sort((a, b) => a - b);
  const o: number[] = [];
  for (const x of v) if (!o.length || x - o[o.length - 1] > 1e-6) o.push(x);
  return o;
}

// ------------------------------------------------------------------------------------------------ casings

function emitCasings(plan: Plan, wm: WallModel): void {
  const g = wm.g;
  for (let a = 0; a < 2; a++) {
    for (let L = 0; L <= TILE_CELLS; L++) {
      for (let c = 0; c < TILE_CELLS; c++) {
        const e = eix(a, L, c);
        if (!wm.ok[e] || g.eKind[e] !== EdgeKind.DOORWAY || !(g.eTrim[e] & EdgeTrim.CASING)) continue;
        for (let s = 0; s < 2; s++) {
          const src = wm.sideFaces.get(e * 2 + s);
          if (!src || !src.length) continue;
          const [ai, aj, bi, bj] = edgeCells(a, L, c);
          const k = s ? cix(bi, bj) : cix(ai, aj);
          if (g.isTower(k)) continue; // tower shells carry no trims (3 m periodicity, TOWER_LAYERS only)
          const sign = s ? 1 : -1;
          const d = wm.half[e];
          const lc = L * CELL, tb = c * CELL;
          const bot = Math.max(g.bottom(k), wm.ySill[e]), top = g.top(k);
          const head = g.eHA[e] / 100;
          const hTop = Math.min(head + CAS_W, top);
          if (head >= top || hTop <= bot) continue;
          const st = state(g.trimMat[k], VFlag.NO_GRIME, trimTint(g.trimMat[k], 1, 1, 1));
          const ax: 0 | 2 = a === 0 ? 0 : 2, ax2: 0 | 2 = a === 0 ? 2 : 0;
          const pf = lc + sign * (d + CAS_D), pw = lc + sign * d;
          const b0 = Math.min(pw, pf), b1 = Math.max(pw, pf);
          const put = (f: Face): void => { plan.borrowFrom(f, src[0]); };
          const tL0 = JAMB - CAS_W, tL1 = JAMB, tR0 = CELL - JAMB, tR1 = CELL - JAMB + CAS_W;
          // fronts
          put(vQuad(ax, pf, sign, tb + tL0, tb + tL1, bot, hTop, st));
          put(vQuad(ax, pf, sign, tb + tR0, tb + tR1, bot, hTop, st));
          if (hTop > head) put(vQuad(ax, pf, sign, tb + tL1, tb + tR0, head, hTop, st));
          // outer sides
          put(vQuad(ax2, tb + tL0, -1, b0, b1, bot, hTop, st));
          put(vQuad(ax2, tb + tR1, 1, b0, b1, bot, hTop, st));
          // inner sides (below the head) and head underside
          put(vQuad(ax2, tb + tL1, 1, b0, b1, bot, head, st));
          put(vQuad(ax2, tb + tR0, -1, b0, b1, bot, head, st));
          const hq = (y: number, dir: number, t0: number, t1: number): Face => (a === 0 ? hQuad(y, dir, b0, b1, tb + t0, tb + t1, st) : hQuad(y, dir, tb + t0, tb + t1, b0, b1, st));
          put(hq(head, -1, tL1, tR0));
          if (hTop < top - EPS) put(hq(hTop, 1, tL0, tR1));
        }
      }
    }
  }
}

// ------------------------------------------------------------------------------------------------ thresholds

function emitThresholds(plan: Plan, wm: WallModel): void {
  const g = wm.g;
  for (let a = 0; a < 2; a++) {
    for (let L = 0; L <= TILE_CELLS; L++) {
      // runs along the line: [t0, t1] tile-local along coordinate, material
      const segs: [number, number, number, number][] = []; // t0, t1, mat, y
      for (let c = 0; c < TILE_CELLS; c++) {
        const e = eix(a, L, c);
        if (!wm.ok[e]) continue;
        const kind = g.eKind[e];
        if (kind !== EdgeKind.OPEN && kind !== EdgeKind.DOORWAY && kind !== EdgeKind.HEADER && kind !== EdgeKind.ARCH) continue;
        const [ai, aj, bi, bj] = edgeCells(a, L, c);
        const ka = cix(ai, aj), kb = cix(bi, bj);
        if (!g.hasFloor(ka) || !g.hasFloor(kb) || g.floorCm[ka] !== g.floorCm[kb] || g.blockCm[ka] > 0 || g.blockCm[kb] > 0) continue;
        if (g.group[ka] !== g.group[kb]) continue;
        if (g.floorMat[ka] === g.floorMat[kb] && !(g.eTrim[e] & EdgeTrim.THRESHOLD)) continue;
        if (kind === EdgeKind.HEADER && g.eHA[e] - g.floorCm[ka] < 100) continue;
        const [t0, t1] = kind === EdgeKind.DOORWAY ? [JAMB, CELL - JAMB] : kind === EdgeKind.ARCH ? [ARCH_JAMB, CELL - ARCH_JAMB] : [0, CELL];
        const tb = c * CELL;
        const mat = g.trimMat[ka];
        const y = g.floor(ka);
        const last = segs[segs.length - 1];
        if (last && Math.abs(last[1] - (tb + t0)) < EPS && last[2] === mat && last[3] === y) last[1] = tb + t1;
        else segs.push([tb + t0, tb + t1, mat, y]);
      }
      for (const [t0, t1, mat, y] of segs) emitThreshold(plan, wm, a, L, t0, t1, mat, y);
    }
  }
}

function emitThreshold(plan: Plan, wm: WallModel, a: number, L: number, t0: number, t1: number, mat: number, y: number): void {
  const g = wm.g;
  const lc = L * CELL;
  const st = state(mat, VFlag.NO_GRIME, trimTint(mat, 0.82, 0.8, 0.76));
  // strips along x stand 1 mm taller: where two strips meet at a corner their tops overlap (no coplanar z-fight)
  const yt = y + TH_H + (a === 1 ? 0.001 : 0);
  const ax: 0 | 2 = a === 0 ? 0 : 2, ax2: 0 | 2 = a === 0 ? 2 : 0;
  const nrmAxis = a === 0 ? 0 : 2;
  const ownerOk = (side: number, t: number): boolean => {
    const c = Math.floor(t / CELL + 1e-7);
    const [ai, aj, bi, bj] = edgeCells(a, L, c);
    const [oi, oj] = side ? [bi, bj] : [ai, aj];
    return g.inTile(oi, oj) && !g.isSolid(cix(oi, oj));
  };
  const put = (f: Face, sign: number): void => {
    const lm = f.p.slice();
    for (let v = 0; v < lm.length; v += 3) lm[v + nrmAxis] = lc + sign * 0.02;
    f.lm = lm;
    plan.borrow(f, plan.floorGrid);
  };
  // split at cell lines along the run so every piece has one owner
  const cuts: number[] = [t0];
  for (let c = Math.floor(t0 / CELL + 1e-7) + 1; c * CELL < t1 - EPS; c++) cuts.push(c * CELL);
  cuts.push(t1);
  for (let i = 0; i + 1 < cuts.length; i++) {
    const a0 = cuts[i], a1 = cuts[i + 1], tm = (a0 + a1) / 2;
    for (let side = 0; side < 2; side++) {
      if (!ownerOk(side, tm)) continue;
      const sign = side ? 1 : -1;
      const n0 = Math.min(lc, lc + sign * TH_W), n1 = Math.max(lc, lc + sign * TH_W);
      put(a === 0 ? hQuad(yt, 1, n0, n1, a0, a1, st) : hQuad(yt, 1, a0, a1, n0, n1, st), sign);
      put(vQuad(ax, lc + sign * TH_W, sign, a0, a1, y, yt, st), sign);
    }
  }
  // free ends (not at a jamb or a post)
  const endFree = (t: number): boolean => {
    const onVertex = Math.abs(t / CELL - Math.round(t / CELL)) < 1e-6;
    if (!onVertex) return false; // ends at a DOORWAY / ARCH jamb
    const v = Math.round(t / CELL);
    return !(a === 0 ? wm.post(L, v) : wm.post(v, L));
  };
  for (const [t, dir] of [[t0, -1], [t1, 1]] as [number, number][]) {
    if (!endFree(t) || t <= EPS || t >= TILE_SIZE - EPS) continue;
    for (let side = 0; side < 2; side++) {
      if (!ownerOk(side, t + dir * 0.01)) continue;
      const sign = side ? 1 : -1;
      const n0 = Math.min(lc, lc + sign * TH_W), n1 = Math.max(lc, lc + sign * TH_W);
      put(vQuad(ax2, t, dir, n0, n1, y, yt, st), sign);
    }
  }
}

// ------------------------------------------------------------------------------------------------ roll-up headers

function emitRollups(plan: Plan, wm: WallModel): void {
  const g = wm.g;
  for (let a = 0; a < 2; a++) {
    for (let L = 0; L <= TILE_CELLS; L++) {
      let c = 0;
      while (c < TILE_CELLS) {
        const e = eix(a, L, c);
        if (!wm.ok[e] || g.eKind[e] !== EdgeKind.HEADER || !(g.eTrim[e] & EdgeTrim.ROLLUP)) { c++; continue; }
        let c1 = c + 1;
        while (c1 < TILE_CELLS) {
          const e2 = eix(a, L, c1);
          if (!wm.ok[e2] || g.eKind[e2] !== EdgeKind.HEADER || !(g.eTrim[e2] & EdgeTrim.ROLLUP) || g.eHA[e2] !== g.eHA[e]) break;
          c1++;
        }
        emitRollup(plan, wm, a, L, c, c1);
        c = c1;
      }
    }
  }
}

function emitRollup(plan: Plan, wm: WallModel, a: number, L: number, c0: number, c1: number): void {
  const g = wm.g;
  const e0 = eix(a, L, c0);
  const hA = g.eHA[e0] / 100, yb = hA - ROLL_H, ys = yb - 0.05;
  const lc = L * CELL;
  const t0 = c0 * CELL + wm.tRange(a, L, c0)[0], t1 = (c1 - 1) * CELL + wm.tRange(a, L, c1 - 1)[1];
  const ax: 0 | 2 = a === 0 ? 0 : 2, ax2: 0 | 2 = a === 0 ? 2 : 0;
  const st = state(Mat.METAL_PAINTED, 0, tintRGB(0.62, 0.6, 0.55));
  const slat = state(Mat.METAL_PAINTED, 0, tintRGB(0.4, 0.4, 0.38));
  const d = wm.half[e0];
  for (let s = 0; s < 2; s++) {
    const sign = s ? 1 : -1;
    // per cell piece along the run (ownership)
    const sideKey = `4u${a}${kf(L, 4)}${s}|${q4(yb)}|s`, botKey = `3u${a}${kf(L, 4)}${s}|${q4(yb)}|b`, topKey = `4u${a}${kf(L, 4)}${s}|${q4(hA)}|t`;
    for (let c = c0; c < c1; c++) {
      const [ai, aj, bi, bj] = edgeCells(a, L, c);
      const oi = s ? bi : ai, oj = s ? bj : aj;
      if (!g.inTile(oi, oj)) continue;
      const k = cix(oi, oj);
      if (g.isSolid(k) || g.isTower(k)) continue;
      const grp = g.group[k];
      const bot = g.bottom(k), top = g.top(k);
      if (yb < bot || yb >= top) continue;
      const a0 = Math.max(t0, c * CELL), a1 = Math.min(t1, (c + 1) * CELL);
      if (a1 - a0 <= EPS) continue;
      const cont = (r0: number, r1: number): number => (r0 <= 1e-4 ? 1 : 0) | (r1 >= TILE_SIZE - 1e-4 ? 2 : 0);
      // side face
      const sp = lc + sign * ROLL_D;
      addVSplit(ax, sp, sign, a0, a1, yb, Math.min(hA, top), st, g.waterY(k), (f) => {
        plan.run(f, sideKey, a0, a1, (r0, r1) => { const x = vSpec(K_BOX, grp, Mat.METAL_PAINTED, sideKey, ax, sp, sign); x.cont = cont(r0, r1); return x; });
      });
      // bottom half band [line, line + sign*ROLL_D]
      const n0 = Math.min(lc, lc + sign * ROLL_D), n1 = Math.max(lc, lc + sign * ROLL_D);
      const bf = a === 0 ? hQuad(yb, -1, n0, n1, a0, a1, st) : hQuad(yb, -1, a0, a1, n0, n1, st);
      plan.run(bf, botKey, a0, a1, (r0, r1) => {
        const x = a === 0
          ? new ChartSpec(K_SOFFIT, grp, Mat.METAL_PAINTED, botKey, [0, -1, 0], [lc, yb, 0], [0, 0, 1], [sign, 0, 0])
          : new ChartSpec(K_SOFFIT, grp, Mat.METAL_PAINTED, botKey, [0, -1, 0], [0, yb, lc], [1, 0, 0], [0, 0, sign]);
        x.setFixedV(0, ROLL_D); x.cont = cont(r0, r1); return x;
      });
      // top band outside the wall face
      if (hA < top - EPS) {
        const m0 = Math.min(lc + sign * d, lc + sign * ROLL_D), m1 = Math.max(lc + sign * d, lc + sign * ROLL_D);
        const tf = a === 0 ? hQuad(hA, 1, m0, m1, a0, a1, st) : hQuad(hA, 1, a0, a1, m0, m1, st);
        plan.run(tf, topKey, a0, a1, (r0, r1) => {
          const x = a === 0
            ? new ChartSpec(K_BOX, grp, Mat.METAL_PAINTED, topKey, [0, 1, 0], [lc + sign * d, hA, 0], [0, 0, 1], [sign, 0, 0])
            : new ChartSpec(K_BOX, grp, Mat.METAL_PAINTED, topKey, [0, 1, 0], [0, hA, lc + sign * d], [1, 0, 0], [0, 0, sign]);
          x.setFixedV(0, ROLL_D - d); x.cont = cont(r0, r1); return x;
        });
      }
      // slatted door bottom strip (half), borrows the box bottom
      const m0 = Math.min(lc, lc + sign * 0.025), m1 = Math.max(lc, lc + sign * 0.025);
      plan.borrowFrom(vQuad(ax, lc + sign * 0.025, sign, a0, a1, ys, yb, slat), bf);
      plan.borrowFrom(a === 0 ? hQuad(ys, -1, m0, m1, a0, a1, slat) : hQuad(ys, -1, a0, a1, m0, m1, slat), bf);
      // run ends
      for (const [t, dir] of [[t0, -1], [t1, 1]] as [number, number][]) {
        if (Math.abs(t - (dir < 0 ? a0 : a1)) > EPS || t <= EPS || t >= TILE_SIZE - EPS) continue;
        const endKey = `4v${a}${kf(L, 4)}${kf(c, 4)}${s}${dir}`;
        const spec = plan.addSpec(new ChartSpec(K_BOX, grp, Mat.METAL_PAINTED, endKey, a === 0 ? [0, 0, dir] : [dir, 0, 0],
          a === 0 ? [lc, 0, t] : [t, 0, lc], a === 0 ? [sign, 0, 0] : [0, 0, sign], [0, 1, 0]));
        plan.own(vQuad(ax2, t, dir, n0, n1, yb, Math.min(hA, top), st), spec);
        plan.borrowFrom(vQuad(ax2, t, dir, m0, m1, ys, yb, slat), bf);
      }
    }
  }
}

// ------------------------------------------------------------------------------------------------ entry

export function emitTrims(plan: Plan, wm: WallModel, idx: VFaceIndex): void {
  emitBaseboards(plan, wm, idx);
  emitCasings(plan, wm);
  emitThresholds(plan, wm);
  emitRollups(plan, wm);
}
