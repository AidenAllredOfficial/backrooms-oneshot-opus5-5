// tests/materials/probe.test.ts — package D: the reflection probe's shader maths (CPU twins in
// materials/chunks/probe.ts): box projection, influence, lightmap normalisation, the cube-face convention of the
// prefilter, its GGX samples, and the wiring of the probe into the lighting chunk (share, fallback, clearcoat).

import { describe, expect, it } from 'vitest';
import {
  cubeDir, cubeFaceOf, PROBE, PROBE_FILTER_FRAG, PROBE_GLSL, probeDir, probeLevels, probeNorm, probeSamples, probeWeight,
  radicalInverse,
} from '../../src/materials/chunks/probe.ts';
import { FRAG_AO_REFL_GLSL, FRAG_LIGHTS_GLSL } from '../../src/materials/chunks/lighting.ts';
import { FRAG_DEBUG_GLSL } from '../../src/materials/chunks/debug.ts';
import { QUALITY } from '../../src/core/quality.ts';

type V = [number, number, number];
const norm = (v: V): V => { const l = Math.hypot(...v); return [v[0] / l, v[1] / l, v[2] / l]; };
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

// a 10 x 3 x 6 room around the camera, the anchor 1 m right of the camera (all relative to the camera)
const MIN: V = [-4, -1.6, -2], MAX: V = [6, 1.4, 4], POS: V = [1, 0, 0];

describe('box projection (brProbeDir)', () => {
  it('a mirror ray from inside the box is looked up toward the point where it leaves the box', () => {
    const pc: V = [-2, -1.6, 1]; // a floor point
    for (const r of [norm([0.3, 0.8, -0.2]), norm([-0.5, 0.2, 0.7]), norm([0.9, 0.1, 0.1])] as V[]) {
      const d = probeDir(pc, r, 0, MIN, MAX, POS);
      // the hit: the smallest t leaving the box
      let t = Infinity;
      for (let i = 0; i < 3; i++) t = Math.min(t, Math.max((MAX[i] - pc[i]) / r[i], (MIN[i] - pc[i]) / r[i]));
      const hit: V = [pc[0] + r[0] * t, pc[1] + r[1] * t, pc[2] + r[2] * t];
      // on the box surface
      const onFace = [0, 1, 2].some((i) => Math.abs(hit[i] - MIN[i]) < 1e-6 || Math.abs(hit[i] - MAX[i]) < 1e-6);
      expect(onFace).toBe(true);
      const want = norm(sub(hit, POS));
      for (let i = 0; i < 3; i++) expect(d[i]).toBeCloseTo(want[i], 9);
    }
  });

  it('roughness fades the projection out (rough^2): rough 1 gives the plain reflection vector', () => {
    const r = norm([0.2, 0.9, 0.3]);
    const d = probeDir([0, 0, 0], r, 1, MIN, MAX, POS);
    for (let i = 0; i < 3; i++) expect(d[i]).toBeCloseTo(r[i], 12);
  });

  it('axis-parallel rays (zero components) stay finite', () => {
    const d = probeDir([0, 0, 0], [0, 1, 0], 0, MIN, MAX, POS);
    for (const v of d) expect(Number.isFinite(v)).toBe(true);
    expect(d[1]).toBeGreaterThan(0.7);
  });
});

describe('influence (brProbeWeight)', () => {
  it('is 1 inside and on the box, fades out FADE0..FADE1 m outside, 0 beyond; probeOn gates it', () => {
    expect(probeWeight([0, 0, 0], MIN, MAX)).toBe(1);
    expect(probeWeight([6, 0, 0], MIN, MAX)).toBe(1);
    expect(probeWeight([6 + PROBE.FADE0, 0, 0], MIN, MAX)).toBe(1);
    const mid = probeWeight([6 + (PROBE.FADE0 + PROBE.FADE1) / 2, 0, 0], MIN, MAX);
    expect(mid).toBeGreaterThan(0.1);
    expect(mid).toBeLessThan(0.9);
    expect(probeWeight([6 + PROBE.FADE1, 0, 0], MIN, MAX)).toBe(0);
    expect(probeWeight([6.7, 0, 4.7], MIN, MAX)).toBe(0); // a corner: the distance counts, not the axes
    expect(probeWeight([6.6, 0, 4.6], MIN, MAX)).toBeLessThan(0.05);
    expect(probeWeight([0, 0, 0], MIN, MAX, 0)).toBe(0);
    // a doorway into the next room: its floor 1 m past the wall has no probe
    expect(probeWeight([7, -1.6, 1], MIN, MAX)).toBe(0);
  });
});

describe('lightmap normalisation (brProbeNorm)', () => {
  it('scales by local / probe irradiance, clamped, mostly on rough lobes', () => {
    const e: V = [100, 100, 100];
    const probe: V = [100 / Math.PI, 100 / Math.PI, 100 / Math.PI]; // the same irradiance
    expect(probeNorm(e, probe, 0.3)).toBeCloseTo(1, 9);
    // a corner at 1/10 of the probe: clamped to NORM_MIN, applied by NORM_MIX_ROUGH at rough 0.5+
    const dark = probeNorm([10, 10, 10], probe, 0.6);
    expect(dark).toBeCloseTo(1 + (PROBE.NORM_MIN - 1) * PROBE.NORM_MIX_ROUGH, 9);
    // a dark glossy receiver takes the ratio at NORM_MIX_DARK (it does not see the anchor's lamps)
    const darkGloss = probeNorm([10, 10, 10], probe, 0.05);
    expect(darkGloss).toBeCloseTo(1 + (PROBE.NORM_MIN - 1) * PROBE.NORM_MIX_DARK, 9);
    // a black probe (nothing captured yet) cannot blow up
    expect(Number.isFinite(probeNorm(e, [0, 0, 0], 0.4))).toBe(true);
  });

  it('only darkens: a receiver lit more than the anchor keeps the probe as captured', () => {
    const probe: V = [100 / Math.PI, 100 / Math.PI, 100 / Math.PI];
    expect(PROBE.NORM_MAX).toBe(1);
    for (const r of [0, 0.05, 0.2, 0.4, 0.6]) {
      expect(probeNorm([1e4, 1e4, 1e4], probe, r)).toBe(1);
      expect(probeNorm([150, 150, 150], probe, r)).toBe(1);
    }
  });

  it('is monotonic in the ratio at every roughness, and the glossy share grows as the receiver darkens', () => {
    const probe: V = [100 / Math.PI, 100 / Math.PI, 100 / Math.PI];
    for (const r of [0, 0.05, 0.1, 0.2, 0.3, 0.45, 0.6]) {
      let prev = -Infinity;
      for (let e = 5; e <= 120; e += 1) {
        const v = probeNorm([e, e, e], probe, r);
        expect(v).toBeGreaterThanOrEqual(prev - 1e-12);
        expect(v).toBeLessThanOrEqual(1);
        expect(v).toBeGreaterThanOrEqual(PROBE.NORM_MIN - 1e-12);
        prev = v;
      }
    }
    // glossy: the share applied, (1 - f) / (1 - k), rises from NORM_MIX_GLOSS near k = 1 to NORM_MIX_DARK at NORM_MIN
    const share = (k: number): number => (1 - probeNorm([100 * k, 100 * k, 100 * k], probe, 0)) / (1 - k);
    expect(share(0.999)).toBeCloseTo(PROBE.NORM_MIX_GLOSS, 2);
    expect(share(0.5)).toBeGreaterThan(PROBE.NORM_MIX_GLOSS);
    expect(share(0.5)).toBeLessThan(PROBE.NORM_MIX_DARK);
    expect(share(PROBE.NORM_MIN)).toBeCloseTo(PROBE.NORM_MIX_DARK, 9);
  });
});

describe('prefilter', () => {
  it('face texel directions follow the GL cube-map convention (cubeDir inverts the lookup)', () => {
    const dirs: V[] = [[1, 0.2, -0.3], [-1, 0.4, 0.1], [0.3, 1, -0.2], [-0.1, -1, 0.5], [0.2, -0.3, 1], [-0.4, 0.1, -1]];
    dirs.forEach((d, face) => {
      const f = cubeFaceOf(d);
      expect(f.face).toBe(face);
      const back = norm(cubeDir(f.face, f.s, f.t));
      const want = norm(d);
      for (let i = 0; i < 3; i++) expect(back[i]).toBeCloseTo(want[i], 9);
    });
    // the face centres are the axes; (s, t) = (0, 0) of +Z is its -x, +y corner
    expect(cubeDir(2, 0.5, 0.5)).toEqual([0, 1, 0]);
    expect(cubeDir(4, 0, 0)).toEqual([-1, 1, 1]);
  });

  it('the shader carries the same face table', () => {
    expect(PROBE_FILTER_FRAG).toContain('if ( face == 0 ) return vec3( 1.0, - tc, - sc );');
    expect(PROBE_FILTER_FRAG).toContain('return vec3( - sc, - tc, - 1.0 );');
    expect(PROBE_FILTER_FRAG).toContain(`uniform vec4 uSamples[ ${PROBE.SAMPLES} ];`);
  });

  it('a non-finite capture texel is dropped, never spread into the filtered cube (both the copy and the GGX sum)', () => {
    expect(PROBE_FILTER_FRAG).toContain('bool brProbeFinite( vec3 c ) { return ! any( isnan( c ) ) && ! any( isinf( c ) ); }');
    expect(PROBE_FILTER_FRAG).toContain('outColor = vec4( brProbeFinite( c ) ? c : vec3( 0.0 ), 1.0 );');
    const loop = PROBE_FILTER_FRAG.slice(PROBE_FILTER_FRAG.indexOf('for ( int i = 0;'));
    expect(loop.indexOf('if ( ! brProbeFinite( c ) ) continue;')).toBeLessThan(loop.indexOf('acc += c * s.z;'));
  });

  it('Hammersley: the radical inverse is the bit-reversed fraction', () => {
    expect(radicalInverse(0)).toBe(0);
    expect(radicalInverse(1)).toBe(0.5);
    expect(radicalInverse(2)).toBe(0.25);
    expect(radicalInverse(3)).toBe(0.75);
    expect(radicalInverse(5)).toBe(0.625);
  });

  it('GGX samples: a copy at alpha 0; unit L in the upper lobe widening with alpha; FIS LODs grow with alpha', () => {
    const s = new Float32Array(4 * PROBE.SAMPLES);
    expect(probeSamples(0, 128, s)).toBe(1);
    const meanZ: number[] = [], meanLod: number[] = [];
    for (const a of [0.0625, 0.25, 0.5625, 1]) {
      expect(probeSamples(a, 128, s)).toBe(PROBE.SAMPLES);
      let z = 0, lod = 0, up = 0;
      for (let i = 0; i < PROBE.SAMPLES; i++) {
        const l = [s[4 * i], s[4 * i + 1], s[4 * i + 2]];
        expect(Math.hypot(l[0], l[1], l[2])).toBeCloseTo(1, 5);
        expect(s[4 * i + 3]).toBeGreaterThanOrEqual(0);
        if (l[2] > 0) { z += l[2]; up++; lod += s[4 * i + 3]; }
      }
      meanZ.push(z / up);
      meanLod.push(lod / up);
    }
    for (let i = 1; i < meanZ.length; i++) {
      expect(meanZ[i]).toBeLessThan(meanZ[i - 1]);
      expect(meanLod[i]).toBeGreaterThan(meanLod[i - 1]);
    }
    // the roughest level stays within the capture's mip chain
    expect(meanLod[meanLod.length - 1]).toBeLessThan(Math.log2(128) + 1);
  });

  it('mips: 5 at 128 (down to 8 px), 6 at 256; the presets', () => {
    expect(probeLevels(128)).toBe(5);
    expect(probeLevels(256)).toBe(6);
    expect(128 >> (probeLevels(128) - 1)).toBe(8);
    expect(QUALITY.low.reflectionProbe).toBe(0);
    expect(QUALITY.medium.reflectionProbe).toBe(0);
    expect(QUALITY.high.reflectionProbe).toBe(128);
    expect(QUALITY.ultra.reflectionProbe).toBe(256);
  });
});

describe('probe in the lighting chunk', () => {
  it('the helpers are real (not the A.0 stubs) and read the prefiltered cube by roughness', () => {
    expect(PROBE_GLSL).toContain('return textureLod( uBrProbe, brProbeDir( pc, rW, rough ), rough * uBrProbeLod ).rgb * brProbeNorm( nW, eLocal, rough );');
    expect(PROBE_GLSL).not.toContain('{ return 0.0; }');
  });

  it('share: influence x roughness fade, never in reflection passes or under water; the clearcoat takes the full influence', () => {
    const blk = FRAG_LIGHTS_GLSL.slice(FRAG_LIGHTS_GLSL.indexOf('#ifdef BR_PROBE'));
    // under water (submerged, or a wet floor under film water) the water mesh reflects the room: no second reflection
    expect(blk).toContain('if ( uBrReflPass < 0.5 && uBrProbeOn > 0.5 && ! brUnderW ) {');
    expect(blk).toContain('brPrW = brPw * ( 1.0 - smoothstep( BR_PROBE_ROUGH0, BR_PROBE_ROUGH1, material.roughness ) );');
    expect(blk).toContain('brPrWc = brPw;');
  });

  it('the baked lobe fades by (1 - share) and the environment mixes toward the probe, before the G-buffer split', () => {
    expect(FRAG_LIGHTS_GLSL).toContain('if ( brPrW > 0.0 ) reflectedLight.directSpecular = brDs0 + ( reflectedLight.directSpecular - brDs0 ) * ( 1.0 - brPrW );');
    expect(FRAG_LIGHTS_GLSL).toContain('vec3 brCcD = ( clearcoatSpecularDirect - brCc0 ) * ( 1.0 - brPrWc );');
    const mixAt = FRAG_LIGHTS_GLSL.indexOf('brEnvRad = mix( brEnvRad, brPrRad, brPrW );');
    const splitAt = FRAG_LIGHTS_GLSL.indexOf('if ( brMrtSpec && ! brCoat ) brFbEnv = brEnvRad;');
    expect(mixAt).toBeGreaterThan(0);
    expect(splitAt).toBeGreaterThan(mixAt);
    expect(FRAG_LIGHTS_GLSL).toContain('brEnvCc = mix( brEnvCc, brPrRadC, brPrWc );');
  });

  it('the coat lobe in the G-buffer: EnvironmentBRDF weight x occlusion x clearcoat, its roughness and normal', () => {
    const fb = FRAG_AO_REFL_GLSL.slice(FRAG_AO_REFL_GLSL.indexOf('if ( brCoat ) {'));
    expect(fb).toContain('vec3 brEc = EnvironmentBRDF( geometryClearcoatNormal, geometryViewDir, material.clearcoatF0, material.clearcoatF90, material.clearcoatRoughness );');
    expect(fb).toContain('brWs = brLuma( brEc ) * brSOch;');
    expect(fb).toContain('brMrtRough = material.clearcoatRoughness;');
    expect(fb).toContain('brMrtN = geometryClearcoatNormal;');
    // inline: the lacquer's environment is occluded like the base's
    expect(FRAG_AO_REFL_GLSL).toContain('clearcoatSpecularIndirect *= brSOc;');
  });

  it('high / ultra compile the emission-map reflection out; the debug views show the probe and its share', () => {
    expect(FRAG_AO_REFL_GLSL).toContain('#if defined( BR_FLOOR_REFL ) && defined( BR_EM_REFL )');
    expect(FRAG_DEBUG_GLSL).toContain('brProbeRad( brPc, brDr, 0.0, brDn, brE + brEf ) * brProbeWeight( brPc ) / BR_DEBUG_NITS');
    expect(FRAG_DEBUG_GLSL).toContain('max( brPrW, brPrWc )');
  });
});
