// src/props/primitives.ts — procedural primitives written through a PartBuilder (§5 WP6): bevelled box, box,
// hexahedron, cylinder / frustum, lathe (surface of revolution), sphere, torus (arc), swept tube along a polyline
// with rounded elbows, extruded 2D profile (optionally chamfered), rectangular frame, flat quads and disks.
// All coordinates are part-local metres; UVs are part-local metres (the builder divides by the layer repeat).
// Normals are outward; the builder winds every triangle to match them. Pure module (no three/DOM).

import type { PartBuilder } from './builder.ts';

const TAU = Math.PI * 2;

/** Face skip bits for box / bevelBox. */
export const SKIP = { NX: 1, PX: 2, NY: 4, PY: 8, NZ: 16, PZ: 32 } as const;

/** Position across a face axis of half extent h, in [-1, 1] (0 on a degenerate axis). */
const rel = (d: number, h: number): number => (h > 1e-9 ? d / h : 0);
/** The axis (0 x, 1 y, 2 z) whose faces show end grain: the longest half extent when it is at least 1.5x the next,
 * else -1 (a cube-ish block has no end faces). */
function endAxis(hx: number, hy: number, hz: number): number {
  const l = hx >= hy && hx >= hz ? 0 : hy >= hz ? 1 : 2;
  const h = [hx, hy, hz];
  const next = Math.max(h[(l + 1) % 3], h[(l + 2) % 3]);
  return h[l] >= 1.5 * next ? l : -1;
}

// ------------------------------------------------------------------------------------------ boxes

/** Axis-aligned box, 12 triangles minus 2 per skipped face. Planar UVs per face (in grain mode u runs along the face's
 * longer side), edge coordinates per face (builder.ts edgeEncode; faces across the box's longest axis are end grain). */
export function box(b: PartBuilder, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, skip = 0): void {
  const hx = (x1 - x0) / 2, hy = (y1 - y0) / 2, hz = (z1 - z0) / 2;
  const cx = x0 + hx, cy = y0 + hy, cz = z0 + hz;
  const long = endAxis(hx, hy, hz);
  // one vertex of a face whose uv axes are (a: half ha, centre ca, coordinate pa) and (b...); normal axis `ax`
  const V = (x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, v: number,
    ha: number, sa: number, hb: number, sb: number, ax: number): number => {
    const end = ax === long;
    if (b.grain && hb > ha) return b.v(x, y, z, nx, ny, nz, v, u, b.ec(hb, sb, end), b.ec(ha, sa));
    return b.v(x, y, z, nx, ny, nz, u, v, b.ec(ha, sa, end), b.ec(hb, sb));
  };
  const X = (x: number, y: number, z: number, n: number, u: number): number => V(x, y, z, n, 0, 0, u, y, hz, rel(z - cz, hz), hy, rel(y - cy, hy), 0);
  const Y = (x: number, y: number, z: number, n: number): number => V(x, y, z, 0, n, 0, x, z, hx, rel(x - cx, hx), hz, rel(z - cz, hz), 1);
  const Z = (x: number, y: number, z: number, n: number, u: number): number => V(x, y, z, 0, 0, n, u, y, hx, rel(x - cx, hx), hy, rel(y - cy, hy), 2);
  if (!(skip & SKIP.NX)) b.quad(X(x0, y0, z0, -1, z0), X(x0, y0, z1, -1, z1), X(x0, y1, z1, -1, z1), X(x0, y1, z0, -1, z0));
  if (!(skip & SKIP.PX)) b.quad(X(x1, y0, z0, 1, -z0), X(x1, y1, z0, 1, -z0), X(x1, y1, z1, 1, -z1), X(x1, y0, z1, 1, -z1));
  if (!(skip & SKIP.NY)) b.quad(Y(x0, y0, z0, -1), Y(x1, y0, z0, -1), Y(x1, y0, z1, -1), Y(x0, y0, z1, -1));
  if (!(skip & SKIP.PY)) b.quad(Y(x0, y1, z0, 1), Y(x0, y1, z1, 1), Y(x1, y1, z1, 1), Y(x1, y1, z0, 1));
  if (!(skip & SKIP.NZ)) b.quad(Z(x0, y0, z0, -1, -x0), Z(x0, y1, z0, -1, -x0), Z(x1, y1, z0, -1, -x1), Z(x1, y0, z0, -1, -x1));
  if (!(skip & SKIP.PZ)) b.quad(Z(x0, y0, z1, 1, x0), Z(x1, y0, z1, 1, x1), Z(x1, y1, z1, 1, x1), Z(x0, y1, z1, 1, x0));
}
/** Triangle count of box(). */
export const boxTris = (skip = 0): number => {
  let n = 12;
  for (let i = 0; i < 6; i++) if (skip & (1 << i)) n -= 2;
  return n;
};

/** Box with c-metre chamfers on every edge and corner (44 triangles when nothing is skipped). Chamfers catch
 * highlights; flat shading per face / chamfer / corner. A skipped face also drops its adjacent chamfers and
 * corners (a face resting on the floor or against a wall); the neighbouring faces then extend to that side. */
export function bevelBox(b: PartBuilder, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, c: number, skip = 0): void {
  const cc = Math.max(1e-4, Math.min(c, 0.45 * (x1 - x0), 0.45 * (y1 - y0), 0.45 * (z1 - z0)));
  const X = [x0, x1], Y = [y0, y1], Z = [z0, z1];
  const skipF = (axis: number, side: number): boolean => (skip & (1 << (axis * 2 + side))) !== 0;
  // A skipped face drops its chamfers, so the neighbouring faces / chamfers run all the way to that side (no
  // c-high slit above the floor / in front of the wall, no gap under a leg standing on a foot plate).
  const XI = [skipF(0, 0) ? x0 : x0 + cc, skipF(0, 1) ? x1 : x1 - cc];
  const YI = [skipF(1, 0) ? y0 : y0 + cc, skipF(1, 1) ? y1 : y1 - cc];
  const ZI = [skipF(2, 0) ? z0 : z0 + cc, skipF(2, 1) ? z1 : z1 - cc];
  const S2 = Math.SQRT1_2, S3 = 1 / Math.sqrt(3);
  // edge coordinates over the outer extents: a face's inner rim lies cc from the box edge; chamfers and corners are on it
  const H = [(x1 - x0) / 2, (y1 - y0) / 2, (z1 - z0) / 2], C = [x0 + H[0], y0 + H[1], z0 + H[2]];
  const long = endAxis(H[0], H[1], H[2]);
  // faces
  for (let axis = 0; axis < 3; axis++) {
    for (let side = 0; side < 2; side++) {
      if (skipF(axis, side)) continue;
      const sg = side ? 1 : -1;
      const end = axis === long;
      // uv axes: x faces (z, y), y faces (x, z), z faces (x, y); grain mode puts u on the longer one
      const ua = axis === 0 ? 2 : 0, va = axis === 1 ? 2 : 1;
      const swap = b.grain && H[va] > H[ua];
      const W = (x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, v: number): number => {
        const p = [x, y, z];
        const ea = b.ec(H[ua], rel(p[ua] - C[ua], H[ua])), eb = b.ec(H[va], rel(p[va] - C[va], H[va]));
        return swap ? b.v(x, y, z, nx, ny, nz, v, u, end ? -eb : eb, ea) : b.v(x, y, z, nx, ny, nz, u, v, end ? -ea : ea, eb);
      };
      const P = (i: number, j: number): number => {
        // i, j index the two other axes' inner coordinates
        if (axis === 0) return W(X[side], YI[i], ZI[j], sg, 0, 0, ZI[j] * sg, YI[i]);
        if (axis === 1) return W(XI[i], Y[side], ZI[j], 0, sg, 0, XI[i], ZI[j]);
        return W(XI[i], YI[j], Z[side], 0, 0, sg, XI[i] * -sg, YI[j]);
      };
      b.quad(P(0, 0), P(1, 0), P(1, 1), P(0, 1));
    }
  }
  // edge chamfers: between faces (a, sa) and (bx, sb) along the remaining axis
  for (let a = 0; a < 3; a++) {
    for (let bb = a + 1; bb < 3; bb++) {
      const along = 3 - a - bb;
      for (let sa = 0; sa < 2; sa++) {
        for (let sb = 0; sb < 2; sb++) {
          if (skipF(a, sa) || skipF(bb, sb)) continue;
          const n = [0, 0, 0];
          n[a] = (sa ? 1 : -1) * S2; n[bb] = (sb ? 1 : -1) * S2;
          const pts: number[] = [];
          for (let t = 0; t < 2; t++) {
            // point on face a (outer on axis a, inner on axis bb) and point on face bb
            for (let f = 0; f < 2; f++) {
              const p = [0, 0, 0];
              const O = [X, Y, Z], I = [XI, YI, ZI];
              p[a] = f === 0 ? O[a][sa] : I[a][sa];
              p[bb] = f === 0 ? I[bb][sb] : O[bb][sb];
              p[along] = I[along][t];
              let u = along === 0 ? p[0] : p[2], v = along === 1 ? p[1] : along === 0 ? p[1] + p[2] : p[1] + p[0];
              if (b.grain && along === 1) { const q = u; u = v; v = q; } // u along the chamfer
              const ea = b.ec(H[along], rel(p[along] - C[along], H[along])), eb = b.ec(0, f ? 1 : -1);
              pts.push(b.v(p[0], p[1], p[2], n[0], n[1], n[2], u, v, ea, eb));
            }
          }
          b.quad(pts[0], pts[1], pts[3], pts[2]);
        }
      }
    }
  }
  // corners
  const ce = b.ec(0, 0);
  for (let sx = 0; sx < 2; sx++) {
    for (let sy = 0; sy < 2; sy++) {
      for (let sz = 0; sz < 2; sz++) {
        if (skipF(0, sx) || skipF(1, sy) || skipF(2, sz)) continue;
        const nx = (sx ? 1 : -1) * S3, ny = (sy ? 1 : -1) * S3, nz = (sz ? 1 : -1) * S3;
        const a = b.v(X[sx], YI[sy], ZI[sz], nx, ny, nz, 0, 0, ce, ce);
        const c2 = b.v(XI[sx], Y[sy], ZI[sz], nx, ny, nz, cc, 0, ce, ce);
        const d = b.v(XI[sx], YI[sy], Z[sz], nx, ny, nz, 0, cc, ce, ce);
        b.tri(a, c2, d);
      }
    }
  }
}
/** Triangle count of bevelBox(). */
export function bevelBoxTris(skip = 0): number {
  const s = (axis: number, side: number): boolean => (skip & (1 << (axis * 2 + side))) !== 0;
  let n = 0;
  for (let a = 0; a < 3; a++) for (let sd = 0; sd < 2; sd++) if (!s(a, sd)) n += 2;
  for (let a = 0; a < 3; a++) for (let bb = a + 1; bb < 3; bb++) for (let sa = 0; sa < 2; sa++) for (let sb = 0; sb < 2; sb++) if (!s(a, sa) && !s(bb, sb)) n += 2;
  for (let x = 0; x < 2; x++) for (let y = 0; y < 2; y++) for (let z = 0; z < 2; z++) if (!s(0, x) && !s(1, y) && !s(2, z)) n++;
  return n;
}

/** Convex hexahedron from 8 corners c[0..23]: bottom quad 0-1-2-3 then top quad 4-5-6-7 (vertex k+4 above k).
 * Flat faces, normals pointing away from the centroid. `skip` uses the box bits with faces
 * NX = (0,3,7,4)... interpreted as: 1 face 0-3-7-4, 2 face 1-2-6-5, 4 bottom, 8 top, 16 face 0-1-5-4, 32 face 3-2-6-7. */
export function hexa(b: PartBuilder, c: readonly number[], skip = 0): void {
  let gx = 0, gy = 0, gz = 0;
  for (let i = 0; i < 8; i++) { gx += c[i * 3]; gy += c[i * 3 + 1]; gz += c[i * 3 + 2]; }
  gx /= 8; gy /= 8; gz /= 8;
  const faces = [[0, 3, 7, 4], [1, 2, 6, 5], [0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 5, 4], [3, 2, 6, 7]];
  for (let f = 0; f < 6; f++) {
    if (skip & (1 << f)) continue;
    const q = faces[f];
    const P = (k: number): [number, number, number] => [c[q[k] * 3], c[q[k] * 3 + 1], c[q[k] * 3 + 2]];
    const p0 = P(0), p1 = P(1), p2 = P(2), p3 = P(3);
    // Newell normal
    let nx = 0, ny = 0, nz = 0;
    const ps = [p0, p1, p2, p3];
    for (let i = 0; i < 4; i++) {
      const a = ps[i], d = ps[(i + 1) % 4];
      nx += (a[1] - d[1]) * (a[2] + d[2]);
      ny += (a[2] - d[2]) * (a[0] + d[0]);
      nz += (a[0] - d[0]) * (a[1] + d[1]);
    }
    const fx = (p0[0] + p1[0] + p2[0] + p3[0]) / 4 - gx, fy = (p0[1] + p1[1] + p2[1] + p3[1]) / 4 - gy, fz = (p0[2] + p1[2] + p2[2] + p3[2]) / 4 - gz;
    if (nx * fx + ny * fy + nz * fz < 0) { nx = -nx; ny = -ny; nz = -nz; }
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    // planar uv: project on the two axes least aligned with the normal
    const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
    const uvOf = (p: [number, number, number]): [number, number] =>
      ax >= ay && ax >= az ? [p[2], p[1]] : ay >= az ? [p[0], p[2]] : [p[0], p[1]];
    // edge coordinates over the face's bounding box in its uv projection (exact for rectangular faces)
    const ts = ps.map(uvOf);
    const ua = Math.min(...ts.map((t) => t[0])), ub = Math.max(...ts.map((t) => t[0]));
    const va = Math.min(...ts.map((t) => t[1])), vb = Math.max(...ts.map((t) => t[1]));
    const hu = (ub - ua) / 2, hv = (vb - va) / 2;
    const V = (p: [number, number, number]): number => {
      const t = uvOf(p);
      return b.v(p[0], p[1], p[2], nx, ny, nz, t[0], t[1], b.ec(hu, rel(t[0] - ua - hu, hu)), b.ec(hv, rel(t[1] - va - hv, hv)));
    };
    b.quad(V(p0), V(p1), V(p2), V(p3));
  }
}

// ------------------------------------------------------------------------------------------ flat pieces

/** Rectangle centred at (cx,cy,cz) spanning +-U and +-V (half-extent vectors), normal N. UV: metres from the
 * min corner along U and V, or the raw atlas rect (u0,v0)-(u1,v1) when `atlas` is given (u along +U, v along +V). */
export function rect(
  b: PartBuilder, cx: number, cy: number, cz: number,
  ux: number, uy: number, uz: number, vx: number, vy: number, vz: number,
  nx: number, ny: number, nz: number, atlas?: readonly [number, number, number, number],
): void {
  const lu = 2 * Math.hypot(ux, uy, uz), lv = 2 * Math.hypot(vx, vy, vz);
  const u0 = atlas ? atlas[0] : 0, v0 = atlas ? atlas[1] : 0, u1 = atlas ? atlas[2] : lu, v1 = atlas ? atlas[3] : lv;
  // edge coordinates (and, in grain mode, u along the longer side) of a (su, sv) corner
  const swap = !atlas && b.grain && lv > lu;
  const V = (x: number, y: number, z: number, su: number, sv: number, u: number, v: number): number => {
    const ea = b.ec(lu / 2, su), eb = b.ec(lv / 2, sv);
    return swap ? b.v(x, y, z, nx, ny, nz, v, u, eb, ea) : b.v(x, y, z, nx, ny, nz, u, v, ea, eb);
  };
  const a = V(cx - ux - vx, cy - uy - vy, cz - uz - vz, -1, -1, u0, v0);
  const c1 = V(cx + ux - vx, cy + uy - vy, cz + uz - vz, 1, -1, u1, v0);
  const c2 = V(cx + ux + vx, cy + uy + vy, cz + uz + vz, 1, 1, u1, v1);
  const d = V(cx - ux + vx, cy - uy + vy, cz - uz + vz, -1, 1, u0, v1);
  b.quad(a, c1, c2, d);
}

/** Flat n-gon disk of radius r in the XZ plane at height y, facing +Y (up) or -Y. n - 2 triangles. */
export function disk(b: PartBuilder, r: number, n: number, y: number, up: boolean, phase = 0.5): void {
  const ny = up ? 1 : -1;
  const first = b.v(r * Math.cos((phase * TAU) / n), y, r * Math.sin((phase * TAU) / n), 0, ny, 0, r * Math.cos((phase * TAU) / n), r * Math.sin((phase * TAU) / n));
  let prev = -1;
  for (let k = 1; k < n; k++) {
    const a = ((k + phase) * TAU) / n;
    const x = r * Math.cos(a), z = r * Math.sin(a);
    const cur = b.v(x, y, z, 0, ny, 0, x, z);
    if (prev >= 0) b.tri(first, prev, cur);
    prev = cur;
  }
}

/** Flat annulus (ring) in the XZ plane at height y between radii r0 < r1. 2n triangles. */
export function annulus(b: PartBuilder, r0: number, r1: number, n: number, y: number, up: boolean): void {
  const ny = up ? 1 : -1;
  let pi = -1, po = -1;
  for (let k = 0; k <= n; k++) {
    const a = ((k + 0.5) * TAU) / n, c = Math.cos(a), s = Math.sin(a);
    const i = b.v(r0 * c, y, r0 * s, 0, ny, 0, r0 * c, r0 * s);
    const o = b.v(r1 * c, y, r1 * s, 0, ny, 0, r1 * c, r1 * s);
    if (k > 0) b.quad(pi, po, o, i);
    pi = i; po = o;
  }
}

// ------------------------------------------------------------------------------------------ revolution

/** Vertex of a curved side (cylinder, lathe, sweep): u around, v along; edge coordinates 0 around (no edge) and
 * (half, s) along, the length's half and the position in [-1, 1]; grain mode swaps u / v so u runs along. */
function tubeV(b: PartBuilder, x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, v: number, half: number, s: number): number {
  const e = b.ec(half, s);
  return b.grain ? b.v(x, y, z, nx, ny, nz, v, u, e, 0) : b.v(x, y, z, nx, ny, nz, u, v, 0, e);
}

/** Frustum along +Y from y0 (radius r0) to y1 (radius r1), n segments. caps: 1 bottom, 2 top. Smooth sides.
 * Triangles: 2n + (n-2) per cap. */
export function cylinder(b: PartBuilder, r0: number, r1: number, y0: number, y1: number, n: number, caps = 0, phase = 0.5): void {
  const h = y1 - y0;
  const slope = (r0 - r1) / (h || 1e-6);
  const nl = Math.hypot(1, slope);
  const circ = Math.max(r0, r1);
  let pb = -1, pt = -1;
  for (let k = 0; k <= n; k++) {
    const a = ((k + phase) * TAU) / n, c = Math.cos(a), s = Math.sin(a);
    const u = (k / n) * TAU * circ;
    // edge coordinates: none around, the distance to the ends along; grain mode runs u along the axis
    const vb = tubeV(b, r0 * c, y0, r0 * s, c / nl, slope / nl, s / nl, u, y0, h / 2, -1);
    const vt = tubeV(b, r1 * c, y1, r1 * s, c / nl, slope / nl, s / nl, u, y1, h / 2, 1);
    if (k > 0) b.quad(pb, vb, vt, pt);
    pb = vb; pt = vt;
  }
  if (caps & 1) disk(b, r0, n, y0, false, phase);
  if (caps & 2) disk(b, r1, n, y1, true, phase);
}
export const cylinderTris = (n: number, caps = 0): number => 2 * n + ((caps & 1) ? n - 2 : 0) + ((caps & 2) ? n - 2 : 0);

/** Surface of revolution about +Y. prof = [r0, y0, r1, y1, ...]. Profile order sets the facing: walking the
 * profile, the surface faces to the right in the (r, y) half-plane (upward outer walls face out, downward inner
 * walls face the axis). Adjacent segments with a turn below `smoothDeg` share normals. Segments touching the axis
 * (r = 0) become triangle fans. caps: 1 = flat cap at the first point, 2 = at the last (if r > 0).
 * Triangles: sum over segments of (2n, or n if one end is on the axis) + caps (n - 2 each). */
export function lathe(b: PartBuilder, prof: readonly number[], n: number, caps = 0, smoothDeg = 35, phase = 0.5): void {
  const np = prof.length / 2;
  const segN: number[] = [];
  for (let i = 0; i < np - 1; i++) {
    const dr = prof[i * 2 + 2] - prof[i * 2], dy = prof[i * 2 + 3] - prof[i * 2 + 1];
    const l = Math.hypot(dr, dy) || 1;
    segN.push(dy / l, -dr / l); // (nr, ny)
  }
  const cosLim = Math.cos((smoothDeg * Math.PI) / 180);
  let vacc = 0;
  let rmax = 0;
  let plen = 0; // profile length: edge coordinates along it (the ends are the lathe's rims)
  for (let i = 0; i < np; i++) rmax = Math.max(rmax, prof[i * 2]);
  for (let i = 0; i < np - 1; i++) plen += Math.hypot(prof[i * 2 + 2] - prof[i * 2], prof[i * 2 + 3] - prof[i * 2 + 1]);
  const ph = plen / 2;
  for (let s = 0; s < np - 1; s++) {
    const r0 = prof[s * 2], y0 = prof[s * 2 + 1], r1 = prof[s * 2 + 2], y1 = prof[s * 2 + 3];
    const sl = Math.hypot(r1 - r0, y1 - y0);
    const nr = segN[s * 2], ny = segN[s * 2 + 1];
    // endpoint normals (smoothed with neighbours when the turn is gentle)
    let n0r = nr, n0y = ny, n1r = nr, n1y = ny;
    if (s > 0) {
      const pr = segN[s * 2 - 2], py = segN[s * 2 - 1];
      if (pr * nr + py * ny > cosLim) { const l = Math.hypot(pr + nr, py + ny) || 1; n0r = (pr + nr) / l; n0y = (py + ny) / l; }
    }
    if (s < np - 2) {
      const qr = segN[s * 2 + 2], qy = segN[s * 2 + 3];
      if (qr * nr + qy * ny > cosLim) { const l = Math.hypot(qr + nr, qy + ny) || 1; n1r = (qr + nr) / l; n1y = (qy + ny) / l; }
    }
    const axis0 = r0 < 1e-6, axis1 = r1 < 1e-6;
    let p0 = -1, p1 = -1;
    for (let k = 0; k <= n; k++) {
      const a = ((k + phase) * TAU) / n, c = Math.cos(a), si = Math.sin(a);
      const u = (k / n) * TAU * rmax;
      const ah = ((k + phase - 0.5) * TAU) / n; // apex normal direction between ring vertices
      const ca = axis0 || axis1 ? Math.cos(ah) : c, sa = axis0 || axis1 ? Math.sin(ah) : si;
      const va = tubeV(b, r0 * c, y0, r0 * si, n0r * (axis0 ? ca : c), n0y, n0r * (axis0 ? sa : si), u, vacc, ph, rel(vacc - ph, ph));
      const vb = tubeV(b, r1 * c, y1, r1 * si, n1r * (axis1 ? ca : c), n1y, n1r * (axis1 ? sa : si), u, vacc + sl, ph, rel(vacc + sl - ph, ph));
      if (k > 0) {
        if (axis0) b.tri(va, vb, p1);
        else if (axis1) b.tri(p0, va, vb);
        else b.quad(p0, va, vb, p1);
      }
      p0 = va; p1 = vb;
    }
    vacc += sl;
  }
  if ((caps & 1) && prof[0] > 1e-6) {
    // cap faces away from the second point
    const up = prof[3] < prof[1];
    disk(b, prof[0], n, prof[1], up, phase);
  }
  if ((caps & 2) && prof[(np - 1) * 2] > 1e-6) {
    const up = prof[(np - 1) * 2 + 1] > prof[(np - 2) * 2 + 1];
    disk(b, prof[(np - 1) * 2], n, prof[(np - 1) * 2 + 1], up, phase);
  }
}
export function latheTris(prof: readonly number[], n: number, caps = 0): number {
  const np = prof.length / 2;
  let t = 0;
  for (let s = 0; s < np - 1; s++) t += prof[s * 2] < 1e-6 || prof[s * 2 + 2] < 1e-6 ? n : 2 * n;
  if ((caps & 1) && prof[0] > 1e-6) t += n - 2;
  if ((caps & 2) && prof[(np - 1) * 2] > 1e-6) t += n - 2;
  return t;
}

/** Sphere of radius r centred at the origin (vertices exactly at r). nLon * (2 nLat - 2) triangles. */
export function sphere(b: PartBuilder, r: number, nLon: number, nLat: number): void {
  const prof: number[] = [];
  for (let i = 0; i <= nLat; i++) {
    const t = -Math.PI / 2 + (i / nLat) * Math.PI;
    prof.push(i === 0 || i === nLat ? 0 : r * Math.cos(t), r * Math.sin(t));
  }
  lathe(b, prof, nLon, 0, 60);
}

/** Torus arc around +Y: major radius R (in the XZ plane), minor radius r, major angle a0..a1 (from +X toward
 * +Z), nMaj x nMin quads. A full circle (a1 - a0 >= 2 pi) is closed; an arc is open (no end caps). */
export function torus(b: PartBuilder, R: number, r: number, a0: number, a1: number, nMaj: number, nMin: number): void {
  let prev: number[] | null = null;
  const cur: number[] = [];
  for (let i = 0; i <= nMaj; i++) {
    const t = a0 + ((a1 - a0) * i) / nMaj, ct = Math.cos(t), st = Math.sin(t);
    cur.length = 0;
    for (let j = 0; j <= nMin; j++) {
      const p = (j / nMin) * TAU, cp = Math.cos(p), sp = Math.sin(p);
      const rr = R + r * cp;
      // edge coordinates: along an open arc (its ends), none around the tube
      const ea = a1 - a0 >= TAU - 1e-6 ? 0 : b.ec(((a1 - a0) * R) / 2, (2 * i) / nMaj - 1);
      cur.push(b.v(rr * ct, r * sp, rr * st, cp * ct, sp, cp * st, t * R, (j / nMin) * TAU * r, ea, 0));
    }
    if (prev) for (let j = 0; j < nMin; j++) b.quad(prev[j], cur[j], cur[j + 1], prev[j + 1]);
    prev = cur.slice();
  }
}

// ------------------------------------------------------------------------------------------ sweeps

/** Canonical ring reference for a tube direction (identical for d and -d): world up projected, or +X for
 * near-vertical tubes. Written into out[0..2]. Pipes use it so separately built tubes and elbows share phase. */
export function canonRef(dx: number, dy: number, dz: number, out: number[]): void {
  let rx = 0, ry = 1, rz = 0;
  if (Math.abs(dy) > 0.9) { rx = 1; ry = 0; }
  const k = rx * dx + ry * dy + rz * dz;
  rx -= k * dx; ry -= k * dy; rz -= k * dz;
  const l = Math.hypot(rx, ry, rz) || 1;
  out[0] = rx / l; out[1] = ry / l; out[2] = rz / l;
}

const sweepScratch = { t: [] as number[], ref: [0, 0, 0], ref2: [0, 0, 0] };

/** Sweep an n-sided ring of radius r along the path pts = [x,y,z,...] (>= 2 points). Ring orientation is
 * parallel-transported from `ref0` (default canonRef of the first tangent); if `ref1` is given the residual
 * twist at the end is distributed along the path so the last ring matches ref1 exactly. `tan0` / `tan1` override
 * the (chord) tangent at the first / last point (direction of travel). caps: 1 start, 2 end.
 * Triangles: 2n (np - 1) + (n - 2) per cap. */
export function sweep(
  b: PartBuilder, pts: readonly number[], r: number, n: number, caps = 0, ref0?: readonly number[], ref1?: readonly number[],
  tan0?: readonly number[], tan1?: readonly number[],
): void {
  const np = pts.length / 3;
  const T = sweepScratch.t;
  T.length = 0;
  for (let i = 0; i < np; i++) {
    const i0 = Math.max(0, i - 1), i1 = Math.min(np - 1, i + 1);
    // explicit end tangents (arcs: the chord tangent would tilt the end ring by half a segment angle and open a
    // crack against the straight tube it joins)
    const ov = i === 0 ? tan0 : i === np - 1 ? tan1 : undefined;
    let tx = ov ? ov[0] : pts[i1 * 3] - pts[i0 * 3], ty = ov ? ov[1] : pts[i1 * 3 + 1] - pts[i0 * 3 + 1], tz = ov ? ov[2] : pts[i1 * 3 + 2] - pts[i0 * 3 + 2];
    const l = Math.hypot(tx, ty, tz) || 1;
    tx /= l; ty /= l; tz /= l;
    T.push(tx, ty, tz);
  }
  // transported reference vectors
  const refs: number[] = [];
  const R = sweepScratch.ref;
  if (ref0) { R[0] = ref0[0]; R[1] = ref0[1]; R[2] = ref0[2]; } else canonRef(T[0], T[1], T[2], R);
  // make ref0 orthogonal to t0
  {
    const k = R[0] * T[0] + R[1] * T[1] + R[2] * T[2];
    R[0] -= k * T[0]; R[1] -= k * T[1]; R[2] -= k * T[2];
    const l = Math.hypot(R[0], R[1], R[2]) || 1;
    R[0] /= l; R[1] /= l; R[2] /= l;
  }
  refs.push(R[0], R[1], R[2]);
  for (let i = 1; i < np; i++) {
    // project the previous ref onto the plane normal to the new tangent (discrete parallel transport)
    const tx = T[i * 3], ty = T[i * 3 + 1], tz = T[i * 3 + 2];
    let rx = refs[(i - 1) * 3], ry = refs[(i - 1) * 3 + 1], rz = refs[(i - 1) * 3 + 2];
    const k = rx * tx + ry * ty + rz * tz;
    rx -= k * tx; ry -= k * ty; rz -= k * tz;
    const l = Math.hypot(rx, ry, rz);
    if (l < 1e-6) canonRef(tx, ty, tz, R);
    else { R[0] = rx / l; R[1] = ry / l; R[2] = rz / l; }
    refs.push(R[0], R[1], R[2]);
  }
  // twist correction to ref1
  let twist = 0;
  if (ref1) {
    const i = np - 1;
    const tx = T[i * 3], ty = T[i * 3 + 1], tz = T[i * 3 + 2];
    const ax = refs[i * 3], ay = refs[i * 3 + 1], az = refs[i * 3 + 2];
    const bx = ty * az - tz * ay, by = tz * ax - tx * az, bz = tx * ay - ty * ax; // t x a
    twist = Math.atan2(ref1[0] * bx + ref1[1] * by + ref1[2] * bz, ref1[0] * ax + ref1[1] * ay + ref1[2] * az);
    // any rotation by a multiple of the segment angle is equivalent for a regular n-gon ring
    const seg = TAU / n;
    twist -= Math.round(twist / seg) * seg;
  }
  // cumulative length (and the total: edge coordinates along the tube, whose ends are joints and cut ends)
  let acc = 0;
  let prevRing = -1;
  let total = 0;
  for (let i = 1; i < np; i++) total += Math.hypot(pts[i * 3] - pts[i * 3 - 3], pts[i * 3 + 1] - pts[i * 3 - 2], pts[i * 3 + 2] - pts[i * 3 - 1]);
  const th = total / 2;
  for (let i = 0; i < np; i++) {
    if (i > 0) acc += Math.hypot(pts[i * 3] - pts[i * 3 - 3], pts[i * 3 + 1] - pts[i * 3 - 2], pts[i * 3 + 2] - pts[i * 3 - 1]);
    const tx = T[i * 3], ty = T[i * 3 + 1], tz = T[i * 3 + 2];
    const rot = np > 1 ? (twist * i) / (np - 1) : 0;
    const ax = refs[i * 3], ay = refs[i * 3 + 1], az = refs[i * 3 + 2];
    const bx = ty * az - tz * ay, by = tz * ax - tx * az, bz = tx * ay - ty * ax;
    let ringStart = -1;
    for (let k = 0; k <= n; k++) {
      const a = ((k + 0.5) * TAU) / n + rot, c = Math.cos(a), s = Math.sin(a);
      const nx = c * ax + s * bx, ny = c * ay + s * by, nz = c * az + s * bz;
      const id = tubeV(b, pts[i * 3] + r * nx, pts[i * 3 + 1] + r * ny, pts[i * 3 + 2] + r * nz, nx, ny, nz, (k / n) * TAU * r, acc, th, rel(acc - th, th));
      if (k === 0) ringStart = id;
    }
    if (prevRing >= 0) for (let k = 0; k < n; k++) b.quad(prevRing + k, ringStart + k, ringStart + k + 1, prevRing + k + 1);
    prevRing = ringStart;
  }
  if (caps) {
    for (let e = 0; e < 2; e++) {
      if (!(caps & (1 << e))) continue;
      const i = e === 0 ? 0 : np - 1;
      const sg = e === 0 ? -1 : 1;
      const tx = T[i * 3] * sg, ty = T[i * 3 + 1] * sg, tz = T[i * 3 + 2] * sg;
      const rot = np > 1 ? (twist * i) / (np - 1) : 0;
      const ax = refs[i * 3], ay = refs[i * 3 + 1], az = refs[i * 3 + 2];
      const bx = T[i * 3 + 1] * az - T[i * 3 + 2] * ay, by = T[i * 3 + 2] * ax - T[i * 3] * az, bz = T[i * 3] * ay - T[i * 3 + 1] * ax;
      const idx: number[] = [];
      for (let k = 0; k < n; k++) {
        const a = ((k + 0.5) * TAU) / n + rot, c = Math.cos(a), s = Math.sin(a);
        const ox = c * ax + s * bx, oy = c * ay + s * by, oz = c * az + s * bz;
        idx.push(b.v(pts[i * 3] + r * ox, pts[i * 3 + 1] + r * oy, pts[i * 3 + 2] + r * oz, tx, ty, tz, r * c, r * s));
      }
      for (let k = 1; k < n - 1; k++) b.tri(idx[0], idx[k], idx[k + 1]);
    }
  }
}
export const sweepTris = (np: number, n: number, caps = 0): number => 2 * n * (np - 1) + ((caps & 1) ? n - 2 : 0) + ((caps & 2) ? n - 2 : 0);

/** Round the corners of a polyline (x,y,z triples) with arcs of radius bendR (clamped to 45% of the adjacent
 * segments), bendSegs segments per arc. Returns the new point list. */
export function roundPolyline(pts: readonly number[], bendR: number, bendSegs: number): number[] {
  const np = pts.length / 3;
  if (np < 3 || bendR <= 0 || bendSegs < 1) return pts.slice();
  const out: number[] = [pts[0], pts[1], pts[2]];
  for (let i = 1; i < np - 1; i++) {
    const px = pts[i * 3], py = pts[i * 3 + 1], pz = pts[i * 3 + 2];
    let ax = pts[i * 3 - 3] - px, ay = pts[i * 3 - 2] - py, az = pts[i * 3 - 1] - pz;
    let cx = pts[i * 3 + 3] - px, cy = pts[i * 3 + 4] - py, cz = pts[i * 3 + 5] - pz;
    const la = Math.hypot(ax, ay, az), lc = Math.hypot(cx, cy, cz);
    ax /= la; ay /= la; az /= la; cx /= lc; cy /= lc; cz /= lc;
    const cosT = ax * cx + ay * cy + az * cz; // angle between the two legs
    const theta = Math.acos(Math.max(-1, Math.min(1, cosT)));
    if (theta > Math.PI - 1e-3 || theta < 1e-3) { out.push(px, py, pz); continue; }
    let t = bendR / Math.tan(theta / 2);
    t = Math.min(t, 0.45 * la, 0.45 * lc);
    const rr = t * Math.tan(theta / 2);
    // arc from p + a t to p + c t around centre p + bis * rr / sin(theta/2)
    let bx = ax + cx, by = ay + cy, bz = az + cz;
    const bl = Math.hypot(bx, by, bz) || 1;
    bx /= bl; by /= bl; bz /= bl;
    const dC = rr / Math.sin(theta / 2);
    const ox = px + bx * dC, oy = py + by * dC, oz = pz + bz * dC;
    const sx = px + ax * t - ox, sy = py + ay * t - oy, sz = pz + az * t - oz;
    const ex = px + cx * t - ox, ey = py + cy * t - oy, ez = pz + cz * t - oz;
    const sweepA = Math.PI - theta;
    const sinA = Math.sin(sweepA);
    for (let k = 0; k <= bendSegs; k++) {
      const f = k / bendSegs;
      // slerp between s and e (both of length rr)
      const w0 = Math.sin((1 - f) * sweepA) / sinA, w1 = Math.sin(f * sweepA) / sinA;
      out.push(ox + sx * w0 + ex * w1, oy + sy * w0 + ey * w1, oz + sz * w0 + ez * w1);
    }
  }
  out.push(pts[np * 3 - 3], pts[np * 3 - 2], pts[np * 3 - 1]);
  return out;
}

/** Tube along a polyline with rounded elbows. Triangles = sweepTris(points after rounding, n, caps). */
export function tubePath(b: PartBuilder, pts: readonly number[], r: number, n: number, bendR: number, bendSegs: number, caps = 0): void {
  sweep(b, roundPolyline(pts, bendR, bendSegs), r, n, caps);
}
/** Number of path points after roundPolyline (for budgets): every non-degenerate interior corner becomes
 * bendSegs + 1 points. */
export function tubePathPoints(pts: readonly number[], bendR: number, bendSegs: number): number {
  return roundPolyline(pts, bendR, bendSegs).length / 3;
}

// ------------------------------------------------------------------------------------------ extrusions

/** Signed area of a 2D polygon (x,y pairs); > 0 for counter-clockwise. */
export function polyArea(p: readonly number[]): number {
  let a = 0;
  const n = p.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += p[i * 2] * p[j * 2 + 1] - p[j * 2] * p[i * 2 + 1];
  }
  return a / 2;
}

/** Ear-clipping triangulation of a simple polygon (x,y pairs, any orientation). Returns index triples. */
export function triangulate(p: readonly number[]): number[] {
  const n = p.length / 2;
  const idx: number[] = [];
  for (let i = 0; i < n; i++) idx.push(i);
  const ccw = polyArea(p) > 0;
  const out: number[] = [];
  const cross = (a: number, b: number, c: number): number =>
    (p[b * 2] - p[a * 2]) * (p[c * 2 + 1] - p[a * 2 + 1]) - (p[b * 2 + 1] - p[a * 2 + 1]) * (p[c * 2] - p[a * 2]);
  const inside = (a: number, b: number, c: number, q: number): boolean => {
    const c1 = cross(a, b, q), c2 = cross(b, c, q), c3 = cross(c, a, q);
    return ccw ? c1 >= -1e-12 && c2 >= -1e-12 && c3 >= -1e-12 : c1 <= 1e-12 && c2 <= 1e-12 && c3 <= 1e-12;
  };
  let guard = 0;
  while (idx.length > 3 && guard++ < 10000) {
    let clipped = false;
    for (let i = 0; i < idx.length; i++) {
      const a = idx[(i + idx.length - 1) % idx.length], b = idx[i], c = idx[(i + 1) % idx.length];
      const cr = cross(a, b, c);
      if (ccw ? cr <= 1e-12 : cr >= -1e-12) continue; // reflex or degenerate
      let ok = true;
      for (const q of idx) {
        if (q === a || q === b || q === c) continue;
        if (inside(a, b, c, q)) { ok = false; break; }
      }
      if (!ok) continue;
      out.push(a, b, c);
      idx.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) {
      // numerically stuck: fan the rest (keeps the triangle count at n - 2)
      for (let i = 1; i < idx.length - 1; i++) out.push(idx[0], idx[i], idx[i + 1]);
      idx.length = 0;
      break;
    }
  }
  if (idx.length === 3) out.push(idx[0], idx[1], idx[2]);
  return out;
}

/** Inward (towards the polygon interior) miter offset of a simple polygon by d. */
export function offsetPoly(p: readonly number[], d: number): number[] {
  const n = p.length / 2;
  const s = polyArea(p) > 0 ? 1 : -1;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const h = (i + n - 1) % n, j = (i + 1) % n;
    let e0x = p[i * 2] - p[h * 2], e0y = p[i * 2 + 1] - p[h * 2 + 1];
    let e1x = p[j * 2] - p[i * 2], e1y = p[j * 2 + 1] - p[i * 2 + 1];
    const l0 = Math.hypot(e0x, e0y) || 1, l1 = Math.hypot(e1x, e1y) || 1;
    e0x /= l0; e0y /= l0; e1x /= l1; e1y /= l1;
    // inward normals (left of the edge for CCW)
    const n0x = -e0y * s, n0y = e0x * s, n1x = -e1y * s, n1y = e1x * s;
    let mx = n0x + n1x, my = n0y + n1y;
    const k = 1 + n0x * n1x + n0y * n1y;
    if (k < 0.2) { mx = n0x + n1x; my = n0y + n1y; const l = Math.hypot(mx, my) || 1; out.push(p[i * 2] + (mx / l) * d, p[i * 2 + 1] + (my / l) * d); continue; }
    mx /= k; my /= k;
    out.push(p[i * 2] + mx * d, p[i * 2 + 1] + my * d);
  }
  return out;
}

/** Extrude a 2D polygon (x,y pairs in the XY plane) along Z from z0 to z1. Flat side normals (hard edges).
 * caps: 1 = at z0 (facing -Z), 2 = at z1 (+Z). Triangles: 2N sides + (N - 2) per cap. */
export function extrude(b: PartBuilder, prof: readonly number[], z0: number, z1: number, caps = 3): void {
  const n = prof.length / 2;
  const s = polyArea(prof) > 0 ? 1 : -1;
  const hz = (z1 - z0) / 2;
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = prof[i * 2], ay = prof[i * 2 + 1], bx = prof[j * 2], by = prof[j * 2 + 1];
    const ex = bx - ax, ey = by - ay, l = Math.hypot(ex, ey) || 1;
    const nx = (ey / l) * s, ny = (-ex / l) * s; // outward
    // side strip: edge coordinates across it (the profile corners) and along the extrusion (the caps)
    const V = (x: number, y: number, z: number, u: number, su: number, sz: number): number =>
      sideV(b, x, y, z, nx, ny, 0, u, z, l / 2, su, hz, sz);
    b.quad(V(ax, ay, z0, acc, -1, -1), V(bx, by, z0, acc + l, 1, -1), V(bx, by, z1, acc + l, 1, 1), V(ax, ay, z1, acc, -1, 1));
    acc += l;
  }
  if (caps) {
    const tri = triangulate(prof);
    for (let e = 0; e < 2; e++) {
      if (!(caps & (1 << e))) continue;
      const z = e === 0 ? z0 : z1, nz = e === 0 ? -1 : 1;
      const ids: number[] = [];
      capVerts(b, prof, z, nz, ids);
      for (let t = 0; t < tri.length; t += 3) b.tri(ids[tri[t]], ids[tri[t + 1]], ids[tri[t + 2]]);
    }
  }
}

/** Vertex of a planar side strip with uv (u across, v along) and edge coordinates (hu, su) across and (hv, sv) along;
 * grain mode runs u along the strip's longer side. */
function sideV(b: PartBuilder, x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, v: number,
  hu: number, su: number, hv: number, sv: number): number {
  const ea = b.ec(hu, su), eb = b.ec(hv, sv);
  return b.grain && hv > hu ? b.v(x, y, z, nx, ny, nz, v, u, eb, ea) : b.v(x, y, z, nx, ny, nz, u, v, ea, eb);
}

/** Cap vertices of an extrusion (polygon `prof` at z, facing nz) into `ids`: uv (x -nz, y), edge coordinates over the
 * polygon's bounding box (exact for rectangles, the nearest box side for other profiles). */
function capVerts(b: PartBuilder, prof: readonly number[], z: number, nz: number, ids: number[]): void {
  let xa = Infinity, xb = -Infinity, ya = Infinity, yb = -Infinity;
  for (let i = 0; i < prof.length; i += 2) {
    xa = Math.min(xa, prof[i]); xb = Math.max(xb, prof[i]); ya = Math.min(ya, prof[i + 1]); yb = Math.max(yb, prof[i + 1]);
  }
  const hx = (xb - xa) / 2, hy = (yb - ya) / 2;
  for (let i = 0; i < prof.length; i += 2) {
    const x = prof[i], y = prof[i + 1];
    ids.push(sideV(b, x, y, z, 0, 0, nz, x * -nz, y, hx, rel(x - xa - hx, hx), hy, rel(y - ya - hy, hy)));
  }
}
export const extrudeTris = (n: number, caps = 3): number => 2 * n + ((caps & 1) ? n - 2 : 0) + ((caps & 2) ? n - 2 : 0);

/** Extrusion with c-metre chamfers around both caps: caps use the polygon offset inward by c, then a chamfer
 * band to the full profile, a straight band, and a chamfer band back. Triangles: 6N + 2 (N - 2). */
export function extrudeBevel(b: PartBuilder, prof: readonly number[], z0: number, z1: number, c: number): void {
  const n = prof.length / 2;
  const cc = Math.min(c, 0.45 * (z1 - z0));
  const inner = offsetPoly(prof, cc);
  const s = polyArea(prof) > 0 ? 1 : -1;
  const edgeN = (i: number): [number, number] => {
    const j = (i + 1) % n;
    const ex = prof[j * 2] - prof[i * 2], ey = prof[j * 2 + 1] - prof[i * 2 + 1], l = Math.hypot(ex, ey) || 1;
    return [(ey / l) * s, (-ex / l) * s];
  };
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const [nx, ny] = edgeN(i);
    const l = Math.hypot(prof[j * 2] - prof[i * 2], prof[j * 2 + 1] - prof[i * 2 + 1]);
    const ax = prof[i * 2], ay = prof[i * 2 + 1], bx = prof[j * 2], by = prof[j * 2 + 1];
    const iax = inner[i * 2], iay = inner[i * 2 + 1], ibx = inner[j * 2], iby = inner[j * 2 + 1];
    // straight band (edge coordinates across the side and along the whole length: the chamfers sit on the ends)
    const hz = (z1 - z0) / 2, sz = (z: number): number => rel(z - z0 - hz, hz);
    const V = (x: number, y: number, z: number, nz: number, u: number, v: number, su: number, k: number): number =>
      sideV(b, x, y, z, nx * k, ny * k, nz, u, v, l / 2, su, hz, sz(z));
    b.quad(V(ax, ay, z0 + cc, 0, acc, z0, -1, 1), V(bx, by, z0 + cc, 0, acc + l, z0, 1, 1), V(bx, by, z1 - cc, 0, acc + l, z1, 1, 1), V(ax, ay, z1 - cc, 0, acc, z1, -1, 1));
    // chamfer bands (normal halfway between side and cap)
    const k = Math.SQRT1_2;
    b.quad(V(iax, iay, z0, -k, acc, z0, -1, k), V(ibx, iby, z0, -k, acc + l, z0, 1, k), V(bx, by, z0 + cc, -k, acc + l, z0 + cc, 1, k), V(ax, ay, z0 + cc, -k, acc, z0 + cc, -1, k));
    b.quad(V(ax, ay, z1 - cc, k, acc, z1 - cc, -1, k), V(bx, by, z1 - cc, k, acc + l, z1 - cc, 1, k), V(ibx, iby, z1, k, acc + l, z1, 1, k), V(iax, iay, z1, k, acc, z1, -1, k));
    acc += l;
  }
  const tri = triangulate(inner);
  for (let e = 0; e < 2; e++) {
    const z = e === 0 ? z0 : z1, nz = e === 0 ? -1 : 1;
    const ids: number[] = [];
    capVerts(b, inner, z, nz, ids);
    for (let t = 0; t < tri.length; t += 3) b.tri(ids[tri[t]], ids[tri[t + 1]], ids[tri[t + 2]]);
  }
}
export const extrudeBevelTris = (n: number): number => 6 * n + 2 * (n - 2);

/** Rectangular frame in the XY plane around the opening [x0,x1] x [y0,y1], bar width `bar`, depth z0..z1.
 * `bottom` = include the bottom bar. 4 (or 3) boxes. */
export function frame(b: PartBuilder, x0: number, y0: number, x1: number, y1: number, bar: number, z0: number, z1: number, bottom = true, skip = 0): void {
  box(b, x0 - bar, y0 - (bottom ? bar : 0), z0, x0, y1 + bar, z1, skip); // left
  box(b, x1, y0 - (bottom ? bar : 0), z0, x1 + bar, y1 + bar, z1, skip); // right
  box(b, x0, y1, z0, x1, y1 + bar, z1, skip); // top
  if (bottom) box(b, x0, y0 - bar, z0, x1, y0, z1, skip);
}

// ------------------------------------------------------------------------------------------ height fields

/** Height-field sheet over an (nx+1) x (nz+1) vertex grid: position (xOf(i,j), yOf(i,j), zOf(i,j)), normals from
 * central differences (smooth across rows). Each row strip j has its own vertices, and `row(j)` (optional) is
 * called before it, so rows can switch material (stripes). `wallY` !== null adds vertical boundary walls from the
 * sheet edge down to y = wallY. Triangles: 2 nx nz (+ 4 (nx + nz) with walls). */
export function heightGrid(
  b: PartBuilder, nx: number, nz: number,
  xOf: (i: number, j: number) => number, yOf: (i: number, j: number) => number, zOf: (i: number, j: number) => number,
  wallY: number | null, row?: (j: number) => void,
): void {
  const ci = (i: number): number => (i < 0 ? 0 : i > nx ? nx : i);
  const cj = (j: number): number => (j < 0 ? 0 : j > nz ? nz : j);
  const nrm = (i: number, j: number, out: number[]): void => {
    const i0 = ci(i - 1), i1 = ci(i + 1), j0 = cj(j - 1), j1 = cj(j + 1);
    const ax = xOf(i1, j) - xOf(i0, j), ay = yOf(i1, j) - yOf(i0, j), az = zOf(i1, j) - zOf(i0, j);
    const bx = xOf(i, j1) - xOf(i, j0), by = yOf(i, j1) - yOf(i, j0), bz = zOf(i, j1) - zOf(i, j0);
    // n = b x a points up for x along i and z along j
    let nx2 = by * az - bz * ay, ny2 = bz * ax - bx * az, nz2 = bx * ay - by * ax;
    if (ny2 < 0) { nx2 = -nx2; ny2 = -ny2; nz2 = -nz2; }
    const l = Math.hypot(nx2, ny2, nz2) || 1;
    out[0] = nx2 / l; out[1] = ny2 / l; out[2] = nz2 / l;
  };
  const n3 = [0, 0, 0];
  // edge coordinates from the grid parameters (the sheet's rim is its edge), half extents from its first row / column
  const hi = Math.hypot(xOf(nx, 0) - xOf(0, 0), yOf(nx, 0) - yOf(0, 0), zOf(nx, 0) - zOf(0, 0)) / 2;
  const hj = Math.hypot(xOf(0, nz) - xOf(0, 0), yOf(0, nz) - yOf(0, 0), zOf(0, nz) - zOf(0, 0)) / 2;
  for (let j = 0; j < nz; j++) {
    row?.(j);
    const r0: number[] = [], r1: number[] = [];
    for (let i = 0; i <= nx; i++) {
      for (let k = 0; k < 2; k++) {
        const jj = j + k;
        nrm(i, jj, n3);
        const x = xOf(i, jj), z = zOf(i, jj);
        const id = b.v(x, yOf(i, jj), z, n3[0], n3[1], n3[2], x, z, b.ec(hi, (2 * i) / nx - 1), b.ec(hj, (2 * jj) / nz - 1));
        (k ? r1 : r0).push(id);
      }
    }
    for (let i = 0; i < nx; i++) b.quad(r0[i], r0[i + 1], r1[i + 1], r1[i]);
  }
  if (wallY === null) return;
  // walls along the 4 boundary polylines
  const wall = (count: number, P: (k: number) => [number, number]): void => {
    for (let k = 0; k < count; k++) {
      const p0 = P(k), p1 = P(k + 1);
      const x0 = xOf(p0[0], p0[1]), z0 = zOf(p0[0], p0[1]), y0 = yOf(p0[0], p0[1]);
      const x1 = xOf(p1[0], p1[1]), z1 = zOf(p1[0], p1[1]), y1 = yOf(p1[0], p1[1]);
      // outward normal: horizontal, perpendicular to the edge, away from the grid centre
      let nx2 = z1 - z0, nz2 = -(x1 - x0);
      const cx = xOf(nx >> 1, nz >> 1), cz = zOf(nx >> 1, nz >> 1);
      if (nx2 * ((x0 + x1) / 2 - cx) + nz2 * ((z0 + z1) / 2 - cz) < 0) { nx2 = -nx2; nz2 = -nz2; }
      const l = Math.hypot(nx2, nz2) || 1;
      nx2 /= l; nz2 /= l;
      const len = Math.hypot(x1 - x0, z1 - z0);
      b.quad(b.v(x0, wallY, z0, nx2, 0, nz2, 0, wallY), b.v(x1, wallY, z1, nx2, 0, nz2, len, wallY), b.v(x1, y1, z1, nx2, 0, nz2, len, y1), b.v(x0, y0, z0, nx2, 0, nz2, 0, y0));
    }
  };
  wall(nx, (k) => [k, 0]);
  wall(nx, (k) => [k, nz]);
  wall(nz, (k) => [0, k]);
  wall(nz, (k) => [nx, k]);
}
export const heightGridTris = (nx: number, nz: number, walls: boolean): number => 2 * nx * nz + (walls ? 4 * (nx + nz) : 0);
