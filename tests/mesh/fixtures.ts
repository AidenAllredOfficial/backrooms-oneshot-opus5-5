// tests/mesh/fixtures.ts — hand-built WP5 coverage fixtures (layoutFromAscii + direct layout edits).

import { cellIdx, exIdx, ezIdx } from '../../src/core/grid.ts';
import { CeilKind, EdgeKind, EdgeTrim, Mat, SolidFlag, TileState } from '../../src/core/ids.ts';
import { setTile, type ChunkLayout } from '../../src/core/layout.ts';
import type { LayoutNeighborhood } from '../../src/core/world.ts';
import { asciiNb } from './helpers.ts';

const N = 32;

/** Character grid in the ascii.ts format (cells default SOLID '#', edges OPEN). */
export class Scene {
  readonly rows: string[][] = [];
  constructor() {
    for (let y = 0; y <= 2 * N; y++) this.rows.push(new Array<string>(2 * N + 1).fill(' '));
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) this.rows[2 * j + 1][2 * i + 1] = '#';
  }
  cell(i: number, j: number, ch: string): this { this.rows[2 * j + 1][2 * i + 1] = ch; return this; }
  cells(i0: number, j0: number, i1: number, j1: number, ch: string): this {
    for (let j = j0; j < j1; j++) for (let i = i0; i < i1; i++) this.cell(i, j, ch);
    return this;
  }
  /** Floor cells [i0,i1)x[j0,j1) enclosed by WALL edges. */
  room(i0: number, j0: number, i1: number, j1: number): this {
    this.cells(i0, j0, i1, j1, '.');
    for (let j = j0; j < j1; j++) { this.xEdge(i0, j, '|'); this.xEdge(i1, j, '|'); }
    for (let i = i0; i < i1; i++) { this.zEdge(i, j0, '-'); this.zEdge(i, j1, '-'); }
    return this;
  }
  /** ex edge on line x = i of row j. */
  xEdge(i: number, j: number, ch: string): this { this.rows[2 * j + 1][2 * i] = ch; return this; }
  /** ez edge on line z = j of column i. */
  zEdge(i: number, j: number, ch: string): this { this.rows[2 * j][2 * i + 1] = ch; return this; }
  text(): string { return this.rows.map((r) => r.join('')).join('\n'); }
}

/** Narrow maze: SOLID wall cells behind OPEN edges, 1-cell corridors, dead ends, a few thin walls and doorways. */
export function mazeNb(): LayoutNeighborhood {
  const s = new Scene();
  // corridors carved in a SOLID block [2, 30) x [2, 30): odd rows / columns open, plus connectors
  for (let j = 3; j < 29; j += 4) s.cells(3, j, 29, j + 1, '.');
  for (let i = 3; i < 29; i += 6) s.cells(i, 3, i + 1, 28, '.');
  s.cells(10, 5, 14, 9, '.'); // a small room with thin walls inside
  s.xEdge(12, 5, '|').xEdge(12, 6, 'd').xEdge(12, 7, '|').xEdge(12, 8, ':');
  s.zEdge(10, 7, '-').zEdge(11, 7, 'h');
  s.cell(20, 11, '#').cell(22, 15, '#'); // pillars in corridors (SOLID cells with OPEN edges)
  s.cells(17, 17, 19, 19, '.'); // a nook reached through a HALF wall
  s.zEdge(17, 17, '=').zEdge(18, 17, '"');
  return asciiNb(s.text());
}

/** SOLID pillars, blocker counters/racks of several heights, a raised platform (step) and a lowered floor. */
export function blockerNb(): LayoutNeighborhood {
  const s = new Scene();
  s.room(2, 2, 30, 30);
  s.cells(6, 6, 8, 8, '#'); // 2x2 SOLID pillar, no edges
  s.cell(14, 5, '#');
  s.cell(22, 22, '#');
  return asciiNb(s.text(), undefined, (l: ChunkLayout) => {
    // counters (WOOD, 95 cm) and racks (METAL_PAINTED, 220 cm) as blocker cells
    for (let i = 10; i < 16; i++) { const c = cellIdx(i, 12); l.blockCm[c] = 95; l.floorMat[c] = Mat.WOOD; }
    for (let j = 16; j < 24; j++) { const c = cellIdx(8, j); l.blockCm[c] = 220; l.floorMat[c] = Mat.METAL_PAINTED; }
    for (let j = 16; j < 24; j++) { const c = cellIdx(9, j); l.blockCm[c] = 220; l.floorMat[c] = Mat.METAL_PAINTED; }
    const plinth = cellIdx(24, 8); l.blockCm[plinth] = 40; l.floorMat[plinth] = Mat.CONCRETE_WALL;
    // raised platform (+30 cm) and a sunken area (-45 cm) with lower ceilings on the platform (soffits)
    for (let j = 18; j < 24; j++) for (let i = 16; i < 22; i++) { const c = cellIdx(i, j); l.floorCm[c] = 30; l.ceilCm[c] = 240; }
    for (let j = 4; j < 10; j++) for (let i = 18; i < 24; i++) { const c = cellIdx(i, j); l.floorCm[c] = -45; l.floorMat[c] = Mat.POOL_TILE; }
    // a bulkhead: lower ceiling strip
    for (let i = 3; i < 12; i++) l.ceilCm[cellIdx(i, 26)] = 230;
  });
}

/** Pits: VOID holes (2x2, 1x3, an L) in open floor, one next to a wall and one next to a doorway. */
export function pitNb(): LayoutNeighborhood {
  const s = new Scene();
  s.room(2, 2, 30, 30);
  s.cells(8, 8, 10, 10, ' ');
  s.cells(15, 4, 18, 5, ' ');
  s.cells(20, 20, 23, 21, ' ').cells(20, 21, 21, 23, ' ');
  s.cells(2, 14, 4, 16, ' '); // against the west wall
  s.xEdge(12, 24, 'd'); s.cells(12, 22, 16, 27, '.'); s.xEdge(16, 24, '|');
  s.cells(12, 24, 13, 25, ' '); // right behind a doorway
  return asciiNb(s.text(), undefined, (l: ChunkLayout) => {
    // blockers right at a pit rim (their pit-facing sides are owned by the VOID cells)
    const c = cellIdx(10, 8); l.blockCm[c] = 95; l.floorMat[c] = Mat.WOOD;
    const r = cellIdx(9, 10); l.blockCm[r] = 220; l.floorMat[r] = Mat.METAL_PAINTED;
  });
}

/** Every rendered edge kind, trims, floor-material changes, ceiling states and fixtures: a stress fixture for buffers,
 * ownership and watertightness. */
export function mixNb(): LayoutNeighborhood {
  const s = new Scene();
  s.room(1, 1, 31, 31);
  const kinds = ['|', 'd', 'h', 'a', ':', '=', '"', 'w', '%'];
  // vertical walls on lines x = 4, 8, ..., each of one kind, with gaps, T-junctions and crossings
  for (let k = 0; k < kinds.length; k++) {
    const x = 3 + 3 * k;
    for (let j = 2; j < 12; j++) if (j !== 6) s.xEdge(x, j, kinds[k]);
    s.zEdge(x, 9, kinds[(k + 3) % kinds.length]).zEdge(x - 1, 9, kinds[(k + 5) % kinds.length]);
  }
  // horizontal walls of mixed kinds on z = 14 with a crossing vertical line
  for (let i = 2; i < 30; i++) s.zEdge(i, 14, kinds[i % kinds.length]);
  for (let j = 12; j < 18; j++) s.xEdge(15, j, j % 2 ? '|' : 'd');
  // rooms with doorways (casings) and partitions
  s.room(4, 18, 10, 24).xEdge(10, 20, 'd').zEdge(6, 18, 'd').zEdge(7, 24, 'a');
  s.room(12, 18, 20, 26).zEdge(15, 18, 'h').xEdge(12, 22, 'w');
  for (let j = 18; j < 26; j++) s.xEdge(16, j, j === 22 ? ' ' : ':');
  s.cells(22, 18, 24, 20, '#'); // SOLID block inside open space
  s.cells(26, 26, 28, 28, ' ');
  s.cell(5, 20, 'L').cell(14, 20, 'f').cell(24, 5, 'y').cell(26, 10, 'l');
  return asciiNb(s.text(), undefined, (l: ChunkLayout) => {
    for (let j = 18; j < 24; j++) for (let i = 4; i < 10; i++) l.floorMat[cellIdx(i, j)] = Mat.VINYL_VCT; // threshold strips
    l.ez.trim[ezIdx(20, 26)] |= EdgeTrim.THRESHOLD;
    // roll-up header, 3 cells
    for (let i = 22; i < 25; i++) { const e = ezIdx(i, 28); l.ez.kind[e] = EdgeKind.HEADER; l.ez.hA[e] = 240; l.ez.trim[e] |= EdgeTrim.ROLLUP; }
    // ceiling tile states
    const states = [TileState.STAINED, TileState.MISSING, TileState.VENT, TileState.SAGGING, TileState.NEW, TileState.DIRTY, TileState.MISSING];
    for (let k = 0; k < states.length; k++) setTile(l.tiles, cellIdx(20 + k, 4), k & 3, states[k]);
    setTile(l.tiles, cellIdx(21, 4), 1, TileState.MISSING);
    // concrete / truss / open ceilings
    for (let i = 20; i < 24; i++) { l.ceilKind[cellIdx(i, 8)] = CeilKind.CONCRETE; l.ceilKind[cellIdx(i, 9)] = CeilKind.TRUSS; }
    // grate floor patch
    for (let i = 20; i < 23; i++) l.floorMat[cellIdx(i, 11)] = Mat.METAL_GRATE;
    // a box solid (desk-like) and a stair ramp
    l.solids.push({ kind: 'box', id: 1, min: [20 * 1.2 + 0.2, 0, 22 * 1.2 + 0.3], max: [21 * 1.2 + 0.6, 0.75, 23 * 1.2 + 0.1], mat: Mat.WOOD, flags: SolidFlag.COLLIDE | SolidFlag.OCCLUDE | SolidFlag.RENDER, bakeGroup: 0 });
    l.solids.push({ kind: 'ramp', id: 2, x0: 25 * 1.2, z0: 15 * 1.2, x1: 28 * 1.2, z1: 16 * 1.2, y0: 0, y1: 1.2, dir: 0, steps: 7, mat: Mat.CONCRETE_FLOOR, flags: SolidFlag.COLLIDE | SolidFlag.RENDER, bakeGroup: 0 });
    // floor / wall decals
    l.decals.push({ kind: 0, sign: false, px: 6.1, py: 0, pz: 3.0, nx: 0, ny: 1, nz: 0, rot: 0.3, w: 1.5, h: 1.0, alpha: 1 });
    l.decals.push({ kind: 3, sign: true, px: 1.2 + 0.075, py: 2.0, pz: 5.3, nx: 1, ny: 0, nz: 0, rot: 0, w: 0.4, h: 0.2, alpha: 1, emit: 40 });
    // water
    for (let j = 28; j < 30; j++) for (let i = 2; i < 6; i++) { const c = cellIdx(i, j); l.floorCm[c] = -60; l.waterCm[c] = -10; l.floorMat[c] = Mat.POOL_TILE; }
    l.water.push({ x0: 2 * 1.2, z0: 28 * 1.2, x1: 6 * 1.2, z1: 30 * 1.2, y: -0.1, floorY: -0.6, kind: 0 });
    void exIdx;
  });
}
