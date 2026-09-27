// src/materials/WaterMaterial.ts — the water surface: its own ShaderMaterial. Today (no refraction pass) it outputs
// reflection, specular and floating matter premultiplied: rgb = F·reflection + specular (+ matter), alpha = F (+ its
// coverage), blended (One, OneMinusSrcAlpha), so the submerged surfaces (already absorbed along the refracted view
// path by their own shader, chunks/haze.ts) show through with weight 1 − alpha.
//
// Surface (package E, chunks/water.ts): per-quad kind / depth / emitter plane / region key from the mesh (flat
// varyings, mesh/water.ts); the slope = analytic dispersive waves + texture octaves (BR_WATER_WAVES) + the ripple
// window and drip rings (BR_WATER_RIPPLE); roughness alpha = sqrt(alpha0^2 + 2 var) from the unresolved slope
// variance (+ the dust film, BR_WATER_DEBRIS). Reflection = the planar texture when this plane is the mirrored one
// (plane height == uReflY ± 2 cm; the perturbed reflected ray is projected at REFL_GEOM_D behind the surface, so the
// distortion is distance-correct, and the mip follows alpha), else the emission-map reflection at the quad's own
// emitter plane and light region over a room-average environment. Specular: the flashlight GGX with alpha (glints)
// and the baked dominant direction only where the surface is rough (on calm water the reflection already holds the
// emitters; the old term drew a halo around them). Haze through the brHaze / brHazeT API.
//
// Wave-2 slots (package E continuation, needs package A's ColorPyramid split and F's haze API): BR_WATER_REFRACT
// makes the output opaque in volMode (refracted scene colour through the medium, see the marked block), the contact
// band / meniscus reads the pyramid depth there, and the in-water lights add to `trans` before the Fresnel mix.

import * as THREE from 'three';
import { DebugView } from '../core/ids.ts';
import type { MaterialGlobals, TileBindings } from '../core/runtime.ts';
import { fragmentCommon, HAZE_FUNCS_GLSL } from './chunks/common.ts';
import { waterFilmGlsl, waterRippleGlsl, waterWavesGlsl } from './chunks/water.ts';
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
${waterWavesGlsl()}
${waterRippleGlsl()}
${waterFilmGlsl()}
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
#ifdef BR_WATER_DEBRIS
	float film = brWaterFilm( pw, uTime, kind );
	alpha = sqrt( alpha * alpha + 0.0025 * film * film );
#endif
	float rough = sqrt( alpha ); // brGGX / brEmissionRefl take the perceptual roughness (alpha = rough^2)
	vec3 nW = normalize( vec3( - S.x, 1.0, - S.y ) );
	vec3 nV = normalize( ( viewMatrix * vec4( nW, 0.0 ) ).xyz );
	vec3 V = normalize( vViewPosition );
	float NdV = max( dot( nV, V ), 1e-3 );
	float F = F_Schlick( BR_WATER_F0, 1.0, NdV );
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
	if ( uDebugView == ${DebugView.WATER} ) {
		// water view: r = roughness alpha x 5, g = 0.5 + ripple height (1 = +6 mm), b = slope magnitude x 10 + foam
		gl_FragColor = vec4( vec3( alpha * 5.0, 0.5 + rippleH * 83.0, length( S ) * 10.0 + foam ) * BR_DEBUG_NITS, 1.0 );
		return;
	}
	// ---- reflection
	vec3 refl;
	if ( uReflOn > 0.5 && abs( waterY + uTileOrigin.y - uReflY ) < BR_PLANE_EPS ) {
		// the perturbed reflected ray, projected into the mirror texture at the typical distance of the reflected
		// geometry behind the surface: the distortion shrinks with distance like the real one
		vec3 rV = reflect( - V, nV );
		vec3 qV = - vViewPosition + rV * BR_REFL_GEOM_D;
		vec4 rc = uReflMatrix * vec4( qV, 1.0 );
		vec2 ruv = rc.xy / rc.w;
		// glossy blur: the lobe (angular radius ~ alpha) seen at the reflected geometry; laterally a mip, along the
		// view plane stretched by 1 / cos(theta) (4 taps), so rough water draws streaks, not blocky squares
		float br = alpha * BR_REFL_GEOM_D / ( d + BR_REFL_GEOM_D ); // radians seen from the eye
		vec2 texSz = vec2( textureSize( uReflTex, 0 ) );
		float lod = clamp( log2( 1.0 + br * 0.5 * projectionMatrix[ 1 ][ 1 ] * texSz.y ), 0.0, 8.0 );
		vec3 upV = viewMatrix[ 1 ].xyz;
		float cV = max( dot( V, upV ), 0.08 );
		float stretch = min( 1.0 / cV, 6.0 );
		if ( br * stretch * 0.5 * projectionMatrix[ 1 ][ 1 ] * texSz.y > 1.5 ) {
			vec3 tV = normalize( V - upV * cV + 1e-5 ); // in-plane direction toward the camera
			vec4 rc2 = uReflMatrix * vec4( qV + tV * ( br * stretch * ( d + BR_REFL_GEOM_D ) ), 1.0 );
			vec2 sd = rc2.xy / rc2.w - ruv; // texture-space extent of the stretched lobe
			refl = vec3( 0.0 );
			for ( int i = 0; i < 4; i ++ ) refl += textureLod( uReflTex, ruv + sd * ( ( float( i ) - 1.5 ) / 2.0 ), lod ).rgb;
			refl *= 0.25;
		} else {
			refl = textureLod( uReflTex, ruv, lod ).rgb;
		}
	} else {
		// room-average environment: the atmosphere's haze tint is the room colour (warm Level 0, cool pool halls)
		refl = mix( irr * BR_WATER_ENV_ALBEDO / BR_PI * uHazeTint, uFarColor, 0.25 );
		vec3 rW = normalize( ( vec4( reflect( - V, nV ), 0.0 ) * viewMatrix ).xyz );
		// the quad's own emitter plane and light region (0: the rect spans several regions, accept any emitter)
		float rk = brAuxB.y + 256.0 * brAuxB.z;
		float planeH = brAuxB.w > 0.5 ? brAuxB.w * 0.05 : BR_WATER_EMIT_H;
		float emFade;
		vec3 ec = brEmissionRefl( vBrLocal, rW, waterY + planeH, rk > 0.5 ? rk : - 1.0, rough, emFade );
		refl += ec * emFade;
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
			* F_Schlick( BR_WATER_F0, 1.0, saturate( dot( V, H ) ) );
	}
	// ---- flashlight glints (cookie + shadow, as three's lights_fragment_begin; the waves break the beam's
	// reflection into glints)
#if NUM_SPOT_LIGHTS > 0
	vec3 geometryPosition = - vViewPosition;
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
		directLight.color *= directLight.visible ? getShadow( spotShadowMap[ i ], spotLightShadow.shadowMapSize, spotLightShadow.shadowIntensity, spotLightShadow.shadowBias, spotLightShadow.shadowRadius, vSpotLightCoord[ i ] ) : 1.0;
		#endif
		if ( directLight.visible ) {
			vec3 Hs = normalize( directLight.direction + V );
			float NdLs = saturate( dot( nV, directLight.direction ) );
			spec += directLight.color * NdLs * brGGX( saturate( dot( nV, Hs ) ), NdV, NdLs, rough ) * F_Schlick( BR_WATER_F0, 1.0, saturate( dot( V, Hs ) ) );
		}
	}
	#pragma unroll_loop_end
#endif
	// ---- [wave-2 slot: the refraction define, in volMode] the refracted scene colour through the medium (trans)
	// makes the water opaque here: colPm = F * refl + spec + ( 1 - F ) * trans, A = 1
	vec3 colPm = F * refl + spec; // premultiplied, alpha A
	float A = F;
	// ---- floating matter on top of the water (it hides the reflection and the floor below)
#ifdef BR_WATER_DEBRIS
	colPm += irr / BR_PI * ( 0.03 * film ) * BR_WSCUM[ kind ];
	A += 0.03 * film * ( 1.0 - A );
	vec4 fk = brWaterFlecks( pw, uTime, kind, fpx );
	colPm = mix( colPm, irr / BR_PI * fk.rgb, fk.a );
	A = mix( A, 1.0, fk.a );
#endif
#ifdef BR_WATER_RIPPLE
	// bubbles of the wading foam: a 2 cm value-noise froth thinned by the foam density
	if ( foam > 0.05 ) {
		float fc = smoothstep( 0.05, 0.6, foam * brVNoise( pw / 0.02, ivec2( 61440 ), 919u ) ) * 0.8;
		colPm = mix( colPm, irr / BR_PI * BR_FOAM_ALB[ kind ], fc );
		A = mix( A, 1.0, fc );
	}
#endif
	// ---- haze (F's API): the premultiplied layer keeps its own in-scatter share A; the floor below receives its own
	// haze with weight 1 - A
	vec3 col = colPm * brHazeT( - vViewPosition ) + A * brHaze( vec3( 0.0 ), irr, - vViewPosition );
	gl_FragColor = vec4( min( max( col, vec3( 0.0 ) ), vec3( BR_HDR_CLAMP ) ), A );
}
`;
}

let fragCache: string | null = null;

/** Water defines: BR_WATER_WAVES (analytic waves, 0 = the two texture layers), BR_WATER_RIPPLE (ripple window and
 * drips), BR_WATER_DEBRIS (dust film, flecks); the key follows the full canonical definesKey. */
export function applyWaterDefines(m: THREE.ShaderMaterial, d: QualityDefines): void {
  const defs: Record<string, string> = { BR_WATER: '' };
  if (d.airlight) defs.BR_AIRLIGHT = '';
  const waves = Math.max(0, Math.min(8, Math.round(d.waterWaves)));
  if (waves > 0) defs.BR_WATER_WAVES = String(waves);
  if (d.waterRipple) defs.BR_WATER_RIPPLE = '';
  if (d.waterDebris) defs.BR_WATER_DEBRIS = '';
  m.defines = defs;
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
