// src/mesh/ceilings.ts — WP5 ceilings (§5 WP5 rules 5 and 6): per-0.6 m ceiling tiles by TileState, T-bar grid,
// MISSING-tile plenum boxes, greedy CONCRETE/TILE_GLAZED/BEAMS/TRUSS ceilings, and recessed fixtures (TROFFER_2x4,
// TROFFER_2x2, SKY_PANEL) emitted whole in the tile containing their centre. Pure module.

import { CEIL_TILE } from '../core/constants.ts';
import { lensAux, recessedProfile } from '../core/emitterProfile.ts';
import { tileOfPoint } from '../core/grid.ts';
import { CeilKind, CellFlag, DYING_MEAN, LightState, Mat, TileState, VFlag, isRecessedFixture } from '../core/ids.ts';
import { fixtureRadiance, getTile, type Fixture } from '../core/layout.ts';
import type { ChartKindId } from '../core/mesh.ts';
import { greedyRects } from './geom.ts';
import { expandPeriodicFixtures } from './periodic.ts';
import { ChartSpec, hQuad, mkFace, state, vQuad, type Face, type FaceState, type Plan } from './plan.ts';
import { cix, cixInv, type TileGrid } from './tileGrid.ts';
import { h01, hUv, kf, q4, tintRGB } from './uv.ts';
import { hSpec } from './walls.ts';

const K_BOX = 5 as ChartKindId, K_PLENUM = 6 as ChartKindId;
const TG = 32; // 0.6 m ceiling tiles per tile side
const TILE_Y = 0.01; // ceiling tiles sit 10 mm above the grid face
const TBAR_W = 0.012; // half width of the 24 mm T-bar
const TBAR_B = 0.002; // T-bar flange bottom below ceilCm (12 mm deep incl. the 10 mm recess)
const PLENUM_D = 0.5;
const EPS = 1e-5;

export interface RecessedFixture {
  f: Fixture;
  x0: number; x1: number; z0: number; z1: number; // tile-local rect
  y: number; // ceiling plane (fixture py)
  aligned: boolean; // rect aligned to the 0.6 m lattice at a ceiling height => recessed into holes
  cell: number; // window cell index of the centre
}

/** Recessed fixtures of the centre chunk whose centre lies in this tile. */
export function tileRecessed(g: TileGrid): RecessedFixture[] {
  const out: RecessedFixture[] = [];
  for (const f of expandPeriodicFixtures(g.nb.center)) {
    if (!isRecessedFixture(f.kind) || tileOfPoint(f.px, f.pz) !== g.tile.q) continue;
    const cx = f.px - g.ox, cz = f.pz - g.oz;
    const alongX = Math.abs(f.tx) >= Math.abs(f.tz);
    const hx = (alongX ? f.w : f.h) / 2, hz = (alongX ? f.h : f.w) / 2;
    const x0 = cx - hx, x1 = cx + hx, z0 = cz - hz, z1 = cz + hz;
    const [ci, cj] = g.cellAt(cx, cz);
    const cell = cix(Math.max(0, Math.min(15, ci)), Math.max(0, Math.min(15, cj)));
    const on = (v: number): boolean => Math.abs(v / CEIL_TILE - Math.round(v / CEIL_TILE)) < 2e-3;
    let aligned = on(x0) && on(x1) && on(z0) && on(z1) && x0 >= -EPS && z0 >= -EPS && x1 <= 19.2 + EPS && z1 <= 19.2 + EPS;
    if (aligned) {
      // every covered tile must have its ceiling at the fixture plane
      for (let tz = Math.round(z0 / CEIL_TILE); tz < Math.round(z1 / CEIL_TILE) && aligned; tz++) {
        for (let tx = Math.round(x0 / CEIL_TILE); tx < Math.round(x1 / CEIL_TILE) && aligned; tx++) {
          const k = cix(tx >> 1, tz >> 1);
          if (!ceilValid(g, k) || Math.abs(g.ceil(k) - f.py) > 0.05) aligned = false;
        }
      }
    }
    out.push({ f, x0, x1, z0, z1, y: f.py, aligned, cell });
  }
  return out;
}

/** The cell has a rendered ceiling. */
export function ceilValid(g: TileGrid, k: number): boolean {
  if (g.flags[k] & (CellFlag.SOLID | CellFlag.TOWER | CellFlag.NO_CEIL)) return false;
  return g.ceilKind[k] !== CeilKind.OPEN_DARK;
}

/** Ceiling chart of a tile cell: CEIL_GRID for the storey, a per-cell BOX chart for structure groups. */
export class CeilCharts {
  private per = new Map<number, ChartSpec>();
  private plan: Plan;
  private g: TileGrid;
  constructor(plan: Plan, g: TileGrid) { this.plan = plan; this.g = g; }
  of(k: number, ci: number, cj: number): ChartSpec {
    const grp = this.g.group[k];
    if (grp === 0) return this.plan.ceilGrid;
    let s = this.per.get(k);
    if (!s) {
      const y = this.g.ceil(k);
      s = this.plan.addSpec(hSpec(K_BOX, grp, this.g.ceilMat[k], `4g${kf(ci, 3)}${kf(cj, 3)}|${q4(y)}`, y, -1));
      this.per.set(k, s);
    }
    return s;
  }
}

export function emitCeilings(plan: Plan, g: TileGrid, rec: RecessedFixture[], cc: CeilCharts): void {
  // ---- holes (0.6 m tiles filled by aligned recessed fixtures)
  const hole = new Uint8Array(TG * TG);
  for (const r of rec) {
    if (!r.aligned) continue;
    for (let tz = Math.round(r.z0 / CEIL_TILE); tz < Math.round(r.z1 / CEIL_TILE); tz++) {
      for (let tx = Math.round(r.x0 / CEIL_TILE); tx < Math.round(r.x1 / CEIL_TILE); tx++) hole[tz * TG + tx] = 1;
    }
  }
  const [gi0, gj0] = [g.tile.cx * 64 + g.li0 * 2, g.tile.cz * 64 + g.lj0 * 2]; // global 0.6 m tile origin
  const missing = new Int32Array(TG * TG).fill(-1);
  const flatKeys = new Int32Array(TG * TG).fill(-1);
  const flatIds = new Map<string, number>();
  const flatRep: number[] = [];
  for (let tz = 0; tz < TG; tz++) {
    for (let tx = 0; tx < TG; tx++) {
      const ci = tx >> 1, cj = tz >> 1;
      const k = cix(ci, cj);
      if (!ceilValid(g, k) || hole[tz * TG + tx]) continue;
      const y = g.ceil(k);
      if (g.ceilKind[k] !== CeilKind.TILES) {
        const s = `${g.ceilCm[k]}|${g.ceilKind[k]}|${g.ceilMat[k]}|${g.group[k] === 0 ? 0 : k}`;
        let id = flatIds.get(s);
        if (id === undefined) { id = flatRep.length; flatIds.set(s, id); flatRep.push(tz * TG + tx); }
        flatKeys[tz * TG + tx] = id;
        continue;
      }
      const tsub = (tz & 1) * 2 + (tx & 1);
      let ts = getTile(g.tiles, k, tsub);
      if (ts === TileState.MISSING) { missing[tz * TG + tx] = g.ceilCm[k] * 4096 + (g.group[k] === 0 ? 0 : (k & 4095)); continue; }
      if (ts === TileState.FIXTURE) ts = TileState.NORMAL; // no fixture fills it: a plain tile
      const spec = cc.of(k, ci, cj);
      const hb = h01(gi0 + tx, gj0 + tz, 0x7e11);
      // aged tiles are faintly yellowed; NEW replacement tiles are clearly whiter and cooler, DIRTY ones grey-brown
      let b = 0.92 * (1 + (hb - 0.5) * 0.06);
      let r = 1, gg = 0.99, bb = 0.95;
      if (ts === TileState.NEW) { b = Math.min(1, b * 1.09); r = 0.97; gg = 1; bb = 1; }
      else if (ts === TileState.DIRTY) { b *= 0.8; r = 1; gg = 0.95; bb = 0.84; }
      else if (ts === TileState.STAINED) { r = 0.97; gg = 0.92; bb = 0.8; }
      const st = state(g.ceilMat[k], 0, tintRGB(b * r, b * gg, b * bb, (hb * 65536) & 255));
      const x0 = tx * CEIL_TILE, x1 = x0 + CEIL_TILE, z0 = tz * CEIL_TILE, z1 = z0 + CEIL_TILE;
      const yt = y + TILE_Y;
      if (ts === TileState.SAGGING) {
        const xc = x0 + CEIL_TILE / 2, zc = z0 + CEIL_TILE / 2, yc = yt - 0.03;
        const corners = [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];
        for (let i = 0; i < 4; i++) {
          const [ax, az] = corners[i], [bx, bz] = corners[(i + 1) % 4];
          const p = [ax, yt, az, bx, yt, bz, xc, yc, zc];
          // normal of the triangle, pointing down
          const ux = bx - ax, uz = bz - az, vx = xc - ax, vy = yc - yt, vz = zc - az;
          let nx = -(0 * vz - uz * vy), ny = -(uz * vx - ux * vz), nz = -(ux * vy - 0 * vx);
          if (ny > 0) { nx = -nx; ny = -ny; nz = -nz; }
          const uv: number[] = [];
          hUv(st.layer, ax, az, uv); hUv(st.layer, bx, bz, uv); hUv(st.layer, xc, zc, uv);
          plan.own(mkFace(p, uv, nx, ny, nz, st), spec);
        }
        continue;
      }
      if (ts === TileState.VENT) { emitDiffuser(plan, spec, x0, z0, yt, hb); continue; }
      plan.own(hQuad(yt, -1, x0, x1, z0, z1, st), spec);
    }
  }
  // ---- flat ceilings (CONCRETE / TILE_GLAZED / BEAMS / TRUSS)
  const fr = greedyRects(flatKeys, TG, TG);
  for (let i = 0; i < fr.length; i += 5) {
    const rep = flatRep[fr[i + 4]];
    const tx = rep % TG, tz = (rep / TG) | 0;
    const k = cix(tx >> 1, tz >> 1);
    const mat = g.ceilKind[k] === CeilKind.TRUSS ? Mat.METAL_DECK : g.ceilMat[k];
    const f = hQuad(g.ceil(k), -1, fr[i] * CEIL_TILE, fr[i + 2] * CEIL_TILE, fr[i + 1] * CEIL_TILE, fr[i + 3] * CEIL_TILE, state(mat));
    plan.own(f, cc.of(k, tx >> 1, tz >> 1));
  }
  // ---- plenum boxes over MISSING tiles
  const mr = greedyRects(missing, TG, TG);
  const isOpen = (tx: number, tz: number, key: number): boolean =>
    tx >= 0 && tz >= 0 && tx < TG && tz < TG && missing[tz * TG + tx] === key;
  for (let i = 0; i < mr.length; i += 5) {
    const i0 = mr[i], j0 = mr[i + 1], i1 = mr[i + 2], j1 = mr[i + 3], key = mr[i + 4];
    const k = cix(i0 >> 1, j0 >> 1);
    const y = g.ceil(k), yt = y + PLENUM_D;
    const st = state(Mat.PLENUM, VFlag.NO_GRIME);
    const spec = plan.addSpec(hSpec(K_PLENUM, g.group[k], Mat.PLENUM, `6${kf(i0, 3)}${kf(j0, 3)}`, yt, -1));
    const topFace = plan.own(hQuad(yt, -1, i0 * CEIL_TILE, i1 * CEIL_TILE, j0 * CEIL_TILE, j1 * CEIL_TILE, st), spec);
    const side = (ax: 0 | 2, plane: number, sign: number, t0: number, t1: number): void => {
      plan.borrowFrom(vQuad(ax, plane, sign, t0, t1, y + TILE_Y, yt, st), topFace);
    };
    // sides facing into the hole, per 0.6 m segment where the neighbour tile is not part of the same hole
    for (let tz = j0; tz < j1; tz++) {
      if (!isOpen(i0 - 1, tz, key)) side(0, i0 * CEIL_TILE, 1, tz * CEIL_TILE, (tz + 1) * CEIL_TILE);
      if (!isOpen(i1, tz, key)) side(0, i1 * CEIL_TILE, -1, tz * CEIL_TILE, (tz + 1) * CEIL_TILE);
    }
    for (let tx = i0; tx < i1; tx++) {
      if (!isOpen(tx, j0 - 1, key)) side(2, j0 * CEIL_TILE, 1, tx * CEIL_TILE, (tx + 1) * CEIL_TILE);
      if (!isOpen(tx, j1, key)) side(2, j1 * CEIL_TILE, -1, tx * CEIL_TILE, (tx + 1) * CEIL_TILE);
    }
  }
  emitTBars(plan, g, hole, cc);
  for (const r of rec) emitRecessed(plan, g, r, cc);
}

/** TileState.VENT: a square stepped-cone supply diffuser filling one 0.6 m tile (instead of a flat decal): an outer
 * metal frame flush with the tile plane (it owns the ceiling chart texels like a tile would), three louvre rings
 * stepping 12 mm up into the plenum with dark slot risers, and a dark throat (PLENUM x 0.35: the duct's dim interior,
 * not a black hole). Lightmap from the ceiling chart. */
function emitDiffuser(plan: Plan, spec: ChartSpec, x0: number, z0: number, yt: number, hb: number): void {
  const metal = state(Mat.METAL_PAINTED, VFlag.NO_GRIME, tintRGB(0.86, 0.86, 0.84, (hb * 65536) & 255));
  const slot = state(Mat.METAL_PAINTED, VFlag.NO_GRIME, tintRGB(0.3, 0.3, 0.29));
  const throat = state(Mat.PLENUM, VFlag.NO_GRIME, tintRGB(0.35, 0.35, 0.35));
  const S = CEIL_TILE, STEP = 0.012;
  const ins = [0, 0.045, 0.095, 0.145, 0.195];
  for (let r = 0; r + 1 < ins.length; r++) {
    const a = ins[r], b = ins[r + 1], y = yt + r * STEP, yu = y + STEP;
    const ring = [
      hQuad(y, -1, x0 + a, x0 + S - a, z0 + a, z0 + b, metal),
      hQuad(y, -1, x0 + a, x0 + S - a, z0 + S - b, z0 + S - a, metal),
      hQuad(y, -1, x0 + a, x0 + b, z0 + b, z0 + S - b, metal),
      hQuad(y, -1, x0 + S - b, x0 + S - a, z0 + b, z0 + S - b, metal),
    ];
    for (const f of ring) { if (r === 0) plan.own(f, spec); else plan.borrow(f, spec); }
    // risers up to the next ring / the throat, facing the diffuser centre
    const st = r + 2 < ins.length ? slot : throat;
    plan.borrow(vQuad(0, x0 + b, 1, z0 + b, z0 + S - b, y, yu, st), spec);
    plan.borrow(vQuad(0, x0 + S - b, -1, z0 + b, z0 + S - b, y, yu, st), spec);
    plan.borrow(vQuad(2, z0 + b, 1, x0 + b, x0 + S - b, y, yu, st), spec);
    plan.borrow(vQuad(2, z0 + S - b, -1, x0 + b, x0 + S - b, y, yu, st), spec);
  }
  const c = ins[ins.length - 1];
  plan.borrow(hQuad(yt + (ins.length - 1) * STEP, -1, x0 + c, x0 + S - c, z0 + c, z0 + S - c, throat), spec);
}

// ------------------------------------------------------------------------------------------------ T-bar grid

function emitTBars(plan: Plan, g: TileGrid, hole: Uint8Array, cc: CeilCharts): void {
  const st = state(Mat.TRIM_PAINT, VFlag.NO_GRIME, tintRGB(0.97, 0.96, 0.93)); // white enamel T-bars
  // tile info: valid TILES ceiling / open (missing or fixture hole) / ceiling y
  const info = (tx: number, tz: number): [boolean, boolean, number, number] => {
    const ci = Math.floor(tx / 2), cj = Math.floor(tz / 2);
    if (!g.inWin(ci, cj)) return [false, false, 0, -1];
    const k = cix(ci, cj);
    if (!ceilValid(g, k) || g.ceilKind[k] !== CeilKind.TILES) return [false, false, 0, k];
    const inT = tx >= 0 && tz >= 0 && tx < TG && tz < TG;
    const ts = getTile(g.tiles, k, (tz & 1) * 2 + (tx & 1));
    const open = ts === TileState.MISSING || (inT && hole[tz * TG + tx] === 1);
    return [true, open, g.ceil(k), k];
  };
  for (let fam = 0; fam < 2; fam++) {
    // fam 0: lines x = kk*0.6 (strips along z); fam 1: lines z = kk*0.6 (strips along x)
    const dy = fam === 0 ? 0 : 0.0005;
    for (let kk = 0; kk <= TG; kk++) {
      const X = kk * CEIL_TILE;
      // per segment config: existsL, existsR, yL, yR, kL, kR
      const cfg: number[][] = [];
      for (let m = 0; m < TG; m++) {
        const L = fam === 0 ? info(kk - 1, m) : info(m, kk - 1);
        const R = fam === 0 ? info(kk, m) : info(m, kk);
        const inL = kk - 1 >= 0, inR = kk < TG;
        const eL = inL && L[0] && !(L[1] && (R[1] || !R[0]));
        const eR = inR && R[0] && !(R[1] && (L[1] || !L[0]));
        cfg.push([eL ? 1 : 0, eR ? 1 : 0, eL ? L[2] : 0, eR ? R[2] : 0, L[3], R[3]]);
      }
      let m = 0;
      while (m < TG) {
        const c0 = cfg[m];
        if (!c0[0] && !c0[1]) { m++; continue; }
        let m1 = m + 1;
        while (m1 < TG && cfg[m1][0] === c0[0] && cfg[m1][1] === c0[1] && cfg[m1][2] === c0[2] && cfg[m1][3] === c0[3]) m1++;
        const full = c0[0] && c0[1] && Math.abs(c0[2] - c0[3]) < EPS;
        const halves: [number, number, number, number][] = []; // [a0, a1 (across offsets), y, cellK]
        if (full) halves.push([-TBAR_W, TBAR_W, c0[2], c0[4]]);
        else {
          if (c0[0]) halves.push([-TBAR_W, 0, c0[2], c0[4]]);
          if (c0[1]) halves.push([0, TBAR_W, c0[3], c0[5]]);
        }
        const s0 = m * CEIL_TILE, s1 = m1 * CEIL_TILE;
        for (const [a0, a1, y, kc] of halves) {
          const [ci, cj] = cixInv(kc);
          const spec = cc.of(kc, ci, cj);
          const yb = y - TBAR_B - dy, yt = y + TILE_Y;
          const put = (f: Face): void => { plan.borrow(f, spec); };
          // end caps only where they face a ceiling-bearing cell of this tile (else they end inside a wall / soffit)
          const capOk = (x: number, z: number): boolean => {
            const [oi, oj] = g.cellAt(x, z);
            if (!g.inTile(oi, oj)) return false;
            const ko = cix(oi, oj);
            return !g.isSolid(ko) && ceilValid(g, ko);
          };
          if (fam === 0) {
            put(hQuad(yb, -1, X + a0, X + a1, s0, s1, st));
            if (a0 < 0) put(vQuad(0, X + a0, -1, s0, s1, yb, yt, st));
            if (a1 > 0) put(vQuad(0, X + a1, 1, s0, s1, yb, yt, st));
            for (const [h0, h1] of halvesOf(a0, a1)) {
              if (!(m > 0 && cfgHas(cfg[m - 1], h0, h1, y)) && capOk(X + (h0 + h1) / 2, s0 - 0.01)) put(vQuad(2, s0, -1, X + h0, X + h1, yb, yt, st));
              if (!(m1 < TG && cfgHas(cfg[m1], h0, h1, y)) && capOk(X + (h0 + h1) / 2, s1 + 0.01)) put(vQuad(2, s1, 1, X + h0, X + h1, yb, yt, st));
            }
          } else {
            put(hQuad(yb, -1, s0, s1, X + a0, X + a1, st));
            if (a0 < 0) put(vQuad(2, X + a0, -1, s0, s1, yb, yt, st));
            if (a1 > 0) put(vQuad(2, X + a1, 1, s0, s1, yb, yt, st));
            for (const [h0, h1] of halvesOf(a0, a1)) {
              if (!(m > 0 && cfgHas(cfg[m - 1], h0, h1, y)) && capOk(s0 - 0.01, X + (h0 + h1) / 2)) put(vQuad(0, s0, -1, X + h0, X + h1, yb, yt, st));
              if (!(m1 < TG && cfgHas(cfg[m1], h0, h1, y)) && capOk(s1 + 0.01, X + (h0 + h1) / 2)) put(vQuad(0, s1, 1, X + h0, X + h1, yb, yt, st));
            }
          }
        }
        m = m1;
      }
    }
  }
}
/** The half strips ([-W, 0] and / or [0, W]) making up a strip across [a0, a1]. */
const halvesOf = (a0: number, a1: number): [number, number][] => {
  const out: [number, number][] = [];
  if (a0 < 0) out.push([a0, 0]);
  if (a1 > 0) out.push([0, a1]);
  return out;
};
const cfgHas = (c: number[], a0: number, a1: number, y: number): boolean =>
  (a0 < 0 ? c[0] === 1 && Math.abs(c[2] - y) < EPS : true) && (a1 > 0 ? c[1] === 1 && Math.abs(c[3] - y) < EPS : true);

// ------------------------------------------------------------------------------------------------ recessed fixtures

/** Lens face state. aux = profile parameter A | profile bits << 16 | state << 24 and tint.a = seed & 255 in every
 * state (core/emitterProfile.ts): the shaders shape the lens (PRISM / LOUVER / OPAL) at medium and above, and an
 * OFF lens keeps its profile for the dark-cavity look. U, V: lens size in ceiling tiles; axis 1: lamps along v. */
function lensState(f: Fixture, zone: number, U: number, V: number): FaceState {
  const c = f.color;
  let emit = fixtureRadiance(f), flags = VFlag.NO_GRIME, st: number = f.state;
  let tint = tintRGB(c[0], c[1], c[2], f.seed & 255);
  switch (f.state) {
    case LightState.OFF: emit = 0; tint = tintRGB(0.55, 0.53, 0.5, f.seed & 255); break;
    case LightState.DYING: emit *= DYING_MEAN; flags |= VFlag.SHIMMER; break;
    case LightState.BUZZ: flags |= VFlag.SHIMMER; break;
    case LightState.FLICKER:
      // a FLICKER light that does not own its tile's channel (WP4 demotes these) looks like a DYING one, exactly as
      // the prop lenses do (props/fixtures.ts fixtureEmitState)
      if (f.dynamic) flags |= VFlag.DYN_EMIT;
      else { emit *= DYING_MEAN; flags |= VFlag.SHIMMER; st = LightState.DYING; }
      break;
    case LightState.ANOMALY: if (f.dynamic) flags |= VFlag.DYN_EMIT; break;
    default: break;
  }
  const axis = Math.abs(f.tz) > Math.abs(f.tx) ? 1 : 0;
  return state(Mat.PANEL_LENS, flags, tint, emit, lensAux(recessedProfile(f.kind, U, V, axis, f.seed, zone), st));
}

function emitRecessed(plan: Plan, g: TileGrid, r: RecessedFixture, cc: CeilCharts): void {
  const [ci, cj] = cixInv(r.cell);
  const spec = cc.of(r.cell, ci, cj);
  const trim = state(Mat.TRIM_PAINT, VFlag.NO_GRIME, tintRGB(0.93, 0.93, 0.9));
  const put = (f: Face): void => { plan.borrow(f, spec); };
  const { x0, x1, z0, z1, y } = r;
  const U = (x1 - x0) / CEIL_TILE, V = (z1 - z0) / CEIL_TILE;
  const lens = lensState(r.f, g.nb.center.zone, U, V);
  const lensQuad = (yl: number): void => {
    // uv 0..U along +x, 0..V along +z: the lens shader's frame (chunks/emitters.ts)
    const f = hQuad(yl, -1, x0, x1, z0, z1, lens);
    f.uv = [0, 0, U, 0, U, V, 0, V];
    put(f);
  };
  if (r.aligned) {
    const yl = y + 0.03, yf = y - 0.003, yt = y + TILE_Y, F = 0.02;
    lensQuad(yl);
    // housing (inward), from the frame bottom up to the lens
    put(vQuad(0, x0, 1, z0, z1, yf, yl, trim));
    put(vQuad(0, x1, -1, z0, z1, yf, yl, trim));
    put(vQuad(2, z0, 1, x0, x1, yf, yl, trim));
    put(vQuad(2, z1, -1, x0, x1, yf, yl, trim));
    // 2 cm frame ring (bottom) + outer sides
    put(hQuad(yf, -1, x0 - F, x1 + F, z0 - F, z0, trim));
    put(hQuad(yf, -1, x0 - F, x1 + F, z1, z1 + F, trim));
    put(hQuad(yf, -1, x0 - F, x0, z0, z1, trim));
    put(hQuad(yf, -1, x1, x1 + F, z0, z1, trim));
    put(vQuad(0, x0 - F, -1, z0 - F, z1 + F, yf, yt, trim));
    put(vQuad(0, x1 + F, 1, z0 - F, z1 + F, yf, yt, trim));
    put(vQuad(2, z0 - F, -1, x0 - F, x1 + F, yf, yt, trim));
    put(vQuad(2, z1 + F, 1, x0 - F, x1 + F, yf, yt, trim));
  } else {
    // not on the lattice / not at a ceiling: a thin surface panel just below the plane
    const yl = y - 0.012;
    lensQuad(yl);
    put(vQuad(0, x0, -1, z0, z1, yl, y, trim));
    put(vQuad(0, x1, 1, z0, z1, yl, y, trim));
    put(vQuad(2, z0, -1, x0, x1, yl, y, trim));
    put(vQuad(2, z1, 1, x0, x1, yl, y, trim));
  }
}
