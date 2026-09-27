// src/materials/chunks/gbuffer.ts — the specular G-buffer outputs of the surface programs (declared by package A,
// filled by package D). Only under BR_SSR, where ScenePass renders the opaque view into a 3-attachment target:
//  att1 = fallback specular x haze transmittance (rgb), specular weight Ws x T (a)
//  att2 = octahedral view normal (rg), lobe roughness (b)
// chunks/lighting.ts declares the split variables (brMrtSpec, brFbDir, brFbEnv, brFbSpec, brWs, brMrtRough) and
// chunks/haze.ts writes them at the very end. Writes to attachments the bound target lacks are dropped, so planar
// and probe captures stay safe; the depth prepass (colorWrite false) never touches the colour attachments.

/** Octahedral unit-vector encoding in [-1, 1]^2 (the twin of post/AmbientOcclusionPass.ts brOctEnc / brOctDec).
 * Guarded by BR_OCT_GLSL: chunks/screenspace.ts carries the same pair for the SSAO normals. */
export const OCT_GLSL = /* glsl */ `
#ifndef BR_OCT_GLSL
#define BR_OCT_GLSL
vec2 brOctEnc( vec3 n ) {
	n /= abs( n.x ) + abs( n.y ) + abs( n.z );
	vec2 e = n.xy;
	if ( n.z < 0.0 ) e = ( 1.0 - abs( n.yx ) ) * vec2( n.x >= 0.0 ? 1.0 : -1.0, n.y >= 0.0 ? 1.0 : -1.0 );
	return e;
}
vec3 brOctDec( vec2 e ) {
	vec3 n = vec3( e, 1.0 - abs( e.x ) - abs( e.y ) );
	if ( n.z < 0.0 ) n.xy = ( 1.0 - abs( n.yx ) ) * vec2( n.x >= 0.0 ? 1.0 : -1.0, n.y >= 0.0 ? 1.0 : -1.0 );
	return normalize( n );
}
#endif
`;

/** Appended to the fragment common block. */
export const GBUFFER_PARS_GLSL = /* glsl */ `
#ifdef BR_SSR
${OCT_GLSL}
layout( location = 1 ) out highp vec4 brOut1;
layout( location = 2 ) out highp vec4 brOut2;
#endif
`;
