// src/materials/chunks/debug.ts — debug views (int uniform uDebugView, DEBUG_VIEW_NAMES order; no recompiles).
// Each view writes a display value v in [0, 1] as v * BR_DEBUG_NITS nits, so it reads as v at the L0 reference
// exposure (EV100 9.4) of the post stack. Runs instead of haze. Index 63 (not in DEBUG_VIEW_NAMES) is a
// WP9-private view: the anti-tiling rotation class, used by the materials dev harness.
// Views 16-23 belong to the graphics-realism packages; each owner replaces its stub line (black until then).
// The shell's LIGHT_VOLUME view shows the light-volume coordinate instead of sampling uVolA: non-props programs must
// not reference that sampler (surface sampler budget, tests/materials/samplerBudget.test.ts).

import { DebugView } from '../../core/ids.ts';

export const DEBUG_VIEW_ROTATION = 63;

/** Inline block inside the fog_fragment replacement; sets `vec3 brDbg`. */
export const FRAG_DEBUG_GLSL = /* glsl */ `
vec3 brDbg = vec3( 0.0 );
{
	int dv = uDebugView;
	if ( dv == ${DebugView.ALBEDO} ) brDbg = diffuseColor.rgb;
	else if ( dv == ${DebugView.NORMAL} ) brDbg = brNWp * 0.5 + 0.5;
	else if ( dv == ${DebugView.ROUGHNESS} ) brDbg = vec3( material.roughness );
	else if ( dv == ${DebugView.LIGHTMAP} ) brDbg = brIrrLocal / BR_DEBUG_LUX;
	else if ( dv == ${DebugView.DIRECTIONALITY} ) brDbg = vec3( brW );
	else if ( dv == ${DebugView.AO} ) brDbg = vec3( brAO );
	else if ( dv == ${DebugView.FLICKER} ) brDbg = brEf / BR_DEBUG_LUX + vec3( brFl.r + brFl.a, brFl.g + brFl.a, brFl.b ) / ( 4.0 * BR_DEBUG_LUX );
	else if ( dv == ${DebugView.MASK} ) brDbg = brMask.rgb + brMask.a * vec3( 0.6, 0.45, 0.0 );
	else if ( dv == ${DebugView.LAYER} ) brDbg = brHashColor( uint( brL ) * 7u + 1u );
	else if ( dv == ${DebugView.TEXEL} ) {
#ifdef BR_LV
		ivec3 tc = ivec3( floor( vBrLocal / BR_LV_STEP ) );
		float ck = float( ( tc.x + tc.y + tc.z ) & 1 );
#else
		vec2 tsz = vec2( textureSize( uLmIrr, 0 ) );
		ivec2 tc = ivec2( floor( vBrLmUv * tsz ) );
		float ck = float( ( tc.x + tc.y ) & 1 );
#endif
		brDbg = mix( vec3( 0.25 ), vec3( 0.75 ), ck ) * mix( vec3( 1.0 ), brHashColor( uint( brL ) + 3u ), 0.25 );
	}
	else if ( dv == ${DebugView.ZONE} ) {
		// zone palettes share (layer, tint): hash them
		uvec3 t8 = uvec3( floor( vBrTint.rgb * 31.0 + 0.5 ) );
		brDbg = brHashColor( uint( brL ) * 131u + t8.r * 7u + t8.g * 1031u + t8.b * 65537u );
	}
	else if ( dv == ${DebugView.ROOM} ) {
		brDbg = ( brF & BR_F_FLOOR_AUX ) != 0 ? brHashColor( uint( brAuxB.y + 256.0 * brAuxB.z ) * 2654435761u ) : vec3( 0.15 );
	}
	else if ( dv == ${DebugView.UV} ) brDbg = vec3( fract( vBrUv ), 0.0 );
	else if ( dv == ${DebugView.EMISSION} ) {
		vec2 uvF = ( vBrLocal.xz + BR_EM_MARGIN ) / ( BR_EM_RES * BR_EM_TEXEL );
		brDbg = textureLod( uEmission, uvF, 0.0 ).rgb / 6600.0 + brRefl / 60.0 + totalEmissiveRadiance / 6600.0;
	}
	else if ( dv == ${DebugView.LIGHT_VOLUME} ) {
#ifdef BR_LV
		brDbg = brLmA.rgb / BR_DEBUG_LUX;
#else
		// the shell has no light volume (and must not reference uVolA): show the volume coordinate a prop would
		// sample here, 0.3 m off the surface (u = x / tile, v = the non-uniform LV level, w = z / tile)
		vec3 lp = vBrLocal + brNWg * 0.3;
		brDbg = vec3( lp.x / BR_TILE, brLvV( lp.y ), lp.z / BR_TILE );
#endif
	}
	else if ( dv == ${DebugView.WETNESS} ) brDbg = vec3( 0.0 ); // package B
	else if ( dv == ${DebugView.HEIGHT} ) brDbg = vec3( 0.0 ); // package B
	else if ( dv == ${DebugView.VOLUMETRIC} ) brDbg = vec3( 0.0 ); // package F
	else if ( dv == ${DebugView.BOUNCE} ) brDbg = brFbE / BR_FB_DEBUG_LUX; // package F: flashlight bounce irradiance
	else if ( dv == ${DebugView.WATER} ) brDbg = vec3( 0.0 ); // package E
	else if ( dv == ${DebugView.PROBE} ) brDbg = vec3( 0.0 ); // package D
	else if ( dv == ${DebugView.SPECW} ) brDbg = vec3( 0.0 ); // package D
	else if ( dv == ${DebugView.SSAO} ) {
		// package A: the screen-space AO (after its exponent) in grey, the contact shadow of the baked directional
		// light in red
		brDbg = vec3( brSs ) * mix( vec3( 1.0, 0.15, 0.15 ), vec3( 1.0 ), brCs );
	}
	else if ( dv == ${DEBUG_VIEW_ROTATION} ) brDbg = vec3( float( brRotIdx + 1 ) / 8.0 ); // 0 = not a rotated-tile layer
}
`;
