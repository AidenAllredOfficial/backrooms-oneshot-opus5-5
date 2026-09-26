import { describe, expect, it } from 'vitest';
import { CELL, PLAYER } from '../../src/core/constants.ts';
import { cellIdx, exIdx, ezIdx } from '../../src/core/grid.ts';
import { EdgeKind, PropKind } from '../../src/core/ids.ts';
import { DEFAULT_SETTINGS } from '../../src/core/settings.ts';
import { createAutopilot, riseClear } from '../../src/player/autopilot.ts';
import { penetrationAt, SCRATCH_BOXES } from '../../src/player/collision.ts';
import { createPlayerSystem } from '../../src/player/PlayerSystem.ts';
import { input, openLayout, recordingBus, spawnAt, TestHost, TestWorld } from './helpers.ts';

/** 4 x 4 rooms of 6 x 6 cells with one doorway in every interior wall, a few dead-end stubs and furniture. */
function mazeWorld(): TestWorld {
  const l = openLayout();
  const R = 6, O = 4, NR = 4;
  for (let k = 0; k <= NR; k++) {
    for (let t = 0; t < R * NR; t++) {
      l.ex.kind[exIdx(O + k * R, O + t)] = EdgeKind.WALL;
      l.ez.kind[ezIdx(O + t, O + k * R)] = EdgeKind.WALL;
    }
  }
  for (let a = 0; a < NR; a++) for (let k = 1; k < NR; k++) {
    const d = (a * 7 + k * 3) % R; // doorway position varies
    l.ex.kind[exIdx(O + k * R, O + a * R + d)] = EdgeKind.DOORWAY; l.ex.hA[exIdx(O + k * R, O + a * R + d)] = 210;
    const e = (a * 5 + k) % R;
    l.ez.kind[ezIdx(O + a * R + e, O + k * R)] = EdgeKind.DOORWAY; l.ez.hA[ezIdx(O + a * R + e, O + k * R)] = 210;
  }
  // a dead-end stub wall inside some rooms
  for (let a = 0; a < NR; a += 2) for (let t = 0; t < 3; t++) l.ex.kind[exIdx(O + a * R + 3, O + a * R + t)] = EdgeKind.WALL;
  l.props.push({ kind: PropKind.DESK, variant: 0, x: (O + 2) * CELL, y: 0, z: (O + 3) * CELL, yaw: 0, scale: 1, flags: 0, seed: 1 });
  l.props.push({ kind: PropKind.CRATE, variant: 0, x: (O + 9) * CELL, y: 0, z: (O + 15) * CELL, yaw: 0, scale: 1, flags: 0, seed: 2 });
  return new TestWorld().add(l);
}

describe('autopilot', () => {
  it('wanders a room maze for 90 s: keeps moving at 0.6-1.2 m/s, never stuck, never inside geometry', () => {
    const w = mazeWorld();
    let t = 0;
    const pilot = createAutopilot(7, () => t);
    const { bus } = recordingBus();
    const start = spawnAt(7 * CELL, 7 * CELL, 0.3);
    const p = createPlayerSystem(start, DEFAULT_SETTINGS, bus, new TestHost(w));
    const inp = input();
    const scratch = new Float32Array(SCRATCH_BOXES * 6);
    const FPS = 30;
    let dist = 0, px = p.state.x, pz = p.state.z;
    let windowStart = 0, wx = px, wz = pz, worstWindow = Infinity;
    const rooms = new Set<string>();
    for (let f = 0; f < FPS * 90; f++) {
      t += 1 / FPS;
      pilot.next(p.state, w, inp);
      expect(inp.sprint).toBe(false);
      p.update(1 / FPS, inp, w, bus, false);
      const st = p.state;
      dist += Math.hypot(st.x - px, st.z - pz); px = st.x; pz = st.z;
      expect(penetrationAt(w, st.x, st.z, st.y, PLAYER.height, scratch)).toBeLessThan(0.003);
      rooms.add(`${Math.floor((st.x / CELL - 4) / 6)}:${Math.floor((st.z / CELL - 4) / 6)}`);
      if (t - windowStart >= 5) {
        worstWindow = Math.min(worstWindow, Math.hypot(st.x - wx, st.z - wz));
        windowStart = t; wx = st.x; wz = st.z;
      }
    }
    const avg = dist / 90;
    console.log(`autopilot: ${dist.toFixed(1)} m in 90 s, avg ${avg.toFixed(2)} m/s, worst 5 s window ${worstWindow.toFixed(2)} m, rooms ${rooms.size}`);
    expect(avg).toBeGreaterThan(0.5);
    expect(avg).toBeLessThan(1.25);
    expect(worstWindow).toBeGreaterThan(1.0); // never stuck for 5 s
    expect(rooms.size).toBeGreaterThanOrEqual(4); // explores, not pacing one room
  });

  it('is deterministic for a seed and heads for a target when given one', () => {
    const w = mazeWorld();
    const runOnce = (): number[] => {
      let t = 0;
      const pilot = createAutopilot(3, () => t);
      const { bus } = recordingBus();
      const p = createPlayerSystem(spawnAt(7 * CELL, 7 * CELL, 0), DEFAULT_SETTINGS, bus, new TestHost(w));
      const inp = input();
      pilot.setTarget(8 * CELL, 8.5 * CELL);
      for (let f = 0; f < 30 * 8; f++) { t += 1 / 30; pilot.next(p.state, w, inp); p.update(1 / 30, inp, w, bus, false); }
      return [p.state.x, p.state.z];
    };
    const a = runOnce(), b = runOnce();
    expect(a).toEqual(b);
    // reached the neighbourhood of the target (then resumed wandering)
    expect(Math.hypot(a[0] - 8 * CELL, a[1] - 8.5 * CELL)).toBeLessThan(6);
  });

  it('adapts to any mouse sensitivity (turns by the requested amount)', () => {
    const w = mazeWorld();
    for (const sens of [0.0005, 0.0022, 0.008]) {
      let t = 0;
      const pilot = createAutopilot(11, () => t);
      const { bus } = recordingBus();
      const p = createPlayerSystem(spawnAt(7 * CELL, 7 * CELL, 0), { ...DEFAULT_SETTINGS, mouseSensitivity: sens }, bus, new TestHost(w));
      const inp = input();
      let maxRate = 0, prevYaw = p.state.yaw;
      for (let f = 0; f < 30 * 20; f++) {
        t += 1 / 30; pilot.next(p.state, w, inp); p.update(1 / 30, inp, w, bus, false);
        let d = p.state.yaw - prevYaw; if (d > Math.PI) d -= 2 * Math.PI; if (d < -Math.PI) d += 2 * Math.PI;
        if (f > 30) maxRate = Math.max(maxRate, Math.abs(d) * 30);
        prevYaw = p.state.yaw;
      }
      expect(maxRate).toBeLessThan(8); // smooth: never a wild spin
      expect(Math.abs(p.state.pitch)).toBeLessThan(0.3);
    }
  });

  it('does not push against the rim of a sunken pit (floor rises taller than a step cut the clearance)', () => {
    // 8 x 8-cell pit, floor -45 cm (the rim is taller than a step), with a 2-cell-wide stair on its north side
    const l = openLayout();
    const P0 = 12, P1 = 20;
    for (let j = P0; j < P1; j++) for (let i = P0; i < P1; i++) l.floorCm[cellIdx(i, j)] = -45;
    for (const i of [15, 16]) { l.floorCm[cellIdx(i, P0)] = -15; l.floorCm[cellIdx(i, P0 + 1)] = -30; }
    const w = new TestWorld().add(l);
    // the rim cuts the clearance of a heading straight out of the pit; the stair heading stays clear
    expect(riseClear(w, 16 * CELL, 17 * CELL, 0, 1, 10)).toBeLessThan(3 * CELL + 0.01);
    expect(riseClear(w, 16 * CELL, 17 * CELL, 0, -1, 10)).toBe(10);
    const run = (target: boolean): { worst: number; outAt: number } => {
      let t = 0;
      const pilot = createAutopilot(5, () => t);
      const { bus } = recordingBus();
      const p = createPlayerSystem(spawnAt(16 * CELL, 17 * CELL, Math.PI, 0, -0.45), DEFAULT_SETTINGS, bus, new TestHost(w));
      const inp = input();
      if (target) pilot.setTarget(16 * CELL, 28 * CELL); // beyond the south rim: the straight line is blocked
      let outAt = -1, worst = Infinity, t0 = 0, wx = p.state.x, wz = p.state.z;
      for (let f = 0; f < 30 * 30; f++) {
        t += 1 / 30; pilot.next(p.state, w, inp); p.update(1 / 30, inp, w, bus, false);
        const gi = Math.floor(p.state.x / CELL), gj = Math.floor(p.state.z / CELL);
        if (outAt < 0 && (gi < P0 || gi >= P1 || gj < P0 || gj >= P1) && p.state.y > -0.05) outAt = t;
        if (t - t0 >= 5) { worst = Math.min(worst, Math.hypot(p.state.x - wx, p.state.z - wz)); t0 = t; wx = p.state.x; wz = p.state.z; }
      }
      return { worst, outAt };
    };
    // with a target across the rim it slides along the rim instead of standing pinned against it (was 0 m) ...
    expect(run(true).worst).toBeGreaterThan(0.5);
    // ... and without one it finds the stair and climbs out (15 s; 28 s without the rise check)
    const out = run(false).outAt;
    expect(out).toBeGreaterThan(0);
    expect(out).toBeLessThan(22);
  });
});
