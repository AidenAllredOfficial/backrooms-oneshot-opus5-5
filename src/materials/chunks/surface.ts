// src/materials/chunks/surface.ts — fragment-stage surface chunks: fade, texture sampling with anti-tiling,
// macro variation, mask-driven grime, hashed world features, porosity-based wetness and puddles, prop dust, Toksvig
// and two-lobe (glaze) roughness, metalness, normal mapping and emission. Albedo/normal/ormh are sampled ONCE (in the
// map_fragment replacement) and stashed in main-scope variables, because in r186 roughnessmap_fragment runs before
// normal_fragment_maps. Main-scope outputs read later (chunks/materialPost.ts, debug views, packages D/E): brWet,
// brFilm, brPuddle, brDust, brCov, brWear, brPileLean, brTbn; POM state for chunks/pom.ts FRAG_DIRVIS_GLSL (brPomOn,
// brPomT/B/N, brPomRep, brPomDepth, brPomHitN, brPomK and the height lookup's brPomSalt / brPomLod); detail state
// (brDetUv, brDetSl, brDetVar, brAm).
// Detail maps (BR_DETAIL_MAPS, chunks/detail.ts) and POM (BR_POM, chunks/pom.ts) are package B's high / ultra paths.
// Texture realism v2: the texture channel decode at main scope (brAux, brAux2, brLean, brRotM, brRotC, brMuH, brRel;
// textures/layers/types.ts AuxKind), the family hook points (chunks/family/index.ts: postSample, postDetail, the
// grime profile branches, postWet, rough, normal), and 0b's per-layer controls: the detail repeat (BR_L_DETREP), the
// 'detailMask' strength and the detail tint (BR_L_DETTINT), and the relief-aware dirt / wear block after the grime
// chain (BR_L_DIRT / BR_L_WEAR, compiled in by BR_RELIEF_GRIME). Lanes edit their family files, not this one.

import { DecalKind } from '../../core/ids.ts';
import { familyHook } from './family/index.ts';

/** Texture-set uniforms (shared objects) + layer table; appended to the fragment common block. */
export const SURFACE_PARS_GLSL = /* glsl */ `
// BR_DETAIL 0 (quality low): skip the per-pixel world features (constant-folded away by the compiler)
#ifdef BR_LITE
#define BR_DETAIL 0
#else
#define BR_DETAIL 1
#endif
uniform sampler2DArray uBrAlbedo;
uniform sampler2DArray uBrNormal;
uniform sampler2DArray uBrOrmh;
uniform sampler2D uBrGrime;
uniform vec4 uBrLayerA[ BR_MAT_COUNT ];
uniform vec4 uBrLayerB[ BR_MAT_COUNT ];

// salt per tile and face axis: rotated physical tiles never straddle a tile (tileSize | repeat | TILE_SIZE),
// so a per-tile salt only decorrelates neighbours
uint brTileSalt( vec3 n ) {
	ivec2 t = ivec2( floor( uNoiseOrigin.xz / BR_TILE + 0.5 ) );
	vec3 a = abs( n );
	uint axis = a.y >= max( a.x, a.z ) ? ( n.y > 0.0 ? 1u : 2u ) : ( a.x > a.z ? 3u : 4u );
	return uint( t.x ) * 73856093u ^ uint( t.y ) * 19349663u ^ axis * 83492791u;
}
// rotated physical tiles: the texel uv of uv under its cell's hashed 90-degree rotation + flip (M acts in square cell
// space) and random cell offset. Shared by the main sampling and the POM height lookups (chunks/pom.ts brPomH), so the
// parallax march and the shading never drift apart
vec2 brRotUv( vec2 uv, vec2 cells, uint salt, out mat2 M, out int rotIdx ) {
	vec2 cu = uv * cells;
	vec2 cc = floor( cu );
	vec2 fr = cu - cc - 0.5;
	uint h = brHash2u( ivec2( cc ), salt );
	int rot = int( h & 3u );
	float flp = ( h & 4u ) != 0u ? - 1.0 : 1.0;
	vec2 cs = rot == 0 ? vec2( 1.0, 0.0 ) : rot == 1 ? vec2( 0.0, 1.0 ) : rot == 2 ? vec2( - 1.0, 0.0 ) : vec2( 0.0, - 1.0 );
	M = mat2( cs.x, cs.y, - cs.y, cs.x ) * mat2( flp, 0.0, 0.0, 1.0 );
	vec2 offs = floor( vec2( brU01( brPcg( h ) ), brU01( brPcg( h ^ 0x68bc21ebu ) ) ) * cells );
	rotIdx = rot + ( flp < 0.0 ? 4 : 0 );
	return ( cc + offs + 0.5 + M * fr ) / cells;
}
// texture realism v2 (main scope of FRAG_MAP_GLSL after the base sampling; see there): the layer's mean height and the
// relief above its mean plane in metres
#define brMuH ( textureLod( uBrNormal, vec3( 0.5, 0.5, brLayerF ), 16.0 ).a )
#define brRel ( ( brNrm.w - brMuH ) * uBrLayerC[ brL ].x )
bool brIsChalk( vec2 uv ) {
	ivec2 s = ivec2( clamp( uv * 4.0, vec2( 0.0 ), vec2( 3.999 ) ) );
	return s.x + 4 * s.y == ${DecalKind.CHALK_ARROW}; // DecalKind.CHALK_ARROW slot
}
`;

/** After `#include <clipping_planes_fragment>` (main start): dithered fade + props culling in the reflection pass. */
export const FRAG_MAIN_START_GLSL = /* glsl */ `
if ( uFade < 1.0 && brBayer4( gl_FragCoord.xy ) >= uFade ) discard;
#ifdef BR_PROPS
if ( uBrReflPass > 0.5 && length( vViewPosition ) > BR_REFL_PROP_DIST ) discard;
#endif
`;

/** Replaces `#include <map_fragment>`. */
export const FRAG_MAP_GLSL = /* glsl */ `
// ==== WP9 surface sampling
int brL = int( vBrLayer + 0.5 );
int brF = int( vBrFlags + 0.5 );
vec4 brAuxB = floor( vBrAux4 * 255.0 + 0.5 );
vec4 brLA = uBrLayerA[ brL ];
vec4 brLB = uBrLayerB[ brL ];
float brLayerF = float( brL );
vec3 brNWg = normalize( vBrNrmW );
bool brHoriz = brIsHoriz( brNWg );
// world-anchored lookup position: xz wrapped by the noise origin, y storey-relative (§2.2)
vec3 brPW = vec3( vBrLocal.x + uNoiseOrigin.x, vBrLocal.y, vBrLocal.z + uNoiseOrigin.z );
vec2 brS2 = brSurf2D( brPW, brNWg );
vec2 brUv = vBrUv;
vec2 brDx = dFdx( brUv );
vec2 brDy = dFdy( brUv );
#if defined( BR_DETAIL_MAPS ) && ! defined( BR_DECAL )
// detail maps: world-anchored on the shell, part-local metres on props. The shell uses the tile-local surface
// coordinate: the repeat divides TILE_SIZE (and STOREY_PITCH), so it is the same world pattern as brS2 / repeat, but
// in 0..64 instead of up to 4096 uv units (brS2 carries the wrapped noise origin, up to NOISE_WRAP). At 4096 a float
// resolves only ~1/4 of a detail texel, and the uv derivatives of the close-range cotangent frame were a third noise.
vec4 brDetL = uBrLayerD[ brL ]; // (detail layer, strength, sheen, sheen roughness)
#ifdef BR_PROPS
vec2 brDetUv = vBrUv * floor( brLB.x / BR_DETAIL_REPEAT + 0.5 );
#else
vec2 brDetUv = brSurf2D( vBrLocal, brNWg ) / BR_DETAIL_REPEAT;
#endif
vec2 brDetDx = dFdx( brDetUv );
vec2 brDetDy = dFdy( brDetUv );
// texture realism v2: the layer's detail repeat is BR_DETAIL_REPEAT x BR_L_DETREP (a divisor of the world periods)
float brDetRep = BR_L_DETREP[ brL ];
if ( brDetRep != 1.0 ) {
	brDetUv /= brDetRep;
	brDetDx /= brDetRep;
	brDetDy /= brDetRep;
}
vec2 brDetSl = vec2( 0.0 ); // resolved detail slope (m / m) for FRAG_NORMAL
float brDetVar = 0.0; // unresolved detail slope variance (LEAN) for FRAG_ROUGHNESS
float brAm = 1.0; // detail albedo multiplier over its layer mean (1 where no detail layer was fetched)
#endif
// wallpaper rolls (world-anchored 0.6 m strips): each roll is hung with its own vertical pattern offset (the print
// mismatches at the seams) and has its own shade / warmth (dye lot, fading)
bool brRoll = ! brHoriz && ( brL == BR_M_WALLPAPER_L0 || brL == BR_M_WALLPAPER_MANILA );
uint brRollH = 0u;
if ( brRoll ) {
	vec3 brAn = abs( brNWg );
	uint brOr = brAn.x > brAn.z ? ( brNWg.x > 0.0 ? 0u : 1u ) : ( brNWg.z > 0.0 ? 2u : 3u );
	brRollH = brHash2u( brWrap( ivec2( int( floor( brS2.x / BR_WALL_ROLL ) ), 0 ), ivec2( BR_WALL_ROLL_P, 1 ) ), 611u + brOr * 13u );
	brUv.y += ( brU01( brRollH ) - 0.5 ) * 0.06 / brLB.y;
}
#ifdef BR_POM
// ---- parallax occlusion mapping (pomTop layers on the shell: CMU, cast concrete, pool tile / mosaic, metal deck).
// The geometric face is the relief top (height pomTop): the view ray is marched down through the height field at
// <= BR_POM_PX_PER_STEP pixels per step, then refined by one secant step, and only the texture lookup moves (depth,
// discards and silhouettes stay those of the flat face, as in DepthMaterial). brDx / brDy stay the unshifted
// footprint (continuous gradients); the rotated-tile sampling below re-derives the cell of the shifted uv.
bool brPomOn = false;
vec3 brPomT = vec3( 1.0, 0.0, 0.0 ), brPomB = vec3( 0.0, 1.0, 0.0 ), brPomN = vec3( 0.0, 0.0, 1.0 );
vec2 brPomRep = vec2( 1.0 );
float brPomDepth = 0.0, brPomHitN = 1.0, brPomK = 0.0, brPomPx = 1.0; // brPomPx: metres per pixel
uint brPomSalt = 0u; // rotated-tile salt of the height lookups (chunks/pom.ts brPomH)
float brPomLod = 0.0; // their isotropic LOD
{
	vec3 brQ0 = dFdx( vViewPosition );
	vec3 brQ1 = dFdy( vViewPosition );
	float brTop = uBrLayerC[ brL ].y;
	// per-face layer and flags: quad-uniform. Skipped in the planar mirror pass and on submerged faces (pool bottoms
	// and walls: the water surface refracts and ripples them, which hides the parallax)
	if ( brTop > 0.0 && ( brF & ( BR_F_DECAL | BR_F_UNDERWATER ) ) == 0 && uBrReflPass < 0.5 ) {
		vec3 brNv = normalize( ( viewMatrix * vec4( brNWg, 0.0 ) ).xyz );
		mat3 brPF = brTangentFrame( - vViewPosition, brNv, vBrUv );
		vec3 brV = normalize( vViewPosition );
		float brNdV = max( dot( brNv, brV ), 0.06 );
		brPomT = brPF[ 0 ] * inversesqrt( max( dot( brPF[ 0 ], brPF[ 0 ] ), 1e-12 ) ); // zero-safe (degenerate quads)
		brPomB = brPF[ 1 ] * inversesqrt( max( dot( brPF[ 1 ], brPF[ 1 ] ), 1e-12 ) );
		brPomN = brNv;
		brPomRep = brHoriz ? vec2( brLB.x ) : brLB.xy; // metres per uv unit
		brPomDepth = uBrLayerC[ brL ].x * brTop * BR_POM_GAIN; // metres from the top plane down to height 0
		// largest visible parallax (pixels): the relief depth seen at this angle over the pixel footprint
		brPomPx = max( max( length( brQ0 ), length( brQ1 ) ), 1e-6 );
		float brShift = brPomDepth * sqrt( 1.0 - brNdV * brNdV ) / ( brNdV * brPomPx );
		float brFadeP = smoothstep( BR_POM_MIN_PX, BR_POM_FULL_PX, brShift );
		if ( brFadeP > 0.0 ) {
			// isotropic LOD of the footprint's area (geometric mean of its axes): the lookups skip anisotropic filtering
			brPomLod = 0.5 * log2( max( length( brDx ) * length( brDy ) * float( textureSize( uBrNormal, 0 ).x * textureSize( uBrNormal, 0 ).x ), 1.0 ) );
			brPomSalt = brTileSalt( brNWg );
			vec2 brDUv = - vec2( dot( brV, brPomT ), dot( brV, brPomB ) ) / brPomRep * ( brPomDepth * brFadeP / brNdV );
			int brSteps = clamp( int( ceil( brShift / BR_POM_STEP_PX ) ), BR_POM_MIN_STEPS, BR_POM_MAX );
			float brStep = 1.0 / float( brSteps );
			vec2 brUvP = brUv;
			float brRayP = 1.0;
			vec2 brPc = vec2( - 1e9 ), brPb = vec2( 0.0 ); // cached rotated-tile cell of the lookups
			mat2 brPm = mat2( 1.0 );
			float brHP = brPomH( brUv, brLA.xy, brPomSalt, brLayerF, brPomLod, brPc, brPm, brPb ) / brTop;
			vec2 brUvHit = brUv;
			float brHitN = 1.0;
			if ( brHP < 1.0 ) {
				for ( int i = 1; i <= BR_POM_MAX; i ++ ) {
					if ( i > brSteps ) break;
					// the last step is exactly the bottom (height 0), so it always hits: 1 - n * ( 1 / n ) can round
					// above 0 (an approximate reciprocal), and a flat floor at height 0 (deck rib bottoms, tie-hole
					// tips) would then miss and fall back to the unshifted uv
					float brRay = i == brSteps ? 0.0 : 1.0 - float( i ) * brStep;
					vec2 brUvC = brUv + brDUv * ( 1.0 - brRay );
					float brHC = brPomH( brUvC, brLA.xy, brPomSalt, brLayerF, brPomLod, brPc, brPm, brPb ) / brTop;
					if ( brHC >= brRay ) {
						// secant between the last sample above the surface and the first below it
						float brSa = brRayP - brHP;
						float brSb = brHC - brRay;
						float brSt = brSa / max( brSa + brSb, 1e-5 );
						brUvHit = mix( brUvP, brUvC, brSt );
						brHitN = mix( brRayP, brRay, brSt );
						break;
					}
					brUvP = brUvC;
					brRayP = brRay;
					brHP = brHC;
				}
			}
			brUv = brUvHit;
			brPomOn = true;
			brPomHitN = brHitN;
			brPomK = brFadeP;
		}
	}
}
#endif
vec4 brAlb;
vec4 brNrm; // xyz: filtered tangent normal (length |n̄|) in the continuous uv frame, w: height
vec4 brOrmh;
float brNLen;
int brRotIdx = - 1;
mat2 brRotM = mat2( 1.0 ); // rotated physical tiles: the cell's texture transform M (identity on other layers)
vec2 brRotC = vec2( 0.0 ); // ...and the cell centre in the continuous uv
if ( brLA.x > 0.0 ) {
	// ---- physical tiles: hashed 90° rotation + flip per tile cell, anisotropic footprint follows the rotation
	vec2 cells = brLA.xy;
	mat2 M;
	vec2 uvR = brRotUv( brUv, cells, brTileSalt( brNWg ), M, brRotIdx );
	brRotM = M;
	brRotC = ( floor( brUv * cells ) + 0.5 ) / cells;
	// d(uvR) = diag(1/cells) · M · diag(cells) · d(uv) (the rotation acts in square cell space)
	vec2 gx = ( M * ( brDx * cells ) ) / cells;
	vec2 gy = ( M * ( brDy * cells ) ) / cells;
	brAlb = textureGrad( uBrAlbedo, vec3( uvR, brLayerF ), gx, gy );
	vec4 nt = textureGrad( uBrNormal, vec3( uvR, brLayerF ), gx, gy );
	brOrmh = textureGrad( uBrOrmh, vec3( uvR, brLayerF ), gx, gy );
	vec3 nd = nt.xyz * 2.0 - 1.0;
	brNLen = length( nd );
	nd.xy = transpose( M ) * nd.xy; // counter-rotate into the continuous uv frame (M orthonormal)
	brNrm = vec4( nd, nt.w );
} else if ( BR_DETAIL == 1 && brLA.z > 0.0 ) {
	// ---- stochastic (offset-only) tiling on a world-anchored sheared triangle lattice: vertices at
	// (i·hexX + j·hexX/2, j·hexR), near-equilateral triangles whose vertex (blend) cells are hexagons of ~hexM.
	// Horizontal faces use world xz, periodic over NOISE_WRAP on both axes (hPz even, see brHexWrap), so the
	// noise-origin wrap never seams. Vertical faces use (along, storey-relative y) with an even row count per
	// STOREY_PITCH (tower periodicity) and hexX the nearest divisor of NOISE_WRAP (twin: params.ts hexLattice()).
	float hexM = brLA.z;
	float hexX; float hexR; int hPx; int hPz;
	if ( brHoriz ) {
		hexX = hexM;
		hexR = hexM * BR_HEX_ROW;
		hPx = int( BR_NOISE_WRAP / hexX + 0.5 );
		hPz = int( BR_NOISE_WRAP / hexR + 0.5 );
	} else {
		hPz = max( 2, 2 * int( BR_PITCH / ( 2.0 * hexM * BR_HEX_ROW ) + 0.5 ) );
		hexR = BR_PITCH / float( hPz );
		hPx = int( BR_NOISE_WRAP * BR_HEX_ROW / hexR + 0.5 );
		hexX = BR_NOISE_WRAP / float( hPx );
	}
	float sy = brS2.y / hexR;
	vec2 q = vec2( brS2.x / hexX - 0.5 * sy, sy );
	vec2 qi = floor( q );
	vec2 qf = q - qi;
	ivec2 c0 = ivec2( qi );
	ivec2 v0; ivec2 v1; ivec2 v2; vec3 w;
	if ( qf.x + qf.y < 1.0 ) {
		v0 = c0; v1 = c0 + ivec2( 1, 0 ); v2 = c0 + ivec2( 0, 1 );
		w = vec3( 1.0 - qf.x - qf.y, qf.x, qf.y );
	} else {
		v0 = c0 + ivec2( 1, 1 ); v1 = c0 + ivec2( 0, 1 ); v2 = c0 + ivec2( 1, 0 );
		w = vec3( qf.x + qf.y - 1.0, 1.0 - qf.x, 1.0 - qf.y );
	}
	float sharp = max( 1.0, hexX / ( 2.0 * BR_HEX_FEATHER ) );
	uint hSalt = brHoriz ? 977u : 983u;
	w = pow( max( w, vec3( 1e-5 ) ), vec3( sharp ) );
	w /= w.x + w.y + w.z;
	uint h0 = brHash2u( brHexWrap( v0, hPx, hPz ), hSalt );
	uint h1 = brHash2u( brHexWrap( v1, hPx, hPz ), hSalt );
	uint h2 = brHash2u( brHexWrap( v2, hPx, hPz ), hSalt );
	vec2 o0 = vec2( brU01( h0 ), brU01( brPcg( h0 ) ) );
	vec2 o1 = vec2( brU01( h1 ), brU01( brPcg( h1 ) ) );
	vec2 o2 = vec2( brU01( h2 ), brU01( brPcg( h2 ) ) );
	vec4 a0 = textureGrad( uBrAlbedo, vec3( brUv + o0, brLayerF ), brDx, brDy );
	vec4 a1 = textureGrad( uBrAlbedo, vec3( brUv + o1, brLayerF ), brDx, brDy );
	vec4 a2 = textureGrad( uBrAlbedo, vec3( brUv + o2, brLayerF ), brDx, brDy );
	vec4 n0 = textureGrad( uBrNormal, vec3( brUv + o0, brLayerF ), brDx, brDy );
	vec4 n1 = textureGrad( uBrNormal, vec3( brUv + o1, brLayerF ), brDx, brDy );
	vec4 n2 = textureGrad( uBrNormal, vec3( brUv + o2, brLayerF ), brDx, brDy );
	vec4 r0 = textureGrad( uBrOrmh, vec3( brUv + o0, brLayerF ), brDx, brDy );
	vec4 r1 = textureGrad( uBrOrmh, vec3( brUv + o1, brLayerF ), brDx, brDy );
	vec4 r2 = textureGrad( uBrOrmh, vec3( brUv + o2, brLayerF ), brDx, brDy );
	// variance-preserving blend around the layer mean (1x1 mip)
	vec4 muA = textureLod( uBrAlbedo, vec3( 0.5, 0.5, brLayerF ), 16.0 );
	vec4 muR = textureLod( uBrOrmh, vec3( 0.5, 0.5, brLayerF ), 16.0 );
	float wn = inversesqrt( dot( w, w ) );
	brAlb = clamp( muA + ( w.x * ( a0 - muA ) + w.y * ( a1 - muA ) + w.z * ( a2 - muA ) ) * wn, 0.0, 1.0 );
	brOrmh = clamp( muR + ( w.x * ( r0 - muR ) + w.y * ( r1 - muR ) + w.z * ( r2 - muR ) ) * wn, 0.0, 1.0 );
	vec3 nd0 = n0.xyz * 2.0 - 1.0;
	vec3 nd1 = n1.xyz * 2.0 - 1.0;
	vec3 nd2 = n2.xyz * 2.0 - 1.0;
	brNLen = w.x * length( nd0 ) + w.y * length( nd1 ) + w.z * length( nd2 );
	vec3 nb = w.x * nd0 + w.y * nd1 + w.z * nd2;
	brNrm = vec4( normalize( nb + vec3( 0.0, 0.0, 1e-4 ) ) * brNLen, w.x * n0.w + w.y * n1.w + w.z * n2.w );
} else {
	// explicit gradients: the per-roll wallpaper offset makes brUv discontinuous at the roll seams
	brAlb = textureGrad( uBrAlbedo, vec3( brUv, brLayerF ), brDx, brDy );
	vec4 nt = textureGrad( uBrNormal, vec3( brUv, brLayerF ), brDx, brDy );
	brOrmh = textureGrad( uBrOrmh, vec3( brUv, brLayerF ), brDx, brDy );
	vec3 nd = nt.xyz * 2.0 - 1.0;
	brNLen = length( nd );
	brNrm = vec4( nd, nt.w );
}

// ---- alpha: soft (decal variant) or alpha-tested (DECAL flag in shell/props)
float brAlpha = 1.0;
#ifdef BR_DECAL
brAlpha = brAlb.a;
if ( brL == BR_M_SIGNAGE || ( brL == BR_M_DECAL_ATLAS && brIsChalk( brUv ) ) ) {
	if ( brAlpha < 0.5 ) discard;
	brAlpha = 1.0;
}
brAlpha *= vBrTint.a; // DecalPlacement.alpha (WP5 writes it to tint.a on decal-buffer vertices)
if ( brAlpha < 0.004 ) discard;
#else
if ( ( brF & BR_F_DECAL ) != 0 && brAlb.a < 0.5 ) discard;
#endif

vec3 brA = brAlb.rgb;
// ---- texture realism v2 channels (textures/layers/types.ts AuxKind; per-face layer: quad-uniform): ormh.a is aux on
// 'detailMask' / 'wear' / 'mask' layers, (ormh.b, ormh.a) the lean vector on 'lean' layers (counter-rotated into the
// continuous uv frame like the normal; such layers have no metalness), albedo.a the second aux channel on aux2 layers
int brAuxK = BR_AUX_KIND[ brL ];
float brAux = brAuxK == BR_AUX_LEAN ? 0.0 : brOrmh.a;
float brAux2 = BR_L_AUX2[ brL ] ? brAlb.a : 0.0;
vec2 brLean = brAuxK == BR_AUX_LEAN ? transpose( brRotM ) * ( brOrmh.ba * 2.0 - 1.0 ) : vec2( 0.0 );
// brMuH: the layer's mean height (1x1 mip, a constant address); brRel: the relief above that mean plane in metres.
// Read-only expressions (#defines in SURFACE_PARS_GLSL), not variables: every use is a fetch, so read them behind a
// quad-uniform gate (one unconditional fetch per pixel cost ~0.3 ms per ultra frame)
// debug views 'aux' (24: r brAux, g brAux2; 'lean' layers rg = lean * 0.5 + 0.5, b = 1) and 'relief' (26: r / b the
// relief above / below the mean in units of BR_L_RELIEF, g the cavity 1 - ormh.r) leave here (chunks/debug.ts)
if ( uDebugView == BR_DV_AUX ) BR_DEBUG_EXIT( brAuxK == BR_AUX_LEAN ? vec3( brLean * 0.5 + 0.5, 1.0 ) : vec3( brAux, brAux2, 0.0 ) )
if ( uDebugView == BR_DV_RELIEF ) {
	float brRl = brRel / BR_L_RELIEF[ brL ];
	BR_DEBUG_EXIT( vec3( clamp( brRl, 0.0, 1.0 ), 1.0 - brOrmh.r, clamp( - brRl, 0.0, 1.0 ) ) )
}
${familyHook('postSample')}#if defined( BR_DETAIL_MAPS ) && ! defined( BR_DECAL )
// ---- detail maps (LEAN; textures/detail.ts): a mean-preserving albedo multiplier (pits and gaps also a little
// rougher), the resolved slope for FRAG_NORMAL and the unresolved slope variance for FRAG_ROUGHNESS
// (per-face layer: quad-uniform; the planar mirror pass skips it; a missing array reads mean 0 and is ignored).
// 'detailMask' layers scale the strength by their aux channel (after the postSample hooks, which may edit brAux)
if ( brAuxK == BR_AUX_DETAILMASK ) brDetL.y *= brAux;
if ( brDetL.x >= 0.0 && uBrReflPass < 0.5 ) {
	int brDi = int( brDetL.x + 0.5 );
	vec4 brDmu;
	vec4 brDt = brDetailFetch( brDetUv, brDetL.x, brDetDx, brDetDy, brDmu );
	if ( brDmu.b <= 0.0 ) {
		brDt = vec4( 0.5, 0.5, 0.5, 0.0 );
		brDmu.b = 0.5;
	}
	float brDs = BR_DETAIL_SLOPE[ brDi ];
	vec2 brDsl = ( brDt.rg * 2.0 - 1.0 ) * brDs;
	brDetVar = max( brDt.a * 2.0 * brDs * brDs - dot( brDsl, brDsl ), 0.0 ) * brDetL.y * brDetL.y; // E[s^2] - |E[s]|^2
	brDetSl = brDsl * brDetL.y;
	brAm = brDt.b / brDmu.b;
${familyHook('postDetail')}	brA *= mix( 1.0, brAm, brDetL.y );
	// detail tint (BR_L_DETTINT, 0 = the grey multiplier alone): per channel, the multiplier's deviation once more, so
	// the detail's pits and fibres shift the hue (dyed pile deepens, aggregate greys) as well as the value
	brA *= 1.0 + ( brAm - 1.0 ) * brDetL.y * BR_L_DETTINT[ brL ];
	brOrmh.g = clamp( brOrmh.g + BR_DETAIL_ROUGH_K[ brDi ] * ( 1.0 - brAm ) * brDetL.y, 0.02, 1.0 );
}
#endif
float brMacro = brLB.w;
// ---- macro variation: value ±6 %, hue ±2 % from low-frequency world noise + the coarse-mip luminance
if ( BR_DETAIL == 1 && brMacro > 0.0 ) {
	float n1 = brSurfNoise( brS2, brHoriz, BR_MACRO_CELL, BR_MACRO_P, BR_MACRO_CELL_Y, BR_MACRO_PY, 101u );
	float n2 = brSurfNoise( brS2, brHoriz, BR_MACRO_CELL * 2.0, BR_MACRO_P / 2, BR_MACRO_CELL_Y, BR_MACRO_PY, 202u );
	vec2 mt = brHoriz ? brS2 / BR_MACRO_TEX_SCALE : vec2( brS2.x / BR_MACRO_TEX_SCALE, brS2.y / BR_PITCH );
	float lc = brLuma( textureLod( uBrAlbedo, vec3( mt, brLayerF ), BR_MACRO_MIP ).rgb );
	float lm = max( brLuma( textureLod( uBrAlbedo, vec3( 0.5, 0.5, brLayerF ), 16.0 ).rgb ), 1e-3 );
	float v = clamp( ( n1 * 2.0 - 1.0 ) * 0.8 + ( lc / lm - 1.0 ) * 1.5, - 1.0, 1.0 );
	float hh = n2 * 2.0 - 1.0;
	brA *= 1.0 + BR_MACRO_VALUE * brMacro * v;
	brA *= vec3( 1.0 + BR_MACRO_HUE * brMacro * hh, 1.0, 1.0 - BR_MACRO_HUE * brMacro * hh );
}
if ( brRoll ) {
	float rv = brU01( brPcg( brRollH ) ) * 2.0 - 1.0;
	float rw = brU01( brPcg( brRollH ^ 0x5bd1e995u ) ) * 2.0 - 1.0;
	brA *= ( 1.0 + 0.03 * rv ) * vec3( 1.0 + 0.015 * rw, 1.0, 1.0 - 0.015 * rw );
	// nicotine / dust yellowing toward the ceiling (storey-relative height)
	brA *= mix( vec3( 1.0 ), vec3( 1.0, 0.975, 0.925 ), smoothstep( 1.1, 2.8, vBrLocal.y ) );
}

// ---- mask-driven grime (LAYER_DEFS.grime profile) + hashed world features
vec4 brMask = vec4( 0.0 );
#if defined( BR_SHELL ) || defined( BR_DECAL )
brMask = texture( uLmMask, vBrLmUv );
#endif
float brRoughMul = 1.0;
// absolute wet-roughness target (carpet: water fills the pile, so the filtered-normal variance no longer roughens it)
float brRoughTo = 1.0;
float brRoughToW = 0.0;
float brMetal = brAuxK == BR_AUX_LEAN ? 0.0 : brOrmh.b;
float brNrmScale = brLB.z;
int brGrime = int( brLA.w + 0.5 );
if ( ( brF & BR_F_NO_GRIME ) != 0 ) brGrime = 0;
// submerged: the water body's depth below its plane (aux.w = plane byte on UNDERWATER faces), < 0 above it
float brSubDepth = ( brF & BR_F_UNDERWATER ) != 0 ? brAuxB.w * 0.05 - 3.2 - vBrLocal.y : - 1.0;
float brWet = 0.0; // wetness 0..1 (mask B, tide-perturbed, ramped; 1 under water): absorption (the damp look)
float brSoak = 0.0; // the same field unramped: water film and standing water (the ramp would flood whole patches)
float brWear = 0.0; // carpet traffic wear (sheen)
float brPileLean = 0.0; // carpet pile lean seen from the camera, -1..1 (sheen roughness)
if ( brGrime != 0 ) {
	vec2 gA = brHoriz ? brS2 / BR_GRIME_A : vec2( brS2.x / BR_GRIME_A, brS2.y / BR_GRIME_YA );
	vec2 gB = brHoriz ? brS2 / BR_GRIME_B : vec2( brS2.x / BR_GRIME_B, brS2.y / BR_GRIME_YB );
	vec4 g1 = texture( uBrGrime, gA );
	vec4 g2 = texture( uBrGrime, gB + 0.37 );
	// wide ramp: the mask's damp patches fade over ~0.5 m; a narrow threshold would re-sharpen their borders.
	// Perturbed by the smooth tide field (g2.r), not the speckle channel: speckle made the fringes sparkle.
	float wetRaw = brMask.b + ( g2.r - 0.5 ) * 0.3;
	float wet = smoothstep( 0.22, 0.62, wetRaw );
	if ( brSubDepth > 0.0 ) wet = 1.0; // under water everything porous is soaked
	brWet = wet;
	brSoak = brSubDepth > 0.0 ? 1.0 : clamp( wetRaw, 0.0, 1.0 );
	// the profile branches (LAYER_DEFS.grime): one 'else if ( brGrime == <profile id> ) { ... }' clause per profile,
	// owned by the chunks/family/*.ts files. One exclusive chain: the same branches as separate ifs compile to
	// different rounding (1 px of the 32 A/B framings moved by one level)
	if ( false ) {
	}
${familyHook('grime')}	// ---- relief-aware dirt and wear (texture realism v2; BR_L_DIRT / BR_L_WEAR [rgb, amount], amount 0 = off; per-face
	// layer: quad-uniform). Dirt settles in the concavities (the cavity 1 - ormh.r), more where the WP7 mask holds grime
	// (G) and in the kick zone at the foot of walls: albedo x dirt colour, rougher. Wear rubs the convexities (brRel above
	// the layer's mean plane, in units of BR_L_RELIEF) where there is traffic (floors: mask A; walls: below hand height):
	// albedo toward the wear colour. Both inputs are linear in the filtered texture, so distance does not bias them.
	// Compiled in only when some layer sets an amount (BR_RELIEF_GRIME: the idle block moved a torch pixel by a level).
#if BR_RELIEF_GRIME
	vec4 brDirtC = BR_L_DIRT[ brL ];
	vec4 brWearC = BR_L_WEAR[ brL ];
	if ( brDirtC.a > 0.0 ) {
		float brFoot = brHoriz ? 0.0 : 1.0 - smoothstep( 0.05, 0.6, vBrLocal.y );
		float brConc = clamp( 1.0 - brOrmh.r, 0.0, 1.0 );
		float brDirt = brDirtC.a * brConc * sqrt( brConc ) * clamp( 0.35 + 1.2 * brMask.g + 0.4 * brFoot, 0.0, 1.0 );
		brA *= mix( vec3( 1.0 ), brDirtC.rgb, brDirt );
		brOrmh.g = min( brOrmh.g + 0.12 * brDirt, 1.0 );
	}
	if ( brWearC.a > 0.0 ) {
		float brTraffic = brHoriz ? ( brNWg.y > 0.0 ? brMask.a : 0.0 ) : 1.0 - smoothstep( 0.3, 1.5, vBrLocal.y );
		float brConv = clamp( brRel / BR_L_RELIEF[ brL ], 0.0, 1.0 );
		brA = mix( brA, brWearC.rgb, brWearC.a * pow( brConv, 1.2 ) * brTraffic );
	}
#endif
}
#ifdef BR_WATER_WETBAND
{
	float brBand = brWaterWetBand( vBrLocal, brNWg, brHoriz ); // splash / wicking band above a water line (package E)
	brWet = max( brWet, brBand );
	brSoak = max( brSoak, brBand );
}
#endif

// ---- wetness (Lagarde 2013): porous media darken and saturate as they absorb water (brWet); a specular water film
// forms early on sealed surfaces but only at saturation on porous ones, and standing water fills the relief below a
// level that rises with the water present (brSoak), so shorelines are ragged and follow grout, joints, cracks and
// tilted-tile corners.
// Submerged faces keep the absorption only (the water material renders the interface).
vec4 brLC = uBrLayerC[ brL ]; // (heightScale m, pomTop, porosity, Toksvig weight)
float brPor = brLC.z;
float brAir = step( brSubDepth, 0.0 );
float brAbs = smoothstep( 0.0, 0.6, brWet ) * brPor; // absorbed water
brA *= 1.0 - BR_WET_DARK * brAbs;
brA = max( mix( vec3( brLuma( brA ) ), brA, 1.0 + BR_WET_SAT * brAbs ), vec3( 0.0 ) );
float brFilm = smoothstep( 0.3 + 0.55 * brPor, 0.6 + 0.35 * brPor, brSoak ) * brAir;
float brPuddle = 0.0;
#ifdef BR_PUDDLES
if ( brNWg.y > 0.9 ) {
	// relief (m) above the layer's mean plane: the 1x1 mip holds the mean height (constant address: always cached).
	// Decals are thin films on the base floor: they take the base's mean state (no relief of their own).
	float brRelM = 0.0;
#ifndef BR_DECAL
	brRelM = ( brNrm.w - brMuH ) * brLC.x;
#endif
	// textiles (porosity >= 0.95: carpet) soak the water up first: it stands over the pile only where the floor is
	// saturated (the film complete), in the cores of the soak field; there it is a mirror like any puddle (as a broken
	// film over the pile it blurred the ceiling lamps into bright blotches through the SSR)
	vec2 brPw = brPor < 0.95 ? vec2( BR_PUDDLE_W0, BR_PUDDLE_W1 ) : vec2( BR_PUDDLE_PILE_W0, BR_PUDDLE_PILE_W1 );
	float brLvl = mix( BR_PUDDLE_LO, BR_PUDDLE_HI, smoothstep( brPw.x, brPw.y, brSoak ) );
	// shoreline width grows with the texel footprint: the mip-filtered height flattens toward the mean far away
	float brPx = max( length( brDx ), length( brDy ) ) * float( textureSize( uBrNormal, 0 ).x );
	float brEdge = BR_PUDDLE_EDGE + 0.05 * brLC.x * clamp( brPx, 0.0, 8.0 );
	brPuddle = smoothstep( 0.0, brEdge, brLvl - brRelM ) * smoothstep( brPw.x, brPw.x + 0.05, brSoak ) * brAir;
	// a textile's shore pixel is either water (flat, a mirror) or fibre tips through the film (the pile's normal, a
	// broad sheen): a blend of the two tilted part-flattened pile normals under a near-mirror lobe and sparkled with
	// the ceiling lamps as a string of bright dots along every shore
	if ( brPor >= 0.95 ) brPuddle = smoothstep( 0.4, 0.6, brPuddle );
	brA *= mix( vec3( 1.0 ), BR_PUDDLE_TINT, brPuddle * min( 2.0 * brPor, 1.0 ) ); // murky on dirty porous floors, clear on glaze
}
#endif
// damp pile / fibres clump (stronger relief); a saturated film and standing water flatten it; still water adds no
// filtered-normal (Toksvig) variance
brNrmScale *= ( 1.0 + BR_WET_CLUMP * brAbs * ( 1.0 - brFilm ) ) * ( 1.0 - BR_SOAK_FLAT * brFilm * brPor ) * ( 1.0 - brPuddle );
#if defined( BR_DETAIL_MAPS ) && ! defined( BR_DECAL )
// water fills the micro-relief: standing water has no detail slope, a film keeps some of the variance
brDetSl *= 1.0 - brPuddle;
brDetVar *= 1.0 - max( brPuddle, 0.7 * brFilm );
#ifdef BR_SHELL
// micro-ripples on standing water (drips, draughts): the ripple layer at BR_RIPPLE_SCALE metres per repeat, drifting
// slowly, only near the viewer (unresolved ripples far away would only blur the mirror through the specular AA)
float brRk = BR_DETAIL_REPEAT / BR_RIPPLE_SCALE * brDetRep; // brDetUv is in units of the layer's detail repeat
float brRn = 1.0 - smoothstep( BR_RIPPLE_NEAR0, BR_RIPPLE_NEAR1, max( length( brDetDx ), length( brDetDy ) ) * brRk * BR_DETAIL_RES );
if ( brPuddle > 0.0 && brRn > 0.0 && uBrReflPass < 0.5 ) { // per-pixel branch: explicit gradients
	vec2 brRp = textureGrad( uBrDetail, vec3( brDetUv * brRk + uTime * BR_RIPPLE_DRIFT, BR_DETAIL_RIPPLE ), brDetDx * brRk, brDetDy * brRk ).rg * 2.0 - 1.0;
	brDetSl += brRp * ( BR_RIPPLE * smoothstep( 0.5, 1.0, brPuddle ) * brRn ); // not on the shoreline film
}
#endif
#endif
brNLen = mix( brNLen, 1.0, brPuddle );
brRoughTo = mix( BR_WET_FILM_ROUGH + BR_WET_FILM_ROUGH_POROUS * brPor + ( brPor < 0.95 ? 0.0 : BR_WET_FILM_ROUGH_PILE ), BR_PUDDLE_ROUGH, brPuddle );
brRoughToW = max( brFilm, brPuddle );
${familyHook('postWet')}diffuseColor.rgb = brA * vBrTint.rgb;
diffuseColor.a = brAlpha;
// ---- props: dust on the anchor cell's decay (aux.z bits 2-7), clumped on up-facing faces, a faint film on the rest.
// Emissive, dead-fixture (NO_GRIME) and animated parts stay clean.
float brDust = 0.0;
#ifdef BR_PROPS
if ( BR_DETAIL == 1 && ( brF & BR_F_PROP_AUX ) != 0 && ( brF & ( BR_F_NO_GRIME | BR_F_DYN_EMIT | BR_F_SHIMMER ) ) == 0 && vBrEmit <= 0.0 ) {
	float brDl = float( ( int( brAuxB.z ) >> 2 ) & 63 ) / 63.0;
	float brUp = smoothstep( 0.3, 0.9, brNWg.y );
	vec2 brDw = vBrLocal.xz + uNoiseOrigin.xz;
	float brDn = brVNoise( brDw / BR_DUST_CELL, ivec2( BR_DUST_P ), 919u );
	// a settled layer with soft drifts: the grime texture's smooth stain field (its speckle channel reads as leopard
	// spots on glossy paint / glass)
	vec4 brDg = texture( uBrGrime, brDw / BR_GRIME_B + 0.61 );
	float brDc = 0.5 * brDn + 0.55 * brDg.r + 0.12 * ( brDg.g - 0.5 );
	brDust = clamp( brDl * ( brUp * mix( 0.45, 1.0, smoothstep( 0.2, 0.75, brDc ) ) + BR_DUST_SIDE * ( 0.5 + 0.5 * brDn ) ), 0.0, 1.0 ) * BR_DUST_MAX;
	diffuseColor.rgb = mix( diffuseColor.rgb, BR_DUST_COLOR, brDust );
	brRoughTo = BR_DUST_ROUGH;
	brRoughToW = max( brRoughToW, brDust );
	brNrmScale *= 1.0 - 0.6 * brDust;
	brMetal *= 1.0 - brDust;
#ifdef BR_DETAIL_MAPS
	brDetSl *= 1.0 - 0.6 * brDust;
#endif
}
#endif
`;

/** Replaces `#include <roughnessmap_fragment>`: ormh.g (or the props aux.x override) with layer-weighted Toksvig
 * (filtered-normal variance), the two-lobe unmixing of bimodal layers, the grime multiplier and the wet / dust target. */
export const FRAG_ROUGHNESS_GLSL = /* glsl */ `
// Toksvig: the mip-filtered normal's shortening widens the lobe, weighted per layer (uBrLayerC.w < 1 where most of
// that variance is structural: grout bevels, tilted tiles, joints, deck ribs)
float brVar = clamp( ( 1.0 - brNLen ) / max( brNLen, 1e-3 ) - BR_TOKSVIG_DEADZONE, 0.0, BR_TOKSVIG_MAX_VAR ) * brLC.w;
float brR = brOrmh.g;
// props: a non-zero aux.x is a per-part roughness override (WP6: car paint, CRT glass, polished metal); on emissive
// parts aux.x is the emitter-profile parameter instead
if ( ( brF & BR_F_PROP_AUX ) != 0 && brAuxB.x > 0.5 && vBrEmit <= 0.0 ) brR = brAuxB.x / 255.0;
float brRt = sqrt( brR * brR + brVar );
// two-lobe unmixing of bimodal layers (glaze + grout, wax + joints, polished terrazzo + pits): the mip-filtered
// roughness is the coverage mixture (1 - c) gz + c rx, so c is the rough component's coverage (materialPost weights
// the specular by 1 - c) and the lobe keeps the glaze's own roughness (plus the tilt share of the normal variance)
// at every distance instead of averaging into satin. Texels glossier than gz keep their own value.
float brCov = 0.0;
vec4 brLE = uBrLayerE[ brL ];
if ( brLE.x > 0.0 ) {
	brCov = clamp( ( brOrmh.g - brLE.x ) / max( brLE.y - brLE.x, 1e-3 ), 0.0, 1.0 );
	float brGz = min( brOrmh.g, brLE.x );
	brRt = sqrt( brGz * brGz + BR_GLAZE_TOKSVIG * brVar );
}
#if defined( BR_DETAIL_MAPS ) && ! defined( BR_DECAL )
brRt = sqrt( sqrt( pow4( brRt ) + brDetVar ) ); // LEAN: the unresolved detail slope variance adds to alpha^2
#endif
${familyHook('rough')}float roughnessFactor = clamp( mix( brRt * brRoughMul, brRoughTo, brRoughToW ), 0.02, 1.0 );
`;

/** Replaces `#include <metalnessmap_fragment>`. */
export const FRAG_METALNESS_GLSL = /* glsl */ `
float metalnessFactor = clamp( brMetal, 0.0, 1.0 );
`;

/** Replaces `#include <normal_fragment_maps>`. brNg = the unperturbed normal (the baked lighting divides by it). */
export const FRAG_NORMAL_GLSL = /* glsl */ `
vec3 brNg = normal;
// cotangent frame of the material uv at main scope (also used by the emitter model, package C)
mat3 brTbn = brTangentFrame( - vViewPosition, normal, vBrUv );
{
	vec3 brMapN = vec3( brNrm.xy * brNrmScale, max( brNrm.z, 1e-3 ) );
	normal = normalize( brTbn * brMapN );
}
#if defined( BR_DETAIL_MAPS ) && ! defined( BR_DECAL )
{
	// detail slope in the detail uv's own cotangent frame (a second frame: world-anchored on the shell), added to the
	// mapped normal (UDN style); |slope| <= 1, so a steep base bevel is never flipped
	mat3 brDf = brTangentFrame( - vViewPosition, brNg, brDetUv );
	vec2 brSl = brDetSl / max( 1.0, length( brDetSl ) );
	normal = normalize( normal - brDf[ 0 ] * brSl.x - brDf[ 1 ] * brSl.y );
}
#endif
${familyHook('normal')}`;

/** Replaces `#include <emissivemap_fragment>`. LENS_SHIMMER_GLSL (core/flicker.ts, WP11) provides brLensShimmer.
 * Under BR_DETAIL == 1, emitters whose aux.z carries a profile (core/emitterProfile.ts; non-FLOOR_AUX faces) are
 * shaped by brEmitterShape (chunks/emitters.ts); the others, and the lite path, keep the uniform / texture-mask
 * emission. OFF recessed lenses carry the profile too and get a dark cavity with dead tubes. */
export const FRAG_EMISSIVE_GLSL = /* glsl */ `
#if BR_DETAIL == 1
// profile inputs, taken in uniform control flow (derivatives): the uv footprint and the view vector in the
// emitter's (u, v, n) frame. Recessed lenses are down-facing shell quads with uv along world +x / +z; props use the
// uv cotangent frame (FRAG_NORMAL's expression, so the compiler shares it)
int brEp = ( brF & BR_F_FLOOR_AUX ) == 0 ? ( int( brAuxB.z + 0.5 ) >> 1 ) & 15 : 0;
float brEmFp = max( length( dFdx( vBrUv ) ), length( dFdy( vBrUv ) ) );
vec3 brEmV = normalize( vViewPosition );
#ifdef BR_PROPS
mat3 brEmTbn = brTangentFrame( - vViewPosition, brNg, vBrUv );
vec3 brEmVt = vec3( dot( brEmV, brEmTbn[ 0 ] ) * inversesqrt( max( dot( brEmTbn[ 0 ], brEmTbn[ 0 ] ), 1e-12 ) ),
	dot( brEmV, brEmTbn[ 1 ] ) * inversesqrt( max( dot( brEmTbn[ 1 ], brEmTbn[ 1 ] ), 1e-12 ) ), dot( brEmV, brNg ) );
#else
vec3 brEmVw = ( vec4( brEmV, 0.0 ) * viewMatrix ).xyz;
vec3 brEmVt = vec3( brEmVw.x, brEmVw.z, - brEmVw.y );
#endif
#endif
// the diffuse albedo punctual lights (the flashlight) see where the emitter model sets one, -1 = the material's
// (chunks/materialPost.ts swaps it in for three's lights_fragment_begin; chunks/lighting.ts restores the room's)
float brPunctAlb = - 1.0;
if ( vBrEmit > 0.0 ) {
	float brIsLens = ( brL == BR_M_PANEL_LENS || brL == BR_M_SIGNAGE ) ? 1.0 : 0.0;
	float brDyn = ( brF & BR_F_DYN_EMIT ) != 0 ? brLuma( uFlick[ 0 ] ) : 1.0;
	float brSh = 1.0;
	if ( ( brF & BR_F_SHIMMER ) != 0 ) brSh = brLensShimmer( int( brAuxB.w ), floor( vBrTint.a * 255.0 + 0.5 ), uTime, uFlickerMode );
#if BR_DETAIL == 1
	float brEpRoom, brEpRoomP;
	if ( brEp != 0 ) {
		totalEmissiveRadiance = vBrEmit * vBrTint.rgb * brEmitterShape( brEp, ( int( brAuxB.z + 0.5 ) >> 5 ) & 7,
			int( brAuxB.x + 0.5 ), floor( vBrTint.a * 255.0 + 0.5 ), vBrUv, brEmVt, brEmFp, uTime, int( brAuxB.w + 0.5 ), brDyn, brSh,
			( brF & BR_F_DYN_EMIT ) != 0, ( brF & BR_F_SHIMMER ) != 0, brEpRoom, brEpRoomP );
		// parabolic louver: its aluminium mirrors the room (neutral), not the lamp-tinted lens diffuse
		if ( brEpRoom >= 0.0 ) diffuseColor.rgb = vec3( brEpRoom );
		brPunctAlb = brEpRoomP;
	} else
#endif
	totalEmissiveRadiance = vBrEmit * vBrTint.rgb * mix( 1.0, brOrmh.a * 1.3, brIsLens ) * brDyn * brSh;
} else {
	totalEmissiveRadiance = vec3( 0.0 );
#if BR_DETAIL == 1
	// OFF recessed lens: dark cavity and dead tubes behind it (emissivemap runs before lights_physical: re-shaded);
	// a dead parabolic louver shows its aluminium blade grid over the dark cells
	if ( brEp != 0 && brL == BR_M_PANEL_LENS && ( brF & BR_F_PROP_AUX ) == 0 ) {
		if ( brEp == BR_EP_LOUVER ) diffuseColor.rgb = vec3( brOffLouver( int( brAuxB.x + 0.5 ), ( int( brAuxB.z + 0.5 ) >> 5 ) & 7,
			vBrUv, brEmVt, brEmFp, brPunctAlb ) );
		else diffuseColor.rgb *= brOffLensShade( brEp, int( brAuxB.x + 0.5 ), ( int( brAuxB.z + 0.5 ) >> 5 ) & 7, vBrUv, brEmVt, brEmFp );
	}
#endif
}
vec4 brSubInfo = brWaterSubInfo( brF, brSubDepth, vBrTint.a, brNWg ); // package E: water info (chunks/water.ts)
#define getSpotLightInfo( l, p, d ) brSpotInfoW( l, p, d, brSubInfo )
`;
