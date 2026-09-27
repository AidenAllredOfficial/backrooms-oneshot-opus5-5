// src/lighting/probeBox.ts — package D: the axis-aligned room box of the reflection probe (materials/ReflectionProbe.ts),
// estimated from the 2.5D world around the probe's anchor. Pure (no three).
//
// RAYS horizontal rays every 30 deg at eye height (WorldQuery.rayDistance: walls, partitions by height, solid cells;
// props do not stop them), plus two rays parallel to each axis ray, offset sideways by up to PAR_OFFSET.
//  1. First guess: the extent along each of +x, +z, -x, -z is the MEDIAN of d_i cos(a_i - axis) over the three rays
//     within +-30 deg of that axis. In a box room all three agree on the wall, and a single pillar or a doorway in one
//     of them does not move the box.
//  2. Refinement: in a room longer than it is wide (a corridor, the pool hall), the +-30 deg rays hit the SIDE walls,
//     and their median would end the box at ~1.7 half-widths down the corridor. A +-30 deg ray whose hit lies on a
//     side face of the first guess is therefore only a lower bound for its axis; the axis itself is measured by the
//     median of three PARALLEL rays (the axis ray and one either side, inside the free space the side rays found),
//     which still ignores a pillar and never passes through a doorway narrower than their spread. The remaining
//     +-30 deg rays (those that met the far wall) vote with it: median of three, the smaller of two.
// Extents are clamped to [MIN, MAX]. The vertical extent is the floor under the anchor (floorAt from the feet; a
// non-finite answer falls back to the feet) and the ceiling above the eye (ceilingAt; non-finite: open or unloaded
// above, eye + CEIL_FALLBACK).

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
  /** m: the sideways offset of the parallel axis rays (wider than a 1.2 m doorway's half-width) */
  PAR_OFFSET: 0.75,
  /** m: parallel rays start at least this far inside the free distance the side ray found */
  PAR_MARGIN: 0.15,
  /** m (and fraction of the lateral distance): a +-30 deg hit this close to a side face lies on that face */
  SIDE_TOL: 0.3,
  SIDE_TOL_REL: 0.05,
} as const;

const rays = new Float64Array(PROBE_BOX.RAYS);
const first = new Float64Array(4);
/** Axis unit vectors: +x, +z, -x, -z. */
const AX = [1, 0, -1, 0] as const, AZ = [0, 1, 0, -1] as const;

/** Median of three. */
const med3 = (a: number, b: number, c: number): number => Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));
const clampExt = (e: number): number => Math.max(PROBE_BOX.MIN, Math.min(PROBE_BOX.MAX, e));
const ray = (q: ProbeBoxQuery, x: number, y: number, z: number, dx: number, dz: number): number => {
  const d = q.rayDistance(x, y, z, dx, dz, PROBE_BOX.MAX);
  return Number.isFinite(d) ? Math.max(0, Math.min(PROBE_BOX.MAX, d)) : PROBE_BOX.MAX;
};

/**
 * The room box around the anchor (x, eyeY, z) with the feet at feetY, written to `out` as
 * [xmin, ymin, zmin, xmax, ymax, zmax] (world metres, y storey-relative). Returns `out`.
 */
export function probeBox(q: ProbeBoxQuery, x: number, eyeY: number, z: number, feetY: number, out: Float64Array): Float64Array {
  const n = PROBE_BOX.RAYS;
  const step = (2 * Math.PI) / n;
  for (let i = 0; i < n; i++) {
    const a = i * step;
    rays[i] = ray(q, x, eyeY, z, Math.cos(a), Math.sin(a));
  }
  // axis k (+x, +z, -x, -z) at angle k * 90 deg = ray index 3k; its neighbours are the rays at +-30 deg
  const c30 = Math.cos(step), s30 = Math.sin(step);
  for (let k = 0; k < 4; k++) {
    const i = 3 * k;
    first[k] = clampExt(med3(rays[(i + n - 1) % n] * c30, rays[i], rays[(i + 1) % n] * c30));
  }
  // axis k: unit (AX[k], AZ[k]); its sides are axes k + 1 (the +30 deg ray's side) and k + 3 (the -30 deg ray's)
  const parallel = (k: number, s: number): number => {
    // offset toward side axis s, inside the free distance its axis ray found (else the axis ray itself)
    const off = Math.min(PROBE_BOX.PAR_OFFSET, rays[3 * s] - PROBE_BOX.PAR_MARGIN, first[s] - PROBE_BOX.PAR_MARGIN);
    return off <= 0.05 ? rays[3 * k] : ray(q, x + AX[s] * off, eyeY, z + AZ[s] * off, AX[k], AZ[k]);
  };
  const ext = (k: number): number => {
    const i = 3 * k, sp = (k + 1) % 4, sm = (k + 3) % 4;
    const axis = med3(parallel(k, sp), rays[i], parallel(k, sm));
    // the +-30 deg rays: a hit on a side face of the first guess only bounds this axis from below; the others vote
    let lower = 0, v1 = NaN, v2 = NaN;
    for (let j = 0; j < 2; j++) {
      const d = rays[j === 0 ? (i + 1) % n : (i + n - 1) % n];
      const face = first[j === 0 ? sp : sm];
      if (d * s30 >= face - Math.max(PROBE_BOX.SIDE_TOL, PROBE_BOX.SIDE_TOL_REL * face)) lower = Math.max(lower, d * c30);
      else if (Number.isNaN(v1)) v1 = d * c30;
      else v2 = d * c30;
    }
    const e = !Number.isNaN(v2) ? med3(axis, v1, v2) : !Number.isNaN(v1) ? Math.min(axis, v1) : axis;
    return clampExt(Math.max(e, lower));
  };
  const e0 = ext(0), e1 = ext(1), e2 = ext(2), e3 = ext(3);
  out[3] = x + e0; // +x
  out[5] = z + e1; // +z
  out[0] = x - e2; // -x
  out[2] = z - e3; // -z
  let y0 = q.floorAt(x, z, feetY);
  if (!Number.isFinite(y0)) y0 = feetY;
  let y1 = q.ceilingAt(x, z, eyeY);
  if (!Number.isFinite(y1)) y1 = eyeY + PROBE_BOX.CEIL_FALLBACK;
  out[1] = Math.min(y0, eyeY - PROBE_BOX.Y_MARGIN);
  out[4] = Math.max(y1, eyeY + PROBE_BOX.Y_MARGIN);
  return out;
}
