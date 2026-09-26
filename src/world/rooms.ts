// src/world/rooms.ts — room labelling, spawn flags and corridor width (WP1).
//
// Rooms: flood fill over non-SOLID cells, separated by every edge that is not OPEN / HEADER / ARCH. In doorless
// zones (LOBBY) a room can be hundreds of cells: `room` is used ONLY for probe interpolation (WP7) and acoustics.
// Placement rules use local measures instead (corridorWidth, distance-to-wall maxima).

import { CELL, CHUNK_CELLS, CHUNK_CELL_COUNT } from '../core/constants.ts';
import { cellIdx, exIdx, ezIdx, worldToCell } from '../core/grid.ts';
import { CellFlag, EdgeKind, LightState } from '../core/ids.ts';
import type { ChunkLayout } from '../core/layout.ts';
import { cellWalkable } from './connectivity.ts';

const N = CHUNK_CELLS;
const SPAWN_LIGHT_R = 4; // m
const SPAWN_MIN_BLOCK = 5; // walkable cells in the 3x3 block

/** OPEN / HEADER / ARCH: edges that do not separate rooms. */
const joinsRooms = (kind: number): boolean => kind === EdgeKind.OPEN || kind === EdgeKind.HEADER || kind === EdgeKind.ARCH;

/** Returns the room count; writes l.room (0 = none / solid). */
export function labelRooms(l: ChunkLayout): number {
  const room = l.room;
  room.fill(0);
  const stack = new Int32Array(CHUNK_CELL_COUNT);
  let label = 0;
  for (let c0 = 0; c0 < CHUNK_CELL_COUNT; c0++) {
    if (room[c0] !== 0 || (l.flags[c0] & CellFlag.SOLID) !== 0) continue;
    if (label === 0xffff) break;
    room[c0] = ++label;
    let sp = 0;
    stack[sp++] = c0;
    while (sp > 0) {
      const c = stack[--sp];
      const li = c & 31, lj = c >> 5;
      for (let d = 0; d < 4; d++) {
        let n: number, kind: number;
        if (d === 0) { if (li === 0) continue; n = c - 1; kind = l.ex.kind[exIdx(li, lj)]; }
        else if (d === 1) { if (li === N - 1) continue; n = c + 1; kind = l.ex.kind[exIdx(li + 1, lj)]; }
        else if (d === 2) { if (lj === 0) continue; n = c - N; kind = l.ez.kind[ezIdx(li, lj)]; }
        else { if (lj === N - 1) continue; n = c + N; kind = l.ez.kind[ezIdx(li, lj + 1)]; }
        if (!joinsRooms(kind) || room[n] !== 0 || (l.flags[n] & CellFlag.SOLID) !== 0) continue;
        room[n] = label;
        stack[sp++] = n;
      }
    }
  }
  return label;
}

/** SPAWN_OK: walkable, not reserved, >= 1 ON fixture within 4 m, >= 5 walkable cells in its 3x3 block. */
export function markSpawnCells(l: ChunkLayout): void {
  const lit = new Uint8Array(CHUNK_CELL_COUNT);
  const r2 = SPAWN_LIGHT_R * SPAWN_LIGHT_R;
  const reach = Math.ceil(SPAWN_LIGHT_R / CELL);
  for (const f of l.fixtures) {
    if (f.state !== LightState.ON) continue;
    const fi = worldToCell(f.px), fj = worldToCell(f.pz);
    for (let lj = Math.max(0, fj - reach); lj <= Math.min(N - 1, fj + reach); lj++) {
      for (let li = Math.max(0, fi - reach); li <= Math.min(N - 1, fi + reach); li++) {
        const dx = (li + 0.5) * CELL - f.px, dz = (lj + 0.5) * CELL - f.pz;
        if (dx * dx + dz * dz <= r2) lit[cellIdx(li, lj)] = 1;
      }
    }
  }
  const walk = new Uint8Array(CHUNK_CELL_COUNT);
  for (let c = 0; c < CHUNK_CELL_COUNT; c++) walk[c] = cellWalkable(l, c) ? 1 : 0;
  for (let lj = 0; lj < N; lj++) {
    for (let li = 0; li < N; li++) {
      const c = cellIdx(li, lj);
      l.flags[c] &= ~CellFlag.SPAWN_OK;
      if (!walk[c] || !lit[c] || (l.flags[c] & (CellFlag.RESERVED | CellFlag.SEALED)) !== 0) continue;
      let n = 0;
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          const i = li + di, j = lj + dj;
          if (i >= 0 && j >= 0 && i < N && j < N && walk[cellIdx(i, j)]) n++;
        }
      }
      if (n >= SPAWN_MIN_BLOCK) l.flags[c] |= CellFlag.SPAWN_OK;
    }
  }
}

/** A cell a free run can continue into: not SOLID / VOID, no blocker. */
const freeCell = (l: ChunkLayout, c: number): boolean => (l.flags[c] & (CellFlag.SOLID | CellFlag.VOID)) === 0 && l.blockCm[c] === 0;

/** Free run (cells) through (li, lj) along one axis: consecutive free cells joined by OPEN/HEADER/ARCH edges. */
function freeRun(l: ChunkLayout, li: number, lj: number, axis: 'x' | 'z'): number {
  let n = 1;
  if (axis === 'x') {
    for (let i = li; i > 0 && joinsRooms(l.ex.kind[exIdx(i, lj)]) && freeCell(l, cellIdx(i - 1, lj)); i--) n++;
    for (let i = li + 1; i < N && joinsRooms(l.ex.kind[exIdx(i, lj)]) && freeCell(l, cellIdx(i, lj)); i++) n++;
  } else {
    for (let j = lj; j > 0 && joinsRooms(l.ez.kind[ezIdx(li, j)]) && freeCell(l, cellIdx(li, j - 1)); j--) n++;
    for (let j = lj + 1; j < N && joinsRooms(l.ez.kind[ezIdx(li, j)]) && freeCell(l, cellIdx(li, j)); j++) n++;
  }
  return n;
}

/** Free run (cells) through (li, lj) perpendicular to its dominant free axis. Used by WP4 and WP7.
 * "Corridor" everywhere in the spec means corridorWidth <= 2. 0 for SOLID/VOID/blocked cells. Runs stop at the
 * chunk border, so the value is capped at 32. */
export function corridorWidth(l: ChunkLayout, li: number, lj: number): number {
  if (li < 0 || lj < 0 || li >= N || lj >= N) return 0;
  if (!freeCell(l, cellIdx(li, lj))) return 0;
  const rx = freeRun(l, li, lj, 'x'), rz = freeRun(l, li, lj, 'z');
  return rx >= rz ? rz : rx;
}
