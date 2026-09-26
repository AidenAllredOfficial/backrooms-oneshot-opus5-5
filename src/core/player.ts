// src/core/player.ts — player state shared by controller (WP12), audio (WP13), lighting (WP11), app/debug (WP14).

import type { StoreyId, SurfaceSoundId } from './ids.ts';

export interface PlayerInput {
  moveX: number; // -1..1 strafe (right +)
  moveZ: number; // -1..1 forward (+)
  lookDX: number; // pixels this frame (already sensitivity-free)
  lookDY: number;
  sprint: boolean;
  crouch: boolean;
  flashlightPressed: boolean; // edge-triggered
  interactPressed: boolean;
}

export interface PlayerState {
  s: StoreyId;
  x: number; y: number; z: number; // feet position, world metres (y storey-relative)
  vx: number; vy: number; vz: number;
  yaw: number; pitch: number;
  crouch: number; // 0 standing .. 1 crouched (smoothed)
  onGround: boolean;
  surface: SurfaceSoundId;
  waterDepth: number; // m of water above feet (0 if dry)
  speed: number; // horizontal m/s
  stridePhase: number; // continuous; footstep at each integer crossing (lowest camera point)
  fatigue: number; // 0..1 (sprint > 10 s raises; drives breathing + sprint speed decay)
  stillFor: number; // seconds without horizontal movement (audio dread gating)
  fly: boolean;
  target: number; // PropKind of the interactable currently targeted (<= 1.6 m, in view), -1 if none (WP14 centre dot)
  // camera rig outputs (world), computed by WP12 CameraRig each frame
  eyeX: number; eyeY: number; eyeZ: number; camYaw: number; camPitch: number; camRoll: number;
}

export function createPlayerState(s: StoreyId, x: number, y: number, z: number, yaw: number, pitch: number): PlayerState {
  return {
    s, x, y, z, vx: 0, vy: 0, vz: 0, yaw, pitch, crouch: 0, onGround: true, surface: 0, waterDepth: 0, speed: 0,
    stridePhase: 0, fatigue: 0, stillFor: 0, fly: false, target: -1, eyeX: x, eyeY: y + 1.62, eyeZ: z, camYaw: yaw, camPitch: pitch, camRoll: 0,
  };
}
