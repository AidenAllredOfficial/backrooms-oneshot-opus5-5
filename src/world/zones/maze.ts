// src/world/zones/maze.ts — MAZE generator (WP2). PATTERN seams via seamPattern; wide (macro-grid Wilson) and
// narrow (global-parity growing tree) variants.
//
// wide   (60%): a 16x16 macro grid of 2x2-cell macro cells with thin walls on the macro edges; Wilson's uniform
//               spanning tree, dead ends braided with p 0.35, and (p 0.2 per chunk) 2-3 open macro rooms.
// narrow (40%): cells with odd global gi AND odd gj are nodes, every other cell is SOLID wall mass; a growing-tree
//               carve (newest 50% / random 50%) links the nodes, braided with p 0.3, plus 4 node-aligned chambers.
//               Seam ports sit on node rows (odd indices along the line), so the cells behind them are always
//               nodes or connectors.

import { CHUNK_CELLS } from '../../core/constants.ts';
import { EDGE_WALKABLE } from '../../core/edges.ts';
import { cellIdx } from '../../core/grid.ts';
import { CeilKind, CellFlag, EdgeKind, FixtureKind, Mat, PropKind, Zone } from '../../core/ids.ts';
import type { Rng } from '../../core/rng.ts';
import type { ChunkGrid, LightingProfile, PropRuleSet, SeamEdges, ZoneGenContext, ZoneGenerator, ZonePalette } from '../../core/world.ts';
import { edgePassable, num, storeyStyle, styleLighting, stylePalette } from './l0common.ts';

const N = CHUNK_CELLS;
const M = N >> 1; // macro cells per axis (16)

export const MAZE_WIDE = 0;
export const MAZE_NARROW = 1;

// ------------------------------------------------------------------------------------------------ seams

/** Wide: 16 macro edges of 2 cells, each open with p 0.35 (>= 2 open); a closed run of > 5 macro edges gets its
 * middle one opened. Narrow: only node rows (odd indices) can be ports, each with p 0.35 (>= 2); wall runs are
 * kept <= 11 by opening the node row nearest the middle of any longer run. */
export function mazeSeamPattern(rng: Rng, variant: number): SeamEdges {
  const kind = new Uint8Array(N), hA = new Int16Array(N), hB = new Int16Array(N);
  if (variant === MAZE_NARROW) {
    kind.fill(EdgeKind.WALL);
    let open = 0;
    for (let c = 1; c < N; c += 2) if (rng.chance(0.35)) { kind[c] = EdgeKind.OPEN; open++; }
    while (open < 2) {
      const c = 1 + 2 * rng.int(0, (N >> 1) - 1);
      if (kind[c] === EdgeKind.WALL) { kind[c] = EdgeKind.OPEN; open++; }
    }
    for (let guard = 0; guard < 32; guard++) {
      let fixed = false;
      let run = 0;
      for (let c = 0; c <= N; c++) {
        if (c < N && kind[c] === EdgeKind.WALL) { run++; continue; }
        if (run > 11) {
          let mid = c - run + (run >> 1);
          if ((mid & 1) === 0) mid++;
          kind[mid] = EdgeKind.OPEN;
          fixed = true;
        }
        run = 0;
      }
      if (!fixed) break;
    }
    return { kind, hA, hB };
  }
  const open = new Uint8Array(M);
  let n = 0;
  for (let m = 0; m < M; m++) if (rng.chance(0.35)) { open[m] = 1; n++; }
  while (n < 2) {
    const m = rng.int(0, M - 1);
    if (!open[m]) { open[m] = 1; n++; }
  }
  for (let guard = 0; guard < 16; guard++) {
    let fixed = false;
    let run = 0;
    for (let m = 0; m <= M; m++) {
      if (m < M && !open[m]) { run++; continue; }
      if (run > 5) { open[m - run + (run >> 1)] = 1; fixed = true; }
      run = 0;
    }
    if (!fixed) break;
  }
  for (let m = 0; m < M; m++) {
    const k = open[m] ? EdgeKind.OPEN : EdgeKind.WALL;
    kind[2 * m] = k; kind[2 * m + 1] = k;
  }
  return { kind, hA, hB };
}

// ------------------------------------------------------------------------------------------------ generator

export const mazeGenerator: ZoneGenerator = {
  id: Zone.MAZE,
  seamMode: 'pattern',
  districtParams(rng, _s) {
    return {
      variant: rng.chance(0.6) ? MAZE_WIDE : MAZE_NARROW,
      phaseX: rng.int(0, 3),
      phaseZ: rng.int(0, 5),
    };
  },
  seamPattern(rng, d) {
    return mazeSeamPattern(rng, num(d.params, 'variant', MAZE_WIDE));
  },
  generate(ctx) {
    if (num(ctx.district.params, 'variant', MAZE_WIDE) === MAZE_NARROW) generateNarrow(ctx);
    else generateWide(ctx);
  },
  palette(s, d) {
    const base: ZonePalette = {
      floorMat: Mat.CARPET_L0, wallMat: Mat.WALLPAPER_L0, ceilMat: Mat.CEILING_TILE, trimMat: Mat.TRIM_PAINT,
      ceilKind: CeilKind.TILES, ceilCm: 270, baseboard: true,
    };
    return stylePalette(storeyStyle(d.zone, s), base);
  },
  lighting(s, d) {
    const base: LightingProfile = {
      kind: FixtureKind.TROFFER_2x4, placement: 'lattice', lattice: [4, 6],
      phase: [num(d.params, 'phaseX', 0) % 4, num(d.params, 'phaseZ', 0) % 6], axis: 1,
      cctRange: [3300, 3700], luminance: 2800, zoneMul: 1, mountCm: 0, // R2: warmer and dimmer than LOBBY
    };
    return styleLighting(storeyStyle(d.zone, s), base, d.params);
  },
  props: {
    rules: [
      { kind: PropKind.OUTLET, where: 'wallMounted', per100m2: 2.0, variants: 2, minSpacing: 2.4, yCm: 30 },
      { kind: PropKind.VENT_GRILLE, where: 'wallMounted', per100m2: 0.4, variants: 2, minSpacing: 6, yCm: -35 },
      { kind: PropKind.CHAIR_STACKING, where: 'wall', per100m2: 0.15, variants: 3, minSpacing: 8, yCm: 0 },
      { kind: PropKind.TRASH_CAN, where: 'corner', per100m2: 0.1, variants: 2, minSpacing: 10, yCm: 0 },
    ],
  } satisfies PropRuleSet,
};

// ------------------------------------------------------------------------------------------------ wide

// macro edge arrays: V[mz*M + mx] = the macro edge on the x-line x = 2*mx (between macro cells mx-1 and mx), mx 1..15;
//                    H[mz*M + mx] = the macro edge on the z-line z = 2*mz (between mz-1 and mz), mz 1..15.
function generateWide(ctx: ZoneGenContext): void {
  const g = ctx.grid, rng = ctx.rng;
  // active macro cells: at least one non-reserved cell, and the free cells connected inside the macro cell (a
  // diagonal pair is two pieces; those join the maze afterwards as dead ends, see splitDiagonal below)
  const active = new Uint8Array(M * M);
  for (let mz = 0; mz < M; mz++) {
    for (let mx = 0; mx < M; mx++) {
      let free = 0;
      for (let d = 0; d < 4; d++) if (!g.isReserved(2 * mx + (d & 1), 2 * mz + (d >> 1))) free++;
      active[mz * M + mx] = free > 0 && splitDiagonal(g, mx, mz) === 0 ? 1 : 0;
    }
  }
  // a macro edge can link two macro cells if both are active and at least one of its cell edges is writable
  const linkable = (dir: 0 | 1, mx: number, mz: number): boolean => {
    // dir 0: V edge at (mx, mz) between (mx-1, mz) and (mx, mz); dir 1: H edge between (mx, mz-1) and (mx, mz)
    if (dir === 0) {
      if (mx <= 0 || mx >= M || !active[mz * M + mx - 1] || !active[mz * M + mx]) return false;
      return canWrite(g, 'x', 2 * mx, 2 * mz) || canWrite(g, 'x', 2 * mx, 2 * mz + 1);
    }
    if (mz <= 0 || mz >= M || !active[(mz - 1) * M + mx] || !active[mz * M + mx]) return false;
    return canWrite(g, 'z', 2 * mx, 2 * mz) || canWrite(g, 'z', 2 * mx + 1, 2 * mz);
  };
  const openV = new Uint8Array(M * M), openH = new Uint8Array(M * M);
  const nbr = (c: number, out: number[]): number => {
    const mx = c % M, mz = (c / M) | 0;
    let n = 0;
    if (linkable(0, mx, mz)) out[n++] = c - 1;
    if (linkable(0, mx + 1, mz)) out[n++] = c + 1;
    if (linkable(1, mx, mz)) out[n++] = c - M;
    if (linkable(1, mx, mz + 1)) out[n++] = c + M;
    return n;
  };
  const link = (a: number, b: number): void => {
    const lo = Math.min(a, b), hi = Math.max(a, b);
    if (hi - lo === 1) openV[hi] = 1; else openH[hi] = 1;
  };
  const isOpen = (a: number, b: number): boolean => {
    const lo = Math.min(a, b), hi = Math.max(a, b);
    return hi - lo === 1 ? openV[hi] === 1 : openH[hi] === 1;
  };

  // Wilson's algorithm, run per connected component of linkable macro cells
  const inTree = new Uint8Array(M * M);
  const next = new Int32Array(M * M).fill(-1);
  const comp = new Int32Array(M * M).fill(-1);
  const buf = [0, 0, 0, 0];
  const order: number[] = [];
  for (let c = 0; c < M * M; c++) if (active[c]) order.push(c);
  rng.shuffle(order);
  let compId = 0;
  const stack: number[] = [];
  for (const c0 of order) {
    if (comp[c0] >= 0) continue;
    // label the component
    const members: number[] = [];
    stack.push(c0); comp[c0] = compId;
    while (stack.length) {
      const c = stack.pop() as number;
      members.push(c);
      const n = nbr(c, buf);
      for (let k = 0; k < n; k++) if (comp[buf[k]] < 0) { comp[buf[k]] = compId; stack.push(buf[k]); }
    }
    compId++;
    members.sort((a, b) => a - b);
    rng.shuffle(members);
    inTree[members[0]] = 1;
    for (let m = 1; m < members.length; m++) {
      const start = members[m];
      if (inTree[start]) continue;
      let cur = start;
      for (let guard = 0; !inTree[cur] && guard < 200000; guard++) {
        const n = nbr(cur, buf);
        const nx = buf[rng.int(0, n - 1)];
        next[cur] = nx;
        cur = nx;
      }
      cur = start;
      while (!inTree[cur]) {
        inTree[cur] = 1;
        link(cur, next[cur]);
        cur = next[cur];
      }
    }
  }

  // braid: each dead end opens one more side with p 0.35 (preferring a neighbouring dead end)
  const degree = (c: number): number => {
    const n = nbr(c, buf);
    let d = 0;
    for (let k = 0; k < n; k++) if (isOpen(c, buf[k])) d++;
    return d;
  };
  const cand = [0, 0, 0, 0];
  for (let c = 0; c < M * M; c++) {
    if (!active[c] || degree(c) !== 1) continue;
    if (!rng.chance(0.35)) continue;
    const n = nbr(c, buf);
    let nc = 0, pref = -1;
    for (let k = 0; k < n; k++) {
      if (isOpen(c, buf[k])) continue;
      cand[nc++] = buf[k];
      if (pref < 0 && degree(buf[k]) === 1) pref = buf[k];
    }
    if (nc === 0) continue;
    link(c, pref >= 0 ? pref : cand[rng.int(0, nc - 1)]);
  }

  // macro rooms: with p 0.2 per chunk, 2-3 open rooms of 2x2..3x3 macro cells
  if (rng.chance(0.2)) {
    const rooms = rng.int(2, 3);
    for (let r = 0; r < rooms; r++) {
      const w = rng.int(2, 3), h = rng.int(2, 3);
      const x0 = rng.int(0, M - w), z0 = rng.int(0, M - h);
      for (let mz = z0; mz < z0 + h; mz++) {
        for (let mx = x0; mx < x0 + w; mx++) {
          const c = mz * M + mx;
          if (mx > x0 && linkable(0, mx, mz)) openV[c] = 1;
          if (mz > z0 && linkable(1, mx, mz)) openH[c] = 1;
        }
      }
    }
  }

  // write the closed macro edges as thin walls (2 cell edges each; refused edges touching stamps are skipped)
  for (let mz = 0; mz < M; mz++) {
    for (let mx = 1; mx < M; mx++) {
      if (openV[mz * M + mx]) continue;
      g.setEdge('x', 2 * mx, 2 * mz, EdgeKind.WALL);
      g.setEdge('x', 2 * mx, 2 * mz + 1, EdgeKind.WALL);
    }
  }
  for (let mz = 1; mz < M; mz++) {
    for (let mx = 0; mx < M; mx++) {
      if (openH[mz * M + mx]) continue;
      g.setEdge('z', 2 * mx, 2 * mz, EdgeKind.WALL);
      g.setEdge('z', 2 * mx + 1, 2 * mz, EdgeKind.WALL);
    }
  }

  // split macro cells (free cells on a diagonal): every piece opens one macro-boundary edge into an active,
  // tree-connected neighbour macro cell, so it becomes a 1-cell dead end off the maze
  const macroActive = (li: number, lj: number): boolean =>
    li >= 0 && lj >= 0 && li < N && lj < N && active[(lj >> 1) * M + (li >> 1)] === 1 && !g.isReserved(li, lj);
  for (let mz = 0; mz < M; mz++) {
    for (let mx = 0; mx < M; mx++) {
      const sd = splitDiagonal(g, mx, mz);
      if (sd === 0) continue;
      const i0 = 2 * mx, j0 = 2 * mz;
      if (sd === 1) { openPiece(g, macroActive, i0, j0, -1, -1); openPiece(g, macroActive, i0 + 1, j0 + 1, 1, 1); }
      else { openPiece(g, macroActive, i0 + 1, j0, 1, -1); openPiece(g, macroActive, i0, j0 + 1, -1, 1); }
    }
  }
}

/** 0 = the free cells of macro cell (mx, mz) are connected inside it; 1 = only (0,0)+(1,1) are free; 2 = only
 * (1,0)+(0,1) are free (the other diagonal is reserved). */
function splitDiagonal(g: ChunkGrid, mx: number, mz: number): number {
  const i0 = 2 * mx, j0 = 2 * mz;
  const r00 = g.isReserved(i0, j0), r10 = g.isReserved(i0 + 1, j0);
  const r01 = g.isReserved(i0, j0 + 1), r11 = g.isReserved(i0 + 1, j0 + 1);
  if (r00 !== r11 || r10 !== r01 || r00 === r10) return 0;
  return r00 ? 2 : 1;
}

/** Free cell (li, lj) of a split macro cell; (sx, sz) = the directions of its two macro-boundary edges. Unless a
 * boundary edge is already passable (a seam port), opens the boundary edge into an active neighbour macro cell
 * (x side first), falling back to any free neighbour. */
function openPiece(
  g: ChunkGrid, macroActive: (li: number, lj: number) => boolean, li: number, lj: number, sx: number, sz: number,
): void {
  const ei = sx < 0 ? li : li + 1, ej = sz < 0 ? lj : lj + 1; // x-line index / z-line index of the boundary edges
  if (EDGE_WALKABLE[g.getEdge('x', ei, lj)] || EDGE_WALKABLE[g.getEdge('z', li, ej)]) return;
  const ni = li + sx, nj = lj + sz;
  const xOk = ni >= 0 && ni < N && !g.isReserved(ni, lj) && canWrite(g, 'x', ei, lj);
  const zOk = nj >= 0 && nj < N && !g.isReserved(li, nj) && canWrite(g, 'z', li, ej);
  if (xOk && (macroActive(ni, lj) || !(zOk && macroActive(li, nj)))) g.setEdge('x', ei, lj, EdgeKind.OPEN);
  else if (zOk) g.setEdge('z', li, ej, EdgeKind.OPEN);
}

function canWrite(g: ChunkGrid, axis: 'x' | 'z', i: number, j: number): boolean {
  if (g.isFrozenEdge(axis, i, j)) return false;
  return axis === 'x' ? !g.isReserved(i - 1, j) && !g.isReserved(i, j) : !g.isReserved(i, j - 1) && !g.isReserved(i, j);
}

// ------------------------------------------------------------------------------------------------ narrow


function generateNarrow(ctx: ZoneGenContext): void {
  const g = ctx.grid, rng = ctx.rng;
  const open = new Uint8Array(N * N);
  const free = (li: number, lj: number): boolean => li >= 0 && lj >= 0 && li < N && lj < N && !g.isReserved(li, lj);
  // nodes: odd local == odd global (chunk origins are multiples of 32)
  const K = N >> 1; // 16 nodes per axis: li = 2k+1
  const nodeOk = new Uint8Array(K * K);
  for (let kz = 0; kz < K; kz++) for (let kx = 0; kx < K; kx++) if (free(2 * kx + 1, 2 * kz + 1)) { nodeOk[kz * K + kx] = 1; open[cellIdx(2 * kx + 1, 2 * kz + 1)] = 1; }
  // neighbour node through a free connector cell
  const DX = [1, -1, 0, 0], DZ = [0, 0, 1, -1];
  const nb = (n: number, d: number): number => {
    const kx = n % K + DX[d], kz = ((n / K) | 0) + DZ[d];
    if (kx < 0 || kz < 0 || kx >= K || kz >= K || !nodeOk[kz * K + kx]) return -1;
    const ci = 2 * (n % K) + 1 + DX[d], cj = 2 * ((n / K) | 0) + 1 + DZ[d];
    return free(ci, cj) ? kz * K + kx : -1;
  };
  const carve = (n: number, d: number): void => {
    open[cellIdx(2 * (n % K) + 1 + DX[d], 2 * ((n / K) | 0) + 1 + DZ[d])] = 1;
  };
  const linked = (n: number, d: number): boolean => open[cellIdx(2 * (n % K) + 1 + DX[d], 2 * ((n / K) | 0) + 1 + DZ[d])] === 1;

  // growing tree: newest 50% / random 50%, one tree per connected component of free nodes
  const visited = new Uint8Array(K * K);
  const list: number[] = [];
  const dirs = [0, 0, 0, 0];
  const starts: number[] = [];
  for (let n = 0; n < K * K; n++) if (nodeOk[n]) starts.push(n);
  rng.shuffle(starts);
  for (const s0 of starts) {
    if (visited[s0]) continue;
    visited[s0] = 1;
    list.push(s0);
    while (list.length) {
      const idx = rng.chance(0.5) ? list.length - 1 : rng.int(0, list.length - 1);
      const n = list[idx];
      let nd = 0;
      for (let d = 0; d < 4; d++) { const m = nb(n, d); if (m >= 0 && !visited[m]) dirs[nd++] = d; }
      if (nd === 0) { list.splice(idx, 1); continue; }
      const d = dirs[rng.int(0, nd - 1)];
      const m = nb(n, d);
      carve(n, d);
      visited[m] = 1;
      list.push(m);
    }
  }

  // braid 0.3: dead-end nodes open one more connector (preferring a neighbouring dead end)
  const deg = (n: number): number => {
    let c = 0;
    for (let d = 0; d < 4; d++) if (nb(n, d) >= 0 && linked(n, d)) c++;
    return c;
  };
  for (let n = 0; n < K * K; n++) {
    if (!nodeOk[n] || deg(n) !== 1 || !rng.chance(0.3)) continue;
    let nd = 0, pref = -1;
    for (let d = 0; d < 4; d++) {
      const m = nb(n, d);
      if (m < 0 || linked(n, d)) continue;
      dirs[nd++] = d;
      if (pref < 0 && deg(m) === 1) pref = d;
    }
    if (nd > 0) carve(n, pref >= 0 ? pref : dirs[rng.int(0, nd - 1)]);
  }

  // chambers: 4 node-aligned open rooms (5 or 7 cells per side) per chunk break the 1.2 m corridors. Not in §5.WP2:
  // without them the parity lattice alone is ~50% walkable, below the MAZE 55% acceptance band.
  const chambers = 4;
  for (let k = 0; k < chambers; k++) {
    const w = rng.chance(0.5) ? 5 : 7, h = rng.chance(0.5) ? 5 : 7;
    const i0 = 1 + 2 * rng.int(0, (N - 1 - w) >> 1), j0 = 1 + 2 * rng.int(0, (N - 1 - h) >> 1);
    let ok = true;
    for (let lj = j0; lj < j0 + h && ok; lj++) for (let li = i0; li < i0 + w && ok; li++) if (!free(li, lj)) ok = false;
    if (!ok) continue;
    for (let lj = j0; lj < j0 + h; lj++) for (let li = i0; li < i0 + w; li++) open[cellIdx(li, lj)] = 1;
  }

  // walkable connectors behind every passable seam edge and every passable edge into a reserved stamp
  const connect = (li: number, lj: number, inI: number, inJ: number): void => {
    if (!free(li, lj)) return;
    open[cellIdx(li, lj)] = 1;
    if ((li & 1) === 0 && (lj & 1) === 0) {
      // an (even, even) pillar cell: also open the inward connector, which touches a node
      const ni = li + inI, nj = lj + inJ;
      if (free(ni, nj)) open[cellIdx(ni, nj)] = 1;
      else {
        for (let d = 0; d < 4; d++) {
          const ai = li + DX[d], aj = lj + DZ[d];
          if (free(ai, aj)) { open[cellIdx(ai, aj)] = 1; break; }
        }
      }
    }
  };
  for (let c = 0; c < N; c++) {
    if (edgePassable(g, 'x', 0, c)) connect(0, c, 1, 0);
    if (edgePassable(g, 'x', N, c)) connect(N - 1, c, -1, 0);
    if (edgePassable(g, 'z', c, 0)) connect(c, 0, 0, 1);
    if (edgePassable(g, 'z', c, N)) connect(c, N - 1, 0, -1);
  }
  for (let lj = 0; lj < N; lj++) {
    for (let li = 0; li < N; li++) {
      if (!g.isReserved(li, lj)) continue;
      // free neighbours reached through a passable edge (artery side doors, tower exits, landmark entrances)
      if (li > 0 && free(li - 1, lj) && EDGE_WALKABLE[g.getEdge('x', li, lj)]) connect(li - 1, lj, -1, 0);
      if (li < N - 1 && free(li + 1, lj) && EDGE_WALKABLE[g.getEdge('x', li + 1, lj)]) connect(li + 1, lj, 1, 0);
      if (lj > 0 && free(li, lj - 1) && EDGE_WALKABLE[g.getEdge('z', li, lj)]) connect(li, lj - 1, 0, -1);
      if (lj < N - 1 && free(li, lj + 1) && EDGE_WALKABLE[g.getEdge('z', li, lj + 1)]) connect(li, lj + 1, 0, 1);
    }
  }

  // everything else is SOLID wall mass
  for (let lj = 0; lj < N; lj++) {
    for (let li = 0; li < N; li++) {
      if (open[cellIdx(li, lj)] || !free(li, lj)) continue;
      g.setCells(li, lj, li + 1, lj + 1, { flagsSet: CellFlag.SOLID });
    }
  }
}
