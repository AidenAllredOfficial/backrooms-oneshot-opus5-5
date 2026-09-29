// src/materials/chunks/lighting.ts — baked lighting for the surface variants (replaces lights_fragment_maps),
// submerged caustics, specular occlusion and the floor/prop reflections (replaces aomap_fragment).
//
// r186 note: RE_IndirectSpecular_Physical turns `iblIrradiance` into BOTH indirect diffuse (energy-conserving
// against the specular lobe) and the multiscatter specular term, and RE_IndirectDiffuse_Physical turns
// `irradiance` into diffuse. The non-directional part of the baked irradiance is therefore added to
// iblIrradiance only (adding it to `irradiance` too would double the ambient diffuse); `radiance` receives the
// same part as a uniform environment (1-w)E/PI so metals, glossy tile, CRT glass and car paint get highlights.
//
// Graphics-realism extension points (A.0; each block names its owner):
//  - brSs / brSsK / brSsC: pre-shade SSAO (A) on the indirect terms only; brSsK is the occlusion the bake has not
//    already applied. With SSAO off they are an exact 1.0, and each factor sits next to brE / brAO so the other
//    operands are rounded exactly as before (the preset images stay bit-identical).
//  - brMrtSpec, brFbDir, brFbEnv, brFbSpec, brWs, brWsRgb, brMrtRough, brMrtN: the specular G-buffer split (package D;
//    chunks/haze.ts writes them to MRT attachments 1 through 3 under BR_SSR). On MRT frames (uBrMrt) a glossy,
//    non-emissive pixel that is not under water (brUnderW: submerged, or a wet floor under a film-water surface,
//    whose reflection the water mesh draws) moves its replaceable specular out of the inline sum: the baked dominant-direction lobe
//    (the difference of reflectedLight.directSpecular across RE_Direct: three's sheen / clearcoat terms stay exact)
//    and the environment radiance (uniform, or the reflection probe's). Clearcoat pixels (props with the coat bit)
//    route their lacquer lobe instead (clearcoatSpecularDirect's difference, the coat environment) and keep the base
//    inline. FRAG_AO_REFL_GLSL assembles the fallback brFbSpec with its RGB weight brWsRgb; the SSR composite
//    (post/frame/MrtComposite.ts) replaces it by confidence, so a screen-space miss falls back to the probe.
//  - brPrW / brPrWc: the reflection probe's share (package D, chunks/probe.ts, BR_PROBE) of the base / clearcoat
//    environment: the baked dominant-direction lobe fades out by (1 - share) and the uniform environment is mixed
//    toward the box-projected, lightmap-normalised probe radiance (not under water either). three leaves clearcoatRadiance at 0 (this chunk
//    replaces lights_fragment_maps): it is set here, from the probe or the uniform environment.
//  - High / ultra (BR_SSR or BR_PROBE) compile the emission-map reflection out (BR_EM_REFL, chunks/common.ts: the
//    surface sampler budget; SSR and the probe replace it). Medium keeps it.
//  - brDirVis: visibility of the baked directional light (A's contact shadow, then B's FRAG_DIRVIS_GLSL).
//  - FRAG_BOUNCE_GLSL (F) after the ambient lines.

import { CELL, LV } from '../../core/constants.ts';
import { smoothstep } from '../../core/grid.ts';
import { DebugView } from '../../core/ids.ts';
import { SSR } from '../../post/ssr/ssrGlsl.ts';
import { FRAG_BOUNCE_GLSL } from './bounce.ts';
import { f, TUNE } from './params.ts';
import { FRAG_DIRVIS_GLSL } from './pom.ts';

/**
 * LV levels of a storey-relative height (TS twin of brLvK): [plain, up-facing] fractional level indices, clamped to
 * [LV.Y[0], LV.Y[NY - 1]], in [i, i + 1] between LV.Y[i] and LV.Y[i + 1]. The plain level is i + t; for an up-facing
 * surface (`ny` = max(n.y, 0)) level i keeps the trilinear weight (1 - t) * b, b = 1 - smoothstep(0, TUNE.LV_BACK_D,
 * (y - LV.Y[i]) * ny), so a surface more than LV_BACK_D above level i (along its normal) reads level i + 1 alone.
 */
export function lvLevels(y: number, ny = 0): [number, number] {
  const Y = LV.Y, n = LV.NY;
  const yc = Math.min(Math.max(y, Y[0]), Y[n - 1]);
  let i = 0;
  while (i < n - 2 && yc >= Y[i + 1]) i++;
  const h = yc - Y[i], t = h / (Y[i + 1] - Y[i]);
  const b = 1 - smoothstep(0, TUNE.LV_BACK_D, h * Math.max(ny, 0));
  return [i + t, Math.min(n - 1, i + t / Math.max(t + (1 - t) * b, 1e-4))];
}

/** Light an up-facing receiver takes from a light-volume sample (TS twin of brLvUp): luminance E, baked direction d
 * (any length) and directionality w; the directional part counts while d lies above the horizon (RE_Direct with n =
 * n_g = +y: min(1, d.y / NG_MIN)). */
export function lvUpLight(E: number, d: readonly [number, number, number], w: number): number {
  const l = Math.hypot(d[0], d[1], d[2]);
  const up = l > 1e-3 ? Math.min(1, Math.max(0, d[1] / (l * TUNE.NG_MIN))) : 1;
  const wc = Math.min(1, Math.max(0, w));
  return Math.max(E, 0) * (1 - wc + wc * up);
}

/**
 * Share of the up-facing level an up-facing surface takes (TS twin of the BR_LV gate), from the light an up-facing
 * receiver takes from the level below (`lo`) and the level above (`hi`), both lvUpLight at lvGatePoint, and the
 * surface's n.y. A sloped surface (n.y <= TUNE.LV_GATE_NY0) drops as the level above gets from LV_GATE_LO to
 * LV_GATE_HI times brighter (the level below then holds the prop's own shadow): its drop squeezes the vertical
 * transition into LV_BACK_D / n.y of height, a band where the levels differ. A flat top (n.y >= LV_GATE_NY1) has no
 * such transition and drops from 1 to LV_GATE_FLAT_HI times: a partial drop left a soft shadow over a lounge chair's
 * seat where the level below brightens away from its frame.
 */
export function lvBackGate(lo: number, hi: number, ny = 1): number {
  const fl = smoothstep(TUNE.LV_GATE_NY0, TUNE.LV_GATE_NY1, ny); // (not `f`: params.ts f formats the GLSL floats)
  const r0 = TUNE.LV_GATE_LO + (1 - TUNE.LV_GATE_LO) * fl, r1 = TUNE.LV_GATE_HI + (TUNE.LV_GATE_FLAT_HI - TUNE.LV_GATE_HI) * fl;
  return smoothstep(r0, r1, hi / Math.max(lo, 1e-6));
}

/** Wall clamp of a tile-local xz point inside the cell of `p` (TS twin of the BR_LV block; `mask` N1 E2 S4 W8). */
function lvClamp(p: readonly [number, number, number], x: number, z: number, mask: number): [number, number] {
  const x0 = Math.floor(p[0] / CELL) * CELL, z0 = Math.floor(p[2] / CELL) * CELL, cl = 0.3; // BR_LV_WALL_CLAMP
  if (mask & 1) z = Math.max(z, z0 + cl);
  if (mask & 2) x = Math.min(x, x0 + CELL - cl);
  if (mask & 4) z = Math.min(z, z0 + CELL - cl);
  if (mask & 8) x = Math.max(x, x0 + cl);
  return [x, z];
}

/** The gate's xz point (TS twin of brLvG): TUNE.LV_GATE_OFF behind the surface (against n.xz), wall-clamped like the
 * lookup. A flat top gates at its own point. */
export const lvGatePoint = (p: readonly [number, number, number], n: readonly [number, number, number], mask: number): [number, number] =>
  lvClamp(p, p[0] - n[0] * TUNE.LV_GATE_OFF, p[2] - n[2] * TUNE.LV_GATE_OFF, mask);

/** Fractional LV level of a surface: the plain level blended toward the up-facing one by the gate `s` (1: fully). */
export function lvLevel(y: number, ny = 0, s = 1): number {
  const [k0, k1] = lvLevels(y, ny);
  return k0 + (k1 - k0) * s;
}

/**
 * TS twin of the props' light-volume lookup (FRAG_LIGHTS_GLSL, BR_LV): the lookup point of a fragment at tile-local p
 * (storey-relative y) with unit geometric normal n, and wall-mask bits `mask` (N1 E2 S4 W8) of its own cell. Returns
 * [x, level, z]: tile-local metres (wall-clamped) and the fractional LV level (texture v = (level + 0.5) / LV.NY)
 * of lvLevel(p.y, n.y, s), `s` = lvBackGate of the two levels around p.y at lvGatePoint(p, n, mask).
 */
export function lvLookup(p: readonly [number, number, number], n: readonly [number, number, number], mask: number, s = 1): [number, number, number] {
  const [x, z] = lvClamp(p, p[0], p[2], mask);
  return [x, lvLevel(p[1], n[1], s), z];
}

/**
 * The baked dominant-direction lobe is an area estimate, not a point light: w * E averages several lights (and
 * sources near the receiver plane) into one direction that turns from texel to texel. Its GGX width therefore grows
 * with the spread of the directions it stands for, as variances add (alpha_eff^2 = alpha^2 + spread):
 *  - K1 * (1 - w): the angular variance of a von Mises-Fisher source distribution with mean resultant length w is
 *    about 2 (1 - w) around L, a quarter of it per axis in half-vector space;
 *  - K2 * (1 - smoothstep(0, NG_FADE, n_g . L)): a dominant direction near the receiver plane stands for a source
 *    close to the surface, whose direction sweeps across the texels (a bulb 0.3 m under a glossy ceiling drew a
 *    2 m bright arc where the mirror condition held along a curve, boosted up to 1 / NG_MIN = 5x).
 * Only the specular widens (the diffuse term does not depend on the roughness).
 */
export const LOBE = {
  K1: 0.25,
  K2: 0.2,
  NG_FADE: 0.3,
} as const;

/** GGX roughness (three's convention, alpha = roughness^2) of the baked lobe for a surface roughness r, baked
 * directionality w and geometric cosine ngl = n_g . L (TS twin of the FRAG_LIGHTS_GLSL block). */
export function bakedLobeRoughness(r: number, w: number, ngl: number): number {
  const a = Math.max(r, TUNE.DIRECT_MIN_ROUGH) ** 2;
  const a2 = a * a + LOBE.K1 * (1 - Math.min(Math.max(w, 0), 1)) + LOBE.K2 * (1 - smoothstep(0, LOBE.NG_FADE, ngl));
  return Math.min(1, Math.sqrt(Math.sqrt(a2)));
}

/** Replaces `#include <lights_fragment_maps>`. */
export const FRAG_LIGHTS_GLSL = /* glsl */ `
#undef getSpotLightInfo
#define BR_SSR_ELIG_ROUGH ${f(SSR.ELIG_ROUGH)}
#define BR_LOBE_K1 ${f(LOBE.K1)}
#define BR_LOBE_K2 ${f(LOBE.K2)}
#define BR_LOBE_NG_FADE ${f(LOBE.NG_FADE)}
// ==== WP9 baked lighting
material.diffuseContribution = brDiffRoom; // after the punctual lights (chunks/materialPost.ts brPunctAlb)
vec4 brLmA;
vec4 brLmB;
vec4 brLmG = vec4( 128.0 / 255.0 ); // (a zero gradient: the light volume has none)
vec4 brFl;
#ifdef BR_LV
	// props: tile light volume (32x6x32, 0.6 m), per-fragment wall clamp inside the fragment's own cell. Up-facing
	// surfaces drop the level below them once it lies BR_LV_BACK_D behind their plane (brLvK, TS twins lvLevels /
	// lvLookup): the samples under a prop's occluder boxes (a lounge chair's frame, a chair seat, a desk top) hold the
	// light in its shadow, lit from the floor below, and blended into the seat top above them they darkened it and
	// turned its baked direction below the seat plane (dark blotches); a seat top reads the first level above it, and
	// nothing higher (a whole-level shift read the light up to 1.1 m above desk tops: +60 % on them, the CRT's shadow
	// on the desk gone, and the pedestal feet under a table lit). The drop is gated (lvGatePoint, lvBackGate): read
	// BR_LV_GATE_OFF behind the surface, a level below that gives an up-facing receiver more light than the level above
	// is kept (a load on a rack deck: the level above it lies under the next deck); a sloped surface drops only a level
	// 1.5 to 3 times darker, the prop's own shadow (a corner in front of it, the hood before a car's windshield, is not:
	// dropping it squeezed the transition into a dark band across the glass). Down-facing
	// surfaces keep plain trilinear weights (the samples under the rear of a reclined backrest lie behind its frame;
	// moving down drew a dark fold across it), and so do vertical ones at their own xz (a sideways offset read other
	// sample columns on thin step faces: a dark stripe on a car door edge).
	vec3 brLvP = vBrLocal;
	if ( ( brF & BR_F_PROP_AUX ) != 0 && ( int( brAuxB.z ) & 1 ) != 0 ) brLvP.y = 1.5 + mod( brLvP.y - 1.5, BR_PITCH );
	vec2 brLvG = brLvP.xz - brNWg.xz * BR_LV_GATE_OFF; // the gate's point, behind the surface (below)
	{
		ivec2 cell = ivec2( floor( brLvP.xz / BR_CELL ) );
		ivec2 msz = textureSize( uVolMask, 0 );
		int m = int( texelFetch( uVolMask, clamp( cell + 1, ivec2( 0 ), msz - 1 ), 0 ).r * 255.0 + 0.5 );
		vec2 lo = vec2( cell ) * BR_CELL + BR_LV_WALL_CLAMP;
		vec2 hi = vec2( cell ) * BR_CELL + BR_CELL - BR_LV_WALL_CLAMP;
		if ( ( m & 1 ) != 0 ) { brLvP.z = max( brLvP.z, lo.y ); brLvG.y = max( brLvG.y, lo.y ); } // N (-z)
		if ( ( m & 2 ) != 0 ) { brLvP.x = min( brLvP.x, hi.x ); brLvG.x = min( brLvG.x, hi.x ); } // E (+x)
		if ( ( m & 4 ) != 0 ) { brLvP.z = min( brLvP.z, hi.y ); brLvG.y = min( brLvG.y, hi.y ); } // S (+z)
		if ( ( m & 8 ) != 0 ) { brLvP.x = max( brLvP.x, lo.x ); brLvG.x = max( brLvG.x, lo.x ); } // W (-x)
	}
	vec2 brLvKs = brLvK( brLvP.y, max( brNWg.y, 0.0 ) );
	float brLvKf = brLvKs.x;
	if ( brLvKs.y > brLvKs.x + 1e-4 ) {
		// the gate: the two levels around the fragment (texel-centred in y) at a point BR_LV_GATE_OFF behind it in xz, as
		// an up-facing receiver sees them
		float brLvI = floor( brLvKs.x );
		vec3 brLv0 = vec3( brLvG.x / BR_TILE, ( brLvI + 0.5 ) / BR_LV_NY, brLvG.y / BR_TILE );
		vec3 brLv1 = vec3( brLv0.x, ( brLvI + 1.5 ) / BR_LV_NY, brLv0.z );
		float brLvE0 = brLvUp( textureLod( uVolA, brLv0, 0.0 ), textureLod( uVolB, brLv0, 0.0 ) );
		float brLvE1 = brLvUp( textureLod( uVolA, brLv1, 0.0 ), textureLod( uVolB, brLv1, 0.0 ) );
		// flat tops (no vertical transition to compress) drop once the level above is the brighter; slopes want 1.5 - 3x
		float brLvF = smoothstep( BR_LV_GATE_NY0, BR_LV_GATE_NY1, brNWg.y );
		vec2 brLvR = mix( vec2( BR_LV_GATE_LO, BR_LV_GATE_HI ), vec2( 1.0, BR_LV_GATE_FLAT_HI ), brLvF );
		brLvKf = mix( brLvKs.x, brLvKs.y, smoothstep( brLvR.x, brLvR.y, brLvE1 / max( brLvE0, 1e-6 ) ) );
	}
	vec3 brUvw = vec3( brLvP.x / BR_TILE, ( brLvKf + 0.5 ) / BR_LV_NY, brLvP.z / BR_TILE );
	brLmA = texture( uVolA, brUvw );
	brLmB = texture( uVolB, brUvw );
	brFl = texture( uVolC, brUvw );
#else
	brLmA = texture( uLmIrr, vBrLmUv );
	brLmB = texture( uLmDir, brLmDirUv( vBrLmUv, 0.0 ) );
	brLmG = texture( uLmDir, brLmDirUv( vBrLmUv, 1.0 ) ); // the dir map's layer 1: the indirect gradient
	brFl = texture( uLmFlick, vBrLmUv );
#endif
vec3 brE = max( brLmA.rgb, vec3( 0.0 ) );
float brAO = clamp( brLmA.a, 0.0, 1.0 );
float brW = clamp( brLmB.a, 0.0, 1.0 );
vec3 brLw = brDecodeDir( brLmB.xyz, brW );
vec3 brEf = vec3( 0.0 );
for ( int k = 0; k < 4; k ++ ) brEf += max( brFl[ k ], 0.0 ) * uFlick[ brChannelSlot( k, vBrLocal.xz, uOwnParity ) ];
// ---- pre-shade SSAO (package A): brSs = screen-space AO, brSsK = its part the bake has not applied, brSsC = the
// albedo multi-bounce of brSsK; brCs = the contact-shadow visibility of the baked directional light (set below)
float brSs = 1.0, brSsK = 1.0;
vec3 brSsC = vec3( 1.0 );
float brCs = 1.0;
#ifdef BR_SSAO
if ( uSsaoP.x > 0.5 && uBrReflPass < 0.5 ) {
	brSs = pow( brSsao( geometryPosition, brNg ), uSsaoP.y );
	brSsK = min( 1.0, brSs / max( brAO, 0.05 ) );
	brSsC = brAoMultiBounce( brSsK, diffuseColor.rgb );
}
#endif
// ---- specular G-buffer split (package D fills these; chunks/haze.ts writes them under BR_SSR)
bool brMrtSpec = false;
vec3 brFbDir = vec3( 0.0 ), brFbEnv = vec3( 0.0 ), brFbSpec = vec3( 0.0 );
float brWs = 0.0, brMrtRough = 1.0;
vec3 brWsRgb = vec3( 0.0 ); // per-channel reflection throughput; scalar brWs remains the eligibility/debug weight
vec3 brMrtN = normal; // the routed lobe's normal (att2): the shading normal, or the clearcoat's
// under water: submerged (the water body's optics act on the whole radiance), or a glossy wet floor under a water
// surface in the wall mask (film water over puddles). The water mesh reflects the room at its surface: neither SSR
// nor the reflection probe may reflect it a second time from the floor below (package D)
bool brUnderW = brSubInfo.x > 0.0;
#if defined( BR_SSR ) || defined( BR_PROBE )
if ( ! brUnderW && uTileWater > 0.5 && material.roughness < BR_SSR_ELIG_ROUGH ) {
	float brWy;
	int brWk;
	if ( brWaterCell( ivec2( floor( vBrLocal.xz / BR_CELL ) ), brWy, brWk ) && brWy > vBrLocal.y - 0.01 ) brUnderW = true;
}
#endif
#if defined( BR_SSR ) && ! defined( BR_DECAL )
// MRT frame: the routed lobe (a clearcoat pixel's lacquer, else the base) glossy (below BR_SSR_ELIG_ROUGH), not an
// emitter, not under water. The specw debug view evaluates the split without MRT (its output replaces the colour).
float brLobeR = material.roughness;
#ifdef USE_CLEARCOAT
if ( brCoat ) brLobeR = material.clearcoatRoughness;
#endif
brMrtSpec = ( uBrMrt > 0.5 || uDebugView == ${DebugView.SPECW} ) && vBrEmit <= 0.0 && ! brUnderW
	&& brLobeR < BR_SSR_ELIG_ROUGH;
#endif
// ---- reflection probe (package D, chunks/probe.ts): brPrW = its share of the base lobe's environment (influence x
// roughness fade), brPrWc of the clearcoat lobe's (the lacquer is always glossy); brPrRad / brPrRadC = the
// box-projected, normalised probe radiance of each lobe. Not in reflection passes (the planar mirror, the probe's own
// capture): the camera-relative box belongs to the main camera, and a capture never sees the probe (no feedback).
// Not under water (brUnderW): those keep the legacy uniform environment.
float brPrW = 0.0, brPrWc = 0.0;
vec3 brPrRad = vec3( 0.0 ), brPrRadC = vec3( 0.0 );
#ifdef BR_PROBE
vec3 brPc = ( vec4( geometryPosition, 0.0 ) * viewMatrix ).xyz; // camera-relative world position
if ( uBrReflPass < 0.5 && uBrProbeOn > 0.5 && ! brUnderW ) {
	float brPw = brProbeWeight( brPc );
	brPrW = brPw * ( 1.0 - smoothstep( BR_PROBE_ROUGH0, BR_PROBE_ROUGH1, material.roughness ) );
	if ( brPrW > 0.0 ) {
		vec3 brRw = ( vec4( reflect( - geometryViewDir, geometryNormal ), 0.0 ) * viewMatrix ).xyz;
		brPrRad = brProbeRad( brPc, brRw, material.roughness, ( vec4( geometryNormal, 0.0 ) * viewMatrix ).xyz, brE + brEf );
	}
#ifdef USE_CLEARCOAT
	if ( brCoat && brPw > 0.0 ) {
		brPrWc = brPw;
		vec3 brRc = ( vec4( reflect( - geometryViewDir, geometryClearcoatNormal ), 0.0 ) * viewMatrix ).xyz;
		brPrRadC = brProbeRad( brPc, brRc, material.clearcoatRoughness, ( vec4( geometryClearcoatNormal, 0.0 ) * viewMatrix ).xyz, brE + brEf );
	}
#endif
}
#endif
// r186 only initialises this when punctual lights exist; set it exactly as lights_fragment_begin does
material.multiScatteringCompensation = 1.0 + material.specularColorBlended * ( 1.0 / ( material.dfg.x + material.dfg.y ) - 1.0 );
vec3 brLv = normalize( ( viewMatrix * vec4( brLw, 0.0 ) ).xyz );
#ifdef BR_CS_STEPS
// contact shadow of the baked directional light (package A), marched in uniform control flow (1 where w is too small
// to cast one) so the pixel quad can average its four IGN-jittered marches (brQuadMean)
if ( uSsaoP.x > 0.5 && uCsOn > 0.5 && uBrReflPass < 0.5 ) brCs = brQuadMean( brContactShadow( geometryPosition, brNg, brLv, brW ) );
#endif
if ( brW > 0.0 ) {
	// directional part through RE_Direct: dividing by the unperturbed cosine lets the normal map re-shade it
	float brNgL = max( dot( brNg, brLv ), BR_NG_MIN );
	// visibility of the baked directional light: contact shadow (package A), then package B's block
	float brDirVis = brCs;
${FRAG_DIRVIS_GLSL}
	IncidentLight brDL;
	brDL.color = brW * brE / brNgL * brDirVis;
	brDL.direction = brLv;
	brDL.visible = true;
	// the lobe is an area estimate (TS twin bakedLobeRoughness): alpha_eff^2 = max(alpha, alpha_min)^2 + the spread of
	// the directions it averages (1 - w) + the sweep of a dominant direction near the receiver plane
	float brLobeX = BR_LOBE_K1 * ( 1.0 - brW ) + BR_LOBE_K2 * ( 1.0 - smoothstep( 0.0, BR_LOBE_NG_FADE, dot( brNg, brLv ) ) );
	float brR0 = material.roughness;
	float brLa = max( brR0, BR_DIRECT_MIN_ROUGH );
	brLa *= brLa;
	material.roughness = min( 1.0, sqrt( sqrt( brLa * brLa + brLobeX ) ) );
#ifdef USE_CLEARCOAT
	// the lacquer's baked lobe is the same area estimate (three would evaluate it at the coat's ~0.05)
	float brCcR0 = material.clearcoatRoughness;
	float brCa = max( brCcR0, BR_DIRECT_MIN_ROUGH );
	brCa *= brCa;
	material.clearcoatRoughness = min( 1.0, sqrt( sqrt( brCa * brCa + brLobeX ) ) );
	vec3 brCc0 = clearcoatSpecularDirect;
#endif
	// split by difference (package D): the baked lobe leaves the inline sum on G-buffer pixels
	vec3 brDs0 = reflectedLight.directSpecular;
	RE_Direct( brDL, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
#ifdef BR_PROBE
	// the probe holds the lamps this lobe stands for: it fades out where the probe takes over
	if ( brPrW > 0.0 ) reflectedLight.directSpecular = brDs0 + ( reflectedLight.directSpecular - brDs0 ) * ( 1.0 - brPrW );
#endif
	if ( brMrtSpec && ! brCoat ) {
		brFbDir = reflectedLight.directSpecular - brDs0;
		reflectedLight.directSpecular = brDs0;
	}
#ifdef USE_CLEARCOAT
	material.clearcoatRoughness = brCcR0;
	vec3 brCcD = ( clearcoatSpecularDirect - brCc0 ) * ( 1.0 - brPrWc );
	if ( brMrtSpec && brCoat ) {
		// the coat lobe goes to the G-buffer, weighted as three's composition would (x clearcoat)
		brFbDir = brCcD * material.clearcoat;
		clearcoatSpecularDirect = brCc0;
	} else {
		clearcoatSpecularDirect = brCc0 + brCcD;
	}
#endif
	material.roughness = brR0;
}
irradiance += brEf * mix( vec3( 1.0 ), brSsC, 0.5 ); // flicker channels: diffuse irradiance
iblIrradiance += ( 1.0 - brW ) * ( brE * brSsC ); // ambient part (diffuse + multiscatter specular in RE_IndirectSpecular)
#ifndef BR_LV
// first-order normal response of the ambient part (lightmap path): E_ind(n) = E_ind(n_g) + g . n with the baked
// indirect gradient (tangent to n_g, so a flat surface keeps its mean), within +-(1 - w) E so the ambient part never
// turns negative. The ambient cube alone is quadratic in n: normal maps shaded nothing but the dominant-direction
// lobe, and ceilings (w = 0) not even that
iblIrradiance += brE * brSsC * clamp( dot( ( viewMatrix * vec4( brLmGrad( brLmG.rg, brNWg ), 0.0 ) ).xyz, normal ), - ( 1.0 - brW ), 1.0 - brW );
#endif
// ambient part as a uniform environment (indirect specular). Package D: the probe radiance takes over by its share
// (the clearcoat lobe's by brPrWc), then the routed lobe's environment becomes the G-buffer fallback's on MRT pixels
vec3 brEnvRad = ( 1.0 - brW ) * ( brE * brSsK ) * RECIPROCAL_PI;
#ifdef USE_CLEARCOAT
vec3 brEnvCc = brEnvRad;
#endif
#ifdef BR_PROBE
if ( brPrW > 0.0 ) brEnvRad = mix( brEnvRad, brPrRad, brPrW );
#ifdef USE_CLEARCOAT
if ( brPrWc > 0.0 ) brEnvCc = mix( brEnvCc, brPrRadC, brPrWc );
#endif
#endif
if ( brMrtSpec && ! brCoat ) brFbEnv = brEnvRad;
else radiance += brEnvRad;
#ifdef USE_CLEARCOAT
// three leaves clearcoatRadiance at 0 (it is set by the lights_fragment_maps this chunk replaces)
if ( brMrtSpec && brCoat ) brFbEnv = brEnvCc;
else clearcoatRadiance += brEnvCc;
#endif
${FRAG_BOUNCE_GLSL}
vec3 brIrrLocal = brE + brEf; // haze inscatter + water in-scatter
// ---- caustics (package E): zero-mean redistributions of the local irradiance.
// Submerged shell faces (below the water plane; brSubInfo = depth, kind from chunks/water.ts): 0 pool (full),
// 1 flooded room (weak, large, slow), 2 film (none). Deeper water spreads the filaments (brCaustics) and the finite
// source size blurs them further. Floors take the pattern straight above; walls the pattern where the baked light
// entered the water (along the refracted dominant direction), which draws streaks down the pool walls.
if ( ( brF & BR_F_UNDERWATER ) != 0 && brSubInfo.x > 0.0 && brNWg.y > ( BR_DETAIL == 1 ? - 0.5 : 0.5 ) ) { // lite: floors only
	float brDepth = brSubInfo.x;
	int brWK = int( brSubInfo.y + 0.5 );
	float brKS = brWK == 0 ? 1.0 : brWK == 1 ? BR_CAUSTIC_FLOOD : 0.0;
	if ( brKS > 0.0 ) {
		float brSc = brWK == 1 ? BR_CAUSTIC_FLOOD_SCALE : 1.0;
		float brTs = brWK == 1 ? BR_CAUSTIC_FLOOD_SPEED : 1.0;
		vec2 brXs = vBrLocal.xz;
		if ( brNWg.y <= 0.5 ) {
			// the light reaching depth d of a wall entered the water d tan(theta_t) out from it: along the refracted
			// baked direction, else along the wall normal at a typical 25 deg (the net then varies with depth)
			brKS *= ( 1.0 - abs( brNWg.y ) ) * BR_CAUSTIC_WALL;
			float brLy = max( brLw.y, 0.3 );
			float brSt = 0.75 * sqrt( max( 1.0 - brLy * brLy, 0.0 ) ); // refracted sine
			brXs += brW >= 0.2 ? normalize( brLw.xz + 1e-6 ) * ( brSt / sqrt( 1.0 - brSt * brSt ) ) * brDepth : brNWg.xz * ( 0.47 * brDepth );
		}
		float brC = brCaustics( brXs + uNoiseOrigin.xz, uTime * brTs, brDepth, brSc );
		float brSoft = 1.0 / ( 1.0 + brDepth * BR_CAUSTIC_SRC_TAN / ( 0.6 * brSc ) );
		float brCf = exp( - brDepth * BR_CAUSTIC_DEPTH_K ) * smoothstep( 0.0, 0.15, brDepth ) * brSoft * brKS;
		irradiance += brE * ( BR_CAUSTIC_STRENGTH * ( brC - brCausticMean( brDepth ) ) * brCf );
	}
}
#ifdef BR_CAUSTICS_FULL
// Above pool water (ceilings and walls of tiles with pool water, uTileWater bit 0; still flood water focuses nothing):
// light reflected and refracted by the wavy surface dances on them. Coverage from the 4 nearest wall-mask cells
// (chunks/water.ts brWaterCover); the net is softer (width 0.18), magnified in steps with the height above the water
// (brCausticsAbove) and slower; zero-mean, so the baked average (which already holds the pool bounce and the
// underwater lights' up-light) is kept. Not in the mirror pass (the reflected ceiling is seen through the wavy surface anyway).
else if ( ( int( uTileWater + 0.5 ) & 1 ) != 0 && brNWg.y < 0.5 && uBrReflPass < 0.5 ) {
	float brCwy;
	float brCov = brWaterCover( vBrLocal.xz + brNWg.xz * 0.05, brCwy );
	float brH = vBrLocal.y - brCwy;
	if ( brCov > 0.0 && brH > 0.02 ) {
		vec2 brXs = vBrLocal.xz - brNWg.xz * ( brH * 0.3 );
		float brBand = abs( brNWg.y ) > 0.9 ? 0.05 : 0.2; // flat ceilings: constant height, a narrow cross-fade band
		float brC = brCausticsAbove( brXs + uNoiseOrigin.xz, uTime * 0.7, 1.0 + brH * BR_CAUSTIC_MAGNIFY, brBand );
		float brStr = brNWg.y < - 0.5 ? BR_CAUSTIC_CEIL : BR_CAUSTIC_ABOVE_WALL;
		irradiance += brE * ( brStr * ( brC - brCausticMeanW( 0.18 ) ) * brCov / ( 1.0 + BR_CAUSTIC_FADE * brH ) );
	}
}
#endif
`;

/** Replaces `#include <aomap_fragment>`: specular occlusion from the baked AO (indirect diffuse already holds the
 * baked AO) times the texture cavity AO + planar / emission-map reflections added to indirectSpecular; on G-buffer
 * pixels (brMrtSpec) the fallback specular brFbSpec and its weight brWs instead (package D): the base lobe's, or on
 * clearcoat pixels the lacquer's. */
export const FRAG_AO_REFL_GLSL = /* glsl */ `
#define BR_HORIZON_K ${f(SSR.HORIZON_K)}
// ==== WP9 specular occlusion + reflections
float brDotNV = saturate( dot( geometryNormal, geometryViewDir ) );
// texture cavity AO (WP8 ormh.r: grout, seams, carpet pile) on the ambient terms; the baked AO is already inside
// the indirect diffuse, so only the micro occlusion multiplies it
float brCav = clamp( brOrmh.r, 0.0, 1.0 );
reflectedLight.indirectDiffuse *= brCav;
float brSO = computeSpecularOcclusion( brDotNV, brAO * brSsK * brCav, material.roughness );
reflectedLight.indirectSpecular *= brSO;
#ifdef USE_CLEARCOAT
// the lacquer's environment is occluded like the base's (three's aomap_fragment does the same)
float brDotNVc = saturate( dot( geometryClearcoatNormal, geometryViewDir ) );
float brSOc = computeSpecularOcclusion( brDotNVc, brAO * brSsK * brCav, material.clearcoatRoughness );
clearcoatSpecularIndirect *= brSOc;
#endif
vec3 brNWp = normalize( ( vec4( geometryNormal, 0.0 ) * viewMatrix ).xyz );
vec3 brRefl = vec3( 0.0 );
vec3 brReflRad = vec3( 0.0 ); // the emission-map reflection's radiance x its fade and roughness gate (package D)
#ifndef BR_DECAL
{
	float brFres = F_Schlick( 0.04, 1.0, brDotNV );
	float brGloss = pow2( 1.0 - material.roughness );
	bool brPlanar = false;
#if ! defined( BR_SSR ) && ! defined( BR_VOLUMETRIC )
	// planar reflection: only the plane currently mirrored by PlanarReflection (uReflY). SSR supersedes it on floors
	// (and frees uReflTex from the surface sampler budget); the water material keeps the planar path. Package F's
	// froxel volume (uVolTex, high / ultra, where SSR is on as well) takes the unit in the surface budget too.
	if ( uReflOn > 0.5 && ( brF & BR_F_REFLECTIVE ) != 0 && brNWg.y > 0.9 && abs( vBrLocal.y + uTileOrigin.y - uReflY ) < BR_PLANE_EPS ) {
		vec4 brRc = uReflMatrix * vec4( - vViewPosition, 1.0 );
		vec2 brRuv = brRc.xy / brRc.w + brNWp.xz * BR_REFL_DISTORT;
		brRefl = textureLod( uReflTex, brRuv, material.roughness * BR_REFL_LOD ).rgb * brFres * brGloss * ( brAO * brSsK );
		brPlanar = true;
	}
#endif
#if defined( BR_FLOOR_REFL ) && defined( BR_EM_REFL )
	// emission-map reflection (medium; high / ultra reflect through SSR and the probe): intersect the reflected ray with the emitter plane in TILE-LOCAL space
	// roughness gate: full below BR_EM_ROUGH_CUT (the spec's 0.5), soft tail to BR_EM_ROUGH_END so per-pixel roughness
	// texture never speckles the reflection on/off and damp carpet (0.55) keeps a faint blurred sheen of the lamps
	float brRGate = 1.0 - smoothstep( BR_EM_ROUGH_CUT, BR_EM_ROUGH_END, material.roughness );
	if ( ! brPlanar && uFloorReflOn > 0.5 && brRGate > 0.0 && ( brF & ( BR_F_DYN_EMIT | BR_F_SHIMMER ) ) == 0 ) {
		bool brFloorR = ( brF & BR_F_FLOOR_AUX ) != 0 && ( brF & BR_F_REFLECTIVE ) != 0 && brNWg.y > 0.7;
		bool brPropR = ( brF & BR_F_PROP_AUX ) != 0 && brNWg.y > 0.7;
		if ( brFloorR || brPropR ) {
			vec3 brRw = normalize( ( vec4( reflect( - geometryViewDir, geometryNormal ), 0.0 ) * viewMatrix ).xyz );
			// floors: emitter plane aux.x * 5 cm above the floor; props: the anchor cell's ceiling (aux.w * 5 cm,
			// storey-relative = tile-local y; tower props: shifted by the same whole periods as the fragment)
			float brPlaneY = vBrLocal.y + brAuxB.x * 0.05;
			if ( ! brFloorR ) {
				brPlaneY = brAuxB.w * 0.05;
#ifdef BR_LV
				brPlaneY += vBrLocal.y - brLvP.y;
#endif
			}
			float brRk = brFloorR ? brAuxB.y + 256.0 * brAuxB.z : - 1.0;
			float brFade;
			vec3 brEc = brEmissionRefl( vBrLocal, brRw, brPlaneY, brRk, material.roughness, brFade );
			brRefl = brEc * brFres * brGloss * ( brAO * brSsK ) * brFade * brRGate;
			brReflRad = brEc * brFade * brRGate;
			// submerged: the tile/water interface reflects ~10x less than tile/air (F0 0.004 vs 0.04)
			if ( ( brF & BR_F_UNDERWATER ) != 0 && brAuxB.w * 0.05 - 3.2 > vBrLocal.y ) brRefl *= BR_UNDERWATER_REFL;
		}
	}
#endif
}
#endif
#if defined( BR_SSR ) && ! defined( BR_DECAL )
if ( brMrtSpec ) {
	// package D: the replaceable specular of a G-buffer pixel, nothing of it stays inline. The environment and
	// emission-map radiance share one RGB weight, which the SSR hit inherits (brWsRgb), with a horizon term against the
	// unperturbed normal, so normal-mapped grout and bevels do not reflect from under the surface. Plus the baked lobe.
#ifdef USE_CLEARCOAT
	if ( brCoat ) {
		// the lacquer (F0 0.04 over the unperturbed normal, the coat roughness): its split-sum environment term, its
		// specular occlusion, x clearcoat as in three's final composition (which still attenuates the inline base by
		// 1 - clearcoat x Fcc)
		vec3 brEc = EnvironmentBRDF( geometryClearcoatNormal, geometryViewDir, material.clearcoatF0, material.clearcoatF90, material.clearcoatRoughness );
		float brHc = saturate( 1.0 + BR_HORIZON_K * dot( reflect( - geometryViewDir, geometryClearcoatNormal ), brNg ) );
		float brSOch = brSOc * brHc * brHc * material.clearcoat;
		brFbSpec = brFbEnv * brEc * brSOch + brFbDir;
		brWsRgb = brEc * brSOch;
		brWs = brLuma( brEc ) * brSOch;
		brMrtRough = material.clearcoatRoughness;
		brMrtN = geometryClearcoatNormal;
	} else
#endif
	{
		// the base lobe: the single-scatter DFG term (dielectric and metal mixed by metalness, three's sheen energy
		// loss) and the specular occlusion (baked AO x SSAO x cavity)
		vec3 brSsD = vec3( 0.0 ), brMsD = vec3( 0.0 ), brSsM = vec3( 0.0 ), brMsM = vec3( 0.0 );
		computeMultiscattering( material.dfg, material.specularColor, material.specularF90, brSsD, brMsD );
		computeMultiscattering( material.dfg, material.diffuseColor, material.specularF90, brSsM, brMsM );
		vec3 brSSw = mix( brSsD, brSsM, material.metalness );
#ifdef USE_SHEEN
		brSSw *= 1.0 - max3( material.sheenColor ) * IBLSheenBRDF( geometryNormal, geometryViewDir, material.sheenRoughness );
#endif
		float brHor = saturate( 1.0 + BR_HORIZON_K * dot( reflect( - geometryViewDir, geometryNormal ), brNg ) );
		float brSOh = brSO * brHor * brHor;
		brFbSpec = ( brFbEnv + brReflRad ) * brSSw * brSOh + brFbDir;
		brWsRgb = brSSw * brSOh;
		brWs = brLuma( brSSw ) * brSOh;
		brMrtRough = material.roughness;
	}
	brRefl = vec3( 0.0 );
}
#endif
reflectedLight.indirectSpecular += brRefl;
`;
