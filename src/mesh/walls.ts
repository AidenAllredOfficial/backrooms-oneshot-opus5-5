// src/mesh/walls.ts — WP5 walls (§5 WP5 rules 1, 1b, 2, 3, 11): edge pieces from core edgePieces, faces on the
// two sides of every rendered edge, SOLID/step/blocker/pit/soffit faces on the edge line, caps, undersides and
// reveals, ARCH intrados + spandrels, partition plinths and WALL_T^2 posts. Pure module.
//
// Ownership: a face belongs to the cell it faces (centre + 1 cm * normal); faces spanning the wall thickness
// (caps, reveals, intrados, post faces) are split at the edge line / vertex lines so each half has one owner.

import { ARCH_JAMB, CELL, PARTITION_BASE_CM, PARTITION_BASE_T, TILE_CELLS, TILE_SIZE, WALL_T } from '../core/constants.ts';
import { EDGE_RENDERS, edgePieces, edgeThickness } from '../core/edges.ts';
import { CeilKind, CellFlag, EdgeKind, Mat, VFlag } from '../core/ids.ts';
import type { ChartKindId } from '../core/mesh.ts';
import { mergeIntervals, subtractRects, unionBoundary } from './geom.ts';
import { ChartSpec, hQuad, mkFace, state, vQuad, type Face, type FaceState, type Plan, type V3 } from './plan.ts';
import { GW, M, NE, PIT_BOTTOM, cix, edgeCells, eix, type TileGrid } from './tileGrid.ts';
import { h01, kf, q4, vUv, wallTint } from './uv.ts';

export const POST_H = WALL_T / 2;
export const LT_COVER = 1;
export const LT_STEP = 2;
export const LT_PIT = 3;
export const LT_BLOCK = 4;
export const LT_SOFFIT = 5;
const EPS = 1e-5;
const PLINTH_H = PARTITION_BASE_CM / 100;
const PLINTH_D = PARTITION_BASE_T / 2;
const K_WALL = 2 as ChartKindId, K_STEP = 3 as ChartKindId, K_SOFFIT = 4 as ChartKindId, K_BOX = 5 as ChartKindId;

export interface LineRect { type: number; t0: number; t1: number; y0: number; y1: number }

export const vix = (vi: number, vj: number): number => (vj + M) * (GW + 1) + (vi + M);
const NV = (GW + 1) * (GW + 1);

/** Per-edge wall data over the tile window + post decisions. Shared by walls, trims and tests. */
export class WallModel {
  readonly g: TileGrid;
  readonly ok = new Uint8Array(2 * NE); // edge computed (both cells in the window)
  readonly pn = new Uint8Array(2 * NE);
  readonly pr = new Float64Array(2 * NE * 16);
  readonly half = new Float64Array(2 * NE);
  readonly yLo = new Float64Array(2 * NE);
  readonly ySill = new Float64Array(2 * NE);
  readonly yHi = new Float64Array(2 * NE);
  readonly thick = new Uint8Array(2 * NE); // has rendered pieces with a non-SOLID side
  readonly lines: (LineRect[] | null)[] = new Array<LineRect[] | null>(4 * NE).fill(null); // e*2+side
  readonly posts: (number[] | null)[] = new Array<number[] | null>(NV).fill(null); // merged y intervals
  /** Piece faces emitted per edge side (e*2+side), for trims that borrow the wall chart. */
  readonly sideFaces = new Map<number, Face[]>();

  constructor(g: TileGrid) {
    this.g = g;
    const tmp = new Float32Array(16);
    for (let a = 0; a < 2; a++) {
      for (let c = -M; c < TILE_CELLS + M; c++) {
        for (let L = -M + 1; L < TILE_CELLS + M; L++) {
          const e = eix(a, L, c);
          const [ai, aj, bi, bj] = edgeCells(a, L, c);
          if (!g.inWin(ai, aj) || !g.inWin(bi, bj)) continue;
          const ka = cix(ai, aj), kb = cix(bi, bj);
          this.ok[e] = 1;
          const sa = g.isSolid(ka), sb = g.isSolid(kb);
          const na = !(sa || g.isVoid(ka)), nbb = !(sb || g.isVoid(kb));
          const fA = na ? g.floor(ka) : nbb ? g.floor(kb) : g.floor(ka);
          const fB = nbb ? g.floor(kb) : na ? g.floor(ka) : g.floor(kb);
          const cA = !sa ? g.ceil(ka) : !sb ? g.ceil(kb) : g.ceil(ka);
          const cB = !sb ? g.ceil(kb) : !sa ? g.ceil(ka) : g.ceil(kb);
          const yLo = Math.min(fA, fB), ySill = Math.max(fA, fB), yHi = Math.max(cA, cB);
          this.yLo[e] = yLo; this.ySill[e] = ySill; this.yHi[e] = yHi;
          const kind = g.eKind[e];
          if (EDGE_RENDERS[kind] && !(sa && sb)) {
            const n = edgePieces(kind, g.eHA[e], g.eHB[e], yLo, ySill, yHi, tmp);
            this.pn[e] = n;
            for (let i = 0; i < n * 4; i++) this.pr[e * 16 + i] = tmp[i];
            this.half[e] = edgeThickness(kind) / 2;
            this.thick[e] = n > 0 ? 1 : 0;
          }
          if (!sa) this.lines[e * 2] = this.lineRects(e, ka, kb);
          if (!sb) this.lines[e * 2 + 1] = this.lineRects(e, kb, ka);
        }
      }
    }
    for (let vj = -M + 1; vj < TILE_CELLS + M; vj++) {
      for (let vi = -M + 1; vi < TILE_CELLS + M; vi++) this.posts[vix(vi, vj)] = this.postAt(vi, vj);
    }
  }

  /** Piece rects of an edge as a flat view (t0,t1,y0,y1 quadruples). */
  pieces(e: number): Float64Array { return this.pr.subarray(e * 16, e * 16 + this.pn[e] * 4); }

  private lineRects(e: number, kO: number, kX: number): LineRect[] | null {
    const g = this.g;
    const out: LineRect[] = [];
    const pr = this.pieces(e), n = this.pn[e];
    const bot = g.bottom(kO), top = g.top(kO);
    const add = (type: number, y0: number, y1: number): void => {
      if (y1 - y0 <= EPS) return;
      const r = subtractRects(0, CELL, y0, y1, pr, n);
      for (let i = 0; i < r.length; i += 4) out.push({ type, t0: r[i], t1: r[i + 1], y0: r[i + 2], y1: r[i + 3] });
    };
    const voidO = g.isVoid(kO), voidX = g.isVoid(kX);
    if (g.isSolid(kX)) {
      add(LT_COVER, bot, top);
    } else {
      if (voidO && !voidX) {
        add(LT_PIT, PIT_BOTTOM, g.floor(kX));
        // a blocker right at the pit rim: its side facing the pit (owned by the VOID cell, like the pit wall below)
        if (g.blockCm[kX] > 0 && !g.isTower(kX)) add(LT_BLOCK, g.floor(kX), g.floor(kX) + g.blockCm[kX] / 100);
      } else if (!voidO && !voidX && !g.isTower(kX)) {
        const fx = g.floor(kX);
        if (fx > bot + EPS) add(LT_STEP, bot, fx);
        if (g.blockCm[kX] > 0) add(LT_BLOCK, Math.max(bot, fx), fx + g.blockCm[kX] / 100);
      }
      const cx = g.ceil(kX);
      if (top > cx + EPS && !g.isTower(kX)) add(LT_SOFFIT, Math.max(cx, bot), top);
    }
    return out.length ? out : null;
  }

  /** Profile of an edge end (0 = start t=0, 1 = end t=CELL): thick piece and line-rect intervals touching it. */
  profile(e: number, end: number): number[] {
    const items: number[] = [];
    if (!this.ok[e]) return items;
    const touch = (t0: number, t1: number): boolean => (end === 0 ? t0 <= EPS : t1 >= CELL - EPS);
    if (this.thick[e]) {
      const pr = this.pieces(e);
      for (let i = 0; i < this.pn[e]; i++) {
        if (touch(pr[i * 4], pr[i * 4 + 1])) items.push(0, pr[i * 4 + 2], pr[i * 4 + 3], this.half[e]);
      }
      if (this.g.eKind[e] === EdgeKind.PARTITION) items.push(0, this.yLo[e], this.ySill[e] + PLINTH_H, PLINTH_D);
    }
    for (let s = 0; s < 2; s++) {
      const lr = this.lines[e * 2 + s];
      if (!lr) continue;
      for (const r of lr) if (touch(r.t0, r.t1)) items.push(1 + s, r.y0, r.y1, 0);
    }
    // sort quadruples for comparison
    const q: number[][] = [];
    for (let i = 0; i < items.length; i += 4) q.push(items.slice(i, i + 4));
    q.sort((x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2] || x[3] - y[3]);
    return q.flat();
  }

  private postAt(vi: number, vj: number): number[] | null {
    // incident edges: [edge, end] for x-line (north: ends here, south: starts here), z-line (west ends, east starts)
    const inc: [number, number][] = [[eix(0, vi, vj - 1), 1], [eix(0, vi, vj), 0], [eix(1, vj, vi - 1), 1], [eix(1, vj, vi), 0]];
    let nThick = 0;
    for (const [e] of inc) if (this.ok[e] && this.thick[e]) nThick++;
    if (nThick === 0) return null;
    const prof = inc.map(([e, end]) => this.profile(e, end));
    const same = (p: number[], q: number[]): boolean => p.length === q.length && p.every((v, i) => Math.abs(v - q[i]) < 1e-5);
    if (nThick === 2) {
      for (const [x, y] of [[0, 1], [2, 3]]) {
        if (this.thick[inc[x][0]] && this.thick[inc[y][0]] && this.ok[inc[x][0]] && this.ok[inc[y][0]] && same(prof[x], prof[y])) return null;
      }
    }
    const iv: number[] = [];
    for (const p of prof) for (let i = 0; i < p.length; i += 4) iv.push(p[i + 1], p[i + 2]);
    const m = mergeIntervals(iv);
    return m.length ? m : null;
  }

  post(vi: number, vj: number): number[] | null {
    if (vi < -M + 1 || vj < -M + 1 || vi >= TILE_CELLS + M || vj >= TILE_CELLS + M) return null;
    return this.posts[vix(vi, vj)];
  }
  /** Start / end vertex of an edge. */
  static v0(a: number, L: number, c: number): [number, number] { return a === 0 ? [L, c] : [c, L]; }
  static v1(a: number, L: number, c: number): [number, number] { return a === 0 ? [L, c + 1] : [c + 1, L]; }
  /** t range of an edge not covered by posts. */
  tRange(a: number, L: number, c: number): [number, number] {
    const [s0, s1] = WallModel.v0(a, L, c), [e0, e1] = WallModel.v1(a, L, c);
    return [this.post(s0, s1) ? POST_H : 0, this.post(e0, e1) ? CELL - POST_H : CELL];
  }
}

// ------------------------------------------------------------------------------------------------ helpers

export const waterByte = (waterCm: number): number => Math.max(0, Math.min(255, Math.round((waterCm + 320) / 5)));
/** Face state with UNDERWATER flag + aux.w set. */
export function underwater(st: FaceState, wCm: number): FaceState {
  return { ...st, flags: st.flags | VFlag.UNDERWATER, aux: ((st.aux & 0x00ffffff) | (waterByte(wCm) << 24)) >>> 0 };
}

/** Ceiling tiles of a TILES ceiling rest TILE_Y (10 mm) above the grid face (ceilings.ts, rule 5), so vertical faces
 * reaching the owner's ceiling are extended up to the tile back (no slot between the wall top and the tiles).
 * Returns the extension (m) for owner cell k. Tower cells (span to +-6 m) never extend. */
export function ceilExt(g: TileGrid, k: number): number {
  if (g.flags[k] & (CellFlag.SOLID | CellFlag.TOWER | CellFlag.NO_CEIL)) return 0;
  return g.ceilKind[k] === CeilKind.TILES ? CEIL_EXT : 0;
}
const CEIL_EXT = 0.01;
/** Top of a vertical face owned by k whose natural top is y1 (clipped to the owner ceiling `top`), extended to the
 * tile back when it reaches that ceiling. */
export const extTop = (g: TileGrid, k: number, y1: number, top: number): number =>
  y1 >= top - EPS ? top + ceilExt(g, k) : y1;
/** Lightmap sample positions of a face extended above `top`: the extension samples the chart row at `top` (the
 * chart rect itself stays [.., top]; plan.finalize measures extents from these positions). */
export function clampLmTop(f: Face, top: number): void {
  const p = f.p;
  let over = false;
  for (let i = 1; i < p.length; i += 3) if (p[i] > top + 1e-7) over = true;
  if (!over) return;
  const lm = p.slice();
  for (let i = 1; i < lm.length; i += 3) if (lm[i] > top) lm[i] = top;
  f.lm = lm;
}

/** Vertical quad(s) split at the owner's water line; each piece passed to reg. */
export function addVSplit(ax: 0 | 2, plane: number, sign: number, t0: number, t1: number, y0: number, y1: number,
  st: FaceState, wy: number, reg: (f: Face) => void, du = 0, dv = 0): void {
  if (t1 - t0 <= EPS || y1 - y0 <= EPS) return;
  if (!(wy > y0 + EPS)) { reg(vQuad(ax, plane, sign, t0, t1, y0, y1, st, du, dv)); return; }
  const wCm = Math.round(wy * 100);
  if (wy >= y1 - EPS) { reg(vQuad(ax, plane, sign, t0, t1, y0, y1, underwater(st, wCm), du, dv)); return; }
  reg(vQuad(ax, plane, sign, t0, t1, y0, wy, underwater(st, wCm), du, dv));
  reg(vQuad(ax, plane, sign, t0, t1, wy, y1, st, du, dv));
}

/** Axis-aligned vertical chart frame for plane ax at `plane` facing sign; u along the other horizontal axis. */
export function vSpec(kind: ChartKindId, group: number, layer: number, key: string, ax: 0 | 2, plane: number, sign: number): ChartSpec {
  const nrm: V3 = ax === 0 ? [sign, 0, 0] : [0, 0, sign];
  const o: V3 = ax === 0 ? [plane, 0, 0] : [0, 0, plane];
  const eu: V3 = ax === 0 ? [0, 0, 1] : [1, 0, 0];
  return new ChartSpec(kind, group, layer, key, nrm, o, eu, [0, 1, 0]);
}
/** Horizontal chart frame at height y facing sign, u = x, v = z. */
export function hSpec(kind: ChartKindId, group: number, layer: number, key: string, y: number, sign: number): ChartSpec {
  return new ChartSpec(kind, group, layer, key, [0, sign, 0], [0, y, 0], [1, 0, 0], [0, 0, 1]);
}
const contOf = (t0: number, t1: number): number => (t0 <= 1e-4 ? 1 : 0) | (t1 >= TILE_SIZE - 1e-4 ? 2 : 0);

/** Global cell coordinates of the tile's first cell (for world-anchored hashes). */
function gOrigin(g: TileGrid): [number, number] { return [g.tile.cx * 32 + g.li0, g.tile.cz * 32 + g.lj0]; }

// ------------------------------------------------------------------------------------------------ run shading

/** Approximate, tile-independent "does the run continue from edge c-1 into edge c on side s" (for rule 11 shade). */
function continues(g: TileGrid, a: number, L: number, c: number, s: number): boolean {
  const e0 = g.edgeLoc(a, L, c - 1), e1 = g.edgeLoc(a, L, c);
  if (!e0 || !e1) return false;
  const k0 = e0[0].kind[e0[1]], k1 = e1[0].kind[e1[1]];
  if (!EDGE_RENDERS[k0] || !EDGE_RENDERS[k1] || edgeThickness(k0) !== edgeThickness(k1)) return false;
  const m0 = s ? e0[0].matPos[e0[1]] : e0[0].matNeg[e0[1]], m1 = s ? e1[0].matPos[e1[1]] : e1[0].matNeg[e1[1]];
  if (m0 !== m1) return false;
  const oi0 = a === 0 ? L - 1 + s : c - 1, oj0 = a === 0 ? c - 1 : L - 1 + s;
  const oi1 = a === 0 ? L - 1 + s : c, oj1 = a === 0 ? c : L - 1 + s;
  const c0 = g.cellLoc(oi0, oj0), c1 = g.cellLoc(oi1, oj1);
  if (!c0 || !c1) return false;
  if ((c0[0].flags[c0[1]] | c1[0].flags[c1[1]]) & CellFlag.SOLID) return false;
  if (c0[0].floorCm[c0[1]] !== c1[0].floorCm[c1[1]] || c0[0].ceilCm[c0[1]] !== c1[0].ceilCm[c1[1]]) return false;
  for (let side = 0; side < 2; side++) {
    const p = g.edgeLoc(1 - a, c, L - 1 + side);
    if (!p || EDGE_RENDERS[p[0].kind[p[1]]]) return false;
  }
  return true;
}

/** Anchor (tile-relative cell along the line where the run starts) for every c in [0, 16) on (a, L, s). */
function runAnchors(g: TileGrid, a: number, L: number, s: number): Int32Array {
  const out = new Int32Array(TILE_CELLS);
  let k = 0;
  while (k > -48 && continues(g, a, L, k, s)) k--;
  let anchor = k;
  for (let c = 0; c < TILE_CELLS; c++) {
    if (c > 0 && !continues(g, a, L, c, s)) anchor = c;
    out[c] = anchor;
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ emission

export function emitWalls(plan: Plan, wm: WallModel): void {
  const g = wm.g;
  const [gi0, gj0] = gOrigin(g);
  const storey = g.tile.s;
  const t = plan.t;
  for (let a = 0; a < 2; a++) {
    for (let L = 0; L <= TILE_CELLS; L++) {
      for (let s = 0; s < 2; s++) {
        if ((L === 0 && s === 0) || (L === TILE_CELLS && s === 1)) continue;
        const anchors = runAnchors(g, a, L, s);
        const gLine = (a === 0 ? gi0 : gj0) + L;
        for (let c = 0; c < TILE_CELLS; c++) {
          // structure shells (towers / elevators) are storey-free: the same shade in every storey (pixel-identical
          // tower switch), so the storey only salts the hash of storey (group 0) runs
          const gAlong = (a === 0 ? gj0 : gi0) + anchors[c];
          const shade = (h01(gLine, gAlong, a * 2 + s + storey * 4) - 0.5) * 0.04;
          const shadeS = (h01(gLine, gAlong, a * 2 + s) - 0.5) * 0.04;
          emitSide(plan, wm, a, L, c, s, shade, shadeS, t);
        }
      }
    }
  }
  emitPosts(plan, wm);
}

function emitSide(plan: Plan, wm: WallModel, a: number, L: number, c: number, s: number, shade: number, shadeS: number, t: number): void {
  const g = wm.g;
  const e = eix(a, L, c);
  if (!wm.ok[e]) return;
  const [ai, aj, bi, bj] = edgeCells(a, L, c);
  const kO = s ? cix(bi, bj) : cix(ai, aj);
  const kX = s ? cix(ai, aj) : cix(bi, bj);
  const oi = s ? bi : ai, oj = s ? bj : aj;
  if (!g.inTile(oi, oj) || g.isSolid(kO)) return;
  const sign = s ? 1 : -1;
  const ax: 0 | 2 = a === 0 ? 0 : 2;
  const lc = L * CELL, tb = c * CELL;
  const group = g.group[kO];
  const bot = g.bottom(kO), top = g.top(kO);
  const wy = g.waterY(kO);
  const kind = g.eKind[e];
  const sideMat = s ? g.eMatPos[e] : g.eMatNeg[e];
  const [tS, tE] = wm.tRange(a, L, c);
  const seedA = Math.floor(h01(L, c, a * 2 + s) * 255);
  const tint = group === 0 ? wallTint(shade, g.warmth[kO], seedA) : wallTint(shadeS, 128, seedA);
  // GLITCH: hashed 2-6 cm material-uv misregistration
  let du = 0, dv = 0;
  if (kind === EdgeKind.GLITCH) {
    const [gi0, gj0] = gOrigin(g);
    const hh = h01(gi0 + (a === 0 ? L : c), gj0 + (a === 0 ? c : L), 911 + a);
    du = (0.02 + 0.04 * hh) * (hh < 0.5 ? -1 : 1);
    dv = (0.02 + 0.04 * h01(gj0 + L, gi0 + c, 913 + a)) * (hh * 7 % 1 < 0.5 ? -1 : 1);
  }
  const faces: Face[] = [];
  const d = wm.half[e];
  const pr = wm.pieces(e), pn = wm.pn[e];
  const isPart = kind === EdgeKind.PARTITION;
  const plinthTop = wm.ySill[e] + PLINTH_H;

  // ---- 2. piece faces (the wall run, rule 3 chart)
  if (wm.thick[e]) {
    const plane = lc + sign * d;
    const runKey = `1${a}${kf(L, 4)}${s}|${q4(d)}|${q4(bot)}|${q4(top)}|${group}|${sideMat}`;
    const make = (r0: number, r1: number): ChartSpec => {
      const sp = vSpec(K_WALL, group, sideMat, runKey, ax, plane, sign).setFixedV(bot, top);
      sp.cont = contOf(r0, r1);
      return sp;
    };
    const st = state(sideMat, 0, tint);
    for (let i = 0; i < pn; i++) {
      const t0 = Math.max(pr[i * 4], tS), t1 = Math.min(pr[i * 4 + 1], tE);
      let y0 = Math.max(pr[i * 4 + 2], bot);
      const y1 = extTop(g, kO, Math.min(pr[i * 4 + 3], top), top);
      if (isPart) y0 = Math.max(y0, plinthTop);
      addVSplit(ax, plane, sign, tb + t0, tb + t1, y0, y1, st, wy, (f) => {
        clampLmTop(f, top);
        const [f0, f1] = tSpan(f, ax);
        plan.run(f, runKey, f0, f1, make);
        faces.push(f);
      }, du, dv);
    }
    // ARCH spandrels (coplanar with the run) + intrados
    if (kind === EdgeKind.ARCH) emitArch(plan, wm, e, a, L, c, s, kO, runKey, make, st, faces, t);
    // caps / undersides / reveals (half band on this side)
    emitCaps(plan, wm, e, a, L, c, s, kO, sideMat, tint, tS, tE);
    // partition plinth (sides + top band), borrowing the panel face above
    if (isPart) emitPlinth(plan, wm, e, a, L, c, s, kO, tS, tE, faces);
  }
  if (faces.length) wm.sideFaces.set(e * 2 + s, faces);

  // ---- 1b / 4 / 5: faces on the edge line (SOLID cover, steps, pits, blocker sides, soffits)
  const lr = wm.lines[e * 2 + s];
  if (lr) {
    for (const r of lr) {
      const t0 = Math.max(r.t0, tS), t1 = Math.min(r.t1, tE);
      if (t1 - t0 <= EPS) continue;
      let y0 = r.y0, y1 = r.y1;
      let mat: number, kindC: ChartKindId, cat: string, lTint = 0xffffff, off = 0;
      switch (r.type) {
        case LT_COVER:
          mat = kind === EdgeKind.OPEN ? g.wallMat[kO] : sideMat; kindC = K_WALL; cat = '1'; lTint = tint;
          // below the base of a rendered wall (a pit / shaft owner reaching lower than the wall's yLo): flush with the
          // wall face above (as LT_PIT), else the strip between the edge line and the face plane stays open
          if (wm.thick[e] && y1 <= wm.yLo[e] + EPS) off = isPart ? PLINTH_D : d;
          y1 = extTop(g, kO, y1, top);
          break;
        case LT_PIT:
          mat = Mat.CONCRETE_WALL; kindC = K_STEP; cat = '2'; lTint = 0x707070;
          off = EDGE_RENDERS[kind] ? (isPart ? PLINTH_D : d) : 0; break;
        case LT_STEP: mat = g.floorMat[kX]; kindC = K_STEP; cat = '2'; break;
        case LT_BLOCK: mat = g.floorMat[kX]; kindC = K_BOX; cat = '4b'; break;
        default: {
          mat = g.wallMat[kO]; kindC = K_SOFFIT; cat = '3'; lTint = tint;
          if (Math.abs(y0 - g.ceil(kX)) < EPS && g.ceilKind[kX] === CeilKind.TILES && !(g.flags[kX] & CellFlag.NO_CEIL)) y0 -= 0.003;
          if (Math.abs(y1 - top) < EPS && g.ceilKind[kO] === CeilKind.TILES && !(g.flags[kO] & CellFlag.NO_CEIL)) y1 += 0.01;
        }
      }
      const plane = lc + sign * off;
      const fixed0 = cat === '1' ? bot : y0, fixed1 = cat === '1' ? top : y1;
      const key = `${cat}${a}${kf(L, 4)}${s}|L${r.type}|${q4(off)}|${q4(fixed0)}|${q4(fixed1)}|${group}|${mat}`;
      const make = (r0: number, r1: number): ChartSpec => {
        const sp = vSpec(kindC, group, mat, key, ax, plane, sign).setFixedV(fixed0, fixed1);
        sp.cont = contOf(r0, r1);
        return sp;
      };
      addVSplit(ax, plane, sign, tb + t0, tb + t1, y0, y1, state(mat, 0, lTint), wy, (f) => {
        if (r.type === LT_COVER) clampLmTop(f, top);
        const [f0, f1] = tSpan(f, ax);
        plan.run(f, key, f0, f1, make);
      });
      // pit rim inside an opening (DOORWAY / ARCH / HEADER hole over a VOID cell): the pit face sits at the wall
      // face plane, so close the strip between the edge line (where the walkable floor ends) and that plane
      if (r.type === LT_PIT && off > 0 && !isPart) emitPitLip(plan, wm, e, a, L, c, s, t0, t1, r.y1);
    }
  }
}

/** Horizontal lip at the pit rim yr over the t-intervals of [t0, t1] where the edge has no piece just above the rim,
 * spanning the half band from the edge line to the wall face plane on the pit side (owner: the VOID cell). The
 * lightmap uv is borrowed from the floor grid just across the line (the walkable cell's valid texels). */
function emitPitLip(plan: Plan, wm: WallModel, e: number, a: number, L: number, c: number, s: number, t0: number, t1: number, yr: number): void {
  const pr = wm.pieces(e), pn = wm.pn[e];
  const cov: number[] = [];
  for (let i = 0; i < pn; i++) if (pr[i * 4 + 2] <= yr + 1e-4 && pr[i * 4 + 3] > yr + 1e-3) cov.push(pr[i * 4], pr[i * 4 + 1]);
  const m = mergeIntervals(cov);
  const free: number[] = [];
  let cur = t0;
  for (let i = 0; i < m.length; i += 2) {
    if (m[i] > cur + EPS) free.push(cur, Math.min(m[i], t1));
    cur = Math.max(cur, m[i + 1]);
    if (cur >= t1) break;
  }
  if (cur < t1 - EPS) free.push(cur, t1);
  if (!free.length) return;
  const sign = s ? 1 : -1;
  const lc = L * CELL, tb = c * CELL, d = wm.half[e];
  const n0 = Math.min(lc, lc + sign * d), n1 = Math.max(lc, lc + sign * d);
  const g = wm.g;
  const [ai, aj, bi, bj] = edgeCells(a, L, c);
  const kW = s ? cix(ai, aj) : cix(bi, bj); // the walkable cell across the line
  const st = state(g.floorMat[kW], VFlag.NO_GRIME);
  for (let i = 0; i < free.length; i += 2) {
    const f0 = tb + free[i], f1 = tb + free[i + 1];
    if (f1 - f0 <= EPS) continue;
    const f = a === 0 ? hQuad(yr, 1, n0, n1, f0, f1, st) : hQuad(yr, 1, f0, f1, n0, n1, st);
    const lm = f.p.slice();
    for (let v = 0; v < lm.length; v += 3) lm[v + (a === 0 ? 0 : 2)] = lc - sign * 0.02;
    f.lm = lm;
    plan.borrow(f, plan.floorGrid);
  }
}

/** t-extent (along-run coordinate: z for ax 0, x for ax 2) of a face. */
function tSpan(f: Face, ax: 0 | 2): [number, number] {
  const o = ax === 0 ? 2 : 0;
  let lo = Infinity, hi = -Infinity;
  for (let i = o; i < f.p.length; i += 3) { lo = Math.min(lo, f.p[i]); hi = Math.max(hi, f.p[i]); }
  return [lo, hi];
}

/** Caps (piece tops / undersides) and reveals on the half band of side s. */
function emitCaps(plan: Plan, wm: WallModel, e: number, a: number, L: number, c: number, s: number, kO: number,
  mat: number, tint: number, tS: number, tE: number): void {
  const g = wm.g;
  const kind = g.eKind[e];
  const d = wm.half[e];
  if (d <= 0) return;
  const sign = s ? 1 : -1;
  const lc = L * CELL, tb = c * CELL;
  const group = g.group[kO];
  const bot = g.bottom(kO), top = g.top(kO);
  const wy = g.waterY(kO);
  const b = unionBoundary(wm.pieces(e), wm.pn[e], 0, CELL, wm.yLo[e], wm.yHi[e]);
  const x0 = Math.min(lc, lc + sign * d), x1 = Math.max(lc, lc + sign * d);
  const spring = g.eHA[e] / 100 - (CELL / 2 - ARCH_JAMB);
  // the curved intrados replaces the crown underside and the upper jamb reveals only where emitArch emits it
  const isArch = kind === EdgeKind.ARCH && archShown(g.eHA[e] / 100, bot, top);
  // horizontal caps
  for (let i = 0; i < b.h.length; i += 4) {
    const y = b.h[i], dir = b.h[i + 3];
    let t0 = b.h[i + 1], t1 = b.h[i + 2];
    if (isArch && dir < 0 && t0 >= ARCH_JAMB - EPS && t1 <= CELL - ARCH_JAMB + EPS) continue; // replaced by the intrados
    t0 = Math.max(t0, tS); t1 = Math.min(t1, tE);
    if (t1 - t0 <= EPS || y <= bot + EPS || y >= top - EPS) continue;
    const kindC = dir > 0 ? K_BOX : K_SOFFIT;
    const key = `4c${a}${kf(L, 4)}${s}|${dir}|${q4(y)}|${q4(d)}|${group}|${mat}`;
    const make = (r0: number, r1: number): ChartSpec => {
      const sp = a === 0
        ? new ChartSpec(kindC, group, mat, key, [0, dir, 0], [lc, y, 0], [0, 0, 1], [sign, 0, 0])
        : new ChartSpec(kindC, group, mat, key, [0, dir, 0], [0, y, lc], [1, 0, 0], [0, 0, sign]);
      sp.setFixedV(0, d);
      sp.cont = contOf(r0, r1);
      return sp;
    };
    let st = state(mat, 0, tint);
    if (wy > y + EPS) st = underwater(st, Math.round(wy * 100));
    const f = a === 0 ? hQuad(y, dir, x0, x1, tb + t0, tb + t1, st) : hQuad(y, dir, tb + t0, tb + t1, x0, x1, st);
    plan.run(f, key, tb + t0, tb + t1, make);
  }
  // reveals
  for (let i = 0; i < b.v.length; i += 4) {
    const tv = b.v[i], dir = b.v[i + 3];
    let y0 = b.v[i + 1], y1 = b.v[i + 2];
    if (tv < tS - EPS || tv > tE + EPS) continue;
    if (isArch && (Math.abs(tv - ARCH_JAMB) < EPS || Math.abs(tv - (CELL - ARCH_JAMB)) < EPS)) y1 = Math.min(y1, spring);
    y0 = Math.max(y0, bot); y1 = Math.min(y1, top);
    if (y1 - y0 <= EPS) continue;
    const yTop = y1;
    y1 = extTop(g, kO, y1, top);
    const key = `4r${a}${kf(L, 4)}${kf(c, 4)}${s}|${q4(tv)}|${q4(y0)}|${dir}`;
    const plane = tb + tv;
    const ax2: 0 | 2 = a === 0 ? 2 : 0; // reveal plane is perpendicular to the wall
    const sp = plan.addSpec(new ChartSpec(K_BOX, group, mat, key,
      a === 0 ? [0, 0, dir] : [dir, 0, 0],
      a === 0 ? [lc, 0, plane] : [plane, 0, lc],
      a === 0 ? [sign, 0, 0] : [0, 0, sign], [0, 1, 0]).setFixedV(y0, yTop));
    addVSplit(ax2, plane, dir, x0, x1, y0, y1, state(mat, 0, tint), wy, (f) => { clampLmTop(f, yTop); plan.own(f, sp); });
  }
}

/** The ARCH curve (spandrels + intrados) is emitted on a side whose owner span [bot, top] contains [spring, crown];
 * otherwise the opening stays rectangular (plain crown underside, full-height jamb reveals). */
const archShown = (crown: number, bot: number, top: number): boolean => crown - (CELL / 2 - ARCH_JAMB) >= bot && crown <= top + EPS;

/** ARCH: spandrels (fan triangles on the wall plane, part of the wall run) and 8-segment intrados halves. */
function emitArch(plan: Plan, wm: WallModel, e: number, a: number, L: number, c: number, s: number, kO: number,
  runKey: string, make: (t0: number, t1: number) => ChartSpec, st: FaceState, faces: Face[], _t: number): void {
  const g = wm.g;
  const sign = s ? 1 : -1;
  const d = wm.half[e];
  const lc = L * CELL, tb = c * CELL;
  const plane = lc + sign * d;
  const r = CELL / 2 - ARCH_JAMB;
  const crown = g.eHA[e] / 100, spring = crown - r;
  const bot = g.bottom(kO), top = g.top(kO);
  if (!archShown(crown, bot, top)) return;
  const nx = a === 0 ? sign : 0, nz = a === 0 ? 0 : sign;
  const P = (tt: number, y: number): number[] => (a === 0 ? [plane, y, tb + tt] : [tb + tt, y, plane]);
  const arc: [number, number][] = [];
  for (let k = 0; k <= 8; k++) {
    const th = Math.PI - (k * Math.PI) / 8;
    arc.push([CELL / 2 + r * Math.cos(th), spring + r * Math.sin(th)]);
  }
  arc[4] = [CELL / 2, crown];
  const tri = (p0: [number, number], p1: [number, number], p2: [number, number]): void => {
    const p = [...P(p0[0], p0[1]), ...P(p1[0], p1[1]), ...P(p2[0], p2[1])];
    const uv: number[] = [];
    for (let i = 0; i < 9; i += 3) vUv(st.layer, p[i], p[i + 1], p[i + 2], nx, nz, uv);
    const f = mkFace(p, uv, nx, 0, nz, st);
    const ts = [p0[0], p1[0], p2[0]];
    plan.run(f, runKey, tb + Math.min(...ts), tb + Math.max(...ts), make);
    faces.push(f);
  };
  for (let k = 0; k < 4; k++) tri([ARCH_JAMB, crown], arc[k], arc[k + 1]);
  for (let k = 4; k < 8; k++) tri([CELL - ARCH_JAMB, crown], arc[k], arc[k + 1]);
  // intrados (half band on this side), one BOX chart per segment
  const group = g.group[kO];
  for (let k = 0; k < 8; k++) {
    const [ta, ya] = arc[k], [tc, yc] = arc[k + 1];
    const thm = Math.PI - ((k + 0.5) * Math.PI) / 8;
    const nt = -Math.cos(thm), ny = -Math.sin(thm);
    const n3: V3 = a === 0 ? [0, ny, nt] : [nt, ny, 0];
    const A = (tt: number, y: number, off: number): number[] => (a === 0 ? [lc + off, y, tb + tt] : [tb + tt, y, lc + off]);
    const p = [...A(ta, ya, 0), ...A(tc, yc, 0), ...A(tc, yc, sign * d), ...A(ta, ya, sign * d)];
    const f = mkFace(p, [], n3[0], n3[1], n3[2], st);
    // material uv like the jamb reveal of this half (u across the wall thickness, v = y), continued along the curve:
    // v = spring + arc length from the nearest spring (continuous with both reveals, mirror-symmetric at the crown)
    const uv: number[] = [];
    const jn = k < 4 ? 1 : -1; // reveal normal sign along t: the left jamb faces +t, the right one -t
    const jx = a === 0 ? 0 : jn, jz = a === 0 ? jn : 0;
    for (let i = 0; i < 4; i++) {
      const j = i === 0 || i === 3 ? k : k + 1;
      const s = (r * Math.PI * (j <= 4 ? j : 8 - j)) / 8;
      vUv(st.layer, p[i * 3], spring + s, p[i * 3 + 2], jx, jz, uv);
    }
    f.uv = uv;
    const len = Math.hypot(tc - ta, yc - ya);
    const eu: V3 = a === 0 ? [0, (yc - ya) / len, (tc - ta) / len] : [(tc - ta) / len, (yc - ya) / len, 0];
    const key = `4i${a}${kf(L, 4)}${kf(c, 4)}${s}|${k}`;
    const sp = plan.addSpec(new ChartSpec(K_BOX, group, st.layer, key, n3, [p[0], p[1], p[2]], eu, a === 0 ? [sign, 0, 0] : [0, 0, sign]).setFixedV(0, d));
    plan.own(f, sp);
  }
}

/** Partition plinth (PARTITION_BASE_T wide, PARTITION_BASE_CM tall above the higher floor), RUBBER, TRIM_BORROW. */
function emitPlinth(plan: Plan, wm: WallModel, e: number, a: number, L: number, c: number, s: number, kO: number,
  tS: number, tE: number, panel: Face[]): void {
  const g = wm.g;
  const sign = s ? 1 : -1;
  const lc = L * CELL, tb = c * CELL;
  const bot = g.bottom(kO);
  const y0 = Math.max(wm.yLo[e], bot), y1 = Math.min(wm.ySill[e] + PLINTH_H, g.top(kO));
  if (y1 - y0 <= EPS || tE - tS <= EPS) return;
  const st = state(Mat.RUBBER, VFlag.NO_GRIME);
  const src = panel.length ? panel[0] : null;
  const reg = (f: Face): void => { if (src) plan.borrowFrom(f, src); else plan.borrow(f, plan.floorGrid); };
  const ax: 0 | 2 = a === 0 ? 0 : 2;
  addVSplit(ax, lc + sign * PLINTH_D, sign, tb + tS, tb + tE, y0, y1, st, g.waterY(kO), reg);
  const d = wm.half[e];
  const b0 = Math.min(lc + sign * d, lc + sign * PLINTH_D), b1 = Math.max(lc + sign * d, lc + sign * PLINTH_D);
  if (y1 > bot + EPS) reg(a === 0 ? hQuad(y1, 1, b0, b1, tb + tS, tb + tE, st) : hQuad(y1, 1, tb + tS, tb + tE, b0, b1, st));
}

// ------------------------------------------------------------------------------------------------ posts

function emitPosts(plan: Plan, wm: WallModel): void {
  const g = wm.g;
  for (let vj = 0; vj <= TILE_CELLS; vj++) {
    for (let vi = 0; vi <= TILE_CELLS; vi++) {
      const iv = wm.post(vi, vj);
      if (!iv) continue;
      const X = vi * CELL, Z = vj * CELL, h = POST_H;
      // side faces: [plane axis, plane, sign, t0, t1, owner ci, owner cj, dirCode, half]
      const sides: [0 | 2, number, number, number, number, number, number, number, number][] = [
        [0, X - h, -1, Z - h, Z, vi - 1, vj - 1, 0, 0], [0, X - h, -1, Z, Z + h, vi - 1, vj, 0, 1],
        [0, X + h, 1, Z - h, Z, vi, vj - 1, 1, 0], [0, X + h, 1, Z, Z + h, vi, vj, 1, 1],
        [2, Z - h, -1, X - h, X, vi - 1, vj - 1, 2, 0], [2, Z - h, -1, X, X + h, vi, vj - 1, 2, 1],
        [2, Z + h, 1, X - h, X, vi - 1, vj, 3, 0], [2, Z + h, 1, X, X + h, vi, vj, 3, 1],
      ];
      for (const [ax, plane, sign, t0, t1, oi, oj, dc, hf] of sides) {
        if (!g.inTile(oi, oj)) continue;
        const k = cix(oi, oj);
        if (g.isSolid(k)) continue;
        const mat = postMat(wm, vi, vj, oi, oj);
        const tint = postTint(g, k);
        const vis = subtractIntervals(iv, postHidden(wm, vi, vj, dc));
        for (let i = 0; i < vis.length; i += 2) {
          const top = g.top(k);
          const y0 = Math.max(vis[i], g.bottom(k)), yTop = Math.min(vis[i + 1], top);
          if (yTop - y0 <= EPS) continue;
          const y1 = extTop(g, k, yTop, top);
          const key = `4p${kf(vi, 4)}${kf(vj, 4)}${dc}${hf}|${q4(vis[i])}`;
          const sp = plan.addSpec(vSpec(K_BOX, g.group[k], mat, key, ax, plane, sign).setFixedV(y0, yTop));
          addVSplit(ax, plane, sign, t0, t1, y0, y1, state(mat, 0, tint), g.waterY(k), (f) => { clampLmTop(f, yTop); plan.own(f, sp); });
        }
      }
      // tops / undersides per quadrant
      for (let q = 0; q < 4; q++) {
        const oi = vi - 1 + (q & 1), oj = vj - 1 + (q >> 1);
        if (!g.inTile(oi, oj)) continue;
        const k = cix(oi, oj);
        if (g.isSolid(k)) continue;
        const qx0 = q & 1 ? X : X - h, qx1 = q & 1 ? X + h : X, qz0 = q >> 1 ? Z : Z - h, qz1 = q >> 1 ? Z + h : Z;
        const mat = postMat(wm, vi, vj, oi, oj);
        const tint = postTint(g, k);
        for (let i = 0; i < iv.length; i += 2) {
          for (const [y, dir] of [[iv[i + 1], 1], [iv[i], -1]] as [number, number][]) {
            if (y <= g.bottom(k) + EPS || y >= g.top(k) - EPS) continue;
            const key = `4q${kf(vi, 4)}${kf(vj, 4)}${q}|${dir}|${q4(y)}`;
            const sp = plan.addSpec(new ChartSpec(dir > 0 ? K_BOX : K_SOFFIT, g.group[k], mat, key, [0, dir, 0], [0, y, 0], [1, 0, 0], [0, 0, 1]));
            let st = state(mat, 0, tint);
            const wy = g.waterY(k);
            if (wy > y + EPS) st = underwater(st, Math.round(wy * 100));
            plan.own(hQuad(y, dir, qx0, qx1, qz0, qz1, st), sp);
          }
        }
      }
    }
  }
}

/** Post tint of owner cell k: the cell's warmth; structure (tower / elevator) cells are storey-free (neutral). */
const postTint = (g: TileGrid, k: number): number => wallTint(0, g.group[k] === 0 ? g.warmth[k] : 128, 0);

/** y intervals where the post side face `dc` (0 -x, 1 +x, 2 -z, 3 +z) lies inside the wall leaving the vertex in that
 * direction (a full-thickness piece or a partition plinth touching the vertex): hidden, not emitted. */
function postHidden(wm: WallModel, vi: number, vj: number, dc: number): number[] {
  const e = dc === 0 ? eix(1, vj, vi - 1) : dc === 1 ? eix(1, vj, vi) : dc === 2 ? eix(0, vi, vj - 1) : eix(0, vi, vj);
  const end = dc === 0 || dc === 2 ? 1 : 0;
  if (!wm.ok[e] || !wm.thick[e]) return [];
  const out: number[] = [];
  if (wm.half[e] >= POST_H - 1e-6) {
    const pr = wm.pieces(e);
    for (let i = 0; i < wm.pn[e]; i++) {
      if (end === 0 ? pr[i * 4] <= EPS : pr[i * 4 + 1] >= CELL - EPS) out.push(pr[i * 4 + 2], pr[i * 4 + 3]);
    }
  }
  if (wm.g.eKind[e] === EdgeKind.PARTITION && PLINTH_D >= POST_H - 1e-6) out.push(wm.yLo[e], wm.ySill[e] + PLINTH_H);
  return mergeIntervals(out);
}

/** Merged intervals `a` minus merged intervals `b` (flat pairs). */
function subtractIntervals(a: number[], b: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < a.length; i += 2) {
    let cur = a[i];
    const end = a[i + 1];
    for (let j = 0; j < b.length && cur < end - EPS; j += 2) {
      if (b[j + 1] <= cur + EPS || b[j] >= end - EPS) continue;
      if (b[j] > cur + EPS) out.push(cur, b[j]);
      cur = Math.max(cur, b[j + 1]);
    }
    if (cur < end - EPS) out.push(cur, end);
  }
  return out;
}

/** Material of a post face in quadrant cell (oi, oj): the face material of an adjacent rendered edge on that side. */
function postMat(wm: WallModel, vi: number, vj: number, oi: number, oj: number): number {
  const g = wm.g;
  const ex = eix(0, vi, oj), ez = eix(1, vj, oi);
  if (wm.ok[ex] && wm.thick[ex]) return oi === vi ? g.eMatPos[ex] : g.eMatNeg[ex];
  if (wm.ok[ez] && wm.thick[ez]) return oj === vj ? g.eMatPos[ez] : g.eMatNeg[ez];
  // any thick incident edge
  for (const e of [eix(0, vi, vj - 1), eix(0, vi, vj), eix(1, vj, vi - 1), eix(1, vj, vi)]) {
    if (wm.ok[e] && wm.thick[e]) return g.eMatNeg[e];
  }
  return g.wallMat[cix(oi, oj)];
}
