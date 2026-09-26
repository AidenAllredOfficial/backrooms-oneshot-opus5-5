import { describe, expect, it } from 'vitest';
import { CELL, PLAYER, WALL_T } from '../../src/core/constants.ts';
import { exIdx, ezIdx } from '../../src/core/grid.ts';
import { EdgeKind, SolidFlag } from '../../src/core/ids.ts';
import { createPlayerState } from '../../src/core/player.ts';
import { MOVE_RESULT, moveAndCollide, penetrationAt, SCRATCH_BOXES } from '../../src/player/collision.ts';
import { layoutFrom, openLayout, place, roomText, TestWorld } from './helpers.ts';

const scratch = new Float32Array(SCRATCH_BOXES * 6);

/** Open floor with one x-wall run on line x = 12 (i = 10) from z-cells [4, 20). */
function wallWorld(): TestWorld {
  const l = openLayout();
  for (let lj = 4; lj < 20; lj++) l.ex.kind[exIdx(10, lj)] = EdgeKind.WALL;
  return new TestWorld().add(l);
}
const FACE = 10 * CELL - WALL_T / 2; // west face of the wall

describe('moveAndCollide', () => {
  it('never tunnels through a 0.15 m wall at 20 m/s and stops at radius from the face (+-1 mm)', () => {
    const w = wallWorld();
    const s = createPlayerState(0, 9, 0, 14, 0, 0);
    const dt = 1 / 120;
    for (let i = 0; i < 240; i++) {
      s.vx = 20; s.vz = 0;
      moveAndCollide(w, s, s.vx * dt, 0, PLAYER.height, scratch);
      expect(s.x).toBeLessThan(FACE);
    }
    expect(Math.abs(s.x - (FACE - PLAYER.radius))).toBeLessThan(0.001);
    expect(s.vx).toBeCloseTo(0, 6); // into-wall velocity removed
  });

  it('never tunnels with a single huge displacement either', () => {
    const w = wallWorld();
    const s = createPlayerState(0, 9, 0, 14, 0, 0);
    moveAndCollide(w, s, 25, 0, PLAYER.height, scratch);
    expect(Math.abs(s.x - (FACE - PLAYER.radius))).toBeLessThan(0.001);
  });

  it('slides along a wall hit at 45 degrees', () => {
    const w = wallWorld();
    const s = createPlayerState(0, FACE - 0.5, 0, 8, 0, 0);
    const dt = 1 / 120;
    const v = 1.45 / Math.SQRT2;
    for (let i = 0; i < 360; i++) moveAndCollide(w, s, v * dt, v * dt, PLAYER.height, scratch);
    expect(Math.abs(s.x - (FACE - PLAYER.radius))).toBeLessThan(0.001);
    // it kept moving along z: 3 s at 1.03 m/s ~ 3.1 m (minus nothing: tangential motion is never removed)
    expect(s.z - 8).toBeGreaterThan(3.0);
  });

  it('does not stick on doorway jambs when entering off-centre or diagonally', () => {
    // two rooms separated by a wall with a DOORWAY on line z = 6 (cell column 6)
    const l = layoutFrom(place(roomText(12, 10), 1, 1));
    for (let li = 1; li < 13; li++) l.ez.kind[ezIdx(li, 6)] = EdgeKind.WALL;
    l.ez.kind[ezIdx(6, 6)] = EdgeKind.DOORWAY; l.ez.hA[ezIdx(6, 6)] = 210;
    const w = new TestWorld().add(l);
    const doorX = 6.5 * CELL, lineZ = 6 * CELL;
    for (const [off, ang] of [[0.15, 0], [-0.15, 0], [0.3, 0.35], [-0.3, -0.35], [0.0, 0.6]]) {
      const s = createPlayerState(0, doorX + off - Math.sin(ang) * 1.5, 0, lineZ - 1.5, 0, 0);
      const dt = 1 / 120;
      const dx = Math.sin(ang), dz = Math.cos(ang);
      for (let i = 0; i < 480 && s.z < lineZ + 1; i++) {
        // steer toward the door centre like a player would (aim assist free: just keep pushing)
        const tx = doorX - s.x, tz = lineZ + 1.2 - s.z;
        const len = Math.hypot(tx, tz);
        const ux = 0.6 * dx + 0.4 * (tx / len), uz = 0.6 * dz + 0.4 * (tz / len);
        s.vx = ux * 1.45; s.vz = uz * 1.45;
        moveAndCollide(w, s, s.vx * dt, s.vz * dt, PLAYER.height, scratch);
      }
      expect(s.z).toBeGreaterThan(lineZ + 0.5);
    }
  });

  it('refuses motion into unloaded chunks, keeping radius from the boundary', () => {
    const w = new TestWorld().add(openLayout(0, 0, 0)); // only chunk (0,0): x in [0, 38.4)
    const s = createPlayerState(0, 37, 0, 10, 0, 0);
    for (let i = 0; i < 200; i++) moveAndCollide(w, s, 0.05, 0.0, PLAYER.height, scratch);
    expect(s.x).toBeLessThanOrEqual(38.4 - PLAYER.radius + 1e-6);
    expect(s.x).toBeGreaterThan(38.4 - PLAYER.radius - 0.01);
    expect(MOVE_RESULT.blocked).toBe(true);
  });

  it('steps onto a 0.30 m riser but is stopped by a 0.45 m one', () => {
    const l = openLayout();
    for (let lj = 0; lj < 32; lj++) { l.floorCm[lj * 32 + 12] = 30; l.floorCm[lj * 32 + 20] = 45; }
    const w = new TestWorld().add(l);
    const s = createPlayerState(0, 13, 0, 10, 0, 0);
    for (let i = 0; i < 100; i++) moveAndCollide(w, s, 0.02, 0, PLAYER.height, scratch);
    expect(s.y).toBeCloseTo(0.3, 5);
    const t = createPlayerState(0, 23, 0, 10, 0, 0);
    for (let i = 0; i < 100; i++) moveAndCollide(w, t, 0.02, 0, PLAYER.height, scratch);
    expect(t.y).toBeCloseTo(0, 5);
    expect(Math.abs(t.x - (20 * CELL - PLAYER.radius))).toBeLessThan(0.001);
  });

  it('reports penetration for the unstuck logic', () => {
    const w = wallWorld();
    expect(penetrationAt(w, FACE - 0.1, 10, 0, PLAYER.height, scratch)).toBeGreaterThan(0.1);
    expect(penetrationAt(w, FACE - 0.5, 10, 0, PLAYER.height, scratch)).toBe(0);
  });

  // ---------------------------------------------------------------- head room (overhangs are not boxes)
  /** Open floor with a free-standing flight overhead: footprint x [6, 7.2], z [6, 13.2], rising +z from 1.0 to 4.0
   * (slope 0.4167); its soffit is 0.2 m under the walking plane (TestWorld.ceilingAt, like WP10's query). */
  function flightWorld(): TestWorld {
    const l = openLayout();
    l.solids.push({ kind: 'ramp', id: 1, x0: 6, z0: 6, x1: 7.2, z1: 13.2, y0: 1.0, y1: 4.0, dir: 2, steps: 20, mat: 9, flags: SolidFlag.COLLIDE | SolidFlag.WALKABLE_TOP, bakeGroup: 0 });
    return new TestWorld().add(l);
  }
  const walkX = (w: TestWorld, z: number, height: number, frames = 360): number => {
    const s = createPlayerState(0, 4, 0, z, 0, 0);
    for (let i = 0; i < frames; i++) moveAndCollide(w, s, 1.45 / 120, 0, height, scratch);
    return s.x;
  };

  it('walking under a stair flight stops where its soffit would hit the head, with the rim (not the centre) at the edge', () => {
    const w = flightWorld();
    // surface 1.83 at z = 8: above the head (1.75) but its soffit (1.63) is not
    const xs = walkX(w, 8.0, PLAYER.height);
    expect(xs).toBeLessThan(6 - PLAYER.radius * 0.9 + 1e-3);
    expect(xs).toBeGreaterThan(6 - PLAYER.radius - 0.02); // no early stop either
    // surface 2.25 at z = 9 (soffit 2.05): free passage under it
    expect(walkX(w, 9.0, PLAYER.height)).toBeGreaterThan(8);
    // crouched the lower part is passable too
    expect(walkX(w, 8.0, PLAYER.crouchHeight)).toBeGreaterThan(8);
    // the flight's side where its surface is at body height: a solid wedge, kept off by the rim
    expect(walkX(w, 7.0, PLAYER.height)).toBeLessThan(6 - PLAYER.radius * 0.9 + 1e-3);
  });

  it('a step up under a low overhang is refused (the raised head would clip), a plain step up is not', () => {
    const l = openLayout();
    // a 0.3 m platform (WALKABLE_TOP box) from x = 6; over part of it a beam whose underside is 1.9 m (clear of a
    // 1.75 m head at floor level, not of the head raised by the step)
    l.solids.push({ kind: 'box', id: 1, min: [6, 0, 2], max: [10, 0.3, 12], mat: 9, flags: SolidFlag.COLLIDE | SolidFlag.WALKABLE_TOP, bakeGroup: 0 });
    l.solids.push({ kind: 'box', id: 2, min: [5, 1.9, 2], max: [10, 2.2, 6], mat: 9, flags: SolidFlag.COLLIDE, bakeGroup: 0 });
    const w = new TestWorld().add(l);
    const s = createPlayerState(0, 4, 0, 4, 0, 0);
    for (let i = 0; i < 360; i++) moveAndCollide(w, s, 1.45 / 120, 0, PLAYER.height, scratch);
    expect(s.y).toBe(0);
    expect(s.x).toBeLessThan(6 + 0.01);
    expect(penetrationAt(w, s.x, s.z, s.y, PLAYER.height, scratch)).toBeLessThan(0.001);
    const t = createPlayerState(0, 4, 0, 9, 0, 0);
    for (let i = 0; i < 360; i++) moveAndCollide(w, t, 1.45 / 120, 0, PLAYER.height, scratch);
    expect(t.y).toBeCloseTo(0.3, 5);
    expect(t.x).toBeGreaterThan(7);
  });

  it('a player who starts under an overhang can always walk out', () => {
    const w = flightWorld();
    const s = createPlayerState(0, 6.6, 0, 7.6, 0, 0); // inside the wedge: surface 1.67 m, soffit 1.47 m
    for (let i = 0; i < 240; i++) moveAndCollide(w, s, -1.45 / 120, 0, PLAYER.height, scratch);
    expect(s.x).toBeLessThan(5);
  });
});
