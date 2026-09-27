// src/props/fixtures.ts — surface-mounted / hanging light fixtures (§5 WP6): TUBE_STRIP, CAGE_BULB, HIGHBAY,
// PENDANT_LINEAR, SODIUM, EXIT_SIGN, UNDERWATER, VENDING, RED_BULB. The recessed kinds (TROFFER_2x4, TROFFER_2x2,
// SKY_PANEL) are shell geometry (WP5 mesh/ceilings.ts): emitFixture writes nothing for them.
//
// Fixture frame: X = t (long axis, w), Y = -n (toward the mount: up for ceiling fixtures, into the wall for wall
// fixtures), Z = X x Y (= n x t, the h axis). The origin is the emitting-surface centre p; light leaves toward -Y.
//
// Photometric calibration (tested): the emissive part is sized so that (emit x projected area along n) equals the
// fixture's intensity (SPHERE / disk: `luminance` cd, emit = I / (pi r^2), r = w / 2) or L * w * h (RECT). SPHERE
// geometry is a sphere of radius exactly w / 2; HIGHBAY's disk has radius w / 2.
// Pure module (no three/DOM).

import { DROP_LENS_H, DYING_MEAN, FixtureKind, isRecessedFixture, LightState, Mat, SignKind, VFlag } from '../core/ids.ts';
import { fixtureRadiance, type Fixture } from '../core/layout.ts';
import type { GeometryWriter } from '../core/writer.ts';
import { PartBuilder, rnd } from './builder.ts';
import { signSlot } from './industrial.ts';
import { annulus, bevelBox, box, cylinder, disk, lathe, rect, sphere, SKIP, sweep, torus } from './primitives.ts';

const B = new PartBuilder();

/** Emissive state of a fixture: emitted nits, VFlag bits and the state written to aux.w. */
export interface EmitState { emit: number; flags: number; state: number }
export function fixtureEmitState(f: Pick<Fixture, 'state' | 'dynamic' | 'shape' | 'luminance' | 'w'>, out: EmitState): EmitState {
  const L = fixtureRadiance(f);
  out.emit = L; out.flags = 0; out.state = f.state;
  switch (f.state) {
    case LightState.OFF: out.emit = 0; break;
    case LightState.DYING: out.emit = L * DYING_MEAN; out.flags = VFlag.SHIMMER; break;
    case LightState.BUZZ: out.flags = VFlag.SHIMMER; break;
    case LightState.FLICKER:
      if (f.dynamic) out.flags = VFlag.DYN_EMIT;
      else { out.emit = L * DYING_MEAN; out.flags = VFlag.SHIMMER; out.state = LightState.DYING; } // WP4 demotes these
      break;
    case LightState.ANOMALY: if (f.dynamic) out.flags = VFlag.DYN_EMIT; break;
    default: break;
  }
  return out;
}

/** Projected emissive area the geometry must present along n: RECT w*h, SPHERE / disk pi (w/2)^2. */
export const emissiveArea = (f: Pick<Fixture, 'shape' | 'w' | 'h'>): number =>
  f.shape === 0 ? f.w * f.h : Math.PI * (f.w / 2) * (f.w / 2);

const st: EmitState = { emit: 0, flags: 0, state: 0 };
let cur: Fixture;

/** Switch the builder to the emissive (lens / tube / bulb) material, or an unlit dusty lens when OFF. */
function lens(layer: number): void {
  if (st.emit > 0) B.emissive(layer, cur.color[0], cur.color[1], cur.color[2], st.emit, st.flags, st.state, cur.seed);
  else B.mat(layer, 0.5, 0.49, 0.46, VFlag.NO_GRIME, 0.3);
}
const housing = (r: number, g: number, bb: number, rough = 0): void => B.mat(Mat.METAL_PAINTED, r, g, bb, 0, rough);

/** Default mount distances (m from the emitting surface to the ceiling / wall) when the ceiling is unknown. */
const MOUNT_DEFAULT: Readonly<Record<number, number>> = {
  [FixtureKind.TUBE_STRIP]: 0.05, [FixtureKind.CAGE_BULB]: 0.14, [FixtureKind.HIGHBAY]: 0.9,
  [FixtureKind.PENDANT_LINEAR]: 0.9, [FixtureKind.SODIUM]: 0.2, [FixtureKind.EXIT_SIGN]: 0.05,
  [FixtureKind.UNDERWATER]: 0.0, [FixtureKind.VENDING]: 0.0, [FixtureKind.RED_BULB]: 0.35,
};
/** Longest suspension (cable / rod / conduit) drawn per kind; beyond it the ceiling is treated as unknown. */
const MOUNT_MAX: Readonly<Record<number, number>> = {
  [FixtureKind.TUBE_STRIP]: 1.5, [FixtureKind.CAGE_BULB]: 1.5, [FixtureKind.HIGHBAY]: 6,
  [FixtureKind.PENDANT_LINEAR]: 6, [FixtureKind.SODIUM]: 1.5, [FixtureKind.RED_BULB]: 3,
};

// ------------------------------------------------------------------------------------------ kinds

function tubeStrip(f: Fixture, md: number): void {
  const A = emissiveArea(f);
  const L = f.shape === 0 ? Math.max(0.3, f.w) : 1.2;
  const d = A / (2 * L); // two tubes: 2 * d * L = A
  const n = 8;
  const R = d / 2 / Math.cos(Math.PI / n); // polygon silhouette width == d
  const zc = R + 0.004;
  // tubes (emissive), along X
  lens(Mat.PLASTIC);
  for (const s of [-1, 1]) {
    B.push();
    B.translate(0, 0, s * zc);
    B.rotZ(-Math.PI / 2); // +Y -> +X
    cylinder(B, R, R, -L / 2, L / 2, n, 0);
    B.pop();
  }
  // sockets (tombstones) and batten channel
  // batten channel: 4.5 cm deep, squeezed (down to 1.5 cm) when the fixture is mounted closer to the ceiling
  const top = R + 0.008, bh = Math.max(0.015, Math.min(0.045, md - top)), bw = Math.max(0.035, zc + R + 0.012);
  housing(0.5, 0.5, 0.48, 0.35);
  for (const s of [-1, 1]) box(B, s > 0 ? L / 2 : -L / 2 - 0.022, -R * 0.6, -bw + 0.006, s > 0 ? L / 2 + 0.022 : -L / 2, top, bw - 0.006, SKIP.PY);
  bevelBox(B, -L / 2 - 0.04, top, -bw, L / 2 + 0.04, top + bh, bw, 0.008);
  // suspension to the ceiling
  const hang = md - (top + bh);
  if (hang > 0.03) {
    housing(0.3, 0.3, 0.3, 0.4);
    for (const s of [-1, 1]) {
      B.push();
      B.translate(s * (L / 2 - 0.1), 0, 0);
      B.wire(0.004);
      cylinder(B, 0.004, 0.004, top + bh, md, 4, 0);
      B.pop();
    }
  }
}

function cageBulb(f: Fixture, md: number): void {
  const r = f.shape === 1 ? f.w / 2 : Math.sqrt(emissiveArea(f) / Math.PI);
  lens(Mat.PLASTIC);
  sphere(B, r, 10, 6);
  const rc = r + 0.022; // cage radius
  const mount = Math.max(md, r + 0.1);
  // porcelain socket + cast base cup; conduit stem and junction box on the mount surface
  B.mat(Mat.PLASTIC, 0.08, 0.08, 0.075, 0, 0.3);
  cylinder(B, 0.02, 0.024, r * 0.75, r + 0.055, 8, 0);
  housing(0.12, 0.16, 0.12, 0.45);
  cylinder(B, 0.034, 0.034, r + 0.055, r + 0.075, 8, 1);
  if (mount - (r + 0.075) > 0.08) cylinder(B, 0.011, 0.011, r + 0.075, mount - 0.035, 6, 0); // conduit stem
  cylinder(B, 0.06, 0.06, mount - 0.035, mount, 8, 1);
  // 6-wire cage: meridians from the socket ring over the bulb to the bottom, plus an equator ring
  housing(0.1, 0.1, 0.1, 0.45);
  const pts = CAGE_PTS;
  for (let m = 0; m < 6; m++) {
    const th = (m / 6) * Math.PI * 2, c = Math.cos(th), sn = Math.sin(th);
    pts.length = 0;
    pts.push(0.03 * c, r + 0.06, 0.03 * sn);
    for (let k = 0; k <= 3; k++) {
      const phi = 0.55 + (k / 3) * (Math.PI - 0.62);
      pts.push(rc * Math.sin(phi) * c, rc * Math.cos(phi), rc * Math.sin(phi) * sn);
    }
    sweep(B, pts, 0.0022, 3, 0);
  }
  torus(B, rc, 0.0025, 0, Math.PI * 2, 10, 3);
}
const CAGE_PTS: number[] = [];

function highbay(f: Fixture, md: number): void {
  const r = f.shape === 1 ? f.w / 2 : Math.sqrt(emissiveArea(f) / Math.PI);
  // emissive disk (radius r) just inside the reflector rim
  lens(Mat.PLASTIC);
  disk(B, r, 24, 0.001, false, 0);
  // bell reflector: inner surface (bright aluminium), rim lip, outer shell
  housing(0.55, 0.55, 0.53, 0.2);
  const topR = Math.max(0.1, r * 0.45), bellH = Math.max(0.3, r * 1.4);
  lathe(B, [topR * 0.85, bellH * 0.92, r, 0.0, r + 0.014, 0.0, topR + 0.02, bellH, topR, bellH + 0.03], 16, 0, 25, 0);
  disk(B, topR * 0.85, 16, bellH * 0.92, false, 0); // reflector apex (seen from below)
  // driver housing + hook
  housing(0.2, 0.2, 0.21, 0.4);
  cylinder(B, topR, topR * 0.95, bellH + 0.03, bellH + 0.16, 12, 2);
  // drop rod to the joist
  const rodTop = Math.max(md, bellH + 0.25);
  housing(0.3, 0.3, 0.3, 0.4);
  B.wire(0.01);
  cylinder(B, 0.01, 0.01, bellH + 0.16, rodTop, 6, 0);
  housing(0.3, 0.3, 0.3, 0.4);
  B.push();
  B.translate(0, bellH + 0.19, 0);
  B.rotX(Math.PI / 2);
  torus(B, 0.022, 0.005, 0, Math.PI * 2, 8, 3);
  B.pop();
}

function pendantLinear(f: Fixture, md: number): void {
  const hx = (f.shape === 0 ? f.w : Math.sqrt(emissiveArea(f) * 6)) / 2;
  const hz = emissiveArea(f) / (4 * hx);
  lens(Mat.PANEL_LENS);
  dropLens(hx, hz);
  // extruded aluminium body with end caps. Its bottom is only a frame around the lens: a full bottom face just
  // above the lens z-fights with it beyond ~30 m (24-bit depth, near 0.05), breaking distant lenses into steps.
  housing(0.5, 0.5, 0.49, 0.25);
  const fx = hx + 0.012, fz = hz + 0.018;
  bevelBox(B, -fx, 0, -fz, fx, 0.075, fz, 0.01, SKIP.NY);
  for (const s of [-1, 1]) {
    rect(B, 0, 0, s * (hz + fz) / 2, fx, 0, 0, 0, 0, (fz - hz) / 2, 0, -1, 0);
    rect(B, s * (hx + fx) / 2, 0, 0, (fx - hx) / 2, 0, 0, 0, 0, hz, 0, -1, 0);
  }
  housing(0.08, 0.08, 0.085, 0.4);
  for (const s of [-1, 1]) box(B, s > 0 ? hx + 0.012 : -hx - 0.02, 0.005, -hz - 0.012, s > 0 ? hx + 0.02 : -hx - 0.012, 0.07, hz + 0.012, 0);
  // aircraft cables + ceiling canopies
  const top = Math.max(md, 0.2);
  for (const s of [-1, 1]) {
    B.push();
    B.translate(s * Math.max(0.05, hx - 0.12), 0, 0);
    housing(0.35, 0.35, 0.35, 0.3);
    B.wire(0.0025);
    cylinder(B, 0.0025, 0.0025, 0.075, top - 0.012, 4, 0);
    housing(0.5, 0.5, 0.49, 0.3);
    cylinder(B, 0.03, 0.03, top - 0.012, top, 10, 1);
    B.pop();
  }
}

/** Emissive drop diffuser of half extents (hx, hz) hanging DROP_LENS_H below y = 0: bottom face plus sides whose
 * lower vertices face down, so the vertex shaders can deepen it to 1 px on screen (a distant lens seen edge-on
 * would otherwise cover under a pixel and break up). */
function dropLens(hx: number, hz: number): void {
  B.dropLens();
  const h = -DROP_LENS_H;
  rect(B, 0, h, 0, hx, 0, 0, 0, 0, hz, 0, -1, 0);
  // sides: top edge at the housing (normal outward), bottom edge on the lens face (normal down)
  const side = (x0: number, z0: number, x1: number, z1: number, nx: number, nz: number): void => {
    const u1 = Math.hypot(x1 - x0, z1 - z0);
    B.quad(B.v(x0, 0, z0, nx, 0, nz, 0, 0), B.v(x1, 0, z1, nx, 0, nz, u1, 0), B.v(x1, h, z1, 0, -1, 0, u1, h), B.v(x0, h, z0, 0, -1, 0, 0, h));
  };
  side(-hx, -hz, hx, -hz, 0, -1);
  side(-hx, hz, hx, hz, 0, 1);
  side(-hx, -hz, -hx, hz, -1, 0);
  side(hx, -hz, hx, hz, 1, 0);
}

function sodium(f: Fixture, md: number): void {
  const A = emissiveArea(f);
  const hx = f.shape === 0 ? f.w / 2 : Math.sqrt(A) / 2;
  const hz = A / (4 * hx);
  // drop lens: a shallow box whose bottom face (and sides) glow orange
  lens(Mat.PLASTIC);
  rect(B, 0, 0, 0, hx, 0, 0, 0, 0, hz, 0, -1, 0);
  const dl = 0.035;
  rect(B, 0, dl / 2, -hz, hx, 0, 0, 0, dl / 2, 0, 0, 0, -1);
  rect(B, 0, dl / 2, hz, hx, 0, 0, 0, dl / 2, 0, 0, 0, 1);
  rect(B, -hx, dl / 2, 0, 0, 0, hz, 0, dl / 2, 0, -1, 0, 0);
  rect(B, hx, dl / 2, 0, 0, 0, hz, 0, dl / 2, 0, 1, 0, 0);
  // cast housing
  housing(0.12, 0.1, 0.08, 0.5);
  bevelBox(B, -hx - 0.04, dl, -hz - 0.04, hx + 0.06, dl + 0.14, hz + 0.04, 0.02);
  // fins
  for (let k = -2; k <= 2; k++) box(B, -hx + (k + 2) * (2 * hx) / 5 - 0.004, dl + 0.14, -hz - 0.02, -hx + (k + 2) * (2 * hx) / 5 + 0.004, dl + 0.17, hz + 0.02, SKIP.NY);
  const top = dl + 0.17;
  if (md - top > 0.03) {
    housing(0.2, 0.2, 0.2, 0.45);
    cylinder(B, 0.016, 0.016, top, md - 0.02, 6, 0);
    cylinder(B, 0.05, 0.05, md - 0.02, md, 8, 1);
  }
}

/** World-space vectors of the current fixture frame (set by emitFixtureInto). */
const FR = { X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1], n: [0, -1, 0] };

function exitSign(f: Fixture, md: number): void {
  const hx = f.w / 2, hz = (f.shape === 0 ? f.h : emissiveArea(f) / f.w) / 2;
  const depth = Math.max(0.045, Math.min(0.08, md > 0 ? md : 0.05));
  // housing box behind the face
  B.mat(Mat.PLASTIC, 0.5, 0.49, 0.45);
  bevelBox(B, -hx - 0.018, 0, -hz - 0.018, hx + 0.018, depth, hz + 0.018, 0.008, SKIP.PY);
  // Atlas slot orientation: glyph up (+v) along whichever in-plane axis (+-X = t, +-Z = h) points most upward
  // (Z when the sign faces straight up / down), +u along the viewer's right = up x n (the viewer looks along -n).
  const xUp = FR.X[1], zUp = FR.Z[1];
  const vAlongX = Math.abs(xUp) > Math.abs(zUp) + 0.1;
  const upS = (vAlongX ? xUp : zUp) < 0 ? -1 : 1;
  const ux = (vAlongX ? FR.X[0] : FR.Z[0]) * upS, uy = (vAlongX ? FR.X[1] : FR.Z[1]) * upS, uz = (vAlongX ? FR.X[2] : FR.Z[2]) * upS;
  const rx = uy * FR.n[2] - uz * FR.n[1], ry = uz * FR.n[0] - ux * FR.n[2], rz = ux * FR.n[1] - uy * FR.n[0];
  const rAxis = vAlongX ? FR.Z : FR.X;
  const rS = rAxis[0] * rx + rAxis[1] * ry + rAxis[2] * rz >= 0 ? 1 : -1;
  lens(Mat.SIGNAGE);
  B.rawUv();
  if (vAlongX) rect(B, 0, -0.0015, 0, 0, 0, rS * hz, upS * hx, 0, 0, 0, -1, 0, signSlot(SignKind.EXIT));
  else rect(B, 0, -0.0015, 0, rS * hx, 0, 0, 0, 0, upS * hz, 0, -1, 0, signSlot(SignKind.EXIT));
}

function underwater(f: Fixture): void {
  const r = f.shape === 1 ? f.w / 2 : Math.sqrt(emissiveArea(f) / Math.PI);
  lens(Mat.PLASTIC);
  disk(B, r, 24, -0.003, false, 0);
  // stainless bezel ring flush with the wall + lip
  housing(0.55, 0.55, 0.54, 0.15);
  annulus(B, r, r + 0.035, 24, -0.004, false);
  cylinder(B, r + 0.035, r + 0.035, -0.004, 0.0, 24, 0);
}

/** Product colours of the vending rows (linear albedo: cans, crisp packets, bottles). */
const PRODUCTS: readonly (readonly [number, number, number])[] = [
  [0.5, 0.03, 0.02], [0.03, 0.08, 0.35], [0.55, 0.4, 0.02], [0.03, 0.25, 0.05], [0.5, 0.5, 0.48],
  [0.02, 0.02, 0.02], [0.45, 0.12, 0.02], [0.25, 0.03, 0.2],
];

function vending(f: Fixture): void {
  const hx = (f.shape === 0 ? f.w : Math.sqrt(emissiveArea(f) / 2)) / 2;
  const hz = emissiveArea(f) / (4 * hx);
  // The fixture point is on (or just in front of) the machine's front; the lit panel sits 3.2 cm further in, inside
  // the VENDING_MACHINE window recess (in front of its dark glass, behind the door frame).
  const back = 0.032;
  const up = FR.Z[1] < 0 ? -1 : 1; // h axis direction that points up (products stand on their shelves)
  if (st.emit > 0) lens(Mat.PLASTIC);
  else B.mat(Mat.PLASTIC, 0.02, 0.022, 0.025, VFlag.NO_GRIME, 0.1); // dead machine: dark glass
  rect(B, 0, back, 0, hx, 0, 0, 0, 0, hz, 0, -1, 0);
  // 5 rows: a chrome shelf lip and 6 products standing on it, silhouetted against the backlit panel
  const rows = 5, perRow = 6, rowH = (2 * hz) / rows, slot = (2 * hx) / perRow;
  const Zr = (a: number, b2: number): [number, number] => (up > 0 ? [a, b2] : [-b2, -a]);
  for (let r = 0; r < rows; r++) {
    const base = -hz + r * rowH + 0.02;
    B.mat(Mat.METAL_PAINTED, 0.5, 0.5, 0.49, 0, 0.25);
    let [z0, z1] = Zr(base - 0.012, base);
    box(B, -hx, back - 0.02, z0, hx, back - 0.001, z1, SKIP.PY);
    for (let k = 0; k < perRow; k++) {
      const c = PRODUCTS[Math.floor(rnd(f.seed, 100 + r * perRow + k) * PRODUCTS.length)];
      const j = 0.85 + 0.3 * rnd(f.seed, r * perRow + k);
      B.mat(Mat.PLASTIC, c[0] * j, c[1] * j, c[2] * j, 0, 0.3);
      const x = -hx + (k + 0.5) * slot;
      const pw = slot * (r & 1 ? 0.62 : 0.5), ph = rowH * (r & 1 ? 0.5 : 0.62);
      [z0, z1] = Zr(base, base + ph);
      box(B, x - pw / 2, back - 0.016, z0, x + pw / 2, back - 0.003, z1, SKIP.PY);
    }
  }
}

function redBulb(f: Fixture, md: number): void {
  if (f.shape === 0) {
    // small dome / courtesy light: rect lens + housing
    const hx = f.w / 2, hz = f.h / 2;
    lens(Mat.PLASTIC);
    rect(B, 0, -0.001, 0, hx, 0, 0, 0, 0, hz, 0, -1, 0);
    B.mat(Mat.PLASTIC, 0.05, 0.05, 0.05, 0, 0.4);
    bevelBox(B, -hx - 0.01, 0, -hz - 0.01, hx + 0.01, 0.025, hz + 0.01, 0.006);
    return;
  }
  const r = f.w / 2;
  lens(Mat.PLASTIC);
  sphere(B, r, 12, 7);
  // bakelite socket + cord to the ceiling
  B.mat(Mat.PLASTIC, 0.03, 0.03, 0.03, 0, 0.35);
  cylinder(B, r * 0.45, r * 0.5, r * 0.8, r + 0.06, 8, 2);
  const top = Math.max(md, r + 0.1);
  cylinder(B, 0.03, 0.03, top - 0.015, top, 8, 1);
  B.wire(0.004);
  cylinder(B, 0.004, 0.004, r + 0.06, top - 0.015, 4, 0);
}

// ------------------------------------------------------------------------------------------ entry

/** Emit fixture `f` (chunk-local) into `w` with tile origin (ox, oz). `ceilY` = storey-relative ceiling height
 * above the fixture (NaN if unknown); auxBits / ceilByte as for props (PROP_AUX). Recessed kinds: nothing (0). */
export function emitFixtureInto(w: GeometryWriter, f: Fixture, ox: number, oz: number, ceilY: number, auxBits: number, ceilByte: number): number {
  if (isRecessedFixture(f.kind)) return 0; // shell geometry (WP5)
  cur = f;
  fixtureEmitState(f, st);
  // frame
  let nx = f.nx, ny = f.ny, nz = f.nz;
  let l = Math.hypot(nx, ny, nz);
  if (!(l > 1e-6)) { nx = 0; ny = -1; nz = 0; l = 1; }
  nx /= l; ny /= l; nz /= l;
  let tx = f.tx, ty = f.ty, tz = f.tz;
  let k = tx * nx + ty * ny + tz * nz;
  tx -= k * nx; ty -= k * ny; tz -= k * nz;
  l = Math.hypot(tx, ty, tz);
  if (!(l > 1e-6)) {
    tx = Math.abs(nx) < 0.9 ? 1 : 0; ty = 0; tz = Math.abs(nx) < 0.9 ? 0 : 1;
    k = tx * nx + ty * ny + tz * nz;
    tx -= k * nx; ty -= k * ny; tz -= k * nz;
    l = Math.hypot(tx, ty, tz);
  }
  tx /= l; ty /= l; tz /= l;
  const Yx = -nx, Yy = -ny, Yz = -nz;
  const Zx = ty * Yz - tz * Yy, Zy = tz * Yx - tx * Yz, Zz = tx * Yy - ty * Yx; // Z = X x Y
  FR.X[0] = tx; FR.X[1] = ty; FR.X[2] = tz;
  FR.Y[0] = Yx; FR.Y[1] = Yy; FR.Y[2] = Yz;
  FR.Z[0] = Zx; FR.Z[1] = Zy; FR.Z[2] = Zz;
  FR.n[0] = nx; FR.n[1] = ny; FR.n[2] = nz;
  // mount distance along +Y
  let md = MOUNT_DEFAULT[f.kind] ?? 0.1;
  const maxM = MOUNT_MAX[f.kind] ?? 0;
  if (ny < -0.7 && Number.isFinite(ceilY)) {
    const d = ceilY - f.py;
    if (f.kind === FixtureKind.HIGHBAY) {
      const dj = d - 0.6; // the joist under the deck
      if (dj > 0.3 && dj <= maxM) md = dj;
      else if (d >= 0 && d <= 0.9) md = d; // hung close under the ceiling: no joist clearance, rod to the ceiling
    } else if (d >= 0 && d <= maxM) md = d;
  }
  w.setTransform(0, 1, -ox, 0, -oz);
  B.begin(w, false, auxBits, ceilByte, f.seed);
  B.translate(f.px, f.py, f.pz);
  B.basis(tx, ty, tz, Yx, Yy, Yz, Zx, Zy, Zz);
  switch (f.kind) {
    case FixtureKind.TUBE_STRIP: tubeStrip(f, md); break;
    case FixtureKind.CAGE_BULB: cageBulb(f, md); break;
    case FixtureKind.HIGHBAY: highbay(f, md); break;
    case FixtureKind.PENDANT_LINEAR: pendantLinear(f, md); break;
    case FixtureKind.SODIUM: sodium(f, md); break;
    case FixtureKind.EXIT_SIGN: exitSign(f, md); break;
    case FixtureKind.UNDERWATER: underwater(f); break;
    case FixtureKind.VENDING: vending(f); break;
    case FixtureKind.RED_BULB: redBulb(f, md); break;
    default: break;
  }
  w.resetTransform();
  return B.tris;
}
