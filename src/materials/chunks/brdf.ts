// src/materials/chunks/brdf.ts — texture realism v2 (0b): the rough-diffuse BRDF of the direct lights. EON, the
// energy-preserving Fujii Oren-Nayar diffuse (Portsmouth, Kutz and Hill, JCGT 2025; the OpenPBR 1.1 diffuse), replaces
// three's Lambert term in RE_Direct where the global brDiffSigma > 0: the baked dominant-direction lobe
// (chunks/lighting.ts) and the flashlight (three's lights_fragment_begin) both go through the RE_Direct macro. The
// ambient (the (1 - w) E part and the gradient, RE_IndirectDiffuse) stays Lambert (EON's response to a uniform
// hemisphere is its directional albedo, which is rho here), and so do the sheen and the specular lobes.
//
// brRE_Direct is three's RE_Direct_Physical (r186, taken from ShaderChunk at build time, so it cannot drift) plus one
// line after its Lambert line: where brDiffSigma > 0 it adds EON minus Lambert, so the Lambert path compiles exactly as
// before (a branch around three's line moved one pixel of the torch frame by one level). It is defined in the
// clipping_planes_pars_fragment slot, which follows lights_physical_pars_fragment, and #undef / #define RE_Direct
// there. brDiffSigma is written by chunks/materialPost.ts (before lights_fragment_begin): min(1, sqrt(BR_L_SIGMA^2 +
// 0.5 (brDetVar + brVar))) on layers with BR_L_SIGMA > 0 (the unresolved detail and mip-filtered normal variance per
// axis become facet roughness at distance), 0 elsewhere.
//
// rho is the layer's calibrated macroscopic albedo (LAYER_DEFS.albedoMean; the bake bounces it), not a facet albedo, so
// the multiple-scattering lobe takes rho_ms = rho: the directional albedo is rho at every angle and roughness, and EON
// only redistributes the light (flatter under a torch at the eye, less cosine falloff). The paper's rho_ms =
// rho^2 E_avg / (1 - rho (1 - E_avg)) belongs to a facet albedo rho: it darkens a 0.3 albedo by 2-8 % at sigma 0.45
// (4-15 % at 0.9), which the bake and the albedo calibration would not know about.
// TS twin (eonBrdf, eonAlbedo*) below; tests/materials/brdf.test.ts checks the white furnace and the published ratios.

import { ShaderChunk } from 'three';
import { f } from './params.ts';

/** FON A = 1 / (1 + C1 sigma) (the paper's constant1_FON). */
export const EON_C1 = 0.5 - 2 / (3 * Math.PI);
/** Mean albedo of FON: E_avg = A (1 + C2 sigma) (constant2_FON). */
export const EON_C2 = 2 / 3 - 28 / (15 * Math.PI);
/** The paper's quartic fit of G(mu) / pi in (1 - mu) for the approximate FON directional albedo. */
export const EON_G = [0.0571085289, 0.491881867, -0.332181442, 0.0714429953] as const;

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

/** FON directional albedo, exact closed form (sigma = r). */
export function fonAlbedoExact(mu: number, r: number): number {
  const m = Math.min(1, Math.max(1e-6, mu));
  const a = 1 / (1 + EON_C1 * r);
  const si = Math.sqrt(1 - m * m);
  const g = si * (Math.acos(m) - si * m) + (2 / 3) * ((si / m) * (1 - si * si * si) - si);
  return a + ((r * a) / Math.PI) * g;
}

/** FON directional albedo, the paper's polynomial fit (what the shader evaluates). */
export function fonAlbedo(mu: number, r: number): number {
  const c = 1 - clamp01(mu);
  const g = c * (EON_G[0] + c * (EON_G[1] + c * (EON_G[2] + c * EON_G[3])));
  return (1 + r * g) / (1 + EON_C1 * r);
}

/**
 * EON BRDF value (per steradian, the twin of brEon) for albedo rho, roughness r = sigma, cosines muI = N.L and
 * muO = N.V and cIO = L.V. Single scattering f_ss = rho / pi A (1 + r s / t), s = L.V - muI muO, t = max(muI, muO) when
 * s > 0 else 1; multiple scattering f_ms = rho / pi (1 - E(muO)) (1 - E(muI)) / (1 - E_avg).
 */
export function eonBrdf(rho: number, r: number, muI: number, muO: number, cIO: number): number {
  const s = cIO - muI * muO;
  const st = s > 0 ? s / Math.max(Math.max(muI, muO), 1e-4) : s;
  const a = 1 / (1 + EON_C1 * r);
  const eAvg = a * (1 + EON_C2 * r);
  const ms = (Math.max(1e-7, 1 - fonAlbedo(muO, r)) * Math.max(1e-7, 1 - fonAlbedo(muI, r))) / Math.max(1e-7, 1 - eAvg);
  return (rho / Math.PI) * (a * (1 + r * st) + ms);
}

/** Single-scattering part over Lambert (f_ss / (rho / pi)). */
export function eonSingleRatio(r: number, muI: number, muO: number, cIO: number): number {
  const s = cIO - muI * muO;
  const st = s > 0 ? s / Math.max(Math.max(muI, muO), 1e-4) : s;
  return (1 + r * st) / (1 + EON_C1 * r);
}

/** Directional albedo of eonBrdf seen from muO: the cosine-weighted integral over the incident hemisphere
 * (midpoint rule in (cos theta, phi); the view direction in the xz plane). */
export function eonAlbedo(rho: number, r: number, muO: number, nt = 256, np = 128): number {
  const so = Math.sqrt(Math.max(0, 1 - muO * muO));
  let sum = 0;
  for (let i = 0; i < nt; i++) {
    const mi = (i + 0.5) / nt;
    const si = Math.sqrt(1 - mi * mi);
    for (let j = 0; j < np; j++) {
      const ph = ((j + 0.5) / np) * 2 * Math.PI;
      const cIO = si * so * Math.cos(ph) + mi * muO;
      sum += eonBrdf(rho, r, mi, muO, cIO) * mi;
    }
  }
  return (sum * 2 * Math.PI) / (nt * np);
}

/** The diffuse line of three's RE_Direct_Physical that the override branches on. */
const LAMBERT_LINE = 'reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseContribution ) * ( 1.0 - F );';

/** three's RE_Direct_Physical source (r186), extracted from ShaderChunk.lights_physical_pars_fragment. */
export function physicalDirectSource(chunk: string = ShaderChunk.lights_physical_pars_fragment): string {
  const head = 'void RE_Direct_Physical(';
  const i = chunk.indexOf(head);
  if (i < 0) throw new Error('brdf.ts: RE_Direct_Physical not found in lights_physical_pars_fragment');
  let depth = 0;
  for (let k = chunk.indexOf('{', i); k < chunk.length; k++) {
    if (chunk[k] === '{') depth++;
    else if (chunk[k] === '}' && --depth === 0) return chunk.slice(i, k + 1);
  }
  throw new Error('brdf.ts: unbalanced RE_Direct_Physical');
}

/** brRE_Direct: RE_Direct_Physical with the Lambert line behind a brDiffSigma branch (throws on anchor drift). */
export function brDirectSource(chunk?: string): string {
  const src = physicalDirectSource(chunk);
  if (src.split(LAMBERT_LINE).length !== 2) throw new Error('brdf.ts: the Lambert line of RE_Direct_Physical changed (three upgrade?)');
  // three's line stays verbatim and first (the Lambert path compiles exactly as before); EON adds its difference
  const eon = 'reflectedLight.directDiffuse += irradiance * ( brEon( material.diffuseContribution, brDiffSigma, dotNL, '
    + 'dot( geometryNormal, geometryViewDir ), dot( directLight.direction, geometryViewDir ) ) '
    + '- BRDF_Lambert( material.diffuseContribution ) ) * ( 1.0 - F );';
  return src.replace('void RE_Direct_Physical(', 'void brRE_Direct(')
    .replace(LAMBERT_LINE, `${LAMBERT_LINE}\n\tif ( brDiffSigma > 0.0 ) ${eon}`);
}

/** Injected after `#include <clipping_planes_pars_fragment>` (fragment preamble, after lights_physical_pars). */
export function brdfParsGlsl(): string {
  return /* glsl */ `
// ---- texture realism v2 (0b): EON rough diffuse for the direct lights (chunks/brdf.ts)
#define BR_EON_C1 ${f(EON_C1)}
#define BR_EON_C2 ${f(EON_C2)}
// the EON roughness of this pixel (0 = three's Lambert); written by chunks/materialPost.ts before the lights
float brDiffSigma = 0.0;
// FON directional albedo (the paper's polynomial fit in 1 - mu)
float brFonE( float mu, float r ) {
	float c = 1.0 - saturate( mu );
	float g = c * ( ${f(EON_G[0])} + c * ( ${f(EON_G[1])} + c * ( ${f(EON_G[2])} + c * ${f(EON_G[3])} ) ) );
	return ( 1.0 + r * g ) / ( 1.0 + BR_EON_C1 * r );
}
// EON BRDF (per steradian): Fujii Oren-Nayar single scattering plus the multiple-scattering lobe, rho_ms = rho (the
// directional albedo stays rho: rho is the calibrated macroscopic albedo)
vec3 brEon( vec3 rho, float r, float muI, float muO, float cIO ) {
	float s = cIO - muI * muO;
	float st = s > 0.0 ? s / max( max( muI, muO ), 1e-4 ) : s;
	float a = 1.0 / ( 1.0 + BR_EON_C1 * r );
	float eAvg = a * ( 1.0 + BR_EON_C2 * r );
	float ms = max( 1e-7, 1.0 - brFonE( muO, r ) ) * max( 1e-7, 1.0 - brFonE( muI, r ) ) / max( 1e-7, 1.0 - eAvg );
	return rho * ( RECIPROCAL_PI * ( a * ( 1.0 + r * st ) + ms ) );
}
${brDirectSource()}
#undef RE_Direct
#define RE_Direct brRE_Direct
`;
}
