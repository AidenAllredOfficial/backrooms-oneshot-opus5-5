// src/materials/chunks/bounce.ts — package F: the flashlight's one-bounce fill from CPU-placed VPLs
// (lighting/FlashlightBounce.ts). No samplers: uniform arrays of BR_FB_SLOTS lights (BR_BOUNCE_N 1 / 4 / 8: 1 on
// medium, 4 on high, 4 on ultra from 8 rays), camera-relative world space (the runtime uploads them relative to the
// frame's eye):
//   uFbP[k]   = (position, active 0/1)            uFbN[k] = (surface normal of the lit patch, isotropic share)
//   uFbC[k]   = (flux / PI per channel, eps2)     uFbBox[k] = the lit room's xz bounds (x0, z0, x1, z1)
//   uFbOn     = 1 while any VPL is active (the whole block is skipped otherwise, and in reflection passes)
// Each VPL is a Lambertian emitter on the patch its angular bin of the beam lights (medium's single VPL merges
// several patches: a shorter mean normal plus an isotropic share uFbN.w of the same total flux):
//   E += C * max(N.l, 0) * (max(N_k.-l, 0) + iso_k) * (1 - (d/R)^4)^2 * box(P) / (d^2 + eps2)
// eps2 is the patch radius^2 (the disc-source form), box cuts the fill at the walls of the lit room within their
// thickness. FRAG_BOUNCE_GLSL (inlined by chunks/lighting.ts after the ambient lines) adds it to the diffuse
// irradiance times the SSAO multi-bounce factor brSsC, and keeps it in brFbE for view=bounce.

import { BOUNCE, bounceSlots } from '../../lighting/FlashlightBounce.ts';
import { f } from './params.ts';

/** Lux shown as 1.0 in view=bounce. */
export const BOUNCE_DEBUG_LUX = 30;

/** Appended to the fragment common block. */
export const BOUNCE_GLSL = /* glsl */ `
// ---- flashlight bounce (package F)
#define BR_FB_DEBUG_LUX ${f(BOUNCE_DEBUG_LUX)}
#ifdef BR_BOUNCE_N
// the VPL slots the runtime fills for BR_BOUNCE_N (FlashlightBounce LAYOUT / bounceSlots: ultra's 8 rays merge into
// 4 slots, so its loop stops there instead of testing 4 slots that are never active)
#if BR_BOUNCE_N >= 8
#define BR_FB_SLOTS ${bounceSlots(8)}
#elif BR_BOUNCE_N >= 4
#define BR_FB_SLOTS ${bounceSlots(4)}
#else
#define BR_FB_SLOTS ${bounceSlots(1)}
#endif
#define BR_FB_INV_R2 ${f(1 / (BOUNCE.RANGE * BOUNCE.RANGE))}
#define BR_FB_SOFT ${f(BOUNCE.BOX_SOFT)}
// P, N: camera-relative world position and unit normal of the shaded point
vec3 brBounce( vec3 P, vec3 N ) {
	vec3 E = vec3( 0.0 );
	for ( int k = 0; k < BR_FB_SLOTS; k ++ ) {
		vec4 pk = uFbP[ k ];
		if ( pk.w < 0.5 ) continue; // uniform branch: inactive slot
		vec3 dv = pk.xyz - P;
		float d2 = dot( dv, dv );
		float q = d2 * BR_FB_INV_R2;
		if ( q >= 1.0 ) continue;
		// room box: a linear ramp over +-BR_FB_SOFT around the nearest xz face (inside the wall's thickness)
		vec4 b = uFbBox[ k ];
		vec4 e = vec4( P.xz - b.xy, b.zw - P.xz );
		float box = clamp( min( min( e.x, e.y ), min( e.z, e.w ) ) * ( 0.5 / BR_FB_SOFT ) + 0.5, 0.0, 1.0 );
		if ( box <= 0.0 ) continue;
		float win = 1.0 - q * q;
		vec3 l = dv * inversesqrt( max( d2, 1e-6 ) );
		float cr = max( dot( N, l ), 0.0 );
		vec4 nk = uFbN[ k ];
		float ce = max( - dot( nk.xyz, l ), 0.0 ) + nk.w; // w: the isotropic share of a merged VPL (medium)
		vec4 ck = uFbC[ k ];
		E += ck.rgb * ( cr * ce * win * win * box / ( d2 + ck.w ) );
	}
	return E;
}
#endif
`;

/** Inline block in FRAG_LIGHTS_GLSL after the ambient lines. */
export const FRAG_BOUNCE_GLSL = /* glsl */ `
vec3 brFbE = vec3( 0.0 ); // flashlight bounce irradiance (lux; view=bounce)
#ifdef BR_BOUNCE_N
if ( uFbOn > 0.5 && uBrReflPass < 0.5 ) {
	// the VPLs are camera-relative world: bring the fragment there (viewMatrix is a pure rotation + translation)
	brFbE = brBounce( ( vec4( geometryPosition, 0.0 ) * viewMatrix ).xyz, normalize( ( vec4( normal, 0.0 ) * viewMatrix ).xyz ) );
	irradiance += brFbE * brSsC;
}
#endif
`;
