// src/materials/chunks/family/walls.ts — texture realism v2 family hooks: wall coverings and paint (WALLPAPER_L0,
// WALLPAPER_MANILA, DRYWALL, TRIM_PAINT). Owns grime profiles 2 (wallpaper) and 7 (paint: DRYWALL, TRIM_PAINT; it
// started as a verbatim copy of the wallpaper branch). Lane D's file; hook points and rules in chunks/family/index.ts.

import type { FamilyHooks } from './index.ts';

export const WALL_HOOKS: FamilyHooks = {
  pars: '',
  postSample: '',
  postDetail: '',
  grime: /* glsl */ `
	else if ( brGrime == BR_G_WALLPAPER ) {
		// wallpaper: tide-band stains (R: leaks, rising damp, ceiling seepage; sharp edge from grime.r), dirt / dust /
		// hand smudges (G), peeling at roll seams (A)
		float s = brMask.r + ( g1.r - 0.5 ) * 0.3 * step( 0.02, brMask.r );
		float stain = smoothstep( 0.42, 0.5, s );
		float tide = ( 1.0 - smoothstep( 0.0, 0.045, abs( s - 0.46 ) ) ) * step( 0.02, brMask.r );
		brA *= mix( vec3( 1.0 ), BR_WALL_STAIN * mix( 0.92, 1.05, g2.r ), stain * 0.7 );
		brA *= mix( vec3( 1.0 ), BR_WALL_TIDE, tide * 0.75 );
		brA *= 1.0 - 0.25 * g1.a * stain;
		brA *= mix( vec3( 1.0 ), BR_WALL_DIRT, clamp( brMask.g * ( 0.45 + 0.9 * g2.g ), 0.0, 1.0 ) );
		float seamM = abs( fract( brUv.x * 2.0 + 0.5 ) - 0.5 ) * 0.5 * brLB.x; // metres to the nearest 0.6 m roll seam
		float seam = 1.0 - smoothstep( 0.0, 0.07, seamM );
		float peel = smoothstep( 0.55, 0.7, brMask.a * ( 0.45 + 0.8 * seam ) + ( g2.b - 0.5 ) * 0.3 );
		brA = mix( brA, BR_WALL_BACKING, peel );
		brNrm.x += peel * ( 1.0 - peel ) * 2.4 * brNrm.z; // lifted edge catches the light
		brRoughMul *= mix( 1.0, 0.9, stain );
		float mould = smoothstep( 0.6, 0.85, g2.g ) * clamp( brMask.b + brMask.r * 0.5, 0.0, 1.0 );
		brA *= mix( vec3( 1.0 ), vec3( 0.45, 0.47, 0.38 ), mould * 0.6 );
		if ( BR_DETAIL == 1 && ! brHoriz ) {
			// sun-less "fades": large soft paler patches
			float fz = smoothstep( 0.62, 0.9, brSurfNoise( brS2, false, BR_FEATURE_CELL, BR_FEATURE_P, BR_FEATURE_CELL_Y, BR_FEATURE_PY, 401u ) );
			brA = mix( brA, vec3( brLuma( brA ) ) * vec3( 1.1, 1.06, 0.95 ), fz * 0.22 );
		}
	}
	else if ( brGrime == BR_G_PAINT ) {
		// wallpaper: tide-band stains (R: leaks, rising damp, ceiling seepage; sharp edge from grime.r), dirt / dust /
		// hand smudges (G), peeling at roll seams (A)
		float s = brMask.r + ( g1.r - 0.5 ) * 0.3 * step( 0.02, brMask.r );
		float stain = smoothstep( 0.42, 0.5, s );
		float tide = ( 1.0 - smoothstep( 0.0, 0.045, abs( s - 0.46 ) ) ) * step( 0.02, brMask.r );
		brA *= mix( vec3( 1.0 ), BR_WALL_STAIN * mix( 0.92, 1.05, g2.r ), stain * 0.7 );
		brA *= mix( vec3( 1.0 ), BR_WALL_TIDE, tide * 0.75 );
		brA *= 1.0 - 0.25 * g1.a * stain;
		brA *= mix( vec3( 1.0 ), BR_WALL_DIRT, clamp( brMask.g * ( 0.45 + 0.9 * g2.g ), 0.0, 1.0 ) );
		float seamM = abs( fract( brUv.x * 2.0 + 0.5 ) - 0.5 ) * 0.5 * brLB.x; // metres to the nearest 0.6 m roll seam
		float seam = 1.0 - smoothstep( 0.0, 0.07, seamM );
		float peel = smoothstep( 0.55, 0.7, brMask.a * ( 0.45 + 0.8 * seam ) + ( g2.b - 0.5 ) * 0.3 );
		brA = mix( brA, BR_WALL_BACKING, peel );
		brNrm.x += peel * ( 1.0 - peel ) * 2.4 * brNrm.z; // lifted edge catches the light
		brRoughMul *= mix( 1.0, 0.9, stain );
		float mould = smoothstep( 0.6, 0.85, g2.g ) * clamp( brMask.b + brMask.r * 0.5, 0.0, 1.0 );
		brA *= mix( vec3( 1.0 ), vec3( 0.45, 0.47, 0.38 ), mould * 0.6 );
		if ( BR_DETAIL == 1 && ! brHoriz ) {
			// sun-less "fades": large soft paler patches
			float fz = smoothstep( 0.62, 0.9, brSurfNoise( brS2, false, BR_FEATURE_CELL, BR_FEATURE_P, BR_FEATURE_CELL_Y, BR_FEATURE_PY, 401u ) );
			brA = mix( brA, vec3( brLuma( brA ) ) * vec3( 1.1, 1.06, 0.95 ), fz * 0.22 );
		}
	}
`,
  postWet: '',
  rough: '',
  normal: '',
  matPost: '',
  postLight: '',
  preFog: '',
};
