// WP1 — connectivity repair (unit cases on ASCII fixtures) and the global flood over 5x5 chunks per storey.
import { describe, expect, it } from 'vitest';
import { CELL, CHUNK_CELLS } from '../../src/core/constants.ts';
import { cellIdx, exIdx, ezIdx } from '../../src/core/grid.ts';
import { CellFlag, EdgeKind, type StoreyId } from '../../src/core/ids.ts';
import type { ChunkLayout } from '../../src/core/layout.ts';
import type { WorldGenOptions } from '../../src/core/world.ts';
import { layoutFromAscii } from '../../src/world/ascii.ts';
import { createChunkGrid } from '../../src/world/chunkGrid.ts';
import { cellWalkable, edgeKindWalkable, edgePassable, portCells, rampLinks, repairConnectivity } from '../../src/world/connectivity.ts';
import { validateLayout } from '../../src/world/validate.ts';
import { createWorldGen } from '../../src/world/worldgen.ts';

const N = CHUNK_CELLS;
const key = { s: 0 as StoreyId, cx: 0, cz: 0 };
const opts = (seed: number): WorldGenOptions => ({
  seed, seedText: String(seed), forceZone: null, forceMood: null, forceLandmark: null, testScene: null, lights: 'default',
});

/** Small scene: rows of cell glyphs (walls drawn with rect helper); cells not covered stay SOLID. */
function scene(build: (t: string[][]) => void): ChunkLayout {
  const rows: string[][] = [];
  for (let y = 0; y <= 2 * N; y++) rows.push(new Array<string>(2 * N + 1).fill(' '));
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) rows[2 * j + 1][2 * i + 1] = '#';
  // chunk border lines are WALL unless a test opens them (an OPEN seam edge is a port)
  for (let c = 0; c < N; c++) { rows[2 * c + 1][0] = '|'; rows[2 * c + 1][2 * N] = '|'; rows[0][2 * c + 1] = '-'; rows[2 * N][2 * c + 1] = '-'; }
  build(rows);
  return layoutFromAscii(key, rows.map((r) => r.join('')).join('\n'));
}
function room(t: string[][], i0: number, j0: number, i1: number, j1: number): void {
  for (let j = j0; j < j1; j++) for (let i = i0; i < i1; i++) t[2 * j + 1][2 * i + 1] = '.';
  for (let j = j0; j < j1; j++) { t[2 * j + 1][2 * i0] = '|'; t[2 * j + 1][2 * i1] = '|'; }
  for (let i = i0; i < i1; i++) { t[2 * j0][2 * i + 1] = '-'; t[2 * j1][2 * i + 1] = '-'; }
}

/** In-chunk flood over walkable cells and passable interior edges. */
function flood(l: ChunkLayout, c0: number): Uint8Array {
  const seen = new Uint8Array(N * N);
  const st = [c0];
  seen[c0] = 1;
  while (st.length) {
    const c = st.pop() as number, i = c & 31, j = c >> 5;
    const go = (n: number, axis: 'x' | 'z', ei: number, ej: number): void => {
      if (seen[n] || !cellWalkable(l, n) || !edgePassable(l, axis, ei, ej)) return;
      seen[n] = 1; st.push(n);
    };
    if (i > 0) go(c - 1, 'x', i, j);
    if (i < N - 1) go(c + 1, 'x', i + 1, j);
    if (j > 0) go(c - N, 'z', i, j);
    if (j < N - 1) go(c + N, 'z', i, j + 1);
  }
  return seen;
}

describe('repairConnectivity', () => {
  it('joins two sealed rooms to the port room through the cheapest wall (doorway / open)', () => {
    for (const door of ['doorway', 'open'] as const) {
      const l = scene((t) => {
        room(t, 0, 4, 8, 12); // touches the W seam
        t[2 * 6 + 1][0] = ' '; // an opening on the W seam line (port) at row 6
        room(t, 8, 4, 16, 12); // shares the wall on line x = 8
        room(t, 16, 4, 24, 12);
      });
      expect(portCells(l)).toEqual([cellIdx(0, 6)]);
      const g = createChunkGrid(l, 1);
      g.freezeSeams();
      const r = repairConnectivity(g, [], door);
      expect(r.carved).toBe(2);
      let opened = 0;
      for (let j = 4; j < 12; j++) {
        for (const i of [8, 16]) {
          const k = l.ex.kind[exIdx(i, j)];
          if (k !== EdgeKind.WALL) { opened++; expect(k).toBe(door === 'doorway' ? EdgeKind.DOORWAY : EdgeKind.OPEN); }
        }
      }
      expect(opened).toBe(2);
      // every walkable cell is now reachable: the validator's in-chunk flood agrees
      l.ports = [{ side: 'W', from: 6, to: 7 }];
      l.hash = 0;
      expect(validateLayout(l).filter((e) => e.includes('unreachable'))).toEqual([]);
    }
  });

  it('prefers opening one wall (cost 1) over clearing SOLID cells (cost 3 each), and clears SOLID when it must', () => {
    const l = scene((t) => {
      room(t, 0, 2, 6, 8);
      t[2 * 4 + 1][0] = ' ';
      room(t, 10, 2, 16, 8); // 4 SOLID cells (i = 6..9) between the rooms: must be cleared
    });
    const g = createChunkGrid(l, 1);
    g.freezeSeams();
    repairConnectivity(g, [], 'open');
    let cleared = 0;
    for (let i = 6; i < 10; i++) for (let j = 2; j < 8; j++) if (!(l.flags[cellIdx(i, j)] & CellFlag.SOLID)) cleared++;
    expect(cleared).toBe(4); // one straight tunnel of 4 cells
  });

  it('small unreachable pockets become SOLID, large reserved ones SEALED; reserved walls are never carved', () => {
    const l = scene((t) => {
      room(t, 0, 0, 10, 10);
      t[2 * 5 + 1][0] = ' ';
      room(t, 12, 12, 14, 13); // 2-cell pocket -> SOLID
      room(t, 20, 20, 26, 26); // 36-cell room, reserved below -> cannot be joined -> SEALED
    });
    for (let j = 20; j < 26; j++) for (let i = 20; i < 26; i++) l.flags[cellIdx(i, j)] |= CellFlag.RESERVED;
    const g = createChunkGrid(l, 1);
    g.freezeSeams();
    const r = repairConnectivity(g, [], 'open');
    expect(l.flags[cellIdx(12, 12)] & CellFlag.SOLID).toBeTruthy();
    expect(l.flags[cellIdx(13, 12)] & CellFlag.SOLID).toBeTruthy();
    expect(l.flags[cellIdx(22, 22)] & CellFlag.SEALED).toBeTruthy();
    expect(l.ex.kind[exIdx(20, 22)]).toBe(EdgeKind.WALL);
    expect(r.sealed).toBe(2);
  });

  it('an unreachable component holding a port cell stays walkable (not SOLID, not SEALED) even when < 3 cells', () => {
    const l = scene((t) => {
      room(t, 0, 0, 10, 10);
      t[2 * 5 + 1][0] = ' '; // main port on the W seam
      room(t, 20, 0, 21, 1); // 1-cell pocket on the N seam ...
      t[0][2 * 20 + 1] = ' '; // ... with its own port
    });
    // walled in by reserved cells: it cannot be joined to main
    for (const [i, j] of [[19, 0], [21, 0], [19, 1], [20, 1], [21, 1]]) l.flags[cellIdx(i, j)] |= CellFlag.RESERVED;
    const g = createChunkGrid(l, 1);
    g.freezeSeams();
    const r = repairConnectivity(g, [], 'open');
    const c = cellIdx(20, 0);
    expect(cellWalkable(l, c)).toBe(true);
    expect(l.flags[c] & CellFlag.SEALED).toBe(0);
    expect(r.sealed).toBe(0);
    expect(portCells(l)).toContain(c);
  });

  it('forces port and target cells walkable and joins targets', () => {
    const l = scene((t) => {
      room(t, 0, 0, 8, 8);
      t[2 * 3 + 1][0] = ' ';
      t[2 * 0][2 * 3 + 1] = ' '; // N seam opening at li = 3 ...
    });
    l.flags[cellIdx(3, 0)] |= CellFlag.SOLID; // ... whose inner cell is SOLID
    const g = createChunkGrid(l, 1);
    g.freezeSeams();
    repairConnectivity(g, [[20, 20]], 'open'); // a target deep in SOLID
    expect(cellWalkable(l, cellIdx(3, 0))).toBe(true);
    expect(cellWalkable(l, cellIdx(20, 20))).toBe(true);
    // the target is connected: flood from the port reaches it
    const seen = flood(l, cellIdx(0, 3));
    expect(seen[cellIdx(20, 20)]).toBe(1);
  });

  it('a ramp solid links cells across a floor step; HEADER passability needs >= 190 cm', () => {
    const l = scene((t) => room(t, 2, 2, 10, 6));
    // cells i >= 6 sunk to -90 cm; a ramp inside cells 6..7 rising from -90 (at x = 9.6) up to 0 (at x = 7.2)
    for (let j = 2; j < 6; j++) for (let i = 6; i < 10; i++) l.floorCm[cellIdx(i, j)] = -90;
    expect(edgePassable(l, 'x', 6, 3)).toBe(false);
    l.solids.push({ kind: 'ramp', id: 1, x0: 6 * CELL, z0: 2 * CELL, x1: 8 * CELL, z1: 6 * CELL, y0: -0.9, y1: 0, dir: 1, steps: 3, mat: 9, flags: 0, bakeGroup: 0 });
    expect(rampLinks(l, 'x', 6, 3)).toBe(true);
    expect(edgePassable(l, 'x', 6, 3)).toBe(true);
    expect(edgePassable(l, 'x', 8, 3)).toBe(true); // bottom of the ramp: both at -90
    expect(edgePassable(l, 'z', 7, 3)).toBe(true); // along the ramp's width, same floor
    expect(edgeKindWalkable(EdgeKind.HEADER, 220)).toBe(true);
    expect(edgeKindWalkable(EdgeKind.HEADER, 180)).toBe(false);
    expect(edgeKindWalkable(EdgeKind.WALL, 0)).toBe(false);
    expect(edgeKindWalkable(EdgeKind.GLITCH, 0)).toBe(false);
  });
});

describe('global connectivity (5x5 chunks per storey)', () => {
  it('a flood from the spawn reaches every port cell, and every chunk validates', () => {
    for (const s of [0, 1, 2] as StoreyId[]) {
      const g = createWorldGen(opts(20 + s));
      const R = 2, W = (2 * R + 1) * N;
      const ls: ChunkLayout[] = [];
      for (let cz = -R; cz <= R; cz++) for (let cx = -R; cx <= R; cx++) {
        const l = g.generateChunk({ s, cx, cz });
        expect(validateLayout(l, g), `${s}:${cx}:${cz}`).toEqual([]);
        ls.push(l);
      }
      const L = (gx: number, gz: number): ChunkLayout => ls[Math.floor(gz / N) * (2 * R + 1) + Math.floor(gx / N)];
      const walk = (gx: number, gz: number): boolean => cellWalkable(L(gx, gz), cellIdx(gx % N, gz % N));
      const floor = (gx: number, gz: number): number => L(gx, gz).floorCm[cellIdx(gx % N, gz % N)];
      /** passable edge between (gx-1, gz) and (gx, gz) ('x') or (gx, gz-1) and (gx, gz) ('z') */
      const pass = (axis: 'x' | 'z', gx: number, gz: number): boolean => {
        const l = L(gx, gz), i = gx % N, j = gz % N;
        if (axis === 'x' ? i !== 0 : j !== 0) return edgePassable(l, axis, i, j);
        // seam: stored identically on both sides; step check across the chunks
        const e = axis === 'x' ? l.ex : l.ez, k = axis === 'x' ? exIdx(0, j) : ezIdx(i, 0);
        if (!edgeKindWalkable(e.kind[k], e.hA[k])) return false;
        const f0 = axis === 'x' ? floor(gx - 1, gz) : floor(gx, gz - 1);
        return Math.abs(f0 - floor(gx, gz)) <= 36;
      };
      const sp = g.findSpawn(s);
      const sx = Math.floor(sp.x / CELL) + R * N, sz = Math.floor(sp.z / CELL) + R * N;
      expect(walk(sx, sz)).toBe(true);
      const seen = new Uint8Array(W * W);
      const st = [sz * W + sx];
      seen[sz * W + sx] = 1;
      while (st.length) {
        const c = st.pop() as number, x = c % W, z = (c / W) | 0;
        const tryN = (nx: number, nz: number, axis: 'x' | 'z', ex: number, ez: number): void => {
          if (nx < 0 || nz < 0 || nx >= W || nz >= W) return;
          const n = nz * W + nx;
          if (seen[n] || !walk(nx, nz) || !pass(axis, ex, ez)) return;
          seen[n] = 1; st.push(n);
        };
        tryN(x - 1, z, 'x', x, z); tryN(x + 1, z, 'x', x + 1, z); tryN(x, z - 1, 'z', x, z); tryN(x, z + 1, 'z', x, z + 1);
      }
      let ports = 0, missed: string[] = [];
      for (let cz = 0; cz < 2 * R + 1; cz++) for (let cx = 0; cx < 2 * R + 1; cx++) {
        const l = ls[cz * (2 * R + 1) + cx];
        for (const pc of portCells(l)) {
          ports++;
          const gx = cx * N + (pc & 31), gz = cz * N + (pc >> 5);
          if (!seen[gz * W + gx]) missed.push(`${s}:${cx - R}:${cz - R} cell (${pc & 31},${pc >> 5})`);
        }
      }
      expect(ports).toBeGreaterThan(100);
      expect(missed.slice(0, 10), `storey ${s}: ${missed.length} unreachable port cells`).toEqual([]);
    }
  });
});

// ------------------------------------------------------------------------------------------ R2 zone transitions

import { EdgeTrim, FixtureKind, PropKind } from '../../src/core/ids.ts';
import { CONNECTOR_CEIL_CM } from '../../src/world/structures/transitions.ts';

describe('R2 zone-transition connectors (full pipeline)', () => {
  it('fire doors with THRESHOLD trim sit at the end of a 230 cm bulkhead connector, with an EXIT sign; chunks validate', { tags: ['sweep'] }, () => {
    let connectors = 0, leaves = 0;
    for (const seed of [1, 7, 42]) {
      const gen = createWorldGen({ seed, seedText: String(seed), forceZone: null, forceMood: null, forceLandmark: null, testScene: null, lights: 'default' });
      for (let cz = -4; cz <= 4; cz++) for (let cx = -4; cx <= 4; cx++) {
        const l = gen.generateChunk({ s: 0, cx, cz });
        expect(validateLayout(l, gen)).toEqual([]);
        for (const axis of ['x', 'z'] as const) {
          const eg = axis === 'x' ? l.ex : l.ez;
          for (let a = 1; a < N; a++) for (let b = 0; b < N; b++) {
            const i = axis === 'x' ? a : b, j = axis === 'x' ? b : a;
            const k = axis === 'x' ? exIdx(i, j) : ezIdx(i, j);
            if (eg.kind[k] !== EdgeKind.DOORWAY || !(eg.trim[k] & EdgeTrim.THRESHOLD)) continue;
            connectors++;
            const ca = axis === 'x' ? cellIdx(i - 1, j) : cellIdx(i, j - 1), cb = cellIdx(i, j);
            const low = (c: number): number => l.ceilCm[c] - Math.max(0, l.floorCm[c]);
            // one side is the connector: its ceiling is the 230 cm bulkhead
            expect(Math.min(low(ca), low(cb))).toBe(CONNECTOR_CEIL_CM);
            expect(eg.hA[k]).toBeLessThanOrEqual(CONNECTOR_CEIL_CM - 10);
            const ex = axis === 'x' ? i * CELL : (i + 0.5) * CELL, ez = axis === 'x' ? (j + 0.5) * CELL : j * CELL;
            if (eg.trim[k] & EdgeTrim.EXIT_SIGN) {
              expect(l.fixtures.some((f) => f.kind === FixtureKind.EXIT_SIGN && Math.hypot(f.px - ex, f.pz - ez) < 0.5)).toBe(true);
            }
            if (l.props.some((p) => p.kind === PropKind.DOOR_LEAF && Math.hypot(p.x - ex, p.z - ez) < 1.2)) leaves++;
          }
        }
      }
    }
    expect(connectors).toBeGreaterThan(5);
    expect(leaves).toBeGreaterThan(connectors / 2);
  });
});
