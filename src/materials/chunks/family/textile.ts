// src/materials/chunks/family/textile.ts — texture realism v2 family hooks: textiles (CARPET_L0, CARPET_OFFICE,
// FABRIC_PARTITION). Owns grime profile 1 (carpet), the textile sheen (materialPost), the pile shading (postLight) and
// the 'textile' debug view (25). Lane A's file; hook points and rules in chunks/family/index.ts.
//
// Pile under overhead light reads through occlusion and view dependence, not normals. The layers store the pile
// visibility V in ormh.r (the share of a view down into the pile that meets lit tips rather than the gaps between
// them) and, on 'lean' layers, the pile lean in ormh.b / ormh.a (textures/layers/carpet.ts). Here:
//  - pile visibility (postLight, SurfacePhys.pile [kp, kv]): the diffuse, direct and ambient, is scaled by
//    Dv = 1 - kp (1 - V) mu_v^kv (mu_v = n_g . v): looking down the gaps show dark, at grazing the tips hide them
//    (the velvet look). Linear in V, so the mip chain stays unbiased (no distance brightening). Dv stands for the
//    generic texture-cavity multiply on the ambient, which is divided back out. The Level 0 pile also keeps a fibre
//    multiple-scattering trap on its diffuse (T = TRAP x chroma^TRAP_SAT; it was a constant 0.55 on the whole
//    radiance, specular and sheen included);
//  - nap (grime branch + matPost): cut pile leans. Leaning toward the camera it shows fibre ends (darker, richer),
//    leaning away the fibre sides (lighter, shinier). The lean is the texel lean (clumps) plus, on the Level 0 floor,
//    a world nap along each broadloom roll with reversed widths and pile-reversal patches, stronger in worn lanes;
//    s = v_t . lean (v_t the tangent-plane direction to the camera) scales the diffuse and the sheen;
//  - office carpet tiles: the loop rows turn with each tile (the detail map too); the view along or across the rows
//    shades the diffuse and the sheen (k = (v_t . row)^2); 0.6 m seams are drawn analytically (they survive the mips);
//  - sheen: fibre surfaces reflect nearly white, so the sheen colour is the sqrt albedo pulled 30 % toward grey,
//    damp fibres keep a grazing gloss;
//  - carpet grime: a crisp wicking front with a dried tide ring, worn lanes that close the valleys and hold soil,
//    spills with sharp edges and a dark rim.
// Every term is linear in the filtered texture values or explicitly filtered (fwidth), and the hooks gate on the
// per-face layer (quad-uniform).

import { NOISE_WRAP } from '../../../core/constants.ts';
import { Mat } from '../../../core/ids.ts';
import { LAYER_DEFS } from '../../../core/materials.ts';
import { f } from '../params.ts';
import type { FamilyHooks } from './index.ts';

/** Textile shading constants (GLSL #defines BR_TX_* in the pars hook). */
export const TEXTILE = {
  /** Level 0 pile trap on the diffuse: T = TRAP x (albedo / max channel)^TRAP_SAT. With Dv (mean V 0.62, kv 0.8) it
   * gives 0.39 looking down, 0.53 at mu_v 0.35 (a typical 3-4 m view; the old constant trap was 0.55 on the whole
   * radiance, sheen and specular included) and 0.59 at mu_v 0.1. Set so the gallery 11 carpet / wall ratio stays. */
  TRAP: 0.63,
  TRAP_SAT: 0.3,
  /** Wet pile clumps into spiky bundles, its valleys open and darken: V_eff = V^(1 + WET_V x absorbed water). */
  WET_V: 0.6,
  /** Detail-map view hiding on pile layers: brAm = 1 + (brAm - 1)(HIDE + (1 - HIDE) mu_v^kv). */
  HIDE: 0.35,
  /** Nap shading, s = v_t . lean: diffuse x clamp(1 - NAP_DIFF s sin(theta_v), 0.6, 1.4), sheen x clamp(1 - NAP_SHEEN s,
   * 0.2, 1.8). */
  NAP_DIFF: 0.25,
  NAP_SHEEN: 0.6,
  /** World nap on the Level 0 floor: magnitude (lean units) plus this x wear, the share of broadloom widths laid
   * reversed, the wobble (degrees) and its noise cell (m, divides NOISE_WRAP). */
  NAP_AMP: 0.5,
  NAP_WEAR: 0.5,
  NAP_REV: 0.2,
  NAP_WOBBLE: 25,
  NAP_CELL: 0.6,
  /** Pile-reversal patches (2.4 m feature lattice): probability per cell, radius and edge width (m). */
  REV_P: 0.15,
  REV_R: [0.3, 1.2] as const,
  REV_EDGE: [0.06, 0.1] as const,
  /** Office loop rows, k = (v_t . row)^2: diffuse x (1 - ROW_DIFF / 2 + ROW_DIFF k (1 - mu_v)), sheen x (ROW_SHEEN0 +
   * ROW_SHEEN1 k). */
  ROW_DIFF: 0.08,
  ROW_SHEEN0: 0.6,
  ROW_SHEEN1: 0.8,
  /** Damp patches (the tide-perturbed wet field): the wicking front, where the field crosses DAMP_AT, is a step to
   * DAMP_EDGE of the full damp look, FRONT_W metres half-wide and ragged by +-FRONT_AMP metres over FRONT_CELL; the damp
   * then deepens inward to DAMP_IN (field units). The dried tide ring lies TIDE_OUT metres outside the front, TIDE_HW
   * metres half-wide (colour multiplier and amount). */
  DAMP_AT: 0.3,
  DAMP_IN: 0.62,
  DAMP_EDGE: 0.25,
  FRONT_W: 0.015,
  FRONT_AMP: 0.02,
  FRONT_CELL: 0.025,
  TIDE: [0.78, 0.68, 0.52] as const,
  TIDE_AMT: 0.6,
  TIDE_OUT: 0.025,
  TIDE_HW: 0.006,
  /** Worn traffic lanes: V -> mix(V, 0.9, WEAR_V x wear); soil on the fibre tips (colour multiplier). */
  WEAR_V: 0.7,
  WEAR_SOIL: [0.9, 0.87, 0.82] as const,
  /** Spills: probability per 2.4 m cell, radius (m), a dried rim (m wide) and colours. */
  BLOT_P: 0.25,
  BLOT_R: [0.05, 0.3] as const,
  BLOT_RIM: 0.015,
  BLOT_COL: [0.7, 0.64, 0.55] as const,
  BLOT_RIM_COL: [0.78, 0.7, 0.58] as const,
} as const;

/** Pile visibility (twin of the postLight GLSL): V the texture visibility (ormh.r), muV = n_g . v. Linear in V. */
export function pileVisibility(V: number, muV: number, kp: number, kv: number): number {
  return Math.max(1 - kp * (1 - V) * Math.pow(Math.min(Math.max(muV, 0), 1), kv), 0);
}

/** Nap diffuse factor (twin of the postLight GLSL): s = v_t . lean (> 0 leaning toward the camera; v_t the unit
 * tangent-plane direction to the camera), muV = n_g . v. The share of fibre ends against fibre sides in view changes
 * with the lean times sin(theta_v), linearly in the (mip-filtered) lean. */
export function napDiffuse(s: number, muV: number): number {
  const sinV = Math.sqrt(Math.max(1 - muV * muV, 0));
  return Math.min(Math.max(1 - TEXTILE.NAP_DIFF * s * sinV, 0.6), 1.4);
}

const T = TEXTILE;
const v2 = (a: readonly number[]): string => `vec2( ${f(a[0])}, ${f(a[1])} )`;
const v3 = (a: readonly number[]): string => `vec3( ${f(a[0])}, ${f(a[1])}, ${f(a[2])} )`;

export const TEXTILE_HOOKS: FamilyHooks = {
  pars: /* glsl */ `
// ---- textiles (lane A, chunks/family/textile.ts)
#define BR_TX_M_OFFICE ${Mat.CARPET_OFFICE}
#define BR_TX_TRAP ${f(T.TRAP)}
#define BR_TX_TRAP_SAT ${f(T.TRAP_SAT)}
#define BR_TX_WET_V ${f(T.WET_V)}
#define BR_TX_HIDE ${f(T.HIDE)}
#define BR_TX_NAP_DIFF ${f(T.NAP_DIFF)}
#define BR_TX_NAP_SHEEN ${f(T.NAP_SHEEN)}
#define BR_TX_NAP_AMP ${f(T.NAP_AMP)}
#define BR_TX_NAP_WEAR ${f(T.NAP_WEAR)}
#define BR_TX_NAP_REV ${f(T.NAP_REV)}
#define BR_TX_NAP_WOBBLE ${f((T.NAP_WOBBLE * Math.PI) / 180)}
#define BR_TX_NAP_CELL ${f(T.NAP_CELL)}
#define BR_TX_NAP_P ${Math.round(NOISE_WRAP / T.NAP_CELL)}
#define BR_TX_OUTLINE_P ${Math.round(NOISE_WRAP / 0.3)}
#define BR_TX_OUTLINE_P2 ${Math.round(NOISE_WRAP / 0.1)}
#define BR_TX_FRONT_P ${Math.round(NOISE_WRAP / T.FRONT_CELL)}
#define BR_TX_OFFICE_TILE ${f(LAYER_DEFS[Mat.CARPET_OFFICE].tileSize)}
#define BR_TX_OFFICE_P ${Math.round(NOISE_WRAP / LAYER_DEFS[Mat.CARPET_OFFICE].tileSize)}
#define BR_TX_REV_P ${f(T.REV_P)}
#define BR_TX_REV_R ${v2(T.REV_R)}
#define BR_TX_REV_EDGE ${v2(T.REV_EDGE)}
#define BR_TX_ROW_DIFF ${f(T.ROW_DIFF)}
#define BR_TX_ROW_SHEEN0 ${f(T.ROW_SHEEN0)}
#define BR_TX_ROW_SHEEN1 ${f(T.ROW_SHEEN1)}
#define BR_TX_DAMP_AT ${f(T.DAMP_AT)}
#define BR_TX_DAMP_IN ${f(T.DAMP_IN)}
#define BR_TX_DAMP_EDGE ${f(T.DAMP_EDGE)}
#define BR_TX_FRONT_W ${f(T.FRONT_W)}
#define BR_TX_FRONT_AMP ${f(T.FRONT_AMP)}
#define BR_TX_FRONT_CELL ${f(T.FRONT_CELL)}
#define BR_TX_TIDE ${v3(T.TIDE)}
#define BR_TX_TIDE_AMT ${f(T.TIDE_AMT)}
#define BR_TX_TIDE_OUT ${f(T.TIDE_OUT)}
#define BR_TX_TIDE_HW ${f(T.TIDE_HW)}
#define BR_TX_WEAR_V ${f(T.WEAR_V)}
#define BR_TX_WEAR_SOIL ${v3(T.WEAR_SOIL)}
#define BR_TX_BLOT_P ${f(T.BLOT_P)}
#define BR_TX_BLOT_R ${v2(T.BLOT_R)}
#define BR_TX_BLOT_RIM ${f(T.BLOT_RIM)}
#define BR_TX_BLOT_COL ${v3(T.BLOT_COL)}
#define BR_TX_BLOT_RIM_COL ${v3(T.BLOT_RIM_COL)}
// hashed discs on the 2.4 m feature lattice (pile-reversal patches, spills): 1 inside a disc of radius rr.x..rr.y whose
// outline wobbles with wob (0..1, a smooth world noise), fading over an edge ee.x..ee.y metres wide; rim = a band rimW
// wide just inside the outline (a stain's dried edge). Fixed widths in metres (no derivatives in the loop)
float brTxDiscs( vec2 s2, uint salt, float prob, vec2 rr, vec2 ee, float rimW, float wob, out float rim ) {
	ivec2 qi = ivec2( floor( s2 / BR_FEATURE_CELL ) );
	float acc = 0.0;
	rim = 0.0;
	for ( int y = - 1; y <= 1; y ++ ) {
		for ( int x = - 1; x <= 1; x ++ ) {
			ivec2 c = qi + ivec2( x, y );
			uint h = brHash2u( brWrap( c, ivec2( BR_FEATURE_P ) ), salt );
			if ( brU01( h ) > prob ) continue;
			vec2 ctr = ( vec2( c ) + vec2( brU01( brPcg( h ) ), brU01( brPcg( h + 1u ) ) ) ) * BR_FEATURE_CELL;
			float r = mix( rr.x, rr.y, brU01( brPcg( h + 2u ) ) );
			float e = mix( ee.x, ee.y, brU01( brPcg( h + 3u ) ) );
			vec2 dv = ( s2 - ctr ) * vec2( 1.0, mix( 0.75, 1.25, brU01( brPcg( h + 4u ) ) ) );
			float d = length( dv ) - r * ( 0.7 + 0.6 * wob ); // metres outside the (wobbly) outline
			acc = max( acc, 1.0 - smoothstep( - e, 0.0, d ) );
			rim = max( rim, 1.0 - smoothstep( 0.0, 0.5 * rimW, abs( d + 0.5 * rimW ) ) );
		}
	}
	return acc;
}
`,
  postSample: /* glsl */ `
// textile state at main scope (lane A): the world nap (world xz, lean units; the carpet grime branch sets it), the
// pile lean seen from the camera (> 0: leaning toward it), the geometric n.v and the office rows' alignment with the
// view (matPost sets those three)
vec2 brTxNapW = vec2( 0.0 );
float brTxS = 0.0, brTxSd = 0.0, brTxMu = 1.0, brTxRow = 0.0;
float brTxAm = 1.0; // pile layers: the detail map's multiplier, applied as visibility (postLight) instead of albedo
#if defined( BR_DETAIL_MAPS ) && ! defined( BR_DECAL )
// office carpet tiles: the loop-pile detail turns with its tile (brRotM about the tile centre; the 0.3 m repeat
// divides the 0.6 m tile, so it stays seamless inside it). postDetail restores the uv and turns the slope back
vec2 brTxDetUv = brDetUv;
if ( brL == BR_TX_M_OFFICE && brLA.x > 0.0 && brHoriz ) {
	vec2 brTxC = brRotC * floor( brLB.x / BR_DETAIL_REPEAT + 0.5 );
	brDetUv = brTxC + brRotM * ( brDetUv - brTxC );
	brDetDx = brRotM * brDetDx;
	brDetDy = brRotM * brDetDy;
}
#endif
`,
  postDetail: /* glsl */ `
	if ( BR_L_PILE[ brL ].x > 0.0 ) {
		// pile: the detail's multiplier is mostly the cracks between tufts, i.e. pile visibility at the sub-texel scale.
		// It shows looking down and hides behind the tips at grazing (as Dv), and scales the diffuse light (postLight)
		// rather than the albedo
		vec3 brTxVd = normalize( ( vec4( vViewPosition, 0.0 ) * viewMatrix ).xyz );
		brTxAm = 1.0 + ( brAm - 1.0 ) * brDetL.y * ( BR_TX_HIDE + ( 1.0 - BR_TX_HIDE ) * pow( clamp( dot( brNWg, brTxVd ), 0.0, 1.0 ), BR_L_PILE[ brL ].y ) );
		brAm = 1.0;
		if ( brL == BR_TX_M_OFFICE && brLA.x > 0.0 && brHoriz ) {
			brDetSl = transpose( brRotM ) * brDetSl; // the slope of the turned detail, in the continuous detail frame
			brDetUv = brTxDetUv;
		}
	}
`,
  grime: /* glsl */ `
	else if ( brGrime == BR_G_CARPET ) {
		// carpet: damage (A) = trodden wear paths / thresholds / lanes; grime (G) = dirt near walls; wet patches (B)
		float wear = smoothstep( 0.25, 0.75, brMask.a + ( g1.b - 0.5 ) * 0.3 );
		brWear = wear;
		// worn lanes: crushed pile closes its valleys (V up) and holds soil on the fibre tips (greyer, not lighter)
		brOrmh.r = mix( brOrmh.r, 0.9, BR_TX_WEAR_V * wear );
		brA *= mix( vec3( 1.0 ), BR_TX_WEAR_SOIL, wear );
		brNrmScale *= 1.0 - BR_CARPET_WEAR_NORMAL * wear;
		brA *= 1.0 - 0.35 * clamp( brMask.g * ( 0.55 + 0.9 * g1.g ), 0.0, 1.0 );
		// the damp patch ends at a ragged wicking front a few cm wide, then deepens inward (the wide ramp alone read as a
		// cast shadow); under water everything stays soaked. The front's width, its raggedness and the tide ring are
		// metres: field units scaled by the field's slope per metre, so a shallow field crossing the threshold draws a
		// contour, not a wide speckled band
		float brTxG = length( vec2( dFdx( wetRaw ), dFdy( wetRaw ) ) ) / max( max( length( dFdx( brS2 ) ), length( dFdy( brS2 ) ) ), 1e-5 );
		float brTxFwW = fwidth( wetRaw );
		float brTxWr = wetRaw + ( brVNoise( brS2 / BR_TX_FRONT_CELL, ivec2( BR_TX_FRONT_P ), 367u ) * 2.0 - 1.0 ) * brTxG * BR_TX_FRONT_AMP;
		if ( brSubDepth <= 0.0 ) {
			float brTxW = max( brTxG * BR_TX_FRONT_W, brTxFwW );
			wet = smoothstep( BR_TX_DAMP_AT - brTxW, BR_TX_DAMP_AT + brTxW, brTxWr ) * mix( BR_TX_DAMP_EDGE, 1.0, smoothstep( BR_TX_DAMP_AT, BR_TX_DAMP_IN, wetRaw ) );
		}
		brWet = wet;
		if ( BR_DETAIL == 1 && brHoriz ) {
			// spills: 5-30 cm stains with a sharp edge and a darker dried rim
			// two octaves of outline wobble (0.3 m and 0.1 m): stains and reversal patches are blotchy, not ellipses
			float brTxWob = 0.65 * brVNoise( brS2 / 0.3, ivec2( BR_TX_OUTLINE_P ), 359u ) + 0.35 * brVNoise( brS2 / 0.1, ivec2( BR_TX_OUTLINE_P2 ), 361u );
			float brTxRim;
			float b = brTxDiscs( brS2, 301u, BR_TX_BLOT_P, BR_TX_BLOT_R, vec2( 0.008, 0.02 ), BR_TX_BLOT_RIM, brTxWob, brTxRim );
			float bs = clamp( 0.35 + brMask.g + brMask.a, 0.0, 1.0 );
			brA *= mix( vec3( 1.0 ), BR_TX_BLOT_COL, b * bs * ( 0.55 + 0.45 * g2.g ) );
			brA *= mix( vec3( 1.0 ), BR_TX_BLOT_RIM_COL, brTxRim * bs );
			if ( brL == BR_M_CARPET_L0 ) {
				// broadloom: seams every 3.84 m along x (3 mm darker line) and a dye lot per width (±3 %)
				float bx = brS2.x / BR_CARPET_BROADLOOM;
				uint hl = brHash2u( brWrap( ivec2( int( floor( bx ) ), 0 ), ivec2( BR_CARPET_BROADLOOM_P, 1 ) ), 341u );
				float lv = brU01( hl ) * 2.0 - 1.0, lh = brU01( brPcg( hl ) ) * 2.0 - 1.0;
				brA *= ( 1.0 + 0.03 * lv ) * vec3( 1.0 + 0.012 * lh, 1.0, 1.0 - 0.012 * lh );
				float dm = abs( fract( bx + 0.5 ) - 0.5 ) * BR_CARPET_BROADLOOM;
				float fw = max( fwidth( brS2.x ), 1e-4 );
				float seamL = clamp( 0.003 / fw, 0.0, 1.0 ) * ( 1.0 - smoothstep( 0.0015, 0.0015 + fw, dm ) );
				brA *= 1.0 - 0.35 * seamL * ( 0.6 + 0.4 * g1.g );
				// nap: the pile leans along the roll length (z), one way per width (some widths laid reversed), wobbling
				// ±25° over ~0.6 m; pile-reversal patches (crisp 6-10 cm edges) flip it, and crushed traffic lanes lie
				// flatter (a stronger nap)
				float brTxNs = brU01( brPcg( hl ^ 0x2545f491u ) ) < BR_TX_NAP_REV ? - 1.0 : 1.0;
				float brTxWb = ( brVNoise( brS2 / BR_TX_NAP_CELL, ivec2( BR_TX_NAP_P ), 351u ) * 2.0 - 1.0 ) * BR_TX_NAP_WOBBLE;
				float brTxRr;
				float brTxRev = brTxDiscs( brS2, 353u, BR_TX_REV_P, BR_TX_REV_R, BR_TX_REV_EDGE, 0.0, brTxWob, brTxRr );
				brTxNapW = vec2( sin( brTxWb ), cos( brTxWb ) ) * ( brTxNs * ( 1.0 - 2.0 * brTxRev ) * ( BR_TX_NAP_AMP + BR_TX_NAP_WEAR * wear ) );
			}
			if ( brL == BR_TX_M_OFFICE && brLA.x > 0.0 ) {
				// carpet tiles in world space (0.6 m): a dye lot per tile (±3 %; 1 in 12 a replacement from another lot,
				// ±8 %), and the seam line drawn analytically (1.5 mm, anti-aliased by the footprint) so it survives the
				// mips; 1 in 20 tiles has a lifted edge that catches the light
				vec2 brTxTq = brS2 / BR_TX_OFFICE_TILE;
				uint brTxTh = brHash2u( brWrap( ivec2( floor( brTxTq ) ), ivec2( BR_TX_OFFICE_P ) ), 373u );
				float brTxRep = brU01( brPcg( brTxTh ) ) < 1.0 / 12.0 ? 0.08 : 0.03;
				brA *= 1.0 + brTxRep * ( 2.0 * brU01( brTxTh ) - 1.0 );
				vec2 brTxTd = abs( fract( brTxTq + 0.5 ) - 0.5 ) * BR_TX_OFFICE_TILE; // metres to the tile edges (x, z)
				vec2 brTxFw = max( fwidth( brS2 ), vec2( 1e-4 ) );
				vec2 brTxSl = clamp( 0.0015 / brTxFw, 0.0, 1.0 ) * ( 1.0 - smoothstep( vec2( 0.00075 ), 0.00075 + brTxFw, brTxTd ) );
				brA *= ( 1.0 - 0.4 * brTxSl.x ) * ( 1.0 - 0.4 * brTxSl.y );
				if ( brU01( brPcg( brTxTh ^ 0x51ed27u ) ) < 0.05 ) {
					vec2 brTxLf = brTxTq - floor( brTxTq ); // lifted along the tile's -x / -z edges
					brA *= 1.0 + 0.08 * ( 1.0 - smoothstep( 0.0, 0.05, min( brTxLf.x, brTxLf.y ) ) );
				}
			}
#ifdef BR_SHELL
			// filtration soiling: a dark line on the carpet along the wall faces (air drawn under the baseboards),
			// from the tile wall mask, broken up by the tide field
			ivec2 wcl = ivec2( floor( vBrLocal.xz / BR_CELL ) );
			int wbits = brWallBits( wcl );
			if ( wbits != 0 ) {
				vec2 wfr = vBrLocal.xz - vec2( wcl ) * BR_CELL;
				float wd = 9.0;
				if ( ( wbits & 1 ) != 0 ) wd = min( wd, wfr.y );
				if ( ( wbits & 2 ) != 0 ) wd = min( wd, BR_CELL - wfr.x );
				if ( ( wbits & 4 ) != 0 ) wd = min( wd, BR_CELL - wfr.y );
				if ( ( wbits & 8 ) != 0 ) wd = min( wd, wfr.x );
				float soil = 1.0 - smoothstep( 0.075, 0.095 + 0.03 * g2.r, wd );
				brA *= mix( vec3( 1.0 ), vec3( 0.7, 0.66, 0.6 ), soil * ( 0.55 + 0.45 * g2.r ) );
			}
#endif
		}
		// damp: a dried tide ring (dirty-water brown) just outside the wicking front, anti-aliased by the field's
		// footprint (its coverage is kept when it gets thinner than a pixel); the damp interior darkens, saturates and
		// clumps through the porosity model, mottled by the tide field
		float brTxHw = brTxG * BR_TX_TIDE_HW;
		float ring = brTxHw / ( brTxHw + brTxFwW + 1e-6 ) * ( 1.0 - smoothstep( 0.0, brTxHw + brTxFwW, abs( brTxWr - BR_TX_DAMP_AT + brTxG * BR_TX_TIDE_OUT ) ) );
		brA *= mix( vec3( 1.0 ), BR_TX_TIDE, BR_TX_TIDE_AMT * ring );
		brA *= mix( vec3( 1.0 ), mix( 0.88, 1.0, g1.r ) * vec3( 1.02, 0.98, 0.9 ), wet );
	}
`,
  postWet: '',
  rough: '',
  normal: '',
  matPost: /* glsl */ `
// textile shading state (lane A): the geometric n.v, the pile lean seen from the camera (the texel lean in the uv
// frame through the cotangent frame, plus the world nap) and the office rows' alignment with the view
if ( BR_L_PILE[ brL ].x > 0.0 ) {
	vec3 brTxV = normalize( vViewPosition );
	brTxMu = clamp( dot( brNg, brTxV ), 0.0, 1.0 );
	vec3 brTxVt = brTxV - brNg * dot( brNg, brTxV );
	float brTxVl = length( brTxVt );
	brTxVt /= max( brTxVl, 1e-4 );
	float brTxK = smoothstep( 0.0, 0.2, brTxVl ); // looking straight down the direction to the camera is undefined
	vec3 brTxL = brTbn[ 0 ] * ( brLean.x * inversesqrt( max( dot( brTbn[ 0 ], brTbn[ 0 ] ), 1e-12 ) ) )
		+ brTbn[ 1 ] * ( brLean.y * inversesqrt( max( dot( brTbn[ 1 ], brTbn[ 1 ] ), 1e-12 ) ) );
	if ( brL == BR_TX_M_OFFICE ) {
		// loop rows have no nap: only the angle between the rows and the view matters
		brTxRow = brTxK * pow2( dot( brTxVt, brTxL ) ) / max( dot( brTxL, brTxL ), 1e-4 );
	} else {
		brTxS = brTxK * dot( brTxVt, brTxL + ( viewMatrix * vec4( brTxNapW.x, 0.0, brTxNapW.y, 0.0 ) ).xyz );
		// the share of fibre ends against fibre sides in view changes with the lean times sin(theta_v)
		brTxSd = brTxS * brTxVl;
	}
}
// textile sheen (Charlie lobe): fibre surfaces reflect nearly white, so the colour is the sqrt albedo pulled toward
// grey; the nap and the office rows modulate it, damp fibres keep a grazing gloss, a film and standing water hide it
#ifdef USE_SHEEN
{
	vec4 brLD = uBrLayerD[ brL ];
	vec3 brTxSq = sqrt( max( diffuseColor.rgb, vec3( 0.0 ) ) );
	float brTxShK = clamp( 1.0 - BR_TX_NAP_SHEEN * brTxS, 0.2, 1.8 ) * ( brL == BR_TX_M_OFFICE ? BR_TX_ROW_SHEEN0 + BR_TX_ROW_SHEEN1 * brTxRow : 1.0 );
	material.sheenColor = brLD.z * mix( brTxSq, vec3( brLuma( brTxSq ) ), 0.3 ) * brTxShK * ( 1.0 - 0.5 * brAbs ) * ( 1.0 - 0.7 * brFilm ) * ( 1.0 - 0.2 * brWear ) * ( 1.0 - brPuddle );
	material.sheenRoughness = clamp( brLD.w, 0.07, 1.0 );
}
#endif
`,
  postLight: /* glsl */ `
#ifndef BR_DECAL
if ( BR_L_PILE[ brL ].x > 0.0 ) {
	// pile visibility (TS twin pileVisibility): wet pile clumps, its valleys open and darken
	vec2 brTxKp = BR_L_PILE[ brL ];
	float brTxV = pow( clamp( brOrmh.r, 0.0, 1.0 ), 1.0 + BR_TX_WET_V * brAbs );
	float brTxDv = max( 1.0 - brTxKp.x * ( 1.0 - brTxV ) * pow( brTxMu, brTxKp.y ), 0.0 );
	// nap (TS twin napDiffuse): leaning toward the camera the pile shows fibre ends, darker; office rows: along or across
	float brTxNd = clamp( 1.0 - BR_TX_NAP_DIFF * brTxSd, 0.6, 1.4 );
	if ( brL == BR_TX_M_OFFICE ) brTxNd *= 1.0 - 0.5 * BR_TX_ROW_DIFF + BR_TX_ROW_DIFF * brTxRow * ( 1.0 - brTxMu );
	vec3 brTxK = vec3( brTxDv * brTxNd * brTxAm );
	if ( brL == BR_M_CARPET_L0 ) {
		// the Level 0 pile trap: what escapes the pile has crossed more dyed fibre (darker and more saturated than one
		// fibre); the layer table albedo stays the fibre colour the bake bounces with
		vec3 brTxA = max( diffuseColor.rgb, vec3( 1e-4 ) );
		brTxK *= BR_TX_TRAP * pow( brTxA / max3( brTxA ), vec3( BR_TX_TRAP_SAT ) );
	}
	reflectedLight.directDiffuse *= brTxK;
	reflectedLight.indirectDiffuse *= brTxK / max( brCav, 1e-3 ); // Dv replaces the generic cavity multiply
	if ( uDebugView == BR_DV_TEXTILE ) BR_DEBUG_EXIT( vec3( brTxDv, 0.5 * brTxNd, 0.5 + 0.5 * brTxS ) )
}
#endif
`,
  preFog: '',
};
