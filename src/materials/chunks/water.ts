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

import { NOISE_WRAP } from '../../core/constants.ts';
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
  /** GGX alpha of the surface itself (still water is a near-perfect mirror; film: carpet pile tips break it); the
   * unresolved waves add to it with distance */
  ALPHA0: [0.004, 0.003, 0.012],
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
  FILM: [0.1, 0.8, 0.4], // dust / oil film coverage weight
  SCUM_ALB: [[0.8, 0.82, 0.8], [0.42, 0.36, 0.24], [0.5, 0.45, 0.35]],
  FLECK_CELL: 0.24, // m (5120 per NOISE_WRAP)
  FLECK_P: [0.004, 0.05, 0.03], // fraction of lattice cells with a fleck
  WETBAND: [0.03, 0.07, 0.015], // m above the water line
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

/** Surface matter (water shader, BR_WATER_DEBRIS): the dust / oil film and floating flecks. */
export function waterFilmGlsl(): string {
  const W = WATER_SURFACE;
  const fp = Math.round(NOISE_WRAP / W.FLECK_CELL);
  return /* glsl */ `
#ifdef BR_WATER_DEBRIS
const float BR_WFILM[3] = float[3](${W.FILM.map(f).join(', ')});
const vec3 BR_WSCUM[3] = vec3[3](${W.SCUM_ALB.map(v3).join(', ')});
const float BR_FLECK_P[3] = float[3](${W.FLECK_P.map(f).join(', ')});
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
// radiance, so it is divided out here) and the wavy surface focuses a point source into a sharp, fine caustic net
// (width 0.08, half-size cells, no source-size blur); turbid flood water scatters the net away, films have none
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
	float ks = k == 0 ? 1.0 : k == 1 ? 0.3 * exp( - BR_WM_SS[ 1 ] * sub.x ) : 0.0;
	if ( ks > 0.0 ) {
		vec2 hd = lw.xz / max( length( lw.xz ), 1e-4 );
		vec2 xe = vBrLocal.xz + uNoiseOrigin.xz + hd * ( sqrt( st2 ) / ct ) * sub.x; // where the beam entered
		float wd = 0.15 * sub.x;
		float c = brCausticsW( xe, uTime, wd, 0.5, 0.08 );
		light.color *= max( 1.0 + BR_CAUSTIC_SPOT_GAIN * ks * ( c - brCausticMeanW( 0.08 + wd ) ), 0.0 );
	}
#endif
}
#endif
`;
