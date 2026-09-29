// tests/materials/gbuffer.test.ts — package D's specular G-buffer contract: the octahedral normal encoding survives
// the RGBA16F attachment, BR_SSR surface programs write attachments 1 through 3, and the lighting split moves exactly
// the replaceable specular (baked lobe by difference across the unchanged RE_Direct call, uniform environment,
// emission-map reflection) into brFbSpec / brWs on eligible pixels.

import { describe, expect, it } from 'vitest';
import { ShaderLib } from 'three';
import { FRAG_AO_REFL_GLSL, FRAG_LIGHTS_GLSL } from '../../src/materials/chunks/lighting.ts';
import { FRAG_FOG_GLSL } from '../../src/materials/chunks/haze.ts';
import { GBUFFER_PARS_GLSL } from '../../src/materials/chunks/gbuffer.ts';
import { buildSurfaceFragment } from '../../src/materials/SurfaceMaterial.ts';
import { SSR } from '../../src/post/ssr/ssrGlsl.ts';

type V3 = [number, number, number];

/** Round to the nearest IEEE half (normal range; the octahedral coordinates lie in [-1, 1]). */
function f16(x: number): number {
  if (x === 0) return 0;
  const e = Math.floor(Math.log2(Math.abs(x)));
  const ulp = 2 ** (Math.max(e, -14) - 10);
  return Math.round(x / ulp) * ulp;
}
/** CPU twins of chunks/gbuffer.ts brOctEnc / brOctDec. */
function octEnc(n: V3): [number, number] {
  const s = Math.abs(n[0]) + Math.abs(n[1]) + Math.abs(n[2]);
  const x = n[0] / s, y = n[1] / s, z = n[2] / s;
  if (z >= 0) return [x, y];
  return [(1 - Math.abs(y)) * (x >= 0 ? 1 : -1), (1 - Math.abs(x)) * (y >= 0 ? 1 : -1)];
}
function octDec(e: [number, number]): V3 {
  let n: V3 = [e[0], e[1], 1 - Math.abs(e[0]) - Math.abs(e[1])];
  if (n[2] < 0) n = [(1 - Math.abs(n[1])) * (n[0] >= 0 ? 1 : -1), (1 - Math.abs(n[0])) * (n[1] >= 0 ? 1 : -1), n[2]];
  const l = Math.hypot(n[0], n[1], n[2]);
  return [n[0] / l, n[1] / l, n[2] / l];
}

describe('octahedral view normals in RGBA16F', () => {
  it('round-trip 10k random unit normals within 1.1e-3 rad (about 0.06 deg)', () => {
    let seed = 7;
    const rnd = (): number => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
    let worst = 0;
    for (let i = 0; i < 10000; i++) {
      const u = rnd() * 2 - 1, t = rnd() * 2 * Math.PI, r = Math.sqrt(1 - u * u);
      const n: V3 = [r * Math.cos(t), r * Math.sin(t), u];
      const e = octEnc(n);
      const m = octDec([f16(e[0]), f16(e[1])]);
      worst = Math.max(worst, Math.acos(Math.min(1, n[0] * m[0] + n[1] * m[1] + n[2] * m[2])));
    }
    expect(worst).toBeLessThan(1.1e-3);
    // a flat floor (view normal straight up in view space) is exact
    const up = octDec(octEnc([0, 1, 0]).map(f16) as [number, number]);
    expect(up[1]).toBeCloseTo(1, 6);
  });
});

describe('G-buffer outputs', () => {
  it('BR_SSR programs declare and write MRT locations 1 through 3 (the surface fragment is one text for every variant)', () => {
    expect(GBUFFER_PARS_GLSL).toMatch(/#ifdef BR_SSR[\s\S]*layout\( location = 1 \) out highp vec4 brOut1;[\s\S]*layout\( location = 2 \) out highp vec4 brOut2;/);
    const frag = buildSurfaceFragment(ShaderLib.physical.fragmentShader);
    expect(frag).toContain(GBUFFER_PARS_GLSL);
    expect(FRAG_FOG_GLSL).toContain('brOut1 = brO1;');
    expect(FRAG_FOG_GLSL).toContain('brOut2 = brO2;');
    expect(GBUFFER_PARS_GLSL).toContain('layout( location = 3 ) out highp vec4 brOut3;');
    expect(FRAG_FOG_GLSL).toContain('brOut3 = brO3;');
    // the write carries the haze transmittance on both the fallback and the weight
    expect(FRAG_FOG_GLSL).toContain('brO1 = vec4( min( brFbSpec * brT, vec3( BR_HDR_CLAMP ) ), brWs * brT );');
    // att2: the routed lobe's normal (the shading normal, a clearcoat pixel's coat normal) and roughness
    expect(FRAG_FOG_GLSL).toContain('brO2 = vec4( brOctEnc( normalize( brMrtN ) ), brMrtRough, 1.0 );');
    expect(FRAG_FOG_GLSL).toContain('brO3 = vec4( brWsRgb * brT, 0.0 );');
    expect(FRAG_FOG_GLSL).toContain('brO3 = vec4( 0.0, 0.0, 0.0, gl_FragColor.a );');
  });
});

describe('lighting split (package D)', () => {
  it('eligibility: MRT frame (or the specw view), no emitter, not under water, a glossy routed lobe, never on decals', () => {
    const decide = FRAG_LIGHTS_GLSL.slice(FRAG_LIGHTS_GLSL.indexOf('#if defined( BR_SSR ) && ! defined( BR_DECAL )'));
    expect(decide).toMatch(/brMrtSpec = \( uBrMrt > 0\.5 \|\| uDebugView == \d+ \) && vBrEmit <= 0\.0 && ! brUnderW/);
    // the routed lobe: a clearcoat pixel's lacquer, else the base
    expect(decide).toMatch(/float brLobeR = material\.roughness;\s*#ifdef USE_CLEARCOAT\s*if \( brCoat \) brLobeR = material\.clearcoatRoughness;\s*#endif/);
    expect(decide).toContain('&& brLobeR < BR_SSR_ELIG_ROUGH;');
    expect(FRAG_LIGHTS_GLSL).toContain(`#define BR_SSR_ELIG_ROUGH ${SSR.ELIG_ROUGH}`);
    // under water: submerged, or a wet floor under a water surface (the water mesh reflects); decided before the split
    // and the probe, for both
    const uw = FRAG_LIGHTS_GLSL.indexOf('bool brUnderW = brSubInfo.x > 0.0;');
    expect(uw).toBeGreaterThan(0);
    expect(uw).toBeLessThan(FRAG_LIGHTS_GLSL.indexOf('#if defined( BR_SSR ) && ! defined( BR_DECAL )'));
    expect(FRAG_LIGHTS_GLSL).toContain('brWaterCell( ivec2( floor( vBrLocal.xz / BR_CELL ) ), brWy, brWk ) && brWy > vBrLocal.y - 0.01 ) brUnderW = true;');
  });

  it('RE_Direct is called once (not inlined: sheen and clearcoat stay exact) and the baked lobe moves by difference', () => {
    expect(FRAG_LIGHTS_GLSL.split('RE_Direct(').length).toBe(2);
    const i = FRAG_LIGHTS_GLSL.indexOf('RE_Direct(');
    expect(FRAG_LIGHTS_GLSL.slice(i - 200, i)).toContain('vec3 brDs0 = reflectedLight.directSpecular;');
    expect(FRAG_LIGHTS_GLSL.slice(i)).toMatch(/if \( brMrtSpec && ! brCoat \) \{\s*brFbDir = reflectedLight\.directSpecular - brDs0;\s*reflectedLight\.directSpecular = brDs0;/);
    // clearcoat pixels route the coat's lobe instead (x clearcoat, as three's composition weights it)
    expect(FRAG_LIGHTS_GLSL.slice(i - 400, i)).toContain('vec3 brCc0 = clearcoatSpecularDirect;');
    expect(FRAG_LIGHTS_GLSL.slice(i)).toMatch(/if \( brMrtSpec && brCoat \) \{[^}]*brFbDir = brCcD \* material\.clearcoat;\s*clearcoatSpecularDirect = brCc0;/);
  });

  it('the uniform environment goes to the fallback on G-buffer pixels, else inline', () => {
    expect(FRAG_LIGHTS_GLSL).toMatch(/if \( brMrtSpec && ! brCoat \) brFbEnv = brEnvRad;\s*else radiance \+= brEnvRad;/);
    // the lacquer's environment: the G-buffer fallback when routed, else three's clearcoatRadiance (left at 0 by three)
    expect(FRAG_LIGHTS_GLSL).toMatch(/if \( brMrtSpec && brCoat \) brFbEnv = brEnvCc;\s*else clearcoatRadiance \+= brEnvCc;/);
  });

  it('the fallback: DFG single scatter x specular occlusion x horizon on environment + emission map, plus the lobe', () => {
    const fb = FRAG_AO_REFL_GLSL.slice(FRAG_AO_REFL_GLSL.indexOf('if ( brMrtSpec ) {'));
    expect(fb).toContain('computeMultiscattering( material.dfg, material.specularColor, material.specularF90, brSsD, brMsD );');
    expect(fb).toContain('computeMultiscattering( material.dfg, material.diffuseColor, material.specularF90, brSsM, brMsM );');
    expect(fb).toContain('vec3 brSSw = mix( brSsD, brSsM, material.metalness );');
    expect(fb).toContain('float brHor = saturate( 1.0 + BR_HORIZON_K * dot( reflect( - geometryViewDir, geometryNormal ), brNg ) );');
    expect(fb).toContain('brFbSpec = ( brFbEnv + brReflRad ) * brSSw * brSOh + brFbDir;');
    expect(fb).toContain('brWs = brLuma( brSSw ) * brSOh;');
    expect(fb).toContain('brWsRgb = brSSw * brSOh;');
    expect(fb).toContain('brWsRgb = brEc * brSOch;');
    expect(fb).toContain('brRefl = vec3( 0.0 );'); // nothing stays inline
    // the specular occlusion is the one the inline terms use (baked AO x SSAO x cavity)
    expect(FRAG_AO_REFL_GLSL).toContain('float brSO = computeSpecularOcclusion( brDotNV, brAO * brSsK * brCav, material.roughness );');
    expect(FRAG_AO_REFL_GLSL).toContain(`#define BR_HORIZON_K ${SSR.HORIZON_K}`);
  });
});
