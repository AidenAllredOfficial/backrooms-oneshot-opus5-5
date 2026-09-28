// src/materials/chunks/pom.ts — package B: parallax occlusion mapping of the shell (BR_POM = 1 steps only, 2 with
// self-shadow) and the directional-light visibility terms (the cavity's visibility cone, POM self-shadow).
// The view march itself sits in chunks/surface.ts FRAG_MAP_GLSL (it moves brUv before the base sampling); this file
// holds its height lookup and FRAG_DIRVIS_GLSL, which chunks/lighting.ts inlines inside `if ( brW > 0.0 )`, after the
// contact shadow and before RE_Direct: it may only multiply `float brDirVis` (brLv, brNg, brNgL in scope).

import { f } from './params.ts';

/** Half-width (in N.L) of the soft edge of the cavity's visibility cone (FRAG_DIRVIS_GLSL). */
export const CAV_CONE_SOFT = 0.15;

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

/** Inline block in FRAG_LIGHTS_GLSL: multiplies brDirVis (the baked directional light's visibility). */
export const FRAG_DIRVIS_GLSL = /* glsl */ `
#ifndef BR_LITE
	// the cavity's visibility cone (ambient aperture): the texture cavity V (ormh.r: grout, joints, pile gaps,
	// fissures) is the cosine-weighted visibility of a cone around the normal, V = sin^2(alpha), so the baked
	// directional light is seen while it stands inside the cone, N.L > cos(alpha) = sqrt(1 - V), with a soft edge.
	// (Chan's clamp(|N.L| + 2V^2 - 1) never fired: every layer's cavity p5 is >= 0.9, where it is 1 for N.L >= 0.38.)
	float brCosA = sqrt( 1.0 - clamp( brOrmh.r, 0.0, 1.0 ) );
	brDirVis *= smoothstep( brCosA - ${f(CAV_CONE_SOFT)}, brCosA + ${f(CAV_CONE_SOFT)}, dot( normal, brLv ) );
#endif
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
