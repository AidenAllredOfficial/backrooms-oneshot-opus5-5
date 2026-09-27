// src/materials/WaterMaterial.ts — the water surface: its own ShaderMaterial, drawn in two ways.
//
// Split frames (high / ultra, BR_WATER_REFRACT; "volMode": uWaterVolOn = 1 and the tile fully faded in): the water is
// drawn after package A's ColorPyramid (post/ScenePass.ts late render) and is OPAQUE: col = F * reflection + specular
// + (1 - F) * trans, with the exact dielectric Fresnel F, where trans is the refracted view of the opaque scene
// through the water body (chunks/water.ts waterVolumeGlsl: marched against the pyramid's linear depth, then the
// kind's medium: unscattered + forward-scattered (blurred through the mips) + ambient in-scatter, and with
// BR_WATER_VOLLIGHT the flashlight beam and the nearest UNDERWATER lamps scattered toward the eye). The submerged
// surfaces left their view-path optics to it (chunks/haze.ts brDefer), so the tile grid bends at the waterline,
// pools look shallower than they are, and props in the water are absorbed like the shell. It writes depth.
// Otherwise (low / medium, a tile fading in): the premultiplied layer rgb = F * reflection + specular (+ matter),
// alpha = F (+ its coverage), blended (One, OneMinusSrcAlpha) over the submerged surfaces, which absorbed along the
// refracted view path in their own shader (the legacy optics in chunks/haze.ts).
//
// Surface (package E, chunks/water.ts): per-quad kind / depth / emitter plane / region key from the mesh (flat
// varyings, mesh/water.ts); the slope = analytic dispersive waves + texture octaves (BR_WATER_WAVES) + the ripple
// window and drip rings (BR_WATER_RIPPLE); roughness alpha = sqrt(alpha0^2 + 2 var) from the unresolved slope
// variance. Surface matter (BR_WATER_DEBRIS): a dust film that dulls the reflection, floating flecks, and contact
// lines where the water meets walls and objects: the meniscus (a thin bright line), a contact shadow and a ragged
// scum band; the contact comes from the tile's wall mask on every preset, and from the pyramid depth (pillars, chair
// legs, ladders) in volMode.
// Reflection = the planar texture when this plane is the mirrored one (plane height == uReflY ± 2 cm; the perturbed
// reflected ray is projected at REFL_GEOM_D behind the surface, so the distortion is distance-correct; the blur
// follows alpha through smooth rotated taps, streaked along the view plane on rough water), else the environment:
// package D's reflection probe when it is on (BR_PROBE; package D's brSsrTrace slots in before it), otherwise the
// room average plus the emission-map reflection at the quad's own emitter plane and light region. Specular: the
// flashlight GGX with alpha (glints) and the baked dominant direction only where the surface is rough. Air haze
// through package F's brHaze / brHazeT API.

import * as THREE from 'three';
import { DebugView } from '../core/ids.ts';
import type { MaterialGlobals, TileBindings } from '../core/runtime.ts';
import { fragmentCommon, HAZE_FUNCS_GLSL } from './chunks/common.ts';
import { PROBE_GLSL } from './chunks/probe.ts';
import { waterFilmGlsl, waterRippleGlsl, waterVolumeGlsl, waterWavesGlsl } from './chunks/water.ts';
import { bindUniforms } from './SurfaceMaterial.ts';
import { definesKey } from './shared.ts';
import type { QualityDefines, SharedUniforms } from './shared.ts';

/** Interpolation weight between the last two fixed ripple-simulation steps (WaterRipples writes it every frame;
 * module singleton bound by reference as uBrRippleLerp by every water material). */
export const RIPPLE_LERP: { value: number } = { value: 1 };

export const WATER_VERTEX_GLSL = /* glsl */ `
#include <common>
#include <shadowmap_pars_vertex>
attribute vec2 brLmUv;
attribute vec4 brAux;
attribute vec4 brTint;
varying vec3 vViewPosition;
varying vec3 vBrLocal;
varying vec2 vBrLmUv;
flat varying vec4 vBrAux4;
flat varying vec4 vBrTint;
void main() {
	vec3 transformed = position;
	vec4 mvPosition = modelViewMatrix * vec4( transformed, 1.0 );
	gl_Position = projectionMatrix * mvPosition;
	vViewPosition = - mvPosition.xyz;
	vBrLocal = transformed;
	vBrLmUv = brLmUv;
	vBrAux4 = brAux;
	vBrTint = brTint;
	vec3 transformedNormal = normalMatrix * normal;
	vec4 worldPosition = modelMatrix * vec4( transformed, 1.0 );
	#include <shadowmap_vertex>
}
`;

export function waterFragmentGlsl(): string {
  return /* glsl */ `
#include <common>
#include <packing>
#include <lights_pars_begin>
#include <shadowmap_pars_fragment>
${fragmentCommon()}
uniform sampler2D uBrWaterNormals;
uniform mat4 projectionMatrix;
varying vec3 vViewPosition;
varying vec3 vBrLocal;
varying vec2 vBrLmUv;
flat varying vec4 vBrAux4;
flat varying vec4 vBrTint;
${HAZE_FUNCS_GLSL}
${PROBE_GLSL}
${waterWavesGlsl()}
${waterRippleGlsl()}
${waterFilmGlsl()}
${waterVolumeGlsl()}
// The mirror texture at uv, magnified with a cubic B-spline (4 bilinear taps; texSz = its level-0 size): it is
// rendered at 0.35-0.67 of the view, and the HDR contour of a bright lamp in plain bilinear magnification traces
// the texel grid (stepped blobs); the B-spline's is smooth. Blurred lookups (lod >= 0.75) are trilinear.
vec3 brWReflCubic( vec2 uv, vec2 texSz, float lod ) {
	if ( lod >= 0.75 ) return textureLod( uReflTex, uv, lod ).rgb;
	vec2 st = uv * texSz - 0.5;
	vec2 i = floor( st ), f = st - i;
	vec2 f2 = f * f, f3 = f2 * f;
	vec2 w0 = ( 1.0 - 3.0 * f + 3.0 * f2 - f3 ) / 6.0, w1 = ( 4.0 - 6.0 * f2 + 3.0 * f3 ) / 6.0;
	vec2 w2 = ( 1.0 + 3.0 * f + 3.0 * f2 - 3.0 * f3 ) / 6.0, w3 = f3 / 6.0;
	vec2 g0 = w0 + w1, g1 = w2 + w3;
	vec2 h0 = ( i - 0.5 + w1 / g0 ) / texSz, h1 = ( i + 1.5 + w3 / g1 ) / texSz;
	return g0.y * ( g0.x * textureLod( uReflTex, vec2( h0.x, h0.y ), 0.0 ).rgb + g1.x * textureLod( uReflTex, vec2( h1.x, h0.y ), 0.0 ).rgb )
		+ g1.y * ( g0.x * textureLod( uReflTex, vec2( h0.x, h1.y ), 0.0 ).rgb + g1.x * textureLod( uReflTex, vec2( h1.x, h1.y ), 0.0 ).rgb );
}
// The environment of a water surface that is not the mirrored plane, along the reflected world direction rW:
// package D's box-projected probe when it is on (D: try brSsrTrace against uHiZ / uSceneColor first, here), else the
// room average (the atmosphere's haze tint is the room colour) plus the emitters of the quad's own light region on its
// emitter plane (the emission map).
vec3 brWaterEnv( vec3 rW, vec3 irr, float rough, float waterY, vec4 auxB ) {
	vec3 env = mix( irr * BR_WATER_ENV_ALBEDO / BR_PI * uHazeTint, uFarColor, 0.25 );
	float rk = auxB.y + 256.0 * auxB.z; // 0: the rect spans several regions, accept any emitter
	float planeH = auxB.w > 0.5 ? auxB.w * 0.05 : BR_WATER_EMIT_H;
	float emFade;
	vec3 ec = brEmissionRefl( vBrLocal, rW, waterY + planeH, rk > 0.5 ? rk : - 1.0, rough, emFade );
	env += ec * emFade;
#ifdef BR_PROBE
	if ( uBrProbeOn > 0.5 ) {
		vec3 pc = ( vec4( - vViewPosition, 0.0 ) * viewMatrix ).xyz; // camera-relative world position
		float pw = brProbeWeight( pc );
		if ( pw > 0.0 ) {
			vec3 pe = textureLod( uBrProbe, brProbeDir( pc, rW, rough ), rough * uBrProbeLod ).rgb * brProbeNorm( vec3( 0.0, 1.0, 0.0 ), irr, rough );
			env = mix( env, pe, pw );
		}
	}
#endif
	return env;
}
void main() {
	if ( uFade < 1.0 && brBayer4( gl_FragCoord.xy ) >= uFade ) discard;
	// not in its own reflection; debug views show the pool floor, except the water view
	if ( uBrReflPass > 0.5 || ( uDebugView != 0 && uDebugView != ${DebugView.WATER} ) ) discard;
	// per-quad data (mesh/water.ts): kind (tint.a), depth (aux.x, 2 cm), region key (aux.y/z), emitter plane (aux.w, 5 cm)
	vec4 brAuxB = floor( vBrAux4 * 255.0 + 0.5 );
	int kind = min( int( vBrTint.a * 255.0 + 0.5 ), 2 );
	float D = max( brAuxB.x * 0.02, 0.02 );
	// the plane height: the fragment's own y (storey-relative = tile-local; uReflY is world)
	float waterY = vBrLocal.y;
	float d = length( vViewPosition );
	vec3 P = - vViewPosition;
	vec3 V = vViewPosition / max( d, 1e-5 );
	vec3 upV = viewMatrix[ 1 ].xyz; // world up in view space
#ifdef BR_WATER_REFRACT
	bool volMode = uWaterVolOn > 0.5 && uFade >= 1.0;
#else
	const bool volMode = false;
#endif
	// ---- surface slope and roughness
	vec2 pw = vBrLocal.xz + uNoiseOrigin.xz;
	float fpx = length( fwidth( pw ) ); // m per pixel
	float var;
	vec2 S = brWaterSlope( pw, uTime, kind, D, 0.7 * fpx, var );
	float rippleH = 0.0, foam = 0.0;
#ifdef BR_WATER_RIPPLE
	S += brRippleSlope( vBrLocal.xz + ( uTileOrigin.xz - uRippleOrigin ), waterY + uTileOrigin.y, 0.7 * fpx, rippleH, foam );
#endif
	float alpha = brWaterAlpha( kind, var );
	float film = 0.0;
	// ---- contact lines: the horizontal distance eC (m) to the nearest wall / rim / object in the water, nC the world
	// xz direction away from it
	float eC = 1e3;
	vec2 nC = vec2( 0.0 );
#ifdef BR_WATER_DEBRIS
	film = brWaterFilm( pw, uTime, kind );
	alpha = sqrt( alpha * alpha + BR_WFILM_ROUGH * BR_WFILM_ROUGH * film * film );
	eC = brWaterEdge( vBrLocal.xz, waterY, nC );
#endif
#ifdef BR_WATER_REFRACT
	if ( volMode ) {
		vec3 nAway;
		float eD = brWContact( P, D, upV, brWProj( P ), nAway );
		if ( eD < eC ) {
			eC = eD;
			vec2 nh = ( vec4( nAway, 0.0 ) * viewMatrix ).xz;
			nC = nh / max( length( nh ), 1e-5 );
		}
	}
#endif
#ifdef BR_WATER_DEBRIS
	// meniscus: the surface climbs the wetted contact, its normal tilts away from it over max(3 mm, 1.2 px): a thin line
	// that reflects the wall and ceiling above instead of the mirror image
	S -= BR_WMENISCUS * ( 1.0 - smoothstep( 0.0, max( BR_WMENISCUS_W, 1.2 * fpx ), eC ) ) * nC;
#endif
	float rough = sqrt( alpha ); // brGGX / brEmissionRefl take the perceptual roughness (alpha = rough^2)
	vec3 nW = normalize( vec3( - S.x, 1.0, - S.y ) );
	vec3 nV = normalize( ( viewMatrix * vec4( nW, 0.0 ) ).xyz );
	float NdV = max( dot( nV, V ), 1e-3 );
	float F = brFresnelW( NdV );
	// ---- local lighting (floor-grid lightmap at the same xz)
	vec4 lmA = texture( uLmIrr, vBrLmUv );
	vec4 lmB = texture( uLmDir, vBrLmUv );
	vec4 fl = texture( uLmFlick, vBrLmUv );
	vec3 E = max( lmA.rgb, vec3( 0.0 ) );
	float w = clamp( lmB.a, 0.0, 1.0 );
	vec3 Lw = brDecodeDir( lmB.xyz, w );
	vec3 Ef = vec3( 0.0 );
	for ( int k = 0; k < 4; k ++ ) Ef += max( fl[ k ], 0.0 ) * uFlick[ brChannelSlot( k, vBrLocal.xz, uOwnParity ) ];
	vec3 irr = E + Ef;
	// ---- reflection
	vec3 refl;
	if ( uReflOn > 0.5 && abs( waterY + uTileOrigin.y - uReflY ) < BR_PLANE_EPS ) {
		// the perturbed reflected ray, projected into the mirror texture at the typical distance of the reflected
		// geometry behind the surface: the distortion shrinks with distance like the real one
		vec3 rV = reflect( - V, nV );
		vec3 qV = P + rV * BR_REFL_GEOM_D;
		vec4 rc = uReflMatrix * vec4( qV, 1.0 );
		vec2 ruv = rc.xy / rc.w;
		// glossy blur: the lobe (angular radius ~ alpha) seen at the reflected geometry, stretched along the view plane
		// by 1 / cos(theta): rough water draws streaks (below). One lookup of a coarse box-filtered mip showed its texel
		// grid in the saturated contour of a bright lamp (stepped blobs)
		float br = alpha * BR_REFL_GEOM_D / ( d + BR_REFL_GEOM_D ); // radians seen from the eye
		vec2 texSz = vec2( textureSize( uReflTex, 0 ) );
		float rT = br * 0.5 * projectionMatrix[ 1 ][ 1 ] * texSz.y; // lobe radius, texels
		float cV = max( dot( V, upV ), 0.08 );
		float stretch = min( 1.0 / cV, 6.0 );
		if ( rT * stretch > 1.5 ) {
			vec3 tV = normalize( V - upV * cV + 1e-5 ); // in-plane direction toward the camera
			// the streak's direction in the mirror texture (the image of the in-plane direction toward the camera); its
			// angular length is stretch x the lateral lobe (the mirror texture has the view's projection)
			vec4 rc2 = uReflMatrix * vec4( qV + tV * ( 0.05 * ( d + BR_REFL_GEOM_D ) ), 1.0 );
			vec2 dirT = ( rc2.xy / rc2.w - ruv ) * texSz;
			dirT /= max( length( dirT ), 1e-6 );
			vec2 sd = dirT * ( rT * stretch ) / texSz; // texture-space radius along the streak
			vec2 lat = vec2( - dirT.y, dirT.x ) * rT / texSz; // lateral radius
			// the mirror texture's hardware anisotropic filter integrates the lobe's ellipse (textureGrad with its axes;
			// PlanarReflection sets anisotropy 8): two taps across it round the lateral profile, a third over twice the
			// length gives the GGX-like tail (a lamp 1000x brighter than the room keeps a visible streak)
			refl = 0.35 * ( textureGrad( uReflTex, ruv + 0.4 * lat, 1.6 * sd, lat ).rgb + textureGrad( uReflTex, ruv - 0.4 * lat, 1.6 * sd, lat ).rgb )
				+ 0.3 * textureGrad( uReflTex, ruv, 3.2 * sd, lat ).rgb;
		} else {
			refl = brWReflCubic( ruv, texSz, clamp( log2( 1.0 + rT ), 0.0, 8.0 ) );
		}
	} else {
		vec3 rW = normalize( ( vec4( reflect( - V, nV ), 0.0 ) * viewMatrix ).xyz );
		refl = brWaterEnv( rW, irr, rough, waterY, brAuxB );
	}
	// ---- specular: the baked dominant direction (an area estimate, never sharper than the surface minimum) only
	// where the water is rough; on calm water the reflection already holds the emitters
	vec3 spec = vec3( 0.0 );
	float specW = smoothstep( 0.08, 0.25, alpha );
	if ( w > 0.0 && specW > 0.0 ) {
		vec3 Lv = normalize( ( viewMatrix * vec4( Lw, 0.0 ) ).xyz );
		vec3 H = normalize( Lv + V );
		float NdL = saturate( dot( nV, Lv ) );
		spec += ( specW * w * E / max( Lw.y, BR_NG_MIN ) ) * NdL * brGGX( saturate( dot( nV, H ) ), NdV, NdL, BR_DIRECT_MIN_ROUGH )
			* brFresnelW( saturate( dot( V, H ) ) );
	}
	// ---- flashlight glints (cookie + shadow, as three's lights_fragment_begin; the waves break the beam's
	// reflection into glints); spotVis = the beam's shadow here (the in-water beam reuses it), spotE = its irradiance
	// on the flat surface (floating matter is lit by it)
	float spotVis = 1.0;
	vec3 spotE = vec3( 0.0 );
#if NUM_SPOT_LIGHTS > 0
	vec3 geometryPosition = P;
	IncidentLight directLight;
	SpotLight spotLight;
	vec4 spotColor;
	vec3 spotLightCoord;
	bool inSpotLightMap;
	#if defined( USE_SHADOWMAP ) && NUM_SPOT_LIGHT_SHADOWS > 0
	SpotLightShadow spotLightShadow;
	#endif
	#pragma unroll_loop_start
	for ( int i = 0; i < NUM_SPOT_LIGHTS; i ++ ) {
		spotLight = spotLights[ i ];
		getSpotLightInfo( spotLight, geometryPosition, directLight );
		#if ( UNROLLED_LOOP_INDEX < NUM_SPOT_LIGHT_SHADOWS_WITH_MAPS )
		#define SPOT_LIGHT_MAP_INDEX UNROLLED_LOOP_INDEX
		#elif ( UNROLLED_LOOP_INDEX < NUM_SPOT_LIGHT_SHADOWS )
		#define SPOT_LIGHT_MAP_INDEX NUM_SPOT_LIGHT_MAPS
		#else
		#define SPOT_LIGHT_MAP_INDEX ( UNROLLED_LOOP_INDEX - NUM_SPOT_LIGHT_SHADOWS + NUM_SPOT_LIGHT_SHADOWS_WITH_MAPS )
		#endif
		#if ( SPOT_LIGHT_MAP_INDEX < NUM_SPOT_LIGHT_MAPS )
			spotLightCoord = vSpotLightCoord[ i ].xyz / vSpotLightCoord[ i ].w;
			inSpotLightMap = all( lessThan( abs( spotLightCoord * 2. - 1. ), vec3( 1.0 ) ) );
			spotColor = texture2D( spotLightMap[ SPOT_LIGHT_MAP_INDEX ], spotLightCoord.xy );
			directLight.color = inSpotLightMap ? directLight.color * spotColor.rgb : directLight.color;
		#endif
		#undef SPOT_LIGHT_MAP_INDEX
		#if defined( USE_SHADOWMAP ) && ( UNROLLED_LOOP_INDEX < NUM_SPOT_LIGHT_SHADOWS )
		spotLightShadow = spotLightShadows[ i ];
		float brShadow = directLight.visible ? getShadow( spotShadowMap[ i ], spotLightShadow.shadowMapSize, spotLightShadow.shadowIntensity, spotLightShadow.shadowBias, spotLightShadow.shadowRadius, vSpotLightCoord[ i ] ) : 1.0;
		directLight.color *= brShadow;
		if ( UNROLLED_LOOP_INDEX == 0 ) spotVis = brShadow;
		#endif
		if ( directLight.visible ) {
			spotE += directLight.color * saturate( dot( upV, directLight.direction ) );
			vec3 Hs = normalize( directLight.direction + V );
			float NdLs = saturate( dot( nV, directLight.direction ) );
			spec += directLight.color * NdLs * brGGX( saturate( dot( nV, Hs ) ), NdV, NdLs, rough ) * brFresnelW( saturate( dot( V, Hs ) ) );
		}
	}
	#pragma unroll_loop_end
#endif
#ifdef BR_WATER_DEBRIS
	// the dust film scatters part of the mirror image diffusely (added with the matter below)
	refl *= 1.0 - BR_WFILM_DULL * film;
	spec *= 1.0 - BR_WFILM_DULL * film;
#endif
	// ---- the water body: opaque in volMode (the refracted scene through the medium), else premultiplied over the
	// submerged surfaces (which absorbed in their own shader)
	vec3 col = F * refl + spec;
	float A = F;
	float L = 0.0, hit = 0.0;
#ifdef BR_WATER_REFRACT
	if ( volMode ) {
		vec3 Tv = refract( - V, nV, ${(1 / 1.333).toFixed(6)} );
		float cosT = max( - dot( Tv, upV ), 0.05 );
		vec2 uvH;
		L = brWRefract( P, Tv, D / cosT, upV, vBrLocal.xz, waterY, uvH, hit );
		vec3 st;
		vec3 trans = brWVolume( uvH, L, cosT, kind, irr, st );
	#ifdef BR_WATER_VOLLIGHT
		#if NUM_SPOT_LIGHTS > 0
		trans += brWaterTorch( P, Tv, L, cosT, upV, st, kind, spotVis );
		#endif
		trans += brWaterLamps( P, Tv, L, st, kind );
	#endif
	#ifdef BR_WATER_DEBRIS
		trans *= 1.0 - BR_WCONTACT_SHADOW * ( 1.0 - smoothstep( 0.0, BR_WCONTACT_W, eC ) );
	#endif
		col += ( 1.0 - F ) * trans;
		A = 1.0;
	}
#endif
	if ( uDebugView == ${DebugView.WATER} ) {
		// water view: r = roughness alpha x 5 (volMode: the refracted path L / 2 m), g = 0.5 + ripple height (1 = +6 mm),
		// b = slope magnitude x 10 + foam (volMode: 0.5 where the march found its target + 0.5 on contact lines)
		vec3 dv = vec3( alpha * 5.0, 0.5 + rippleH * 83.0, length( S ) * 10.0 + foam );
		if ( volMode ) dv = vec3( L * 0.5, 0.5 + rippleH * 83.0, 0.5 * hit + 0.5 * ( 1.0 - smoothstep( 0.0, 0.1, eC ) ) );
		gl_FragColor = vec4( dv * BR_DEBUG_NITS, 1.0 );
		return;
	}
	// ---- floating matter on top of the water ("over": it hides the reflection and what lies below), lit by the baked
	// light and the flashlight
	vec3 irrM = irr + spotE;
#ifdef BR_WATER_DEBRIS
	float fa = 0.06 * film;
	col = mix( col, irrM / BR_PI * BR_WSCUM[ kind ], fa );
	A = mix( A, 1.0, fa );
	// the scum band along the contact, in the contact's shade
	float sc = 0.85 * brWaterScum( pw, eC, kind, uTime );
	col = mix( col, irrM / BR_PI * BR_WSCUM[ kind ] * ( 1.0 - 0.5 * BR_WCONTACT_SHADOW ), sc );
	A = mix( A, 1.0, sc );
	vec4 fk = brWaterFlecks( pw, uTime, kind, fpx );
	col = mix( col, irrM / BR_PI * fk.rgb, fk.a );
	A = mix( A, 1.0, fk.a );
#endif
#ifdef BR_WATER_RIPPLE
	// bubbles of the wading foam: a 2 cm value-noise froth thinned by the foam density
	if ( foam > 0.05 ) {
		float fc = smoothstep( 0.05, 0.6, foam * brVNoise( pw / 0.02, ivec2( 61440 ), 919u ) ) * 0.8;
		col = mix( col, irrM / BR_PI * BR_FOAM_ALB[ kind ], fc );
		A = mix( A, 1.0, fc );
	}
#endif
	// ---- air haze (package F's API) on the camera -> surface segment: an opaque surface takes it whole; the
	// premultiplied layer keeps its own share A (the floor below receives its own haze with weight 1 - A)
	if ( volMode ) col = brHaze( col, irr, - vViewPosition );
	else col = col * brHazeT( - vViewPosition ) + A * brHaze( vec3( 0.0 ), irr, - vViewPosition );
	gl_FragColor = vec4( min( max( col, vec3( 0.0 ) ), vec3( BR_HDR_CLAMP ) ), A );
}
`;
}

let fragCache: string | null = null;

/** Water defines: BR_WATER_WAVES (analytic waves, 0 = the two texture layers), BR_WATER_RIPPLE (ripple window and
 * drips), BR_WATER_DEBRIS (dust film, flecks, contact lines), BR_WATER_REFRACT = march steps (split frames: the opaque
 * refracted water body; the material then leaves the transparent list and writes depth, so the late layer's sparks
 * and motes behind the surface are hidden), BR_WATER_VOLLIGHT = in-water lamps (with the refraction), BR_PROBE (the
 * reflection probe as the environment). The key follows the full canonical definesKey. */
export function applyWaterDefines(m: THREE.ShaderMaterial, d: QualityDefines): void {
  const defs: Record<string, string> = { BR_WATER: '' };
  if (d.airlight) defs.BR_AIRLIGHT = '';
  const waves = Math.max(0, Math.min(8, Math.round(d.waterWaves)));
  if (waves > 0) defs.BR_WATER_WAVES = String(waves);
  if (d.waterRipple) defs.BR_WATER_RIPPLE = '';
  if (d.waterDebris) defs.BR_WATER_DEBRIS = '';
  if (d.waterRefract > 0) {
    defs.BR_WATER_REFRACT = String(d.waterRefract);
    if (d.waterVolLight > 0) defs.BR_WATER_VOLLIGHT = String(Math.min(4, Math.round(d.waterVolLight)));
  }
  if (d.probe) defs.BR_PROBE = '';
  m.defines = defs;
  m.transparent = d.waterRefract <= 0;
  m.depthWrite = d.waterRefract > 0;
  m.userData.brKey = `br-water-v2|${definesKey(d)}`;
  m.needsUpdate = true;
}

export function createWaterMaterial(g: MaterialGlobals, s: SharedUniforms, b: TileBindings, d: QualityDefines): THREE.ShaderMaterial {
  fragCache ??= waterFragmentGlsl();
  // three's light uniforms (cloned: they belong to this material), then OUR objects by reference
  const uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.lights]);
  bindUniforms(uniforms, g, s, b);
  uniforms.uBrRippleLerp = RIPPLE_LERP;
  const m = new THREE.ShaderMaterial({
    name: 'br-water',
    uniforms,
    vertexShader: WATER_VERTEX_GLSL,
    fragmentShader: fragCache,
    lights: true,
    transparent: true,
    depthWrite: false,
    side: THREE.FrontSide,
    blending: THREE.CustomBlending,
  });
  m.blendEquation = THREE.AddEquation;
  m.blendSrc = THREE.OneFactor;
  m.blendDst = THREE.OneMinusSrcAlphaFactor;
  m.userData.brVariant = 'water';
  applyWaterDefines(m, d);
  m.customProgramCacheKey = () => m.userData.brKey as string;
  return m;
}
