// src/materials/chunks/family/props.ts — texture realism v2 family hooks: props and metals (METAL_PAINTED,
// METAL_RUST, METAL_GRATE, METAL_DECK, METAL_BARE, WOOD, PLASTIC, RUBBER). Owns grime profile 6 (metal) and the
// clearcoat fields (materialPost). Lane E's file; hook points and rules in chunks/family/index.ts.
//
// Lane E (docs/DESIGN.md "Lane E"):
// - tint headroom: non-emissive prop parts store tint / 2 (props/builder.ts tintByte); postSample decodes x2 and applies
//   the tint only to the topcoat, diffuse = recipe x mix(1, tint, brWpTop), so primer, steel and rust keep their own
//   colours;
// - edge and contact wear on the 'wear' layers: a level from the face-local edge coordinates of props (the lmUv stream,
//   props/builder.ts edgeEncode; props light from the light volume), the kick zone and the hand band, thresholded
//   against the layer's rank-normalised wear field W (ormh.a, P(W < x) = x). The threshold widens with the texel
//   footprint to a linear ramp of half-width 0.5, so far away the exposed share stays the level (mip-linear);
// - the per-part roughness override is a scale on the topcoat (brR = mix(exposed, ormh.g x override / refR, topcoat));
// - the clearcoat (car paint only) covers the topcoat, on the base map's normal (orange peel and oil-canning).

import { Mat } from '../../../core/ids.ts';
import { RUST_PAINT_REF } from '../../../props/builder.ts';
import { Det } from '../../../textures/detailRecipes/types.ts';
import type { FamilyHooks } from './index.ts';

/** Reference topcoat roughness of the 'wear' layers (the recipe's mean): a part's roughness override scales the
 * texture by override / ref, so the recipe's structure survives. */
export const PROP_REF_ROUGH = { METAL_PAINTED: 0.4, WOOD: 0.36, PLASTIC: 0.4, METAL_BARE: 0.3 } as const;

/** Wear level terms (millimetres and metres). The level is the expected exposed share (W is uniform): a clean
 * interior (base, < 2 %), edges and corners (EDGE_*: ~30 % on the arris, ~4 % at 5 mm, ~2 % at 1 cm), the kick zone near the floor
 * and a trace in the hand band; the edge / kick / hand terms scale with the prop's age (the anchor cell's decay, dust
 * bits) and a per-prop hash. */
export const PROP_WEAR = {
  BASE: 0.003, BASE_HASH: 0.006, BASE_DECAY: 0.01,
  EDGE_NEAR: 0.24, EDGE_NEAR_MM: 2.5, EDGE_FAR: 0.05, EDGE_FAR_MM: 12,
  KICK: 0.14, KICK_Y0: 0.05, KICK_Y1: 0.35, // kick and trolley scrapes near the floor (vertical faces)
  HAND: 0.015, HAND_Y: 1.15, HAND_W: 0.22, // hand band around 0.9-1.4 m (scratches and grease use it more)
  AGE0: 0.6, AGE_DECAY: 0.5, AGE_HASH: 0.5, // age factor of the contact terms: AGE0 + AGE_DECAY decay + AGE_HASH (hash - 0.5)
  CORE: 0.06, // W band between the exposed primer and the steel core
} as const;

const f = (v: number): string => (Number.isInteger(v) ? `${v}.0` : String(v));

/** TS twin of the shader's brWpExpose: the exposed share of a texel with wear threshold w at level l, over a linear
 * ramp of half-width a, with the low / high level correction that keeps the mean over a uniform W equal to l. */
export function wearExposure(w: number, a: number, l: number): number {
  const t = Math.min(l, 1 - l);
  const c = t < a ? 2 * Math.sqrt(a * Math.max(t, 0)) - a : t;
  const lc = l < 0.5 ? c : 1 - c;
  return Math.min(1, Math.max(0, (lc - w + a) / (2 * a)));
}

export const PROP_HOOKS: FamilyHooks = {
  pars: /* glsl */ `
#define BR_M_METAL_PAINTED ${Mat.METAL_PAINTED}
#define BR_M_METAL_RUST ${Mat.METAL_RUST}
#define BR_M_METAL_GRATE ${Mat.METAL_GRATE}
#define BR_M_WOOD ${Mat.WOOD}
#define BR_M_PLASTIC ${Mat.PLASTIC}
#define BR_M_RUBBER ${Mat.RUBBER}
#define BR_M_METAL_DECK ${Mat.METAL_DECK}
#define BR_M_METAL_BARE ${Mat.METAL_BARE}
// props edge coordinate (props/builder.ts edgeEncode): millimetres to the face's nearer edge along one axis, 1e4 where the
// axis has none (0: a tube's circumference, and every non-prop face). The sign bits are flags (end grain, part kind)
// ...and the axis' half extent (mm) and the position s in [-1, 1] across it
vec2 brPropEdgeHS( float x ) {
	float a = abs( x );
	float h = floor( a * 0.25 );
	return vec2( h, clamp( a - 4.0 * h - 1.0, - 1.0, 1.0 ) );
}
float brPropEdgeD( float x ) {
	float a = abs( x );
	float h = floor( a * 0.25 );
	return a < 0.5 ? 1e4 : h * max( 0.0, 1.0 - abs( a - 4.0 * h - 1.0 ) );
}
// threshold wear: the exposed share of a texel whose threshold is w, at level l, over a linear ramp of half-width a
// (screen AA and the unresolved share of W). For uniform W the mean of a ramp centred on l is l only while l >= a (its
// lower half clips at W = 0), so a low level moves to l' = 2 sqrt(a l) - a, which restores mean = l (and the mirror
// at the top): the exposed share stays the level at every distance
float brWpExpose( float w, float a, float l ) {
	float t = min( l, 1.0 - l ); // distance to the nearer end (one sqrt for both corrections)
	float c = t < a ? 2.0 * sqrt( a * max( t, 0.0 ) ) - a : t;
	float lc = l < 0.5 ? c : 1.0 - c;
	return clamp( ( lc - w + a ) / ( 2.0 * a ), 0.0, 1.0 );
}
`,
  postSample: /* glsl */ `
// ---- lane E: edge and contact wear of the 'wear' layers (per-face layer: quad-uniform). brWpTop: topcoat coverage (the
// part tint applies there; the only value that stays live past this hook: everything else is scoped, which kept the
// surface programs' register pressure, and so the frame cost, down); brWpPrim / brWpCore: exposed primer ring and core
// (METAL_PAINTED); brWpScr: scratch / scuff visibility; brWpLvl: the wear level; brWpExp: the exposed share
float brWpTop = 1.0;
#ifndef BR_DECAL
{
float brWpPrim = 0.0, brWpCore = 0.0, brWpScr = 0.0, brWpLvl = 0.0, brWpExp = 0.0;
bool brWpOn = BR_DETAIL == 1 && brAuxK == BR_AUX_WEAR;
bool brWpProp = false; // a non-emissive prop part (tint stored halved, edge coordinates, roughness override)
#ifdef BR_PROPS
brWpProp = ( brF & BR_F_PROP_AUX ) != 0 && vBrEmit <= 0.0;
#endif
float brWpOvr = brWpProp && brAuxB.x > 0.5 ? brAuxB.x / 255.0 : 0.0; // the part's roughness override (0 = none)
if ( brWpOn ) {
	// the override scales the topcoat's own roughness (by the layer's reference), keeping the recipe's structure
	float brWpRef = brL == BR_M_METAL_PAINTED ? ${f(PROP_REF_ROUGH.METAL_PAINTED)} : brL == BR_M_WOOD ? ${f(PROP_REF_ROUGH.WOOD)}
		: brL == BR_M_PLASTIC ? ${f(PROP_REF_ROUGH.PLASTIC)} : ${f(PROP_REF_ROUGH.METAL_BARE)};
	if ( brWpOvr > 0.0 ) brOrmh.g *= brWpOvr / brWpRef;
	float brWpEd = 1e4; // mm to the nearest face edge
	float brWpHash = 0.5, brWpDec = 0.0;
#ifdef BR_PROPS
	if ( brWpProp ) {
		brWpEd = min( brPropEdgeD( vBrLmUv.x ), brPropEdgeD( vBrLmUv.y ) );
		brWpHash = fract( vBrTint.a * 97.31 + 0.137 );
		brWpDec = float( ( int( brAuxB.z ) >> 2 ) & 63 ) / 63.0;
	}
#endif
	float brWpY = vBrLocal.y; // storey-relative
	float brWpHand = exp( - ( brWpY - ${f(PROP_WEAR.HAND_Y)} ) * ( brWpY - ${f(PROP_WEAR.HAND_Y)} ) * ${f(1 / (PROP_WEAR.HAND_W * PROP_WEAR.HAND_W))} );
	float brWpEdge = ${f(PROP_WEAR.EDGE_NEAR)} * exp( - brWpEd * ${f(1 / PROP_WEAR.EDGE_NEAR_MM)} ) + ${f(PROP_WEAR.EDGE_FAR)} * exp( - brWpEd * ${f(1 / PROP_WEAR.EDGE_FAR_MM)} );
	float brWpKick = ( 1.0 - smoothstep( ${f(PROP_WEAR.KICK_Y0)}, ${f(PROP_WEAR.KICK_Y1)}, brWpY ) ) * ( 1.0 - abs( brNWg.y ) );
	float brWpAge = ${f(PROP_WEAR.AGE0)} + ${f(PROP_WEAR.AGE_DECAY)} * brWpDec + ${f(PROP_WEAR.AGE_HASH)} * ( brWpHash - 0.5 );
	brWpLvl = ${f(PROP_WEAR.BASE)} + ${f(PROP_WEAR.BASE_HASH)} * brWpHash + ${f(PROP_WEAR.BASE_DECAY)} * brWpDec
		+ brWpAge * ( brWpEdge + ${f(PROP_WEAR.KICK)} * brWpKick + ${f(PROP_WEAR.HAND)} * brWpHand );
	// part kind 1 on METAL_PAINTED (the edge coordinate y's sign): a painted shadow / cavity stand-in, never worn
	brWpLvl = brWpProp && brL == BR_M_METAL_PAINTED && vBrLmUv.y < 0.0 ? 0.0 : clamp( brWpLvl, 0.0, 1.0 );
	// threshold against W: an AA ramp over the screen gradient, widened to a half-width of 0.5 once the texel footprint
	// hides the flakes (the mip-filtered W tends to its mean 0.5: exposure = level, not a step at level 0.5)
	float brWpFp = max( dot( brDx, brDx ), dot( brDy, brDy ) ) * float( textureSize( uBrOrmh, 0 ).x * textureSize( uBrOrmh, 0 ).x ); // texels^2
	float brWpA = min( fwidth( brAux ) + 0.01 + 0.5 * smoothstep( 16.0, 256.0, brWpFp ), 0.5 );
	brWpExp = brWpExpose( brAux, brWpA, brWpLvl );
	if ( brL == BR_M_METAL_PAINTED ) {
		// painted steel: topcoat -> primer ring -> steel core; old steel (hash x decay) is oxidised dark brown. Primer grey
		// or red oxide by part.
		brWpCore = brWpExpose( brAux, brWpA, brWpLvl - ${f(PROP_WEAR.CORE)} );
		// scratches (albedo.a S: segments of depth class 0.3-1): more in the hand band and near edges; the deepest cut to
		// bright steel
#ifdef BR_PROPS
		float brWpSg = brWpLvl > 0.0 ? clamp( brWpAge * ( 0.12 + 0.6 * brWpHand + 2.0 * brWpEdge + 0.3 * brWpKick ), 0.0, 1.0 ) : 0.0;
		brWpScr = brAux2 * brWpSg;
		float brWpLine = smoothstep( 0.82, 0.95, brAux2 ) * smoothstep( 0.3, 0.7, brWpSg );
		brWpCore = max( brWpCore, brWpLine );
#endif
		brWpExp = max( brWpExp, brWpCore );
		brWpPrim = brWpExp - brWpCore;
		brWpTop = 1.0 - brWpExp;
		float brWpOx = brWpHash * brWpDec; // oxidised steel (old parts)
		vec3 brWpPr = fract( brWpHash * 7.13 ) < 0.6 ? vec3( 0.32, 0.31, 0.29 ) : vec3( 0.24, 0.10, 0.06 );
		vec3 brWpSt = mix( vec3( 0.56, 0.57, 0.58 ), vec3( 0.10, 0.07, 0.05 ), smoothstep( 0.25, 0.6, brWpOx ) );
		float brWpStM = 1.0 - smoothstep( 0.25, 0.6, brWpOx );
		// topcoat roughness: scratches and the scuffed kick zone are chalkier (the hand band's grease is in the grime branch)
		float brWpTr = brOrmh.g + 0.15 * brWpScr + 0.12 * brWpAge * brWpKick;
		brA = brA * brWpTop + brWpPr * brWpPrim + brWpSt * brWpCore;
		brOrmh.g = brWpTr * brWpTop + 0.7 * brWpPrim + mix( 0.3, 0.75, 1.0 - brWpStM ) * brWpCore;
		brOrmh.b = brWpStM * brWpCore;
		brWpScr *= brWpTop;
		// oil-canning is a flat sheet's waviness: tubes and rails (curved sides: no edge across) are drawn smooth
		if ( brWpProp && ( abs( vBrLmUv.x ) < 0.5 || abs( vBrLmUv.y ) < 0.5 ) ) brNrm.xy *= 0.15;
	} else if ( brL == BR_M_METAL_RUST ) {
		// corrosion: paint remnants where C is above a threshold that rises with age, on pipe undersides (condensation)
		// and at joints and flanges (crevices); below it the recipe's rust shows. The paint takes the part's colour
		// (props/builder.ts: METAL_RUST tints are relative to the neutral RUST_PAINT_REF paint)
		float brWpRt = 0.62 + 0.1 * ( brWpDec - 0.5 ) + ( brWpProp ? 0.25 * smoothstep( -0.3, -0.8, brNWg.y ) : 0.0 )
			+ 0.3 * ( 1.0 - smoothstep( 20.0, 80.0, brWpEd ) );
		float brWpPt = 1.0 - brWpExpose( brAux, brWpA, brWpRt );
		// the paint: chalked and stained brown where rust bleeds under it (the band above the threshold)
		vec3 brWpPc = vec3( ${f(RUST_PAINT_REF)} ) * mix( vec3( 0.88 ), vec3( 0.7, 0.55, 0.42 ), 0.65 * ( 1.0 - smoothstep( brWpRt, brWpRt + 0.2, brAux ) ) );
		brA = mix( brA, brWpPc, brWpPt );
		brOrmh.g = mix( brOrmh.g, 0.6, brWpPt );
		brWpTop = brWpPt;
#if defined( BR_DETAIL_MAPS ) && ! defined( BR_DECAL )
		brDetL.y *= 1.0 - 0.8 * brWpPt; // the rust grain is on the rust
#endif
		// run-off: world drips (the grime texture's drip channel, two projections blended by the normal: no 45-degree seam
		// on pipes and tanks) below rusty areas, found with three coarse taps of C 3, 8 and 18 cm up the surface
		// (derivatives and implicit-LOD fetches outside any per-pixel condition: the branch is per face). Props only: in
		// the shell program its registers cost every shell pixel (measured), and the rusty props carry the look
#ifdef BR_PROPS
		if ( uBrReflPass < 0.5 ) {
			vec3 brWpQx = dFdx( vBrLocal ), brWpQy = dFdy( vBrLocal );
			float brWpG11 = dot( brWpQx, brWpQx ), brWpG12 = dot( brWpQx, brWpQy ), brWpG22 = dot( brWpQy, brWpQy );
			vec2 brWpAb = vec2( brWpG22 * brWpQx.y - brWpG12 * brWpQy.y, brWpG11 * brWpQy.y - brWpG12 * brWpQx.y ) / max( brWpG11 * brWpG22 - brWpG12 * brWpG12, 1e-24 );
			vec2 brWpUp = brWpAb.x * brDx + brWpAb.y * brDy; // uv per metre of rise
			float brWpC1 = textureLod( uBrOrmh, vec3( brUv + 0.03 * brWpUp, brLayerF ), 3.0 ).a;
			float brWpC2 = textureLod( uBrOrmh, vec3( brUv + 0.08 * brWpUp, brLayerF ), 3.5 ).a;
			float brWpC3 = textureLod( uBrOrmh, vec3( brUv + 0.18 * brWpUp, brLayerF ), 4.5 ).a;
			float brWpSrc = ( 1.0 - smoothstep( 0.35, 0.62, min( brWpC1, brWpC2 ) ) ) * 0.8 + ( 1.0 - smoothstep( 0.35, 0.6, brWpC3 ) ) * 0.4;
			float brWpNx = abs( brNWg.x ) / max( abs( brNWg.x ) + abs( brNWg.z ), 1e-4 );
			float brWpDr = mix( texture( uBrGrime, vec2( brPW.x / BR_GRIME_A, brPW.y / BR_GRIME_YA ) ).a,
				texture( uBrGrime, vec2( brPW.z / BR_GRIME_A, brPW.y / BR_GRIME_YA ) ).a, brWpNx );
			float brWpRun = min( brWpSrc, 1.0 ) * ( 0.35 + 0.65 * smoothstep( 0.2, 0.7, brWpDr ) ) * ( 0.5 + 0.5 * brWpPt )
				* ( 1.0 - smoothstep( 0.6, 0.8, abs( brNWg.y ) ) ); // vertical and sloped faces only
			brA *= mix( vec3( 1.0 ), vec3( 0.75, 0.55, 0.4 ), 0.85 * brWpRun );
			brOrmh.g = min( brOrmh.g + 0.1 * brWpRun, 1.0 );
		}
#endif
	} else if ( brL == BR_M_WOOD ) {
		// finish wear (W = ormh.a): where hands and objects wore the finish off, the wood is lighter, a little greyer and
		// rough; edges, the hand band and up-facing tops (things slid over them) go first
		float brWpWd = brWpExpose( brAux, brWpA, brWpLvl + brWpAge * 0.05 * smoothstep( 0.7, 0.95, brNWg.y ) );
		brA = mix( brA, mix( vec3( brLuma( brA ) ), brA, 0.9 ) * 1.25, brWpWd );
		brOrmh.g = mix( brOrmh.g, 0.6, brWpWd );
		brWpExp = brWpWd;
		// end grain (the edge coordinate x's sign on props): the open cells soak up stain and dirt, unfinished and rough
		if ( brWpProp && vBrLmUv.x < 0.0 ) {
			brA *= 0.7;
			brOrmh.g = min( brOrmh.g + 0.2, 1.0 );
		}
#ifdef BR_PROPS
	} else if ( brL == BR_M_PLASTIC ) {
		if ( brWpProp && vBrLmUv.y < 0.0 ) {
			// part kind 1: kraft board. The kraft detail (D20: flutes, floc) replaces the haircell; the liner is matte;
			// crushed, darker and fuzzier within ~6 mm of the edges; the top flaps meet in a dark seam
#if defined( BR_DETAIL_MAPS ) && ! defined( BR_DECAL )
			brDetL.x = ${f(Det.KRAFT)};
			brDetL.y = 1.0;
#endif
			float brWpCr = exp( - brWpEd * 0.2 ) * ( 0.6 + 0.8 * brAux );
			brA *= 1.0 - 0.2 * brWpCr;
			brOrmh.g = mix( 0.85, 0.95, brWpCr );
			if ( brNWg.y > 0.9 ) {
				vec2 brWpA0 = brPropEdgeHS( vBrLmUv.x ), brWpA1 = brPropEdgeHS( vBrLmUv.y );
				// mm off the centre line across the long axis (the flaps' seam, under the tape where there is one)
				float brWpSm = brWpA0.x > brWpA1.x ? brWpA0.x * abs( brWpA0.y ) : brWpA1.x * abs( brWpA1.y );
				// (only on faces with edge coordinates on both axes: a crushed box's hexahedron has none)
				// (widened by the pixel footprint at a constant integral: a sub-pixel seam stays a faint line, not dashes)
				float brWpFw = fwidth( brWpSm );
				float brWpSe = ( 1.0 - smoothstep( 0.6, 1.1 + brWpFw, brWpSm ) ) * 1.1 / ( 1.1 + brWpFw );
				if ( min( brWpA0.x, brWpA1.x ) > 1.5 ) brA *= 1.0 - 0.6 * brWpSe;
			}
			brWpExp = 0.0;
		} else if ( brWpOvr > 0.0 && brWpOvr < 0.12 ) {
			// glossy clear parts (glass, lenses, screens on PLASTIC): no haircell, no scuffs
#if defined( BR_DETAIL_MAPS ) && ! defined( BR_DECAL )
			brDetL.y = 0.0;
#endif
			brWpExp = 0.0;
		} else {
			// moulded plastic: stress-whitened scuffs where edges and the kick zone wear (whitened after the tint, below);
			// UV chalking of up-facing faces on old parts: greyer, lighter, rough
			brWpScr = 0.85 * brWpExp;
			brOrmh.g = min( brOrmh.g + 0.15 * brWpExp, 1.0 );
			float brWpCh = smoothstep( 0.7, 0.95, brNWg.y ) * brWpDec * brWpAge;
			brA = mix( brA, mix( vec3( brLuma( brA ) ), brA, 0.85 ) * 1.08, brWpCh );
			brOrmh.g = mix( brOrmh.g, min( brOrmh.g + 0.2, 1.0 ), brWpCh );
		}
	} else if ( brL == BR_M_METAL_BARE ) {
		// bare metal: sebum smudges and fingerprints (W = the smudge field) in the hand band and a faint film elsewhere:
		// a duller, rougher film
		float brWpSm = brWpExpose( brAux, brWpA, brWpAge * ( 0.04 + 0.4 * brWpHand ) );
		brA *= 1.0 - 0.1 * brWpSm;
		brOrmh.g = min( brOrmh.g + 0.2 * brWpSm, 1.0 );
		brWpExp = 0.0;
#endif
	}
}
#if BR_DETAIL == 0
// low quality: no wear, but rust keeps its paint remnants (a plain threshold of C) so the rust itself stays untinted
if ( brL == BR_M_METAL_RUST ) {
	brWpTop = smoothstep( 0.6, 0.64, brOrmh.a );
	brA = mix( brA, vec3( ${f(RUST_PAINT_REF)} ), brWpTop );
	brOrmh.g = mix( brOrmh.g, 0.6, brWpTop );
}
#endif
// rubber bloom: a waxy antiozonant film (the recipe's mottle, ormh.a) that greys up-facing faces, more on old parts
if ( BR_DETAIL == 1 && brL == BR_M_RUBBER ) {
	float brWpBl = smoothstep( 0.3, 0.8, brNWg.y ) * brAux
		* ( brWpProp ? 0.25 + 0.75 * float( ( int( brAuxB.z ) >> 2 ) & 63 ) / 63.0 : 0.6 );
	brA += vec3( 0.06, 0.058, 0.055 ) * brWpBl;
	brOrmh.g = min( brOrmh.g + 0.15 * brWpBl, 1.0 );
}
// tint headroom and topcoat mask. Props store tint / 2 (decoded x2 here); the tint colours the topcoat only (brWpTop):
// exposed primer / steel / rust keep the recipe's colour. Whitened scratches and scuffs act on the tinted colour. The
// surface multiplies by vBrTint after the grime and wetness, so brA is pre-divided (tint bytes are >= 1 on props); the
// grime and wetness then act on the untinted colour as before lane E
if ( brWpProp || brWpOn ) {
	vec3 brWpT = brWpProp ? vBrTint.rgb * 2.0 : vBrTint.rgb;
	vec3 brWpC = brA * mix( vec3( 1.0 ), brWpT, brWpTop );
	if ( brWpScr > 0.0 ) brWpC = mix( brWpC, vec3( brLuma( brWpC ) * 1.3 + 0.04 ), 0.7 * brWpScr ); // stress-whitened paint
	brA = brWpC / max( vBrTint.rgb, vec3( 1.0 / 255.0 ) );
}
}
#endif
`,
  postDetail: '',
  grime: /* glsl */ `
	else if ( brGrime == BR_G_METAL ) {
		// metal: rust run-off streaks (drips g1.a where the WP7 mask holds grime; the smooth tide field g2.r, not the
		// speckle channel: speckle made leopard spots) on steel that can rust; stainless and chrome only dull
		if ( brL != BR_M_METAL_BARE && brL != BR_M_METAL_RUST ) { // (METAL_RUST: its own run-off, postSample)
			float rust = smoothstep( 0.5, 0.85, brMask.g * 0.8 + g1.a * 0.6 + g2.r * 0.2 );
			// on paint these are thin stains over an intact film, not scale: a lighter tint, and the gloss mostly kept (the
			// tide field's blobs had turned painted pipes' highlights into lumps)
			rust *= brL == BR_M_METAL_PAINTED ? 0.5 : 1.0;
			brA = mix( brA, BR_RUST * ( 0.8 + 0.4 * g2.r ), rust * 0.75 );
			brMetal *= 1.0 - rust;
			brRoughMul = mix( 1.0, brL == BR_M_METAL_PAINTED ? 1.2 : 1.6, rust );
		}
		// settled dust on up-facing shell steel (props get the anchor cell's dust in surface.ts), heavier in the mask's
		// grime; a greasy hand band on painted steel (glossier)
		float brWpDu = ( ( brF & BR_F_PROP_AUX ) != 0 || brNWg.y < 0.5 ) ? 0.0 : smoothstep( 0.5, 0.95, brNWg.y ) * clamp( 0.25 + brMask.g + 0.3 * ( g2.r - 0.5 ), 0.0, 1.0 );
		brA = mix( brA, BR_DUST_COLOR, 0.55 * brWpDu );
		brMetal *= 1.0 - brWpDu;
		brRoughMul *= mix( 1.0, 1.5, brWpDu );
		if ( brL == BR_M_METAL_PAINTED ) {
			float brWpGr = exp( - ( vBrLocal.y - 1.2 ) * ( vBrLocal.y - 1.2 ) * 11.0 ) * smoothstep( 0.35, 0.7, g2.r ) * ( 1.0 - abs( brNWg.y ) );
			brRoughMul *= 1.0 - 0.35 * brWpGr * brWpTop;
		}
	}
`,
  postWet: '',
  rough: /* glsl */ `
// ---- lane E: the 'wear' layers carry their exposed roughness and the override-scaled topcoat in ormh.g (postSample):
// replace the override with it (Toksvig and LEAN as above)
if ( BR_DETAIL == 1 && brAuxK == BR_AUX_WEAR ) {
	brRt = sqrt( brOrmh.g * brOrmh.g + brVar );
#if defined( BR_DETAIL_MAPS ) && ! defined( BR_DECAL )
	brRt = sqrt( sqrt( pow4( brRt ) + brDetVar ) );
#endif
}
`,
  normal: '',
  matPost: /* glsl */ `
// clearcoat (props with the coat bit: car paint): a lacquer lobe over the topcoat that dust dulls, at the part's
// override-scaled roughness
#ifdef USE_CLEARCOAT
brCoat = ( brF & BR_F_PROP_AUX ) != 0 && vBrEmit <= 0.0 && ( int( brAuxB.z ) & 2 ) != 0;
material.clearcoat = brCoat ? brWpTop * ( 1.0 - brDust ) : 0.0;
material.clearcoatRoughness = min( max( max( BR_COAT_ROUGH, 0.0525 ), 0.35 * brAuxB.x / 255.0 ) + geometryRoughness, 1.0 );
material.clearcoatF0 = vec3( 0.04 );
material.clearcoatF90 = 1.0;
#endif
// kraft board (PLASTIC part kind 1): a fibrous liner, rough diffuse (EON sigma 0.5)
if ( brL == BR_M_PLASTIC && ( brF & BR_F_PROP_AUX ) != 0 && vBrEmit <= 0.0 && vBrLmUv.y < 0.0 ) brDiffSigma = 0.5;
`,
  postLight: '',
  preFog: '',
};

/** After three's clearcoat_normal_fragment_begin (anchors.ts): the coat follows the base map's normal (orange peel and
 * oil-canning), not the unperturbed geometric normal. */
export const PROP_COAT_NORMAL_GLSL = /* glsl */ `
#ifdef USE_CLEARCOAT
clearcoatNormal = normalize( brTbn * vec3( brNrm.xy * brNrmScale, max( brNrm.z, 1e-3 ) ) );
#endif
`;
