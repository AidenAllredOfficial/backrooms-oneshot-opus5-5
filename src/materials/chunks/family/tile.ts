// src/materials/chunks/family/tile.ts — texture realism v2 family hooks: tile (VINYL_VCT, POOL_TILE, POOL_MOSAIC).
// Owns grime profile 5 (tile: those three and TERRAZZO). Lane C's file; hook points and rules in
// chunks/family/index.ts.

import type { FamilyHooks } from './index.ts';

export const TILE_HOOKS: FamilyHooks = {
  pars: '',
  postSample: '',
  postDetail: '',
  grime: /* glsl */ `
	else if ( brGrime == BR_G_TILE ) {
		// tile: grout grime (G). Grout = markedly rougher than the layer's mean AND low: height alone is ambiguous (WP8
		// tilts glazed tiles by +-1.5 deg, so tile corners sink to grout height)
		float brMuRough = textureLod( uBrOrmh, vec3( 0.5, 0.5, brLayerF ), 16.0 ).g;
		float grout = smoothstep( 0.12, 0.28, brOrmh.g - brMuRough ) * ( 1.0 - smoothstep( 0.35, 0.6, brNrm.w ) );
		brA *= mix( vec3( 1.0 ), vec3( 0.5, 0.52, 0.42 ), clamp( grout * ( brMask.g * 1.6 + 0.25 * g2.g ), 0.0, 1.0 ) );
		if ( ! brHoriz && brSubDepth > 0.0 ) {
			// pool walls: a limescale band just under the waterline, faint algae below it
			float lime = 1.0 - smoothstep( 0.035, 0.05, brSubDepth + ( g2.r - 0.5 ) * 0.02 );
			float algae = smoothstep( 0.03, 0.06, brSubDepth ) * ( 1.0 - smoothstep( 0.1, 0.3, brSubDepth + ( g1.r - 0.5 ) * 0.1 ) );
			brA *= mix( vec3( 1.0 ), vec3( 0.86, 0.84, 0.76 ), lime * ( 0.7 + 0.3 * g1.g ) );
			brA *= mix( vec3( 1.0 ), vec3( 0.8, 0.88, 0.72 ), algae * smoothstep( 0.3, 0.8, g1.g ) * 0.7 );
			brRoughMul *= mix( 1.0, 4.0, lime );
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
