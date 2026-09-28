// src/stream/priorities.ts — desired set, hysteresis, look-ahead and job priorities (WP10). No three, no DOM:
// pure functions of their arguments (unit-tested in tests/stream/priorities.test.ts).
//
// Priority (lower = sooner):  base = ring*20 + (inFrustum ? 0 : 30) + distance*2
//                             + job offset (layout -90, build -70, bake +60) + (prefetch ? 400 : 0)
//                             + (own chunk and not a bake ? -1000 : 0) + (bake && inFrustum ? -10 : 0)
// Distance dominates the chunk ring: the player gate (loop.ts streamReadyFor) needs the preview-lit tiles within
// 20 m and in view within 40 m, which often lie in ring-1 chunks while the far corner of the player's own chunk is
// 50 m away. A full bake (+60 vs -70) runs before the builds of tiles ~65 m farther away: nearby previews first,
// then lighting upgrades close by, then the far ring. The own-chunk head start is for its layout (the player's
// collision) and builds only; its full bakes queue by distance like every other bake. Automation runs (bake 'full')
// reorder their gate ring on top of this: ChunkStreamer StreamerOptions.fullBakeRing.

import { CHUNK_SIZE, EDGE_FOG } from '../core/constants.ts';
import { chebyshev } from '../core/grid.ts';

export type JobType = 'layout' | 'build' | 'bake';
export const JOB_OFFSET: Readonly<Record<JobType, number>> = { layout: -90, build: -70, bake: 60 };
export const RING_WEIGHT = 20;
export const DISTANCE_WEIGHT = 2; // per metre
export const OFF_FRUSTUM_PENALTY = 30;
export const PREFETCH_OFFSET = 400;
export const OWN_CHUNK_OFFSET = -1000;
export const BAKE_IN_VIEW_BONUS = 10;
/** Priority of one-shot queries (find / spawn / ascii): ahead of everything. */
export const QUERY_PRIORITY = -2000;

export function basePriority(ring: number, inFrustum: boolean, distance: number): number {
  return ring * RING_WEIGHT + (inFrustum ? 0 : OFF_FRUSTUM_PENALTY) + distance * DISTANCE_WEIGHT;
}

export function jobPriority(base: number, type: JobType, prefetch: boolean, ownChunk: boolean, inView = false): number {
  return base + JOB_OFFSET[type] + (prefetch ? PREFETCH_OFFSET : 0) + (ownChunk && type !== 'bake' ? OWN_CHUNK_OFFSET : 0)
    - (type === 'bake' && inView && !prefetch ? BAKE_IN_VIEW_BONUS : 0);
}

/** Desired set: chunks within Chebyshev `radius` of the look-ahead chunk (lcx, lcz), plus the player's chunk. */
export function isDesired(cx: number, cz: number, lcx: number, lcz: number, pcx: number, pcz: number, radius: number): boolean {
  return chebyshev(cx, cz, lcx, lcz) <= radius || (cx === pcx && cz === pcz);
}

/** Hysteresis: a resident chunk is evicted only once it is more than radius + 1 from the desired-set centre
 * (and it is not the player's own chunk). At radius 2 this bounds residency to 6x6 chunks. */
export function keepResident(cx: number, cz: number, lcx: number, lcz: number, pcx: number, pcz: number, radius: number): boolean {
  return chebyshev(cx, cz, lcx, lcz) <= radius + 1 || (cx === pcx && cz === pcz);
}

/** Writes the desired chunks as (cx, cz) pairs into `out`, nearest ring (to the player's chunk) first.
 * Returns the number of chunks. `out` must hold 2*((2r+1)^2 + 1) numbers. */
export function desiredChunks(lcx: number, lcz: number, pcx: number, pcz: number, radius: number, out: Int32Array | number[]): number {
  let n = 0;
  const maxRing = radius + chebyshev(lcx, lcz, pcx, pcz);
  for (let ring = 0; ring <= maxRing; ring++) {
    for (let dz = -ring; dz <= ring; dz++) {
      for (let dx = -ring; dx <= ring; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== ring) continue;
        const cx = pcx + dx, cz = pcz + dz;
        if (!isDesired(cx, cz, lcx, lcz, pcx, pcz, radius)) continue;
        out[n * 2] = cx;
        out[n * 2 + 1] = cz;
        n++;
      }
    }
  }
  return n;
}

/** Distance from (px, pz) to the nearest point of the rectangle [x0,x1] x [z0,z1] (0 inside). */
export function rectDistance(px: number, pz: number, x0: number, z0: number, x1: number, z1: number): number {
  const dx = px < x0 ? x0 - px : px > x1 ? px - x1 : 0;
  const dz = pz < z0 ? z0 - pz : pz > z1 ? pz - z1 : 0;
  return Math.sqrt(dx * dx + dz * dz);
}

/** Edge-fog end distance (m) for a stream radius (radius 0, the chunk harness, never hides anything). */
export const fogEnd = (radius: number): number => (radius <= 0 ? Infinity : EDGE_FOG.END * radius * CHUNK_SIZE);

/** Tiles whose nearest point lies beyond the edge-fog end are fully fogged: resident but hidden. */
export function fogHidden(px: number, pz: number, x0: number, z0: number, size: number, radius: number): boolean {
  return rectDistance(px, pz, x0, z0, x0 + size, z0 + size) > fogEnd(radius);
}

/** Axis-aligned (Chebyshev) distance from (px, pz) to the rectangle [x0,x1] x [z0,z1] (0 inside). */
export function rectChebyshev(px: number, pz: number, x0: number, z0: number, x1: number, z1: number): number {
  const dx = px < x0 ? x0 - px : px > x1 ? px - x1 : 0;
  const dz = pz < z0 ? z0 - pz : pz > z1 ? pz - z1 : 0;
  return dx > dz ? dx : dz;
}

// ---------------------------------------------------------------- automation capture set (gate v2)

/** m: every tile this close to the eye can change a still capture whatever the view:
 *  - the reflection probe renders the cube [-PROBE.FAR, PROBE.FAR]^3 around its anchor (six 90 deg faces with their
 *    far plane at 60 m), so its reach is an AXIS-ALIGNED 60 m (Chebyshev distance), up to 85 m along the diagonals;
 *  - the light atlas (froxel volumetrics, dust motes) is sampled within LA.REACH = 56 m (57.6 m guaranteed).
 * tests/stream/priorities.test.ts keeps it >= both. */
export const CAPTURE_NEAR_M = 60;
/** m added to the near reach: the eye (and so the probe anchor) sits up to a head-bob offset from the player's x/z,
 * which the streamer measures from. */
export const CAPTURE_EYE_SLACK_M = 1;
/** m: vertical extent of the in-view test of the capture set (the tile's real bounds are unknown before its build):
 * tall rooms, pools and the planar mirror's vertically mirrored frustum all fall inside it. */
export const CAPTURE_VIEW_Y: readonly [number, number] = [-20, 20];

/**
 * The automation capture set (bake=full, gate v2): the tiles that can change a still capture, defined by position
 * and view only, never by timing or cache state. `dist` = rectDistance (Euclidean) from the eye, `cheb` =
 * rectChebyshev, `inView` = the tile intersects the view frustum (CAPTURE_VIEW_Y), `radius` = stream radius.
 *  - ring <= 1: the historical gate ring (always);
 *  - otherwise only tiles within the edge-fog end: a fogged tile's group is hidden from every pass (main view, probe,
 *    planar mirror);
 *  - within it: everything the probe cube or the light atlas can reach (cheb <= CAPTURE_NEAR_M + slack), and
 *    whatever is in view.
 */
export function inCaptureSet(ring: number, dist: number, inView: boolean, radius: number, cheb: number = dist): boolean {
  if (ring <= 1) return true;
  if (dist > fogEnd(radius)) return false;
  return cheb <= CAPTURE_NEAR_M + CAPTURE_EYE_SLACK_M || inView;
}

// ---------------------------------------------------------------- velocity estimate / look-ahead

export interface MotionState { x: number; z: number; vx: number; vz: number; t: number; valid: boolean }
export const createMotion = (): MotionState => ({ x: 0, z: 0, vx: 0, vz: 0, t: 0, valid: false });

/** Smoothing time constant of the velocity estimate (s). */
export const VELOCITY_TAU = 0.5;
/** A jump longer than this between two updates (or faster than TELEPORT_SPEED) is a teleport: velocity resets. */
export const TELEPORT_DIST = 8;
export const TELEPORT_SPEED = 25;

/** Update the smoothed velocity from a new position sample at time tMs (milliseconds). */
export function updateMotion(m: MotionState, x: number, z: number, tMs: number): void {
  if (!m.valid) {
    m.x = x; m.z = z; m.vx = 0; m.vz = 0; m.t = tMs; m.valid = true;
    return;
  }
  const dt = (tMs - m.t) / 1000;
  const dx = x - m.x, dz = z - m.z;
  const d = Math.sqrt(dx * dx + dz * dz);
  if (d > TELEPORT_DIST || (dt > 0 && d / dt > TELEPORT_SPEED)) {
    m.vx = 0; m.vz = 0;
  } else if (dt > 1e-4) {
    const h = Math.min(dt, 0.25);
    const a = 1 - Math.exp(-h / VELOCITY_TAU);
    m.vx += (dx / dt - m.vx) * a;
    m.vz += (dz / dt - m.vz) * a;
  } else {
    return; // same timestamp: keep the previous sample as the reference
  }
  m.x = x; m.z = z; m.t = tMs;
}

export function resetMotion(m: MotionState): void {
  m.valid = false; m.vx = 0; m.vz = 0;
}

/** Look-ahead point = position + smoothedVelocity * EDGE_FOG.LOOKAHEAD_S. */
export function lookahead(m: MotionState, x: number, z: number, out: { x: number; z: number }): void {
  out.x = x + m.vx * EDGE_FOG.LOOKAHEAD_S;
  out.z = z + m.vz * EDGE_FOG.LOOKAHEAD_S;
}
