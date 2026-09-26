// src/audio/propagation.ts — Dijkstra sound propagation over the passability grid (pure).
//
// propagate(): shortest paths from the listener's cell over a (2R+1)^2 window of global cells. Moves are 4-connected
// between walkable cells across edges whose sound transmission (EDGE_SOUND via WorldQuery.edgeSound) is > 0, each
// costing 1 cell. With unit costs Dijkstra is exactly a breadth-first search, which is what runs (ring-buffer queue,
// no allocation after the first call). Among equal-length paths the one with the fewest bends (direction changes)
// wins, so `prev` chains are straight corridor runs joined at real corners and `bends` counts corners.
//   field.dist[k]  path length in CELLS (Infinity = unreachable within the window)
//   field.prev[k]  window index of the previous cell towards the listener (-1 at the listener / unreached)
//   field.bends[k] corners along that path (saturating at 255)
//   window index k = (gj - gj0) * size + (gi - gi0)
//
// resolveSource(): the §5 WP13 source placement rule (line of sight / portal / through-the-wall) as a pure function
// of the field and a sight test, so it is unit-testable without a world.

import { CELL } from '../core/constants.ts';

export interface PropagationGrid { walkable(gi: number, gj: number): boolean; edge(axis: 'x' | 'z', gi: number, gj: number): number }
export interface PropagationField { dist: Float32Array; prev: Int32Array; bends: Uint8Array; size: number; gi0: number; gj0: number }

/** Listener-window radius in cells (§5 WP13: "within 24 cells of the listener"). */
export const PROPAGATION_RADIUS = 24;

export function createPropagationField(radius: number = PROPAGATION_RADIUS): PropagationField {
  const size = 2 * radius + 1;
  const n = size * size;
  const f: PropagationField = { dist: new Float32Array(n), prev: new Int32Array(n), bends: new Uint8Array(n), size, gi0: 0, gj0: 0 };
  f.dist.fill(Infinity);
  f.prev.fill(-1);
  return f;
}

let queue = new Int32Array(0);
let dirIn = new Int8Array(0);

export function propagate(grid: PropagationGrid, listener: [number, number], radius: number, out: PropagationField): void {
  const r = Math.max(0, Math.floor(radius));
  let size = Math.min(Math.floor(Math.sqrt(out.dist.length)), 2 * r + 1);
  if ((size & 1) === 0) size--;
  out.size = size;
  const n = size * size;
  const rr = (size - 1) >> 1;
  out.gi0 = listener[0] - rr;
  out.gj0 = listener[1] - rr;
  out.dist.fill(Infinity);
  out.prev.fill(-1);
  out.bends.fill(0);
  if (size <= 0) return;
  if (queue.length < n) { queue = new Int32Array(n); dirIn = new Int8Array(n); }
  const { dist, prev, bends } = out;
  const gi0 = out.gi0, gj0 = out.gj0;
  const start = rr * size + rr;
  dist[start] = 0;
  dirIn[start] = -1;
  let head = 0, tail = 0;
  queue[tail++] = start;
  while (head < tail) {
    const p = queue[head++];
    const pi = p % size, pj = (p - pi) / size;
    const gi = gi0 + pi, gj = gj0 + pj;
    const dp = dist[p] + 1;
    const dIn = dirIn[p];
    const bp = bends[p];
    for (let d = 0; d < 4; d++) {
      let ni = pi, nj = pj, e: number;
      // 0 +x, 1 -x, 2 +z, 3 -z; edge between the two cells (core/grid.ts line conventions)
      if (d === 0) { ni++; if (ni >= size) continue; e = grid.edge('x', gi + 1, gj); }
      else if (d === 1) { ni--; if (ni < 0) continue; e = grid.edge('x', gi, gj); }
      else if (d === 2) { nj++; if (nj >= size) continue; e = grid.edge('z', gi, gj + 1); }
      else { nj--; if (nj < 0) continue; e = grid.edge('z', gi, gj); }
      if (!(e > 0)) continue;
      const k = nj * size + ni;
      const b = Math.min(255, bp + (dIn >= 0 && dIn !== d ? 1 : 0));
      const dk = dist[k];
      if (dk === Infinity) {
        if (!grid.walkable(gi0 + ni, gj0 + nj)) { dist[k] = -1; continue; } // mark non-walkable (restored below)
        dist[k] = dp; prev[k] = p; bends[k] = b; dirIn[k] = d;
        queue[tail++] = k;
      } else if (dk === dp && b < bends[k]) {
        prev[k] = p; bends[k] = b; dirIn[k] = d;
      }
    }
  }
  for (let k = 0; k < n; k++) if (dist[k] < 0) dist[k] = Infinity;
}

/** Window index of a global cell, or -1 outside the window. */
export function fieldIndex(f: PropagationField, gi: number, gj: number): number {
  const i = gi - f.gi0, j = gj - f.gj0;
  return i < 0 || j < 0 || i >= f.size || j >= f.size ? -1 : j * f.size + i;
}

// ---------------------------------------------------------------- source resolution

export const SourceKind = { LOS: 0, OCCLUDED: 1, UNREACHABLE: 2, OUTSIDE: 3 } as const;
export type SourceKindId = (typeof SourceKind)[keyof typeof SourceKind];

export interface SourceResolution {
  kind: SourceKindId;
  x: number; y: number; z: number; // apparent source position (world metres)
  path: number; // metres travelled (euclid for LOS / through-wall)
  euclid: number;
  excess: number; // path - euclid (m)
  bends: number;
  cutoff: number; // Hz, combined occlusion + air-absorption low-pass
  gain: number; // linear, bends / wall loss (distance attenuation is left to the panner)
  portalIdx: number; // window index of the portal cell (OCCLUDED), else -1
}
export function createResolution(): SourceResolution {
  return { kind: SourceKind.LOS, x: 0, y: 0, z: 0, path: 0, euclid: 0, excess: 0, bends: 0, cutoff: 20000, gain: 1, portalIdx: -1 };
}

/** Horizontal-plane line-of-sight test in world metres (WorldQuery.losClear). */
export type SightTest = (ax: number, ay: number, az: number, bx: number, by: number, bz: number) => boolean;

/** Air absorption for line-of-sight sources: 20 kHz * e^(-d / 40 m), min 2 kHz. */
export const airCutoff = (d: number): number => Math.max(2000, 20000 * Math.exp(-d / 40));
/** Occlusion low-pass from the path excess: 20 kHz * e^(-0.35 excess), min 500 Hz. */
export const occlusionCutoff = (excess: number): number => Math.max(500, 20000 * Math.exp(-0.35 * excess));
export const BEND_DB = -3;
export const WALL_CUTOFF = 300;
export const WALL_DB = -18;
/** Sources beyond the propagation window and out of sight: assumed far and winding. */
export const OUTSIDE_DB = -9;

const cellOf = (m: number): number => Math.floor(m / CELL + 1e-7);

/**
 * Place a source for the listener (§5 WP13 propagation rules):
 *  - line of sight: true position, air absorption only;
 *  - reachable but occluded: walk back along `prev` from the source cell to the first cell the listener can see
 *    (the portal); apparent source = listener + dir(portal) * pathDist, low-pass by the path excess, -3 dB per bend;
 *  - unreachable (inside the window): true position, 300 Hz low-pass, -18 dB (heard through the wall);
 *  - outside the window and not visible: true position, low-pass for an assumed winding path, -9 dB.
 * `checkLos` = false skips the direct test (caller already knows it is occluded).
 */
export function resolveSource(
  f: PropagationField, sight: SightTest, lx: number, ly: number, lz: number, sx: number, sy: number, sz: number,
  out: SourceResolution, checkLos = true,
): SourceResolution {
  const dx = sx - lx, dy = sy - ly, dz = sz - lz;
  const euclid = Math.sqrt(dx * dx + dy * dy + dz * dz);
  out.euclid = euclid;
  out.portalIdx = -1;
  if (checkLos && sight(lx, ly, lz, sx, sy, sz)) {
    out.kind = SourceKind.LOS;
    out.x = sx; out.y = sy; out.z = sz;
    out.path = euclid; out.excess = 0; out.bends = 0;
    out.cutoff = airCutoff(euclid);
    out.gain = 1;
    return out;
  }
  let k = fieldIndex(f, cellOf(sx), cellOf(sz));
  if (k < 0) {
    out.kind = SourceKind.OUTSIDE;
    out.x = sx; out.y = sy; out.z = sz;
    out.path = euclid * 1.4; out.excess = euclid * 0.4; out.bends = 1;
    out.cutoff = Math.min(airCutoff(out.path), occlusionCutoff(out.excess));
    out.gain = Math.pow(10, OUTSIDE_DB / 20);
    return out;
  }
  if (!(f.dist[k] < Infinity)) {
    // sources mounted in a blocked cell (vent in a wall, drip over a pipe): use the best reachable neighbour
    const size = f.size;
    const ci = k % size, cj = (k - ci) / size;
    let best = -1, bd = Infinity;
    for (let oj = -1; oj <= 1; oj++) for (let oi = -1; oi <= 1; oi++) {
      const ni = ci + oi, nj = cj + oj;
      if ((oi === 0 && oj === 0) || ni < 0 || nj < 0 || ni >= size || nj >= size) continue;
      const nk = nj * size + ni;
      if (f.dist[nk] < bd) { bd = f.dist[nk]; best = nk; }
    }
    // only adopt a neighbour when the source actually sits on that cell's boundary (within 0.35 m)
    if (best >= 0) {
      const bi = best % size, bj = (best - bi) / size;
      const cx0 = (f.gi0 + bi) * CELL, cz0 = (f.gj0 + bj) * CELL;
      const ox = Math.max(cx0 - sx, 0, sx - (cx0 + CELL)), oz = Math.max(cz0 - sz, 0, sz - (cz0 + CELL));
      if (ox * ox + oz * oz > 0.35 * 0.35) best = -1;
    }
    if (best < 0) {
      out.kind = SourceKind.UNREACHABLE;
      out.x = sx; out.y = sy; out.z = sz;
      out.path = euclid; out.excess = 0; out.bends = 0;
      out.cutoff = WALL_CUTOFF;
      out.gain = Math.pow(10, WALL_DB / 20);
      return out;
    }
    k = best;
  }
  // walk back from the source cell towards the listener: the first visible cell is the portal
  const size = f.size;
  const listenerIdx = ((size - 1) >> 1) * size + ((size - 1) >> 1);
  let portal = -1, c = k, last = k;
  while (c >= 0 && c !== listenerIdx) {
    const ci = c % size, cj = (c - ci) / size;
    const px = (f.gi0 + ci + 0.5) * CELL, pz = (f.gj0 + cj + 0.5) * CELL;
    if (sight(lx, ly, lz, px, ly, pz)) { portal = c; break; }
    last = c;
    c = f.prev[c];
  }
  if (portal < 0) portal = last;
  const pi = portal % size, pj = (portal - pi) / size;
  const px = (f.gi0 + pi + 0.5) * CELL, pz = (f.gj0 + pj + 0.5) * CELL;
  const lpX = px - lx, lpZ = pz - lz;
  const lp = Math.sqrt(lpX * lpX + lpZ * lpZ);
  const tailM = (f.dist[k] - f.dist[portal]) * CELL;
  const path = Math.max(euclid, lp + tailM);
  const excess = path - euclid;
  out.kind = SourceKind.OCCLUDED;
  out.portalIdx = portal;
  out.path = path;
  out.excess = excess;
  out.bends = f.bends[k];
  if (lp > 1e-4) { out.x = lx + (lpX / lp) * path; out.z = lz + (lpZ / lp) * path; }
  else { out.x = sx; out.z = sz; }
  out.y = sy;
  out.cutoff = Math.min(occlusionCutoff(excess), airCutoff(path));
  out.gain = Math.pow(10, (BEND_DB * out.bends) / 20);
  return out;
}
