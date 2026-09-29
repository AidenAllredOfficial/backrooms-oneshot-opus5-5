// src/world/zones/pipeworks.ts — PIPEWORKS generator (WP3). PATTERN seams: narrow maze, boiler rooms, pipe runs.
//
// - Corridors: the global-parity narrow-maze lattice (cells with odd gi and odd gj are nodes, everything else is
//   SOLID mass) carved with a growing tree (newest 75% / random 25%, straight bias 0.7) and braided (p 0.25), so
//   runs are long and there are loops. Seams: ports only on node rows (odd indices), p 0.35 each, at least 2, never a
//   wall run longer than 12; the cells behind a port (and behind stamp openings) are carved as connectors.
// - Boiler rooms: 5 × 5 open rooms (p 0.3 per candidate, 3 candidates per chunk) with a BOILER, a TANK, connecting
//   pipes, a riser, a valve, cage bulbs, MACHINE/STEAM emitters and a taller ceiling.
// - Pipes: per district 2–4 "slots" (radius 0.04–0.15 m; slot 0, the big main, runs along every corridor line, so
//   every straight run carries 1–4 pipes). Each slot has a side (±), a wall offset (pipes on one side
//   are stacked laterally, never touching) and two heights: x-running pipes in the upper band (2.20–2.60 m), z-running
//   pipes in the lower band (1.80–2.15 m), so crossing pipes never intersect. Whether a slot runs along a corridor
//   line is a hash of (slot, global row / column): world-anchored, so pipes continue across seams. At a turn the
//   x- and z-pipes of a slot meet a vertical riser at the same corner point (shared endpoints → WP6 elbows); where a
//   riser meets a pipe mid-span (a tee) the pipe is split at that point, so three endpoints coincide and WP6 draws a
//   junction fitting. A pipe whose run ends without a partner turns up into the ceiling; dead ends run into the wall;
//   runs continue across seams only into the same district (same slots) and otherwise stop 0.25 m short and rise.
// - Floors: METAL_GRATE patches from a world-space noise (WP5 draws the grate over a dark plenum pit).
// - Lights: CAGE_BULB (64 cd, 2700 K) every 4–6 cells along corridors on a world-anchored pitch; zoneMul 0.7.
// - Emitters: PIPE knocks along pipes, STEAM, DRIP.

import { transitionStamps } from '../structures/transitions.ts';
import { CELL, CHUNK_CELL_COUNT } from '../../core/constants.ts';
import { cellIdx, floorDiv, mod } from '../../core/grid.ts';
import { CeilKind, EdgeKind, EmitterKind, FixtureKind, Mat, PropKind, Zone, type MatId, type StoreyId } from '../../core/ids.ts';
import { fbm2 } from '../../core/noise.ts';
import { hash01, hash3, hash5, Rng, SALT, type Rng as RngT } from '../../core/rng.ts';
import type { DistrictInfo, LightingProfile, SeamEdges, ZoneGenContext, ZoneGenerator, ZonePalette } from '../../core/world.ts';
import {
  applyMass, bulbSpec, carveToOpen, createFixturePlacer, DX, DZ, entryCells, fieldAt, inChunk, isReservedCell,
  kindWalkable, longestWallRun, N, PIPE_FLAGS, sameDistrictAcross, sideHA, sideKind,
} from './deepcommon.ts';

const TAG = Zone.PIPEWORKS * 16;
const PORT_P = 0.35;
const MAX_WALL_RUN = 12;
const BRAID_P = 0.25;
const STRAIGHT_P = 0.7;
const ROOM_P = 0.3;
const ROOM_CEIL_CM = 420;
const X_BAND: readonly [number, number] = [2.2, 2.6]; // x-running pipe bodies (spec: pipes at 1.8–2.6 m)
const Z_BAND: readonly [number, number] = [1.8, 2.15]; // z-running pipe bodies (below the x band: crossings never touch)
const LIGHT_PITCH = 5; // cells: one bulb per 5-cell block of a corridor line, at offset 2 or 3 (spacing 4–6)
const BULB_CCT: readonly [number, number] = [2700, 2700];
const GRATE_T = 0.63;
const EDGE_SETBACK = 0.25; // m: a run that opens onto another district stops this far short of the seam and rises
const MIN_PIPE = 0.05; // m: shorter pieces are dropped (turn connectors next to a seam can be ~0.13 m long)

type Vec3 = [number, number, number];
interface Slot { r: number; side: 1 | -1; o: number; hx: number; hz: number; p: number }
interface PipeParams { ceil: number; slots: Slot[] }

function params(d: DistrictInfo): PipeParams {
  const P = d.params;
  const n = P.nSlots ?? 2;
  const slots: Slot[] = [];
  for (let k = 0; k < n; k++) {
    slots.push({
      r: P[`r${k}`] ?? 0.06, side: (P[`side${k}`] ?? 1) > 0 ? 1 : -1, o: P[`o${k}`] ?? 0.4,
      hx: P[`hx${k}`] ?? 2.5, hz: P[`hz${k}`] ?? 2.0, p: P[`p${k}`] ?? 0.6,
    });
  }
  return { ceil: P.ceil ?? 300, slots };
}

function districtParams(rng: RngT, _s: StoreyId): Record<string, number> {
  const out: Record<string, number> = {};
  out.ceil = 300 + 30 * rng.int(0, 2); // 300..360 cm (boiler rooms 420)
  const n = rng.int(2, 4);
  out.nSlots = n;
  const stack = { [1]: 0.57, [-1]: 0.57 } as Record<number, number>; // next free wall offset per side
  for (let k = 0; k < n; k++) {
    const side = k % 2 === 0 ? -1 : 1;
    const r = Math.round((k === 0 ? rng.range(0.1, 0.15) : rng.range(0.04, 0.08)) * 200) / 200;
    const o = stack[side] - r;
    stack[side] = o - r - 0.04;
    out[`r${k}`] = r;
    out[`side${k}`] = side;
    out[`o${k}`] = Math.round(o * 1000) / 1000;
    out[`hx${k}`] = Math.round(rng.range(X_BAND[0] + r, X_BAND[1] - r) * 100) / 100;
    out[`hz${k}`] = Math.round(rng.range(Z_BAND[0] + r, Z_BAND[1] - r) * 100) / 100;
    // slot 0 (the big main) follows every corridor line, so every straight run carries 1–4 pipes
    out[`p${k}`] = k === 0 ? 1 : rng.range(0.35, 0.65);
  }
  return out;
}

/** Node-row ports: odd indices only, p 0.35, at least 2, no WALL run > 12. */
function seamPattern(rng: RngT, _d: DistrictInfo): SeamEdges {
  const kind = new Uint8Array(N).fill(EdgeKind.WALL);
  let open = 0;
  for (let c = 1; c < N; c += 2) if (rng.chance(PORT_P)) { kind[c] = EdgeKind.OPEN; open++; }
  while (open < 2) {
    const c = 2 * rng.int(0, N / 2 - 1) + 1;
    if (kind[c] !== EdgeKind.OPEN) { kind[c] = EdgeKind.OPEN; open++; }
  }
  // break long wall runs at an odd index near their middle
  for (let guard = 0; guard < 8 && longestWallRun(kind) > MAX_WALL_RUN; guard++) {
    let run = 0;
    for (let c = 0; c <= N; c++) {
      if (c < N && kind[c] === EdgeKind.WALL) { run++; continue; }
      if (run > MAX_WALL_RUN) { const mid = c - (run >> 1); kind[mid | 1] = EdgeKind.OPEN; break; }
      run = 0;
    }
  }
  return { kind, hA: new Int16Array(N), hB: new Int16Array(N) };
}

function generate(ctx: ZoneGenContext): void {
  const g = ctx.grid, l = g.layout;
  const P = params(ctx.district);
  const gi0 = g.gi0, gj0 = g.gj0;
  const rng = ctx.rng;
  const { s } = ctx.key;
  const placer = createFixturePlacer(ctx);
  const open = new Uint8Array(CHUNK_CELL_COUNT);
  const room = new Uint8Array(CHUNK_CELL_COUNT);
  const reserved = (c: number): boolean => isReservedCell(l, c);

  // ---- growing-tree maze over the odd/odd node lattice (local odd = global odd: chunk origins are even)
  const NN = N / 2; // 16 nodes per axis; node (a, b) = cell (2a+1, 2b+1)
  const visited = new Uint8Array(NN * NN);
  const lastDir = new Int8Array(NN * NN).fill(-1);
  const nodeCell = (a: number, b: number): number => cellIdx(2 * a + 1, 2 * b + 1);
  const nodeOk = (a: number, b: number): boolean => a >= 0 && b >= 0 && a < NN && b < NN && !reserved(nodeCell(a, b));
  const links = new Uint8Array(NN * NN); // bit d: connector toward direction d carved
  const carveLink = (a: number, b: number, d: number): void => {
    links[b * NN + a] |= 1 << d;
    links[(b + DZ[d]) * NN + a + DX[d]] |= 1 << (d ^ 1);
    open[cellIdx(2 * a + 1 + DX[d], 2 * b + 1 + DZ[d])] = 1;
  };
  const active: number[] = [];
  const avail: number[] = [];
  for (let b0 = 0; b0 < NN; b0++) {
    for (let a0 = 0; a0 < NN; a0++) {
      if (visited[b0 * NN + a0] || !nodeOk(a0, b0)) continue;
      visited[b0 * NN + a0] = 1;
      open[nodeCell(a0, b0)] = 1;
      active.length = 0;
      active.push(b0 * NN + a0);
      while (active.length) {
        const pick = rng.chance(0.75) ? active.length - 1 : rng.int(0, active.length - 1);
        const n = active[pick];
        const a = n % NN, b = (n - a) / NN;
        avail.length = 0;
        for (let d = 0; d < 4; d++) {
          const na = a + DX[d], nb = b + DZ[d];
          if (nodeOk(na, nb) && !visited[nb * NN + na]) avail.push(d);
        }
        if (avail.length === 0) { active.splice(pick, 1); continue; }
        const ld = lastDir[n];
        const d = ld >= 0 && avail.includes(ld) && rng.chance(STRAIGHT_P) ? ld : avail[rng.int(0, avail.length - 1)];
        carveLink(a, b, d);
        const m = (b + DZ[d]) * NN + a + DX[d];
        visited[m] = 1;
        lastDir[m] = d;
        open[nodeCell(a + DX[d], b + DZ[d])] = 1;
        active.push(m);
      }
    }
  }
  // braid: open a dead end onward (prefer straight on)
  for (let b = 0; b < NN; b++) {
    for (let a = 0; a < NN; a++) {
      const n = b * NN + a;
      if (!visited[n]) continue;
      const lk = links[n];
      if ((lk & (lk - 1)) !== 0 || !rng.chance(BRAID_P)) continue; // not a dead end (0 or >= 2 links)
      const cand: number[] = [];
      for (let d = 0; d < 4; d++) if (!(lk & (1 << d)) && nodeOk(a + DX[d], b + DZ[d]) && visited[(b + DZ[d]) * NN + a + DX[d]]) cand.push(d);
      if (!cand.length) continue;
      let incoming = -1;
      for (let d = 0; d < 4; d++) if (lk === 1 << d) incoming = d;
      const straight = incoming >= 0 ? incoming ^ 1 : -1;
      carveLink(a, b, cand.includes(straight) ? straight : cand[rng.int(0, cand.length - 1)]);
    }
  }

  // ---- boiler rooms (5 x 5, aligned to the node lattice)
  const rooms: { i0: number; j0: number }[] = [];
  for (let k = 0; k < 3; k++) {
    const i0 = 2 * rng.int(0, 12) + 1, j0 = 2 * rng.int(0, 12) + 1; // odd, i0 + 4 <= 29
    const want = rng.chance(ROOM_P);
    if (!want) continue;
    let ok = true;
    for (const r of rooms) if (i0 < r.i0 + 7 && r.i0 < i0 + 7 && j0 < r.j0 + 7 && r.j0 < j0 + 7) ok = false;
    for (let lj = j0 - 1; lj < j0 + 6 && ok; lj++) for (let li = i0 - 1; li < i0 + 6 && ok; li++) if (inChunk(li, lj) && reserved(cellIdx(li, lj))) ok = false;
    if (!ok) continue;
    rooms.push({ i0, j0 });
    for (let lj = j0; lj < j0 + 5; lj++) for (let li = i0; li < i0 + 5; li++) { open[cellIdx(li, lj)] = 1; room[cellIdx(li, lj)] = 1; }
  }

  // ---- connectors behind seam ports and stamp openings
  const prev = new Int32Array(CHUNK_CELL_COUNT), queue = new Int32Array(CHUNK_CELL_COUNT);
  for (const c of entryCells(l)) { open[c] = 1; carveToOpen(l, open, c, prev, queue); }
  applyMass(g, open, null);

  // ---- ceilings and grated floors
  const noiseSeed = hash3(ctx.seed, SALT.GLOBAL_FEATURE, TAG + s);
  for (let c = 0; c < CHUNK_CELL_COUNT; c++) {
    if (!open[c] || reserved(c)) continue;
    const li = c & 31, lj = c >> 5;
    if (room[c]) { g.setCells(li, lj, li + 1, lj + 1, { ceilCm: ROOM_CEIL_CM }); continue; }
    g.setCells(li, lj, li + 1, lj + 1, { ceilCm: P.ceil });
    if (fbm2(noiseSeed, (gi0 + li) / 4.5, (gj0 + lj) / 4.5, 2) > GRATE_T) g.setCells(li, lj, li + 1, lj + 1, { floorMat: Mat.METAL_GRATE });
  }

  // ---- corridor runs and the pipe network
  const corr = new Uint8Array(CHUNK_CELL_COUNT);
  for (let c = 0; c < CHUNK_CELL_COUNT; c++) corr[c] = open[c] && !room[c] && !reserved(c) ? 1 : 0;
  const seamOpen = (li: number, lj: number, d: number): boolean => kindWalkable(sideKind(l, li, lj, d), sideHA(l, li, lj, d));
  // a run continues across a seam when the seam edge is passable (the neighbour's port cell is a corridor: stamps keep
  // >= 2 cells from seams) and the neighbour belongs to this district (same pipe slots); across a district boundary
  // the pipes stop short of the seam and rise into the ceiling
  const sameAcross = [sameDistrictAcross(ctx, 1, 0), sameDistrictAcross(ctx, -1, 0), sameDistrictAcross(ctx, 0, 1), sameDistrictAcross(ctx, 0, -1)];
  const cont = (li: number, lj: number, d: number): boolean => !inChunk(li + DX[d], lj + DZ[d]) && sameAcross[d] && seamOpen(li, lj, d);
  const edgeOut = (li: number, lj: number, d: number): boolean => !inChunk(li + DX[d], lj + DZ[d]) && !sameAcross[d] && seamOpen(li, lj, d);
  const isCorr = (li: number, lj: number): boolean => inChunk(li, lj) && corr[cellIdx(li, lj)] === 1;
  // run membership per axis: xLen[c] = length of the x-run through c (counting a seam continuation as +1)
  const runLen = (li: number, lj: number, axis: 0 | 1): number => {
    if (!isCorr(li, lj)) return 0;
    const dxp = axis === 0 ? 0 : 2, dxn = dxp + 1;
    let n = 1;
    for (let k = 1; ; k++) { const i = li + DX[dxp] * k, j = lj + DZ[dxp] * k; if (!isCorr(i, j)) { if (cont(i - DX[dxp], j - DZ[dxp], dxp)) n++; break; } n++; }
    for (let k = 1; ; k++) { const i = li + DX[dxn] * k, j = lj + DZ[dxn] * k; if (!isCorr(i, j)) { if (cont(i - DX[dxn], j - DZ[dxn], dxn)) n++; break; } n++; }
    return n;
  };
  const inRunX = (li: number, lj: number): boolean => runLen(li, lj, 0) >= 2;
  const inRunZ = (li: number, lj: number): boolean => runLen(li, lj, 1) >= 2;
  const presentX = (k: number, gj: number): boolean => k === 0 || hash01(hash5(ctx.seed, SALT.GLOBAL_FEATURE, TAG + 1, k, gj)) < P.slots[k].p;
  const presentZ = (k: number, gi: number): boolean => k === 0 || hash01(hash5(ctx.seed, SALT.GLOBAL_FEATURE, TAG + 2, k, gi)) < P.slots[k].p;
  const mat = (c: number): MatId => (fieldAt(l.decay, c) > 0.55 ? Mat.METAL_RUST : Mat.METAL_PAINTED);
  // pipes are collected first and emitted by flushPipes(), which splits a straight pipe wherever a riser meets it
  // mid-span (a tee): WP6 draws a junction fitting only where pipe endpoints coincide
  const specs: { a: Vec3; b: Vec3; r: number; c: number }[] = [];
  const addPipe = (a: Vec3, b: Vec3, r: number, c: number): void => { specs.push({ a, b, r, c }); };
  const ceilAt = (c: number): number => l.ceilCm[c] / 100;

  for (let axis = 0 as 0 | 1; axis < 2; axis = (axis + 1) as 0 | 1) {
    const fwd = axis === 0 ? 0 : 2, back = fwd + 1; // + / - directions along the run
    for (let line = 0; line < N; line++) {
      let k0 = 0;
      while (k0 < N) {
        const li0 = axis === 0 ? k0 : line, lj0 = axis === 0 ? line : k0;
        if (!isCorr(li0, lj0) || !(axis === 0 ? inRunX(li0, lj0) : inRunZ(li0, lj0))) { k0++; continue; }
        let k1 = k0;
        while (k1 + 1 < N && isCorr(axis === 0 ? k1 + 1 : line, axis === 0 ? line : k1 + 1)) k1++;
        // run cells k0..k1 (inclusive) along `axis` on `line`
        const cellAt = (k: number): [number, number] => (axis === 0 ? [k, line] : [line, k]);
        const [ai, aj] = cellAt(k0), [bi, bj] = cellAt(k1);
        const ca = cellIdx(ai, aj), cb = cellIdx(bi, bj);
        const contA = cont(ai, aj, back); // continues across the seam at the low end
        const contB = cont(bi, bj, fwd);
        const turnA = !contA && (axis === 0 ? inRunZ(ai, aj) : inRunX(ai, aj));
        const turnB = !contB && (axis === 0 ? inRunZ(bi, bj) : inRunX(bi, bj));
        // a run end that opens onto a room / stamp (walkable but not corridor): the pipe ends at the line and rises
        const openA = !contA && !turnA && kindWalkable(sideKind(l, ai, aj, back), sideHA(l, ai, aj, back)) && inChunk(ai + DX[back], aj + DZ[back]);
        const openB = !contB && !turnB && kindWalkable(sideKind(l, bi, bj, fwd), sideHA(l, bi, bj, fwd)) && inChunk(bi + DX[fwd], bj + DZ[fwd]);
        // a run end that opens onto another district: stop short of the seam (the riser stays in this chunk) and rise
        const edgeA = !contA && !turnA && edgeOut(ai, aj, back);
        const edgeB = !contB && !turnB && edgeOut(bi, bj, fwd);
        const gLine = (axis === 0 ? gj0 : gi0) + line;
        for (let si = 0; si < P.slots.length; si++) {
          const sl = P.slots[si];
          if (!(axis === 0 ? presentX(si, gLine) : presentZ(si, gLine))) continue;
          const h = axis === 0 ? sl.hx : sl.hz;
          const lat = (line + 0.5) * CELL + sl.side * sl.o; // lateral coordinate (z for x-pipes, x for z-pipes)
          const endA = turnA ? (k0 + 0.5) * CELL + sl.side * sl.o : edgeA ? k0 * CELL + EDGE_SETBACK : k0 * CELL;
          const endB = turnB ? (k1 + 0.5) * CELL + sl.side * sl.o : edgeB ? (k1 + 1) * CELL - EDGE_SETBACK : (k1 + 1) * CELL;
          if (endB - endA < MIN_PIPE) continue;
          const pa: [number, number, number] = axis === 0 ? [endA, h, lat] : [lat, h, endA];
          const pb: [number, number, number] = axis === 0 ? [endB, h, lat] : [lat, h, endB];
          addPipe(pa, pb, sl.r, ca);
          // vertical pieces at this run's ends
          for (const [isTurn, isOpenEnd, p, c] of [[turnA, openA || edgeA, pa, ca], [turnB, openB || edgeB, pb, cb]] as [boolean, boolean, Vec3, number][]) {
            if (isTurn) {
              // partner pipe of the same slot on the crossing line?
              const li = c & 31, lj = c >> 5;
              const partner = axis === 0 ? presentZ(si, gi0 + li) : presentX(si, gj0 + lj);
              if (partner) {
                // the riser is added once, by the x-run (axis 0) end; a z-run end whose partner x-run passes
                // through adds the tee riser itself
                const xPasses = axis === 1 && inRunX(li, lj) && !isRunEnd(li, lj, 0);
                if (axis === 0 || xPasses) {
                  const lo = Math.min(sl.hx, sl.hz), hi = Math.max(sl.hx, sl.hz);
                  addPipe([p[0], lo, p[2]], [p[0], hi, p[2]], sl.r, c);
                }
              } else {
                addPipe([p[0], h, p[2]], [p[0], ceilAt(c), p[2]], sl.r, c);
              }
            } else if (isOpenEnd) {
              addPipe([p[0], h, p[2]], [p[0], ceilAt(c), p[2]], sl.r, c);
            }
          }
        }
        // x-runs passing through a z-run end: the z-run adds the tee (above); nothing else to do
        // valve on the big pipe of long runs
        if (k1 - k0 >= 3 && P.slots.length > 0 && P.slots[0].r >= 0.06 && (axis === 0 ? presentX(0, gLine) : presentZ(0, gLine))) {
          const hv = hash5(ctx.seed, SALT.PROP, TAG, gLine * 2 + axis, (axis === 0 ? gi0 : gj0) + k0);
          if (hash01(hv) < 0.3) {
            const sl = P.slots[0];
            const km = (k0 + k1) >> 1;
            const along = (km + 0.5) * CELL, lat = (line + 0.5) * CELL + sl.side * sl.o;
            const hh = axis === 0 ? sl.hx : sl.hz;
            // the valve model fits a pipe of r <= 0.065 (flange r 0.074, axis 0.15 above its base): scale it to the pipe
            const vs = Math.max(1, sl.r / 0.065);
            g.addProp({
              kind: PropKind.PIPE_VALVE, variant: hv & 1, x: axis === 0 ? along : lat, y: hh - 0.15 * vs, z: axis === 0 ? lat : along,
              yaw: axis === 0 ? 0 : Math.PI / 2, scale: vs, flags: 0, seed: hv,
            });
          }
        }
        k0 = k1 + 1;
      }
    }
  }
  /** c is an end of its run along `axis` (no corridor continuation on one side, and no seam continuation). */
  function isRunEnd(li: number, lj: number, axis: 0 | 1): boolean {
    const fwd = axis === 0 ? 0 : 2;
    for (const d of [fwd, fwd + 1]) {
      const ni = li + DX[d], nj = lj + DZ[d];
      if (isCorr(ni, nj) || cont(li, lj, d)) continue;
      return true;
    }
    return false;
  }

  const bulb = new Uint8Array(CHUNK_CELL_COUNT);
  // ---- corridor lights: one bulb per 5-cell block of a corridor line (offset 2 or 3: spacing 4–6)
  for (let c = 0; c < CHUNK_CELL_COUNT; c++) {
    if (!corr[c]) continue;
    const li = c & 31, lj = c >> 5;
    const gi = gi0 + li, gj = gj0 + lj;
    let lit = false;
    if (inRunX(li, lj)) {
      const blk = floorDiv(gi, LIGHT_PITCH);
      if (mod(gi, LIGHT_PITCH) === 2 + (hash3(ctx.seed, gj, blk) & 1)) lit = true;
    }
    if (!lit && inRunZ(li, lj)) {
      const blk = floorDiv(gj, LIGHT_PITCH);
      if (mod(gj, LIGHT_PITCH) === 2 + (hash3(ctx.seed ^ 0x55, gi, blk) & 1)) lit = true;
    }
    if (!lit) continue;
    let crowded = false; // never two bulbs in neighbouring cells (a turn cell can qualify on both axes)
    for (let dj = -1; dj <= 1 && !crowded; dj++) for (let di = -1; di <= 1 && !crowded; di++) {
      if (inChunk(li + di, lj + dj) && bulb[cellIdx(li + di, lj + dj)]) crowded = true;
    }
    if (crowded) continue;
    bulb[c] = 1;
    placer.add(bulbSpec((li + 0.5) * CELL, ceilAt(c) - 0.3, (lj + 0.5) * CELL, 64, BULB_CCT, 0.3));
  }

  // ---- boiler room contents
  for (const r of rooms) {
    const rr = new Rng(hash5(ctx.seed, SALT.PROP, TAG + 3, gi0 + r.i0, gj0 + r.j0));
    const cx = (r.i0 + 2.5) * CELL, cz = (r.j0 + 2.5) * CELL;
    const ceilY = ROOM_CEIL_CM / 100;
    const c0 = cellIdx(r.i0 + 2, r.j0 + 2);
    g.addProp({ kind: PropKind.BOILER, variant: rr.int(0, 1), x: cx, y: 0, z: cz, yaw: rr.int(0, 3) * Math.PI / 2, scale: 1, flags: 0, seed: rr.next() });
    // tank on a perimeter cell (corners first) whose outside neighbours are solid: never in front of an entrance
    const corners: [number, number][] = [[0, 0], [4, 0], [0, 4], [4, 4]];
    const edgesP: [number, number][] = [];
    for (let k = 1; k < 4; k++) edgesP.push([k, 0], [k, 4], [0, k], [4, k]);
    rr.shuffle(corners);
    rr.shuffle(edgesP);
    let tank: [number, number] | null = null;
    for (const [ci, cj] of [...corners, ...edgesP]) {
      const li = r.i0 + ci, lj = r.j0 + cj;
      let closed = true;
      if (ci === 0 || ci === 4) { const ox = li + (ci === 0 ? -1 : 1); if (inChunk(ox, lj) && open[cellIdx(ox, lj)]) closed = false; }
      if (cj === 0 || cj === 4) { const oz = lj + (cj === 0 ? -1 : 1); if (inChunk(li, oz) && open[cellIdx(li, oz)]) closed = false; }
      if (closed) { tank = [li, lj]; break; }
    }
    if (tank) {
      const tx = (tank[0] + 0.5) * CELL, tz = (tank[1] + 0.5) * CELL;
      g.addProp({ kind: PropKind.TANK, variant: rr.int(0, 1), x: tx, y: 0, z: tz, yaw: 0, scale: 1, flags: 0, seed: rr.next() });
      // boiler -> tank: along x then z at 2.5 m, then down into the tank top. A tank in the boiler's column or row
      // needs only one horizontal leg (a zero-length leg would be a degenerate elbow partner for WP6)
      const y = 2.5;
      const legX = Math.abs(tx - cx) > 1e-6, legZ = Math.abs(tz - cz) > 1e-6;
      if (legX) addPipe([cx, y, cz], [tx, y, cz], 0.07, c0);
      if (legZ) addPipe([tx, y, cz], [tx, y, tz], 0.07, c0);
      addPipe([tx, y, tz], [tx, 2.4, tz], 0.07, c0);
      const vx = legX && (!legZ || Math.abs(tx - cx) >= Math.abs(tz - cz)); // valve on the longer leg
      g.addProp({
        kind: PropKind.PIPE_VALVE, variant: 0, x: vx ? (cx + tx) / 2 : tx, y: y - 0.15, z: vx ? cz : (cz + tz) / 2,
        yaw: vx ? 0 : Math.PI / 2, scale: 1, flags: 0, seed: rr.next(),
      });
    }
    addPipe([cx, 2.2, cz], [cx, ceilY, cz], 0.12, c0); // flue riser
    g.addEmitter(EmitterKind.MACHINE, cx, 1.2, cz, 0.6);
    if (rr.chance(0.5)) g.addEmitter(EmitterKind.STEAM, cx, 2.2, cz, 0.45);
    // two cage bulbs on opposite sides of the boiler
    const offs = rr.chance(0.5) ? [[-1.8, 0], [1.8, 0]] : [[0, -1.8], [0, 1.8]];
    for (const [ox, oz] of offs) placer.add(bulbSpec(cx + ox, ceilY - 0.4, cz + oz, 64, BULB_CCT, 0.3));
  }

  // ---- emit the pipe network, split at tees
  const pipeMids: Vec3[] = [];
  const emit = (a: Vec3, b: Vec3, r: number, c: number): void => {
    if (Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) < 1e-3) return; // never a degenerate pipe
    g.addSolid({ kind: 'pipe', a, b, r, mat: mat(c), flags: PIPE_FLAGS });
    pipeMids.push([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]);
  };
  const riserEnds: Vec3[] = [];
  for (const p of specs) if (Math.abs(p.a[0] - p.b[0]) < 1e-9 && Math.abs(p.a[2] - p.b[2]) < 1e-9) riserEnds.push(p.a, p.b);
  const cuts: number[] = [];
  for (const p of specs) {
    const alongX = Math.abs(p.a[1] - p.b[1]) < 1e-9 && Math.abs(p.a[2] - p.b[2]) < 1e-9;
    const alongZ = Math.abs(p.a[1] - p.b[1]) < 1e-9 && Math.abs(p.a[0] - p.b[0]) < 1e-9;
    if (!alongX && !alongZ) { emit(p.a, p.b, p.r, p.c); continue; }
    const ax = alongX ? 0 : 2, lat = alongX ? 2 : 0;
    const lo = Math.min(p.a[ax], p.b[ax]), hi = Math.max(p.a[ax], p.b[ax]);
    cuts.length = 0;
    for (const q of riserEnds) {
      if (Math.abs(q[1] - p.a[1]) > 1e-6 || Math.abs(q[lat] - p.a[lat]) > 1e-6) continue;
      if (q[ax] > lo + 0.01 && q[ax] < hi - 0.01 && !cuts.includes(q[ax])) cuts.push(q[ax]);
    }
    if (cuts.length === 0) { emit(p.a, p.b, p.r, p.c); continue; }
    const up = p.b[ax] > p.a[ax];
    cuts.sort((u, v) => (up ? u - v : v - u));
    let from = p.a;
    for (const t of cuts) {
      const to: Vec3 = [p.a[0], p.a[1], p.a[2]];
      to[ax] = t;
      emit(from, to, p.r, p.c);
      from = to;
    }
    emit(from, p.b, p.r, p.c);
  }

  // ---- ambience: pipe knocks, steam, drips
  const er = new Rng(hash5(ctx.seed, SALT.EMITTER, TAG, ctx.key.cx, ctx.key.cz));
  for (let k = 0; k < 3 && pipeMids.length; k++) {
    const m = pipeMids[er.int(0, pipeMids.length - 1)];
    g.addEmitter(EmitterKind.PIPE, m[0], m[1], m[2], 0.25 + 0.2 * er.float());
  }
  if (pipeMids.length && er.chance(0.5)) {
    const m = pipeMids[er.int(0, pipeMids.length - 1)];
    g.addEmitter(EmitterKind.STEAM, m[0], m[1], m[2], 0.4);
  }
  for (let k = 0; k < 2; k++) {
    const li = er.int(1, N - 2), lj = er.int(1, N - 2);
    const c = cellIdx(li, lj);
    if (corr[c]) g.addEmitter(EmitterKind.DRIP, (li + 0.5) * CELL, ceilAt(c) - 0.02, (lj + 0.5) * CELL, 0.35);
  }
  // R2: zone-transition connectors (CMU service corridors with a tube strip) behind boundary openings
  transitionStamps(ctx, null);
}

export const pipeworksGenerator: ZoneGenerator = {
  id: Zone.PIPEWORKS,
  seamMode: 'pattern',
  seamPattern,
  districtParams,
  generate,
  palette(_s: StoreyId, d: DistrictInfo): ZonePalette {
    // utility tunnels: raw (unpainted) concrete block
    return {
      floorMat: Mat.CONCRETE_FLOOR, wallMat: Mat.CMU_RAW, ceilMat: Mat.CONCRETE_CEIL, trimMat: Mat.CMU_RAW,
      ceilKind: CeilKind.CONCRETE, ceilCm: params(d).ceil, baseboard: false,
    };
  },
  lighting(_s: StoreyId, _d: DistrictInfo): LightingProfile {
    return {
      kind: FixtureKind.CAGE_BULB, placement: 'custom', lattice: [LIGHT_PITCH * 2, LIGHT_PITCH * 2], phase: [0, 0], axis: 0,
      cctRange: [BULB_CCT[0], BULB_CCT[1]], luminance: 64, zoneMul: 0.7, mountCm: 30,
    };
  },
  props: {
    rules: [
      { kind: PropKind.BUCKET, where: 'corner', per100m2: 0.3, variants: 2, minSpacing: 6, yCm: 0 },
      { kind: PropKind.PIPE_VALVE, where: 'wallMounted', per100m2: 0.4, variants: 2, minSpacing: 4, yCm: 110 },
      { kind: PropKind.EXTINGUISHER, where: 'wallMounted', per100m2: 0.15, variants: 1, minSpacing: 10, yCm: 60 },
      { kind: PropKind.CRATE, where: 'corner', per100m2: 0.15, variants: 3, minSpacing: 6, yCm: 0 },
    ],
  },
};

/** Test hook: the decoded pipe slots of a district. */
export const pipeworksSlots = (d: DistrictInfo): readonly Slot[] => params(d).slots;
