// src/lighting/flashlightOptics.ts — the flashlight's optics: the single source of its photometric constants and of
// its beam profile, for every consumer (the SpotLight in Flashlight.ts, the cookie texture, the bounce VPLs, and the
// water / volumetric consumers of later packages). Pure (no three).
//
// The beam is modelled on a reflector LED torch measured on a wall: a small, slightly square LED-die hotspot
// (about +-4 deg) with a dark ring and a yellowish phosphor ring at its edge, a dimmer corona out to about 24 deg, a
// wide flat spill at about 7 % of the peak, a faint bright lip where the reflector ends, and a crisp cut-off at
// 35.5 deg (the SpotLight cone). With t = theta in degrees and g(x) = exp(-x^2):
//
//   I(t) = [max(core, shoulder) + dark + phos + corona + spill + lip] * rim * ripple / NORM      (I(0) = 1)
//     core     = exp(-(ts / CORE_DEG)^3)                ts = the die-shaped angle (a softly square image of the die)
//     shoulder = SHOULDER.a * g(t / SHOULDER.w)
//     dark     = DARK_RING.a * g((t - c) / s)            the thin dark ring around the die image
//     phos     = PHOSPHOR.a * g((t - c) / s)             yellow phosphor ring (tint in the cookie)
//     corona   = CORONA.a * (1 - smoothstep(from, to, t))
//     spill    = SPILL.a * (1 - droop * (t / RIM.out)^2)
//     lip      = LIP.a * g((t - c) / s)                  the reflector's last facet
//     rim      = 1 - smoothstep(RIM.in, RIM.out, t)      reflector cut-off
//     ripple   = 1 + RIPPLE.a * sin(RIPPLE.f * t + 1.3) * smoothstep(10, 14, t)   faceting rings in the corona
//
// Rendered intensity (cd) = PEAK_CD * I(theta) * three's spot attenuation (smoothstep over the last PENUMBRA of the
// cone, which the rim already sits inside). beamProfileGlsl() emits the same function as GLSL from these numbers,
// so the TS mirror, the cookie and any shader consumer cannot drift apart.

import { f } from '../materials/chunks/params.ts';

export const FLASHLIGHT_OPTICS = {
  /** rad: spill cut-off half-angle (= SpotLight.angle; the cookie spans exactly this cone) */
  CONE: 0.62,
  /** SpotLight.penumbra: three's own edge ramp covers the last 6 % of the cone, inside the reflector rim */
  PENUMBRA: 0.06,
  /** cd at the beam axis (SpotLight.intensity; the cookie is normalised to 1 there) */
  PEAK_CD: 3000,
  /** m: SpotLight.distance (three's (1 - (d/R)^4)^2 window) and the shadow camera's far plane */
  RANGE: 40,
  /** SpotLightShadow.focus: the cookie and the shadow map span CONE * MAP_FOCUS. three looks the cookie up at the
   * shadow-normal-biased position (shadowmap_vertex: + normal * normalBias), which reads a larger angle than the
   * surface point's on near walls (+1.1 deg at 0.5 m); where that lookup leaves the map three skips the cookie and
   * the bare cone shines through as thin crescents. The margin keeps every lit angle inside the map. */
  MAP_FOCUS: 1.1,
  CORE_DEG: 4.0,
  SHOULDER: { a: 0.42, w: 8.5 },
  DARK_RING: { a: -0.05, c: 6.2, s: 0.8 },
  PHOSPHOR: { a: 0.07, c: 9.5, s: 1.3, tint: [1.0, 0.88, 0.6] as const },
  CORONA: { a: 0.16, from: 9, to: 24 },
  // design value 0.085 put the plateau at 5.6 % of the peak and the flux at 386 lm; 0.11 gives 7 % and ~430 lm
  SPILL: { a: 0.11, droop: 0.35 },
  RIM: { in: 33.8, out: 35.5 },
  LIP: { a: 0.025, c: 33.2, s: 0.45 },
  RIPPLE: { a: 0.035, f: 2.1 },
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
  const q = ts / O.CORE_DEG;
  const core = Math.exp(-q * q * q); // ts >= 0; order 3: the die image blurred by the reflector
  const shoulder = O.SHOULDER.a * gauss(t / O.SHOULDER.w);
  const dark = O.DARK_RING.a * gauss((t - O.DARK_RING.c) / O.DARK_RING.s);
  const phos = O.PHOSPHOR.a * gauss((t - O.PHOSPHOR.c) / O.PHOSPHOR.s);
  const corona = O.CORONA.a * (1 - smoothstep(O.CORONA.from, O.CORONA.to, t));
  const u = t / O.RIM.out;
  const spill = O.SPILL.a * (1 - O.SPILL.droop * u * u);
  const lip = O.LIP.a * gauss((t - O.LIP.c) / O.LIP.s);
  const rim = 1 - smoothstep(O.RIM.in, O.RIM.out, t);
  const ripple = 1 + O.RIPPLE.a * Math.sin(O.RIPPLE.f * t + 1.3) * smoothstep(10, 14, t);
  return (Math.max(core, shoulder) + dark + phos + corona + spill + lip) * rim * ripple;
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
 * airlight: 6 samples along a view ray, per pixel): a Gaussian core of the die's width over the shoulder, the corona
 * and the spill, cut by the rim; no rings, lip or ripple. It works in t^2 (deg^2) straight from cos(theta), without
 * acos: t^2 = (2x + x^2 / 3) DEG^2 with x = 1 - cos(theta) (the series of acos^2: t is 0.06 % short at the rim), and its
 * corona / rim ramps are smoothsteps over t^2. 1 on the axis. TS mirror of brBeamSoft( cos ). */
export function beamProfileSoftCos(cosTheta: number): number {
  const x = 1 - cosTheta;
  return beamSoftRaw((2 * x + (x * x) / 3) * DEG * DEG) / SOFT_NORM;
}
/** beamProfileSoft at an angle (rad). */
export function beamProfileSoft(thetaRad: number): number {
  return beamProfileSoftCos(Math.cos(thetaRad));
}
function beamSoftRaw(t2: number): number {
  const core = Math.exp(-t2 / (O.CORE_DEG * O.CORE_DEG));
  const shoulder = O.SHOULDER.a * Math.exp(-t2 / (O.SHOULDER.w * O.SHOULDER.w));
  const corona = O.CORONA.a * (1 - smoothstep(O.CORONA.from ** 2, O.CORONA.to ** 2, t2));
  const spill = O.SPILL.a * (1 - (O.SPILL.droop * t2) / O.RIM.out ** 2);
  return (Math.max(core, shoulder) + corona + spill) * (1 - smoothstep(O.RIM.in ** 2, O.RIM.out ** 2, t2));
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
	float q = ts / ${f(O.CORE_DEG)};
	float core = exp( - q * q * q );
	float shoulder = ${f(O.SHOULDER.a)} * brBeamG( t / ${f(O.SHOULDER.w)} );
	float dark = ${f(O.DARK_RING.a)} * brBeamG( ( t - ${f(O.DARK_RING.c)} ) / ${f(O.DARK_RING.s)} );
	float phos = ${f(O.PHOSPHOR.a)} * brBeamG( ( t - ${f(O.PHOSPHOR.c)} ) / ${f(O.PHOSPHOR.s)} );
	float corona = ${f(O.CORONA.a)} * ( 1.0 - smoothstep( ${f(O.CORONA.from)}, ${f(O.CORONA.to)}, t ) );
	float u = t / ${f(O.RIM.out)};
	float spill = ${f(O.SPILL.a)} * ( 1.0 - ${f(O.SPILL.droop)} * u * u );
	float lip = ${f(O.LIP.a)} * brBeamG( ( t - ${f(O.LIP.c)} ) / ${f(O.LIP.s)} );
	float rim = 1.0 - smoothstep( ${f(O.RIM.in)}, ${f(O.RIM.out)}, t );
	float ripple = 1.0 + ${f(O.RIPPLE.a)} * sin( ${f(O.RIPPLE.f)} * t + 1.3 ) * smoothstep( 10.0, 14.0, t );
	return ( max( core, shoulder ) + dark + phos + corona + spill + lip ) * rim * ripple;
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
	float t2 = ( 2.0 * x + x * x * ${f(1 / 3)} ) * ${f(d2)};
	float I = max( exp( - t2 * ${f(1 / O.CORE_DEG ** 2)} ), ${f(O.SHOULDER.a)} * exp( - t2 * ${f(1 / O.SHOULDER.w ** 2)} ) )
		+ ${f(O.CORONA.a)} * ( 1.0 - smoothstep( ${f(O.CORONA.from ** 2)}, ${f(O.CORONA.to ** 2)}, t2 ) )
		+ ${f(O.SPILL.a)} * ( 1.0 - t2 * ${f(O.SPILL.droop / O.RIM.out ** 2)} );
	return I * ( 1.0 - smoothstep( ${f(O.RIM.in ** 2)}, ${f(O.RIM.out ** 2)}, t2 ) ) * ${f(1 / SOFT_NORM)};
}
`;
}
