// src/core/emitterProfile.ts — graphics-realism C.2/C.3: luminaire and prop-emitter profiles. Pure module shared by
// the mesher (recessed lens aux, mesh/ceilings.ts), the prop builder (props/fixtures.ts) and the surface shaders
// (materials/chunks/emitters.ts generates EMITTER_GLSL from the constants and the EP_NORM table here).
// emitterShape() is the TS twin of the GLSL brEmitterShape: the same maths, line for line (tests: nadir means,
// angular integral, aux round-trip).
//
// Vertex contract (non-FLOOR_AUX faces; documented at VFlag.PROP_AUX in core/ids.ts):
//   aux.z bits 1-4 = profile (EP), bits 5-7 = variant; bit 0 stays the props tower flag.
//   aux.x = profile parameter: recessed lenses A = (U-1) | (V-1)<<3 | axis<<6 (lens size in 0.6 m ceiling tiles;
//   axis 1 = lamps along v); TUBE / DROP / SODIUM: emitter length in cm.
//   tint.a = fixture seed & 255 on every emitter (recessed lenses: in every state, OFF included).
// Variants: recessed bits 5-6 = lamp count - 2, bit 7 = aged (yellowed) lens; TUBE = tube index; BULB 1 = clear glass.
// Every profile is normalised so that its mean over the emitter seen from the nadir is 1 (the baked flux stays
// calibrated: emit x area = the fixture flux the lightmaps were built with); the angular profiles change the look,
// not the bake.

import { FixtureKind, LightState, Zone } from './ids.ts';

/** Emitter profile codes (aux.z bits 1-4). LEGACY = the old uniform / texture-mask emission. */
export const EP = { LEGACY: 0, PRISM: 1, LOUVER: 2, OPAL: 3, DROP: 4, TUBE: 5, BULB: 6, HIGHBAY: 7, SODIUM: 8 } as const;
export type EpId = (typeof EP)[keyof typeof EP];
export const EP_NAMES: readonly string[] = ['LEGACY', 'PRISM', 'LOUVER', 'OPAL', 'DROP', 'TUBE', 'BULB', 'HIGHBAY', 'SODIUM'];

/** Share of troffers built as 90s parabolic louvers (the rest are prismatic lenses), per zone id. */
export const LOUVER_P: readonly number[] = zoneTable({ [Zone.OFFICE]: 0.85 }, 0);
/** Share of recessed lenses with a yellowed (aged) acrylic, per zone id. */
export const AGED_P: readonly number[] = zoneTable({
  [Zone.MANILA]: 0.6, [Zone.DARK]: 0.5, [Zone.MAZE]: 0.45, [Zone.LOBBY]: 0.3, [Zone.LOW_EXPANSE]: 0.3,
  [Zone.OFFICE]: 0.1, [Zone.POOLROOMS]: 0,
}, 0.25);
function zoneTable(v: Readonly<Record<number, number>>, dflt: number): number[] {
  const out: number[] = [];
  for (let z = 0; z < 12; z++) out.push(v[z] ?? dflt);
  return out;
}

/** Ceiling tile (m): recessed lens uv runs 0..U, 0..V in these units. */
export const LENS_TILE = 0.6;

/** Prismatic (A12) troffer lens: T8 lamps D above a lens of 4 mm pyramids; a facet tilted across the lamps shows
 * the lamp plane shifted by D * KAPPA (acrylic 45 deg facets). */
export const PRISM = {
  D: 0.065, KAPPA: 0.45, PITCH: 0.004,
  SIGMA: 0.011, // lamp image half width (T8, 26 mm) before the pixel footprint
  FACET_S: 0.012, // angular spread of a facet (rounded tips, lamp size): blurs each facet image
  END_S: 0.025, // along-tilted facets smear the lamp ends by about +-D KAPPA
  CLEAR: 0.1, // lamps sit in the lens width minus this (reflector returns)
  BG: 0.38, BG_FALL: 0.3, // white reflector seen between the lamps, darker toward the sides
  BAND: 0.95, // lamp image gain
  END_IN: 0.04, // lamp holders: the lamp glow stops this far inside the lens ends
  CAV: 0.62, CAV_W: 0.05, // housing walls shade the lens rim
  // footprint / PITCH over which the facet sparkle fades into the 4-image mean. It is gone before a facet cell
  // shrinks to 4 px: the 4 mm lattice beats with the pixel grid (moire arcs that crawl as the camera moves) well
  // before its 2 px Nyquist limit, and ultra's 1.5x supersampled buffer is resampled to the screen, so a period of
  // 3 buffer px is already 2 screen px there.
  FAR0: 0.07, FAR1: 0.25,
} as const;
/** Pixel footprint (m) at which the EP_NORM recipe integrates the lens: far field (4 mm facets fully averaged). */
const NORM_FP = 0.0144;
/** Parabolic louver (18-cell 2x4 / 9-cell 2x2): specular aluminium cells H deep, lamps D above the cells. */
export const LOUVER = {
  CELL: 0.2, H: 0.075, D: 0.11, BLADE_T: 0.003,
  REFL: 0.3, LAMP: 1.6, // reflector and lamp images seen straight through a cell
  BLADE: 0.5, BLADE_MIN: 0.015, BLADE_V0: 0.35, BLADE_V1: 0.8, // parabolic blades: lamp images inside the cutoff
  GLINT: 0.5, GLINT_W: 0.006, // top-edge glints past the cutoff (m of blade height; widened by the footprint)
  EDGE: 0.85, // blade bottom edges
  SIGMA: 0.012,
} as const;
/** Opal (sky panel) diffuser: slightly hot centre, faint LED grid, rim shade, mild angular falloff. */
export const OPAL = { HOT: 0.06, DOT: 0.03, DOT_PITCH: 0.075, CAV: 0.7, CAV_W: 0.035, ANG: 0.14 } as const;
/** Per-lamp variation of multi-lamp luminaires (gains renormalised to mean 1). */
export const LAMP = {
  GAIN0: 0.88, GAIN_VAR: 0.2, DEAD_P: 0.06, DEAD: 0.03, CAST: 0.035,
  EB: 0.7, EB_W: 0.05, // end blackening: depth EB * u^2, e-folding length EB_W
  GLOW_W: 0.06, GLOW_DYING: 1.3, GLOW_FLICKER: 0.07, // cathode glow at the lamp ends
  BAD_GAIN: 0.35, // a DYING fixture's bad lamp runs at this share of the shimmer-driven gain
  SHADOW: 0.5, // a dead / weak lamp blocks this share of the reflector glow behind it
} as const;
export const AGED_TINT = [1.0, 0.95, 0.82] as const;
export const CATHODE_TINT = [1.0, 0.62, 0.5] as const;
/** Bare T8 tube (TUBE_STRIP): limb brightening, phosphor noise, electrode caps, end blackening, DYING striations. */
export const TUBE = {
  LIMB: 0.08, NOISE: 0.025, NOISE_CELL: 0.04, CAP: 0.022, CAP_L: 0.03, EB_W: 0.025,
  STRIA: 0.35, STRIA_L: 0.085, STRIA_V: 0.6, GLOW: 1.2, GLOW_W: 0.03,
} as const;
/** Bulbs: frosted (hot centre) or clear (filament core in dim glass). */
export const BULB = { FROST: 0.8, CLEAR0: 0.12, CLEAR1: 17.2, CLEAR_S: 0.16 } as const;
/** Metal-halide highbay seen through its open reflector: arc lamp LAMP_H (in disk radii) above the disk, reflector
 * ring near the rim. */
export const HIGHBAY = { BASE: 0.45, CORE: 3.2, CORE_S: 0.18, LAMP_H: 0.55, RING: 0.5, RING_R: 0.88, RING_S: 0.06 } as const;
/** Opal drop diffuser of a linear pendant: brighter along the centre line, ends shaded. */
export const DROP = { CENTRE: 0.28, END_W: 0.03, ANG: 0.1 } as const;
/** Sodium refractor: the arc tube smeared into a bright band by the prismatic glass. */
export const SODIUM = { BASE: 0.35, ARC: 2.4, SIGMA: 0.16, END0: 0.25, END1: 0.4 } as const;

// ------------------------------------------------------------------------------------------ aux packing

/** Recessed-lens profile parameter A = (U-1) | (V-1)<<3 | axis<<6 (U, V in 1..8 ceiling tiles). */
export const lensParam = (U: number, V: number, axis: 0 | 1): number =>
  (clampI(U, 1, 8) - 1) | ((clampI(V, 1, 8) - 1) << 3) | (axis << 6);
/** aux.z of an emitter: profile bits 1-4, variant bits 5-7, keeping bit 0 (props tower flag). */
export const profileBits = (ep: number, variant: number, keep = 0): number => ((keep & 1) | ((ep & 15) << 1) | ((variant & 7) << 5)) & 255;
/** Unpack aux.z: [ep, variant]. */
export const unpackProfile = (z: number): [number, number] => [(z >> 1) & 15, (z >> 5) & 7];
/** Unpack a recessed-lens parameter: [U, V, axis]. */
export const unpackLensParam = (A: number): [number, number, 0 | 1] => [(A & 7) + 1, ((A >> 3) & 7) + 1, ((A >> 6) & 1) as 0 | 1];
/** Recessed variant: lamp count n (2..4) and aged lens. */
export const lensVariant = (n: number, aged: boolean): number => ((clampI(n, 2, 4) - 2) | (aged ? 4 : 0)) & 7;
function clampI(v: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, Math.round(v))); }

export interface LensProfile { ep: number; variant: number; A: number; n: number; aged: boolean }
/** Profile of a recessed lens of U x V ceiling tiles (axis 1: lamps / long side along v) in `zone`. The choices hash
 * the fixture seed only, so a fixture keeps its look across re-bakes and storeys. */
export function recessedProfile(kind: number, U: number, V: number, axis: 0 | 1, seed: number, zone: number): LensProfile {
  const A = lensParam(U, V, axis);
  const aged = hashU(seed, 13) < (AGED_P[zone] ?? 0);
  if (kind === FixtureKind.SKY_PANEL) return { ep: EP.OPAL, variant: lensVariant(2, false), A, n: 2, aged: false };
  const louver = hashU(seed, 11) < (LOUVER_P[zone] ?? 0);
  let n: number;
  if (louver) n = 3;
  else if (kind === FixtureKind.TROFFER_2x2) n = 4; // two U-tubes
  else n = hashU(seed, 12) < 0.6 ? 3 : 2;
  const ep = louver ? EP.LOUVER : EP.PRISM;
  return { ep, variant: lensVariant(n, aged && !louver), A, n, aged: aged && !louver };
}

/** Packed recessed-lens aux: A | profile bits << 16 | state << 24 (aux.y unused). */
export const lensAux = (p: LensProfile, state: number): number =>
  ((p.A & 255) | (profileBits(p.ep, p.variant) << 16) | ((state & 255) << 24)) >>> 0;

// ------------------------------------------------------------------------------------------ hashing (GLSL twins)

/** brPcg (materials/chunks/common.ts) in uint32 arithmetic. */
export function pcg(v: number): number {
  const s = (Math.imul(v >>> 0, 747796405) + 2891336453) >>> 0;
  const w = Math.imul(((s >>> ((s >>> 28) + 4)) ^ s) >>> 0, 277803737) >>> 0;
  return ((w >>> 22) ^ w) >>> 0;
}
const u01 = (h: number): number => (h >>> 8) / 16777216;
/** brEpRand: per-fixture / per-lamp uniform from the 8-bit fixture seed (the only seed the shader sees). */
export const epRand = (seed8: number, k: number): number => u01(pcg(((seed8 & 255) + k * 256 + 12061) >>> 0));
/** Mesher-side hash of the full fixture seed (never used by the shader). */
const hashU = (seed: number, salt: number): number => u01(pcg((pcg(seed >>> 0) ^ Math.imul(salt, 0x9e3779b9)) >>> 0));

// ------------------------------------------------------------------------------------------ shape (TS twin)

export interface ShapeInput {
  ep: number; variant: number; param: number; seed8: number;
  /** Material uv of the fragment (recessed: 0..U x 0..V lens tiles; props: the profile's own uv scheme). */
  u: number; v: number;
  /** View direction toward the camera in the emitter frame (u axis, v axis, normal). Props use vz = n.V only,
   * except HIGHBAY (parallax of the arc lamp). */
  vx: number; vy: number; vz: number;
  /** Pixel footprint in uv units. */
  fp: number;
  t: number; state: number;
  /** Live intensity of the tile's flicker channel (DYN_EMIT) and the lens shimmer (SHIMMER). */
  dyn: number; sh: number; dynEmit: boolean; shimmer: boolean;
}
export const defaultShapeInput = (): ShapeInput => ({
  ep: EP.PRISM, variant: 1, param: lensParam(2, 1, 0), seed8: 0, u: 1, v: 0.5, vx: 0, vy: 0, vz: 1, fp: 1,
  t: 0, state: LightState.ON, dyn: 1, sh: 1, dynEmit: false, shimmer: false,
});

const sat = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
const smoothstep = (a: number, b: number, x: number): number => { const t = sat((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const mix = (a: number, b: number, t: number): number => a + (b - a) * t;
const fract = (x: number): number => x - Math.floor(x);

/** Lamp set of a multi-lamp luminaire: gains (mean 1), colour casts, end blackening, cathode glow per lamp. */
interface Lamps { n: number; uTube: boolean; g: number[]; c: number[]; eb: number[]; glow: number[] }
function lampSet(seed8: number, n: number, uTube: boolean, inp: ShapeInput): Lamps {
  const L: Lamps = { n, uTube, g: [0, 0, 0, 0], c: [0, 0, 0, 0], eb: [0, 0, 0, 0], glow: [0, 0, 0, 0] };
  let sum = 0;
  for (let k = 0; k < n; k++) {
    const id = uTube ? k >> 1 : k;
    let g = LAMP.GAIN0 + LAMP.GAIN_VAR * epRand(seed8, id);
    if (n >= 3 && !uTube && epRand(seed8, id + 8) < LAMP.DEAD_P) g = LAMP.DEAD;
    L.g[k] = g; sum += g;
    L.c[k] = 2 * epRand(seed8, id + 16) - 1;
    const e = epRand(seed8, id + 24);
    L.eb[k] = LAMP.EB * e * e;
  }
  for (let k = 0; k < n; k++) L.g[k] *= n / sum;
  if (inp.shimmer && inp.state === LightState.DYING) {
    // one bad lamp: it follows the shimmer (dips to dark), glows at its cathodes; the others carry the fixture
    const ids = uTube ? n >> 1 : n;
    const bad = (seed8 & 255) % ids;
    const gb = Math.min(Math.max(1 + 3 * (inp.sh - 1), 0), 1.3) * LAMP.BAD_GAIN;
    for (let k = 0; k < n; k++) {
      const id = uTube ? k >> 1 : k;
      if (id === bad) { L.g[k] *= gb; L.glow[k] = LAMP.GLOW_DYING; } else L.g[k] *= (ids - LAMP.BAD_GAIN) / (ids - 1);
    }
  }
  return L;
}

const gauss = (x: number, s: number): number => Math.exp(-0.5 * (x / s) * (x / s));

/** Accumulated lamp images at along-position a for three across offsets (x + s, s in {+dk, -dk, 0}).
 * pitch: lamp spacing across; La: lamp-run length; sig: image half width. Writes [rowP, rowM, row0] (rgb) and, in
 * out[9], the silhouette of weak lamps (sum of (1 - gain) x image); returns the cathode-end mask. */
function lampRows(L: Lamps, a: number, x: number, dk: number, sig: number, La: number, pitch: number, endIn: number,
  endS: number, out: number[]): number {
  for (let i = 0; i < 10; i++) out[i] = 0;
  let endMask = 0;
  const r = 0.5 * pitch; // U-tube bend radius
  const aB = 0.5 * La - endIn - r; // bend centre
  for (let k = 0; k < L.n; k++) {
    const xk = (k + 0.5 - 0.5 * L.n) * pitch;
    // distance from the pin end (U-tubes have pins at -a only)
    const ea = L.uTube ? 0.5 * La - endIn + a : 0.5 * La - endIn - Math.abs(a);
    const endF = smoothstep(-0.01 - endS, 0.03 + endS, ea);
    const eF = endF * (1 - L.eb[k] * Math.exp(-Math.max(ea, 0) / LAMP.EB_W));
    const gl = endF * Math.exp(-Math.max(ea, 0) / LAMP.GLOW_W);
    let gp: number, gm: number, g0: number;
    if (L.uTube && a > aB) {
      if ((k & 1) === 1) continue; // the pair's arc is evaluated once, from its first leg
      const xc = xk + r;
      const d = (s: number): number => Math.abs(Math.hypot(a - aB, x + s - xc) - r);
      gp = gauss(d(dk), sig); gm = gauss(d(-dk), sig); g0 = gauss(d(0), sig);
    } else {
      gp = gauss(x + dk - xk, sig); gm = gauss(x - dk - xk, sig); g0 = gauss(x - xk, sig);
    }
    const w = L.g[k] * eF;
    const cr = 1 + LAMP.CAST * L.c[k], cb = 1 - LAMP.CAST * L.c[k];
    const glw = L.glow[k] * gl;
    const addRow = (o: number, G: number): void => {
      out[o] += G * (w * cr + glw * CATHODE_TINT[0]);
      out[o + 1] += G * (w + glw * CATHODE_TINT[1]);
      out[o + 2] += G * (w * cb + glw * CATHODE_TINT[2]);
    };
    addRow(0, gp); addRow(3, gm); addRow(6, g0);
    endMask += g0 * gl;
    out[9] += Math.max(0, 1 - L.g[k]) * g0 * endF;
  }
  return endMask;
}

/** Recessed-lens frame: lamp-aligned coordinates of the fragment. */
interface LensFrame { a: number; x: number; La: number; Wx: number; va: number; vx: number; vz: number; dEdge: number; pa: number; px: number; n: number; aged: boolean; uTube: boolean }
function lensFrame(inp: ShapeInput): LensFrame {
  const [U, V, axis] = unpackLensParam(inp.param);
  const sx = U * LENS_TILE, sy = V * LENS_TILE;
  const px0 = inp.u * LENS_TILE, py0 = inp.v * LENS_TILE;
  const cx = px0 - 0.5 * sx, cy = py0 - 0.5 * sy;
  const dEdge = Math.min(0.5 * sx - Math.abs(cx), 0.5 * sy - Math.abs(cy));
  const n = Math.min((inp.variant & 3) + 2, 4);
  const along = axis === 0;
  return {
    a: along ? cx : cy, x: along ? cy : cx, La: along ? sx : sy, Wx: along ? sy : sx,
    va: along ? inp.vx : inp.vy, vx: along ? inp.vy : inp.vx, vz: Math.max(inp.vz, 0.02), dEdge,
    pa: along ? px0 : py0, px: along ? py0 : px0, n, aged: (inp.variant & 4) !== 0,
    uTube: n === 4 && U === V,
  };
}

/** Angular luminance of the prismatic lens relative to the nadir (fits A12 data: 1.03 at 45, .76 at 75, .5 at 85 deg). */
export const prismAngular = (vz: number): number => Math.pow(vz, 0.3) * (1 + 0.7 * vz * (1 - vz));

const rowBuf = new Array<number>(10).fill(0);

function prismShape(inp: ShapeInput, out: number[]): void {
  const F = lensFrame(inp);
  const L = lampSet(inp.seed8, F.n, F.uTube, inp);
  const fp = inp.fp * LENS_TILE;
  // lamp plane seen straight through the lens (parallax)
  const ba = F.a - PRISM.D * F.va / F.vz, bx = F.x - PRISM.D * F.vx / F.vz;
  const sig = Math.sqrt(PRISM.SIGMA * PRISM.SIGMA + PRISM.FACET_S * PRISM.FACET_S + fp * fp);
  const pitch = (F.Wx - PRISM.CLEAR) / F.n;
  const dk = PRISM.D * PRISM.KAPPA;
  // area-normalised: the footprint blur spreads the lamp images without adding energy
  const amp = Math.sqrt(PRISM.SIGMA * PRISM.SIGMA + PRISM.FACET_S * PRISM.FACET_S) / sig;
  const endMask = amp * lampRows(L, ba, bx, dk, sig, F.La, pitch, PRISM.END_IN, PRISM.END_S, rowBuf);
  for (let i = 0; i < 9; i++) rowBuf[i] *= amp;
  // pyramid facets tilted across the lamps (|x| > |a| in the cell) show the image shifted by +-dk. Coverage =
  // product of the two half-plane coverages, so it tends to the facet's true share (1/4) as the footprint grows
  const qa = fract(F.pa / PRISM.PITCH) - 0.5, qx = fract(F.px / PRISM.PITCH) - 0.5;
  const fq = Math.max(fp / PRISM.PITCH, 1e-3);
  const hp = (d: number): number => smoothstep(-fq, fq, d * 0.7071);
  const wP = hp(qx - qa) * hp(qx + qa), wM = hp(-qx - qa) * hp(-qx + qa);
  const far = smoothstep(PRISM.FAR0, PRISM.FAR1, fq);
  const xb = Math.max(-1, Math.min(1, bx / (0.5 * F.Wx)));
  let gm = 0;
  for (let k = 0; k < F.n; k++) gm += L.g[k];
  const bg = PRISM.BG * (1 - PRISM.BG_FALL * xb * xb) * (gm / F.n) * (1 - LAMP.SHADOW * Math.min(rowBuf[9], 1));
  const cav = mix(PRISM.CAV, 1, smoothstep(0, PRISM.CAV_W, F.dEdge));
  const ang = prismAngular(F.vz);
  for (let c = 0; c < 3; c++) {
    const lf = wP * rowBuf[c] + wM * rowBuf[3 + c] + (1 - wP - wM) * rowBuf[6 + c];
    const l4 = 0.25 * (rowBuf[c] + rowBuf[3 + c]) + 0.5 * rowBuf[6 + c];
    out[c] = (bg + PRISM.BAND * mix(lf, l4, far)) * cav * ang;
  }
  finishRecessed(inp, F, endMask * cav * ang, EP.PRISM, out);
}

function louverShape(inp: ShapeInput, out: number[]): void {
  const F = lensFrame(inp);
  const L = lampSet(inp.seed8, F.n, false, inp);
  const fp = inp.fp * LENS_TILE + 1e-4;
  const ca = Math.max(1, Math.round(F.La / LOUVER.CELL)), cx = Math.max(1, Math.round(F.Wx / LOUVER.CELL));
  const csa = F.La / ca, csx = F.Wx / cx;
  const pca = fract((F.a + 0.5 * F.La) / csa) * csa, pcx = fract((F.x + 0.5 * F.Wx) / csx) * csx;
  const da = F.va / F.vz, dx = F.vx / F.vz; // lateral shift per metre of height (the ray climbs along -d)
  const ta = pca - LOUVER.H * da, tx = pcx - LOUVER.H * dx;
  const vis = smoothstep(-fp, fp, ta) * smoothstep(-fp, fp, csa - ta) * smoothstep(-fp, fp, tx) * smoothstep(-fp, fp, csx - tx);
  // through the cell: reflector + lamps H + D up, one lamp over each cell column
  const la = F.a - (LOUVER.H + LOUVER.D) * da, lx = F.x - (LOUVER.H + LOUVER.D) * dx;
  const sig = Math.sqrt(LOUVER.SIGMA * LOUVER.SIGMA + fp * fp);
  const amp = LOUVER.SIGMA / sig;
  const endMask = amp * lampRows(L, la, lx, 0, sig, F.La, F.Wx / F.n, PRISM.END_IN, 0, rowBuf);
  for (let i = 0; i < 9; i++) rowBuf[i] *= amp;
  // blade hit height: the first wall the climbing ray reaches
  const wa = -da > 0 ? csa - pca : pca, wx = -dx > 0 ? csx - pcx : pcx;
  const hh = Math.min(wa / Math.max(Math.abs(da), 1e-4), wx / Math.max(Math.abs(dx), 1e-4));
  const spec = smoothstep(LOUVER.BLADE_V0, LOUVER.BLADE_V1, F.vz);
  // the glint band is a sub-pixel line at distance: widen it by the footprint in blade-height units (one pixel spans
  // fp / tan(theta) of height), keeping its energy, so far rows keep a faint striped glow instead of aliasing
  const glw = Math.hypot(LOUVER.GLINT_W, fp / Math.max(Math.hypot(da, dx), 1e-3));
  const gl = (LOUVER.H - hh) / glw;
  const glint = LOUVER.GLINT * (LOUVER.GLINT_W / glw) * Math.exp(-gl * gl) * smoothstep(0.1, 0.3, F.vz) * (1 - spec);
  const blade = LOUVER.BLADE * spec + LOUVER.BLADE_MIN + glint;
  const ea = Math.min(pca, csa - pca), ex = Math.min(pcx, csx - pcx);
  const hw = 0.5 * LOUVER.BLADE_T, cov = sat(LOUVER.BLADE_T / fp);
  const edge = Math.max(cov * (1 - smoothstep(hw, hw + fp, ea)), cov * (1 - smoothstep(hw, hw + fp, ex)));
  let gm = 0;
  for (let k = 0; k < F.n; k++) gm += L.g[k];
  const refl = LOUVER.REFL * (gm / F.n);
  for (let c = 0; c < 3; c++) {
    const lamp = refl + LOUVER.LAMP * rowBuf[6 + c];
    out[c] = mix(blade * (gm / F.n), lamp, vis) * (1 - LOUVER.EDGE * edge);
  }
  finishRecessed(inp, F, endMask * vis, EP.LOUVER, out);
}

function opalShape(inp: ShapeInput, out: number[]): void {
  const F = lensFrame(inp);
  const fp = inp.fp * LENS_TILE;
  const rn = F.a / (0.5 * F.La), rx = F.x / (0.5 * F.Wx);
  const r2 = 0.5 * (rn * rn + rx * rx);
  const px = inp.u * LENS_TILE, py = inp.v * LENS_TILE;
  const dots = OPAL.DOT * Math.cos(2 * Math.PI * px / OPAL.DOT_PITCH) * Math.cos(2 * Math.PI * py / OPAL.DOT_PITCH)
    * (1 - smoothstep(0.25, 0.8, fp / OPAL.DOT_PITCH));
  const l = (1 + OPAL.HOT * (1 - r2)) * (1 + dots) * mix(OPAL.CAV, 1, smoothstep(0, OPAL.CAV_W, F.dEdge)) * (1 - OPAL.ANG + OPAL.ANG * F.vz);
  out[0] = out[1] = out[2] = l;
  finishRecessed(inp, F, 0, EP.OPAL, out);
}

/** Norm, aged tint, flicker and shimmer handling shared by the recessed profiles. */
function finishRecessed(inp: ShapeInput, F: LensFrame, endMask: number, ep: number, out: number[]): void {
  const nrm = epNorm(ep, F.n, F.La, F.Wx);
  for (let c = 0; c < 3; c++) out[c] *= nrm;
  if (F.aged) {
    const w = 0.5 * epRand(inp.seed8, 9);
    for (let c = 0; c < 3; c++) out[c] *= mix(1, AGED_TINT[c], w);
  }
  applyDynamics(inp, endMask * nrm, out);
}

/** Profiles that apply the DYING shimmer per lamp / per tube themselves. */
const perLampDying = (ep: number): boolean => ep === EP.PRISM || ep === EP.LOUVER || ep === EP.TUBE;

/** DYN_EMIT: shape * dyn, plus the pink-orange cathode ends of a tube that is out during a burst. The shimmer scales
 * the whole shape (BUZZ; DYING on single-lamp profiles); multi-lamp DYING is per lamp (lampSet, tubeShape). */
function applyDynamics(inp: ShapeInput, endMask: number, out: number[]): void {
  if (inp.dynEmit) {
    const e = (1 - smoothstep(0.08, 0.4, inp.dyn)) * LAMP.GLOW_FLICKER * endMask;
    for (let c = 0; c < 3; c++) out[c] = out[c] * inp.dyn + e * CATHODE_TINT[c];
  }
  if (inp.shimmer && (inp.state !== LightState.DYING || !perLampDying(inp.ep))) for (let c = 0; c < 3; c++) out[c] *= inp.sh;
}

/** 1D value noise on integer cells (brEpNoise). */
function epNoise(x: number, seed8: number): number {
  const i = Math.floor(x), f = x - i;
  const a = epRand(seed8, 64 + ((i + 4096) & 1023)), b = epRand(seed8, 64 + ((i + 4097) & 1023));
  const w = f * f * (3 - 2 * f);
  return a + (b - a) * w;
}

/** Along-tube mean of the TUBE end treatment (caps + blackening) for length Lm: its reciprocal normalises the tube. */
export function tubeAlongMean(Lm: number, eb: number): number {
  const h = 0.5 * Lm, run = Math.max(h - TUBE.CAP, 1e-3);
  return (TUBE.CAP * TUBE.CAP_L + run - eb * TUBE.EB_W * (1 - Math.exp(-run / TUBE.EB_W))) / h;
}

function tubeShape(inp: ShapeInput, out: number[]): void {
  const Lm = Math.max(inp.param, 10) * 0.01;
  const a = inp.v * Lm, e = 0.5 * Lm - Math.abs(a);
  const mu = Math.abs(inp.vz);
  const r = epRand(inp.seed8, 40 + inp.variant);
  const eb = LAMP.EB * r * r;
  let l = (1 - TUBE.LIMB / 3 + TUBE.LIMB * (1 - mu * mu)) * (1 + TUBE.NOISE * (2 * epNoise(a / TUBE.NOISE_CELL, (inp.seed8 + 37 * inp.variant) & 255) - 1));
  l *= e < TUBE.CAP ? TUBE.CAP_L : 1 - eb * Math.exp(-(e - TUBE.CAP) / TUBE.EB_W);
  l /= tubeAlongMean(Lm, eb);
  let glow = 0;
  const endMask = e < TUBE.CAP ? 0 : Math.exp(-(e - TUBE.CAP) / TUBE.GLOW_W);
  if (inp.shimmer && inp.state === LightState.DYING && ((inp.seed8 & 255) & 1) === (inp.variant & 1)) {
    // the bad tube of the pair: moving striations, dips with the shimmer, orange-pink cathodes
    l *= 1 + TUBE.STRIA * Math.sin(2 * Math.PI * (a / TUBE.STRIA_L - fract(TUBE.STRIA_V * inp.t)) + inp.seed8);
    l *= Math.min(Math.max(1 + 3 * (inp.sh - 1), 0), 1.3);
    glow = TUBE.GLOW * endMask;
  }
  for (let c = 0; c < 3; c++) out[c] = l + glow * CATHODE_TINT[c];
  applyDynamics(inp, endMask, out);
}

function bulbShape(inp: ShapeInput, out: number[]): void {
  const rho2 = sat(1 - inp.vz * inp.vz);
  const l = (inp.variant & 1) !== 0
    ? BULB.CLEAR0 + BULB.CLEAR1 * Math.exp(-rho2 / (2 * BULB.CLEAR_S * BULB.CLEAR_S))
    : (1 + BULB.FROST * Math.pow(1 - rho2, 1.5)) / (1 + BULB.FROST * 0.4);
  out[0] = out[1] = out[2] = l;
  applyDynamics(inp, 0, out);
}

function highbayShape(inp: ShapeInput, out: number[]): void {
  const vz = Math.max(inp.vz, 0.02);
  // the arc lamp sits LAMP_H disk radii above the disk: its image slides away from the viewer and the bell hides it
  const cu = inp.u - HIGHBAY.LAMP_H * inp.vx / vz, cv = inp.v - HIGHBAY.LAMP_H * inp.vy / vz;
  const rc2 = cu * cu + cv * cv;
  const rho = Math.hypot(inp.u, inp.v);
  const core = HIGHBAY.CORE * Math.exp(-rc2 / (2 * HIGHBAY.CORE_S * HIGHBAY.CORE_S));
  const dr = (rho - HIGHBAY.RING_R) / HIGHBAY.RING_S;
  const l = (HIGHBAY.BASE + core + HIGHBAY.RING * Math.exp(-0.5 * dr * dr)) * EP_NORM_SCALAR.HIGHBAY;
  out[0] = out[1] = out[2] = l;
  applyDynamics(inp, 0, out);
}

function dropShape(inp: ShapeInput, out: number[]): void {
  const len = Math.max(inp.param, 10) * 0.01;
  const xn = 2 * inp.v - 1;
  const cc = Math.cos(0.5 * Math.PI * xn);
  const ends = smoothstep(0, DROP.END_W, Math.min(inp.u, 1 - inp.u) * len);
  const nrm = 1 / ((1 + 0.5 * DROP.CENTRE) * (1 - DROP.END_W / len));
  const l = (1 + DROP.CENTRE * cc * cc) * ends * (1 - DROP.ANG + DROP.ANG * Math.max(inp.vz, 0)) * nrm;
  out[0] = out[1] = out[2] = l;
  applyDynamics(inp, 0, out);
}

function sodiumShape(inp: ShapeInput, out: number[]): void {
  const xn = 2 * inp.v - 1, un = Math.abs(inp.u - 0.5);
  const l = (SODIUM.BASE + SODIUM.ARC * gauss(xn, SODIUM.SIGMA) * (1 - smoothstep(SODIUM.END0, SODIUM.END1, un))) * EP_NORM_SCALAR.SODIUM;
  out[0] = out[1] = out[2] = l;
  applyDynamics(inp, 0, out);
}

/** Relative luminance (rgb multiplier of vBrEmit * tint) of profile `inp.ep` at one fragment. */
export function emitterShape(inp: ShapeInput, out: number[] = [0, 0, 0]): number[] {
  switch (inp.ep) {
    case EP.PRISM: prismShape(inp, out); break;
    case EP.LOUVER: louverShape(inp, out); break;
    case EP.OPAL: opalShape(inp, out); break;
    case EP.TUBE: tubeShape(inp, out); break;
    case EP.BULB: bulbShape(inp, out); break;
    case EP.HIGHBAY: highbayShape(inp, out); break;
    case EP.DROP: dropShape(inp, out); break;
    case EP.SODIUM: sodiumShape(inp, out); break;
    default: out[0] = out[1] = out[2] = 1; break;
  }
  return out;
}

/** Dark-cavity factor of an OFF recessed lens (dead tubes behind the lens): multiplies its diffuse colour. */
export function offLensShade(inp: ShapeInput): number {
  const F = lensFrame(inp);
  const bx = F.x - PRISM.D * F.vx / F.vz, ba = F.a - PRISM.D * F.va / F.vz;
  const L: Lamps = { n: F.n, uTube: F.uTube, g: [1, 1, 1, 1], c: [0, 0, 0, 0], eb: [0, 0, 0, 0], glow: [0, 0, 0, 0] };
  const pitch = inp.ep === EP.LOUVER ? F.Wx / F.n : (F.Wx - PRISM.CLEAR) / F.n;
  lampRows(L, ba, bx, 0, 0.018 + inp.fp * LENS_TILE, F.La, pitch, PRISM.END_IN, PRISM.END_S, rowBuf);
  const sh = inp.ep === EP.OPAL ? 0 : Math.min(rowBuf[7], 1);
  return (0.5 + 0.3 * (1 - 0.6 * sh)) * mix(0.75, 1, smoothstep(0, PRISM.CAV_W, F.dEdge));
}

// ------------------------------------------------------------------------------------------ nadir normalisation

/** Recessed profiles with a size table: PRISM and LOUVER x n 2..4 x La 1..4 tiles x Wx 1..4 tiles (0..95), then
 * OPAL x La x Wx (96..111; no lamps). La / Wx: lens length along / across the lamps. */
export const EP_TABLE_PROFILES: readonly number[] = [EP.PRISM, EP.LOUVER, EP.OPAL];
export const EP_NORM_SIZE = 112;
export const epNormIndex = (ep: number, n: number, La: number, Wx: number): number => {
  const li = clampI(La / LENS_TILE, 1, 4) - 1, wi = clampI(Wx / LENS_TILE, 1, 4) - 1;
  if (ep === EP.OPAL) return 96 + li * 4 + wi;
  return (((ep === EP.LOUVER ? 3 : 0) + clampI(n, 2, 4) - 2) * 4 + li) * 4 + wi;
};
export function epNorm(ep: number, n: number, La: number, Wx: number): number {
  return EP_NORM[epNormIndex(ep, n, La, Wx)] ?? 1;
}

/** Lens mean seen from the nadir as the shader shows it (normalised, ~1) by 96 x 48 midpoint integration, the
 * design's EP_NORM recipe: V = nadir, far-field facets (the pyramid mean), lamp gains and end blackening averaged
 * over seeds. U, V: lens size in ceiling tiles (lamps along u). */
export function nadirMean(ep: number, n: number, U: number, V: number): number {
  const inp = defaultShapeInput();
  inp.ep = ep; inp.variant = lensVariant(n, false); inp.param = lensParam(U, V, 0);
  inp.fp = NORM_FP / LENS_TILE; // far field (the lamp images are area-normalised: the mean hardly depends on it)
  const out = [0, 0, 0];
  let s = 0;
  const NU = 96, NV = 48;
  for (let j = 0; j < NV; j++) {
    for (let i = 0; i < NU; i++) {
      inp.u = ((i + 0.5) / NU) * U; inp.v = ((j + 0.5) / NV) * V;
      // seed-independent: average the lamp gains / blackening out over a few seeds
      inp.seed8 = (i * 7 + j * 13) & 255;
      emitterShape(inp, out);
      s += (0.2126 * out[0] + 0.7152 * out[1] + 0.0722 * out[2]);
    }
  }
  return s / (NU * NV);
}
/** Unnormalised nadir mean (1 / its EP_NORM entry). */
export const rawNadirMean = (ep: number, n: number, U: number, V: number): number =>
  nadirMean(ep, n, U, V) / epNorm(ep, n, U * LENS_TILE, V * LENS_TILE);

/** Recompute the EP_NORM table (tests compare it with the literal below; paste the output on a model change). */
export function computeEpNorm(): number[] {
  const out: number[] = [];
  for (const ep of [EP.PRISM, EP.LOUVER]) {
    for (let n = 2; n <= 4; n++) {
      for (let La = 1; La <= 4; La++) for (let Wx = 1; Wx <= 4; Wx++) out.push(1 / rawNadirMean(ep, n, La, Wx));
    }
  }
  for (let La = 1; La <= 4; La++) for (let Wx = 1; Wx <= 4; Wx++) out.push(1 / rawNadirMean(EP.OPAL, 2, La, Wx));
  return out;
}

/** Scalar norms of the prop profiles whose nadir mean is not analytic (tests recompute them). */
export const EP_NORM_SCALAR = { HIGHBAY: 1.2720, SODIUM: 1.5087 };

/** 1 / raw nadir mean per (profile, n, La, Wx): see epNormIndex. Generated by computeEpNorm() (checked by
 * tests/core/emitterProfile.test.ts); computing it at startup would cost ~0.2 s. */
export const EP_NORM: readonly number[] = [
  // PRISM n = 2, 3, 4
  2.3479, 2.6411, 2.7560, 2.8161, 2.2527, 2.5618, 2.6847, 2.7495, 2.2225, 2.5362, 2.6616, 2.7278, 2.2079, 2.5238, 2.6505, 2.7174,
  2.1044, 2.4812, 2.6398, 2.7243, 2.0041, 2.3942, 2.5614, 2.6517, 1.9726, 2.3663, 2.5361, 2.6281, 1.9570, 2.3523, 2.5235, 2.6165,
  1.8175, 2.3344, 2.5259, 2.6328, 1.7988, 2.1839, 2.4399, 2.5534, 1.7663, 2.2092, 2.3714, 2.5276, 1.7505, 2.1943, 2.3986, 2.4828,
  // LOUVER n = 2, 3, 4
  2.3585, 2.7668, 2.9326, 3.0533, 2.2808, 2.7143, 2.8937, 3.0276, 2.2536, 2.6923, 2.8771, 3.0128, 2.2279, 2.6765, 2.8718, 3.0123,
  2.0521, 2.5656, 2.7653, 2.9308, 1.9650, 2.5004, 2.7136, 2.8941, 1.9347, 2.4736, 2.6917, 2.8751, 1.9054, 2.4496, 2.6795, 2.8689,
  1.8508, 2.3642, 2.6606, 2.8194, 1.7590, 2.2875, 2.6002, 2.7730, 1.7282, 2.2582, 2.5769, 2.7515, 1.6964, 2.2320, 2.5620, 2.7414,
  // OPAL
  0.9945, 0.9865, 0.9834, 0.9806, 0.9863, 0.9781, 0.9750, 0.9721, 0.9836, 0.9753, 0.9722, 0.9693, 0.9823, 0.9741, 0.9710, 0.9680,
];
