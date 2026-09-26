import { describe, expect, it } from 'vitest';
import { CELL, PLAYER, WALL_T } from '../../src/core/constants.ts';
import { cellIdx, exIdx, ezIdx } from '../../src/core/grid.ts';
import { CellFlag, EdgeKind, PropFlag, PropKind, SolidFlag } from '../../src/core/ids.ts';
import { buildChunkCollision, rampHeightAt } from '../../src/player/collisionBuild.ts';
import { layoutFrom, openLayout, place, roomText } from './helpers.ts';

type Box = [number, number, number, number, number, number];
const boxesOf = (c: ReturnType<typeof buildChunkCollision>): Box[] => {
  const out: Box[] = [];
  for (let i = 0; i < c.boxFlags.length; i++) out.push(Array.from(c.boxes.subarray(i * 6, i * 6 + 6)) as Box);
  return out;
};
const near = (a: number, b: number, e = 1e-4): boolean => Math.abs(a - b) < e;

describe('buildChunkCollision', () => {
  it('produces a valid CSR bucket structure', () => {
    const l = layoutFrom(place(roomText(6, 5), 4, 4));
    const c = buildChunkCollision(l);
    expect(c.cellStart.length).toBe(1025);
    expect(c.boxes.length).toBe(c.boxFlags.length * 6);
    for (let i = 0; i < 1024; i++) expect(c.cellStart[i + 1]).toBeGreaterThanOrEqual(c.cellStart[i]);
    expect(c.cellStart[1024]).toBe(c.cellBoxes.length);
    for (const b of c.cellBoxes) expect(b).toBeLessThan(c.boxFlags.length);
    for (const f of c.boxFlags) expect(f & SolidFlag.COLLIDE).toBe(SolidFlag.COLLIDE);
    expect(Number.isFinite(c.boxes.reduce((a, b) => a + b, 0))).toBe(true);
  });

  it('buckets every box into every cell its radius-expanded footprint touches', () => {
    const l = layoutFrom(place(roomText(6, 5), 4, 4));
    const c = buildChunkCollision(l);
    const bs = boxesOf(c);
    const r = PLAYER.radius;
    for (let li = 0; li < 32; li++) for (let lj = 0; lj < 32; lj++) {
      const cell = cellIdx(li, lj);
      const listed = new Set(Array.from(c.cellBoxes.subarray(c.cellStart[cell], c.cellStart[cell + 1])));
      bs.forEach((b, i) => {
        const overlaps = b[0] - r < (li + 1) * CELL && b[3] + r > li * CELL && b[2] - r < (lj + 1) * CELL && b[5] + r > lj * CELL;
        if (overlaps) expect(listed.has(i)).toBe(true);
      });
    }
  });

  it('turns WALL edges into WALL_T boxes extended over the corner posts', () => {
    const l = openLayout();
    l.ex.kind[exIdx(10, 5)] = EdgeKind.WALL; // line x = 12 m, cell row 5
    const c = buildChunkCollision(l);
    const walls = boxesOf(c).filter((b) => near(b[0], 10 * CELL - WALL_T / 2) && near(b[3], 10 * CELL + WALL_T / 2));
    expect(walls.length).toBe(1);
    const w = walls[0];
    expect(w[2]).toBeCloseTo(5 * CELL - WALL_T / 2, 5);
    expect(w[5]).toBeCloseTo(6 * CELL + WALL_T / 2, 5);
    expect(w[1]).toBeCloseTo(0, 5);
    expect(w[4]).toBeCloseTo(2.7, 5);
  });

  it('splits a DOORWAY into jambs and a head, leaving a 0.9 m x 2.1 m hole', () => {
    const l = openLayout();
    l.ez.kind[ezIdx(7, 9)] = EdgeKind.DOORWAY; // line z = 10.8, cell column 7
    l.ez.hA[ezIdx(7, 9)] = 210;
    const c = buildChunkCollision(l);
    const pieces = boxesOf(c).filter((b) => near(b[2], 9 * CELL - WALL_T / 2) && near(b[5], 9 * CELL + WALL_T / 2));
    expect(pieces.length).toBe(3);
    const x0 = 7 * CELL;
    const jambs = pieces.filter((p) => near(p[1], 0));
    expect(jambs.length).toBe(2);
    const inner = jambs.map((j) => (j[0] < x0 + 0.6 ? j[3] : j[0])).sort((a, b) => a - b);
    expect(inner[1] - inner[0]).toBeCloseTo(0.9, 5);
    const head = pieces.find((p) => near(p[1], 2.1));
    expect(head).toBeDefined();
  });

  it('adds risers for raised cells (step blocking) and soffits for low ceilings', () => {
    const l = openLayout();
    l.floorCm[cellIdx(10, 10)] = 30;
    l.ceilCm[cellIdx(12, 10)] = 150;
    const c = buildChunkCollision(l);
    const bs = boxesOf(c);
    const riser = bs.find((b) => near(b[0], 10 * CELL) && near(b[2], 10 * CELL) && near(b[4], 0.3));
    expect(riser).toBeDefined();
    expect(riser![1]).toBeCloseTo(0, 5);
    const i = bs.indexOf(riser!);
    expect(c.boxFlags[i] & SolidFlag.WALKABLE_TOP).toBeTruthy();
    const soffit = bs.find((b) => near(b[0], 12 * CELL) && near(b[2], 10 * CELL) && near(b[1], 1.5));
    expect(soffit).toBeDefined();
    expect(soffit![4]).toBeCloseTo(2.7, 5);
  });

  it('merges SOLID cells into rectangles and emits blockers / NOWALK / VOID boxes', () => {
    const l = openLayout();
    for (let j = 3; j < 7; j++) for (let i = 3; i < 9; i++) l.flags[cellIdx(i, j)] = CellFlag.SOLID;
    l.blockCm[cellIdx(20, 20)] = 90;
    l.flags[cellIdx(22, 20)] = CellFlag.NOWALK;
    l.flags[cellIdx(24, 20)] = CellFlag.VOID;
    const c = buildChunkCollision(l);
    const bs = boxesOf(c);
    const solid = bs.filter((b) => b[0] >= 3 * CELL - 1e-4 && b[3] <= 9 * CELL + 1e-4 && b[2] >= 3 * CELL - 1e-4 && b[5] <= 7 * CELL + 1e-4 && b[1] < -5);
    expect(solid.length).toBe(1);
    expect(solid[0][3] - solid[0][0]).toBeCloseTo(6 * CELL, 4);
    expect(bs.some((b) => near(b[0], 20 * CELL) && near(b[4], 0.9))).toBe(true);
    expect(bs.some((b) => near(b[0], 22 * CELL) && b[4] > 2)).toBe(true);
    expect(bs.some((b) => near(b[0], 24 * CELL) && near(b[4], -6))).toBe(true);
  });

  it('uses PROP_DEFS footprints with yaw snapped to 90 degrees; skips non-colliding and ceiling props', () => {
    const l = openLayout();
    l.props.push({ kind: PropKind.DESK, variant: 0, x: 10, y: 0, z: 10, yaw: Math.PI / 2 + 0.1, scale: 1, flags: 0, seed: 1 });
    l.props.push({ kind: PropKind.PHONE, variant: 0, x: 5, y: 0.75, z: 5, yaw: 0, scale: 1, flags: 0, seed: 2 });
    l.props.push({ kind: PropKind.DESK, variant: 0, x: 20, y: 2.7, z: 20, yaw: 0, scale: 1, flags: PropFlag.CEILING, seed: 3 });
    const c = buildChunkCollision(l);
    const bs = boxesOf(c).filter((b) => b[1] >= -1e-6 && b[0] > 4 && b[3] < 30 && b[4] < 1);
    const desk = bs.find((b) => near((b[0] + b[3]) / 2, 10) && near((b[2] + b[5]) / 2, 10));
    expect(desk).toBeDefined();
    expect(desk![3] - desk![0]).toBeCloseTo(0.75, 5); // rotated: depth along x
    expect(desk![5] - desk![2]).toBeCloseTo(1.5, 5);
    expect(desk![4]).toBeCloseTo(0.75, 5);
    expect(bs.some((b) => near((b[0] + b[3]) / 2, 5))).toBe(false); // phone: no collision
    expect(boxesOf(c).some((b) => near((b[0] + b[3]) / 2, 20) && near((b[2] + b[5]) / 2, 20) && b[1] > 2)).toBe(false);
  });

  it('keeps a lone DOOR_FRAME passable (jambs + head)', () => {
    const l = openLayout();
    l.props.push({ kind: PropKind.DOOR_FRAME, variant: 0, x: 12, y: 0, z: 12, yaw: 0, scale: 1, flags: 0, seed: 1 });
    const c = buildChunkCollision(l);
    const bs = boxesOf(c).filter((b) => near((b[2] + b[5]) / 2, 12) && b[0] > 11 && b[3] < 13);
    expect(bs.length).toBe(3);
    const low = bs.filter((b) => near(b[1], 0)).sort((a, b) => a[0] - b[0]);
    expect(low[1][0] - low[0][3]).toBeCloseTo(0.9, 5);
  });

  it('passes ramps through and evaluates their height', () => {
    const l = openLayout();
    l.solids.push({ kind: 'ramp', id: 1, x0: 2, z0: 2, x1: 3.2, z1: 5.6, y0: -1.5, y1: 0, dir: 3, steps: 13, mat: 9, flags: SolidFlag.COLLIDE | SolidFlag.WALKABLE_TOP, bakeGroup: 0 });
    const c = buildChunkCollision(l);
    expect(c.ramps.length).toBe(8);
    expect(rampHeightAt(c.ramps, 0, 2.5, 2)).toBeCloseTo(0, 5); // -z end is the high end
    expect(rampHeightAt(c.ramps, 0, 2.5, 5.6)).toBeCloseTo(-1.5, 5);
    expect(rampHeightAt(c.ramps, 0, 2.5, 3.8)).toBeCloseTo(-0.75, 5);
    expect(Number.isNaN(rampHeightAt(c.ramps, 0, 4, 3))).toBe(true);
  });

  it('GLITCH edges collide like walls', () => {
    const l = openLayout();
    l.ex.kind[exIdx(8, 8)] = EdgeKind.GLITCH;
    const c = buildChunkCollision(l);
    expect(boxesOf(c).some((b) => near(b[0], 8 * CELL - WALL_T / 2) && near(b[2], 8 * CELL - WALL_T / 2))).toBe(true);
  });
});
