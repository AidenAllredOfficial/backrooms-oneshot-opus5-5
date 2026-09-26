// src/bake/areaLight.ts — emitter form factors and stratified emitter sampling (WP7 §Algorithms 5). Pure module.
//
// Hybrid form factor for RECT emitters (one-sided Lambertian, luminance L):
//   d < POLY_EXACT_FACTOR * max(w, h): the emitter rectangle is clipped (Sutherland–Hodgman) to the receiver's
//     tangent half-space and integrated with the Lambert polygon formula
//       E = L/2 * sum_k acos(v_k . v_k+1) * (n . normalize(v_k x v_k+1));
//   otherwise a point (or, for elongated emitters, 2-point) sample  E = L * A * max(0, n.w) * max(0, -nL.w) / d^2.
// SPHERE: E = I * max(0, n.w) / max(d^2, r^2) (soft core). HIGHBAY disk: the same x max(0, -nL.w).
// Prismatic-lens emitters (L.lens[l] = 1: troffers) are not ideal Lambertian: their radiance falls with the
// emission angle, I(theta) ~ cos^LENS_N(theta), normalised by (LENS_N + 1) / 2 so the flux is unchanged; i.e. every
// emitter-side cosine ce is multiplied by lensW(ce) = LENS_NORM * ce^(LENS_N - 1). Point samples weight each sample;
// the exact polygon splits the rectangle into LENS_SU x LENS_SV sub-rectangles (each exact, weighted at its centre)
// when d < LENS_SPLIT0 * size, blends to the whole polygon weighted at its clipped centroid direction up to
// LENS_SPLIT1 * size, and uses that beyond (continuous everywhere). This concentrates bright pools under the
// fixtures and lets the upper walls between them fall off, as real troffers do.
// Everything returns the GEOMETRIC factor F (E = F * radiance or intensity) and the unit direction toward the
// light's projected centroid in `ff` (used for the dominant-direction accumulation).
// Inputs: receiver position x/z in halo cells, y in metres, receiver unit normal (world).

import { CELL, LIGHT } from '../core/constants.ts';
import { hash01, hash3, hash4, SALT } from '../core/rng.ts';
import { SHAPE_DISK, SHAPE_RECT, SHAPE_SPHERE, type LightSet } from './lights.ts';
import { quant } from './util.ts';

export const ff = { wx: 0, wy: 1, wz: 0, d2: 1 };

/** Prismatic lens exponent (cos^1.5: sqrt instead of pow in the hot loop) and its flux normalisation. */
export const LENS_N = 1.5;
export const LENS_NORM = (LENS_N + 1) / 2;
export const LENS_SU = 4, LENS_SV = 2;
export const LENS_SPLIT0 = 1.0, LENS_SPLIT1 = 1.5;
/** Lens weight of an emitter-side cosine (ce > 0). */
export const lensW = (ce: number): number => LENS_NORM * Math.sqrt(ce);

const poly = new Float64Array(3 * 8);
const clipped = new Float64Array(3 * 8);

/** Exact irradiance factor of a rectangle given by 4 corner vectors relative to the receiver (metres). */
function polygonFactor(nx: number, ny: number, nz: number, nv: number): number {
  // clip against n.v >= 0
  let m = 0;
  for (let k = 0; k < nv; k++) {
    const a = k * 3, b = ((k + 1) % nv) * 3;
    const ax = poly[a], ay = poly[a + 1], az = poly[a + 2];
    const bx = poly[b], by = poly[b + 1], bz = poly[b + 2];
    const da = nx * ax + ny * ay + nz * az, db = nx * bx + ny * by + nz * bz;
    if (da >= 0) { clipped[m * 3] = ax; clipped[m * 3 + 1] = ay; clipped[m * 3 + 2] = az; m++; }
    if ((da >= 0) !== (db >= 0)) {
      const t = da / (da - db);
      clipped[m * 3] = ax + (bx - ax) * t; clipped[m * 3 + 1] = ay + (by - ay) * t; clipped[m * 3 + 2] = az + (bz - az) * t;
      m++;
    }
  }
  if (m < 3) { ff.wx = 0; ff.wy = 0; ff.wz = 0; return 0; }
  let sum = 0, cx = 0, cy = 0, cz = 0;
  for (let k = 0; k < m; k++) {
    const a = k * 3;
    cx += clipped[a]; cy += clipped[a + 1]; cz += clipped[a + 2];
    const l = Math.hypot(clipped[a], clipped[a + 1], clipped[a + 2]);
    const il = l > 1e-12 ? 1 / l : 0;
    clipped[a] *= il; clipped[a + 1] *= il; clipped[a + 2] *= il;
  }
  for (let k = 0; k < m; k++) {
    const a = k * 3, b = ((k + 1) % m) * 3;
    const ax = clipped[a], ay = clipped[a + 1], az = clipped[a + 2];
    const bx = clipped[b], by = clipped[b + 1], bz = clipped[b + 2];
    let c = ax * bx + ay * by + az * bz;
    c = c > 1 ? 1 : c < -1 ? -1 : c;
    const crx = ay * bz - az * by, cry = az * bx - ax * bz, crz = ax * by - ay * bx;
    const s = Math.hypot(crx, cry, crz);
    if (s < 1e-12) continue;
    const th = Math.acos(c);
    sum += (th / s) * (nx * crx + ny * cry + nz * crz);
  }
  const cl = Math.hypot(cx, cy, cz);
  if (cl > 1e-12) { ff.wx = cx / cl; ff.wy = cy / cl; ff.wz = cz / cl; }
  const e = 0.5 * sum;
  return e < 0 ? -e : e;
}

/**
 * Geometric irradiance factor of light l at receiver (px, py, pz) with unit normal n, WITHOUT window or
 * visibility. `exactFactor`: use the exact polygon when d < exactFactor * size (POLY_EXACT_FACTOR in the full
 * bake). Sets ff.w* (unit direction to the light) and ff.d2 (squared distance to the centre, m^2).
 */
export function formFactor(L: LightSet, l: number, px: number, py: number, pz: number, nx: number, ny: number, nz: number, exactFactor: number): number {
  const o = l * 3;
  const rx = (L.pos[o] - px) * CELL, ry = L.pos[o + 1] - py, rz = (L.pos[o + 2] - pz) * CELL;
  const d2 = rx * rx + ry * ry + rz * rz;
  ff.d2 = d2;
  const d = Math.sqrt(d2);
  const inv = d > 1e-9 ? 1 / d : 0;
  const wx = rx * inv, wy = ry * inv, wz = rz * inv;
  const lnx = L.nrm[o], lny = L.nrm[o + 1], lnz = L.nrm[o + 2];
  const shape = L.shape[l];
  if (shape !== SHAPE_RECT) {
    ff.wx = wx; ff.wy = wy; ff.wz = wz;
    const cosr = nx * wx + ny * wy + nz * wz;
    if (cosr <= 0) return 0;
    const r = L.w[l] * 0.5;
    let f = cosr / (d2 > r * r ? d2 : r * r);
    if (shape === SHAPE_DISK) {
      const ce = -(lnx * wx + lny * wy + lnz * wz);
      if (ce <= 0) return 0;
      f *= ce;
    }
    return f;
  }
  // one-sided: receiver must be in front of the emitter plane
  if (-(lnx * rx + lny * ry + lnz * rz) <= 0) { ff.wx = wx; ff.wy = wy; ff.wz = wz; return 0; }
  const hw = L.w[l] * 0.5, hh = L.h[l] * 0.5;
  const tx = L.tan[o], ty = L.tan[o + 1], tz = L.tan[o + 2];
  const bx = L.bit[o], by = L.bit[o + 1], bz = L.bit[o + 2];
  const lens = L.lens[l] !== 0;
  if (d < exactFactor * L.size[l]) {
    if (!lens) return rectPolygon(rx, ry, rz, tx, ty, tz, bx, by, bz, -hw, hw, -hh, hh, nx, ny, nz);
    const near = d < LENS_SPLIT1 * L.size[l];
    let fs = 0, sx = 0, sy = 0, sz = 0;
    if (near) {
      // sub-rectangles, each weighted at its centre
      const du = (2 * hw) / LENS_SU, dv = (2 * hh) / LENS_SV;
      for (let b = 0; b < LENS_SV; b++) {
        const v0 = -hh + b * dv, vc = v0 + 0.5 * dv;
        for (let a = 0; a < LENS_SU; a++) {
          const u0 = -hw + a * du, uc = u0 + 0.5 * du;
          const qx = rx + tx * uc + bx * vc, qy = ry + ty * uc + by * vc, qz = rz + tz * uc + bz * vc;
          const ql = Math.sqrt(qx * qx + qy * qy + qz * qz);
          const ce = ql > 1e-12 ? -(lnx * qx + lny * qy + lnz * qz) / ql : 1;
          if (ce <= 0) continue;
          const f = rectPolygon(rx, ry, rz, tx, ty, tz, bx, by, bz, u0, u0 + du, v0, v0 + dv, nx, ny, nz);
          if (f <= 0) continue;
          const k = f * lensW(ce);
          fs += k; sx += k * ff.wx; sy += k * ff.wy; sz += k * ff.wz;
        }
      }
    }
    if (near && d < LENS_SPLIT0 * L.size[l]) {
      const sl = Math.sqrt(sx * sx + sy * sy + sz * sz);
      if (sl > 1e-12) { ff.wx = sx / sl; ff.wy = sy / sl; ff.wz = sz / sl; } else { ff.wx = wx; ff.wy = wy; ff.wz = wz; }
      return fs;
    }
    // whole polygon weighted at its clipped centroid direction (blended with the split below LENS_SPLIT1 * size)
    let f = rectPolygon(rx, ry, rz, tx, ty, tz, bx, by, bz, -hw, hw, -hh, hh, nx, ny, nz);
    if (f > 0) {
      const ce = -(lnx * ff.wx + lny * ff.wy + lnz * ff.wz);
      f = ce > 0 ? f * lensW(ce) : 0;
    }
    if (!near) return f;
    const t = (d - LENS_SPLIT0 * L.size[l]) / ((LENS_SPLIT1 - LENS_SPLIT0) * L.size[l]);
    const s2 = t * t * (3 - 2 * t);
    const cwx = ff.wx * f, cwy = ff.wy * f, cwz = ff.wz * f;
    const bxs = sx + (cwx - sx) * s2, bys = sy + (cwy - sy) * s2, bzs = sz + (cwz - sz) * s2;
    const bl = Math.sqrt(bxs * bxs + bys * bys + bzs * bzs);
    if (bl > 1e-12) { ff.wx = bxs / bl; ff.wy = bys / bl; ff.wz = bzs / bl; } else { ff.wx = wx; ff.wy = wy; ff.wz = wz; }
    return fs + (f - fs) * s2;
  }
  ff.wx = wx; ff.wy = wy; ff.wz = wz;
  const area = L.w[l] * L.h[l];
  if (L.w[l] >= 1.5 * L.h[l]) {
    // 2-point sample along the long axis
    let f = 0;
    for (let s = -1; s <= 1; s += 2) {
      const qx = rx + tx * hw * 0.5 * s, qy = ry + ty * hw * 0.5 * s, qz = rz + tz * hw * 0.5 * s;
      const q2 = qx * qx + qy * qy + qz * qz;
      const qi = 1 / Math.sqrt(q2);
      const cr = (nx * qx + ny * qy + nz * qz) * qi;
      const ce = -(lnx * qx + lny * qy + lnz * qz) * qi;
      if (cr > 0 && ce > 0) f += 0.5 * area * cr * ce * (lens ? lensW(ce) : 1) / q2;
    }
    return f;
  }
  const cr = nx * wx + ny * wy + nz * wz;
  const ce = -(lnx * wx + lny * wy + lnz * wz);
  if (cr <= 0 || ce <= 0) return 0;
  return area * cr * ce * (lens ? lensW(ce) : 1) / d2;
}

/** Exact factor of the sub-rectangle [u0,u1] x [v0,v1] (emitter frame, m) of an emitter centred at r. */
function rectPolygon(rx: number, ry: number, rz: number, tx: number, ty: number, tz: number, bx: number, by: number, bz: number,
  u0: number, u1: number, v0: number, v1: number, nx: number, ny: number, nz: number): number {
  for (let k = 0; k < 4; k++) {
    const su = k === 0 || k === 3 ? u0 : u1, sv = k < 2 ? v0 : v1;
    poly[k * 3] = rx + tx * su + bx * sv;
    poly[k * 3 + 1] = ry + ty * su + by * sv;
    poly[k * 3 + 2] = rz + tz * su + bz * sv;
  }
  return polygonFactor(nx, ny, nz, 4);
}

/** Exact-polygon distance factor of the full bake. */
export const EXACT_FULL = LIGHT.POLY_EXACT_FACTOR;

// ---------------------------------------------------------------- stratified emitter samples

// The first SAMPLE_N points of the (0,2)-sequence in base 2 (Sobol dimensions 1 and 2): every prefix of 2^k points
// is stratified in both 1D projections (and in every 2D elementary interval). This world's occluders (walls,
// partitions, headers) and emitters are axis-aligned, so a shadow edge usually cuts the emitter along u or v and the
// visible fraction depends on ONE projection: with (Halton2, Halton3) the base-3 projection was not stratified (at 4
// samples two of them share a quarter), which made hard penumbrae noisy. The per-receiver Cranley-Patterson shift
// keeps the 1D stratification (it is a shift mod 1).
const SAMPLE_N = 16;
export const SAMPLE_U = new Float64Array(SAMPLE_N), SAMPLE_V = new Float64Array(SAMPLE_N);
{
  const dirV = [8, 12, 10, 15]; // Sobol dimension 2 direction numbers (x 1/16): 0.1, 0.11, 0.101, 0.1111 (binary)
  for (let i = 0; i < SAMPLE_N; i++) {
    let u = 0, v = 0;
    for (let b = 0; b < 4; b++) {
      if (((i >> b) & 1) === 0) continue;
      u += 8 >> b; // van der Corput (dimension 1): bit b -> 2^-(b+1)
      v ^= dirV[b];
    }
    SAMPLE_U[i] = u / 16; SAMPLE_V[i] = v / 16;
  }
}

/** Per-receiver Cranley–Patterson rotation from a quantized world position (mm) and the light uid. */
export const rot = { u: 0, v: 0 };
export function sampleRotation(qx: number, qy: number, qz: number, uid: number): void {
  const h = hash4(qx, qy, qz, uid ^ SALT.BAKE);
  rot.u = hash01(h);
  rot.v = hash01(hash3(h, qx, 0x51ed27));
}

/**
 * Emitter sample point i of S (after the per-receiver rotation) written to `sp` (x/z halo cells, y m), offset
 * EMIT_OFF-like along the emitting normal so the point is in free space. Receiver position needed for spheres.
 */
export const sp = { x: 0, y: 0, z: 0 };
export function emitterSample(L: LightSet, l: number, i: number, px: number, py: number, pz: number): void {
  let u = SAMPLE_U[i] + rot.u; if (u >= 1) u -= 1;
  let v = SAMPLE_V[i] + rot.v; if (v >= 1) v -= 1;
  const o = l * 3;
  const shape = L.shape[l];
  if (shape === SHAPE_RECT) {
    const su = (u - 0.5) * (L.w[l] - 0.02), sv = (v - 0.5) * (L.h[l] - 0.02);
    const wx = L.tan[o] * su + L.bit[o] * sv + L.nrm[o] * 0.02;
    const wy = L.tan[o + 1] * su + L.bit[o + 1] * sv + L.nrm[o + 1] * 0.02;
    const wz = L.tan[o + 2] * su + L.bit[o + 2] * sv + L.nrm[o + 2] * 0.02;
    sp.x = L.pos[o] + quant(wx / CELL); sp.y = L.pos[o + 1] + wy; sp.z = L.pos[o + 2] + quant(wz / CELL);
    return;
  }
  // sphere / disk: a disc facing the receiver (disk lights: in the emitter plane, just below it)
  const r = L.w[l] * 0.5 * Math.sqrt(u);
  const a = 2 * Math.PI * v;
  const ca = Math.cos(a) * r, sa = Math.sin(a) * r;
  if (shape === SHAPE_DISK) {
    const wx = L.tan[o] * ca + L.bit[o] * sa + L.nrm[o] * 0.02;
    const wy = L.tan[o + 1] * ca + L.bit[o + 1] * sa + L.nrm[o + 1] * 0.02;
    const wz = L.tan[o + 2] * ca + L.bit[o + 2] * sa + L.nrm[o + 2] * 0.02;
    sp.x = L.pos[o] + quant(wx / CELL); sp.y = L.pos[o + 1] + wy; sp.z = L.pos[o + 2] + quant(wz / CELL);
    return;
  }
  let dx = (px - L.pos[o]) * CELL, dy = py - L.pos[o + 1], dz = (pz - L.pos[o + 2]) * CELL;
  const dl = Math.hypot(dx, dy, dz) || 1;
  dx /= dl; dy /= dl; dz /= dl;
  // basis perpendicular to d
  let ex: number, ey: number, ez: number;
  if (Math.abs(dy) < 0.9) { ex = dz; ey = 0; ez = -dx; } else { ex = 0; ey = -dz; ez = dy; }
  const el = Math.hypot(ex, ey, ez); ex /= el; ey /= el; ez /= el;
  const fx = dy * ez - dz * ey, fy = dz * ex - dx * ez, fz = dx * ey - dy * ex;
  const wx = ex * ca + fx * sa, wy = ey * ca + fy * sa, wz = ez * ca + fz * sa;
  sp.x = L.pos[o] + quant(wx / CELL); sp.y = L.pos[o + 1] + wy; sp.z = L.pos[o + 2] + quant(wz / CELL);
}

/** 4 classification points on the emitter (i = 0..3), inset 1 cm and offset along the emitting normal. */
export function emitterCorner(L: LightSet, l: number, i: number): void {
  const o = l * 3;
  const shape = L.shape[l];
  const hw = shape === SHAPE_RECT ? L.w[l] * 0.5 - 0.01 : L.w[l] * 0.5, hh = shape === SHAPE_RECT ? L.h[l] * 0.5 - 0.01 : L.w[l] * 0.5;
  const su = i === 0 || i === 3 ? -hw : hw, sv = i < 2 ? -hh : hh;
  if (shape === SHAPE_SPHERE) {
    // 4 points on the sphere's horizontal great circle
    const ax = i === 0 ? hw : i === 1 ? -hw : 0, az = i === 2 ? hw : i === 3 ? -hw : 0;
    sp.x = L.pos[o] + quant(ax / CELL); sp.y = L.pos[o + 1]; sp.z = L.pos[o + 2] + quant(az / CELL);
    return;
  }
  const uu = shape === SHAPE_DISK ? (i === 0 ? hw : i === 1 ? -hw : 0) : su;
  const vv = shape === SHAPE_DISK ? (i === 2 ? hh : i === 3 ? -hh : 0) : sv;
  const wx = L.tan[o] * uu + L.bit[o] * vv + L.nrm[o] * 0.02;
  const wy = L.tan[o + 1] * uu + L.bit[o + 1] * vv + L.nrm[o + 1] * 0.02;
  const wz = L.tan[o + 2] * uu + L.bit[o + 2] * vv + L.nrm[o + 2] * 0.02;
  sp.x = L.pos[o] + quant(wx / CELL); sp.y = L.pos[o + 1] + wy; sp.z = L.pos[o + 2] + quant(wz / CELL);
}
