// src/core/writer.ts — GeometryWriter: the seam between the architecture mesher (WP5) and prop/fixture/
// structure emitters (WP6). Fully implemented in WP0 (pure, growable typed arrays, no three).
// Usage: w.setState(layer, flags, tint, emit, aux); w.setTransform(yaw, scale, tx, ty, tz);
//        const a = w.vertex(...); ...; w.quad(a, b, c, d); const buf = w.finish();

import type { MeshBuffers } from './mesh.ts';

/** Pack rgba bytes (0..255) into a uint32 (r in the low byte). */
export const packRGBA = (r: number, g: number, b: number, a: number): number =>
  ((r & 255) | ((g & 255) << 8) | ((b & 255) << 16) | ((a & 255) << 24)) >>> 0;
export const WHITE = packRGBA(255, 255, 255, 0);

export class GeometryWriter {
  private cap: number;
  private icap: number;
  private n = 0;
  private ni = 0;
  private pos: Float32Array;
  private nor: Int8Array;
  private uv: Float32Array;
  private lm: Float32Array;
  private layer: Uint8Array;
  private flags: Uint8Array;
  private tint: Uint8Array;
  private emit: Float32Array;
  private aux: Uint8Array;
  private idx: Uint32Array;
  // state
  private sLayer = 0;
  private sFlags = 0;
  private sTint = WHITE;
  private sEmit = 0;
  private sAux = 0;
  // transform: rotation about Y (cos, sin), uniform scale, translation
  private tc = 1;
  private ts = 0;
  private tk = 1;
  private tx = 0;
  private ty = 0;
  private tz = 0;
  private min: [number, number, number] = [Infinity, Infinity, Infinity];
  private max: [number, number, number] = [-Infinity, -Infinity, -Infinity];

  constructor(initialVertices = 4096) {
    this.cap = initialVertices;
    this.icap = initialVertices * 2;
    this.pos = new Float32Array(this.cap * 3);
    this.nor = new Int8Array(this.cap * 4);
    this.uv = new Float32Array(this.cap * 2);
    this.lm = new Float32Array(this.cap * 2);
    this.layer = new Uint8Array(this.cap);
    this.flags = new Uint8Array(this.cap);
    this.tint = new Uint8Array(this.cap * 4);
    this.emit = new Float32Array(this.cap);
    this.aux = new Uint8Array(this.cap * 4);
    this.idx = new Uint32Array(this.icap);
  }

  get vertexCount(): number { return this.n; }
  get indexCount(): number { return this.ni; }

  setState(layer: number, flags: number, tint: number = WHITE, emit = 0, aux = 0): void {
    this.sLayer = layer; this.sFlags = flags; this.sTint = tint; this.sEmit = emit; this.sAux = aux;
  }
  /** Subsequent vertices: p' = R_y(yaw) * (p * scale) + t ; n' = R_y(yaw) * n. yaw 0 = identity. */
  setTransform(yaw: number, scale: number, tx: number, ty: number, tz: number): void {
    this.tc = Math.cos(yaw); this.ts = Math.sin(yaw); this.tk = scale; this.tx = tx; this.ty = ty; this.tz = tz;
  }
  resetTransform(): void { this.setTransform(0, 1, 0, 0, 0); }

  /** Returns the vertex index. (u,v) material uv, (lu,lv) lightmap uv. Normal need not be normalised. */
  vertex(px: number, py: number, pz: number, nx: number, ny: number, nz: number, u: number, v: number, lu = 0, lv = 0): number {
    if (this.n === this.cap) this.growV();
    const i = this.n++;
    const k = this.tk, c = this.tc, s = this.ts;
    // R_y(yaw): x' = c*x + s*z ; z' = -s*x + c*z  (positive yaw turns +X toward -Z, i.e. counter-clockwise from above)
    const x = (c * px + s * pz) * k + this.tx;
    const y = py * k + this.ty;
    const z = (-s * px + c * pz) * k + this.tz;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    const rnx = c * nx + s * nz, rnz = -s * nx + c * nz;
    const len = Math.hypot(rnx, ny, rnz) || 1;
    this.nor[i * 4] = Math.round((rnx / len) * 127);
    this.nor[i * 4 + 1] = Math.round((ny / len) * 127);
    this.nor[i * 4 + 2] = Math.round((rnz / len) * 127);
    this.nor[i * 4 + 3] = 0;
    this.uv[i * 2] = u; this.uv[i * 2 + 1] = v;
    this.lm[i * 2] = lu; this.lm[i * 2 + 1] = lv;
    this.layer[i] = this.sLayer;
    this.flags[i] = this.sFlags;
    const t = this.sTint, a = this.sAux;
    this.tint[i * 4] = t & 255; this.tint[i * 4 + 1] = (t >>> 8) & 255; this.tint[i * 4 + 2] = (t >>> 16) & 255; this.tint[i * 4 + 3] = (t >>> 24) & 255;
    this.aux[i * 4] = a & 255; this.aux[i * 4 + 1] = (a >>> 8) & 255; this.aux[i * 4 + 2] = (a >>> 16) & 255; this.aux[i * 4 + 3] = (a >>> 24) & 255;
    this.emit[i] = this.sEmit;
    if (x < this.min[0]) this.min[0] = x; if (y < this.min[1]) this.min[1] = y; if (z < this.min[2]) this.min[2] = z;
    if (x > this.max[0]) this.max[0] = x; if (y > this.max[1]) this.max[1] = y; if (z > this.max[2]) this.max[2] = z;
    return i;
  }

  /** Counter-clockwise (front face) triangle as seen from the side the normal points to. */
  tri(a: number, b: number, c: number): void {
    if (this.ni + 3 > this.icap) this.growI();
    this.idx[this.ni++] = a; this.idx[this.ni++] = b; this.idx[this.ni++] = c;
  }
  /** Quad a-b-c-d counter-clockwise => triangles (a,b,c) (a,c,d). */
  quad(a: number, b: number, c: number, d: number): void { this.tri(a, b, c); this.tri(a, c, d); }

  finish(): MeshBuffers {
    const n = this.n, ni = this.ni;
    const empty = n === 0;
    return {
      position: this.pos.slice(0, n * 3), normal: this.nor.slice(0, n * 4), uv: this.uv.slice(0, n * 2),
      lmUv: this.lm.slice(0, n * 2), layer: this.layer.slice(0, n), flags: this.flags.slice(0, n),
      tint: this.tint.slice(0, n * 4), emit: this.emit.slice(0, n), aux: this.aux.slice(0, n * 4),
      index: this.idx.slice(0, ni), vertexCount: n, indexCount: ni,
      bounds: empty ? [0, 0, 0, 0, 0, 0] : [this.min[0], this.min[1], this.min[2], this.max[0], this.max[1], this.max[2]],
    };
  }

  private growV(): void {
    const c = this.cap * 2;
    const g = <T extends Float32Array | Int8Array | Uint8Array>(a: T, per: number, make: (n: number) => T): T => {
      const b = make(c * per); b.set(a); return b;
    };
    this.pos = g(this.pos, 3, (k) => new Float32Array(k));
    this.nor = g(this.nor, 4, (k) => new Int8Array(k));
    this.uv = g(this.uv, 2, (k) => new Float32Array(k));
    this.lm = g(this.lm, 2, (k) => new Float32Array(k));
    this.layer = g(this.layer, 1, (k) => new Uint8Array(k));
    this.flags = g(this.flags, 1, (k) => new Uint8Array(k));
    this.tint = g(this.tint, 4, (k) => new Uint8Array(k));
    this.emit = g(this.emit, 1, (k) => new Float32Array(k));
    this.aux = g(this.aux, 4, (k) => new Uint8Array(k));
    this.cap = c;
  }
  private growI(): void {
    const b = new Uint32Array(this.icap * 2); b.set(this.idx); this.idx = b; this.icap *= 2;
  }
}
