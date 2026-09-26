// src/player/controller.ts (WP12, PURE) — one fixed sub-step of the player controller.
//
// Velocity: v += (target - v)(1 - e^(-k dt)), k = kAccel speeding up, kDecel slowing/stopping, kSprint when
// speeding up into a sprint. Modifiers: wading x(1 - 0.6 min(depth/1, 1)), crouch (0.22 s smoothstep; standing
// up needs head room; refused while waterDepth > crouchEye - 0.15), sprint fatigue (after 25 s of sprinting the
// sprint speed decays to sprintTired over 5 s; recovers at 2x while not sprinting).
// R2 (B7) pace: walk 1.75 m/s (stride 0.75 m, ~2.3 Hz cadence), sprint 4.0, tired 3.2; the walk pace in play follows
// settings.walkSpeed (WALK_SPEEDS; PlayerSystem swaps the config), the attract walk / autowalk keep the default.
// Collision: collision.ts moveAndCollide (step-up <= stepMax, ground follow); drops > GROUND_SNAP fall under
// gravity and a landing emits `land`. Footsteps: `stridePhase += distance / stride`, a `footstep` at every integer
// crossing (the bob minimum) plus a soft `settle` step when stopping from > 0.8 m/s. Breathing: `breath` at 2 Hz
// while its values change. Unstuck: > 0.5 s inside a box => nearest free cell centre (spiral, 3 cells).
// fly: noclip flight at 4 m/s along the look direction, vertical on up (Space) / crouch (C).
//
// Per-player controller memory that PlayerState does not carry lives in a WeakMap keyed by the state object
// (`controllerExtra(s)`); PlayerSystem and the traversal modules use it for clamps and holds.

import { CELL, PLAYER } from '../core/constants.ts';
import type { Emit } from '../core/events.ts';
import { worldToCell } from '../core/grid.ts';
import type { PlayerInput, PlayerState } from '../core/player.ts';
import type { CollisionWorld } from '../core/runtime.ts';
import { fitsAt, GROUND_SNAP, MOVE_RESULT, moveAndCollide, SCRATCH_BOXES } from './collision.ts';

export interface ControllerConfig { walk: number; sprint: number; sprintTired: number; crouch: number; kAccel: number; kDecel: number; kSprint: number }

export const DEFAULT_CONTROLLER: ControllerConfig = {
  walk: PLAYER.walk, sprint: PLAYER.sprint, sprintTired: PLAYER.sprintTired, crouch: PLAYER.crouch, kAccel: 10, kDecel: 12, kSprint: 6,
};

export const CROUCH_TIME = 0.22;
export const FLY_SPEED = 4;
export const FATIGUE_START = 25; // s of continuous sprint (R2: was 10; a sparse infinite world needs longer runs)
export const FATIGUE_RAMP = 5; // s to decay to sprintTired
export const BREATH_START = 4; // s of sprint before breathing becomes audible
export const STRIDE = { walk: 0.75, sprint: 1.12, crouch: 0.52 } as const;
/** settings.walkSpeed -> walk speed (m/s). 'normal' is PLAYER.walk. */
export const WALK_SPEEDS = { slow: 1.45, normal: PLAYER.walk, brisk: 2.0 } as const;
export const SETTLE_FROM = 0.8; // m/s
export const UNSTUCK_AFTER = 0.5; // s
export const MAX_FALL = 20; // m/s
const PITCH_MAX = 1.5;
const STEP_TOL = 0.01; // m of Float32 / rounding slack on the step-up limit

/** Optional extension of PlayerInput written by player/input.ts: fly-mode ascend (Space). */
export interface PlayerInputExt extends PlayerInput { up?: boolean }

/** Controller memory not carried by PlayerState. */
export interface ControllerExtra {
  crouchP: number; // linear crouch progress 0..1 (s.crouch = smoothstep(crouchP))
  crouchRefused: boolean; // crouch was wanted but refused (water / head room) this step
  sprintT: number; // seconds of "continuous" sprint (decreases at 2x when not sprinting)
  sprinting: boolean;
  settleArmed: boolean;
  stuckT: number;
  unstuckCount: number;
  breathT: number;
  breathRate: number; breathDepth: number; // last emitted values
  landImpact: number; // impact speed of the last landing (consumed by the camera rig; 0 = none pending)
  /** traversal clamps on the feet height (NaN = none): tower clamp-until-prefetched, pit hold */
  yMin: number; yMax: number;
  /** traversal hold: no movement, no gravity (glitch/pit warp in progress) */
  hold: boolean;
  /** input direction (world, unit or 0) of the last step, and the collision outcome (glitch push detection) */
  inX: number; inZ: number;
  reqX: number; reqZ: number; movX: number; movZ: number; hitNX: number; hitNZ: number;
  scratch: Float32Array;
}

const EXTRA = new WeakMap<PlayerState, ControllerExtra>();

export function controllerExtra(s: PlayerState): ControllerExtra {
  let e = EXTRA.get(s);
  if (!e) {
    e = {
      crouchP: 0, crouchRefused: false, sprintT: 0, sprinting: false, settleArmed: false, stuckT: 0, unstuckCount: 0,
      breathT: 0, breathRate: 0.25, breathDepth: 0, landImpact: 0, yMin: NaN, yMax: NaN, hold: false,
      inX: 0, inZ: 0, reqX: 0, reqZ: 0, movX: 0, movZ: 0, hitNX: 0, hitNZ: 0,
      scratch: new Float32Array(SCRATCH_BOXES * 6),
    };
    EXTRA.set(s, e);
  }
  return e;
}

const smooth01 = (t: number): number => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** Mouse/stick look (pixels * sensitivity). Called once per frame by PlayerSystem; stepPlayer applies i.look too. */
export function applyLook(s: PlayerState, i: PlayerInput, sensitivity: number, invertY: boolean): void {
  if (i.lookDX !== 0) {
    let y = s.yaw - i.lookDX * sensitivity;
    if (y > Math.PI) y -= 2 * Math.PI; else if (y < -Math.PI) y += 2 * Math.PI;
    s.yaw = y;
  }
  if (i.lookDY !== 0) s.pitch = clamp(s.pitch - i.lookDY * sensitivity * (invertY ? -1 : 1), -PITCH_MAX, PITCH_MAX);
}

/** Current body height (crouch-dependent). */
export const bodyHeight = (s: PlayerState): number => PLAYER.height + (PLAYER.crouchHeight - PLAYER.height) * s.crouch;
/** Current eye height above the feet (crouch-dependent). */
export const eyeHeight = (s: PlayerState): number => PLAYER.eye + (PLAYER.crouchEye - PLAYER.eye) * s.crouch;
/** Stride length for the current gait. */
export function strideLength(s: PlayerState, cfg: ControllerConfig = DEFAULT_CONTROLLER): number {
  const k = clamp((s.speed - cfg.walk) / (cfg.sprint - cfg.walk), 0, 1);
  const upright = STRIDE.walk + (STRIDE.sprint - STRIDE.walk) * k;
  return upright + (STRIDE.crouch - upright) * s.crouch;
}

/** Nearest free cell centre within 3 cells (rings by Chebyshev distance, nearest first). Cells whose floor is
 * within step reach of the current feet are preferred (never lift the player onto a counter or a ledge when a
 * floor-level cell is free); a second pass accepts floors up to 1 m higher. */
function unstuck(s: PlayerState, w: CollisionWorld, height: number, scratch: Float32Array): boolean {
  return unstuckPass(s, w, height, scratch, PLAYER.stepMax + STEP_TOL) || unstuckPass(s, w, height, scratch, 1.0 + PLAYER.stepMax);
}

function unstuckPass(s: PlayerState, w: CollisionWorld, height: number, scratch: Float32Array, rise: number): boolean {
  const gi = worldToCell(s.x), gj = worldToCell(s.z);
  for (let d = 0; d <= 3; d++) {
    let best = -1, bx = 0, bz = 0, by = 0;
    for (let dj = -d; dj <= d; dj++) {
      for (let di = -d; di <= d; di++) {
        if (Math.max(Math.abs(di), Math.abs(dj)) !== d) continue;
        const cx = (gi + di + 0.5) * CELL, cz = (gj + dj + 0.5) * CELL;
        if (!w.isLoaded(cx, cz)) continue;
        const f = w.floorAt(cx, cz, s.y + rise - PLAYER.stepMax);
        if (!(f === f) || f < s.y - 3 || f > s.y + rise) continue;
        if (!fitsAt(w, cx, cz, f, height, scratch)) continue;
        const dd = (cx - s.x) * (cx - s.x) + (cz - s.z) * (cz - s.z);
        if (best < 0 || dd < best) { best = dd; bx = cx; bz = cz; by = f; }
      }
    }
    if (best >= 0) {
      s.x = bx; s.z = bz; s.y = by; s.vx = 0; s.vz = 0; s.vy = 0; s.onGround = true;
      return true;
    }
  }
  return false;
}

function flyStep(s: PlayerState, i: PlayerInputExt, dt: number, cfg: ControllerConfig): void {
  const cy = Math.cos(s.pitch), sy = Math.sin(s.pitch);
  const fx = -Math.sin(s.yaw) * cy, fy = sy, fz = -Math.cos(s.yaw) * cy;
  const rx = Math.cos(s.yaw), rz = -Math.sin(s.yaw);
  const up = (i.up ? 1 : 0) - (i.crouch ? 1 : 0);
  let tx = fx * i.moveZ + rx * i.moveX, ty = fy * i.moveZ + up, tz = fz * i.moveZ + rz * i.moveX;
  const len = Math.sqrt(tx * tx + ty * ty + tz * tz);
  const sp = FLY_SPEED * (i.sprint ? 2.5 : 1);
  if (len > 1) { tx /= len; ty /= len; tz /= len; }
  tx *= sp; ty *= sp; tz *= sp;
  const a = 1 - Math.exp(-(len > 0.01 ? cfg.kAccel : cfg.kDecel) * dt);
  s.vx += (tx - s.vx) * a; s.vy += (ty - s.vy) * a; s.vz += (tz - s.vz) * a;
  s.x += s.vx * dt; s.y += s.vy * dt; s.z += s.vz * dt;
  s.speed = Math.sqrt(s.vx * s.vx + s.vz * s.vz);
  s.onGround = false;
  s.stillFor = s.speed < 0.05 ? s.stillFor + dt : 0;
}

export function stepPlayer(s: PlayerState, i: PlayerInput, dt: number, w: CollisionWorld, cfg: ControllerConfig, emit: Emit, sensitivity: number, invertY: boolean): void {
  applyLook(s, i, sensitivity, invertY);
  if (!(dt > 0)) return;
  const c = controllerExtra(s);
  if (s.fly) {
    c.crouchP = 0; s.crouch = 0; c.sprintT = 0; s.fatigue = 0;
    flyStep(s, i as PlayerInputExt, dt, cfg);
    return;
  }
  if (c.hold) {
    s.vx = 0; s.vy = 0; s.vz = 0; s.speed = 0; c.inX = 0; c.inZ = 0; c.reqX = c.reqZ = c.movX = c.movZ = 0;
    s.stillFor += dt;
    return;
  }

  // ---------------------------------------------------------------- water
  const wy = w.waterAt(s.x, s.z);
  s.waterDepth = wy !== null && wy === wy ? Math.max(0, wy - s.y) : 0;

  // ---------------------------------------------------------------- crouch (0.22 s smoothstep, head room, water)
  const waterBlocksCrouch = s.waterDepth > PLAYER.crouchEye - 0.15;
  let wantCrouch = i.crouch && !waterBlocksCrouch;
  c.crouchRefused = i.crouch && waterBlocksCrouch;
  if (!wantCrouch && c.crouchP > 0) {
    // standing up (further) needs room for the full height
    if (!fitsAt(w, s.x, s.z, s.y, PLAYER.height, c.scratch)) {
      wantCrouch = true;
      if (!i.crouch) c.crouchRefused = true;
    }
  }
  c.crouchP = clamp(c.crouchP + (wantCrouch ? dt : -dt) / CROUCH_TIME, 0, 1);
  s.crouch = smooth01(c.crouchP);
  const height = bodyHeight(s);

  // ---------------------------------------------------------------- input direction
  let mx = i.moveX, mz = i.moveZ;
  let mag = Math.sqrt(mx * mx + mz * mz);
  if (mag > 1) { mx /= mag; mz /= mag; mag = 1; }
  const sinY = Math.sin(s.yaw), cosY = Math.cos(s.yaw);
  const fx = -sinY, fz = -cosY; // forward
  const rx = cosY, rz = -sinY; // right
  let dirX = fx * mz + rx * mx, dirZ = fz * mz + rz * mx;
  if (mag > 1e-6) { c.inX = dirX / mag; c.inZ = dirZ / mag; } else { c.inX = 0; c.inZ = 0; dirX = 0; dirZ = 0; }

  // ---------------------------------------------------------------- sprint + fatigue
  const sprintWanted = i.sprint && mz > 0.3 && s.crouch < 0.3 && s.waterDepth < 0.45 && s.onGround;
  c.sprinting = sprintWanted;
  if (sprintWanted && s.speed > cfg.walk * 0.9) c.sprintT = Math.min(FATIGUE_START + FATIGUE_RAMP, c.sprintT + dt);
  else if (!sprintWanted) c.sprintT = Math.max(0, c.sprintT - 2 * dt);
  s.fatigue = clamp((c.sprintT - FATIGUE_START) / FATIGUE_RAMP, 0, 1);

  let speed = sprintWanted ? cfg.sprint + (cfg.sprintTired - cfg.sprint) * s.fatigue : cfg.walk;
  speed += (cfg.crouch - speed) * s.crouch;
  speed *= 1 - 0.6 * Math.min(s.waterDepth / 1.0, 1);
  const tvx = dirX * speed, tvz = dirZ * speed;

  // ---------------------------------------------------------------- velocity
  const cur = Math.sqrt(s.vx * s.vx + s.vz * s.vz);
  const tgt = speed * mag;
  let k: number;
  if (tgt > cur + 1e-4) k = sprintWanted && cur >= cfg.walk * 0.95 ? cfg.kSprint : cfg.kAccel;
  else k = cfg.kDecel;
  const a = 1 - Math.exp(-k * dt);
  s.vx += (tvx - s.vx) * a;
  s.vz += (tvz - s.vz) * a;

  // ---------------------------------------------------------------- move + collide
  const px = s.x, pz = s.z;
  moveAndCollide(w, s, s.vx * dt, s.vz * dt, height, c.scratch);
  c.reqX = MOVE_RESULT.reqX; c.reqZ = MOVE_RESULT.reqZ; c.movX = MOVE_RESULT.movX; c.movZ = MOVE_RESULT.movZ;
  c.hitNX = MOVE_RESULT.nx; c.hitNZ = MOVE_RESULT.nz;
  const ddx = s.x - px, ddz = s.z - pz;
  const dist = Math.sqrt(ddx * ddx + ddz * ddz);
  // effective speed = what actually happened (walls stop the stride too)
  s.speed = Math.min(dist / dt, Math.sqrt(s.vx * s.vx + s.vz * s.vz) + 1e-3);

  // ---------------------------------------------------------------- vertical
  let floor = w.floorAt(s.x, s.z, s.y);
  let hasFloor = floor === floor;
  if (hasFloor) {
    if (c.yMin === c.yMin && floor < c.yMin) floor = c.yMin;
    if (c.yMax === c.yMax && floor > c.yMax) floor = c.yMax;
    // a surface out of step reach under the centre (a WorldQuery may report the lowest surface ABOVE the step
    // reach instead of -Infinity) is not a floor to snap onto: hold the height like an unknown floor
    if (floor > s.y + PLAYER.stepMax + STEP_TOL) hasFloor = false;
  }
  if (!hasFloor) {
    // unloaded under the feet: hold height (never fall into the unknown)
    s.vy = 0;
  } else if (s.onGround) {
    if (floor < s.y - GROUND_SNAP) { s.onGround = false; s.vy = 0; } else s.y = floor;
  }
  if (hasFloor && !s.onGround) {
    const y0 = s.y;
    s.vy = Math.max(-MAX_FALL, s.vy - PLAYER.gravity * dt);
    s.y += s.vy * dt;
    // landing: any surface between the old and new feet (queried from the old height so thin slabs are not missed)
    let f = w.floorAt(s.x, s.z, y0);
    if (f === f) {
      if (c.yMin === c.yMin && f < c.yMin) f = c.yMin;
      if (c.yMax === c.yMax && f > c.yMax) f = c.yMax;
      if (s.y <= f && f <= y0 + PLAYER.stepMax + STEP_TOL) {
        const impact = -s.vy;
        s.y = f; s.vy = 0; s.onGround = true;
        c.landImpact = Math.max(c.landImpact, impact);
        s.surface = w.surfaceAt(s.x, s.z, s.y);
        emit('land', { surface: s.surface, impact, x: s.x, y: s.y, z: s.z });
      }
    }
  }
  if (c.yMin === c.yMin && s.y < c.yMin) { s.y = c.yMin; s.vy = 0; s.onGround = true; }
  if (c.yMax === c.yMax && s.y > c.yMax) { s.y = c.yMax; s.vy = Math.min(0, s.vy); }

  // ---------------------------------------------------------------- surface, water, stillness
  s.surface = w.surfaceAt(s.x, s.z, s.y);
  const wy2 = w.waterAt(s.x, s.z);
  s.waterDepth = wy2 !== null && wy2 === wy2 ? Math.max(0, wy2 - s.y) : 0;
  s.stillFor = s.speed < 0.05 ? s.stillFor + dt : 0;

  // ---------------------------------------------------------------- stride + footsteps
  if (s.onGround && dist > 0) {
    const prev = s.stridePhase;
    s.stridePhase += dist / strideLength(s, cfg);
    const step = Math.floor(s.stridePhase);
    if (step > Math.floor(prev)) {
      const kS = clamp((s.speed - cfg.walk) / (cfg.sprint - cfg.walk), 0, 1);
      const intensity = s.crouch > 0.5 ? 0.3 : 0.6 + 0.4 * kS;
      emit('footstep', { surface: s.surface, intensity, foot: (step & 1) as 0 | 1, x: s.x, y: s.y, z: s.z, waterDepth: s.waterDepth, settle: false });
    }
  }
  if (s.speed > SETTLE_FROM && s.onGround) c.settleArmed = true;
  if (c.settleArmed && mag < 0.05 && s.speed < 0.25 && s.onGround) {
    c.settleArmed = false;
    const foot = ((Math.floor(s.stridePhase) + 1) & 1) as 0 | 1;
    emit('footstep', { surface: s.surface, intensity: 0.35, foot, x: s.x, y: s.y, z: s.z, waterDepth: s.waterDepth, settle: true });
  }

  // ---------------------------------------------------------------- breathing (2 Hz while changing)
  c.breathT += dt;
  if (c.breathT >= 0.5) {
    c.breathT -= 0.5;
    const exert = clamp((c.sprintT - BREATH_START) / (FATIGUE_START - BREATH_START), 0, 1);
    const depth = Math.max(exert * 0.8, s.fatigue);
    const rate = 0.25 + 0.55 * depth; // breaths per second
    if (Math.abs(depth - c.breathDepth) > 0.01 || Math.abs(rate - c.breathRate) > 0.01) {
      c.breathDepth = depth; c.breathRate = rate;
      emit('breath', { rate, depth });
    }
  }

  // ---------------------------------------------------------------- unstuck
  if (MOVE_RESULT.pen > 0.005) {
    c.stuckT += dt;
    if (c.stuckT > UNSTUCK_AFTER) {
      c.stuckT = 0;
      if (unstuck(s, w, height, c.scratch)) c.unstuckCount++;
    }
  } else c.stuckT = 0;
}

/** Immediate unstuck (spawn inside a wall, teleports). Returns true if the player was moved. */
export function unstuckNow(s: PlayerState, w: CollisionWorld): boolean {
  const c = controllerExtra(s);
  return unstuck(s, w, bodyHeight(s), c.scratch);
}

/** Reset transient controller memory (teleport). */
export function resetController(s: PlayerState): void {
  const c = controllerExtra(s);
  c.stuckT = 0; c.settleArmed = false; c.landImpact = 0; c.yMin = NaN; c.yMax = NaN; c.hold = false;
  c.inX = c.inZ = c.reqX = c.reqZ = c.movX = c.movZ = c.hitNX = c.hitNZ = 0;
}
