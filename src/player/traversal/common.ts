// src/player/traversal/common.ts (WP12) — shared context and portal helpers for the traversal modules
// (tower, elevator, glitch, pit, doors). The PlayerSystem owns one TraversalCtx and passes it every call.

import type { Emit } from '../../core/events.ts';
import type { StoreyId } from '../../core/ids.ts';
import type { PlayerInput, PlayerState } from '../../core/player.ts';
import type { CollisionWorld, PortalHit } from '../../core/runtime.ts';
import type { ControllerExtra } from '../controller.ts';
import type { TraversalHost } from '../PlayerSystem.ts';

export interface TraversalCtx {
  readonly state: PlayerState;
  readonly extra: ControllerExtra;
  readonly host: TraversalHost;
  emit: Emit;
  /** collision world incl. virtual boxes (door leaves) */
  world: CollisionWorld;
  /** the world as passed to PlayerSystem.update (a WorldQuery at runtime: layoutAt is used for door frames) */
  raw: CollisionWorld;
  input: PlayerInput;
  /** portals within PROXIMITY_R, refreshed every PROXIMITY_S (and right after storey changes) */
  readonly portals: PortalHit[];
  portalCount: number;
  /** request a portal refresh at the next opportunity (storey changed) */
  refreshPortals(): void;
  /** the feet were shifted by dy (tower switch): shift interpolation + camera springs, no pop */
  onShift(dy: number): void;
  /** the player was moved discontinuously (warp): snap interpolation + camera springs */
  onTeleported(): void;
  /** elevator ride camera shake 0..1 (written by the elevator module) */
  shake: number;
}

export const PROXIMITY_R = 12; // m
export const PROXIMITY_S = 0.25; // s
export const STOREYS = 3;
export const down = (s: StoreyId): StoreyId => ((s + 1) % STOREYS) as StoreyId;
export const up = (s: StoreyId): StoreyId => ((s + 2) % STOREYS) as StoreyId;

/** World-space AABB test of a portal trigger volume (pad grows it in x/z). */
export function inPortal(h: PortalHit, x: number, y: number, z: number, pad = 0): boolean {
  const m = h.spec.min, M = h.spec.max;
  return x >= h.ox + m[0] - pad && x <= h.ox + M[0] + pad && z >= h.oz + m[2] - pad && z <= h.oz + M[2] + pad && y >= m[1] && y <= M[1];
}
export function inPortalXZ(h: PortalHit, x: number, z: number, pad = 0): boolean {
  const m = h.spec.min, M = h.spec.max;
  return x >= h.ox + m[0] - pad && x <= h.ox + M[0] + pad && z >= h.oz + m[2] - pad && z <= h.oz + M[2] + pad;
}
export const portalCX = (h: PortalHit): number => h.ox + (h.spec.min[0] + h.spec.max[0]) / 2;
export const portalCZ = (h: PortalHit): number => h.oz + (h.spec.min[2] + h.spec.max[2]) / 2;
/** Stable identity of a portal across storeys / refreshes. */
export const portalKey = (h: PortalHit): string =>
  `${h.spec.kind}:${h.spec.towerId}:${Math.round(h.ox + h.spec.min[0])}:${Math.round(h.oz + h.spec.min[2])}`;
/** Same portal (same kind + same world footprint), independent of the object identity. */
export function samePortal(a: PortalHit, b: PortalHit): boolean {
  return a.spec.kind === b.spec.kind && a.spec.towerId === b.spec.towerId &&
    Math.abs(a.ox + a.spec.min[0] - (b.ox + b.spec.min[0])) < 1e-3 && Math.abs(a.oz + a.spec.min[2] - (b.oz + b.spec.min[2])) < 1e-3 &&
    Math.abs(a.ox + a.spec.max[0] - (b.ox + b.spec.max[0])) < 1e-3 && Math.abs(a.oz + a.spec.max[2] - (b.oz + b.spec.max[2])) < 1e-3;
}
