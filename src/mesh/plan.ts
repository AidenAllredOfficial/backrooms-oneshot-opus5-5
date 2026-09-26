// src/mesh/plan.ts — WP5 private: face records and lightmap chart specs. The same planning pass feeds
// buildTile (which then writes vertices) and buildTileSurfaces (charts only), so both produce identical charts.
// Pure module (no three/DOM).
//
// A ChartSpec is a planar texel frame: point o, unit in-plane coordinate axes eu/ev (frame coordinates of a point p
// are u = (p-o).eu, v = (p-o).ev, in metres) and 3D per-metre axes du/dv (== eu/ev except for ramps, whose texels
// are projected by xz onto the sloped plane). Its texel rectangle is derived from the extents of its OWN faces,
// snapped to the world texel grid along u (and v unless the v range is fixed), plus a 1-texel apron on every side.

import { lmTexel, type LmTpc } from '../core/constants.ts';
import type { Vec3 } from '../core/grid.ts';
import type { Chart, ChartKindId } from '../core/mesh.ts';
import { hUv, vUv } from './uv.ts';

export type V3 = [number, number, number];

export const BUF_SHELL = 0;
export const BUF_DECALS = 1;
export const BUF_WATER = 2;

export class ChartSpec {
  kind: ChartKindId;
  group: number;
  layer: number;
  key: string;
  nrm: V3;
  o: V3;
  eu: V3;
  ev: V3;
  du: V3;
  dv: V3;
  fixedV = false;
  vA = 0;
  vB = 0;
  uMin = Infinity;
  uMax = -Infinity;
  vMin = Infinity;
  vMax = -Infinity;
  cont = 0;
  grid = 0; // 1 floor grid, 2 ceiling grid
  // ---- texel rect (specDims) and atlas placement
  tex = 0;
  uBase = 0;
  vBase = 0;
  w = 0;
  h = 0;
  x = 0;
  y = 0;
  halv = 0;
  id = 0;
  ownFaces = 0;

  constructor(kind: ChartKindId, group: number, layer: number, key: string, nrm: V3, o: V3, eu: V3, ev: V3, du?: V3, dv?: V3) {
    this.kind = kind; this.group = group; this.layer = layer; this.key = key;
    this.nrm = nrm; this.o = o; this.eu = eu; this.ev = ev; this.du = du ?? eu; this.dv = dv ?? ev;
  }
  setFixedV(vA: number, vB: number): this { this.fixedV = true; this.vA = vA; this.vB = vB; return this; }
  get halvable(): boolean { return this.grid === 0 && this.group === 0; }
}

/** Per-face render state. */
export interface FaceState { layer: number; flags: number; tint: number; emit: number; aux: number; buf: number }
export const state = (layer: number, flags = 0, tint = 0xffffff, emit = 0, aux = 0, buf = BUF_SHELL): FaceState =>
  ({ layer, flags, tint, emit, aux, buf });

export interface Face {
  p: number[]; // xyz per vertex, tile-local metres (convex polygon, any winding: emission orients it by the normal)
  uv: number[]; // material uv per vertex
  nx: number; ny: number; nz: number;
  layer: number; flags: number; tint: number; emit: number; aux: number;
  buf: number;
  spec: ChartSpec | null; // own chart, or borrowed chart
  own: boolean;
  from: Face | null; // borrow the chart of another face (resolved at emission)
  lm: number[] | null; // optional per-vertex positions used for the lightmap uv (default p), e.g. inset samples
  fan: number; // triangulation: fan start vertex, or -1 = fan around an added centre vertex (tjunction.ts)
}

export function mkFace(p: number[], uv: number[], nx: number, ny: number, nz: number, st: FaceState): Face {
  return { p, uv, nx, ny, nz, layer: st.layer, flags: st.flags, tint: st.tint, emit: st.emit, aux: st.aux, buf: st.buf, spec: null, own: false, from: null, lm: null, fan: 0 };
}

/** Vertical axis-aligned quad. ax 0: plane x = plane, t along z; ax 2: plane z = plane, t along x. sign = normal sign. */
export function vQuad(ax: 0 | 2, plane: number, sign: number, t0: number, t1: number, y0: number, y1: number, st: FaceState, du = 0, dv = 0): Face {
  const p = ax === 0
    ? [plane, y0, t0, plane, y0, t1, plane, y1, t1, plane, y1, t0]
    : [t0, y0, plane, t1, y0, plane, t1, y1, plane, t0, y1, plane];
  const nx = ax === 0 ? sign : 0, nz = ax === 2 ? sign : 0;
  const uv: number[] = [];
  for (let i = 0; i < 4; i++) vUv(st.layer, p[i * 3], p[i * 3 + 1], p[i * 3 + 2], nx, nz, uv, du, dv);
  return mkFace(p, uv, nx, 0, nz, st);
}
/** Horizontal quad at height y facing sign (+1 up, -1 down). */
export function hQuad(y: number, sign: number, x0: number, x1: number, z0: number, z1: number, st: FaceState): Face {
  const p = [x0, y, z0, x1, y, z0, x1, y, z1, x0, y, z1];
  const uv: number[] = [];
  for (let i = 0; i < 4; i++) hUv(st.layer, p[i * 3], p[i * 3 + 2], uv);
  return mkFace(p, uv, 0, sign, 0, st);
}
/** Generic polygon with per-vertex material uv computed from the normal (vertical-ish => vUv, else hUv). */
export function polyFace(p: number[], nx: number, ny: number, nz: number, st: FaceState): Face {
  const uv: number[] = [];
  const vertical = Math.abs(ny) < 0.5;
  for (let i = 0; i < p.length; i += 3) {
    if (vertical) vUv(st.layer, p[i], p[i + 1], p[i + 2], nx, nz, uv);
    else hUv(st.layer, p[i], p[i + 2], uv);
  }
  return mkFace(p, uv, nx, ny, nz, st);
}

interface RunItem { f: Face; t0: number; t1: number }
interface RunGroup { make: (t0: number, t1: number) => ChartSpec; items: RunItem[] }

export class Plan {
  readonly tpc: LmTpc;
  readonly t: number;
  readonly faces: Face[] = [];
  private specs: ChartSpec[] = [];
  private runs = new Map<string, RunGroup>();
  readonly floorGrid: ChartSpec;
  readonly ceilGrid: ChartSpec;

  constructor(tpc: LmTpc, floorLayer: number, ceilLayer: number) {
    this.tpc = tpc;
    this.t = lmTexel(tpc);
    const S = 16 * tpc + 2;
    const mk = (kind: ChartKindId, key: string, ny: number, layer: number, grid: number): ChartSpec => {
      const s = new ChartSpec(kind, 0, layer, key, [0, ny, 0], [0, 0, 0], [1, 0, 0], [0, 0, 1]);
      s.grid = grid; s.cont = 15; s.tex = this.t; s.w = S; s.h = S;
      this.specs.push(s);
      return s;
    };
    this.floorGrid = mk(0, '00', 1, floorLayer, 1);
    this.ceilGrid = mk(1, '01', -1, ceilLayer, 2);
  }

  addSpec(s: ChartSpec): ChartSpec { this.specs.push(s); return s; }
  /** Face owns (contributes texels to) spec. */
  own(f: Face, s: ChartSpec): Face { f.spec = s; f.own = true; this.faces.push(f); return f; }
  /** Face belongs to a run chart: faces with the same key whose [t0, t1] intervals touch share one chart. */
  run(f: Face, key: string, t0: number, t1: number, make: (t0: number, t1: number) => ChartSpec): Face {
    let g = this.runs.get(key);
    if (!g) { g = { make, items: [] }; this.runs.set(key, g); }
    g.items.push({ f, t0, t1 });
    f.own = true;
    this.faces.push(f);
    return f;
  }
  /** Face samples another chart (trims, housings, T-bars: TRIM_BORROW). */
  borrow(f: Face, s: ChartSpec): Face { f.spec = s; f.own = false; this.faces.push(f); return f; }
  borrowFrom(f: Face, src: Face): Face { f.from = src; f.own = false; this.faces.push(f); return f; }

  /** Resolve runs, compute extents and texel rects, drop empty specs, sort by key and assign ids. */
  finalize(): ChartSpec[] {
    const keys = [...this.runs.keys()].sort();
    for (const key of keys) {
      const g = this.runs.get(key)!;
      const items = g.items.slice().sort((a, b) => a.t0 - b.t0);
      let i = 0;
      while (i < items.length) {
        let e = items[i].t1;
        let j = i + 1;
        while (j < items.length && items[j].t0 <= e + 1e-4) { e = Math.max(e, items[j].t1); j++; }
        const spec = this.addSpec(g.make(items[i].t0, e));
        for (let k = i; k < j; k++) items[k].f.spec = spec;
        i = j;
      }
    }
    for (const f of this.faces) {
      if (!f.own || !f.spec) continue;
      const s = f.spec;
      s.ownFaces++;
      if (s.grid) continue;
      const p = f.lm ?? f.p; // lightmap sample positions (faces extended past their chart, e.g. to the tile back)
      for (let i = 0; i < p.length; i += 3) {
        const dx = p[i] - s.o[0], dy = p[i + 1] - s.o[1], dz = p[i + 2] - s.o[2];
        const u = dx * s.eu[0] + dy * s.eu[1] + dz * s.eu[2];
        const v = dx * s.ev[0] + dy * s.ev[1] + dz * s.ev[2];
        if (u < s.uMin) s.uMin = u;
        if (u > s.uMax) s.uMax = u;
        if (v < s.vMin) s.vMin = v;
        if (v > s.vMax) s.vMax = v;
      }
    }
    const out: ChartSpec[] = [];
    for (const s of this.specs) {
      if (s.grid !== 0 || s.ownFaces > 0) out.push(s);
      else s.id = -1; // dropped (only borrowers): buildTile falls back to a grid chart
    }
    // stable sort by key (Array.prototype.sort is stable)
    out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    for (let i = 0; i < out.length; i++) {
      out[i].id = i;
      if (!out[i].grid) specDims(out[i], this.t);
    }
    return out;
  }
}

/** Texel rect of a (non-grid) spec at its current density (t * 2^halv). */
export function specDims(s: ChartSpec, t: number): void {
  const tex = t * (1 << s.halv);
  s.tex = tex;
  const e = 1e-6;
  const iu0 = Math.floor(s.uMin / tex + e);
  let iu1 = Math.ceil(s.uMax / tex - e);
  if (iu1 - iu0 < 2) iu1 = iu0 + 2;
  s.uBase = iu0 * tex;
  s.w = iu1 - iu0 + 2;
  let rows: number;
  if (s.fixedV) {
    const vA = Math.min(s.vA, s.vMin), vB = Math.max(s.vB, s.vMax);
    s.vBase = vA;
    rows = Math.ceil((vB - vA) / tex - e);
  } else {
    const iv0 = Math.floor(s.vMin / tex + e);
    s.vBase = iv0 * tex;
    rows = Math.ceil(s.vMax / tex - e) - iv0;
  }
  if (rows < 2) rows = 2;
  s.h = rows + 2;
}

/** Final contract Chart of a placed spec. */
export function toChart(s: ChartSpec): Chart {
  const t = s.tex;
  const q = (v: number): number => Math.round(v * 1e9) / 1e9; // strip float noise (hash stability)
  let origin: Vec3;
  if (s.grid) origin = [-t, 0, -t];
  else {
    const a = s.uBase - t, b = s.vBase - t;
    origin = [q(s.o[0] + a * s.du[0] + b * s.dv[0]), q(s.o[1] + a * s.du[1] + b * s.dv[1]), q(s.o[2] + a * s.du[2] + b * s.dv[2])];
  }
  return {
    id: s.id, kind: s.kind, bakeGroup: s.group, x: s.x, y: s.y, w: s.w, h: s.h, origin,
    axisU: [q(s.du[0] * t), q(s.du[1] * t), q(s.du[2] * t)],
    axisV: [q(s.dv[0] * t), q(s.dv[1] * t), q(s.dv[2] * t)],
    normal: [s.nrm[0], s.nrm[1], s.nrm[2]], layer: s.layer, cont: s.cont,
  };
}

/** Continuous texel coordinates (from the chart rect corner, apron included) of a point. */
export function texCoord(s: ChartSpec, x: number, y: number, z: number, out: [number, number]): void {
  const dx = x - s.o[0], dy = y - s.o[1], dz = z - s.o[2];
  const u = dx * s.eu[0] + dy * s.eu[1] + dz * s.eu[2];
  const v = dx * s.ev[0] + dy * s.ev[1] + dz * s.ev[2];
  out[0] = (u - s.uBase) / s.tex + 1;
  out[1] = (v - s.vBase) / s.tex + 1;
}
