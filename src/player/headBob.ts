// src/player/headBob.ts (WP12, PURE) — footstep-locked head bob, landing dip, breathing, strafe/yaw roll,
// stairs smoothing.
//
// Numbers (atmosphere proposal, §5 WP12 "Feel"):
//   vertical  A_v (sin(pi frac) - 0.637)     zero-mean, lowest at heel strike (frac = 0 = footstep)
//   lateral   A_l sin(pi (step + frac))      alternates per step
//   roll      R lateral / A_l
//   gait      walk A_v 0.028 A_l 0.018 R 0.4deg | sprint 0.05 0.03 0.8deg | crouch 0.012 (no lateral/roll)
//   amplitude eases with tau 0.15 s and is scaled by settings.headBob
//   idle breathing 0.004 m at 0.23 Hz + 0.12deg pitch; strafe lean 0.6deg; yaw-rate roll <= 0.5deg
//   landing   spring dip min(0.12, 0.03 v_impact), k 90, c 14 (b.landing / b.landingV; kick with kickLanding)
//   stairs    eye height follows a critically damped spring (omega 18) (b.eyeY / b.eyeV)
// Output offsets are in the camera frame: dx along the camera right vector, dy up, roll/pitch in radians.
// `dy` is relative to the un-smoothed eye (feet + eye height): it contains the stairs-spring lag too, so
// eyeY = s.y + eyeHeight(s) + dy.

import { PLAYER } from '../core/constants.ts';
import type { PlayerState } from '../core/player.ts';

export interface BobState {
  phase: number; amp: number; landing: number; landingV: number; eyeY: number; eyeV: number; roll: number; breath: number;
  /** previous yaw (yaw-rate roll); NaN = unknown */
  yawPrev?: number;
  /** smoothed yaw rate (rad/s) */
  yawRate?: number;
}

const DEG = Math.PI / 180;
export const BOB = {
  walk: { av: 0.028, al: 0.018, r: 0.4 * DEG },
  sprint: { av: 0.05, al: 0.03, r: 0.8 * DEG },
  crouch: { av: 0.012 },
  tau: 0.15,
  mean: 2 / Math.PI, // 0.637: mean of sin(pi t) over [0,1]
  breathM: 0.004, breathHz: 0.23, breathPitch: 0.12 * DEG,
  lean: 0.6 * DEG, yawRoll: 0.5 * DEG, yawRollAt: 2.5, // rad/s for the full yaw roll
  landK: 90, landC: 14, landMax: 0.12, landPerV: 0.03,
  stairsOmega: 18,
} as const;

// peak displacement of the landing spring for a unit initial velocity (underdamped, zeta = c / (2 sqrt k))
const LAND_W = Math.sqrt(BOB.landK);
const LAND_Z = BOB.landC / (2 * LAND_W);
const LAND_WD = LAND_W * Math.sqrt(1 - LAND_Z * LAND_Z);
const LAND_TP = Math.atan2(Math.sqrt(1 - LAND_Z * LAND_Z), LAND_Z) / LAND_WD;
const LAND_PEAK_PER_V = (Math.exp(-LAND_Z * LAND_W * LAND_TP) * Math.sin(LAND_WD * LAND_TP)) / LAND_WD;

export function createBobState(eyeY: number): BobState {
  return { phase: 0, amp: 0, landing: 0, landingV: 0, eyeY, eyeV: 0, roll: 0, breath: 0, yawPrev: NaN, yawRate: 0 };
}

/** Landing kick: the spring dips by min(0.12, 0.03 * impact) metres at its lowest point. */
export function kickLanding(b: BobState, impact: number): void {
  const dip = Math.min(BOB.landMax, BOB.landPerV * Math.max(0, impact));
  if (dip <= 0) return;
  b.landingV = Math.min(b.landingV, -dip / LAND_PEAK_PER_V);
}

/** Snap the smoothing springs to the current state (teleports); `shift` moves them by dy (tower switch, no pop). */
export function snapBob(b: BobState, s: PlayerState): void {
  b.eyeY = s.y + PLAYER.eye + (PLAYER.crouchEye - PLAYER.eye) * s.crouch;
  b.eyeV = 0; b.landing = 0; b.landingV = 0; b.yawPrev = NaN;
}
export function shiftBob(b: BobState, dy: number): void { b.eyeY += dy; }

const OUT = { dx: 0, dy: 0, roll: 0, pitch: 0 }; // reused result (no per-frame allocation)
const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
const smooth = (e0: number, e1: number, x: number): number => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };

/** Gait blend for the current state: k = walk..sprint (0..1), c = crouch (0..1). */
function nominalAv(k: number, c: number): number {
  const up = BOB.walk.av + (BOB.sprint.av - BOB.walk.av) * k;
  return up + (BOB.crouch.av - up) * c;
}

export function updateBob(b: BobState, s: PlayerState, dt: number, headBob: number): { dx: number; dy: number; roll: number; pitch: number } {
  const hb = clamp(headBob, 0, 1);
  const k = clamp((s.speed - PLAYER.walk) / (PLAYER.sprint - PLAYER.walk), 0, 1);
  const c = clamp(s.crouch, 0, 1);
  const moving = s.onGround ? smooth(0.12, 0.7, s.speed) : 0;
  const target = s.y + PLAYER.eye + (PLAYER.crouchEye - PLAYER.eye) * c;

  if (dt > 0) {
    // amplitude easing
    const avT = nominalAv(k, c) * moving;
    b.amp += (avT - b.amp) * (1 - Math.exp(-dt / BOB.tau));
    // stairs: exact critically damped spring toward the eye target
    {
      const w = BOB.stairsOmega;
      let x = b.eyeY - target;
      if (!(x === x) || Math.abs(x) > 2) x = 0; // teleport / first frame
      const v = b.eyeV;
      const e = Math.exp(-w * dt);
      const q = v + w * x;
      b.eyeY = target + (x + q * dt) * e;
      b.eyeV = (v - w * q * dt) * e;
    }
    // landing spring: exact underdamped solution of x'' + c x' + k x = 0 (frame-rate independent)
    {
      const x0 = b.landing, v0 = b.landingV;
      if (x0 !== 0 || v0 !== 0) {
        const a = LAND_Z * LAND_W;
        const e = Math.exp(-a * dt), co = Math.cos(LAND_WD * dt), si = Math.sin(LAND_WD * dt);
        b.landing = e * (x0 * co + ((v0 + a * x0) / LAND_WD) * si);
        b.landingV = e * (v0 * co - ((LAND_W * LAND_W * x0 + a * v0) / LAND_WD) * si);
        if (Math.abs(b.landing) < 1e-6 && Math.abs(b.landingV) < 1e-5) { b.landing = 0; b.landingV = 0; }
      }
    }
    // breathing phase (faster when fatigued)
    b.breath += dt * 2 * Math.PI * (BOB.breathHz + 0.35 * s.fatigue);
    if (b.breath > 2 * Math.PI) b.breath -= 2 * Math.PI;
    // yaw rate
    const yp = b.yawPrev ?? NaN;
    let yr = 0;
    if (yp === yp) {
      let d = s.yaw - yp;
      if (d > Math.PI) d -= 2 * Math.PI; else if (d < -Math.PI) d += 2 * Math.PI;
      yr = d / dt;
    }
    b.yawPrev = s.yaw;
    const yrs = (b.yawRate ?? 0) + (yr - (b.yawRate ?? 0)) * (1 - Math.exp(-dt / 0.12));
    b.yawRate = yrs;
    // lean + yaw roll (smoothed)
    const rx = Math.cos(s.yaw), rz = -Math.sin(s.yaw);
    const strafe = (s.vx * rx + s.vz * rz) / PLAYER.walk;
    const leanT = -BOB.lean * clamp(strafe, -1, 1) + BOB.yawRoll * clamp(yrs / BOB.yawRollAt, -1, 1);
    b.roll += (leanT - b.roll) * (1 - Math.exp(-dt / 0.12));
    b.phase = s.stridePhase;
  }

  // gait shape
  const ph = s.stridePhase;
  const frac = ph - Math.floor(ph);
  const sinPh = Math.sin(Math.PI * ph); // = sin(pi (step + frac)): alternates sign per step
  const vert = b.amp * (Math.sin(Math.PI * frac) - BOB.mean);
  const nom = nominalAv(k, c);
  const norm = nom > 1e-6 ? b.amp / nom : 0; // 0..1 eased gait amplitude
  const upright = 1 - c;
  const al = (BOB.walk.al + (BOB.sprint.al - BOB.walk.al) * k) * upright;
  const rr = (BOB.walk.r + (BOB.sprint.r - BOB.walk.r) * k) * upright;
  const lat = al * norm * sinPh;
  const rollBob = rr * norm * sinPh;
  // idle breathing (fades out while walking)
  const idle = 1 - smooth(0.05, 0.5, s.speed);
  const bm = 1 + 1.5 * s.fatigue;
  const breathY = BOB.breathM * bm * Math.sin(b.breath) * idle;
  const breathP = BOB.breathPitch * bm * Math.sin(b.breath - 0.6) * idle;

  OUT.dx = lat * hb;
  OUT.dy = (b.eyeY - target) + (vert + breathY + b.landing) * hb;
  OUT.roll = (rollBob + b.roll) * hb;
  OUT.pitch = (breathP + b.landing * 0.35) * hb;
  return OUT;
}
