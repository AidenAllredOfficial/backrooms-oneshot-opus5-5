// tests/materials/lvLookup.test.ts — the props' light-volume lookup (chunks/lighting.ts lvLevels / lvLevel /
// lvUpLight / lvGatePoint / lvBackGate / lvLookup, the TS twins of brLvK, brLvUp and the BR_LV block): an up-facing
// surface never blends in volume samples lying more than TUNE.LV_BACK_D behind its plane where they hold the prop's own
// shadow (the samples under a lounge chair's frame are lit from below; blended into the seat top they drew a dark
// blotch), it reads the first level above it, not a higher one, and the gate (read behind the surface) keeps plain
// weights for a normal vertical gradient, a corner in front of the surface and a level below that is the brighter (a
// rack deck's load).

import { describe, expect, it } from 'vitest';
import { CELL, LV } from '../../src/core/constants.ts';
import { FRAG_LIGHTS_GLSL, lvBackGate, lvGatePoint, lvLevel, lvLevels, lvLookup, lvUpLight } from '../../src/materials/chunks/lighting.ts';
import { HELPERS_GLSL } from '../../src/materials/chunks/common.ts';
import { TUNE } from '../../src/materials/chunks/params.ts';

const Y = LV.Y;
const D = TUNE.LV_BACK_D;
const UP = [0, 1, 0] as const, DOWN = [0, -1, 0] as const;
/** The two LV levels a trilinear lookup at fractional level k blends, with their weights. */
const corners = (k: number): [number, number, number, number] => {
  const i = Math.min(LV.NY - 2, Math.floor(k)), t = k - i;
  return [i, 1 - t, i + 1, t];
};

describe('lvLevel', () => {
  it('maps the LV.Y heights to their indices and interpolates linearly between them (ny = 0)', () => {
    for (let i = 0; i < LV.NY; i++) expect(lvLevel(Y[i])).toBeCloseTo(i, 12);
    expect(lvLevel((Y[1] + Y[2]) / 2)).toBeCloseTo(1.5, 12);
    expect(lvLevel(-1)).toBe(0);
    expect(lvLevel(99)).toBe(LV.NY - 1);
  });

  it('an up-facing surface reads each level exactly at its height (whatever the normal)', () => {
    for (let i = 0; i < LV.NY; i++) for (const ny of [0.3, 0.7, 1]) expect(lvLevel(Y[i], ny)).toBeCloseTo(i, 9);
  });
});

describe('lvLookup: up-facing surfaces drop the level behind them', () => {
  it('an up-facing surface blends no level lying more than LV_BACK_D below it', () => {
    for (let y = 0; y <= Y[LV.NY - 1]; y += 0.01) {
      const [i0, w0, i1, w1] = corners(lvLookup([6, y, 6], UP, 0)[1]);
      if (w0 > 1e-9) expect(Y[i0]).toBeGreaterThan(y - D - 1e-9);
      if (w1 > 1e-9) expect(Y[i1]).toBeGreaterThan(y - D - 1e-9);
    }
  });

  it('and reads nothing above the first level at or above it (no upward bias beyond one level)', () => {
    for (let y = Y[0]; y < Y[LV.NY - 1]; y += 0.01) {
      const k = lvLookup([6, y, 6], UP, 0)[1];
      const above = Y.findIndex((v) => v >= y - 1e-9);
      expect(k).toBeLessThanOrEqual(above + 1e-9);
      expect(k).toBeGreaterThanOrEqual(lvLevel(y) - 1e-9); // never below the plain lookup
    }
  });

  it('a down-facing surface keeps the levels around its own height (the samples under it lie behind its prop)', () => {
    for (let y = 0; y <= 5.2; y += 0.05) {
      for (const n of [DOWN, [0.6, -0.8, 0] as const, [0, -0.5, -0.866] as const, [1, 0, 0] as const]) {
        expect(lvLookup([6, y, 6], n, 0)[1]).toBeCloseTo(lvLevel(y), 12);
      }
    }
  });

  it('a lounge chair seat reads the level above its frame; a desk top the level just above it', () => {
    // LOUNGE_CHAIR frame occluder: y 0.3 .. 0.36 (core/props.ts); seat top 0.36 .. 0.40; LV levels 0.2 (under it), 0.8
    for (const y of [0.36, 0.38, 0.4]) expect(lvLookup([6, y, 6], UP, 0)[1]).toBeCloseTo(1, 6);
    // the reclined backrest's front near the crease (n.y 0.5) gives the level under the frame little weight
    const back = corners(lvLookup([6, 0.42, 6], [0.866, 0.5, 0], 0)[1]);
    expect(back[0] === 0 ? back[1] : 0).toBeLessThan(0.1);
    // an office chair seat (0.5) and a desk top (0.75) read the 0.8 m level, not the 1.5 m one
    for (const y of [0.5, 0.75]) expect(lvLookup([6, y, 6], UP, 0)[1]).toBeCloseTo(1, 6);
    // just above a level (within LV_BACK_D) the level at the surface keeps most of its weight
    expect(lvLookup([6, Y[1] + 0.02, 6], UP, 0)[1]).toBeLessThan(1.05);
  });

  it('is continuous in height for a fixed normal (no seams on curved or sloped parts)', () => {
    for (const n of [[0.6, 0.64, 0.48], [0, 1, 0], [0.3, 0.954, 0]] as const) {
      let prev = lvLookup([6, 0, 6], n, 0)[1];
      for (let y = 0.0005; y < 5.5; y += 0.0005) {
        const k = lvLookup([6, y, 6], n, 0)[1];
        expect(Math.abs(k - prev)).toBeLessThan(0.03);
        prev = k;
      }
    }
  });

  it('vertical faces keep the plain level and the fragment\'s own (wall-clamped) point', () => {
    const [x, k, z] = lvLookup([6.1, 1.1, 6.2], [1, 0, 0], 0);
    expect(k).toBeCloseTo(lvLevel(1.1), 12);
    expect(x).toBe(6.1);
    expect(z).toBe(6.2);
    const x0 = 5 * CELL, z0 = 5 * CELL;
    // 0.1 m from a west wall (bit 8) / a north wall (bit 1): held 0.3 m inside the cell, whatever the normal
    expect(lvLookup([x0 + 0.1, 1, z0 + 0.6], [-1, 0, 0], 8)[0]).toBeCloseTo(x0 + 0.3, 12);
    expect(lvLookup([x0 + 0.6, 1, z0 + 0.05], [0, 1, 0], 1)[2]).toBeCloseTo(z0 + 0.3, 12);
    expect(lvLookup([x0 + 0.1, 1, z0 + 0.6], [-1, 0, 0], 0)[0]).toBeCloseTo(x0 + 0.1, 12);
  });
});

describe('the gate: the drop only removes a darker level', () => {
  it('lvUpLight: an up-facing receiver takes the ambient part and the directional part above the horizon', () => {
    expect(lvUpLight(100, [0, 1, 0], 0.8)).toBeCloseTo(100, 12);
    expect(lvUpLight(100, [0, -1, 0], 0.8)).toBeCloseTo(20, 12); // lit from below: only (1 - w) E
    expect(lvUpLight(100, [0.98, 0.1, 0], 1)).toBeCloseTo(100 * 0.1 / Math.hypot(0.98, 0.1) / TUNE.NG_MIN, 9);
    expect(lvUpLight(100, [0, 0, 0], 0.5)).toBeCloseTo(100, 12); // degenerate direction
  });

  it('lvBackGate on a slope: 0 for a normal vertical gradient, 1 once the level below holds the prop\'s own shadow', () => {
    const lo = TUNE.LV_GATE_LO, hi = TUNE.LV_GATE_HI, ny = 0.55; // a windshield, a reclined backrest
    expect(lvBackGate(100, 100, ny)).toBe(0);
    expect(lvBackGate(100, 20, ny)).toBe(0);
    expect(lvBackGate(100, 100 * lo, ny)).toBe(0); // a room's own gradient (E(0.8) / E(0.2) p50 1.3, p75 1.8)
    expect(lvBackGate(126, 184, ny)).toBe(0); // behind a car's windshield base: inside the cabin (1.46x)
    expect(lvBackGate(100, 100 * hi, ny)).toBe(1);
    expect(lvBackGate(0, 50, ny)).toBe(1);
    expect(lvBackGate(3, 300, ny)).toBe(1); // under a lounge chair's frame (high/ultra near-field bake)
    const g = lvBackGate(100, 100 * (lo + hi) / 2, ny);
    expect(g).toBeGreaterThan(0.4);
    expect(g).toBeLessThan(0.6);
  });

  it('lvBackGate on a flat top: drops once the level above is the brighter, keeps a brighter level below', () => {
    expect(lvBackGate(100, 100)).toBe(0);
    expect(lvBackGate(100, 20)).toBe(0); // rack deck: the level above lies under the next deck
    expect(lvBackGate(100, 100 * TUNE.LV_GATE_FLAT_HI)).toBe(1);
    expect(lvBackGate(200, 330)).toBe(1); // a seat over the edge of its frame's shadow: no soft shadow left
    // continuous in n.y between the slope and the flat ranges
    let prev = lvBackGate(100, 160, 0.5);
    for (let ny = 0.5; ny <= 1; ny += 0.001) {
      const v = lvBackGate(100, 160, ny);
      expect(Math.abs(v - prev)).toBeLessThan(0.02);
      prev = v;
    }
  });

  it('lvGatePoint: LV_GATE_OFF behind the surface in xz, wall-clamped like the lookup; a flat top gates at its own point', () => {
    const d = TUNE.LV_GATE_OFF;
    expect(lvGatePoint([6.1, 0.4, 6.2], UP, 0)).toEqual([6.1, 6.2]);
    const n = [0, 0.6, -0.8] as const; // a windshield facing -z: its gate point lies +z, inside the cabin
    const [gx, gz] = lvGatePoint([6.1, 0.9, 6.2], n, 0);
    expect(gx).toBeCloseTo(6.1, 12);
    expect(gz).toBeCloseTo(6.2 + 0.8 * d, 12);
    // a south wall (bit 4) of the cell at z 6.0 .. 7.2 holds the point 0.3 m inside it
    expect(lvGatePoint([6.1, 0.9, 6.8], n, 4)[1]).toBeCloseTo(7.2 - 0.3, 12);
    expect(lvLookup([6.1, 0.9, 6.8], n, 4)[2]).toBeCloseTo(6.8, 12); // (the lookup itself stays at the fragment)
  });

  it('a gated surface lies between the plain and the up-facing level (continuous in the gate)', () => {
    for (let y = 0; y <= 5.2; y += 0.013) {
      const [k0, k1] = lvLevels(y, 1);
      expect(lvLevel(y, 1, 0)).toBeCloseTo(k0, 12);
      expect(lvLevel(y, 1, 1)).toBeCloseTo(k1, 12);
      const k = lvLevel(y, 1, 0.3);
      expect(k).toBeGreaterThanOrEqual(k0 - 1e-12);
      expect(k).toBeLessThanOrEqual(k1 + 1e-12);
      expect(lvLookup([6, y, 6], UP, 0, 0.3)[1]).toBeCloseTo(k, 12);
    }
  });
});

describe('GLSL: BR_LV block', () => {
  it('clamps the fragment\'s own point inside its cell and drops the level behind up-facing surfaces, gated', () => {
    expect(FRAG_LIGHTS_GLSL).toContain('vec2 brLvG = brLvP.xz - brNWg.xz * BR_LV_GATE_OFF;');
    expect(FRAG_LIGHTS_GLSL).toContain('if ( ( m & 1 ) != 0 ) { brLvP.z = max( brLvP.z, lo.y ); brLvG.y = max( brLvG.y, lo.y ); } // N (-z)');
    expect(FRAG_LIGHTS_GLSL).toContain('vec3 brLv0 = vec3( brLvG.x / BR_TILE, ( brLvI + 0.5 ) / BR_LV_NY, brLvG.y / BR_TILE );');
    expect(FRAG_LIGHTS_GLSL).toContain('ivec2 cell = ivec2( floor( brLvP.xz / BR_CELL ) )');
    expect(FRAG_LIGHTS_GLSL).toContain('vec2 brLvKs = brLvK( brLvP.y, max( brNWg.y, 0.0 ) );');
    expect(FRAG_LIGHTS_GLSL).toContain('float brLvF = smoothstep( BR_LV_GATE_NY0, BR_LV_GATE_NY1, brNWg.y );');
    expect(FRAG_LIGHTS_GLSL).toContain('vec2 brLvR = mix( vec2( BR_LV_GATE_LO, BR_LV_GATE_HI ), vec2( 1.0, BR_LV_GATE_FLAT_HI ), brLvF );');
    expect(FRAG_LIGHTS_GLSL).toContain('brLvKf = mix( brLvKs.x, brLvKs.y, smoothstep( brLvR.x, brLvR.y, brLvE1 / max( brLvE0, 1e-6 ) ) );');
    expect(FRAG_LIGHTS_GLSL).toContain('vec3 brUvw = vec3( brLvP.x / BR_TILE, ( brLvKf + 0.5 ) / BR_LV_NY, brLvP.z / BR_TILE );');
    expect(HELPERS_GLSL).toContain('vec2 brLvK( float y, float ny )');
    expect(HELPERS_GLSL).toContain('float b = 1.0 - smoothstep( 0.0, BR_LV_BACK_D, h * ny );');
    expect(HELPERS_GLSL).toContain('return vec2( k + t, min( k + t / max( t + ( 1.0 - t ) * b, 1e-4 ), BR_LV_NY - 1.0 ) );');
    expect(HELPERS_GLSL).toContain('float up = l > 1e-3 ? clamp( d.y / ( l * BR_NG_MIN ), 0.0, 1.0 ) : 1.0;');
  });
});
