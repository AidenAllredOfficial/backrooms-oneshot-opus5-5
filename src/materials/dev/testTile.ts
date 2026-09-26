// src/materials/dev/testTile.ts — WP9 dev harness only: one hand-built 19.2 m tile with the exact vertex layout of
// core/mesh.ts (tile-local positions, br* attributes, VFlag/aux conventions) and a small CPU "bake" producing every
// per-tile texture the WP9 shaders read (irr/dir/flick/mask lightmaps, emission map, light volume + wall mask).
// Three rooms: A (Level 0 office: carpet, wallpaper, troffers, leak stain, wet patch, wear path, desk),
// B (wet VCT floor, drywall, one FLICKER troffer), C (pool hall: POOL_TILE deck, sunk pool with water).
// Lighting is room-local (no occlusion tests); indirect is a per-room radiosity estimate with analytic AO.

import * as THREE from 'three';
import { EMISSION, LV } from '../../core/constants.ts';
import { toHalf } from '../../core/half.ts';
import { LightState, Mat, VFlag } from '../../core/ids.ts';
import type { MatId } from '../../core/ids.ts';
import { LAYER_DEFS, layerRepeatY } from '../../core/materials.ts';

type V3 = [number, number, number];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
const norm = (a: V3): V3 => mul(a, 1 / (len(a) || 1));
const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (e0: number, e1: number, x: number): number => { const t = clamp01((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };
const luma = (c: V3): number => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

const TEXEL = 0.1; // m (tpc 12)
const ATLAS_W = 1024;
const WATER_Y = -0.1;
const POOL_Y = -1.6;
const waterByte = Math.round((WATER_Y * 100 + 320) / 5);

interface Room { id: number; box: [number, number, number, number, number, number]; lights: Light[] }
interface Light { c: V3; hu: V3; hv: V3; L: V3; dyn: boolean; room: number }
interface Chart { x: number; y: number; nu: number; nv: number; p0: V3; eu: V3; ev: V3; n: V3; room: number; layer: number; maskKind: string }

const ROOMS: Room[] = [
  { id: 1, box: [0.075, 0, 0.075, 9.525, 2.7, 9.525], lights: [] },
  { id: 2, box: [9.675, 0, 0.075, 19.125, 2.7, 9.525], lights: [] },
  { id: 3, box: [0.075, POOL_Y, 9.675, 19.125, 3.6, 19.125], lights: [] },
];
const POOL = { x0: 4.8, x1: 14.4, z0: 12.0, z1: 16.8 };

// ---------------------------------------------------------------- geometry builder (MeshBuffers layout)
interface QuadOpts {
  layer: MatId; flags?: number; tint?: [number, number, number, number]; emit?: number; aux?: [number, number, number, number];
  uv?: (p: V3, n: V3) => [number, number]; lm?: (p: V3) => [number, number];
}
class MeshB {
  pos: number[] = []; nrm: number[] = []; uv: number[] = []; lm: number[] = []; layer: number[] = []; flags: number[] = [];
  tint: number[] = []; emit: number[] = []; aux: number[] = []; idx: number[] = [];
  quad(p0: V3, eu: V3, ev: V3, o: QuadOpts): void {
    const n = norm(cross(eu, ev));
    const base = this.pos.length / 3;
    const corners: V3[] = [p0, add(p0, eu), add(add(p0, eu), ev), add(p0, ev)];
    const uvOf = o.uv ?? defaultUv(o.layer);
    for (const p of corners) {
      this.pos.push(...p);
      this.nrm.push(Math.round(n[0] * 127), Math.round(n[1] * 127), Math.round(n[2] * 127), 0);
      const t = uvOf(p, n); this.uv.push(t[0], t[1]);
      const l = o.lm ? o.lm(p) : [0, 0]; this.lm.push(l[0], l[1]);
      this.layer.push(o.layer); this.flags.push(o.flags ?? 0);
      this.tint.push(...(o.tint ?? [255, 255, 255, 255])); this.emit.push(o.emit ?? 0); this.aux.push(...(o.aux ?? [0, 0, 0, 0]));
    }
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  box(min: V3, max: V3, o: QuadOpts): void {
    const [x0, y0, z0] = min, [x1, y1, z1] = max;
    const partUv = (p: V3, n: V3): [number, number] => {
      const r = LAYER_DEFS[o.layer].repeat;
      const a = [Math.abs(n[0]), Math.abs(n[1]), Math.abs(n[2])];
      if (a[1] > 0.5) return [(p[0] - x0) / r, (p[2] - z0) / r];
      return a[0] > 0.5 ? [(p[2] - z0) / r, (p[1] - y0) / r] : [(p[0] - x0) / r, (p[1] - y0) / r];
    };
    const q = { ...o, uv: partUv };
    this.quad([x0, y1, z0], [0, 0, z1 - z0], [x1 - x0, 0, 0], q); // top +y
    this.quad([x0, y0, z0], [x1 - x0, 0, 0], [0, 0, z1 - z0], q); // bottom -y
    this.quad([x0, y0, z1], [x1 - x0, 0, 0], [0, y1 - y0, 0], q); // +z
    this.quad([x1, y0, z0], [-(x1 - x0), 0, 0], [0, y1 - y0, 0], q); // -z
    this.quad([x1, y0, z1], [0, 0, -(z1 - z0)], [0, y1 - y0, 0], q); // +x
    this.quad([x0, y0, z0], [0, 0, z1 - z0], [0, y1 - y0, 0], q); // -x
  }
  geometry(lmW = 1, lmH = 1): THREE.BufferGeometry {
    for (let i = 0; i < this.lm.length; i += 2) { this.lm[i] /= lmW; this.lm[i + 1] /= lmH; }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Int8Array(this.nrm), 4, true));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(this.uv), 2));
    g.setAttribute('brLmUv', new THREE.BufferAttribute(new Float32Array(this.lm), 2));
    g.setAttribute('brLayer', new THREE.BufferAttribute(new Uint8Array(this.layer), 1));
    g.setAttribute('brFlags', new THREE.BufferAttribute(new Uint8Array(this.flags), 1));
    g.setAttribute('brTint', new THREE.BufferAttribute(new Uint8Array(this.tint), 4, true));
    g.setAttribute('brEmit', new THREE.BufferAttribute(new Float32Array(this.emit), 1));
    g.setAttribute('brAux', new THREE.BufferAttribute(new Uint8Array(this.aux), 4, true));
    g.setIndex(new THREE.BufferAttribute(new Uint32Array(this.idx), 1));
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  }
}
/** Material uv per the mesher rule: horizontal (x, z)/repeat; vertical (along, y/repeatY). */
function defaultUv(layer: MatId): (p: V3, n: V3) => [number, number] {
  const d = LAYER_DEFS[layer];
  const r = d.repeat, ry = layerRepeatY(d);
  return (p, n) => {
    if (Math.abs(n[1]) > 0.5) return [p[0] / r, p[2] / r];
    return Math.abs(n[0]) > 0.5 ? [p[2] / r, p[1] / ry] : [p[0] / r, p[1] / ry];
  };
}

// ---------------------------------------------------------------- atlas (shelf packer, 1-texel apron)
class Atlas {
  charts: Chart[] = [];
  private sx = 0; private sy = 0; private sh = 0;
  add(p0: V3, eu: V3, ev: V3, room: number, layer: number, maskKind: string): Chart {
    const nu = Math.max(1, Math.ceil(len(eu) / TEXEL - 1e-6)), nv = Math.max(1, Math.ceil(len(ev) / TEXEL - 1e-6));
    const w = nu + 2 + 2, h = nv + 2 + 2; // apron + gutter
    if (this.sx + w > ATLAS_W) { this.sx = 0; this.sy += this.sh; this.sh = 0; }
    const c: Chart = { x: this.sx + 1, y: this.sy + 1, nu, nv, p0, eu, ev, n: norm(cross(eu, ev)), room, layer, maskKind };
    this.sx += w; this.sh = Math.max(this.sh, h);
    this.charts.push(c);
    return c;
  }
  get height(): number { return Math.max(64, Math.pow(2, Math.ceil(Math.log2(this.sy + this.sh + 1)))); }
}
function lmOf(c: Chart, H: () => number): (p: V3) => [number, number] {
  return (p) => {
    const d = sub(p, c.p0);
    const s = clamp01(dot(d, c.eu) / dot(c.eu, c.eu)), r = clamp01(dot(d, c.ev) / dot(c.ev, c.ev));
    void H;
    return [c.x + 1 + s * c.nu, c.y + 1 + r * c.nv]; // atlas texel units; normalised in MeshB.geometry()
  };
}

// ---------------------------------------------------------------- lighting model (room-local)
const ambientOf = new Map<number, V3>();
function directAt(p: V3, n: V3, room: number, dynOut: { y: number } | null, dirAcc: V3 | null): V3 {
  const e: V3 = [0, 0, 0];
  const r = ROOMS.find((x) => x.id === room);
  if (!r) return e;
  for (const l of r.lights) {
    const nl: V3 = [0, -1, 0]; // every emitter faces down
    const area = 4 * len(l.hu) * len(l.hv);
    const NU = 4, NV = 6; const dA = area / (NU * NV);
    let acc = 0; const dsum: V3 = [0, 0, 0];
    for (let i = 0; i < NU; i++) for (let j = 0; j < NV; j++) {
      const q = add(add(l.c, mul(l.hu, ((i + 0.5) / NU - 0.5) * 2)), mul(l.hv, ((j + 0.5) / NV - 0.5) * 2));
      const d = sub(q, p); const d2 = Math.max(dot(d, d), 1e-4); const w = mul(d, 1 / Math.sqrt(d2));
      const cr = dot(n, w), ce = dot(nl, mul(w, -1));
      if (cr <= 0 || ce <= 0) continue;
      const k = dA * cr * ce / d2; acc += k;
      dsum[0] += w[0] * k; dsum[1] += w[1] * k; dsum[2] += w[2] * k;
    }
    if (l.dyn) { if (dynOut) dynOut.y += luma(l.L) * acc; continue; }
    const c = mul(l.L, acc);
    e[0] += c[0]; e[1] += c[1]; e[2] += c[2];
    if (dirAcc) { const y = luma(c); const dn = norm(dsum); dirAcc[0] += dn[0] * y; dirAcc[1] += dn[1] * y; dirAcc[2] += dn[2] * y; }
  }
  return e;
}
function aoAt(p: V3, n: V3, room: number): number {
  const r = ROOMS.find((x) => x.id === room);
  if (!r) return 1;
  const planes: { axis: number; v: number }[] = [
    { axis: 0, v: r.box[0] }, { axis: 0, v: r.box[3] }, { axis: 1, v: r.box[1] < -1 ? 0 : r.box[1] }, { axis: 1, v: r.box[4] },
    { axis: 2, v: r.box[2] }, { axis: 2, v: r.box[5] },
  ];
  if (room === 3 && p[1] < 0.01 && p[0] > POOL.x0 - 0.01 && p[0] < POOL.x1 + 0.01 && p[2] > POOL.z0 - 0.01 && p[2] < POOL.z1 + 0.01) {
    planes.push({ axis: 0, v: POOL.x0 }, { axis: 0, v: POOL.x1 }, { axis: 1, v: POOL_Y }, { axis: 2, v: POOL.z0 }, { axis: 2, v: POOL.z1 });
  }
  let ao = 1;
  for (const pl of planes) {
    if (Math.abs(n[pl.axis]) > 0.5) continue; // own plane / opposite plane
    const d = Math.abs(p[pl.axis] - pl.v);
    ao *= 1 - 0.5 / (1 + (d / 0.25) ** 2);
  }
  return ao;
}
function roomAt(x: number, y: number, z: number): number {
  for (const r of ROOMS) if (x >= r.box[0] - 0.08 && x <= r.box[3] + 0.08 && z >= r.box[2] - 0.08 && z <= r.box[5] + 0.08 && y <= r.box[4] + 0.01) return r.id;
  return 0;
}

// ---------------------------------------------------------------- mask rules
function maskAt(c: Chart, p: V3): [number, number, number, number] {
  let R = 0, G = 0, B = 0, A = 0;
  const r = ROOMS.find((x) => x.id === c.room)!;
  const dWall = Math.min(p[0] - r.box[0], r.box[3] - p[0], p[2] - r.box[2], r.box[5] - p[2]);
  const corner = 1 - smooth(0, 0.7, dWall);
  const wob = Math.sin(p[0] * 3.1 + p[2] * 1.7) * 0.5 + Math.sin(p[0] * 7.3 - p[2] * 5.1) * 0.25;
  switch (c.maskKind) {
    case 'carpetA': {
      B = clamp01(1 - smooth(0.9, 1.6, Math.hypot(p[0] - 7.4, p[2] - 7.2) + wob * 0.25)); // puddle
      B = Math.max(B, 0.6 * clamp01(1 - smooth(0.2, 1.0, Math.hypot(p[0] - 6.0, p[2] - 0.8)))); // under the leak
      A = clamp01(1 - smooth(0.25, 0.7, Math.abs(p[2] - 4.8 + Math.sin(p[0] * 0.8) * 0.3))) * (dWall > 0.6 ? 1 : 0);
      G = 0.7 * corner;
      break;
    }
    case 'wallA': {
      G = 0.7 * (1 - smooth(0.1, 0.3, p[1])) + 0.3 * corner;
      if (c.n[2] > 0.5) { // north wall z = 0.075: leak at x = 6
        const hf = 1 - smooth(0.5, 1.3, Math.abs(p[0] - 6.0));
        const yEdge = 1.7 + 0.12 * Math.sin(p[0] * 9.0) + 0.05 * Math.sin(p[0] * 23.0);
        R = clamp01(0.46 + (p[1] - yEdge) * 1.1) * hf;
        A = 0.8 * hf * (1 - smooth(0.0, 0.5, p[1])) + 0.75 * (1 - smooth(0.9, 1.5, Math.abs(p[0] - 3.0))) * smooth(0.5, 2.0, p[1]) * 0.9;
      }
      break;
    }
    case 'ceilA': {
      R = clamp01(1 - smooth(0.0, 1.0, Math.hypot(p[0] - 6.0, p[2] - 0.6)));
      B = 0.3 * R;
      G = 0.3 * corner;
      break;
    }
    case 'vctB': {
      B = clamp01(smooth(12.5, 13.3, p[0] + wob * 0.6)) * (0.8 + 0.2 * Math.sin(p[2] * 2.0));
      G = 0.5 * corner;
      break;
    }
    case 'deckC': {
      const dp = Math.max(POOL.x0 - p[0], p[0] - POOL.x1, POOL.z0 - p[2], p[2] - POOL.z1, 0);
      B = clamp01(1 - smooth(0.4, 1.6, dp + wob * 0.3));
      G = 0.5 * corner;
      break;
    }
    default:
      G = 0.4 * corner;
  }
  return [R, G, B, A];
}

// ---------------------------------------------------------------- textures
function halfTex(w: number, h: number, data: Uint16Array, mips: boolean): THREE.DataTexture {
  const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.HalfFloatType);
  t.minFilter = mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = mips;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.needsUpdate = true;
  return t;
}
function u8Tex(w: number, h: number, data: Uint8Array): THREE.DataTexture {
  const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.minFilter = THREE.LinearFilter; t.magFilter = THREE.LinearFilter; t.generateMipmaps = false;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.needsUpdate = true;
  return t;
}
function tex3D(w: number, h: number, d: number, data: Uint16Array | Uint8Array, half: boolean): THREE.Data3DTexture {
  const t = new THREE.Data3DTexture(data, w, h, d);
  t.format = THREE.RGBAFormat; t.type = half ? THREE.HalfFloatType : THREE.UnsignedByteType;
  t.minFilter = THREE.LinearFilter; t.magFilter = THREE.LinearFilter; t.generateMipmaps = false;
  t.wrapS = t.wrapT = t.wrapR = THREE.ClampToEdgeWrapping;
  t.needsUpdate = true;
  return t;
}

export interface DevTile {
  shell: THREE.BufferGeometry; props: THREE.BufferGeometry; decals: THREE.BufferGeometry; water: THREE.BufferGeometry;
  lmIrr: THREE.Texture; lmDir: THREE.Texture; lmMask: THREE.Texture; lmFlick: THREE.Texture; lmFlickAlt: THREE.Texture;
  emission: THREE.Texture; volA: THREE.Texture; volB: THREE.Texture; volC: THREE.Texture; volMask: THREE.Texture;
  dynColor: V3;
  stats: { charts: number; atlasH: number; texels: number; ms: number };
}

/** Build the tile. `vctOnly`: a single big VCT floor (anti-tiling check), no walls/props. */
export function buildDevTile(opts: { vctOnly?: boolean } = {}): DevTile {
  const t0 = performance.now();
  for (const r of ROOMS) r.lights = [];
  const shell = new MeshB(), props = new MeshB(), decals = new MeshB(), water = new MeshB();
  const atlas = new Atlas();
  const H = (): number => atlas.height;
  const key = (room: number): [number, number] => [room & 255, room >> 8];

  // ---- lights (troffers 0.6 x 1.2 at 3300 nits; sky panels 1.2 x 1.2 at 2500 nits)
  const troffer = (room: number, x: number, z: number, y: number, L: number, dyn = false): Light => {
    const l: Light = { c: [x, y, z], hu: [0.3, 0, 0], hv: [0, 0, 0.6], L: [L, L * 0.97, L * 0.88], dyn, room };
    ROOMS[room - 1].lights.push(l);
    return l;
  };
  const dynColor: V3 = [1, 0.95, 0.85];
  const lensQuads: { l: Light; flags: number; aux: [number, number, number, number]; tint: [number, number, number, number]; emit: number }[] = [];
  if (!opts.vctOnly) {
    for (const [x, z] of [[1.8, 2.4], [4.2, 2.4], [7.2, 2.4], [1.8, 7.2], [4.2, 7.2], [7.2, 7.2]] as const) {
      const l = troffer(1, x, z, 2.695, 3300);
      lensQuads.push({ l, flags: 0, aux: [0, 0, 0, 0], tint: [255, 247, 224, 255], emit: 3300 });
    }
    // a DYING shimmer lens and an OFF lens in room A (DYING light still lights at DYING_MEAN)
    const dying = troffer(1, 7.2, 4.8, 2.695, 3300 * 0.35);
    lensQuads.push({ l: dying, flags: VFlag.SHIMMER, aux: [0, 0, 0, LightState.DYING], tint: [255, 235, 240, 77], emit: 3300 * 0.35 });
    lensQuads.push({ l: { c: [1.8, 2.695, 4.8], hu: [0.3, 0, 0], hv: [0, 0, 0.6], L: [0, 0, 0], dyn: false, room: 1 }, flags: 0, aux: [0, 0, 0, 0], tint: [140, 135, 128, 255], emit: 0 });
  }
  for (const [x, z] of [[12.0, 2.4], [16.8, 2.4], [12.0, 7.2], [16.8, 7.2]] as const) {
    const dyn = x === 16.8 && z === 7.2;
    const l = troffer(2, x, z, 2.695, 3300, dyn);
    if (dyn) l.L = mul(dynColor, 3300) as V3;
    lensQuads.push({ l, flags: dyn ? VFlag.DYN_EMIT : 0, aux: [0, 0, 0, dyn ? LightState.FLICKER : 0], tint: [255, 247, 224, dyn ? 91 : 255], emit: 3300 });
  }
  if (opts.vctOnly) for (const [x, z] of [[2.4, 2.4], [7.2, 2.4], [2.4, 7.2], [7.2, 7.2], [2.4, 12], [7.2, 12], [2.4, 16.8],
    [7.2, 16.8], [12, 12], [16.8, 12], [12, 16.8], [16.8, 16.8]] as const) {
    const l = troffer(2, x, z, 2.695, 3300);
    lensQuads.push({ l, flags: 0, aux: [0, 0, 0, 0], tint: [255, 247, 224, 255], emit: 3300 });
  }
  if (!opts.vctOnly) for (const [x, z] of [[3.6, 11.4], [9.6, 11.4], [15.6, 11.4], [3.6, 17.4], [9.6, 17.4], [15.6, 17.4]] as const) {
    const l: Light = { c: [x, 3.595, z], hu: [0.6, 0, 0], hv: [0, 0, 0.6], L: [2500 * 0.92, 2500 * 0.97, 2500], dyn: false, room: 3 };
    ROOMS[2].lights.push(l);
    lensQuads.push({ l, flags: 0, aux: [0, 0, 0, 0], tint: [235, 247, 255, 255], emit: 2500 });
  }

  // ---- shell: floors, ceilings, walls
  const floor = (x0: number, z0: number, x1: number, z1: number, y: number, room: number, layer: MatId, maskKind: string, extraFlags = 0, auxW = 0, planeH = 2.7): Chart => {
    const p0: V3 = [x0, y, z1], eu: V3 = [x1 - x0, 0, 0], ev: V3 = [0, 0, -(z1 - z0)]; // normal +y
    const c = atlas.add(p0, eu, ev, room, layer, maskKind);
    const refl = LAYER_DEFS[layer].reflective ? VFlag.REFLECTIVE : 0;
    const k = key(room);
    shell.quad(p0, eu, ev, { layer, flags: VFlag.FLOOR_AUX | refl | extraFlags, aux: [Math.round(planeH / 0.05), k[0], k[1], auxW], lm: lmOf(c, H) });
    return c;
  };
  const ceiling = (x0: number, z0: number, x1: number, z1: number, y: number, room: number, layer: MatId, maskKind: string): Chart => {
    const p0: V3 = [x0, y, z0], eu: V3 = [x1 - x0, 0, 0], ev: V3 = [0, 0, z1 - z0]; // normal -y
    const c = atlas.add(p0, eu, ev, room, layer, maskKind);
    shell.quad(p0, eu, ev, { layer, lm: lmOf(c, H) });
    return c;
  };
  /** vertical wall face: from p0 along `along` (horizontal) and up to height h; normal = along x up */
  const wall = (p0: V3, along: V3, h: number, room: number, layer: MatId, maskKind: string, flags = 0, auxW = 0): Chart => {
    const ev: V3 = [0, h, 0];
    const c = atlas.add(p0, along, ev, room, layer, maskKind);
    shell.quad(p0, along, ev, { layer, flags, aux: [0, 0, 0, auxW], lm: lmOf(c, H) });
    return c;
  };

  let ceilA: Chart | null = null, ceilB: Chart | null = null, ceilC: Chart | null = null;
  if (opts.vctOnly) {
    floor(0.075, 0.075, 19.125, 19.125, 0, 2, Mat.VINYL_VCT, 'vctB');
    ROOMS[1].box = [0.075, 0, 0.075, 19.125, 2.7, 19.125];
    ceilB = ceiling(0.075, 0.075, 19.125, 19.125, 2.7, 2, Mat.CEILING_TILE, 'none');
  } else {
    ROOMS[1].box = [9.675, 0, 0.075, 19.125, 2.7, 9.525];
    const fA = floor(0.075, 0.075, 9.525, 9.525, 0, 1, Mat.CARPET_L0, 'carpetA');
    floor(9.675, 0.075, 19.125, 9.525, 0, 2, Mat.VINYL_VCT, 'vctB');
    // pool hall deck around the pool (4 pieces) + pool floor
    floor(0.075, 9.675, 19.125, POOL.z0, 0, 3, Mat.POOL_TILE, 'deckC', 0, 0, 3.6);
    floor(0.075, POOL.z1, 19.125, 19.125, 0, 3, Mat.POOL_TILE, 'deckC', 0, 0, 3.6);
    floor(0.075, POOL.z0, POOL.x0, POOL.z1, 0, 3, Mat.POOL_TILE, 'deckC', 0, 0, 3.6);
    floor(POOL.x1, POOL.z0, 19.125, POOL.z1, 0, 3, Mat.POOL_TILE, 'deckC', 0, 0, 3.6);
    floor(POOL.x0, POOL.z0, POOL.x1, POOL.z1, POOL_Y, 3, Mat.POOL_MOSAIC, 'none', VFlag.UNDERWATER, waterByte, 3.6 - POOL_Y);
    // pool walls (inward-facing), submerged
    const pw = (p0: V3, al: V3): void => { wall(p0, al, -POOL_Y, 3, Mat.POOL_MOSAIC, 'none', VFlag.UNDERWATER, waterByte); };
    pw([POOL.x0, POOL_Y, POOL.z0], [POOL.x1 - POOL.x0, 0, 0]); // faces +z
    pw([POOL.x1, POOL_Y, POOL.z1], [-(POOL.x1 - POOL.x0), 0, 0]); // faces -z
    pw([POOL.x0, POOL_Y, POOL.z1], [0, 0, -(POOL.z1 - POOL.z0)]); // faces +x
    pw([POOL.x1, POOL_Y, POOL.z0], [0, 0, POOL.z1 - POOL.z0]); // faces -x
    ceilA = ceiling(0.075, 0.075, 9.525, 9.525, 2.7, 1, Mat.CEILING_TILE, 'ceilA');
    ceilB = ceiling(9.675, 0.075, 19.125, 9.525, 2.7, 2, Mat.CEILING_TILE, 'none');
    ceilC = ceiling(0.075, 9.675, 19.125, 19.125, 3.6, 3, Mat.POOL_TILE, 'none');

    // room A walls (wallpaper) with a doorway to B (x = 9.6, z 4.35..5.25) and to C (z = 9.6, x 4.35..5.25)
    const wA = (p0: V3, al: V3, h = 2.7): Chart => wall(p0, al, h, 1, Mat.WALLPAPER_L0, 'wallA');
    // normal = along x up: along +x -> +z, -x -> -z, +z -> -x, -z -> +x
    wA([0.075, 0, 0.075], [9.45, 0, 0]); // north wall (leak), faces +z
    wA([0.075, 0, 9.525], [0, 0, -9.45]); // west wall, faces +x
    wA([9.525, 0, 0.075], [0, 0, 4.275]); // east wall, faces -x, doorway z 4.35..5.25
    wA([9.525, 0, 5.25], [0, 0, 4.275]);
    wA([9.525, 2.1, 4.35], [0, 0, 0.9], 0.6);
    wA([4.35, 0, 9.525], [-4.275, 0, 0]); // south wall, faces -z, doorway x 4.35..5.25
    wA([9.525, 0, 9.525], [-4.275, 0, 0]);
    wA([5.25, 2.1, 9.525], [-0.9, 0, 0], 0.6);
    // baseboards (TRIM_PAINT, lm borrowed from the west wall chart region is approximated by the floor chart)
    const bb = (p0: V3, al: V3, out: V3): void => {
      const p = add(p0, mul(out, 0.015));
      shell.quad(p, al, [0, 0.1, 0], { layer: Mat.TRIM_PAINT, tint: [240, 232, 210, 255], lm: lmOf(fA, H) });
      shell.quad(add(p, [0, 0.1, 0]), al, mul(out, -0.015), { layer: Mat.TRIM_PAINT, tint: [240, 232, 210, 255], lm: lmOf(fA, H) });
    };
    bb([0.075, 0, 9.525], [0, 0, -9.45], [1, 0, 0]);
    bb([0.075, 0, 0.075], [9.45, 0, 0], [0, 0, 1]);

    // room B walls (drywall)
    const wB = (p0: V3, al: V3, h = 2.7): Chart => wall(p0, al, h, 2, Mat.DRYWALL, 'wallB');
    wB([9.675, 0, 0.075], [9.45, 0, 0]); // north, faces +z
    wB([19.125, 0, 0.075], [0, 0, 9.45]); // east, faces -x
    wB([9.675, 0, 4.35], [0, 0, -4.275]); // west (door side), faces +x
    wB([9.675, 0, 9.525], [0, 0, -4.275]);
    wB([9.675, 2.1, 5.25], [0, 0, -0.9], 0.6);
    wB([13.95, 0, 9.525], [-4.275, 0, 0]); // south, faces -z, doorway 13.95..14.85
    wB([19.125, 0, 9.525], [-4.275, 0, 0]);
    wB([14.85, 2.1, 9.525], [-0.9, 0, 0], 0.6);
    // door jambs + lintel undersides (TRIM_PAINT)
    const jamb = (p0: V3, al: V3, room: number): void => { wall(p0, al, 2.1, room, Mat.TRIM_PAINT, 'none'); };
    jamb([9.525, 0, 4.35], [0.15, 0, 0], 1); // A|B, faces +z
    jamb([9.675, 0, 5.25], [-0.15, 0, 0], 1); // faces -z
    shell.quad([9.525, 2.1, 4.35], [0.15, 0, 0], [0, 0, 0.9], { layer: Mat.TRIM_PAINT, lm: lmOf(ceilA, H) });
    for (const x0 of [4.35, 13.95]) { // A|C and B|C
      const room = x0 < 9.6 ? 1 : 2;
      jamb([x0, 0, 9.675], [0, 0, -0.15], room); // faces +x
      jamb([x0 + 0.9, 0, 9.525], [0, 0, 0.15], room); // faces -x
      shell.quad([x0, 2.1, 9.525], [0.9, 0, 0], [0, 0, 0.15], { layer: Mat.TRIM_PAINT, lm: lmOf(room === 1 ? ceilA : ceilB, H) });
    }

    // room C walls (pool tile, 3.6 m)
    const wC = (p0: V3, al: V3, h = 3.6): Chart => wall(p0, al, h, 3, Mat.POOL_TILE, 'none');
    wC([0.075, 0, 9.675], [4.35 - 0.075, 0, 0]); // north (faces +z)... al x up = (+x) x (+y) = +z
    wC([5.25, 0, 9.675], [13.95 - 5.25, 0, 0]);
    wC([14.85, 0, 9.675], [19.125 - 14.85, 0, 0]);
    wC([4.35, 2.1, 9.675], [0.9, 0, 0], 1.5);
    wC([13.95, 2.1, 9.675], [0.9, 0, 0], 1.5);
    wC([19.125, 0, 19.125], [-19.05, 0, 0]); // south, faces -z
    wC([0.075, 0, 19.125], [0, 0, -9.45]); // west, faces +x
    wC([19.125, 0, 9.675], [0, 0, 9.45]); // east, faces -x
  }

  // ---- lens quads (facing down, lm borrowed from the ceiling chart; uv 0..1 per 0.6 m)
  for (const q of lensQuads) {
    const c = q.l.c;
    const ceil = q.l.room === 1 ? ceilA : q.l.room === 2 ? ceilB : ceilC;
    const p0: V3 = [c[0] - q.l.hu[0], c[1], c[2] - q.l.hv[2]];
    const eu: V3 = [2 * q.l.hu[0], 0, 0], ev: V3 = [0, 0, 2 * q.l.hv[2]];
    const n = cross(eu, ev); // must face down
    const flip = n[1] > 0;
    const pA = flip ? add(p0, ev) : p0, evA: V3 = flip ? mul(ev, -1) : ev;
    shell.quad(pA, eu, evA, {
      layer: Mat.PANEL_LENS, flags: q.flags, aux: q.aux, tint: q.tint, emit: q.emit,
      uv: (p) => [(p[0] - p0[0]) / 0.6, (p[2] - p0[2]) / 0.6], lm: ceil ? lmOf(ceil, H) : undefined,
    });
  }

  // ---- props (light volume; PROP_AUX aux = (0, 0, bits, ceilByte))
  if (!opts.vctOnly) {
    const pa = (ceil: number): [number, number, number, number] => [0, 0, 0, Math.round(ceil / 0.05)];
    const P = VFlag.PROP_AUX;
    props.box([2.2, 0.72, 5.6], [3.8, 0.76, 6.4], { layer: Mat.WOOD, flags: P, aux: pa(2.7), tint: [230, 200, 170, 255] });
    for (const [x, z] of [[2.25, 5.65], [3.7, 5.65], [2.25, 6.3], [3.7, 6.3]] as const) {
      props.box([x, 0, z], [x + 0.05, 0.72, z + 0.05], { layer: Mat.METAL_PAINTED, flags: P, aux: pa(2.7), tint: [90, 90, 92, 255] });
    }
    props.box([0.2, 0, 8.6], [0.65, 1.32, 9.2], { layer: Mat.METAL_PAINTED, flags: P, aux: pa(2.7), tint: [200, 190, 165, 255] });
    props.box([17.6, 0, 1.0], [18.8, 1.9, 1.5], { layer: Mat.METAL_PAINTED, flags: P, aux: pa(2.7), tint: [230, 110, 40, 255] });
    props.box([12.0, 0, 18.2], [14.0, 0.45, 18.7], { layer: Mat.POOL_TILE, flags: P, aux: pa(3.6), tint: [255, 255, 255, 255] });
    props.box([2.0, 0, 12.5], [2.6, 0.9, 13.1], { layer: Mat.PLASTIC, flags: P, aux: pa(3.6), tint: [60, 150, 230, 255] });
  }

  // ---- decals (DECAL flag, borrowed lmUv, slot uvs; floor +v along -Z)
  if (!opts.vctOnly) {
    const floorA = atlas.charts[0];
    const slotUv = (slot: number, x0: V3, eu: V3, ev: V3) => (p: V3): [number, number] => {
      const d = sub(p, x0);
      const s = dot(d, eu) / dot(eu, eu), r = dot(d, ev) / dot(ev, ev);
      return [((slot % 4) + s) / 4, (Math.floor(slot / 4) + r) / 4];
    };
    { // carpet water stain, 1.3 m
      const p0: V3 = [5.6, 0.002, 3.7], eu: V3 = [1.3, 0, 0], ev: V3 = [0, 0, -1.3];
      decals.quad(p0, eu, ev, { layer: Mat.DECAL_ATLAS, flags: VFlag.DECAL, uv: slotUv(0, p0, eu, ev), lm: lmOf(floorA, H) });
    }
    const wallCharts = atlas.charts.filter((c) => c.room === 1 && Math.abs(c.n[0]) > 0.5);
    { // poster on the west wall of A (faces +x), +v = +Y
      const p0: V3 = [0.077, 1.1, 3.8], eu: V3 = [0, 0, -0.8], ev: V3 = [0, 1.0, 0];
      decals.quad(p0, eu, ev, { layer: Mat.DECAL_ATLAS, flags: VFlag.DECAL, uv: slotUv(8, p0, eu, ev), lm: lmOf(wallCharts[0], H) });
    }
    { // chalk arrow on B's north wall (faces +z)
      const wb = atlas.charts.find((c) => c.room === 2 && c.n[2] > 0.5)!;
      const p0: V3 = [15.0, 0.9, 0.077], eu: V3 = [0.6, 0, 0], ev: V3 = [0, 0.6, 0];
      decals.quad(p0, eu, ev, { layer: Mat.DECAL_ATLAS, flags: VFlag.DECAL, uv: slotUv(9, p0, eu, ev), lm: lmOf(wb, H) });
    }
    { // yellow floor-paint stripe on the VCT (FLOOR_PAINT, uv in metres)
      const fb = atlas.charts[1];
      const p0: V3 = [14.9, 0.002, 8.8], eu: V3 = [0.12, 0, 0], ev: V3 = [0, 0, -7.6];
      decals.quad(p0, eu, ev, { layer: Mat.FLOOR_PAINT, flags: VFlag.DECAL, tint: [235, 190, 30, 255], lm: lmOf(fb, H) });
    }
  }

  // ---- water surface (REFLECTIVE; aux.x = depth/5 cm, aux.w = plane byte)
  if (!opts.vctOnly) {
    const deck = atlas.charts.find((c) => c.room === 3 && c.layer === Mat.POOL_MOSAIC)!;
    water.quad([POOL.x0, WATER_Y, POOL.z1], [POOL.x1 - POOL.x0, 0, 0], [0, 0, -(POOL.z1 - POOL.z0)], {
      layer: Mat.POOL_TILE, flags: VFlag.REFLECTIVE, aux: [Math.round((WATER_Y - POOL_Y) * 20), 3, 0, waterByte], lm: lmOf(deck, H),
    });
  }

  // ---- bake lightmaps
  const AH = atlas.height;
  const N = ATLAS_W * AH;
  const irr = new Uint16Array(N * 4), dir = new Uint8Array(N * 4), mask = new Uint8Array(N * 4);
  const flick = new Uint16Array(N * 4), flickAlt = new Uint16Array(N * 4);
  // per-room ambient: radiosity estimate from the mean direct floor irradiance
  for (const r of ROOMS) {
    let s: V3 = [0, 0, 0], n = 0;
    for (let x = r.box[0] + 0.3; x < r.box[3]; x += 0.6) for (let z = r.box[2] + 0.3; z < r.box[5]; z += 0.6) {
      const e = directAt([x, 0.02, z], [0, 1, 0], r.id, null, null); s = add(s, e); n++;
    }
    ambientOf.set(r.id, mul(s, n ? 0.62 / n : 0));
  }
  let texels = 0;
  for (const c of atlas.charts) {
    for (let j = 0; j < c.nv + 2; j++) {
      for (let i = 0; i < c.nu + 2; i++) {
        const s = clamp01((i - 0.5) / c.nu), r = clamp01((j - 0.5) / c.nv);
        const p = add(add(c.p0, mul(c.eu, s)), mul(c.ev, r));
        const pe = add(p, mul(c.n, 0.02));
        const dyn = { y: 0 };
        const dacc: V3 = [0, 0, 0];
        const ed = directAt(pe, c.n, c.room, dyn, dacc);
        const ao = aoAt(p, c.n, c.room);
        const amb = mul(ambientOf.get(c.room) ?? [0, 0, 0], ao);
        const e = add(ed, amb);
        const w = clamp01(len(dacc) / Math.max(luma(e), 1e-6));
        const dn = len(dacc) > 1e-6 ? norm(dacc) : [0, 1, 0] as V3;
        const k = ((c.y + j) * ATLAS_W + (c.x + i)) * 4;
        irr[k] = toHalf(e[0]); irr[k + 1] = toHalf(e[1]); irr[k + 2] = toHalf(e[2]); irr[k + 3] = toHalf(ao);
        dir[k] = Math.round((dn[0] * 0.5 + 0.5) * 255); dir[k + 1] = Math.round((dn[1] * 0.5 + 0.5) * 255);
        dir[k + 2] = Math.round((dn[2] * 0.5 + 0.5) * 255); dir[k + 3] = Math.round(w * 255);
        flick[k] = toHalf(dyn.y); flickAlt[k] = toHalf(dyn.y * 4 + (c.room === 2 ? 800 : 0));
        const m = maskAt(c, p);
        mask[k] = Math.round(255 * m[0]); mask[k + 1] = Math.round(255 * m[1]); mask[k + 2] = Math.round(255 * m[2]); mask[k + 3] = Math.round(255 * m[3]);
        texels++;
      }
    }
  }

  // ---- emission map (88^2 at 0.3 m over the tile +- 3.6 m): rgb radiance footprint, a = region key (negated: dynamic)
  const R = EMISSION.RES;
  const em = new Uint16Array(R * R * 4);
  for (let j = 0; j < R; j++) {
    for (let i = 0; i < R; i++) {
      const x0 = -EMISSION.MARGIN + i * EMISSION.TEXEL, z0 = -EMISSION.MARGIN + j * EMISSION.TEXEL;
      const x1 = x0 + EMISSION.TEXEL, z1 = z0 + EMISSION.TEXEL;
      let rgb: V3 = [0, 0, 0]; let dynHit = false;
      for (const room of ROOMS) for (const l of room.lights) {
        const lx0 = l.c[0] - Math.abs(l.hu[0]), lx1 = l.c[0] + Math.abs(l.hu[0]);
        const lz0 = l.c[2] - Math.abs(l.hv[2]), lz1 = l.c[2] + Math.abs(l.hv[2]);
        const ox = Math.max(0, Math.min(x1, lx1) - Math.max(x0, lx0)), oz = Math.max(0, Math.min(z1, lz1) - Math.max(z0, lz0));
        const cov = (ox * oz) / (EMISSION.TEXEL * EMISSION.TEXEL);
        if (cov <= 0) continue;
        rgb = add(rgb, mul(l.L, cov)); // dynamic lights at intensity 1 (the shader multiplies the live channel)
        if (l.dyn) dynHit = true;
      }
      const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
      const rk = roomAt(cx, 0, cz);
      const k = (j * R + i) * 4;
      em[k] = toHalf(rgb[0]); em[k + 1] = toHalf(rgb[1]); em[k + 2] = toHalf(rgb[2]); em[k + 3] = toHalf(dynHit ? -rk : rk);
    }
  }

  // ---- light volume (32 x 6 x 32, 0.6 m) + wall mask
  const NX = LV.NX, NY = LV.NY, NZ = LV.NZ;
  const va = new Uint16Array(NX * NY * NZ * 4), vb = new Uint8Array(NX * NY * NZ * 4), vc = new Uint16Array(NX * NY * NZ * 4);
  const axes: V3[] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  for (let j = 0; j < NZ; j++) for (let k = 0; k < NY; k++) for (let i = 0; i < NX; i++) {
    const p: V3 = [(i + 0.5) * LV.STEP, LV.Y[k], (j + 0.5) * LV.STEP];
    const room = roomAt(p[0], p[1], p[2]);
    let sum: V3 = [0, 0, 0]; const dacc: V3 = [0, 0, 0]; const dyn = { y: 0 };
    for (const a of axes) { sum = add(sum, directAt(p, a, room, dyn, dacc)); }
    const amb = ambientOf.get(room) ?? [0, 0, 0];
    const e = add(mul(sum, 1 / 6), amb);
    const w = clamp01(len(dacc) / Math.max(luma(sum) + luma(amb) * 6, 1e-6));
    const dn = len(dacc) > 1e-6 ? norm(dacc) : [0, 1, 0] as V3;
    const q = ((j * NY + k) * NX + i) * 4;
    va[q] = toHalf(e[0]); va[q + 1] = toHalf(e[1]); va[q + 2] = toHalf(e[2]); va[q + 3] = toHalf(1);
    vb[q] = Math.round((dn[0] * 0.5 + 0.5) * 255); vb[q + 1] = Math.round((dn[1] * 0.5 + 0.5) * 255);
    vb[q + 2] = Math.round((dn[2] * 0.5 + 0.5) * 255); vb[q + 3] = Math.round(w * 255);
    vc[q] = toHalf(dyn.y / 6);
  }
  const wm = new Uint8Array(18 * 18 * 4);
  for (let lj = -1; lj <= 16; lj++) for (let li = -1; li <= 16; li++) {
    const x0 = li * 1.2, x1 = x0 + 1.2, z0 = lj * 1.2, z1 = z0 + 1.2;
    const inDoor = (a: number, b: number, lo: number, hi: number): boolean => Math.min(b, hi) - Math.max(a, lo) > 0.3;
    let bits = 0;
    const wallX = (x: number, zA: number, zB: number): boolean => !opts.vctOnly && ((Math.abs(x - 9.6) < 1e-6 && zB <= 9.6 + 1e-6 && !inDoor(zA, zB, 4.35, 5.25)) || Math.abs(x) < 1e-6 || Math.abs(x - 19.2) < 1e-6);
    const wallZ = (z: number, xA: number, xB: number): boolean => !opts.vctOnly && ((Math.abs(z - 9.6) < 1e-6 && !inDoor(xA, xB, 4.35, 5.25) && !inDoor(xA, xB, 13.95, 14.85)) || Math.abs(z) < 1e-6 || Math.abs(z - 19.2) < 1e-6);
    if (wallZ(z0, x0, x1)) bits |= 1;
    if (wallX(x1, z0, z1)) bits |= 2;
    if (wallZ(z1, x0, x1)) bits |= 4;
    if (wallX(x0, z0, z1)) bits |= 8;
    wm[((lj + 1) * 18 + (li + 1)) * 4] = bits;
  }

  return {
    shell: shell.geometry(ATLAS_W, AH), props: props.geometry(), decals: decals.geometry(ATLAS_W, AH), water: water.geometry(ATLAS_W, AH),
    lmIrr: halfTex(ATLAS_W, AH, irr, false), lmDir: u8Tex(ATLAS_W, AH, dir), lmMask: u8Tex(ATLAS_W, AH, mask),
    lmFlick: halfTex(ATLAS_W, AH, flick, false), lmFlickAlt: halfTex(ATLAS_W, AH, flickAlt, false),
    emission: halfTex(R, R, em, true),
    volA: tex3D(NX, NY, NZ, va, true), volB: tex3D(NX, NY, NZ, vb, false), volC: tex3D(NX, NY, NZ, vc, true),
    volMask: (() => { const t = u8Tex(18, 18, wm); t.minFilter = t.magFilter = THREE.NearestFilter; return t; })(),
    dynColor,
    stats: { charts: atlas.charts.length, atlasH: AH, texels, ms: performance.now() - t0 },
  };
}
