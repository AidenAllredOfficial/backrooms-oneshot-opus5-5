// src/materials/chunks/pom.ts — package B: parallax occlusion mapping of the shell (BR_POM = 1 steps only, 2 with
// self-shadow) and the directional-light visibility terms (micro-shadowing, POM self-shadow).
// The view march itself sits in chunks/surface.ts FRAG_MAP_GLSL (it moves brUv before the base sampling); this file
// holds its height lookup and FRAG_DIRVIS_GLSL, which chunks/lighting.ts inlines inside `if ( brW > 0.0 )`, after the
// contact shadow and before RE_Direct: it may only multiply `float brDirVis` (brLv, brNg, brNgL in scope).

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
// texture height (normal.a) at uv through the rotated-tile transform of physical tiles (brRotUv, per lookup: a march
// or shadow ray that crosses a cell edge reads the neighbour tile as the shading will, so tile corners never catch false
// shadows), at an explicit isotropic LOD (the footprint's area): trilinear, never anisotropic, which is what makes 5-20
// lookups per pixel affordable; the smoother height only softens the parallax at grazing angles
float brPomH( vec2 uv, vec2 cells, uint salt, float lf, float lod ) {
	vec2 t = uv;
	if ( cells.x > 0.0 ) {
		mat2 M;
		int ri;
		t = brRotUv( uv, cells, salt, M, ri );
	}
	return textureLod( uBrNormal, vec3( t, lf ), lod ).a;
}
#endif
`;

/** Inline block in FRAG_LIGHTS_GLSL: multiplies brDirVis (the baked directional light's visibility). */
export const FRAG_DIRVIS_GLSL = /* glsl */ `
#ifndef BR_LITE
	// micro-shadowing (Chan 2018): the texture cavities (ormh.r: grout, joints, pile gaps, fissures) shadow the baked
	// directional light, the more the more it grazes the mapped normal
	brDirVis *= clamp( abs( dot( normal, brLv ) ) + 2.0 * brOrmh.r * brOrmh.r - 1.0, 0.0, 1.0 );
#endif
#if defined( BR_POM ) && BR_POM >= 2
	if ( brPomOn ) {
		// POM self-shadow: from the parallax hit toward the light up to the relief top (the same faded depth as the
		// view march); a less directional bake (small w) is shadowed less
		float brPl = dot( brPomN, brLv );
		if ( brPl > 0.02 ) {
			vec2 brDuL = vec2( dot( brLv, brPomT ), dot( brLv, brPomB ) ) / brPomRep * ( brPomDepth * brPomK * ( 1.0 - brPomHitN ) / brPl );
			float brPTop = uBrLayerC[ brL ].y;
			float brOcc = 0.0;
			for ( int i = 1; i <= BR_POM_SH_STEPS; i ++ ) {
				float brT = float( i ) / float( BR_POM_SH_STEPS );
				float brRay = mix( brPomHitN, 1.0, brT );
				float brHs = brPomH( brUv + brDuL * brT, brLA.xy, brPomSalt, brLayerF, brPomLod ) / brPTop;
				brOcc = max( brOcc, ( brHs - brRay ) * BR_POM_SH_K * ( 1.0 - 0.5 * brT ) );
			}
			brDirVis *= 1.0 - clamp( brOcc, 0.0, 1.0 ) * brPomK * brW;
		}
	}
#endif
`;
