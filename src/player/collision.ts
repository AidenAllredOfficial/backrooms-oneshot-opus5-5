// src/player/collision.ts (WP12, PURE) — circle-vs-box move-and-slide against a CollisionWorld.
//
// The player is an XZ circle of radius PLAYER.radius. A box blocks when its y-range overlaps
// [feet + stepMax, feet + height]. Motion is split into pieces of at most MAX_PIECE metres (no tunnelling at any
// speed: a piece never moves the centre past a box's near face), each piece is resolved by PUSH_ITERS
// minimum-translation push-outs (Gauss-Seidel over the nearby boxes) and the into-wall velocity component is
// removed for every contact (sliding). Unloaded cells are solid: a piece whose centre would stand on a NaN floor
// is refused, and the circle is kept `radius` away from the boundary of an unloaded chunk.
// While grounded the feet follow the floor: step-ups <= stepMax happen as soon as the centre is over the higher
// surface; drops <= GROUND_SNAP are followed, larger drops are left to the controller (gravity).
// A walkable surface between feet + stepMax and the head (e.g. a stair flight seen from its side or from
// underneath) also blocks, so ramps behave as solid wedges; so does an overhang below the top of the head (the
// soffit under a flight, a low ceiling), also for the raised head after a step up. Both are sampled at the centre
// and at 4 rim points, so the body keeps its radius off ramps like off boxes.
// No allocation: results go to the module-level MOVE_RESULT (read it right after the call).

import { CHUNK_SIZE, PLAYER } from '../core/constants.ts';
import { worldToChunk } from '../core/grid.ts';
import type { PlayerState } from '../core/player.ts';
import type { CollisionWorld } from '../core/runtime.ts';

export const MAX_PIECE = 0.1; // m of motion per collision piece
export const PUSH_ITERS = 3;
export const GROUND_SNAP = 0.05; // drops up to this are followed while grounded; larger drops fall under gravity
export const BOX_STRIDE = 6;
/** Minimum scratch length for moveAndCollide / overlap queries. */
export const SCRATCH_BOXES = 512;
const EPS_PEN = 1e-7;
/** boxesNear margin beyond the swept circle: push-outs may move the centre sideways a little past the sweep. */
const QUERY_MARGIN = 0.2;
/** Residual penetration (m) a collision piece may end with (push-out rounding in concave corners). */
export const PEN_ACCEPT = 0.004;
const MAX_NORMALS = 8;
/** Overhangs up to this far below the top of the head are tolerated (Float32 boxes, cm-rounded ceilings). */
const HEAD_TOL = 0.005;
/** Rim sample distance (x radius) for ramp / overhang clearance. */
const RIM = 0.9;

export interface MoveResult {
  reqX: number; reqZ: number; // requested motion
  movX: number; movZ: number; // applied motion
  contacts: number; // push-outs applied
  nx: number; nz: number; // normal of the deepest contact (unit, pointing away from the box), 0 if none
  pen: number; // largest penetration left after the push-out iterations (m); > 0.005 means "stuck"
  blocked: boolean; // a piece was refused (unloaded / no floor / obstruction)
  stepped: number; // total step-up applied (m)
}
export const MOVE_RESULT: MoveResult = { reqX: 0, reqZ: 0, movX: 0, movZ: 0, contacts: 0, nx: 0, nz: 0, pen: 0, blocked: false, stepped: 0 };

const normals = new Float64Array(MAX_NORMALS * 2);
let nNormals = 0;
// resolve() output
let RX = 0, RZ = 0, RBEST = 0, RNX = 0, RNZ = 0;

/** true if a box with y-range [y0, y1] blocks a player whose feet are at `feet` and head at `head`. */
export const boxBlocks = (y0: number, y1: number, feet: number, head: number): boolean =>
  y0 < head - 1e-6 && y1 > feet + PLAYER.stepMax + 1e-6;

function addNormal(nx: number, nz: number): void {
  for (let i = 0; i < nNormals; i++) if (Math.abs(normals[i * 2] - nx) < 1e-3 && Math.abs(normals[i * 2 + 1] - nz) < 1e-3) return;
  if (nNormals >= MAX_NORMALS) return;
  normals[nNormals * 2] = nx; normals[nNormals * 2 + 1] = nz; nNormals++;
}

/** Push the circle at (x, z) out of the blocking boxes (PUSH_ITERS Gauss-Seidel passes). Writes RX, RZ, contact stats. */
function resolve(x: number, z: number, feet: number, head: number, boxes: Float32Array, n: number, record: boolean): void {
  const r = PLAYER.radius, r2 = r * r;
  RBEST = 0; RNX = 0; RNZ = 0;
  for (let it = 0; it < PUSH_ITERS; it++) {
    let any = false;
    for (let b = 0; b < n; b++) {
      const o = b * BOX_STRIDE;
      if (!boxBlocks(boxes[o + 1], boxes[o + 4], feet, head)) continue;
      const x0 = boxes[o], z0 = boxes[o + 2], x1 = boxes[o + 3], z1 = boxes[o + 5];
      const qx = x < x0 ? x0 : x > x1 ? x1 : x;
      const qz = z < z0 ? z0 : z > z1 ? z1 : z;
      const dx = x - qx, dz = z - qz;
      const d2 = dx * dx + dz * dz;
      if (d2 >= r2 - EPS_PEN) continue;
      let nx: number, nz: number, pen: number;
      if (d2 > 1e-14) {
        const d = Math.sqrt(d2);
        nx = dx / d; nz = dz / d; pen = r - d;
      } else {
        // centre inside the box: leave through the nearest face
        const l = x - x0, rr = x1 - x, t = z - z0, bb = z1 - z;
        let m = l; nx = -1; nz = 0;
        if (rr < m) { m = rr; nx = 1; nz = 0; }
        if (t < m) { m = t; nx = 0; nz = -1; }
        if (bb < m) { m = bb; nx = 0; nz = 1; }
        pen = m + r;
      }
      x += nx * pen; z += nz * pen;
      any = true;
      if (record) {
        MOVE_RESULT.contacts++;
        addNormal(nx, nz);
        if (pen > RBEST) { RBEST = pen; RNX = nx; RNZ = nz; }
      }
    }
    if (!any) break;
  }
  RX = x; RZ = z;
}

/** Largest penetration of the circle at (x, z) into the blocking boxes of `boxes` (no push-out). */
function penLocal(x: number, z: number, feet: number, head: number, boxes: Float32Array, n: number): number {
  const r = PLAYER.radius, r2 = r * r;
  let left = 0;
  for (let b = 0; b < n; b++) {
    const o = b * BOX_STRIDE;
    if (!boxBlocks(boxes[o + 1], boxes[o + 4], feet, head)) continue;
    const qx = x < boxes[o] ? boxes[o] : x > boxes[o + 3] ? boxes[o + 3] : x;
    const qz = z < boxes[o + 2] ? boxes[o + 2] : z > boxes[o + 5] ? boxes[o + 5] : z;
    const dx = x - qx, dz = z - qz;
    const d2 = dx * dx + dz * dz;
    if (d2 >= r2 - 1e-6) continue;
    const pen = d2 <= 1e-14 ? r + Math.min(x - boxes[o], boxes[o + 3] - x, z - boxes[o + 2], boxes[o + 5] - z) : r - Math.sqrt(d2);
    if (pen > left) left = pen;
  }
  return left;
}

/** Keeps the circle `radius` away from unloaded chunks along the motion (sx, sz). Writes RX, RZ. */
function clampLoaded(w: CollisionWorld, px: number, pz: number, x: number, z: number): void {
  const r = PLAYER.radius;
  const dx = x - px, dz = z - pz;
  if (dx !== 0) {
    const sg = dx > 0 ? 1 : -1;
    const ex = x + sg * r;
    if (!w.isLoaded(ex, z)) {
      const c = worldToChunk(ex);
      const boundary = sg > 0 ? c * CHUNK_SIZE : (c + 1) * CHUNK_SIZE;
      const lim = boundary - sg * (r + 1e-4);
      x = sg > 0 ? Math.min(x, Math.max(px, lim)) : Math.max(x, Math.min(px, lim));
      MOVE_RESULT.blocked = true;
    }
  }
  if (dz !== 0) {
    const sg = dz > 0 ? 1 : -1;
    const ez = z + sg * r;
    if (!w.isLoaded(x, ez)) {
      const c = worldToChunk(ez);
      const boundary = sg > 0 ? c * CHUNK_SIZE : (c + 1) * CHUNK_SIZE;
      const lim = boundary - sg * (r + 1e-4);
      z = sg > 0 ? Math.min(z, Math.max(pz, lim)) : Math.max(z, Math.min(pz, lim));
      MOVE_RESULT.blocked = true;
    }
  }
  RX = x; RZ = z;
}

/** Lowest overhang (ceiling, box or ramp underside: a stair flight's soffit) above the knees at (x, z). */
function headRoomAt(w: CollisionWorld, x: number, z: number, feet: number): number {
  const c = w.ceilingAt(x, z, feet + PLAYER.stepMax + 0.01);
  return c === c ? c : Infinity;
}

/** Clearance at one sample point: no walkable surface between the knees and the head (a stair flight from the
 * side or from underneath: ramps are solid wedges) and, with `head`, no overhang (a flight's soffit, a low
 * ceiling) below the top of the head. `feet` = current feet, `nf` = feet after a step up (>= feet). */
function clearAt(w: CollisionWorld, x: number, z: number, feet: number, nf: number, height: number, knee: boolean, head: boolean): boolean {
  if (knee) {
    const o = w.floorAt(x, z, nf + height - PLAYER.stepMax);
    if (o === o && o > feet + PLAYER.stepMax + 0.01 && o < nf + height) return false;
  }
  return !head || headRoomAt(w, x, z, nf) >= nf + height - HEAD_TOL;
}

/** Centre + 4 rim points (RIM x radius along the axes): ramps and ceilings are not boxes, so the push-out does not
 * keep the circle off them; the rim points do. Unloaded rim points are skipped (clampLoaded handles them). */
function bodyClear(w: CollisionWorld, x: number, z: number, feet: number, nf: number, height: number, knee: boolean, head: boolean, rim: boolean): boolean {
  if (!clearAt(w, x, z, feet, nf, height, knee, head)) return false;
  if (!rim) return true;
  const k = PLAYER.radius * RIM;
  return (!w.isLoaded(x + k, z) || clearAt(w, x + k, z, feet, nf, height, knee, head)) &&
    (!w.isLoaded(x - k, z) || clearAt(w, x - k, z, feet, nf, height, knee, head)) &&
    (!w.isLoaded(x, z + k) || clearAt(w, x, z + k, feet, nf, height, knee, head)) &&
    (!w.isLoaded(x, z - k) || clearAt(w, x, z - k, feet, nf, height, knee, head));
}

/** Can the centre stand at (x, z) with feet at `feet`? (loaded, has a floor, bodyClear). With `stepUp` (grounded)
 * the feet will follow a higher floor there: the body must also fit at that height (no box, no overhang within
 * the raised head). `knee` / `head` / `rim` are false when the start of the move already violates them (spawned or
 * pushed under an overhang or into a flight): the player can then always walk out. */
function standable(w: CollisionWorld, x: number, z: number, feet: number, height: number, stepUp: boolean, knee: boolean, head: boolean, rim: boolean, boxes: Float32Array, nb: number, lim: number): boolean {
  if (!w.isLoaded(x, z)) return false;
  const f = w.floorAt(x, z, feet);
  if (!(f === f)) return false; // NaN: unloaded
  if (f > feet + PLAYER.stepMax + 0.01) return false; // defensive: a floor out of step reach
  const nf = stepUp && f > feet ? f : feet;
  if (!bodyClear(w, x, z, feet, nf, height, knee, head, rim)) return false;
  // a step up raises the head: boxes that cleared it before may not any more
  if (nf > feet && penLocal(x, z, nf, nf + height, boxes, nb) > lim) return false;
  return true;
}

/**
 * Moves the player by (dx, dz) with collision. `height` = current body height (crouch-dependent).
 * `scratch` receives boxesNear output (length >= 6 * SCRATCH_BOXES recommended).
 */
export function moveAndCollide(w: CollisionWorld, s: PlayerState, dx: number, dz: number, height: number, scratch: Float32Array): void {
  const R = MOVE_RESULT;
  R.reqX = dx; R.reqZ = dz; R.movX = 0; R.movZ = 0; R.contacts = 0; R.nx = 0; R.nz = 0; R.pen = 0; R.blocked = false; R.stepped = 0;
  nNormals = 0;
  const x0 = s.x, z0 = s.z;
  const len = Math.sqrt(dx * dx + dz * dz);
  const pieces = Math.max(1, Math.ceil(len / MAX_PIECE - 1e-9));
  const r = PLAYER.radius;
  const n = w.boxesNear(x0 + dx * 0.5, z0 + dz * 0.5, r + len * 0.5 + QUERY_MARGIN, scratch);
  const nb = Math.min(n, (scratch.length / BOX_STRIDE) | 0);
  const sx = dx / pieces, sz = dz / pieces;
  let deepest = 0;
  // penetration of the current position: a piece may never end deeper than max(curPen, PEN_ACCEPT), so the centre
  // can never creep into a thin wall through unresolved corner conflicts (it would leave through the far face)
  let curPen = penLocal(x0, z0, s.y, s.y + height, scratch, nb);
  const stepUp = s.onGround && !s.fly;
  // head room / rim clearance are enforced only if the start has them (never trap a player who already lacks them)
  const kneeCheck = clearAt(w, x0, z0, s.y, s.y, height, true, false);
  const headCheck = clearAt(w, x0, z0, s.y, s.y, height, false, true);
  const rimCheck = bodyClear(w, x0, z0, s.y, s.y, height, kneeCheck, headCheck, true);
  for (let k = 0; k < pieces; k++) {
    const feet = s.y, head = s.y + height;
    const px = s.x, pz = s.z;
    const lim = Math.max(curPen, PEN_ACCEPT) + 1e-6;
    resolve(px + sx, pz + sz, feet, head, scratch, nb, true);
    if (RBEST > deepest) { deepest = RBEST; R.nx = RNX; R.nz = RNZ; }
    clampLoaded(w, px, pz, RX, RZ);
    let tx = RX, tz = RZ;
    let pen = penLocal(tx, tz, feet, head, scratch, nb);
    if (pen > lim || !standable(w, tx, tz, feet, height, stepUp, kneeCheck, headCheck, rimCheck, scratch, nb, lim)) {
      // try the axis-separated slides, then stay
      R.blocked = true;
      let ok = false;
      if (sx !== 0) {
        resolve(px + sx, pz, feet, head, scratch, nb, false);
        clampLoaded(w, px, pz, RX, RZ);
        const p1 = penLocal(RX, RZ, feet, head, scratch, nb);
        if (p1 <= lim && standable(w, RX, RZ, feet, height, stepUp, kneeCheck, headCheck, rimCheck, scratch, nb, lim)) { tx = RX; tz = RZ; pen = p1; ok = true; }
      }
      if (!ok && sz !== 0) {
        resolve(px, pz + sz, feet, head, scratch, nb, false);
        clampLoaded(w, px, pz, RX, RZ);
        const p2 = penLocal(RX, RZ, feet, head, scratch, nb);
        if (p2 <= lim && standable(w, RX, RZ, feet, height, stepUp, kneeCheck, headCheck, rimCheck, scratch, nb, lim)) { tx = RX; tz = RZ; pen = p2; ok = true; }
      }
      if (!ok) {
        // stay; still resolve penetration in place (closing doors) if that spot is standable and shallower
        resolve(px, pz, feet, head, scratch, nb, false);
        const p3 = RX !== px || RZ !== pz ? penLocal(RX, RZ, feet, head, scratch, nb) : Infinity;
        if (p3 < curPen && standable(w, RX, RZ, feet, height, stepUp, kneeCheck, headCheck, rimCheck, scratch, nb, lim)) { tx = RX; tz = RZ; pen = p3; } else { tx = px; tz = pz; pen = curPen; }
      }
    }
    curPen = pen;
    s.x = tx; s.z = tz;
    // ground follow
    if (s.onGround && !s.fly) {
      const f = w.floorAt(tx, tz, s.y);
      if (f === f && f >= s.y - GROUND_SNAP && f <= s.y + PLAYER.stepMax + 0.01) {
        if (f > s.y) R.stepped += f - s.y;
        s.y = f;
      }
    }
  }
  // penetration at the final position (feet may have stepped: re-measure)
  R.pen = penLocal(s.x, s.z, s.y, s.y + height, scratch, nb);
  R.movX = s.x - x0; R.movZ = s.z - z0;
  // sliding: remove the into-wall velocity component of every contact
  for (let i = 0; i < nNormals; i++) {
    const nx = normals[i * 2], nz = normals[i * 2 + 1];
    const vn = s.vx * nx + s.vz * nz;
    if (vn < 0) { s.vx -= vn * nx; s.vz -= vn * nz; }
  }
}

/** Largest penetration (m) of the circle at (x, z) into boxes blocking a body [feet, feet + height]. No allocation. */
export function penetrationAt(w: CollisionWorld, x: number, z: number, feet: number, height: number, scratch: Float32Array): number {
  const n = Math.min(w.boxesNear(x, z, PLAYER.radius + 0.05, scratch), (scratch.length / BOX_STRIDE) | 0);
  return penLocal(x, z, feet, feet + height, scratch, n);
}

/** true if a body of `height` fits at (x, z, feet): no box overlap beyond 1 mm and the ceiling is high enough. */
export function fitsAt(w: CollisionWorld, x: number, z: number, feet: number, height: number, scratch: Float32Array): boolean {
  if (penetrationAt(w, x, z, feet, height, scratch) > 0.001) return false;
  const c = w.ceilingAt(x, z, feet + 0.05);
  return !(c === c) || c >= feet + height - 1e-4;
}
