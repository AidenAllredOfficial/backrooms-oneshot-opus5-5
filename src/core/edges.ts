// src/core/edges.ts — THE single definition of what each edge kind is, used identically by the mesher (WP5),
// collision (WP12), light-bake visibility (WP7) and audio propagation (WP13). If these disagree, light leaks.
// t = metres along the edge from its start (0..CELL) (start = min x for ez edges, min z for ex edges).
// y = metres, storey-relative. hA/hB in centimetres (see EdgeKind comment in ids.ts).

import { ARCH_JAMB, CELL, DOOR_W, PARTITION_BASE_T, PARTITION_T, WALL_T } from './constants.ts';
import { EdgeKind } from './ids.ts';

//                                   OPEN   WALL   DOORWAY HEADER ARCH   PARTIT HALF   RAIL   WINDOW GLITCH
export const EDGE_RENDERS: readonly boolean[] = [false, true, true, true, true, true, true, true, true, true];
// GLITCH collides like a WALL; the noclip transition is a StructureKind.GLITCH portal in front of it (WP4/WP12).
export const EDGE_COLLIDES: readonly boolean[] = [false, true, true, true, true, true, true, true, true, true];
export const EDGE_OCCLUDES: readonly boolean[] = [false, true, true, true, true, true, true, false, true, true];
/** walkable for connectivity/pathing (a GLITCH edge is a secret: not counted). HEADER is passable if hA >= 190. */
export const EDGE_WALKABLE: readonly boolean[] = [true, false, true, true, true, false, false, false, false, false];
/** amplitude transmission for audio propagation (0 = blocks; wall transmission handled separately). */
export const EDGE_SOUND: readonly number[] = [1, 0, 0.9, 1, 1, 0.7, 0.6, 1, 0.8, 0];

export const edgeThickness = (kind: number): number =>
  kind === EdgeKind.OPEN ? 0 : kind === EdgeKind.PARTITION ? PARTITION_T : WALL_T;
/** Thickness at floor level (y < PARTITION_BASE_CM above the higher floor): PARTITION panels stand on a
 * PARTITION_BASE_T plinth that WP5 always emits. The no-leak invariant is stated on this value:
 * EDGE_OCCLUDES[k] => edgeBaseThickness(k) >= lmTexel(tpc) for every tpc (tests/core/invariants.test.ts).
 * Collision and bake visibility use edgeThickness (the plinth is below stepMax and inside the sample clamp). */
export const edgeBaseThickness = (kind: number): number =>
  kind === EdgeKind.PARTITION ? PARTITION_BASE_T : edgeThickness(kind);

/**
 * Solid pieces of an edge as axis-aligned rectangles in the edge plane: (t0,t1,y0,y1) quadruples written to
 * `out` (length >= 16). yLo = MIN floor, ySill = MAX floor, yHi = MAX ceiling of the two adjacent cells (metres).
 * Openings (DOORWAY/HEADER/ARCH/WINDOW) start at ySill: a full-width sill piece [yLo, ySill] closes the part
 * below the higher floor (this also seals the stacked vestibule copies of stair towers).
 * Returns the number of pieces. ARCH returns jambs + the block above the crown; its curved spandrel is
 * described exactly by edgeSolidAt (the mesher emits the curve; collision ignores it: it is above head height).
 */
export function edgePieces(kind: number, hA: number, hB: number, yLo: number, ySill: number, yHi: number, out: Float32Array): number {
  const a = hA / 100, b = hB / 100;
  const j = (CELL - DOOR_W) / 2;
  let n = 0;
  const put = (t0: number, t1: number, y0: number, y1: number): void => {
    if (y1 <= y0 || t1 <= t0) return;
    out[n * 4] = t0; out[n * 4 + 1] = t1; out[n * 4 + 2] = y0; out[n * 4 + 3] = y1; n++;
  };
  switch (kind) {
    case EdgeKind.WALL: case EdgeKind.GLITCH: put(0, CELL, yLo, yHi); break;
    case EdgeKind.DOORWAY: put(0, j, yLo, yHi); put(CELL - j, CELL, yLo, yHi); put(j, CELL - j, a, yHi); put(j, CELL - j, yLo, ySill); break;
    case EdgeKind.HEADER: put(0, CELL, a, yHi); put(0, CELL, yLo, ySill); break;
    case EdgeKind.ARCH: put(0, ARCH_JAMB, yLo, yHi); put(CELL - ARCH_JAMB, CELL, yLo, yHi); put(ARCH_JAMB, CELL - ARCH_JAMB, a, yHi); put(ARCH_JAMB, CELL - ARCH_JAMB, yLo, ySill); break;
    case EdgeKind.PARTITION: case EdgeKind.HALF: case EdgeKind.RAIL: put(0, CELL, yLo, a); break;
    case EdgeKind.WINDOW: put(0, CELL, yLo, Math.max(a, ySill)); put(0, CELL, b, yHi); break;
    default: break;
  }
  return n;
}

/** Point-in-solid test in the edge plane (used by light/sound visibility). Ignores EDGE_OCCLUDES.
 * ySill = MAX floor of the two adjacent cells (openings are solid below it); pass -Infinity if unknown. */
export function edgeSolidAt(kind: number, hA: number, hB: number, t: number, y: number, ySill = -Infinity): boolean {
  const a = hA / 100;
  if (y < ySill && (kind === EdgeKind.DOORWAY || kind === EdgeKind.HEADER || kind === EdgeKind.ARCH || kind === EdgeKind.WINDOW)) return true;
  switch (kind) {
    case EdgeKind.OPEN: return false;
    case EdgeKind.WALL: case EdgeKind.GLITCH: return true;
    case EdgeKind.DOORWAY: return Math.abs(t - CELL / 2) >= DOOR_W / 2 || y >= a;
    case EdgeKind.HEADER: return y >= a;
    case EdgeKind.ARCH: {
      const half = CELL / 2 - ARCH_JAMB; // opening half-width (radius of the round top)
      const dx = Math.abs(t - CELL / 2);
      if (dx >= half) return true;
      const spring = a - half;
      if (y <= spring) return false;
      const dy = y - spring;
      return dx * dx + dy * dy >= half * half;
    }
    case EdgeKind.PARTITION: case EdgeKind.HALF: case EdgeKind.RAIL: return y < a;
    case EdgeKind.WINDOW: return y < a || y >= hB / 100;
    default: return false;
  }
}

/** Light occlusion at a crossing point: EDGE_OCCLUDES[kind] && edgeSolidAt(...). */
export const edgeOccludesAt = (kind: number, hA: number, hB: number, t: number, y: number, ySill = -Infinity): boolean =>
  EDGE_OCCLUDES[kind] && edgeSolidAt(kind, hA, hB, t, y, ySill);

/** Default hA/hB for a kind (cm). */
export function edgeDefaults(kind: number): [number, number] {
  switch (kind) {
    case EdgeKind.DOORWAY: return [210, 0];
    case EdgeKind.HEADER: return [220, 0];
    case EdgeKind.ARCH: return [260, 0];
    case EdgeKind.PARTITION: return [150, 0];
    case EdgeKind.HALF: return [105, 0];
    case EdgeKind.RAIL: return [100, 0];
    case EdgeKind.WINDOW: return [95, 200];
    default: return [0, 0];
  }
}
