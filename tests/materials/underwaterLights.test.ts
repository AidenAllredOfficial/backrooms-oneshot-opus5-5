// tests/materials/underwaterLights.test.ts — package E light in water (materials/water/underwaterLights.ts): the
// UNDERWATER lamp picker and the TS twin of the water shader's lamp integral (chunks/water.ts brWaterLamps).

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { CELL } from '../../src/core/constants.ts';
import { cellIdx } from '../../src/core/grid.ts';
import { CellFlag, DYING_MEAN, FixtureKind, LightState, Mood, Zone } from '../../src/core/ids.ts';
import { createEmptyLayout, type ChunkLayout, type Fixture } from '../../src/core/layout.ts';
import type { MaterialGlobals } from '../../src/core/runtime.ts';
import { phaseWater, WATER_MEDIA } from '../../src/materials/chunks/params.ts';
import { waterVolumeGlsl } from '../../src/materials/chunks/water.ts';
import { createUnderwaterLights, lampScatter, lampStateScale, pickUnderwaterLights, UW, type UwLamp } from '../../src/materials/water/underwaterLights.ts';

/** One chunk at (0, 0): a pool (water -10 cm, floor -2 m) over cells 2..7 x 2..7 of a 10 x 10 room. */
function poolLayout(): ChunkLayout {
  const l = createEmptyLayout({ s: 0, cx: 0, cz: 0 }, Zone.POOLROOMS, 0, Mood.NORMAL);
  l.flags.fill(CellFlag.SOLID);
  for (let j = 0; j < 10; j++) for (let i = 0; i < 10; i++) { l.flags[cellIdx(i, j)] = 0; l.ceilCm[cellIdx(i, j)] = 450; }
  for (let j = 2; j < 8; j++) for (let i = 2; i < 8; i++) { l.floorCm[cellIdx(i, j)] = -200; l.waterCm[cellIdx(i, j)] = -10; }
  l.water.push({ x0: 2 * CELL, z0: 2 * CELL, x1: 8 * CELL, z1: 8 * CELL, y: -0.1, floorY: -2, kind: 0 });
  return l;
}
const worldOf = (l: ChunkLayout) => ({ layoutAt: (cx: number, cz: number) => (cx === 0 && cz === 0 ? l : null) });

let nextId = 1;
function lamp(x: number, z: number, nx: number, nz: number, state: number = LightState.ON, over: Partial<Fixture> = {}): Fixture {
  return {
    id: nextId++, kind: FixtureKind.UNDERWATER, state: state as Fixture['state'], shape: 0, px: x, py: -1, pz: z, nx, ny: 0, nz,
    tx: 0, ty: 1, tz: 0, w: 0.26, h: 0.26, color: [0.8, 0.9, 1], luminance: 1400, seed: 1, hum: 0, bakeGroup: 0, dynamic: false, ...over,
  };
}

describe('underwater lamp picker', () => {
  it('keeps the nearest lit lamps in water in front of the camera, sorted, with their intensity in cd', () => {
    const l = poolLayout();
    const west = lamp(2 * CELL + 0.02, 4 * CELL, 1, 0); // in the pool's west wall, facing +x
    const east = lamp(8 * CELL - 0.02, 4 * CELL, -1, 0);
    const off = lamp(5 * CELL, 2 * CELL + 0.02, 0, 1, LightState.OFF);
    const dying = lamp(5 * CELL, 8 * CELL - 0.02, 0, -1, LightState.DYING);
    const dry = lamp(0.02, 0.6, 1, 0); // in a wall of the dry deck
    const other = { ...lamp(4 * CELL, 4 * CELL, 1, 0), kind: FixtureKind.TROFFER_2x2 as Fixture['kind'] };
    l.fixtures.push(west, east, off, dying, dry, other);
    const out: UwLamp[] = [];
    // eye on the west deck looking east (+x)
    const n = pickUnderwaterLights(worldOf(l), 1.0, 1.6, 4 * CELL, 1, 0, 4, out);
    expect(n).toBe(3);
    expect(out.map((x) => x.id)).toEqual([west.id, dying.id, east.id]);
    const I = 1400 * 0.26 * 0.26;
    expect(out[0].r).toBeCloseTo(I * 0.8, 6);
    expect(out[0].b).toBeCloseTo(I, 6);
    expect(out[1].g).toBeCloseTo(I * 0.9 * DYING_MEAN, 6);
    expect(out[0].nx).toBeCloseTo(1, 9);
    expect(out[0].radius).toBeCloseTo(0.13, 9);
    // the nearest N only; stable order
    expect(pickUnderwaterLights(worldOf(l), 1.0, 1.6, 4 * CELL, 1, 0, 2, out)).toBe(2);
    expect(out.map((x) => x.id)).toEqual([west.id, dying.id]);
    // facing away (-x): only the lamp within 2 m stays (the same behind-the-camera rule as the water-plane scan)
    expect(pickUnderwaterLights(worldOf(l), 1.0, 1.6, 4 * CELL, -1, 0, 4, out)).toBe(1);
    expect(out[0].id).toBe(west.id);
    expect(pickUnderwaterLights(worldOf(l), 1.0, 1.6, 4 * CELL, 1, 0, 0, out)).toBe(0);
    // a round lens (shape 1: `luminance` is the intensity, fixtureRadiance spreads it over the disc): I = luminance
    const disc = poolLayout();
    disc.fixtures.push(lamp(2 * CELL + 0.02, 4 * CELL, 1, 0, LightState.ON, { shape: 1, w: 0.3, h: 0.3, luminance: 90 }));
    expect(pickUnderwaterLights(worldOf(disc), 1.0, 1.6, 4 * CELL, 1, 0, 4, out)).toBe(1);
    expect(out[0].b).toBeCloseTo(90, 6);
  });

  it('state scale: ON / BUZZ full, DYING at its mean, OFF / flicker states none; beyond RANGE nothing', () => {
    expect(lampStateScale(LightState.ON)).toBe(1);
    expect(lampStateScale(LightState.BUZZ)).toBe(1);
    expect(lampStateScale(LightState.DYING)).toBe(DYING_MEAN);
    for (const s of [LightState.OFF, LightState.FLICKER, LightState.ANOMALY]) expect(lampStateScale(s)).toBe(0);
    const l = poolLayout();
    l.fixtures.push(lamp(2 * CELL + 0.02, 4 * CELL, 1, 0));
    const out: UwLamp[] = [];
    expect(pickUnderwaterLights(worldOf(l), 2 * CELL - UW.RANGE - 1, 1.6, 4 * CELL, 1, 0, 4, out)).toBe(0);
  });

  it('writes camera-relative globals every frame and re-picks every SCAN_FRAMES frames', () => {
    const l = poolLayout();
    l.fixtures.push(lamp(2 * CELL + 0.02, 4 * CELL, 1, 0));
    const v4 = (): THREE.Vector4[] => Array.from({ length: 4 }, () => new THREE.Vector4());
    const g = { uwPos: { value: v4() }, uwDir: { value: v4() }, uwCol: { value: v4() }, nUw: { value: 0 } } as unknown as MaterialGlobals;
    const uw = createUnderwaterLights(g);
    uw.update(worldOf(l), 1, 1.6, 4 * CELL, -Math.PI / 2);
    expect(g.nUw.value).toBe(0); // max 0 (no refraction): off
    uw.setMax(2);
    uw.update(worldOf(l), 1, 1.6, 4 * CELL, -Math.PI / 2); // yaw -pi/2 faces +x
    expect(g.nUw.value).toBe(1);
    expect(g.uwPos.value[0].x).toBeCloseTo(2 * CELL + 0.02 - 1, 9);
    expect(g.uwPos.value[0].y).toBeCloseTo(-1 - 1.6, 9);
    uw.update(worldOf(l), 1.5, 1.6, 4 * CELL, -Math.PI / 2); // moved: the offset follows the eye at once
    expect(g.uwPos.value[0].x).toBeCloseTo(2 * CELL + 0.02 - 1.5, 9);
    expect(g.uwDir.value[0].w).toBeCloseTo(0.13, 9);
    uw.setMax(0);
    expect(g.nUw.value).toBe(0);
  });
});

describe('in-water lamp integral (brWaterLamps twin)', () => {
  it('the 6-sample tan substitution matches a 20000-step brute-force integral within 4 % (12 samples: 1 %)', () => {
    const kind = 0;
    const ss = WATER_MEDIA.SS[kind];
    const phase = (mu: number): number => phaseWater(mu, kind);
    // view segments into the water past a lamp facing +x at the origin
    const cases: [number[], number[], number, number][] = [
      [[0.4, 0.3, -1.2], [0, -0.6, 0.8], 2.5, 0.2], // passes in front of the lamp
      [[1.5, 0.8, 0.5], [-0.3, -0.9, -0.3], 2.0, 0.06], // steep, from the side, murkier
      [[0.8, 1.0, 0.0], [0.2, -0.98, 0], 1.2, 0.5],
    ];
    for (const [P0, T0, L, st] of cases) {
      const tl = Math.hypot(T0[0], T0[1], T0[2]);
      const T = T0.map((x) => x / tl);
      const n = [1, 0, 0], Q = [0, 0, 0];
      const I0 = 95;
      const fast = lampScatter(P0, T, L, Q, n, I0, ss, st, phase, 6, 0.01);
      let ref = 0;
      const N = 20000;
      for (let i = 0; i < N; i++) {
        const s = ((i + 0.5) / N) * L;
        const w = [P0[0] + T[0] * s, P0[1] + T[1] * s, P0[2] + T[2] * s];
        const r = Math.hypot(w[0], w[1], w[2]);
        const lam = Math.max(w[0] / r, 0);
        ref += (ss * I0 * lam * phase(-(w[0] * T[0] + w[1] * T[1] + w[2] * T[2]) / r) * Math.exp(-st * (r + s)) / (r * r)) * (L / N);
      }
      expect(ref).toBeGreaterThan(0);
      expect(Math.abs(fast - ref) / ref).toBeLessThan(0.04);
      expect(Math.abs(lampScatter(P0, T, L, Q, n, I0, ss, st, phase, 12, 0.01) - ref) / ref).toBeLessThan(0.01);
    }
  });

  it('the GLSL loops over BR_WATER_VOLLIGHT lamps with the lamp radius as the closest-approach floor', () => {
    const g = waterVolumeGlsl();
    expect(g).toContain('for ( int i = 0; i < BR_WATER_VOLLIGHT; i ++ )');
    expect(g).toContain('max( length( Q - P - Tv * tc ), uUwDir[ i ].w )');
    expect(g).toContain('brPhaseW( dot( wn, - Tv ), kind )');
  });
});
