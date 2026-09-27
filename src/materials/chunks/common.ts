// src/materials/chunks/common.ts — GLSL declarations and helpers shared by every WP9 shader (surface variants and
// water). Pure strings; tuning numbers come from chunks/params.ts.
//
// Precision rules (§2.2): no float32 world-position varying. World-anchored lookups use
// vBrLocal + uNoiseOrigin (xz, wraps at NOISE_WRAP) and vBrLocal.y (storey-relative). Every lattice used by
// world noise is integer-periodic over NOISE_WRAP horizontally and over STOREY_PITCH vertically.

import { CELL } from '../../core/constants.ts';
import { beamSoftGlsl } from '../../lighting/flashlightOptics.ts';
import { f, glslConstants } from './params.ts';

/** Uniforms shared by every surface / water material (MaterialGlobals + shared texture set + layer table). Every
 * uniform of the graphics-realism packages is declared here once (A.0); unused declarations cost nothing, and the
 * surface sampler budget (16, tests/materials/samplerBudget.test.ts) counts only referenced samplers. */
export const GLOBAL_UNIFORMS_GLSL = /* glsl */ `
uniform float uTime;
uniform int uDebugView;
uniform float uHazeDensity;
uniform vec3 uHazeTint;
uniform float uHazeAlbedo;
uniform vec2 uEdgeFog;
uniform vec3 uFarColor;
uniform int uFlickerMode;
uniform sampler2D uReflTex;
uniform mat4 uReflMatrix;
uniform float uReflOn;
uniform float uReflY;
uniform float uFloorReflOn;
uniform float uBrReflPass;
uniform float uBrMrt;
// D: box-projected reflection probe (camera-relative world metres)
uniform samplerCube uBrProbe;
uniform float uBrProbeOn;
uniform float uBrProbeLod;
uniform vec3 uBrProbeMin;
uniform vec3 uBrProbeMax;
uniform vec3 uBrProbePos;
// A/E: opaque colour pyramid (rgb HDR, a linear view depth) of split frames; D: Hi-Z min-depth pyramid
uniform sampler2D uSceneColor;
uniform vec2 uSceneInvSize;
uniform float uWaterVolOn;
uniform sampler2D uHiZ;
uniform vec4 uHiZInfo;
// A: pre-shade SSAO (r AO, g view Z, ba oct normal; x on, y pow, z plane, w step) and contact shadows
uniform sampler2D uSsaoTex;
uniform vec4 uSsaoP;
uniform vec4 uSsaoProj;
uniform vec4 uSsaoSize;
uniform float uCsOn;
// F: froxel volume (rgb in-scatter, a transmittance)
uniform sampler2D uVolTex;
uniform vec4 uVolGrid;
uniform vec4 uVolZ;
uniform vec2 uVolScreen;
// F: flashlight bounce VPLs
uniform float uFbOn;
uniform vec4 uFbP[ 8 ];
uniform vec4 uFbN[ 8 ];
uniform vec4 uFbC[ 8 ];
uniform vec4 uFbBox[ 8 ];
// E: ripple window, drips, in-water lights
uniform sampler2D uRipple;
uniform vec2 uRippleOrigin;
uniform float uRippleSpan;
uniform float uRipplePlane;
uniform float uRippleOn;
uniform vec4 uDrips[ 8 ];
uniform int uNDrips;
uniform vec4 uUwPos[ 4 ];
uniform vec4 uUwDir[ 4 ];
uniform vec4 uUwCol[ 4 ];
uniform int uNUw;
// B: SURFACE_PHYS layer tables and the detail-map array
uniform vec4 uBrLayerC[ BR_MAT_COUNT ];
uniform vec4 uBrLayerD[ BR_MAT_COUNT ];
uniform vec4 uBrLayerE[ BR_MAT_COUNT ];
uniform sampler2DArray uBrDetail;
`;

/** Per-tile uniforms (TileBindings). */
export const TILE_UNIFORMS_GLSL = /* glsl */ `
uniform vec3 uTileOrigin;
uniform vec3 uNoiseOrigin;
uniform sampler2D uLmIrr;
uniform sampler2D uLmDir;
uniform sampler2D uLmMask;
uniform sampler2D uLmFlick;
uniform sampler2D uEmission;
uniform sampler3D uVolA;
uniform sampler3D uVolB;
uniform sampler3D uVolC;
uniform sampler2D uVolMask;
uniform vec3 uFlick[ 9 ];
uniform vec2 uOwnParity;
uniform float uFade;
uniform float uTileWater;
`;

/** Pure helper functions (hashes, periodic noise, Voronoi caustics, dither, flicker-channel slots, LV mapping). */
export const HELPERS_GLSL = /* glsl */ `
#define BR_CELL ${f(CELL)}
#define BR_LV_WALL_CLAMP 0.3

float brLuma( vec3 c ) { return dot( c, vec3( 0.2126, 0.7152, 0.0722 ) ); }

// ---- integer hashing (PCG). Stable per lattice id; never used for CPU parity.
uint brPcg( uint v ) {
	uint s = v * 747796405u + 2891336453u;
	uint w = ( ( s >> ( ( s >> 28u ) + 4u ) ) ^ s ) * 277803737u;
	return ( w >> 22u ) ^ w;
}
uint brHash2u( ivec2 c, uint salt ) { return brPcg( uint( c.x ) * 1597334677u ^ brPcg( uint( c.y ) ^ ( salt * 3812015801u ) ) ); }
float brU01( uint h ) { return float( h >> 8u ) * ( 1.0 / 16777216.0 ); }
// floor-mod for (possibly negative) lattice ids; GLSL % is undefined for negative operands
ivec2 brWrap( ivec2 c, ivec2 p ) { return c - p * ivec2( floor( vec2( c ) / vec2( p ) ) ); }
// canonical id of a sheared-lattice vertex (world (i + j/2, ROW·j)·hexM): a z shift of NOISE_WRAP is (−Pz/2, +Pz)
// in lattice units, an x shift is (+Px, 0); Pz is even so both are lattice translations
ivec2 brHexWrap( ivec2 c, int px, int pz ) {
	int k = int( floor( float( c.y ) / float( pz ) ) );
	c.y -= k * pz;
	c.x += k * ( pz / 2 );
	c.x -= px * int( floor( float( c.x ) / float( px ) ) );
	return c;
}
vec3 brHashColor( uint h ) {
	uint a = brPcg( h );
	return vec3( brU01( a ), brU01( brPcg( a ) ), brU01( brPcg( a + 1u ) ) ) * 0.8 + 0.2;
}

// ---- periodic value noise: x in lattice units, period in cells
float brVNoise( vec2 x, ivec2 period, uint salt ) {
	vec2 i = floor( x );
	vec2 fr = x - i;
	vec2 u = fr * fr * ( 3.0 - 2.0 * fr );
	ivec2 c = ivec2( i );
	float a = brU01( brHash2u( brWrap( c, period ), salt ) );
	float b = brU01( brHash2u( brWrap( c + ivec2( 1, 0 ), period ), salt ) );
	float d = brU01( brHash2u( brWrap( c + ivec2( 0, 1 ), period ), salt ) );
	float e = brU01( brHash2u( brWrap( c + ivec2( 1, 1 ), period ), salt ) );
	return mix( mix( a, b, u.x ), mix( d, e, u.x ), u.y );
}

// ---- world-anchored 2D coordinates on a surface: horizontal -> (x, z); vertical -> (along, y)
bool brIsHoriz( vec3 n ) { vec3 a = abs( n ); return a.y >= max( a.x, a.z ); }
vec2 brSurf2D( vec3 pw, vec3 n ) {
	vec3 a = abs( n );
	if ( a.y >= max( a.x, a.z ) ) return pw.xz;
	return a.x > a.z ? vec2( pw.z, pw.y ) : vec2( pw.x, pw.y );
}
// noise on a surface; vertical faces use a y cell dividing STOREY_PITCH (tower periodicity)
float brSurfNoise( vec2 s2, bool horiz, float cell, int P, float cellY, int PY, uint salt ) {
	vec2 cv = horiz ? vec2( cell ) : vec2( cell, cellY );
	ivec2 per = horiz ? ivec2( P ) : ivec2( P, PY );
	return brVNoise( s2 / cv, per, salt + ( horiz ? 0u : 7919u ) );
}

// ---- hashed world features: soft blotches on a world lattice (cell ids periodic)
float brBlotch( vec2 s2, bool horiz, uint salt, float prob, float rmin, float rmax, float edge ) {
	vec2 cell = horiz ? vec2( BR_FEATURE_CELL ) : vec2( BR_FEATURE_CELL, BR_FEATURE_CELL_Y );
	ivec2 P = horiz ? ivec2( BR_FEATURE_P ) : ivec2( BR_FEATURE_P, BR_FEATURE_PY );
	vec2 q = s2 / cell;
	ivec2 qi = ivec2( floor( q ) );
	float acc = 0.0;
	for ( int y = - 1; y <= 1; y ++ ) {
		for ( int x = - 1; x <= 1; x ++ ) {
			ivec2 c = qi + ivec2( x, y );
			uint h = brHash2u( brWrap( c, P ), salt );
			if ( brU01( h ) > prob ) continue;
			vec2 ctr = ( vec2( c ) + vec2( brU01( brPcg( h ) ), brU01( brPcg( h + 1u ) ) ) ) * cell;
			float r = mix( rmin, rmax, brU01( brPcg( h + 2u ) ) );
			vec2 dv = ( s2 - ctr ) * vec2( 1.0, mix( 0.7, 1.3, brU01( brPcg( h + 3u ) ) ) );
			float d = length( dv ) / r;
			acc = max( acc, ( 1.0 - smoothstep( 0.55, 1.0, d + edge ) ) * mix( 0.55, 1.0, brU01( brPcg( h + 4u ) ) ) );
		}
	}
	return acc;
}

// ---- animated Voronoi caustics (2 octaves, world xz in metres; cells divide NOISE_WRAP)
float brCausticLayer( vec2 p, int P, float t, uint salt ) {
	ivec2 qi = ivec2( floor( p ) );
	vec2 fr = p - floor( p );
	float f1 = 8.0;
	float f2 = 8.0;
	for ( int y = - 1; y <= 1; y ++ ) {
		for ( int x = - 1; x <= 1; x ++ ) {
			ivec2 c = qi + ivec2( x, y );
			uint h = brHash2u( brWrap( c, ivec2( P ) ), salt );
			vec2 o = vec2( brU01( h ), brU01( brPcg( h ) ) );
			float ph = brU01( brPcg( h ^ 0x9e3779b9u ) ) * 6.2831853;
			o = 0.5 + 0.38 * sin( vec2( ph, ph * 1.37 ) + t * ( 0.55 + 0.5 * o.yx ) + o * 6.2831853 );
			vec2 d = vec2( x, y ) + o - fr;
			float dd = dot( d, d );
			if ( dd < f1 ) { f2 = f1; f1 = dd; } else if ( dd < f2 ) { f2 = dd; }
		}
	}
	return sqrt( f2 ) - sqrt( f1 );
}
// Filament width (lattice units) w0 + wd for the coarse layer, w0 + 0.04 + wd for the fine one: wd widens them
// with depth (the focus spreads below the focal plane), w0 is the source sharpness (0.26 for the large ceiling
// panels over pool floors, 0.08 for the point-like flashlight, 0.18 above the water). sc scales the cells (1 or 2
// keep the lattice periods integral over NOISE_WRAP; other scales repeat only at the wrap). Mean over the plane:
// brCausticMeanW( w0 + wd ).
float brCausticsW( vec2 xz, float t, float wd, float sc, float w0 ) {
	// domain warp (period 4 lattice units: divides both lattice periods) bends the straight Voronoi edges into the
	// curved filaments of real refraction caustics
	vec2 p1 = xz / ( 0.6 * sc );
	p1 += 0.22 * sin( 1.5707963 * p1.yx + vec2( t * 0.7, t * 0.53 ) );
	vec2 p2 = xz / ( 0.3 * sc ) + 0.37;
	p2 += 0.18 * sin( 1.5707963 * p2.yx + vec2( - t * 0.61, t * 0.83 ) );
	float e1 = brCausticLayer( p1, int( 2048.0 / sc + 0.5 ), t * 0.9, 11u );
	float e2 = brCausticLayer( p2, int( 4096.0 / sc + 0.5 ), t * 1.3, 23u );
	float c1 = pow( 1.0 - smoothstep( 0.0, w0 + wd, e1 ), 1.6 );
	float c2 = pow( 1.0 - smoothstep( 0.0, w0 + 0.04 + wd, e2 ), 1.6 );
	// filaments where both layers focus are much brighter (sum plus a product term)
	return c1 * 0.6 + c2 * 0.35 + c1 * c2 * 0.9;
}
// the pool-floor pattern: depth (m) widens the filaments by 0.5 per metre. Mean ~ brCausticMean( depth ).
float brCaustics( vec2 xz, float t, float depth, float sc ) { return brCausticsW( xz, t, 0.5 * depth, sc, 0.26 ); }
float brCausticMean( float depth ) { return 0.3 + depth * ( 0.63 - 0.07 * depth ); }
// mean of brCausticsW over the plane for a coarse-layer width w (cubic fit of the TS twin within 0.006 on
// w in [0.04, 1.3]: tests/materials/waterOptics.test.ts)
float brCausticMeanW( float w ) { w = clamp( w, 0.04, 1.3 ); return 0.0102 + w * ( 1.0431 + w * ( 0.3895 - 0.3278 * w ) ); }

// ---- package E: the water of a wall-mask cell (bake/volume.ts bakeWallMask: g/a = waterCm + 32768, b = kind + 1).
// c = tile cell (the mask covers the tile and a 1-cell ring); wy = the water surface (storey-relative m, = vBrLocal.y
// units), kind = WaterRect kind (0 pool, 1 flooded, 2 film). False for dry / SOLID cells and outside the mask.
bool brWaterCell( ivec2 c, out float wy, out int kind ) {
	wy = 0.0;
	kind = 0;
	if ( c.x < - 1 || c.y < - 1 || c.x > 16 || c.y > 16 ) return false;
	vec4 m = texelFetch( uVolMask, c + 1, 0 );
	int k = int( m.b * 255.0 + 0.5 );
	if ( k == 0 ) return false;
	wy = ( floor( m.g * 255.0 + 0.5 ) * 256.0 + floor( m.a * 255.0 + 0.5 ) - 32768.0 ) * 0.01;
	kind = k - 1;
	return true;
}

// ---- ordered dither for the fade-in
float brBayer4( vec2 fc ) {
	ivec2 p = ivec2( fc ) & 3;
	int i = p.y * 4 + p.x;
	const float m[ 16 ] = float[ 16 ]( 0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0 );
	return ( m[ i ] + 0.5 ) / 16.0;
}

// ---- flicker channels (D6): channel k = kx + 2 kz; its source tile is our own column/row when the parity
// matches, otherwise the neighbour on the texel's side (R_DYN < TILE_SIZE / 2 makes this unambiguous)
int brSlotOf( int dx, int dz ) { return BR_SLOT_LUT[ ( dx + 1 ) + 3 * ( dz + 1 ) ]; }
int brChannelSlot( int k, vec2 local, vec2 parity ) {
	int kx = k & 1;
	int kz = k >> 1;
	int ox = int( parity.x + 0.5 );
	int oz = int( parity.y + 0.5 );
	int dx = kx == ox ? 0 : ( local.x < BR_HALF_TILE ? - 1 : 1 );
	int dz = kz == oz ? 0 : ( local.y < BR_HALF_TILE ? - 1 : 1 );
	return brSlotOf( dx, dz );
}

// ---- light-volume v coordinate for a storey-relative height (LV.Y levels are not uniform)
float brLvV( float y ) {
	y = clamp( y, BR_LV_Y[ 0 ], BR_LV_Y[ BR_LV_NYI - 1 ] );
	float k = 0.0;
	for ( int i = 0; i < BR_LV_NYI - 1; i ++ ) {
		if ( y >= BR_LV_Y[ i ] ) k = float( i ) + ( y - BR_LV_Y[ i ] ) / ( BR_LV_Y[ i + 1 ] - BR_LV_Y[ i ] );
	}
	return ( min( k, BR_LV_NY - 1.0 ) + 0.5 ) / BR_LV_NY;
}

// ---- lightmap dominant direction decode (w forced to 0 for a degenerate direction)
vec3 brDecodeDir( vec3 enc, inout float w ) {
	vec3 d = enc * 2.0 - 1.0;
	float l = length( d );
	if ( l < 1e-3 ) { w = 0.0; return vec3( 0.0, 1.0, 0.0 ); }
	return d / l;
}

// ---- cotangent frame from view-space position derivatives (precise) and the continuous material uv
mat3 brTangentFrame( vec3 eyePos, vec3 N, vec2 uv ) {
	vec3 q0 = dFdx( eyePos );
	vec3 q1 = dFdy( eyePos );
	vec2 st0 = dFdx( uv );
	vec2 st1 = dFdy( uv );
	vec3 q1perp = cross( q1, N );
	vec3 q0perp = cross( N, q0 );
	vec3 T = q1perp * st0.x + q0perp * st1.x;
	vec3 B = q1perp * st0.y + q0perp * st1.y;
	float det = max( dot( T, T ), dot( B, B ) );
	float scale = det == 0.0 ? 0.0 : inversesqrt( det );
	return mat3( T * scale, B * scale, N );
}

// ---- rough GGX specular (water); dot products pre-saturated
float brGGX( float NdH, float NdV, float NdL, float rough ) {
	float a = rough * rough;
	float a2 = a * a;
	float d = NdH * NdH * ( a2 - 1.0 ) + 1.0;
	float D = a2 / ( BR_PI * d * d );
	float gv = NdL * sqrt( NdV * NdV * ( 1.0 - a2 ) + a2 );
	float gl = NdV * sqrt( NdL * NdL * ( 1.0 - a2 ) + a2 );
	float V = 0.5 / max( gv + gl, 1e-5 );
	return D * V;
}

// ---- emission-map reflection (tile-local): the reflected ray rW (world axes, unit) leaves pLocal and hits the
// horizontal emitter plane y = planeY (tile-local); returns the emitter radiance seen there (0 if rejected).
// rk >= 0: accept only texels whose |key| equals rk (same light region); rk < 0: accept any emitter (props, water).
// Fade: 1 - smoothstep over the last EM_FADE_BAND metres of the reach (see below).
// The glossy lobe (angular radius ~ alpha = rough^2) maps to a footprint stretched along the reflection's horizontal
// direction by 1 / sin(elevation): 4 taps along it at the lateral LOD produce the streaks of wet floors.
// Is there an occluding wall (tile wall mask: bits N1 E2 S4 W8 per cell, 18x18 = the tile + a 1-cell ring) on the
// straight xz segment a -> b (tile-local metres)? Cells outside the mask count as open. At most 10 cell steps.
int brWallBits( ivec2 c ) {
	if ( c.x < - 1 || c.y < - 1 || c.x > 16 || c.y > 16 ) return 0;
	return int( texelFetch( uVolMask, c + 1, 0 ).r * 255.0 + 0.5 );
}
bool brWallBetween( vec2 a, vec2 b ) {
	vec2 ca = a / BR_CELL, cb = b / BR_CELL;
	ivec2 c = ivec2( floor( ca ) ), ce = ivec2( floor( cb ) );
	vec2 d = cb - ca;
	ivec2 st = ivec2( d.x > 0.0 ? 1 : - 1, d.y > 0.0 ? 1 : - 1 );
	vec2 inv = 1.0 / max( abs( d ), vec2( 1e-6 ) );
	vec2 tMax = vec2( ( d.x > 0.0 ? float( c.x ) + 1.0 - ca.x : ca.x - float( c.x ) ) * inv.x,
		( d.y > 0.0 ? float( c.y ) + 1.0 - ca.y : ca.y - float( c.y ) ) * inv.y );
	for ( int i = 0; i < 10; i ++ ) {
		if ( c == ce ) return false;
		int m = brWallBits( c );
		if ( tMax.x < tMax.y ) {
			if ( ( st.x > 0 ? ( m & 2 ) : ( m & 8 ) ) != 0 ) return true;
			c.x += st.x; tMax.x += inv.x;
		} else {
			if ( ( st.y > 0 ? ( m & 4 ) : ( m & 1 ) ) != 0 ) return true;
			c.y += st.y; tMax.y += inv.y;
		}
	}
	return false;
}

// the emission-map reflection: low / medium surfaces and the water shader. High / ultra surface programs (SSR, the
// reflection probe) compile it out with the EMISSION debug view's fetch, freeing uEmission from the 16-unit sampler
// budget (package D, plan-common lead decisions)
#if defined( BR_WATER ) || ( ! defined( BR_SSR ) && ! defined( BR_PROBE ) )
#define BR_EM_REFL
vec3 brEmissionRefl( vec3 pLocal, vec3 rW, float planeY, float rk, float rough, out float fade ) {
	fade = 0.0;
	float h = planeY - pLocal.y;
	if ( rW.y < 0.02 || h < 0.05 ) return vec3( 0.0 );
	float path = h / rW.y;
	vec2 off = rW.xz * path;
	float offLen = length( off );
	// reach: the map covers the tile +- MARGIN, so any hit within MARGIN + (distance from pLocal to the nearest tile
	// line) is inside it. That bound is continuous across tile lines (0 extra on both sides), so reflections never
	// seam at tile borders, yet reach far (long wet-floor streaks) away from them.
	vec2 dB2 = min( pLocal.xz, BR_TILE - pLocal.xz );
	float reach = min( BR_EM_FADE + max( min( dB2.x, dB2.y ), 0.0 ), BR_EM_MAX_REACH );
	fade = 1.0 - smoothstep( reach - BR_EM_FADE_BAND, reach, offLen );
	if ( fade <= 0.0 ) return vec3( 0.0 );
	vec2 hit = pLocal.xz + off;
	const float emSpan = BR_EM_RES * BR_EM_TEXEL;
	vec2 uvE = ( hit + BR_EM_MARGIN ) / emSpan;
	if ( any( lessThan( uvE, vec2( 0.0 ) ) ) || any( greaterThanEqual( uvE, vec2( 1.0 ) ) ) ) { fade = 0.0; return vec3( 0.0 ); }
	ivec2 esz = textureSize( uEmission, 0 );
	float key = texelFetch( uEmission, clamp( ivec2( floor( uvE * vec2( esz ) ) ), ivec2( 0 ), esz - 1 ), 0 ).a;
	bool ok = rk < 0.0 ? abs( key ) > 0.5 : abs( abs( key ) - rk ) < 0.5;
	if ( ! ok || brWallBetween( pLocal.xz, hit ) ) { fade = 0.0; return vec3( 0.0 ); }
	float lobe = max( rough * rough, 0.004 ) * BR_EM_LOBE;
	float cosE = sqrt( max( 1.0 - rW.y * rW.y, 0.0 ) );
	float rLat = path * max( cosE, 0.05 ) * lobe;
	float rLong = min( path * lobe / max( rW.y, 0.05 ), BR_EM_MAX_STREAK );
	// taps span +-0.75 rLong; the mip texel must cover the tap gap or the streak breaks into ghost copies
	const int NT = 6;
	float gap = 1.5 * rLong / float( NT - 1 );
	float lod = max( rough * BR_EM_LOD, log2( max( 2.0 * rLat / BR_EM_TEXEL, 1.0 ) ) );
	lod = max( lod, log2( max( gap / BR_EM_TEXEL, 1.0 ) ) );
	// the emission map (and its GPU mip chain) knows nothing about walls, and light regions merge through doorways:
	// shrink the blur until its footprint around the hit does not reach across a wall, so a rough reflection never
	// pulls in the panels of the room behind it
	for ( int it = 0; it < 3 && lod > 0.5; it ++ ) {
		float rM = 0.5 * exp2( lod ) * BR_EM_TEXEL; // footprint radius, metres
		if ( ! brWallBetween( hit, hit + vec2( rM, 0.0 ) ) && ! brWallBetween( hit, hit - vec2( rM, 0.0 ) ) &&
			! brWallBetween( hit, hit + vec2( 0.0, rM ) ) && ! brWallBetween( hit, hit - vec2( 0.0, rM ) ) ) break;
		lod = max( lod - 1.5, 0.0 );
	}
	vec2 dir = offLen > 1e-4 ? off / offLen : vec2( 0.0 );
	vec3 ec = vec3( 0.0 );
	for ( int i = 0; i < NT; i ++ ) {
		float s = ( float( i ) / float( NT - 1 ) - 0.5 ) * 1.5; // -0.75 .. 0.75
		vec2 uv = clamp( uvE + dir * ( rLong * s / emSpan ), vec2( 0.0 ), vec2( 1.0 ) );
		// every tap must land in the receiver's own light region too: a streak (up to +-2.25 m) that crosses a wall
		// would otherwise reflect the next room's panels onto this floor
		float kt = texelFetch( uEmission, clamp( ivec2( floor( uv * vec2( esz ) ) ), ivec2( 0 ), esz - 1 ), 0 ).a;
		bool okT = rk < 0.0 ? abs( kt ) > 0.5 : abs( abs( kt ) - rk ) < 0.5;
		if ( ! okT || brWallBetween( hit, hit + dir * ( rLong * s ) ) ) continue;
		ec += textureLod( uEmission, uv, lod ).rgb;
	}
	ec = max( ec / float( NT ), vec3( 0.0 ) );
	if ( key < 0.0 ) {
		// dynamic emitter: multiply by the live intensity of the light of the tile containing the hit
		ivec2 td = clamp( ivec2( floor( hit / BR_TILE ) ), ivec2( - 1 ), ivec2( 1 ) );
		ec *= brLuma( uFlick[ brSlotOf( td.x, td.y ) ] );
	}
	return ec;
}
#endif
`;

/** Constants + helpers, injected right after three's `#include <common>` in every fragment shader we own. */
export function fragmentCommon(): string {
  return glslConstants() + '#define BR_LV_NYI int( BR_LV_NY )\n' + GLOBAL_UNIFORMS_GLSL + TILE_UNIFORMS_GLSL + HELPERS_GLSL;
}

/**
 * Haze (D12) + edge fog + optional flashlight airlight. Needs three's lights_pars_begin (getSpotAttenuation,
 * getDistanceAttenuation, spotLights[]) so it is injected after the last pars include.
 * brHazeTerms() is separate so the premultiplied water shader can apply the same maths.
 */
export const HAZE_FUNCS_GLSL = /* glsl */ `
#if defined( BR_AIRLIGHT ) && NUM_SPOT_LIGHTS > 0
${beamSoftGlsl()}
#endif
vec3 brAirlight( vec3 viewPos, float d ) {
#if defined( BR_AIRLIGHT ) && NUM_SPOT_LIGHTS > 0
	SpotLight sl = spotLights[ 0 ];
	if ( dot( sl.color, sl.color ) <= 0.0 || uHazeDensity <= 0.0 ) return vec3( 0.0 );
	vec3 r = viewPos / max( d, 1e-4 );
	float tc = dot( sl.position, r );
	float h = max( sqrt( max( dot( sl.position, sl.position ) - tc * tc, 0.0 ) ), BR_AIR_MIN_H );
	float dmax = d;
	if ( sl.distance > 0.0 ) dmax = min( d, tc + sl.distance );
	// substitute t = tc + h tan(th): the inverse-square integrand becomes uniform in th
	float a0 = atan( - tc / h );
	float a1 = atan( ( dmax - tc ) / h );
	if ( a1 <= a0 ) return vec3( 0.0 );
	float acc = 0.0;
	for ( int i = 0; i < BR_AIR_STEPS; i ++ ) {
		float th = mix( a0, a1, ( float( i ) + 0.5 ) / float( BR_AIR_STEPS ) );
		vec3 p = r * ( tc + h * tan( th ) );
		vec3 L = sl.position - p;
		float ld = max( length( L ), 1e-3 );
		// the beam's angular profile (the smooth twin of the cookie, whose rim is the cone: 6 samples cannot resolve the
		// die image)
		float att = brBeamSoft( dot( L / ld, sl.direction ) );
		att *= getDistanceAttenuation( ld, sl.distance, sl.decay ) * ld * ld; // keep only the range window
		acc += att;
	}
	float integral = acc * ( a1 - a0 ) / ( float( BR_AIR_STEPS ) * h );
	return sl.color * integral * uHazeDensity * uHazeAlbedo * uHazeTint * ( BR_AIR_GAIN / ( 4.0 * BR_PI ) );
#else
	return vec3( 0.0 );
#endif
}
void brHazeTerms( vec3 irrLocal, float d, out float fh, out vec3 insc, out float fe ) {
	fh = 1.0 - exp( - uHazeDensity * d );
	insc = mix( uFarColor, irrLocal * uHazeAlbedo / BR_PI * uHazeTint, 0.5 );
	fe = smoothstep( uEdgeFog.x, uEdgeFog.y, d );
}
// transmittance of the haze and edge fog between the camera and viewPos (the MRT specular write, water); package F
// replaces the body with the froxel volume's when BR_VOLUMETRIC is on
float brHazeT( vec3 viewPos ) {
	float fh; vec3 insc; float fe;
	brHazeTerms( vec3( 0.0 ), length( viewPos ), fh, insc, fe );
	return ( 1.0 - fh ) * ( 1.0 - fe );
}
vec3 brHaze( vec3 col, vec3 irrLocal, vec3 viewPos ) {
	float d = length( viewPos );
	float fh; vec3 insc; float fe;
	brHazeTerms( irrLocal, d, fh, insc, fe );
	col = mix( col, insc, fh ) + brAirlight( viewPos, d );
	return mix( col, uFarColor, fe );
}
`;
