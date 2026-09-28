// tests/stream/raycast.test.ts (package F) — WorldQuery.raycast over a hand-built layout whose collision comes from the
// real WP12 builder (walls with their thickness, SOLID masses, blockers, props): floor, ceiling and wall hits with the
// right distance, normal and albedo.

import { describe, expect, it } from 'vitest';
import { CELL, WALL_T } from '../../src/core/constants.ts';
import { cellIdx, exIdx, ezIdx, type ChunkKey } from '../../src/core/grid.ts';
import { CellFlag, EdgeKind, Mat, Mood, PropKind, SolidFlag, Zone, type StoreyId } from '../../src/core/ids.ts';
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

  it('looks through the virtual keep-out column of deep-water NOWALK cells to the pool floor and walls', () => {
    const l = room();
    // a 4 x 4-cell deep pool (x 14.4..19.2, z 12..16.8), floor 1.8 m below the deck, water 0.3 m below it
    for (let lj = 10; lj < 14; lj++) for (let li = 12; li < 16; li++) {
      const c = cellIdx(li, lj);
      l.flags[c] |= CellFlag.NOWALK;
      l.floorCm[c] = -180;
      l.waterCm[c] = -30;
      l.floorMat[c] = Mat.POOL_TILE;
    }
    const col = buildChunkCollision(l);
    // the column is still there for the player (collision), flagged VIRTUAL
    let columns = 0;
    for (let i = 0; i < col.boxFlags.length; i++) {
      if ((col.boxFlags[i] & SolidFlag.VIRTUAL) !== 0 && col.boxes[i * 6 + 4] > 2) columns++;
    }
    expect(columns).toBe(16);
    const q2 = query(l);
    // from the deck, 1.6 m up, 1.4 m before the pool edge: a 45-degree ray lands on the pool floor, not on the edge
    const s = Math.SQRT1_2;
    expect(q2.raycast!(13, 1.6, 14.4, s, -s, 0, 40, h)).toBe(true);
    expect(h.t).toBeCloseTo(3.4 * Math.SQRT2, 5);
    expect([h.nx, h.ny, h.nz]).toEqual([0, 1, 0]);
    expect([h.r, h.g, h.b]).toEqual([...albedo(Mat.POOL_TILE)]);
    // a flatter ray crosses the whole pool and hits its far wall (the deck's riser face at x = 19.2) below the deck
    const n = Math.hypot(1, 0.5);
    expect(q2.raycast!(13, 1.6, 14.4, 1 / n, -0.5 / n, 0, 40, h)).toBe(true);
    expect(h.t / n).toBeCloseTo(19.2 - 13, 5);
    expect(h.nx).toBe(-1);
    expect(1.6 - 0.5 * (h.t / n)).toBeLessThan(0);
    // a level ray from the deck crosses the pool and the deck beyond it and leaves the chunk (nothing to light)
    expect(q2.raycast!(13, 1.0, 13.8, 1, 0, 0, 40, h)).toBe(false);
    // the unchanged builder output with the flag cleared: the ray stops at the invisible column (the old defect)
    const opaque = { ...col, boxFlags: col.boxFlags.map((f) => f & ~SolidFlag.VIRTUAL) };
    const s0 = new StoreyData();
    s0.set(createChunkData(l, opaque));
    const data = [s0, new StoreyData(), new StoreyData()];
    const q3 = createWorldQuery({ storey: () => 0 as StoreyId, data: (i) => data[i] });
    expect(q3.raycast!(13, 1.0, 13.8, 1, 0, 0, 40, h)).toBe(true);
    expect(h.t).toBeCloseTo(14.4 - 13, 5);
  });

  it('a FILLED ramp is hit on its sides and ends below its walking surface; an open flight only on its top', () => {
    const l = room();
    // two 1.2 m-high flights ascending +x over x 12..14.4: filled at z 18..19.2, open at z 21.6..22.8
    const flight = (id: number, z0: number, filled: boolean): void => {
      l.solids.push({ kind: 'ramp', id, x0: 12, z0, x1: 14.4, z1: z0 + 1.2, y0: 0, y1: 1.2, dir: 0, steps: 8, mat: Mat.POOL_TILE,
        flags: SolidFlag.COLLIDE | SolidFlag.WALKABLE_TOP | SolidFlag.RENDER | (filled ? SolidFlag.FILLED : 0), bakeGroup: 0 });
    };
    flight(1, 18, true);
    flight(2, 21.6, false);
    const q2 = query(l);
    // along +z at x = 14, 0.5 m up (walking surface 1.0 m there): the filled body's side face z = 18
    expect(q2.raycast!(14, 0.5, 16, 0, 0, 1, 40, h)).toBe(true);
    expect(h.t).toBeCloseTo(2, 5);
    expect([h.nx, h.ny, h.nz]).toEqual([0, 0, -1]);
    // the same ray through the open flight's side reaches whatever lies beyond (no ramp hit at z = 21.6)
    expect(q2.raycast!(14, 0.5, 20, 0, 0, 1, 40, h)).toBe(false);
    // above the walking surface at the entry point: not a side hit (x = 12.5: surface 0.25 m)
    expect(q2.raycast!(12.5, 0.5, 16, 0, 0, 1, 40, h)).toBe(false);
    // the high end face (x = 14.4) from +x, 0.6 m up
    expect(q2.raycast!(16, 0.6, 18.6, -1, 0, 0, 40, h)).toBe(true);
    expect(h.t).toBeCloseTo(16 - 14.4, 5);
    expect(h.nx).toBe(1);
    // from above: the walking surface, as before
    expect(q2.raycast!(13.2, 2, 18.6, 0, -1, 0, 40, h)).toBe(true);
    expect(h.t).toBeCloseTo(2 - 0.6, 5);
    expect(h.ny).toBeGreaterThan(0.8);
  });

  it('an open flight is a slab: its soffit is hit from below, its stringers between the soffit and the walking line', () => {
    const l = room();
    // an open 1.2 m flight ascending +x over x 12..14.4, z 21.6..22.8 (slope 0.5)
    l.solids.push({ kind: 'ramp', id: 2, x0: 12, z0: 21.6, x1: 14.4, z1: 22.8, y0: 0, y1: 1.2, dir: 0, steps: 8, mat: Mat.POOL_TILE,
      flags: SolidFlag.COLLIDE | SolidFlag.WALKABLE_TOP | SolidFlag.RENDER, bakeGroup: 0 });
    const q2 = query(l);
    const nl = 1 / Math.hypot(0.5, 1);
    // straight up from under the high end (walking line 0.9 m at x = 13.8): the soffit, RAMP_SLAB = 0.2 m below it,
    // facing down and toward the high end; before this, the ray passed through to the ceiling at 2.7 m
    expect(q2.raycast!(13.8, 0.2, 22.2, 0, 1, 0, 40, h)).toBe(true);
    expect(h.t).toBeCloseTo(0.9 - 0.2 - 0.2, 5);
    expect(h.nx).toBeCloseTo(0.5 * nl, 6); // Float32 ramp records
    expect(h.ny).toBeCloseTo(-nl, 6);
    expect(h.nz).toBeCloseTo(0, 12);
    // a slanted ray from beside the flight enters under it (0.4 m up at z = 21.6, soffit 0.7 m) and meets the soffit
    // at x = 13.5 (0.55 m up), not the ceiling behind
    const n = Math.hypot(1, 0.5, 1);
    expect(q2.raycast!(14.5, 0.05, 20.9, -1 / n, 0.5 / n, 1 / n, 40, h)).toBe(true);
    expect(h.t).toBeCloseTo(1.0 * n, 5);
    expect(h.ny).toBeCloseTo(-nl, 6);
    // along +z at x = 14 (walking line 1.0 m, soffit 0.8 m): 0.9 m up hits the stringer face z = 21.6 ...
    expect(q2.raycast!(14, 0.9, 20, 0, 0, 1, 40, h)).toBe(true);
    expect(h.t).toBeCloseTo(1.6, 5);
    expect([h.nx, h.ny, h.nz]).toEqual([0, 0, -1]);
    // ... 0.5 m up passes under the flight, and 1.1 m up over it (a level ray never meets the sloped planes)
    expect(q2.raycast!(14, 0.5, 20, 0, 0, 1, 40, h)).toBe(false);
    expect(q2.raycast!(14, 1.1, 20, 0, 0, 1, 40, h)).toBe(false);
    // a ray rising from above the flight never meets its soffit (the plane lies behind it)
    expect(q2.raycast!(13.2, 1.2, 22.2, 0, 1, 0, 40, h)).toBe(true);
    expect(h.t).toBeCloseTo(2.7 - 1.2, 5);
    expect(h.ny).toBe(-1);
  });
});
