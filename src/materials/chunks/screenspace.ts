// src/materials/chunks/screenspace.ts — screen-space helpers of the surface shaders (package A): the pre-shade SSAO
// lookup (uSsaoTex: half-res r AO, g view Z, ba oct view normal; post/AmbientOcclusionPass.ts SsaoPre), its albedo
// multi-bounce and the contact-shadow march along the baked dominant light direction. chunks/lighting.ts gates every
// call by uSsaoP.x > 0.5 and uBrReflPass < 0.5 (the mirrored view has no SSAO of its own). IGN is the only dither of
// the surface programs: the 16-sampler budget has no room for a blue-noise texture.
//
// brSsao ports the retired post composite's upsample, fed with the exact per-fragment geometry (geometryPosition,
// the unperturbed normal brNg) instead of a 9-tap depth reconstruction: the 2x2 AO texels around the pixel, weighted
// by bilinear weight x exp(-|distance of P to the texel's tangent plane| / plane) x max(N.Ns, 0)^8. Plane distance
// alone lets the two faces of a crease borrow each other's AO (each passes within a centimetre of the other's plane
// there), which drew the AO edge along every ceiling grid bar in 2-pixel steps. A fragment with no texel of its own
// surface in the 2x2 (a face narrower than two pixels) uses that surface's texels in the surrounding 4x4, and failing
// that is left unoccluded (a cable thinner than a pixel: not the AO of whatever lies behind it). Decals sit on their
// surface (polygon offset only), so they take its AO.
//
// brContactShadow marches BR_CS_STEPS steps (IGN-jittered) from P, pushed off the surface along Ng, towards the baked
// dominant light L over CS.LEN (growing with distance), reading the half-res view depth (aoRT.g); the ray is stepped
// in homogeneous AO-texel coordinates, which are affine along it. A sample behind the depth buffer by more than the
// bias and less than CS.THICK is occluded, by (1 - t)^2 at the ray fraction t of the first crossing: the baked light
// is an area source (troffers, several panels), so a shadow is darkest at the contact and its penumbra swallows it
// within a few decimetres (an armrest over a seat casts a faint one, a monitor foot a dark line). It fades out over
// 10-20 m (the march is the costliest part at ultra) and where the light is non-directional (w small). Its dithered
// hit / miss on thin occluders (armrests, lounger axles) would draw the IGN pattern as hatching: chunks/lighting.ts
// marches in uniform control flow and averages the result over the pixel quad (brQuadMean, no history needed).
// chunks/lighting.ts multiplies only the baked directional term (brDirVis) by it: not the flicker channels (no stored
// direction), not the flashlight (a real shadow map). The TS twins below mirror the GLSL
// (tests/materials/screenspace.test.ts).

import { OCT_GLSL } from './gbuffer.ts';

/** Contact-shadow tuning (emitted as BR_CS_* defines): march length LEN x (1 + LEN_GROW x view depth) m, surface
 * offset OFFSET + OFFSET_GROW x view depth along Ng, hit when BIAS x depth < behind < THICK, distance fade
 * FADE0-FADE1 m, directionality fade W0-W1, STRENGTH at full occlusion, skipped when N.L < NGL_MIN. */
export const CONTACT_SHADOW = {
  LEN: 0.35,
  LEN_GROW: 0.02,
  OFFSET: 0.003,
  OFFSET_GROW: 0.0015,
  BIAS: 0.006,
  THICK: 0.3,
  FADE0: 10,
  FADE1: 20,
  W0: 0.05,
  W1: 0.3,
  STRENGTH: 0.9,
  NGL_MIN: 0.05,
} as const;

const CS_DEFINES = Object.entries(CONTACT_SHADOW).map(([k, v]) => `#define BR_CS_${k} ${v.toFixed(4)}`).join('\n');

/** Appended to the fragment common block (after the uniforms). */
export const SCREENSPACE_GLSL = /* glsl */ `
#if defined( BR_SSAO ) || defined( BR_CS_STEPS )
${CS_DEFINES}
${OCT_GLSL}
// interleaved gradient noise (Jimenez 2014) at a pixel position
float brIGN( vec2 p ) { return fract( 52.9829189 * fract( dot( p, vec2( 0.06711056, 0.00583715 ) ) ) ); }
int brSsStep() { return int( uSsaoP.w + 0.5 ); }
// view position of the full-resolution pixel AO texel q represents, at view distance vz
vec3 brSsPos( ivec2 q, float vz ) {
	vec2 ndc = ( vec2( q * brSsStep() ) + 0.5 ) * uSsaoSize.zw * 2.0 - 1.0;
	return vec3( ( ndc + uSsaoProj.zw ) * vz / uSsaoProj.xy, - vz );
}
// how well AO texel q (value s) describes the surface at P with normal N (0 = another surface or the background)
float brSsSame( vec4 s, ivec2 q, vec3 P, vec3 N ) {
	if ( s.g >= 1e4 ) return 0.0;
	vec3 Ns = brOctDec( s.ba );
	float nd = max( dot( N, Ns ), 0.0 );
	nd *= nd; nd *= nd; nd *= nd;
	return exp( - abs( dot( P - brSsPos( q, s.g ), Ns ) ) / uSsaoP.z ) * nd;
}
// ambient occlusion at the view-space fragment P with geometric normal N (1 = open)
float brSsao( vec3 P, vec3 N ) {
	ivec2 x = ivec2( gl_FragCoord.xy );
	ivec2 sz = textureSize( uSsaoTex, 0 );
	int st = brSsStep();
	if ( st <= 1 ) return texelFetch( uSsaoTex, min( x, sz - 1 ), 0 ).r;
	vec2 fc = vec2( x ) / float( st );
	ivec2 b = ivec2( floor( fc ) );
	vec2 f = fc - vec2( b );
	float sum = 0.0, wsum = 0.0, gmax = 0.0;
	for ( int j = 0; j < 2; j ++ ) {
		for ( int i = 0; i < 2; i ++ ) {
			ivec2 q = min( b + ivec2( i, j ), sz - 1 );
			vec4 s = texelFetch( uSsaoTex, q, 0 );
			float g = brSsSame( s, q, P, N );
			float w = ( ( i == 0 ? 1.0 - f.x : f.x ) * ( j == 0 ? 1.0 - f.y : f.y ) + 1e-3 ) * g;
			sum += s.r * w;
			wsum += w;
			gmax = max( gmax, g );
		}
	}
	if ( gmax < 0.1 ) {
		sum = wsum = 0.0;
		for ( int j = -1; j <= 2; j ++ ) {
			for ( int i = -1; i <= 2; i ++ ) {
				ivec2 q = clamp( b + ivec2( i, j ), ivec2( 0 ), sz - 1 );
				vec4 s = texelFetch( uSsaoTex, q, 0 );
				vec2 dq = vec2( q * st - x );
				float w = exp( - 0.125 * dot( dq, dq ) ) * brSsSame( s, q, P, N );
				sum += s.r * w;
				wsum += w;
			}
		}
	}
	return wsum > 1e-4 ? clamp( sum / wsum, 0.0, 1.0 ) : 1.0;
}
// multi-bounce occlusion of albedo a (Jimenez 2016): occluded corners keep (and deepen) their hue
vec3 brAoMultiBounce( float v, vec3 a ) {
	return max( vec3( v ), ( ( v * ( 2.0404 * a - 0.3324 ) + ( - 4.7951 * a + 0.6417 ) ) * v + ( 2.7552 * a + 0.6903 ) ) * v );
}
// mean of v over the pixel's 2x2 quad: the x pair through dFdx, then the y pair through dFdy (x pairs start on even
// columns, y pairs on even rows). Call in uniform control flow. The deterministic stand-in for the temporal filter
// the dithered contact-shadow march lacks: four IGN offsets per quad instead of one per pixel
float brQuadMean( float v ) {
	vec2 q = mod( floor( gl_FragCoord.xy ), 2.0 );
	v += dFdx( v ) * ( 0.5 - q.x );
	v += dFdy( v ) * ( 0.5 - q.y );
	return clamp( v, 0.0, 1.0 );
}
// visibility of the baked directional light L (view space, directionality w) from P (1 = unshadowed)
float brContactShadow( vec3 P, vec3 Ng, vec3 L, float w ) {
#ifdef BR_CS_STEPS
	float vz = - P.z;
	float fade = ( 1.0 - smoothstep( BR_CS_FADE0, BR_CS_FADE1, vz ) ) * smoothstep( BR_CS_W0, BR_CS_W1, w );
	if ( fade <= 0.0 || dot( Ng, L ) < BR_CS_NGL_MIN ) return 1.0;
	float len = BR_CS_LEN * ( 1.0 + BR_CS_LEN_GROW * vz );
	vec3 O = P + Ng * ( BR_CS_OFFSET + BR_CS_OFFSET_GROW * vz );
	vec3 E = O + L * len;
	// the ray in homogeneous AO-texel coordinates (x, y scaled by the view distance, z = the view distance): affine in
	// t, so each step costs 3 MADs and a reciprocal instead of a projection
	vec2 k = 0.5 * uSsaoSize.xy / float( brSsStep() );
	vec3 hO = vec3( ( uSsaoProj.xy * O.xy + uSsaoProj.zw * O.z - O.z ) * k, - O.z );
	vec3 hD = vec3( ( uSsaoProj.xy * E.xy + uSsaoProj.zw * E.z - E.z ) * k, - E.z ) - hO;
	vec2 sz = vec2( textureSize( uSsaoTex, 0 ) );
	// each AO texel holds the depth of its representative pixel (the first of its st x st block, at texel coordinate
	// q + 0.5 / st): test a sample against the texel whose representative lies nearest to it (a centred +-0.5 texel
	// error instead of 0 .. 1, and no half-pixel shift of the shadow)
	vec2 rep = vec2( 0.5 - 0.5 / float( brSsStep() ) );
	// jitter stratified within the pixel quad (offsets u, u + 1/4, u + 1/2, u + 3/4; u from the IGN of the quad), so
	// brQuadMean averages four evenly spread marches
	vec2 qc = floor( gl_FragCoord.xy * 0.5 );
	vec2 ql = floor( gl_FragCoord.xy ) - 2.0 * qc;
	float j = 0.25 * ( brIGN( qc ) + ql.x * 2.0 + abs( ql.x - ql.y ) );
	float hs = 0.5 / float( BR_CS_STEPS );
	float tHit = - 1.0;
	for ( int i = 0; i < BR_CS_STEPS; i ++ ) {
		float t = ( float( i ) + j ) / float( BR_CS_STEPS );
		vec3 h = hO + hD * t;
		if ( h.z < 0.01 ) break; // behind the camera
		vec2 tc = h.xy / h.z;
		if ( any( lessThan( tc, vec2( 0.0 ) ) ) || any( greaterThanEqual( tc, sz ) ) ) break;
		float dz = h.z - texelFetch( uSsaoTex, min( ivec2( tc + rep ), ivec2( sz ) - 1 ), 0 ).g;
		if ( dz > BR_CS_BIAS * h.z && dz < BR_CS_THICK ) { tHit = t; break; }
	}
	if ( tHit < 0.0 ) return 1.0;
	// the penumbra widens with the occluder's distance from P (the crossing lies within half a step before the hit);
	// and an area light's penumbra swallows an occluder thinner than it (a lounger axle, a cable): the ray is tested
	// again half a step and a step past the hit, and the share of the three samples still behind it scales the
	// shadow (a solid occluder keeps it whole; a thin one, which the dithered steps hit on only some pixels, casts a
	// lighter one, so its hit / miss hatching is far fainter)
	float cov = 1.0;
	for ( int r = 1; r <= 2; r ++ ) {
		vec3 h = hO + hD * min( tHit + float( r ) * hs, 1.0 );
		if ( h.z < 0.01 ) break;
		vec2 tc = h.xy / h.z;
		if ( any( lessThan( tc, vec2( 0.0 ) ) ) || any( greaterThanEqual( tc, sz ) ) ) break;
		float dz = h.z - texelFetch( uSsaoTex, min( ivec2( tc + rep ), ivec2( sz ) - 1 ), 0 ).g;
		cov += dz > BR_CS_BIAS * h.z && dz < BR_CS_THICK ? 1.0 : 0.0;
	}
	float th = 1.0 - max( tHit - hs, 0.0 );
	return 1.0 - th * th * ( cov / 3.0 ) * fade * BR_CS_STRENGTH;
#else
	return 1.0;
#endif
}
#endif
`;

// ---------------------------------------------------------------- TS twins (tests)

export type Vec3 = readonly [number, number, number];
/** (P00, P11, P20, P21) of a perspective projection: uSsaoProj */
export type SsProj = readonly [number, number, number, number];

const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** brAoMultiBounce for one channel. */
export function aoMultiBounce(v: number, a: number): number {
  return Math.max(v, ((v * (2.0404 * a - 0.3324) + (-4.7951 * a + 0.6417)) * v + (2.7552 * a + 0.6903)) * v);
}

/** brSsPos: view position of the full-resolution pixel AO texel q represents (`step` px per texel). */
export function ssPos(q: readonly [number, number], vz: number, step: number, full: readonly [number, number], proj: SsProj): Vec3 {
  const nx = ((q[0] * step + 0.5) / full[0]) * 2 - 1, ny = ((q[1] * step + 0.5) / full[1]) * 2 - 1;
  return [((nx + proj[2]) * vz) / proj[0], ((ny + proj[3]) * vz) / proj[1], -vz];
}

/** brContactShadow; `viewZAt(u, v)` returns the stored view distance of the AO texel under screen uv (aoRT.g),
 * `jitter` is the IGN value of the pixel. */
export function contactShadow(P: Vec3, Ng: Vec3, L: Vec3, w: number, steps: number, jitter: number, proj: SsProj, viewZAt: (u: number, v: number) => number): number {
  const C = CONTACT_SHADOW;
  const vz = -P[2];
  const fade = (1 - smoothstep(C.FADE0, C.FADE1, vz)) * smoothstep(C.W0, C.W1, w);
  if (fade <= 0 || Ng[0] * L[0] + Ng[1] * L[1] + Ng[2] * L[2] < C.NGL_MIN) return 1;
  const len = C.LEN * (1 + C.LEN_GROW * vz);
  const off = C.OFFSET + C.OFFSET_GROW * vz;
  const O = [P[0] + Ng[0] * off, P[1] + Ng[1] * off, P[2] + Ng[2] * off];
  // 1 = the ray point at t is behind the depth buffer (within the thickness), 0 = not, -1 = off screen / behind the eye
  const behind = (t: number): number => {
    const S = [O[0] + L[0] * len * t, O[1] + L[1] * len * t, O[2] + L[2] * len * t];
    if (S[2] > -0.01) return -1;
    const u = ((proj[0] * S[0] + proj[2] * S[2]) / -S[2]) * 0.5 + 0.5;
    const v = ((proj[1] * S[1] + proj[3] * S[2]) / -S[2]) * 0.5 + 0.5;
    if (u < 0 || v < 0 || u >= 1 || v >= 1) return -1;
    const dz = -S[2] - viewZAt(u, v);
    return dz > C.BIAS * -S[2] && dz < C.THICK ? 1 : 0;
  };
  const hs = 0.5 / steps;
  let tHit = -1;
  for (let i = 0; i < steps; i++) {
    const t = (i + jitter) / steps;
    const b = behind(t);
    if (b < 0) break;
    if (b > 0) { tHit = t; break; }
  }
  if (tHit < 0) return 1;
  let cov = 1;
  for (let k = 1; k <= 2; k++) {
    const b = behind(Math.min(tHit + k * hs, 1));
    if (b < 0) break;
    cov += b;
  }
  const th = 1 - Math.max(tHit - hs, 0);
  return 1 - th * th * (cov / 3) * fade * C.STRENGTH;
}
