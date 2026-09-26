// src/props/industrial.ts — industrial props: CRATE, PALLET, SHELF_RACK (incl. collapsed variant 2), BOILER,
// TANK, PIPE_VALVE, VENT_GRILLE, EXTINGUISHER, CARDBOARD_BOX (§5 WP6).
// Prop-local frame: base centre at the origin, +Y up, front faces -Z; wall-mounted props have their back on +Z.
// Pure module (no three/DOM).

import { Mat, SignKind, VFlag } from '../core/ids.ts';
import { rnd, rndRange, type PartBuilder } from './builder.ts';
import type { PropBuild } from './furniture.ts';
import { bevelBox, box, cylinder, extrude, hexa, lathe, rect, SKIP, sweep, torus, tubePath } from './primitives.ts';

type RGB = readonly [number, number, number];
const KRAFT: RGB = [0.4, 0.28, 0.15];
const RACK_BLUE: RGB = [0.04, 0.1, 0.3];
const RACK_ORANGE: RGB = [0.55, 0.16, 0.02];

/** SIGNAGE atlas rect of a SignKind slot (u0, v0, u1, v1); +v is the glyph's up. */
export const signSlot = (s: number): [number, number, number, number] => {
  const u0 = (s % 4) / 4, v0 = Math.floor(s / 4) / 4;
  return [u0, v0, u0 + 0.25, v0 + 0.25];
};

/** Material by decay-like variant: painted metal, or rust for "old" variants. */
function paint(b: PartBuilder, c: RGB, rusty: boolean, rough = 0): void {
  if (rusty) b.mat(Mat.METAL_RUST);
  else b.mat(Mat.METAL_PAINTED, c[0], c[1], c[2], 0, rough);
}

// ---------------------------------------------------------------------------------------- CRATE
const CRATE_WOOD: readonly RGB[] = [[0.42, 0.3, 0.17], [0.22, 0.17, 0.12], [0.36, 0.24, 0.13], [0.3, 0.28, 0.25]];
export const crate: PropBuild = (b, v) => {
  const w = CRATE_WOOD[v];
  b.mat(Mat.WOOD, w[0] * 0.7, w[1] * 0.7, w[2] * 0.7);
  box(b, -0.47, 0, -0.47, 0.47, 0.78, 0.47, SKIP.NY); // core (seen through the slat gaps)
  b.mat(Mat.WOOD, w[0], w[1], w[2]);
  for (let k = 0; k < 3; k++) {
    const y0 = 0.03 + k * 0.255, y1 = y0 + 0.22;
    box(b, -0.44, y0, -0.49, 0.44, y1, -0.47, SKIP.PZ);
    box(b, -0.44, y0, 0.47, 0.44, y1, 0.49, SKIP.NZ);
    box(b, -0.49, y0, -0.44, -0.47, y1, 0.44, SKIP.PX);
    box(b, 0.47, y0, -0.44, 0.49, y1, 0.44, SKIP.NX);
  }
  b.mat(Mat.WOOD, w[0] * 0.9, w[1] * 0.9, w[2] * 0.9);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const x0 = sx < 0 ? -0.5 : 0.44, z0 = sz < 0 ? -0.5 : 0.44;
    box(b, x0, 0, z0, x0 + 0.06, 0.8, z0 + 0.06, SKIP.NY);
  }
  box(b, -0.44, 0.78, -0.3, 0.44, 0.8, -0.2, SKIP.NY);
  box(b, -0.44, 0.78, 0.2, 0.44, 0.8, 0.3, SKIP.NY);
};

// ---------------------------------------------------------------------------------------- PALLET
const PALLET_WOOD: readonly RGB[] = [[0.45, 0.34, 0.2], [0.26, 0.23, 0.19], [0.06, 0.12, 0.28], [0.38, 0.28, 0.16]];
export const pallet: PropBuild = (b, v, seed) => {
  const w = PALLET_WOOD[v];
  if (v === 2) b.mat(Mat.METAL_PAINTED, w[0], w[1], w[2]); // painted (pooled) pallet
  else b.mat(Mat.WOOD, w[0], w[1], w[2]);
  // top deck boards along x
  const nTop = v === 3 ? 4 : 5; // variant 3: a board missing
  const zs = [-0.44, -0.22, 0, 0.22, 0.44];
  for (let k = 0, placed = 0; k < 5 && placed < nTop; k++) {
    if (v === 3 && k === 1 + (seed & 1) * 2) continue;
    const z = zs[k];
    box(b, -0.6, 0.123, z - 0.055, 0.6, 0.145, z + 0.055);
    placed++;
  }
  // stringer boards (across, along z), blocks, bottom boards
  const xs = [-0.55, 0, 0.55];
  for (const x of xs) box(b, x - 0.05, 0.1, -0.5, x + 0.05, 0.123, 0.5);
  b.mat(v === 2 ? Mat.METAL_PAINTED : Mat.WOOD, w[0] * 0.85, w[1] * 0.85, w[2] * 0.85);
  for (const x of xs) for (const z of [-0.45, 0, 0.45]) box(b, x - 0.05, 0.022, z - 0.05, x + 0.05, 0.1, z + 0.05, SKIP.NY | SKIP.PY);
  for (const z of [-0.45, 0, 0.45]) box(b, -0.6, 0, z - 0.05, 0.6, 0.022, z + 0.05, SKIP.NY);
};

// ---------------------------------------------------------------------------------------- SHELF_RACK
// Pallet racking: 4 blue C-channel uprights with slot punchings, zig-zag end-frame bracing, 3 levels of orange
// step beams with wire (grate) decks, cardboard loads. Variant 2 = collapsed: the +x end frame buckled 25 deg
// inward about its base, beams torn off that end and hanging from the -x uprights, loads on the floor.
const UPRIGHT_PROF = [ // C-section, 8 cm wide (x) x 7 cm deep (z), opening toward -x... closed polygon (x, -z)
  -0.04, -0.035, 0.04, -0.035, 0.04, 0.035, -0.04, 0.035, -0.04, 0.025, 0.03, 0.025, 0.03, -0.025, -0.04, -0.025,
];
function upright(b: PartBuilder, x: number, z: number, h: number): void {
  b.mat(Mat.METAL_PAINTED, RACK_BLUE[0], RACK_BLUE[1], RACK_BLUE[2], 0, 0.35);
  b.push();
  b.translate(x, 0, z);
  b.rotX(-Math.PI / 2); // extrusion (local Z) -> +Y
  extrude(b, UPRIGHT_PROF, 0, h, 2);
  b.pop();
  // slot punchings on the aisle face (-z for front uprights, +z for back ones)
  b.mat(Mat.PLASTIC, 0.01, 0.01, 0.012);
  const sz = z < 0 ? -1 : 1;
  for (let y = 0.25; y < h - 0.1; y += 0.1) rect(b, x, y, z + sz * 0.0355, 0.008, 0, 0, 0, 0.022, 0, 0, 0, sz);
}
function basePlates(b: PartBuilder, x: number): void {
  b.mat(Mat.METAL_PAINTED, 0.2, 0.2, 0.2);
  const x0 = x < 0 ? x - 0.04 : x - 0.05, x1 = x < 0 ? x + 0.05 : x + 0.04;
  box(b, x0, 0, -0.55, x1, 0.008, -0.45, SKIP.NY);
  box(b, x0, 0, 0.45, x1, 0.008, 0.55, SKIP.NY);
}
function endFrame(b: PartBuilder, x: number, h: number): void {
  upright(b, x, -0.5, h);
  upright(b, x, 0.5, h);
  b.mat(Mat.METAL_PAINTED, RACK_BLUE[0], RACK_BLUE[1], RACK_BLUE[2], 0, 0.35);
  // bracing: bottom horizontal + zig-zag diagonals
  sweep(b, [x, 0.12, -0.465, x, 0.12, 0.465], 0.012, 4, 0);
  const n = 6;
  for (let k = 0; k < n; k++) {
    const y0 = 0.12 + ((h - 0.35) * k) / n, y1 = 0.12 + ((h - 0.35) * (k + 1)) / n;
    const za = k & 1 ? 0.465 : -0.465;
    sweep(b, [x, y0, za, x, y1, -za], 0.012, 4, 0);
  }
}
function beam(b: PartBuilder, len: number): void {
  // local: from x = 0 to len, centred on y and z
  b.mat(Mat.METAL_PAINTED, RACK_ORANGE[0], RACK_ORANGE[1], RACK_ORANGE[2], 0, 0.35);
  bevelBox(b, 0, -0.06, -0.025, len, 0.06, 0.025, 0.008);
}
function cardboardLoad(b: PartBuilder, x: number, y: number, z: number, sx: number, sy: number, sz: number, tone: number): void {
  b.mat(Mat.DRYWALL, KRAFT[0] * tone, KRAFT[1] * tone, KRAFT[2] * tone);
  box(b, x - sx / 2, y, z - sz / 2, x + sx / 2, y + sy, z + sz / 2, SKIP.NY);
}
const RACK_LEVELS = [1.2, 2.4, 3.6];
export const shelfRack: PropBuild = (b, v, seed) => {
  const H = 4.2, X = 1.16, BEAM = 2.24;
  const collapsed = v === 2;
  endFrame(b, -X, H);
  basePlates(b, -X);
  basePlates(b, X);
  if (collapsed) {
    b.push();
    b.translate(1.12, 0, 0);
    b.rotZ((25 * Math.PI) / 180); // leans toward -x (pivot on the inner face of the uprights)
    b.translate(-1.12, 0, 0);
    endFrame(b, X, H);
    b.pop();
  } else endFrame(b, X, H);
  // beams + decks
  for (let li = 0; li < RACK_LEVELS.length; li++) {
    const L = RACK_LEVELS[li];
    for (const zb of [-0.5, 0.5]) {
      b.push();
      if (collapsed) {
        // torn off the buckled end: hangs from the -x upright
        const a = L >= BEAM ? rndRange(seed, li * 2 + (zb > 0 ? 1 : 0), 1.2, 1.35) : Math.asin(Math.min(0.97, (L - 0.13) / BEAM));
        b.translate(-1.12, L - 0.06, zb);
        b.rotZ(-a);
        beam(b, BEAM);
      } else {
        b.translate(-1.12, L - 0.06, zb);
        beam(b, BEAM);
      }
      b.pop();
    }
    b.mat(Mat.METAL_GRATE, -1, -1, -1, VFlag.DECAL);
    b.push();
    if (collapsed) {
      const a = li === 0 ? Math.asin((L - 0.03) / BEAM) : rndRange(seed, 10 + li, 1.25, 1.4);
      b.translate(-1.12, L - 0.015, 0);
      b.rotZ(-a);
      box(b, 0.02, -0.008, -0.49, BEAM - 0.02, 0.004, 0.49);
    } else {
      box(b, -1.1, L - 0.008, -0.49, 1.1, L + 0.004, 0.49); // rests on the beams' inner steps
    }
    b.pop();
  }
  // loads (count fixed per variant; placement from the seed)
  if (collapsed) {
    for (let k = 0; k < 3; k++) {
      const x = rndRange(seed, 20 + k, -0.9, 0.3), z = rndRange(seed, 30 + k, -0.3, 0.3);
      cardboardLoad(b, x, 0, z, 0.5, 0.35, 0.4, 0.8 + 0.3 * rnd(seed, 40 + k));
    }
    return;
  }
  const count = v === 0 ? 8 : v === 1 ? 5 : 3;
  for (let k = 0; k < count; k++) {
    const li = k % 4; // 0 = floor, 1..3 = beam levels
    const slot = k < 4 ? (rnd(seed, 50 + k) < 0.5 ? 0 : 1) : 2;
    const x = -0.72 + slot * 0.72 + rndRange(seed, 60 + k, -0.08, 0.08);
    const y = li === 0 ? 0 : RACK_LEVELS[li - 1];
    const sx = rndRange(seed, 70 + k, 0.4, 0.6), sz = rndRange(seed, 90 + k, 0.5, 0.85);
    const sy = Math.min(rndRange(seed, 80 + k, 0.3, 0.7), 4.18 - y);
    cardboardLoad(b, x, y, rndRange(seed, 100 + k, -0.05, 0.05), sx, sy, sz, 0.8 + 0.3 * rnd(seed, 110 + k));
  }
};

// ---------------------------------------------------------------------------------------- BOILER
const BOILER_PAINT: readonly RGB[] = [[0.1, 0.16, 0.12], [0.35, 0.05, 0.03], [0.2, 0.2, 0.2], [0.45, 0.42, 0.33]];
export const boiler: PropBuild = (b, v) => {
  const c = BOILER_PAINT[v];
  const rusty = v === 2;
  b.mat(Mat.CONCRETE_WALL);
  bevelBox(b, -0.75, 0, -0.75, 0.75, 0.15, 0.75, 0.02, SKIP.NY);
  paint(b, c, rusty, 0.4);
  lathe(b, [0.66, 0.15, 0.66, 1.65, 0.62, 1.78, 0.5, 1.88, 0.3, 1.93, 0.12, 1.95, 0, 1.95], 16, 0);
  // insulation / stiffener bands
  b.mat(Mat.METAL_PAINTED, 0.3, 0.3, 0.29, 0, 0.35);
  for (const y of [0.45, 0.95, 1.45]) lathe(b, [0.66, y, 0.675, y, 0.675, y + 0.05, 0.66, y + 0.05], 16, 0, 10);
  // flue
  b.mat(Mat.METAL_PAINTED, 0.12, 0.12, 0.12, 0, 0.5);
  cylinder(b, 0.14, 0.14, 1.9, 2.2, 12, 2);
  // manway door with bolt ring (front, -z)
  paint(b, c, rusty, 0.4);
  b.push();
  b.translate(0, 0.95, -0.655);
  b.rotX(-Math.PI / 2);
  cylinder(b, 0.21, 0.2, 0, 0.04, 14, 2);
  b.mat(Mat.METAL_PAINTED, 0.25, 0.25, 0.24, 0, 0.3);
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    const x = Math.cos(a) * 0.175, z = Math.sin(a) * 0.175;
    box(b, x - 0.012, 0.04, z - 0.012, x + 0.012, 0.055, z + 0.012, SKIP.NY);
  }
  b.pop();
  // side nozzles with flanges
  paint(b, c, rusty, 0.4);
  for (const sx of [-1, 1]) {
    b.push();
    b.translate(sx * 0.6, 1.3, 0);
    b.rotZ(-sx * Math.PI / 2);
    cylinder(b, 0.08, 0.08, 0, 0.16, 10, 0);
    cylinder(b, 0.12, 0.12, 0.15, 0.19, 10, 3);
    b.pop();
  }
  // pressure gauge
  b.mat(Mat.METAL_PAINTED, 0.45, 0.45, 0.44, 0, 0.3);
  b.push();
  b.translate(0.3, 1.6, -0.58);
  b.rotX(-Math.PI / 2);
  cylinder(b, 0.06, 0.06, 0, 0.05, 10, 2);
  b.pop();
  b.mat(Mat.PLASTIC, 0.52, 0.52, 0.5);
  rect(b, 0.3, 1.6, -0.6305, 0.045, 0, 0, 0, 0.045, 0, 0, 0, -1);
  // burner housing
  b.mat(Mat.METAL_PAINTED, 0.3, 0.3, 0.3, 0, 0.35);
  bevelBox(b, -0.3, 0.15, -0.8, 0.3, 0.55, -0.55, 0.02, SKIP.NY);
};

// ---------------------------------------------------------------------------------------- TANK
const TANK_PAINT: readonly RGB[] = [[0.5, 0.5, 0.47], [0.3, 0.3, 0.3], [0.3, 0.3, 0.3], [0.1, 0.18, 0.1]];
export const tank: PropBuild = (b, v) => {
  const c = TANK_PAINT[v];
  const rusty = v === 2;
  // legs (angle-iron look: two plates each) and foot plates
  b.mat(Mat.METAL_PAINTED, 0.15, 0.15, 0.15, 0, 0.4);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const x = sx * 0.4, z = sz * 0.4;
    box(b, x - 0.035, 0.012, z - 0.004, x + 0.035, 0.72, z + 0.004, SKIP.NY);
    box(b, x - 0.004, 0.012, z - 0.035, x + 0.004, 0.72, z + 0.035, SKIP.NY);
    box(b, x - 0.07, 0, z - 0.07, x + 0.07, 0.012, z + 0.07, SKIP.NY);
  }
  // vessel with 2:1 elliptical heads
  paint(b, c, rusty, 0.45);
  lathe(b, [0, 0.45, 0.25, 0.47, 0.42, 0.53, 0.52, 0.62, 0.55, 0.72, 0.55, 2.1, 0.52, 2.2, 0.42, 2.29, 0.25, 2.35, 0, 2.37], 16, 0, 40);
  b.mat(Mat.METAL_PAINTED, c[0] * 0.8, c[1] * 0.8, c[2] * 0.8, 0, 0.45);
  lathe(b, [0.55, 1.4, 0.565, 1.4, 0.565, 1.44, 0.55, 1.44], 16, 0, 10); // girth weld band
  // top nozzle + flange
  b.mat(Mat.METAL_PAINTED, 0.25, 0.25, 0.25, 0, 0.4);
  cylinder(b, 0.06, 0.06, 2.3, 2.37, 10, 0);
  cylinder(b, 0.1, 0.1, 2.37, 2.4, 10, 2);
  // side outlet + valve body
  b.push();
  b.translate(-0.5, 0.95, 0);
  b.rotZ(Math.PI / 2); // +Y -> -X
  cylinder(b, 0.05, 0.05, 0, 0.06, 10, 0);
  cylinder(b, 0.085, 0.085, 0.06, 0.09, 10, 3);
  b.pop();
  // sight glass with brackets
  b.mat(Mat.PLASTIC, 0.08, 0.1, 0.1, 0, 0.1);
  sweep(b, [0.585, 0.9, 0, 0.585, 1.9, 0], 0.013, 6, 3);
  b.mat(Mat.METAL_PAINTED, 0.25, 0.25, 0.25);
  box(b, 0.54, 0.86, -0.015, 0.6, 0.9, 0.015, 0);
  box(b, 0.54, 1.9, -0.015, 0.6, 1.94, 0.015, 0);
  // nameplate
  b.mat(Mat.METAL_PAINTED, 0.5, 0.48, 0.4, 0, 0.3);
  box(b, -0.12, 1.53, -0.556, 0.12, 1.67, -0.5, SKIP.PZ); // plate face proud of the shell, sides buried in it
};

// ---------------------------------------------------------------------------------------- PIPE_VALVE
// Gate valve on a pipe running along local x through the centre of the 0.3 m footprint (axis at y = 0.15: WP3 / WP4
// place it with p.y = pipeCentreY - 0.15), flanged both sides, bonnet + stem + handwheel above.
const VALVE_Y = 0.15;
export const pipeValve: PropBuild = (b, v) => {
  const rusty = v === 2;
  b.push();
  b.translate(0, VALVE_Y, 0);
  b.rotZ(-Math.PI / 2); // local +Y -> +X
  paint(b, [0.12, 0.12, 0.12], rusty, 0.45);
  cylinder(b, 0.074, 0.074, -0.15, -0.12, 8, 3);
  cylinder(b, 0.074, 0.074, 0.12, 0.15, 8, 3);
  lathe(b, [0.045, -0.12, 0.07, -0.06, 0.076, 0, 0.07, 0.06, 0.045, 0.12], 8, 0, 40);
  b.pop();
  paint(b, [0.12, 0.12, 0.12], rusty, 0.45);
  cylinder(b, 0.035, 0.035, VALVE_Y + 0.05, VALVE_Y + 0.1, 8, 2); // bonnet
  b.mat(Mat.METAL_PAINTED, 0.45, 0.45, 0.44, 0, 0.3);
  cylinder(b, 0.008, 0.008, VALVE_Y + 0.1, VALVE_Y + 0.132, 4, 0); // stem
  const wheel: RGB = v === 1 ? [0.05, 0.15, 0.4] : [0.45, 0.04, 0.03];
  b.mat(Mat.METAL_PAINTED, wheel[0], wheel[1], wheel[2], 0, 0.4);
  b.push();
  b.translate(0, VALVE_Y + 0.135, 0);
  torus(b, 0.09, 0.01, 0, Math.PI * 2, 10, 4);
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI * 2;
    sweep(b, [0, 0, 0, Math.cos(a) * 0.085, 0, Math.sin(a) * 0.085], 0.006, 4, 0);
  }
  cylinder(b, 0.016, 0.016, -0.01, 0.012, 6, 3);
  b.pop();
};

// ---------------------------------------------------------------------------------------- VENT_GRILLE
const VENT: readonly RGB[] = [[0.52, 0.51, 0.48], [0.3, 0.3, 0.3], [0.35, 0.35, 0.34], [0.42, 0.38, 0.3]];
export const ventGrille: PropBuild = (b, v) => {
  const c = VENT[v];
  const rusty = v === 1;
  paint(b, c, rusty, 0);
  // frame (back on the wall at z = +0.025)
  box(b, -0.3, 0, 0.0, -0.27, 0.3, 0.025, SKIP.PZ);
  box(b, 0.27, 0, 0.0, 0.3, 0.3, 0.025, SKIP.PZ);
  box(b, -0.27, 0.27, 0.0, 0.27, 0.3, 0.025, SKIP.PZ);
  box(b, -0.27, 0, 0.0, 0.27, 0.03, 0.025, SKIP.PZ);
  // louvres tilted down toward the room
  for (let k = 0; k < 8; k++) {
    b.push();
    b.translate(0, 0.045 + k * 0.03, 0.012);
    b.rotX(0.6);
    box(b, -0.27, -0.013, -0.002, 0.27, 0.013, 0.002, 0);
    b.pop();
  }
  // dark duct behind
  b.mat(Mat.PLENUM);
  rect(b, 0, 0.15, 0.0245, 0.27, 0, 0, 0, 0.12, 0, 0, 0, -1);
};

// ---------------------------------------------------------------------------------------- EXTINGUISHER
export const extinguisher: PropBuild = (b, v) => {
  const zc = 0.02;
  // wall bracket
  b.mat(Mat.METAL_PAINTED, 0.12, 0.12, 0.12, 0, 0.4);
  box(b, -0.05, 0.3, 0.105, 0.05, 0.62, 0.125, SKIP.PZ);
  box(b, -0.015, 0.58, 0.06, 0.015, 0.6, 0.105, 0);
  // body
  const body: RGB = v === 2 ? [0.4, 0.4, 0.4] : v === 3 ? [0.3, 0.05, 0.04] : [0.42, 0.02, 0.015];
  b.mat(Mat.METAL_PAINTED, body[0], body[1], body[2], 0, 0.25);
  b.push();
  b.translate(0, 0, zc);
  lathe(b, [0, 0.18, 0.07, 0.18, 0.08, 0.2, 0.08, 0.6, 0.07, 0.65, 0.04, 0.68, 0.02, 0.69, 0.02, 0.71], 12, 0);
  // valve head + levers
  b.mat(Mat.METAL_PAINTED, 0.5, 0.5, 0.48, 0, 0.2);
  box(b, -0.025, 0.71, -0.025, 0.025, 0.77, 0.025, 0);
  box(b, -0.012, 0.77, -0.07, 0.012, 0.785, 0.02, 0);
  b.push();
  b.translate(0, 0.745, -0.02);
  b.rotX(-0.25);
  box(b, -0.012, -0.007, -0.08, 0.012, 0.007, 0, 0);
  b.pop();
  // gauge
  b.push();
  b.translate(0.025, 0.74, 0);
  b.rotZ(-Math.PI / 2);
  cylinder(b, 0.014, 0.014, 0, 0.01, 6, 2);
  b.pop();
  // hose + nozzle
  b.mat(Mat.RUBBER);
  tubePath(b, [0.03, 0.735, 0, 0.1, 0.72, 0, 0.125, 0.5, -0.02, 0.11, 0.32, -0.03], 0.01, 6, 0.04, 2, 0);
  b.push();
  b.translate(0.11, 0.32, -0.03);
  cylinder(b, 0.016, 0.012, -0.06, 0, 6, 1);
  b.pop();
  // label (FIRE sign slot)
  b.mat(Mat.SIGNAGE, -1, -1, -1, VFlag.DECAL);
  b.rawUv();
  rect(b, 0, 0.42, -0.0815, -0.03, 0, 0, 0, 0.045, 0, 0, 0, -1, signSlot(SignKind.FIRE)); // +u = -x: the viewer's right
  b.pop();
};

// ---------------------------------------------------------------------------------------- CARDBOARD_BOX
export const cardboardBox: PropBuild = (b, v, seed) => {
  const tone = v === 2 ? 0.75 : 1;
  const c: RGB = [KRAFT[0] * tone, KRAFT[1] * tone, KRAFT[2] * tone];
  if (v === 1) {
    // open box: outer walls, a rim closing the 4 mm wall thickness, inner walls and bottom, 4 flaps folded out
    const W = 0.2, D = 0.15, H = 0.3, t = 0.004;
    b.mat(Mat.DRYWALL, c[0], c[1], c[2]);
    box(b, -W, 0, -D, W, H, D, SKIP.NY | SKIP.PY);
    // rim (top edge of the corrugated board)
    rect(b, 0, H, -D + t / 2, W, 0, 0, 0, 0, t / 2, 0, 1, 0);
    rect(b, 0, H, D - t / 2, W, 0, 0, 0, 0, t / 2, 0, 1, 0);
    rect(b, -W + t / 2, H, 0, t / 2, 0, 0, 0, 0, D - t, 0, 1, 0);
    rect(b, W - t / 2, H, 0, t / 2, 0, 0, 0, 0, D - t, 0, 1, 0);
    b.mat(Mat.DRYWALL, c[0] * 0.6, c[1] * 0.6, c[2] * 0.6);
    rect(b, 0, H / 2, -D + t, W - t, 0, 0, 0, H / 2, 0, 0, 0, 1);
    rect(b, 0, H / 2, D - t, W - t, 0, 0, 0, H / 2, 0, 0, 0, -1);
    rect(b, -W + t, H / 2, 0, 0, 0, D - t, 0, H / 2, 0, 1, 0, 0);
    rect(b, W - t, H / 2, 0, 0, 0, D - t, 0, H / 2, 0, -1, 0, 0);
    rect(b, 0, 0.004, 0, W - t, 0, 0, 0, 0, D - t, 0, 1, 0);
    b.mat(Mat.DRYWALL, c[0], c[1], c[2]);
    // flaps: hinged on the rim, folded out and down; a = elevation above horizontal. Two faces 4 mm apart (the
    // board thickness) so the two sides never share a plane.
    const flap = (k: number, hx: number, hz: number, ox: number, oz: number, half: number, len: number): void => {
      const a = 0.5 + 0.25 * rnd(seed, k);
      const dx = ox * Math.cos(a), dy = Math.sin(a), dz = oz * Math.cos(a);
      const ux = oz !== 0 ? half : 0, uz = ox !== 0 ? half : 0;
      const nx = -ox * Math.sin(a), ny = Math.cos(a), nz = -oz * Math.sin(a);
      for (const sd of [1, -1]) {
        const o = sd * t / 2;
        const cx = hx + dx * len * 0.5 + nx * o, cy = H + dy * len * 0.5 + ny * o, cz = hz + dz * len * 0.5 + nz * o;
        rect(b, cx, cy, cz, ux, 0, uz, dx * len * 0.5, dy * len * 0.5, dz * len * 0.5, nx * sd, ny * sd, nz * sd);
      }
      // free (outer) edge of the board
      rect(b, hx + dx * len, H + dy * len, hz + dz * len, ux, 0, uz, nx * t / 2, ny * t / 2, nz * t / 2, dx, dy, dz);
    };
    flap(1, 0, -D, 0, -1, W, 0.05);
    flap(2, 0, D, 0, 1, W, 0.05);
    flap(3, -W, 0, -1, 0, D, 0.05);
    flap(4, W, 0, 1, 0, D, 0.05);
    return;
  }
  b.mat(Mat.DRYWALL, c[0], c[1], c[2]);
  if (v === 3) {
    // crushed: sheared and squashed
    const s = rndRange(seed, 1, 0.03, 0.06);
    hexa(b, [-0.25, 0, -0.2, 0.25, 0, -0.2, 0.25, 0, 0.2, -0.25, 0, 0.2,
      -0.25 + s, 0.3, -0.19, 0.25, 0.33, -0.2, 0.25 - s, 0.31, 0.19, -0.24, 0.29, 0.2]);
  } else {
    bevelBox(b, -0.248, 0, -0.198, 0.248, 0.398, 0.198, 0.006, SKIP.NY);
  }
  const top = v === 3 ? 0.315 : 0.398;
  b.mat(Mat.PLASTIC, 0.42, 0.36, 0.22, 0, 0.3);
  if (v !== 3) {
    // packing tape over the lid seam and 4 cm down both ends (1.5 mm proud of the board)
    rect(b, 0, top + 0.0015, 0, 0.025, 0, 0, 0, 0, 0.1995, 0, 1, 0);
    rect(b, 0, top - 0.04, -0.1995, 0.025, 0, 0, 0, 0.04, 0, 0, 0, -1);
    rect(b, 0, top - 0.04, 0.1995, 0.025, 0, 0, 0, 0.04, 0, 0, 0, 1);
  }
};

