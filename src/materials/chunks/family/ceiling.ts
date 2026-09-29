// src/materials/chunks/family/ceiling.ts — texture realism v2 family hooks: ceilings (CEILING_TILE, PANEL_LENS,
// PLENUM). Owns grime profile 3 (ceilingTile). Lane D's file; hook points and rules in chunks/family/index.ts.
//
// Water stains are capillary fronts (the walls family's brWlFronts, chunks/family/walls.ts): the WP7 mask R is the
// wet extent around a leak (bake/mask.ts), and a few tiles carry an old stain of their own with a lobed outline. The
// fine field that roughens the fronts is the tile's own relief (water wicks along the fissures), the D5 multiplier and
// two world noise octaves. Each 0.6 m tile absorbs a little differently and its front spacing is its
// own, so a stain steps at the T-bars (water does not cross them). A few tiles are displaced (a dark plenum wedge at a
// lifted edge), sag or are replacements from another lot; their tilt is a world-space height gradient (brClBump) that
// the normal hook adds.

import { STAIN_FRONT } from '../grimeLib.ts';
import { f } from '../params.ts';
import type { FamilyHooks } from './index.ts';
import { WALL_STAIN } from './walls.ts';

/** Ceiling stain colours (linear multipliers): the tide-line deposit and the pale tan halo; RELIEF: the weight of the
 * tile's relief in the fine field. */
export const CEIL_STAIN = { TIDE: [0.58, 0.44, 0.26], HALO: [0.88, 0.8, 0.62], RELIEF: 0.5 } as const;

const v3 = (c: readonly number[]): string => `vec3( ${c.map(f).join(', ')} )`;

export const CEILING_HOOKS: FamilyHooks = {
  pars: /* glsl */ `
// ---- lane D ceiling stains (chunks/family/ceiling.ts; brWlFronts from chunks/family/walls.ts)
#define BR_CL_TIDE ${v3(CEIL_STAIN.TIDE)}
#define BR_CL_HALO ${v3(CEIL_STAIN.HALO)}
float brClNoise( vec2 s2, float c, uint salt ) { return brVNoise( s2 / c, ivec2( int( BR_NOISE_WRAP / c + 0.5 ) ), salt ); }
`,
  postSample: /* glsl */ `
vec2 brClBump = vec2( 0.0 ); // world relief gradient (d h / d x, d h / d z) of ceiling tiles for the normal hook
`,
  postDetail: '',
  grime: /* glsl */ `
	else if ( brGrime == BR_G_CEILINGTILE ) {
		// ceiling tile: water stains (mask R near leaks, and old stains on a few tiles), damp sag darkening, grime
		ivec2 cti = ivec2( floor( brS2 / 0.6 ) );
		ivec2 ctP = ivec2( int( BR_NOISE_WRAP / 0.6 + 0.5 ) );
		uint ht = brHash2u( brWrap( cti, ctP ), 503u );
		uint hs = brHash2u( brWrap( cti, ctP ), 509u );
		vec2 tfr = brS2 / 0.6 - vec2( cti );
		float clipT = smoothstep( 0.012, 0.03, min( min( tfr.x, 1.0 - tfr.x ), min( tfr.y, 1.0 - tfr.y ) ) * 0.6 );
		// fine field (low relief is wetter: the fissures steer the front) and the footprints, in uniform flow
		// (the tile's fissures are deep and texel-sharp: a light share)
		float clFine = clamp( ( brMuH - brNrm.w ) / 0.15, - 1.0, 1.0 ) * ${f(CEIL_STAIN.RELIEF)};
#if defined( BR_DETAIL_MAPS ) && ! defined( BR_DECAL )
		clFine += 1.6 * ( 1.0 - brAm );
#endif
		float clFp = 0.5 * ( fwidth( brS2.x ) + fwidth( brS2.y ) );
		vec2 clDx = dFdx( brS2 ), clDy = dFdy( brS2 );
		// the front footprint is the smooth field's: the fine field only moves the fronts (brWlFronts)
		// leak stains: the mask's wet extent, each tile absorbing a little differently (the fronts step at the T-bars)
		float cs = brMask.r * mix( 0.88, 1.12, brU01( brPcg( ht + 7u ) ) ) + 0.1 * ( g2.r - 0.5 ) * smoothstep( 0.02, 0.2, brMask.r );
		vec2 clDc = vec2( dFdx( cs ), dFdy( cs ) );
		float clW = ${f(STAIN_FRONT.W_PX)} * ( abs( clDc.x ) + abs( clDc.y ) );
		float clGs = - 1.0; // the metric gradient: solved below only on stained texels (or set by an old stain)
		// old water stains on a few tiles: an off-centre blotch with a lobed outline, clipped to the tile
		if ( brHoriz && brU01( hs ) < BR_CEIL_STAIN_P ) {
			vec2 ctr = 0.3 + 0.28 * vec2( brU01( brPcg( hs ) ), brU01( brPcg( hs + 1u ) ) ) - 0.14;
			float R = mix( 0.08, 0.26, brU01( brPcg( hs + 2u ) ) );
			vec2 sy = vec2( 1.0, mix( 0.75, 1.25, brU01( brPcg( hs + 3u ) ) ) );
			vec2 dv = ( tfr * 0.6 - ctr ) * sy;
			float th = atan( dv.y, dv.x );
			float Rl = R * ( 1.0 + 0.25 * sin( 3.0 * th + 6.283 * brU01( brPcg( hs + 5u ) ) ) + 0.15 * sin( 5.0 * th + 6.283 * brU01( brPcg( hs + 6u ) ) ) );
			float ts = ( BR_WL_L0 + 0.5 * ( 1.0 - length( dv ) / Rl ) ) * clipT;
			if ( ts > cs ) {
				cs = ts;
				// its screen footprint from the analytic gradient (anisotropic: a grazing view blurs only across)
				vec2 gts = - 0.5 / Rl * sy * dv / max( length( dv ), 1e-5 );
				clW = ${f(STAIN_FRONT.W_PX)} * ( abs( dot( gts, clDx ) ) + abs( dot( gts, clDy ) ) );
				clGs = length( gts );
			}
		}
		if ( cs > 0.02 ) {
			if ( clGs < 0.0 ) clGs = length( brWlGrad2( clDc, clDx, clDy ) );
			float n12 = ( brClNoise( brS2, 0.012, 811u ) - 0.5 ) * ( 1.0 - smoothstep( 0.2, 0.5, clFp / 0.012 ) );
			float n40 = ( brClNoise( brS2, 0.04, 823u ) - 0.5 ) * ( 1.0 - smoothstep( 0.2, 0.5, clFp / 0.04 ) );
			float sp = cs + clGs * ( ${f(WALL_STAIN.M_TEX)} * clFine + ${f(2 * WALL_STAIN.M_12)} * n12 + ${f(2 * WALL_STAIN.M_40)} * n40 );
			// per-tile front spacing (the hashed rings of brStainFront's spacing, one set per tile)
			float L1 = BR_WL_L0 + ${f(STAIN_FRONT.A1)} + ${f(STAIN_FRONT.B1)} * brU01( brPcg( hs + 11u ) );
			float L2 = L1 + ${f(STAIN_FRONT.A2)} + ${f(STAIN_FRONT.B2)} * brU01( brPcg( hs + 12u ) );
			float inside, tide;
			brWlFronts( sp, BR_WL_TIDE_M * clGs, clW, BR_WL_L0, L1, L2, inside, tide );
			brA *= mix( vec3( 1.0 ), BR_CL_HALO * mix( 0.93, 1.04, g2.r ), 0.4 * inside );
			brA *= mix( vec3( 1.0 ), BR_CL_TIDE, tide * ( 0.75 + 0.25 * g2.g ) );
			brRoughMul *= 1.0 + 0.05 * tide;
			// chronic leaks: mould specks inside the innermost front
			float mould = smoothstep( 0.65, 0.88, g1.g ) * smoothstep( L2, L2 + 0.08, sp );
			brA *= mix( vec3( 1.0 ), vec3( 0.3, 0.33, 0.25 ), 0.7 * mould );
		}
		// damp tiles sag and darken a little; dust near walls and fixtures (G)
		brA *= 1.0 - 0.06 * smoothstep( 0.35, 0.9, brMask.r + brMask.b * 0.5 );
		brA *= mix( vec3( 1.0 ), vec3( 0.72, 0.68, 0.6 ), clamp( brMask.g * ( 0.4 + 1.2 * g2.g ), 0.0, 1.0 ) * 0.45 );
		// a few yellowed tiles (hash per 0.6 m ceiling tile)
		brA *= mix( vec3( 1.0 ), vec3( 0.93, 0.88, 0.74 ), step( 0.86, brU01( ht ) ) * brU01( brPcg( ht ) ) );
		// tile states: 3 % displaced (one edge lifted off its flange: a dark plenum wedge opening to 15 mm along that
		// edge, the face tilted 2 degrees), 12 % sagging with humidity (0.7 degrees at the edges, the centre a shade
		// darker), 6 % replacements from another lot (whiter, less yellow). The T-bar (brAux = 1 - bar) stays put
		if ( BR_DETAIL == 1 && brHoriz ) {
			float us = brU01( brPcg( ht + 31u ) );
			vec2 lc = ( tfr - 0.5 ) * 0.6; // metres from the tile centre
			if ( us < 0.03 ) {
				uint he = brPcg( ht + 37u );
				uint ed = he & 3u;
				vec2 ax = ed == 0u ? vec2( 1.0, 0.0 ) : ed == 1u ? vec2( - 1.0, 0.0 ) : ed == 2u ? vec2( 0.0, 1.0 ) : vec2( 0.0, - 1.0 );
				float de = 0.3 - dot( lc, ax ); // metres from the lifted edge
				float t = dot( lc, vec2( - ax.y, ax.x ) ) / 0.6 + 0.5;
				float gap = 0.015 * ( ( he & 4u ) != 0u ? t : 1.0 - t );
				float wedge = smoothstep( 0.012 - clFp, 0.012 + clFp, de ) * ( 1.0 - smoothstep( 0.012 + gap - clFp, 0.012 + gap + clFp, de ) );
				brA = mix( brA, vec3( 0.02 ), wedge );
				brOrmh.r = mix( brOrmh.r, 0.1, wedge );
				brClBump -= ax * ( 0.035 * brAux );
			} else if ( us < 0.15 ) {
				brClBump -= lc * ( 0.012 / 0.3 * brAux );
				brA *= 1.0 - 0.03 * brAux * max( 1.0 - dot( lc, lc ) / 0.09, 0.0 );
			} else if ( us < 0.21 ) {
				vec3 fr = brA * vec3( 1.08, 1.08, 1.1 );
				brA = mix( brA, mix( fr, vec3( brLuma( fr ) ), 0.3 ), brAux );
			}
		}
	}
`,
  postWet: '',
  rough: '',
  normal: /* glsl */ `
#if BR_DETAIL == 1
// lane D ceilings: the tile states' tilt and sag on the world (x, z) axes: n = N - dh/dx X - dh/dz Z
if ( brClBump.x != 0.0 || brClBump.y != 0.0 ) {
	normal = normalize( normal - brClBump.x * ( viewMatrix * vec4( 1.0, 0.0, 0.0, 0.0 ) ).xyz - brClBump.y * ( viewMatrix * vec4( 0.0, 0.0, 1.0, 0.0 ) ).xyz );
}
#endif
`,
  matPost: '',
  postLight: '',
  preFog: '',
};
