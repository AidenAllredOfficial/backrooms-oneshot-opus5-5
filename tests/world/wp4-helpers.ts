// tests/world/wp4-helpers.ts — shared helpers for the WP4 tests (structures / content / tower). Not a test file.

import { CELL, CHUNK_CELLS, PLAYER, WALL_T } from '../../src/core/constants.ts';
import { edgePieces } from '../../src/core/edges.ts';
import { cellIdx, exIdx, ezIdx } from '../../src/core/grid.ts';
import { CellFlag, EdgeKind, Mood, SolidFlag, type StoreyId, type ZoneId, Zone } from '../../src/core/ids.ts';
import { createEmptyLayout, type ChunkLayout, type Fixture } from '../../src/core/layout.ts';
import type { ChunkCollision } from '../../src/core/mesh.ts';
import { rngFor, SALT } from '../../src/core/rng.ts';
import type {
  DistrictInfo, LightingProfile, SeamSpec, WorldGen, WorldGenOptions, WorldGenQuery, ZoneGenContext, ZonePalette,
} from '../../src/core/world.ts';
import { rampHeightAt } from '../../src/player/collisionBuild.ts';
import { createChunkGrid } from '../../src/world/chunkGrid.ts';
import { cellWalkable, edgePassable, portCells } from '../../src/world/connectivity.ts';
import { createFieldSampler } from '../../src/world/fields.ts';
import { generatorFor } from '../../src/world/zones/registry.ts';

export const N = CHUNK_CELLS;

export const opts = (seed: number, o: Partial<WorldGenOptions> = {}): WorldGenOptions => ({
  seed, seedText: String(seed), forceZone: null, forceMood: null, forceLandmark: null, testScene: null, lights: 'default', ...o,
});

const emptySeam = (): SeamSpec => ({
  mode: 1, kind: new Uint8Array(N), hA: new Int16Array(N), hB: new Int16Array(N), matNeg: new Uint8Array(N), matPos: new Uint8Array(N), trim: new Uint8Array(N),
});

/** A ZoneGenContext over an existing layout (for calling WP4 passes directly). `gen` supplies districts / sites. */
export function ctxFor(l: ChunkLayout, seed: number, gen?: WorldGen, o: Partial<WorldGenOptions> = {}): ZoneGenContext {
  const { s, cx, cz } = l.key;
  const zone = l.zone as ZoneId;
  const district: DistrictInfo = gen ? gen.districtAt(s, cx, cz) : { id: 1, s, zone, mood: l.mood, siteX: cx + 0.5, siteZ: cz + 0.5, seed: 1, params: {} };
  const gz = generatorFor(district.zone);
  const palette: ZonePalette = gz.palette(s, district);
  const lighting: LightingProfile = gz.lighting(s, district);
  const world: WorldGenQuery = gen ?? {
    districtAt: (ss, x, z) => ({ ...district, s: ss, id: x === 0 && z === 0 ? 999 : district.id }),
    arteriesNear: () => [],
    towersNear: () => [],
  };
  const grid = createChunkGrid(l, seed);
  return {
    key: l.key, seed, opts: opts(seed, o), rng: rngFor(seed, SALT.ZONE_LAYOUT, s, cx, cz), district, grid,
    seams: { W: emptySeam(), N: emptySeam(), E: emptySeam(), S: emptySeam() },
    neighbors: { W: zone, N: zone, E: zone, S: zone },
    fields: gen ? gen.fields(s) : createFieldSampler(seed, s), palette, lighting, world,
  };
}

/** An empty open layout (floor 0, ceiling 270, all edges OPEN, fields mid) for synthetic tests. */
export function openLayout(s: StoreyId = 0, cx = 3, cz = 5, zone: ZoneId = Zone.LOBBY): ChunkLayout {
  const l = createEmptyLayout({ s, cx, cz }, zone, 1, Mood.NORMAL);
  l.ceilCm.fill(270);
  l.power.fill(200); l.decay.fill(64); l.humidity.fill(64); l.warmth.fill(128);
  l.cellZone.fill(zone);
  return l;
}

/** Cells reachable from the walkable port cells (WP1 rules), or from `from` when given. */
export function reachable(l: ChunkLayout, from?: number[]): Uint8Array {
  const seen = new Uint8Array(N * N);
  const stack: number[] = [];
  for (const c of from ?? portCells(l)) if (cellWalkable(l, c) && !seen[c]) { seen[c] = 1; stack.push(c); }
  while (stack.length) {
    const c = stack.pop() as number;
    const li = c & 31, lj = c >> 5;
    const tryN = (n: number, axis: 'x' | 'z', i: number, j: number): void => {
      if (!seen[n] && cellWalkable(l, n) && edgePassable(l, axis, i, j)) { seen[n] = 1; stack.push(n); }
    };
    if (li > 0) tryN(c - 1, 'x', li, lj);
    if (li < N - 1) tryN(c + 1, 'x', li + 1, lj);
    if (lj > 0) tryN(c - N, 'z', li, lj);
    if (lj < N - 1) tryN(c + N, 'z', li, lj + 1);
  }
  return seen;
}

/** Reference floorAt over a ChunkCollision (same semantics as WP10/WP12: cell floor, WALKABLE_TOP boxes, ramps). */
export function floorAt(l: ChunkLayout, col: ChunkCollision, x: number, z: number, feetY: number): number {
  const li = Math.min(N - 1, Math.max(0, Math.floor(x / CELL + 1e-7))), lj = Math.min(N - 1, Math.max(0, Math.floor(z / CELL + 1e-7)));
  const c = cellIdx(li, lj);
  const lim = feetY + PLAYER.stepMax + 1e-6;
  let best = -Infinity;
  if (!(l.flags[c] & (CellFlag.SOLID | CellFlag.VOID))) {
    const f = l.floorCm[c] / 100;
    if (f <= lim) best = f;
  }
  for (let k = col.cellStart[c]; k < col.cellStart[c + 1]; k++) {
    const b = col.cellBoxes[k];
    if (!(col.boxFlags[b] & SolidFlag.WALKABLE_TOP)) continue;
    const o = b * 6, bx = col.boxes;
    if (x < bx[o] || x > bx[o + 3] || z < bx[o + 2] || z > bx[o + 5]) continue;
    const top = bx[o + 4];
    if (top <= lim && top > best) best = top;
  }
  for (let o = 0; o < col.ramps.length; o += 8) {
    const h = rampHeightAt(col.ramps, o, x, z);
    if (h === h && h <= lim && h > best) best = h;
  }
  return best;
}

const T2 = WALL_T / 2;

/** Horizontal rect [x0, z0, x1, z1] of a ceiling RECT fixture. */
export function fixtureRect(f: Fixture): [number, number, number, number] {
  const alongX = Math.abs(f.tx) > 0.5;
  const hx = (alongX ? f.w : f.h) / 2, hz = (alongX ? f.h : f.w) / 2;
  return [f.px - hx, f.pz - hz, f.px + hx, f.pz + hz];
}

export function fixtureHitsWall(l: ChunkLayout, f: Fixture): boolean {
  const pieces = new Float32Array(32);
  let x0: number, z0: number, x1: number, z1: number, y0: number, y1: number;
  if (f.shape === 1) {
    const r = f.w / 2;
    [x0, z0, x1, z1, y0, y1] = [f.px - r, f.pz - r, f.px + r, f.pz + r, f.py - r, f.py + r];
  } else if (Math.abs(f.ny) > 0.9) {
    [x0, z0, x1, z1] = fixtureRect(f);
    [y0, y1] = [f.py - 0.01, f.py + 0.01];
  } else {
    // vertical panel: w along t (horizontal), h vertical, 1 cm thick
    const hx = Math.abs(f.tx) * f.w / 2 + Math.abs(f.nx) * 0.005, hz = Math.abs(f.tz) * f.w / 2 + Math.abs(f.nz) * 0.005;
    [x0, z0, x1, z1, y0, y1] = [f.px - hx, f.pz - hz, f.px + hx, f.pz + hz, f.py - f.h / 2, f.py + f.h / 2];
  }
  const e = 1e-4;
  for (const axis of ['x', 'z'] as const) {
    const eg = axis === 'x' ? l.ex : l.ez;
    for (let a = 0; a <= N; a++) {
      const line = a * CELL;
      const lo = axis === 'x' ? x0 : z0, hi = axis === 'x' ? x1 : z1;
      if (!(line - T2 < hi - e && line + T2 > lo + e)) continue;
      for (let b = 0; b < N; b++) {
        const k = axis === 'x' ? exIdx(a, b) : ezIdx(b, a);
        const kind = eg.kind[k];
        if (kind === EdgeKind.OPEN) continue;
        const ca = axis === 'x' ? cellIdx(Math.max(0, a - 1), b) : cellIdx(b, Math.max(0, a - 1));
        const cb = axis === 'x' ? cellIdx(Math.min(N - 1, a), b) : cellIdx(b, Math.min(N - 1, a));
        const fa = l.floorCm[ca] / 100, fb = l.floorCm[cb] / 100;
        const n = edgePieces(kind, eg.hA[k], eg.hB[k], Math.min(fa, fb), Math.max(fa, fb), Math.max(l.ceilCm[ca], l.ceilCm[cb]) / 100, pieces);
        const s0 = axis === 'x' ? z0 : x0, s1 = axis === 'x' ? z1 : x1;
        for (let p = 0; p < n; p++) {
          const t0 = b * CELL + pieces[p * 4], t1 = b * CELL + pieces[p * 4 + 1];
          if (t0 < s1 - e && t1 > s0 + e && pieces[p * 4 + 2] < y1 - e && pieces[p * 4 + 3] > y0 + e) return true;
        }
      }
    }
  }
  return false;
}
