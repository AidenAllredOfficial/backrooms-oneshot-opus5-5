// tests/bake/dda.test.ts — WP7 unit tests of the 2.5D visibility walk: edge semantics identical to core/edges.ts,
// corner (vertex) crossings, heights, group isolation, occluder boxes, and the direct-light helpers.

import { describe, expect, it } from 'vitest';
import { CELL } from '../../src/core/constants.ts';
import { edgeDefaults, edgeOccludesAt } from '../../src/core/edges.ts';
import { CellFlag, EdgeKind, PropKind } from '../../src/core/ids.ts';
import type { TileKey } from '../../src/core/grid.ts';
import { createBakeContext, irradianceAt, traceVisible } from '../../src/bake/context.ts';
import { crossX, crossZ } from '../../src/bake/dda.ts';
import { buildVisGrid } from '../../src/bake/visgrid.ts';
import { HALO_OFF } from '../../src/bake/util.ts';
import { Q_HIGH, addLight, carveRoom, handNeighborhood, setEx, setEz, solidLayout } from './helpers.ts';

const TILE: TileKey = { s: 0, cx: 0, cz: 0, q: 0 };

describe('edge crossings match core/edges.ts', () => {
  const kinds = [EdgeKind.WALL, EdgeKind.DOORWAY, EdgeKind.HEADER, EdgeKind.ARCH, EdgeKind.PARTITION, EdgeKind.HALF,
    EdgeKind.RAIL, EdgeKind.WINDOW, EdgeKind.GLITCH, EdgeKind.OPEN];
  const l = solidLayout({ s: 0, cx: 0, cz: 0 });
  carveRoom(l, 1, 1, 15, 15, 270, EdgeKind.OPEN);
  for (let k = 0; k < kinds.length; k++) {
    const [a, b] = edgeDefaults(kinds[k]);
    setEx(l, 5, 2 + k, kinds[k], a, b);
    setEz(l, 2 + k, 5, kinds[k], a, b);
  }
  const nb = handNeighborhood(l);
  const g = buildVisGrid(nb, TILE);
  it('crossX / crossZ == edgeOccludesAt away from the corner posts', () => {
    let checked = 0;
    for (let k = 0; k < kinds.length; k++) {
      const [a, b] = edgeDefaults(kinds[k]);
      for (let ti = 1; ti < 24; ti++) {
        const along = 0.07 + (0.86 * ti) / 24; // cells, outside the post zone
        for (let y = -0.05; y < 2.8; y += 0.0625) {
          const want = edgeOccludesAt(kinds[k], a, b, along * CELL, y, 0);
          expect(crossX(g, HALO_OFF + 5, HALO_OFF + 2 + k, along, y), `x ${kinds[k]} t=${along} y=${y}`).toBe(want);
          expect(crossZ(g, HALO_OFF + 5, HALO_OFF + 2 + k, along, y), `z ${kinds[k]} t=${along} y=${y}`).toBe(want);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(5000);
  });
});

describe('visibility', () => {
  const l = solidLayout({ s: 0, cx: 0, cz: 0 });
  carveRoom(l, 1, 1, 15, 15, 270, EdgeKind.OPEN);
  // an L of walls meeting at vertex (8, 8): x-edge on line 8 row 7, z-edge on line 8 column 8
  setEx(l, 8, 7, EdgeKind.WALL);
  setEz(l, 8, 8, EdgeKind.WALL);
  // a half wall on line x = 4, rows 10..12
  for (let j = 10; j < 13; j++) setEx(l, 4, j, EdgeKind.HALF, 105);
  // a pillar (SOLID cell) and a raised floor step
  l.flags[12 * 32 + 12] = CellFlag.SOLID;
  l.floorCm[3 * 32 + 12] = 80;
  // a crate (occluding prop) at (3, 3)
  l.props.push({ kind: PropKind.CRATE, variant: 0, x: 3.6, y: 0, z: 3.6, yaw: 0, scale: 1, flags: 0, seed: 1 });
  const nb = handNeighborhood(l);
  const ctx = createBakeContext(nb, TILE, Q_HIGH);
  it('open space is visible, walls and pillars block', () => {
    expect(traceVisible(ctx, 2, 1, 2, 7, 2, 2, 0)).toBe(true);
    expect(traceVisible(ctx, 9.0, 1.5, 7.0, 10.2, 1.5, 8.2, 0)).toBe(true); // past the end of the L's x wall
    expect(traceVisible(ctx, 13.0, 1.5, 2.0, 16.0, 1.5, 2.0, 0)).toBe(true);
    expect(traceVisible(ctx, 13.5, 1.5, 15.0, 16.5, 1.5, 15.0, 0)).toBe(false); // through the SOLID pillar cell (12, 12)
  });
  it('a segment through the corner post of two walls meeting at a vertex is blocked', () => {
    // from cell (7, 8) to cell (8, 7) diagonally through vertex (8, 8)
    const v = 8 * CELL;
    expect(traceVisible(ctx, v - 0.3, 1.5, v + 0.3, v + 0.3, 1.5, v - 0.3, 0)).toBe(false);
    expect(traceVisible(ctx, v - 0.3, 1.5, v + 0.31, v + 0.3, 1.5, v - 0.29, 0)).toBe(false);
  });
  it('half walls block below their top only', () => {
    const x = 4 * CELL;
    expect(traceVisible(ctx, x - 0.5, 0.5, 13.0, x + 0.5, 0.5, 13.0, 0)).toBe(false);
    expect(traceVisible(ctx, x - 0.5, 1.2, 13.0, x + 0.5, 1.2, 13.0, 0)).toBe(true);
    expect(traceVisible(ctx, x - 0.5, 0.2, 13.0, x + 0.5, 2.0, 13.0, 0)).toBe(true); // crosses the line at 1.1 m
    expect(traceVisible(ctx, x - 0.5, 0.2, 13.0, x + 0.5, 1.8, 13.0, 0)).toBe(false); // crosses at 1.0 m
  });
  it('floors, ceilings and raised steps bound the segment', () => {
    expect(traceVisible(ctx, 2, 1, 2, 7, 2.8, 2, 0)).toBe(false); // ends above the ceiling
    expect(traceVisible(ctx, 13.5, 0.3, 3.0, 15.5, 0.3, 4.5, 0)).toBe(false); // into the 80 cm step at cell (12, 3)
    expect(traceVisible(ctx, 13.5, 1.0, 3.0, 15.5, 1.0, 4.5, 0)).toBe(true);
  });
  it('occluder boxes (OCCLUDE props) block', () => {
    expect(traceVisible(ctx, 3.6, 0.4, 2.0, 3.6, 0.4, 5.2, 0)).toBe(false); // through the crate
    expect(traceVisible(ctx, 3.6, 1.0, 2.0, 3.6, 1.0, 5.2, 0)).toBe(true); // over it (crate is 0.8 m tall)
  });
  it('group isolation: storey rays treat other groups as solid', () => {
    expect(traceVisible(ctx, 2, 1, 2, 7, 2, 2, 12345)).toBe(false);
  });
});

describe('irradianceAt (direct test helper)', () => {
  const l = solidLayout({ s: 0, cx: 0, cz: 0 });
  carveRoom(l, 1, 1, 15, 15);
  addLight(l, { px: 8.4, pz: 8.4 });
  const nb = handNeighborhood(l);
  const ctx = createBakeContext(nb, TILE, Q_HIGH);
  it('is positive under the light, zero behind the emitter plane and falls off with distance', () => {
    const out: [number, number, number] = [0, 0, 0];
    irradianceAt(ctx, [8.4, 0.02, 8.4], [0, 1, 0], 0, out);
    const e0 = out[1];
    expect(e0).toBeGreaterThan(300);
    irradianceAt(ctx, [12.4, 0.02, 8.4], [0, 1, 0], 0, out);
    expect(out[1]).toBeLessThan(e0 * 0.5);
    irradianceAt(ctx, [8.4, 2.68, 10.4], [0, -1, 0], 0, out); // ceiling: coplanar recessed emitter culls it
    expect(out[1]).toBe(0);
    expect(ctx.lights.length).toBe(1);
    expect(ctx.lights[0].px).toBeCloseTo(8.4, 6);
  });
});
