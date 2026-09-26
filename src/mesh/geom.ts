// src/mesh/geom.ts — WP5 private: small 2D rectangle/polygon helpers used by the mesher. Pure module.
// Rects are flat number arrays of (t0, t1, y0, y1) quadruples (the edgePieces layout).

const EPS = 1e-6;

function uniqSorted(v: number[]): number[] {
  v.sort((a, b) => a - b);
  const out: number[] = [];
  for (const x of v) if (out.length === 0 || x - out[out.length - 1] > EPS) out.push(x);
  return out;
}

/** Rect region [t0,t1]x[y0,y1] minus the union of `n` rects in `r` (quadruples). Output: merged quadruples. */
export function subtractRects(t0: number, t1: number, y0: number, y1: number, r: ArrayLike<number>, n: number): number[] {
  if (t1 - t0 <= EPS || y1 - y0 <= EPS) return [];
  const ts = [t0, t1], ys = [y0, y1];
  for (let i = 0; i < n; i++) {
    const a = r[i * 4], b = r[i * 4 + 1], c = r[i * 4 + 2], d = r[i * 4 + 3];
    if (b <= t0 + EPS || a >= t1 - EPS || d <= y0 + EPS || c >= y1 - EPS) continue;
    if (a > t0 && a < t1) ts.push(a);
    if (b > t0 && b < t1) ts.push(b);
    if (c > y0 && c < y1) ys.push(c);
    if (d > y0 && d < y1) ys.push(d);
  }
  const T = uniqSorted(ts), Y = uniqSorted(ys);
  const nt = T.length - 1, ny = Y.length - 1;
  const free = new Uint8Array(nt * ny);
  for (let j = 0; j < ny; j++) {
    const ym = (Y[j] + Y[j + 1]) / 2;
    for (let i = 0; i < nt; i++) {
      const tm = (T[i] + T[i + 1]) / 2;
      let cov = false;
      for (let k = 0; k < n && !cov; k++) cov = tm > r[k * 4] && tm < r[k * 4 + 1] && ym > r[k * 4 + 2] && ym < r[k * 4 + 3];
      free[j * nt + i] = cov ? 0 : 1;
    }
  }
  // row segments, then vertical merge of identical segments
  const out: number[] = [];
  let open: number[] = []; // quadruples being extended upward
  for (let j = 0; j < ny; j++) {
    const segs: number[] = [];
    let i = 0;
    while (i < nt) {
      if (!free[j * nt + i]) { i++; continue; }
      let k = i;
      while (k < nt && free[j * nt + k]) k++;
      segs.push(T[i], T[k]);
      i = k;
    }
    const next: number[] = [];
    const used = new Uint8Array(segs.length / 2);
    for (let o = 0; o < open.length; o += 4) {
      let ext = false;
      for (let s = 0; s < segs.length; s += 2) {
        if (!used[s / 2] && Math.abs(segs[s] - open[o]) < EPS && Math.abs(segs[s + 1] - open[o + 1]) < EPS) {
          used[s / 2] = 1; next.push(open[o], open[o + 1], open[o + 2], Y[j + 1]); ext = true; break;
        }
      }
      if (!ext) out.push(open[o], open[o + 1], open[o + 2], open[o + 3]);
    }
    for (let s = 0; s < segs.length; s += 2) if (!used[s / 2]) next.push(segs[s], segs[s + 1], Y[j], Y[j + 1]);
    open = next;
  }
  for (let o = 0; o < open.length; o += 4) out.push(open[o], open[o + 1], open[o + 2], open[o + 3]);
  return out;
}

/** Boundary of the union of rects inside the domain [tLo,tHi]x[yLo,yHi], excluding the domain border.
 * Horizontal segments: (y, t0, t1, dir) with dir +1 = top cap (solid below), -1 = underside.
 * Vertical segments: (t, y0, y1, dir) with dir +1 = reveal facing +t (solid on the -t side), -1 = facing -t. */
export function unionBoundary(r: ArrayLike<number>, n: number, tLo: number, tHi: number, yLo: number, yHi: number): { h: number[]; v: number[] } {
  const ts = [tLo, tHi], ys = [yLo, yHi];
  for (let i = 0; i < n; i++) {
    ts.push(Math.min(tHi, Math.max(tLo, r[i * 4])), Math.min(tHi, Math.max(tLo, r[i * 4 + 1])));
    ys.push(Math.min(yHi, Math.max(yLo, r[i * 4 + 2])), Math.min(yHi, Math.max(yLo, r[i * 4 + 3])));
  }
  const T = uniqSorted(ts), Y = uniqSorted(ys);
  const nt = T.length - 1, ny = Y.length - 1;
  const cov = new Uint8Array(Math.max(0, nt * ny));
  for (let j = 0; j < ny; j++) {
    const ym = (Y[j] + Y[j + 1]) / 2;
    for (let i = 0; i < nt; i++) {
      const tm = (T[i] + T[i + 1]) / 2;
      let c = 0;
      for (let k = 0; k < n && !c; k++) c = tm > r[k * 4] && tm < r[k * 4 + 1] && ym > r[k * 4 + 2] && ym < r[k * 4 + 3] ? 1 : 0;
      cov[j * nt + i] = c;
    }
  }
  const h: number[] = [], v: number[] = [];
  for (let j = 1; j < ny; j++) {
    let i = 0;
    while (i < nt) {
      const below = cov[(j - 1) * nt + i], above = cov[j * nt + i];
      const dir = below && !above ? 1 : !below && above ? -1 : 0;
      if (!dir) { i++; continue; }
      let k = i + 1;
      while (k < nt) {
        const b2 = cov[(j - 1) * nt + k], a2 = cov[j * nt + k];
        if ((b2 && !a2 ? 1 : !b2 && a2 ? -1 : 0) !== dir) break;
        k++;
      }
      h.push(Y[j], T[i], T[k], dir);
      i = k;
    }
  }
  for (let i = 1; i < nt; i++) {
    let j = 0;
    while (j < ny) {
      const left = cov[j * nt + i - 1], right = cov[j * nt + i];
      const dir = left && !right ? 1 : !left && right ? -1 : 0;
      if (!dir) { j++; continue; }
      let k = j + 1;
      while (k < ny) {
        const l2 = cov[k * nt + i - 1], r2 = cov[k * nt + i];
        if ((l2 && !r2 ? 1 : !l2 && r2 ? -1 : 0) !== dir) break;
        k++;
      }
      v.push(T[i], Y[j], Y[k], dir);
      j = k;
    }
  }
  return { h, v };
}

/** Merge [a,b] intervals (flat pairs) that overlap or touch. */
export function mergeIntervals(iv: number[]): number[] {
  const pairs: [number, number][] = [];
  for (let i = 0; i < iv.length; i += 2) if (iv[i + 1] - iv[i] > EPS) pairs.push([iv[i], iv[i + 1]]);
  pairs.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  const out: number[] = [];
  for (const [a, b] of pairs) {
    if (out.length && a <= out[out.length - 1] + 1e-5) out[out.length - 1] = Math.max(out[out.length - 1], b);
    else out.push(a, b);
  }
  return out;
}

/** Clip a convex polygon (flat xyz, plus parallel flat uv with `uvStride` values per vertex) against the
 * half-space sgn*(p[axis] - c) >= 0. Returns new arrays. */
export function clipPoly(p: number[], uv: number[], uvStride: number, axis: number, c: number, sgn: number): [number[], number[]] {
  const n = p.length / 3;
  const op: number[] = [], ou: number[] = [];
  if (n === 0) return [op, ou];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const di = sgn * (p[i * 3 + axis] - c), dj = sgn * (p[j * 3 + axis] - c);
    if (di >= 0) {
      op.push(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]);
      for (let k = 0; k < uvStride; k++) ou.push(uv[i * uvStride + k]);
    }
    if ((di >= 0) !== (dj >= 0)) {
      const f = di / (di - dj);
      op.push(p[i * 3] + (p[j * 3] - p[i * 3]) * f, p[i * 3 + 1] + (p[j * 3 + 1] - p[i * 3 + 1]) * f, p[i * 3 + 2] + (p[j * 3 + 2] - p[i * 3 + 2]) * f);
      for (let k = 0; k < uvStride; k++) ou.push(uv[i * uvStride + k] + (uv[j * uvStride + k] - uv[i * uvStride + k]) * f);
    }
  }
  return [op, ou];
}

/** Polygon area (flat xyz). */
export function polyArea(p: number[]): number {
  let x = 0, y = 0, z = 0;
  const n = p.length / 3;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = p[i * 3], ay = p[i * 3 + 1], az = p[i * 3 + 2], bx = p[j * 3], by = p[j * 3 + 1], bz = p[j * 3 + 2];
    x += ay * bz - az * by; y += az * bx - ax * bz; z += ax * by - ay * bx;
  }
  return Math.hypot(x, y, z) / 2;
}

/** Greedy rectangles over a W x H grid of keys (-1 = empty). Returns flat (i0, j0, i1, j1, key) tuples. */
export function greedyRects(keys: Int32Array | number[], W: number, H: number): number[] {
  const used = new Uint8Array(W * H);
  const out: number[] = [];
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const k = keys[j * W + i];
      if (k < 0 || used[j * W + i]) continue;
      let i1 = i + 1;
      while (i1 < W && !used[j * W + i1] && keys[j * W + i1] === k) i1++;
      let j1 = j + 1;
      outer: while (j1 < H) {
        for (let x = i; x < i1; x++) if (used[j1 * W + x] || keys[j1 * W + x] !== k) break outer;
        j1++;
      }
      for (let y = j; y < j1; y++) for (let x = i; x < i1; x++) used[y * W + x] = 1;
      out.push(i, j, i1, j1, k);
    }
  }
  return out;
}

/** Split a convex polygon (flat xyz + parallel uv) at the cell lines x = k*cell and z = k*cell inside [0, size]^2
 * (tile-local); pieces outside the tile are dropped (an axis along which the polygon is flat is not split).
 * Returns [p, uv] pairs. */
export function splitByCells(p: number[], uv: number[], uvStride: number, cell: number, size: number): [number[], number[]][] {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < p.length; i += 3) {
    minX = Math.min(minX, p[i]); maxX = Math.max(maxX, p[i]);
    minZ = Math.min(minZ, p[i + 2]); maxZ = Math.max(maxZ, p[i + 2]);
  }
  const n = Math.round(size / cell);
  const flatX = maxX - minX <= 1e-9, flatZ = maxZ - minZ <= 1e-9;
  const c0 = flatX ? 0 : Math.max(0, Math.floor(minX / cell + 1e-7)), c1 = flatX ? 0 : Math.min(n - 1, Math.floor(maxX / cell - 1e-7));
  const r0 = flatZ ? 0 : Math.max(0, Math.floor(minZ / cell + 1e-7)), r1 = flatZ ? 0 : Math.min(n - 1, Math.floor(maxZ / cell - 1e-7));
  const out: [number[], number[]][] = [];
  for (let ci = c0; ci <= c1; ci++) {
    let px = p, ux = uv;
    if (!flatX) {
      [px, ux] = clipPoly(px, ux, uvStride, 0, ci * cell, 1);
      [px, ux] = clipPoly(px, ux, uvStride, 0, (ci + 1) * cell, -1);
    }
    if (px.length < 9) continue;
    for (let cj = r0; cj <= r1; cj++) {
      let pz = px, uz = ux;
      if (!flatZ) {
        [pz, uz] = clipPoly(pz, uz, uvStride, 2, cj * cell, 1);
        [pz, uz] = clipPoly(pz, uz, uvStride, 2, (cj + 1) * cell, -1);
      }
      if (pz.length < 9 || polyArea(pz) < 1e-8) continue;
      out.push([pz, uz]);
    }
  }
  return out;
}
