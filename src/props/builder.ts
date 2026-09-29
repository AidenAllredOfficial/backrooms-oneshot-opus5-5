// src/props/builder.ts — PartBuilder: the single funnel through which every prop, fixture and pipe triangle
// reaches the GeometryWriter (§5 WP6). Private to src/props. Pure module (no three/DOM).
//
// Responsibilities:
// - a part transform stack (full 3x3 rotation + translation) on top of the writer's yaw/scale/translation, so
//   parts can be tilted, and fixtures can be built in their own (t, -n, n x t) frame;
// - PropFlag.CEILING mirroring (y -> -y about the prop base, winding reversed);
// - automatic triangle orientation: every triangle is wound counter-clockwise as seen from the side its vertex
//   normals point to, so primitives only have to supply correct (outward) normals;
// - material state per part: layer, tint (desired linear albedo / layer albedoMean, stored halved on non-emissive
//   parts: tint headroom, below), VFlag.PROP_AUX and aux = (roughnessOverride, wire radius, bits, ceilByte);
//   emissive parts with DYN_EMIT / SHIMMER metadata and an emitter profile (aux.z contract below);
// - UVs in part-local metres / (LAYER_DEFS[layer].repeat, layerRepeatY) (or raw atlas UVs, or a profile's own scale:
//   uvScale), plus a per-part offset on the prop layers (DECORRELATE: sibling slats, doors and panels do not show the
//   same texture region);
// - face-local edge coordinates in the lmUv stream (props light from the light volume, so lmUv is free): see
//   edgeEncode. The primitives write them per face, and in grain mode (GRAIN layers) they turn each face's u along its
//   longer side, so wood grain, brushing and scratches run along rails, slats, beams and door leaves;
//
// aux.z contract (core/ids.ts VFlag.PROP_AUX; graphics-realism C.3): bit 0 = tower (from the prop's auxBits).
// Emissive parts: bits 1-4 = emitter profile (core/emitterProfile.ts EP), bits 5-7 = variant, aux.x = the profile
// parameter. Other parts: bit 1 = clearcoat, bits 2-7 = dust 0-63 (auxBits from props/tileProps.ts), aux.x = the
// roughness override.
// Tint headroom (texture realism v2, lane E): non-emissive parts store byte(tint / 2) and the surface shader decodes
// x2 (chunks/family/props.ts), so a part can be up to twice its layer's mean albedo (white enamel, chrome, light wood
// on a dark layer mean) instead of clamping at the mean; bytes are at least 1 so the decode never divides by zero.
// Emissive parts keep x1 (their tint is the emitter colour).
// - a counting mode (no writer) used by propTris(), which runs the identical code path.

import { profileBits } from '../core/emitterProfile.ts';
import { LAYER_DEFS, layerRepeatY } from '../core/materials.ts';
import { DROP_LENS_AUX, Mat, VFlag } from '../core/ids.ts';
import { packRGBA, type GeometryWriter } from '../core/writer.ts';

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const byte = (v: number): number => Math.round(clamp01(v) * 255);
/** Tint byte of a non-emissive part: tint / 2 (the shader decodes x2), at least 1. */
export const tintByte = (t: number): number => Math.max(1, byte(t / 2));
/** The shader's decode of tintByte (chunks/family/props.ts: vBrTint.rgb x 2). */
export const tintDecode = (b: number): number => (2 * b) / 255;

/** Directional layers: u runs along each face's longer side (wood grain, brushing, rolled-steel scratches). */
export const GRAIN_LAYERS: ReadonlySet<number> = new Set<number>([Mat.WOOD, Mat.METAL_PAINTED, Mat.METAL_BARE]);
/** Layers whose parts get a hashed uv offset (a repeat's worth), so siblings do not share one texture region. */
export const DECORRELATE_LAYERS: ReadonlySet<number> = new Set<number>([
  Mat.METAL_PAINTED, Mat.METAL_RUST, Mat.METAL_BARE, Mat.WOOD, Mat.PLASTIC, Mat.RUBBER,
]);

/**
 * Edge coordinate of one face axis (the lmUv stream of props; decoded by chunks/family/props.ts brPropEdge):
 * 4 round(half mm) + (1 + s), half = the face's half extent along the axis (>= 1 mm), s in [-1, 1] the position across
 * it. Affine over a planar face, so the interpolation is exact; the distance to the face's nearer edge along that axis
 * is half (1 - |s|). 0 = no edge on this axis (curved sides: a tube's circumference). A negative x marks end grain (the
 * face looks along the part's longest axis); a negative y marks part kind 1 (kraft board on PLASTIC).
 */
export function edgeEncode(halfMm: number, s: number): number {
  return 4 * Math.max(1, Math.round(halfMm)) + 1 + Math.max(-1, Math.min(1, s));
}
/** Decode of edgeEncode (the shader's): half-extent (mm), position s and distance to the nearer edge (mm). */
export function edgeDecode(x: number): { halfMm: number; s: number; dMm: number } {
  const a = Math.abs(x);
  const halfMm = Math.floor(a / 4);
  const s = a - 4 * halfMm - 1;
  return { halfMm, s, dMm: halfMm * Math.max(0, 1 - Math.abs(s)) };
}

export class PartBuilder {
  /** Triangles emitted since begin(). */
  tris = 0;
  private w: GeometryWriter | null = null;
  private base = 0;
  private nv = 0;
  private mirror = false;
  // part transform, row-major 3x4: [m00 m01 m02 m03 | m10 m11 m12 m13 | m20 m21 m22 m23]
  private m = new Float64Array(12);
  private stack = new Float64Array(12 * 48);
  private sp = 0;
  // prop-local position + normal of every vertex of the current prop (pre-mirror), for orientation checks
  private lp = new Float64Array(6 * 2048);
  private uvS = 1;
  private uvSv = 1;
  // per-part uv offset (part-local metres; DECORRELATE layers), part counter since begin(), edge-coordinate scale
  private ou = 0;
  private ov = 0;
  private partK = 0;
  private seed = 0;
  private mmPerM = 1000;
  /** The current part's layer is directional (GRAIN_LAYERS): the primitives turn u along each face's longer side. */
  grain = false;
  // part kind 1 (the sign of the edge coordinate y): kraft board on PLASTIC, a shadow / cavity part on METAL_PAINTED
  private alt = false;
  // per-prop constants
  private auxBits = 0;
  private ceilByte = 0;
  private seedByte = 0;
  private jitter = 1;
  private layer = 0;
  // writer state of the current part (re-issued by wire())
  private stFlags = 0;
  private stTint = 0;
  private stEmit = 0;
  private stAux = 0;

  /** Start a prop / fixture / pipe. `w` null => counting mode. `seed` drives tint jitter and the per-part uv offsets
   * only. `scale`: the writer's uniform scale of this prop (edge coordinates are in true millimetres). */
  begin(w: GeometryWriter | null, mirror: boolean, auxBits: number, ceilByte: number, seed: number, scale = 1): void {
    this.w = w;
    this.base = w ? w.vertexCount : 0;
    this.nv = 0;
    this.tris = 0;
    this.mirror = mirror;
    this.partK = 0;
    this.seed = seed | 0;
    this.mmPerM = 1000 * scale;
    this.auxBits = auxBits & 255;
    this.ceilByte = ceilByte & 255;
    this.seedByte = seed & 255;
    // +-5% brightness per instance (hash of the seed; never changes topology)
    const h = Math.imul((seed ^ 0x9e3779b9) >>> 0, 0x85ebca6b) >>> 0;
    this.jitter = 0.95 + 0.1 * ((h >>> 8) / 16777216);
    this.sp = 0;
    this.identity();
    this.mat(0);
  }

  // ------------------------------------------------------------------ materials
  /** Opaque part. (r, g, b) = desired linear albedo (r < 0: the layer's own albedo). `rough` > 0 writes a
   * roughness override into aux.x (0 = none; see docs/contract-changes/WP6.md). `coat`: aux.z bit 1 (clearcoat). */
  mat(layer: number, r = -1, g = -1, b = -1, extraFlags = 0, rough = 0, coat = false): void {
    const d = LAYER_DEFS[layer] ?? LAYER_DEFS[0];
    this.layer = layer;
    this.uvS = 1 / d.repeat;
    this.uvSv = 1 / layerRepeatY(d);
    this.grain = GRAIN_LAYERS.has(layer);
    this.alt = false;
    const k = this.partK++;
    this.ou = DECORRELATE_LAYERS.has(layer) ? Math.floor(rnd(this.seed, 0x5a17 + 2 * k) * 64) / 64 * d.repeat : 0;
    this.ov = DECORRELATE_LAYERS.has(layer) ? Math.floor(rnd(this.seed, 0x5a18 + 2 * k) * 64) / 64 * layerRepeatY(d) : 0;
    const j = this.jitter;
    let tr = j, tg = j, tb = j;
    if (r >= 0) {
      tr = (r / Math.max(d.albedoMean[0], 1e-3)) * j;
      tg = (g / Math.max(d.albedoMean[1], 1e-3)) * j;
      tb = (b / Math.max(d.albedoMean[2], 1e-3)) * j;
    }
    const tint = packRGBA(tintByte(tr), tintByte(tg), tintByte(tb), this.seedByte);
    const bits = (this.auxBits & ~2) | (coat ? 2 : 0);
    const aux = packRGBA(rough > 0 ? Math.max(1, byte(rough)) : 0, 0, bits, this.ceilByte);
    this.state(VFlag.PROP_AUX | extraFlags, tint, 0, aux);
  }

  /** Emissive part: tint = emitter colour (max component 1), `emit` nits. DYN_EMIT/SHIMMER parts store
   * aux.w = state and tint.a = fixture seed & 255 (the shader's shimmer inputs). `ep` / `variant` / `param`: the
   * emitter profile (core/emitterProfile.ts) in aux.z bits 1-4 / 5-7 and aux.x (0-255); only the tower bit of the
   * prop's auxBits is kept (no dust / coat bits on emitters). */
  emissive(layer: number, r: number, g: number, b: number, emit: number, flags: number, state: number, fixtureSeed: number,
    ep = 0, variant = 0, param = 0): void {
    const d = LAYER_DEFS[layer] ?? LAYER_DEFS[0];
    this.layer = layer;
    this.uvS = 1 / d.repeat;
    this.uvSv = 1 / layerRepeatY(d);
    this.grain = false;
    this.alt = false;
    this.ou = this.ov = 0;
    this.partK++; // counted like a mat() part, so the offsets of the parts after it do not depend on the light state
    const dyn = (flags & (VFlag.DYN_EMIT | VFlag.SHIMMER)) !== 0;
    const tint = packRGBA(byte(r), byte(g), byte(b), dyn ? fixtureSeed & 255 : this.seedByte);
    const aux = packRGBA(Math.max(0, Math.min(255, Math.round(param))), 0, profileBits(ep, variant, this.auxBits), dyn ? state & 255 : this.ceilByte);
    this.state(VFlag.PROP_AUX | VFlag.NO_GRIME | flags, tint, emit, aux);
  }

  /** Subsequent UVs are the part-local (u, v) times (su, sv) instead of / the layer repeat, until the next mat() /
   * emissive() (emitter profiles with their own uv scheme, e.g. a tube's v in [-0.5, 0.5] along its length). */
  uvScale(su: number, sv = su): void { this.uvS = su; this.uvSv = sv; this.ou = this.ov = 0; }

  /** The following parts of the current material are thin tubes of radius `r` (m, 0.1 mm steps up to 25.5 mm):
   * cylinder / sweep sides with radial normals and no caps, straight from the builder (no scaled transform). The
   * vertex shaders widen them to at least WIRE_MIN_PX on screen (aux.y < 255, materials/chunks/vertex.ts WIRE_GLSL), so a
   * distant cable stays a continuous line instead of breaking into dashes. Cleared by the next mat() / emissive(). */
  wire(r: number): void {
    this.tag(Math.max(1, Math.min(DROP_LENS_AUX - 1, Math.round(r * 1e4))));
  }

  /** The following parts are a drop lens DROP_LENS_H deep whose down-facing vertices (normal y < -0.5) are the ones
   * to lower: the vertex shaders deepen it to at least 1 px on screen (aux.y = DROP_LENS_AUX). */
  dropLens(): void { this.tag(DROP_LENS_AUX); }

  private tag(auxY: number): void {
    this.state(this.stFlags, this.stTint, this.stEmit, ((this.stAux & ~0xff00) | (auxY << 8)) >>> 0);
  }

  private state(flags: number, tint: number, emit: number, aux: number): void {
    this.stFlags = flags; this.stTint = tint; this.stEmit = emit; this.stAux = aux;
    this.w?.setState(this.layer, flags, tint, emit, aux);
  }

  /** Subsequent UVs are passed through unscaled (atlas slots: SIGNAGE, DECAL_ATLAS). */
  rawUv(): void { this.uvS = this.uvSv = 1; this.ou = this.ov = 0; }
  get currentLayer(): number { return this.layer; }

  /** The following parts of the current material are part kind 1 (edgeEncode's y sign; cleared by the next mat()):
   * kraft board on PLASTIC (flutes, crushed edges, seam), a painted shadow / cavity stand-in on METAL_PAINTED (door
   * gaps, louvre slots: never worn through). */
  altKind(): void { this.alt = true; }

  /** Edge coordinate (edgeEncode) of a face axis with half extent `half` part-local metres, at position s in [-1, 1]
   * across it; `neg` sets the sign flag (x: end grain, y: part kind). */
  ec(half: number, s: number, neg = false): number {
    const e = edgeEncode(half * this.mmPerM, s);
    return neg ? -e : e;
  }

  // ------------------------------------------------------------------ transforms (post-multiplied)
  identity(): void {
    const m = this.m;
    m.fill(0);
    m[0] = 1; m[5] = 1; m[10] = 1;
  }
  push(): void {
    if (this.sp >= 48) throw new Error('PartBuilder: transform stack overflow');
    this.stack.set(this.m, this.sp * 12);
    this.sp++;
  }
  pop(): void {
    this.sp--;
    for (let i = 0; i < 12; i++) this.m[i] = this.stack[this.sp * 12 + i];
  }
  translate(x: number, y: number, z: number): void {
    const m = this.m;
    m[3] += m[0] * x + m[1] * y + m[2] * z;
    m[7] += m[4] * x + m[5] * y + m[6] * z;
    m[11] += m[8] * x + m[9] * y + m[10] * z;
  }
  /** Post-multiply by the rotation whose COLUMNS are the local axes a, b, c (orthonormal, right-handed). */
  basis(ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number): void {
    const m = this.m;
    for (let r = 0; r < 3; r++) {
      const m0 = m[r * 4], m1 = m[r * 4 + 1], m2 = m[r * 4 + 2];
      m[r * 4] = m0 * ax + m1 * ay + m2 * az;
      m[r * 4 + 1] = m0 * bx + m1 * by + m2 * bz;
      m[r * 4 + 2] = m0 * cx + m1 * cy + m2 * cz;
    }
  }
  rotX(a: number): void { const c = Math.cos(a), s = Math.sin(a); this.basis(1, 0, 0, 0, c, s, 0, -s, c); }
  rotY(a: number): void { const c = Math.cos(a), s = Math.sin(a); this.basis(c, 0, -s, 0, 1, 0, s, 0, c); }
  rotZ(a: number): void { const c = Math.cos(a), s = Math.sin(a); this.basis(c, s, 0, -s, c, 0, 0, 0, 1); }
  /** Rotate so that local +Y points along the unit vector (dx, dy, dz). */
  alignY(dx: number, dy: number, dz: number): void {
    // pick a helper axis not parallel to d
    let hx = 1, hy = 0, hz = 0;
    if (Math.abs(dx) > 0.9) { hx = 0; hz = 1; }
    // a = normalize(h x d) ... choose a = normalize(cross(d, h)) as local Z, then X = Y x Z
    let zx = dy * hz - dz * hy, zy = dz * hx - dx * hz, zz = dx * hy - dy * hx;
    const zl = Math.hypot(zx, zy, zz) || 1;
    zx /= zl; zy /= zl; zz /= zl;
    const xx = dy * zz - dz * zy, xy = dz * zx - dx * zz, xz = dx * zy - dy * zx;
    this.basis(xx, xy, xz, dx, dy, dz, zx, zy, zz);
  }

  // ------------------------------------------------------------------ geometry
  /** Emit a vertex in part-local coordinates; (u, v) in part-local metres, (eu, ev) its face's edge coordinates
   * (edgeEncode; 0 = none). Returns its index. */
  v(x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, vv: number, eu = 0, ev = 0): number {
    const m = this.m;
    const X = m[0] * x + m[1] * y + m[2] * z + m[3];
    let Y = m[4] * x + m[5] * y + m[6] * z + m[7];
    const Z = m[8] * x + m[9] * y + m[10] * z + m[11];
    const NX = m[0] * nx + m[1] * ny + m[2] * nz;
    let NY = m[4] * nx + m[5] * ny + m[6] * nz;
    const NZ = m[8] * nx + m[9] * ny + m[10] * nz;
    const k = this.nv++;
    if ((k + 1) * 6 > this.lp.length) {
      const g = new Float64Array(this.lp.length * 2);
      g.set(this.lp);
      this.lp = g;
    }
    const o = k * 6;
    this.lp[o] = X; this.lp[o + 1] = Y; this.lp[o + 2] = Z;
    this.lp[o + 3] = NX; this.lp[o + 4] = NY; this.lp[o + 5] = NZ;
    if (this.mirror) { Y = -Y; NY = -NY; }
    if (this.alt) ev = ev === 0 ? -0.25 : -Math.abs(ev); // -0.25: the flag on an axis without edges
    return this.w ? this.w.vertex(X, Y, Z, NX, NY, NZ, (u + this.ou) * this.uvS, (vv + this.ov) * this.uvSv, eu, ev) : this.base + k;
  }

  /** Triangle, automatically wound counter-clockwise as seen from its vertex normals. */
  tri(a: number, b: number, c: number): void {
    const lp = this.lp, base = this.base;
    const oa = (a - base) * 6, ob = (b - base) * 6, oc = (c - base) * 6;
    const e1x = lp[ob] - lp[oa], e1y = lp[ob + 1] - lp[oa + 1], e1z = lp[ob + 2] - lp[oa + 2];
    const e2x = lp[oc] - lp[oa], e2y = lp[oc + 1] - lp[oa + 1], e2z = lp[oc + 2] - lp[oa + 2];
    const cx = e1y * e2z - e1z * e2y, cy = e1z * e2x - e1x * e2z, cz = e1x * e2y - e1y * e2x;
    const nx = lp[oa + 3] + lp[ob + 3] + lp[oc + 3];
    const ny = lp[oa + 4] + lp[ob + 4] + lp[oc + 4];
    const nz = lp[oa + 5] + lp[ob + 5] + lp[oc + 5];
    let swap = cx * nx + cy * ny + cz * nz < 0;
    if (this.mirror) swap = !swap;
    this.tris++;
    if (!this.w) return;
    if (swap) this.w.tri(a, c, b);
    else this.w.tri(a, b, c);
  }
  /** Quad a-b-c-d (cyclic order, either direction). */
  quad(a: number, b: number, c: number, d: number): void {
    this.tri(a, b, c);
    this.tri(a, c, d);
  }
}

/** Deterministic [0,1) value from a prop seed and a draw index (positions / tints only, never topology). */
export function rnd(seed: number, k: number): number {
  let h = Math.imul((seed ^ Math.imul(k + 0x632be5ab, 0x9e3779b1)) >>> 0, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return (h >>> 8) / 16777216;
}
/** Deterministic value in [lo, hi). */
export const rndRange = (seed: number, k: number, lo: number, hi: number): number => lo + (hi - lo) * rnd(seed, k);
