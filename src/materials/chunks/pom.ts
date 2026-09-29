// src/materials/chunks/pom.ts — package B: parallax occlusion mapping of the shell (BR_POM = 1 steps only, 2 with
// self-shadow) and the directional-light visibility terms (the texture cavity's visibility of the baked light, POM
// self-shadow). The view march itself sits in chunks/surface.ts FRAG_MAP_GLSL (it moves brUv before the base
// sampling); this file holds its height lookup and FRAG_DIRVIS_GLSL, which chunks/lighting.ts inlines inside
// `if ( brW > 0.0 )`, after the contact shadow and before RE_Direct: it may only multiply `float brDirVis` (brLv, brNg,
// brNgL, brW in scope).

import { f } from './params.ts';

/**
 * Visibility of the baked directional light in the texture cavity (texture realism v2, 0b; FRAG_DIRVIS_GLSL, TS twin
 * dirVis). The light is modelled as a cap of half-angle beta around its direction L, with cos(beta) = 2 R_d - 1 (a
 * uniform cap's mean resultant length is (1 + cos beta) / 2); R_d, the direct light's resultant length, is estimated
 * from the baked directionality as w / RD_W (the bake does not store it yet). The cavity V (ormh.r) is the
 * cosine-weighted visibility of the hemisphere, V = 1 - mean sin^2(horizon), so a light whose cosine-weighted mean
 * sin^2(theta) is m loses (1 - V) 2m of itself (the hemisphere's m is 1/2):
 *   vis = 1 - (1 - V) g,  g = K (2 - (1 + cb^2) c^2 - 1.5 (1 - cb^2) (1 - c^2)),  c = N_g.L,
 * the closed form of 2m for a cap above the horizon, with cb = max(cos beta, min(sin theta_L, CB_LOW)): the part of a
 * wide cap around a low light that would lie below the horizon is not light the surface receives (the exact clipped
 * cap within 0.1 in g). Linear in V, so the mip-filtered cavity gives the filtered visibility (no brightening with
 * distance). Fitted against a ray-marched height-field reference (grooves, tooled joints, pits, rough fields; caps of
 * 25-85 degrees at 0-75 degrees from the normal): rms error 0.066 in visibility, bias +0.003 (the plan's cone-scaled
 * form: 0.123). A narrow light near the horizon shadows even shallow relief (a texel is dark once the light sinks below
 * its horizon, so the shadowed share grows like cot(elevation), not like the cap's mean sin^2): there g takes the larger
 * GRAZE n^2 (1 / c - 1), n = (cos beta - GRAZE_CB) / (1 - GRAZE_CB), 0 at normal incidence and for wide caps. On rough
 * fields under 8-40 degree caps 70-84 degrees from the normal that cuts the rms error from 0.217 to 0.177 and the bias
 * from +0.10 to +0.06 (the old cone: bias -0.23, rms 0.37). There the clamp at 0 makes distant (mip-averaged) grout a
 * little darker than near. tests/materials/brdf.test.ts re-runs reduced versions of both fits. Skipped on pile layers
 * (BR_L_PILE.x > 0: the textile family's view-dependent pile visibility carries it).
 */
export const DIRVIS = {
  /** false: the legacy smoothstep cone (N.L against sqrt(1 - V)), kept for A/B checks */
  LINEAR: true,
  /** R_d = clamp(w / RD_W, 0, 1): the baked directionality w mixes the lamps' spread with the indirect share */
  RD_W: 0.8,
  /** cos(beta) floor once the light leaves the normal (fitted, see above) */
  CB_LOW: 0.55,
  /** scale of the closed-form 2m (fitted: zero mean bias against the reference) */
  K: 1.04,
  /** narrow light near the horizon: g >= GRAZE ((cos(beta) - GRAZE_CB) / (1 - GRAZE_CB))^2 (1 / c - 1) */
  GRAZE: 1.0,
  GRAZE_CB: 0.8,
} as const;

/** Half-width (in N.L) of the soft edge of the legacy cavity cone (DIRVIS.LINEAR false). */
export const CAV_CONE_SOFT = 0.15;

/** The cavity's share of the baked light's occlusion g for directionality w and geometric cosine c = N_g.L (TS twin of
 * FRAG_DIRVIS_GLSL; vis = 1 - (1 - V) g). */
export function dirVisG(w: number, c: number): number {
  const rd = Math.min(1, Math.max(0, w / DIRVIS.RD_W));
  const cc = Math.min(1, Math.max(0, c));
  const cb0 = Math.min(1, Math.max(0, 2 * rd - 1));
  const cb = Math.max(cb0, Math.min(Math.sqrt(1 - cc * cc), DIRVIS.CB_LOW));
  const cb2 = cb * cb, c2 = cc * cc;
  const n = Math.max(cb0 - DIRVIS.GRAZE_CB, 0) / (1 - DIRVIS.GRAZE_CB);
  return Math.max(DIRVIS.K * (2 - (1 + cb2) * c2 - 1.5 * (1 - cb2) * (1 - c2)), DIRVIS.GRAZE * n * n * (1 / Math.max(cc, 0.05) - 1));
}

/** Visibility of the baked directional light for the texture cavity V (TS twin of FRAG_DIRVIS_GLSL). */
export const dirVis = (v: number, w: number, c: number): number => Math.max(0, 1 - (1 - Math.min(1, Math.max(0, v))) * dirVisG(w, c));

/** Appended to the fragment common block. */
export const POM_PARS_GLSL = /* glsl */ `
// ---- parallax occlusion mapping (package B)
#ifdef BR_POM
#if BR_POM >= 2
#define BR_POM_MAX BR_POM_MAX_2
#define BR_POM_STEP_PX BR_POM_PX_PER_STEP_2
#else
#define BR_POM_MAX BR_POM_MAX_1
#define BR_POM_STEP_PX BR_POM_PX_PER_STEP
#endif
// texture height (normal.a) at uv through the rotated-tile transform of physical tiles (brRotUv), at an explicit
// isotropic LOD (the footprint's area): trilinear, never anisotropic, which is what makes 5-20 lookups per pixel
// affordable; the smoother height only softens the parallax at grazing angles. A ray that crosses a cell edge reads the
// neighbour tile as the shading will (tile corners never catch false shadows), but the cell's hashed transform is cached
// in (cell, M, b) and only re-derived when the ray enters another cell: texel uv = ( b + M ( uv cells - cell - 0.5 ) ) /
// cells. Start with cell = vec2( -1e9 ).
float brPomH( vec2 uv, vec2 cells, uint salt, float lf, float lod, inout vec2 cell, inout mat2 M, inout vec2 b ) {
	vec2 t = uv;
	if ( cells.x > 0.0 ) {
		vec2 cu = uv * cells;
		vec2 c = floor( cu );
		if ( c != cell ) {
			int ri;
			vec2 r = brRotUv( uv, cells, salt, M, ri );
			b = r * cells - M * ( cu - c - 0.5 );
			cell = c;
		}
		t = ( b + M * ( cu - c - 0.5 ) ) / cells;
	}
	return textureLod( uBrNormal, vec3( t, lf ), lod ).a;
}
#endif
`;

const DIRVIS_LINEAR_GLSL = /* glsl */ `
	// the texture cavity's visibility of the baked light (DIRVIS, TS twin dirVis), linear in V (mip-safe): the light
	// as a cap around brLv with cos(beta) = 2 R_d - 1, R_d ~ w / RD_W; g = K 2m, m the cap's cosine-weighted mean
	// sin^2 (hemisphere: 1/2), its part below the horizon cut (cb >= min(sin theta_L, CB_LOW)); a narrow light near the
	// horizon shadows at least GRAZE n^2 (1 / c - 1) (cot(elevation) growth). Not on pile layers.
	if ( BR_L_PILE[ brL ].x <= 0.0 ) {
		float brVc = min( brNgL, 1.0 );
		float brVc2 = brVc * brVc;
		float brVcb0 = clamp( 2.0 * brW / ${f(DIRVIS.RD_W)} - 1.0, 0.0, 1.0 );
		float brVcb = max( brVcb0, min( sqrt( 1.0 - brVc2 ), ${f(DIRVIS.CB_LOW)} ) );
		float brVcb2 = brVcb * brVcb;
		float brVn = max( brVcb0 - ${f(DIRVIS.GRAZE_CB)}, 0.0 ) * ${f(+(1 / (1 - DIRVIS.GRAZE_CB)).toPrecision(6))};
		float brVg = max( ${f(DIRVIS.K)} * ( 2.0 - ( 1.0 + brVcb2 ) * brVc2 - 1.5 * ( 1.0 - brVcb2 ) * ( 1.0 - brVc2 ) ),
			${f(DIRVIS.GRAZE)} * brVn * brVn * ( 1.0 / max( brVc, 0.05 ) - 1.0 ) );
		brDirVis *= max( 1.0 - ( 1.0 - clamp( brOrmh.r, 0.0, 1.0 ) ) * brVg, 0.0 );
	}
`;

const DIRVIS_CONE_GLSL = /* glsl */ `
	// legacy (DIRVIS.LINEAR false): the cavity's visibility cone, N.L > cos(alpha) = sqrt(1 - V) with a soft edge
	float brCosA = sqrt( 1.0 - clamp( brOrmh.r, 0.0, 1.0 ) );
	brDirVis *= smoothstep( brCosA - ${f(CAV_CONE_SOFT)}, brCosA + ${f(CAV_CONE_SOFT)}, dot( normal, brLv ) );
`;

/** Inline block in FRAG_LIGHTS_GLSL: multiplies brDirVis (the baked directional light's visibility). */
export const FRAG_DIRVIS_GLSL = /* glsl */ `
#ifndef BR_LITE
${DIRVIS.LINEAR ? DIRVIS_LINEAR_GLSL : DIRVIS_CONE_GLSL}#endif
#if defined( BR_POM ) && BR_POM >= 2
	if ( brPomOn ) {
		// POM self-shadow: from the parallax hit toward the light up to the relief top (the same faded depth as the
		// view march), in steps of the view march's pixel length, skipped when the shadow would be under half a pixel
		// long (light near the normal: floors under their lamps). brDirVis scales only the directional share w E, so
		// the occlusion applies in full (x w again left a fully occluded texel at w = 0.28 with 72 % of its light)
		float brPl = dot( brPomN, brLv );
		float brLen = brPomDepth * brPomK * ( 1.0 - brPomHitN ) * sqrt( max( 1.0 - brPl * brPl, 0.0 ) ) / ( max( brPl, 0.02 ) * brPomPx );
		if ( brPl > 0.02 && brLen > BR_POM_MIN_PX ) {
			vec2 brDuL = vec2( dot( brLv, brPomT ), dot( brLv, brPomB ) ) / brPomRep * ( brPomDepth * brPomK * ( 1.0 - brPomHitN ) / brPl );
			float brPTop = uBrLayerC[ brL ].y;
			float brOcc = 0.0;
			vec2 brSc = vec2( - 1e9 ), brSb = vec2( 0.0 );
			mat2 brSm = mat2( 1.0 );
			int brSn = clamp( int( ceil( brLen / BR_POM_STEP_PX ) ), 1, BR_POM_SH_STEPS );
			for ( int i = 1; i <= BR_POM_SH_STEPS; i ++ ) {
				if ( i > brSn ) break;
				// step midpoints: the end point is the relief top, where nothing below pomTop can occlude, so sampling
				// it wastes a lookup (and a 1-step shadow would never shade anything)
				float brT = ( float( i ) - 0.5 ) / float( brSn );
				float brRay = mix( brPomHitN, 1.0, brT );
				float brHs = brPomH( brUv + brDuL * brT, brLA.xy, brPomSalt, brLayerF, brPomLod, brSc, brSm, brSb ) / brPTop;
				brOcc = max( brOcc, ( brHs - brRay ) * BR_POM_SH_K * ( 1.0 - 0.5 * brT ) );
			}
			brDirVis *= 1.0 - clamp( brOcc, 0.0, 1.0 ) * brPomK;
		}
	}
#endif
`;
