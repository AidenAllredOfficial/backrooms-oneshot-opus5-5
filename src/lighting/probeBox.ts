// src/lighting/probeBox.ts — package D: the axis-aligned room box of the reflection probe (materials/ReflectionProbe.ts),
// estimated from the 2.5D world around the probe's anchor. Pure (no three).
//
// RAYS horizontal rays every 30 deg at eye height (WorldQuery.rayDistance: walls, partitions by height, solid cells;
// props do not stop them). The extent along each of +x, +z, -x, -z is the MEDIAN of d_i cos(a_i - axis) over the
// three rays within +-30 deg of that axis: in a box room all three agree on the wall, and a single pillar or a
// doorway in one of them does not move the box. Extents are clamped to [MIN, MAX]. The vertical extent is the floor
// under the anchor (floorAt from the feet; a non-finite answer falls back to the feet) and the ceiling above the eye
// (ceilingAt; non-finite: open or unloaded above, eye + CEIL_FALLBACK).

/** The world queries the estimate needs (WorldQuery / CollisionWorld subset; y is storey-relative). */
export interface ProbeBoxQuery {
  rayDistance(x: number, y: number, z: number, dx: number, dz: number, maxDist: number): number;
  floorAt(x: number, z: number, feetY: number): number;
  ceilingAt(x: number, z: number, y: number): number;
}

export const PROBE_BOX = {
  /** horizontal rays, evenly spaced from +x toward +z */
  RAYS: 12,
  /** m: ray length and the largest half-extent */
  MAX: 40,
  /** m: the smallest half-extent (the anchor never sits on a box face) */
  MIN: 0.6,
  /** m above the eye when no ceiling is found */
  CEIL_FALLBACK: 3,
  /** m: the floor / ceiling stay at least this far below / above the eye */
  Y_MARGIN: 0.1,
} as const;

const rays = new Float64Array(PROBE_BOX.RAYS);

/** Median of three. */
const med3 = (a: number, b: number, c: number): number => Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));

/**
 * The room box around the anchor (x, eyeY, z) with the feet at feetY, written to `out` as
 * [xmin, ymin, zmin, xmax, ymax, zmax] (world metres, y storey-relative). Returns `out`.
 */
export function probeBox(q: ProbeBoxQuery, x: number, eyeY: number, z: number, feetY: number, out: Float64Array): Float64Array {
  const n = PROBE_BOX.RAYS;
  const step = (2 * Math.PI) / n;
  for (let i = 0; i < n; i++) {
    const a = i * step;
    const d = q.rayDistance(x, eyeY, z, Math.cos(a), Math.sin(a), PROBE_BOX.MAX);
    rays[i] = Number.isFinite(d) ? Math.max(0, Math.min(PROBE_BOX.MAX, d)) : PROBE_BOX.MAX;
  }
  // axis k at angle k * 90 deg = ray index 3k; its neighbours are the rays at +-30 deg (projected onto the axis)
  const c30 = Math.cos(step);
  const ext = (k: number): number => {
    const i = 3 * k;
    const e = med3(rays[(i + n - 1) % n] * c30, rays[i], rays[(i + 1) % n] * c30);
    return Math.max(PROBE_BOX.MIN, Math.min(PROBE_BOX.MAX, e));
  };
  out[3] = x + ext(0); // +x
  out[5] = z + ext(1); // +z
  out[0] = x - ext(2); // -x
  out[2] = z - ext(3); // -z
  let y0 = q.floorAt(x, z, feetY);
  if (!Number.isFinite(y0)) y0 = feetY;
  let y1 = q.ceilingAt(x, z, eyeY);
  if (!Number.isFinite(y1)) y1 = eyeY + PROBE_BOX.CEIL_FALLBACK;
  out[1] = Math.min(y0, eyeY - PROBE_BOX.Y_MARGIN);
  out[4] = Math.max(y1, eyeY + PROBE_BOX.Y_MARGIN);
  return out;
}
