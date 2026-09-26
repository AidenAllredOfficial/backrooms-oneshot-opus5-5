// src/world/ascii.ts — ASCII rendering / parsing of layouts (2x2 characters per cell, (2W+1)x(2H+1) grid) (WP1).
//
// Character (2i+1, 2j+1) is cell (i, j); (2i, 2j+1) its WEST edge (ex line i); (2i+1, 2j) its NORTH edge (ez line
// j); (2i, 2j) the vertex. Vertices print '+' where any adjacent edge is not OPEN (' ' in open space).
//   edges: WALL '-' / '|', DOORWAY 'd', HEADER 'h', ARCH 'a', PARTITION ':', HALF '=', RAIL '"', WINDOW 'w',
//          GLITCH '%', OPEN ' '
//   cells (highest precedence first): '@' player / marks, 'S' tower, 'E' elevator, '*' landmark, 'L' light ON,
//          'f' dynamic, 'y' DYING, 'l' OFF, 'v' vignette, 'p' prop, '~' water, '#' SOLID, ' ' VOID, '.' walkable
// layoutFromAscii parses the same format (unknown glyphs are ignored; cells the text does not cover are SOLID).

import { CELL, CHUNK_CELLS, CHUNK_CELL_COUNT, STD_CEIL_CM } from '../core/constants.ts';
import { edgeDefaults } from '../core/edges.ts';
import { cellIdx, exIdx, ezIdx, worldToCell, type ChunkKey } from '../core/grid.ts';
import {
  CeilKind, CellFlag, EdgeKind, EdgeTrim, FixtureKind, LightState, Mat, Mood, PropKind, TileState, VignetteKind, Zone,
} from '../core/ids.ts';
import { createEmptyLayout, fixtureId, fixtureSeed, NO_WATER, setTile, type ChunkLayout, type EdgeGrid } from '../core/layout.ts';
import type { ZonePalette } from '../core/world.ts';
import { STRUCTURE_ZONE } from '../core/zones.ts';
import { computePorts } from './connectivity.ts';
import { labelRooms, markSpawnCells } from './rooms.ts';
import { layoutHash } from './validate.ts';

const N = CHUNK_CELLS;
const H_GLYPH = ['', '-', 'd', 'h', 'a', ':', '=', '"', 'w', '%'];
const V_GLYPH = ['', '|', 'd', 'h', 'a', ':', '=', '"', 'w', '%'];

/** Cell glyphs of one layout (1024 chars as char codes), by the precedence above. */
function cellGlyphs(l: ChunkLayout): string[] {
  const g = new Array<string>(CHUNK_CELL_COUNT);
  const rank = new Uint8Array(CHUNK_CELL_COUNT); // higher = stronger
  for (let c = 0; c < CHUNK_CELL_COUNT; c++) {
    const f = l.flags[c];
    let ch = '.', r = 1;
    if ((f & CellFlag.VOID) !== 0) { ch = ' '; r = 2; }
    if ((f & CellFlag.SOLID) !== 0) { ch = '#'; r = 3; }
    if (l.waterCm[c] !== NO_WATER || (f & CellFlag.NOWALK) !== 0) { ch = '~'; r = 4; }
    if ((f & CellFlag.LANDMARK) !== 0) { ch = '*'; r = 12; }
    if ((f & CellFlag.ELEVATOR) !== 0) { ch = 'E'; r = 13; }
    if ((f & CellFlag.TOWER) !== 0) { ch = 'S'; r = 14; }
    g[c] = ch; rank[c] = r;
  }
  const put = (x: number, z: number, ch: string, r: number): void => {
    const li = worldToCell(x), lj = worldToCell(z);
    if (li < 0 || lj < 0 || li >= N || lj >= N) return;
    const c = cellIdx(li, lj);
    if (r > rank[c]) { g[c] = ch; rank[c] = r; }
  };
  for (const p of l.props) put(p.x, p.z, 'p', 5);
  for (const v of l.vignettes) put(v.x, v.z, 'v', 6);
  for (const f of l.fixtures) {
    if (f.dynamic) put(f.px, f.pz, 'f', 9);
    else if (f.state === LightState.ON || f.state === LightState.BUZZ) put(f.px, f.pz, 'L', 11);
    else if (f.state === LightState.DYING || f.state === LightState.FLICKER || f.state === LightState.ANOMALY) put(f.px, f.pz, 'y', 8);
    else put(f.px, f.pz, 'l', 7);
  }
  return g;
}

/** Writes one chunk into a character grid at chunk offset (ox, oz) in cells. */
function drawChunk(l: ChunkLayout, rows: string[][], ox: number, oz: number): void {
  const g = cellGlyphs(l);
  for (let lj = 0; lj < N; lj++) {
    for (let li = 0; li < N; li++) {
      rows[2 * (oz + lj) + 1][2 * (ox + li) + 1] = g[cellIdx(li, lj)];
    }
  }
  // edges (both border lines are stored, so each chunk draws its own; shared lines agree)
  for (let lj = 0; lj < N; lj++) {
    for (let i = 0; i <= N; i++) {
      const k = l.ex.kind[exIdx(i, lj)];
      rows[2 * (oz + lj) + 1][2 * (ox + i)] = k === EdgeKind.OPEN ? ' ' : V_GLYPH[k] ?? '?';
    }
  }
  for (let j = 0; j <= N; j++) {
    for (let li = 0; li < N; li++) {
      const k = l.ez.kind[ezIdx(li, j)];
      rows[2 * (oz + j)][2 * (ox + li) + 1] = k === EdgeKind.OPEN ? ' ' : H_GLYPH[k] ?? '?';
    }
  }
}

function finishVertices(rows: string[][]): void {
  const H = rows.length, W = rows[0].length;
  for (let y = 0; y < H; y += 2) {
    for (let x = 0; x < W; x += 2) {
      const any = (y > 0 && rows[y - 1][x] !== ' ') || (y < H - 1 && rows[y + 1][x] !== ' ') ||
        (x > 0 && rows[y][x - 1] !== ' ') || (x < W - 1 && rows[y][x + 1] !== ' ');
      rows[y][x] = any ? '+' : ' ';
    }
  }
}

export function layoutToAscii(l: ChunkLayout, marks?: { li: number; lj: number; ch: string }[]): string {
  const rows: string[][] = [];
  for (let y = 0; y <= 2 * N; y++) rows.push(new Array<string>(2 * N + 1).fill(' '));
  drawChunk(l, rows, 0, 0);
  finishVertices(rows);
  if (marks) {
    for (const m of marks) {
      if (m.li >= 0 && m.lj >= 0 && m.li < N && m.lj < N) rows[2 * m.lj + 1][2 * m.li + 1] = m.ch.charAt(0) || '@';
    }
  }
  return rows.map((r) => r.join('')).join('\n');
}

/** Multi-chunk map: `layouts[(cz − cz0)·nx + (cx − cx0)]`, nx × nz chunks sharing border lines. */
export function asciiMapFromLayouts(layouts: readonly ChunkLayout[], nx: number, nz: number, marks?: { gi: number; gj: number; ch: string }[]): string {
  const rows: string[][] = [];
  for (let y = 0; y <= 2 * N * nz; y++) rows.push(new Array<string>(2 * N * nx + 1).fill(' '));
  for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) drawChunk(layouts[z * nx + x], rows, x * N, z * N);
  finishVertices(rows);
  if (marks && layouts.length > 0) {
    const gi0 = layouts[0].key.cx * N, gj0 = layouts[0].key.cz * N;
    for (const m of marks) {
      const x = m.gi - gi0, z = m.gj - gj0;
      if (x >= 0 && z >= 0 && x < nx * N && z < nz * N) rows[2 * z + 1][2 * x + 1] = m.ch.charAt(0) || '@';
    }
  }
  return rows.map((r) => r.join('')).join('\n');
}

const EDGE_OF: Readonly<Record<string, number>> = {
  '-': EdgeKind.WALL, '|': EdgeKind.WALL, d: EdgeKind.DOORWAY, h: EdgeKind.HEADER, a: EdgeKind.ARCH, ':': EdgeKind.PARTITION,
  '=': EdgeKind.HALF, '"': EdgeKind.RAIL, w: EdgeKind.WINDOW, '%': EdgeKind.GLITCH,
};

export function layoutFromAscii(key: ChunkKey, text: string, palette?: Partial<ZonePalette>): ChunkLayout {
  const pal: ZonePalette = {
    floorMat: palette?.floorMat ?? Mat.CARPET_L0, wallMat: palette?.wallMat ?? Mat.WALLPAPER_L0,
    ceilMat: palette?.ceilMat ?? Mat.CEILING_TILE, trimMat: palette?.trimMat ?? Mat.TRIM_PAINT,
    ceilKind: palette?.ceilKind ?? CeilKind.TILES, ceilCm: palette?.ceilCm ?? STD_CEIL_CM, baseboard: palette?.baseboard ?? true,
  };
  const l = createEmptyLayout(key, Zone.LOBBY, 0, Mood.NORMAL);
  l.ceilCm.fill(pal.ceilCm);
  l.floorMat.fill(pal.floorMat);
  l.ceilMat.fill(pal.ceilMat);
  l.ceilKind.fill(pal.ceilKind);
  l.cellZone.fill(Zone.LOBBY);
  l.wallMat.fill(pal.wallMat);
  l.trimMat.fill(pal.trimMat);
  l.flags.fill(CellFlag.SOLID);
  for (const e of [l.ex, l.ez] as EdgeGrid[]) { e.matNeg.fill(pal.wallMat); e.matPos.fill(pal.wallMat); }
  const baseTrim = pal.baseboard ? EdgeTrim.BASEBOARD : 0;
  const lines = text.replace(/\r/g, '').split('\n');
  const at = (x: number, y: number): string => (y < lines.length && x < lines[y].length ? lines[y][x] : ' ');
  const H = Math.min(N, Math.floor((lines.length - 1) / 2));
  let W = 0;
  for (const s of lines) W = Math.max(W, Math.floor((s.length - 1) / 2));
  W = Math.min(N, W);
  const setE = (e: EdgeGrid, k: number, ch: string, casing: boolean): void => {
    const kind = EDGE_OF[ch];
    if (kind === undefined) return;
    const d = edgeDefaults(kind);
    e.kind[k] = kind; e.hA[k] = d[0]; e.hB[k] = d[1];
    e.trim[k] = kind === EdgeKind.DOORWAY && casing ? baseTrim | EdgeTrim.CASING : baseTrim;
  };
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const c = cellIdx(i, j);
      const ch = at(2 * i + 1, 2 * j + 1);
      const px = (i + 0.5) * CELL, pz = (j + 0.5) * CELL;
      let flags = 0;
      switch (ch) {
        case '#': flags = CellFlag.SOLID; break;
        case ' ': flags = CellFlag.VOID; break;
        case 'S': flags = CellFlag.TOWER | CellFlag.RESERVED; l.cellZone[c] = STRUCTURE_ZONE; break;
        case 'E': flags = CellFlag.ELEVATOR | CellFlag.RESERVED; l.cellZone[c] = STRUCTURE_ZONE; break;
        case '*': flags = CellFlag.LANDMARK; break;
        case '~':
          l.waterCm[c] = 20;
          l.water.push({ x0: i * CELL, z0: j * CELL, x1: (i + 1) * CELL, z1: (j + 1) * CELL, y: 0.2, floorY: 0, kind: 1 });
          break;
        case 'p': l.props.push({ kind: PropKind.CARDBOARD_BOX, variant: 0, x: px, y: 0, z: pz, yaw: 0, scale: 1, flags: 0, seed: c }); break;
        case 'v': l.vignettes.push({ kind: VignetteKind.CHAIR_FACING_WALL, x: px, z: pz, yaw: 0, seed: c }); break;
        case 'L': case 'f': case 'y': case 'l': {
          // 2x4 troffer on the tx = 1 ceiling-tile column of the cell, long axis z (fills 2 tiles exactly).
          // Lattice key = the 0.6 m tile containing the centre (x = gi·1.2 + 0.9, z = gj·1.2 + 0.6): (2gi+1, 2gj+1).
          const state = ch === 'L' ? LightState.ON : ch === 'f' ? LightState.FLICKER : ch === 'y' ? LightState.DYING : LightState.OFF;
          const latticeI = 2 * (key.cx * N + i) + 1, latticeJ = 2 * (key.cz * N + j) + 1;
          const id = fixtureId(0, key.s, latticeI, latticeJ, FixtureKind.TROFFER_2x4);
          l.fixtures.push({
            id, kind: FixtureKind.TROFFER_2x4, state, shape: 0, px: i * CELL + 0.9, py: pal.ceilCm / 100, pz,
            nx: 0, ny: -1, nz: 0, tx: 0, ty: 0, tz: 1, w: 1.2, h: 0.6, color: [1, 0.93, 0.82], luminance: 3300,
            seed: fixtureSeed(id), hum: 0.5, bakeGroup: 0, dynamic: ch === 'f',
          });
          setTile(l.tiles, c, 1, TileState.FIXTURE);
          setTile(l.tiles, c, 3, TileState.FIXTURE);
          break;
        }
        default: break; // '.', '@', unknown glyphs: walkable floor
      }
      l.flags[c] = flags;
    }
  }
  for (let j = 0; j < H; j++) for (let i = 0; i <= W; i++) setE(l.ex, exIdx(i, j), at(2 * i, 2 * j + 1), true);
  for (let j = 0; j <= H; j++) for (let i = 0; i < W; i++) setE(l.ez, ezIdx(i, j), at(2 * i + 1, 2 * j), true);
  labelRooms(l);
  markSpawnCells(l);
  l.ports = computePorts(l);
  l.hash = layoutHash(l);
  return l;
}
