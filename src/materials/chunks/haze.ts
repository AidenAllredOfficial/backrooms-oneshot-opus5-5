// src/materials/chunks/haze.ts — the fog_fragment replacement (it runs after colorspace_fragment in r186; every
// target we render into is linear): debug views, submerged optics (the water body's absorption and in-scatter
// live on the submerged surfaces, not on the transparent water mesh), per-fragment haze + edge fog + airlight
// (HAZE_FUNCS_GLSL in chunks/common.ts), decal premultiply and the HDR clamp; then, under BR_SSR, the specular
// G-buffer write (MRT attachments 1 and 2, chunks/gbuffer.ts).

import { FRAG_DEBUG_GLSL } from './debug.ts';

/** Level 0 carpet pile trap (see below): radiance scale and the saturation exponent on the albedo's chroma. */
export const CARPET_L0_PILE_TRAP = 0.55;
export const CARPET_L0_PILE_SAT = 0.3;

/** Replaces `#include <fog_fragment>` in the surface variants. */
export const FRAG_FOG_GLSL = /* glsl */ `
#define BR_PILE_TRAP ${CARPET_L0_PILE_TRAP.toFixed(4)}
#define BR_PILE_SAT ${CARPET_L0_PILE_SAT.toFixed(4)}
// ==== WP9 debug views / submerged optics / haze / HDR clamp
if ( uDebugView != 0 ) {
${FRAG_DEBUG_GLSL}
	gl_FragColor.rgb = brDbg * BR_DEBUG_NITS;
} else {
#ifndef BR_DECAL
	if ( brL == BR_M_CARPET_L0 ) {
		// Level 0 pile trap: the layer table albedo is the fibre colour (the bake's bounce uses it), but a damp cut
		// pile under overhead light traps part of it between the tufts, and what escapes has scattered through more
		// dyed fibre: darker and more saturated than a flat sample. Without this the floor, which receives ~2x the
		// wall irradiance, rendered as bright as the wallpaper (reference photo: clearly darker, mustard-brown).
		// Applied to the surface radiance only, before the submerged optics (FLOODED_HALL's carpet): the water's
		// in-scatter is not the carpet's to trap.
		vec3 brPa = max( diffuseColor.rgb, vec3( 1e-4 ) );
		gl_FragColor.rgb *= BR_PILE_TRAP * pow( brPa / max( max( brPa.r, brPa.g ), brPa.b ), vec3( BR_PILE_SAT ) );
	}
#endif
	if ( ( brF & BR_F_UNDERWATER ) != 0 ) {
		float brWy = brAuxB.w * 0.05 - 3.2;
		float brPy = vBrLocal.y; // storey-relative, like brWy
		if ( brWy > brPy ) {
			vec3 brVw = normalize( ( vec4( - vViewPosition, 0.0 ) * viewMatrix ).xyz ); // camera -> fragment, world axes
			float brPath = cameraPosition.y - uTileOrigin.y >= brWy ? ( brWy - brPy ) / max( abs( brVw.y ), 0.05 ) : length( vViewPosition );
			vec3 brT = exp( - BR_WATER_SIGMA * min( brPath, 60.0 ) );
			gl_FragColor.rgb = gl_FragColor.rgb * brT + ( 1.0 - brT ) * brIrrLocal * BR_WATER_INSCATTER * BR_WATER_INSCATTER_TINT;
		}
	}
	gl_FragColor.rgb = brHaze( gl_FragColor.rgb, brIrrLocal, - vViewPosition );
}
#ifdef BR_DECAL
gl_FragColor.rgb *= gl_FragColor.a; // premultiplied soft alpha (CustomBlending One, OneMinusSrcAlpha)
#endif
gl_FragColor.rgb = min( max( gl_FragColor.rgb, vec3( 0.0 ) ), vec3( BR_HDR_CLAMP ) );
#ifdef BR_SSR
{
	// specular G-buffer (package D fills the split in chunks/lighting.ts): att1 = fallback specular x haze
	// transmittance and Ws x T, att2 = oct view normal + lobe roughness. Decals blend att1 with (Zero,
	// OneMinusSrcAlpha) on alpha, which attenuates the surface's specular weight under them by their coverage; att2
	// keeps the surface below (src alpha 0).
	vec4 brO1 = vec4( 0.0 ), brO2 = vec4( 0.0 );
#ifndef BR_DECAL
	if ( uDebugView == 0 && brMrtSpec ) {
		float brT = brHazeT( - vViewPosition );
		brO1 = vec4( min( brFbSpec * brT, vec3( BR_HDR_CLAMP ) ), brWs * brT );
		brO2 = vec4( brOctEnc( normalize( normal ) ), brMrtRough, 1.0 );
	}
#else
	brO1 = vec4( 0.0, 0.0, 0.0, gl_FragColor.a );
#endif
	brOut1 = brO1;
	brOut2 = brO2;
}
#endif
`;
