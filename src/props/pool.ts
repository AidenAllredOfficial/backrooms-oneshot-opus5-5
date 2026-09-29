// src/props/pool.ts — poolrooms props: POOL_LADDER, LOUNGE_CHAIR, LIFEBUOY, BENCH_TILED, FLOAT_ROPE,
// POOL_FLOAT, TOWEL (§5 WP6). Prop-local frame: base centre at the origin, +Y up, front faces -Z.
// Pure module (no three/DOM).

import { Mat } from '../core/ids.ts';
import { rnd, rndRange } from './builder.ts';
import type { PropBuild } from './furniture.ts';
import { bevelBox, box, cylinder, heightGrid, lathe, SKIP, sweep, torus, tubePath } from './primitives.ts';

type RGB = readonly [number, number, number];
const CHROME: RGB = [0.6, 0.6, 0.6];

// ---------------------------------------------------------------------------------------- POOL_LADDER
// Hangs in the pool against the wall (+Z). Deck (coping) level is local y = 1.0: WP4 sets p.y = deckY - 1.0.
export const poolLadder: PropBuild = (b, v) => {
  const steps = v === 1 ? 2 : v === 3 ? 4 : 3;
  const sides = v === 3 ? 6 : 8;
  if (v === 2) b.mat(Mat.METAL_PAINTED, 0.42, 0.4, 0.36, 0, 0.35);
  else b.mat(Mat.METAL_BARE, CHROME[0], CHROME[1], CHROME[2], 0, 0.15); // polished stainless
  const r = 0.019;
  for (const sx of [-1, 1]) {
    const x = sx * 0.24;
    tubePath(b, [x, 0.03, 0.2, x, 0.26, 0.0, x, 1.55, 0.0, x, 1.86, 0.11, x, 1.6, 0.228, x, 1.0, 0.228], r, sides, 0.11, 2, 0);
  }
  // wall bumpers at the feet
  b.mat(Mat.RUBBER);
  for (const sx of [-1, 1]) box(b, sx * 0.24 - 0.025, 0.0, 0.2, sx * 0.24 + 0.025, 0.06, 0.25, 0);
  // treads
  b.mat(Mat.PLASTIC, 0.5, 0.5, 0.48);
  for (let k = 0; k < steps; k++) {
    const y = steps === 4 ? 0.1 + k * 0.25 : steps === 3 ? 0.25 + k * 0.3 : 0.45 + k * 0.3;
    bevelBox(b, -0.225, y - 0.02, -0.075, 0.225, y + 0.02, 0.075, 0.01);
  }
};

// ---------------------------------------------------------------------------------------- LOUNGE_CHAIR
const LOUNGE_FRAME: readonly RGB[] = [[0.55, 0.55, 0.53], [0.5, 0.5, 0.5], [0.3, 0.2, 0.11], [0.55, 0.54, 0.5]];
export const loungeChair: PropBuild = (b, v) => {
  const f = LOUNGE_FRAME[v];
  const frame = (): void => {
    if (v === 2) b.mat(Mat.WOOD, f[0], f[1], f[2], 0, 0.45);
    else if (v === 1) b.mat(Mat.METAL_PAINTED, f[0], f[1], f[2], 0, 0.25);
    else b.mat(Mat.PLASTIC, f[0], f[1], f[2]);
  };
  const bed = (): void => {
    if (v === 1) b.mat(Mat.FABRIC_PARTITION, 0.06, 0.12, 0.3);
    else if (v === 3) b.mat(Mat.FABRIC_PARTITION, 0.4, 0.28, 0.1);
    else frame();
  };
  frame();
  // side rails run the full length (under the raised backrest too); legs at the foot end
  for (const sx of [-1, 1]) {
    box(b, sx * 0.3125 - 0.0125, 0.3, -0.95, sx * 0.3125 + 0.0125, 0.36, 0.8, 0);
    b.push();
    b.translate(sx * 0.3, 0, -0.85);
    cylinder(b, 0.02, 0.02, 0, 0.3, 6, 0);
    b.pop();
  }
  // head end: cross member under the rails, two struts down to the wheel axle (the wheels carry the head end)
  box(b, -0.3, 0.28, 0.69, 0.3, 0.31, 0.75, 0);
  for (const sx of [-1, 1]) {
    b.push();
    b.translate(sx * 0.255, 0.07, 0.72);
    cylinder(b, 0.016, 0.016, 0, 0.225, 6, 0);
    b.pop();
  }
  b.mat(Mat.METAL_BARE, CHROME[0], CHROME[1], CHROME[2], 0, 0.3); // brushed stainless
  b.push();
  b.translate(0, 0.08, 0.72);
  b.rotZ(Math.PI / 2);
  cylinder(b, 0.009, 0.009, -0.3, 0.3, 6, 0); // axle, ends buried in the wheel hubs
  b.pop();
  // wheels on the axle ends
  b.mat(Mat.RUBBER);
  for (const sx of [-1, 1]) {
    b.push();
    b.translate(sx * 0.29, 0.08, 0.72);
    b.rotZ(Math.PI / 2);
    cylinder(b, 0.08, 0.08, -0.015, 0.015, 10, 3);
    b.pop();
  }
  // flat bed
  bed();
  if (v === 1 || v === 3) box(b, -0.3, 0.33, -0.93, 0.3, 0.36, 0.28, 0);
  else for (let k = 0; k < 11; k++) {
    const z0 = -0.93 + k * 0.11;
    box(b, -0.3, 0.335, z0, 0.3, 0.36, z0 + 0.08, 0);
  }
  // backrest raised 40 deg
  b.push();
  b.translate(0, 0.36, 0.3);
  b.rotX(-0.7);
  frame();
  for (const sx of [-1, 1]) box(b, sx * 0.3125 - 0.0125, -0.05, 0, sx * 0.3125 + 0.0125, 0.0, 0.8, 0);
  bed();
  if (v === 1 || v === 3) box(b, -0.3, -0.03, 0.01, 0.3, 0.0, 0.79, 0);
  else for (let k = 0; k < 7; k++) {
    const z0 = 0.02 + k * 0.11;
    box(b, -0.3, -0.025, z0, 0.3, 0.0, z0 + 0.08, 0);
  }
  b.pop();
};

// ---------------------------------------------------------------------------------------- LIFEBUOY
export const lifebuoy: PropBuild = (b, v) => {
  const red: RGB = v === 2 ? [0.5, 0.18, 0.02] : v === 3 ? [0.3, 0.06, 0.05] : [0.5, 0.04, 0.03];
  const white: RGB = [0.55, 0.55, 0.53];
  b.push();
  b.translate(0, 0.3, 0);
  b.rotX(Math.PI / 2); // torus plane (local XZ) -> wall plane (XY)
  const R = 0.235, r = 0.05;
  for (let k = 0; k < 4; k++) {
    const c = k & 1 ? white : red;
    b.mat(Mat.PLASTIC, c[0], c[1], c[2]);
    const a0 = (k * Math.PI) / 2 + Math.PI / 4, a1 = a0 + Math.PI / 2;
    torus(b, R, r, a0, a1, 5, 6);
  }
  // grab-line bindings at the band joints
  b.mat(Mat.FABRIC_PARTITION, 0.5, 0.48, 0.4);
  for (let k = 0; k < 4; k++) {
    const a = (k * Math.PI) / 2 + Math.PI / 4;
    b.push();
    b.translate(R * Math.cos(a), 0, R * Math.sin(a));
    b.alignY(-Math.sin(a), 0, Math.cos(a));
    torus(b, 0.052, 0.004, 0, Math.PI * 2, 6, 3);
    b.pop();
  }
  b.pop();
};

// ---------------------------------------------------------------------------------------- BENCH_TILED
export const benchTiled: PropBuild = (b, v) => {
  const base = v === 1 ? Mat.POOL_MOSAIC : Mat.POOL_TILE;
  if (v === 3) b.mat(base, 0.3, 0.5, 0.42);
  else b.mat(base);
  box(b, -1.15, 0, -0.26, 1.15, 0.4, 0.26, SKIP.NY);
  if (v === 2) b.mat(Mat.TERRAZZO);
  else if (v === 3) b.mat(base, 0.3, 0.5, 0.42);
  else b.mat(Mat.POOL_TILE);
  bevelBox(b, -1.2, 0.4, -0.3, 1.2, 0.45, 0.3, 0.012);
};

// ---------------------------------------------------------------------------------------- FLOAT_ROPE
// Lane rope along local x at water level: floats centred at local y = 0.06 (WP4: p.y = waterY - 0.06).
export const floatRope: PropBuild = (b, v) => {
  b.mat(Mat.PLASTIC, 0.3, 0.3, 0.28, 0, 0.7); // braided polypropylene rope
  b.push();
  b.translate(0, 0.06, 0);
  b.rotZ(-Math.PI / 2); // +Y -> +X
  cylinder(b, 0.008, 0.008, -0.585, 0.585, 6, 0); // both ends buried in the end floats
  const alt: RGB = v === 1 ? [0.05, 0.12, 0.45] : v === 2 ? [0.5, 0.35, 0.02] : [0.5, 0.04, 0.03];
  for (let k = 0; k < 8; k++) {
    const c: RGB = k & 1 ? [0.55, 0.55, 0.53] : alt;
    b.mat(Mat.PLASTIC, c[0], c[1], c[2], 0, 0.3);
    const s = -0.525 + k * 0.15;
    lathe(b, [0, s - 0.066, 0.055, s - 0.03, 0.055, s + 0.03, 0, s + 0.066], 8, 0, 50);
  }
  b.pop();
};

// ---------------------------------------------------------------------------------------- POOL_FLOAT
const FLOAT_TINT: readonly RGB[] = [[0.55, 0.2, 0.3], [0.55, 0.45, 0.05], [0.1, 0.3, 0.5], [0.4, 0.4, 0.4]];
export const poolFloat: PropBuild = (b, v, seed) => {
  const c = FLOAT_TINT[v];
  const deflated = v === 3;
  b.mat(Mat.PLASTIC, c[0], c[1], c[2], 0, 0.15);
  // inflated perimeter tube around a rounded rectangle
  const hx = 0.45, hz = 0.2, R = 0.12, tr = deflated ? 0.06 : 0.09;
  const cy = tr + (deflated ? 0.01 : 0);
  const pts: number[] = [];
  const corners: [number, number, number][] = [[hx - R, hz - R, 0], [-hx + R, hz - R, Math.PI / 2], [-hx + R, -hz + R, Math.PI], [hx - R, -hz + R, Math.PI * 1.5]];
  for (const [cx, cz, a0] of corners) {
    for (let k = 0; k <= 3; k++) {
      const a = a0 + (k / 3) * (Math.PI / 2);
      const sag = deflated ? rndRange(seed, pts.length, -0.01, 0.0) : 0;
      pts.push(cx + (R + 0.0) * Math.cos(a), cy + sag, cz + R * Math.sin(a));
    }
  }
  pts.push(pts[0], pts[1], pts[2]);
  sweep(b, pts, tr, 8, 0);
  // membrane bed
  b.mat(Mat.PLASTIC, c[0] * 0.9, c[1] * 0.9, c[2] * 0.9, 0, 0.15);
  box(b, -hx + 0.02, cy - 0.01, -hz + 0.02, hx - 0.02, cy + 0.01, hz - 0.02, 0);
  // pillow
  bevelBox(b, 0.25, cy + tr * 0.4, -0.17, 0.44, Math.min(0.25, cy + tr + 0.06), 0.17, 0.035);
};

// ---------------------------------------------------------------------------------------- TOWEL
const TOWEL: readonly RGB[] = [[0.55, 0.54, 0.5], [0.08, 0.2, 0.45], [0.45, 0.06, 0.05], [0.5, 0.42, 0.28]];
export const towel: PropBuild = (b, v, seed) => {
  const c = TOWEL[v];
  const nx = 3, nz = 10;
  const Z = (j: number): number => -0.68 + (1.36 * j) / nz;
  heightGrid(b, nx, nz, (i, j) => -0.285 + (0.57 * i) / nx + 0.012 * Math.sin(j * 1.7 + (seed & 15)), (i, j) => {
    const fold = 0.008 + 0.01 * Math.max(0, Math.sin(j * 1.3 + (seed & 7))) + 0.004 * rnd(seed, i * 13 + j);
    return Math.min(0.028, i === 0 || i === nx || j === 0 || j === nz ? 0.004 : fold);
  }, (_i, j) => Z(j), 0, (j) => {
    // variant 1: white and blue stripes across the towel
    const stripe = v === 1 && (j === 1 || j === 8);
    const t: RGB = stripe ? [0.55, 0.54, 0.5] : c;
    b.mat(Mat.FABRIC_PARTITION, t[0], t[1], t[2]);
  });
};
