// tests/materials/brdf.test.ts — texture realism v2 (0b) shading maths: the EON rough diffuse (chunks/brdf.ts TS twin,
// white furnace, the published single-scattering ratios, the RE_Direct override text).

import { describe, expect, it } from 'vitest';
import { ShaderChunk, ShaderLib } from 'three';
import {
  brdfParsGlsl, brDirectSource, EON_C1, EON_C2, EON_G, eonAlbedo, eonBrdf, eonSingleRatio, fonAlbedo, fonAlbedoExact,
  physicalDirectSource,
} from '../../src/materials/chunks/brdf.ts';
import { f } from '../../src/materials/chunks/params.ts';
import { buildSurfaceFragment } from '../../src/materials/SurfaceMaterial.ts';

describe('EON rough diffuse (chunks/brdf.ts)', () => {
  it('white furnace: the directional albedo is rho within 3 % for sigma 0.2 / 0.5 / 0.9 and mu in [0.1, 1]', () => {
    for (const s of [0.2, 0.5, 0.9]) {
      for (const mu of [0.1, 0.25, 0.4, 0.55, 0.7, 0.85, 1]) {
        for (const rho of [1, 0.3]) {
          const a = eonAlbedo(rho, s, mu, 96, 48);
          if (!(Math.abs(a / rho - 1) <= 0.03)) expect(a / rho, `sigma ${s} mu ${mu} rho ${rho}`).toBeCloseTo(1, 1);
        }
      }
    }
  });

  it('sigma 0: exact Lambert (rho / pi) at every angle', () => {
    for (const [mi, mo, c] of [[1, 1, 1], [0.5, 0.8, 0.2], [0.2, 0.9, -0.3], [0.7, 0.3, 0.9]]) {
      expect(eonBrdf(0.4, 0, mi, mo, c)).toBeCloseTo(0.4 / Math.PI, 5);
    }
  });

  it('single scattering at sigma 0.45: 0.885 at L = V = N, 1.48 at L = V 60 degrees off the normal', () => {
    expect(eonSingleRatio(0.45, 1, 1, 1)).toBeCloseTo(0.885, 3);
    expect(eonSingleRatio(0.45, 0.5, 0.5, 1)).toBeCloseTo(1.483, 3);
    // retroreflection grows toward grazing (the torch's oblique ring lifts); forward scattering stays below Lambert
    expect(eonBrdf(1, 0.45, 0.3, 0.3, 1)).toBeGreaterThan(eonBrdf(1, 0.45, 0.6, 0.6, 1));
    const fwd = 2 * 0.3 * 0.3 - 1; // L and V mirrored about the normal at mu 0.3: cos = 2 mu^2 - 1
    expect(eonBrdf(1, 0.45, 0.3, 0.3, fwd)).toBeLessThan(1 / Math.PI);
  });

  it('the FON albedo fit is within 0.1 % of the closed form', () => {
    for (const s of [0.1, 0.45, 0.9]) {
      for (let mu = 0.02; mu <= 1; mu += 0.02) {
        const e = Math.abs(fonAlbedo(mu, s) - fonAlbedoExact(mu, s));
        if (!(e < 1e-3)) expect(e, `sigma ${s} mu ${mu}`).toBeLessThan(1e-3);
      }
    }
  });

  it('the GLSL uses the TS constants', () => {
    const g = brdfParsGlsl();
    expect(g).toContain(`#define BR_EON_C1 ${f(EON_C1)}`);
    expect(g).toContain(`#define BR_EON_C2 ${f(EON_C2)}`);
    for (const c of EON_G) expect(g).toContain(f(c));
    expect(g).toContain('float brDiffSigma = 0.0;');
  });

  it('brRE_Direct is three\'s RE_Direct_Physical plus one EON line after the verbatim Lambert line', () => {
    const three = physicalDirectSource();
    const ours = brDirectSource();
    const extra = ours.split('\n').filter((l) => l.includes('brDiffSigma'));
    expect(extra).toHaveLength(1);
    expect(extra[0]).toMatch(/^\tif \( brDiffSigma > 0\.0 \) reflectedLight\.directDiffuse \+= irradiance \* \( brEon\(/);
    expect(ours.split('\n').filter((l) => !l.includes('brDiffSigma')).join('\n'))
      .toBe(three.replace('void RE_Direct_Physical(', 'void brRE_Direct('));
    // a changed Lambert line (three upgrade) fails loudly instead of silently dropping EON
    expect(() => brDirectSource(ShaderChunk.lights_physical_pars_fragment.replace('BRDF_Lambert( material.diffuseContribution ) * ( 1.0 - F )', 'X'))).toThrow();
  });

  it('the surface program defines the override after three\'s physical lighting and before main; every RE_Direct call uses it', () => {
    const frag = buildSurfaceFragment(ShaderLib.physical.fragmentShader);
    const at = (s: string): number => { const i = frag.indexOf(s); expect(i, s).toBeGreaterThanOrEqual(0); return i; };
    expect(at('#include <lights_physical_pars_fragment>')).toBeLessThan(at('void brRE_Direct('));
    expect(at('#define RE_Direct brRE_Direct')).toBeLessThan(at('void main()'));
    // the EON roughness is set in material post (before lights_fragment_begin: the flashlight), from the layer's sigma
    expect(at('brDiffSigma = min( 1.0, sqrt( brSg * brSg + 0.5 * brSv ) );')).toBeLessThan(at('#include <lights_fragment_begin>'));
    expect(at('#include <lights_fragment_begin>')).toBeLessThan(at('RE_Direct( brDL,'));
  });
});
