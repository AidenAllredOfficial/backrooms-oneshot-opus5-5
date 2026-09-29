// src/materials/chunks/family/masonry.ts — texture realism v2 family hooks: masonry (CMU_PAINTED, CMU_RAW). Owns
// grime profile 8 (masonry) and the per-block world variation of block walls. Lane C's file; hook points and rules
// in chunks/family/index.ts.

import { Mat } from '../../../core/ids.ts';
import { NOISE_WRAP, STOREY_PITCH } from '../../../core/constants.ts';
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
  painted: { value: 0.025, warm: 0.01, rough: 0.07 },
  raw: { value: 0.06, warm: 0.02, rough: 0.03 },
  tilt: 0.0044,
  touchUp: { p: 0.06, value: 0.03, rough: -0.08, detail: 0.8 },
  filled: { p: 0.04, detail: 0.6 },
  open: { p: 0.1, detail: 1.25 },
  /** detail uv offset per block (detail repeats): the aggregate never continues across a joint */
  detailOffset: 7.3,
} as const;

/** Unresolved detail slope variance E[|s|^2] of D14 / D15 (harness extra=detail, stats().detailMoments rmsSlope^2),
 * added to alpha^2 where no detail maps are bound (low / medium), so block walls keep their matte sheen there. */
export const CMU_DET_VAR_MEAN: Readonly<Record<number, number>> = { [Mat.CMU_PAINTED]: 0.12, [Mat.CMU_RAW]: 0.18 };

/** Until package 0b multiplies the detail strength by the 'detailMask' channel itself, the family applies it on CMU
 * (1 = on). */
const DETAIL_MASK_SHIM = 1;

const f = (x: number): string => (Number.isInteger(x) ? `${x}.0` : String(x));
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
// ---- CMU per-block world variation (shell walls; faces only: brMsJ is the joint share from the detail-mask channel,
// 0.3 in the joints, 1 on faces, mip-filtered)
#ifdef BR_SHELL
bool brMsOn = ( brL == BR_M_CMU_PAINTED || brL == BR_M_CMU_RAW ) && ! brHoriz;
#else
bool brMsOn = false;
#endif
float brMsJ = 0.0, brMsDet = 1.0;
vec2 brMsTilt = vec2( 0.0 );
if ( brMsOn ) {
	uint brMsH = brMsKey( brPW, brNWg, brUv - vBrUv, brLB.xy, vBrLocal.y );
	brMsJ = clamp( ( 1.0 - brAux ) / 0.7, 0.0, 1.0 );
	bool brMsRaw = brL == BR_M_CMU_RAW;
	uint h1 = brPcg( brMsH ), h2 = brPcg( h1 ), h3 = brPcg( h2 ), h4 = brPcg( h3 ), h5 = brPcg( h4 );
	float cls = brU01( h3 );
	float val = ( brU01( brMsH ) * 2.0 - 1.0 ) * ( brMsRaw ? ${f(V.raw.value)} : ${f(V.painted.value)} );
	float wrm = ( brU01( h1 ) * 2.0 - 1.0 ) * ( brMsRaw ? ${f(V.raw.warm)} : ${f(V.painted.warm)} );
	float rgh = ( brU01( h2 ) * 2.0 - 1.0 ) * ( brMsRaw ? ${f(V.raw.rough)} : ${f(V.painted.rough)} );
	if ( ! brMsRaw && cls < ${f(V.touchUp.p)} ) { val += ${f(V.touchUp.value)}; rgh += ${f(V.touchUp.rough)}; brMsDet = ${f(V.touchUp.detail)}; }
	else if ( cls < ${f(V.touchUp.p + V.filled.p)} ) brMsDet = ${f(V.filled.detail)};
	else if ( cls < ${f(V.touchUp.p + V.filled.p + V.open.p)} ) brMsDet = ${f(V.open.detail)};
	float fm = 1.0 - brMsJ;
	brA *= ( 1.0 + val * fm ) * vec3( 1.0 + wrm * fm, 1.0, 1.0 - wrm * fm );
	brOrmh.g = clamp( brOrmh.g + rgh * fm, 0.03, 1.0 );
	brMsTilt = ( vec2( brU01( h4 ), brU01( h5 ) ) * 2.0 - 1.0 ) * ${f(V.tilt)} * fm;
#if defined( BR_DETAIL_MAPS ) && ! defined( BR_DECAL )
	// the unoffset derivatives stay (textureGrad), so the fetch footprint is continuous across the key's jump
	brDetUv += vec2( brU01( brPcg( h5 ) ), brU01( brPcg( h5 ^ 0x9e3779b9u ) ) ) * ${f(V.detailOffset)};
#endif
}
`,
  postDetail: /* glsl */ `
	if ( brMsOn ) {
		// block class and the smoother tooled joints (${DETAIL_MASK_SHIM ? 'detail-mask shim until 0b applies brAux' : 'block class only'})
		float k = brMsDet * mix( 1.0, brAux, ${f(DETAIL_MASK_SHIM)} );
		brDetSl *= k;
		brDetVar *= k * k;
		brAm = 1.0 + k * ( brAm - 1.0 );
	}
`,
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
  rough: /* glsl */ `
#ifndef BR_DETAIL_MAPS
// block walls without detail maps (low / medium): the aggregate's unresolved slope variance (D14 / D15 moments)
if ( brL == BR_M_CMU_PAINTED ) brRt = sqrt( sqrt( pow4( brRt ) + ${f(CMU_DET_VAR_MEAN[Mat.CMU_PAINTED])} * brAux * brAux ) );
else if ( brL == BR_M_CMU_RAW ) brRt = sqrt( sqrt( pow4( brRt ) + ${f(CMU_DET_VAR_MEAN[Mat.CMU_RAW])} * brAux * brAux ) );
#endif
`,
  normal: /* glsl */ `
if ( brMsOn ) {
	// per-block tilt in the wall plane's own axes (the uv cotangent frame, normalised: u spans 2.4 m, v 1.0 m)
	vec3 brMsT = brTbn[ 0 ] * inversesqrt( max( dot( brTbn[ 0 ], brTbn[ 0 ] ), 1e-12 ) );
	vec3 brMsB = brTbn[ 1 ] * inversesqrt( max( dot( brTbn[ 1 ], brTbn[ 1 ] ), 1e-12 ) );
	normal = normalize( normal + brMsT * brMsTilt.x + brMsB * brMsTilt.y );
}
`,
  matPost: '',
  postLight: '',
  preFog: '',
};
