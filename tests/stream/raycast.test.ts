// tests/stream/raycast.test.ts (package F) — WorldQuery.raycast over a hand-built layout whose collision comes from the
// real WP12 builder (walls with their thickness, SOLID masses, blockers, props): floor, ceiling and wall hits with the
// right distance, normal and albedo.

import { describe, expect, it } from 'vitest';
import { CELL, WALL_T } from '../../src/core/constants.ts';
import { cellIdx, exIdx, ezIdx, type ChunkKey } from '../../src/core/grid.ts';
import { CellFlag, EdgeKind, Mat, Mood, PropKind, Zone, type StoreyId } from '../../src/core/ids.ts';
import { createEmptyLayout, type ChunkLayout } from '../../src/core/layout.ts';
import { LAYER_DEFS } from '../../src/core/materials.ts';
import type { RaycastHit } from '../../src/core/runtime.ts';
import { buildChunkCollision } from '../../src/player/collisionBuild.ts';
import { createChunkData, createWorldQuery, RAY_PROP_RHO, StoreyData } from '../../src/stream/WorldQueryImpl.ts';

/** Floor 0, ceiling 2.7 m; a full wall on the line x = 6 m (cell line 5) with wallpaper on its -x face and concrete
 * on its +x face; carpet floor, ceiling tiles; a SOLID cell at (2, 8); a blocker at (3, 3); a crate at (8, 12). */
function room(): ChunkLayout {
  const k: ChunkKey = { s: 0, cx: 0, cz: 0 };
  const l = createEmptyLayout(k, Zone.LOBBY, 1, Mood.NORMAL);
  l.floorCm.fill(0);
  l.ceilCm.fill(270);
  l.floorMat.fill(Mat.CARPET_L0);
  l.ceilMat.fill(Mat.CEILING_TILE);
  l.wallMat.fill(Mat.WALLPAPER_L0);
  for (let lj = 0; lj < 32; lj++) {
    const e = exIdx(5, lj);
    l.ex.kind[e] = EdgeKind.WALL; l.ex.matNeg[e] = Mat.WALLPAPER_L0; l.ex.matPos[e] = Mat.CONCRETE_WALL;
  }
  l.flags[cellIdx(2, 8)] |= CellFlag.SOLID;
  l.blockCm[cellIdx(3, 3)] = 90;
  l.props.push({ kind: PropKind.CRATE, variant: 0, x: 8 * CELL + 0.6, y: 0, z: 12 * CELL + 0.6, yaw: 0, scale: 1, flags: 0, seed: 1 });
  return l;
}

function query(l: ChunkLayout) {
  const s0 = new StoreyData();
  s0.set(createChunkData(l, buildChunkCollision(l)));
  const data = [s0, new StoreyData(), new StoreyData()];
  return createWorldQuery({ storey: () => 0 as StoreyId, data: (s) => data[s] });
}

const hit = (): RaycastHit => ({ t: 0, nx: 0, ny: 0, nz: 0, r: 0, g: 0, b: 0 });
const albedo = (m: number) => LAYER_DEFS[m].albedoMean;

describe('WorldQuery.raycast', () => {
  const q = query(room());
  const h = hit();

  it('hits the floor straight down and at a slant, with +Y and the floor albedo', () => {
    expect(q.raycast!(2, 1.5, 2, 0, -1, 0, 40, h)).toBe(true);
    expect(h.t).toBeCloseTo(1.5, 9);
    expect([h.nx, h.ny, h.nz]).toEqual([0, 1, 0]);
    expect([h.r, h.g, h.b]).toEqual([...albedo(Mat.CARPET_L0)]);
    const s = Math.SQRT1_2;
    expect(q.raycast!(1.0, 1.5, 20, s, -s, 0, 40, h)).toBe(true);
    expect(h.t).toBeCloseTo(1.5 * Math.SQRT2, 9);
    expect(h.ny).toBe(1);
  });

  it('hits the ceiling with -Y and the ceiling albedo', () => {
    expect(q.raycast!(2, 1.5, 20, 0, 1, 0, 40, h)).toBe(true);
    expect(h.t).toBeCloseTo(1.2, 9);
    expect([h.nx, h.ny, h.nz]).toEqual([0, -1, 0]);
    expect([h.r, h.g, h.b]).toEqual([...albedo(Mat.CEILING_TILE)]);
  });

  it('hits the wall face (not its centre line) with the face material of the side it came from', () => {
    expect(q.raycast!(1, 1.5, 20, 1, 0, 0, 40, h)).toBe(true);
    expect(h.t).toBeCloseTo(6 - WALL_T / 2 - 1, 5);
    expect([h.nx, h.ny, h.nz]).toEqual([-1, 0, 0]);
    expect([h.r, h.g, h.b]).toEqual([...albedo(Mat.WALLPAPER_L0)]);
    // from the other side: the +x face
    expect(q.raycast!(9, 1.5, 20, -1, 0, 0, 40, h)).toBe(true);
    expect(h.t).toBeCloseTo(9 - 6 - WALL_T / 2, 5);
    expect(h.nx).toBe(1);
    expect([h.r, h.g, h.b]).toEqual([...albedo(Mat.CONCRETE_WALL)]);
    // a slanted ray reaches the wall before the floor
    const n = Math.hypot(4, -1);
    expect(q.raycast!(1, 1.5, 20, 4 / n, -1 / n, 0, 40, h)).toBe(true);
    expect(h.nx).toBe(-1);
    expect(h.t * 4 / n).toBeCloseTo(6 - WALL_T / 2 - 1, 5);
  });

  it('hits SOLID cells, blockers and props; stops at maxDist and at unloaded space', () => {
    // SOLID cell (2, 8) spans x 2.4..3.6, z 9.6..10.8: a ray along +z at x = 3 hits its face z = 9.6
    expect(q.raycast!(3, 1.5, 7, 0, 0, 1, 40, h)).toBe(true);
    expect(h.t).toBeCloseTo(9.6 - 7, 5);
    expect(h.nz).toBe(-1);
    // blocker (3, 3): 0.9 m box over x 3.6..4.8, z 3.6..4.8, walkable top
    expect(q.raycast!(4.2, 2, 4.2, 0, -1, 0, 40, h)).toBe(true);
    expect(h.t).toBeCloseTo(2 - 0.9, 5);
    expect(h.ny).toBe(1);
    // the crate, lower than the ray origin: hit from above, prop albedo
    expect(q.raycast!(8 * CELL + 0.6, 2, 12 * CELL + 0.6, 0, -1, 0, 40, h)).toBe(true);
    expect(h.t).toBeLessThan(2 - 0.05);
    expect([h.r, h.g, h.b]).toEqual([RAY_PROP_RHO, RAY_PROP_RHO, RAY_PROP_RHO]);
    // too short
    expect(q.raycast!(2, 1.5, 2, 0, -1, 0, 1.0, h)).toBe(false);
    // horizontal ray along -x leaves the loaded chunk at x = 0 without a wall: no hit
    expect(q.raycast!(4, 1.5, 20, -1, 0, 0, 40, h)).toBe(false);
  });

  it('crosses open edges and passes through doorway openings, but not their jambs', () => {
    const l = room();
    const e = ezIdx(1, 20); // an x-running doorway on z = 24 m, cell 1 (x 1.2..2.4)
    l.ez.kind[e] = EdgeKind.DOORWAY; l.ez.hA[e] = 210; l.ez.matNeg[e] = Mat.DRYWALL; l.ez.matPos[e] = Mat.DRYWALL;
    const w = ezIdx(1, 25); // a wall behind it on z = 30 m
    l.ez.kind[w] = EdgeKind.WALL; l.ez.matNeg[w] = Mat.CONCRETE_WALL; l.ez.matPos[w] = Mat.CONCRETE_WALL;
    const q2 = query(l);
    // through the opening at 1 m to the wall behind it
    expect(q2.raycast!(1.8, 1.0, 22, 0, 0, 1, 40, h)).toBe(true);
    expect(h.t).toBeCloseTo(30 - WALL_T / 2 - 22, 5);
    expect([h.r, h.g, h.b]).toEqual([...albedo(Mat.CONCRETE_WALL)]);
    // above the header height: the header piece
    expect(q2.raycast!(1.8, 2.4, 22, 0, 0, 1, 40, h)).toBe(true);
    expect(h.t).toBeCloseTo(24 - WALL_T / 2 - 22, 5);
    expect(h.nz).toBe(-1);
    expect([h.r, h.g, h.b]).toEqual([...albedo(Mat.DRYWALL)]);
    // at the jamb (x = 1.25, inside the 0.6 m jamb band of a 1.2 m cell with a narrower door)
    expect(q2.raycast!(1.25, 1.0, 22, 0, 0, 1, 40, h)).toBe(true);
    expect(h.t).toBeCloseTo(24 - WALL_T / 2 - 22, 5);
  });
});
