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
  /** the lobe's spread out of the plane of incidence is the cone's x N.V (a half-vector tilt d out of that plane turns
   * the reflected ray by 2 d N.V, one inside it by 2 d): the vertical light streaks of glossy floors. N.V is floored
   * at NV_MIN */
  NV_MIN: 0.05,
  /** the lobe's edge rays meet the hit's plane at LEN_MIN..LEN_MAX x the central ray's length (a plane seen edge-on
   * along the lobe) */
  LEN_MIN: 0.25,
  LEN_MAX: 4,
  /** GGX's heavy tail: a second lookup with the microfacet part of the cone TAIL_K x wider, mixed in at TAIL_W. The
   * cone alone (a Gaussian-like lookup of sd about 1.3 x its tan) holds the lobe's core; a tube lamp over a glossy
   * floor (roughness 0.16-0.25, 1600x the ceiling's radiance) integrated with GGX keeps a visible streak about twice
   * as long, which 0.85 core + 0.15 tail at 4x matches within ~30 % along the streak */
  TAIL_K: 4,
  TAIL_W: 0.15,
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
  /** the resolve (SSR_RESOLVE_FRAG): each texel also gathers its neighbours' rays over the lobe's spread seen from the
   * camera through the mirror (the angle x L0 / (|P| + L0), along the plane of incidence's screen direction and x N.V
   * across it), a Gaussian of sd RESOLVE_K x RESOLVE_SD x the cone's tan (GGX's in-plane half width at half maximum
   * is about the cone's 1.5 alpha: sd = tan / 1.18). One ray per texel read through its footprint on the hit plane
   * cannot see what lies off that plane: a lamp fixture hanging below a lit ceiling grid, a partition, a lamp's own
   * ribbed lens. Where the ray hit or missed such a thing the lookup flipped from texel to texel (a terrazzo floor drew
   * the lamp as a lit rectangle with a dashed dark line through it and a dotted tail of the grid beside it); a
   * supersampled GGX reference shows a smooth glow. Neighbouring rays are samples of nearby directions of the same
   * lobe: gathering them averages what each one saw. The lookup keeps the whole cone: against a 1536-ray GGX
   * reference of 15 framings, the full cone plus RESOLVE_K 0.7 came closest (splitting the cone between lookup and
   * resolve left the lookups sharper and PARKING's painted roll-up door headers brighter than the reference) */
  RESOLVE_K: 0.7,
  RESOLVE_SD: 0.85,
  /** trace texels: the resolve's sd cap; kernels below RESOLVE_MIN (mirrors, contact reflections) are copied */
  RESOLVE_MAX: 16,
  RESOLVE_MIN: 0.35,
  /** resolve weights: distance to the texel's macro plane (x its depth), roughness. The plane is the trace's macro
   * normal Nm, not the block's: a corrugated deck's rib flanks lie on one plane, and weighing their block normals kept
   * each texel to its own flank, a rib-periodic subset of the taps that drew the roof glints as a checkered grid */
  RESOLVE_PLANE: 0.01,
  RESOLVE_ROUGH: 8,
  /** taps on the resolve's Vogel disc (radius 2 sd): ultra (ssrFilter) and high */
  RESOLVE_TAPS: [8, 6] as const,
  /** full-resolution upsample in the composite: depth (relative), normal power, roughness */
  UP_Z: 0.03,
  UP_NPOW: 8,
  UP_ROUGH: 8,
  /** G-buffer eligibility (chunks/lighting.ts): surfaces below this roughness write their replaceable specular */
  ELIG_ROUGH: 0.7,
  /** horizon occlusion of the reflected direction against the unperturbed normal (squared falloff) */
  HORIZON_K: 1.1,
  /** the trace: rays whose cosine to the depth's macro normal is below this fade out (0 and below: not traced; a
   * grazing view of a floor still reflects at 0.03) */
  UP_FADE: 0.03,
  /** the trace follows the macro (depth) normal instead of the block's mean normal as 1 - |mean| grows over this range
   * (a normal map finer than the trace grid) */
  NVAR: [0.002, 0.02] as const,
  /** ...where the depth is a surface: the macro normal is the mean of the depth normals at the texel and one texel
   * left / right / below / above, used as far as their mean length lies over this range (a ceiling grid's T-bars
   * narrower than a pixel, depth noise at the horizon and creases are no surface) */
  NCOH: [0.85, 0.95] as const,
  /** ...and as far as it agrees with the block's mean (cosine over this range: a corrugation's partial-period mean
   * lies within ~35 deg of its plane; a depth normal further off is not the block's surface) */
  NAGREE: [0.7, 0.8] as const,
  /** a block pixel joins the representative's lobe only within this roughness of it (another surface / lobe: its
   * own texels carry it through the upsample's roughness weight) */
  BLOCK_DR: 0.15,
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
 * lies behind the depth buffer, as a share of the accepted thickness: 0..1) and rayT (distance / maxDist). A receding
 * ray that passed behind an occluder leaves the distance at which it last did in brSsrBehindT (0 if it never did: a
 * miss behind a lamp fixture still tells the resolve how far its lobe reached). Receding rays (away from the camera)
 * use the min-pyramid traversal (Uludag, GPU Pro 5): coarse cells the ray passes in front of are skipped whole. Rays
 * toward the camera use a linear march with growing strides and a bisection.
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
float brSsrBehindT = 0.0;
bool brSsrTrace( vec3 P, vec3 R, mat4 proj, float maxDist, out vec2 hitUv, out float hitZ, out float hitGap, out float rayT ) {
	hitUv = vec2( 0.0 );
	hitZ = 0.0;
	hitGap = 0.0;
	rayT = 1.0;
	brSsrBehindT = 0.0;
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
					brSsrBehindT = t * L;
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

/** The trace at half the display resolution (one ray per step x step block, from its top-left pixel like the SSAO;
 * step 2, or 3 on ultra's 1.4x supersampled buffer). MRT: location 0 = premultiplied reflected radiance x confidence
 * (rgb), confidence (a); location 1 = the representative pixel's metadata for the resolve and the upsample: linear
 * view depth, oct view normal, lobe roughness (0 where the pixel has no G-buffer specular); location 2 = its resolve
 * kernel: the oct macro normal Nm (xy), the sd along the plane of incidence and across it (zw, trace texels; 0 where
 * no ray told how far the lobe reaches). */
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
uniform float uMaxRough;
uniform int uStep;                // full-resolution pixels per trace texel (2, 3 on ultra's 1.4x buffer)
layout( location = 0 ) out highp vec4 outSsr;
layout( location = 1 ) out highp vec4 outMeta;
layout( location = 2 ) out highp vec4 outKer;
#define BR_SSR_DEPTH_AT( px ) texelFetch( tDepth, clamp( px, ivec2( 0 ), ivec2( uFull ) - 1 ), 0 ).x
#define BR_SSR_MAX_DIST ${f(SSR.MAX_DIST)}
#define BR_SSR_EDGE ${f(SSR.EDGE_FADE)}
#define BR_SSR_RZ0 ${f(SSR.RZ_FADE0)}
#define BR_SSR_RZ1 ${f(SSR.RZ_FADE1)}
#define BR_SSR_FACING ${f(SSR.FACING)}
#define BR_SSR_CONE ${f(SSR.CONE)}
#define BR_SSR_NV_MIN ${f(SSR.NV_MIN)}
#define BR_SSR_LEN_MIN ${f(SSR.LEN_MIN)}
#define BR_SSR_LEN_MAX ${f(SSR.LEN_MAX)}
#define BR_SSR_ANISO ${f(SSR.PYR_ANISO)}
#define BR_SSR_TAIL_K ${f(SSR.TAIL_K)}
#define BR_SSR_TAIL_W ${f(SSR.TAIL_W)}
#define BR_SSR_SOFT ${f(SSR.THICK_SOFT)}
#define BR_SSR_UP ${f(SSR.UP_FADE)}
#define BR_SSR_NVAR0 ${f(SSR.NVAR[0])}
#define BR_SSR_NVAR1 ${f(SSR.NVAR[1])}
#define BR_SSR_NCOH0 ${f(SSR.NCOH[0])}
#define BR_SSR_NCOH1 ${f(SSR.NCOH[1])}
#define BR_SSR_NAGREE0 ${f(SSR.NAGREE[0])}
#define BR_SSR_NAGREE1 ${f(SSR.NAGREE[1])}
#define BR_SSR_BLOCK_DR ${f(SSR.BLOCK_DR)}
#define BR_SSR_RES_S ${f(SSR.RESOLVE_K * SSR.RESOLVE_SD)}
#define BR_SSR_RES_MAX ${f(SSR.RESOLVE_MAX)}
#define BR_HDR_CLAMP ${f(HDR_CLAMP)}
${SSR_OCT_GLSL}
vec2 brOctEnc( vec3 n ) {
	n /= abs( n.x ) + abs( n.y ) + abs( n.z );
	vec2 e = n.xy;
	if ( n.z < 0.0 ) e = ( 1.0 - abs( n.yx ) ) * vec2( n.x >= 0.0 ? 1.0 : -1.0, n.y >= 0.0 ? 1.0 : -1.0 );
	return e;
}
float pow4( float x ) { float x2 = x * x; return x2 * x2; }
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
// full-resolution pixel where the edge ray P + e t of the lobe meets the hit's plane (hd = dot(Ph - P, Nh), negative in
// front of it), within LEN_MIN..LEN_MAX x the central ray's length L0; a ray along the plane or away from it runs to
// LEN_MAX x L0 (continuous with the grazing ones: a jump there cut lamp streaks off at a hard edge)
vec2 brFootPx( vec3 P, vec3 e, vec3 Nh, float hd, float L0 ) {
	float de = dot( e, Nh );
	float t = hd >= 0.0 ? L0 : de < 0.0 ? clamp( hd / de, BR_SSR_LEN_MIN * L0, BR_SSR_LEN_MAX * L0 ) : BR_SSR_LEN_MAX * L0;
	vec3 q = P + e * t;
	q.z = min( q.z, - 0.05 ); // stays in front of the camera
	return brProjPx( q );
}
// One axis of the footprint, ends a and b (px), as textureGrad samples it: symmetric about the hit p0, so at most twice
// the nearer end's distance along the axis. A plane met obliquely puts the hit far off the footprint's middle (the edge
// rays meet it at LEN_MIN..LEN_MAX x the central ray's length); an axis of |a - b| centred on the hit reached past the
// nearer end by up to half its length, onto whatever lies beside the lobe on screen (dashed lamp glints along the
// T-bars of a ceiling grid, PILLAR_HALL ultra)
vec2 brSymAxis( vec2 a, vec2 b, vec2 p0 ) {
	vec2 d = a - b;
	float l2 = dot( d, d );
	if ( l2 < 1e-12 ) return d;
	return d * min( 2.0 * min( abs( dot( a - p0, d ) ), abs( dot( b - p0, d ) ) ) / l2, 1.0 );
}
// The glossy lobe's footprint at the hit, as the screen ellipse's two full axes in uv (textureGrad's gradients): the
// lobe's edge rays (tan tn in the plane of incidence of R about N, tn x N.V across it: GGX's reflected lobe narrows
// out of that plane at grazing views) met with the hit's plane (Ph, Nh: a receding ceiling or floor stretches it
// along the recession), projected, each axis kept within the nearer end (brSymAxis). The axis ratio is capped at the
// pyramid's anisotropy.
void brSsrFootprint( vec3 P, vec3 R, vec3 N, float nv, vec3 Ph, vec3 Nh, float tn, out vec2 gI, out vec2 gO ) {
	vec3 bO = cross( R, N );
	float bl = length( bO );
	bO = bl > 1e-4 ? bO / bl : normalize( cross( R, abs( R.y ) < 0.9 ? vec3( 0.0, 1.0, 0.0 ) : vec3( 1.0, 0.0, 0.0 ) ) );
	vec3 tI = cross( bO, R );
	float L0 = length( Ph - P );
	float hd = dot( Ph - P, Nh );
	vec3 eI = tn * tI, eO = ( tn * max( nv, BR_SSR_NV_MIN ) ) * bO;
	vec2 p0 = brProjPx( Ph );
	gI = brSymAxis( brFootPx( P, R + eI, Nh, hd, L0 ), brFootPx( P, R - eI, Nh, hd, L0 ), p0 ) / uFull;
	gO = brSymAxis( brFootPx( P, R + eO, Nh, hd, L0 ), brFootPx( P, R - eO, Nh, hd, L0 ), p0 ) / uFull;
	float lI = length( gI ), lO = length( gO );
	float lMin = max( lI, lO ) / BR_SSR_ANISO;
	if ( lI < lMin ) gI = ( lI > 1e-9 ? gI / lI : vec2( - gO.y, gO.x ) / lO ) * lMin;
	if ( lO < lMin ) gO = ( lO > 1e-9 ? gO / lO : vec2( - gI.y, gI.x ) / lI ) * lMin;
}
// The resolve's kernel of a texel at P (N.V nv) whose lobe (tan tn) reached Lr metres, in trace texels: for a mirror
// the camera sees the hit as if through a window, so a neighbour whose ray hits Lr x d away from ours sits
// d x Lr / (|P| + Lr) away on screen; the sd along the plane of incidence, and x N.V across it (resolveKernel twin)
vec2 brSsrKernel( vec3 P, float nv, float tn, float Lr ) {
	float s = BR_SSR_RES_S * tn * Lr / ( length( P ) + Lr ) * uProj[ 1 ][ 1 ] * uFull.y * 0.5 / float( uStep );
	return min( vec2( s, s * max( nv, BR_SSR_NV_MIN ) ), vec2( BR_SSR_RES_MAX ) );
}
void main() {
	outSsr = vec4( 0.0 );
	outMeta = vec4( 0.0 );
	outKer = vec4( 0.0 );
	ivec2 p = min( ivec2( gl_FragCoord.xy ) * uStep, ivec2( uFull ) - 1 );
	vec4 s1 = texelFetch( tSpec, p, 0 );
	vec4 g = texelFetch( tGNR, p, 0 );
	if ( s1.a < 1e-4 || g.a < 0.5 ) return;
	// the texel stands for its block: average the lobes of the glossy pixels of its whole step x step block (a normal
	// map finer than the trace grid, corrugated metal or grout, would otherwise alias into dots); the spread of their
	// normals widens the cone (Toksvig: alpha^2 + (1 - |n|) / |n|). Only pixels of the representative's lobe count
	// (roughness within BLOCK_DR): a block across a puddle's shore averaged the mirror with the wet carpet around it
	// into a middling lobe that caught the ceiling lamps as bright dots along the shore.
	vec3 nSum = brOctDec( g.rg );
	float rSum = g.b, cnt = 1.0;
	ivec2 lim = ivec2( uFull ) - 1;
	for ( int k = 1; k < uStep * uStep; k ++ ) {
		vec4 gk = texelFetch( tGNR, min( p + ivec2( k % uStep, k / uStep ), lim ), 0 );
		if ( gk.a < 0.5 || abs( gk.b - g.b ) > BR_SSR_BLOCK_DR ) continue;
		nSum += brOctDec( gk.rg );
		rSum += gk.b;
		cnt += 1.0;
	}
	float nLen = max( length( nSum ) / cnt, 1e-3 );
	vec3 N = normalize( nSum );
	float rough = rSum / cnt;
	float d = texelFetch( tDepth, p, 0 ).x;
	vec3 P = brViewPos( d, ( vec2( p ) + 0.5 ) / uFull );
	outMeta = vec4( - P.z, brOctEnc( N ), rough );
	if ( rough > uMaxRough ) return;
	float a = sqrt( pow4( rough ) + ( 1.0 - nLen ) / nLen );
	// the macro surface: the depth's own normal. A block whose normals disagree (a normal map finer than the trace
	// grid: a corrugated deck's ribs) is traced along it, the spread kept as the Toksvig cone: the mean of a partial rib
	// period changes from block to block and beat against the grid into dashed glints beside every high-bay, crawling
	// as the camera moved. The per-pixel weight Ws still draws the ribs in the composite. Nm: the mean depth normal of
	// the texel and its four neighbours, where they agree with each other (a surface) and with the block's mean; one
	// pixel's depth slope at geometry finer than a pixel (a ceiling grid's far T-bars) is noise, and rays reflected
	// about it caught the lamps as sparkles along every far grid line.
	vec3 Ng = brDepthNormal( p );
	for ( int k = 0; k < 4; k ++ ) {
		ivec2 o = ( k < 2 ? ivec2( 1, 0 ) : ivec2( 0, 1 ) ) * ( ( k & 1 ) == 0 ? - uStep : uStep );
		Ng += brDepthNormal( clamp( p + o, ivec2( 0 ), lim ) );
	}
	float coh = 0.2 * length( Ng );
	if ( coh > 1e-3 ) Ng /= 5.0 * coh; // (also false for a non-finite normal: the block's then)
	else { Ng = N; coh = 0.0; }
	vec3 Nm = normalize( mix( N, Ng, smoothstep( BR_SSR_NCOH0, BR_SSR_NCOH1, coh ) * smoothstep( BR_SSR_NAGREE0, BR_SSR_NAGREE1, dot( N, Ng ) ) ) );
	vec3 Nt = normalize( mix( N, Nm, smoothstep( BR_SSR_NVAR0, BR_SSR_NVAR1, 1.0 - nLen ) ) );
	vec3 V = - normalize( P );
	float nv = dot( Nt, V );
	if ( nv < 0.01 ) return;
	vec3 R = reflect( - V, Nt );
	if ( R.z >= BR_SSR_RZ1 ) return; // toward the camera: faded out anyway
	// a normal map can tilt the reflected ray below the macro surface: the ray would meet that surface a cell on and
	// copy it. What a groove reflects there is its own neighbouring flank: leave it to the fallback, whose horizon term
	// already weighs those directions down
	float up = dot( R, Nm );
	if ( up <= 0.0 ) return;
	vec2 hitUv;
	float hitZ, hitGap, rayT;
	// start just off the surface: its own depth must not stop the ray. A miss behind an occluder (a lamp fixture
	// hanging below the ceiling it would have hit) still sizes the resolve, which fills it from the neighbours' rays
	if ( ! brSsrTrace( P + Nt * ( 0.002 * - P.z ), R, uProj, BR_SSR_MAX_DIST, hitUv, hitZ, hitGap, rayT ) ) {
		if ( brSsrBehindT > 0.0 ) outKer = vec4( brOctEnc( Nm ), brSsrKernel( P, nv, BR_SSR_CONE * a, brSsrBehindT ) );
		return;
	}
	vec3 Ph = brViewPos( 1.0, hitUv );
	Ph *= hitZ / - Ph.z;
	outKer = vec4( brOctEnc( Nm ), brSsrKernel( P, nv, BR_SSR_CONE * a, length( Ph - P ) ) );
	ivec2 hp = ivec2( hitUv * uFull );
	vec3 Nh = brDepthNormal( hp );
	if ( dot( Nh, R ) > BR_SSR_FACING ) return; // the back of a surface: not what the ray sees
	// the glossy lobe (tan = CONE alpha) where it meets the hit's surface, one anisotropic lookup of the low-passed
	// pyramid. A screen-aligned disc stretched along the projected normal (the lookup until September 2026) was up to
	// 16x the lobe's area at grazing views and ignored the hit surface: a lamp beside a dark hit, metres behind it
	// and far outside the lobe, drew phantom copies in puddles and sparkle on tile ceilings
	vec2 gI, gO;
	brSsrFootprint( P, R, Nt, nv, Ph, Nh, BR_SSR_CONE * a, gI, gO );
	vec3 col = textureGrad( tPyr, hitUv, gI, gO ).rgb;
	// GGX's heavy tail (a lamp 1000x brighter than the room still streaks a glossy floor well outside the core): the
	// microfacet part widens, the Toksvig spread of the block's normals (about Gaussian) does not
	brSsrFootprint( P, R, Nt, nv, Ph, Nh, BR_SSR_CONE * sqrt( BR_SSR_TAIL_K * BR_SSR_TAIL_K * pow4( rough ) + ( 1.0 - nLen ) / nLen ), gI, gO );
	col = mix( col, textureGrad( tPyr, hitUv, gI, gO ).rgb, BR_SSR_TAIL_W );
	// a non-finite pyramid texel (ColorPyramid zeroes them at level 0 and filters its mips in fp32) is a miss, never a
	// firefly clamped to BR_HDR_CLAMP
	if ( any( isnan( col ) ) || any( isinf( col ) ) ) return;
	// confidence: screen border, roughness cut-off, ray length, rays toward the camera, thickness
	vec2 eb = min( hitUv, 1.0 - hitUv ) / BR_SSR_EDGE;
	float conf = clamp( min( eb.x, eb.y ), 0.0, 1.0 );
	conf *= 1.0 - smoothstep( uMaxRough - 0.1, uMaxRough, rough );
	conf *= 1.0 - smoothstep( 0.75, 1.0, rayT );
	conf *= 1.0 - smoothstep( BR_SSR_RZ0, BR_SSR_RZ1, R.z );
	conf *= 1.0 - smoothstep( 1.0 - BR_SSR_SOFT, 1.0, hitGap );
	conf *= smoothstep( 0.0, BR_SSR_UP, up );
	outSsr = vec4( min( max( col, vec3( 0.0 ) ), vec3( BR_HDR_CLAMP ) ) * conf, conf );
}
`;

/** The resolve, at the trace's resolution: each texel gathers BR_SSR_TAPS neighbours on a Vogel disc of radius 2 sd
 * in its kernel's frame (the trace's location 2: along the plane of incidence, the screen line toward the vanishing
 * point of the macro normal (vertical on a floor), and across it), Gaussian-weighted x the distance to its macro
 * plane x roughness, over the premultiplied result (a miss among the taps lowers the confidence, not the colour).
 * Kernels under RESOLVE_MIN texels (mirrors, contact reflections) are copied. uProjP = (P00, P11, P20, P21). */
export const SSR_RESOLVE_FRAG = /* glsl */ `
precision highp float;
precision highp int;
uniform highp sampler2D tSsr;
uniform highp sampler2D tMeta;
uniform highp sampler2D tKer;
uniform vec4 uProjP;
uniform vec2 uFull;
uniform int uStep;
layout( location = 0 ) out highp vec4 outSsr;
#ifndef BR_SSR_TAPS
#define BR_SSR_TAPS ${SSR.RESOLVE_TAPS[0]}
#endif
${SSR_OCT_GLSL}
// view position of trace texel q's representative pixel at linear depth z
vec3 brResPos( ivec2 q, float z ) {
	vec2 ndc = ( vec2( q * uStep ) + 0.5 ) / uFull * 2.0 - 1.0;
	return vec3( ( ndc + uProjP.zw ) / uProjP.xy * z, - z );
}
// screen position (px, up to a constant) of view point v
vec2 brResPx( vec3 v ) { return ( uProjP.xy * v.xy + uProjP.zw * v.z ) / - v.z * 0.5 * uFull; }
void main() {
	ivec2 t = ivec2( gl_FragCoord.xy );
	vec4 c = texelFetch( tSsr, t, 0 );
	outSsr = c;
	vec4 m = texelFetch( tMeta, t, 0 );
	if ( m.x <= 0.0 ) return;
	vec4 k = texelFetch( tKer, t, 0 );
	if ( k.z < ${f(SSR.RESOLVE_MIN)} ) return;
	ivec2 sz = textureSize( tSsr, 0 ) - 1;
	vec3 Nc = brOctDec( k.xy );
	vec3 Pc = brResPos( t, m.x );
	vec2 dir = brResPx( Pc + Nc * ( 0.05 * m.x ) ) - brResPx( Pc );
	float dl = length( dir );
	dir = dl > 1e-6 ? dir / dl : vec2( 0.0, 1.0 );
	vec2 dI = dir * k.z, dO = vec2( - dir.y, dir.x ) * k.w;
	// every tap is clamped to the range of the texel and the kernel's four axis points at 1 sd (at least a texel off):
	// one ray that caught a lamp is far brighter than the lobe around it, and the fixed tap pattern of every texel
	// within 2 sd of it copied it as a ring of glints (dots along ultra LOBBY's T-bars beside the troffers). A hole or
	// a flip smaller than the kernel still has lit axis points around it and is filled
	vec4 lo = c, hi = c;
	for ( int n = 0; n < 4; n ++ ) {
		vec2 ax = ( n < 2 ? dI : dO ) * ( ( n & 1 ) == 0 ? - 1.0 : 1.0 );
		ax *= max( 1.0 / max( length( ax ), 1e-3 ), 1.0 );
		vec4 sn = texelFetch( tSsr, clamp( t + ivec2( floor( ax + 0.5 ) ), ivec2( 0 ), sz ), 0 );
		lo = min( lo, sn );
		hi = max( hi, sn );
	}
	float pInv = 1.0 / ( ${f(SSR.RESOLVE_PLANE)} * m.x );
	vec4 acc = c;
	float ws = 1.0;
	for ( int i = 0; i < BR_SSR_TAPS; i ++ ) {
		float r = 2.0 * sqrt( ( float( i ) + 0.5 ) / float( BR_SSR_TAPS ) );
		float th = float( i ) * 2.39996323;
		ivec2 q = clamp( t + ivec2( floor( r * ( cos( th ) * dI + sin( th ) * dO ) + 0.5 ) ), ivec2( 0 ), sz );
		vec4 mq = texelFetch( tMeta, q, 0 );
		if ( mq.x <= 0.0 ) continue;
		float w = exp( - 0.5 * r * r - abs( dot( brResPos( q, mq.x ) - Pc, Nc ) ) * pInv
			- ${f(SSR.RESOLVE_ROUGH)} * abs( mq.w - m.w ) );
		acc += w * clamp( texelFetch( tSsr, q, 0 ), lo, hi );
		ws += w;
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
uniform vec4 uSsrP;               // x on, y debug view (REFL_DEBUG), z full-resolution pixels per trace texel
uniform vec3 uLin;                // near x far, far - near, far
#define BR_HDR_CLAMP ${f(HDR_CLAMP)}
#define BR_DEBUG_NITS ${f(TUNE.DEBUG_NITS)}
${SSR_OCT_GLSL}
float brLinZ( float d ) { return uLin.x / ( uLin.z - d * uLin.y ); }
// the upsample weight of a half-resolution texel with metadata m for a pixel at depth zp, normal Np, roughness rp
// (0 where the texel's pixel has no G-buffer specular)
float brUpW( vec4 m, float zp, vec3 Np, float rp ) {
	if ( m.x <= 0.0 ) return 0.0;
	return exp( - abs( zp - m.x ) / ( ${f(SSR.UP_Z)} * zp ) ) * pow( max( dot( Np, brOctDec( m.yz ) ), 0.0 ), ${f(SSR.UP_NPOW)} )
		* exp( - ${f(SSR.UP_ROUGH)} * abs( rp - m.w ) );
}
`;

/** Inside main() after `vec4 s1` (att1 at pixel p): sets `vec3 spec` and `vec4 ssr` (the upsampled reflection). */
export const SSR_COMPOSITE_SPECULAR = /* glsl */ `
	vec3 spec = s1.rgb;
	vec4 ssr = vec4( 0.0 );
	if ( uSsrP.x > 0.5 && s1.a > 0.0 ) {
		ivec2 hs = textureSize( tSsr, 0 ) - 1;
		// texel t represents pixel step x t: pixel p sits at p / step in texel units
		vec2 tf = vec2( p ) / uSsrP.z;
		ivec2 t0 = ivec2( floor( tf ) );
		vec2 fr = tf - vec2( t0 );
		ivec2 t1 = min( t0 + 1, hs );
		t0 = min( t0, hs );
		vec4 r00 = texelFetch( tSsr, t0, 0 ), r10 = texelFetch( tSsr, ivec2( t1.x, t0.y ), 0 );
		vec4 r01 = texelFetch( tSsr, ivec2( t0.x, t1.y ), 0 ), r11 = texelFetch( tSsr, t1, 0 );
		// all four missed (or were not traced): the fallback, without the bilateral weights
		if ( max( max( r00.a, r10.a ), max( r01.a, r11.a ) ) > 0.0 ) {
			vec4 g = texelFetch( tN2, p, 0 );
			vec3 Np = brOctDec( g.rg );
			float zp = brLinZ( texelFetch( tDepth, p, 0 ).x );
			vec4 m00 = texelFetch( tMeta, t0, 0 ), m10 = texelFetch( tMeta, ivec2( t1.x, t0.y ), 0 );
			vec4 m01 = texelFetch( tMeta, ivec2( t0.x, t1.y ), 0 ), m11 = texelFetch( tMeta, t1, 0 );
			vec4 w = vec4( ( 1.0 - fr.x ) * ( 1.0 - fr.y ), fr.x * ( 1.0 - fr.y ), ( 1.0 - fr.x ) * fr.y, fr.x * fr.y ) + 0.01;
			w *= vec4( brUpW( m00, zp, Np, g.b ), brUpW( m10, zp, Np, g.b ), brUpW( m01, zp, Np, g.b ), brUpW( m11, zp, Np, g.b ) );
			float ws = w.x + w.y + w.z + w.w;
			if ( ws > 1e-3 ) ssr = ( w.x * r00 + w.y * r10 + w.z * r01 + w.w * r11 ) / ws;
		}
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

/** The trace's two cone tans for lobe roughness `rough` and block normal length `nLen`: the core (Toksvig alpha) and
 * the tail (the microfacet alpha TAIL_K x wider, the normals' spread unchanged). */
export function lobeCones(rough: number, nLen: number): { core: number; tail: number } {
  const r4 = rough ** 4, toks = (1 - nLen) / nLen;
  return { core: SSR.CONE * Math.sqrt(r4 + toks), tail: SSR.CONE * Math.sqrt(SSR.TAIL_K * SSR.TAIL_K * r4 + toks) };
}

type Vec3 = readonly [number, number, number];
const dot3 = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a: Vec3, b: Vec3): [number, number, number] => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm3 = (a: Vec3): [number, number, number] => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const axpy = (a: Vec3, s: number, b: Vec3): [number, number, number] => [a[0] + s * b[0], a[1] + s * b[1], a[2] + s * b[2]];

/** brSymAxis twin: the footprint axis with ends a, b (px) as the ellipse symmetric about the hit p0 that textureGrad
 * samples, at most twice the nearer end's distance along it. */
export function symAxis(a: readonly [number, number], b: readonly [number, number], p0: readonly [number, number]): [number, number] {
  const d: [number, number] = [a[0] - b[0], a[1] - b[1]];
  const l2 = d[0] * d[0] + d[1] * d[1];
  if (l2 < 1e-12) return d;
  const near = Math.min(Math.abs((a[0] - p0[0]) * d[0] + (a[1] - p0[1]) * d[1]), Math.abs((b[0] - p0[0]) * d[0] + (b[1] - p0[1]) * d[1]));
  const s = Math.min((2 * near) / l2, 1);
  return [d[0] * s, d[1] * s];
}

/** brSsrFootprint twin: the glossy lobe (tan tn) from view point P along unit R about normal N (N.V = nv), met with
 * the hit's plane (Ph, Nh). `project` maps a view point to full-resolution pixels (brProjPx with the near guard left
 * to the caller). Returns the lobe's edge points on that plane (in-plane pair, out-of-plane pair) and the ellipse's
 * two full axes in pixels, each kept within the nearer end (symAxis) and then anisotropy-capped (the shader divides
 * them by the frame size). */
export function lobeFootprint(P: Vec3, R: Vec3, N: Vec3, nv: number, Ph: Vec3, Nh: Vec3, tn: number,
  project: (v: Vec3) => [number, number]): { edges: [number, number, number][]; gI: [number, number]; gO: [number, number] } {
  let bO = cross3(R, N);
  bO = Math.hypot(...bO) > 1e-4 ? norm3(bO) : norm3(cross3(R, Math.abs(R[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]));
  const tI = cross3(bO, R);
  const d: Vec3 = [Ph[0] - P[0], Ph[1] - P[1], Ph[2] - P[2]];
  const L0 = Math.hypot(...d), hd = dot3(d, Nh);
  const oS = tn * Math.max(nv, SSR.NV_MIN);
  const rays = [axpy(R, tn, tI), axpy(R, -tn, tI), axpy(R, oS, bO), axpy(R, -oS, bO)];
  const edges = rays.map((e) => {
    const de = dot3(e, Nh);
    const t = hd >= 0 ? L0 : de < 0 ? Math.min(SSR.LEN_MAX * L0, Math.max(SSR.LEN_MIN * L0, hd / de)) : SSR.LEN_MAX * L0;
    return axpy(P, t, e);
  });
  const px = edges.map((q) => project(q));
  const p0 = project(Ph);
  let gI = symAxis(px[0], px[1], p0);
  let gO = symAxis(px[2], px[3], p0);
  const lI = Math.hypot(...gI), lO = Math.hypot(...gO);
  const lMin = Math.max(lI, lO) / SSR.PYR_ANISO;
  if (lI < lMin) gI = lI > 1e-9 ? [gI[0] / lI * lMin, gI[1] / lI * lMin] : [-gO[1] / lO * lMin, gO[0] / lO * lMin];
  if (lO < lMin) gO = lO > 1e-9 ? [gO[0] / lO * lMin, gO[1] / lO * lMin] : [-gI[1] / lI * lMin, gI[0] / lI * lMin];
  return { edges, gI, gO };
}

/** brSsrKernel twin: the resolve's sd along the plane of incidence and across it, in trace texels, for a texel at P
 * (N.V nv) whose lobe (tan tn) reached Lr metres; p11 = the projection's [1][1], fullH = the frame's height (px),
 * step = full-resolution pixels per trace texel. */
export function resolveKernel(P: Vec3, nv: number, tn: number, Lr: number, p11: number, fullH: number, step: number): [number, number] {
  const s = SSR.RESOLVE_K * SSR.RESOLVE_SD * tn * Lr / (Math.hypot(P[0], P[1], P[2]) + Lr) * p11 * fullH * 0.5 / step;
  return [Math.min(s, SSR.RESOLVE_MAX), Math.min(s * Math.max(nv, SSR.NV_MIN), SSR.RESOLVE_MAX)];
}

/** Tap i of n on the resolve's Vogel disc: radius (in sd, up to 2) and angle (golden angle steps). */
export function resolveTap(i: number, n: number): [number, number] {
  return [2 * Math.sqrt((i + 0.5) / n), i * 2.39996323];
}

/** The composite's specular term: fallback s1 (rgb, a = Ws), upsampled reflection ssr (premultiplied, a = conf). */
export function compositeSpecular(s1: readonly [number, number, number, number], ssr: readonly [number, number, number, number]): [number, number, number] {
  if (s1[3] <= 0 || ssr[3] <= 0) return [s1[0], s1[1], s1[2]];
  const c = ssr[3];
  const out: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < 3; i++) out[i] = s1[i] * (1 - c) + c * (s1[3] * ssr[i] / Math.max(c, 1e-4));
  return out;
}
