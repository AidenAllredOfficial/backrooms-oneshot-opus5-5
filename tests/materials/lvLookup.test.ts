// tests/materials/lvLookup.test.ts — the props' front-side light-volume lookup (chunks/lighting.ts lvLookup, the TS
// twin of the BR_LV block): an up-facing surface never blends in volume samples below its own plane (the samples
// under a lounge chair's frame are in its shadow and lit from below; blended into the seat top they drew a dark
// blotch), and every lookup moves out of the surface horizontally without crossing a wall of its own cell.

import { describe, expect, it } from 'vitest';
import { CELL, LV } from '../../src/core/constants.ts';
import { FRAG_LIGHTS_GLSL, lvLevel, lvLookup } from '../../src/materials/chunks/lighting.ts';
import { HELPERS_GLSL } from '../../src/materials/chunks/common.ts';
import { TUNE } from '../../src/materials/chunks/params.ts';

const Y = LV.Y;
const UP = [0, 1, 0] as const, DOWN = [0, -1, 0] as const;
/** The two LV levels a trilinear lookup at fractional level k blends, with their weights. */
const corners = (k: number): [number, number, number, number] => {
  const i = Math.min(LV.NY - 2, Math.floor(k)), t = k - i;
  return [i, 1 - t, i + 1, t];
};

describe('lvLevel', () => {
  it('maps the LV.Y heights to their indices and interpolates linearly between them', () => {
    for (let i = 0; i < LV.NY; i++) expect(lvLevel(Y[i])).toBeCloseTo(i, 12);
    expect(lvLevel((Y[1] + Y[2]) / 2)).toBeCloseTo(1.5, 12);
    expect(lvLevel(-1)).toBe(0);
    expect(lvLevel(99)).toBe(LV.NY - 1);
  });
});

describe('lvLookup: front-side light-volume lookup', () => {
  it('an up-facing surface blends no level below it (within the volume)', () => {
    for (let y = 0; y <= Y[LV.NY - 2]; y += 0.01) {
      const [i0, w0, i1, w1] = corners(lvLookup([6, y, 6], UP, 0)[1]);
      if (w0 > 1e-9) expect(Y[i0]).toBeGreaterThanOrEqual(y - 1e-9);
      if (w1 > 1e-9) expect(Y[i1]).toBeGreaterThanOrEqual(y - 1e-9);
    }
  });

  it('a down-facing surface keeps the levels around its own height (the samples under it lie behind its prop)', () => {
    for (let y = 0; y <= 5.2; y += 0.05) {
      for (const n of [DOWN, [0.6, -0.8, 0] as const, [0, -0.5, -0.866] as const]) expect(lvLookup([6, y, 6], n, 0)[1]).toBeCloseTo(lvLevel(y), 12);
    }
  });

  it('a lounge chair seat reads the levels above its frame', () => {
    // LOUNGE_CHAIR frame occluder: y 0.3 .. 0.36 (core/props.ts); LV levels 0.2 (under it), 0.8, 1.5
    const top = corners(lvLookup([6, 0.37, 6], UP, 0)[1]);
    expect(top[0]).toBeGreaterThanOrEqual(1);
    // the reclined backrest's front near the crease (n.y 0.5) gives the level under the frame little weight
    const back = corners(lvLookup([6, 0.42, 6], [0.866, 0.5, 0], 0)[1]);
    expect(back[0] === 0 ? back[1] : 0).toBeLessThan(0.15);
    // an office chair seat (0.5) and a desk top (0.75) likewise never blend the 0.2 level under them
    for (const y of [0.5, 0.75]) expect(corners(lvLookup([6, y, 6], UP, 0)[1])[0]).toBeGreaterThanOrEqual(1);
  });

  it('is continuous in height for a fixed normal (no seams on curved or sloped parts)', () => {
    const n = [0.6, 0.64, 0.48] as const;
    let prev = lvLookup([6, 0, 6], n, 0)[1];
    for (let y = 0.005; y < 5.5; y += 0.005) {
      const k = lvLookup([6, y, 6], n, 0)[1];
      expect(Math.abs(k - prev)).toBeLessThan(0.02);
      prev = k;
    }
  });

  it('vertical faces keep the plain level and move half an LV step out along the normal', () => {
    const [x, k, z] = lvLookup([6.1, 1.1, 6.2], [1, 0, 0], 0);
    expect(k).toBeCloseTo(lvLevel(1.1), 12);
    expect(x).toBeCloseTo(6.1 + TUNE.LV_BIAS_XZ, 12);
    expect(z).toBeCloseTo(6.2, 12);
    expect(TUNE.LV_BIAS_XZ).toBeCloseTo(LV.STEP / 2, 12);
  });

  it('never moves the lookup through an occluding side of the fragment\'s own cell', () => {
    const x0 = 5 * CELL, z0 = 5 * CELL;
    // a back panel 0.1 m in front of a west wall, facing it: held 0.3 m inside the cell
    expect(lvLookup([x0 + 0.1, 1, z0 + 0.6], [-1, 0, 0], 8)[0]).toBeCloseTo(x0 + 0.3, 12);
    // the same face with an open west side reads beyond the cell line
    expect(lvLookup([x0 + 0.1, 1, z0 + 0.6], [-1, 0, 0], 0)[0]).toBeCloseTo(x0 - 0.2, 12);
    // north wall (bit 1), face turned toward it
    expect(lvLookup([x0 + 0.6, 1, z0 + 0.05], [0, 0, -1], 1)[2]).toBeCloseTo(z0 + 0.3, 12);
  });
});

describe('GLSL: BR_LV block', () => {
  it('clamps with the fragment\'s own cell, offsets along the geometric normal and shifts the level', () => {
    expect(FRAG_LIGHTS_GLSL).toContain('ivec2 cell = ivec2( floor( brLvP.xz / BR_CELL ) )');
    expect(FRAG_LIGHTS_GLSL).toContain('vec2 brLvQ = brLvP.xz + brNWg.xz * BR_LV_BIAS_XZ');
    expect(FRAG_LIGHTS_GLSL).toContain('brLvV( brLvP.y, max( brNWg.y, 0.0 ) * BR_LV_BIAS_K )');
    expect(HELPERS_GLSL).toContain('float brLvV( float y, float dk )');
    expect(HELPERS_GLSL).toContain('clamp( k + dk, 0.0, BR_LV_NY - 1.0 )');
  });
});
