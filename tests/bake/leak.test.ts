// tests/bake/leak.test.ts — WP7 acceptance: no light leaks through walls / partitions (FILTERED lightmap, both
// variants, both texel densities) and a HALF wall's shadow length matches the geometry within one texel.

import { describe, expect, it } from 'vitest';
import { CELL, type LmTpc } from '../../src/core/constants.ts';
import { edgeBaseThickness } from '../../src/core/edges.ts';
import { CellFlag, EdgeKind, FixtureKind } from '../../src/core/ids.ts';
import { ChartKind, type LightmapData, type SurfaceSet } from '../../src/core/mesh.ts';
import type { TileKey } from '../../src/core/grid.ts';
import type { BakeTerm } from '../../src/core/worker.ts';
import type { LayoutNeighborhood } from '../../src/core/world.ts';
import { bakeTile } from '../../src/bake/index.ts';
import { setupTexels, TX_VALID, type TexelSet } from '../../src/bake/context.ts';
import { createJob } from '../../src/bake/job.ts';
import { HALO_OFF } from '../../src/bake/util.ts';
import {
  addLight, carveRoom, findChart, handNeighborhood, qFor, sampleGrid, setEx, solidLayout, surfacesOf, texelLum,
} from './helpers.ts';

const TILE: TileKey = { s: 0, cx: 0, cz: 0, q: 0 };
const WALL_LINE = 8; // x line between room A [2,8) and room B [8,14), rows [2,10)

function twoRooms(kind: number, hA: number, light: 'ceiling' | 'low'): LayoutNeighborhood {
  const l = solidLayout({ s: 0, cx: 0, cz: 0 });
  carveRoom(l, 2, 2, 8, 10);
  carveRoom(l, 8, 2, 14, 10);
  for (let j = 2; j < 10; j++) setEx(l, WALL_LINE, j, kind, hA);
  if (light === 'ceiling') addLight(l, { px: WALL_LINE * CELL - 1.5, pz: 6 * CELL, tx: 0, tz: 1 });
  else {
    // a bare bulb below the partition top: the whole floor of B is geometrically shadowed
    addLight(l, { kind: FixtureKind.CAGE_BULB, shape: 1, px: WALL_LINE * CELL - 1.5, py: 1.2, pz: 6 * CELL, w: 0.15, h: 0.15, luminance: 900 });
  }
  return handNeighborhood(l);
}

interface Baked { lm: LightmapData; T: TexelSet; s: SurfaceSet }
function bake(nb: LayoutNeighborhood, tpc: LmTpc, variant: 'preview' | 'full', term: BakeTerm): Baked {
  const q = qFor(tpc);
  const s = surfacesOf(nb, TILE, tpc);
  const lm = bakeTile(nb, TILE, s, variant, q, term);
  const T = setupTexels(createJob(nb, TILE, q, null), s);
  return { lm, T, s };
}

/** Local cell (li, lj) of a texel's owner cell (tile q = 0). */
const ownerLi = (T: TexelSet, t: number, n: number): [number, number] => {
  const c = T.cell[t];
  return [(c % n) - HALO_OFF, Math.floor(c / n) - HALO_OFF];
};

function roomMax(b: Baked, inRoom: (li: number, lj: number) => boolean, pred: (t: number) => boolean = () => true): number {
  let m = 0;
  const n = 16 + 2 * HALO_OFF;
  for (let t = 0; t < b.T.n; t++) {
    if (b.T.state[t] !== TX_VALID || !pred(t)) continue;
    const [li, lj] = ownerLi(b.T, t, n);
    if (!inRoom(li, lj)) continue;
    const ai = b.T.atlas[t];
    const v = texelLum(b.lm, ai % b.lm.width, Math.floor(ai / b.lm.width));
    if (v > m) m = v;
  }
  return m;
}
const inA = (li: number, lj: number): boolean => li >= 2 && li < 8 && lj >= 2 && lj < 10;
const inB = (li: number, lj: number): boolean => li >= 8 && li < 14 && lj >= 2 && lj < 10;

/** Max FILTERED floor luminance over visible floor points of room B (>= T/2 from the separating line). */
function filteredFloorMaxB(b: Baked, tpc: LmTpc, kind: number): number {
  const ch = findChart(b.s, ChartKind.FLOOR_GRID);
  const x0 = WALL_LINE * CELL + edgeBaseThickness(kind) / 2, x1 = 14 * CELL - 0.075;
  const z0 = 2 * CELL + 0.075, z1 = 10 * CELL - 0.075;
  let m = 0;
  for (let x = x0; x <= x1; x += 0.025) for (let z = z0; z <= z1; z += 0.05) m = Math.max(m, sampleGrid(b.lm, ch, tpc, x, z));
  return m;
}

describe('bake leak (WALL)', () => {
  const nb = twoRooms(EdgeKind.WALL, 0, 'ceiling');
  for (const tpc of [8, 12] as const) {
    for (const variant of ['preview', 'full'] as const) {
      it(`room B stays black: ${variant}, tpc ${tpc}`, () => {
        const b = bake(nb, tpc, variant, 'all');
        const maxA = roomMax(b, inA);
        expect(maxA).toBeGreaterThan(50);
        const maxB = roomMax(b, inB);
        expect(maxB).toBeLessThan(1e-4 * maxA);
        expect(filteredFloorMaxB(b, tpc, EdgeKind.WALL)).toBeLessThan(1e-4 * maxA);
      });
    }
  }
});

describe('bake leak (PARTITION, light below the partition top)', () => {
  const nb = twoRooms(EdgeKind.PARTITION, 150, 'low');
  for (const tpc of [8, 12] as const) {
    for (const variant of ['preview', 'full'] as const) {
      it(`floor of B is shadowed: ${variant}, tpc ${tpc}`, () => {
        const b = bake(nb, tpc, variant, 'direct');
        const maxA = roomMax(b, inA);
        expect(maxA).toBeGreaterThan(10);
        const floorB = roomMax(b, inB, (t) => b.T.ny[t] > 0.9);
        expect(floorB).toBeLessThan(1e-4 * maxA);
        expect(filteredFloorMaxB(b, tpc, EdgeKind.PARTITION)).toBeLessThan(1e-4 * maxA);
        // ...while the ceiling of B above the partition top is lit (the partition does not block everything)
        const ceilB = roomMax(b, inB, (t) => b.T.ny[t] < -0.9);
        expect(ceilB).toBeGreaterThan(1e-3 * maxA);
      });
    }
  }
});

describe('bake leak (SOLID block at the end of a wall, dilation corner)', () => {
  // Rooms A [2,8) and B [8,14) separated by a WALL on line 8, except row 5 where B's cell (8, 5) is a SOLID block
  // facing A through an OPEN edge (a zero-thickness face on the line). The block's corner texels border A (west) and
  // B (north / south): their dilated value must not carry A's light into B's floor corners.
  const l = solidLayout({ s: 0, cx: 0, cz: 0 });
  carveRoom(l, 2, 2, 8, 10);
  carveRoom(l, 8, 2, 14, 10);
  for (let j = 2; j < 10; j++) setEx(l, WALL_LINE, j, EdgeKind.WALL, 0);
  setEx(l, WALL_LINE, 5, EdgeKind.OPEN, 0);
  l.flags[5 * 32 + WALL_LINE] = CellFlag.SOLID;
  addLight(l, { px: WALL_LINE * CELL - 1.5, pz: 5.5 * CELL, tx: 0, tz: 1 });
  const nb = handNeighborhood(l);
  for (const tpc of [8, 12] as const) {
    for (const variant of ['preview', 'full'] as const) {
      it(`filtered floor of B stays black at the block corners: ${variant}, tpc ${tpc}`, () => {
        const b = bake(nb, tpc, variant, 'all');
        const ch = findChart(b.s, ChartKind.FLOOR_GRID);
        let maxA = 0, maxB = 0;
        for (let x = 2 * CELL + 0.1; x < WALL_LINE * CELL - 0.1; x += 0.05) {
          for (let z = 2 * CELL + 0.1; z < 10 * CELL - 0.1; z += 0.05) maxA = Math.max(maxA, sampleGrid(b.lm, ch, tpc, x, z));
        }
        // B's visible floor: >= WALL_T/2 from the wall line, anywhere up to the block's zero-thickness faces
        for (let x = WALL_LINE * CELL + 0.075; x < 10 * CELL; x += 0.01) {
          for (let z = 3 * CELL; z < 8 * CELL; z += 0.01) {
            if (x < (WALL_LINE + 1) * CELL && z > 5 * CELL && z < 6 * CELL) continue; // inside the block
            maxB = Math.max(maxB, sampleGrid(b.lm, ch, tpc, x, z));
          }
        }
        expect(maxA).toBeGreaterThan(50);
        expect(maxB).toBeLessThan(1e-4 * maxA);
      });
    }
  }
});

describe('HALF wall shadow length', () => {
  const lightX = WALL_LINE * CELL - 1.2, lightY = 2.0, lightZ = 6 * CELL + 0.6;
  const l = solidLayout({ s: 0, cx: 0, cz: 0 });
  carveRoom(l, 2, 2, 8, 10);
  carveRoom(l, 8, 2, 14, 10);
  for (let j = 2; j < 10; j++) setEx(l, WALL_LINE, j, EdgeKind.HALF, 105);
  addLight(l, { kind: FixtureKind.CAGE_BULB, shape: 1, px: lightX, py: lightY, pz: lightZ, w: 0.01, h: 0.01, luminance: 300 });
  const nb = handNeighborhood(l);
  const wallX = WALL_LINE * CELL;
  for (const tpc of [8, 12] as const) {
    it(`shadow edge within one texel, tpc ${tpc}`, () => {
      const b = bake(nb, tpc, 'full', 'direct');
      const ch = findChart(b.s, ChartKind.FLOOR_GRID);
      const t = CELL / tpc;
      const yRecv = 0.02; // floor samples are 2 cm above the floor
      const expected = wallX + (wallX - lightX) * (1.05 - yRecv) / (lightY - 1.05);
      // unshadowed point-light irradiance at a floor texel centre
      const e0 = (x: number): number => {
        const dx = x - lightX, dy = lightY - yRecv, dz = 0;
        const d2 = dx * dx + dy * dy + dz * dz;
        return 300 * (dy / Math.sqrt(d2)) / d2;
      };
      const v = ch.y + Math.floor(lightZ / t + 1); // texel row through the light
      let edge = -1;
      for (let u = Math.floor(wallX / t + 1) + 1; u < Math.floor(14 * CELL / t); u++) {
        const x = (u - 0.5) * t;
        const e = texelLum(b.lm, ch.x + u, v);
        if (e > 0.5 * e0(x)) { edge = x; break; }
      }
      expect(edge).toBeGreaterThan(0);
      expect(Math.abs(edge - expected)).toBeLessThanOrEqual(t + 1e-9);
    });
  }
});
