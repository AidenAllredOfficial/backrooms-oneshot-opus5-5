// src/props/misc.ts — miscellaneous props: CONE, WET_FLOOR_SIGN, WHEEL_STOP, BACKPACK, BOTTLE, BUCKET, MOP,
// DOOR_FRAME, DOOR_LEAF, ELEVATOR_DOOR, HANDRAIL, CEILING_DEBRIS, TILE_FRAGMENT (§5 WP6).
// Prop-local frame: base centre at the origin, +Y up, front faces -Z; wall-mounted props have their back on +Z.
// Pure module (no three/DOM).

import { Mat, SignKind, VFlag } from '../core/ids.ts';
import { rnd, rndRange, type PartBuilder } from './builder.ts';
import type { PropBuild } from './furniture.ts';
import { signSlot } from './industrial.ts';
import { bevelBox, box, cylinder, extrude, hexa, lathe, rect, SKIP, sweep, tubePath } from './primitives.ts';

type RGB = readonly [number, number, number];
const CHROME: RGB = [0.56, 0.56, 0.55];

// ---------------------------------------------------------------------------------------- CONE
export const cone: PropBuild = (b, v) => {
  const orange: RGB = v === 2 ? [0.42, 0.14, 0.04] : [0.55, 0.12, 0.01];
  const white: RGB = [0.55, 0.55, 0.53];
  if (v === 1) b.mat(Mat.RUBBER);
  else b.mat(Mat.PLASTIC, orange[0], orange[1], orange[2]);
  bevelBox(b, -0.175, 0, -0.175, 0.175, 0.03, 0.175, 0.01, SKIP.NY);
  const y0 = 0.03, y1 = 0.68, r0 = 0.13, r1 = 0.025;
  const rAt = (y: number): number => r0 + ((r1 - r0) * (y - y0)) / (y1 - y0);
  const cuts = [y0, 0.25, 0.35, 0.45, 0.52, y1];
  for (let k = 0; k < 5; k++) {
    const band = (k & 1) === 1 && (v !== 3 || k === 1);
    const c = band ? white : orange;
    b.mat(Mat.PLASTIC, c[0], c[1], c[2], 0, band ? 0.25 : 0);
    lathe(b, [rAt(cuts[k]), cuts[k], rAt(cuts[k + 1]), cuts[k + 1]], 10, k === 4 ? 2 : 0);
  }
};

// ---------------------------------------------------------------------------------------- WET_FLOOR_SIGN
export const wetFloorSign: PropBuild = (b, v) => {
  const yel: RGB = v === 2 ? [0.55, 0.3, 0.02] : v === 1 ? [0.45, 0.38, 0.08] : [0.6, 0.48, 0.02];
  b.mat(Mat.PLASTIC, yel[0], yel[1], yel[2]);
  // A-frame: two 12 mm panels hinged at the top (y 0.6), feet at z = +-0.165
  const H = 0.6, foot = 0.15, t = 0.012;
  for (const sz of [-1, 1]) {
    hexa(b, [-0.14, 0, sz * (foot + t), 0.14, 0, sz * (foot + t), 0.14, 0, sz * foot, -0.14, 0, sz * foot,
      -0.14, H, sz * t, 0.14, H, sz * t, 0.14, H, 0, -0.14, H, 0]);
  }
  box(b, -0.05, H, -0.016, 0.05, 0.62, 0.016, 0); // handle
  b.mat(Mat.RUBBER);
  for (const sz of [-1, 1]) {
    const za = sz * (foot - 0.008), zb = sz * (foot + t + 0.008);
    box(b, -0.13, 0, Math.min(za, zb), 0.13, 0.012, Math.max(za, zb), 0);
  }
  // WET FLOOR sign faces on both panels (alpha-tested decal quads, 2 mm proud)
  b.mat(Mat.SIGNAGE, -1, -1, -1, VFlag.DECAL | VFlag.NO_GRIME);
  b.rawUv();
  const L = Math.hypot(H, foot);
  const ux = 0.12;
  for (const sz of [-1, 1]) {
    // outer normal of the panel (faces out and up)
    const nz = (sz * H) / L, ny = foot / L;
    const cy = 0.34, cz = sz * (foot * (1 - cy / H) + t) + nz * 0.002;
    // up the panel (+v): from the foot toward the hinge
    const vy = (H / L) * 0.13, vz = (-sz * foot / L) * 0.13;
    // +u = the viewer's right seen from outside: -x on the front (-z) panel, +x on the back panel
    rect(b, 0, cy + ny * 0.002, cz, sz < 0 ? -ux : ux, 0, 0, 0, vy, vz, 0, ny, nz, signSlot(SignKind.WET_FLOOR));
  }
};

// ---------------------------------------------------------------------------------------- WHEEL_STOP
export const wheelStop: PropBuild = (b, v) => {
  const prof = [-0.09, 0, 0.09, 0, 0.07, 0.1, 0.05, 0.12, -0.05, 0.12, -0.07, 0.1];
  const concrete = (): void => b.mat(Mat.CONCRETE_WALL, v === 3 ? 0.25 : -1, 0.24, 0.22);
  b.push();
  b.basis(0, 0, 1, 0, 1, 0, -1, 0, 0); // profile (z, y), extruded along -x
  if (v === 0 || v === 3) {
    concrete();
    extrude(b, prof, -0.9, 0.9, 3);
  } else {
    // painted: 4 segments alternating yellow / body colour
    const segs = [-0.9, -0.45, 0, 0.45, 0.9];
    for (let k = 0; k < 4; k++) {
      const yellow = (k & 1) === (v === 1 ? 0 : 1);
      if (yellow) b.mat(Mat.FLOOR_PAINT);
      else if (v === 2) b.mat(Mat.RUBBER);
      else concrete();
      extrude(b, prof, segs[k], segs[k + 1], k === 0 ? 1 : k === 3 ? 2 : 0);
    }
  }
  b.pop();
};

// ---------------------------------------------------------------------------------------- BACKPACK
const PACK: readonly RGB[] = [[0.04, 0.06, 0.16], [0.35, 0.04, 0.03], [0.12, 0.13, 0.06], [0.03, 0.03, 0.035]];
export const backpack: PropBuild = (b, v) => {
  const c = PACK[v];
  b.mat(Mat.FABRIC_PARTITION, c[0], c[1], c[2]);
  bevelBox(b, -0.15, 0, -0.07, 0.15, 0.44, 0.09, 0.045, SKIP.NY);
  hexa(b, [-0.15, 0.44, -0.07, 0.15, 0.44, -0.07, 0.15, 0.44, 0.09, -0.15, 0.44, 0.09,
    -0.11, 0.49, -0.04, 0.11, 0.49, -0.04, 0.11, 0.49, 0.06, -0.11, 0.49, 0.06], SKIP.NY);
  b.mat(Mat.FABRIC_PARTITION, c[0] * 0.8, c[1] * 0.8, c[2] * 0.8);
  bevelBox(b, -0.11, 0.05, -0.11, 0.11, 0.26, -0.06, 0.025);
  // zips
  b.mat(Mat.PLASTIC, 0.02, 0.02, 0.02);
  rect(b, 0, 0.24, -0.1105, 0.09, 0, 0, 0, 0.004, 0, 0, 0, -1);
  rect(b, 0, 0.465, -0.0565, 0.1, 0, 0, 0, 0.0026, 0.0015, 0, 0.51, -0.86);
  // shoulder straps on the back and a top loop
  b.mat(Mat.FABRIC_PARTITION, c[0] * 0.6, c[1] * 0.6, c[2] * 0.6);
  for (const sx of [-1, 1]) tubePath(b, [sx * 0.08, 0.42, 0.09, sx * 0.09, 0.3, 0.113, sx * 0.1, 0.07, 0.095], 0.011, 4, 0.05, 2, 0);
  tubePath(b, [-0.03, 0.48, 0.02, 0, 0.49, 0.02, 0.03, 0.48, 0.02], 0.006, 4, 0.01, 1, 0);
};

// ---------------------------------------------------------------------------------------- BOTTLE
const GLASS: readonly RGB[] = [[0.05, 0.14, 0.05], [0.12, 0.06, 0.02], [0.3, 0.36, 0.4], [0.35, 0.38, 0.4]];
export const bottle: PropBuild = (b, v) => {
  const g = GLASS[v];
  b.mat(Mat.PLASTIC, g[0], g[1], g[2], VFlag.NO_GRIME, 0.06);
  lathe(b, [0, 0, 0.036, 0, 0.036, 0.19, 0.03, 0.225, 0.014, 0.25, 0.014, 0.285, 0.016, 0.3, 0, 0.3], 8, 0);
  // paper label
  b.mat(Mat.DRYWALL, v === 2 ? 0.05 : 0.5, v === 2 ? 0.15 : 0.45, v === 2 ? 0.45 : 0.35);
  lathe(b, [0.0368, 0.07, 0.0368, 0.15], 8, 0);
};

// ---------------------------------------------------------------------------------------- BUCKET
const BUCKET: readonly RGB[] = [[0.3, 0.3, 0.29], [0.55, 0.45, 0.03], [0.42, 0.42, 0.41], [0.4, 0.04, 0.03]];
export const bucket: PropBuild = (b, v, seed) => {
  const c = BUCKET[v];
  if (v === 2) b.mat(Mat.METAL_PAINTED, c[0], c[1], c[2], 0, 0.35);
  else b.mat(Mat.PLASTIC, c[0], c[1], c[2]);
  lathe(b, [0.125, 0, 0.155, 0.33, 0.16, 0.345, 0.148, 0.345, 0.12, 0.015, 0, 0.015], 10, 1);
  // ears + wire handle folded down to one side
  box(b, -0.1595, 0.28, -0.012, -0.148, 0.31, 0.012, SKIP.PX);
  box(b, 0.148, 0.28, -0.012, 0.1595, 0.31, 0.012, SKIP.NX);
  b.mat(Mat.METAL_PAINTED, 0.4, 0.4, 0.4, 0, 0.3);
  const tilt = 1.2 + 0.15 * rnd(seed, 1);
  const pts: number[] = [];
  for (let k = 0; k <= 8; k++) {
    const a = (k / 8) * Math.PI;
    const px = -Math.cos(a) * 0.155, pr = Math.sin(a) * 0.155;
    pts.push(px, 0.285 + pr * Math.cos(tilt), pr * Math.sin(tilt));
  }
  sweep(b, pts, 0.004, 4, 0);
};

// ---------------------------------------------------------------------------------------- MOP
export const mop: PropBuild = (b, v) => {
  const strands: RGB = v === 2 ? [0.2, 0.18, 0.13] : [0.45, 0.44, 0.4];
  b.mat(Mat.FABRIC_PARTITION, strands[0], strands[1], strands[2]);
  lathe(b, [0, 0, 0.12, 0.0, 0.13, 0.03, 0.09, 0.1, 0.02, 0.17], 10, 0, 50);
  b.mat(Mat.PLASTIC, 0.3, 0.3, 0.3);
  cylinder(b, 0.03, 0.025, 0.16, 0.22, 8, 2);
  b.push();
  b.translate(0, 0.22, 0);
  if (v === 3) b.rotZ(0.08);
  const handle: RGB = v === 1 ? [0.05, 0.12, 0.4] : [0.36, 0.23, 0.12];
  if (v === 1) b.mat(Mat.PLASTIC, handle[0], handle[1], handle[2]);
  else b.mat(Mat.WOOD, handle[0], handle[1], handle[2], 0, 0.45);
  cylinder(b, 0.013, 0.013, 0, 1.07, 6, 2);
  b.pop();
};

// ---------------------------------------------------------------------------------------- DOOR_FRAME
const FRAME: readonly RGB[] = [[0.5, 0.47, 0.4], [0.35, 0.23, 0.12], [0.14, 0.08, 0.04], [0.3, 0.3, 0.3]];
export const doorFrame: PropBuild = (b, v) => {
  const c = FRAME[v];
  if (v === 3) b.mat(Mat.METAL_PAINTED, c[0], c[1], c[2]);
  else if (v === 0) b.mat(Mat.TRIM_PAINT, c[0], c[1], c[2]);
  else b.mat(Mat.WOOD, c[0], c[1], c[2], 0, 0.45);
  // jambs and head with 1 cm chamfers (the head butts into the jambs: no end faces)
  bevelBox(b, -0.55, 0, -0.075, -0.45, 2.2, 0.075, 0.01, SKIP.NY);
  bevelBox(b, 0.45, 0, -0.075, 0.55, 2.2, 0.075, 0.01, SKIP.NY);
  bevelBox(b, -0.45, 2.1, -0.075, 0.45, 2.2, 0.075, 0.01, SKIP.NX | SKIP.PX);
  // door stops
  box(b, -0.45, 0, -0.02, -0.435, 2.085, 0.02, SKIP.NY | SKIP.NX);
  box(b, 0.435, 0, -0.02, 0.45, 2.085, 0.02, SKIP.NY | SKIP.PX);
  box(b, -0.435, 2.085, -0.02, 0.435, 2.1, 0.02, SKIP.PY);
};

// ---------------------------------------------------------------------------------------- DOOR_LEAF
const LEAF: readonly RGB[] = [[0.3, 0.19, 0.1], [0.52, 0.5, 0.45], [0.3, 0.31, 0.3], [0.2, 0.12, 0.06]];
export const doorLeaf: PropBuild = (b, v) => {
  const c = LEAF[v];
  if (v === 0 || v === 3) b.mat(Mat.WOOD, c[0], c[1], c[2], 0, 0.45);
  else if (v === 1) b.mat(Mat.TRIM_PAINT, c[0], c[1], c[2]);
  else b.mat(Mat.METAL_PAINTED, c[0], c[1], c[2]);
  bevelBox(b, -0.44, 0.005, -0.0175, 0.44, 2.07, 0.0175, 0.004);
  // flush pull plates (a lever would not fit the 45 mm footprint) + latch plate
  b.mat(Mat.METAL_PAINTED, CHROME[0], CHROME[1], CHROME[2], 0, 0.22);
  box(b, 0.33, 0.97, -0.0215, 0.37, 1.13, -0.0175, SKIP.PZ);
  box(b, 0.33, 0.97, 0.0175, 0.37, 1.13, 0.0215, SKIP.NZ);
  rect(b, 0.4405, 1.05, 0, 0, 0, 0.012, 0, 0.05, 0, 1, 0, 0);
  // hinge knuckles on the -x edge
  for (const y of [0.25, 1.05, 1.85]) {
    b.push();
    b.translate(-0.44, y, 0);
    cylinder(b, 0.008, 0.008, -0.05, 0.05, 5, 3);
    b.pop();
  }
  if (v === 2) {
    b.mat(Mat.METAL_PAINTED, 0.45, 0.45, 0.44, 0, 0.3);
    rect(b, 0, 0.12, -0.018, 0.4, 0, 0, 0, 0.1, 0, 0, 0, -1); // kick plate
  }
};

// ---------------------------------------------------------------------------------------- ELEVATOR_DOOR
const ELEV: readonly RGB[] = [[0.52, 0.52, 0.51], [0.4, 0.28, 0.14], [0.2, 0.22, 0.24], [0.45, 0.45, 0.44]];
export const elevatorDoor: PropBuild = (b, v) => {
  const c = ELEV[v];
  b.mat(Mat.METAL_PAINTED, c[0], c[1], c[2], 0, v === 2 ? 0 : 0.28);
  bevelBox(b, -0.5, 0, -0.025, 0.495, 2.2, 0.025, 0.006);
  b.mat(Mat.RUBBER);
  box(b, 0.495, 0.0, -0.012, 0.5, 2.2, 0.012, SKIP.NX);
};

// ---------------------------------------------------------------------------------------- HANDRAIL
const RAIL: readonly RGB[] = [[0.5, 0.5, 0.49], [0.3, 0.19, 0.1], [0.55, 0.42, 0.03], [0.3, 0.3, 0.3]];
export const handrail: PropBuild = (b, v) => {
  const c = RAIL[v];
  const railMat = (): void => {
    if (v === 1) b.mat(Mat.WOOD, c[0], c[1], c[2], 0, 0.45);
    else if (v === 3) b.mat(Mat.METAL_RUST);
    else b.mat(Mat.METAL_PAINTED, c[0], c[1], c[2], 0, v === 0 ? 0.25 : 0);
  };
  railMat();
  tubePath(b, [-0.58, 0.9, 0.04, -0.58, 0.9, -0.005, 0.58, 0.9, -0.005, 0.58, 0.9, 0.04], 0.02, 8, 0.03, 2, 0);
  // brackets with wall rosettes
  b.mat(Mat.METAL_PAINTED, 0.4, 0.4, 0.4, 0, 0.3);
  for (const x of [-0.35, 0.35]) {
    tubePath(b, [x, 0.84, 0.04, x, 0.84, 0.0, x, 0.885, -0.005], 0.006, 4, 0.02, 1, 0);
    b.push();
    b.translate(x, 0.84, 0.04);
    b.rotX(-Math.PI / 2);
    cylinder(b, 0.025, 0.025, 0, 0.012, 6, 2);
    b.pop();
  }
};

// ---------------------------------------------------------------------------------------- CEILING_DEBRIS
const MOUND_S = 10, MOUND_RINGS = [0, 0.4, 0.75, 1];
const moundIds: number[] = [];
/** Low heap on the floor: centre (cx, cz), jagged outline radius in [r0, r1] per sector, peak height h.
 * S + 2 S (rings - 2) triangles (50). Normals from the analytic slope of h (1 - f^2). */
function dustMound(b: PartBuilder, seed: number, cx: number, cz: number, r0: number, r1: number, h: number): void {
  const S = MOUND_S, K = MOUND_RINGS.length;
  moundIds.length = 0;
  moundIds.push(b.v(cx, 0.001 + h, cz, 0, 1, 0, cx, cz));
  for (let k = 1; k < K; k++) {
    const f = MOUND_RINGS[k];
    for (let i = 0; i < S; i++) {
      const a = (i / S) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
      const R = r0 + (r1 - r0) * rnd(seed, 600 + i);
      const x = cx + ca * R * f, z = cz + sa * R * f;
      const y = k === K - 1 ? 0.001 : 0.001 + h * (1 - f * f) * (0.8 + 0.4 * rnd(seed, 700 + k * S + i));
      const sl = (2 * h * f) / R; // |dh/dr|
      moundIds.push(b.v(x, y, z, ca * sl, 1, sa * sl, x, z));
    }
  }
  const at = (k: number, i: number): number => moundIds[1 + (k - 1) * S + (i % S)];
  for (let i = 0; i < S; i++) b.tri(moundIds[0], at(1, i), at(1, i + 1));
  for (let k = 1; k < K - 1; k++) for (let i = 0; i < S; i++) b.quad(at(k, i), at(k, i + 1), at(k + 1, i + 1), at(k + 1, i));
}
function fragment(b: PartBuilder, seed: number, k: number, maxR: number, sides: number, thick: number): void {
  // irregular convex-ish shard
  const prof: number[] = [];
  const phase = rnd(seed, k * 7 + 1) * Math.PI * 2;
  for (let i = 0; i < sides; i++) {
    const a = phase + (i / sides) * Math.PI * 2 + (rnd(seed, k * 7 + 2 + i) - 0.5) * 0.5;
    const r = maxR * (0.6 + 0.4 * rnd(seed, k * 13 + 3 + i));
    prof.push(Math.cos(a) * r, Math.sin(a) * r);
  }
  b.push();
  b.rotX(-Math.PI / 2); // profile in XZ, thickness up
  extrude(b, prof, 0, thick, 3);
  b.pop();
}
export const ceilingDebris: PropBuild = (b, v, seed) => {
  const wet = v === 3;
  // dust mound: an irregular low heap of crumbled tile (polar mesh, jagged outline)
  b.mat(Mat.CEILING_TILE, wet ? 0.3 : 0.5, wet ? 0.28 : 0.48, wet ? 0.24 : 0.43);
  dustMound(b, seed, rndRange(seed, 500, -0.08, 0.08), rndRange(seed, 501, -0.08, 0.08), 0.3, 0.46, wet ? 0.008 : 0.016);
  // tile fragments
  const n = 7;
  for (let k = 0; k < n; k++) {
    const r = Math.sqrt(rnd(seed, k)) * 0.36;
    const a = rnd(seed, k + 50) * Math.PI * 2;
    const sz = rndRange(seed, k + 100, 0.1, 0.2);
    b.mat(Mat.CEILING_TILE, wet ? 0.35 : 0.58, wet ? 0.32 : 0.54, wet ? 0.26 : 0.43);
    b.push();
    b.translate(Math.cos(a) * r, 0.03 + rnd(seed, k + 150) * 0.015, Math.sin(a) * r);
    b.rotY(rnd(seed, k + 180) * Math.PI * 2);
    b.rotX((rnd(seed, k + 210) - 0.5) * 0.2);
    b.rotZ((rnd(seed, k + 240) - 0.5) * 0.2);
    fragment(b, seed, k, sz, 5, 0.016);
    b.pop();
  }
  // bent T-bar and insulation clumps
  if (v === 2 || v === 3) {
    b.mat(Mat.TRIM_PAINT, 0.55, 0.54, 0.5);
    for (let k = 0; k < 2; k++) {
      b.push();
      b.translate(rndRange(seed, 300 + k, -0.15, 0.15), 0.03, rndRange(seed, 310 + k, -0.15, 0.15));
      b.rotY(rnd(seed, 320 + k) * Math.PI);
      b.rotZ((rnd(seed, 330 + k) - 0.5) * 0.08);
      box(b, -0.3, -0.012, -0.012, 0.3, 0.012, 0.012, SKIP.NY);
      b.pop();
    }
  }
  if (v === 1) {
    b.mat(Mat.FABRIC_PARTITION, 0.5, 0.4, 0.15);
    for (let k = 0; k < 3; k++) {
      b.push();
      b.translate(rndRange(seed, 400 + k, -0.35, 0.35), 0, rndRange(seed, 410 + k, -0.35, 0.35));
      const s = rndRange(seed, 420 + k, 0.08, 0.14);
      lathe(b, [0, 0, s, 0.01, s * 0.8, 0.05, 0, 0.07], 6, 0, 60);
      b.pop();
    }
  }
};

// ---------------------------------------------------------------------------------------- TILE_FRAGMENT
export const tileFragment: PropBuild = (b, v, seed) => {
  const stain = v === 3;
  b.mat(Mat.CEILING_TILE, stain ? 0.45 : 0.6, stain ? 0.4 : 0.56, stain ? 0.28 : 0.44);
  const main = (): void => {
    const prof = v === 2
      ? [-0.28, -0.28, 0.25, -0.28, 0.2, -0.05, -0.02, 0.1, -0.12, 0.27, -0.28, 0.25] // corner piece
      : (() => {
        const p: number[] = [];
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * Math.PI * 2 + rnd(seed, i) * 0.4;
          const r = 0.2 + 0.08 * rnd(seed, 10 + i);
          p.push(Math.cos(a) * r, Math.sin(a) * r);
        }
        return p;
      })();
    b.push();
    b.rotX(-Math.PI / 2);
    extrude(b, prof, 0, 0.016, 3);
    b.pop();
  };
  if (v === 1) {
    b.push();
    b.translate(-0.12, 0, -0.1);
    b.push();
    b.rotY(rnd(seed, 30));
    fragment(b, seed, 1, 0.16, 6, 0.016);
    b.pop();
    b.pop();
    b.push();
    b.translate(0.16, 0, 0.14);
    fragment(b, seed, 2, 0.12, 5, 0.016);
    b.pop();
  } else main();
};
