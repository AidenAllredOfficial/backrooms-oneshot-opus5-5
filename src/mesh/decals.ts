// src/mesh/decals.ts — WP5 decals (§5 WP5 rule 9): every DecalPlacement of the 3x3 neighbourhood becomes a quad
// 2 mm off its surface, clipped to this tile's cells (split at cell lines, owner = cell faced), in the separate
// `decals` buffer. Atlas slot uv follows the core/layout.ts `rot` convention (+v = forwardXZ(rot) on floors and
// ceilings; +v = +Y rotated counter-clockwise by rot as seen by a viewer in front of a wall). DECAL_PAINT_STRIPE uses
// FLOOR_PAINT with stripe-local metre uv (u across the stripe from 0 at one edge, v along it: the world coordinate plus
// a per-line hashed offset, so the pieces of a stripe clipped at chunk edges continue) and its width in mm in aux.x,
// so the shader knows the distance to the painted edge (edge flakes) and the recipe's wear bands run across the
// stripe (texture realism v2 lane B). The lightmap uv is borrowed from the surface underneath.
// Pure module.

import { CELL, CHUNK_SIZE, TILE_SIZE } from '../core/constants.ts';
import { DECAL_PAINT_STRIPE, DecalKind, Mat, VFlag } from '../core/ids.ts';
import { hash01, hash3 } from '../core/rng.ts';
import type { DecalPlacement } from '../core/layout.ts';
import type { CeilCharts } from './ceilings.ts';
import type { VFaceIndex } from './faceIndex.ts';
import { splitByCells } from './geom.ts';
import { BUF_DECALS, mkFace, state, type Plan, type V3 } from './plan.ts';
import { cix, type TileGrid } from './tileGrid.ts';
import { matRepeat, tintRGB } from './uv.ts';

const OFF = 0.002;

/** Unit (u, v) frame of a decal: +u right, +v "up" per the layout rot convention. */
export function decalFrame(d: DecalPlacement): { n: V3; u: V3; v: V3 } {
  const l = Math.hypot(d.nx, d.ny, d.nz) || 1;
  const n: V3 = [d.nx / l, d.ny / l, d.nz / l];
  const c = Math.cos(d.rot), s = Math.sin(d.rot);
  if (Math.abs(n[1]) > 0.9) {
    const v: V3 = [-s, 0, -c]; // forwardXZ(rot)
    const u: V3 = [v[1] * n[2] - v[2] * n[1], v[2] * n[0] - v[0] * n[2], v[0] * n[1] - v[1] * n[0]]; // v x n
    return { n, u, v };
  }
  // wall: rot 0 => +v = +Y, u0 = +Y x n (viewer's right); rotate counter-clockwise (as seen from the front)
  const hl = Math.hypot(n[0], n[2]) || 1;
  const u0: V3 = [n[2] / hl, 0, -n[0] / hl];
  const v0: V3 = [0, 1, 0];
  const v: V3 = [c * v0[0] - s * u0[0], c * v0[1] - s * u0[1], c * v0[2] - s * u0[2]];
  const u: V3 = [c * u0[0] + s * v0[0], c * u0[1] + s * v0[1], c * u0[2] + s * v0[2]];
  return { n, u, v };
}

export function emitDecals(plan: Plan, g: TileGrid, idx: VFaceIndex, cc: CeilCharts): void {
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      const lay = g.nb.get(dx as -1 | 0 | 1, dz as -1 | 0 | 1);
      const ox = dx * CHUNK_SIZE - g.ox, oz = dz * CHUNK_SIZE - g.oz;
      const gx0 = (g.tile.cx + dx) * CHUNK_SIZE, gz0 = (g.tile.cz + dz) * CHUNK_SIZE;
      for (const d of lay.decals) emitDecal(plan, g, idx, cc, d, d.px + ox, d.py, d.pz + oz, gx0 + d.px, gz0 + d.pz);
    }
  }
}

/** Slot-local sub-rectangle ([0,1]^2 of the atlas slot) mapped onto the quad, with optional flips. */
interface SlotRect { u0: number; v0: number; u1: number; v1: number }
const FULL: SlotRect = { u0: 0, v0: 0, u1: 1, v1: 1 };
/** Stain-like slots whose artwork may be mirrored per placement (never the oriented ones: arrows, drips, rust). */
const FLIPPABLE = new Set<number>([DecalKind.WATER_STAIN, DecalKind.OIL, DecalKind.CRACK, DecalKind.BURN, DecalKind.SCUFF]);
/** Parking stencil digit cells (atlas slot PARKING_NUMBER: 2 rows x 5 digits, textures/decals.ts). */
export function digitRect(n: number): SlotRect {
  const col = n % 5, row = n < 5 ? 0 : 1;
  const cx = 0.5 - 0.36 + 0.18 * col, cy = row === 0 ? 0.5 + 0.225 : 0.5 - 0.225;
  return { u0: cx - 0.085, u1: cx + 0.085, v0: cy - 0.16, v1: cy + 0.16 };
}
/** Bay number (1..99) of a parking column stencil at global (gx, gz): consecutive along a column row. */
// (column centres sit on the 1.2 m cell lattice: gx / 7.2 has fractions k / 6, gz / 6 has fractions k / 5 +- 0.05 for
// the stencil face; the offsets keep every floor() argument away from an integer)
export const parkingNumber = (gx: number, gz: number): number =>
  1 + ((((Math.floor(gx / 7.2 + 1 / 12) + 17 * Math.floor(gz / 6 + 0.1)) % 99) + 99) % 99);

function emitDecal(plan: Plan, g: TileGrid, idx: VFaceIndex, cc: CeilCharts, d: DecalPlacement, px: number, py: number, pz: number, gx: number, gz: number): void {
  const r = (Math.abs(d.w) + Math.abs(d.h)) / 2 + 0.01;
  if (px < -r || pz < -r || px > TILE_SIZE + r || pz > TILE_SIZE + r || !(d.w > 0) || !(d.h > 0)) return;
  const { n, u, v } = decalFrame(d);
  const stripe = !d.sign && d.kind === DECAL_PAINT_STRIPE;
  const slot = d.kind & 15;
  const hw = d.w / 2, hh = d.h / 2;
  if (!d.sign && !stripe && slot === DecalKind.PARKING_NUMBER) {
    // two stencilled digits side by side from the 0-9 strip
    const num = parkingNumber(gx, gz);
    const dig = [Math.floor(num / 10), num % 10];
    for (let i = 0; i < 2; i++) {
      const s = (i - 0.5) * hw;
      emitQuad(plan, g, idx, cc, d, n, u, v, px + u[0] * s, py + u[1] * s, pz + u[2] * s, hw / 2, hh, digitRect(dig[i]), false, false);
    }
    return;
  }
  let rect = FULL, fu = false, fv = false;
  if (!d.sign && !stripe && FLIPPABLE.has(slot)) {
    const h = hash3(Math.round(gx * 100), Math.round(gz * 100), Math.round(py * 100) ^ 0x5d3c);
    fu = (h & 1) !== 0;
    fv = Math.abs(n[1]) > 0.9 && (h & 2) !== 0; // walls keep "up": drips and tide lines stay on top
    if (slot === DecalKind.WATER_STAIN && Math.abs(n[1]) < 0.5) {
      // a humidity stain standing on the floor: the upper half of the blob, stretched onto the quad, so the stain
      // rises from a flat bottom along the floor line with a ragged tide-line top
      const [ci, cj] = g.cellAt(px + n[0] * 0.3, pz + n[2] * 0.3);
      if (g.inWin(ci, cj) && Math.abs(py - hh - g.floor(cix(ci, cj))) < 0.05) rect = { u0: 0, u1: 1, v0: 0.5, v1: 0.97 };
    }
  }
  emitQuad(plan, g, idx, cc, d, n, u, v, px, py, pz, hw, hh, rect, fu, fv, stripe ? stripeV0(n, u, v, gx, gz, py, hh) : 0);
}

/**
 * Stripe v (units of the FLOOR_PAINT repeat) at the stripe's start edge: the world coordinate along the stripe plus a
 * hash of its line (the across coordinate and height), modulo the texture period. The layouts clip long stripes at
 * chunk edges, and the pieces of one line then continue one wear pattern; parallel lines get their own.
 */
export function stripeV0(n: V3, u: V3, v: V3, gx: number, gz: number, py: number, hh: number): number {
  const along = gx * v[0] + gz * v[2], across = gx * u[0] + gz * u[2];
  const off = hash01(hash3(Math.round(across * 100), Math.round(py * 100), Math.round(n[1] * 8) ^ 0x2f1d));
  const t = (along - hh) / matRepeat(Mat.FLOOR_PAINT) + off;
  return t - Math.floor(t);
}

function emitQuad(plan: Plan, g: TileGrid, idx: VFaceIndex, cc: CeilCharts, d: DecalPlacement, n: V3, u: V3, v: V3, px: number, py: number, pz: number,
  hw: number, hh: number, rect: SlotRect, fu: boolean, fv: boolean, vStart = 0): void {
  const cx = px + n[0] * OFF, cy = py + n[1] * OFF, cz = pz + n[2] * OFF;
  const p: number[] = [];
  const ab: number[] = []; // slot-local (a, b) along +u, +v
  for (const [a, b] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
    const su = (a - 0.5) * 2 * hw, sv = (b - 0.5) * 2 * hh;
    p.push(cx + u[0] * su + v[0] * sv, cy + u[1] * su + v[1] * sv, cz + u[2] * su + v[2] * sv);
    const ta = fu ? 1 - a : a, tb = fv ? 1 - b : b;
    ab.push(rect.u0 + (rect.u1 - rect.u0) * ta, rect.v0 + (rect.v1 - rect.v0) * tb);
  }
  const stripe = !d.sign && d.kind === DECAL_PAINT_STRIPE;
  const layer = stripe ? Mat.FLOOR_PAINT : d.sign ? Mat.SIGNAGE : Mat.DECAL_ATLAS;
  const slot = d.kind & 15;
  const col = d.color ?? [1, 1, 1];
  const alpha = Math.max(0, Math.min(1, d.alpha ?? 1));
  // stripes: aux.x = width in mm; v continues along the line from vStart (stripeV0)
  const auxX = stripe ? Math.max(1, Math.min(255, Math.round(hw * 2000))) : 0;
  const st = state(layer, VFlag.DECAL | VFlag.NO_GRIME, tintRGB(col[0], col[1], col[2], Math.round(alpha * 255)), d.emit ?? 0, auxX, BUF_DECALS);
  const floorLike = n[1] > 0.9, ceilLike = n[1] < -0.9;
  const rep = matRepeat(layer);
  for (const [pp, uv] of splitByCells(p, ab, 2, CELL, TILE_SIZE)) {
    const nv = pp.length / 3;
    let mx = 0, my = 0, mz = 0;
    for (let i = 0; i < pp.length; i += 3) { mx += pp[i]; my += pp[i + 1]; mz += pp[i + 2]; }
    mx /= nv; my /= nv; mz /= nv;
    const [ci, cj] = g.cellAt(mx + n[0] * 0.01, mz + n[2] * 0.01);
    if (!g.inTile(ci, cj)) continue;
    const k = cix(ci, cj);
    if (g.isSolid(k)) continue;
    const muv: number[] = [];
    for (let i = 0; i < nv; i++) {
      if (stripe) muv.push((uv[i * 2] * 2 * hw) / rep, (uv[i * 2 + 1] * 2 * hh) / rep + vStart);
      else muv.push(((slot % 4) + uv[i * 2]) / 4, (Math.floor(slot / 4) + uv[i * 2 + 1]) / 4);
    }
    const f = mkFace(pp, muv, n[0], n[1], n[2], st);
    if (floorLike) { plan.borrow(f, plan.floorGrid); continue; }
    if (ceilLike) { plan.borrow(f, cc.of(k, ci, cj)); continue; }
    // wall-like: the own face underneath (same normal, plane within 3 cm)
    const axisX = Math.abs(n[0]) >= Math.abs(n[2]);
    const behind = idx.find(k, axisX ? Math.sign(n[0]) : 0, axisX ? 0 : Math.sign(n[2]), axisX ? px : pz, axisX ? mz : mx, my, 0.03);
    if (behind) { plan.borrowFrom(f, behind); continue; }
    // fallback: the floor grid just inside the owner cell
    const lm = pp.slice();
    for (let i = 0; i < lm.length; i += 3) { lm[i] += n[0] * 0.05; lm[i + 2] += n[2] * 0.05; }
    f.lm = lm;
    plan.borrow(f, plan.floorGrid);
  }
}
