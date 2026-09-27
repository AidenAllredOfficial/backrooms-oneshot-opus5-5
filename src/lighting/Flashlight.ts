// src/lighting/Flashlight.ts (WP11) — the one runtime light. A SpotLight that is ALWAYS in the scene with
// castShadow ALWAYS true (constant light count and program set); off = intensity 0 + shadow.autoUpdate false.
// Photometry and beam shape come from lighting/flashlightOptics.ts (package F): a 5500 cd LED reflector beam (a ~9 deg
// hotspot, a dim spill fading out by 37 deg) reaching 40 m, shaped by the cookie texture.
// Rig: the light sits at the eye + camera-space offset (0.15, -0.2, 0) and aims along a direction that follows
// the camera through a critically damped rotation spring (omega 12), so fast turns lag slightly like a hand. A small
// hand sway (breathing, gait, tremor) moves the aim only; it advances only on normal frames (0 < dt <= 0.25), so
// frozen-time captures never sway.

import * as THREE from 'three';
import type { GameBus } from '../core/events.ts';
import type { PlayerState } from '../core/player.ts';
import type { QualityConfig } from '../core/quality.ts';
import type { Flashlight } from '../core/runtime.ts';
import { LAYER_LATE } from '../materials/shared.ts';
import { FLASHLIGHT_OPTICS } from './flashlightOptics.ts';

export const FLASHLIGHT = {
  COLOR: 0xfff4e0,
  CD: FLASHLIGHT_OPTICS.PEAK_CD, // candela at the beam axis (the cookie is 1 there)
  DISTANCE: FLASHLIGHT_OPTICS.RANGE, // m; shadow.camera.far == distance (outside the shadow frustum three reports "lit")
  ANGLE: FLASHLIGHT_OPTICS.CONE, // just beyond the spill's soft rim; the cookie spans this cone x MAP_FOCUS
  PENUMBRA: FLASHLIGHT_OPTICS.PENUMBRA, // three's ramp lies beyond the cookie's rim
  DECAY: 2,
  OFFSET: [0.15, -0.2, 0] as const, // camera space (right, up, back)
  OMEGA: 12,
  SHADOW_RADIUS: 3,
  NORMAL_BIAS: 0.02,
  SHADOW_NEAR: 0.1,
  CONVERGE: 3, // m: the beam converges horizontally on the view centre this far ahead (spot 0.2 m below centre)
} as const;

/** Hand sway of the aim (rad; added to the lagged yaw / pitch). Breathing at 0.23 Hz scaled by fatigue, a gait term
 * locked to the stride (one sideways swing per step, a dip at each footfall) and a small incommensurate tremor.
 * Peak |yaw| while walking briskly stays below ~0.011 rad (0.6 deg). */
export const SWAY = {
  BREATH_HZ: 0.23,
  BREATH_YAW: 0.0035,
  BREATH_PITCH: 0.003,
  GAIT_YAW: 0.005,
  GAIT_PITCH: 0.004,
  GAIT_SPEED: 1.75, // m/s of a walk: the gait weight is speed / GAIT_SPEED ...
  GAIT_MAX: 1.2, // ... capped here (sprinting swings the arm no wider)
  TREMOR: 0.0006,
  /** dt above this is a hitch or a teleport: the sway holds (the aim spring snaps anyway) */
  MAX_DT: 0.25,
} as const;

/** Gait / breathing state for the sway (PlayerState fields). */
export interface SwayInput { speed: number; stridePhase: number; fatigue: number }

/** Sway angles (rad) at sway time `swayT` (s, advanced by real frames only) for a gait state, written into out[0]
 * (yaw) and out[1] (pitch). Exactly zero at swayT = 0 when standing still. */
export function handSway(swayT: number, g: SwayInput, out: Float64Array): void {
  const b = 0.3 + 0.7 * Math.min(1, Math.max(0, g.fatigue || 0));
  const w = Math.min(SWAY.GAIT_MAX, Math.max(0, (g.speed || 0) / SWAY.GAIT_SPEED));
  const ph = Math.PI * (g.stridePhase || 0);
  const br = 2 * Math.PI * SWAY.BREATH_HZ * swayT;
  // the breathing and tremor terms start from 0 at swayT = 0 (sin(x + c) - sin(c)), so the first frames never jump
  out[0] = SWAY.BREATH_YAW * b * Math.sin(br) + SWAY.GAIT_YAW * w * Math.sin(ph)
    + SWAY.TREMOR * (Math.sin(3.1 * swayT) + Math.sin(4.7 * swayT + 2) - Math.sin(2));
  out[1] = SWAY.BREATH_PITCH * b * (Math.sin(br + 1.1) - Math.sin(1.1)) + SWAY.GAIT_PITCH * w * (Math.abs(Math.sin(ph)) - 0.63);
}

export interface FlashlightRig extends Flashlight {
  /** Quality change: shadow map size. */
  setQuality(q: QualityConfig): void;
  /** Aim from explicit pose (harness / tools). yaw/pitch/roll in the camera convention (Euler YXZ). `gait` (the
   * player's speed, stride phase and fatigue) adds the hand sway; without it the aim does not sway. */
  aim(x: number, y: number, z: number, yaw: number, pitch: number, roll: number, dt: number, gait?: SwayInput): void;
  /** Camera-space basis of the last aim (right, up), world unit vectors: the bounce VPLs spread around the beam axis
   * in this frame so their pattern turns with the view. */
  readonly basis: { rx: number; ry: number; rz: number; ux: number; uy: number; uz: number };
}

/** Critically damped spring step toward target (exact solution): returns new value, writes velocity to v[i]. */
function spring(x: number, target: number, v: Float64Array, i: number, omega: number, dt: number): number {
  const d = x - target;
  const e = Math.exp(-omega * dt);
  const tmp = (v[i] + omega * d) * dt;
  v[i] = (v[i] - omega * tmp) * e;
  return target + (d + tmp) * e;
}
const wrapPi = (a: number): number => a - 2 * Math.PI * Math.floor((a + Math.PI) / (2 * Math.PI));

export function createFlashlight(scene: THREE.Scene, cookie: THREE.Texture | null, q: QualityConfig, bus: GameBus | null): FlashlightRig {
  const F = FLASHLIGHT;
  const light = new THREE.SpotLight(F.COLOR, 0, F.DISTANCE, F.ANGLE, F.PENUMBRA, F.DECAY);
  light.name = 'flashlight';
  // three filters lights by the camera's layers on every render: the late render (LAYER_LATE only) must still see
  // the torch, or water and sparks programs compile with NUM_SPOT_LIGHTS 0
  light.layers.enable(LAYER_LATE);
  light.map = cookie;
  light.castShadow = true;
  light.shadow.mapSize.set(q.flashlightShadow, q.flashlightShadow);
  light.shadow.radius = F.SHADOW_RADIUS;
  light.shadow.normalBias = F.NORMAL_BIAS;
  light.shadow.camera.near = F.SHADOW_NEAR;
  light.shadow.camera.far = F.DISTANCE;
  // the cookie and the shadow map span the cone plus a margin (tan(theta) = |p| * tan(ANGLE * MAP_FOCUS)): three reads
  // the cookie at the normal-biased position, and outside the map it would light with the bare cone
  light.shadow.focus = FLASHLIGHT_OPTICS.MAP_FOCUS;
  light.shadow.autoUpdate = false;
  // Render the shadow map once so it is allocated: with autoUpdate off and no map, three binds the shadow sampler
  // to a non-depth texture and every lit draw fails (GL_INVALID_OPERATION). Keeps the map valid from frame 1.
  light.shadow.needsUpdate = true;
  light.target.name = 'flashlight.target';
  scene.add(light);
  scene.add(light.target);

  const vel = new Float64Array(2);
  let lagYaw = 0;
  let lagPitch = 0;
  let primed = false;
  let swayT = 0; // s of real (non-frozen, non-hitch) frames since boot
  const sway = new Float64Array(2);
  const basis = { rx: 1, ry: 0, rz: 0, ux: 0, uy: 1, uz: 0 };

  const fl: FlashlightRig = {
    light,
    basis,
    on: false,
    set(on) {
      const changed = on !== fl.on;
      fl.on = on;
      light.intensity = on ? F.CD : 0;
      light.shadow.autoUpdate = on;
      if (on) light.shadow.needsUpdate = true;
      if (changed && bus) bus.emit('flashlight', { on });
    },
    update(player: PlayerState, camera: THREE.Camera, dt: number) {
      // The rig follows the WP12 camera-rig outputs of THIS frame (applyToCamera runs later in the loop).
      if (Number.isFinite(player.eyeX)) fl.aim(player.eyeX, player.eyeY, player.eyeZ, player.camYaw, player.camPitch, player.camRoll, dt, player);
      else fl.aim(camera.position.x, camera.position.y, camera.position.z, camera.rotation.y, camera.rotation.x, camera.rotation.z, dt);
    },
    aim(x, y, z, yaw, pitch, roll, dt, gait) {
      // the sway runs on live frames only: frozen or paused time (dt = 0, where the aim spring also snaps) shows the
      // plain aim, so time= captures never sway; a hitch holds the sway clock
      if (gait && dt > 0) {
        if (dt <= SWAY.MAX_DT) swayT += dt;
        handSway(swayT, gait, sway);
      } else { sway[0] = 0; sway[1] = 0; }
      if (!primed || !(dt > 0) || dt > 0.25) {
        // first frame, frozen time (deterministic shots) or a hitch/teleport: snap
        lagYaw = yaw; lagPitch = pitch; vel[0] = 0; vel[1] = 0; primed = true;
      } else {
        const ty = lagYaw + wrapPi(yaw - lagYaw);
        lagYaw = spring(lagYaw, ty, vel, 0, F.OMEGA, dt);
        lagPitch = spring(lagPitch, pitch, vel, 1, F.OMEGA, dt);
        lagYaw = wrapPi(lagYaw);
      }
      // camera basis (Euler YXZ): forward (-sin y cos p, sin p, -cos y cos p), right (cos y, 0, -sin y) rotated by roll
      const sy = Math.sin(yaw), cy = Math.cos(yaw), sp = Math.sin(pitch), cp = Math.cos(pitch);
      const sr = Math.sin(roll), cr = Math.cos(roll);
      const fx = -sy * cp, fyv = sp, fz = -cy * cp;
      const rx0 = cy, rz0 = -sy; // right (no roll)
      const ux0 = sy * sp, uy0 = cp, uz0 = cy * sp; // up = right x forward... (no roll)
      const rx = rx0 * cr + ux0 * sr, ry = uy0 * sr, rz = rz0 * cr + uz0 * sr;
      const ux = -rx0 * sr + ux0 * cr, uy = uy0 * cr, uz = -rz0 * sr + uz0 * cr;
      const ox = F.OFFSET[0], oy = F.OFFSET[1], oz = F.OFFSET[2];
      const px = x + rx * ox + ux * oy - fx * oz;
      const py = y + ry * ox + uy * oy - fyv * oz;
      const pz = z + rz * ox + uz * oy - fz * oz;
      light.position.set(px, py, pz);
      basis.rx = rx; basis.ry = ry; basis.rz = rz; basis.ux = ux; basis.uy = uy; basis.uz = uz;
      const aimYaw = lagYaw + sway[0], aimPitch = lagPitch + sway[1];
      const lsy = Math.sin(aimYaw), lcy = Math.cos(aimYaw), lsp = Math.sin(aimPitch), lcp = Math.cos(aimPitch);
      // aim converged toward the view centre CONVERGE m ahead (the offset otherwise shifts the spot down-right)
      // horizontally the beam converges on the view centre; vertically it stays parallel to the view (the target
      // keeps the rig's downward offset), so it never tilts up into the ceiling beyond the convergence point
      const conv = F.CONVERGE;
      light.target.position.set(
        x + (-lsy * lcp) * conv + ux * oy,
        y + lsp * conv + uy * oy,
        z + (-lcy * lcp) * conv + uz * oy,
      );
      light.target.updateMatrixWorld();
    },
    setQuality(nq) {
      if (light.shadow.mapSize.x !== nq.flashlightShadow) {
        // three (r186) resizes the existing map at its next shadow render (WebGLShadowMap: map.setSize when mapSize
        // differs) and fills it in the same call. Disposing it here left the lit draws before that render (the planar
        // reflection, the next frame's first passes) with no depth texture behind the shadow sampler: a burst of
        // GL_INVALID_OPERATION on every quality switch that changes the map size (e.g. high <-> ultra).
        light.shadow.mapSize.set(nq.flashlightShadow, nq.flashlightShadow);
        light.shadow.needsUpdate = true;
      }
    },
  };
  return fl;
}
