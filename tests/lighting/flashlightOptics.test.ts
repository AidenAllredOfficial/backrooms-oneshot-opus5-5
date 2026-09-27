// tests/lighting/flashlightOptics.test.ts (package F) — the flashlight's beam profile: normalisation, hotspot width,
// dim spill and soft edge, flux, and the GLSL twin carrying every constant.

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

  it('a ~9 deg hotspot falling smoothly into a dim spill (2-5 % of the peak) that fades out softly', () => {
    // hotspot: full width at half maximum 8-12 deg
    let half = 0;
    while (beamProfile(deg(half + 0.05)) > 0.5) half += 0.05;
    expect(2 * half).toBeGreaterThan(8);
    expect(2 * half).toBeLessThan(12);
    // the spill is much dimmer than the hotspot
    const s = beamProfile(deg(22));
    expect(s).toBeGreaterThanOrEqual(0.02);
    expect(s).toBeLessThanOrEqual(0.05);
    expect(beamProfile(0) / s).toBeGreaterThanOrEqual(20);
    // monotone fall-off from the hotspot through the halo into the spill (the faint ripple aside): no rim ring
    for (let t = 8; t < 36; t += 0.5) expect(beamProfile(deg(t + 1))).toBeLessThan(beamProfile(deg(t)) * 1.05);
    // a soft edge: from the spill level to zero over several degrees, no step between neighbouring degrees
    expect(beamProfile(deg(30))).toBeGreaterThan(0.25 * s);
    expect(beamProfile(deg(34))).toBeLessThan(0.3 * s);
    for (let t = 20; t < 36; t += 0.5) expect(beamProfile(deg(t)) - beamProfile(deg(t + 0.5))).toBeLessThan(0.08 * s);
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
    // the same halo, spill and fall-off as the cookie's profile (within 25 %) away from the die and the ring
    for (const t of [12, 18, 25, 30]) expect(Math.abs(beamProfileSoft(deg(t)) / beamProfile(deg(t)) - 1)).toBeLessThan(0.25);
    expect(Math.abs(beamProfileSoft(deg(3)) / beamProfile(deg(3)) - 1)).toBeLessThan(0.1);
    const g = beamSoftGlsl();
    expect(g).toMatch(/float brBeamSoft\( float ca \)/);
    expect(g).not.toMatch(/acos/);
    for (const m of g.matchAll(/smoothstep\( ([\d.]+), ([\d.]+),/g)) expect(Number(m[1])).toBeLessThan(Number(m[2]));
  });

  it('the die-shaped angle only moves the core', () => {
    expect(beamProfile(deg(3), deg(3.3))).toBeLessThan(beamProfile(deg(3), deg(3)));
    expect(beamProfile(deg(20), deg(22))).toBeCloseTo(beamProfile(deg(20)), 6);
    expect(phosphorWeight(deg(O.PHOSPHOR.c))).toBeCloseTo(1, 12);
    expect(phosphorWeight(0)).toBeLessThan(1e-6);
  });

  it('emits 250-500 lm, most of it in the hotspot and halo; three\'s penumbra ramp lies beyond the rim', () => {
    const lm = beamFluxLm();
    expect(lm).toBeGreaterThan(250);
    expect(lm).toBeLessThan(500);
    const rendered = beamFluxLm(0, O.CONE, 4000, true);
    expect(rendered / lm).toBeGreaterThan(0.999);
    expect(rendered).toBeLessThanOrEqual(lm);
    expect(O.CONE * (1 - O.PENUMBRA)).toBeGreaterThan(deg(O.RIM.out) * 0.99);
    expect(spotAttenuation(0)).toBe(1);
    expect(spotAttenuation(O.CONE)).toBe(0);
    expect(beamIntensity(0)).toBe(O.PEAK_CD);
    // additive over sub-ranges
    expect(beamFluxLm(0, deg(10)) + beamFluxLm(deg(10), O.CONE)).toBeCloseTo(lm, 3);
    // the hotspot and halo (inside 16 deg) carry more than the wide spill, which still shows the room around them
    const spill = beamFluxLm(deg(16), O.CONE) / lm;
    expect(spill).toBeGreaterThan(0.2);
    expect(spill).toBeLessThan(0.5);
    const c = beamCentroid(deg(16), O.CONE);
    expect(c).toBeGreaterThan(deg(20));
    expect(c).toBeLessThan(deg(27));
  });

  it('beamProfileGlsl() carries every constant, and the cookie uses it at 512^2', () => {
    const g = beamProfileGlsl();
    const nums = [
      1 / O.CORE_DEG, O.CORE_EXP, O.HALO.a, O.HALO.w, O.PHOSPHOR.a, O.PHOSPHOR.c, O.PHOSPHOR.s, O.SPILL.a, O.SPILL.droop,
      O.RIM.in, O.RIM.out, O.RIPPLE.a, O.RIPPLE.f, 1 / BEAM_NORM,
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
