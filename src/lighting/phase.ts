// src/lighting/phase.ts — package F: scattering phase functions of the air (froxel volumetrics, dust motes).
// Henyey-Greenstein lobes, normalised over the sphere (integral of p over 4 PI sr = 1):
//   HG(mu, g) = (1 - g^2) / (4 PI (1 + g^2 - 2 g mu)^1.5)
// mu = cos of the scattering angle between the light's propagation direction and the direction toward the camera:
// with l the unit vector from the scattering point toward the light and rd the view ray (camera -> point),
// mu = dot(l, rd); +1 is forward scattering (looking into the light), -1 back-scattering (a torch at the eye).
// The haze and dust use a dual lobe (1 - wB) HG(gF) + wB HG(gB): forward halos around the lamps and a back lobe that
// keeps a torch held at the eye visible in the air; the atmosphere's hazePhase is the forward weight 1 - wB. Mist
// droplets scatter strongly forward (MIST_G). Pure (no three).

import { f } from '../materials/chunks/params.ts';

export const PHASE = {
  /** forward lobe asymmetry of haze and dust */
  G_F: 0.5,
  /** back lobe asymmetry */
  G_B: -0.25,
  /** default forward-lobe weight (AtmosphereParams.hazePhase) */
  W_F: 0.7,
  /** mist droplets (micron-sized water: strongly forward) */
  MIST_G: 0.75,
} as const;

/** Henyey-Greenstein phase function (1/sr). */
export function hg(mu: number, g: number): number {
  const d = 1 + g * g - 2 * g * mu;
  return (1 - g * g) / (4 * Math.PI * d * Math.sqrt(d));
}

/** Dual-lobe HG with forward weight wF. */
export function dualHg(mu: number, wF: number = PHASE.W_F, gF: number = PHASE.G_F, gB: number = PHASE.G_B): number {
  return wF * hg(mu, gF) + (1 - wF) * hg(mu, gB);
}

/** GLSL: brHG( mu, g ), brPhaseAir( mu, wF ) (the dual lobe), brPhaseMist( mu ). Self-contained. */
export const PHASE_GLSL = /* glsl */ `
// ---- scattering phase functions (package F, lighting/phase.ts)
float brHG( float mu, float g ) {
	float d = 1.0 + g * g - 2.0 * g * mu;
	return ( 1.0 - g * g ) / ( 12.566370614359172 * d * sqrt( d ) );
}
float brPhaseAir( float mu, float wF ) { return wF * brHG( mu, ${f(PHASE.G_F)} ) + ( 1.0 - wF ) * brHG( mu, ${f(PHASE.G_B)} ); }
float brPhaseMist( float mu ) { return brHG( mu, ${f(PHASE.MIST_G)} ); }
`;
