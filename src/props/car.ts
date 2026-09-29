// src/props/car.ts — CAR_SEDAN (§5 WP6): a mid-size sedan, <= 2500 triangles. METAL_PAINTED body and pillars under
// a clearcoat (aux.z bit 1: the lacquer lobe, chunks/materialPost.ts), dark glass, RUBBER tyres, silver rims; variant
// 3 = driver door open (narrower compact body so the door stays inside the PROP_DEFS footprint; see
// docs/contract-changes/WP6.md). Front faces -Z. Pure module (no three/DOM).
//
// Body: the side profile (z, y) with wheel-arch cut-outs is split at the door shut lines into four sections, each a
// chamfered extrusion across the width (the chamfer grooves between sections read as panel gaps). The greenhouse
// is a symmetric loft with tumblehome; windows are dark glossy glass with painted pillar overlays.

import { Mat } from '../core/ids.ts';
import type { PartBuilder } from './builder.ts';
import type { PropBuild } from './furniture.ts';
import { bevelBox, box, cylinder, extrudeBevel, hexa, lathe, rect, SKIP, triangulate } from './primitives.ts';

type RGB = readonly [number, number, number];
const PAINT: readonly RGB[] = [[0.3, 0.035, 0.03], [0.42, 0.39, 0.3], [0.04, 0.07, 0.16], [0.45, 0.45, 0.43]];
const GLASS: RGB = [0.012, 0.014, 0.016];

const ZF = -1.36, ZR = 1.36, WHEEL_Y = 0.316, ARCH_R = 0.37, ARCH_Y = 0.31, SILL = 0.24;

/** Side profile of the lower body in (z, y), with both wheel arches (clockwise when z is right and y up). */
function sideProfile(): number[] {
  const p: number[] = [
    -2.25, SILL, -2.28, 0.38, -2.27, 0.55, -2.2, 0.66, -1.9, 0.72, -1.0, 0.8, 1.35, 0.84, 2.0, 0.84, 2.22, 0.8,
    2.28, 0.66, 2.28, 0.45, 2.25, SILL,
  ];
  const arch = (zc: number): void => {
    p.push(zc + ARCH_R, SILL);
    const n = 7;
    for (let k = 0; k <= n; k++) {
      const a = (k / n) * Math.PI;
      p.push(zc + ARCH_R * Math.cos(a), ARCH_Y + ARCH_R * Math.sin(a));
    }
    p.push(zc - ARCH_R, SILL);
  };
  arch(ZR);
  arch(ZF);
  return p;
}

/** Sutherland-Hodgman clip of a (z, y) polygon to za <= z <= zb. */
function clipZ(p: readonly number[], za: number, zb: number): number[] {
  const half = (poly: number[], keep: (z: number) => boolean, zc: number): number[] => {
    const out: number[] = [];
    const n = poly.length / 2;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const az = poly[i * 2], ay = poly[i * 2 + 1], bz = poly[j * 2], by = poly[j * 2 + 1];
      const ka = keep(az), kb = keep(bz);
      if (ka) out.push(az, ay);
      if (ka !== kb) {
        const t = (zc - az) / (bz - az);
        out.push(zc, ay + (by - ay) * t);
      }
    }
    // drop consecutive duplicates
    const d: number[] = [];
    for (let i = 0; i < out.length; i += 2) {
      const k = d.length;
      if (k >= 2 && Math.abs(d[k - 2] - out[i]) < 1e-6 && Math.abs(d[k - 1] - out[i + 1]) < 1e-6) continue;
      d.push(out[i], out[i + 1]);
    }
    if (d.length >= 4 && Math.abs(d[0] - d[d.length - 2]) < 1e-6 && Math.abs(d[1] - d[d.length - 1]) < 1e-6) d.length -= 2;
    return d;
  };
  return half(half(p.slice(), (z) => z >= za, za), (z) => z <= zb, zb);
}

/** Body section: profile (z, y) extruded across x in [x0, x1] with chamfered edges. */
function section(b: PartBuilder, prof: readonly number[], x0: number, x1: number, c: number): void {
  b.push();
  b.basis(0, 0, 1, 0, 1, 0, -1, 0, 0); // local X -> +Z, Y -> Y, Z -> -X
  extrudeBevel(b, prof, -x1, -x0, c);
  b.pop();
}

// greenhouse (z, y) polyline from the windshield base over the roof to the rear-window base
const GH = [-0.95, 0.8, -0.3, 1.36, -0.1, 1.41, 0.75, 1.41, 0.95, 1.37, 1.4, 0.84];
const GH_GLASS = [true, false, false, false, true]; // per segment

function greenhouse(b: PartBuilder, hw: number, paint: RGB): void {
  const hw0 = hw - 0.03, k = 0.12 / 0.61; // half width at y = 0.8, tumblehome slope
  const hwAt = (y: number): number => hw0 - k * (y - 0.8);
  const n = GH.length / 2;
  // bands across the car (windshield, roof, rear window)
  for (let s = 0; s < n - 1; s++) {
    const za = GH[s * 2], ya = GH[s * 2 + 1], zb = GH[s * 2 + 2], yb = GH[s * 2 + 3];
    let ny = zb - za, nz = -(yb - ya);
    const l = Math.hypot(ny, nz) || 1;
    ny /= l; nz /= l;
    if (GH_GLASS[s]) b.mat(Mat.PLASTIC, GLASS[0], GLASS[1], GLASS[2], 0, 0.05);
    else b.mat(Mat.METAL_PAINTED, paint[0], paint[1], paint[2], 0, 0.25, true);
    const wa = hwAt(ya), wb = hwAt(yb);
    const len = Math.hypot(zb - za, yb - ya);
    b.quad(b.v(-wa, ya, za, 0, ny, nz, -wa, 0), b.v(wa, ya, za, 0, ny, nz, wa, 0), b.v(wb, yb, zb, 0, ny, nz, wb, len), b.v(-wb, yb, zb, 0, ny, nz, -wb, len));
  }
  // side planes: glass + painted pillar / rail overlays + black belt trim
  const nl = Math.hypot(1, k);
  const side = (poly: readonly number[], s: number, off: number): void => {
    const nx = s / nl, ny = k / nl;
    const ids: number[] = [];
    for (let i = 0; i < poly.length; i += 2) {
      const z = poly[i], y = poly[i + 1];
      ids.push(b.v(s * hwAt(y) + nx * off, y + ny * off, z, nx, ny, 0, z, y));
    }
    const t = triangulate(poly);
    for (let i = 0; i < t.length; i += 3) b.tri(ids[t[i]], ids[t[i + 1]], ids[t[i + 2]]);
  };
  const A = [-0.95, 0.8, -0.3, 1.36, -0.22, 1.36, -0.86, 0.8];
  const RAIL = [-0.3, 1.36, -0.1, 1.41, 0.75, 1.41, 0.95, 1.37, 0.92, 1.315, 0.72, 1.35, -0.1, 1.35, -0.25, 1.31];
  const B = [0.08, 0.81, 0.17, 0.81, 0.17, 1.35, 0.08, 1.35];
  const C = [1.4, 0.84, 0.95, 1.37, 0.8, 1.35, 1.12, 0.84];
  const BELT = [-0.95, 0.8, 1.4, 0.84, 1.4, 0.875, -0.9, 0.835];
  for (const s of [-1, 1]) {
    b.mat(Mat.PLASTIC, GLASS[0], GLASS[1], GLASS[2], 0, 0.05);
    side(GH, s, 0);
    b.mat(Mat.METAL_PAINTED, paint[0], paint[1], paint[2], 0, 0.25, true);
    side(A, s, 0.003);
    side(RAIL, s, 0.003);
    side(B, s, 0.003);
    side(C, s, 0.003);
    b.mat(Mat.PLASTIC, 0.02, 0.02, 0.02, 0, 0.3);
    side(BELT, s, 0.004);
  }
}

function wheel(b: PartBuilder, x: number, z: number, outward: number): void {
  b.push();
  b.translate(x, WHEEL_Y, z);
  b.rotZ(-outward * Math.PI / 2); // local +Y -> outward (+-X)
  b.mat(Mat.RUBBER);
  lathe(b, [0.2, -0.1, 0.28, -0.105, 0.305, -0.09, 0.315, -0.03, 0.315, 0.03, 0.305, 0.09, 0.28, 0.105, 0.2, 0.1], 14, 0, 40);
  b.mat(Mat.METAL_PAINTED, 0.42, 0.42, 0.42, 0, 0.3);
  lathe(b, [0.2, 0.1, 0.19, 0.09, 0.12, 0.07, 0.05, 0.08, 0, 0.085], 14, 0, 30);
  b.pop();
}

export const carSedan: PropBuild = (b, v) => {
  const paint = PAINT[v];
  const open = v === 3;
  const hw = open ? 0.74 : 0.82;
  const prof = sideProfile();
  const cuts = [-2.3, -0.95, 0.12, 0.98, 2.3];
  const C = 0.045;
  b.mat(Mat.METAL_PAINTED, paint[0], paint[1], paint[2], 0, 0.25, true);
  for (let s = 0; s < 4; s++) {
    const sec = clipZ(prof, cuts[s], cuts[s + 1]);
    if (open && s === 1) {
      // driver (-x) front door as a separate slab, swung open about its front (hinge) edge
      const DT = 0.07;
      section(b, sec, -hw + DT, hw, C);
      const L = cuts[2] - cuts[1];
      const ang = Math.asin(Math.min(0.99, (0.9 - hw - 0.004) / L));
      b.push();
      b.translate(-hw, 0, cuts[1]);
      b.rotY(-ang);
      b.translate(hw, 0, -cuts[1]);
      section(b, sec, -hw, -hw + DT, 0.02);
      b.mat(Mat.METAL_BARE, 0.56, 0.56, 0.55, 0, 0.12); // chrome handle
      box(b, -hw - 0.015, 0.73, -0.25, -hw, 0.75, -0.13, SKIP.PX); // handle
      b.mat(Mat.METAL_PAINTED, paint[0], paint[1], paint[2], 0, 0.25, true);
      b.pop();
    } else section(b, sec, -hw, hw, C);
  }
  greenhouse(b, hw, paint);
  // dark cabin floor / wheel wells / underbody (seen through arches and under the sills)
  b.mat(Mat.PLENUM);
  box(b, -hw + 0.25, 0.14, -1.8, hw - 0.25, SILL + 0.01, 1.8, SKIP.PY);
  for (const zc of [ZF, ZR]) box(b, -hw + 0.21, SILL, zc - ARCH_R, hw - 0.21, 0.67, zc + ARCH_R, 0);
  // bumpers
  b.mat(Mat.PLASTIC, 0.05, 0.05, 0.055, 0, 0.35);
  bevelBox(b, -hw + 0.02, 0.22, -2.285, hw - 0.02, 0.4, -2.14, 0.03);
  bevelBox(b, -hw + 0.02, 0.22, 2.14, hw - 0.02, 0.4, 2.285, 0.03);
  // grille
  b.mat(Mat.PLASTIC, 0.015, 0.015, 0.017, 0, 0.4);
  box(b, -0.42, 0.42, -2.29, 0.42, 0.54, -2.2, SKIP.PZ);
  // lamps
  b.mat(Mat.PLASTIC, 0.5, 0.5, 0.48, 0, 0.05);
  for (const s of [-1, 1]) bevelBox(b, s > 0 ? hw - 0.3 : -hw + 0.04, 0.52, -2.27, s > 0 ? hw - 0.04 : -hw + 0.3, 0.62, -2.15, 0.02);
  b.mat(Mat.PLASTIC, 0.35, 0.015, 0.012, 0, 0.1);
  for (const s of [-1, 1]) bevelBox(b, s > 0 ? hw - 0.3 : -hw + 0.04, 0.6, 2.17, s > 0 ? hw - 0.04 : -hw + 0.3, 0.7, 2.285, 0.02);
  // number plates
  b.mat(Mat.PLASTIC, 0.5, 0.5, 0.45, 0, 0.3);
  rect(b, 0, 0.31, -2.2875, 0.26, 0, 0, 0, 0.055, 0, 0, 0, -1);
  rect(b, 0, 0.31, 2.2875, 0.26, 0, 0, 0, 0.055, 0, 0, 0, 1);
  // mirrors on the front fenders
  b.mat(Mat.PLASTIC, 0.03, 0.03, 0.033, 0, 0.3);
  for (const s of [-1, 1]) {
    const x0 = s * (hw - 0.02), x1 = s * (hw + 0.075);
    hexa(b, [x0, 0.86, -1.05, x1, 0.88, -1.03, x1, 0.88, -0.97, x0, 0.86, -0.95,
      x0, 0.97, -1.05, x1, 0.96, -1.03, x1, 0.96, -0.97, x0, 0.97, -0.95]);
    // mounting sail from the door top up into the mirror housing
    const xi = s * (hw - 0.035), xo = s * (hw - 0.005);
    box(b, Math.min(xi, xo), 0.76, -1.0, Math.max(xi, xo), 0.9, -0.9, 0);
  }
  // door handles (chrome)
  b.mat(Mat.METAL_BARE, 0.56, 0.56, 0.55, 0, 0.12);
  for (const s of [-1, 1]) {
    for (const z of [-0.19, 0.64]) {
      if (open && s < 0 && z < 0) continue; // on the open door (drawn above)
      if (s > 0) box(b, hw, 0.73, z - 0.06, hw + 0.015, 0.75, z + 0.06, SKIP.NX);
      else box(b, -hw - 0.015, 0.73, z - 0.06, -hw, 0.75, z + 0.06, SKIP.PX);
    }
  }
  // exhaust
  b.mat(Mat.METAL_PAINTED, 0.15, 0.15, 0.15, 0, 0.5);
  b.push();
  b.translate(0.45, 0.2, 2.2);
  b.rotX(Math.PI / 2); // +Y -> +Z
  cylinder(b, 0.03, 0.03, 0, 0.085, 8, 0);
  b.pop();
  // wheels
  for (const s of [-1, 1]) for (const zc of [ZF, ZR]) wheel(b, s * (hw - 0.1), zc, s);
};
