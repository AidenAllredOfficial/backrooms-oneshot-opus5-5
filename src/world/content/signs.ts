// src/world/content/signs.ts — EXIT_SIGN fixtures near towers, dark-room EXIT signs, STAIRS wayfinding (WP4, R2 B6).
//
// In chunks within 2 chunks of a tower: every DOORWAY / HEADER edge whose crossing direction points toward the
// nearest tower exit (dot > 0.7) gets, with p 0.35 (hashed per global edge), an EXIT_SIGN fixture (RECT 0.3 x 0.15,
// 150 nits red) hanging 5 cm below the head on the approach side, facing the approaching player. WP6's EXIT_SIGN
// geometry carries the emissive SIGNAGE face (no decal). Seam edges are stored by both chunks: the chunk that
// contains the sign's centre owns it.
//
// R2 (B6):
//  - dark rooms (pockets of lit districts, not the DARK zone): a DOORWAY / HEADER edge with unlit cells (no lit fixture within DARK_LIT_R) on both sides gets, with p
//    DARK_EXIT_P (hashed per edge, at most DARK_EXIT_MAX per chunk, lowest hashes), an EXIT_SIGN over it: the red glow
//    you walk toward in a blacked-out room. It faces the side the nearest tower exit is NOT on (you read it walking
//    toward the tower), or a hashed side without a tower in range.
//  - wayfinding: wall faces within STAIRS_RANGE (30 m) of a tower exit (and >= 4 m from it) whose wall runs toward the
//    exit (|dot| >= 0.6, the passage continues that way) get, with p STAIRS_SIGN_P (hashed per face, at most
//    STAIRS_SIGN_MAX per chunk, >= 8 m apart), a blue STAIRS plate at 1.55 m with a stencil arrow plate beside it
//    pointing along the wall (SIGNAGE decals, no light).

import { CELL, CHUNK_SIZE, WALL_T } from '../../core/constants.ts';
import { CellFlag, EdgeKind, FixtureKind, LightState, SALT, SignKind, Zone, cellIdx, exIdx, ezIdx, hash01, hash2, hash5 } from '../../core/index.ts';
import type { ZoneGenContext } from '../../core/index.ts';
import { towerExitCell } from '../structures/tower.ts';
import {
  addLatticeFixture, canStep, DX, DZ, EXIT_RED, fixtureAt, isOpenFloor, isSeamSide, isWallKind, N, sideKind, toLocalX, toLocalZ, towersWithin, wallFaceOf,
} from './util.ts';

export const EXIT_SIGN_P = 0.35;
export const EXIT_SIGN_RANGE = 2;

/** Tower exit points (cell centres, context-chunk-local metres) within `r` chunks. */
export function towerExits(ctx: ZoneGenContext, r: number): [number, number][] {
  return towersWithin(ctx, r).map((t) => {
    const e = towerExitCell(t);
    return [toLocalX(ctx, t.cx, (e.li + 0.5) * CELL), toLocalZ(ctx, t.cz, (e.lj + 0.5) * CELL)] as [number, number];
  });
}

export function placeExitSigns(ctx: ZoneGenContext, o: { dark?: boolean; stairs?: boolean } = {}): void {
  placeTowerExitSigns(ctx);
  if (o.dark !== false) placeDarkExitSigns(ctx);
  if (o.stairs !== false) placeStairsSigns(ctx);
}

function placeTowerExitSigns(ctx: ZoneGenContext): void {
  const exits = towerExits(ctx, EXIT_SIGN_RANGE);
  if (exits.length === 0) return;
  const g = ctx.grid, l = g.layout, s = ctx.key.s;
  const dead = ctx.opts.lights === 'dead';
  const nearest = (x: number, z: number): [number, number] => {
    let best = exits[0], bd = Infinity;
    for (const e of exits) {
      const d = (e[0] - x) * (e[0] - x) + (e[1] - z) * (e[1] - z);
      if (d < bd) { bd = d; best = e; }
    }
    return best;
  };
  const tryEdge = (axis: 'x' | 'z', i: number, j: number, kind: number, hA: number): void => {
    if (kind !== EdgeKind.DOORWAY && kind !== EdgeKind.HEADER) return;
    if (kind === EdgeKind.HEADER && hA < 190) return;
    // edge centre and its two cells
    const ex = axis === 'x' ? i * CELL : (i + 0.5) * CELL;
    const ez = axis === 'x' ? (j + 0.5) * CELL : j * CELL;
    const [tx, tz] = nearest(ex, ez);
    let dx = tx - ex, dz = tz - ez;
    const len = Math.sqrt(dx * dx + dz * dz);
    if (len < 1e-6) return;
    dx /= len; dz /= len;
    const along = axis === 'x' ? dx : dz; // crossing direction component
    if (Math.abs(along) <= 0.7) return;
    const sgn = along > 0 ? 1 : -1; // crossing toward the tower
    const gi = g.gi0 + i, gj = g.gj0 + j;
    if (hash01(hash5(ctx.seed, SALT.EXIT_SIGN, s, axis === 'x' ? gi * 2 : gi * 2 + 1, gj)) >= EXIT_SIGN_P) return;
    // approach side = the side the player comes from (opposite to the crossing direction)
    const off = WALL_T / 2 + 0.035;
    const px = axis === 'x' ? ex - sgn * off : ex, pz = axis === 'x' ? ez : ez - sgn * off;
    if (px < 0 || pz < 0 || px >= CHUNK_SIZE || pz >= CHUNK_SIZE) return; // owned by the chunk containing it
    // approach cell must be open storey space (not a tower / elevator)
    const ai = axis === 'x' ? (sgn > 0 ? i - 1 : i) : i, aj = axis === 'x' ? j : (sgn > 0 ? j - 1 : j);
    if (ai < 0 || aj < 0 || ai >= N || aj >= N) return;
    if ((l.flags[cellIdx(ai, aj)] & (CellFlag.TOWER | CellFlag.ELEVATOR | CellFlag.SOLID)) !== 0) return;
    const head = hA / 100;
    const py = head - 0.05 - 0.075;
    if (py - 0.075 < l.floorCm[cellIdx(ai, aj)] / 100 + 1.8) return; // keep head clearance
    const nx = axis === 'x' ? -sgn : 0, nz = axis === 'x' ? 0 : -sgn;
    const t: [number, number, number] = axis === 'x' ? [0, 0, 1] : [1, 0, 0];
    const sign = fixtureAt(FixtureKind.EXIT_SIGN, px, py, pz, [nx, 0, nz], t, EXIT_RED, 150);
    // placed after assignFixtureStates: honour the QA 'dead' override here (every light OFF)
    if (dead) sign.state = LightState.OFF;
    addLatticeFixture(g, sign);
  };
  for (let lj = 0; lj < N; lj++) for (let i = 0; i <= N; i++) { const k = exIdx(i, lj); tryEdge('x', i, lj, l.ex.kind[k], l.ex.hA[k]); }
  for (let j = 0; j <= N; j++) for (let li = 0; li < N; li++) { const k = ezIdx(li, j); tryEdge('z', li, j, l.ez.kind[k], l.ez.hA[k]); }
}

// ------------------------------------------------------------------------------------------ R2 (B6)

export const DARK_LIT_R = 4.5;
export const DARK_EXIT_P = 0.3;
export const DARK_EXIT_MAX = 2;
export const STAIRS_RANGE = 30;
export const STAIRS_SIGN_P = 0.12;
export const STAIRS_SIGN_MAX = 3;
const DARK_TAG = 0xda2c, STAIRS_TAG = 0x57a1;

/** 1 = cell has a lit (not OFF) fixture within DARK_LIT_R (fixtures of this chunk only). */
export function litCells(ctx: ZoneGenContext): Uint8Array {
  const l = ctx.grid.layout;
  const lit = new Uint8Array(N * N);
  const reach = Math.ceil(DARK_LIT_R / CELL), r2 = DARK_LIT_R * DARK_LIT_R;
  for (const f of l.fixtures) {
    if (f.state === LightState.OFF || f.kind === FixtureKind.EXIT_SIGN) continue;
    const fi = Math.floor(f.px / CELL), fj = Math.floor(f.pz / CELL);
    for (let lj = Math.max(0, fj - reach); lj <= Math.min(N - 1, fj + reach); lj++) {
      for (let li = Math.max(0, fi - reach); li <= Math.min(N - 1, fi + reach); li++) {
        const dx = (li + 0.5) * CELL - f.px, dz = (lj + 0.5) * CELL - f.pz;
        if (dx * dx + dz * dz <= r2) lit[cellIdx(li, lj)] = 1;
      }
    }
  }
  return lit;
}

function placeDarkExitSigns(ctx: ZoneGenContext): void {
  const g = ctx.grid, l = g.layout, s = ctx.key.s;
  if (ctx.opts.lights === 'on') return; // QA 'on': nothing is dark
  const lit = litCells(ctx);
  const exits = towerExits(ctx, EXIT_SIGN_RANGE);
  const dead = ctx.opts.lights === 'dead';
  const cand: { axis: 'x' | 'z'; i: number; j: number; h: number }[] = [];
  const consider = (axis: 'x' | 'z', i: number, j: number, kind: number, hA: number): void => {
    if (kind !== EdgeKind.DOORWAY && !(kind === EdgeKind.HEADER && hA >= 190)) return;
    if (axis === 'x' ? i <= 0 || i >= N : j <= 0 || j >= N) return;
    const a = axis === 'x' ? cellIdx(i - 1, j) : cellIdx(i, j - 1), b = cellIdx(i, j);
    if (lit[a] || lit[b] || !isOpenFloor(l, a) || !isOpenFloor(l, b)) return;
    if ((l.flags[a] | l.flags[b]) & (CellFlag.LANDMARK | CellFlag.TOWER | CellFlag.ELEVATOR)) return;
    // dark POCKETS of lit districts; the DARK zone itself stays black (spawn views into it look for no emitters)
    if (l.cellZone[a] === Zone.DARK || l.cellZone[b] === Zone.DARK) return;
    const gi = g.gi0 + i, gj = g.gj0 + j;
    const h = hash5(ctx.seed, SALT.EXIT_SIGN, s, (axis === 'x' ? gi * 2 : gi * 2 + 1) ^ DARK_TAG, gj);
    if (hash01(h) >= DARK_EXIT_P) return;
    cand.push({ axis, i, j, h });
  };
  for (let lj = 0; lj < N; lj++) for (let i = 1; i < N; i++) { const k = exIdx(i, lj); consider('x', i, lj, l.ex.kind[k], l.ex.hA[k]); }
  for (let j = 1; j < N; j++) for (let li = 0; li < N; li++) { const k = ezIdx(li, j); consider('z', li, j, l.ez.kind[k], l.ez.hA[k]); }
  cand.sort((p, q) => p.h - q.h || p.i - q.i || p.j - q.j);
  let n = 0;
  for (const e of cand) {
    if (n >= DARK_EXIT_MAX) break;
    const ex = e.axis === 'x' ? e.i * CELL : (e.i + 0.5) * CELL, ez = e.axis === 'x' ? (e.j + 0.5) * CELL : e.j * CELL;
    if (l.fixtures.some((f) => f.kind === FixtureKind.EXIT_SIGN && Math.abs(f.px - ex) < 3 && Math.abs(f.pz - ez) < 3)) continue;
    // approach side: away from the nearest tower exit (you walk toward it), else hashed
    let sgn: number = hash01(hash2(e.h, 9)) < 0.5 ? 1 : -1; // crossing direction
    if (exits.length > 0) {
      let bd = Infinity, tx = 0, tz = 0;
      for (const t of exits) { const d = (t[0] - ex) ** 2 + (t[1] - ez) ** 2; if (d < bd) { bd = d; tx = t[0] - ex; tz = t[1] - ez; } }
      const along = e.axis === 'x' ? tx : tz;
      if (Math.abs(along) > 1e-6) sgn = along > 0 ? 1 : -1;
    }
    const k = e.axis === 'x' ? exIdx(e.i, e.j) : ezIdx(e.i, e.j);
    const hA = (e.axis === 'x' ? l.ex.hA[k] : l.ez.hA[k]) / 100;
    const ai = e.axis === 'x' ? (sgn > 0 ? e.i - 1 : e.i) : e.i, aj = e.axis === 'x' ? e.j : (sgn > 0 ? e.j - 1 : e.j);
    const off = WALL_T / 2 + 0.035;
    const px = e.axis === 'x' ? ex - sgn * off : ex, pz = e.axis === 'x' ? ez : ez - sgn * off;
    const py = hA - 0.05 - 0.075;
    if (py - 0.075 < l.floorCm[cellIdx(ai, aj)] / 100 + 1.8) continue;
    const nx = e.axis === 'x' ? -sgn : 0, nz = e.axis === 'x' ? 0 : -sgn;
    const t: [number, number, number] = e.axis === 'x' ? [0, 0, 1] : [1, 0, 0];
    const sign = fixtureAt(FixtureKind.EXIT_SIGN, px, py, pz, [nx, 0, nz], t, EXIT_RED, 150);
    if (dead) sign.state = LightState.OFF;
    if (addLatticeFixture(g, sign) >= 0) n++;
  }
}

function placeStairsSigns(ctx: ZoneGenContext): void {
  const exits = towerExits(ctx, 1);
  if (exits.length === 0) return;
  const g = ctx.grid, l = g.layout, s = ctx.key.s;
  const cand: { c: number; d: number; h: number; along: number }[] = [];
  for (let c = 0; c < N * N; c++) {
    if (!isOpenFloor(l, c) || (l.flags[c] & (CellFlag.LANDMARK | CellFlag.RESERVED)) !== 0) continue;
    const li = c & 31, lj = c >> 5;
    const cx = (li + 0.5) * CELL, cz = (lj + 0.5) * CELL;
    let bd = Infinity, tx = 0, tz = 0;
    for (const t of exits) { const d = (t[0] - cx) ** 2 + (t[1] - cz) ** 2; if (d < bd) { bd = d; tx = t[0] - cx; tz = t[1] - cz; } }
    if (bd > STAIRS_RANGE * STAIRS_RANGE || bd < 16) continue;
    const len = Math.sqrt(bd);
    for (let d = 0; d < 4; d++) {
      if (isSeamSide(li, lj, d) || !isWallKind(sideKind(l, li, lj, d))) continue;
      // viewer's right on this face: u0 = (nz, -nx) with n = inward normal = -(DX, DZ)
      const nx = -DX[d], nz = -DZ[d], rx = nz, rz = -nx;
      const along = (tx * rx + tz * rz) / len;
      if (Math.abs(along) < 0.6) continue;
      // the passage continues toward the exit along the wall
      const dir = rx * (along > 0 ? 1 : -1) > 0.5 ? 0 : rx * (along > 0 ? 1 : -1) < -0.5 ? 1 : rz * (along > 0 ? 1 : -1) > 0.5 ? 2 : 3;
      if (!canStep(l, li, lj, dir)) continue;
      const h = hash5(ctx.seed, SALT.EXIT_SIGN, s, ((g.gi0 + li) * 4 + d) ^ STAIRS_TAG, g.gj0 + lj);
      if (hash01(h) >= STAIRS_SIGN_P) continue;
      cand.push({ c, d, h, along });
    }
  }
  cand.sort((p, q) => p.h - q.h || p.c - q.c || p.d - q.d);
  const done: [number, number][] = [];
  for (const e of cand) {
    if (done.length >= STAIRS_SIGN_MAX) break;
    const li = e.c & 31, lj = e.c >> 5;
    const f = wallFaceOf(li, lj, e.d);
    if (done.some(([x, z]) => (x - f.x) ** 2 + (z - f.z) ** 2 < 64)) continue;
    const y = l.floorCm[e.c] / 100 + 1.55;
    if (y + 0.2 > l.ceilCm[e.c] / 100 - 0.1) continue;
    const rx = f.nz, rz = -f.nx, sgn = e.along > 0 ? 1 : -1;
    // plate slightly off the face centre, arrow plate on the exit side of it
    const px = f.x - rx * sgn * 0.12, pz = f.z - rz * sgn * 0.12;
    g.addDecal({ kind: SignKind.STAIRS, sign: true, px, py: y, pz, nx: f.nx, ny: 0, nz: f.nz, rot: 0, w: 0.3, h: 0.3, alpha: 1 });
    g.addDecal({ kind: SignKind.ARROW_UP, sign: true, px: px + rx * sgn * 0.3, py: y, pz: pz + rz * sgn * 0.3, nx: f.nx, ny: 0, nz: f.nz, rot: sgn > 0 ? -Math.PI / 2 : Math.PI / 2, w: 0.26, h: 0.26, alpha: 1 });
    done.push([f.x, f.z]);
  }
}
