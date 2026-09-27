// tests/lighting/flashlightOptics.test.ts (package F) — the flashlight's beam profile: normalisation, cut-off, spill
// plateau, flux, and the GLSL twin carrying every constant.

import { describe, expect, it } from 'vitest';
import {
  BEAM_NORM, beamCentroid, beamFluxLm, beamIntensity, beamProfile, beamProfileGlsl, beamProfileSoft, beamProfileSoftCos,
  beamSoftGlsl, FLASHLIGHT_OPTICS, phosphorWeight, spotAttenuation,
} from '../../src/lighting/flashlightOptics.ts';
import { f } from '../../src/materials/chunks/params.ts';
import { COOKIE_GLSL, COOKIE_SIZE } from '../../src/textures/cookie.ts';

const O = FLASHLIGHT_OPTICS;
const deg = (d: number): number => (d * Math.PI) / 180;

describe('flashlight optics', () => {
  it('I(0) = 1, zero at and beyond the cone, falling from the core to the spill', () => {
    expect(beamProfile(0)).toBeCloseTo(1, 12);
    expect(beamProfile(O.CONE)).toBe(0);
    expect(beamProfile(O.CONE + 0.1)).toBe(0);
    expect(beamProfile(deg(O.RIM.out))).toBe(0);
    expect(beamProfile(deg(2))).toBeGreaterThan(beamProfile(deg(6)));
    expect(beamProfile(deg(6))).toBeGreaterThan(beamProfile(deg(15)));
    expect(beamProfile(deg(15))).toBeGreaterThan(beamProfile(deg(25)));
    for (let t = 0; t < 36; t += 0.25) expect(beamProfile(deg(t))).toBeGreaterThanOrEqual(0);
  });

  it('has a flat spill plateau at 6-12 % of the peak and a hotspot at least 8x brighter', () => {
    const s = beamProfile(deg(25));
    expect(s).toBeGreaterThanOrEqual(0.06);
    expect(s).toBeLessThanOrEqual(0.12);
    expect(beamProfile(0) / s).toBeGreaterThanOrEqual(8);
    // plateau: 22..31 deg within +-25 % of the 25 deg value (the ripple and droop only)
    for (let t = 22; t <= 31; t++) expect(Math.abs(beamProfile(deg(t)) / s - 1)).toBeLessThan(0.25);
    // the reflector lip is a slight rise right before the crisp rim
    expect(beamProfile(deg(33.2))).toBeGreaterThan(beamProfile(deg(31)));
    expect(beamProfile(deg(35))).toBeLessThan(0.3 * s);
  });

  it('the soft (airlight) profile: 1 on the axis, 0 past the rim, close to the full profile outside the die', () => {
    expect(beamProfileSoft(0)).toBeCloseTo(1, 12);
    expect(beamProfileSoft(deg(O.RIM.out))).toBeLessThan(1e-3);
    expect(Math.abs(beamProfileSoft(deg(O.RIM.out + 0.1)))).toBe(0);
    expect(Math.abs(beamProfileSoft(deg(60)))).toBe(0);
    expect(Math.abs(beamProfileSoftCos(-1))).toBe(0);
    // the acos-free t^2 = (2x + x^2/3) DEG^2 matches theta^2 within 0.2 % inside the cone
    for (let t = 1; t <= 35; t += 2) {
      const x = 1 - Math.cos(deg(t));
      expect(Math.abs((2 * x + (x * x) / 3) / deg(t) ** 2 - 1)).toBeLessThan(2e-3);
    }
    for (let t = 0; t < 36; t += 0.5) expect(beamProfileSoft(deg(t))).toBeGreaterThanOrEqual(0);
    // same spill plateau and fall-off as the cookie's profile (within 25 %) away from the die, rings and lip
    for (const t of [12, 18, 25, 30]) expect(Math.abs(beamProfileSoft(deg(t)) / beamProfile(deg(t)) - 1)).toBeLessThan(0.25);
    const g = beamSoftGlsl();
    expect(g).toMatch(/float brBeamSoft\( float ca \)/);
    expect(g).not.toMatch(/acos/);
    for (const m of g.matchAll(/smoothstep\( ([\d.]+), ([\d.]+),/g)) expect(Number(m[1])).toBeLessThan(Number(m[2]));
  });

  it('the die-shaped angle only moves the core', () => {
    expect(beamProfile(deg(3), deg(3.3))).toBeLessThan(beamProfile(deg(3), deg(3)));
    expect(beamProfile(deg(20), deg(22))).toBeCloseTo(beamProfile(deg(20)), 10);
    expect(phosphorWeight(deg(O.PHOSPHOR.c))).toBeCloseTo(1, 12);
    expect(phosphorWeight(0)).toBeLessThan(1e-6);
  });

  it('emits 400-800 lm; three\'s penumbra ramp sits inside the rim (rendered flux within 2 %)', () => {
    const lm = beamFluxLm();
    expect(lm).toBeGreaterThan(400);
    expect(lm).toBeLessThan(800);
    const rendered = beamFluxLm(0, O.CONE, 4000, true);
    expect(rendered / lm).toBeGreaterThan(0.98);
    expect(rendered).toBeLessThanOrEqual(lm);
    expect(spotAttenuation(0)).toBe(1);
    expect(spotAttenuation(O.CONE)).toBe(0);
    expect(beamIntensity(0)).toBe(O.PEAK_CD);
    // additive over sub-ranges
    expect(beamFluxLm(0, deg(10)) + beamFluxLm(deg(10), O.CONE)).toBeCloseTo(lm, 3);
    // the spill ring carries most of the light: the room around the hotspot is what the torch shows
    expect(beamFluxLm(deg(16), O.CONE) / lm).toBeGreaterThan(0.4);
    const c = beamCentroid(deg(16), O.CONE);
    expect(c).toBeGreaterThan(deg(22));
    expect(c).toBeLessThan(deg(27));
  });

  it('beamProfileGlsl() carries every constant, and the cookie uses it at 512^2', () => {
    const g = beamProfileGlsl();
    const nums = [
      O.CORE_DEG, O.SHOULDER.a, O.SHOULDER.w, O.DARK_RING.a, O.DARK_RING.c, O.DARK_RING.s, O.PHOSPHOR.a, O.PHOSPHOR.c,
      O.PHOSPHOR.s, O.CORONA.a, O.CORONA.from, O.CORONA.to, O.SPILL.a, O.SPILL.droop, O.RIM.in, O.RIM.out, O.LIP.a,
      O.LIP.c, O.LIP.s, O.RIPPLE.a, O.RIPPLE.f, 1 / BEAM_NORM,
    ];
    for (const v of nums) expect(g).toContain(f(v));
    expect(g).toMatch(/float brBeam\( float th, float ths \)/);
    expect(g).toMatch(/float brBeamPhos\( float th \)/);
    // GLSL smoothstep is undefined for edge0 >= edge1: every call must have ascending edges
    for (const m of g.matchAll(/smoothstep\( ([\d.]+), ([\d.]+),/g)) expect(Number(m[1])).toBeLessThan(Number(m[2]));
    expect(COOKIE_GLSL).toContain('brBeam(th, ths)');
    expect(COOKIE_GLSL).toMatch(/vec4 texel\(vec2 uv\)/);
    expect(COOKIE_SIZE).toBe(512);
  });
});
