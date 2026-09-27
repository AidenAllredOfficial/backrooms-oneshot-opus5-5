// src/materials/chunks/volumetric.ts — package F: the froxel volume lookup under BR_VOLUMETRIC (post/VolumetricFog.ts:
// uVolTex = integrated in-scatter rgb and transmittance a from the camera to each slice's far boundary, the slices
// tiled uVolGrid.w per row into a 2D atlas; uVolGrid = (W, H, N, per row), uVolZ = (zN, zF, (N - 1) / ln(zF / zN),
// on), uVolScreen = 1 / the target size). The haze API brHaze / brHazeT (chunks/common.ts HAZE_FUNCS_GLSL) dispatches
// to it on high / ultra outside reflection passes.
//
// Included twice on purpose: in the surface programs' fragment common block (A.0 slot) and again at the top of
// HAZE_FUNCS_GLSL, so the water shader, which takes the haze functions but not the surface common block, gets it too;
// the guard keeps one definition. Fragment only (gl_FragCoord).

/** view=volumetric: the in-scatter from the camera to the surface shown as 1.0 at this many nits (and 1 - the
 * transmittance in blue). */
export const VOL_DEBUG_NITS = 8;

/** Appended to the fragment common block (and prepended to HAZE_FUNCS_GLSL). */
export const VOLUMETRIC_GLSL = /* glsl */ `
#if defined( BR_VOLUMETRIC ) && ! defined( BR_VOL_LOOKUP )
#define BR_VOL_LOOKUP
#define BR_VOL_DEBUG_NITS ${VOL_DEBUG_NITS.toFixed(1)}
// slice k of the atlas at screen uv: bilinear inside the slice's tile, the pixel position clamped half a texel in
// from its edges, so nothing bleeds between neighbouring slices
vec4 brVolSlice( float k, vec2 uv ) {
	vec2 g = uVolGrid.xy;
	vec2 px = clamp( uv * g, vec2( 0.5 ), g - 0.5 );
	float ty = floor( k / uVolGrid.w );
	vec2 t = vec2( k - ty * uVolGrid.w, ty );
	return textureLod( uVolTex, ( t * g + px ) / vec2( textureSize( uVolTex, 0 ) ), 0.0 );
}
// in-scatter (rgb) and transmittance (a) from the camera to view-space position viewPos (up to zF)
vec4 brVolLookup( vec3 viewPos ) {
	vec2 uv = gl_FragCoord.xy * uVolScreen;
	float z = max( - viewPos.z, 0.0 );
	float s = z < uVolZ.x ? z / uVolZ.x : 1.0 + log( z / uVolZ.x ) * uVolZ.z;
	s = clamp( s, 0.0, uVolGrid.z );
	// between boundaries b0 and b0 + 1: texel b0 - 1 ends at b0, texel b0 at b0 + 1 (texel -1: nothing yet)
	float b0 = min( floor( s ), uVolGrid.z - 1.0 );
	vec4 v0 = b0 < 0.5 ? vec4( 0.0, 0.0, 0.0, 1.0 ) : brVolSlice( b0 - 1.0, uv );
	vec4 v1 = brVolSlice( b0, uv );
	return mix( v0, v1, s - b0 );
}
#endif
`;
