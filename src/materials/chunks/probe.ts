// src/materials/chunks/probe.ts — package D: the box-projected, lightmap-normalised reflection probe in the surface
// programs (BR_PROBE, high / ultra), plus its tuning and the CPU twins of its maths (tests/materials/probe.test.ts).
//
// materials/ReflectionProbe.ts captures a cube around an anchor in the camera's room and GGX-prefilters it into
// uBrProbe: mip k holds roughness k / uBrProbeLod. It publishes the room box and the anchor relative to the camera
// (uBrProbeMin / Max / Pos, world axes, metres; computed in float64 on the CPU), so shaders work with pc = the fragment
// position relative to the camera in world axes (never a float32 world position).
//  - brProbeWeight: the probe's influence, 1 inside the box, fading out FADE0..FADE1 m outside it. A room seen through
//    a doorway lies outside the box and keeps the legacy fallback: the probe never leaks the camera's room into it.
//  - brProbeDir: box projection (Lagarde & Zanuttini 2012): the reflection ray meets the box, and the cube is looked up
//    toward that point from the anchor, which puts panels, walls and the ceiling grid where they are for any
//    fragment in the room. Rough lobes fade back to the plain reflection vector (roughness^2): a wide lobe gathers
//    from all over the box, where one projected point means little.
//  - brProbeNorm: lightmap normalisation. The probe saw the room from the anchor; a fragment under a desk or in a
//    corner receives less. The ratio of the fragment's baked irradiance to the probe's own irradiance estimate along
//    the normal (its roughest mip, x pi) scales the reflection, clamped to NORM_MIN..1: it only darkens (a receiver
//    lit more than the anchor does not see a brighter room; up to 2x brightened walls near lamps, and the reflection
//    brightened wherever the SSR faded to this fallback). Rough lobes take 90 % of it; glossy ones 35 % at k = 1,
//    growing to 90 % at NORM_MIN (a dark, occluded glossy receiver kept 70 % of the anchor's lamps).
// chunks/lighting.ts mixes it in (FRAG_LIGHTS_GLSL): brPrW = weight x (1 - smoothstep(ROUGH0, ROUGH1, roughness)); the
// baked dominant-direction lobe fades out by (1 - brPrW) (the probe holds the lamps it stands for), and the uniform
// environment is mixed toward the probe radiance. Clearcoat lobes take the probe at their own roughness.

import { f } from './params.ts';

/** Probe tuning (GLSL defines below, the capture in ReflectionProbe.ts, the TS twins and tests share them). */
export const PROBE = {
  /** m outside the box where the influence starts / ends fading */
  FADE0: 0.25,
  FADE1: 0.9,
  /** the probe replaces the legacy environment below ROUGH0, fading out by ROUGH1 (rough carpet, wallpaper and
   * ceiling tile keep the per-texel baked lobe, which is closer for them) */
  ROUGH0: 0.5,
  ROUGH1: 0.65,
  /** lightmap normalisation: the ratio k is clamped to NORM_MIN..NORM_MAX (1: it only darkens; reflected radiance does
   * not grow because the receiver is lit more than the anchor) and applied at a share that is NORM_MIX_ROUGH on rough
   * lobes and, on glossy ones, grows from NORM_MIX_GLOSS at k = 1 to NORM_MIX_DARK at k = NORM_MIN (a dark, occluded
   * glossy receiver does not see the anchor's lamps) */
  NORM_MIN: 0.15,
  NORM_MAX: 1.0,
  NORM_MIX_GLOSS: 0.35,
  NORM_MIX_DARK: 0.9,
  NORM_MIX_ROUGH: 0.9,
  /** m: the anchor follows the eye when it moves farther than this (or leaves the box) */
  ANCHOR_MOVE: 2,
  /** stale faces (a new anchor, streamed tiles) captured per frame */
  BURST: 2,
  /** otherwise one face every STEADY_EVERY frames (a full refresh every 6 x STEADY_EVERY frames; 2 until the perf
   * pass: 4 halves the steady main-thread and GPU cost, and flicker reaches a face at most 24 frames late) */
  STEADY_EVERY: 4,
  /** m: capture camera planes */
  NEAR: 0.05,
  FAR: 60,
  /** GGX samples per prefiltered texel; filtered importance sampling reads the capture's mips */
  SAMPLES: 32,
  /** frames between re-estimates of the box around an unchanged anchor (neighbouring chunks stream in) */
  BOX_REFRESH: 15,
} as const;

/** Prefiltered mips: 5 at 128 (128 -> 8 px, roughness 0, .25, .5, .75, 1), 6 at 256. */
export const probeLevels = (size: number): number => (size >= 256 ? 6 : 5);

/** Appended to the fragment common block. */
export const PROBE_GLSL = /* glsl */ `
#ifdef BR_PROBE
#define BR_PROBE_FADE0 ${f(PROBE.FADE0)}
#define BR_PROBE_FADE1 ${f(PROBE.FADE1)}
#define BR_PROBE_ROUGH0 ${f(PROBE.ROUGH0)}
#define BR_PROBE_ROUGH1 ${f(PROBE.ROUGH1)}
// influence of the probe at camera-relative world position pc (0 outside its box or while no probe exists)
float brProbeWeight( vec3 pc ) {
	vec3 o = max( max( uBrProbeMin - pc, pc - uBrProbeMax ), vec3( 0.0 ) );
	return uBrProbeOn * ( 1.0 - smoothstep( BR_PROBE_FADE0, BR_PROBE_FADE1, length( o ) ) );
}
// cube lookup direction for the world reflection vector r (box projection fading to r with roughness)
vec3 brProbeDir( vec3 pc, vec3 r, float rough ) {
	vec3 rs = vec3( r.x >= 0.0 ? max( r.x, 1e-5 ) : min( r.x, - 1e-5 ), r.y >= 0.0 ? max( r.y, 1e-5 ) : min( r.y, - 1e-5 ),
		r.z >= 0.0 ? max( r.z, 1e-5 ) : min( r.z, - 1e-5 ) );
	vec3 tf = max( ( uBrProbeMax - pc ) / rs, ( uBrProbeMin - pc ) / rs );
	float t = max( min( min( tf.x, tf.y ), tf.z ), 0.0 );
	return mix( normalize( pc + r * t - uBrProbePos ), r, rough * rough );
}
// normalisation of the probe radiance to the local baked irradiance eLocal at world normal nW: darkening only, at a
// glossy share that grows as the receiver gets darker than the anchor (monotonic in k, never above 1)
float brProbeNorm( vec3 nW, vec3 eLocal, float rough ) {
	float ep = BR_PI * brLuma( textureLod( uBrProbe, nW, uBrProbeLod ).rgb );
	float k = clamp( brLuma( eLocal ) / max( ep, 1e-2 ), ${f(PROBE.NORM_MIN)}, ${f(PROBE.NORM_MAX)} );
	float gloss = mix( ${f(PROBE.NORM_MIX_DARK)}, ${f(PROBE.NORM_MIX_GLOSS)}, ( k - ${f(PROBE.NORM_MIN)} ) / ${f(1 - PROBE.NORM_MIN)} );
	return mix( 1.0, k, mix( gloss, ${f(PROBE.NORM_MIX_ROUGH)}, smoothstep( 0.1, 0.5, rough ) ) );
}
// the normalised probe radiance along world reflection vector rW for a lobe of perceptual roughness rough
vec3 brProbeRad( vec3 pc, vec3 rW, float rough, vec3 nW, vec3 eLocal ) {
	return textureLod( uBrProbe, brProbeDir( pc, rW, rough ), rough * uBrProbeLod ).rgb * brProbeNorm( nW, eLocal, rough );
}
#endif
`;

// ---------------------------------------------------------------- the prefilter (materials/ReflectionProbe.ts)

/** Direction of texel (s, t) in [0, 1]^2 of cube face `face` (+X, -X, +Y, -Y, +Z, -Z), in the GL cube-map convention
 * (t = 0 is the face's first row, i.e. framebuffer row 0 when rendering into it). */
export const CUBE_DIR_GLSL = /* glsl */ `
vec3 brCubeDir( int face, vec2 st ) {
	float sc = st.x * 2.0 - 1.0, tc = st.y * 2.0 - 1.0;
	if ( face == 0 ) return vec3( 1.0, - tc, - sc );
	if ( face == 1 ) return vec3( - 1.0, - tc, sc );
	if ( face == 2 ) return vec3( sc, 1.0, tc );
	if ( face == 3 ) return vec3( sc, - 1.0, - tc );
	if ( face == 4 ) return vec3( sc, - tc, 1.0 );
	return vec3( - sc, - tc, - 1.0 );
}
`;

/** The GGX prefilter of one face at one mip (N = V = R). uSamples[i] = (tangent-space L, capture LOD); the weight is
 * L.z (N.L), zero for samples below the horizon. uCount = 1 copies the capture (mirror level). A non-finite capture
 * texel (a driver's half-float mip generation overflowing on a lamp; the capture is float where it can be) is dropped
 * instead of turning the whole filtered cube, and every surface reflecting it, into NaN. */
export const PROBE_FILTER_FRAG = /* glsl */ `
precision highp float;
precision highp int;
uniform highp samplerCube tCube;
uniform int uFace;
uniform float uSize;      // this mip's face size (px)
uniform int uCount;
uniform vec4 uSamples[ ${PROBE.SAMPLES} ];
layout( location = 0 ) out highp vec4 outColor;
${CUBE_DIR_GLSL}
bool brProbeFinite( vec3 c ) { return ! any( isnan( c ) ) && ! any( isinf( c ) ); }
void main() {
	vec3 N = normalize( brCubeDir( uFace, gl_FragCoord.xy / uSize ) );
	if ( uCount <= 1 ) {
		vec3 c = textureLod( tCube, N, 0.0 ).rgb;
		outColor = vec4( brProbeFinite( c ) ? c : vec3( 0.0 ), 1.0 );
		return;
	}
	vec3 up = abs( N.y ) < 0.999 ? vec3( 0.0, 1.0, 0.0 ) : vec3( 1.0, 0.0, 0.0 );
	vec3 T = normalize( cross( up, N ) );
	vec3 B = cross( N, T );
	vec3 acc = vec3( 0.0 );
	float ws = 0.0;
	for ( int i = 0; i < ${PROBE.SAMPLES}; i ++ ) {
		if ( i >= uCount ) break;
		vec4 s = uSamples[ i ];
		if ( s.z <= 0.0 ) continue;
		vec3 c = textureLod( tCube, T * s.x + B * s.y + N * s.z, s.w ).rgb;
		if ( ! brProbeFinite( c ) ) continue;
		acc += c * s.z;
		ws += s.z;
	}
	outColor = vec4( acc / max( ws, 1e-6 ), 1.0 );
}
`;

// ---------------------------------------------------------------- CPU twins

type V3 = readonly [number, number, number];
const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};
const luma = (c: V3): number => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

/** brProbeWeight twin (min / max: the box relative to the camera, pc the fragment relative to the camera). */
export function probeWeight(pc: V3, min: V3, max: V3, on = 1): number {
  let o2 = 0;
  for (let i = 0; i < 3; i++) {
    const o = Math.max(min[i] - pc[i], pc[i] - max[i], 0);
    o2 += o * o;
  }
  return on * (1 - smoothstep(PROBE.FADE0, PROBE.FADE1, Math.sqrt(o2)));
}

/** brProbeDir twin (unnormalised when rough > 0, like the GLSL mix). */
export function probeDir(pc: V3, r: V3, rough: number, min: V3, max: V3, pos: V3): [number, number, number] {
  let t = Infinity;
  for (let i = 0; i < 3; i++) {
    const ri = r[i] >= 0 ? Math.max(r[i], 1e-5) : Math.min(r[i], -1e-5);
    t = Math.min(t, Math.max((max[i] - pc[i]) / ri, (min[i] - pc[i]) / ri));
  }
  t = Math.max(t, 0);
  const d: [number, number, number] = [pc[0] + r[0] * t - pos[0], pc[1] + r[1] * t - pos[1], pc[2] + r[2] * t - pos[2]];
  const l = Math.hypot(d[0], d[1], d[2]) || 1;
  const a = rough * rough;
  return [d[0] / l * (1 - a) + r[0] * a, d[1] / l * (1 - a) + r[1] * a, d[2] / l * (1 - a) + r[2] * a];
}

/** brProbeNorm twin: eLocal = the fragment's baked irradiance, probeRough = the probe's roughest mip along the
 * normal (radiance). */
export function probeNorm(eLocal: V3, probeRough: V3, rough: number): number {
  const ep = Math.PI * luma(probeRough);
  const k = Math.min(PROBE.NORM_MAX, Math.max(PROBE.NORM_MIN, luma(eLocal) / Math.max(ep, 1e-2)));
  const gloss = PROBE.NORM_MIX_DARK + (PROBE.NORM_MIX_GLOSS - PROBE.NORM_MIX_DARK) * (k - PROBE.NORM_MIN) / (1 - PROBE.NORM_MIN);
  const m = gloss + (PROBE.NORM_MIX_ROUGH - gloss) * smoothstep(0.1, 0.5, rough);
  return 1 + (k - 1) * m;
}

/** brCubeDir twin. */
export function cubeDir(face: number, s: number, t: number): [number, number, number] {
  const sc = s * 2 - 1, tc = t * 2 - 1;
  switch (face) {
    case 0: return [1, -tc, -sc];
    case 1: return [-1, -tc, sc];
    case 2: return [sc, 1, tc];
    case 3: return [sc, -1, -tc];
    case 4: return [sc, -tc, 1];
    default: return [-sc, -tc, -1];
  }
}

/** The GL cube-map face and (s, t) a direction samples (the inverse of cubeDir). */
export function cubeFaceOf(d: V3): { face: number; s: number; t: number } {
  const ax = Math.abs(d[0]), ay = Math.abs(d[1]), az = Math.abs(d[2]);
  let face: number, sc: number, tc: number, ma: number;
  if (ax >= ay && ax >= az) { ma = ax; face = d[0] > 0 ? 0 : 1; sc = d[0] > 0 ? -d[2] : d[2]; tc = -d[1]; }
  else if (ay >= az) { ma = ay; face = d[1] > 0 ? 2 : 3; sc = d[0]; tc = d[1] > 0 ? d[2] : -d[2]; }
  else { ma = az; face = d[2] > 0 ? 4 : 5; sc = d[2] > 0 ? d[0] : -d[0]; tc = -d[1]; }
  return { face, s: (sc / ma + 1) / 2, t: (tc / ma + 1) / 2 };
}

/** Van der Corput radical inverse (base 2) of i: the second Hammersley coordinate. */
export function radicalInverse(i: number): number {
  let b = i >>> 0;
  b = ((b << 16) | (b >>> 16)) >>> 0;
  b = (((b & 0x55555555) << 1) | ((b & 0xaaaaaaaa) >>> 1)) >>> 0;
  b = (((b & 0x33333333) << 2) | ((b & 0xcccccccc) >>> 2)) >>> 0;
  b = (((b & 0x0f0f0f0f) << 4) | ((b & 0xf0f0f0f0) >>> 4)) >>> 0;
  b = (((b & 0x00ff00ff) << 8) | ((b & 0xff00ff00) >>> 8)) >>> 0;
  return b * 2.3283064365386963e-10;
}

/**
 * The prefilter's samples for GGX alpha `alpha` (N = V = R, so they depend on alpha alone), into out[4 x SAMPLES]:
 * tangent-space L (z = N.L, <= 0: no weight) and the capture LOD of filtered importance sampling (Krivanek & Colbert,
 * GPU Gems 3 ch. 20): lod = 0.5 log2(Omega_s / Omega_p) + 1 with Omega_s = 1 / (n pdf), pdf(L) = D / 4 here, and
 * Omega_p = 4 pi / (6 captureSize^2) (one level-0 texel). Returns the sample count (1 for a mirror: a copy).
 */
export function probeSamples(alpha: number, captureSize: number, out: Float32Array): number {
  if (alpha <= 0) {
    out.fill(0);
    out[2] = 1;
    return 1;
  }
  const n = PROBE.SAMPLES;
  const a2 = alpha * alpha;
  const omegaP = (4 * Math.PI) / (6 * captureSize * captureSize);
  for (let i = 0; i < n; i++) {
    const u = (i + 0.5) / n, v = radicalInverse(i);
    const cosH = Math.sqrt((1 - u) / (1 + (a2 - 1) * u));
    const sinH = Math.sqrt(Math.max(0, 1 - cosH * cosH));
    const phi = 2 * Math.PI * v;
    const h: V3 = [sinH * Math.cos(phi), sinH * Math.sin(phi), cosH];
    // L = reflect(-V, H) with V = (0, 0, 1)
    const vh = cosH;
    const l: V3 = [2 * vh * h[0], 2 * vh * h[1], 2 * vh * h[2] - 1];
    const dd = (a2 - 1) * cosH * cosH + 1;
    const D = a2 / (Math.PI * dd * dd);
    const pdf = D / 4;
    const lod = Math.max(0.5 * Math.log2(1 / (n * pdf) / omegaP) + 1, 0);
    out[4 * i] = l[0];
    out[4 * i + 1] = l[1];
    out[4 * i + 2] = l[2];
    out[4 * i + 3] = lod;
  }
  return n;
}
