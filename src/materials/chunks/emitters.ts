// src/materials/chunks/emitters.ts — graphics-realism C.2/C.3: luminaire and prop-emitter profiles (brEmitterShape:
// PRISM, LOUVER, OPAL recessed lenses; DROP, TUBE, BULB, HIGHBAY, SODIUM prop emitters). The GLSL twin of
// core/emitterProfile.ts emitterShape(): constants and the nadir-normalised EP_NORM table come from there, and the
// maths follows it line for line. Compiled only under BR_DETAIL == 1 (medium / high / ultra); low keeps the
// texture-mask emission. ALU only (no textures); only emitter fragments pay.

import {
  AGED_TINT, BULB, CATHODE_TINT, DROP, EP, EP_NORM, EP_NORM_SCALAR, HIGHBAY, LAMP, LENS_TILE, LOUVER, OPAL, PRISM, SODIUM,
  TUBE,
} from '../../core/emitterProfile.ts';
import { LightState } from '../../core/ids.ts';
import { f } from './params.ts';

const v3 = (a: readonly number[]): string => `vec3( ${f(a[0])}, ${f(a[1])}, ${f(a[2])} )`;
const defs = (prefix: string, o: Readonly<Record<string, number>>): string =>
  Object.entries(o).map(([k, v]) => `#define ${prefix}${k} ${f(v)}`).join('\n');
const norm = (): string => {
  const rows: string[] = [];
  for (let i = 0; i < EP_NORM.length; i += 16) rows.push('\t' + EP_NORM.slice(i, i + 16).map((v) => f(v)).join(', '));
  return rows.join(',\n');
};

/** Appended to the fragment common block. */
export const EMITTER_GLSL = /* glsl */ `
// ---- emitter profiles (package C)
#if BR_DETAIL == 1
#define BR_EP_PRISM ${EP.PRISM}
#define BR_EP_LOUVER ${EP.LOUVER}
#define BR_EP_OPAL ${EP.OPAL}
#define BR_EP_DROP ${EP.DROP}
#define BR_EP_TUBE ${EP.TUBE}
#define BR_EP_BULB ${EP.BULB}
#define BR_EP_HIGHBAY ${EP.HIGHBAY}
#define BR_EP_SODIUM ${EP.SODIUM}
#define BR_EP_DYING ${LightState.DYING}
#define BR_LENS_TILE ${f(LENS_TILE)}
${defs('BR_PR_', PRISM)}
${defs('BR_LV_', LOUVER)}
${defs('BR_OP_', OPAL)}
${defs('BR_LP_', LAMP)}
${defs('BR_TB_', TUBE)}
${defs('BR_BU_', BULB)}
${defs('BR_HB_', HIGHBAY)}
${defs('BR_DR_', DROP)}
${defs('BR_SO_', SODIUM)}
#define BR_HB_NORM ${f(EP_NORM_SCALAR.HIGHBAY)}
#define BR_SO_NORM ${f(EP_NORM_SCALAR.SODIUM)}
#define BR_AGED_TINT ${v3(AGED_TINT)}
#define BR_CATHODE ${v3(CATHODE_TINT)}
// 1 / nadir lens mean per (PRISM | LOUVER, lamps 2..4, La 1..4, Wx 1..4 tiles), then OPAL (La, Wx)
const float BR_EP_NORM[ ${EP_NORM.length} ] = float[ ${EP_NORM.length} ](
${norm()}
);

float brEpRand( float seed8, int k ) { return brU01( brPcg( uint( int( seed8 + 0.5 ) & 255 ) + uint( k ) * 256u + 12061u ) ); }
float brEpGauss( float x, float s ) { float q = x / s; return exp( - 0.5 * q * q ); }
float brEpNoise( float x, float seed8 ) {
	float i = floor( x );
	float fr = x - i;
	int ii = int( i ) + 4096;
	float a = brEpRand( seed8, 64 + ( ii & 1023 ) );
	float b = brEpRand( seed8, 64 + ( ( ii + 1 ) & 1023 ) );
	return a + ( b - a ) * fr * fr * ( 3.0 - 2.0 * fr );
}
float brEpNorm( int ep, int n, float La, float Wx ) {
	int li = clamp( int( La / BR_LENS_TILE + 0.5 ), 1, 4 ) - 1;
	int wi = clamp( int( Wx / BR_LENS_TILE + 0.5 ), 1, 4 ) - 1;
	int i = ep == BR_EP_OPAL ? 96 + li * 4 + wi : ( ( ( ep == BR_EP_LOUVER ? 3 : 0 ) + clamp( n, 2, 4 ) - 2 ) * 4 + li ) * 4 + wi;
	return BR_EP_NORM[ i ];
}
// prismatic lens luminance vs the nadir (A12 fit: 1.03 at 45, .9 at 65, .76 at 75, .5 at 85 deg)
float brPrismAngular( float vz ) { return pow( vz, 0.3 ) * ( 1.0 + 0.7 * vz * ( 1.0 - vz ) ); }

// lamp set of a multi-lamp luminaire: gains (renormalised to mean 1), warm / cool casts, end blackening, cathode
// glow. DYING: one bad lamp follows the shimmer (dipping to dark) and glows at its ends; the others carry the rest.
struct BrLamps { int n; bool uTube; vec4 g; vec4 c; vec4 eb; vec4 glow; };
BrLamps brLampSet( float seed8, int n, bool uTube, bool dying, float sh ) {
	BrLamps L;
	L.n = n; L.uTube = uTube; L.g = vec4( 0.0 ); L.c = vec4( 0.0 ); L.eb = vec4( 0.0 ); L.glow = vec4( 0.0 );
	float sum = 0.0;
	for ( int k = 0; k < 4; k ++ ) {
		if ( k >= n ) break;
		int id = uTube ? k / 2 : k;
		float g = BR_LP_GAIN0 + BR_LP_GAIN_VAR * brEpRand( seed8, id );
		if ( n >= 3 && ! uTube && brEpRand( seed8, id + 8 ) < BR_LP_DEAD_P ) g = BR_LP_DEAD;
		L.g[ k ] = g;
		sum += g;
		L.c[ k ] = 2.0 * brEpRand( seed8, id + 16 ) - 1.0;
		float e = brEpRand( seed8, id + 24 );
		L.eb[ k ] = BR_LP_EB * e * e;
	}
	L.g *= float( n ) / sum;
	if ( dying ) {
		int ids = uTube ? n / 2 : n;
		int bad = ( int( seed8 + 0.5 ) & 255 ) % ids;
		float gb = clamp( 1.0 + 3.0 * ( sh - 1.0 ), 0.0, 1.3 ) * BR_LP_BAD_GAIN;
		float go = ( float( ids ) - BR_LP_BAD_GAIN ) / float( ids - 1 );
		for ( int k = 0; k < 4; k ++ ) {
			if ( k >= n ) break;
			if ( ( uTube ? k / 2 : k ) == bad ) { L.g[ k ] *= gb; L.glow[ k ] = BR_LP_GLOW_DYING; }
			else L.g[ k ] *= go;
		}
	}
	return L;
}

// lamp images at along-position a (m) for the across offsets x + dk, x - dk, x (rowP, rowM, row0); lamps across at
// pitch, glowing over La - 2 endIn (ends smeared by endS). U-tubes (2x2): legs pair up and bend at +a. shadow: the
// silhouette of weak lamps against the reflector. Returns the cathode-end mask.
float brLampRows( BrLamps L, float a, float x, float dk, float sig, float La, float pitch, float endIn, float endS, out vec3 rowP, out vec3 rowM, out vec3 row0, out float shadow ) {
	rowP = vec3( 0.0 ); rowM = vec3( 0.0 ); row0 = vec3( 0.0 );
	shadow = 0.0;
	float endMask = 0.0;
	float r = 0.5 * pitch;
	float aB = 0.5 * La - endIn - r;
	for ( int k = 0; k < 4; k ++ ) {
		if ( k >= L.n ) break;
		float xk = ( float( k ) + 0.5 - 0.5 * float( L.n ) ) * pitch;
		float ea = L.uTube ? 0.5 * La - endIn + a : 0.5 * La - endIn - abs( a );
		float endF = smoothstep( - 0.01 - endS, 0.03 + endS, ea );
		float eF = endF * ( 1.0 - L.eb[ k ] * exp( - max( ea, 0.0 ) / BR_LP_EB_W ) );
		float gl = endF * exp( - max( ea, 0.0 ) / BR_LP_GLOW_W );
		float gp; float gm; float g0;
		if ( L.uTube && a > aB ) {
			if ( ( k & 1 ) == 1 ) continue; // the pair's bend is evaluated once, from its first leg
			float xc = xk + r;
			gp = brEpGauss( abs( length( vec2( a - aB, x + dk - xc ) ) - r ), sig );
			gm = brEpGauss( abs( length( vec2( a - aB, x - dk - xc ) ) - r ), sig );
			g0 = brEpGauss( abs( length( vec2( a - aB, x - xc ) ) - r ), sig );
		} else {
			gp = brEpGauss( x + dk - xk, sig );
			gm = brEpGauss( x - dk - xk, sig );
			g0 = brEpGauss( x - xk, sig );
		}
		float w = L.g[ k ] * eF;
		vec3 lc = w * vec3( 1.0 + BR_LP_CAST * L.c[ k ], 1.0, 1.0 - BR_LP_CAST * L.c[ k ] ) + L.glow[ k ] * gl * BR_CATHODE;
		rowP += gp * lc;
		rowM += gm * lc;
		row0 += g0 * lc;
		endMask += g0 * gl;
		shadow += max( 0.0, 1.0 - L.g[ k ] ) * g0 * endF;
	}
	return endMask;
}

// recessed lens frame: (a, x) = along / across the lamps from the lens centre (m); La / Wx = lens extents; (va, vx,
// vz) = view vector toward the camera; (pa, px) = lens metres from its corner (pyramid lattice)
struct BrLens { float a; float x; float La; float Wx; float va; float vx; float vz; float dEdge; float pa; float px; int n; bool aged; bool uTube; };
BrLens brLensFrame( int A, int variant, vec2 uv, vec3 Vt ) {
	BrLens F;
	int U = ( A & 7 ) + 1;
	int V = ( ( A >> 3 ) & 7 ) + 1;
	bool along = ( ( A >> 6 ) & 1 ) == 0;
	vec2 sz = vec2( float( U ), float( V ) ) * BR_LENS_TILE;
	vec2 p = uv * BR_LENS_TILE;
	vec2 c = p - 0.5 * sz;
	F.dEdge = min( 0.5 * sz.x - abs( c.x ), 0.5 * sz.y - abs( c.y ) );
	F.n = min( ( variant & 3 ) + 2, 4 );
	F.aged = ( variant & 4 ) != 0;
	F.uTube = F.n == 4 && U == V;
	F.a = along ? c.x : c.y;
	F.x = along ? c.y : c.x;
	F.La = along ? sz.x : sz.y;
	F.Wx = along ? sz.y : sz.x;
	F.va = along ? Vt.x : Vt.y;
	F.vx = along ? Vt.y : Vt.x;
	F.vz = max( Vt.z, 0.02 );
	F.pa = along ? p.x : p.y;
	F.px = along ? p.y : p.x;
	return F;
}

// PRISM: lamps D above a lens of 4 mm pyramids. The lamp plane is seen through the lens with parallax; a facet
// tilted across the lamps shows it shifted by D KAPPA. Near: per-facet sparkle (coverage anti-aliased by the
// footprint); far: the 4-image mean, so the lattice never aliases.
vec3 brPrism( BrLens F, BrLamps L, float fp, out float endMask ) {
	float ba = F.a - BR_PR_D * F.va / F.vz;
	float bx = F.x - BR_PR_D * F.vx / F.vz;
	float sig = sqrt( BR_PR_SIGMA * BR_PR_SIGMA + BR_PR_FACET_S * BR_PR_FACET_S + fp * fp );
	float pitch = ( F.Wx - BR_PR_CLEAR ) / float( F.n );
	vec3 rP; vec3 rM; vec3 r0; float shadow;
	endMask = brLampRows( L, ba, bx, BR_PR_D * BR_PR_KAPPA, sig, F.La, pitch, BR_PR_END_IN, BR_PR_END_S, rP, rM, r0, shadow );
	// area-normalised: the footprint blur spreads the lamp images without adding energy
	float amp = sqrt( BR_PR_SIGMA * BR_PR_SIGMA + BR_PR_FACET_S * BR_PR_FACET_S ) / sig;
	rP *= amp; rM *= amp; r0 *= amp; endMask *= amp;
	// facet coverage = product of the two half-plane coverages: tends to the facet's true share (1/4) when blurred
	float qa = fract( F.pa / BR_PR_PITCH ) - 0.5;
	float qx = fract( F.px / BR_PR_PITCH ) - 0.5;
	float fq = max( fp / BR_PR_PITCH, 1e-3 );
	vec4 hp = smoothstep( vec4( - fq ), vec4( fq ), vec4( qx - qa, qx + qa, - qx - qa, - qx + qa ) * 0.7071 );
	float wP = hp.x * hp.y;
	float wM = hp.z * hp.w;
	float far = smoothstep( BR_PR_FAR0, BR_PR_FAR1, fq );
	float xb = clamp( bx / ( 0.5 * F.Wx ), - 1.0, 1.0 );
	float bg = BR_PR_BG * ( 1.0 - BR_PR_BG_FALL * xb * xb ) * dot( L.g, vec4( 1.0 ) ) / float( F.n ) * ( 1.0 - BR_LP_SHADOW * min( shadow, 1.0 ) );
	vec3 lf = wP * rP + wM * rM + ( 1.0 - wP - wM ) * r0;
	vec3 l4 = 0.25 * ( rP + rM ) + 0.5 * r0;
	float k = mix( BR_PR_CAV, 1.0, smoothstep( 0.0, BR_PR_CAV_W, F.dEdge ) ) * brPrismAngular( F.vz );
	endMask *= k;
	return ( bg + BR_PR_BAND * mix( lf, l4, far ) ) * k;
}

// LOUVER: parabolic aluminium cells H deep. Through a cell's top opening: the reflector and the lamp over that cell
// column; past the cutoff the ray hits a blade: dark (it mirrors the room) except a glint along its top edge; the
// blades' 3 mm bottom edges draw the cell grid.
vec3 brLouver( BrLens F, BrLamps L, float fp, out float endMask ) {
	fp += 1e-4;
	float ca = max( 1.0, floor( F.La / BR_LV_CELL + 0.5 ) );
	float cx = max( 1.0, floor( F.Wx / BR_LV_CELL + 0.5 ) );
	float csa = F.La / ca;
	float csx = F.Wx / cx;
	float pca = fract( ( F.a + 0.5 * F.La ) / csa ) * csa;
	float pcx = fract( ( F.x + 0.5 * F.Wx ) / csx ) * csx;
	float da = F.va / F.vz;
	float dx = F.vx / F.vz;
	float ta = pca - BR_LV_H * da;
	float tx = pcx - BR_LV_H * dx;
	float vis = smoothstep( - fp, fp, ta ) * smoothstep( - fp, fp, csa - ta ) * smoothstep( - fp, fp, tx ) * smoothstep( - fp, fp, csx - tx );
	float sig = sqrt( BR_LV_SIGMA * BR_LV_SIGMA + fp * fp );
	vec3 rP; vec3 rM; vec3 r0; float shadow;
	endMask = brLampRows( L, F.a - ( BR_LV_H + BR_LV_D ) * da, F.x - ( BR_LV_H + BR_LV_D ) * dx, 0.0, sig, F.La, F.Wx / float( F.n ), BR_PR_END_IN, 0.0, rP, rM, r0, shadow );
	float amp = BR_LV_SIGMA / sig;
	r0 *= amp; endMask *= amp;
	float wa = - da > 0.0 ? csa - pca : pca;
	float wx = - dx > 0.0 ? csx - pcx : pcx;
	float hh = min( wa / max( abs( da ), 1e-4 ), wx / max( abs( dx ), 1e-4 ) );
	float spec = smoothstep( BR_LV_BLADE_V0, BR_LV_BLADE_V1, F.vz );
	// the glint band is sub-pixel at distance: widened by the footprint in blade-height units, energy kept
	float glw = length( vec2( BR_LV_GLINT_W, fp / max( length( vec2( da, dx ) ), 1e-3 ) ) );
	float gl = ( BR_LV_H - hh ) / glw;
	float glint = BR_LV_GLINT * ( BR_LV_GLINT_W / glw ) * exp( - gl * gl ) * smoothstep( 0.1, 0.3, F.vz ) * ( 1.0 - spec );
	float blade = BR_LV_BLADE * spec + BR_LV_BLADE_MIN + glint;
	float hw = 0.5 * BR_LV_BLADE_T;
	float cov = clamp( BR_LV_BLADE_T / fp, 0.0, 1.0 );
	float edge = cov * ( 1.0 - smoothstep( hw, hw + fp, min( min( pca, csa - pca ), min( pcx, csx - pcx ) ) ) );
	float gm = dot( L.g, vec4( 1.0 ) ) / float( F.n );
	vec3 lamp = BR_LV_REFL * gm + BR_LV_LAMP * r0;
	endMask *= vis;
	return mix( vec3( blade * gm ), lamp, vis ) * ( 1.0 - BR_LV_EDGE * edge );
}

// OPAL: sky-panel diffuser, slightly hot centre, faint LED grid (fades out before it could alias), rim shade
float brOpal( BrLens F, vec2 uv, float fp ) {
	float rn = F.a / ( 0.5 * F.La );
	float rx = F.x / ( 0.5 * F.Wx );
	float r2 = 0.5 * ( rn * rn + rx * rx );
	vec2 p = uv * BR_LENS_TILE;
	float dots = BR_OP_DOT * cos( 6.2831853 * p.x / BR_OP_DOT_PITCH ) * cos( 6.2831853 * p.y / BR_OP_DOT_PITCH ) * ( 1.0 - smoothstep( 0.25, 0.8, fp / BR_OP_DOT_PITCH ) );
	return ( 1.0 + BR_OP_HOT * ( 1.0 - r2 ) ) * ( 1.0 + dots ) * mix( BR_OP_CAV, 1.0, smoothstep( 0.0, BR_OP_CAV_W, F.dEdge ) ) * ( 1.0 - BR_OP_ANG + BR_OP_ANG * F.vz );
}

float brTubeAlongMean( float Lm, float eb ) {
	float h = 0.5 * Lm;
	float run = max( h - BR_TB_CAP, 1e-3 );
	return ( BR_TB_CAP * BR_TB_CAP_L + run - eb * BR_TB_EB_W * ( 1.0 - exp( - run / BR_TB_EB_W ) ) ) / h;
}

// Relative luminance of profile ep (multiplies vBrEmit * tint). variant / param: aux.z bits 5-7 / aux.x;
// seed8: tint.a * 255; uv: material uv; Vt: view vector toward the camera in the emitter's (u, v, n) frame;
// fpUv: pixel footprint in uv units; dyn / sh: live flicker intensity / lens shimmer.
vec3 brEmitterShape( int ep, int variant, int param, float seed8, vec2 uv, vec3 Vt, float fpUv, float t, int state, float dyn, float sh, bool dynEmit, bool shimmer ) {
	vec3 L = vec3( 1.0 );
	float endMask = 0.0;
	bool dying = shimmer && state == BR_EP_DYING;
	if ( ep <= BR_EP_OPAL ) {
		BrLens F = brLensFrame( param, variant, uv, Vt );
		float fp = fpUv * BR_LENS_TILE;
		if ( ep == BR_EP_OPAL ) L = vec3( brOpal( F, uv, fp ) );
		else if ( ep == BR_EP_PRISM ) L = brPrism( F, brLampSet( seed8, F.n, F.uTube, dying, sh ), fp, endMask );
		else L = brLouver( F, brLampSet( seed8, F.n, false, dying, sh ), fp, endMask );
		float nrm = brEpNorm( ep, F.n, F.La, F.Wx );
		L *= nrm;
		endMask *= nrm;
		if ( F.aged ) L *= mix( vec3( 1.0 ), BR_AGED_TINT, 0.5 * brEpRand( seed8, 9 ) );
	} else if ( ep == BR_EP_TUBE ) {
		// bare T8: limb brightening, phosphor noise, electrode caps, blackened ends (normalised per tube)
		float Lm = max( float( param ), 10.0 ) * 0.01;
		float a = uv.y * Lm;
		float e = 0.5 * Lm - abs( a );
		float mu = abs( Vt.z );
		float r = brEpRand( seed8, 40 + variant );
		float eb = BR_LP_EB * r * r;
		float l = ( 1.0 - BR_TB_LIMB / 3.0 + BR_TB_LIMB * ( 1.0 - mu * mu ) ) * ( 1.0 + BR_TB_NOISE * ( 2.0 * brEpNoise( a / BR_TB_NOISE_CELL, float( ( int( seed8 + 0.5 ) + 37 * variant ) & 255 ) ) - 1.0 ) );
		l *= e < BR_TB_CAP ? BR_TB_CAP_L : 1.0 - eb * exp( - ( e - BR_TB_CAP ) / BR_TB_EB_W );
		l /= brTubeAlongMean( Lm, eb );
		endMask = e < BR_TB_CAP ? 0.0 : exp( - ( e - BR_TB_CAP ) / BR_TB_GLOW_W );
		vec3 glow = vec3( 0.0 );
		if ( dying && ( int( seed8 + 0.5 ) & 1 ) == ( variant & 1 ) ) {
			// the pair's bad tube: striations crawling along it, dips with the shimmer, orange-pink cathodes
			l *= 1.0 + BR_TB_STRIA * sin( 6.2831853 * ( a / BR_TB_STRIA_L - fract( BR_TB_STRIA_V * t ) ) + seed8 );
			l *= clamp( 1.0 + 3.0 * ( sh - 1.0 ), 0.0, 1.3 );
			glow = BR_TB_GLOW * endMask * BR_CATHODE;
		}
		L = vec3( l ) + glow;
	} else if ( ep == BR_EP_BULB ) {
		float rho2 = clamp( 1.0 - Vt.z * Vt.z, 0.0, 1.0 );
		L = vec3( ( variant & 1 ) != 0
			? BR_BU_CLEAR0 + BR_BU_CLEAR1 * exp( - rho2 / ( 2.0 * BR_BU_CLEAR_S * BR_BU_CLEAR_S ) )
			: ( 1.0 + BR_BU_FROST * pow( 1.0 - rho2, 1.5 ) ) / ( 1.0 + BR_BU_FROST * 0.4 ) );
	} else if ( ep == BR_EP_HIGHBAY ) {
		// the arc lamp sits LAMP_H disk radii above the disk: its image slides away from the viewer and the bell hides it
		float vz = max( Vt.z, 0.02 );
		vec2 cc = uv - BR_HB_LAMP_H * Vt.xy / vz;
		float rho = length( uv );
		float dr = ( rho - BR_HB_RING_R ) / BR_HB_RING_S;
		L = vec3( ( BR_HB_BASE + BR_HB_CORE * exp( - dot( cc, cc ) / ( 2.0 * BR_HB_CORE_S * BR_HB_CORE_S ) ) + BR_HB_RING * exp( - 0.5 * dr * dr ) ) * BR_HB_NORM );
	} else if ( ep == BR_EP_DROP ) {
		float len = max( float( param ), 10.0 ) * 0.01;
		float cc = cos( 1.5707963 * ( 2.0 * uv.y - 1.0 ) );
		float ends = smoothstep( 0.0, BR_DR_END_W, min( uv.x, 1.0 - uv.x ) * len );
		L = vec3( ( 1.0 + BR_DR_CENTRE * cc * cc ) * ends * ( 1.0 - BR_DR_ANG + BR_DR_ANG * max( Vt.z, 0.0 ) ) / ( ( 1.0 + 0.5 * BR_DR_CENTRE ) * ( 1.0 - BR_DR_END_W / len ) ) );
	} else if ( ep == BR_EP_SODIUM ) {
		float xn = 2.0 * uv.y - 1.0;
		L = vec3( ( BR_SO_BASE + BR_SO_ARC * brEpGauss( xn, BR_SO_SIGMA ) * ( 1.0 - smoothstep( BR_SO_END0, BR_SO_END1, abs( uv.x - 0.5 ) ) ) ) * BR_SO_NORM );
	}
	// DYN_EMIT: the flicker channel drives the shape; a lamp that is out during a burst keeps pink-orange cathodes
	if ( dynEmit ) L = L * dyn + ( 1.0 - smoothstep( 0.08, 0.4, dyn ) ) * BR_LP_GLOW_FLICKER * endMask * BR_CATHODE;
	// the shimmer scales the whole emitter (BUZZ; DYING on single-lamp profiles); multi-lamp DYING is per lamp (above)
	if ( shimmer && ( ! dying || ! ( ep == BR_EP_PRISM || ep == BR_EP_LOUVER || ep == BR_EP_TUBE ) ) ) L *= sh;
	return L;
}

// OFF recessed lens (unlit, lit by the room): diffuse factor of the dark cavity with dead tubes behind the lens
float brOffLensShade( int ep, int param, int variant, vec2 uv, vec3 Vt, float fpUv ) {
	BrLens F = brLensFrame( param, variant, uv, Vt );
	BrLamps L;
	L.n = F.n; L.uTube = F.uTube; L.g = vec4( 1.0 ); L.c = vec4( 0.0 ); L.eb = vec4( 0.0 ); L.glow = vec4( 0.0 );
	float pitch = ep == BR_EP_LOUVER ? F.Wx / float( F.n ) : ( F.Wx - BR_PR_CLEAR ) / float( F.n );
	vec3 rP; vec3 rM; vec3 r0; float shadow;
	brLampRows( L, F.a - BR_PR_D * F.va / F.vz, F.x - BR_PR_D * F.vx / F.vz, 0.0, 0.018 + fpUv * BR_LENS_TILE, F.La, pitch, BR_PR_END_IN, BR_PR_END_S, rP, rM, r0, shadow );
	float s = ep == BR_EP_OPAL ? 0.0 : min( r0.g, 1.0 );
	return ( 0.5 + 0.3 * ( 1.0 - 0.6 * s ) ) * mix( 0.75, 1.0, smoothstep( 0.0, BR_PR_CAV_W, F.dEdge ) );
}
#endif
`;
