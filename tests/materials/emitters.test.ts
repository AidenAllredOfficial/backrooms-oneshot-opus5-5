// tests/materials/emitters.test.ts — graphics-realism C.2/C.3 shader wiring: EMITTER_GLSL carries the TS twin's
// constants and EP_NORM table, compiles only under BR_DETAIL == 1, and FRAG_EMISSIVE_GLSL routes profiled emitters
// through brEmitterShape (legacy otherwise) and shades OFF recessed lenses only on shell PANEL_LENS faces.

import { describe, expect, it } from 'vitest';
import { EP, EP_NORM, LAMP, PRISM } from '../../src/core/emitterProfile.ts';
import { EMITTER_GLSL } from '../../src/materials/chunks/emitters.ts';
import { glslConstants } from '../../src/materials/chunks/params.ts';
import { FRAG_EMISSIVE_GLSL } from '../../src/materials/chunks/surface.ts';

describe('EMITTER_GLSL', () => {
  it('is compiled only at medium and above (BR_DETAIL == 1)', () => {
    const body = EMITTER_GLSL.trim().split('\n');
    expect(body.find((l) => l.startsWith('#'))).toBe('#if BR_DETAIL == 1');
    expect(body[body.length - 1]).toBe('#endif');
  });

  it('carries the EP_NORM table and the TS constants', () => {
    const m = /const float BR_EP_NORM\[ (\d+) \] = float\[ \d+ \]\(([^;]*)\);/.exec(EMITTER_GLSL);
    expect(m).not.toBeNull();
    const vals = (m?.[2] ?? '').split(',').map((s) => Number(s.trim()));
    expect(Number(m?.[1])).toBe(EP_NORM.length);
    expect(vals).toEqual([...EP_NORM]);
    expect(EMITTER_GLSL).toContain(`#define BR_EP_PRISM ${EP.PRISM}`);
    expect(EMITTER_GLSL).toContain(`#define BR_EP_SODIUM ${EP.SODIUM}`);
    expect(EMITTER_GLSL).toMatch(new RegExp(`#define BR_PR_D ${PRISM.D}\\b`));
    expect(EMITTER_GLSL).toMatch(new RegExp(`#define BR_LP_DEAD_P ${LAMP.DEAD_P}\\b`));
  });

  it('every BR_ identifier it uses is defined (here, in the params block or the common helpers)', () => {
    const defined = new Set<string>();
    for (const src of [EMITTER_GLSL, glslConstants()]) {
      for (const m of src.matchAll(/#define (BR_\w+)/g)) defined.add(m[1]);
      for (const m of src.matchAll(/const \w+ (BR_\w+)/g)) defined.add(m[1]);
    }
    const used = new Set<string>();
    for (const m of EMITTER_GLSL.matchAll(/\b(BR_[A-Z0-9_]+)\b/g)) used.add(m[1]);
    for (const u of used) {
      if (u === 'BR_DETAIL') continue; // SURFACE_PARS_GLSL (lite switch)
      expect(defined.has(u), u).toBe(true);
    }
  });

  it('declares every function FRAG_EMISSIVE calls', () => {
    for (const fn of ['brEmitterShape', 'brOffLensShade']) {
      expect(EMITTER_GLSL).toMatch(new RegExp(`\\b(vec3|float) ${fn}\\(`));
      expect(FRAG_EMISSIVE_GLSL).toContain(`${fn}(`);
    }
  });
});

describe('FRAG_EMISSIVE_GLSL', () => {
  const lines = FRAG_EMISSIVE_GLSL.split('\n');
  /** Innermost #if condition active at the first line containing `needle`. */
  const condAt = (needle: string): string[] => {
    const stack: string[] = [];
    for (const l of lines) {
      const t = l.trim();
      if (t.startsWith('#if')) stack.push(t);
      else if (t.startsWith('#else')) stack.push(`!${stack.pop() ?? ''}`);
      else if (t.startsWith('#endif')) stack.pop();
      if (l.includes(needle)) return [...stack];
    }
    return ['<missing>'];
  };

  it('calls brEmitterShape under BR_DETAIL == 1 and keeps the legacy formula for every other case', () => {
    expect(condAt('brEmitterShape(')).toContain('#if BR_DETAIL == 1');
    expect(condAt('brOrmh.a * 1.3')).not.toContain('#if BR_DETAIL == 1');
    // the profile is decoded only off FLOOR_AUX faces (their aux.z is a region key)
    expect(FRAG_EMISSIVE_GLSL).toMatch(/int brEp = \( brF & BR_F_FLOOR_AUX \) == 0 \? \( int\( brAuxB\.z \+ 0\.5 \) >> 1 \) & 15 : 0;/);
  });

  it('shades OFF lenses only on shell PANEL_LENS faces with a profile', () => {
    const l = lines.findIndex((s) => s.includes('brOffLensShade('));
    const cond = lines.slice(l - 1, l + 1).join(' ');
    expect(cond).toContain('brL == BR_M_PANEL_LENS');
    expect(cond).toContain('( brF & BR_F_PROP_AUX ) == 0');
    expect(cond).toContain('brEp != 0');
    expect(condAt('brOffLensShade(')).toContain('#if BR_DETAIL == 1');
  });

  it('takes its derivatives in uniform control flow (before the emissive branch)', () => {
    const d = lines.findIndex((s) => s.includes('dFdx('));
    const b = lines.findIndex((s) => s.includes('if ( vBrEmit > 0.0 )'));
    expect(d).toBeGreaterThanOrEqual(0);
    expect(d).toBeLessThan(b);
    expect(lines.slice(b).some((s) => /dFd[xy]\(|fwidth\(/.test(s))).toBe(false);
  });

  it('ends with the closing brace, followed only by the two lines package E appends', () => {
    const tail = FRAG_EMISSIVE_GLSL.trimEnd().split('\n');
    const e = tail.findIndex((s) => s.startsWith('vec4 brSubInfo = brWaterSubInfo('));
    expect(e).toBe(tail.length - 2);
    expect(tail[e + 1]).toMatch(/^#define getSpotLightInfo\( l, p, d \) brSpotInfoW\(/);
    expect(tail.slice(0, e).join('\n').trimEnd().endsWith('}')).toBe(true);
  });
});
