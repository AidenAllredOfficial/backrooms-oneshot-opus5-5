// src/props/office.ts — office and wall-hardware props: FILING_CABINET, CRT_MONITOR, WATER_COOLER,
// VENDING_MACHINE, TRASH_CAN, PHONE, RADIO, OUTLET, THERMOSTAT (§5 WP6).
// Prop-local frame: base centre at the origin, +Y up, front faces -Z; wall-mounted props have their back on +Z.
// Pure module (no three/DOM).

import { Mat } from '../core/ids.ts';
import type { PropBuild } from './furniture.ts';
import { bevelBox, box, cylinder, extrudeBevel, heightGrid, hexa, lathe, rect, SKIP, tubePath } from './primitives.ts';

type RGB = readonly [number, number, number];
const DARK_GLASS: RGB = [0.018, 0.022, 0.02];
const CHROME: RGB = [0.56, 0.56, 0.55];

// ---------------------------------------------------------------------------------------- FILING_CABINET
const CABINET: readonly RGB[] = [[0.45, 0.4, 0.3], [0.32, 0.32, 0.31], [0.2, 0.22, 0.14], [0.3, 0.3, 0.29]];
export const filingCabinet: PropBuild = (b, v) => {
  const c = CABINET[v];
  const ajar = v === 3;
  const front = ajar ? -0.21 : -0.27; // body front plane
  b.mat(Mat.METAL_PAINTED, c[0], c[1], c[2]);
  bevelBox(b, -0.23, 0, front, 0.23, 1.32, 0.31, 0.01, SKIP.NY);
  for (let i = 0; i < 4; i++) {
    const y0 = 0.04 + i * 0.32, y1 = y0 + 0.3;
    const out = ajar && i === 3 ? 0.06 : 0; // top drawer pulled out
    const fz = front - out;
    b.mat(Mat.METAL_PAINTED, c[0] * 1.04, c[1] * 1.04, c[2] * 1.04);
    bevelBox(b, -0.215, y0, fz - 0.015, 0.215, y1, fz + 0.005, 0.006, SKIP.PZ);
    if (out > 0) {
      // drawer side walls visible in the gap
      b.mat(Mat.METAL_PAINTED, c[0] * 0.7, c[1] * 0.7, c[2] * 0.7);
      box(b, -0.2, y0 + 0.03, fz, -0.19, y1 - 0.03, front + 0.01, SKIP.PZ | SKIP.NZ);
      box(b, 0.19, y0 + 0.03, fz, 0.2, y1 - 0.03, front + 0.01, SKIP.PZ | SKIP.NZ);
    }
    b.mat(Mat.METAL_PAINTED, CHROME[0], CHROME[1], CHROME[2], 0, 0.22);
    box(b, -0.07, y1 - 0.085, fz - 0.035, 0.07, y1 - 0.06, fz - 0.015, SKIP.PZ);
    b.mat(Mat.PLASTIC, 0.5, 0.48, 0.42);
    rect(b, 0, y1 - 0.035, fz - 0.0155, 0.04, 0, 0, 0, 0.012, 0, 0, 0, -1);
  }
};

// ---------------------------------------------------------------------------------------- CRT_MONITOR
const CRT_SHELL: readonly RGB[] = [[0.5, 0.47, 0.4], [0.33, 0.33, 0.32], [0.48, 0.43, 0.3], [0.05, 0.05, 0.055]];
export const crtMonitor: PropBuild = (b, v) => {
  const s = CRT_SHELL[v];
  b.mat(Mat.PLASTIC, s[0], s[1], s[2]);
  // stand
  cylinder(b, 0.13, 0.115, 0, 0.022, 10, 2);
  box(b, -0.06, 0.022, -0.07, 0.06, 0.085, 0.05, SKIP.NY); // neck, top buried in the housing
  // bezel + tapered back housing
  bevelBox(b, -0.2, 0.06, -0.194, 0.2, 0.38, -0.13, 0.014);
  hexa(b, [-0.185, 0.07, -0.13, 0.185, 0.07, -0.13, 0.12, 0.12, 0.18, -0.12, 0.12, 0.18,
    -0.185, 0.37, -0.13, 0.185, 0.37, -0.13, 0.12, 0.32, 0.18, -0.12, 0.32, 0.18]);
  box(b, -0.08, 0.15, 0.18, 0.08, 0.29, 0.196, SKIP.NZ);
  // vent slots on the sloping top
  b.mat(Mat.PLASTIC, 0.02, 0.02, 0.02);
  for (let k = 0; k < 4; k++) {
    const z = 0.0 + k * 0.035;
    const y = 0.37 - ((z + 0.13) / 0.31) * 0.05 + 0.003;
    rect(b, 0, y, z, 0.1, 0, 0, 0, 0, 0.006, 0, 1, 0);
  }
  // curved screen (dark glossy glass), a height grid in a frame whose +Y is the screen normal (-Z)
  b.mat(Mat.PLASTIC, DARK_GLASS[0], DARK_GLASS[1], DARK_GLASS[2], 0, 0.08);
  b.push();
  b.translate(0, 0, -0.194);
  b.rotX(-Math.PI / 2);
  const nx = 6, ny = 5, hx = 0.165, y0 = 0.095, y1 = 0.345;
  heightGrid(b, nx, ny, (i) => -hx + (2 * hx * i) / nx, (i, j) => {
    const u = -1 + (2 * i) / nx, w = -1 + (2 * j) / ny;
    return 0.001 + 0.012 * (1 - 0.5 * u * u - 0.5 * w * w);
  }, (_i, j) => y0 + ((y1 - y0) * j) / ny, null);
  b.pop();
  // power button + LED
  b.mat(Mat.PLASTIC, s[0] * 0.8, s[1] * 0.8, s[2] * 0.8);
  box(b, 0.14, 0.075, -0.2, 0.17, 0.085, -0.194, SKIP.PZ);
  b.emissive(Mat.PLASTIC, 0.2, 1, 0.25, 60, 0, 0, 0);
  rect(b, 0.12, 0.08, -0.1945, 0.004, 0, 0, 0, 0.003, 0, 0, 0, -1);
};

// ---------------------------------------------------------------------------------------- WATER_COOLER
const COOLER: readonly RGB[] = [[0.52, 0.5, 0.45], [0.48, 0.44, 0.34], [0.36, 0.37, 0.37], [0.5, 0.5, 0.47]];
const JUG: readonly RGB[] = [[0.2, 0.36, 0.55], [0.22, 0.38, 0.52], [0.3, 0.42, 0.52], [0.18, 0.33, 0.5]];
export const waterCooler: PropBuild = (b, v) => {
  const c = COOLER[v], j = JUG[v];
  b.mat(Mat.PLASTIC, c[0], c[1], c[2]);
  bevelBox(b, -0.15, 0, -0.12, 0.15, 0.95, 0.16, 0.015, SKIP.NY);
  b.push();
  b.translate(0, 0, 0.02);
  cylinder(b, 0.1, 0.095, 0.95, 0.985, 10, 2);
  b.pop();
  b.mat(Mat.PLASTIC, 0.06, 0.06, 0.065);
  rect(b, 0, 0.8, -0.1205, 0.11, 0, 0, 0, 0.08, 0, 0, 0, -1); // tap recess
  box(b, -0.1, 0.66, -0.158, 0.1, 0.68, -0.12, SKIP.PZ); // drip tray
  b.mat(Mat.PLASTIC, 0.45, 0.04, 0.03);
  box(b, -0.075, 0.79, -0.15, -0.045, 0.82, -0.12, SKIP.PZ); // hot tap
  b.mat(Mat.PLASTIC, 0.05, 0.12, 0.45);
  box(b, 0.045, 0.79, -0.15, 0.075, 0.82, -0.12, SKIP.PZ); // cold tap
  // inverted jug (glossy blue plastic)
  b.mat(Mat.PLASTIC, j[0], j[1], j[2], 0, 0.12);
  b.push();
  b.translate(0, 0, 0.02);
  lathe(b, [0.03, 0.95, 0.03, 0.995, 0.06, 1.015, 0.135, 1.06, 0.135, 1.23, 0.12, 1.275, 0.06, 1.297, 0, 1.3], 12, 0);
  b.pop();
};

// ---------------------------------------------------------------------------------------- VENDING_MACHINE
// The VENDING fixture (RECT 0.7 x 1.4, normal = the machine's front, centre on or just in front of it at y ~1.05)
// draws the lit product panel 3.2 cm behind its centre, i.e. inside this 0.72 x 1.42 window (centre local
// (0, 1.05), frame 2 cm proud of the body). Without a fixture the window shows dark glass. docs/contract-changes/WP6.md.
const VEND: readonly RGB[] = [[0.4, 0.03, 0.03], [0.04, 0.1, 0.35], [0.03, 0.03, 0.035], [0.5, 0.5, 0.48]];
export const vendingMachine: PropBuild = (b, v) => {
  const c = VEND[v];
  b.mat(Mat.METAL_PAINTED, c[0], c[1], c[2], 0, 0.3);
  bevelBox(b, -0.45, 0, -0.37, 0.45, 1.83, 0.4, 0.02, SKIP.NY);
  // door frame around the window (proud of the body)
  const dc: RGB = [c[0] * 0.8, c[1] * 0.8, c[2] * 0.8];
  b.mat(Mat.METAL_PAINTED, dc[0], dc[1], dc[2], 0, 0.3);
  box(b, -0.45, 0.02, -0.39, -0.36, 1.81, -0.37, SKIP.PZ);
  box(b, 0.36, 0.02, -0.39, 0.45, 1.81, -0.37, SKIP.PZ);
  box(b, -0.36, 1.76, -0.39, 0.36, 1.81, -0.37, SKIP.PZ);
  box(b, -0.36, 0.02, -0.39, 0.36, 0.34, -0.37, SKIP.PZ);
  // dark glass back of the window (visible when the fixture is absent)
  b.mat(Mat.PLASTIC, DARK_GLASS[0], DARK_GLASS[1], DARK_GLASS[2], 0, 0.1);
  rect(b, 0, 1.05, -0.3705, 0.36, 0, 0, 0, 0.71, 0, 0, 0, -1);
  // delivery flap and coin / keypad panel on the bottom bar
  b.mat(Mat.PLASTIC, 0.03, 0.03, 0.03);
  box(b, -0.3, 0.09, -0.398, 0.12, 0.25, -0.39, SKIP.PZ);
  b.mat(Mat.METAL_PAINTED, CHROME[0], CHROME[1], CHROME[2], 0, 0.25);
  box(b, 0.18, 0.1, -0.398, 0.32, 0.3, -0.39, SKIP.PZ);
  b.mat(Mat.PLASTIC, 0.02, 0.02, 0.02);
  rect(b, 0.25, 0.26, -0.3985, 0.04, 0, 0, 0, 0.006, 0, 0, 0, -1); // coin slot
  rect(b, 0.25, 0.17, -0.3985, 0.045, 0, 0, 0, 0.045, 0, 0, 0, -1); // keypad
  // plinth kick
  b.mat(Mat.PLASTIC, 0.02, 0.02, 0.022);
  box(b, -0.44, 0, -0.385, 0.44, 0.02, 0.38, SKIP.NY);
};

// ---------------------------------------------------------------------------------------- TRASH_CAN
const CAN: readonly RGB[] = [[0.28, 0.28, 0.27], [0.03, 0.03, 0.033], [0.05, 0.12, 0.35], [0.42, 0.42, 0.4]];
export const trashCan: PropBuild = (b, v) => {
  const c = CAN[v];
  if (v === 3) b.mat(Mat.METAL_PAINTED, c[0], c[1], c[2], 0, 0.35);
  else b.mat(Mat.PLASTIC, c[0], c[1], c[2]);
  lathe(b, [0.155, 0, 0.18, 0.575, 0.197, 0.588, 0.195, 0.6, 0.177, 0.592, 0.152, 0.03, 0, 0.03], 10, 1);
};

// ---------------------------------------------------------------------------------------- PHONE
const PHONE: readonly RGB[] = [[0.5, 0.46, 0.36], [0.03, 0.03, 0.033], [0.3, 0.3, 0.3], [0.35, 0.04, 0.03]];
export const phone: PropBuild = (b, v) => {
  const c = PHONE[v];
  b.mat(Mat.PLASTIC, c[0], c[1], c[2]);
  // wedge body, side profile in (-z, y), extruded across x
  b.push();
  b.basis(0, 0, 1, 0, 1, 0, -1, 0, 0); // local X -> +Z, Y -> Y, Z -> -X
  extrudeBevel(b, [-0.1, 0, 0.1, 0, 0.1, 0.075, -0.02, 0.07, -0.1, 0.03], -0.1, 0.1, 0.008);
  b.pop();
  // handset resting across the back
  b.mat(Mat.PLASTIC, c[0] * 0.92, c[1] * 0.92, c[2] * 0.92);
  bevelBox(b, -0.1, 0.075, 0.035, 0.1, 0.095, 0.085, 0.008);
  box(b, -0.1, 0.07, 0.025, -0.055, 0.11, 0.095, 0);
  box(b, 0.055, 0.07, 0.025, 0.1, 0.11, 0.095, 0);
  // keypad on the sloped front: slope from (z=-0.1, y=0.03) to (z=0.02, y=0.07)
  const ang = Math.atan2(0.04, 0.08);
  b.mat(Mat.PLASTIC, 0.45, 0.44, 0.4);
  b.push();
  b.translate(0.0, 0.0525, -0.055);
  b.rotX(-ang);
  for (let r = 0; r < 4; r++) {
    for (let k = 0; k < 3; k++) {
      const x = -0.03 + k * 0.03, z = -0.036 + r * 0.024;
      box(b, x - 0.011, 0, z - 0.009, x + 0.011, 0.007, z + 0.009, SKIP.NY);
    }
  }
  b.mat(Mat.PLASTIC, 0.03, 0.05, 0.04, 0, 0.1);
  rect(b, 0.065, 0.0005, -0.02, 0.022, 0, 0, 0, 0, 0.03, 0, 1, 0); // display
  b.pop();
  // coiled cord stub
  b.mat(Mat.PLASTIC, c[0] * 0.8, c[1] * 0.8, c[2] * 0.8);
  tubePath(b, [-0.1, 0.03, 0.05, -0.105, 0.02, 0.0, -0.105, 0.012, -0.06], 0.005, 4, 0.02, 2, 0);
};

// ---------------------------------------------------------------------------------------- RADIO
const RADIO: readonly RGB[] = [[0.03, 0.03, 0.035], [0.4, 0.4, 0.4], [0.22, 0.12, 0.06], [0.35, 0.04, 0.03]];
export const radio: PropBuild = (b, v) => {
  const c = RADIO[v];
  if (v === 2) b.mat(Mat.WOOD, c[0], c[1], c[2], 0, 0.4);
  else b.mat(Mat.PLASTIC, c[0], c[1], c[2]);
  bevelBox(b, -0.17, 0, -0.05, 0.17, 0.17, 0.05, 0.012);
  // speaker grilles
  b.mat(Mat.METAL_PAINTED, 0.12, 0.12, 0.12, 0, 0.5);
  for (const sx of [-1, 1]) {
    b.push();
    b.translate(sx * 0.1, 0.075, -0.05);
    b.rotX(-Math.PI / 2);
    cylinder(b, 0.047, 0.043, 0, 0.004, 12, 2);
    b.pop();
  }
  // tuning dial window (warm backlight)
  b.emissive(Mat.PLASTIC, 1, 0.62, 0.25, 12, 0, 0, 0);
  rect(b, 0, 0.14, -0.0505, 0.04, 0, 0, 0, 0.012, 0, 0, 0, -1);
  // knobs on top
  b.mat(Mat.PLASTIC, 0.3, 0.3, 0.3);
  for (const x of [0.08, 0.125]) {
    b.push();
    b.translate(x, 0.17, 0);
    cylinder(b, 0.012, 0.011, 0, 0.014, 8, 2);
    b.pop();
  }
  // carry handle
  b.mat(Mat.METAL_PAINTED, CHROME[0], CHROME[1], CHROME[2], 0, 0.25);
  tubePath(b, [-0.13, 0.17, 0, -0.11, 0.19, 0, 0.05, 0.19, 0, 0.07, 0.17, 0], 0.007, 6, 0.012, 2, 0);
};

// ---------------------------------------------------------------------------------------- OUTLET
export const outlet: PropBuild = (b, v) => {
  const ivory = v & 1;
  const pc: RGB = ivory ? [0.5, 0.46, 0.36] : [0.52, 0.51, 0.48];
  b.mat(Mat.PLASTIC, pc[0], pc[1], pc[2]);
  bevelBox(b, -0.035, 0, 0.002, 0.035, 0.12, 0.01, 0.002, SKIP.PZ);
  for (const cy of [0.035, 0.085]) {
    b.mat(Mat.PLASTIC, pc[0] * 0.95, pc[1] * 0.95, pc[2] * 0.95);
    rect(b, 0, cy, 0.0015, 0.018, 0, 0, 0, 0.017, 0, 0, 0, -1);
    b.mat(Mat.PLASTIC, 0.01, 0.01, 0.01);
    rect(b, -0.0065, cy + 0.003, 0.0012, 0.0012, 0, 0, 0, 0.004, 0, 0, 0, -1);
    rect(b, 0.0065, cy + 0.003, 0.0012, 0.0012, 0, 0, 0, 0.0045, 0, 0, 0, -1);
    rect(b, 0, cy - 0.008, 0.0012, 0.0022, 0, 0, 0, 0.0025, 0, 0, 0, -1);
  }
  b.mat(Mat.METAL_PAINTED, 0.4, 0.38, 0.33);
  rect(b, 0, 0.06, 0.0015, 0.003, 0, 0, 0, 0.003, 0, 0, 0, -1); // centre screw
};

// ---------------------------------------------------------------------------------------- THERMOSTAT
export const thermostat: PropBuild = (b, v) => {
  const pc: RGB = v === 2 ? [0.3, 0.29, 0.26] : [0.52, 0.5, 0.45];
  b.mat(Mat.PLASTIC, pc[0], pc[1], pc[2]);
  bevelBox(b, -0.05, 0, -0.012, 0.05, 0.12, 0.015, 0.008, SKIP.PZ);
  b.mat(Mat.PLASTIC, 0.08, 0.1, 0.08, 0, 0.1);
  rect(b, 0, 0.085, -0.0125, 0.03, 0, 0, 0, 0.012, 0, 0, 0, -1);
  b.mat(Mat.PLASTIC, pc[0] * 0.85, pc[1] * 0.85, pc[2] * 0.85);
  b.push();
  b.translate(0, 0.045, -0.012);
  b.rotX(-Math.PI / 2);
  cylinder(b, 0.028, 0.026, 0, 0.003, 8, 2);
  b.pop();
};
