// src/materials/dev/fakeTextures.ts — WP9 dev harness only: a CPU-generated stand-in TextureSet with enough
// structure (tiles, grout, pile, prisms, decal atlas slots, grime channels, water normals, cookie) to judge the
// WP9 shaders while WP8's GPU generator is being built. Not used by the game.

import * as THREE from 'three';
import { MAT_COUNT, Mat } from '../../core/ids.ts';
import { LAYER_DEFS, layerRepeatY } from '../../core/materials.ts';
import type { TextureSet } from '../../core/runtime.ts';

// ---------------------------------------------------------------- tiny periodic noise
function mulberry32(a: number): () => number {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
class PNoise {
  private readonly t: Float32Array;
  readonly px: number;
  readonly py: number;
  constructor(px: number, py: number, seed: number) {
    this.px = px;
    this.py = py;
    const r = mulberry32(seed);
    this.t = new Float32Array(px * py);
    for (let i = 0; i < this.t.length; i++) this.t[i] = r();
  }
  /** x, y in lattice units; the lattice repeats every `per` cells (so uv*per tiles over [0,1)) */
  at(x: number, y: number, per: number, perY = per): number {
    const xi = Math.floor(x), yi = Math.floor(y);
    let fx = x - xi, fy = y - yi;
    fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
    const w = (i: number, p: number, n: number): number => (((i % p) + p) % p) % n;
    const x0 = w(xi, per, this.px), y0 = w(yi, perY, this.py);
    const x1 = w(xi + 1, per, this.px), y1 = w(yi + 1, perY, this.py);
    const a = this.t[y0 * this.px + x0], b = this.t[y0 * this.px + x1];
    const c = this.t[y1 * this.px + x0], d = this.t[y1 * this.px + x1];
    return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
  }
}
/** fbm over [0,1)^2 uv with base period p (integer); octaves double the period */
function fbm(n: PNoise[], u: number, v: number, p: number, oct: number): number {
  let s = 0, a = 0.5, norm = 0, f = p;
  for (let k = 0; k < oct; k++) {
    const nz = n[k % n.length];
    s += a * nz.at(u * f, v * f, f); norm += a; a *= 0.5; f *= 2;
  }
  return s / norm;
}
const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (e0: number, e1: number, x: number): number => { const t = clamp01((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };
const lin2srgb = (c: number): number => Math.round(255 * clamp01(c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055));

interface Surf { r: number; g: number; b: number; a: number; h: number; rough: number; metal: number; ao: number; em: number }

// ---------------------------------------------------------------- recipes (u, v in [0,1) over repeat x repeatY)
const FAKE_OPTS = { isoVct: false };
type Recipe = (u: number, v: number, s: Surf, nz: PNoise[], L: number) => void;

function base(L: number, s: Surf): void {
  const d = LAYER_DEFS[L];
  s.r = d.albedoMean[0]; s.g = d.albedoMean[1]; s.b = d.albedoMean[2]; s.a = 1; s.h = 0.5;
  s.rough = d.roughness; s.metal = d.metal; s.ao = 1; s.em = 0;
}
function tint(s: Surf, k: number): void { s.r *= k; s.g *= k; s.b *= k; }

const RECIPES: Partial<Record<number, Recipe>> = {
  [Mat.WALLPAPER_L0]: (u, v, s, nz) => {
    // two 0.6 m rolls, diamond damask on a 0.3 m lattice, fibre noise, roll-seam ridge
    const roll = u < 0.5 ? 1.02 : 0.98;
    const du = (u * 4) % 1, dv = (v * 4) % 1;
    const dia = Math.abs(du - 0.5) + Math.abs(dv - 0.5);
    const motif = smooth(0.32, 0.36, dia) - smooth(0.4, 0.44, dia);
    const fib = fbm(nz, u, v, 64, 3);
    tint(s, roll * (1 + 0.05 * motif) * (0.94 + 0.12 * fib));
    const seam = Math.min(Math.abs(u - 0.5), u, 1 - u);
    s.h = 0.5 + 0.12 * motif + 0.3 * (1 - smooth(0, 0.004, seam)) + 0.05 * fib;
    s.rough = 0.78 + 0.07 * fib;
  },
  [Mat.CARPET_L0]: (u, v, s, nz) => {
    const pile = fbm(nz, u, v, 256, 2);
    const tuft = fbm(nz, u + 0.31, v + 0.17, 48, 3);
    const mott = fbm(nz, u + 0.7, v + 0.2, 6, 2);
    tint(s, (0.82 + 0.36 * pile) * (0.92 + 0.16 * tuft) * (0.94 + 0.12 * mott));
    s.h = 0.3 + 0.5 * pile * tuft;
    s.rough = 0.95;
  },
  [Mat.CEILING_TILE]: (u, v, s, nz) => {
    const tu = (u * 2) % 1, tv = (v * 2) % 1;
    const edge = Math.min(tu, 1 - tu, tv, 1 - tv) * 0.6; // metres to tile edge
    const grid = edge < 0.012;
    const fis = fbm(nz, u, v, 96, 3);
    const hole = fis > 0.68 ? 0.65 : 1;
    if (grid) { s.r = 0.8; s.g = 0.79; s.b = 0.75; s.rough = 0.45; s.metal = 0.3; s.h = 0.95; }
    else { tint(s, hole * (0.95 + 0.1 * fis)); s.h = 0.5 - (hole < 1 ? 0.25 : 0) + 0.05 * fis; }
    s.ao = grid ? 1 : hole < 1 ? 0.7 : 1;
  },
  [Mat.PANEL_LENS]: (u, v, s, nz) => {
    // uv 0..1 per 0.6 m: prism grid (4 mm), 2 cm frame (mask 0), two tube hot stripes along v
    const pu = (u * 150) % 1, pv = (v * 150) % 1;
    s.h = 0.5 + 0.25 * (1 - Math.abs(pu - 0.5) * 2) * (1 - Math.abs(pv - 0.5) * 2);
    const fr = Math.min(u, 1 - u) * 0.6 < 0.02 || Math.min(v % 1, 1 - (v % 1)) * 0.6 < 0.005;
    const stripe = Math.exp(-(((u - 0.3) / 0.09) ** 2)) + Math.exp(-(((u - 0.7) / 0.09) ** 2));
    s.em = fr ? 0 : clamp01(0.55 + 0.45 * stripe);
    s.rough = 0.3;
    void nz;
  },
  [Mat.DRYWALL]: (u, v, s, nz) => { const st = fbm(nz, u, v, 128, 2); tint(s, 0.95 + 0.1 * st); s.h = 0.4 + 0.3 * st; },
  [Mat.TRIM_PAINT]: (u, v, s, nz) => { const p = fbm(nz, u, v, 64, 2); tint(s, 0.97 + 0.06 * p); s.h = 0.5 + 0.1 * p; s.rough = 0.45 + 0.1 * p; },
  [Mat.VINYL_VCT]: (u, v, s, nz, L) => {
    // 4x4 tiles of 0.3 m, per-tile tint and wax, directional chip streaks (make rotation visible), 1 mm joints
    const tu = u * 4, tv = v * 4;
    const ti = Math.floor(tu), tj = Math.floor(tv);
    const r = mulberry32(ti * 7 + tj * 131 + 1)();
    const fu = tu - ti, fv = tv - tj;
    const joint = Math.min(fu, 1 - fu, fv, 1 - fv) * 0.3 < 0.0012;
    const chips = FAKE_OPTS.isoVct // isotropic chips: the anti-tiling check then measures filtering, not content
      ? 0.6 * nz[0].at(u * 64, v * 64, 64) + 0.4 * nz[1].at(u * 128, v * 128, 128)
      : 0.6 * nz[0].at(u * 40, v * 160, 40, 160) + 0.4 * nz[1].at(u * 80, v * 320, 80, 320); // streaks along u
    const spk = nz[2].at(u * 512, v * 512, 512);
    tint(s, (0.92 + 0.16 * r) * (0.85 + 0.3 * chips) * (spk > 0.8 ? 0.7 : 1));
    if (r > 0.75) { s.r *= 0.85; s.g *= 0.9; }
    s.h = joint ? 0.2 : 0.55 + 0.05 * chips;
    s.rough = joint ? 0.7 : 0.3 + 0.12 * r;
    void L;
  },
  [Mat.CONCRETE_FLOOR]: (u, v, s, nz) => {
    const ag = nz[3].at(u * 300, v * 300, 300);
    const lo = fbm(nz, u, v, 8, 4);
    tint(s, (0.85 + 0.3 * lo) * (ag > 0.75 ? 1.15 : ag < 0.2 ? 0.85 : 1));
    s.h = 0.5 + 0.1 * lo; s.rough = 0.35 + 0.4 * lo;
  },
  [Mat.CMU_PAINTED]: (u, v, s, nz) => {
    const bu = u * 6, bv = v * 5; const row = Math.floor(bv);
    const fu = (bu + (row % 2) * 0.5) % 1, fv = bv % 1;
    const mortar = Math.min(fu, 1 - fu) * 0.4 < 0.005 || Math.min(fv, 1 - fv) * 0.2 < 0.005;
    const p = fbm(nz, u, v, 64, 2);
    tint(s, mortar ? 0.85 : 0.97 + 0.06 * p); s.h = mortar ? 0.2 : 0.6 + 0.1 * p;
  },
  [Mat.POOL_TILE]: (u, v, s, nz) => {
    const tu = u * 8, tv = v * 8; const fu = tu % 1, fv = tv % 1;
    const grout = Math.min(fu, 1 - fu, fv, 1 - fv) * 0.15 < 0.0015;
    const r = mulberry32(Math.floor(tu) * 17 + Math.floor(tv) * 1031 + 5)();
    if (grout) { s.r = 0.35; s.g = 0.42; s.b = 0.42; s.rough = 0.7; s.h = 0.15; }
    else { tint(s, 0.97 + 0.06 * r); s.rough = 0.06 + 0.06 * fbm(nz, u, v, 32, 2); s.h = 0.6 + 0.04 * (r - 0.5); }
  },
  [Mat.POOL_MOSAIC]: (u, v, s, nz) => {
    const tu = u * 24, tv = v * 24; const fu = tu % 1, fv = tv % 1;
    const grout = Math.min(fu, 1 - fu, fv, 1 - fv) * 0.025 < 0.0012;
    const r = mulberry32(Math.floor(tu) * 29 + Math.floor(tv) * 977 + 9)();
    if (grout) { s.r = 0.4; s.g = 0.45; s.b = 0.45; s.rough = 0.7; s.h = 0.2; }
    else { tint(s, 0.85 + 0.3 * r); s.rough = 0.1; s.h = 0.6; }
    void nz;
  },
  [Mat.METAL_PAINTED]: (u, v, s, nz) => { const p = fbm(nz, u, v, 32, 3); tint(s, 0.95 + 0.1 * p); s.rough = 0.4 + 0.1 * p; s.h = 0.5 + 0.05 * p; },
  [Mat.WOOD]: (u, v, s, nz) => {
    const g = Math.sin((v * 40 + 3 * fbm(nz, u, v, 4, 3)) * Math.PI * 2) * 0.5 + 0.5;
    tint(s, 0.8 + 0.4 * g * (0.8 + 0.4 * fbm(nz, u, v, 64, 2))); s.h = 0.5 + 0.05 * g; s.rough = 0.5 + 0.1 * g;
  },
  [Mat.PLASTIC]: (u, v, s, nz) => { tint(s, 0.97 + 0.06 * fbm(nz, u, v, 32, 2)); },
  [Mat.FLOOR_PAINT]: (u, v, s, nz) => { const p = fbm(nz, u, v, 24, 4); s.a = p > 0.42 ? 1 : smooth(0.3, 0.42, p); s.rough = 0.5; },
  [Mat.SIGNAGE]: (u, v, s) => {
    // slot 0 = EXIT: green panel with white glyph bars (emissive mask on the glyphs)
    const su = (u * 4) % 1, sv = (v * 4) % 1; const slot = Math.floor(u * 4) + 4 * Math.floor(v * 4);
    const glyph = slot === 0 && sv > 0.35 && sv < 0.65 && [0.15, 0.3, 0.45, 0.6, 0.75].some((x) => Math.abs(su - x) < 0.04);
    s.r = glyph ? 0.9 : 0.05; s.g = glyph ? 0.9 : 0.35; s.b = glyph ? 0.9 : 0.1; s.em = glyph ? 1 : 0.15; s.a = 1;
  },
  [Mat.DECAL_ATLAS]: (u, v, s, nz) => {
    const slot = Math.floor(u * 4) + 4 * Math.floor(v * 4);
    const su = (u * 4) % 1, sv = (v * 4) % 1;
    const du = su - 0.5, dv = sv - 0.5; const rr = Math.sqrt(du * du + dv * dv) * 2;
    s.a = 0;
    if (slot === 0) { // water stain: feathered blob with a darker tide ring
      const n = fbm(nz, u, v, 16, 3);
      const d = rr + (n - 0.5) * 0.35;
      s.a = (1 - smooth(0.6, 0.9, d)) * 0.55 + (1 - smooth(0.0, 0.05, Math.abs(d - 0.75))) * 0.35;
      s.r = 0.28; s.g = 0.2; s.b = 0.09;
    } else if (slot === 8) { // poster
      const inside = Math.abs(du) < 0.36 && Math.abs(dv) < 0.46;
      s.a = inside ? 1 : 0; const band = sv > 0.55 && sv < 0.75;
      s.r = band ? 0.6 : 0.75; s.g = band ? 0.15 : 0.72; s.b = band ? 0.1 : 0.62;
    } else if (slot === 9) { // chalk arrow pointing +v
      const shaft = Math.abs(du) < 0.05 && sv > 0.15 && sv < 0.7;
      const head = sv >= 0.6 && sv < 0.85 && Math.abs(du) < (0.85 - sv) * 0.9;
      const n = fbm(nz, u, v, 128, 2);
      s.a = (shaft || head) && n > 0.3 ? 1 : 0; s.r = 0.85; s.g = 0.85; s.b = 0.82;
    }
    s.rough = 0.8;
  },
};

// ---------------------------------------------------------------- builders
function arrayTex(data: Uint8Array, size: number, srgb: boolean, aniso: number): THREE.DataArrayTexture {
  const t = new THREE.DataArrayTexture(data, size, size, MAT_COUNT);
  t.format = THREE.RGBAFormat;
  t.type = THREE.UnsignedByteType;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = aniso;
  t.needsUpdate = true;
  return t;
}
function tex2D(data: Uint8Array, size: number, format: THREE.PixelFormat): THREE.DataTexture {
  const t = new THREE.DataTexture(data, size, size, format, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

export function createFakeTextureSet(size: 256 | 512 = 256, anisotropy = 8, opts: { isoVct?: boolean } = {}): TextureSet {
  FAKE_OPTS.isoVct = opts.isoVct === true;
  const S = size;
  const nz = [new PNoise(64, 64, 11), new PNoise(128, 128, 23), new PNoise(512, 512, 37), new PNoise(300, 300, 41)];
  const alb = new Uint8Array(S * S * MAT_COUNT * 4);
  const nrm = new Uint8Array(S * S * MAT_COUNT * 4);
  const orm = new Uint8Array(S * S * MAT_COUNT * 4);
  const h = new Float32Array(S * S);
  const s: Surf = { r: 0, g: 0, b: 0, a: 1, h: 0.5, rough: 1, metal: 0, ao: 1, em: 0 };
  for (let L = 0; L < MAT_COUNT; L++) {
    const rec = RECIPES[L];
    const d = LAYER_DEFS[L];
    // normal strength: height units -> metres over the layer frame
    const hScale = 0.004; // 4 mm full-scale relief
    const mPerTexU = d.repeat / S, mPerTexV = layerRepeatY(d) / S;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        base(L, s);
        if (rec) rec((x + 0.5) / S, (y + 0.5) / S, s, nz, L);
        const i = ((L * S + y) * S + x) * 4;
        alb[i] = lin2srgb(s.r); alb[i + 1] = lin2srgb(s.g); alb[i + 2] = lin2srgb(s.b); alb[i + 3] = Math.round(255 * clamp01(s.a));
        orm[i] = Math.round(255 * clamp01(s.ao)); orm[i + 1] = Math.round(255 * clamp01(s.rough));
        orm[i + 2] = Math.round(255 * clamp01(s.metal)); orm[i + 3] = Math.round(255 * clamp01(s.em));
        h[y * S + x] = s.h;
      }
    }
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const hx = (h[y * S + ((x + 1) % S)] - h[y * S + ((x + S - 1) % S)]) * hScale / (2 * mPerTexU);
        const hy = (h[((y + 1) % S) * S + x] - h[((y + S - 1) % S) * S + x]) * hScale / (2 * mPerTexV);
        let nx = -hx, ny = -hy, nzz = 1;
        const l = Math.hypot(nx, ny, nzz); nx /= l; ny /= l; nzz /= l;
        const i = ((L * S + y) * S + x) * 4;
        nrm[i] = Math.round((nx * 0.5 + 0.5) * 255); nrm[i + 1] = Math.round((ny * 0.5 + 0.5) * 255);
        nrm[i + 2] = Math.round((nzz * 0.5 + 0.5) * 255); nrm[i + 3] = Math.round(255 * clamp01(h[y * S + x]));
      }
    }
  }
  const albedo = arrayTex(alb, S, true, anisotropy);
  const normal = arrayTex(nrm, S, false, anisotropy);
  const ormh = arrayTex(orm, S, false, anisotropy);

  // grime 512^2: r tide rings, g speckle/mould, b scuff, a vertical drip streaks
  const G = 512;
  const gd = new Uint8Array(G * G * 4);
  for (let y = 0; y < G; y++) {
    for (let x = 0; x < G; x++) {
      const u = (x + 0.5) / G, v = (y + 0.5) / G;
      const f = fbm(nz, u, v, 4, 5);
      const ring = 1 - smooth(0, 0.06, Math.abs(((f * 7) % 1) - 0.5) - 0.44);
      const sp = nz[2].at(u * 256, v * 256, 256);
      const sc = fbm(nz, u * 4, v, 16, 3);
      const drip = Math.pow(nz[1].at(u * 90, v * 3, 90, 3), 3) * 1.8;
      const i = (y * G + x) * 4;
      gd[i] = Math.round(255 * clamp01(ring)); gd[i + 1] = Math.round(255 * clamp01(sp * 0.7 + f * 0.3));
      gd[i + 2] = Math.round(255 * clamp01(sc)); gd[i + 3] = Math.round(255 * clamp01(drip));
    }
  }
  const grime = tex2D(gd, G, THREE.RGBAFormat);

  // water normals 256^2 RG: gradient of periodic noise
  const W = 256;
  const wh = new Float32Array(W * W);
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) wh[y * W + x] = fbm(nz, (x + 0.5) / W, (y + 0.5) / W, 8, 4);
  const wd = new Uint8Array(W * W * 4);
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      const gx = (wh[y * W + ((x + 1) % W)] - wh[y * W + ((x + W - 1) % W)]) * 12;
      const gy = (wh[((y + 1) % W) * W + x] - wh[((y + W - 1) % W) * W + x]) * 12;
      const i = (y * W + x) * 4;
      wd[i] = Math.round(255 * clamp01(0.5 - gx * 0.5)); wd[i + 1] = Math.round(255 * clamp01(0.5 - gy * 0.5)); wd[i + 2] = 255; wd[i + 3] = 255;
    }
  }
  const waterNormals = tex2D(wd, W, THREE.RGBAFormat);

  // cookie 256^2: hot centre, soft rings, falloff to 0 at the edge
  const C = 256;
  const cd = new Uint8Array(C * C * 4);
  for (let y = 0; y < C; y++) {
    for (let x = 0; x < C; x++) {
      const dx = (x + 0.5) / C - 0.5, dy = (y + 0.5) / C - 0.5; const r = Math.sqrt(dx * dx + dy * dy) * 2;
      const v = clamp01((1 - smooth(0.6, 1.0, r)) * (0.75 + 0.25 * Math.exp(-r * r * 8) + 0.08 * Math.sin(r * 30)));
      const i = (y * C + x) * 4; cd[i] = cd[i + 1] = cd[i + 2] = Math.round(255 * v); cd[i + 3] = 255;
    }
  }
  const cookie = tex2D(cd, C, THREE.RGBAFormat);
  cookie.wrapS = cookie.wrapT = THREE.ClampToEdgeWrapping;

  return {
    size: 512,
    albedo, normal, ormh, grime, waterNormals, cookie,
    dispose() { albedo.dispose(); normal.dispose(); ormh.dispose(); grime.dispose(); waterNormals.dispose(); cookie.dispose(); },
  };
}
