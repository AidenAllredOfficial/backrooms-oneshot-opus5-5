// tests/materials/screenspace.test.ts — the pre-shade SSAO and contact-shadow maths (chunks/screenspace.ts TS twins)
// and where the surface shader applies them (chunks/lighting.ts): AO on the indirect terms only, contact shadows on
// the baked directional term only.

import { describe, expect, it } from 'vitest';
import {
  aoMultiBounce, CONTACT_SHADOW, contactShadow, SCREENSPACE_GLSL, ssPos,
} from '../../src/materials/chunks/screenspace.ts';
import type { SsProj, Vec3 } from '../../src/materials/chunks/screenspace.ts';
import { FRAG_AO_REFL_GLSL, FRAG_LIGHTS_GLSL } from '../../src/materials/chunks/lighting.ts';

// a 60 deg vertical fov, 16:9 perspective (three's projection: P00, P11, P20 = P21 = 0 without a view offset)
const f = 1 / Math.tan(Math.PI / 6);
const PROJ: SsProj = [f / (16 / 9), f, 0, 0];
const W = 320, H = 180;

/** A synthetic half-res view-distance buffer: a wall facing the camera 5 m away with a 0.2 m deep box against it
 * (its front face at 4.8 m) covering view x in [-0.2, 0.2], y in [-1.0, -0.6]. */
function scene(u: number, v: number): number {
  // the view ray through (u, v) in [0,1]^2: x = (ndc.x + P20) z / P00 at unit distance
  const rx = (u * 2 - 1) / PROJ[0], ry = (v * 2 - 1) / PROJ[1];
  const x = rx * 4.8, y = ry * 4.8;
  if (x >= -0.2 && x <= 0.2 && y >= -1.0 && y <= -0.6) return 4.8;
  return 5;
}
const zAt = (u: number, v: number): number => scene((Math.floor(u * W) + 0.5) / W, (Math.floor(v * H) + 0.5) / H);

describe('brAoMultiBounce (Jimenez 2016)', () => {
  it('is the plain visibility at albedo 0, above it for bright albedo, and 1 at full visibility', () => {
    for (const v of [0.1, 0.3, 0.5, 0.8]) {
      expect(aoMultiBounce(v, 0)).toBeCloseTo(v, 6);
      expect(aoMultiBounce(v, 0.8)).toBeGreaterThan(v + 0.05);
      expect(aoMultiBounce(v, 0.8)).toBeGreaterThan(aoMultiBounce(v, 0.4));
    }
    expect(aoMultiBounce(1, 0.8)).toBeCloseTo(1, 2);
    expect(aoMultiBounce(1, 0)).toBeCloseTo(1, 3);
  });
});

describe('brSsPos', () => {
  it('reconstructs the view position of the pixel an AO texel represents', () => {
    const P: Vec3 = [0.4, -0.3, -3];
    // project P to its full-res pixel, then back through the half-res texel it falls in
    const ndcX = (PROJ[0] * P[0] + PROJ[2] * P[2]) / -P[2], ndcY = (PROJ[1] * P[1] + PROJ[3] * P[2]) / -P[2];
    const px = Math.floor((ndcX * 0.5 + 0.5) * W * 2), py = Math.floor((ndcY * 0.5 + 0.5) * H * 2);
    const q: [number, number] = [px >> 1, py >> 1];
    const r = ssPos(q, 3, 2, [W * 2, H * 2], PROJ);
    expect(r[2]).toBe(-3);
    // within a pixel or two of P at 3 m
    expect(Math.abs(r[0] - P[0])).toBeLessThan(0.02);
    expect(Math.abs(r[1] - P[1])).toBeLessThan(0.02);
  });
});

describe('brContactShadow on a synthetic depth box', () => {
  const L: Vec3 = [0, 0, 1]; // light from the camera side: the box stands between the wall and it
  const Ng: Vec3 = [0, 0, 1];
  it('shadows the wall at the foot of the box', () => {
    for (const j of [0, 0.25, 0.5, 0.75, 0.99]) {
      const v = contactShadow([0, -0.8, -5], Ng, L, 1, 8, j, PROJ, zAt);
      expect(v).toBeLessThan(0.3);
    }
  });
  it('leaves the wall away from the box, grazing lights and non-directional light alone', () => {
    expect(contactShadow([1.5, 0.5, -5], Ng, L, 1, 8, 0.5, PROJ, zAt)).toBe(1);
    expect(contactShadow([0, -0.8, -5], Ng, L, 0.04, 8, 0.5, PROJ, zAt)).toBe(1); // w < W0
    expect(contactShadow([0, -0.8, -5], Ng, [1, 0, 0], 1, 8, 0.5, PROJ, zAt)).toBe(1); // N.L < 0.05
  });
  it('fades out with distance (FADE0-FADE1) and scales with the directionality', () => {
    const far = (z: number): number => contactShadow([0, 0, -z], Ng, L, 1, 8, 0, PROJ, () => z - 0.2);
    expect(far(CONTACT_SHADOW.FADE0 - 1)).toBeCloseTo(1 - CONTACT_SHADOW.STRENGTH, 5);
    expect(far(CONTACT_SHADOW.FADE1 + 1)).toBe(1);
    expect(far((CONTACT_SHADOW.FADE0 + CONTACT_SHADOW.FADE1) / 2)).toBeGreaterThan(far(CONTACT_SHADOW.FADE0 - 1));
    const half = contactShadow([0, 0, -8], Ng, L, 0.175, 8, 0, PROJ, () => 7.8);
    expect(half).toBeCloseTo(1 - CONTACT_SHADOW.STRENGTH * 0.5, 5);
  });
  it('weakens with the occluder\'s distance from the receiver (penumbra)', () => {
    // light up and towards the camera; an overhang 0.3 m in front of the wall covers everything higher than h
    const Lt: Vec3 = [0, 0.6, 0.8];
    const at = (h: number): number => contactShadow([0, 0, -8], Ng, Lt, 1, 64, 0, PROJ, (_u, v) => (((v * 2 - 1) / PROJ[1]) * 8 > h ? 7.7 : 8.05));
    expect(at(0.02)).toBeLessThan(0.3);
    expect(at(0.02)).toBeLessThan(at(0.1));
    expect(at(0.1)).toBeLessThan(at(0.2));
    expect(at(0.4)).toBe(1); // beyond the march
  });
  it('casts a lighter shadow from an occluder thinner than a step (an area light swallows it), a full one from a solid', () => {
    // light up and towards the camera; an overhang 0.3 m in front of the wall: a solid one above h = 0.1, or a bar
    // only 1.5 cm tall there (a lounger axle)
    const Lt: Vec3 = [0, 0.6, 0.8];
    const y = (v: number): number => ((v * 2 - 1) / PROJ[1]) * 8;
    const solid = (j: number): number => contactShadow([0, 0, -8], Ng, Lt, 1, 8, j, PROJ, (_u, v) => (y(v) > 0.1 ? 7.7 : 8.05));
    const bar = (j: number): number => contactShadow([0, 0, -8], Ng, Lt, 1, 8, j, PROJ, (_u, v) => (y(v) > 0.1 && y(v) < 0.115 ? 7.7 : 8.05));
    let hitsBar = 0;
    for (let j = 0.05; j < 1; j += 0.1) {
      const s = solid(j), b = bar(j);
      expect(s).toBeLessThan(0.75);
      expect(b).toBeGreaterThanOrEqual(s - 1e-9);
      if (b < 1) {
        hitsBar++;
        // a dithered step that lands on the bar shadows at most a third as deep as the solid (the two samples past the hit miss)
        expect(1 - b).toBeLessThanOrEqual((1 - s) / 3 + 0.05);
      }
    }
    expect(hitsBar).toBeGreaterThan(0);
  });
  it('ignores its own surface (depth bias) and occluders thicker than CS_THICK behind the ray', () => {
    // a flat wall: every sample is in front of the depth buffer
    expect(contactShadow([0.3, 0.3, -5], Ng, L, 1, 8, 0.5, PROJ, () => 5)).toBe(1);
    // the only surface in front is more than THICK in front of every sample
    expect(contactShadow([0.3, 0.3, -5], Ng, L, 1, 8, 0.5, PROJ, () => 3)).toBe(1);
  });
});

describe('GLSL twins', () => {
  it('emits the TS constants as the shader defines', () => {
    for (const [k, v] of Object.entries(CONTACT_SHADOW)) expect(SCREENSPACE_GLSL).toContain(`#define BR_CS_${k} ${v.toFixed(4)}`);
    expect(SCREENSPACE_GLSL).toContain('max( vec3( v ), ( ( v * ( 2.0404 * a - 0.3324 ) + ( - 4.7951 * a + 0.6417 ) ) * v + ( 2.7552 * a + 0.6903 ) ) * v )');
  });
  it('applies SSAO to the indirect terms only and the contact shadow to the baked directional term only', () => {
    const src = FRAG_LIGHTS_GLSL;
    const direct = src.slice(src.indexOf('if ( brW > 0.0 ) {'), src.indexOf('RE_Direct('));
    expect(direct).toContain('brContactShadow( geometryPosition, brNg, brLv, brW )');
    expect(src.split('brContactShadow(').length).toBe(2); // only there
    expect(direct).not.toMatch(/brSs[KC]?\b/);
    expect(src).toContain('iblIrradiance += ( 1.0 - brW ) * ( brE * brSsC );');
    expect(src).toContain('vec3 brEnvRad = ( 1.0 - brW ) * ( brE * brSsK ) * RECIPROCAL_PI;'); // radiance, or D's G-buffer
    expect(src).toContain('brDL.color = brW * brE / brNgL * brDirVis;');
    expect(FRAG_AO_REFL_GLSL).toContain('computeSpecularOcclusion( brDotNV, brAO * brSsK * brCav, material.roughness )');
  });
});
