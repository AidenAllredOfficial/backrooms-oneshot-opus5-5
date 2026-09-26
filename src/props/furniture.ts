// src/props/furniture.ts — seating, tables and bedding: CHAIR_STACKING, OFFICE_CHAIR, DESK, CONFERENCE_TABLE,
// MATTRESS, SLEEPING_BAG (§5 WP6). Prop-local frame: base centre at the origin, +Y up, front faces -Z.
// Pure module (no three/DOM).

import { Mat } from '../core/ids.ts';
import { rnd, rndRange, type PartBuilder } from './builder.ts';
import { bevelBox, box, cylinder, extrudeBevel, heightGrid, hexa, SKIP, sweep, tubePath } from './primitives.ts';

export type PropBuild = (b: PartBuilder, variant: number, seed: number) => void;
type RGB = readonly [number, number, number];

const CHROME: RGB = [0.56, 0.56, 0.55];
const BLACK_PLASTIC: RGB = [0.035, 0.035, 0.037];

// ---------------------------------------------------------------------------------------- CHAIR_STACKING
const STACK_SEAT: readonly RGB[] = [[0.3, 0.3, 0.29], [0.06, 0.1, 0.2], [0.45, 0.14, 0.03], [0.04, 0.04, 0.045]];
export const chairStacking: PropBuild = (b, v) => {
  // tubular chrome frame
  b.mat(Mat.METAL_PAINTED, CHROME[0], CHROME[1], CHROME[2], 0, 0.22);
  const r = 0.011;
  for (const sx of [-1, 1]) {
    tubePath(b, [sx * 0.222, 0.002, -0.232, sx * 0.205, 0.44, -0.2], r, 6, 0, 0, 0); // front leg
    tubePath(b, [sx * 0.222, 0.002, 0.232, sx * 0.205, 0.44, 0.19, sx * 0.205, 0.8, 0.24], r, 6, 0.05, 2, 2); // rear leg + back upright
    sweep(b, [sx * 0.214, 0.16, -0.215, sx * 0.214, 0.16, 0.215], 0.008, 6, 0); // side stretcher
  }
  sweep(b, [-0.21, 0.4, -0.2, 0.21, 0.4, -0.2], 0.008, 6, 0); // front seat rail
  // seat and backrest
  const c = STACK_SEAT[v];
  if (v === 1) b.mat(Mat.FABRIC_PARTITION, c[0], c[1], c[2]);
  else b.mat(Mat.PLASTIC, c[0], c[1], c[2], 0, 0.35);
  bevelBox(b, -0.235, 0.43, -0.245, 0.235, 0.462, 0.222, 0.012);
  b.push();
  b.translate(0, 0.68, 0.222);
  b.rotX(0.12);
  bevelBox(b, -0.212, -0.115, -0.012, 0.212, 0.115, 0.012, 0.01);
  b.pop();
};

// ---------------------------------------------------------------------------------------- OFFICE_CHAIR
const OFFICE_FABRIC: readonly RGB[] = [[0.035, 0.035, 0.04], [0.05, 0.08, 0.16], [0.16, 0.16, 0.16], [0.2, 0.04, 0.035]];
export const officeChair: PropBuild = (b, v) => {
  // 5-star base
  b.mat(Mat.PLASTIC, BLACK_PLASTIC[0], BLACK_PLASTIC[1], BLACK_PLASTIC[2], 0, 0.35);
  for (let k = 0; k < 5; k++) {
    const a = (k * Math.PI * 2) / 5 + Math.PI / 2;
    const cx = Math.cos(a), cz = Math.sin(a), px = -cz, pz = cx; // radial and perpendicular
    const r0 = 0.03, r1 = 0.255, w0 = 0.024, w1 = 0.016;
    const P = (r: number, w: number, y: number): number[] => [cx * r + px * w, y, cz * r + pz * w];
    hexa(b, [
      ...P(r0, -w0, 0.07), ...P(r1, -w1, 0.075), ...P(r1, w1, 0.075), ...P(r0, w0, 0.07),
      ...P(r0, -w0, 0.11), ...P(r1, -w1, 0.095), ...P(r1, w1, 0.095), ...P(r0, w0, 0.11),
    ]);
    // caster: fork + twin wheel
    b.push();
    b.translate(cx * 0.262, 0, cz * 0.262);
    b.rotY(-a);
    box(b, -0.012, 0.045, -0.014, 0.012, 0.075, 0.014, 0);
    b.push();
    b.translate(0.012, 0.03, 0);
    b.rotZ(Math.PI / 2);
    cylinder(b, 0.03, 0.03, -0.012, 0.012, 8, 3);
    b.pop();
    b.pop();
  }
  // column and gas lift
  b.mat(Mat.METAL_PAINTED, 0.3, 0.3, 0.3, 0, 0.3);
  cylinder(b, 0.022, 0.022, 0.1, 0.4, 8, 0);
  b.mat(Mat.PLASTIC, BLACK_PLASTIC[0], BLACK_PLASTIC[1], BLACK_PLASTIC[2], 0, 0.35);
  cylinder(b, 0.036, 0.03, 0.1, 0.3, 8, 2);
  box(b, -0.09, 0.38, -0.1, 0.09, 0.42, 0.1, 0); // tilt mechanism
  // seat + back
  const f = OFFICE_FABRIC[v];
  b.mat(Mat.FABRIC_PARTITION, f[0], f[1], f[2]);
  bevelBox(b, -0.245, 0.42, -0.25, 0.245, 0.5, 0.24, 0.03);
  b.push();
  b.translate(0, 0.78, 0.235);
  b.rotX(0.1);
  bevelBox(b, -0.22, -0.26, -0.035, 0.22, 0.26, 0.035, 0.03);
  b.pop();
  // back spine
  b.mat(Mat.PLASTIC, BLACK_PLASTIC[0], BLACK_PLASTIC[1], BLACK_PLASTIC[2], 0, 0.35);
  hexa(b, [-0.035, 0.44, 0.19, 0.035, 0.44, 0.19, 0.035, 0.44, 0.235, -0.035, 0.44, 0.235,
    -0.035, 0.6, 0.235, 0.035, 0.6, 0.235, 0.035, 0.6, 0.27, -0.035, 0.6, 0.27]);
  if (v & 1) {
    // armrests
    for (const sx of [-1, 1]) {
      box(b, sx * 0.235 - 0.012, 0.47, -0.03, sx * 0.235 + 0.012, 0.66, 0.02, SKIP.NY);
      bevelBox(b, sx * 0.25 - 0.03, 0.66, -0.16, sx * 0.25 + 0.03, 0.69, 0.08, 0.012);
    }
  }
};

// ---------------------------------------------------------------------------------------- DESK
const DESK_WOOD: readonly RGB[] = [[0.33, 0.21, 0.11], [0.3, 0.19, 0.1], [0.5, 0.38, 0.24], [0.16, 0.09, 0.05]];
const DESK_METAL: readonly RGB[] = [[0.3, 0.3, 0.29], [0.34, 0.32, 0.27], [0.04, 0.04, 0.045], [0.25, 0.25, 0.24]];
export const desk: PropBuild = (b, v) => {
  const w = DESK_WOOD[v], m = DESK_METAL[v];
  b.mat(Mat.WOOD, w[0], w[1], w[2], 0, 0.4);
  bevelBox(b, -0.75, 0.72, -0.375, 0.75, 0.75, 0.375, 0.008);
  b.mat(Mat.METAL_PAINTED, m[0], m[1], m[2]);
  for (const sx of [-1, 1]) bevelBox(b, sx * 0.725 - 0.015, 0, -0.35, sx * 0.725 + 0.015, 0.72, 0.35, 0.006, SKIP.NY);
  box(b, -0.71, 0.3, 0.3, 0.71, 0.72, 0.33); // modesty panel
  if (v === 1 || v === 3) {
    // drawer pedestal on the right
    box(b, 0.3, 0.05, -0.33, 0.71, 0.7, 0.3, SKIP.PX | SKIP.PY);
    for (let i = 0; i < 3; i++) {
      const y0 = 0.06 + i * 0.215;
      b.mat(Mat.METAL_PAINTED, m[0] * 0.9, m[1] * 0.9, m[2] * 0.9);
      box(b, 0.312, y0, -0.345, 0.698, y0 + 0.205, -0.33, SKIP.PZ);
      b.mat(Mat.METAL_PAINTED, CHROME[0], CHROME[1], CHROME[2], 0, 0.25);
      box(b, 0.45, y0 + 0.17, -0.36, 0.56, y0 + 0.185, -0.345, SKIP.PZ);
    }
  }
};

// ---------------------------------------------------------------------------------------- CONFERENCE_TABLE
const CONF_WOOD: readonly RGB[] = [[0.3, 0.18, 0.09], [0.36, 0.23, 0.12], [0.12, 0.07, 0.04], [0.5, 0.38, 0.25]];
export const conferenceTable: PropBuild = (b, v) => {
  const w = CONF_WOOD[v];
  b.mat(Mat.WOOD, w[0], w[1], w[2], 0, 0.35);
  if (v & 1) {
    // racetrack top: stadium outline in XZ, extruded up 4 cm
    const prof: number[] = [];
    const R = 0.6, half = 0.9, seg = 8;
    for (let k = 0; k <= seg; k++) { const a = -Math.PI / 2 + (k / seg) * Math.PI; prof.push(half + R * Math.cos(a), R * Math.sin(a)); }
    for (let k = 0; k <= seg; k++) { const a = Math.PI / 2 + (k / seg) * Math.PI; prof.push(-half + R * Math.cos(a), R * Math.sin(a)); }
    b.push();
    b.translate(0, 0.71, 0);
    b.rotX(-Math.PI / 2);
    extrudeBevel(b, prof, 0, 0.04, 0.008);
    b.pop();
  } else {
    bevelBox(b, -1.5, 0.71, -0.6, 1.5, 0.75, 0.6, 0.01);
  }
  b.mat(Mat.METAL_PAINTED, 0.08, 0.08, 0.085, 0, 0.35);
  for (const sx of [-1, 1]) {
    bevelBox(b, sx * 0.85 - 0.05, 0.04, -0.28, sx * 0.85 + 0.05, 0.71, 0.28, 0.012, SKIP.NY);
    box(b, sx * 0.85 - 0.09, 0, -0.42, sx * 0.85 + 0.09, 0.04, 0.42, SKIP.NY);
  }
  box(b, -0.8, 0.5, -0.04, 0.8, 0.58, 0.04); // stretcher beam
};

// ---------------------------------------------------------------------------------------- MATTRESS
const MATTRESS_TINT: readonly RGB[] = [[0.55, 0.53, 0.48], [0.22, 0.28, 0.38], [0.5, 0.44, 0.3], [0.45, 0.42, 0.36]];
export const mattress: PropBuild = (b, v, seed) => {
  const t = MATTRESS_TINT[v];
  b.mat(Mat.FABRIC_PARTITION, t[0], t[1], t[2]);
  const nx = 5, nz = 10, hx = 0.45, hz = 0.95;
  const sag = v === 3 ? 0.035 : 0.008;
  const X = (i: number): number => -hx + (2 * hx * i) / nx;
  const Z = (j: number): number => -hz + (2 * hz * j) / nz;
  heightGrid(b, nx, nz, (i) => X(i), (i, j) => {
    const edge = i === 0 || i === nx || j === 0 || j === nz;
    if (edge) return 0.15;
    const u = X(i) / hx, w = Z(j) / hz;
    const dome = (1 - u * u * u * u) * (1 - w * w * w * w);
    const tuft = (i + j) & 1 ? 0 : -0.008; // quilting dimples
    const lump = (rnd(seed, i * 17 + j) - 0.5) * 0.008;
    return Math.min(0.2, 0.172 + 0.026 * dome + tuft + lump - sag * (1 - u * u) * (1 - w * w));
  }, (_i, j) => Z(j), 0);
};

// ---------------------------------------------------------------------------------------- SLEEPING_BAG
const BAG_TINT: readonly RGB[] = [[0.3, 0.04, 0.03], [0.04, 0.06, 0.16], [0.12, 0.13, 0.06], [0.45, 0.16, 0.03]];
export const sleepingBag: PropBuild = (b, v, seed) => {
  const t = BAG_TINT[v];
  b.mat(Mat.FABRIC_PARTITION, t[0], t[1], t[2]);
  const nx = 5, nz = 12, z0 = -0.98, z1 = 0.98;
  const Z = (j: number): number => z0 + ((z1 - z0) * j) / nz;
  const hw = (j: number): number => 0.38 - 0.1 * (j / nz); // mummy taper toward the foot (+Z)
  const skew = rndRange(seed, 3, -0.03, 0.03);
  heightGrid(b, nx, nz, (i, j) => (-1 + (2 * i) / nx) * hw(j) + skew * (j / nz), (i, j) => {
    if (i === 0 || i === nx || j === 0 || j === nz) return 0.025;
    const u = -1 + (2 * i) / nx;
    const baffle = j & 1 ? 0.012 : 0; // quilted baffles across the bag
    const lump = rnd(seed, i * 31 + j) * 0.012;
    return Math.min(0.118, 0.06 + 0.035 * (1 - u * u) + baffle + lump);
  }, (_i, j) => Z(j), 0);
};
