// src/bake/dilate.ts — chart-local dilation of invalid texels and gutters (WP7 §Algorithms 12). Pure module.
// Invalid texels inside a chart rect: DILATE_PASSES passes; in each pass every unfilled texel takes the average of
// its already-filled 8-neighbours of the SAME chart (Jacobi order, so the result does not depend on iteration
// order; done as a frontier walk). Texels still unfilled afterwards get their chart's mean.
// LM_PAD gutter texels around a chart (never sampled by bilinear lookups inside the chart, which stop at the
// apron) copy the nearest chart texel: a nearest-neighbour dilation, cheap and seam-free for mip-free sampling.
//
// Side-aware dilation on grid charts (leak-freedom): an invalid texel in a SOLID / blocker / VOID cell is sampled
// by the bilinear footprint of floor points of EVERY walkable cell whose face on the cell line has no thickness.
// At a corner of such a cell its 8-neighbours can come from two cells that are separated by an occluding edge
// (room A west of the block, room B north of it, a wall between A and B ending at the block): averaging them would
// carry A's light into B's floor corner. Every filled texel therefore remembers its source cell ("side"); when the
// neighbours' sides are not locally connected (4-adjacent through an edge open at the surface height, diagonal
// through an open L-path), only the darkest connected group is averaged (a dark corner, never a bright leak).

import { CellFlag } from '../core/ids.ts';
import type { TexelSet } from './context.ts';
import { TX_GUTTER, TX_INVALID, TX_VALID } from './context.ts';
import { crossX, crossZ } from './dda.ts';
import type { VisGrid } from './visgrid.ts';

export const DILATE_PASSES = 4;

/** Channel arrays with their component counts (per compact texel). */
export interface Channels { arrs: Float32Array[]; comps: number[] }

const nbr = new Int32Array(8);
const sides = new Int32Array(8);
const comp = new Int32Array(8);
const compLum = new Float64Array(8);
const compCnt = new Int32Array(8);

/** Are 4-adjacent halo cells a and b connected at the grid surface height (floor + 0.05 / ceiling - 0.05)? */
function link4(g: VisGrid, a: number, b: number, ceil: boolean): boolean {
  if (((g.flags[a] | g.flags[b]) & CellFlag.SOLID) !== 0 || g.group[a] !== g.group[b]) return false;
  const n = g.n;
  const y = ceil ? Math.min(g.ceil[a], g.ceil[b]) - 0.05 : Math.max(g.floor[a], g.floor[b]) + 0.05;
  const ai = a % n, aj = (a - ai) / n, bi = b % n, bj = (b - bi) / n;
  if (aj === bj) return !crossX(g, ai > bi ? ai : bi, aj, 0.5, y);
  return !crossZ(g, aj > bj ? aj : bj, ai, 0.5, y);
}
/** Local connectivity of two source cells (identical, 4-adjacent or diagonal through an open L-path). */
export function sidesLinked(g: VisGrid, a: number, b: number, ceil: boolean): boolean {
  if (a === b) return true;
  const n = g.n;
  const ai = a % n, aj = (a - ai) / n, bi = b % n, bj = (b - bi) / n;
  const dx = bi - ai, dz = bj - aj;
  if (dx < -1 || dx > 1 || dz < -1 || dz > 1) return false;
  if (dx === 0 || dz === 0) return link4(g, a, b, ceil);
  const m1 = aj * n + bi, m2 = bj * n + ai;
  return (link4(g, a, m1, ceil) && link4(g, m1, b, ceil)) || (link4(g, a, m2, ceil) && link4(g, m2, b, ceil));
}

/**
 * Keep only the darkest locally connected group of the `cnt` neighbours in `nbr` (grid charts; see the header).
 * `side`: source cell per texel; `lumArr`: RGB array whose luminance ranks the groups. Returns the new count and
 * writes the chosen group's source cell to `pickedSide.v`.
 */
const pickedSide = { v: -1 };
function sideFilter(g: VisGrid, side: Int32Array, lumArr: Float32Array, cnt: number, ceil: boolean): number {
  let ns = 0;
  for (let i = 0; i < cnt; i++) {
    const sd = side[nbr[i]];
    let k = 0;
    while (k < ns && sides[k] !== sd) k++;
    if (k === ns) sides[ns++] = sd;
  }
  pickedSide.v = sides[0];
  if (ns <= 1) return cnt;
  // connected components of the distinct sides (tiny: <= 8)
  for (let k = 0; k < ns; k++) comp[k] = k;
  for (let a = 0; a < ns; a++) {
    for (let b = a + 1; b < ns; b++) {
      if (comp[a] === comp[b] || !sidesLinked(g, sides[a], sides[b], ceil)) continue;
      const from = comp[b], to = comp[a];
      for (let k = 0; k < ns; k++) if (comp[k] === from) comp[k] = to;
    }
  }
  let multi = false;
  for (let k = 1; k < ns; k++) if (comp[k] !== comp[0]) { multi = true; break; }
  let minSide = sides[0];
  for (let k = 1; k < ns; k++) if (sides[k] < minSide) minSide = sides[k];
  if (!multi) { pickedSide.v = minSide; return cnt; }
  compLum.fill(0, 0, ns); compCnt.fill(0, 0, ns);
  for (let i = 0; i < cnt; i++) {
    const s = nbr[i], sd = side[s];
    let k = 0;
    while (sides[k] !== sd) k++;
    const cp = comp[k];
    compLum[cp] += 0.2126 * lumArr[s * 3] + 0.7152 * lumArr[s * 3 + 1] + 0.0722 * lumArr[s * 3 + 2];
    compCnt[cp]++;
  }
  // darkest group (mean luminance); ties -> the group holding the smallest source cell (deterministic)
  let best = -1, bestLum = Infinity, bestSide = 0;
  for (let cp = 0; cp < ns; cp++) {
    if (compCnt[cp] === 0) continue;
    let ms = Infinity;
    for (let k = 0; k < ns; k++) if (comp[k] === cp && sides[k] < ms) ms = sides[k];
    const m = compLum[cp] / compCnt[cp];
    if (m < bestLum || (m === bestLum && ms < bestSide)) { best = cp; bestLum = m; bestSide = ms; }
  }
  let m = 0;
  for (let i = 0; i < cnt; i++) {
    const sd = side[nbr[i]];
    let k = 0;
    while (sides[k] !== sd) k++;
    if (comp[k] === best) nbr[m++] = nbr[i];
  }
  pickedSide.v = bestSide;
  return m;
}

/**
 * `g` (optional): the bake's VisGrid; enables side-aware dilation on grid charts (ch.arrs[0] must be the RGB
 * irradiance used to rank the sides).
 */
export function dilate(T: TexelSet, ch: Channels, nCharts: number, g: VisGrid | null = null): void {
  const n = T.n, W = T.atlasW, H = T.atlasH;
  const nA = ch.arrs.length;
  // Jacobi passes done as a breadth-first layering (identical result): layer[t] = pass in which t gets filled
  // (1 = valid). A texel of layer k averages its same-chart 8-neighbours of layers < k.
  const layer = new Uint8Array(n);
  const side = g ? new Int32Array(n).fill(-1) : null;
  if (side) for (let t = 0; t < n; t++) if (T.state[t] === TX_VALID) side[t] = T.cell[t];
  let nTodo = 0;
  for (let t = 0; t < n; t++) { if (T.state[t] === TX_VALID) layer[t] = 1; else if (T.state[t] === TX_INVALID) nTodo++; }
  let front = new Int32Array(nTodo), next = new Int32Array(nTodo);
  const filledNow = new Int32Array(nTodo);
  const queued = new Uint8Array(n); // candidate stamp of the next pass
  let nf = 0;
  for (let t = 0; t < n; t++) if (T.state[t] === TX_INVALID) front[nf++] = t;
  for (let pass = 0; pass < DILATE_PASSES && nf > 0; pass++) {
    const cur = pass + 2; // layer value assigned in this pass
    let nd = 0;
    for (let q = 0; q < nf; q++) {
      const t = front[q];
      const ai = T.atlas[t];
      const ax = ai % W, ay = (ai - ax) / W;
      const chart = T.chart[t];
      let cnt = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = ay + dy;
        if (yy < 0 || yy >= H) continue;
        const row = yy * W;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = ax + dx;
          if ((dx === 0 && dy === 0) || xx < 0 || xx >= W) continue;
          const s = T.map[row + xx];
          if (s >= 0 && layer[s] !== 0 && layer[s] < cur && T.chart[s] === chart) nbr[cnt++] = s;
        }
      }
      if (cnt === 0) continue;
      if (g && side && T.grid[chart] !== 0) {
        cnt = sideFilter(g, side, ch.arrs[0], cnt, T.grid[chart] === 2);
        side[t] = pickedSide.v;
      }
      const inv = 1 / cnt;
      for (let a = 0; a < nA; a++) {
        const arr = ch.arrs[a], c = ch.comps[a];
        for (let k = 0; k < c; k++) {
          let sum = 0;
          for (let i = 0; i < cnt; i++) sum += arr[nbr[i] * c + k];
          arr[t * c + k] = sum * inv;
        }
      }
      layer[t] = cur;
      filledNow[nd++] = t;
    }
    // next candidates: unfilled same-chart neighbours of the texels filled in this pass (frontier)
    let nn = 0;
    for (let q = 0; q < nd; q++) {
      const t = filledNow[q];
      const ai = T.atlas[t];
      const ax = ai % W, ay = (ai - ax) / W;
      const chart = T.chart[t];
      for (let dy = -1; dy <= 1; dy++) {
        const yy = ay + dy;
        if (yy < 0 || yy >= H) continue;
        const row = yy * W;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = ax + dx;
          if (xx < 0 || xx >= W) continue;
          const s = T.map[row + xx];
          if (s >= 0 && layer[s] === 0 && queued[s] !== cur && T.chart[s] === chart && T.state[s] === TX_INVALID) { queued[s] = cur; next[nn++] = s; }
        }
      }
    }
    const tmp = front; front = next; next = tmp;
    nf = nn;
  }
  // invalid texels never reached get their chart's mean
  let nLeft = 0;
  for (let t = 0; t < n; t++) if (layer[t] === 0 && T.state[t] === TX_INVALID) next[nLeft++] = t;
  if (nLeft > 0) chartMeans(T, ch, nCharts, next, nLeft);
  // gutters (outside the chart rect, never sampled by in-chart bilinear lookups): copy the nearest chart texel
  for (let t = 0; t < n; t++) {
    if (T.state[t] !== TX_GUTTER) continue;
    const u = T.u[t], v = T.v[t], c = T.chart[t];
    const ai = T.atlas[t];
    const ax = ai % W, ay = (ai - ax) / W;
    const uc = u < 0 ? 0 : u >= T.chartW[c] ? T.chartW[c] - 1 : u;
    const vc = v < 0 ? 0 : v >= T.chartH[c] ? T.chartH[c] - 1 : v;
    const s = T.map[(ay - v + vc) * W + (ax - u + uc)];
    if (s < 0 || T.chart[s] !== c) continue;
    for (let a = 0; a < nA; a++) {
      const arr = ch.arrs[a], cc = ch.comps[a];
      for (let k = 0; k < cc; k++) arr[t * cc + k] = arr[s * cc + k];
    }
  }
}

function chartMeans(T: TexelSet, ch: Channels, nCharts: number, todo: Int32Array, nTodo: number): void {
  const n = T.n, nA = ch.arrs.length;
  // chart means for the rest
  const sums = ch.arrs.map((_, a) => new Float64Array(nCharts * ch.comps[a]));
  const cnts = new Float64Array(nCharts);
  const need = new Uint8Array(nCharts);
  for (let q = 0; q < nTodo; q++) need[T.chart[todo[q]]] = 1;
  for (let t = 0; t < n; t++) {
    if (T.state[t] !== TX_VALID) continue;
    const c0 = T.chart[t];
    if (need[c0] === 0) continue;
    cnts[c0]++;
    for (let a = 0; a < nA; a++) {
      const c = ch.comps[a];
      for (let k = 0; k < c; k++) sums[a][c0 * c + k] += ch.arrs[a][t * c + k];
    }
  }
  for (let q = 0; q < nTodo; q++) {
    const t = todo[q], c0 = T.chart[t];
    const inv = cnts[c0] > 0 ? 1 / cnts[c0] : 0;
    for (let a = 0; a < nA; a++) {
      const c = ch.comps[a];
      for (let k = 0; k < c; k++) ch.arrs[a][t * c + k] = sums[a][c0 * c + k] * inv;
    }
  }
}
