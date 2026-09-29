// src/materials/chunks/family/masonry.ts — texture realism v2 family hooks: masonry (CMU_PAINTED, CMU_RAW). Owns
// grime profile 8 (masonry) and the per-block world variation of block walls. Lane C's file; hook points and rules
// in chunks/family/index.ts.

import { Mat } from '../../../core/ids.ts';
import { NOISE_WRAP, STOREY_PITCH } from '../../../core/constants.ts';
import { SSR } from '../../../post/ssr/ssrGlsl.ts';
import { CMU_BLOCK, CMU_BOND } from '../../../textures/layers/masonry.ts';
import type { FamilyHooks } from './index.ts';

/**
 * Per-block world variation of CMU walls (texture realism v2 lane C): every world block (a key from the wall position
 * that follows the texture's bond, so it changes inside the joints) gets its own paint lot and sheen, a small tilt
 * and its own patch of the aggregate detail. `value` and `warm` are +- amplitudes of the albedo (warm: R up, B down),
 * `rough` of the face roughness (porous blocks 'flash': the first coat soaks in unevenly), `tilt` of the face normal
 * (radians per axis: sheen steps between blocks at grazing angles). Classes by share: touch-up blocks (fresher,
 * glossier, less texture), heavily filled blocks (less texture), open blocks (more texture).
 */
export const CMU_VARIATION = {
  painted: { value: 0.032, warm: 0.01, rough: 0.05 },
  raw: { value: 0.06, warm: 0.02, rough: 0.03 },
  tilt: 0.0044,
  touchUp: { p: 0.06, value: 0.025, rough: -0.04, detail: 0.85 },
  filled: { p: 0.04, detail: 0.6 },
  open: { p: 0.1, detail: 1.25 },
  /** detail uv offset per block (detail repeats): the aggregate never continues across a joint */
  detailOffset: 7.3,
} as const;

/** Unresolved detail slope variance E[|s|^2] of D14 / D15 (harness extra=detail, stats().detailMoments rmsSlope^2),
 * added to alpha^2 where no detail maps are bound (low / medium), so block walls keep their matte sheen there. */
export const CMU_DET_VAR_MEAN: Readonly<Record<number, number>> = { [Mat.CMU_PAINTED]: 0.12, [Mat.CMU_RAW]: 0.18 };

/** Upper bound of painted CMU's lobe roughness once the aggregate is unresolved: real painted block measures about
 * 0.62-0.7 beyond 2 m (the film's 0.52 broadened by the grain slopes), and every block of a wall must stay on one
 * side of SSR's G-buffer eligibility cut (SSR.ELIG_ROUGH 0.7). Its two paths differ by the lamps' glossy reflection,
 * so blocks whose flashing, class and distance put them around the cut popped between the paths as the camera moved. */
export const CMU_PAINTED_MAX_ROUGH = Number((SSR.ELIG_ROUGH - 0.03).toFixed(3));

const f = (x: number): string => (Number.isInteger(x) ? `${x}.0` : String(x));
const v3 = (c: readonly number[]): string => `vec3( ${c.map(f).join(', ')} )`;
/** Masonry grime colours: seepage (x 0.86 with a brown tint) and efflorescence salts. */
const SEEPAGE = [0.86 * 0.93, 0.86 * 0.9, 0.86 * 0.84].map((x) => Number(x.toFixed(4)));
const EFFLORESCENCE = [0.66, 0.65, 0.62] as const;
/** Blister lattice cell (m): divides NOISE_WRAP and STOREY_PITCH. */
const BLISTER_CELL = 0.012;
const V = CMU_VARIATION;
const offs = CMU_BOND.map((o) => f(Number(o.toFixed(6))));

export const MASONRY_HOOKS: FamilyHooks = {
  pars: /* glsl */ `
#define BR_M_CMU_PAINTED ${Mat.CMU_PAINTED}
#define BR_M_CMU_RAW ${Mat.CMU_RAW}
// CMU world block key (lane C): the block of the texture's bond at the wall position. 'along' is the mesher's u in
// world metres (mesh/uv.ts vUv: right = up x n; the tile origin enters through the noise origin, a multiple of the
// 2.4 m frame), y is storey-relative; both follow the POM shift of the lookup. The key wraps at NOISE_WRAP along
// (${Math.round(NOISE_WRAP / CMU_BLOCK[0])} blocks) and per storey (${Math.round(STOREY_PITCH / CMU_BLOCK[1])} courses), so it never jumps at a tile or wrap edge.
uint brMsKey( vec3 pw, vec3 n, vec2 duv, vec2 rep, float y ) {
	float al = dot( pw.xz, vec2( n.z, - n.x ) ) + duv.x * rep.x;
	float yy = y + duv.y * rep.y;
	float crs = floor( yy / ${f(CMU_BLOCK[1])} );
	float cw = crs - 5.0 * floor( crs / 5.0 );
	float off = cw < 0.5 ? ${offs[0]} : cw < 1.5 ? ${offs[1]} : cw < 2.5 ? ${offs[2]} : cw < 3.5 ? ${offs[3]} : ${offs[4]};
	ivec2 bk = ivec2( int( floor( al / ${f(CMU_BLOCK[0])} + off ) ), int( crs ) );
	vec3 a = abs( n );
	uint axis = a.x > a.z ? ( n.x > 0.0 ? 0u : 1u ) : ( n.z > 0.0 ? 2u : 3u );
	return brHash2u( brWrap( bk, ivec2( ${Math.round(NOISE_WRAP / CMU_BLOCK[0])}, ${Math.round(STOREY_PITCH / CMU_BLOCK[1])} ) ), 1201u + 17u * axis );
}
`,
  postSample: /* glsl */ `
// ---- CMU per-block world variation (shell walls; faces only: the joint share comes from the detail-mask channel,
// 0.3 in the joints, 1 on faces, mip-filtered). Two hashes: eight 8-bit fields
#ifdef BR_SHELL
bool brMsOn = ( brL == BR_M_CMU_PAINTED || brL == BR_M_CMU_RAW ) && ! brHoriz;
#else
bool brMsOn = false;
#endif
float brMsDet = 1.0;
if ( brMsOn ) {
	// the base normal is a metric slope, but FRAG_NORMAL's cotangent frame keeps |T| : |B| = |grad u| : |grad v| =
	// repeatY : repeat (u spans 2.4 m, v 1.0 m on walls), which shrank every slope along u (head joints, tilts, chips)
	// to 0.42: undo it for these layers
	brNrm.x *= brLB.x / brLB.y;
	uint h = brMsKey( brPW, brNWg, brUv - vBrUv, brLB.xy, vBrLocal.y );
	uint h2 = brPcg( h );
	vec4 u = vec4( uvec4( h, h >> 8u, h >> 16u, h >> 24u ) & 255u ) * ( 2.0 / 255.0 ) - 1.0;
	vec4 w = vec4( uvec4( h2, h2 >> 8u, h2 >> 16u, h2 >> 24u ) & 255u ) * ( 1.0 / 255.0 );
	bool raw = brL == BR_M_CMU_RAW;
	float val = u.x * ( raw ? ${f(V.raw.value)} : ${f(V.painted.value)} );
	float wrm = u.y * ( raw ? ${f(V.raw.warm)} : ${f(V.painted.warm)} );
	float rgh = u.z * ( raw ? ${f(V.raw.rough)} : ${f(V.painted.rough)} );
	float cls = u.w * 0.5 + 0.5;
	if ( ! raw && cls < ${f(V.touchUp.p)} ) { val += ${f(V.touchUp.value)}; rgh += ${f(V.touchUp.rough)}; brMsDet = ${f(V.touchUp.detail)}; }
	else if ( cls < ${f(V.touchUp.p + V.filled.p)} ) brMsDet = ${f(V.filled.detail)};
	else if ( cls < ${f(V.touchUp.p + V.filled.p + V.open.p)} ) brMsDet = ${f(V.open.detail)};
	float fm = clamp( ( brAux - 0.3 ) / 0.7, 0.0, 1.0 );
	brA *= ( 1.0 + val * fm ) * vec3( 1.0 + wrm * fm, 1.0, 1.0 - wrm * fm );
	brOrmh.g = clamp( brOrmh.g + rgh * fm, 0.03, 1.0 );
	// the block's tilt, straight into the (metric) tangent normal
	brNrm.xy += ( w.xy * 2.0 - 1.0 ) * ( ${f(V.tilt)} * fm * brNrm.z );
#if defined( BR_DETAIL_MAPS ) && ! defined( BR_DECAL )
	// the unoffset derivatives stay (textureGrad), so the fetch footprint is continuous across the key's jump
	brDetUv += w.zw * ${f(V.detailOffset)};
#endif
}
`,
  postDetail: /* glsl */ `
	if ( brMsOn ) {
		// the block's texture class (the tooled joints' weaker aggregate is 0b's: the 'detailMask' channel scales the
		// strength before the fetch)
		brDetSl *= brMsDet;
		brDetVar *= brMsDet * brMsDet;
		brAm = 1.0 + brMsDet * ( brAm - 1.0 );
	}
`,
  grime: /* glsl */ `
	else if ( brGrime == BR_G_MASONRY ) {
		// masonry (CMU): paint delamination and blisters in the damp band (A; painted block: the raw block shows
		// through), dirt (G) gathering on the bed-joint ledges, damp and seepage (R) that the mortar wicks further than
		// the block, efflorescence at the drying front and blooming in the joints of the bottom 0.6 m, boot and cart
		// scuffs; tops of block walls (horizontal): oil and dirt
		float jM = clamp( ( 1.0 - brAux ) / 0.7, 0.0, 1.0 ); // joint share (detail-mask channel: 0.3 in the joints)
		if ( ! brHoriz && brL == BR_M_CMU_PAINTED ) {
			// delamination field (ragged, isotropic patches) and its screen gradient, in uniform control flow
			float fv = brMask.a + 0.3 * ( g2.r - 0.5 ) + 0.18 * ( g1.g - 0.5 );
			vec2 fd = vec2( dFdx( fv ), dFdy( fv ) );
			// the damp band only: one coherent branch on the smooth mask (unexecuted, this block cost 0.36 ms per ultra
			// frame of close-up block wall while its fetches sat in a small inner branch)
			if ( fv > 0.22 ) {
				float fl = smoothstep( 0.5, 0.62, fv ); // flaked: the substrate shows
				float rim = smoothstep( 0.4, 0.5, fv ) * ( 1.0 - fl ); // the lifted film edge around it
				if ( fl > 0.0 ) {
					// the raw block (CMU_RAW: the same blocks and joints) through the flake: its albedo and relief (trilinear:
					// a small screen share), raw roughness, the painted aggregate's slopes roughened
					float rl = float( BR_M_CMU_RAW );
					float ts = float( textureSize( uBrAlbedo, 0 ).x );
					float lod = 0.5 * log2( max( max( dot( brDx, brDx ), dot( brDy, brDy ) ) * ts * ts, 1.0 ) );
					vec3 ra = textureLod( uBrAlbedo, vec3( brUv, rl ), lod ).rgb;
					vec3 rn = textureLod( uBrNormal, vec3( brUv, rl ), lod ).xyz * 2.0 - 1.0;
					if ( brMsOn ) rn.x *= brLB.x / brLB.y; // the frame fix of the painted layer (postSample)
					// the salts that lifted the film bloom on the exposed block
					brA = mix( brA, mix( ra, ${v3(EFFLORESCENCE)}, 0.35 * smoothstep( 0.3, 0.9, g1.g + 0.3 * g2.r ) ), fl );
					brNrm.xyz = mix( brNrm.xyz, rn, fl );
					brOrmh.g = mix( brOrmh.g, 0.9, fl );
				brRoughMul *= mix( 1.0, 1.4, fl ); // over the painted layer's roughness cap (rough hook): raw ~0.9
#if defined( BR_DETAIL_MAPS ) && ! defined( BR_DECAL )
					brDetSl *= 1.0 + 0.4 * fl;
					brDetVar *= 1.0 + 0.9 * fl;
#endif
				}
				// the film edge lifts toward the flake: it tilts away from it and catches the light
				if ( rim > 0.0 ) {
					mat2 brJ = mat2( brDx.x, brDy.x, brDx.y, brDy.y ); // brJ * grad_uv = screen derivatives
					vec2 gm = ( abs( determinant( brJ ) ) > 1e-14 ? inverse( brJ ) * fd : vec2( 0.0 ) ) / brLB.xy; // per metre
					float gl = length( gm );
					if ( gl > 1e-6 ) brNrm.xy -= gm / gl * ( 0.9 * rim * brNrm.z );
					brA *= 1.0 + 0.06 * rim;
				}
				// blisters: 2-8 mm domes of film lifted by the damp where it still holds (12 mm cells in wall metres,
				// faded out as a pixel's footprint approaches half a cell: from the uv footprint, no derivatives here)
				float bfw = 1.0 - smoothstep( 0.25, 0.5, max( length( brDx * brLB.xy ), length( brDy * brLB.xy ) ) / ${f(BLISTER_CELL)} );
				float bl = smoothstep( 0.22, 0.42, fv ) * ( 1.0 - fl ) * smoothstep( 0.55, 0.8, g1.g ) * bfw;
				if ( bl > 0.0 ) {
					vec2 bc = vec2( dot( brPW.xz, vec2( brNWg.z, - brNWg.x ) ), vBrLocal.y ) / ${f(BLISTER_CELL)};
					vec2 bi = floor( bc );
					uint bh = brHash2u( brWrap( ivec2( bi ), ivec2( ${Math.round(NOISE_WRAP / BLISTER_CELL)}, ${Math.round(STOREY_PITCH / BLISTER_CELL)} ) ), 1301u );
					vec2 bo = 0.35 + 0.3 * vec2( brU01( brPcg( bh ) ), brU01( brPcg( bh ^ 0x51u ) ) );
					float brr = mix( 0.08, 0.33, brU01( brPcg( bh + 7u ) ) );
					vec2 bp = ( bc - bi - bo ) / brr;
					float on = step( brU01( bh ), 0.4 ) * ( 1.0 - smoothstep( 0.8, 1.0, dot( bp, bp ) ) );
					brNrm.xy += bp * ( 0.8 * on * bl * brNrm.z );
				}
			}
		}
		float oil = 0.0;
		if ( brHoriz ) oil = max( smoothstep( 0.55, 0.8, g1.b * 0.6 + brMask.g * 0.7 ), brBlotch( brS2, true, 311u, 0.18, 0.15, 0.45, ( g2.b - 0.5 ) * 0.6 ) * 0.8 );
		brA *= mix( vec3( 1.0 ), vec3( 0.5, 0.48, 0.46 ), oil * 0.65 );
		brA *= mix( vec3( 1.0 ), vec3( 0.62, 0.58, 0.52 ), clamp( brMask.g * ( 0.4 + g2.g ) * ( 1.0 + 0.6 * jM ), 0.0, 1.0 ) * 0.8 );
		if ( ! brHoriz ) {
			float y = vBrLocal.y;
			// damp and seepage: the stain threshold of the mask's R field, its edge ragged by the tide field and pushed
			// out along the joints; brownish, not black
			float wR = step( 0.02, brMask.r );
			float s = brMask.r + ( g1.r - 0.5 ) * 0.3 * wR + 0.05 * jM * wR;
			// nested, ragged tide fronts (0b's brStainFront), roughened by the grime speckle
			float damp, front;
			brStainFront( s, ( g2.g - 0.5 ) * 2.0, 0.46, damp, front );
			damp *= wR;
			front *= wR;
			brA *= mix( vec3( 1.0 ), ${v3(SEEPAGE)}, damp );
			// efflorescence: salt crust along the drying front and blooming in the joints (salts migrate through the
			// mortar), in streaks down the damp area of the bottom 0.6 m
			float eff = clamp( ( front * 0.8 + damp * smoothstep( 0.5, 0.8, g1.a ) * 0.7 * ( 1.0 - smoothstep( 0.45, 0.65, y ) ) ) * ( 0.6 + 1.2 * jM ), 0.0, 1.0 );
			brA = mix( brA, ${v3(EFFLORESCENCE)}, eff * 0.55 );
			brRoughMul *= mix( 1.0, 1.3, eff );
			// scuffs: black rubber smears from carts (0.08-0.35 m) and boots and trolleys (0.75-1.0 m) on the faces
			float band = smoothstep( 0.06, 0.1, y ) * ( 1.0 - smoothstep( 0.3, 0.37, y ) ) + smoothstep( 0.72, 0.77, y ) * ( 1.0 - smoothstep( 0.96, 1.03, y ) );
			float sc = band * smoothstep( 0.62, 0.85, g1.b ) * clamp( 0.3 + 1.5 * brMask.g, 0.0, 1.0 ) * ( 1.0 - 0.6 * jM );
			brA *= 1.0 - 0.45 * sc;
			brRoughMul *= 1.0 - 0.15 * sc;
		}
		brRoughMul *= mix( 1.0, 0.7, oil );
	}
`,
  postWet: '',
  rough: /* glsl */ `
#ifndef BR_DETAIL_MAPS
// block walls without detail maps (low / medium): the aggregate's unresolved slope variance (D14 / D15 moments)
if ( brL == BR_M_CMU_PAINTED ) brRt = sqrt( sqrt( pow4( brRt ) + ${f(CMU_DET_VAR_MEAN[Mat.CMU_PAINTED])} * brAux * brAux ) );
else if ( brL == BR_M_CMU_RAW ) brRt = sqrt( sqrt( pow4( brRt ) + ${f(CMU_DET_VAR_MEAN[Mat.CMU_RAW])} * brAux * brAux ) );
#endif
// painted block stays on one side of the SSR cut (CMU_PAINTED_MAX_ROUGH; flakes get their raw roughness from
// brRoughMul, applied after this)
if ( brL == BR_M_CMU_PAINTED ) brRt = min( brRt, ${f(CMU_PAINTED_MAX_ROUGH)} );
`,
  normal: '',
  matPost: '',
  postLight: '',
  preFog: '',
};
