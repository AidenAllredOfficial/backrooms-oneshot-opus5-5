// src/materials/chunks/water.ts — package E: the water surface model (waves, ripples, surface matter) of the water
// shader (WaterMaterial.ts), and the water code shared with the surface programs: the submerged-fragment info that
// drives the caustics / the legacy in-water optics / the flashlight hook, the above-water caustic coverage and the
// wet band above a water line (called from package B's wetness block).
//
// Waves (brWaterSlope): BR_WATER_WAVES analytic gravity-capillary waves with dispersion at the local depth,
// omega^2 = g k tanh(k D) + (sigma / rho) k^3, on an integer wave-vector lattice (exactly periodic over
// NOISE_WRAP), wavelengths geometric from LAMBDA_MAX to LAMBDA_MIN, golden-angle directions, slope amplitudes
// split ~ lambda^0.5 and normalised to the kind's slope RMS; a footprint filter turns sub-pixel waves into
// roughness (alpha = sqrt(alpha0^2 + 2 var)). Three drifting octaves of the texture slope map (textures/
// waterNormals.ts: periods 1.2 / 0.96 axis-swapped / 1.92 rotated 3-4-5, all dividing NOISE_WRAP) add the
// capillary detail. BR_WATER_WAVES 0 (low): the two texture layers only (today's cost).
// All world-anchored lookups use vBrLocal + uNoiseOrigin (§2.2 precision rules).

import { NOISE_WRAP, WALL_T } from '../../core/constants.ts';
import { beamSoftGlsl } from '../../lighting/flashlightOptics.ts';
import { f } from './params.ts';

/** Water surface tuning (package E). Index = WaterRect kind: 0 pool, 1 flooded room, 2 film. */
export const WATER_SURFACE = {
  // ---- analytic waves
  LAMBDA_MAX: 1.6, // m
  LAMBDA_MIN: 0.22, // m
  THETA0: 0.37, // rad, direction of the first wave
  GOLDEN: (137.5 * Math.PI) / 180,
  /** slope RMS of the analytic waves per kind: circulation wavelets in a pool (the panel reflections wobble but
   * stay rectangles), nearly still flood water, a film */
  RMS: [0.012, 0.004, 0.0015],
  /** amplitude split: slope amplitude ~ lambda^SPLIT */
  SPLIT: 0.5,
  /** GGX alpha of the surface itself (still water is a near-perfect mirror; film: the carpet pile tips break it, so
   * lamps reflect as glossy streaks, like wet asphalt); the unresolved waves add to it with distance */
  ALPHA0: [0.004, 0.003, 0.035],
  ALPHA_MAX: 0.5,
  G: 9.81, // m/s^2
  SIGMA_RHO: 7.3e-5, // m^3/s^2, surface tension / density
  // ---- texture octaves (the slope map stores s = (v * 2 - 1) * TEX_SCALE)
  TEX_SCALE: 0.25,
  TEX_PERIOD: [1.2, 0.96, 1.92], // m (1024, 1280, 640 per NOISE_WRAP)
  TEX_DRIFT: [[0.021, 0.013], [-0.017, 0.024], [0.011, -0.019]], // uv / s (1-4 cm/s: calm water)
  /** per kind x layer: world slope = gain * stored slope */
  TEX_GAIN: [[0.035, 0.025, 0.03], [0.012, 0.008, 0.012], [0.01, 0.01, 0.01]],
  /** vector RMS of the stored slope (the generator's scale; unresolved-variance estimate) */
  TEX_RMS: 0.085,
  /** dominant feature wavelength of a layer / its period (unresolved-variance footprint) */
  TEX_FEATURE: 0.1,
  // ---- planar reflection: typical distance of the reflected geometry behind the reflection point (m)
  REFL_GEOM_D: 3,
  // ---- ripples / drips
  DRIP_SLOPE: 0.25,
  DRIP_SPEED: 0.28, // m/s ring expansion
  DRIP_WAVELENGTH: 0.022, // m
  FOAM_ALB: [[0.85, 0.88, 0.9], [0.62, 0.56, 0.44], [0.7, 0.66, 0.58]],
  // ---- surface matter (waterDebris)
  FILM: [0.1, 0.55, 0.4], // dust / oil film coverage weight
  /** a dust film barely roughens still water (GGX alpha it adds at full coverage); it dulls it instead: FILM_DULL of
   * the reflection is scattered diffusely under full coverage */
  FILM_ROUGH: 0.012,
  FILM_DULL: 0.3,
  SCUM_ALB: [[0.8, 0.82, 0.8], [0.42, 0.36, 0.24], [0.5, 0.45, 0.35]],
  FLECK_CELL: 0.24, // m (5120 per NOISE_WRAP)
  FLECK_P: [0.004, 0.05, 0.03], // fraction of lattice cells with a fleck
  WETBAND: [0.03, 0.07, 0.015], // m above the water line
  // ---- contact lines (waterDebris): where the water meets a wall, a pillar, a chair leg, the pool's rim
  /** width (m) and strength of the scum / foam line floating against what stands in the water: pools barely any
   * (circulation), flooded rooms a ragged brown band of dust, lint and soaked paper */
  SCUM_W: [0.012, 0.11, 0.04],
  SCUM_K: [0.25, 0.9, 0.55],
  /** meniscus: the water climbs a wetted surface by ~2-3 mm (capillary length 2.7 mm); pixel-averaged slope and its
   * width (m; never under 1.2 px, so it reads as a thin bright line at any distance) */
  MENISCUS: 0.8,
  MENISCUS_W: 0.003,
  /** the water right at a contact is shaded by the wall above it (fraction lost within CONTACT_W m) */
  CONTACT_SHADOW: 0.3,
  CONTACT_W: 0.03,
  // ---- refraction stand-ins (brWRefract / brWVolume): the screen-edge mirror copies content from beside the edge;
  // where it or its neighbourhood is STANDIN_K0..K1 times brighter (luma) than the scene where the ray's image left the
  // screen (both the pyramid at mip STANDIN_LOD), its luma is clamped to within STANDIN_K of that scene's: no second
  // copy of a wall lamp and its bezel near the screen's bottom edge beside the lamp's own refracted image
  STANDIN_K0: 1.5,
  STANDIN_K1: 2.5,
  STANDIN_K: 1.15,
  STANDIN_LOD: 3,
  /** a thing on the water (a lane-rope float) reaches this deep below the surface (m; at most half the water's
   * depth): past it the scene counts as visible again, its submerged half is not the floor */
  STRIP_DEPTH: 0.15,
  /** the refraction march passes behind a thing on the water it lies more than this far behind (m; floats) */
  THIN: 0.25,
} as const;

export interface Wave { mx: number; mz: number; kx: number; kz: number; k: number; lambda: number; phase: number }

/** The n analytic waves: integer lattice m = round(NOISE_WRAP / lambda (cos th, sin th)), k = 2 pi m / NOISE_WRAP. */
export function waveLattice(n: number): Wave[] {
  const W = WATER_SURFACE;
  const out: Wave[] = [];
  for (let i = 0; i < n; i++) {
    const lam = n === 1 ? W.LAMBDA_MAX : W.LAMBDA_MAX * Math.pow(W.LAMBDA_MIN / W.LAMBDA_MAX, i / (n - 1));
    const th = W.THETA0 + i * W.GOLDEN;
    const mx = Math.round((NOISE_WRAP / lam) * Math.cos(th)), mz = Math.round((NOISE_WRAP / lam) * Math.sin(th));
    const kx = (2 * Math.PI * mx) / NOISE_WRAP, kz = (2 * Math.PI * mz) / NOISE_WRAP;
    const k = Math.hypot(kx, kz);
    // R2 low-discrepancy phases
    const phase = 2 * Math.PI * (((i + 1) * 0.7548776662466927) % 1);
    out.push({ mx, mz, kx, kz, k, lambda: (2 * Math.PI) / k, phase });
  }
  return out;
}

/** Slope amplitudes a_i k_i per kind (rows) for a wave set: ~ lambda^SPLIT, sum of a^2 / 2 = RMS^2. */
export function waveAmplitudes(waves: readonly Wave[]): number[][] {
  const W = WATER_SURFACE;
  const wgt = waves.map((w) => Math.pow(w.lambda, W.SPLIT));
  const norm = Math.sqrt(0.5 * wgt.reduce((s, x) => s + x * x, 0)) || 1;
  return W.RMS.map((rms) => wgt.map((x) => (rms * x) / norm));
}

/** Angular frequency (rad/s) of a wave of wavenumber k over depth D (twin of brWaterSlope). */
export const waveOmega = (k: number, D: number): number =>
  Math.sqrt(WATER_SURFACE.G * k * Math.tanh(Math.min(k * Math.max(D, 0.02), 10)) + WATER_SURFACE.SIGMA_RHO * k * k * k);

const v2 = (a: readonly number[]): string => `vec2(${a.map(f).join(', ')})`;
const v3 = (a: readonly number[]): string => `vec3(${a.map(f).join(', ')})`;
const g9 = (v: number): string => f(Number(v.toPrecision(9)));

/** Wave tables for every BR_WATER_WAVES value 1..8 (the compiler keeps the one selected). */
function waveTablesGlsl(): string {
  let s = '';
  for (let n = 1; n <= 8; n++) {
    const w = waveLattice(n);
    const a = waveAmplitudes(w);
    s += `${n === 1 ? '#if' : '#elif'} BR_WATER_WAVES == ${n}
const vec2 BR_WK[${n}] = vec2[${n}](${w.map((x) => `vec2(${g9(x.kx)}, ${g9(x.kz)})`).join(', ')});
const float BR_WPH[${n}] = float[${n}](${w.map((x) => g9(x.phase)).join(', ')});
const float BR_WA[${3 * n}] = float[${3 * n}](${a.flat().map(g9).join(', ')});
`;
  }
  return s + '#endif\n';
}

/** The water shader's wave model (after fragmentCommon; needs uBrWaterNormals). */
export function waterWavesGlsl(): string {
  const W = WATER_SURFACE;
  return /* glsl */ `
#ifndef BR_WATER_WAVES
#define BR_WATER_WAVES 0
#endif
#define BR_WTEX_SCALE ${f(W.TEX_SCALE)}
#define BR_WTEX_RMS ${f(W.TEX_RMS)}
#define BR_WTEX_FEATURE ${f(W.TEX_FEATURE)}
#define BR_WALPHA_MAX ${f(W.ALPHA_MAX)}
#define BR_REFL_GEOM_D ${f(W.REFL_GEOM_D)}
const float BR_WALPHA0[3] = float[3](${W.ALPHA0.map(f).join(', ')});
const vec3 BR_WTEX_GAIN[3] = vec3[3](${W.TEX_GAIN.map(v3).join(', ')});
const vec3 BR_WTEX_P = ${v3(W.TEX_PERIOD)};
${waveTablesGlsl()}
// stored slope of the texture map at uv (repeat 1), filtered isotropically over the pixel footprint (fp metres, the
// layer period p): no anisotropic taps; the slope variance the filter removes becomes roughness (brWaterUnres)
vec2 brWaterTex( vec2 uv, float fp, float p ) {
	float lod = log2( max( fp / p * ${f(512)}, 1.0 ) );
	return ( textureLod( uBrWaterNormals, uv, lod ).rg * 2.0 - 1.0 ) * BR_WTEX_SCALE;
}
float brWaterUnres( float s, float fp, float lam ) { float q = fp / lam; return 0.5 * s * s * ( 1.0 - exp( - 8.0 * q * q ) ); }

// surface slope (dh/dx, dh/dz) at the world-periodic position pw; t time, kind, D depth (m), fp the pixel footprint
// (m); var = slope variance removed by the footprint filters (it becomes roughness)
vec2 brWaterSlope( vec2 pw, float t, int kind, float D, float fp, out float var ) {
	vec2 S = vec2( 0.0 );
	var = 0.0;
	vec3 g = BR_WTEX_GAIN[ kind ];
	vec2 s1 = brWaterTex( pw / BR_WTEX_P.x + t * ${v2(W.TEX_DRIFT[0])}, fp, BR_WTEX_P.x );
	vec2 s2 = brWaterTex( pw.yx / BR_WTEX_P.y + t * ${v2(W.TEX_DRIFT[1])}, fp, BR_WTEX_P.y ).yx;
	S += g.x * s1 + g.y * s2;
	var += brWaterUnres( g.x * BR_WTEX_RMS, fp, BR_WTEX_P.x * BR_WTEX_FEATURE ) + brWaterUnres( g.y * BR_WTEX_RMS, fp, BR_WTEX_P.y * BR_WTEX_FEATURE );
#if BR_WATER_WAVES > 0
	// third octave on a 3-4-5 rotated lattice (0.6 NW / 1.92 and 0.8 NW / 1.92 are integers: still periodic)
	const mat2 brR = mat2( 0.6, - 0.8, 0.8, 0.6 );
	vec2 s3 = transpose( brR ) * brWaterTex( brR * pw / BR_WTEX_P.z + t * ${v2(W.TEX_DRIFT[2])}, fp, BR_WTEX_P.z );
	S += g.z * s3;
	var += brWaterUnres( g.z * BR_WTEX_RMS, fp, BR_WTEX_P.z * BR_WTEX_FEATURE );
	float kd = max( D, 0.02 );
	for ( int i = 0; i < BR_WATER_WAVES; i ++ ) {
		vec2 k = BR_WK[ i ];
		float kl = length( k );
		// gravity-capillary dispersion at the local depth (tanh argument capped: some drivers overflow exp)
		float w = sqrt( ${f(W.G)} * kl * tanh( min( kl * kd, 10.0 ) ) + ${f(W.SIGMA_RHO)} * kl * kl * kl );
		float a = BR_WA[ kind * BR_WATER_WAVES + i ];
		float r = exp( - 0.25 * kl * kl * fp * fp ); // footprint filter
		S += a * r * cos( dot( k, pw ) - w * t + BR_WPH[ i ] ) * ( k / kl );
		var += 0.5 * a * a * ( 1.0 - r * r );
	}
#endif
	return S;
}
// GGX alpha of the water from the unresolved slope variance
float brWaterAlpha( int kind, float var ) {
	float a0 = BR_WALPHA0[ kind ];
	return min( sqrt( a0 * a0 + 2.0 * var ), BR_WALPHA_MAX );
}
`;
}

/** Ripple window + drip rings (water shader, BR_WATER_RIPPLE). uBrRippleLerp: WaterMaterial's own uniform. */
export function waterRippleGlsl(): string {
  const W = WATER_SURFACE;
  return /* glsl */ `
#ifdef BR_WATER_RIPPLE
uniform float uBrRippleLerp;
const vec3 BR_FOAM_ALB[3] = vec3[3](${W.FOAM_ALB.map(v3).join(', ')});
// ripple height at uv: the last two fixed steps of the simulation, interpolated to the frame time
float brRippleH( vec2 uv ) { vec2 v = texture( uRipple, uv ).rg; return mix( v.g, v.r, uBrRippleLerp ); }
// slope of the ripple window (WaterRipples.ts: world-anchored heightfield of the simulated plane) at rp (m from the
// window's texel-0 corner) plus the analytic drip rings; wyW = this plane's world y, fp the pixel footprint (m);
// h = ripple height (debug view), foam = bubble density
vec2 brRippleSlope( vec2 rp, float wyW, float fp, out float h, out float foam ) {
	vec2 S = vec2( 0.0 );
	h = 0.0;
	foam = 0.0;
	if ( uRippleOn > 0.5 && abs( wyW - uRipplePlane ) < 0.02 ) {
		vec2 ruv = rp / uRippleSpan;
		float edge = min( min( ruv.x, ruv.y ), min( 1.0 - ruv.x, 1.0 - ruv.y ) );
		if ( edge > 0.0 ) {
			float n = float( textureSize( uRipple, 0 ).x );
			float e = 1.0 / n;
			float dx = uRippleSpan * e;
			// window edge fade; sub-texel footprints average the rings out instead of aliasing them
			float ef = smoothstep( 0.0, 0.08, edge ) / ( 1.0 + ( fp / dx ) * ( fp / dx ) * 0.25 );
			float hxp = brRippleH( ruv + vec2( e, 0.0 ) ), hxm = brRippleH( ruv - vec2( e, 0.0 ) );
			float hzp = brRippleH( ruv + vec2( 0.0, e ) ), hzm = brRippleH( ruv - vec2( 0.0, e ) );
			S = vec2( hxp - hxm, hzp - hzm ) / ( 2.0 * dx ) * ef;
			vec4 c = texture( uRipple, ruv );
			h = mix( c.g, c.r, uBrRippleLerp ) * ef;
			foam = c.b * smoothstep( 0.0, 0.08, edge );
		}
	}
	// drips outside the window: expanding capillary rings (the simulation renders the ones inside it)
	const float kr = 6.2831853 / ${f(W.DRIP_WAVELENGTH)};
	float fk = exp( - 0.25 * kr * kr * fp * fp );
	for ( int i = 0; i < 8; i ++ ) {
		if ( i >= uNDrips ) break;
		vec2 dd = rp - uDrips[ i ].xy;
		float r = length( dd );
		if ( r > 0.9 ) continue;
		float age = mod( uTime + uDrips[ i ].w, uDrips[ i ].z );
		float R = ${f(W.DRIP_SPEED)} * age;
		float q = ( r - R ) / 0.045;
		float env = exp( - age / 0.7 ) * exp( - q * q ) / sqrt( 1.0 + r / 0.05 ) * fk;
		S += ${f(W.DRIP_SLOPE)} * env * cos( kr * ( r - R ) ) * dd / max( r, 1e-3 );
	}
	return S;
}
#endif
`;
}

/** Surface matter (water shader, BR_WATER_DEBRIS): the dust / oil film, floating flecks and the contact lines. */
export function waterFilmGlsl(): string {
  const W = WATER_SURFACE;
  const fp = Math.round(NOISE_WRAP / W.FLECK_CELL);
  return /* glsl */ `
#ifdef BR_WATER_DEBRIS
const float BR_WFILM[3] = float[3](${W.FILM.map(f).join(', ')});
const vec3 BR_WSCUM[3] = vec3[3](${W.SCUM_ALB.map(v3).join(', ')});
const float BR_FLECK_P[3] = float[3](${W.FLECK_P.map(f).join(', ')});
const float BR_WSCUM_W[3] = float[3](${W.SCUM_W.map(f).join(', ')});
const float BR_WSCUM_K[3] = float[3](${W.SCUM_K.map(f).join(', ')});
#define BR_WFILM_ROUGH ${f(W.FILM_ROUGH)}
#define BR_WFILM_DULL ${f(W.FILM_DULL)}
#define BR_WMENISCUS ${f(W.MENISCUS)}
#define BR_WMENISCUS_W ${f(W.MENISCUS_W)}
#define BR_WCONTACT_SHADOW ${f(W.CONTACT_SHADOW)}
#define BR_WCONTACT_W ${f(W.CONTACT_W)}
#define BR_WALL_T ${f(WALL_T)}
// Distance (m) from p (tile-local xz) to the nearest side of its cell that bounds this water (surface wy): a wall
// (wall-mask bit; its face WALL_T / 2 in front of the edge line) or a neighbour cell without water at this plane (the
// pool's rim, a step, a SOLID block). n = the unit horizontal direction away from that side (into the water).
// Works on every preset (one 18x18 mask, 5 texel fetches); objects smaller than a cell need the pyramid depth.
float brWaterEdge( vec2 p, float wy, out vec2 n ) {
	ivec2 c = ivec2( floor( p / BR_CELL ) );
	vec2 fr = p - vec2( c ) * BR_CELL;
	int bits = brWallBits( c );
	float e = 1e3;
	n = vec2( 0.0 );
	for ( int k = 0; k < 4; k ++ ) {
		// N1 (-z), E2 (+x), S4 (+z), W8 (-x)
		ivec2 d = k == 0 ? ivec2( 0, - 1 ) : k == 1 ? ivec2( 1, 0 ) : k == 2 ? ivec2( 0, 1 ) : ivec2( - 1, 0 );
		bool wall = ( bits & ( 1 << k ) ) != 0;
		float wyn;
		int kn;
		if ( ! wall && brWaterCell( c + d, wyn, kn ) && abs( wyn - wy ) < 0.03 ) continue;
		float dist = k == 0 ? fr.y : k == 1 ? BR_CELL - fr.x : k == 2 ? BR_CELL - fr.y : fr.x;
		if ( wall ) dist -= 0.5 * BR_WALL_T;
		if ( dist < e ) { e = dist; n = - vec2( d ); }
	}
	return max( e, 0.0 );
}
// Scum / foam line floating against a contact at horizontal distance e (m): a ragged band BR_WSCUM_W wide (its edge
// wanders with 0.3 m noise) made of clumps (7.5 cm and 0.6 m noise; slow drift), x the kind's strength
float brWaterScum( vec2 pw, float e, int kind, float t ) {
	float w = BR_WSCUM_W[ kind ];
	if ( e > 2.0 * w ) return 0.0;
	float band = 1.0 - smoothstep( 0.15 * w, w, e + ( brVNoise( pw / 0.3, ivec2( 4096 ), 921u ) - 0.5 ) * 0.9 * w );
	float clumps = smoothstep( 0.35, 0.7, 0.6 * brVNoise( pw / 0.075 + 0.004 * t, ivec2( 16384 ), 922u ) + 0.4 * brVNoise( pw / 0.6, ivec2( 2048 ), 923u ) );
	return band * clumps * BR_WSCUM_K[ kind ];
}
// dust / oil film coverage: slow-drifting patches (1.2 m and 0.3 m value noise, periods divide NOISE_WRAP)
float brWaterFilm( vec2 pw, float t, int kind ) {
	float n = 0.7 * brVNoise( pw / 1.2 + 0.01 * t, ivec2( 1024 ), 913u ) + 0.3 * brVNoise( pw / 0.3 - 0.013 * t, ivec2( 4096 ), 914u );
	return smoothstep( 0.55, 0.85, n ) * BR_WFILM[ kind ];
}
// floating flecks (paper, ceiling-tile crumbs, lint) on a ${f(W.FLECK_CELL)} m lattice, each wandering slowly about
// its cell; rgb = albedo, a = coverage (sub-pixel flecks fade out instead of sparkling). fpx = pixel footprint (m)
vec4 brWaterFlecks( vec2 pw, float t, int kind, float fpx ) {
	vec2 q = pw / ${f(W.FLECK_CELL)} - 0.5;
	ivec2 c0 = ivec2( floor( q ) );
	vec4 acc = vec4( 0.0 );
	if ( fpx > 0.05 ) return acc; // every fleck is sub-pixel
	for ( int j = 0; j < 2; j ++ ) {
		for ( int i = 0; i < 2; i ++ ) {
			ivec2 c = c0 + ivec2( i, j );
			uint h = brHash2u( brWrap( c, ivec2( ${fp} ) ), 917u );
			if ( brU01( h ) >= BR_FLECK_P[ kind ] ) continue;
			float p1 = brU01( brPcg( h + 1u ) ) * 6.2831853, p2 = brU01( brPcg( h + 2u ) ) * 6.2831853;
			vec2 ctr = ( vec2( c ) + 0.5 + 0.3 * vec2( sin( 0.05 * t + p1 ), cos( 0.035 * t + p2 ) ) ) * ${f(W.FLECK_CELL)};
			float u = brU01( brPcg( h + 3u ) );
			float r = 0.004 + 0.02 * u * u * u; // mostly crumbs, a few scraps
			float ang = brU01( brPcg( h + 4u ) ) * 3.1415927;
			float asp = mix( 0.35, 1.0, brU01( brPcg( h + 5u ) ) );
			vec2 dv = pw - ctr;
			vec2 cs = vec2( cos( ang ), sin( ang ) );
			dv = vec2( dot( dv, cs ), dot( dv, vec2( - cs.y, cs.x ) ) / asp );
			float dist = length( dv );
			if ( dist > 1.6 * r + fpx ) continue;
			// ragged outline: a few weak angular harmonics of the radius (no single one dominates: no clover shapes)
			float th = atan( dv.y, dv.x );
			float re = r * ( 1.0 + 0.12 * sin( 2.0 * th + p1 ) + 0.1 * sin( 3.0 * th + p2 ) + 0.07 * sin( 5.0 * th + p1 + p2 ) );
			float a = ( 1.0 - smoothstep( re - fpx, re + fpx, dist ) ) * smoothstep( 0.5, 1.5, r / max( fpx, 1e-5 ) ) * 0.9;
			// soaked matter: grey paper, ceiling-tile crumbs, cardboard, dark lint
			float pal = brU01( brPcg( h + 6u ) );
			vec3 alb = pal < 0.35 ? vec3( 0.55, 0.53, 0.47 ) : pal < 0.65 ? vec3( 0.5, 0.47, 0.4 ) : pal < 0.85 ? vec3( 0.36, 0.28, 0.18 ) : vec3( 0.16, 0.14, 0.11 );
			if ( a > acc.a ) acc = vec4( alb * mix( 0.8, 1.0, brU01( brPcg( h + 7u ) ) ), a );
		}
	}
	return acc;
}
#endif
`;
}

/**
 * The water body seen through the surface (water shader, BR_WATER_REFRACT = march steps; split frames only). The
 * submerged surfaces were drawn into package A's ColorPyramid without the view-path optics (chunks/haze.ts brDefer:
 * only the downwelling attenuation of their light), so here: the refracted view ray is marched against the pyramid's
 * linear depth, and what it reaches is seen through the medium: unscattered (sharp), forward-scattered (the same
 * scene, blurred through the pyramid's mips) and the ambient light scattered into the path (closed form, with the
 * downwelling attenuation at the depth s cos(theta_t)); plus, with BR_WATER_VOLLIGHT, the flashlight beam and the
 * nearest UNDERWATER lamps scattered toward the eye (6-sample integrals, the dual-lobe phase brPhaseW).
 */
export function waterVolumeGlsl(): string {
  const W = WATER_SURFACE;
  return /* glsl */ `
#ifdef BR_WATER_REFRACT
#define BR_WSTAND_K0 ${f(W.STANDIN_K0)}
#define BR_WSTAND_K1 ${f(W.STANDIN_K1)}
#define BR_WSTAND_K ${f(W.STANDIN_K)}
#define BR_WSTAND_LOD ${f(W.STANDIN_LOD)}
#define BR_WSTRIP_DEPTH ${f(W.STRIP_DEPTH)}
#define BR_WTHIN ${f(W.THIN)}
// view-space point -> pyramid uv (the pyramid spans the whole view at any scale)
vec2 brWProj( vec3 X ) { vec4 c = projectionMatrix * vec4( X, 1.0 ); return c.xy / c.w * 0.5 + 0.5; }
// linear view depth of the opaque scene at uv: the nearest level-0 texel (never filtered)
float brWSceneZ( vec2 uv ) {
	ivec2 s = textureSize( uSceneColor, 0 );
	return texelFetch( uSceneColor, clamp( ivec2( uv * vec2( s ) ), ivec2( 0 ), s - 1 ), 0 ).a;
}
// view-space point at pyramid uv and linear depth z (perspective)
vec3 brWViewPos( vec2 uv, float z ) {
	vec2 n = uv * 2.0 - 1.0;
	return vec3( ( n + vec2( projectionMatrix[ 2 ][ 0 ], projectionMatrix[ 2 ][ 1 ] ) ) * z / vec2( projectionMatrix[ 0 ][ 0 ], projectionMatrix[ 1 ][ 1 ] ), - z );
}
// the opaque scene's surface point (view space) in the level-0 texel nearest uv: the texel centre's ray at the
// texel's depth. Tests against surfaces use it rather than (uv, depth): at grazing angles one texel spans more depth
// than a film is deep (the 0.67 pyramid of ultra puts the texel centre up to half a texel off the pixel's ray)
vec3 brWScenePos( vec2 uv ) {
	ivec2 s = textureSize( uSceneColor, 0 );
	ivec2 t = clamp( ivec2( uv * vec2( s ) ), ivec2( 0 ), s - 1 );
	return brWViewPos( ( vec2( t ) + 0.5 ) / vec2( s ), texelFetch( uSceneColor, t, 0 ).a );
}
bool brWOnScreen( vec2 uv ) { return all( greaterThanEqual( uv, vec2( 0.0 ) ) ) && all( lessThanEqual( uv, vec2( 1.0 ) ) ); }

// The water's edge between p (tile-local xz, on the surface wy) and the eye: the wall-mask cells are walked along
// dir (unit xz toward the eye) for up to 4 cells. Returns the world axis the first edge runs along (1 x, 2 z; a wall
// or a cell without this water beyond it), 0 when there is none in reach. Pool rims lie on the cell grid, so this is
// the lip that hides refracted rays next to the near side of a pool.
int brWEdgeAxis( vec2 p, vec2 dir, float wy ) {
	ivec2 c = ivec2( floor( p / BR_CELL ) );
	ivec2 st = ivec2( dir.x > 0.0 ? 1 : - 1, dir.y > 0.0 ? 1 : - 1 );
	vec2 inv = 1.0 / max( abs( dir ), vec2( 1e-4 ) );
	vec2 tM = abs( ( vec2( c ) + vec2( greaterThan( dir, vec2( 0.0 ) ) ) ) * BR_CELL - p ) * inv; // to the next x / z line
	for ( int k = 0; k < 4; k ++ ) {
		bool xs = tM.x < tM.y;
		ivec2 d = xs ? ivec2( st.x, 0 ) : ivec2( 0, st.y );
		ivec2 cn = c + d;
		if ( cn.x < - 1 || cn.y < - 1 || cn.x > 16 || cn.y > 16 ) return 0;
		int side = d.x > 0 ? 2 : d.x < 0 ? 8 : d.y > 0 ? 4 : 1; // N1 (-z) E2 (+x) S4 (+z) W8 (-x)
		float wyn;
		int kn;
		if ( ( brWallBits( c ) & side ) != 0 || ! brWaterCell( cn, wyn, kn ) || abs( wyn - wy ) > 0.03 ) return xs ? 2 : 1;
		c = cn;
		if ( xs ) tM.x += BR_CELL * inv.x; else tM.y += BR_CELL * inv.y;
	}
	return 0;
}

// Does the pyramid texel at uv show a thing on the water (a lane-rope float, a ladder's rail, a lounger in a flooded
// room): its surface point lies from hS below to 1.2 m above the surface of the fragment P (tile-local xz pl) over a
// cell holding water? The deck at a pool's lip does not (its cell is dry).
bool brWOnWater( vec2 uv, vec3 P, vec3 upV, vec2 pl, float hS ) {
	vec3 S = brWScenePos( uv ) - P;
	float h = dot( S, upV );
	float wyn;
	int kn;
	return h > - hS && h < 1.2 && brWaterCell( ivec2( floor( ( pl + ( vec4( S, 0.0 ) * viewMatrix ).xz ) / BR_CELL ) ), wyn, kn );
}

// The refracted view ray from P (view space, on the surface) along Tv (unit); Lf = the path to the rect's flat floor
// (D / cos theta_t; rects are single-depth), upV = world up in view space, pl / wy = the fragment's tile-local xz and
// surface height. Returns the path length L in the water to what the ray reaches and its pyramid uv (uvH); hit = 0 when
// the ray left the screen or passed behind something above the water (the deck lip, a lounger: no data behind it; the
// floor under a near rim is only visible through the refraction): then L is the flat-floor path and uvH a stand-in (see
// below), which brWVolume takes by alt.w: 0 = as is; 1 = the target mirrored at the screen's edge, vetted against the
// scene at alt.xy (where the ray's image left the screen); 2 = behind a thing on the water, the scene at uvH
// (past its far side) blended with the scene at alt.xy (past its near side) by alt.z.
float brWRefract( vec3 P, vec3 Tv, float Lf, vec3 upV, vec2 pl, float wy, out vec2 uvH, out float hit, out vec4 alt ) {
	alt = vec4( 0.0 );
	// fast path: the flat floor, unless something in front of it covers that point (the texel there shows a surface
	// point off the floor plane)
	vec3 Xf = P + Tv * Lf;
	vec2 uvf = brWProj( Xf );
	if ( brWOnScreen( uvf ) && abs( dot( brWScenePos( uvf ) - Xf, upV ) ) < 0.01 - 0.004 * Xf.z ) { uvH = uvf; hit = 1.0; return Lf; }
	// linear march (1.2 Lf: floors lower than the rect's own under steps and ladders) to the first sample behind the
	// scene, 3 bisections to the crossing, then: behind something above the water (hidden) or on what the ray reaches
	// under the water (the secant). Classifying the coarse step instead stair-stepped the underwater walls beside
	// above-water ones (a step past the wall projects onto its part above the water). A sample more than BR_WTHIN
	// behind a thing on the water (brWOnWater: a lane-rope float nearer the eye, its submerged half too; the ray is
	// under the water far beyond it) passes behind it and the march goes on; only a ray that ends behind
	// such a thing is hidden by its first crossing (the lip of a pool's near side hides the whole rest of the ray): one
	// that came out beyond it is classified as its neighbours are. Stopping at the float drew a stand-in patch (a copy
	// of its outline) beyond every float.
	float hS = min( BR_WSTRIP_DEPTH, 0.5 * Lf * max( - dot( Tv, upV ), 0.05 ) ); // shallower: at the surface (a float)
	float tA = 0.0, dA = 1.0, tB = - 1.0, dB = 0.0, tA1 = 0.0, tB1 = - 1.0;
	vec2 uvP = brWProj( P ), uvA = uvP, uvX = uvP, uvA1 = uvP, uvX1 = uvP;
	bool off = false, behind = false;
	hit = 0.0;
	for ( int i = 1; i <= BR_WATER_REFRACT; i ++ ) {
		float t = 1.2 * Lf * float( i ) / float( BR_WATER_REFRACT );
		vec3 X = P + Tv * t;
		vec2 uv = brWProj( X );
		if ( ! brWOnScreen( uv ) ) { off = true; break; }
		float d = brWSceneZ( uv ) + X.z; // > 0: the ray is still in front of the scene
		if ( d < - BR_WTHIN && brWOnWater( uv, P, upV, pl, hS ) ) {
			if ( tB1 < 0.0 ) { tA1 = tA; tB1 = t; uvA1 = uvA; uvX1 = uv; }
			behind = true;
			continue;
		}
		if ( d <= 0.0 ) { tB = t; dB = d; uvX = uv; break; }
		tA = t;
		dA = d;
		uvA = uv;
		behind = false;
	}
	if ( tB < 0.0 && behind ) { tA = tA1; tB = tB1; uvA = uvA1; uvX = uvX1; off = false; }
	bool hidden = off || tB < 0.0 || tB == tB1;
	if ( ! hidden ) {
		for ( int k = 0; k < 3; k ++ ) {
			float tm = 0.5 * ( tA + tB );
			vec3 X = P + Tv * tm;
			vec2 uv = brWProj( X );
			float d = brWSceneZ( uv ) + X.z;
			if ( d <= 0.0 && ( d >= - BR_WTHIN || ! brWOnWater( uv, P, upV, pl, hS ) ) ) { tB = tm; dB = d; uvX = uv; }
			else if ( d > 0.0 ) { tA = tm; dA = d; uvA = uv; }
			else tA = tm; // behind a thing on the water: before the crossing, keep the last clearance
		}
		hidden = dot( brWScenePos( uvX ) - P, upV ) > 0.01;
	}
	if ( ! hidden ) {
		float t = tA + ( tB - tA ) * dA / max( dA - dB, 1e-5 );
		uvH = brWProj( P + Tv * t );
		if ( tB1 < 0.0 || ! brWOnWater( uvH, P, upV, pl, hS ) ) { hit = 1.0; return t; }
		// what the ray reached lies behind the float it passed (the texel shows the float): hidden by that crossing
		tA = tA1; tB = tB1; uvA = uvA1; uvX = uvX1; off = false;
	}
	// The target is not in the pyramid. Stand-in: the target reflected back across the line it disappeared behind,
	// i.e. the floor as far in front of that line as the target lies behind it. A reflection keeps the waves' lensing
	// at its true strength and is continuous where the target reappears (points on the line map to themselves).
	// Off screen the line is the screen's edge. Behind a thing on the water (a lane-rope float, a ladder's rail; found
	// first, below) the scene on its two sides is blended instead. Behind the lip of a pool's near side (the rim's axis
	// from brWEdgeAxis) the flat-floor target is mirrored ON THE FLOOR across the lip's shadow line (the lip point at the
	// crossing, bisected down to a texel, projected from the eye onto the floor plane): floor maps to floor at its true
	// perspective, so a deep pool's wide hidden band shows the visible floor beyond the shadow, not pool content from
	// across the screen; where that lands on nothing under the water, the lip's image line in screen space is the
	// mirror. Anything else (no rim in reach: a lounger) mirrors the target about the crossing point. The screen-edge
	// mirror copies content from beside the edge: a wall lamp there (beside its own refracted image) would show twice,
	// with its bezel, so brWVolume vets that stand-in against the scene where the ray's image left the screen (uvR).
	// (The last visible texel before a lip, in the lip's shade, is no reference for the floor mirrored beyond it.)
	vec2 uvM = 1.0 - abs( 1.0 - abs( uvf ) ); // folded back into the screen
	vec2 dU = uvf - uvP;
	vec2 sE = mix( uvP, 1.0 - uvP, vec2( greaterThan( dU, vec2( 0.0 ) ) ) ) / max( abs( dU ), vec2( 1e-6 ) );
	vec2 uvR = uvP + dU * clamp( min( sE.x, sE.y ), 0.0, 1.0 ); // where the ray's image left the screen
	if ( ! off && tB > 0.0 ) {
		vec2 ps = vec2( textureSize( uSceneColor, 0 ) );
		float tH = tB;
		for ( int k = 0; k < 8; k ++ ) {
			vec2 gap = ( uvX - uvA ) * ps;
			if ( dot( gap, gap ) < 1.0 ) break;
			float tm = 0.5 * ( tA + tH );
			vec3 X = P + Tv * tm;
			vec2 uv = brWProj( X );
			if ( brWOnScreen( uv ) && brWSceneZ( uv ) + X.z > 0.0 ) { tA = tm; uvA = uv; } else { tH = tm; uvX = uv; }
		}
		vec2 qB = 0.5 * ( uvA + uvX ) * ps, qf = uvf * ps;
		// a thing on the water (a lane-rope float, a ladder's rail) hides a narrow strip: past its near side
		// along the ray's image (doubling steps up to 64 texels, 3 bisections) the scene under the water is visible
		// again, and the scene just outside each side (1.5 texels, or the flat-floor target where it lies outside:
		// what the neighbours show) is blended by the flat-floor target's position across the strip (a mirror cannot
		// match both edges of so narrow a strip: it drew each float's outline beyond it; a rim in reach does not decide
		// it, lane ropes run within 4 cells of one). Visible = deeper than hS below the surface: a float's submerged
		// half is not the floor. Only behind a thing on the water (brWOnWater), not the deck at a lip.
		vec2 dn = normalize( ( uvX - uvA ) * ps + vec2( 0.0, 1e-6 ) );
		float sIn = 0.0, sOut = - 1.0; // texels past qB: the last inside the strip, the first beyond it
		for ( int k = 0; k < ( brWOnWater( uvX, P, upV, pl, hS ) ? 7 : 0 ); k ++ ) {
			float s = exp2( float( k ) );
			vec2 uv = ( qB + dn * s ) / ps;
			if ( ! brWOnScreen( uv ) ) break;
			if ( dot( brWScenePos( uv ) - P, upV ) < - hS ) { sOut = s; break; }
			sIn = s;
		}
		if ( sOut > 0.0 ) {
			for ( int k = 0; k < 3; k ++ ) {
				float s = 0.5 * ( sIn + sOut );
				if ( dot( brWScenePos( ( qB + dn * s ) / ps ) - P, upV ) < - hS ) sOut = s; else sIn = s;
			}
			float sf = dot( qf - qB, dn );
			uvH = clamp( ( qB + min( sf, - 1.5 ) * dn ) / ps, vec2( 0.0 ), vec2( 1.0 ) );
			alt = vec4( clamp( ( qB + max( sf, sOut + 1.5 ) * dn ) / ps, vec2( 0.0 ), vec2( 1.0 ) ), clamp( sf / sOut, 0.0, 1.0 ), 2.0 );
			return Lf;
		}
		vec2 q = 2.0 * qB - qf; // point mirror
		vec2 eye = ( vec4( - P, 0.0 ) * viewMatrix ).xz; // horizontal, toward the eye
		int ax = brWEdgeAxis( pl, eye / max( length( eye ), 1e-5 ), wy );
		if ( ax != 0 ) {
			vec3 aV = ( viewMatrix * vec4( ax == 1 ? 1.0 : 0.0, 0.0, ax == 2 ? 1.0 : 0.0, 0.0 ) ).xyz;
			vec4 c = projectionMatrix * vec4( aV, 0.0 );
			vec2 tl = ( c.xy - ( 2.0 * qB / ps - 1.0 ) * c.w ) * ps; // the lip's image direction at qB (pixels)
			if ( dot( tl, tl ) > 1e-8 ) {
				vec2 n = normalize( vec2( - tl.y, tl.x ) );
				q = qf - 2.0 * dot( qf - qB, n ) * n; // reflected across the line
			}
			// the floor mirror: heights relative to the eye (view origin) of the lip point and the floor plane
			vec3 Lp = brWScenePos( uvX );
			float lh = dot( Lp, upV ), fh = dot( Xf, upV );
			if ( lh < 0.0 && fh < lh ) {
				vec3 Xs = Lp * ( fh / lh ); // on the lip's shadow line
				vec3 nH = cross( upV, aV );
				nH *= dot( nH, Xs ) < 0.0 ? - 1.0 : 1.0; // horizontal, away from the eye across the rim
				vec3 Xm = Xf - 2.0 * min( dot( Xf - Xs, nH ), 0.0 ) * nH;
				vec2 uvW = brWProj( Xm );
				if ( brWOnScreen( uvW ) && dot( brWScenePos( uvW ) - P, upV ) < 0.0 ) q = uvW * ps;
			}
		}
		uvM = clamp( q / ps, vec2( 0.0 ), vec2( 1.0 ) );
	}
	// keep the last visible sample where the stand-in lands on something above the water (a pool narrower than the
	// band) or, for a ray that passed behind a float, on the float
	uvH = dot( brWScenePos( uvM ) - P, upV ) < 0.0 && ! ( tB1 > 0.0 && brWOnWater( uvM, P, upV, pl, hS ) ) ? uvM : uvA;
	if ( off ) alt = vec4( uvR, 0.0, 1.0 );
	return Lf;
}

// The scene at pyramid uv, sharp (cs; a = its linear depth) and through the kind's forward-scattering blur over the
// path L (Cb)
void brWSceneCol( vec2 uv, float L, int kind, out vec4 cs, out vec3 Cb ) {
	cs = textureLod( uSceneColor, uv, 0.0 );
	Cb = cs.rgb;
	float blur = BR_WM_BLUR[ kind ];
	if ( blur > 0.0 ) {
		// the forward-scattered spread (a random walk: blur sqrt(ss L) L metres) seen at the hit's depth, in pyramid
		// texels -> the mip
		float r = blur * sqrt( BR_WM_SS[ kind ] * L ) * L;
		float px = r / max( cs.a, 0.05 ) * 0.5 * projectionMatrix[ 1 ][ 1 ] / uSceneInvSize.y;
		vec4 cb = textureLod( uSceneColor, uv, clamp( log2( max( px, 1.0 ) ), 0.0, 6.0 ) );
		// the mips average across silhouettes (the deck beside the water): fall back where their depth disagrees
		Cb = mix( cs.rgb, cb.rgb, 1.0 - smoothstep( 0.1, 0.35, abs( cb.a - cs.a ) / max( cs.a, 0.05 ) ) );
	}
}

// Radiance leaving the water body toward the surface (before the interface): the scene at uvH (a stand-in by alt.w,
// brWRefract) through the medium of the kind over the refracted path L (cosT = its cosine to the vertical), lit
// ambiently by irr (lux). Where the screen-edge mirror or its neighbourhood (mip BR_WSTAND_LOD) is BR_WSTAND_K0..K1
// times brighter than the scene where the ray's image left the screen (alt.xy, same mip), its luma is clamped to within
// BR_WSTAND_K of that scene's, hue kept: a copy of a lamp and of its dark bezel fades into the stand-in's texture,
// which stays elsewhere (a clamp everywhere drew streaks along the rays). Behind a thing on the water (alt.w = 2) the
// two sides' colours are blended by alt.z. st = the extinction (for the in-water light integrals).
vec3 brWVolume( vec2 uvH, vec4 alt, float L, float cosT, int kind, vec3 irr, out vec3 st ) {
	vec3 sa = BR_WM_SA[ kind ];
	float ss = BR_WM_SS[ kind ];
	st = sa + ss;
	vec3 kap = sa + ( 1.0 - BR_WM_G[ kind ] ) * ss; // transport: what forward scattering keeps in the beam
	vec3 Tu = exp( - st * L ); // unscattered: sharp
	vec3 Tf = max( exp( - kap * L ) - Tu, vec3( 0.0 ) ); // scattered forward: arrives blurred
	vec4 cs;
	vec3 Cb;
	brWSceneCol( uvH, L, kind, cs, Cb );
	if ( alt.w > 1.5 ) {
		vec4 cs2;
		vec3 Cb2;
		brWSceneCol( alt.xy, L, kind, cs2, Cb2 );
		cs.rgb = mix( cs.rgb, cs2.rgb, alt.z );
		Cb = mix( Cb, Cb2, alt.z );
	}
	if ( alt.w > 0.5 && alt.w < 1.5 ) {
		float lR = brLuma( textureLod( uSceneColor, alt.xy, BR_WSTAND_LOD ).rgb ) + 1e-4;
		float lS = brLuma( cs.rgb ) + 1e-4, lB = brLuma( Cb ) + 1e-4;
		float lD = brLuma( textureLod( uSceneColor, uvH, BR_WSTAND_LOD ).rgb ); // the stand-in's neighbourhood
		float v = smoothstep( BR_WSTAND_K0, BR_WSTAND_K1, max( lD, lS ) / lR );
		cs.rgb *= mix( 1.0, clamp( lS, lR / BR_WSTAND_K, lR * BR_WSTAND_K ) / lS, v );
		Cb *= mix( 1.0, clamp( lB, lR / BR_WSTAND_K, lR * BR_WSTAND_K ) / lB, v );
	}
	// ambient light scattered into the path: source ss PHI E / pi, attenuated on the way down to the depth s cos(theta_t)
	// (1.25 kappa per metre of depth: diffuse downwelling) and on the way back up to the surface; closed form
	vec3 k = st + 1.25 * kap * cosT;
	vec3 Lin = ss * BR_WM_PHI[ kind ] * BR_WM_TINT[ kind ] * irr / BR_PI * ( 1.0 - exp( - k * L ) ) / k;
	return cs.rgb * Tu + Cb * Tf + Lin;
}

// Contact from the pyramid depth at the own pixel (uv0): the straight view ray meets something standing in the water
// (a wall, a pillar, a chair leg) at a depth h0 much shallower than the floor (h0 < D / 2): its horizontal distance
// (m) from the fragment, and nAway = the view-space horizontal direction from it to the fragment. The texel's own
// surface point (brWScenePos) keeps the depth test exact at grazing angles (a film's floor is no contact), and a
// texel of something above the water (a silhouette in the 0.67 pyramid of ultra) is none either. From 0.2 D the
// distance is pushed out smoothly, by 0.3 m (past every contact effect) at the cutoff: seen steeply the cutoff falls
// inside the flooded scum band (e = D / (2 tan) is 7 cm at 60 deg, the band 11 cm) and cut it off in a hard ring
// around chair legs and pillars.
float brWContact( vec3 P, float D, vec3 upV, vec2 uv0, out vec3 nAway ) {
	vec3 dv = brWScenePos( uv0 ) - P;
	float h0 = - dot( dv, upV ); // depth below the surface
	nAway = vec3( 0.0 );
	if ( h0 > 0.5 * D || h0 < - 0.01 ) return 1e3;
	vec3 hz = - dv - upV * h0; // horizontal, from the contact to the fragment
	float e = length( hz );
	nAway = hz / max( e, 1e-5 );
	return e + 0.3 * smoothstep( 0.2 * D, 0.5 * D, h0 );
}

#ifdef BR_WATER_VOLLIGHT
#if NUM_SPOT_LIGHTS > 0
#define brBeamSoft brBeamSoftW
${beamSoftGlsl()}
#undef brBeamSoft
// The flashlight beam scattered toward the eye inside the water (silty water glows where the beam enters): 6 samples
// on the refracted view segment [0, L] below P. The beam reaches a sample X at depth s cos(theta_t) along its own
// refracted path (transport-attenuated), its intensity is the smooth beam profile (flashlightOptics.ts) x three's
// cone and range window, and the scattered light returns to the surface through the medium. vis = the beam's shadow
// at the surface point (stops it leaking through walls).
vec3 brWaterTorch( vec3 P, vec3 Tv, float L, float cosT, vec3 upV, vec3 st, int kind, float vis ) {
	SpotLight sl = spotLights[ 0 ];
	if ( dot( sl.color, sl.color ) <= 0.0 || vis <= 0.0 ) return vec3( 0.0 );
	vec3 kap = BR_WM_SA[ kind ] + ( 1.0 - BR_WM_G[ kind ] ) * BR_WM_SS[ kind ];
	vec3 acc = vec3( 0.0 );
	for ( int j = 0; j < 6; j ++ ) {
		float s = ( float( j ) + 0.5 ) / 6.0 * L;
		vec3 X = P + Tv * s;
		vec3 Ld = sl.position - X;
		float r = length( Ld );
		vec3 l = Ld / max( r, 1e-4 );
		float ca = dot( l, sl.direction );
		float I = brBeamSoftW( ca ) * getSpotAttenuation( sl.coneCos, sl.penumbraCos, ca ) * getDistanceAttenuation( r, sl.distance, sl.decay );
		float ly = dot( l, upV );
		float cb = sqrt( max( 1.0 - ( 1.0 - ly * ly ) * 0.5625, 0.0 ) ); // the refracted beam's cosine to the vertical
		acc += I * brPhaseW( dot( l, Tv ), kind ) * exp( - kap * ( s * cosT / max( cb, 0.3 ) ) - st * s );
	}
	return sl.color * ( BR_WM_SS[ kind ] * vis * L / 6.0 ) * acc;
}
#endif
// The nearest UNDERWATER lamps (water/underwaterLights.ts: camera-relative position, facing, colour x cd) scattered
// toward the eye along [0, L]: Lambertian lamps; the substitution s = tc + h tan(th) makes the inverse-square
// integrand smooth (as brAirlight), 6 samples per lamp; a lamp's glow fades out between 2.5 and 4 m from the segment
// (there it is a few % of the lit pool floor: a hard cut would draw a ring around the 6000-nit pool lights).
vec3 brWaterLamps( vec3 P, vec3 Tv, float L, vec3 st, int kind ) {
	vec3 acc = vec3( 0.0 );
	mat3 R = mat3( viewMatrix );
	for ( int i = 0; i < BR_WATER_VOLLIGHT; i ++ ) {
		if ( i >= uNUw ) break;
		vec3 Q = R * uUwPos[ i ].xyz;
		vec3 n = R * uUwDir[ i ].xyz;
		float tc = dot( Q - P, Tv );
		float h = max( length( Q - P - Tv * tc ), uUwDir[ i ].w );
		if ( h > 4.0 ) continue;
		float a0 = atan( - tc / h ), a1 = atan( ( L - tc ) / h );
		vec3 sum = vec3( 0.0 );
		for ( int j = 0; j < 6; j ++ ) {
			float th = mix( a0, a1, ( float( j ) + 0.5 ) / 6.0 );
			float s = tc + h * tan( th );
			vec3 w = P + Tv * s - Q;
			float r = length( w );
			vec3 wn = w / max( r, 1e-4 );
			sum += max( dot( n, wn ), 0.0 ) * brPhaseW( dot( wn, - Tv ), kind ) * exp( - st * ( r + s ) );
		}
		acc += uUwCol[ i ].rgb * sum * ( ( a1 - a0 ) / ( 6.0 * h ) * ( 1.0 - smoothstep( 2.5, 4.0, h ) ) );
	}
	return BR_WM_SS[ kind ] * acc;
}
#endif
#endif
`;
}

/** Appended to the surface fragment common block (after the helpers and uniforms). */
export const WATER_SURF_GLSL = /* glsl */ `
// ---- package E: water seen from the surface programs
// This fragment's water: (depth below the surface (> 0 submerged, else <= 0), kind, surface y (storey-relative),
// 1 when known). Shell faces flagged UNDERWATER carry the plane in aux.w (subDepth, chunks/surface.ts); floors carry
// the kind in tint.a, other faces take it from the wall-mask cell in front of them; props (and anything else in a
// water tile) look their cell up in the wall mask. Evaluated once, at the end of the emissive chunk (brSubInfo).
vec4 brWaterSubInfo( int f, float subDepth, float tintA, vec3 nWg ) {
	float wy;
	int k;
	if ( ( f & BR_F_UNDERWATER ) != 0 ) {
		float kind = floor( tintA * 255.0 + 0.5 );
		if ( ( f & BR_F_FLOOR_AUX ) == 0 ) kind = brWaterCell( ivec2( floor( ( vBrLocal.xz + nWg.xz * 0.1 ) / BR_CELL ) ), wy, k ) ? float( k ) : 0.0;
		return vec4( subDepth, min( kind, 2.0 ), vBrLocal.y + subDepth, 1.0 );
	}
#ifdef BR_PROPS
	if ( uTileWater > 0.5 && brWaterCell( ivec2( floor( vBrLocal.xz / BR_CELL ) ), wy, k ) && wy > vBrLocal.y ) {
		return vec4( wy - vBrLocal.y, float( k ), wy, 1.0 );
	}
#endif
	return vec4( - 1.0, 0.0, 0.0, 0.0 );
}
#ifdef BR_CAUSTICS_FULL
// Above-water caustics: pool-water coverage around p (tile-local xz) from the 4 nearest wall-mask cells (bilinear
// over cell centres: spills ~0.6 m past the water's edge; pools only), with the mean surface height wy; cells behind
// a wall of the fragment's own cell do not count.
float brWaterCover( vec2 p, out float wy ) {
	vec2 cv = p / BR_CELL - 0.5;
	ivec2 c0 = ivec2( floor( cv ) );
	vec2 fr = cv - vec2( c0 );
	ivec2 cs = ivec2( floor( p / BR_CELL ) );
	int wb = brWallBits( cs );
	float cov = 0.0, ws = 0.0;
	wy = 0.0;
	for ( int j = 0; j < 2; j ++ ) {
		for ( int i = 0; i < 2; i ++ ) {
			ivec2 c = c0 + ivec2( i, j );
			float wyc;
			int k;
			if ( ! brWaterCell( c, wyc, k ) || k != 0 ) continue;
			ivec2 d = c - cs;
			if ( ( d.x > 0 && ( wb & 2 ) != 0 ) || ( d.x < 0 && ( wb & 8 ) != 0 ) || ( d.y > 0 && ( wb & 4 ) != 0 ) || ( d.y < 0 && ( wb & 1 ) != 0 ) ) continue;
			float w = ( i == 0 ? 1.0 - fr.x : fr.x ) * ( j == 0 ? 1.0 - fr.y : fr.y );
			cov += w;
			wy += w * wyc;
			ws += w;
		}
	}
	wy = ws > 0.0 ? wy / ws : 0.0;
	return cov;
}
// The above-water net magnified sc times (cells 0.6 sc m). brCausticsW scales about the world-periodic origin, so a
// scale that varies along one surface (walls, pillars, arch soffits: the height above the water changes) would slide
// the net by |pw| d(1/sc), hundreds of cells per metre of height at |pw| ~ 600 m: noise. The scale therefore steps
// through levels BR_CAUSTIC_LEVEL^k, each snapped so that 2048 / sc is a multiple of 4 (the lattices and their warp
// stay periodic over NOISE_WRAP), and cross-fades to the next level over the middle 2 x band of each step (a single
// evaluation elsewhere; horizontal faces, whose height is constant, pass a narrow band). Every level has the same
// mean, brCausticMeanW( 0.18 ).
float brCausticLevel( float k ) { return 2048.0 / ( 4.0 * floor( 512.0 / pow( BR_CAUSTIC_LEVEL, k ) + 0.5 ) ); }
float brCausticsAbove( vec2 xz, float t, float sc, float band ) {
	float L = log2( max( sc, 1.0 ) ) / log2( BR_CAUSTIC_LEVEL );
	float k = floor( L );
	float w = smoothstep( 0.5 - band, 0.5 + band, L - k );
	float c = 0.0;
	if ( w < 1.0 ) c += ( 1.0 - w ) * brCausticsW( xz, t, 0.0, brCausticLevel( k ), 0.18 );
	if ( w > 0.0 ) c += w * brCausticsW( xz, t, 0.0, brCausticLevel( k + 1.0 ), 0.18 );
	return c;
}
#endif
#ifdef BR_WATER_WETBAND
// wetness (0..1) of a fragment just above a water line: a band of BR_WETBAND[kind] (pool: lapping +- 8 mm) on
// vertical faces whose cell in front holds water (tile-local position, world geometric normal)
const float BR_WETBAND[3] = float[3](${WATER_SURFACE.WETBAND.map(f).join(', ')});
float brWaterWetBand( vec3 local, vec3 nWg, bool horiz ) {
	if ( horiz || uTileWater < 0.5 ) return 0.0;
	float wy;
	int k;
	if ( ! brWaterCell( ivec2( floor( ( local.xz + nWg.xz * 0.1 ) / BR_CELL ) ), wy, k ) ) return 0.0;
	float dy = local.y - wy;
	float hb = BR_WETBAND[ k ] + ( k == 0 ? 0.008 * sin( uTime * 1.3 + ( local.x + local.z + uNoiseOrigin.x + uNoiseOrigin.z ) * 4.1 ) : 0.0 );
	return ( 1.0 - smoothstep( 0.6 * hb, hb, dy ) ) * step( - 0.002, dy );
}
#endif
`;

/** Appended to the surface clipping_planes_pars_fragment injection (after three's light pars: SpotLight,
 * getSpotLightInfo). chunks/surface.ts redirects three's getSpotLightInfo call in lights_fragment_begin here
 * (#define at the end of the emissive chunk, #undef at the start of chunks/lighting.ts). */
export const WATER_SPOT_GLSL = /* glsl */ `
#if NUM_SPOT_LIGHTS > 0
// the flashlight on a submerged fragment (sub = brSubInfo): the beam's in-water path attenuates it (transport
// coefficient, refracted path; chunks/haze.ts later applies the downwelling factor of the baked light to all lit
// radiance, so it is divided out here) and the wavy surface focuses the small source into a sharp, fine caustic net
// (width 0.08, half-size cells), mean-preserving with a floor between the filaments (BR_CAUSTIC_SPOT_CONTRAST: the
// reflector's size and the beam's spread fill the cells); turbid flood water scatters the net away, films have none
void brSpotInfoW( const in SpotLight spotLight, const in vec3 geometryPosition, out IncidentLight light, const in vec4 sub ) {
	getSpotLightInfo( spotLight, geometryPosition, light );
#ifdef BR_CAUSTICS_FULL
	if ( sub.x <= 0.0 || ! light.visible ) return;
	int k = int( sub.y + 0.5 );
	vec3 lw = normalize( ( vec4( light.direction, 0.0 ) * viewMatrix ).xyz );
	float st2 = ( 1.0 - lw.y * lw.y ) * 0.5625; // sin^2 of the refracted beam (air -> water)
	float ct = max( sqrt( max( 1.0 - st2, 0.0 ) ), 0.2 );
	vec3 kap = BR_WM_SA[ k ] + ( 1.0 - BR_WM_G[ k ] ) * BR_WM_SS[ k ];
	light.color *= exp( - kap * ( sub.x * ( 1.0 / ct - BR_WM_DOWN ) ) );
	float ks = k == 0 ? 1.0 : k == 1 ? 0.1 * exp( - BR_WM_SS[ 1 ] * sub.x ) : 0.0;
	if ( ks > 0.0 ) {
		vec2 hd = lw.xz / max( length( lw.xz ), 1e-4 );
		vec2 xe = vBrLocal.xz + uNoiseOrigin.xz + hd * ( sqrt( st2 ) / ct ) * sub.x; // where the beam entered
		float wd = 0.15 * sub.x;
		float c = brCausticsW( xe, uTime, wd, 0.5, 0.08 );
		light.color *= 1.0 + BR_CAUSTIC_SPOT_CONTRAST * ks * ( c / brCausticMeanW( 0.08 + wd ) - 1.0 );
	}
#endif
}
#endif
`;
