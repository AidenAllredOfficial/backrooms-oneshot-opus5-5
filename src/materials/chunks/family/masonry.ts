// src/materials/chunks/family/masonry.ts — texture realism v2 family hooks: masonry (CMU_PAINTED, CMU_RAW). Owns
// grime profile 8 (masonry; it started as a verbatim copy of the concrete branch). Lane C's file; hook points and rules
// in chunks/family/index.ts.

import type { FamilyHooks } from './index.ts';

export const MASONRY_HOOKS: FamilyHooks = {
  pars: '',
  postSample: '',
  postDetail: '',
  grime: /* glsl */ `
	else if ( brGrime == BR_G_MASONRY ) {
		// concrete: oil and wet patches; floors: saw-cut control joints; walls: damp, efflorescence, tie-hole rust
		float oil = smoothstep( 0.55, 0.8, g1.b * 0.6 + brMask.g * 0.7 );
		if ( brHoriz ) oil = max( oil, brBlotch( brS2, true, 311u, 0.18, 0.15, 0.45, ( g2.b - 0.5 ) * 0.6 ) * 0.8 );
		brA *= mix( vec3( 1.0 ), vec3( 0.5, 0.48, 0.46 ), oil * 0.65 );
		brA *= mix( vec3( 1.0 ), vec3( 0.62, 0.58, 0.52 ), clamp( brMask.g * ( 0.4 + g2.g ), 0.0, 1.0 ) * 0.8 );
		if ( brHoriz && brL == BR_M_CONCRETE_FLOOR && brNWg.y > 0.0 ) {
			vec2 jd = abs( fract( brS2 / BR_CONCRETE_JOINT + 0.5 ) - 0.5 ) * BR_CONCRETE_JOINT; // m to the joint lines
			vec2 fw = max( fwidth( brS2 ), vec2( 1e-4 ) );
			float hw = 0.002 + 0.003 * smoothstep( 0.6, 0.9, g1.b ) + 0.0015 * ( g2.r - 0.5 ); // spalled edges
			vec2 ln = clamp( 2.0 * hw / fw, 0.0, 1.0 ) * ( 1.0 - smoothstep( vec2( hw ), hw + fw, jd ) );
			vec2 dz = 1.0 - smoothstep( 0.0, 0.03, jd ); // dirt collected beside the cut
			brA *= 1.0 - 0.6 * max( ln.x, ln.y ) - 0.08 * max( dz.x, dz.y );
		}
		if ( ! brHoriz ) {
			float s = brMask.r + ( g1.r - 0.5 ) * 0.3 * step( 0.02, brMask.r );
			float damp = smoothstep( 0.42, 0.5, s );
			float front = ( 1.0 - smoothstep( 0.0, 0.05, abs( s - 0.47 ) ) ) * step( 0.02, brMask.r );
			brA *= mix( 1.0, 0.78, damp );
			// efflorescence: white-grey salts at the drying front and in streaks down the damp area
			float eff = clamp( front * 0.8 + damp * smoothstep( 0.5, 0.8, g1.a ) * 0.7, 0.0, 1.0 );
			brA = mix( brA, vec3( 0.6, 0.59, 0.56 ), eff * 0.5 );
			brRoughMul *= mix( 1.0, 1.1, eff );
			if ( brL == BR_M_CONCRETE_WALL ) {
				// rust bleeding from some formwork tie holes (holes at along = 0.3 + 0.6 k, y = 0.375 + 0.75 k)
				float hx = ( floor( ( brS2.x - 0.3 ) / 0.6 + 0.5 ) ) * 0.6 + 0.3;
				float hy = ceil( ( brS2.y - 0.375 ) / 0.75 ) * 0.75 + 0.375;
				uint hh = brHash2u( brWrap( ivec2( int( floor( hx / 0.6 ) ), int( floor( hy / 0.75 ) ) ), ivec2( int( BR_NOISE_WRAP / 0.6 + 0.5 ), 4 ) ), 719u );
				float dy = hy - brS2.y;
				float L = 0.15 + 0.6 * brU01( brPcg( hh ) );
				float w = 0.008 + 0.03 * dy / L;
				float rs = step( brU01( hh ), 0.35 ) * exp( - ( brS2.x - hx ) * ( brS2.x - hx ) / ( w * w ) ) * ( 1.0 - smoothstep( 0.2, 1.0, dy / L ) ) * step( 0.01, dy );
				rs *= 0.5 + 0.5 * g1.a;
				brA = mix( brA, vec3( 0.32, 0.16, 0.07 ), rs * 0.6 );
			}
		}
		brRoughMul *= mix( 1.0, 0.7, oil );
	}
`,
  postWet: '',
  rough: '',
  normal: '',
  matPost: '',
  postLight: '',
  preFog: '',
};
