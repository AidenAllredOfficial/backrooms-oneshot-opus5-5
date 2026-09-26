// src/app/worldDebug.ts (WP14, private) — CellInfo and the ASCII view of resident layouts (debug API §7.2).
// Reads only WorldQuery.layoutAt (resident data of the current storey); no allocation concerns (debug only).

import { CHUNK_CELLS } from '../core/constants.ts';
import { cellIdx, exIdx, ezIdx, tileOfLocalCell, worldToCell } from '../core/grid.ts';
import { CellFlag, EdgeKind, MOOD_NAMES, ZONE_NAMES } from '../core/ids.ts';
import type { StoreyId } from '../core/ids.ts';
import type { CellInfo } from '../core/debug.ts';
import { NO_WATER } from '../core/layout.ts';
import type { ChunkLayout } from '../core/layout.ts';
import type { WorldQuery } from '../core/runtime.ts';

export const EDGE_KIND_NAMES: readonly string[] = Object.keys(EdgeKind); // index = EdgeKind value (0..9, dense)

const edgeName = (k: number): string => EDGE_KIND_NAMES[k] ?? `KIND_${k}`;

function locate(q: WorldQuery, gi: number, gj: number): { l: ChunkLayout; li: number; lj: number; cx: number; cz: number } | null {
  const cx = Math.floor(gi / CHUNK_CELLS);
  const cz = Math.floor(gj / CHUNK_CELLS);
  const l = q.layoutAt(cx, cz);
  if (!l) return null;
  return { l, li: gi - cx * CHUNK_CELLS, lj: gj - cz * CHUNK_CELLS, cx, cz };
}

export function cellInfoAt(q: WorldQuery, s: StoreyId, x: number, z: number): CellInfo | null {
  if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
  const gi = worldToCell(x), gj = worldToCell(z);
  const c = locate(q, gi, gj);
  if (!c) return null;
  const { l, li, lj } = c;
  const i = cellIdx(li, lj);
  return {
    s, gi, gj, chunk: [c.cx, c.cz], tile: tileOfLocalCell(li, lj),
    zone: ZONE_NAMES[l.cellZone[i]] ?? String(l.cellZone[i]), mood: MOOD_NAMES[l.mood] ?? String(l.mood),
    flags: l.flags[i], floorY: l.floorCm[i] / 100, ceilY: l.ceilCm[i] / 100,
    waterY: l.waterCm[i] === NO_WATER ? null : l.waterCm[i] / 100, room: l.room[i],
    power: l.power[i] / 255, decay: l.decay[i] / 255, humidity: l.humidity[i] / 255, warmth: l.warmth[i] / 255,
    edges: {
      W: edgeName(l.ex.kind[exIdx(li, lj)]), E: edgeName(l.ex.kind[exIdx(li + 1, lj)]),
      N: edgeName(l.ez.kind[ezIdx(li, lj)]), S: edgeName(l.ez.kind[ezIdx(li, lj + 1)]),
    },
  };
}

// edge glyphs by EdgeKind: OPEN WALL DOORWAY HEADER ARCH PARTITION HALF RAIL WINDOW GLITCH
const H_EDGE = [' ', '-', '.', '~', '^', '=', '_', ':', '#', '!'];
const V_EDGE = [' ', '|', '.', '~', '^', 'I', 'i', ':', '#', '!'];

function cellGlyph(l: ChunkLayout, i: number): string {
  const f = l.flags[i];
  if (f & CellFlag.SOLID) return '#';
  if (f & CellFlag.VOID) return 'O';
  if (f & CellFlag.TOWER) return 'T';
  if (f & CellFlag.ELEVATOR) return 'E';
  if (l.waterCm[i] !== NO_WATER && l.waterCm[i] > l.floorCm[i]) return f & CellFlag.NOWALK ? 'W' : '~';
  if (f & CellFlag.NOWALK) return 'x';
  if (f & CellFlag.LANDMARK) return 'L';
  if (f & CellFlag.ARTERY) return ',';
  return '.';
}

export const ASCII_LEGEND =
  "@ you  . floor  , artery  # solid  O void/pit  T tower  E elevator  L landmark  ~ water  W deep water  x no-walk  ? not loaded\n" +
  "edges: -| wall  . doorway  ~ header  ^ arch  =I partition  _i half wall  : rail  # window  ! glitch";

/** Resident layouts around (x, z) in a (2r+1)^2 cell window; one char per cell and per edge; north is up. */
export function asciiAround(q: WorldQuery, x: number, z: number, radiusCells: number): string {
  const r = Math.max(1, Math.min(96, Math.floor(Number.isFinite(radiusCells) ? radiusCells : 24)));
  const pgi = worldToCell(x), pgj = worldToCell(z);
  const lines: string[] = [ASCII_LEGEND, `cell (${pgi}, ${pgj}), radius ${r}`];
  const hKind = (gi: number, gj: number): number => { // edge on line z = gj (north of cell gj)
    const c = locate(q, gi, gj);
    return c ? c.l.ez.kind[ezIdx(c.li, c.lj)] : -1;
  };
  const vKind = (gi: number, gj: number): number => { // edge on line x = gi (west of cell gi)
    const c = locate(q, gi, gj);
    return c ? c.l.ex.kind[exIdx(c.li, c.lj)] : -1;
  };
  const open = (k: number): boolean => k <= 0;
  for (let gj = pgj - r; gj <= pgj + r + 1; gj++) {
    // edge row: corners + north edges of row gj
    let e = '';
    for (let gi = pgi - r; gi <= pgi + r + 1; gi++) {
      const around = [hKind(gi - 1, gj), hKind(gi, gj), vKind(gi, gj - 1), vKind(gi, gj)];
      e += around.some((k) => !open(k)) ? '+' : ' ';
      if (gi <= pgi + r) {
        const k = hKind(gi, gj);
        e += k < 0 ? ' ' : H_EDGE[k] ?? '?';
      }
    }
    lines.push(e.replace(/\s+$/, ''));
    if (gj > pgj + r) break;
    // cell row
    let c = '';
    for (let gi = pgi - r; gi <= pgi + r + 1; gi++) {
      const k = vKind(gi, gj);
      c += k < 0 ? ' ' : V_EDGE[k] ?? '?';
      if (gi <= pgi + r) {
        if (gi === pgi && gj === pgj) { c += '@'; continue; }
        const loc = locate(q, gi, gj);
        c += loc ? cellGlyph(loc.l, cellIdx(loc.li, loc.lj)) : '?';
      }
    }
    lines.push(c.replace(/\s+$/, ''));
  }
  return lines.join('\n');
}
