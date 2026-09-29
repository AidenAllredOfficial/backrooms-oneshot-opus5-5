// src/materials/chunks/grimeLib.ts — texture realism v2 (0b): shared grime helpers for the family hooks (appended to
// the fragment common block before the families' pars). Pure GLSL; the families call them from their grime branches.
//  - brHeightBlend: a mask coverage that fills the low relief first (stains, damp, oil, soil, efflorescence enter
//    pores and joints before the faces), crisp near the camera and soft far away, where the relief filters to its mean.
//  - brStainFront: the capillary fronts of a dried water stain on porous board or paper: 3 nested, ragged tide lines
//    (repeated wet / dry cycles), each a deposit darkest at its outer edge (sharp outside, 4x softer inside: the
//    coffee-ring effect), anti-aliased by the field's screen-space footprint. TS twin: stainFront below.

import { f } from './params.ts';

/** brStainFront: extra spacing of the inner fronts (L1 = L0 + a + b h1, L2 = L1 + c + d h2) and the weight lost per
 * nested front. */
export const STAIN_FRONT = { A1: 0.07, B1: 0.05, A2: 0.05, B2: 0.08, NEST_FADE: 0.3, FINE: 0.06, W_MIN: 0.006, W_PX: 1.5, INNER: 4 } as const;

/** TS twin of brHeightBlend: coverage of mask value m at relief rel (-1..1). */
export const heightBlend = (m: number, rel: number, k = 0.5, e = 0.12): number =>
  Math.min(1, Math.max(0, (m * (1 + k) - k * (0.5 + 0.5 * rel)) / e));

/**
 * TS twin of brStainFront for a field value s', front L0, footprint w and front hashes h1, h2 in [0, 1): the tide
 * deposit (0..1) and the inside coverage (smoothstep across L0).
 */
export function stainFront(sp: number, l0: number, w: number, h1: number, h2: number): { inside: number; tide: number } {
  const l1 = l0 + STAIN_FRONT.A1 + STAIN_FRONT.B1 * h1;
  const l2 = l1 + STAIN_FRONT.A2 + STAIN_FRONT.B2 * h2;
  let tide = 0;
  [l0, l1, l2].forEach((l, k) => {
    const d = sp - l;
    const t = d < 0 ? Math.exp(-((d / w) ** 2)) : Math.exp(-d / (STAIN_FRONT.INNER * w));
    tide = Math.max(tide, t * (1 - STAIN_FRONT.NEST_FADE * k));
  });
  const x = Math.min(1, Math.max(0, (sp - (l0 - w)) / (2 * w)));
  return { inside: x * x * (3 - 2 * x), tide };
}

export const GRIME_LIB_GLSL = /* glsl */ `
// ---- texture realism v2 grime helpers (chunks/grimeLib.ts)
// Height-blended mask coverage: m the mask value 0..1, rel the relief -1..1 (brRel / BR_L_RELIEF, clamped; 0 far away
// where the mips flatten it), K how far the relief shifts the threshold (0.5), E the edge width (0.12): coverage reaches
// the low relief (rel < 0) at lower m, so an advancing front fills pores and joints first.
float brHeightBlend( float m, float rel, float K, float E ) {
	return clamp( ( m * ( 1.0 + K ) - K * ( 0.5 + 0.5 * rel ) ) / E, 0.0, 1.0 );
}
// Nested stain fronts on a stain field s (higher = wetter; inside for s' > L0). fine: the caller's zero-mean fine field
// that roughens the fronts (the layer's own relief, the detail multiplier, grime noise; scaled by ${f(STAIN_FRONT.FINE)}).
// L0: the outer front level; the spacing of the two inner fronts is hashed from L0's bits, so a caller that jitters L0
// per stain or per tile gets per-stain spacing. inside: 0..1 across the outer front; tide: the deposit 0..1 (the
// caller modulates and colours it). Calls fwidth: only in quad-uniform control flow (gate on brL / brGrime).
void brStainFront( float s, float fine, float L0, out float inside, out float tide ) {
	float sp = s + ${f(STAIN_FRONT.FINE)} * fine;
	float w = max( ${f(STAIN_FRONT.W_MIN)}, ${f(STAIN_FRONT.W_PX)} * fwidth( sp ) );
	uint h = brPcg( floatBitsToUint( L0 ) );
	float L1 = L0 + ${f(STAIN_FRONT.A1)} + ${f(STAIN_FRONT.B1)} * brU01( h );
	float L2 = L1 + ${f(STAIN_FRONT.A2)} + ${f(STAIN_FRONT.B2)} * brU01( brPcg( h ) );
	tide = 0.0;
	for ( int k = 0; k < 3; k ++ ) {
		float d = sp - ( k == 0 ? L0 : k == 1 ? L1 : L2 );
		float t = d < 0.0 ? exp( - ( d / w ) * ( d / w ) ) : exp( - d / ( ${f(STAIN_FRONT.INNER)} * w ) );
		tide = max( tide, t * ( 1.0 - ${f(STAIN_FRONT.NEST_FADE)} * float( k ) ) );
	}
	inside = smoothstep( L0 - w, L0 + w, sp );
}
`;
