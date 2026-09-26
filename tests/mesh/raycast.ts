// tests/mesh/raycast.ts — brute-force-free ray casting against mesh triangles (2D bucket grid over xz), used by the
// WP5 coverage / partition tests.

import type { MeshBuffers } from '../../src/core/mesh.ts';

export interface Hit { t: number; tri: number; front: boolean; nx: number; ny: number; nz: number; u: number; w: number }

export class TriSoup {
  readonly v: number[] = []; // 9 per triangle, chunk-local metres
  readonly n: number[] = []; // 3 per triangle, geometric (winding) normal
  readonly layer: number[] = [];
  readonly uv: number[] = []; // 6 per triangle (material uv of the 3 corners)
  private buckets: Map<number, number[]> | null = null;
  readonly B = 0.6;

  /** Add every triangle of `m`, translated by (ox, 0, oz). */
  add(m: MeshBuffers | null, ox: number, oz: number): void {
    if (!m) return;
    const P = m.position, I = m.index;
    for (let t = 0; t < m.indexCount / 3; t++) {
      const k: number[] = [];
      for (let c = 0; c < 3; c++) { const i = I[t * 3 + c] * 3; k.push(P[i] + ox, P[i + 1], P[i + 2] + oz); }
      const e1 = [k[3] - k[0], k[4] - k[1], k[5] - k[2]], e2 = [k[6] - k[0], k[7] - k[1], k[8] - k[2]];
      const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
      const l = Math.hypot(n[0], n[1], n[2]) || 1;
      this.v.push(...k);
      this.n.push(n[0] / l, n[1] / l, n[2] / l);
      this.layer.push(m.layer[I[t * 3]]);
      for (let c = 0; c < 3; c++) this.uv.push(m.uv[I[t * 3 + c] * 2], m.uv[I[t * 3 + c] * 2 + 1]);
    }
    this.buckets = null;
  }

  get count(): number { return this.n.length / 3; }

  private key(i: number, j: number): number { return (i + 1000) * 4096 + (j + 1000); }

  private build(): Map<number, number[]> {
    const b = new Map<number, number[]>();
    for (let t = 0; t < this.count; t++) {
      const v = this.v;
      const x0 = Math.min(v[t * 9], v[t * 9 + 3], v[t * 9 + 6]), x1 = Math.max(v[t * 9], v[t * 9 + 3], v[t * 9 + 6]);
      const z0 = Math.min(v[t * 9 + 2], v[t * 9 + 5], v[t * 9 + 8]), z1 = Math.max(v[t * 9 + 2], v[t * 9 + 5], v[t * 9 + 8]);
      for (let j = Math.floor(z0 / this.B - 1e-6); j <= Math.floor(z1 / this.B + 1e-6); j++) {
        for (let i = Math.floor(x0 / this.B - 1e-6); i <= Math.floor(x1 / this.B + 1e-6); i++) {
          const k = this.key(i, j);
          let l = b.get(k);
          if (!l) b.set(k, (l = []));
          l.push(t);
        }
      }
    }
    return b;
  }

  /** Möller–Trumbore; hits on triangle edges count (eps). */
  private lastU = 0;
  private lastW = 0;
  private hitTri(t: number, o: number[], d: number[], tMax: number): number {
    const v = this.v, b = t * 9;
    const e1x = v[b + 3] - v[b], e1y = v[b + 4] - v[b + 1], e1z = v[b + 5] - v[b + 2];
    const e2x = v[b + 6] - v[b], e2y = v[b + 7] - v[b + 1], e2z = v[b + 8] - v[b + 2];
    const px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (Math.abs(det) < 1e-14) return Infinity;
    const inv = 1 / det;
    const sx = o[0] - v[b], sy = o[1] - v[b + 1], sz = o[2] - v[b + 2];
    const u = (sx * px + sy * py + sz * pz) * inv;
    if (u < -1e-7 || u > 1 + 1e-7) return Infinity;
    const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
    const w = (d[0] * qx + d[1] * qy + d[2] * qz) * inv;
    if (w < -1e-7 || u + w > 1 + 1e-7) return Infinity;
    const tt = (e2x * qx + e2y * qy + e2z * qz) * inv;
    this.lastU = u; this.lastW = w;
    return tt > 1e-6 && tt < tMax ? tt : Infinity;
  }

  /** Nearest hit along o + t*d (d need not be unit; t in units of |d|). */
  cast(o: number[], d: number[], tMax = 200): Hit | null {
    this.buckets ??= this.build();
    const B = this.B;
    let i = Math.floor(o[0] / B), j = Math.floor(o[2] / B);
    const si = d[0] > 0 ? 1 : -1, sj = d[2] > 0 ? 1 : -1;
    const tdx = Math.abs(d[0]) > 1e-12 ? B / Math.abs(d[0]) : Infinity, tdz = Math.abs(d[2]) > 1e-12 ? B / Math.abs(d[2]) : Infinity;
    let tx = Math.abs(d[0]) > 1e-12 ? ((d[0] > 0 ? (i + 1) * B - o[0] : o[0] - i * B) / Math.abs(d[0])) : Infinity;
    let tz = Math.abs(d[2]) > 1e-12 ? ((d[2] > 0 ? (j + 1) * B - o[2] : o[2] - j * B) / Math.abs(d[2])) : Infinity;
    let tEnter = 0;
    const seen = new Set<number>();
    let best = Infinity, bestT = -1, bu = 0, bw = 0;
    for (let step = 0; step < 4000 && tEnter < tMax; step++) {
      const l = this.buckets.get(this.key(i, j));
      if (l) {
        for (const t of l) {
          if (seen.has(t)) continue;
          seen.add(t);
          const h = this.hitTri(t, o, d, tMax);
          if (h < best) { best = h; bestT = t; bu = this.lastU; bw = this.lastW; }
        }
      }
      const tExit = Math.min(tx, tz);
      if (best <= tExit + 1e-9) break;
      tEnter = tExit;
      if (tx < tz) { i += si; tx += tdx; } else { j += sj; tz += tdz; }
    }
    if (bestT < 0) return null;
    const nx = this.n[bestT * 3], ny = this.n[bestT * 3 + 1], nz = this.n[bestT * 3 + 2];
    return { t: best, tri: bestT, front: nx * d[0] + ny * d[1] + nz * d[2] < 0, nx, ny, nz, u: bu, w: bw };
  }
}

/** Material uv at a hit (barycentric interpolation). */
export function hitUv(s: TriSoup, h: Hit): [number, number] {
  const b = h.tri * 6, a = 1 - h.u - h.w;
  return [a * s.uv[b] + h.u * s.uv[b + 2] + h.w * s.uv[b + 4], a * s.uv[b + 1] + h.u * s.uv[b + 3] + h.w * s.uv[b + 5]];
}
