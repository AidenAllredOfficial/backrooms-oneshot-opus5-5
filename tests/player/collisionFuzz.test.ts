// Robustness fuzz: random wall mazes (walls, doorways, arches, half walls, posts, props, raised cells) walked with
// random fast inputs. Invariants after every sub-step: the body never overlaps a blocking box by more than
// PEN_ACCEPT, the centre never crosses a WALL line within the wall's extent (no tunnelling), and the feet never
// float or sink (y is always a real floor within step reach of the previous one).
import { describe, expect, it } from 'vitest';
import { CELL, PLAYER } from '../../src/core/constants.ts';
import { edgeDefaults } from '../../src/core/edges.ts';
import type { GameEvents } from '../../src/core/events.ts';
import { cellIdx, exIdx, ezIdx, worldToCell } from '../../src/core/grid.ts';
import { EdgeKind, PropKind } from '../../src/core/ids.ts';
import { createPlayerState } from '../../src/core/player.ts';
import { Rng } from '../../src/core/rng.ts';
import { PEN_ACCEPT, penetrationAt, SCRATCH_BOXES } from '../../src/player/collision.ts';
import { DEFAULT_CONTROLLER, stepPlayer } from '../../src/player/controller.ts';
import { input, openLayout, TestWorld } from './helpers.ts';

const DT = 1 / 120;
const noEmit = (() => {}) as <K extends keyof GameEvents>(k: K, e: GameEvents[K]) => void;

function mazeWorld(seed: number): TestWorld {
  const rng = new Rng(seed);
  const l = openLayout();
  const kinds = [EdgeKind.WALL, EdgeKind.WALL, EdgeKind.WALL, EdgeKind.DOORWAY, EdgeKind.ARCH, EdgeKind.HALF, EdgeKind.GLITCH];
  const set = (e: typeof l.ex, idx: number): void => {
    const k = kinds[rng.int(0, kinds.length - 1)];
    const d = edgeDefaults(k);
    e.kind[idx] = k; e.hA[idx] = d[0]; e.hB[idx] = d[1];
  };
  for (let j = 2; j < 30; j++) for (let i = 2; i <= 30; i++) if (rng.float() < 0.28) set(l.ex, exIdx(i, j));
  for (let j = 2; j <= 30; j++) for (let i = 2; i < 30; i++) if (rng.float() < 0.28) set(l.ez, ezIdx(i, j));
  // a closed outer ring so the player stays on the chunk
  for (let k = 2; k < 30; k++) {
    l.ex.kind[exIdx(2, k)] = EdgeKind.WALL; l.ex.kind[exIdx(30, k)] = EdgeKind.WALL;
    l.ez.kind[ezIdx(k, 2)] = EdgeKind.WALL; l.ez.kind[ezIdx(k, 30)] = EdgeKind.WALL;
  }
  // raised cells (climbable and not), blockers, props
  for (let n = 0; n < 40; n++) l.floorCm[cellIdx(rng.int(3, 28), rng.int(3, 28))] = [20, 30, 45, 90][rng.int(0, 3)];
  for (let n = 0; n < 10; n++) l.blockCm[cellIdx(rng.int(3, 28), rng.int(3, 28))] = 100;
  for (let n = 0; n < 30; n++) {
    const kind = [PropKind.CRATE, PropKind.DESK, PropKind.TRASH_CAN, PropKind.CHAIR_STACKING][rng.int(0, 3)];
    l.props.push({ kind, variant: 0, x: rng.range(3 * CELL, 29 * CELL), y: 0, z: rng.range(3 * CELL, 29 * CELL), yaw: rng.int(0, 3) * Math.PI / 2 + rng.range(-0.2, 0.2), scale: 1, flags: 0, seed: n });
  }
  return new TestWorld().add(l);
}

/** Does the segment a->b cross a full-height WALL/GLITCH edge between the two cells it connects? */
function crossesWall(w: TestWorld, ax: number, az: number, bx: number, bz: number): boolean {
  const l = w.layoutAt(0, 0)!;
  const ai = worldToCell(ax), aj = worldToCell(az), bi = worldToCell(bx), bj = worldToCell(bz);
  const full = (k: number): boolean => k === EdgeKind.WALL || k === EdgeKind.GLITCH;
  if (ai !== bi && aj === bj) return full(l.ex.kind[exIdx(Math.max(ai, bi), aj)]);
  if (aj !== bj && ai === bi) return full(l.ez.kind[ezIdx(ai, Math.max(aj, bj))]);
  return false; // diagonal cell change through a corner: covered by the penetration invariant
}

describe('collision fuzz', () => {
  for (const seed of [1, 2, 3, 4]) {
    it(`random maze ${seed}: bounded penetration, no wall crossing, no floating / sinking`, () => {
      const w = mazeWorld(seed);
      const rng = new Rng(seed * 7919);
      const scratch = new Float32Array(SCRATCH_BOXES * 6);
      const s = createPlayerState(0, 16 * CELL + 0.6, 0, 16 * CELL + 0.6, 0, 0);
      const l = w.layoutAt(0, 0)!;
      l.floorCm[cellIdx(16, 16)] = 0; l.blockCm[cellIdx(16, 16)] = 0;
      let inp = input({ moveZ: 1 });
      let maxPen = 0, moved = 0;
      for (let step = 0; step < 120 * 90; step++) {
        if (step % 45 === 0) {
          inp = input({ moveZ: rng.float() < 0.8 ? 1 : -1, moveX: rng.range(-1, 1), sprint: rng.float() < 0.5, crouch: rng.float() < 0.1 });
          s.yaw = rng.range(-Math.PI, Math.PI);
        }
        if (step % 240 === 0) { s.vx = rng.range(-20, 20); s.vz = rng.range(-20, 20); } // violent shoves
        const px = s.x, pz = s.z, py = s.y;
        stepPlayer(s, inp, DT, w, DEFAULT_CONTROLLER, noEmit, 0.0022, false);
        moved += Math.hypot(s.x - px, s.z - pz);
        const pen = penetrationAt(w, s.x, s.z, s.y, PLAYER.height + (PLAYER.crouchHeight - PLAYER.height) * s.crouch, scratch);
        maxPen = Math.max(maxPen, pen);
        if (!(pen <= PEN_ACCEPT + 1e-4)) expect(pen).toBeLessThanOrEqual(PEN_ACCEPT + 1e-4);
        const crossed = crossesWall(w, px, pz, s.x, s.z);
        if (!Object.is(crossed, false)) expect(crossed).toBe(false);
        // feet on a real surface of the current position, never above step reach of the last one
        if (s.onGround) {
          const floorY = w.floorAt(s.x, s.z, s.y);
          if (!(Math.abs(floorY - s.y) < 10 ** -5 / 2)) expect(s.y).toBeCloseTo(floorY, 5);
          if (!(s.y - py <= PLAYER.stepMax + 0.011)) expect(s.y - py).toBeLessThanOrEqual(PLAYER.stepMax + 0.011);
        }
      }
      expect(moved).toBeGreaterThan(50); // it really explored
    });
  }
});
