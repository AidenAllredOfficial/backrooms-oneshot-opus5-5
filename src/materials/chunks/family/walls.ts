// src/materials/chunks/family/walls.ts — texture realism v2 family hooks: wall coverings and paint (WALLPAPER_L0,
// WALLPAPER_MANILA, DRYWALL, TRIM_PAINT). Owns grime profiles 2 (wallpaper) and 7 (paint: DRYWALL, TRIM_PAINT). Lane
// D's file; hook points and rules in chunks/family/index.ts.
//
// Water stains (both profiles) are capillary fronts, not thresholds: the WP7 mask R is the wet extent (bake/mask.ts:
// stains at or below STAIN_MAX, seepage runnel tongues SEEP_R0..1), perturbed by a fine field (the layer's own relief,
// the detail multiplier and two world value-noise octaves at 12 mm and 40 mm; no speckle: it broke the fronts into
// grains), so the paper's formation and emboss steer the edge. brWlFronts draws 3 nested drying fronts whose spacing
// varies along the wall, each a deposit darkest at its outer edge (brStainFront's profile, chunks/grimeLib.ts) that
// keeps its integral when the pixel footprint widens it (no darkening with distance), a pale halo inside the outermost,
// mould specks inside the innermost where the wall stays damp, and white efflorescence just above a rising-damp front.
// Runnel zones get narrow runnels (one per 0.1 m column, p 0.6) that wander, narrow down the wall and end in teardrop
// deposits. The ceiling family (chunks/family/ceiling.ts) reuses brWlFronts.
//
// Wallpaper also gets its roll seams (tight, open or lifted), the peel edge (torn fibres, a lifted flap showing its
// white back and casting a shadow, the exposed face paper and adhesive) and damp cockle; paint gets scuffs, blisters
// and flakes to the primer, and drywall its screw spots, pops and spackle patches (postSample: they change the detail
// mask). The analytic relief of seams, flaps, cockle, pops and blisters is a world-space height gradient
// (brWlBump, d h / d along and d h / d y) that the normal hook adds on the wall's world axes.

import { SEEP_R0, STAIN_MAX } from '../../../bake/mask.ts';
import { Mat } from '../../../core/ids.ts';
import { STAIN_FRONT } from '../grimeLib.ts';
import { f } from '../params.ts';
import type { FamilyHooks } from './index.ts';

/** Wall stain colours (linear multipliers): the tide-line deposit, the pale halo inside the outer front, the
 * efflorescence salt, and the runnel deposit. */
export const WALL_STAIN = {
  TIDE: [0.55, 0.42, 0.26], HALO: [0.84, 0.74, 0.55], SALT: [0.78, 0.77, 0.72], RUNNEL: [0.5, 0.38, 0.22],
  L0: 0.44, // R of the outermost drying front
  TIDE_M: 0.003, // m, width of a tide line's sharp outer edge (it fades inward over STAIN_FRONT.INNER times this)
  NEST_FADE: 0.2, // deposit lost per nested front (the older, inner fronts are fainter)
  RELIEF: 1.0, // weight of the layer's relief (per 0.15 of height, clamped +-1) in the fine field (x M_TEX)
  // the fronts' raggedness is a metric displacement along the wet extent's gradient (so a front stays one coherent
  // ragged line however gentle the extent is): up to +-M_TEX from the layer's relief, +-M_12 / +-M_40 m from the 12 mm
  // and 40 mm world noise octaves (displacement slopes < 1: the level set never breaks into islands)
  M_TEX: 0.004, M_12: 0.006, M_40: 0.015,
} as const;

const v3 = (c: readonly number[]): string => `vec3( ${c.map(f).join(', ')} )`;

const WALL_PARS = /* glsl */ `
// ---- lane D wall stains and damage (chunks/family/walls.ts)
#define BR_WL_TIDE ${v3(WALL_STAIN.TIDE)}
#define BR_WL_HALO ${v3(WALL_STAIN.HALO)}
#define BR_WL_SALT ${v3(WALL_STAIN.SALT)}
#define BR_WL_RUNNEL ${v3(WALL_STAIN.RUNNEL)}
#define BR_WL_L0 ${f(WALL_STAIN.L0)}
#define BR_WL_TIDE_M ${f(WALL_STAIN.TIDE_M)}
#define BR_WL_STAIN_MAX ${f(STAIN_MAX)}
#define BR_WL_SEEP_R0 ${f(SEEP_R0)}
#define BR_WL_M_DRYWALL ${Mat.DRYWALL}
#define BR_WL_M_TRIM ${Mat.TRIM_PAINT}
// nested drying fronts at the levels L0 < L1 < L2 of the field sp: brStainFront's deposit profile (a half Gaussian of
// width wp on the dry side, an exponential of ${f(STAIN_FRONT.INNER)} wp inside, each inner front
// ${f(WALL_STAIN.NEST_FADE)} weaker). wp is the deposit's physical width in s units: the caller converts BR_WL_TIDE_M
// metres with the field's metric gradient, so the line is ~3 mm wide however steep or gentle the wet extent is. The
// pixel footprint wAA (the caller's fwidth of the field's smooth part, taken in uniform flow) widens both sides in
// quadrature and lowers the peak so the deposit keeps its integral (0.886 wp + ${f(STAIN_FRONT.INNER)} wp): a front
// neither darkens nor brightens a wall with distance, and it stays a thin line wherever it is resolved. The fine
// field's noise is left out of wAA: it only moves the front, and its octaves fade before they could alias. Callable in
// per-pixel branches
void brWlFronts( float sp, float wpIn, float wAA, float L0, float L1, float L2, out float inside, out float tide ) {
	float wp = max( wpIn, 1e-5 );
	float wo = sqrt( wp * wp + wAA * wAA );
	float li = sqrt( ${f(STAIN_FRONT.INNER * STAIN_FRONT.INNER)} * wp * wp + wAA * wAA );
	float amp = ${f(0.886 + STAIN_FRONT.INNER)} * wp / ( 0.886 * wo + li );
	tide = 0.0;
	for ( int k = 0; k < 3; k ++ ) {
		float d = sp - ( k == 0 ? L0 : k == 1 ? L1 : L2 );
		float t = d < 0.0 ? exp( - ( d / wo ) * ( d / wo ) ) : exp( - d / li );
		tide = max( tide, t * ( 1.0 - ${f(WALL_STAIN.NEST_FADE)} * float( k ) ) );
	}
	tide *= amp;
	inside = smoothstep( L0 - wo, L0 + wo, sp );
}
// the gradient (per metre) of a field on the surface's 2D coordinate s2 from its screen derivatives dp and those of s2
// (sx, sy); the derivatives are taken in uniform control flow, the solve may run in a branch
vec2 brWlGrad2( vec2 dp, vec2 sx, vec2 sy ) {
	float det = sx.x * sy.y - sx.y * sy.x;
	return abs( det ) > 1e-14 ? vec2( sy.y * dp.x - sx.y * dp.y, sx.x * dp.y - sy.x * dp.x ) / det : vec2( 0.0 );
}
// world value noise on a wall and its gradient (per metre) in one evaluation (4 corner hashes): .x the value 0..1,
// .yz d/d along, d/d y; cell c metres (c divides NOISE_WRAP and STOREY_PITCH)
vec3 brWlNoiseD( vec2 s2, float c, uint salt ) {
	ivec2 P = ivec2( int( BR_NOISE_WRAP / c + 0.5 ), int( BR_PITCH / c + 0.5 ) );
	vec2 p = s2 / c;
	ivec2 i = ivec2( floor( p ) );
	vec2 fr = p - floor( p );
	float a = brU01( brHash2u( brWrap( i, P ), salt ) ), b = brU01( brHash2u( brWrap( i + ivec2( 1, 0 ), P ), salt ) );
	float d0 = brU01( brHash2u( brWrap( i + ivec2( 0, 1 ), P ), salt ) ), d1 = brU01( brHash2u( brWrap( i + 1, P ), salt ) );
	vec2 u = fr * fr * ( 3.0 - 2.0 * fr );
	vec2 du = 6.0 * fr * ( 1.0 - fr ) / c;
	float k = a - b - d0 + d1;
	return vec3( a + ( b - a ) * u.x + ( d0 - a ) * u.y + k * u.x * u.y, du * vec2( b - a + k * u.y, d0 - a + k * u.x ) );
}
// world value noise on a wall (along, storey-relative y), cell c metres (c divides NOISE_WRAP and STOREY_PITCH)
float brWlNoise( vec2 s2, float c, uint salt ) {
	return brVNoise( s2 / c, ivec2( int( BR_NOISE_WRAP / c + 0.5 ), int( BR_PITCH / c + 0.5 ) ), salt );
}
// box-filtered coverage of a line of half-width hw at signed distance d over a pixel footprint fp (all metres): exact
// for lines thinner than a pixel, so seams and cracks keep their mean at any distance
float brWlLine( float d, float hw, float fp ) { return max( 0.0, min( d + 0.5 * fp, hw ) - max( d - 0.5 * fp, - hw ) ) / fp; }
// ...and of a small dot of radius r at offset q (a square of the same area, so the coverage is separable and exact)
float brWlDot( vec2 q, float r, float fp ) { return brWlLine( q.x, 0.886 * r, fp ) * brWlLine( q.y, 0.886 * r, fp ); }
// a band beside an edge (d >= 0 on its side, metres) fading out over w0..w1, which the footprint fp softens: the peak
// drops as the band widens, so it keeps its integral (w0 + w1) / 2 and an edge detail (a torn fibre strip, a lip, a
// cast shadow) neither darkens nor brightens a wall with distance
float brWlBand( float d, float w0, float w1, float fp ) { return ( 1.0 - smoothstep( w0, w1 + fp, d ) ) * ( w0 + w1 ) / ( w0 + w1 + fp ); }
// signed distance (m) to the level T of a smooth damage field pfS (positive where pfS > T) and the unit direction
// toward that side, on the wall's (along, y) plane, from the field's screen derivatives dp and those of s2 (taken by the
// caller in uniform control flow); the caller's fine offset ragM (metres) roughens the edge. (A fine field added to pfS
// before the division crossed T wherever pfS lay near it with a small gradient: thin false edges in long streaks.)
float brWlEdgeDist( float pfS, vec2 dp, vec2 sx, vec2 sy, float ragM, float T, out vec2 dir ) {
	vec2 g = brWlGrad2( dp, sx, sy );
	float gl = length( g );
	dir = gl > 1e-6 ? g / gl : vec2( 0.0, - 1.0 );
	return ( pfS - T ) / max( gl, 0.05 ) + ragM;
}
// the shared wall stain block: fronts, halo, mould, efflorescence and runnels on the albedo a and the roughness
// multiplier; fine: the texture part of the fine field, w: the front footprint and gs the smooth field's metric
// gradient (1/m) from the caller, fp the metric pixel footprint, yLoc the storey-relative height
void brWlStain( inout vec3 a, inout float roughMul, vec4 mask, vec4 g1, vec4 g2, float fine, float w, float gs, vec2 s2, float fp, float yLoc ) {
	// the fine field's world octaves, faded out as they shrink below ~2 pixels (the texture terms are mip-filtered)
	float n12 = ( brWlNoise( s2, 0.012, 811u ) - 0.5 ) * ( 1.0 - smoothstep( 0.2, 0.5, fp / 0.012 ) );
	float n40 = ( brWlNoise( s2, 0.04, 823u ) - 0.5 ) * ( 1.0 - smoothstep( 0.2, 0.5, fp / 0.04 ) );
	float R = mask.r;
	float sp = min( R, BR_WL_STAIN_MAX ) + 0.12 * ( g2.r - 0.5 )
		+ gs * ( ${f(WALL_STAIN.M_TEX)} * fine + ${f(2 * WALL_STAIN.M_12)} * n12 + ${f(2 * WALL_STAIN.M_40)} * n40 );
	// front spacing varies smoothly along the wall (0.6 m noise): no per-cell jumps
	float L1 = BR_WL_L0 + ${f(STAIN_FRONT.A1)} + ${f(STAIN_FRONT.B1)} * brWlNoise( s2, 0.6, 839u );
	float L2 = L1 + ${f(STAIN_FRONT.A2)} + ${f(STAIN_FRONT.B2)} * brWlNoise( s2 + 0.3, 0.6, 853u );
	float inside, tide;
	brWlFronts( sp, BR_WL_TIDE_M * gs, w, BR_WL_L0, L1, L2, inside, tide );
	// runnel zones (R >= SEEP_R0): the halo and fronts stay at the zone's rim, the runnels are drawn inside
	float zone = smoothstep( BR_WL_SEEP_R0 - 0.035, BR_WL_SEEP_R0 + 0.015, R );
	float halo = inside * ( 1.0 - 0.5 * zone );
	a *= mix( vec3( 1.0 ), BR_WL_HALO * mix( 0.93, 1.04, g2.r ), 0.45 * halo );
	a *= mix( vec3( 1.0 ), BR_WL_TIDE, 0.75 * tide * ( 0.6 + 0.4 * g2.g ) );
	roughMul *= 1.0 + 0.08 * tide - 0.05 * halo;
	// mould specks inside the innermost front where the wall stays damp
	float mould = smoothstep( 0.62, 0.85, g1.g ) * smoothstep( L1, L2, sp ) * clamp( 0.4 + mask.b * 1.5, 0.0, 1.0 );
	a *= mix( vec3( 1.0 ), vec3( 0.3, 0.33, 0.25 ), 0.5 * mould );
	// efflorescence: salts crystallise just above a rising-damp front (5-20 mm on the dry side), in patches
	if ( yLoc < 1.3 ) {
		float eb = smoothstep( BR_WL_L0 - 0.1, BR_WL_L0 - 0.06, sp ) * ( 1.0 - smoothstep( BR_WL_L0 - 0.025, BR_WL_L0 - 0.005, sp ) );
		float ef = eb * smoothstep( 0.35, 0.65, g1.r + 0.4 * n40 ) * ( 1.0 - zone );
		a = mix( a, BR_WL_SALT, 0.4 * ef );
		roughMul *= 1.0 + 0.15 * ef;
	}
	if ( zone > 0.0 ) {
		// runnels: one per 0.1 m column (p 0.6), wandering +-10 mm, 5-20 mm wide narrowing down the wall, each ending
		// in a teardrop at its own progress tEnd; the zone's own progress t = (1 - R) / (1 - SEEP_R0)
		float t = clamp( ( 1.0 - R ) / ( 1.0 - BR_WL_SEEP_R0 ), 0.0, 1.0 );
		float col = floor( s2.x / 0.1 );
		uint h = brHash2u( brWrap( ivec2( int( col ), 0 ), ivec2( int( BR_NOISE_WRAP / 0.1 + 0.5 ), 1 ) ), 877u );
		if ( brU01( h ) < 0.6 ) {
			float h1 = brU01( brPcg( h ) ), h2 = brU01( brPcg( h + 1u ) ), h3 = brU01( brPcg( h + 2u ) );
			float wob = brVNoise( vec2( col * 7.31, s2.y / 0.05 ), ivec2( 1 << 20, int( BR_PITCH / 0.05 + 0.5 ) ), 881u ) - 0.5;
			float cx = ( col + 0.3 + 0.4 * h1 ) * 0.1 + 0.02 * wob;
			float tEnd = mix( 0.45, 0.92, h3 );
			float drop = smoothstep( tEnd - 0.07, tEnd - 0.015, t );
			float hw = mix( 0.0025, 0.01, h2 ) * ( 1.0 - 0.7 * t ) * ( 1.0 + 1.3 * drop );
			float live = 1.0 - smoothstep( tEnd - 0.012, tEnd, t );
			float core = brWlLine( s2.x - cx, hw, max( fp, 1e-5 ) ) * live;
			float rim = ( brWlLine( s2.x - cx, hw + 0.0015, max( fp, 1e-5 ) ) - core ) * live;
			a *= mix( vec3( 1.0 ), BR_WL_RUNNEL, zone * ( 0.5 * core + 0.7 * rim + 0.3 * drop * core ) );
			roughMul *= 1.0 + 0.06 * zone * rim;
		}
		// the damp halo under the ceiling, fading down the zone
		a *= mix( vec3( 1.0 ), BR_WL_HALO, 0.45 * zone * ( 1.0 - t ) );
	}
}
`;

// the fine field's texture part and the metric footprint, shared by every block of the two profile branches (uniform
// control flow). Low relief is wetter (the paper's formation, emboss and joints steer a front), the detail's dark
// pores too
const WALL_FIELDS = /* glsl */ `
		vec2 wlSx = dFdx( brS2 ), wlSy = dFdy( brS2 ); // shared by every metric gradient below
		float wlFp = max( 0.5 * ( abs( wlSx.x ) + abs( wlSy.x ) + abs( wlSx.y ) + abs( wlSy.y ) ), 1e-5 );
		float wlFade = 1.0 - smoothstep( 0.004, 0.012, wlFp ); // analytic relief below a few pixels would only sparkle
		float wlFine = clamp( ( brMuH - brNrm.w ) / 0.15, - 1.0, 1.0 ) * ${f(WALL_STAIN.RELIEF)};
#if defined( BR_DETAIL_MAPS ) && ! defined( BR_DECAL )
		wlFine += 1.6 * ( 1.0 - brAm );
#endif
`;

// the stain call: the front footprint from the smooth part of the field (mask, tide noise); the texture part and the
// world noise octaves only move the fronts (the one is mip-filtered, the others fade out before they could alias)
const WALL_STAIN_CALL = /* glsl */ `
		{
			float wlS0 = min( brMask.r, BR_WL_STAIN_MAX ) + 0.12 * ( g2.r - 0.5 );
			vec2 wlDs = vec2( dFdx( wlS0 ), dFdy( wlS0 ) );
			float wlW = ${f(STAIN_FRONT.W_PX)} * ( abs( wlDs.x ) + abs( wlDs.y ) );
			if ( brMask.r > 0.02 ) brWlStain( brA, brRoughMul, brMask, g1, g2, wlFine, wlW, length( brWlGrad2( wlDs, wlSx, wlSy ) ), brS2, wlFp, vBrLocal.y );
		}
`;

// postSample: the analytic relief gradient (applied in the normal hook), the per-roll shade and sheen of both
// wallpapers, and the drywall's construction features (screw spots and pops on the stud lattice, spackle patches),
// which change the detail mask, so they run before the detail block
const WALL_POST_SAMPLE = /* glsl */ `
vec2 brWlBump = vec2( 0.0 ); // world relief gradient (d h / d along, d h / d y) for the normal hook
if ( brRoll ) {
	// per-roll dye lot: surface.ts multiplies +-3 % value / +-1.5 % warmth after the detail block from the same hash;
	// one dye lot differs by < 1 % (+-0.8 % / +-0.5 %), so that factor is divided out here, and reverse-hung rolls
	// differ in sheen instead (roughness +-0.03)
	float rv = brU01( brPcg( brRollH ) ) * 2.0 - 1.0;
	float rw = brU01( brPcg( brRollH ^ 0x5bd1e995u ) ) * 2.0 - 1.0;
	brA *= ( 1.0 + 0.008 * rv ) * vec3( 1.0 + 0.005 * rw, 1.0, 1.0 - 0.005 * rw ) / ( ( 1.0 + 0.03 * rv ) * vec3( 1.0 + 0.015 * rw, 1.0, 1.0 - 0.015 * rw ) );
	brOrmh.g = clamp( brOrmh.g + 0.03 * ( brU01( brPcg( brRollH + 0x9e3779b9u ) ) * 2.0 - 1.0 ), 0.03, 1.0 );
}
#if BR_DETAIL == 1 && ! defined( BR_DECAL )
if ( brL == BR_WL_M_DRYWALL && ! brHoriz ) {
	float wlFp0 = max( 0.5 * ( fwidth( brS2.x ) + fwidth( brS2.y ) ), 1e-5 );
	float wlFade0 = 1.0 - smoothstep( 0.004, 0.012, wlFp0 );
	// screw spots: studs every 0.4 m (the 1.2 m sheet edges and joints on every third), screws every 0.3 m up each stud.
	// 30 % of the spots flash (the compound takes the primer glossier and the stipple shallower), 6 % have popped: an
	// 18 mm dome 0.6 mm high with a hairline ring crack
	vec2 wlSc = vec2( floor( brS2.x / 0.4 + 0.5 ), floor( brS2.y / 0.3 ) );
	uint wlHs = brHash2u( brWrap( ivec2( wlSc ), ivec2( int( BR_NOISE_WRAP / 0.4 + 0.5 ), 10 ) ), 907u );
	float wlUs = brU01( wlHs );
	if ( wlUs < 0.36 ) {
		vec2 dsp = brS2 - vec2( wlSc.x * 0.4, ( wlSc.y + 0.5 ) * 0.3 ) - 0.012 * ( vec2( brU01( brPcg( wlHs ) ), brU01( brPcg( wlHs + 1u ) ) ) - 0.5 );
		float r = length( dsp );
		float spot = 1.0 - smoothstep( 0.013 - wlFp0, 0.019 + wlFp0, r );
		brAux *= 1.0 - 0.5 * spot;
		if ( wlUs < 0.3 ) {
			brOrmh.g = max( brOrmh.g - 0.06 * spot, 0.03 );
			brA *= 1.0 + 0.006 * spot;
		} else {
			float k = max( 1.0 - r * r / ( 0.009 * 0.009 ), 0.0 );
			brWlBump += dsp * ( - 4.0 * 0.0006 * k / ( 0.009 * 0.009 ) ) * wlFade0;
			float crack = brWlLine( r - 0.0105, 0.0002, wlFp0 );
			brA *= 1.0 - 0.25 * crack;
			brOrmh.r *= 1.0 - 0.35 * crack;
		}
	}
	// spackle patches: one in ~4 feature cells (2.4 x 1.5 m), a sanded 60-180 mm rounded rectangle, smoother (less
	// stipple, glossier) and a touch lighter (touch-up paint)
	vec2 wlFc = vec2( BR_FEATURE_CELL, BR_FEATURE_CELL_Y );
	ivec2 wlPc = ivec2( floor( brS2 / wlFc ) );
	uint wlHp = brHash2u( brWrap( wlPc, ivec2( BR_FEATURE_P, BR_FEATURE_PY ) ), 919u );
	if ( brU01( wlHp ) < 0.25 ) {
		vec2 ctr = ( vec2( wlPc ) + 0.1 + 0.8 * vec2( brU01( brPcg( wlHp ) ), brU01( brPcg( wlHp + 1u ) ) ) ) * wlFc;
		vec2 hsz = 0.5 * mix( vec2( 0.06 ), vec2( 0.18 ), vec2( brU01( brPcg( wlHp + 2u ) ), brU01( brPcg( wlHp + 3u ) ) ) );
		vec2 dd = abs( brS2 - ctr ) - hsz + 0.015;
		float sd = length( max( dd, 0.0 ) ) + min( max( dd.x, dd.y ), 0.0 ) - 0.015;
		float pat = 1.0 - smoothstep( - 0.012 - wlFp0, 0.012 + wlFp0, sd );
		brOrmh.g = max( brOrmh.g - 0.08 * pat, 0.03 );
		brA *= 1.0 + 0.03 * pat;
		brAux *= 1.0 - 0.6 * pat;
	}
}
#endif
`;

// wallpaper: roll seam states, the peel edge and damp cockle
const WALLPAPER_DAMAGE = /* glsl */ `
		{
			vec3 wlAn = abs( brNWg );
			uint wlOr = wlAn.x > wlAn.z ? ( brNWg.x > 0.0 ? 0u : 1u ) : ( brNWg.z > 0.0 ? 2u : 3u );
			// roll seams: 60 % tight (the texture's hairline), 25 % open 0.3-0.8 mm (the wall shows), 15 % lifted 0.3-1 mm
			// (more where the wall is damp or damaged), curling over ~4 mm with a thin shadow beside the curl
			float sK = floor( brS2.x / BR_WALL_ROLL + 0.5 );
			float dS = brS2.x - sK * BR_WALL_ROLL;
			uint hsm = brHash2u( brWrap( ivec2( int( sK ), 0 ), ivec2( BR_WALL_ROLL_P, 1 ) ), 613u + wlOr * 13u );
			float um = brU01( hsm );
			if ( ! brHoriz && um >= 0.6 && abs( dS ) < 0.03 ) {
				float h2 = brU01( brPcg( hsm ) ), h3 = brU01( brPcg( hsm + 1u ) );
				if ( um < 0.85 ) {
					float gap = brWlLine( dS, mix( 0.00015, 0.0004, h2 ), wlFp );
					brA = mix( brA, vec3( 0.5, 0.48, 0.44 ), gap );
					brOrmh.r *= 1.0 - 0.4 * gap;
				} else {
					float sgn = h2 < 0.5 ? - 1.0 : 1.0;
					float lift = min( mix( 0.0003, 0.001, h3 ) * ( 1.0 + brMask.a + brMask.b ), 0.001 );
					float e = exp( - max( sgn * dS, 0.0 ) / 0.004 ) * step( 0.0, sgn * dS );
					brWlBump.x -= sgn * lift / 0.004 * e * wlFade;
					float shade = brWlLine( dS + sgn * 0.00075, 0.00075, wlFp );
					brA *= 1.0 - 0.3 * shade;
					brOrmh.r *= 1.0 - 0.3 * shade;
				}
			}
			// peeling (mask A, more at the roll seams): the edge distance from the field's screen gradient
			float seam = 1.0 - smoothstep( 0.0, 0.07, abs( dS ) );
			float pfS = brMask.a * ( 0.45 + 0.8 * seam ) + ( g2.r - 0.5 ) * 0.3; // the smooth tide field: blobs (the scuff channel made dashes)
			vec2 pfD = vec2( dFdx( pfS ), dFdy( pfS ) );
			vec2 pdir;
			// below A 0.08 the field stays >= 0.28 under T: an edge within 3 cm would need a gradient of 9 / m
			float dE = brMask.a > 0.08 ? brWlEdgeDist( pfS, pfD, wlSx, wlSy, 0.01 * wlFine, 0.55, pdir ) : - 1.0;
			if ( dE > - 0.03 ) {
				float ex = smoothstep( - wlFp, wlFp, dE ); // exposed wall
				float torn = ex * brWlBand( dE, 0.0015, 0.0025, wlFp );
				float flapW = mix( 0.004, 0.025, brWlNoise( brS2, 0.075, 941u ) );
				float flap = ( 1.0 - ex ) * brWlBand( - dE, 0.7 * flapW, flapW, wlFp );
				// the flap stands off the wall above the edge: its shadow falls on the exposed side below it
				float shadow = ex * brWlBand( dE, 0.002, 0.009, wlFp ) * clamp( 0.35 - pdir.y, 0.0, 1.0 );
				float glue = smoothstep( 0.4, 0.7, g1.g + 0.3 * ( g2.r - 0.5 ) );
				brA = mix( brA, mix( vec3( 0.5, 0.47, 0.4 ), vec3( 0.55, 0.45, 0.25 ), 0.4 * glue ), ex );
				brOrmh.g = mix( brOrmh.g, mix( 0.7, 0.35, glue ), ex );
				brA *= 1.0 - 0.45 * shadow;
				brA = mix( brA, vec3( 0.78, 0.75, 0.68 ), 0.85 * flap );
				brA = mix( brA, vec3( 0.72 ), torn );
				brWlBump += pdir * ( flap * mix( 0.36, 0.84, brWlNoise( brS2 + 0.5, 0.05, 947u ) ) * wlFade );
			}
			// damp cockle: the swollen paper bubbles 1.5 mm over ~6 cm and turns a little glossier
			float ck = smoothstep( 0.3, 0.6, brMask.b + min( brMask.r, BR_WL_STAIN_MAX ) );
			if ( ck > 0.0 && ! brHoriz ) {
				brWlBump += ck * 0.0015 * brWlNoiseD( brS2, 0.06, 953u ).yz;
				brOrmh.g = max( brOrmh.g - 0.05 * ck, 0.03 );
			}
		}
`;

// paint: scuffs (shoes and carts low, chair backs at 0.7-0.95 m), flakes down to the white primer (face paper in the
// cores) with a shadowed lip, chips in the trim down to the MDF, and blisters where the wall is damp
const PAINT_DAMAGE = /* glsl */ `
		{
			if ( ! brHoriz ) {
				float y = vBrLocal.y;
				float band = smoothstep( 0.04, 0.1, y ) * ( 1.0 - smoothstep( 0.35, 0.45, y ) )
					+ 0.6 * smoothstep( 0.66, 0.72, y ) * ( 1.0 - smoothstep( 0.92, 0.98, y ) );
				float sc = smoothstep( 0.45, 0.8, g1.b ) * band * clamp( 0.3 + 1.2 * brMask.g, 0.0, 1.0 );
				brA = mix( brA, vec3( 0.07, 0.066, 0.06 ), 0.35 * sc );
				brRoughMul *= 1.0 - 0.15 * sc;
			}
			vec2 pdir;
			float pfS = brMask.a + ( g2.r - 0.5 ) * 0.3;
			vec2 pfD = vec2( dFdx( pfS ), dFdy( pfS ) );
			// below A 0.2 the field stays >= 0.25 under T: an edge within 2 cm would need a gradient of 12 / m
			float dE = brMask.a > 0.2 ? brWlEdgeDist( pfS, pfD, wlSx, wlSy, 0.008 * wlFine, 0.6, pdir ) : - 1.0;
			if ( dE > - 0.02 ) {
				float ex = smoothstep( - wlFp, wlFp, dE );
				float core = smoothstep( 0.02, 0.06, dE );
				brA = mix( brA, mix( vec3( 0.75, 0.74, 0.7 ), vec3( 0.52, 0.5, 0.46 ), 0.7 * core * smoothstep( 0.4, 0.7, g2.g ) ), ex );
				brOrmh.g = mix( brOrmh.g, 0.8, ex );
				float lip = ex * brWlBand( dE, 0.0006, 0.0014, wlFp );
				float edge = ( 1.0 - ex ) * brWlBand( - dE, 0.0004, 0.001, wlFp );
				brA *= ( 1.0 - 0.35 * lip ) * ( 1.0 + 0.08 * edge );
			}
			if ( brL == BR_WL_M_TRIM ) {
				// chips: 12 mm cells, a 1-6 mm chip down to the MDF with a dark broken lip, mostly on the top face and the
				// top arris of a baseboard, more where the grime is heavy
				vec2 cq = brS2 / 0.012;
				vec2 cc = floor( cq );
				int cpy = brHoriz ? int( BR_NOISE_WRAP / 0.012 + 0.5 ) : int( BR_PITCH / 0.012 + 0.5 );
				uint hc = brHash2u( brWrap( ivec2( cc ), ivec2( int( BR_NOISE_WRAP / 0.012 + 0.5 ), cpy ) ), 983u );
				float arris = brHoriz ? ( brNWg.y > 0.0 ? 1.0 : 0.2 ) : 0.25 + 0.75 * smoothstep( 0.06, 0.1, vBrLocal.y ) * ( 1.0 - smoothstep( 0.16, 0.2, vBrLocal.y ) );
				if ( brU01( hc ) < 0.07 * arris * clamp( 0.4 + 1.5 * brMask.g, 0.0, 1.5 ) ) {
					vec2 d = ( cq - cc - 0.5 - 0.4 * ( vec2( brU01( brPcg( hc ) ), brU01( brPcg( hc + 1u ) ) ) - 0.5 ) ) * 0.012;
					float R = mix( 0.0005, 0.003, brU01( brPcg( hc + 2u ) ) );
					R *= 1.0 + 0.35 * sin( 3.0 * atan( d.y, d.x ) + 6.2831853 * brU01( brPcg( hc + 3u ) ) );
					float r = length( d );
					float chip = 1.0 - smoothstep( R - wlFp, R + wlFp, r );
					float lip = ( 1.0 - chip ) * brWlBand( r - R, 0.0, 0.0006, wlFp );
					brA = mix( brA, vec3( 0.45, 0.38, 0.28 ), chip );
					brA *= 1.0 - 0.3 * lip;
					brOrmh.g = mix( brOrmh.g, 0.8, chip );
				}
			}
			float damp = clamp( brMask.b + brMask.a, 0.0, 1.0 );
			if ( damp > 0.2 && ! brHoriz ) {
				// blisters: 15 mm cells, a 3-7 mm dome 0.4 mm high in up to 45 % of them (more where it is wetter)
				vec2 bq = brS2 / 0.015;
				vec2 bc = floor( bq );
				uint hb = brHash2u( brWrap( ivec2( bc ), ivec2( int( BR_NOISE_WRAP / 0.015 + 0.5 ), 200 ) ), 961u );
				if ( brU01( hb ) < 0.45 * smoothstep( 0.2, 0.6, damp ) ) {
					vec2 d = ( bq - bc - 0.5 - 0.3 * ( vec2( brU01( brPcg( hb ) ), brU01( brPcg( hb + 1u ) ) ) - 0.5 ) ) * 0.015;
					float R = mix( 0.003, 0.007, brU01( brPcg( hb + 2u ) ) );
					float k = max( 1.0 - dot( d, d ) / ( R * R ), 0.0 );
					brWlBump += d * ( - 4.0 * 0.0004 * k / ( R * R ) ) * wlFade;
				}
			}
		}
`;

const WALL_FADES = /* glsl */ `
		if ( BR_DETAIL == 1 && ! brHoriz ) {
			// sun-less "fades": large soft paler patches
			float fz = smoothstep( 0.62, 0.9, brSurfNoise( brS2, false, BR_FEATURE_CELL, BR_FEATURE_P, BR_FEATURE_CELL_Y, BR_FEATURE_PY, 401u ) );
			brA = mix( brA, vec3( brLuma( brA ) ) * vec3( 1.1, 1.06, 0.95 ), fz * 0.22 );
		}
`;

// life marks (wallpaper and drywall, not trim), one draw per 2.4 m of wall and face: a picture ghost (p 0.08: the
// cleaner, unfaded rectangle a long-hung frame leaves, a dust line along its top edge and the nail hole above) or a
// poster's traces (p 0.12: four tack holes and yellowed, glossy tape residue at its top corners); the hand zones near
// openings (the mask's G at 0.9-1.5 m) are burnished glossier as well as dirtier
const WALL_LIFE = /* glsl */ `
		if ( BR_DETAIL == 1 && ! brHoriz && brL != BR_WL_M_TRIM ) {
			vec3 lfAn = abs( brNWg );
			int lfOr = lfAn.x > lfAn.z ? ( brNWg.x > 0.0 ? 0 : 1 ) : ( brNWg.z > 0.0 ? 2 : 3 );
			float gx = floor( brS2.x / 2.4 );
			uint hg = brHash2u( brWrap( ivec2( int( gx ), lfOr ), ivec2( BR_FEATURE_P, 4 ) ), 971u );
			float ug = brU01( hg );
			if ( ug < 0.2 ) {
				vec4 r4 = vec4( brU01( brPcg( hg ) ), brU01( brPcg( hg + 1u ) ), brU01( brPcg( hg + 2u ) ), brU01( brPcg( hg + 3u ) ) );
				vec2 q = brS2 - vec2( ( gx + 0.25 + 0.5 * r4.z ) * 2.4, mix( 1.3, 1.7, r4.w ) );
				if ( ug < 0.08 ) {
					vec2 hsz = 0.5 * vec2( mix( 0.25, 0.8, r4.x ), mix( 0.2, 0.6, r4.y ) );
					vec2 dd = abs( q ) - hsz;
					float sd = length( max( dd, 0.0 ) ) + min( max( dd.x, dd.y ), 0.0 );
					float inR = 1.0 - smoothstep( - 0.0015 - wlFp, 0.0015 + wlFp, sd );
					brA *= mix( vec3( 1.0 ), vec3( 1.06, 1.05, 1.08 ), inR );
					brA *= 1.0 - 0.12 * brWlLine( q.y - hsz.y - 0.0015, 0.0015, wlFp ) * step( abs( q.x ), hsz.x );
					float nail = brWlDot( q - vec2( 0.0, hsz.y + 0.06 ), 0.0008, wlFp );
					brA *= 1.0 - 0.85 * nail;
					brOrmh.r *= 1.0 - 0.7 * nail;
				} else {
					vec2 hsz = 0.5 * vec2( mix( 0.4, 0.6, r4.x ), mix( 0.5, 0.8, r4.y ) );
					vec2 cq = abs( q ) - hsz + 0.012;
					float tack = brWlDot( cq, 0.0005, wlFp );
					brA *= 1.0 - 0.7 * tack;
					brOrmh.r *= 1.0 - 0.5 * tack;
					if ( q.y > 0.0 && r4.x < 0.7 ) {
						vec2 tq = vec2( cq.x + cq.y, cq.y - cq.x ) * 0.7071;
						vec2 td = abs( tq ) - vec2( 0.03, 0.01 );
						float tape = 1.0 - smoothstep( - wlFp, wlFp, length( max( td, 0.0 ) ) + min( max( td.x, td.y ), 0.0 ) );
						brA *= mix( vec3( 1.0 ), vec3( 1.0, 0.95, 0.8 ), 0.8 * tape );
						brOrmh.g = mix( brOrmh.g, 0.3, tape );
					}
				}
			}
			float hz = smoothstep( 0.85, 0.95, vBrLocal.y ) * ( 1.0 - smoothstep( 1.45, 1.55, vBrLocal.y ) );
			brRoughMul *= 1.0 - 0.15 * hz * smoothstep( 0.1, 0.4, brMask.g );
		}
`;

const WALL_DIRT = /* glsl */ `
		brA *= mix( vec3( 1.0 ), BR_WALL_DIRT, clamp( brMask.g * ( 0.45 + 0.9 * g2.g ), 0.0, 1.0 ) );
		float mould = smoothstep( 0.6, 0.85, g2.g ) * clamp( brMask.b + brMask.r * 0.5, 0.0, 1.0 );
		brA *= mix( vec3( 1.0 ), vec3( 0.45, 0.47, 0.38 ), mould * 0.6 );
`;

export const WALL_HOOKS: FamilyHooks = {
  pars: WALL_PARS,
  postSample: WALL_POST_SAMPLE,
  postDetail: '',
  grime: /* glsl */ `
	else if ( brGrime == BR_G_WALLPAPER ) {
		// wallpaper: water stains (R: leaks, rising damp, ceiling seepage runnels), dirt / dust / hand smudges (G),
		// seams, peeling (A) and damp cockle
${WALL_FIELDS}${WALL_STAIN_CALL}${WALL_DIRT}${WALL_LIFE}${WALLPAPER_DAMAGE}${WALL_FADES}	}
	else if ( brGrime == BR_G_PAINT ) {
		// paint (drywall, trim): water stains as on wallpaper, dirt / dust / hand smudges (G), scuffs, flakes to the
		// primer (A) and blisters where damp
${WALL_FIELDS}${WALL_STAIN_CALL}${WALL_DIRT}${WALL_LIFE}${PAINT_DAMAGE}${WALL_FADES}	}
`,
  postWet: '',
  rough: '',
  normal: /* glsl */ `
#if BR_DETAIL == 1
// lane D walls: the analytic relief (lifted seams, peel flaps, cockle, screw pops, blisters) on the wall's world
// (along, up) axes: n = N - dh/d along T_along - dh/dy T_up
if ( brWlBump.x != 0.0 || brWlBump.y != 0.0 ) {
	vec3 wlTa = abs( brNWg.x ) > abs( brNWg.z ) ? vec3( 0.0, 0.0, 1.0 ) : vec3( 1.0, 0.0, 0.0 );
	normal = normalize( normal - brWlBump.x * ( viewMatrix * vec4( wlTa, 0.0 ) ).xyz - brWlBump.y * ( viewMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz );
}
#endif
`,
  matPost: '',
  postLight: '',
  preFog: '',
};
