// src/mesh/stairs.ts — WP5 ramps / stairs (§5 WP5 rule 7): visual treads, risers and stringers mapped to one RAMP
// chart per ramp (texels projected by xz onto the sloped plane from (x0,y0) to (x1,y1)), plus a sloped soffit 0.15 m
// below the nosing line (SOFFIT chart) so stacked flights are opaque from below. Faces are split at cell lines and
// filtered by ownership. Pure module.

import { CELL, TILE_SIZE } from '../core/constants.ts';
import { SolidFlag, VFlag } from '../core/ids.ts';
import type { Solid } from '../core/layout.ts';
import type { ChartKindId } from '../core/mesh.ts';
import { clipPoly, polyArea, splitByCells } from './geom.ts';
import { ChartSpec, polyFace, state, type FaceState, type Plan, type V3 } from './plan.ts';
import { cix, type TileGrid } from './tileGrid.ts';
import { kf } from './uv.ts';
import { underwater } from './walls.ts';

const K_SOFFIT = 4 as ChartKindId, K_RAMP = 7 as ChartKindId;
const EPS = 1e-5;
type Ramp = Extract<Solid, { kind: 'ramp' }>;
type Box = Extract<Solid, { kind: 'box' }>;

/** Emit a polygon split at cell lines; each piece is registered if its owner cell is in the tile, not SOLID and in `group`. */
function emitSplit(plan: Plan, g: TileGrid, p: number[], n: V3, st: FaceState, group: number, spec: ChartSpec): void {
  for (const [pp] of splitByCells(p, [], 0, CELL, TILE_SIZE)) {
    let cx = 0, cy = 0, cz = 0;
    const nv = pp.length / 3;
    for (let i = 0; i < pp.length; i += 3) { cx += pp[i]; cy += pp[i + 1]; cz += pp[i + 2]; }
    cx /= nv; cy /= nv; cz /= nv;
    const [ci, cj] = g.cellAt(cx + n[0] * 0.01, cz + n[2] * 0.01);
    if (!g.inTile(ci, cj)) continue;
    const k = cix(ci, cj);
    if (g.isSolid(k) || g.group[k] !== group) continue;
    if (polyArea(pp) < 1e-7) continue;
    if (Math.abs(n[1]) < 0.5) {
      // vertical piece entirely below the floor of the cell it faces (or above its ceiling): hidden, skip
      let yMax = -Infinity, yMin = Infinity;
      for (let i = 1; i < pp.length; i += 3) { yMax = Math.max(yMax, pp[i]); yMin = Math.min(yMin, pp[i]); }
      if (yMax <= g.bottom(k) + 1e-4 || yMin >= g.top(k) - 1e-4) continue;
    }
    let s2 = st;
    const wy = g.waterY(k);
    if (wy > cy + EPS) s2 = underwater(st, Math.round(wy * 100));
    plan.own(polyFace(pp, n[0], n[1], n[2], s2), spec);
  }
}

export function emitRamps(plan: Plan, g: TileGrid, solids: readonly Solid[]): void {
  const ramps: Ramp[] = [];
  const boxes: Box[] = [];
  for (const s of solids) {
    if (s.kind === 'ramp' && s.flags & SolidFlag.RENDER) ramps.push(s);
    else if (s.kind === 'box' && s.flags & SolidFlag.RENDER) boxes.push(s);
  }
  const order = ramps.map((_, i) => i).sort((a, b) => ramps[a].id - ramps[b].id || a - b);
  let rank = 0;
  for (const ri of order) emitRamp(plan, g, ramps[ri], ++rank, boxes);
}

function emitRamp(plan: Plan, g: TileGrid, r: Ramp, rank: number, boxes: Box[]): void {
  const X0 = Math.min(r.x0, r.x1) - g.ox, X1 = Math.max(r.x0, r.x1) - g.ox;
  const Z0 = Math.min(r.z0, r.z1) - g.oz, Z1 = Math.max(r.z0, r.z1) - g.oz;
  if (X1 < -EPS || Z1 < -EPS || X0 > TILE_SIZE + EPS || Z0 > TILE_SIZE + EPS) return; // faces on the tile lines may be ours
  const alongX = r.dir <= 1;
  const L = alongX ? X1 - X0 : Z1 - Z0, W = alongX ? Z1 - Z0 : X1 - X0;
  if (L <= EPS || W <= EPS) return;
  const sv: V3 = r.dir === 0 ? [1, 0, 0] : r.dir === 1 ? [-1, 0, 0] : r.dir === 2 ? [0, 0, 1] : [0, 0, -1];
  const wv: V3 = alongX ? [0, 0, 1] : [1, 0, 0];
  const P = (s: number, w: number, y: number): number[] => {
    switch (r.dir) {
      case 0: return [X0 + s, y, Z0 + w];
      case 1: return [X1 - s, y, Z0 + w];
      case 2: return [X0 + w, y, Z0 + s];
      default: return [X0 + w, y, Z1 - s];
    }
  };
  const y0 = r.y0, y1 = r.y1;
  const backedBy = highEndBacked(g, boxes, P, L, W, y1, sv);
  const backed = backedBy !== 0;
  // the high end on a cell line backed by cells: the step / cover face on that line replaces the top riser
  const endOnLine = ((): boolean => { const q = P(L, 0, 0); const v = sv[0] !== 0 ? q[0] : q[2]; return Math.abs(v / CELL - Math.round(v / CELL)) < 1e-6; })();
  const n = Math.max(0, Math.round(r.steps));
  const rise = n > 0 ? (y1 - y0) / n : 0;
  const nT = Math.max(1, n - 1);
  const dep = L / nT;
  const nose = (s: number): number => (n === 0 ? y0 + ((y1 - y0) * s) / L : n === 1 ? y1 : y0 + rise + (s * rise) / dep);
  const off = n > 1 ? Math.max(0.15, rise + 0.03) : 0.15;
  // floor under the footprint
  let fl = Infinity;
  for (let cj = Math.floor(Z0 / CELL + 1e-7); cj * CELL < Z1 - EPS; cj++) {
    for (let ci = Math.floor(X0 / CELL + 1e-7); ci * CELL < X1 - EPS; ci++) {
      if (!g.inWin(ci, cj)) continue;
      const k = cix(ci, cj);
      if (!g.isSolid(k)) fl = Math.min(fl, g.floor(k));
    }
  }
  if (fl === Infinity) fl = Math.min(y0, y1);
  const bottom = (s: number): number => Math.max(nose(s) - off, fl);
  // s* where the soffit line meets the floor (nose - off == fl)
  const kn = n === 0 ? (y1 - y0) / L : n === 1 ? 0 : rise / dep;
  const n0 = nose(0) - off;
  let sStar = kn > 1e-9 ? (fl - n0) / kn : n0 > fl ? 0 : L;
  sStar = Math.max(0, Math.min(L, sStar));

  // RAMP chart: sloped plane (s = 0, y0) -> (s = L, y1), texels projected by xz
  const k = (y1 - y0) / L;
  const du: V3 = [sv[0], k, sv[2]];
  const nl = Math.hypot(k, 1);
  const nrm: V3 = [-k * sv[0] / nl, 1 / nl, -k * sv[2] / nl];
  const o = P(0, 0, y0) as V3;
  const spec = plan.addSpec(new ChartSpec(K_RAMP, r.bakeGroup, r.mat, `5${kf(r.id, 10)}${kf(rank, 5)}a`, nrm, o, sv, wv, du, wv));
  // cont bits: -u end at s = 0, +u at s = L, -v at w = 0, +v at w = W (tile boundary crossings)
  const sLo = r.dir === 0 ? X0 < -EPS : r.dir === 1 ? X1 > TILE_SIZE + EPS : r.dir === 2 ? Z0 < -EPS : Z1 > TILE_SIZE + EPS;
  const sHi = r.dir === 0 ? X1 > TILE_SIZE + EPS : r.dir === 1 ? X0 < -EPS : r.dir === 2 ? Z1 > TILE_SIZE + EPS : Z0 < -EPS;
  const [wLo, wHi] = alongX ? [Z0 < -EPS, Z1 > TILE_SIZE + EPS] : [X0 < -EPS, X1 > TILE_SIZE + EPS];
  spec.cont = (sLo ? 1 : 0) | (sHi ? 2 : 0) | (wLo ? 4 : 0) | (wHi ? 8 : 0);
  const st = state(r.mat, 0);
  const ns: V3 = [-sv[0], 0, -sv[2]]; // riser normal (faces the low end)
  const up: V3 = [0, 1, 0];
  const quad = (a: number[], b: number[], c: number[], d: number[], nn: V3, sp: ChartSpec = spec): void => {
    for (const pp of cutCoplanarBoxes(g, boxes, [...a, ...b, ...c, ...d], nn)) emitSplit(plan, g, pp, nn, st, r.bakeGroup, sp);
  };

  if (n === 0) {
    quad(P(0, 0, y0), P(L, 0, y1), P(L, W, y1), P(0, W, y0), nrm);
    if (y0 > bottom(0) + EPS) quad(P(0, 0, bottom(0)), P(0, W, bottom(0)), P(0, W, y0), P(0, 0, y0), ns);
  } else {
    for (let i = 0; i < nT; i++) {
      const ty = n === 1 ? y1 : y0 + (i + 1) * rise;
      quad(P(i * dep, 0, ty), P((i + 1) * dep, 0, ty), P((i + 1) * dep, W, ty), P(i * dep, W, ty), up);
    }
    for (let i = 0; i < n; i++) {
      if (i === n - 1 && n > 1 && !backed) continue; // free-standing flight: no paper-thin top riser
      const s = n === 1 ? 0 : i * dep;
      const ya = i === 0 ? bottom(0) : y0 + i * rise, yb = y0 + (i + 1) * rise;
      if (yb - ya <= EPS) continue;
      if (i === n - 1 && n > 1 && ((backedBy === 2 && endOnLine) || topCovered(g, boxes, P(s, 0, 0), P(s, W, 0), ya, yb, sv))) continue;
      quad(P(s, 0, ya), P(s, W, ya), P(s, W, yb), P(s, 0, yb), ns);
    }
  }
  // back face at the high end of a free-standing flight (nothing beyond it at the top height)
  const yBack = bottom(L), yTop = n > 1 ? y0 + (n - 1) * rise : y1;
  if (!backed && yTop - yBack > EPS) quad(P(L, W, yBack), P(L, 0, yBack), P(L, 0, yTop), P(L, W, yTop), sv);
  // stringers: strips per tread between the bottom line and the tread / slope, split at s*
  const strips: [number, number, number, number][] = []; // s0, s1, top(s0), top(s1)
  if (n === 0) strips.push([0, L, y0, y1]);
  else for (let i = 0; i < nT; i++) { const ty = n === 1 ? y1 : y0 + (i + 1) * rise; strips.push([i * dep, (i + 1) * dep, ty, ty]); }
  for (const [s0, s1, t0, t1] of strips) {
    const cuts = [s0, s1];
    if (sStar > s0 + EPS && sStar < s1 - EPS) cuts.splice(1, 0, sStar);
    for (let c = 0; c + 1 < cuts.length; c++) {
      const a = cuts[c], b = cuts[c + 1];
      const ta = t0 + ((t1 - t0) * (a - s0)) / (s1 - s0), tb = t0 + ((t1 - t0) * (b - s0)) / (s1 - s0);
      const ba = bottom(a), bb = bottom(b);
      if (ta - ba <= EPS && tb - bb <= EPS) continue;
      for (const [w, sg] of [[0, -1], [W, 1]] as [number, number][]) {
        quad(P(a, w, ba), P(b, w, bb), P(b, w, tb), P(a, w, ta), [wv[0] * sg, 0, wv[2] * sg]);
      }
    }
  }
  // soffit (only where it hangs above the floor)
  if (sStar < L - EPS) {
    const ya = nose(sStar) - off, yb = nose(L) - off;
    const len = Math.hypot(L - sStar, yb - ya);
    const eu: V3 = [(sv[0] * (L - sStar)) / len, (yb - ya) / len, (sv[2] * (L - sStar)) / len];
    const knn = (yb - ya) / (L - sStar);
    const nn = Math.hypot(knn, 1);
    const sn: V3 = [(knn * sv[0]) / nn, -1 / nn, (knn * sv[2]) / nn];
    const sp = plan.addSpec(new ChartSpec(K_SOFFIT, r.bakeGroup, r.mat, `5${kf(r.id, 10)}${kf(rank, 5)}b`, sn, P(sStar, 0, ya) as V3, eu, wv));
    sp.cont = spec.cont & 12;
    emitSplit(plan, g, [...P(sStar, 0, ya), ...P(sStar, W, ya), ...P(L, W, yb), ...P(L, 0, yb)], sn, state(r.mat, VFlag.NO_GRIME), r.bakeGroup, sp);
  }
}

/** A vertical ramp face (stringer, riser, back face) minus the parts lying on a coplanar face of a render box with
 * the same normal (e.g. a tower wall box whose end overlaps the flight): that box face is emitted by solids.ts, so
 * the ramp keeps out of it (no coincident faces / z-fighting). Returns convex pieces. */
function cutCoplanarBoxes(g: TileGrid, boxes: Box[], p: number[], n: V3): number[][] {
  if (Math.abs(n[1]) > 1e-6 || (Math.abs(n[0]) < 0.999 && Math.abs(n[2]) < 0.999)) return [p];
  const ax = Math.abs(n[0]) > 0.5 ? 0 : 2, ta = ax === 0 ? 2 : 0, sg = n[ax] > 0 ? 1 : -1;
  const plane = p[ax];
  const off = (i: number): number => (i === 0 ? g.ox : i === 2 ? g.oz : 0);
  let pieces: number[][] = [p];
  for (const b of boxes) {
    const face = (sg > 0 ? b.max[ax] : b.min[ax]) - off(ax);
    if (Math.abs(face - plane) > 1e-4) continue;
    const t0 = b.min[ta] - off(ta), t1 = b.max[ta] - off(ta), y0 = b.min[1], y1 = b.max[1];
    const next: number[][] = [];
    for (const q of pieces) {
      let lo = Infinity, hi = -Infinity, ylo = Infinity, yhi = -Infinity;
      for (let i = 0; i < q.length; i += 3) {
        lo = Math.min(lo, q[i + ta]); hi = Math.max(hi, q[i + ta]); ylo = Math.min(ylo, q[i + 1]); yhi = Math.max(yhi, q[i + 1]);
      }
      if (hi <= t0 + EPS || lo >= t1 - EPS || yhi <= y0 + EPS || ylo >= y1 - EPS) { next.push(q); continue; }
      // outside parts: t < t0, t > t1, then (inside t) y < y0, y > y1; the rest lies on the box face
      const keep = (r: number[]): void => { if (r.length >= 9 && polyArea(r) > 1e-8) next.push(r); };
      keep(clipPoly(q, [], 0, ta, t0, -1)[0]);
      keep(clipPoly(q, [], 0, ta, t1, 1)[0]);
      const mid = clipPoly(clipPoly(q, [], 0, ta, t0, 1)[0], [], 0, ta, t1, -1)[0];
      if (mid.length >= 9) {
        keep(clipPoly(mid, [], 0, 1, y0, -1)[0]);
        keep(clipPoly(mid, [], 0, 1, y1, 1)[0]);
      }
    }
    pieces = next;
  }
  return pieces;
}

/** Is the high end of a flight backed by a landing? 0 free-standing, 1 a render box, 2 SOLID cells / floors at >= the
 * top height. */
function highEndBacked(g: TileGrid, boxes: Box[], P: (s: number, w: number, y: number) => number[], L: number, W: number, y1: number, sv: V3): number {
  let backed = true;
  for (const w of [0.02, W / 2, W - 0.02]) {
    const q = P(L, w, 0);
    const [ci, cj] = g.cellAt(q[0] + sv[0] * 0.02, q[2] + sv[2] * 0.02);
    if (!g.inWin(ci, cj)) continue;
    const k = cix(ci, cj);
    if (!g.isSolid(k) && g.floor(k) + Math.max(0, g.blockCm[k]) / 100 < y1 - 0.01) backed = false;
  }
  if (backed) return 2;
  return topCovered(g, boxes, P(L, 0, 0), P(L, W, 0), Math.max(-6, y1 - 0.02), y1, sv) ? 1 : 0;
}

/** Is the top riser face (at the high end, facing the low end) covered by a render box starting there? */
function topCovered(g: TileGrid, boxes: Box[], a: number[], b: number[], ya: number, yb: number, sv: V3): boolean {
  const ax = sv[0] !== 0 ? 0 : 2, sg = sv[0] + sv[2];
  const plane = a[ax];
  const oth = ax === 0 ? 2 : 0;
  const lo = Math.min(a[oth], b[oth]), hi = Math.max(a[oth], b[oth]);
  for (const bx of boxes) {
    const mn = [bx.min[0] - g.ox, bx.min[1], bx.min[2] - g.oz], mx = [bx.max[0] - g.ox, bx.max[1], bx.max[2] - g.oz];
    const beyond = sg > 0 ? mn[ax] <= plane + 1e-3 && mx[ax] >= plane + 1e-3 : mx[ax] >= plane - 1e-3 && mn[ax] <= plane - 1e-3;
    if (beyond && mn[oth] <= lo + 1e-3 && mx[oth] >= hi - 1e-3 && mn[1] <= ya + 1e-3 && mx[1] >= yb - 1e-3) return true;
  }
  return false;
}
