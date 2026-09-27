// tests/materials/rippleSources.test.ts — package E ripple simulation, pure half (materials/water/rippleSources.ts):
// impulses, window snapping, stability, the cell mask, drips and the water-plane scan.

import { describe, expect, it } from 'vitest';
import { CELL } from '../../src/core/constants.ts';
import { cellIdx, exIdx } from '../../src/core/grid.ts';
import { CellFlag, EdgeKind, EmitterKind, Mood, Zone } from '../../src/core/ids.ts';
import { createEmptyLayout, type ChunkLayout } from '../../src/core/layout.ts';
import { QUALITY, QUALITY_NAMES } from '../../src/core/quality.ts';
import {
  buildRippleMask, collectDrips, courant2, dampOf, dripTiming, dropsBetween, footOffset, footstepImpulse, maskCell0,
  nearestWaterPlane, RIPPLE, rippleWindow, simulatedPlane, swayDue, wakeImpulses, type DripSource, type Impulse,
  type RippleWindow,
} from '../../src/materials/water/rippleSources.ts';

/** One chunk at (0, 0): a room of 10 x 10 cells with a pool (water -10 cm) in cells 2..7 x 2..7. */
function poolLayout(): ChunkLayout {
  const l = createEmptyLayout({ s: 0, cx: 0, cz: 0 }, Zone.POOLROOMS, 0, Mood.NORMAL);
  l.flags.fill(CellFlag.SOLID);
  for (let j = 0; j < 10; j++) for (let i = 0; i < 10; i++) { l.flags[cellIdx(i, j)] = 0; l.ceilCm[cellIdx(i, j)] = 450; }
  for (let j = 2; j < 8; j++) {
    for (let i = 2; i < 8; i++) { l.floorCm[cellIdx(i, j)] = -150; l.waterCm[cellIdx(i, j)] = -10; }
  }
  l.water.push({ x0: 2 * CELL, z0: 2 * CELL, x1: 8 * CELL, z1: 8 * CELL, y: -0.1, floorY: -1.5, kind: 0 });
  return l;
}
const worldOf = (l: ChunkLayout) => ({ layoutAt: (cx: number, cz: number) => (cx === 0 && cz === 0 ? l : null) });

describe('ripple impulses', () => {
  it('footsteps: none when dry, the foot is offset sideways, amplitude grows with depth up to 0.3 m', () => {
    expect(footstepImpulse(1, 1, 0, 0, 1, 0.01)).toBeNull();
    const [lx, lz] = footOffset(0, 0), [rx, rz] = footOffset(0, 1);
    // yaw 0 faces -z: the feet are on the x axis, left at -x
    expect(lx).toBeCloseTo(-RIPPLE.FOOT_OFFSET, 9);
    expect(rx).toBeCloseTo(RIPPLE.FOOT_OFFSET, 9);
    expect(lz).toBeCloseTo(0, 9);
    expect(rz).toBeCloseTo(0, 9);
    const shallow = footstepImpulse(0, 0, 0, 1, 1, 0.05)!, deep = footstepImpulse(0, 0, 0, 1, 1, 0.3)!, deeper = footstepImpulse(0, 0, 0, 1, 1, 0.8)!;
    expect(shallow.a).toBeCloseTo(RIPPLE.FOOT_A * 0.3, 9);
    expect(deep.a).toBeCloseTo(RIPPLE.FOOT_A, 9);
    expect(deeper.a).toBeCloseTo(RIPPLE.FOOT_A, 9);
    expect(deep.x).toBeCloseTo(RIPPLE.FOOT_OFFSET, 9);
    // perpendicular to the heading for any yaw
    const yaw = 0.7, [ox, oz] = footOffset(yaw, 1);
    expect(ox * -Math.sin(yaw) + oz * -Math.cos(yaw)).toBeCloseTo(0, 9);
  });

  it('wading wake: a zero-volume dipole per leg (bow wave ahead), proportional to speed, off when slow or shallow', () => {
    const out: Impulse[] = [];
    expect(wakeImpulses(0, 0, 0, 0.1, 0, 0.3, out)).toBe(0);
    expect(wakeImpulses(0, 0, 0, 0, -1, 0.02, out)).toBe(0);
    expect(wakeImpulses(0, 0, 0, 0, -1, 0.3, out)).toBe(4);
    expect(out.reduce((s, p) => s + p.a, 0)).toBeCloseTo(0, 12);
    const ahead = out.filter((p) => p.a > 0), behind = out.filter((p) => p.a < 0);
    for (const p of ahead) expect(p.z).toBeLessThan(0); // moving toward -z
    for (const p of behind) expect(p.z).toBeGreaterThan(0);
    const fast: Impulse[] = [];
    wakeImpulses(0, 0, 0, 0, -2, 0.3, fast);
    expect(fast[0].a / out[0].a).toBeCloseTo(2, 9);
  });

  it('idle sway fires once per period', () => {
    let n = 0;
    for (let t = 0; t < 13; t += 1 / 60) if (swayDue(t, t + 1 / 60)) n++;
    expect(n).toBe(Math.floor((13 + 1 / 60) / RIPPLE.SWAY_PERIOD));
  });
});

describe('ripple window', () => {
  it('is snapped to whole texels (world anchored): moving the eye shifts it by integer texels only', () => {
    const w: RippleWindow = { i0: 0, j0: 0, originX: 0, originZ: 0, span: 0 };
    const n = 256, dx = 0.04;
    rippleWindow(n, dx, -681.013, 216.37, w);
    const i0 = w.i0, j0 = w.j0;
    expect(w.span).toBeCloseTo(n * dx, 12);
    expect(w.originX).toBeCloseTo(i0 * dx, 9);
    expect(w.originX).toBeLessThanOrEqual(-681.013 - w.span / 2);
    expect(w.originX).toBeGreaterThan(-681.013 - w.span / 2 - dx);
    // 7.3 texels right, 2.9 texels up: the texel lattice does not move, the window moves by whole texels
    rippleWindow(n, dx, -681.013 + 7.3 * dx, 216.37 - 2.9 * dx, w);
    expect(Number.isInteger(w.i0 - i0)).toBe(true);
    expect(Math.abs(w.i0 - i0 - 7.3)).toBeLessThanOrEqual(1);
    expect(Math.abs(w.j0 - j0 + 2.9)).toBeLessThanOrEqual(1);
    // the mask's first cell covers the window corner
    const c0 = maskCell0(w.i0, dx);
    expect(c0 * CELL).toBeLessThanOrEqual(w.originX + 1e-9);
    expect((c0 + 1) * CELL).toBeGreaterThan(w.originX);
  });

  it('every preset with ripples is stable (c dt / dx <= 1 / sqrt 2) and the mask covers its window', () => {
    for (const name of QUALITY_NAMES) {
      const q = QUALITY[name];
      if (q.waterRippleRes <= 0) continue;
      expect(courant2(q.waterRippleTexel), name).toBeLessThanOrEqual(0.5);
      expect(Math.ceil((q.waterRippleRes * q.waterRippleTexel) / CELL) + 1, name).toBeLessThanOrEqual(RIPPLE.MASK_W);
    }
    for (const tau of RIPPLE.TAU) { expect(dampOf(tau)).toBeGreaterThan(0.95); expect(dampOf(tau)).toBeLessThan(1); }
  });
});

describe('ripple cell mask', () => {
  it('marks the cells on the simulated plane; other planes, SOLID, blockers and pillars are dry', () => {
    const l = poolLayout();
    l.waterCm[cellIdx(7, 7)] = 20; // another plane
    l.flags[cellIdx(2, 7)] |= CellFlag.SOLID;
    l.blockCm[cellIdx(3, 7)] = 100;
    // a 1.0 x 1.0 m pillar standing in the pool in cell (6, 3)
    l.solids.push({ kind: 'box', id: 1, min: [6 * CELL + 0.1, -1.5, 3 * CELL + 0.1], max: [6 * CELL + 1.1, 4.5, 3 * CELL + 1.1], mat: 0, flags: 0, bakeGroup: 0 });
    const W = RIPPLE.MASK_W, out = new Uint8Array(W * W * 4);
    const n = buildRippleMask(worldOf(l), 0, 0, W, -0.1, out);
    const r = (i: number, j: number): number => out[(j * W + i) * 4];
    expect(r(2, 2)).toBe(255);
    expect(r(4, 5)).toBe(255);
    expect(r(1, 2)).toBe(0); // deck
    expect(r(7, 7)).toBe(0);
    expect(r(2, 7)).toBe(0);
    expect(r(3, 7)).toBe(0);
    expect(r(6, 3)).toBe(0);
    expect(n).toBe(36 - 4);
  });

  it('wall bits N1 E2 S4 W8 of sides that occlude at the plane', () => {
    const l = poolLayout();
    for (let j = 2; j < 8; j++) { const e = exIdx(5, j); l.ex.kind[e] = EdgeKind.WALL; } // a wall through the pool on line x = 5
    const W = RIPPLE.MASK_W, out = new Uint8Array(W * W * 4);
    buildRippleMask(worldOf(l), 0, 0, W, -0.1, out);
    const g = (i: number, j: number): number => out[(j * W + i) * 4 + 1];
    expect(g(4, 4) & 2).toBe(2);
    expect(g(5, 4) & 8).toBe(8);
    expect(g(3, 4)).toBe(0);
  });
});

describe('drips', () => {
  it('timing is deterministic per source, periods in range, drops counted per interval', () => {
    const a = dripTiming(1234), b = dripTiming(1234), c = dripTiming(99);
    expect(a).toEqual(b);
    expect(a.period).not.toBe(c.period);
    for (let s = 0; s < 200; s++) {
      const { period, phase } = dripTiming(s * 7919);
      expect(period).toBeGreaterThanOrEqual(RIPPLE.DRIP_PERIOD[0]);
      expect(period).toBeLessThanOrEqual(RIPPLE.DRIP_PERIOD[1]);
      expect(phase).toBeGreaterThanOrEqual(0);
      expect(phase).toBeLessThan(period);
    }
    expect(dropsBetween(0, 10, 2, 0.5)).toBe(5);
    expect(dropsBetween(3, 3, 2, 0.5)).toBe(0); // frozen time: nothing falls
    expect(dropsBetween(1.4, 1.6, 2, 0.5)).toBe(1); // (t + 0.5) crosses 2
  });

  it('only DRIP emitters above water, nearest first', () => {
    const l = poolLayout();
    l.emitters.push({ kind: EmitterKind.DRIP, x: 3.1, y: 4.3, z: 3.1, gain: 0.3, seed: 1 });
    l.emitters.push({ kind: EmitterKind.DRIP, x: 8.0, y: 4.3, z: 8.0, gain: 0.3, seed: 2 });
    l.emitters.push({ kind: EmitterKind.DRIP, x: 0.6, y: 4.3, z: 0.6, gain: 0.3, seed: 3 }); // over the dry deck
    l.emitters.push({ kind: EmitterKind.VENT, x: 4, y: 4.3, z: 4, gain: 0.3, seed: 4 });
    const out: DripSource[] = [];
    expect(collectDrips(worldOf(l), 7.5, 7.5, 25, 8, out)).toBe(2);
    expect(out[0].seed).toBe(2);
    expect(out[1].seed).toBe(1);
    expect(out[0].y).toBeCloseTo(-0.1, 9);
  });
});

describe('nearest water plane', () => {
  it('finds the pool below the eye and ignores water behind the camera or above the eye', () => {
    const l = poolLayout();
    const w = worldOf(l);
    // on the deck at (0.6, 0.6) looking +x+z (yaw -3pi/4: forward = (sin 3pi/4, cos 3pi/4)... use explicit forward)
    const p = nearestWaterPlane(w, 0.6, 1.6, 0.6, Math.SQRT1_2, Math.SQRT1_2, 40);
    expect(p).not.toBeNull();
    expect(p!.y).toBeCloseTo(-0.1, 9);
    expect(p!.kind).toBe(0);
    // far away and facing away: nothing
    expect(nearestWaterPlane(w, 30, 1.6, 30, 1, 0, 40)).toBeNull();
    // eye below the surface: nothing
    expect(nearestWaterPlane(w, 4, -0.5, 4, 1, 0, 40)).toBeNull();
    // within 6 m only
    expect(nearestWaterPlane(w, 0.6, 1.6, 20, 0, -1, 6)).toBeNull();
  });

  it('the simulated plane: the water the player stands in, bit-stable while the feet move (else the scanned one)', () => {
    // feet on a pool floor / its steps at many heights under a -10 cm surface: y + depth must give one value, or the
    // window mask would be rebuilt every frame
    const seen = new Set<number>();
    for (let i = 0; i < 190; i++) {
      const y = -1.5 + i * 0.007123;
      seen.add(simulatedPlane(y, Math.max(0, -0.1 - y), 0.5)!);
    }
    expect([...seen]).toEqual([-0.1]);
    expect(simulatedPlane(0, 0, -0.1)).toBe(-0.1);
    expect(simulatedPlane(0, 0, null)).toBeNull();
  });
});
