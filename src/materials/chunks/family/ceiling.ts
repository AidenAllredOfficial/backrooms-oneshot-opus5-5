// src/materials/chunks/family/ceiling.ts — texture realism v2 family hooks: ceilings (CEILING_TILE, PANEL_LENS,
// PLENUM). Owns grime profile 3 (ceilingTile). Lane D's file; hook points and rules in chunks/family/index.ts.

import type { FamilyHooks } from './index.ts';

export const CEILING_HOOKS: FamilyHooks = {
  pars: '',
  postSample: '',
  postDetail: '',
  grime: /* glsl */ `
	else if ( brGrime == BR_G_CEILINGTILE ) {
		// ceiling tile: stain rings (R and iso-rings), sag darkening, grime
		float s = brMask.r;
		float ring = smoothstep( 0.75, 0.95, fract( s * 3.0 + g1.r * 0.25 ) ) * step( 0.04, s );
		brA *= mix( vec3( 1.0 ), vec3( 0.78, 0.66, 0.45 ), smoothstep( 0.05, 0.6, s ) * 0.55 );
		brA *= mix( vec3( 1.0 ), vec3( 0.55, 0.43, 0.27 ), ring * 0.6 );
		brA *= 1.0 - 0.18 * smoothstep( 0.35, 0.9, s + brMask.b * 0.5 );
		brA *= mix( vec3( 1.0 ), vec3( 0.72, 0.68, 0.6 ), clamp( brMask.g * ( 0.4 + 1.2 * g2.g ), 0.0, 1.0 ) * 0.45 );
		// a few yellowed tiles (hash per 0.6 m ceiling tile)
		ivec2 cti = ivec2( floor( brS2 / 0.6 ) );
		ivec2 ctP = ivec2( int( BR_NOISE_WRAP / 0.6 + 0.5 ) );
		uint ht = brHash2u( brWrap( cti, ctP ), 503u );
		brA *= mix( vec3( 1.0 ), vec3( 0.93, 0.88, 0.74 ), step( 0.86, brU01( ht ) ) * brU01( brPcg( ht ) ) );
		// old water stains on a few tiles: an off-centre blotch with 1-3 brown tide rings, clipped to the tile
		uint hs = brHash2u( brWrap( cti, ctP ), 509u );
		if ( brHoriz && brU01( hs ) < BR_CEIL_STAIN_P ) {
			vec2 tfr = brS2 / 0.6 - vec2( cti );
			vec2 ctr = 0.3 + 0.28 * vec2( brU01( brPcg( hs ) ), brU01( brPcg( hs + 1u ) ) ) - 0.14;
			float R = mix( 0.08, 0.26, brU01( brPcg( hs + 2u ) ) );
			vec2 dv = ( tfr * 0.6 - ctr ) * vec2( 1.0, mix( 0.75, 1.25, brU01( brPcg( hs + 3u ) ) ) );
			float d = length( dv ) / R + ( g1.r - 0.5 ) * 0.5 + ( g2.b - 0.5 ) * 0.15;
			int nr = 1 + int( brU01( brPcg( hs + 4u ) ) * 2.99 );
			float clipT = smoothstep( 0.012, 0.03, min( min( tfr.x, 1.0 - tfr.x ), min( tfr.y, 1.0 - tfr.y ) ) * 0.6 );
			float inside = ( 1.0 - smoothstep( 0.9, 1.0, d ) ) * clipT;
			float rings = 0.0;
			for ( int k = 0; k < 3; k ++ ) {
				if ( k >= nr ) break;
				float rk = 1.0 - float( k ) * 0.3;
				rings = max( rings, ( 1.0 - smoothstep( 0.0, 0.05, abs( d - rk ) ) ) * ( 1.0 - 0.25 * float( k ) ) );
			}
			brA *= mix( vec3( 1.0 ), vec3( 0.88, 0.8, 0.6 ), inside * ( 0.45 + 0.25 * g2.r ) );
			brA *= mix( vec3( 1.0 ), vec3( 0.6, 0.47, 0.3 ), rings * clipT * 0.7 );
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
