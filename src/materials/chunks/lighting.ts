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
//  - brMrtSpec, brFbDir, brFbEnv, brFbSpec, brWs, brMrtRough: the specular G-buffer split (D fills them; chunks/haze.ts
//    writes them to MRT attachments 1 and 2 under BR_SSR).
//  - brDirVis: visibility of the baked directional light (A's contact shadow, then B's FRAG_DIRVIS_GLSL).
//  - FRAG_BOUNCE_GLSL (F) after the ambient lines.

import { CELL, LV } from '../../core/constants.ts';
import { smoothstep } from '../../core/grid.ts';
import { FRAG_BOUNCE_GLSL } from './bounce.ts';
import { TUNE } from './params.ts';
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
  const f = smoothstep(TUNE.LV_GATE_NY0, TUNE.LV_GATE_NY1, ny);
  const r0 = TUNE.LV_GATE_LO + (1 - TUNE.LV_GATE_LO) * f, r1 = TUNE.LV_GATE_HI + (TUNE.LV_GATE_FLAT_HI - TUNE.LV_GATE_HI) * f;
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

/** Replaces `#include <lights_fragment_maps>`. */
export const FRAG_LIGHTS_GLSL = /* glsl */ `
#undef getSpotLightInfo
// ==== WP9 baked lighting
vec4 brLmA;
vec4 brLmB;
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
	brLmB = texture( uLmDir, vBrLmUv );
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
// r186 only initialises this when punctual lights exist; set it exactly as lights_fragment_begin does
material.multiScatteringCompensation = 1.0 + material.specularColorBlended * ( 1.0 / ( material.dfg.x + material.dfg.y ) - 1.0 );
if ( brW > 0.0 ) {
	// directional part through RE_Direct: dividing by the unperturbed cosine lets the normal map re-shade it
	vec3 brLv = normalize( ( viewMatrix * vec4( brLw, 0.0 ) ).xyz );
	float brNgL = max( dot( brNg, brLv ), BR_NG_MIN );
	// visibility of the baked directional light: contact shadow (package A), then package B's block
	float brDirVis = 1.0;
#ifdef BR_CS_STEPS
	if ( uSsaoP.x > 0.5 && uCsOn > 0.5 && uBrReflPass < 0.5 ) {
		brCs = brContactShadow( geometryPosition, brNg, brLv, brW );
		brDirVis *= brCs;
	}
#endif
${FRAG_DIRVIS_GLSL}
	IncidentLight brDL;
	brDL.color = brW * brE / brNgL * brDirVis;
	brDL.direction = brLv;
	brDL.visible = true;
	float brR0 = material.roughness;
	material.roughness = max( brR0, BR_DIRECT_MIN_ROUGH );
	RE_Direct( brDL, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
	material.roughness = brR0;
}
irradiance += brEf * mix( vec3( 1.0 ), brSsC, 0.5 ); // flicker channels: diffuse irradiance
iblIrradiance += ( 1.0 - brW ) * ( brE * brSsC ); // ambient part (diffuse + multiscatter specular in RE_IndirectSpecular)
radiance += ( 1.0 - brW ) * ( brE * brSsK ) * RECIPROCAL_PI; // ambient part as a uniform environment (indirect specular)
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
 * baked AO) times the texture cavity AO + planar / emission-map reflections added to indirectSpecular. */
export const FRAG_AO_REFL_GLSL = /* glsl */ `
// ==== WP9 specular occlusion + reflections
float brDotNV = saturate( dot( geometryNormal, geometryViewDir ) );
// texture cavity AO (WP8 ormh.r: grout, seams, carpet pile) on the ambient terms; the baked AO is already inside
// the indirect diffuse, so only the micro occlusion multiplies it
float brCav = clamp( brOrmh.r, 0.0, 1.0 );
reflectedLight.indirectDiffuse *= brCav;
reflectedLight.indirectSpecular *= computeSpecularOcclusion( brDotNV, brAO * brSsK * brCav, material.roughness );
vec3 brNWp = normalize( ( vec4( geometryNormal, 0.0 ) * viewMatrix ).xyz );
vec3 brRefl = vec3( 0.0 );
#ifndef BR_DECAL
{
	float brFres = F_Schlick( 0.04, 1.0, brDotNV );
	float brGloss = pow2( 1.0 - material.roughness );
	bool brPlanar = false;
#ifndef BR_SSR
	// planar reflection: only the plane currently mirrored by PlanarReflection (uReflY). SSR supersedes it on floors
	// (and frees uReflTex from the surface sampler budget); the water material keeps the planar path.
	if ( uReflOn > 0.5 && ( brF & BR_F_REFLECTIVE ) != 0 && brNWg.y > 0.9 && abs( vBrLocal.y + uTileOrigin.y - uReflY ) < BR_PLANE_EPS ) {
		vec4 brRc = uReflMatrix * vec4( - vViewPosition, 1.0 );
		vec2 brRuv = brRc.xy / brRc.w + brNWp.xz * BR_REFL_DISTORT;
		brRefl = textureLod( uReflTex, brRuv, material.roughness * BR_REFL_LOD ).rgb * brFres * brGloss * ( brAO * brSsK );
		brPlanar = true;
	}
#endif
#ifdef BR_FLOOR_REFL
	// emission-map reflection: intersect the reflected ray with the emitter plane in TILE-LOCAL space
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
			// submerged: the tile/water interface reflects ~10x less than tile/air (F0 0.004 vs 0.04)
			if ( ( brF & BR_F_UNDERWATER ) != 0 && brAuxB.w * 0.05 - 3.2 > vBrLocal.y ) brRefl *= BR_UNDERWATER_REFL;
		}
	}
#endif
}
#endif
reflectedLight.indirectSpecular += brRefl;
`;
