// src/mesh/tjunction.ts — WP5 private: T-junction repair of the shell faces before they are written. Pure module.
//
// Faces are emitted per piece (door jambs next to headers, a HALF wall next to a WALL, faces split at the water line,
// greedy floor rects of different sizes, post sides next to wall faces ...), so a vertex of one face often lies in
// the middle of an edge of its neighbour. Rasterisers only guarantee watertight shared edges when both triangles use
// the same two end points; T-junctions leave sub-pixel pinholes that sparkle against the clear colour behind the
// shell. Every axis-aligned edge of every shell face therefore gets the vertices of other shell faces that lie
// inside it (same line, quantised to 0.1 mm; at least MIN_SEG from the ends and from each other). Material uv and
// lightmap sample positions are interpolated along the edge (both are affine on a planar face), so shading is
// unchanged. Faces that received vertices get a fan start that yields no degenerate triangle, or a centre-vertex fan
// when no such start exists (Face.fan). Charts are not affected: inserted vertices lie on existing edges.

import { BUF_SHELL, type Face } from './plan.ts';

const Q = 1e4; // 0.1 mm
// inserted vertices keep >= 2.5 mm from the edge ends and from each other: closer T-junctions leave no visible
// pinhole, and slivers would only add near-coincident triangles
const MIN_SEG = 0.0025;
const AXIS_EPS = 1e-7;
const MIN_AREA2 = 4e-9; // 2x the smallest accepted triangle area (tests: 1e-9 m^2)

/** Vertices bucketed by the line they lie on (two quantised fixed coordinates), chained in typed arrays. */
class LineIndex {
  private readonly head: Int32Array;
  private readonly next: Int32Array;
  private readonly ka: Int32Array;
  private readonly kb: Int32Array;
  private readonly val: Float64Array;
  private readonly mask: number;
  private n = 0;
  constructor(cap: number) {
    let size = 1024;
    while (size < cap * 2) size <<= 1;
    this.mask = size - 1;
    this.head = new Int32Array(size).fill(-1);
    this.next = new Int32Array(cap);
    this.ka = new Int32Array(cap);
    this.kb = new Int32Array(cap);
    this.val = new Float64Array(cap);
  }
  private slot(a: number, b: number): number { return (Math.imul(a, 0x9e3779b1) ^ Math.imul(b, 0x85ebca6b)) & this.mask; }
  add(a: number, b: number, v: number): void {
    const h = this.slot(a, b), i = this.n++;
    this.ka[i] = a; this.kb[i] = b; this.val[i] = v;
    this.next[i] = this.head[h];
    this.head[h] = i;
  }
  /** Values on line (a, b) inside [lo, hi] (unsorted, may repeat) appended to out. */
  collect(a: number, b: number, lo: number, hi: number, out: number[]): void {
    for (let i = this.head[this.slot(a, b)]; i >= 0; i = this.next[i]) {
      if (this.ka[i] !== a || this.kb[i] !== b) continue;
      const v = this.val[i];
      if (v >= lo && v <= hi) out.push(v);
    }
  }
}

const qi = (v: number): number => Math.round(v * Q);

/** Faces that take part: shell faces that own lightmap texels (walls, posts, reveals, caps, steps, soffits, floors,
 * ceilings, boxes, ramps). Borrowing faces (trims, T-bars, housings, plinths, pit sides) sit in front of or behind
 * those surfaces, so their vertices would only add hidden splits. */
const takesPart = (f: Face): boolean => f.buf === BUF_SHELL && f.own;

/** Twice the area of triangle (a, b, c) of the flat xyz array p. */
function area2(p: number[], a: number, b: number, c: number): number {
  const ux = p[b * 3] - p[a * 3], uy = p[b * 3 + 1] - p[a * 3 + 1], uz = p[b * 3 + 2] - p[a * 3 + 2];
  const vx = p[c * 3] - p[a * 3], vy = p[c * 3 + 1] - p[a * 3 + 1], vz = p[c * 3 + 2] - p[a * 3 + 2];
  const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
  return Math.sqrt(cx * cx + cy * cy + cz * cz);
}

/** Fan start k whose triangles (k, i, i+1) are all non-degenerate, or -1 (use a centre vertex). */
export function fanStart(p: number[]): number {
  const n = p.length / 3;
  for (let k = 0; k < n; k++) {
    let ok = true;
    for (let s = 1; s + 1 < n && ok; s++) {
      const i = (k + s) % n, j = (k + s + 1) % n;
      if (area2(p, k, i, j) < MIN_AREA2) ok = false;
    }
    if (ok) return k;
  }
  return -1;
}

/** Insert T-junction vertices into the shell faces (in place; sets Face.fan of the faces that changed). */
export function repairTJunctions(faces: readonly Face[]): void {
  let nv = 0;
  for (const f of faces) if (takesPart(f)) nv += f.p.length / 3;
  if (nv === 0) return;
  // lines along x (key y, z -> x), along y (key x, z -> y), along z (key x, y -> z)
  const lx = new LineIndex(nv), ly = new LineIndex(nv), lz = new LineIndex(nv);
  for (const f of faces) {
    if (!takesPart(f)) continue;
    const p = f.p;
    for (let i = 0; i + 2 < p.length; i += 3) {
      const x = p[i], y = p[i + 1], z = p[i + 2];
      const qx = qi(x), qy = qi(y), qz = qi(z);
      lx.add(qy, qz, x);
      ly.add(qx, qz, y);
      lz.add(qx, qy, z);
    }
  }
  const ins: number[] = [];
  for (const f of faces) {
    if (!takesPart(f)) continue;
    const p = f.p, n = p.length / 3;
    if (n < 3) continue;
    const uv = f.uv, lm = f.lm;
    let np: number[] | null = null, nuv: number[] | null = null, nlm: number[] | null = null;
    for (let i = 0; i < n; i++) {
      const j = i + 1 === n ? 0 : i + 1;
      if (np) {
        np.push(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]);
        nuv!.push(uv[i * 2] ?? 0, uv[i * 2 + 1] ?? 0);
        if (nlm && lm) nlm.push(lm[i * 3], lm[i * 3 + 1], lm[i * 3 + 2]);
      }
      const mx = Math.abs(p[j * 3] - p[i * 3]) > AXIS_EPS, my = Math.abs(p[j * 3 + 1] - p[i * 3 + 1]) > AXIS_EPS;
      const mz = Math.abs(p[j * 3 + 2] - p[i * 3 + 2]) > AXIS_EPS;
      const axis = mx && !my && !mz ? 0 : my && !mx && !mz ? 1 : mz && !mx && !my ? 2 : -1;
      if (axis < 0) continue;
      const v0 = p[i * 3 + axis], v1 = p[j * 3 + axis];
      const lo = Math.min(v0, v1), hi = Math.max(v0, v1);
      if (hi - lo < 2 * MIN_SEG) continue;
      ins.length = 0;
      if (axis === 0) lx.collect(qi(p[i * 3 + 1]), qi(p[i * 3 + 2]), lo + MIN_SEG, hi - MIN_SEG, ins);
      else if (axis === 1) ly.collect(qi(p[i * 3]), qi(p[i * 3 + 2]), lo + MIN_SEG, hi - MIN_SEG, ins);
      else lz.collect(qi(p[i * 3]), qi(p[i * 3 + 1]), lo + MIN_SEG, hi - MIN_SEG, ins);
      if (ins.length === 0) continue;
      // along the edge direction, >= MIN_SEG apart
      if (v1 > v0) ins.sort((a, b) => a - b);
      else ins.sort((a, b) => b - a);
      if (!np) {
        np = p.slice(0, (i + 1) * 3);
        nuv = [];
        for (let k = 0; k <= i; k++) nuv.push(uv[k * 2] ?? 0, uv[k * 2 + 1] ?? 0);
        nlm = lm ? lm.slice(0, (i + 1) * 3) : null;
      }
      const dv = v1 - v0;
      let last = v0;
      for (const v of ins) {
        if (Math.abs(v - last) < MIN_SEG) continue;
        last = v;
        const s = (v - v0) / dv;
        const x = axis === 0 ? v : p[i * 3], y = axis === 1 ? v : p[i * 3 + 1], z = axis === 2 ? v : p[i * 3 + 2];
        np.push(x, y, z);
        const ui = uv[i * 2] ?? 0, vi = uv[i * 2 + 1] ?? 0;
        nuv!.push(ui + s * ((uv[j * 2] ?? 0) - ui), vi + s * ((uv[j * 2 + 1] ?? 0) - vi));
        if (nlm && lm) {
          nlm.push(lm[i * 3] + s * (lm[j * 3] - lm[i * 3]), lm[i * 3 + 1] + s * (lm[j * 3 + 1] - lm[i * 3 + 1]),
            lm[i * 3 + 2] + s * (lm[j * 3 + 2] - lm[i * 3 + 2]));
        }
      }
    }
    if (!np) continue;
    f.p = np;
    f.uv = nuv!;
    if (lm) f.lm = nlm;
    f.fan = fanStart(np);
  }
}
