// src/lighting/Flashlight.ts (WP11) — the one runtime light. A SpotLight that is ALWAYS in the scene with
// castShadow ALWAYS true (constant light count and program set); off = intensity 0 + shadow.autoUpdate false.
// Rig: the light sits at the eye + camera-space offset (0.15, -0.2, 0) and aims along a direction that follows
// the camera through a critically damped rotation spring (omega 12), so fast turns lag slightly like a hand.

import * as THREE from 'three';
import type { GameBus } from '../core/events.ts';
import type { PlayerState } from '../core/player.ts';
import type { QualityConfig } from '../core/quality.ts';
import type { Flashlight } from '../core/runtime.ts';

export const FLASHLIGHT = {
  COLOR: 0xfff4e0,
  CD: 2000, // candela (R2-post: a real LED torch; 600 barely registered against the camcorder's max gain)
  DISTANCE: 25, // m; shadow.camera.far == distance (outside the shadow frustum three reports "lit")
  ANGLE: 0.35,
  PENUMBRA: 0.45,
  DECAY: 2,
  OFFSET: [0.15, -0.2, 0] as const, // camera space (right, up, back)
  OMEGA: 12,
  SHADOW_RADIUS: 3,
  NORMAL_BIAS: 0.02,
  SHADOW_NEAR: 0.1,
  CONVERGE: 3, // m: the beam converges horizontally on the view centre this far ahead (spot 0.2 m below centre)
} as const;

export interface FlashlightRig extends Flashlight {
  /** Quality change: shadow map size. */
  setQuality(q: QualityConfig): void;
  /** Aim from explicit pose (harness / tools). yaw/pitch/roll in the camera convention (Euler YXZ). */
  aim(x: number, y: number, z: number, yaw: number, pitch: number, roll: number, dt: number): void;
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
  light.map = cookie;
  light.castShadow = true;
  light.shadow.mapSize.set(q.flashlightShadow, q.flashlightShadow);
  light.shadow.radius = F.SHADOW_RADIUS;
  light.shadow.normalBias = F.NORMAL_BIAS;
  light.shadow.camera.near = F.SHADOW_NEAR;
  light.shadow.camera.far = F.DISTANCE;
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

  const fl: FlashlightRig = {
    light,
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
      if (Number.isFinite(player.eyeX)) fl.aim(player.eyeX, player.eyeY, player.eyeZ, player.camYaw, player.camPitch, player.camRoll, dt);
      else fl.aim(camera.position.x, camera.position.y, camera.position.z, camera.rotation.y, camera.rotation.x, camera.rotation.z, dt);
    },
    aim(x, y, z, yaw, pitch, roll, dt) {
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
      const lsy = Math.sin(lagYaw), lcy = Math.cos(lagYaw), lsp = Math.sin(lagPitch), lcp = Math.cos(lagPitch);
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
        light.shadow.mapSize.set(nq.flashlightShadow, nq.flashlightShadow);
        if (light.shadow.map) {
          light.shadow.map.dispose();
          (light.shadow as { map: THREE.WebGLRenderTarget | null }).map = null;
        }
        light.shadow.needsUpdate = true;
      }
    },
  };
  return fl;
}
