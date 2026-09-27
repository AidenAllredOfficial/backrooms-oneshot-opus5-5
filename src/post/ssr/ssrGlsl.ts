// src/post/ssr/ssrGlsl.ts — package D: the shader code of the screen-space reflections (post/ssr/SsrTrace.ts,
// post/ssr/HiZ.ts, post/frame/MrtComposite.ts) and their CPU twins (tests/post/ssr.test.ts).
//
// - SSR_TRACE_GLSL is self-contained apart from two uniforms every user declares under the same names (the surface /
//   water programs get them from chunks/common.ts): uHiZ (the min device-depth pyramid) and uHiZInfo. brSsrTrace()
//   takes the camera projection as a parameter, so the water shader (package E) can trace non-mirrored planes with
//   three's projectionMatrix.
// - Hi-Z layout: level 0 is half the full resolution, texel i covering full-resolution pixels 2i and 2i+1; the mips are
//   floor-halved (three allocates `width >> level`), and the last texel of a level also covers the odd remainder of the
//   level below it, so a lookup clamped to the level's size is conservative. uHiZInfo = (W / 2, H / 2, levels built,
//   1 while valid this frame): positions are traced in level-0 cells (uv x uHiZInfo.xy).

import { TUNE } from '../../materials/chunks/params.ts';
import { HDR_CLAMP } from '../../core/constants.ts';

const f = (x: number): string => (Number.isInteger(x) ? x.toFixed(1) : String(x));

/** Tuning of the reflections (TS twins below and tests use the same numbers). */
export const SSR = {
  /** m: rays end here and fade over the last quarter */
  MAX_DIST: 60,
  /** a hit lies at most THICK + THICK_Z x depth (m) behind the depth buffer */
  THICK: 0.15,
  THICK_Z: 0.04,
  /** share of the thickness over which a hit fades out (soft silhouettes of reflected objects) */
  THICK_SOFT: 0.4,
  /** hits closer than this uv share to the screen border fade out */
  EDGE_FADE: 0.07,
  /** rays toward the camera (view R.z) fade out between these */
  RZ_FADE0: 0.25,
  RZ_FADE1: 0.7,
  /** the hit surface must face the ray: dot(N_hit, R) below this */
  FACING: 0.2,
  /** glossy cone: tan = CONE x alpha (alpha = roughness^2; GGX's median half-vector angle doubled for the reflected
   * ray, trimmed for perceived sharpness) */
  CONE: 1.5,
  /** the footprint stretches along the screen-projected normal by 1 / max(N.V, STRETCH_NV) up to STRETCH_MAX: the
   * vertical light streaks of glossy floors */
  STRETCH_NV: 0.15,
  STRETCH_MAX: 4,
  /** rays toward the camera: a linear march of LIN_STEPS steps growing from 1 to LIN_STRIDE level-0 cells, then
   * BISECT bisections */
  LIN_STEPS: 24,
  LIN_STRIDE: 16,
  BISECT: 5,
  /** receding rays give up after this many consecutive level-0 cells behind a thick occluder (a miss either way) */
  BEHIND_MAX: 10,
  /** Hi-Z levels built (the full chain is allocated for texture completeness) */
  HIZ_LEVELS: 8,
  /** anisotropic filtering of the colour pyramid (the streak lookups use textureGrad) */
  PYR_ANISO: 8,
  /** ultra's bilateral filter: radius = rough x FILTER_R (half-res texels, at most 2); mirrors below FILTER_ROUGH stay
   * unfiltered */
  FILTER_R: 6,
  FILTER_ROUGH: 0.12,
  FILTER_Z: 0.05,
  FILTER_NPOW: 16,
  /** full-resolution upsample in the composite: depth (relative), normal power, roughness */
  UP_Z: 0.03,
  UP_NPOW: 8,
  UP_ROUGH: 8,
  /** G-buffer eligibility (chunks/lighting.ts): surfaces below this roughness write their replaceable specular */
  ELIG_ROUGH: 0.7,
  /** horizon occlusion of the reflected direction against the unperturbed normal (squared falloff) */
  HORIZON_K: 1.1,
} as const;

/** Debug output of the composite (URL reflView): 0 off, 1 the reflection alone, 2 confidence (misses magenta). */
export const REFL_DEBUG = { off: 0, ssr: 1, conf: 2 } as const;

/** Octahedral unit-vector decode (chunks/gbuffer.ts OCT_GLSL twin; post passes do not include the surface chunks). */
export const SSR_OCT_GLSL = /* glsl */ `
vec3 brOctDec( vec2 e ) {
	vec3 n = vec3( e, 1.0 - abs( e.x ) - abs( e.y ) );
	if ( n.z < 0.0 ) n.xy = ( 1.0 - abs( n.yx ) ) * vec2( n.x >= 0.0 ? 1.0 : -1.0, n.y >= 0.0 ? 1.0 : -1.0 );
	return normalize( n );
}
`;

/**
 * The Hi-Z ray trace. Needs `uniform sampler2D uHiZ; uniform vec4 uHiZInfo;` declared before it. Optional:
 * `#define BR_SSR_DEPTH_AT( px )` = the full-resolution device depth of pixel px (ivec2); hits are then validated
 * against it instead of the 2x2 minimum (post pass). BR_SSR_STEPS bounds the Hi-Z loop (default 32).
 *
 * brSsrTrace( P, R, proj, maxDist, hitUv, hitZ, hitGap, rayT ): P = view-space origin, R = unit view-space direction.
 * On a hit returns true with hitUv (screen uv), hitZ (the scene's linear view depth there), hitGap (how far the ray
 * lies behind the depth buffer, as a share of the accepted thickness: 0..1) and rayT (distance / maxDist).
 * Receding rays (away from the camera) use the min-pyramid traversal (Uludag, GPU Pro 5): coarse cells the ray
 * passes in front of are skipped whole. Rays toward the camera use a linear march with growing strides and a
 * bisection.
 */
export const SSR_TRACE_GLSL = /* glsl */ `
#ifndef BR_SSR_TRACE_GLSL
#define BR_SSR_TRACE_GLSL
#ifndef BR_SSR_STEPS
#define BR_SSR_STEPS 32
#endif
#define BR_SSR_THICK ${f(SSR.THICK)}
#define BR_SSR_THICK_Z ${f(SSR.THICK_Z)}
#define BR_SSR_LIN_STEPS ${SSR.LIN_STEPS}
#define BR_SSR_LIN_STRIDE ${f(SSR.LIN_STRIDE)}
#define BR_SSR_BISECT ${SSR.BISECT}
#define BR_SSR_BEHIND_MAX ${SSR.BEHIND_MAX}
// linear view depth (positive metres) of window depth d under projection proj
float brSsrLinZ( float d, mat4 proj ) { return proj[ 3 ][ 2 ] / ( ( d * 2.0 - 1.0 ) + proj[ 2 ][ 2 ] ); }
// min device depth of Hi-Z cell c at level lvl (clamped: the last texel covers the remainder); hz0 = level-0 size
float brSsrHiZ( ivec2 c, int lvl, ivec2 hz0 ) {
	ivec2 sz = max( hz0 >> lvl, ivec2( 1 ) );
	return texelFetch( uHiZ, clamp( c, ivec2( 0 ), sz - 1 ), lvl ).r;
}
// device depth the ray is compared against at level-0 position q (cells): the full-resolution pixel when available
float brSsrSceneD( vec2 q, ivec2 hz0 ) {
#ifdef BR_SSR_DEPTH_AT
	return BR_SSR_DEPTH_AT( ivec2( q * 2.0 ) );
#else
	return brSsrHiZ( ivec2( q ), 0, hz0 );
#endif
}
// the ray at o + d t is at or behind the depth buffer: within the thickness? (gap = share of the allowed thickness)
bool brSsrAccept( vec3 p, mat4 proj, ivec2 hz0, out float zs, out float gap ) {
	zs = brSsrLinZ( brSsrSceneD( p.xy, hz0 ), proj );
	float zr = brSsrLinZ( p.z, proj );
	gap = ( zr - zs ) / ( BR_SSR_THICK + BR_SSR_THICK_Z * zs );
	return gap >= 0.0 && gap < 1.0;
}
bool brSsrTrace( vec3 P, vec3 R, mat4 proj, float maxDist, out vec2 hitUv, out float hitZ, out float hitGap, out float rayT ) {
	hitUv = vec2( 0.0 );
	hitZ = 0.0;
	hitGap = 0.0;
	rayT = 1.0;
	if ( uHiZInfo.w < 0.5 ) return false;
	// the ray ends in front of the near plane
	float near = proj[ 3 ][ 2 ] / ( proj[ 2 ][ 2 ] - 1.0 );
	float L = maxDist;
	if ( R.z > 1e-5 ) L = min( L, ( - near * 1.02 - P.z ) / R.z );
	if ( L <= 1e-3 ) return false;
	vec4 c0 = proj * vec4( P, 1.0 );
	vec4 c1 = proj * vec4( P + R * L, 1.0 );
	vec2 cells = uHiZInfo.xy;
	vec3 o = vec3( ( c0.xy / c0.w * 0.5 + 0.5 ) * cells, c0.z / c0.w * 0.5 + 0.5 );
	vec3 e = vec3( ( c1.xy / c1.w * 0.5 + 0.5 ) * cells, c1.z / c1.w * 0.5 + 0.5 );
	vec3 d = e - o;
	vec2 dxy = vec2( abs( d.x ) < 1e-5 ? 1e-5 : d.x, abs( d.y ) < 1e-5 ? 1e-5 : d.y );
	vec2 sgn = sign( dxy );
	vec2 brX = step( 0.0, dxy ); // 1 on axes the ray advances along +
	// the ray's screen extent: t in [0, tMax] stays inside the viewport
	vec2 tb = ( brX * cells - o.xy ) / dxy;
	float tMax = min( 1.0, min( tb.x, tb.y ) );
	// leave the origin's own level-0 cell first (the reflector's depth must not stop the ray)
	vec2 cl0 = floor( o.xy + sgn * 1e-3 );
	vec2 te = ( cl0 + brX - o.xy ) / dxy;
	float t = min( te.x, te.y ) + 1e-4;
	if ( t >= tMax ) return false;
	float zs, gap;
	ivec2 hz0 = textureSize( uHiZ, 0 );
	if ( d.z > 0.0 ) {
		// receding: min-pyramid traversal
		int maxLvl = min( int( uHiZInfo.z ) - 1, 7 );
		int lvl = 0;
		float cs = 1.0; // cell size at lvl, level-0 cells
		int behind = 0;
		for ( int i = 0; i < BR_SSR_STEPS; i ++ ) {
			vec2 q = o.xy + dxy * t;
			vec2 cell = floor( q / cs + sgn * 1e-3 );
			float zmin = brSsrHiZ( ivec2( cell ), lvl, hz0 );
			vec2 tc = ( ( cell + brX ) * cs - o.xy ) / dxy;
			float tExit = min( tc.x, tc.y );
			float tz = ( zmin - o.z ) / d.z; // where the ray reaches the cell's closest depth
			if ( tz > tExit ) {
				// in front of everything in the cell: skip it, try coarser cells
				t = tExit + 1e-5;
				if ( lvl < maxLvl ) { lvl ++; cs *= 2.0; }
				behind = 0;
			} else if ( lvl > 0 ) {
				t = max( t, tz );
				lvl --;
				cs *= 0.5;
			} else {
				t = max( t, tz );
				if ( t > tMax ) break;
				vec3 p = o + d * t;
				if ( brSsrSceneD( p.xy, hz0 ) <= p.z ) {
					if ( brSsrAccept( p, proj, hz0, zs, gap ) ) {
						hitUv = p.xy / cells;
						hitZ = zs;
						hitGap = gap;
						rayT = t * L / maxDist;
						return true;
					}
					// passing behind a thick occluder: what the ray meets there is not on screen
					if ( ++ behind >= BR_SSR_BEHIND_MAX ) return false;
				}
				t = tExit + 1e-5;
			}
			if ( t > tMax ) break;
		}
		return false;
	}
	// toward the camera: linear march in level-0 cells (strides growing 1 -> BR_SSR_LIN_STRIDE), then bisection
	float dtCell = 1.0 / max( max( abs( d.x ), abs( d.y ) ), 1e-6 );
	float tPrev = t;
	for ( int i = 0; i < BR_SSR_LIN_STEPS; i ++ ) {
		vec3 p = o + d * t;
		if ( brSsrSceneD( p.xy, hz0 ) <= p.z ) {
			float lo = tPrev, hi = t;
			for ( int k = 0; k < BR_SSR_BISECT; k ++ ) {
				float mid = 0.5 * ( lo + hi );
				vec3 pm = o + d * mid;
				if ( brSsrSceneD( pm.xy, hz0 ) <= pm.z ) hi = mid; else lo = mid;
			}
			p = o + d * hi;
			if ( brSsrAccept( p, proj, hz0, zs, gap ) ) {
				hitUv = p.xy / cells;
				hitZ = zs;
				hitGap = gap;
				rayT = hi * L / maxDist;
				return true;
			}
		}
		if ( t >= tMax ) break;
		tPrev = t;
		t = min( t + mix( 1.0, BR_SSR_LIN_STRIDE, float( i ) / float( BR_SSR_LIN_STEPS - 1 ) ) * dtCell, tMax );
	}
	return false;
}
#endif
`;

/** Hi-Z build: level 0 from the full-resolution depth (uLevel 0), level k from the Hi-Z's level k - 1. Each texel
 * is the min of its 2x2 source texels, plus the odd remainder row / column on a level's last texel. */
export const HIZ_FRAG = /* glsl */ `
precision highp float;
precision highp int;
uniform highp sampler2D tSrc;
uniform int uLevel;       // source mip level
uniform ivec2 uSrcSize;   // source level size
uniform ivec2 uDstSize;   // size of the level being built
layout( location = 0 ) out highp vec4 outZ;
void main() {
	ivec2 t = ivec2( gl_FragCoord.xy );
	ivec2 s0 = t * 2;
	ivec2 last = uSrcSize - 1;
	ivec2 n = ivec2( 2 );
	if ( t.x == uDstSize.x - 1 ) n.x = clamp( uSrcSize.x - s0.x, 1, 3 );
	if ( t.y == uDstSize.y - 1 ) n.y = clamp( uSrcSize.y - s0.y, 1, 3 );
	float z = 1.0;
	for ( int y = 0; y < 3; y ++ ) {
		if ( y >= n.y ) break;
		for ( int x = 0; x < 3; x ++ ) {
			if ( x >= n.x ) break;
			z = min( z, texelFetch( tSrc, min( s0 + ivec2( x, y ), last ), uLevel ).x );
		}
	}
	outZ = vec4( z, 0.0, 0.0, 1.0 );
}
`;

/** The half-resolution trace (one ray per 2x2 block, from its top-left pixel like the SSAO). MRT: location 0 =
 * premultiplied reflected radiance x confidence (rgb), confidence (a); location 1 = the representative pixel's
 * metadata for the filter and the upsample: linear view depth, oct view normal, lobe roughness (0 where the pixel has
 * no G-buffer specular). */
export const SSR_TRACE_FRAG = /* glsl */ `
precision highp float;
precision highp int;
uniform highp sampler2D tDepth;   // full-resolution device depth
uniform highp sampler2D tSpec;    // G-buffer att1: fallback specular x T (rgb), Ws x T (a)
uniform highp sampler2D tGNR;     // G-buffer att2: oct view normal (rg), lobe roughness (b), 1 where written (a)
uniform highp sampler2D tPyr;     // colour pyramid (opaque HDR before reflections)
uniform highp sampler2D tAo;      // pre-shade SSAO (ba = oct view normal of the depth; this frame when uAoP.x = 1)
uniform vec2 uAoP;                // x SSAO valid, y its texel step (full-resolution pixels)
uniform highp sampler2D uHiZ;
uniform vec4 uHiZInfo;
uniform mat4 uProj;
uniform mat4 uProjInv;
uniform vec2 uFull;               // full-resolution size (px)
uniform vec2 uPyrSize;            // pyramid level-0 size (px)
uniform float uMaxRough;
layout( location = 0 ) out highp vec4 outSsr;
layout( location = 1 ) out highp vec4 outMeta;
#define BR_SSR_DEPTH_AT( px ) texelFetch( tDepth, clamp( px, ivec2( 0 ), ivec2( uFull ) - 1 ), 0 ).x
#define BR_SSR_MAX_DIST ${f(SSR.MAX_DIST)}
#define BR_SSR_EDGE ${f(SSR.EDGE_FADE)}
#define BR_SSR_RZ0 ${f(SSR.RZ_FADE0)}
#define BR_SSR_RZ1 ${f(SSR.RZ_FADE1)}
#define BR_SSR_FACING ${f(SSR.FACING)}
#define BR_SSR_CONE ${f(SSR.CONE)}
#define BR_SSR_NV ${f(SSR.STRETCH_NV)}
#define BR_SSR_STRETCH ${f(SSR.STRETCH_MAX)}
#define BR_SSR_SOFT ${f(SSR.THICK_SOFT)}
#define BR_HDR_CLAMP ${f(HDR_CLAMP)}
${SSR_OCT_GLSL}
${SSR_TRACE_GLSL}
// view-space position of window depth d at full-resolution uv (perspective)
vec3 brViewPos( float d, vec2 uv ) {
	vec4 v = uProjInv * vec4( uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0 );
	return v.xyz / v.w;
}
vec3 brPixPos( ivec2 px ) {
	ivec2 q = clamp( px, ivec2( 0 ), ivec2( uFull ) - 1 );
	return brViewPos( texelFetch( tDepth, q, 0 ).x, ( vec2( q ) + 0.5 ) / uFull );
}
// view normal of the depth buffer at pixel px (att2 exists only on glossy pixels, so the hit surface's normal comes
// from its depth): the SSAO's (the same best-side derivative, one fetch) when it ran this frame, else 5 depth taps
vec3 brDepthNormal( ivec2 px ) {
	if ( uAoP.x > 0.5 ) return brOctDec( texelFetch( tAo, px / int( uAoP.y ), 0 ).ba );
	vec3 c = brPixPos( px );
	vec3 l = brPixPos( px - ivec2( 1, 0 ) ), r = brPixPos( px + ivec2( 1, 0 ) );
	vec3 b = brPixPos( px - ivec2( 0, 1 ) ), u = brPixPos( px + ivec2( 0, 1 ) );
	vec3 dx = abs( c.z - l.z ) < abs( r.z - c.z ) ? c - l : r - c;
	vec3 dy = abs( c.z - b.z ) < abs( u.z - c.z ) ? c - b : u - c;
	return normalize( cross( dx, dy ) );
}
// full-resolution pixel coordinates of view point v
vec2 brProjPx( vec3 v ) {
	vec4 c = uProj * vec4( v, 1.0 );
	return ( c.xy / c.w * 0.5 + 0.5 ) * uFull;
}
void main() {
	outSsr = vec4( 0.0 );
	outMeta = vec4( 0.0 );
	ivec2 p = min( ivec2( gl_FragCoord.xy ) * 2, ivec2( uFull ) - 1 );
	vec4 s1 = texelFetch( tSpec, p, 0 );
	vec4 g = texelFetch( tGNR, p, 0 );
	if ( s1.a < 1e-4 || g.a < 0.5 ) return;
	float rough = g.b;
	float d = texelFetch( tDepth, p, 0 ).x;
	vec3 P = brViewPos( d, ( vec2( p ) + 0.5 ) / uFull );
	outMeta = vec4( - P.z, g.rg, rough );
	if ( rough > uMaxRough ) return;
	vec3 N = brOctDec( g.rg );
	vec3 V = - normalize( P );
	float nv = dot( N, V );
	if ( nv < 0.01 ) return;
	vec3 R = reflect( - V, N );
	vec2 hitUv;
	float hitZ, hitGap, rayT;
	// start just off the surface: its own depth must not stop the ray
	if ( ! brSsrTrace( P + N * ( 0.002 * - P.z ), R, uProj, BR_SSR_MAX_DIST, hitUv, hitZ, hitGap, rayT ) ) return;
	ivec2 hp = ivec2( hitUv * uFull );
	if ( dot( brDepthNormal( hp ), R ) > BR_SSR_FACING ) return; // the back of a surface: not what the ray sees
	// the glossy lobe as a cone (tan = CONE alpha) over the ray length, measured in pyramid texels at the hit, stretched
	// along the screen-projected normal (grazing views of floors: the vertical streaks of lamps)
	vec3 Ph = brViewPos( 1.0, hitUv );
	Ph *= hitZ / - Ph.z;
	float a = rough * rough;
	float D = max( 2.0 * BR_SSR_CONE * a * length( Ph - P ) * 0.5 * uPyrSize.y * uProj[ 1 ][ 1 ] / hitZ, 1e-3 );
	vec2 nS = brProjPx( P + N * ( 0.01 * - P.z ) ) - brProjPx( P );
	nS = dot( nS, nS ) > 1e-10 ? normalize( nS ) : vec2( 0.0, 1.0 );
	float s = clamp( 1.0 / max( nv, BR_SSR_NV ), 1.0, BR_SSR_STRETCH );
	vec3 col = textureGrad( tPyr, hitUv, nS * ( D * s ) / uPyrSize, vec2( - nS.y, nS.x ) * D / uPyrSize ).rgb;
	// confidence: screen border, roughness cut-off, ray length, rays toward the camera, thickness
	vec2 eb = min( hitUv, 1.0 - hitUv ) / BR_SSR_EDGE;
	float conf = clamp( min( eb.x, eb.y ), 0.0, 1.0 );
	conf *= 1.0 - smoothstep( uMaxRough - 0.1, uMaxRough, rough );
	conf *= 1.0 - smoothstep( 0.75, 1.0, rayT );
	conf *= 1.0 - smoothstep( BR_SSR_RZ0, BR_SSR_RZ1, R.z );
	conf *= 1.0 - smoothstep( 1.0 - BR_SSR_SOFT, 1.0, hitGap );
	outSsr = vec4( min( max( col, vec3( 0.0 ) ), vec3( BR_HDR_CLAMP ) ) * conf, conf );
}
`;

/** Ultra: one 3x3 bilateral pass over the half-resolution result (premultiplied, so misses fade the confidence
 * smoothly); taps r = rough x FILTER_R texels apart (rounded, at most 2), none below FILTER_ROUGH: mirrors stay
 * sharp. Weights: Gaussian x depth x normal^FILTER_NPOW, from the trace's metadata. */
export const SSR_FILTER_FRAG = /* glsl */ `
precision highp float;
precision highp int;
uniform highp sampler2D tSsr;
uniform highp sampler2D tMeta;
layout( location = 0 ) out highp vec4 outSsr;
${SSR_OCT_GLSL}
void main() {
	ivec2 t = ivec2( gl_FragCoord.xy );
	vec4 c = texelFetch( tSsr, t, 0 );
	outSsr = c;
	vec4 m = texelFetch( tMeta, t, 0 );
	int r = int( floor( clamp( m.w * ${f(SSR.FILTER_R)}, 0.0, 2.0 ) + 0.5 ) );
	if ( m.x <= 0.0 || m.w <= ${f(SSR.FILTER_ROUGH)} || r == 0 ) return;
	ivec2 sz = textureSize( tSsr, 0 ) - 1;
	vec3 Nc = brOctDec( m.yz );
	vec4 acc = c;
	float ws = 1.0;
	for ( int j = - 1; j <= 1; j ++ ) {
		for ( int i = - 1; i <= 1; i ++ ) {
			if ( i == 0 && j == 0 ) continue;
			ivec2 q = clamp( t + ivec2( i, j ) * r, ivec2( 0 ), sz );
			vec4 mq = texelFetch( tMeta, q, 0 );
			if ( mq.x <= 0.0 ) continue;
			float w = exp( - 0.5 * float( i * i + j * j ) ) * exp( - abs( mq.x - m.x ) / ( ${f(SSR.FILTER_Z)} * m.x ) )
				* pow( max( dot( Nc, brOctDec( mq.yz ) ), 0.0 ), ${f(SSR.FILTER_NPOW)} );
			acc += w * texelFetch( tSsr, q, 0 );
			ws += w;
		}
	}
	outSsr = acc / ws;
}
`;

/** Composite pieces (post/frame/MrtComposite.ts): declarations and the specular term of an MRT frame. With the SSR
 * off (uSsrP.x = 0) or where Ws is 0 the term is exactly the fallback att1.rgb. Otherwise the 4 half-resolution
 * texels around the pixel are weighted bilinear x depth x normal^UP_NPOW x roughness (from the trace's metadata:
 * texels whose representative pixel has no G-buffer specular do not count), and the reflection replaces the
 * fallback by its confidence:
 *   spec = mix( s1.rgb, s1.a x ssr.rgb / ssr.a, ssr.a ). */
export const SSR_COMPOSITE_PARS = /* glsl */ `
uniform highp sampler2D tSsr;     // half-resolution premultiplied reflection (a = confidence)
uniform highp sampler2D tMeta;    // half-resolution metadata: linear depth, oct view normal, roughness
uniform highp sampler2D tDepth;   // full-resolution device depth of the MRT frame
uniform vec4 uSsrP;               // x on, y debug view (REFL_DEBUG)
uniform vec3 uLin;                // near x far, far - near, far
#define BR_HDR_CLAMP ${f(HDR_CLAMP)}
#define BR_DEBUG_NITS ${f(TUNE.DEBUG_NITS)}
${SSR_OCT_GLSL}
float brLinZ( float d ) { return uLin.x / ( uLin.z - d * uLin.y ); }
`;

/** Inside main() after `vec4 s1` (att1 at pixel p): sets `vec3 spec` and `vec4 ssr` (the upsampled reflection). */
export const SSR_COMPOSITE_SPECULAR = /* glsl */ `
	vec3 spec = s1.rgb;
	vec4 ssr = vec4( 0.0 );
	if ( uSsrP.x > 0.5 && s1.a > 0.0 ) {
		vec4 g = texelFetch( tN2, p, 0 );
		vec3 Np = brOctDec( g.rg );
		float zp = brLinZ( texelFetch( tDepth, p, 0 ).x );
		ivec2 hs = textureSize( tSsr, 0 ) - 1;
		// texel t represents pixel 2t: pixel p sits at p / 2 in texel units
		vec2 tf = vec2( p ) * 0.5;
		ivec2 t0 = ivec2( floor( tf ) );
		vec2 fr = tf - vec2( t0 );
		vec4 acc = vec4( 0.0 );
		float ws = 0.0;
		for ( int j = 0; j < 2; j ++ ) {
			for ( int i = 0; i < 2; i ++ ) {
				ivec2 t = min( t0 + ivec2( i, j ), hs );
				vec4 mq = texelFetch( tMeta, t, 0 );
				float bil = ( i == 0 ? 1.0 - fr.x : fr.x ) * ( j == 0 ? 1.0 - fr.y : fr.y ) + 0.01;
				float w = mq.x > 0.0 ? bil * exp( - abs( zp - mq.x ) / ( ${f(SSR.UP_Z)} * zp ) )
					* pow( max( dot( Np, brOctDec( mq.yz ) ), 0.0 ), ${f(SSR.UP_NPOW)} ) * exp( - ${f(SSR.UP_ROUGH)} * abs( g.b - mq.w ) ) : 0.0;
				acc += w * texelFetch( tSsr, t, 0 );
				ws += w;
			}
		}
		if ( ws > 1e-3 ) ssr = acc / ws;
		spec = mix( s1.rgb, s1.a * ssr.rgb / max( ssr.a, 1e-4 ), ssr.a );
	}
`;

/** Inside main() after the output colour `outc`: the reflView debug outputs. */
export const SSR_COMPOSITE_DEBUG = /* glsl */ `
	int brDbg = int( uSsrP.y + 0.5 );
	if ( brDbg == ${REFL_DEBUG.ssr} ) outc = ssr.rgb;
	else if ( brDbg == ${REFL_DEBUG.conf} ) outc = ( s1.a > 0.0 && ssr.a <= 0.0 ? vec3( 1.0, 0.0, 1.0 ) : vec3( ssr.a ) ) * BR_DEBUG_NITS;
`;

// ---------------------------------------------------------------- CPU twins (tests/post/ssr.test.ts)

/** Level sizes of the Hi-Z for a w x h full-resolution frame: level 0 = ceil(w/2) x ceil(h/2), then floor-halved (as
 * three allocates mips); `levels` = the full chain, `built` = min(levels, HIZ_LEVELS). */
export function hiZLayout(w: number, h: number): { sizes: [number, number][]; levels: number; built: number } {
  const w0 = Math.max(1, Math.ceil(w / 2)), h0 = Math.max(1, Math.ceil(h / 2));
  const levels = Math.floor(Math.log2(Math.max(w0, h0))) + 1;
  const sizes: [number, number][] = [];
  for (let k = 0; k < levels; k++) sizes.push([Math.max(1, w0 >> k), Math.max(1, h0 >> k)]);
  return { sizes, levels, built: Math.min(levels, SSR.HIZ_LEVELS) };
}

/** The source texels (per axis) texel t of a level of size dst covers in a source level of size src. */
export function hiZSpan(t: number, dst: number, src: number): number[] {
  const s0 = 2 * t;
  const n = t === dst - 1 ? Math.min(3, Math.max(1, src - s0)) : 2;
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(Math.min(s0 + i, src - 1));
  return out;
}

/** Footprint diameter (pyramid texels) of the glossy cone at the hit and its mip LOD (the isotropic part of the
 * textureGrad lookup): pxPerRad = 0.5 x pyramid height x proj[1][1]. */
export function coneLod(rough: number, rayLen: number, hitZ: number, pxPerRad: number): { diameter: number; lod: number } {
  const a = rough * rough;
  const diameter = Math.max((2 * SSR.CONE * a * rayLen * pxPerRad) / Math.max(hitZ, 1e-6), 1e-3);
  return { diameter, lod: Math.max(0, Math.log2(diameter)) };
}

/** The composite's specular term: fallback s1 (rgb, a = Ws), upsampled reflection ssr (premultiplied, a = conf). */
export function compositeSpecular(s1: readonly [number, number, number, number], ssr: readonly [number, number, number, number]): [number, number, number] {
  if (s1[3] <= 0 || ssr[3] <= 0) return [s1[0], s1[1], s1[2]];
  const c = ssr[3];
  const out: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < 3; i++) out[i] = s1[i] * (1 - c) + c * (s1[3] * ssr[i] / Math.max(c, 1e-4));
  return out;
}
