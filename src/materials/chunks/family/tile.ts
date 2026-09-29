// src/materials/chunks/family/tile.ts — texture realism v2 family hooks: tile (VINYL_VCT, POOL_TILE, POOL_MOSAIC).
// Owns grime profile 5 (tile: those three and TERRAZZO). Lane C's file; hook points and rules in
// chunks/family/index.ts.

import { NOISE_WRAP, STOREY_PITCH } from '../../../core/constants.ts';
import { Mat } from '../../../core/ids.ts';
import type { FamilyHooks } from './index.ts';

/** World-space grout colour along the lines of POOL_TILE / POOL_MOSAIC (their ormh.a is the grout coverage): value
 * noise on two cells (m, dividing NOISE_WRAP and STOREY_PITCH), albedo x (1 - amp / 2 + amp n). Per-tile content is
 * rotated by the shader, so a texture-space variation would split every grout line down its middle. */
export const GROUT_VARIATION = { cells: [0.025, 0.1] as const, amp: 0.32 };
/** Pool deck glaze: up-facing, non-submerged POOL_TILE is dulled by foot traffic and cleaning to this roughness
 * (added in alpha^2 over the glaze lobe); a water film still makes the splash band glossy. Art direction: the
 * glossy pool look stays, only the dry-deck mirror goes. */
export const POOL_DECK_ROUGH = 0.17;
/** VCT traffic and maintenance (grime 'tile' on up-facing VINYL_VCT): lane wear from mask A (the bake's hard-floor
 * wear; roughness + LANE_ROUGH x wear, a little lighter and greyer), the amber wax build-up in a WAX_BAND m band along
 * the walls (glossier), and heel marks (a 0.24 m world lattice, HEEL_P of the cells, more in the lanes). */
export const VCT_WEAR = {
  LANE_ROUGH: 0.22, WAX_BAND: [0.02, 0.05] as const, WAX_TINT: [0.86, 0.8, 0.66] as const, HEEL_CELL: 0.24, HEEL_P: 0.1,
};
/** Development switch: 1 replaces VCT's mask A by a synthetic lane field (until the hard-floor wear bake lands). */
const VCT_SYNTH_WEAR = 0;

const f = (x: number): string => (Number.isInteger(x) ? `${x}.0` : String(x));
const v3 = (c: readonly number[]): string => `vec3( ${c.map(f).join(', ')} )`;
const G = GROUT_VARIATION;
const W = VCT_WEAR;
const wrap = (cell: number): number => Math.round(NOISE_WRAP / cell);
const wrapY = (cell: number): number => Math.round(STOREY_PITCH / cell);

export const TILE_HOOKS: FamilyHooks = {
  pars: /* glsl */ `
#define BR_M_POOL_MOSAIC ${Mat.POOL_MOSAIC}
#define BR_M_VINYL_VCT ${Mat.VINYL_VCT}
`,
  postSample: /* glsl */ `
float brTlWear = 0.0; // VCT lane wear (grime 'tile'), read by the rough hook
if ( BR_DETAIL == 1 && ( brL == BR_M_POOL_TILE || brL == BR_M_POOL_MOSAIC ) ) {
	// grout colour along the lines, world-anchored (brAux: grout coverage)
	float n = 0.6 * brSurfNoise( brS2, brHoriz, ${f(G.cells[0])}, ${wrap(G.cells[0])}, ${f(G.cells[0])}, ${wrapY(G.cells[0])}, 1401u )
		+ 0.4 * brSurfNoise( brS2, brHoriz, ${f(G.cells[1])}, ${wrap(G.cells[1])}, ${f(G.cells[1])}, ${wrapY(G.cells[1])}, 1402u );
	brA *= mix( 1.0, ${f(1 - G.amp / 2)} + ${f(G.amp)} * n, brAux );
}
`,
  postDetail: '',
  grime: /* glsl */ `
	else if ( brGrime == BR_G_TILE ) {
		// tile: grout grime (G). POOL_TILE / POOL_MOSAIC carry their grout coverage in brAux; the others: grout =
		// markedly rougher than the layer's mean AND low (height alone is ambiguous: tilted tiles' corners sink to
		// grout height)
		float grout;
		if ( brL == BR_M_POOL_TILE || brL == BR_M_POOL_MOSAIC ) grout = brAux;
		else {
			float brMuRough = textureLod( uBrOrmh, vec3( 0.5, 0.5, brLayerF ), 16.0 ).g;
			grout = smoothstep( 0.12, 0.28, brOrmh.g - brMuRough ) * ( 1.0 - smoothstep( 0.35, 0.6, brNrm.w ) );
		}
		brA *= mix( vec3( 1.0 ), vec3( 0.5, 0.52, 0.42 ), clamp( grout * ( brMask.g * 1.6 + 0.25 * g2.g ), 0.0, 1.0 ) );
		if ( ! brHoriz && brSubDepth > 0.0 ) {
			// pool walls: a limescale band just under the waterline, faint algae below it
			float lime = 1.0 - smoothstep( 0.035, 0.05, brSubDepth + ( g2.r - 0.5 ) * 0.02 );
			float algae = smoothstep( 0.03, 0.06, brSubDepth ) * ( 1.0 - smoothstep( 0.1, 0.3, brSubDepth + ( g1.r - 0.5 ) * 0.1 ) );
			brA *= mix( vec3( 1.0 ), vec3( 0.86, 0.84, 0.76 ), lime * ( 0.7 + 0.3 * g1.g ) );
			brA *= mix( vec3( 1.0 ), vec3( 0.8, 0.88, 0.72 ), algae * smoothstep( 0.3, 0.8, g1.g ) * 0.7 );
			brRoughMul *= mix( 1.0, 4.0, lime );
		}
		if ( brL == BR_M_VINYL_VCT && brNWg.y > 0.7 ) {
			// maintained VCT: the acrylic finish wears matte (and a little lighter, greyer) in the traffic lanes and at
			// thresholds (mask A)
			float brTa = ${VCT_SYNTH_WEAR ? 'smoothstep( 0.3, 0.7, brVNoise( brS2 / 1.2, ivec2( 1024 ), 1411u ) )' : 'brMask.a'};
			brTlWear = smoothstep( 0.25, 0.75, brTa + 0.3 * ( g1.b - 0.5 ) );
			brA = mix( brA, mix( brA, vec3( brLuma( brA ) ), 0.2 ) * 1.03, brTlWear );
#ifdef BR_SHELL
			// wax build-up where the buffer does not reach: amber and glossy within a few cm of the walls
			ivec2 wcl = ivec2( floor( vBrLocal.xz / BR_CELL ) );
			int wbits = brWallBits( wcl );
			if ( wbits != 0 ) {
				vec2 wfr = vBrLocal.xz - vec2( wcl ) * BR_CELL;
				float wd = 9.0;
				if ( ( wbits & 1 ) != 0 ) wd = min( wd, wfr.y );
				if ( ( wbits & 2 ) != 0 ) wd = min( wd, BR_CELL - wfr.x );
				if ( ( wbits & 4 ) != 0 ) wd = min( wd, BR_CELL - wfr.y );
				if ( ( wbits & 8 ) != 0 ) wd = min( wd, wfr.x );
				float wax = 1.0 - smoothstep( ${f(W.WAX_BAND[0])}, ${f(W.WAX_BAND[1])} + 0.02 * g2.r, wd );
				brA *= mix( vec3( 1.0 ), ${v3(W.WAX_TINT)}, wax * ( 0.6 + 0.4 * g1.g ) );
				brRoughMul *= mix( 1.0, 0.75, wax );
			}
#endif
			// heel marks: short black rubber streaks, one candidate per 0.24 m cell, more of them in the lanes
			vec2 hc = brS2 / ${f(W.HEEL_CELL)};
			ivec2 hi = ivec2( floor( hc ) );
			uint hh = brHash2u( brWrap( hi, ivec2( ${wrap(W.HEEL_CELL)} ) ), 1421u );
			if ( brU01( hh ) < ${f(W.HEEL_P)} * ( 0.4 + 1.2 * brTlWear ) ) {
				float ang = brU01( brPcg( hh ) ) * 6.2831853;
				vec2 hp = ( hc - vec2( hi ) - 0.5 - 0.3 * ( vec2( brU01( brPcg( hh + 1u ) ), brU01( brPcg( hh + 2u ) ) ) - 0.5 ) ) * ${f(W.HEEL_CELL)};
				hp = mat2( cos( ang ), sin( ang ), - sin( ang ), cos( ang ) ) * hp;
				float len = mix( 0.015, 0.045, brU01( brPcg( hh + 3u ) ) );
				float wid = mix( 0.003, 0.006, brU01( brPcg( hh + 4u ) ) );
				float hm = ( 1.0 - smoothstep( 0.6, 1.0, length( hp / vec2( len, wid ) ) ) ) * ( 0.5 + 0.5 * g2.g );
				brA *= 1.0 - 0.65 * hm;
				brRoughMul *= 1.0 - 0.2 * hm;
			}
		}
	}
`,
  postWet: '',
  rough: /* glsl */ `
// pool deck glaze (up-facing, above water) and VCT lane wear, over the glaze lobe
if ( brL == BR_M_POOL_TILE && brNWg.y > 0.7 && brSubDepth <= 0.0 ) brRt = sqrt( sqrt( pow4( brRt ) + ${f(Number((POOL_DECK_ROUGH ** 4).toPrecision(4)))} ) );
if ( brTlWear > 0.0 ) brRt = min( brRt + ${f(W.LANE_ROUGH)} * brTlWear, 1.0 );
`,
  normal: '',
  matPost: '',
  postLight: '',
  preFog: '',
};
