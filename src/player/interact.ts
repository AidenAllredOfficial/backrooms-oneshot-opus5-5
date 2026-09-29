// src/player/interact.ts (WP12) — interactable targeting and the `interact` event.
// Each frame: state.target = world.propAt(x, z, yaw, 1.6)?.kind ?? -1, only while |pitch| < 0.6 (looking roughly
// level). On interactPressed: bus 'interact' {propKind, x, y, z, yaw, seed} (propKind -1 if nothing is targeted;
// then the position is the player's feet). WP13 plays the matching sound, WP14 shows the centre dot.

import type { Emit } from '../core/events.ts';
import type { PlayerState } from '../core/player.ts';
import type { CollisionWorld, PropHit } from '../core/runtime.ts';

export const INTERACT_DIST = 1.6;
export const INTERACT_PITCH = 0.6;

/** Updates state.target; returns the targeted prop (or null). */
export function updateTarget(s: PlayerState, w: CollisionWorld): PropHit | null {
  const hit = Math.abs(s.pitch) < INTERACT_PITCH && !s.fly ? w.propAt(s.x, s.z, s.yaw, INTERACT_DIST) : null;
  s.target = hit ? hit.kind : -1;
  return hit;
}

export function updateInteract(s: PlayerState, w: CollisionWorld, pressed: boolean, emit: Emit, useDoor?: (hit: PropHit) => 'open' | 'close' | undefined): PropHit | null {
  const hit = updateTarget(s, w);
  if (!pressed) return hit;
  if (hit) emit('interact', { propKind: hit.kind, x: hit.x, y: hit.y, z: hit.z, yaw: s.yaw, seed: hit.seed, door: useDoor?.(hit) });
  else emit('interact', { propKind: -1, x: s.x, y: s.y, z: s.z, yaw: s.yaw, seed: 0 });
  return hit;
}
