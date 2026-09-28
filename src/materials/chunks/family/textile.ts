// src/materials/chunks/family/textile.ts — texture realism v2 family hooks: textiles (CARPET_L0, CARPET_OFFICE,
// FABRIC_PARTITION). Owns grime profile 1 (carpet), the textile sheen (materialPost) and the Level 0 pile trap
// (preFog). Lane A's file; hook points and rules in chunks/family/index.ts. The 'textile' debug view (25) is this
// family's: a hook shows its value with `if ( uDebugView == BR_DV_TEXTILE ) BR_DEBUG_EXIT( v )` (chunks/debug.ts).

import type { FamilyHooks } from './index.ts';

/** Level 0 carpet pile trap (preFog): radiance scale and the saturation exponent on the albedo's chroma. */
export const CARPET_L0_PILE_TRAP = 0.55;
export const CARPET_L0_PILE_SAT = 0.3;

export const TEXTILE_HOOKS: FamilyHooks = {
  pars: /* glsl */ `
#define BR_PILE_TRAP ${CARPET_L0_PILE_TRAP.toFixed(4)}
#define BR_PILE_SAT ${CARPET_L0_PILE_SAT.toFixed(4)}
`,
  postSample: '',
  postDetail: '',
  grime: /* glsl */ `
	else if ( brGrime == BR_G_CARPET ) {
		// carpet: damage (A) = trodden wear paths / thresholds / lanes; grime (G) = dirt near walls; wet patches (B)
		float wear = smoothstep( 0.25, 0.75, brMask.a + ( g1.b - 0.5 ) * 0.3 );
		brWear = wear;
		vec3 worn = mix( brA, vec3( brLuma( brA ) ), 0.25 ) * ( 1.0 + BR_CARPET_WEAR_LIGHTEN );
		brA = mix( brA, worn, wear * 0.8 );
		brNrmScale *= 1.0 - BR_CARPET_WEAR_NORMAL * wear;
		brA *= 1.0 - 0.35 * clamp( brMask.g * ( 0.55 + 0.9 * g1.g ), 0.0, 1.0 );
		if ( BR_DETAIL == 1 && brHoriz ) {
			float b = brBlotch( brS2, true, 301u, 0.42, 0.25, 0.75, ( g2.g - 0.5 ) * 0.5 );
			brA *= mix( vec3( 1.0 ), vec3( 0.7, 0.64, 0.55 ), b * clamp( 0.35 + brMask.g + brMask.a, 0.0, 1.0 ) );
			// pile lean: soft world patches (1.2 m) where the pile leans one way read lighter from one side and
			// darker from the other (view-dependent sheen of cut pile); crushed / worn pile shows less of it
			vec3 brVW = ( vec4( vViewPosition, 0.0 ) * viewMatrix ).xyz;
			float brVL = length( brVW.xz );
			if ( brVL > 1e-4 ) {
				float pa = brVNoise( brS2 / BR_CARPET_PILE_CELL, ivec2( BR_CARPET_PILE_P ), 331u ) * 12.566;
				float pamp = smoothstep( 0.2, 0.8, brVNoise( brS2 / ( 2.0 * BR_CARPET_PILE_CELL ), ivec2( BR_CARPET_PILE_P / 2 ), 337u ) );
				float sh = dot( brVW.xz / brVL, vec2( cos( pa ), sin( pa ) ) );
				brPileLean = sh * ( 0.3 + 0.7 * pamp ) * ( 1.0 - 0.5 * wear );
				brA *= 1.0 + BR_CARPET_PILE_SHADE * brPileLean * ( 1.0 - wet );
			}
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
		// damp: a dried tide ring (dirty-water brown) at the patch edge; the damp interior darkens, saturates and
		// clumps through the porosity model below, mottled by the tide field
		float ring = smoothstep( 0.1, 0.2, wetRaw ) * ( 1.0 - smoothstep( 0.2, 0.32, wetRaw ) );
		brA *= mix( vec3( 1.0 ), vec3( 0.8, 0.7, 0.55 ), 0.5 * ring );
		brA *= mix( vec3( 1.0 ), mix( 0.88, 1.0, g1.r ) * vec3( 1.02, 0.98, 0.9 ), wet );
	}
`,
  postWet: '',
  rough: '',
  normal: '',
  matPost: /* glsl */ `
// textile sheen (Charlie lobe): fibre-tinted, lost where the pile is wet or crushed (and under standing water); the
// pile lean seen from the camera narrows / widens it
#ifdef USE_SHEEN
{
	vec4 brLD = uBrLayerD[ brL ];
	material.sheenColor = brLD.z * sqrt( max( diffuseColor.rgb, vec3( 0.0 ) ) ) * ( 1.0 - 0.85 * max( brFilm, brAbs ) ) * ( 1.0 - 0.4 * brWear ) * ( 1.0 - brPuddle );
	material.sheenRoughness = clamp( brLD.w + BR_SHEEN_LEAN_ROUGH * brPileLean, 0.07, 1.0 );
}
#endif
`,
  postLight: '',
  preFog: /* glsl */ `
#ifndef BR_DECAL
	if ( brL == BR_M_CARPET_L0 ) {
		// Level 0 pile trap: the layer table albedo is the fibre colour (the bake's bounce uses it), but a damp cut
		// pile under overhead light traps part of it between the tufts, and what escapes has scattered through more
		// dyed fibre: darker and more saturated than a flat sample. Without this the floor, which receives ~2x the
		// wall irradiance, rendered as bright as the wallpaper (reference photo: clearly darker, mustard-brown).
		// Applied to the surface radiance only, before the submerged optics (FLOODED_HALL's carpet): the water's
		// in-scatter is not the carpet's to trap.
		vec3 brPa = max( diffuseColor.rgb, vec3( 1e-4 ) );
		gl_FragColor.rgb *= BR_PILE_TRAP * pow( brPa / max( max( brPa.r, brPa.g ), brPa.b ), vec3( BR_PILE_SAT ) );
	}
#endif
`,
};
