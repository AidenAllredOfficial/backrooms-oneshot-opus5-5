// src/materials/chunks/family/concrete.ts — texture realism v2 family hooks: concrete, floor paint, terrazzo
// (CONCRETE_FLOOR, CONCRETE_WALL, CONCRETE_CEIL, FLOOR_PAINT, TERRAZZO). Owns grime profile 4 (concrete: the slabs,
// walls, soffits and FLOOR_PAINT; TERRAZZO has the tile profile). Lane B's file; hook points and rules in
// chunks/family/index.ts.
//
// The slab's structure above the 2.4 m texture is world-space (lane B):
// - pours (19.2 x 9.6 m) and 4.8 m panels with their own tone, hue and sheen;
// - saw-cut control joints on the 4.8 m grid: a 4.4 mm kerf with 1.5 mm arrises, filled 4 mm down with dark polyurea
//   or open (debris); inside it the view ray sees the far wall (analytic parallax) or the bottom; 30 % of the 0.24 m
//   joint segments are spalled (a fresh, paler fracture sloping into the kerf); dirt collects beside the cut;
// - one shrinkage crack in some panels, edge to edge (so every crack ends at a joint), warped, 0.2-1.2 mm wide, 35 %
//   branched, with a dirty halo;
// - traffic lanes (WP7 mask A, bake/mask.ts): burnished darker and glossier on concrete, dulled on terrazzo;
// - a finish class per room (the FLOOR_AUX region key): sealed, plain troweled or dusty.
// Everything is anti-aliased against the pixel footprint (1D supersampling across the kerf, a minimum rendered width
// with scaled contrast for sub-pixel cracks and kerfs), and gated on the per-face layer (quad-uniform).

import { Mat } from '../../../core/ids.ts';
import { Det } from '../../../textures/detailRecipes/types.ts';
import type { FamilyHooks } from './index.ts';

export const CONCRETE_HOOKS: FamilyHooks = {
  pars: /* glsl */ `
// ---- lane B: concrete slab system (world xz metres; cells divide NOISE_WRAP)
#define BRC_M_CONCRETE_CEIL ${Mat.CONCRETE_CEIL}
#define BRC_M_TERRAZZO ${Mat.TERRAZZO}
#define BRC_DET_SLAB ${Det.SLAB}.0
#define BRC_KERF_HW 0.0022 // m, saw-cut kerf half-width
#define BRC_ARRIS 0.0015 // m, arris bevel width (the saw's bevel, ravelled by traffic)
#define BRC_FILL_D 0.004 // m, joint filler depth below the surface
#define BRC_OPEN_D 0.03 // m, depth of an open (unfilled) kerf
#define BRC_SPALL_CELL 0.24 // m, joint segments that may spall (5120 per NOISE_WRAP)
#define BRC_SPALL_P 5120
// The kerf profile at signed distance x (m) from a joint line, seen along the view slope t (horizontal travel across
// the joint per unit of depth): albedo multiplier (a), tangent normal of the kerf / spall / arris faces (n; z up) and
// its weight (nw), roughness target and weight (r, rw), cavity multiplier (cav). sw: the spall half-widths on the
// side x > 0 (sw.x) and x < 0 (sw.y). filled: the kerf holds filler at BRC_FILL_D (else debris at BRC_OPEN_D). The
// axis is the joint's across direction: n.x is along it.
void brcKerfTap( float x, float t, vec2 sw, bool filled, inout float a, inout vec3 n, inout float nw, inout float r, inout float rw, inout float cav ) {
	float ax = abs( x );
	float sd = x >= 0.0 ? 1.0 : - 1.0;
	float spw = x >= 0.0 ? sw.x : sw.y;
	if ( ax < BRC_KERF_HW ) {
		// the kerf opening: follow the view ray down to the wall it meets (on the side it travels to) or the bottom
		float st = t >= 0.0 ? 1.0 : - 1.0;
		float z = ( BRC_KERF_HW - x * st ) / max( abs( t ), 1e-4 );
		float bottom = filled ? BRC_FILL_D : BRC_OPEN_D;
		if ( z < bottom ) {
			a *= 0.5 * exp( - z / 0.006 );
			n += vec3( - st * 0.95, 0.0, 0.3 );
			r += 0.8;
			cav *= 0.55;
		} else if ( filled ) {
			a *= 0.2; // dark grey polyurea (albedo ~0.06)
			n += vec3( 0.0, 0.0, 1.0 );
			r += 0.5;
			cav *= 0.5;
		} else {
			a *= 0.33 * exp( - bottom / 0.006 ); // debris at the bottom of an open kerf
			n += vec3( 0.0, 0.0, 1.0 );
			r += 0.95;
			cav *= 0.3;
		}
		nw += 1.0;
		rw += 1.0;
	} else if ( ax < BRC_KERF_HW + spw ) {
		// spall: a fresh, paler fracture sloping down into the kerf (25-40 degrees), dirt collected at its bottom
		float f = 1.0 - ( ax - BRC_KERF_HW ) / max( spw, 1e-5 );
		a *= 1.15 * mix( 1.0, 0.75, f * f );
		n += normalize( vec3( - sd * mix( 0.47, 0.84, fract( spw * 997.0 ) ), 0.0, 1.0 ) );
		r += 0.85;
		cav *= mix( 1.0, 0.7, f );
		nw += 1.0;
		rw += 1.0;
	} else if ( ax < BRC_KERF_HW + spw + BRC_ARRIS ) {
		// arris: the saw's bevel (45 degrees, ravelled to 1.5 mm), a little worn and paler
		a *= 1.03;
		n += vec3( - sd * 0.707, 0.0, 0.707 );
		cav *= 0.9;
		nw += 1.0;
	}
}
// Spall half-widths (m) at along-joint position al (m) of joint line li on the side x > 0 (x) and x < 0 (y):
// 30 % of the 0.24 m segments carry a chip 5-25 mm long and 3-10 mm wide, on one side or (15 %) both
vec2 brcSpall( float al, int li, uint salt ) {
	vec2 sw = vec2( 0.0 );
	float q = al / BRC_SPALL_CELL;
	float c0 = floor( q );
	float c1 = c0 + ( q - c0 < 0.5 ? - 1.0 : 1.0 );
	for ( int k = 0; k < 2; k ++ ) {
		float c = k == 0 ? c0 : c1;
		uint h = brHash2u( brWrap( ivec2( li, int( c ) ), ivec2( BR_CONCRETE_JOINT_P, BRC_SPALL_P ) ), salt );
		if ( brU01( h ) > 0.3 ) continue;
		uint h1 = brPcg( h );
		uint h2 = brPcg( h1 );
		float ac = ( c + 0.15 + 0.7 * brU01( h1 ) ) * BRC_SPALL_CELL;
		float hl = mix( 0.0025, 0.0125, brU01( h2 ) );
		float u = ( al - ac ) / hl;
		if ( abs( u ) >= 1.0 ) continue;
		float wm = mix( 0.003, 0.01, brU01( brPcg( h2 ) ) );
		// a ragged chip outline: two harmonics of the along coordinate
		float rag = 0.85 + 0.15 * sin( u * 7.0 + brU01( h ) * 40.0 ) + 0.08 * sin( u * 17.0 + brU01( h1 ) * 50.0 );
		float w = wm * pow( 1.0 - u * u, 0.6 ) * rag;
		float side = brU01( brPcg( h2 + 7u ) );
		if ( side < 0.575 ) sw.x = max( sw.x, w );
		if ( side > 0.425 ) sw.y = max( sw.y, w );
	}
	return sw;
}
// The joint of one axis: x = signed metres from the line, al = along-joint metres, li = line index, t = view slope,
// fx = pixel footprint across the joint (m). 4 taps across the footprint while the kerf is at least ~1 pixel wide,
// fading to the kerf's mean darkening (coverage) below that. Returns the joint coverage of the pixel.
float brcJoint( float x, float al, int li, float t, float fx, bool filled, out float a, out vec3 n, out float r, out float cav ) {
	vec2 sw = brcSpall( al, li, 523u );
	float a4 = 0.0, nw = 0.0, r4 = 0.0, rw = 0.0, c4 = 0.0;
	vec3 n4 = vec3( 0.0 );
	for ( int k = 0; k < 4; k ++ ) {
		float xs = x + fx * ( float( k ) - 1.5 ) * 0.25;
		float ta = 1.0, tc = 1.0;
		brcKerfTap( xs, t, sw, filled, ta, n4, nw, r4, rw, tc );
		a4 += ta;
		c4 += tc;
	}
	a = a4 * 0.25;
	cav = c4 * 0.25;
	n = nw > 0.0 ? n4 / nw : vec3( 0.0, 0.0, 1.0 );
	r = rw > 0.0 ? r4 / rw : 0.0;
	float cov = nw * 0.25;
	// sub-pixel kerf: its mean darkening over the footprint (a line that neither vanishes nor crawls)
	float wk = 2.0 * BRC_KERF_HW + sw.x + sw.y;
	float k = smoothstep( 0.5 * wk, 1.5 * wk, fx );
	if ( k > 0.0 ) {
		float cl = clamp( wk / fx, 0.0, 1.0 ) * ( 1.0 - smoothstep( 0.5 * wk, 0.5 * wk + fx, abs( x ) ) );
		a = mix( a, 1.0 - 0.7 * cl, k );
		cav = mix( cav, 1.0 - 0.4 * cl, k );
		cov = mix( cov, cl, k );
	}
	return cov;
}
// A shrinkage crack of panel pid (4.8 m, world xz): with probability p, one crack between random points on two
// different panel edges (so it ends at joints), wandering across its line by 6 cm at 0.4 m and 1 cm at 5 cm, 0.1-0.6 mm
// half-width along its length; 35 % carry a branch from a point on it to a third edge. Returns the crack core
// coverage-weighted darkness (0..1) and its dirty halo (hal). pf = the pixel footprint (m).
vec2 brcCrackEnd( int e, float u ) {
	return e == 0 ? vec2( u, 0.0 ) : e == 1 ? vec2( 1.0, u ) : e == 2 ? vec2( u, 1.0 ) : vec2( 0.0, u );
}
float brcSegD( vec2 p, vec2 a, vec2 b, out float h ) {
	vec2 pa = p - a, ba = b - a;
	h = clamp( dot( pa, ba ) / dot( ba, ba ), 0.0, 1.0 );
	return length( pa - ba * h );
}
// a one-round lattice hash and its 10-bit fields (the per-floor-pixel hashes: fewer PCG rounds)
uint brcHash( ivec2 c, uint salt ) { return brPcg( uint( c.x ) * 1597334677u ^ uint( c.y ) * 3812015801u ^ salt * 2654435761u ); }
float brcBits( uint h, uint shift ) { return float( ( h >> shift ) & 1023u ) * ( 1.0 / 1023.0 ); }
// pid: the panel (unwrapped, for its position); pw: the same wrapped over NOISE_WRAP (for its hashes)
float brcSlabCrack( vec2 s2, ivec2 pid, ivec2 pw, float p, float pf, out float hal ) {
	hal = 0.0;
	uint h = brcHash( pw, 1741u );
	if ( brU01( h ) >= p ) return 0.0;
	uint h1 = brPcg( h );
	int e0 = int( h1 & 3u );
	int e1 = ( e0 + 1 + int( ( ( h1 >> 2 ) & 255u ) % 3u ) ) & 3;
	vec2 o = vec2( pid ) * BR_CONCRETE_JOINT;
	vec2 A = o + brcCrackEnd( e0, mix( 0.15, 0.85, brcBits( h1, 10u ) ) ) * BR_CONCRETE_JOINT;
	vec2 B = o + brcCrackEnd( e1, mix( 0.15, 0.85, brcBits( h1, 20u ) ) ) * BR_CONCRETE_JOINT;
	// run the segment 15 cm past both edges: the wander may shift its ends, the panel boundary clips it at the joint
	vec2 dir = normalize( B - A );
	A -= dir * 0.15;
	B += dir * 0.15;
	float ta, tbr = 0.0;
	float d = brcSegD( s2, A, B, ta );
	uint h2 = brPcg( h1 );
	bool br = brcBits( h2, 0u ) < 0.35;
	vec2 C = A, D = A;
	float db = 1e3;
	if ( br ) {
		C = mix( A, B, mix( 0.25, 0.75, brcBits( h2, 10u ) ) );
		int e2 = e0 == ( ( e1 + 1 ) & 3 ) ? ( e1 + 3 ) & 3 : ( e1 + 1 ) & 3;
		D = o + brcCrackEnd( e2, mix( 0.2, 0.8, brcBits( h2, 20u ) ) ) * BR_CONCRETE_JOINT;
		D += normalize( D - C ) * 0.15;
		db = brcSegD( s2, C, D, tbr );
	}
	if ( min( d, db ) > 0.1 ) return 0.0; // beyond the wander amplitude plus the halo
	// the crack wanders: the lookup point shifts across it by 6 cm at 0.4 m and 1 cm at 5 cm
	float wv = 0.12 * ( brVNoise( s2 / 0.4, ivec2( 3072 ), 1801u ) - 0.5 ) + 0.02 * ( brVNoise( s2 / 0.05, ivec2( 24576 ), 1803u ) - 0.5 );
	vec2 sw = s2 + vec2( - dir.y, dir.x ) * wv;
	d = brcSegD( sw, A, B, ta );
	// the width breathes along the crack (0.1-0.6 mm half-width over ~0.2-0.8 m)
	float ph = float( h2 >> 22 );
	float hw = mix( 0.0001, 0.0006, clamp( 0.5 + 0.5 * sin( ta * 41.0 + ph ) * ( 0.6 + 0.4 * sin( ta * 97.0 + 2.0 * ph ) ), 0.0, 1.0 ) );
	if ( br ) {
		db = brcSegD( sw, C, D, tbr );
		float hwb = mix( 0.0001, 0.0004, 0.5 + 0.5 * sin( tbr * 29.0 + 3.0 * ph ) ) * ( 1.0 - 0.6 * tbr );
		if ( db < d ) { d = db; hw = hwb; }
	}
	// sub-pixel line: rendered at least 0.35 pixel wide with the darkness scaled by the true width (no shimmer)
	float hr = max( hw, 0.35 * pf );
	float core = ( 1.0 - smoothstep( hr - 0.5 * pf, hr + 0.5 * pf, d ) ) * ( hw / hr );
	hal = 1.0 - smoothstep( 0.0, mix( 0.003, 0.006, float( h2 >> 30 ) / 3.0 ) + pf, d );
	return core;
}
// The slab system of an up-facing CONCRETE_FLOOR (and FLOOR_PAINT stripes over it): joints, spalls, pours, panels and
// cracks, applied in place to the surface state (albedo a, roughness multiplier rm, the filtered tangent normal nrm of
// length nlen, ormh: r cavity, g roughness). paint: a stripe (joints only). Returns the joint coverage of the pixel.
// Most pixels leave after a few hashes (no crack within 0.1 m, no joint within 4 cm): the kerf and the view vector
// are only evaluated near a joint.
float brcSlab( vec2 s2, bool paint, inout vec3 a, inout float rm, inout vec4 nrm, float nlen, inout vec4 ormh ) {
	vec2 fw = max( fwidth( s2 ), vec2( 1e-5 ) );
	ivec2 pid = ivec2( floor( s2 / BR_CONCRETE_JOINT ) );
	if ( ! paint ) {
		// pours (4 x 2 panels) and panels: tone, hue and sheen
		ivec2 pour = ivec2( floor( vec2( pid ) / vec2( 4.0, 2.0 ) ) );
		ivec2 pw = brWrap( pid, ivec2( BR_CONCRETE_JOINT_P ) );
		uint hp = brcHash( brWrap( pour, ivec2( BR_CONCRETE_JOINT_P / 4, BR_CONCRETE_JOINT_P / 2 ) ), 1613u );
		uint hq = brcHash( pw, 1619u );
		float hue = brcBits( hp, 10u ) * 2.0 - 1.0;
		a *= ( 1.0 + 0.06 * ( brcBits( hp, 0u ) * 2.0 - 1.0 ) + 0.03 * ( brcBits( hq, 0u ) * 2.0 - 1.0 ) ) * vec3( 1.0 + 0.012 * hue, 1.0, 1.0 - 0.012 * hue );
		rm *= mix( 0.85, 1.15, brcBits( hp, 20u ) ) * mix( 0.95, 1.05, brcBits( hq, 10u ) );
		float hal;
		float cr = brcSlabCrack( s2, pid, pw, 0.6, max( fw.x, fw.y ), hal );
		if ( hal > 0.0 ) {
			a *= ( 1.0 - 0.65 * cr ) * ( 1.0 - 0.07 * hal );
			rm *= 1.0 + 0.12 * hal;
			ormh.r *= ( 1.0 - 0.4 * cr ) * ( 1.0 - 0.1 * hal );
		}
	}
	// joints: the nearer of the two line families
	vec2 lj = floor( s2 / BR_CONCRETE_JOINT + 0.5 );
	vec2 jx = s2 - lj * BR_CONCRETE_JOINT; // signed metres from the nearest x-line (x) / z-line (y)
	vec2 ajx = abs( jx );
	if ( min( ajx.x, ajx.y ) > 0.04 + 2.0 * max( fw.x, fw.y ) ) return 0.0;
	bool zl = ajx.y < ajx.x; // nearer to a z = const line: across = z
	float x = zl ? jx.y : jx.x;
	int li = int( zl ? lj.y : lj.x );
	vec3 vw = ( vec4( normalize( vViewPosition ), 0.0 ) * viewMatrix ).xyz; // world direction to the eye
	float t = - ( zl ? vw.z : vw.x ) / max( vw.y, 0.05 );
	uint hl = brHash2u( brWrap( ivec2( li, zl ? 1 : 0 ), ivec2( BR_CONCRETE_JOINT_P, 2 ) ), 1627u );
	float ka, kr, kc;
	vec3 kn;
	float cov = brcJoint( x, zl ? s2.x : s2.y, li, t, zl ? fw.y : fw.x, brU01( hl ) < 0.7, ka, kn, kr, kc );
	// dirt collected beside the cut
	a *= ka * ( 1.0 - 0.12 * ( 1.0 - smoothstep( 0.0, 0.025, abs( x ) ) ) );
	ormh.r *= kc;
	if ( cov > 0.0 ) {
		ormh.g = mix( ormh.g, kr, cov );
		// the across axis is the tangent y (world z) for z-lines
		nrm.xyz = mix( nrm.xyz, normalize( zl ? vec3( 0.0, kn.x, kn.z ) : kn ) * nlen, cov );
	}
	return cov;
}
`,
  postSample: /* glsl */ `
#ifdef BR_DECAL
	if ( brL == BR_M_FLOOR_PAINT && brNWg.y > 0.5 ) {
		// floor-paint stripes (mesh/decals.ts: u across the stripe from one edge, v along it, aux.x = width mm)
		float brcWd = brAuxB.x * 0.001;
		if ( brAuxB.x > 0.5 && brAuxB.x < 254.5 ) {
			// edge flakes: 2-10 mm chips out of both painted edges, on 40 % of 8 mm cells along the stripe
			float brcAc = brUv.x * brLB.x;
			float brcAl = brUv.y * brLB.x;
			float brcFw = max( fwidth( brcAc ), 1e-5 );
			vec2 brcDep = vec2( 0.0 ); // chip depth into each edge (u = 0, u = width)
			float brcQ = brcAl / 0.008;
			float brcC0 = floor( brcQ );
			for ( int k = - 1; k <= 1; k ++ ) {
				float c = brcC0 + float( k );
				uint h = brHash2u( ivec2( int( c ), int( brAuxB.x ) ), 1777u );
				if ( brU01( h ) > 0.4 ) continue;
				uint h1 = brPcg( h );
				float r = mix( 0.002, 0.01, brU01( h1 ) * brU01( h1 ) );
				float u = ( brcAl - ( c + brU01( brPcg( h1 ) ) ) * 0.008 ) / r;
				if ( abs( u ) >= 1.0 ) continue;
				float d = r * sqrt( 1.0 - u * u ) * ( 0.8 + 0.4 * brU01( brPcg( h1 + 9u ) ) );
				if ( ( h & 256u ) != 0u ) brcDep.x = max( brcDep.x, d ); else brcDep.y = max( brcDep.y, d );
			}
			brAlpha *= smoothstep( - brcFw, brcFw, min( brcAc - brcDep.x, brcWd - brcAc - brcDep.y ) );
		}
		// the slab's saw-cut joints run through the stripe: the filler and the kerf stay unpainted (the slab shows)
		if ( BR_DETAIL == 1 ) {
			float brcRm = 1.0;
			vec3 brcA = vec3( 1.0 );
			vec4 brcN = vec4( 0.0, 0.0, 1.0, 0.0 ), brcO = vec4( 1.0 );
			brAlpha *= 1.0 - brcSlab( brS2, true, brcA, brcRm, brcN, 1.0, brcO );
		}
#ifdef BR_DETAIL_MAPS
		// the slab's detail (D12, world-anchored) through the thin film: speckle and pinholes continue under the paint
		vec2 brcDu = brSurf2D( vBrLocal, brNWg ) / BR_DETAIL_REPEAT;
		vec2 brcDx = dFdx( brcDu ), brcDy = dFdy( brcDu );
		vec4 brcMu = textureLod( uBrDetail, vec3( 0.5, 0.5, BRC_DET_SLAB ), 16.0 );
		float brcNear = 1.0 - smoothstep( BR_DETAIL_FAR0, BR_DETAIL_FAR1, max( length( brcDx ), length( brcDy ) ) * BR_DETAIL_RES );
		if ( brcMu.b > 0.0 && brcNear > 0.0 && uBrReflPass < 0.5 ) {
			float brcT = textureGrad( uBrDetail, vec3( brcDu, BRC_DET_SLAB ), brcDx, brcDy ).b;
			float brcAm2 = mix( 1.0, brcT / brcMu.b, brcNear );
			brA *= mix( 1.0, brcAm2, 0.6 );
			brOrmh.g = clamp( brOrmh.g + 0.3 * ( 1.0 - brcAm2 ), 0.02, 1.0 );
		}
#endif
	}
#endif
`,
  postDetail: '',
  grime: /* glsl */ `
	else if ( brGrime == BR_G_CONCRETE ) {
		// concrete: floors: oil (glossy) and grime, the slab system (joints, spalls, pours, cracks), traffic lanes,
		// finish classes; walls and soffits: matte dust and soot, per-sheet world tone, damp, efflorescence, tie-hole rust
		float oil = smoothstep( 0.55, 0.8, g1.b * 0.6 + brMask.g * 0.7 );
		float brcDirt = clamp( brMask.g * ( 0.4 + g2.g ), 0.0, 1.0 ) * 0.8;
		bool brcUp = brNWg.y > 0.5;
		if ( brcUp ) {
			oil = max( oil, brBlotch( brS2, true, 311u, 0.18, 0.15, 0.45, ( g2.b - 0.5 ) * 0.6 ) * 0.8 );
			brA *= mix( vec3( 1.0 ), vec3( 0.5, 0.48, 0.46 ), oil * 0.65 );
			brA *= mix( vec3( 1.0 ), vec3( 0.62, 0.58, 0.52 ), brcDirt );
			brRoughMul *= mix( 1.0, 0.7, oil );
		} else {
			// oil only drips onto floors: on walls and soffits the same fields are dust and soot (matte, a little darker
			// and warmer, never glossier)
			float soot = clamp( oil * 0.65 + brcDirt, 0.0, 1.0 );
			brA *= mix( vec3( 1.0 ), vec3( 0.7, 0.67, 0.62 ), soot * 0.85 );
			brRoughMul *= mix( 1.0, 1.1, soot );
			if ( brL == BR_M_CONCRETE_WALL || brL == BRC_M_CONCRETE_CEIL ) {
				// every form sheet its own tone and sheen (world 1.2 x 1.5 m sheets on walls, 1.2 x 2.4 m on soffits): the
				// texture's 2.4 m repeat would show as ABAB
				bool brcVert = ! brHoriz;
				vec2 brcSheet = brcVert ? vec2( 1.2, 1.5 ) : vec2( 1.2, 2.4 );
				ivec2 brcSp = brcVert ? ivec2( int( BR_NOISE_WRAP / 1.2 + 0.5 ), int( BR_PITCH / 1.5 + 0.5 ) ) : ivec2( int( BR_NOISE_WRAP / 1.2 + 0.5 ), int( BR_NOISE_WRAP / 2.4 + 0.5 ) );
				uint brcSh = brHash2u( brWrap( ivec2( floor( brS2 / brcSheet ) ), brcSp ), brcVert ? 1709u : 1721u );
				brA *= 1.0 + 0.1 * ( brU01( brcSh ) - 0.5 );
				brRoughMul *= mix( 0.9, 1.1, brU01( brPcg( brcSh ) ) );
			}
		}
		if ( brL == BR_M_CONCRETE_FLOOR && brcUp ) {
			// finish class per room (the FLOOR_AUX region key): sealed / densified and burnished (35 %: glossier, the
			// trowel swirl stronger), plain troweled (45 %), dusty (20 %: paler, rougher, the fines hidden)
			float brcSeal = 0.0, brcDust = 0.0;
			if ( ( brF & BR_F_FLOOR_AUX ) != 0 ) {
				float u = brU01( brPcg( uint( brAuxB.y + 256.0 * brAuxB.z ) * 2654435761u + 911u ) );
				brcSeal = step( u, 0.35 );
				brcDust = step( 0.8, u );
			}
			brRoughMul *= mix( 1.0, 0.6, brcSeal ) * mix( 1.0, 1.3, brcDust );
			brA *= mix( 1.0, 0.95, brcSeal ) * mix( 1.0, 1.06, brcDust );
			brOrmh.g -= 0.04 * brAux * brcSeal;
			// traffic lanes (mask A): rubber and fines burnish the paste into darker, glossier lanes that expose the sand
			// and carry micro-scratches; dust gathers along their edges
			float brcW = smoothstep( 0.25, 0.75, brMask.a + 0.3 * ( g1.b - 0.5 ) );
			brRoughMul *= mix( 1.0, 0.62, brcW );
			brA *= mix( vec3( 1.0 ), 0.88 * vec3( 1.0, 0.97, 0.93 ), brcW );
			float brcEdge = smoothstep( 0.1, 0.18, brcW ) * ( 1.0 - smoothstep( 0.28, 0.38, brcW ) );
			brA *= 1.0 + 0.04 * brcEdge;
			brRoughMul *= 1.0 + 0.12 * brcEdge;
#if defined( BR_DETAIL_MAPS ) && ! defined( BR_DECAL )
			float brcDk = ( 1.0 + 0.6 * brcW ) * mix( 1.0, 0.7, brcDust ); // detail strength relative to the layer's
			brA *= 1.0 + ( brAm - 1.0 ) * brDetL.y * ( brcDk - 1.0 );
			brDetSl *= brcDk;
			brDetVar *= ( 1.0 + 1.5 * brcW ) * mix( 1.0, 0.5, brcDust );
#endif
			// joints, pours and cracks belong to the slab (the FLOOR_AUX floor faces), not to stair treads and block tops
			bool brcSlabOn = ( brF & BR_F_FLOOR_AUX ) != 0;
			if ( brcSlabOn && BR_DETAIL == 1 && uBrReflPass < 0.5 ) {
				brcSlab( brS2, false, brA, brRoughMul, brNrm, brNLen, brOrmh );
			} else if ( brcSlabOn ) {
				// low quality and the planar mirror pass: the joints as their mean darkening only
				vec2 brcJd = abs( fract( brS2 / BR_CONCRETE_JOINT + 0.5 ) - 0.5 ) * BR_CONCRETE_JOINT;
				vec2 brcFw = max( fwidth( brS2 ), vec2( 1e-4 ) );
				vec2 brcLn = clamp( 2.0 * BRC_KERF_HW / brcFw, 0.0, 1.0 ) * ( 1.0 - smoothstep( vec2( BRC_KERF_HW ), BRC_KERF_HW + brcFw, brcJd ) );
				brA *= 1.0 - 0.7 * max( brcLn.x, brcLn.y );
			}
		} else if ( brL == BR_M_CONCRETE_FLOOR ) {
			// risers and tower faces: no power trowel ever ran there (ormh.a holds the swirl)
			brOrmh.g += 0.08 * brAux;
			brA /= 1.0 - 0.03 * brAux;
		}
		if ( ! brHoriz ) {
			// rising damp: a gradual darkening with a diffuse, ragged fringe (the tide field perturbed at 0.3 m and by the
			// grime texture), and efflorescence: a patchy crystalline bloom concentrated at the drying front, raised and
			// matte, fading in streaks down the damp area
			float brcN = brSurfNoise( brS2, false, 0.3, int( BR_NOISE_WRAP / 0.3 + 0.5 ), 0.3, int( BR_PITCH / 0.3 + 0.5 ), 1733u );
			float s = brMask.r + ( ( g1.r - 0.5 ) * 0.25 + ( brcN - 0.5 ) * 0.08 ) * step( 0.02, brMask.r );
			float damp = smoothstep( 0.38, 0.52, s );
			float brcSpk = 0.0; // the detail map's speckle breaks the bloom into crystals
#if defined( BR_DETAIL_MAPS ) && ! defined( BR_DECAL )
			brcSpk = brAm - 1.0;
#endif
			float brcFd = ( s - 0.47 ) / 0.03;
			float front = exp( - brcFd * brcFd ) * smoothstep( 0.4, 0.8, g2.g + 0.3 * brcSpk ) * step( 0.02, brMask.r );
			brA *= mix( 1.0, 0.78, damp );
			float eff = clamp( front + damp * smoothstep( 0.5, 0.8, g1.a ) * 0.6, 0.0, 1.0 );
			brA = mix( brA, vec3( 0.72, 0.71, 0.68 ), eff * 0.6 );
			brRoughMul *= mix( 1.0, 1.2, eff );
			brNrm.xy += 0.15 * ( g2.gb - 0.5 ) * eff * brNrm.z;
			if ( brL == BR_M_CONCRETE_WALL ) {
				// rust bleeding from some formwork tie holes (holes at along = 0.3 + 0.6 k, y = 0.375 + 0.75 k)
				float hx = ( floor( ( brS2.x - 0.3 ) / 0.6 + 0.5 ) ) * 0.6 + 0.3;
				float hy = ceil( ( brS2.y - 0.375 ) / 0.75 ) * 0.75 + 0.375;
				uint hh = brHash2u( brWrap( ivec2( int( floor( hx / 0.6 ) ), int( floor( hy / 0.75 ) ) ), ivec2( int( BR_NOISE_WRAP / 0.6 + 0.5 ), 4 ) ), 719u );
				float dy = hy - brS2.y;
				float L = 0.15 + 0.6 * brU01( brPcg( hh ) );
				float w = 0.008 + 0.03 * dy / L;
				float rs = step( brU01( hh ), 0.35 ) * exp( - ( brS2.x - hx ) * ( brS2.x - hx ) / ( w * w ) ) * ( 1.0 - smoothstep( 0.2, 1.0, dy / L ) ) * step( 0.01, dy );
				rs *= 0.5 + 0.5 * g1.a;
				brA = mix( brA, vec3( 0.32, 0.16, 0.07 ), rs * 0.6 );
			}
		}
	}
`,
  postWet: /* glsl */ `
#ifdef BR_DECAL
	if ( brL == BR_M_FLOOR_PAINT && brNWg.y > 0.5 ) {
		// floor-paint stripes carry NO_GRIME (no dirt profile of their own) but get wet with the slab under them: the
		// same wetness, film and standing water as the concrete profile (a sealed film: little darkening, an early film)
		vec4 brcG2 = texture( uBrGrime, brS2 / BR_GRIME_B + 0.37 );
		float brcRaw = brMask.b + ( brcG2.r - 0.5 ) * 0.3;
		brWet = smoothstep( 0.22, 0.62, brcRaw );
		brSoak = clamp( brcRaw, 0.0, 1.0 );
		float brcAbs = smoothstep( 0.0, 0.6, brWet ) * brPor;
		brA *= 1.0 - BR_WET_DARK * brcAbs;
		brA = max( mix( vec3( brLuma( brA ) ), brA, 1.0 + BR_WET_SAT * brcAbs ), vec3( 0.0 ) );
		brFilm = smoothstep( 0.3 + 0.55 * brPor, 0.6 + 0.35 * brPor, brSoak ) * brAir;
#ifdef BR_PUDDLES
		float brcLvl = mix( BR_PUDDLE_LO, BR_PUDDLE_HI, smoothstep( BR_PUDDLE_W0, BR_PUDDLE_W1, brSoak ) );
		brPuddle = smoothstep( 0.0, BR_PUDDLE_EDGE, brcLvl ) * smoothstep( BR_PUDDLE_W0, BR_PUDDLE_W0 + 0.05, brSoak ) * brAir;
		brA *= mix( vec3( 1.0 ), BR_PUDDLE_TINT, brPuddle * min( 2.0 * brPor, 1.0 ) );
#endif
		brNrmScale *= ( 1.0 - BR_SOAK_FLAT * brFilm * brPor ) * ( 1.0 - brPuddle );
		brNLen = mix( brNLen, 1.0, brPuddle );
		brRoughTo = mix( BR_WET_FILM_ROUGH + BR_WET_FILM_ROUGH_POROUS * brPor, BR_PUDDLE_ROUGH, brPuddle );
		brRoughToW = max( brFilm, brPuddle );
	}
#else
	if ( brL == BRC_M_TERRAZZO && brNWg.y > 0.5 ) {
		// polished terrazzo: traffic lanes (mask A) lose the polish (rougher, greyer, micro-scratched: the rough lobe covers
		// more of them, FRAG_ROUGHNESS family hook); along the walls (mask G) the polish survives under yellowed wax
		float brcTw = smoothstep( 0.25, 0.75, brMask.a );
		brRoughMul *= mix( 1.0, 3.5, brcTw );
		brA *= mix( 1.0, 0.95, brcTw );
		float brcWax = smoothstep( 0.1, 0.5, brMask.g ) * ( 1.0 - brcTw );
		brA *= mix( vec3( 1.0 ), vec3( 1.0, 0.96, 0.86 ) * 0.95, brcWax );
#ifdef BR_DETAIL_MAPS
		brDetVar *= 1.0 + 3.0 * brcTw;
#endif
	}
#endif
`,
  rough: /* glsl */ `
#ifndef BR_DECAL
	if ( brL == BRC_M_TERRAZZO && brNWg.y > 0.5 ) brCov = clamp( brCov + 0.4 * smoothstep( 0.25, 0.75, brMask.a ), 0.0, 1.0 );
#endif
`,
  normal: '',
  matPost: '',
  postLight: '',
  preFog: '',
};
