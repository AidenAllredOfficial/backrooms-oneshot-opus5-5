// src/player/cameraRig.ts (WP12) — turns the (interpolated) player state into the camera pose written to
// PlayerState.eyeX..camRoll: head bob (headBob.ts), sprint FOV kick (+3 deg, tau 0.4 s), handheld sway and the
// elevator ride shake (+-0.2 deg).
// Handheld (R2, B7): someone is holding this camera. A slow operator drift (0.12-0.3 Hz, dominant) plus the
// 3-octave hand noise (0.4-1.2 Hz), amplitude settings.cameraShake x 0.3 deg (0.5 -> ~0.15 deg), x1.35 while walking
// and x1.8 sprinting; camcorder mode raises it to 0.5 deg per unit (0.25 deg at the default, the old camcorder
// value). cameraShake 0 removes all of it (comfort). Frozen simulation time (time=): no sway at all (deterministic
// automation captures).
// Pure maths (no three / DOM); applyToCamera in PlayerSystem copies the pose onto the THREE camera.

import { PLAYER } from '../core/constants.ts';
import { valueNoise2 } from '../core/noise.ts';
import type { PlayerState } from '../core/player.ts';
import { createBobState, kickLanding, shiftBob, snapBob, updateBob, type BobState } from './headBob.ts';

const DEG = Math.PI / 180;
export const RIG = {
  fovKick: 3, fovTau: 0.4,
  camAmp: 0.25 * DEG, camSprint: 1.8, camOct: [0.4, 0.75, 1.2] as const, camW: [0.5, 0.3, 0.2] as const,
  /** handheld amplitude per unit of settings.cameraShake (camcorder mode: swayCam) */
  sway: 0.3 * DEG, swayCam: 0.5 * DEG, swayWalk: 1.35,
  driftOct: [0.12, 0.29] as const, driftW: [0.65, 0.35] as const, driftMix: 0.55,
  /** the octave sum has rms ~0.17 and peaks ~0.55: x1.8 makes `sway` the typical peak angle */
  swayNorm: 1.8,
  shakeAmp: 0.2 * DEG, shakeHz: [7.3, 11.9] as const, shakeY: 0.0015,
} as const;

export interface RigOptions {
  headBob: number; // settings.headBob (0..1)
  camcorder: boolean; // settings.film.camcorder
  /** settings.cameraShake (0..1); absent = 0.5 */
  cameraShake?: number;
  shake: number; // 0..1 elevator ride shake
  frozen: boolean; // simulation clock frozen: no bob / noise motion (deterministic captures)
}

export interface CameraRig {
  readonly bob: BobState;
  /** eased sprint FOV kick in degrees (added by applyToCamera) */
  readonly fovKick: number;
  snap(s: PlayerState): void;
  shiftY(dy: number): void;
  landing(impact: number): void;
  /** view: interpolated state (position, stride); out: the real state receiving eye/cam fields. t = sim time. */
  update(view: PlayerState, out: PlayerState, dt: number, t: number, o: RigOptions): void;
}

const noise1 = (seed: number, t: number): number => valueNoise2(seed, t, 0.5) * 2 - 1;

function handheld(seed: number, t: number): number {
  let v = 0;
  for (let k = 0; k < 3; k++) v += RIG.camW[k] * noise1(seed + k * 7919, t * RIG.camOct[k]);
  let d = 0;
  for (let k = 0; k < 2; k++) d += RIG.driftW[k] * noise1(seed + 0x9e37 + k * 104729, t * RIG.driftOct[k]);
  return (v * (1 - RIG.driftMix) + d * RIG.driftMix) * RIG.swayNorm; // peaks ~ +-1, rms ~0.3
}

/** Handheld sway amplitude (radians) for the settings, sprint blend k (0..1) and walking blend m (0..1). */
export function handheldAmp(cameraShake: number, camcorder: boolean, k: number, m: number): number {
  const u = Math.max(0, Math.min(1, cameraShake));
  if (u <= 0) return 0;
  const base = (camcorder ? RIG.swayCam : RIG.sway) * u;
  return base * (1 + (RIG.swayWalk - 1) * m) * (1 + (RIG.camSprint - 1) * k);
}

export function createCameraRig(s: PlayerState): CameraRig {
  const bob = createBobState(s.y + PLAYER.eye);
  let fovKick = 0;
  const rig: CameraRig = {
    bob,
    get fovKick() { return fovKick; },
    snap(st) { snapBob(bob, st); },
    shiftY(dy) { shiftBob(bob, dy); },
    landing(impact) { kickLanding(bob, impact); },
    update(view, out, dt, t, o) {
      const hb = o.frozen ? 0 : o.headBob;
      const b = updateBob(bob, view, dt, hb);
      const eyeBase = view.y + PLAYER.eye + (PLAYER.crouchEye - PLAYER.eye) * view.crouch;
      const rx = Math.cos(view.yaw), rz = -Math.sin(view.yaw);
      let yaw = view.yaw, pitch = view.pitch + b.pitch, roll = b.roll, ey = eyeBase + b.dy;
      // sprint FOV kick
      const k = Math.max(0, Math.min(1, (view.speed - PLAYER.walk) / (PLAYER.sprint - PLAYER.walk)));
      if (dt > 0) fovKick += (RIG.fovKick * k - fovKick) * (1 - Math.exp(-dt / RIG.fovTau));
      // handheld sway (sim time; none under frozen time so captures stay deterministic)
      if (!o.frozen) {
        const m = Math.max(0, Math.min(1, view.speed / PLAYER.walk)) * (1 - k);
        const a = handheldAmp(o.cameraShake ?? 0.5, o.camcorder, k, m);
        if (a > 0) {
          yaw += a * handheld(0x51a7, t);
          pitch += a * 0.8 * handheld(0x2b91, t);
          roll += a * 0.6 * handheld(0x77c3, t);
        }
      }
      if (o.shake > 0) {
        const a = RIG.shakeAmp * o.shake;
        const s1 = noise1(0x3131, t * RIG.shakeHz[0]), s2 = noise1(0x4747, t * RIG.shakeHz[1]);
        pitch += a * (0.6 * s1 + 0.4 * s2);
        roll += a * (0.5 * s2 - 0.5 * s1);
        ey += RIG.shakeY * o.shake * s2;
      }
      out.eyeX = view.x + rx * b.dx;
      out.eyeY = ey;
      out.eyeZ = view.z + rz * b.dx;
      out.camYaw = yaw;
      out.camPitch = Math.max(-1.55, Math.min(1.55, pitch));
      out.camRoll = roll;
    },
  };
  return rig;
}
