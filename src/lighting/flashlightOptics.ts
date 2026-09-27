// src/lighting/flashlightOptics.ts — the flashlight's optics: the single source of its photometric constants and of
// its beam profile, for every consumer (the SpotLight in Flashlight.ts, the cookie texture, the bounce VPLs, the
// froxel volumetrics and the dust motes, and the water glints / in-water beam of package E). Pure (no three).
//
// The beam is modelled on a reflector LED torch filmed on a wall through a camcorder: a round hotspot about 9 deg
// across at half maximum (the LED die imaged by the reflector: a slightly square, flat-topped core), a faint warm
// phosphor ring at its edge, a smooth halo falling from the hotspot into a much dimmer, wide spill (about 3 % of the
// peak) and a soft outer edge where the spill fades between 25 and 37 deg (the reflector lip seen from the die's
// finite size: a penumbra of several degrees, not a razor rim). With t = theta in degrees and g(x) = exp(-x^2):
//
//   I(t) = [core + halo + phos + spill] * rim * ripple / NORM      (I(0) = 1)
//     core   = exp(-(ts / CORE_DEG)^CORE_EXP)       ts = the die-shaped angle (a softly square image of the die)
//     halo   = HALO.a * g(t / HALO.w)              the reflector's scatter around the hotspot
//     phos   = PHOSPHOR.a * g((t - c) / s)         yellow phosphor ring (tint in the cookie)
//     spill  = SPILL.a * (1 - droop * (t / RIM.out)^2)
//     rim    = 1 - smoothstep(RIM.in, RIM.out, t)   soft reflector cut-off
//     ripple = 1 + RIPPLE.a * sin(RIPPLE.f * t + 1.3) * smoothstep(10, 14, t)   faint faceting rings in the halo
//
// Rendered intensity (cd) = PEAK_CD * I(theta) * three's spot attenuation (smoothstep over the last PENUMBRA of the
// cone, which lies beyond the rim). beamProfileGlsl() emits the same function as GLSL from these numbers, so the TS
// mirror, the cookie and any shader consumer cannot drift apart.

import { f } from '../materials/chunks/params.ts';

export const FLASHLIGHT_OPTICS = {
  /** rad: SpotLight.angle, just beyond the rim (three's penumbra ramp, the last PENUMBRA of it, starts past RIM.out) */
  CONE: 0.69,
  /** SpotLight.penumbra: three's own edge ramp covers the last 6 % of the cone, outside the soft rim */
  PENUMBRA: 0.06,
  /** cd at the beam axis (SpotLight.intensity; the cookie is normalised to 1 there) */
  PEAK_CD: 5500,
  /** m: SpotLight.distance (three's (1 - (d/R)^4)^2 window) and the shadow camera's far plane */
  RANGE: 40,
  /** SpotLightShadow.focus: the cookie and the shadow map span CONE * MAP_FOCUS. three looks the cookie up at the
   * shadow-normal-biased position (shadowmap_vertex: + normal * normalBias), which reads a larger angle than the
   * surface point's on near walls (+1.1 deg at 0.5 m); where that lookup leaves the map three skips the cookie and
   * the bare cone shines through as thin crescents. The margin keeps every lit angle inside the map. */
  MAP_FOCUS: 1.1,
  /** deg: the hotspot's 1/e half-width, and the exponent of its flat-topped fall-off (FWHM ~9 deg) */
  CORE_DEG: 5.0,
  CORE_EXP: 2.2,
  HALO: { a: 0.16, w: 11 },
  PHOSPHOR: { a: 0.03, c: 7.5, s: 1.5, tint: [1.0, 0.88, 0.6] as const },
  SPILL: { a: 0.036, droop: 0.45 },
  RIM: { in: 25, out: 37 },
  RIPPLE: { a: 0.025, f: 2.1 },
} as const;

const O = FLASHLIGHT_OPTICS;
const DEG = 180 / Math.PI;
const gauss = (x: number): number => Math.exp(-x * x);
/** GLSL smoothstep (edge0 < edge1). */
const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Unnormalised profile at t degrees (ts: the die-shaped angle, degrees). */
function beamRaw(t: number, ts: number): number {
  const core = Math.exp(-Math.pow(ts / O.CORE_DEG, O.CORE_EXP)); // ts >= 0
  const halo = O.HALO.a * gauss(t / O.HALO.w);
  const phos = O.PHOSPHOR.a * gauss((t - O.PHOSPHOR.c) / O.PHOSPHOR.s);
  const u = t / O.RIM.out;
  const spill = O.SPILL.a * (1 - O.SPILL.droop * u * u);
  const rim = 1 - smoothstep(O.RIM.in, O.RIM.out, t);
  const ripple = 1 + O.RIPPLE.a * Math.sin(O.RIPPLE.f * t + 1.3) * smoothstep(10, 14, t);
  return (core + halo + phos + spill) * rim * ripple;
}

/** Normaliser: I(0) = 1. */
export const BEAM_NORM = beamRaw(0, 0);

/** Relative beam intensity I(theta) / I(0) (TS mirror of brBeam). dieThetaRad: the die-shaped angle the cookie uses
 * for the core (defaults to theta: the round, azimuthally averaged profile). */
export function beamProfile(thetaRad: number, dieThetaRad = thetaRad): number {
  const t = Math.abs(thetaRad) * DEG;
  if (t >= O.RIM.out) return 0;
  return beamRaw(t, Math.abs(dieThetaRad) * DEG) / BEAM_NORM;
}

/** Smooth beam profile for consumers whose few samples cannot resolve the die image (the analytic flashlight
 * airlight: 6 samples along a view ray, per pixel): the round core, the halo and the spill, cut by the rim; no ring
 * or ripple. It works in t^2 (deg^2) straight from cos(theta), without acos: t^2 = (2x + x^2 / 3) DEG^2 with
 * x = 1 - cos(theta) (the series of acos^2: t is 0.06 % short at the rim), and its rim ramp is a smoothstep over t^2.
 * 1 on the axis. TS mirror of brBeamSoft( cos ). */
export function beamProfileSoftCos(cosTheta: number): number {
  const x = 1 - cosTheta;
  return beamSoftRaw((2 * x + (x * x) / 3) * DEG * DEG) / SOFT_NORM;
}
/** beamProfileSoft at an angle (rad). */
export function beamProfileSoft(thetaRad: number): number {
  return beamProfileSoftCos(Math.cos(thetaRad));
}
function beamSoftRaw(t2: number): number {
  const core = Math.exp(-Math.pow(Math.max(t2, 0) / (O.CORE_DEG * O.CORE_DEG), O.CORE_EXP / 2));
  const halo = O.HALO.a * Math.exp(-t2 / (O.HALO.w * O.HALO.w));
  const spill = O.SPILL.a * (1 - (O.SPILL.droop * t2) / O.RIM.out ** 2);
  return (core + halo + spill) * (1 - smoothstep(O.RIM.in ** 2, O.RIM.out ** 2, t2));
}
const SOFT_NORM = beamSoftRaw(0);

/** Weight 0..1 of the phosphor ring at theta (the cookie tints toward PHOSPHOR.tint by it). */
export function phosphorWeight(thetaRad: number): number {
  return gauss((Math.abs(thetaRad) * DEG - O.PHOSPHOR.c) / O.PHOSPHOR.s);
}

/** three's getSpotAttenuation for the flashlight: smoothstep(cos(CONE), cos(CONE * (1 - PENUMBRA)), cos(theta)). */
export function spotAttenuation(thetaRad: number): number {
  const c = Math.cos(thetaRad);
  const c0 = Math.cos(O.CONE), c1 = Math.cos(O.CONE * (1 - O.PENUMBRA));
  return smoothstep(c0, c1, c);
}

/** Rendered intensity (cd) at theta off the axis: PEAK_CD * I(theta) * spot attenuation. */
export function beamIntensity(thetaRad: number): number {
  return O.PEAK_CD * beamProfile(thetaRad) * spotAttenuation(thetaRad);
}

/** Luminous flux (lm) of the beam between polar angles t0 and t1 (rad) over the full azimuth: 2 PI * the integral
 * of PEAK_CD * I(theta) * sin(theta), Simpson's rule. rendered = true includes three's spot attenuation (what the
 * scene actually receives). */
export function beamFluxLm(t0 = 0, t1: number = O.CONE, steps = 4000, rendered = false): number {
  const n = steps + (steps & 1);
  const h = (t1 - t0) / n;
  let s = 0;
  for (let i = 0; i <= n; i++) {
    const th = t0 + i * h;
    const w = i === 0 || i === n ? 1 : i & 1 ? 4 : 2;
    const I = rendered ? beamIntensity(th) : O.PEAK_CD * beamProfile(th);
    s += w * I * Math.sin(th);
  }
  return (2 * Math.PI * s * h) / 3;
}

/** Flux-weighted mean polar angle (rad) of the beam between t0 and t1 (rendered intensity). */
export function beamCentroid(t0: number, t1: number, steps = 1000): number {
  const n = steps + (steps & 1);
  const h = (t1 - t0) / n;
  let s = 0, st = 0;
  for (let i = 0; i <= n; i++) {
    const th = t0 + i * h;
    const w = (i === 0 || i === n ? 1 : i & 1 ? 4 : 2) * beamIntensity(th) * Math.sin(th);
    s += w;
    st += w * th;
  }
  return s > 0 ? st / s : 0.5 * (t0 + t1);
}

/** GLSL twin of beamProfile: `float brBeam( float th, float ths )` (radians; 0 at and beyond RIM.out) and
 * `float brBeamPhos( float th )` (phosphorWeight). Self-contained (its own gauss), so any shader can include it. */
export function beamProfileGlsl(): string {
  return /* glsl */ `
// ---- flashlight beam profile (lighting/flashlightOptics.ts; the TS mirror is beamProfile)
float brBeamG( float x ) { return exp( - x * x ); }
float brBeamRaw( float t, float ts ) {
	float core = exp( - pow( ts * ${f(1 / O.CORE_DEG)}, ${f(O.CORE_EXP)} ) );
	float halo = ${f(O.HALO.a)} * brBeamG( t / ${f(O.HALO.w)} );
	float phos = ${f(O.PHOSPHOR.a)} * brBeamG( ( t - ${f(O.PHOSPHOR.c)} ) / ${f(O.PHOSPHOR.s)} );
	float u = t / ${f(O.RIM.out)};
	float spill = ${f(O.SPILL.a)} * ( 1.0 - ${f(O.SPILL.droop)} * u * u );
	float rim = 1.0 - smoothstep( ${f(O.RIM.in)}, ${f(O.RIM.out)}, t );
	float ripple = 1.0 + ${f(O.RIPPLE.a)} * sin( ${f(O.RIPPLE.f)} * t + 1.3 ) * smoothstep( 10.0, 14.0, t );
	return ( core + halo + phos + spill ) * rim * ripple;
}
float brBeam( float th, float ths ) {
	float t = abs( th ) * ${f(DEG)};
	if ( t >= ${f(O.RIM.out)} ) return 0.0;
	return brBeamRaw( t, abs( ths ) * ${f(DEG)} ) * ${f(1 / BEAM_NORM)};
}
float brBeamPhos( float th ) { return brBeamG( ( abs( th ) * ${f(DEG)} - ${f(O.PHOSPHOR.c)} ) / ${f(O.PHOSPHOR.s)} ); }
`;
}

/** GLSL twin of beamProfileSoftCos: `float brBeamSoft( float ca )` (ca = cos(theta)). Self-contained. */
export function beamSoftGlsl(): string {
  const d2 = DEG * DEG;
  return /* glsl */ `
// ---- flashlight beam, smooth profile of cos(theta) (lighting/flashlightOptics.ts beamProfileSoftCos)
float brBeamSoft( float ca ) {
	float x = 1.0 - ca;
	float t2 = max( ( 2.0 * x + x * x * ${f(1 / 3)} ) * ${f(d2)}, 0.0 );
	float I = exp( - pow( t2 * ${f(1 / O.CORE_DEG ** 2)}, ${f(O.CORE_EXP / 2)} ) )
		+ ${f(O.HALO.a)} * exp( - t2 * ${f(1 / O.HALO.w ** 2)} )
		+ ${f(O.SPILL.a)} * ( 1.0 - t2 * ${f(O.SPILL.droop / O.RIM.out ** 2)} );
	return I * ( 1.0 - smoothstep( ${f(O.RIM.in ** 2)}, ${f(O.RIM.out ** 2)}, t2 ) ) * ${f(1 / SOFT_NORM)};
}
`;
}
