// src/lighting/volumetricDensity.ts — package F: the living air of the froxel volumetrics (post/VolumetricFog.ts)
// and the dust motes. Pure (no three): GLSL strings and their TS mirrors (tests/lighting/volumetricDensity.test.ts).
//
// Dust (1/m): drifting 3D value noise, two octaves on lattices of 2.4 m and 1.2 m, settling toward the floor:
//   dust(p) = D * (1 - a + 2 a n(p)) * (1 + SETTLE * exp(-max(y, 0) / SETTLE_H)),  n = 0.65 n1 + 0.35 n2 (mean 0.5)
// with D = AtmosphereParams.dustDensity (x the mood's dustMul) and a = dustNoise. y is storey-relative (the floor on
// flat storeys). The noise is sampled at pn = rel + uVdCam, where uVdCam = (camera + wind * t) mod the lattice periods
// (NOISE_WRAP horizontally, VD.PERIOD_Y vertically; float64 on the CPU): every lattice is integer-periodic over those
// periods, so the field is continuous when the offset wraps and exact at any distance from the origin.
// Mist (1/m) over water: up to VD.MIST_MAX rects nearest the eye (camera-relative, float64 on the CPU), feathered over
// MIST_FEATHER m inside the rect edge, zero below the surface and e-folding every MIST_H m above it, broken into
// rising wisps by a 0.6 x 0.3 m noise:
//   mist(p) = M * max_i(k_i * smoothstep(0, FEATHER, inside_i) * exp(-max(y - y_i, 0) / MIST_H)) * (0.6 + 0.8 n_m)
// with M = mistDensity and k_i the kind factor (pool 1, flooded 0.4, film 0).

import { NOISE_WRAP } from '../core/constants.ts';
import { f } from '../materials/chunks/params.ts';

export const VD = {
  /** dust noise cells (m): both divide NOISE_WRAP and PERIOD_Y */
  DUST_CELL: [2.4, 1.2] as const,
  DUST_W: [0.65, 0.35] as const,
  /** extra dust near the floor: x (1 + SETTLE exp(-y / SETTLE_H)) */
  SETTLE: 0.6,
  SETTLE_H: 0.7,
  /** m: vertical period of every noise lattice */
  PERIOD_Y: 76.8,
  /** m/s: the slow drift of the air (a fixed direction; frozen captures stay deterministic at a given time) */
  WIND: [0.028, 0.01, -0.029] as const,
  /** mist */
  MIST_MAX: 16,
  MIST_FEATHER: 0.8,
  MIST_H: 0.35,
  MIST_CELL: [0.6, 0.3] as const, // horizontal, vertical (m)
  /** m/s: the wisps rise */
  MIST_RISE: 0.08,
  /** kind factor: pool, flooded room, film */
  MIST_KIND: [1, 0.4, 0] as const,
  /** single-scattering albedo of dust and of mist droplets */
  DUST_ALBEDO: 0.85,
  MIST_ALBEDO: 0.97,
  /** 1/m cap of the mood-scaled dust (a DARK mood must not extinguish the far rooms) */
  DUST_MAX: 0.03,
} as const;

/** Lattice periods (cells) of the dust octaves and the mist noise: [x, y, z]. */
const per = (cell: number, cellY = cell): [number, number, number] =>
  [Math.round(NOISE_WRAP / cell), Math.round(VD.PERIOD_Y / cellY), Math.round(NOISE_WRAP / cell)];
export const DUST_PERIODS = [per(VD.DUST_CELL[0]), per(VD.DUST_CELL[1])] as const;
export const MIST_PERIOD = per(VD.MIST_CELL[0], VD.MIST_CELL[1]);

// ---------------------------------------------------------------- TS mirror (uint32 PCG, as the GLSL)

function pcg(v: number): number {
  const s = (Math.imul(v >>> 0, 747796405) + 2891336453) >>> 0;
  const w = Math.imul(((s >>> ((s >>> 28) + 4)) ^ s) >>> 0, 277803737) >>> 0;
  return ((w >>> 22) ^ w) >>> 0;
}
const u01 = (h: number): number => (h >>> 8) * (1 / 16777216);
const wrapI = (c: number, p: number): number => c - p * Math.floor(c / p);
function hash3(x: number, y: number, z: number, salt: number): number {
  return pcg((Math.imul(x >>> 0, 1597334677) ^ pcg((Math.imul(y >>> 0, 3812015801) ^ pcg((z ^ Math.imul(salt, 2654435761)) >>> 0)) >>> 0)) >>> 0);
}

/** 3D value noise in [0, 1] at p (lattice units), integer-periodic with period (px, py, pz). */
export function vnoise3(x: number, y: number, z: number, px: number, py: number, pz: number, salt: number): number {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = x - ix, fy = y - iy, fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy), uz = fz * fz * (3 - 2 * fz);
  const v = (dx: number, dy: number, dz: number): number =>
    u01(hash3(wrapI(ix + dx, px), wrapI(iy + dy, py), wrapI(iz + dz, pz), salt));
  const x00 = v(0, 0, 0) + (v(1, 0, 0) - v(0, 0, 0)) * ux;
  const x10 = v(0, 1, 0) + (v(1, 1, 0) - v(0, 1, 0)) * ux;
  const x01 = v(0, 0, 1) + (v(1, 0, 1) - v(0, 0, 1)) * ux;
  const x11 = v(0, 1, 1) + (v(1, 1, 1) - v(0, 1, 1)) * ux;
  const y0 = x00 + (x10 - x00) * uy, y1 = x01 + (x11 - x01) * uy;
  return y0 + (y1 - y0) * uz;
}

/** Dust noise n in [0, 1] (mean 0.5) at noise-space position (m). */
export function dustNoise(x: number, y: number, z: number): number {
  let n = 0;
  for (let o = 0; o < 2; o++) {
    const c = VD.DUST_CELL[o], p = DUST_PERIODS[o];
    n += VD.DUST_W[o] * vnoise3(x / c, y / c, z / c, p[0], p[1], p[2], 17 + 12 * o);
  }
  return n;
}

/** Dust extinction (1/m) for density D, noise amount a, noise n and storey-relative height y. */
export function dustDensity(D: number, a: number, n: number, y: number): number {
  return Math.max(0, D * (1 - a + 2 * a * n) * (1 + VD.SETTLE * Math.exp(-Math.max(y, 0) / VD.SETTLE_H)));
}

/** One mist rect: camera-relative (x0, z0, x1, z1), surface y (camera-relative) and kind factor. */
export interface MistRect { x0: number; z0: number; x1: number; z1: number; y: number; k: number }

/** Mist envelope (without the noise factor) at a camera-relative point. */
export function mistEnvelope(rects: readonly MistRect[], x: number, y: number, z: number): number {
  let m = 0;
  for (const r of rects) {
    const h = y - r.y;
    if (h < -0.02) continue;
    const e = Math.min(x - r.x0, r.x1 - x, z - r.z0, r.z1 - z);
    if (e <= 0) continue;
    const t = Math.min(1, e / VD.MIST_FEATHER);
    m = Math.max(m, r.k * t * t * (3 - 2 * t) * Math.exp(-Math.max(h, 0) / VD.MIST_H));
  }
  return m;
}

// ---------------------------------------------------------------- GLSL

/** GLSL: brVdNoise3, brDustNoise( pn ), brDustDensity( D, a, n, y ), and the mist uniforms + brMist( rel, pn ).
 * Self-contained. pn = rel + uVdCam (see above); the mist noise samples pn + uVdMistOff (the rising wisps). */
export function volumetricDensityGlsl(): string {
  const [d0, d1] = DUST_PERIODS;
  const mp = MIST_PERIOD;
  return /* glsl */ `
// ---- living air (package F, lighting/volumetricDensity.ts)
uniform vec3 uVdCam;
uniform vec3 uVdMistOff;
uniform vec4 uMistRect[ ${VD.MIST_MAX} ];
uniform vec4 uMistInfo[ ${VD.MIST_MAX} ];
uniform int uMistCount;
uint brVdPcg( uint v ) {
	uint s = v * 747796405u + 2891336453u;
	uint w = ( ( s >> ( ( s >> 28u ) + 4u ) ) ^ s ) * 277803737u;
	return ( w >> 22u ) ^ w;
}
float brVdU01( uint h ) { return float( h >> 8u ) * ( 1.0 / 16777216.0 ); }
float brVdHash( ivec3 c, ivec3 p, uint salt ) {
	c -= p * ivec3( floor( vec3( c ) / vec3( p ) ) );
	return brVdU01( brVdPcg( uint( c.x ) * 1597334677u ^ brVdPcg( uint( c.y ) * 3812015801u ^ brVdPcg( uint( c.z ) ^ salt * 2654435761u ) ) ) );
}
float brVdNoise3( vec3 x, ivec3 p, uint salt ) {
	vec3 i = floor( x );
	vec3 fr = x - i;
	vec3 u = fr * fr * ( 3.0 - 2.0 * fr );
	ivec3 c = ivec3( i );
	float a = brVdHash( c, p, salt ), b = brVdHash( c + ivec3( 1, 0, 0 ), p, salt );
	float d = brVdHash( c + ivec3( 0, 1, 0 ), p, salt ), e = brVdHash( c + ivec3( 1, 1, 0 ), p, salt );
	float g = brVdHash( c + ivec3( 0, 0, 1 ), p, salt ), h = brVdHash( c + ivec3( 1, 0, 1 ), p, salt );
	float k = brVdHash( c + ivec3( 0, 1, 1 ), p, salt ), l = brVdHash( c + ivec3( 1, 1, 1 ), p, salt );
	return mix( mix( mix( a, b, u.x ), mix( d, e, u.x ), u.y ), mix( mix( g, h, u.x ), mix( k, l, u.x ), u.y ), u.z );
}
float brDustNoise( vec3 pn ) {
	return ${f(VD.DUST_W[0])} * brVdNoise3( pn * ${f(1 / VD.DUST_CELL[0])}, ivec3( ${d0.join(', ')} ), 17u )
		+ ${f(VD.DUST_W[1])} * brVdNoise3( pn * ${f(1 / VD.DUST_CELL[1])}, ivec3( ${d1.join(', ')} ), 29u );
}
float brDustDensity( float D, float a, float n, float y ) {
	return max( 0.0, D * ( 1.0 - a + 2.0 * a * n ) * ( 1.0 + ${f(VD.SETTLE)} * exp( - max( y, 0.0 ) * ${f(1 / VD.SETTLE_H)} ) ) );
}
// mist envelope x wisps; rel camera-relative, pn the noise-space position
float brMist( vec3 rel, vec3 pn ) {
	float m = 0.0;
	for ( int i = 0; i < ${VD.MIST_MAX}; i ++ ) {
		if ( i >= uMistCount ) break;
		vec4 r = uMistRect[ i ];
		vec4 inf = uMistInfo[ i ];
		float h = rel.y - inf.x;
		if ( h < - 0.02 ) continue;
		float e = min( min( rel.x - r.x, r.z - rel.x ), min( rel.z - r.y, r.w - rel.z ) );
		if ( e <= 0.0 ) continue;
		m = max( m, inf.y * smoothstep( 0.0, ${f(VD.MIST_FEATHER)}, e ) * exp( - max( h, 0.0 ) * ${f(1 / VD.MIST_H)} ) );
	}
	if ( m <= 0.0 ) return 0.0;
	vec3 q = ( pn + uVdMistOff ) * vec3( ${f(1 / VD.MIST_CELL[0])}, ${f(1 / VD.MIST_CELL[1])}, ${f(1 / VD.MIST_CELL[0])} );
	return m * ( 0.6 + 0.8 * brVdNoise3( q, ivec3( ${mp.join(', ')} ), 41u ) );
}
`;
}

/** The noise-space offsets for camera position (x, y, z) at time t (s), float64: uVdCam = (camera + wind t) mod
 * the periods, uVdMistOff = the wisps' rise mod the vertical period (written into out[0..5]). */
export function noiseOffsets(x: number, y: number, z: number, t: number, out: Float64Array): void {
  const m = (v: number, p: number): number => v - p * Math.floor(v / p);
  out[0] = m(x + VD.WIND[0] * t, NOISE_WRAP);
  out[1] = m(y + VD.WIND[1] * t, VD.PERIOD_Y);
  out[2] = m(z + VD.WIND[2] * t, NOISE_WRAP);
  out[3] = 0;
  out[4] = m(-VD.MIST_RISE * t, VD.PERIOD_Y);
  out[5] = 0;
}
