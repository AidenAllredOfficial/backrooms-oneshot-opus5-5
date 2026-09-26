// src/materials/WaterMaterial.ts — the water surface: its own ShaderMaterial that outputs ONLY reflection and
// specular, premultiplied: rgb = F·reflection + specular, alpha = F (Fresnel), blended (One, OneMinusSrcAlpha), so
// the pool floor (already absorbed by the submerged-surface optics) shows through with weight 1 − F.
// Reflection = planar texture when this plane is the mirrored one (plane height == uReflY ± 2 cm), else the
// emission-map reflection over a room-average environment tinted toward uFarColor. Two scrolling normal layers;
// specular from the lightmap dominant direction + the flashlight (lights: true, shadowed, cookie). Same haze
// maths as the surfaces; HDR clamp.

import * as THREE from 'three';
import type { MaterialGlobals, TileBindings } from '../core/runtime.ts';
import { fragmentCommon, HAZE_FUNCS_GLSL } from './chunks/common.ts';
import { bindUniforms } from './SurfaceMaterial.ts';
import { definesKey } from './shared.ts';
import type { QualityDefines, SharedUniforms } from './shared.ts';

export const WATER_VERTEX_GLSL = /* glsl */ `
#include <common>
#include <shadowmap_pars_vertex>
attribute vec2 brLmUv;
attribute vec4 brAux;
varying vec3 vViewPosition;
varying vec3 vBrLocal;
varying vec2 vBrLmUv;
varying vec4 vBrAux4;
void main() {
	vec3 transformed = position;
	vec4 mvPosition = modelViewMatrix * vec4( transformed, 1.0 );
	gl_Position = projectionMatrix * mvPosition;
	vViewPosition = - mvPosition.xyz;
	vBrLocal = transformed;
	vBrLmUv = brLmUv;
	vBrAux4 = brAux;
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
varying vec3 vViewPosition;
varying vec3 vBrLocal;
varying vec2 vBrLmUv;
varying vec4 vBrAux4;
${HAZE_FUNCS_GLSL}
void main() {
	if ( uFade < 1.0 && brBayer4( gl_FragCoord.xy ) >= uFade ) discard;
	if ( uBrReflPass > 0.5 || uDebugView != 0 ) discard; // not in its own reflection; debug views show the pool floor
	// the plane height: the fragment's own y (exact; the aux.w byte is quantised to 5 cm, coarser than BR_PLANE_EPS).
	// vBrLocal.y is storey-relative (tile-local); uReflY is world
	float waterY = vBrLocal.y;
	// ---- two scrolling normal layers (world-anchored, periods divide NOISE_WRAP; second layer axis-swapped)
	vec2 pw = vBrLocal.xz + uNoiseOrigin.xz;
	vec2 d1 = texture( uBrWaterNormals, pw / BR_WATER_NA + uTime * vec2( 0.021, 0.013 ) ).rg * 2.0 - 1.0;
	vec2 d2 = texture( uBrWaterNormals, pw.yx / BR_WATER_NB + uTime * vec2( - 0.017, 0.024 ) ).rg * 2.0 - 1.0;
	vec3 nW = normalize( vec3( ( d1.x + d2.y ) * BR_WATER_NS, 1.0, ( d1.y + d2.x ) * BR_WATER_NS ) );
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
	// ---- reflection
	vec3 refl;
	if ( uReflOn > 0.5 && abs( waterY + uTileOrigin.y - uReflY ) < BR_PLANE_EPS ) {
		vec4 rc = uReflMatrix * vec4( - vViewPosition, 1.0 );
		vec2 ruv = rc.xy / rc.w + nW.xz * BR_REFL_DISTORT;
		refl = textureLod( uReflTex, ruv, BR_WATER_ROUGH * BR_REFL_LOD ).rgb;
	} else {
		refl = mix( irr * BR_WATER_ENV_ALBEDO / BR_PI * BR_WATER_ENV_TINT, uFarColor, 0.25 );
		vec3 rW = normalize( ( vec4( reflect( - V, nV ), 0.0 ) * viewMatrix ).xyz );
		float emFade;
		vec3 ec = brEmissionRefl( vBrLocal, rW, waterY + BR_WATER_EMIT_H, - 1.0, BR_WATER_ROUGH, emFade );
		refl += ec * emFade;
	}
	// ---- specular: baked dominant direction (an area estimate: never sharper than the surface minimum)
	vec3 spec = vec3( 0.0 );
	if ( w > 0.0 ) {
		vec3 Lv = normalize( ( viewMatrix * vec4( Lw, 0.0 ) ).xyz );
		vec3 H = normalize( Lv + V );
		float NdL = saturate( dot( nV, Lv ) );
		spec += ( w * E / max( Lw.y, BR_NG_MIN ) ) * NdL * brGGX( saturate( dot( nV, H ) ), NdV, NdL, BR_DIRECT_MIN_ROUGH )
			* F_Schlick( BR_WATER_F0, 1.0, saturate( dot( V, H ) ) );
	}
	// ---- flashlight glint (cookie + shadow, as three's lights_fragment_begin)
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
			spec += directLight.color * NdLs * brGGX( saturate( dot( nV, Hs ) ), NdV, NdLs, BR_WATER_ROUGH ) * F_Schlick( BR_WATER_F0, 1.0, saturate( dot( V, Hs ) ) );
		}
	}
	#pragma unroll_loop_end
#endif
	// ---- haze on the premultiplied layer: the floor below receives its own haze with weight 1 - F
	float d = length( vViewPosition );
	float fh; vec3 insc; float fe;
	brHazeTerms( irr, d, fh, insc, fe );
	vec3 reflH = mix( mix( refl, insc, fh ) + brAirlight( - vViewPosition, d ), uFarColor, fe );
	vec3 col = F * reflH + spec * ( 1.0 - fh ) * ( 1.0 - fe );
	gl_FragColor = vec4( min( max( col, vec3( 0.0 ) ), vec3( BR_HDR_CLAMP ) ), F );
}
`;
}

let fragCache: string | null = null;

export function applyWaterDefines(m: THREE.ShaderMaterial, d: QualityDefines): void {
  const defs: Record<string, string> = { BR_WATER: '' };
  if (d.airlight) defs.BR_AIRLIGHT = '';
  m.defines = defs;
  m.userData.brKey = `br-water-v1|${definesKey(d)}`;
  m.needsUpdate = true;
}

export function createWaterMaterial(g: MaterialGlobals, s: SharedUniforms, b: TileBindings, d: QualityDefines): THREE.ShaderMaterial {
  fragCache ??= waterFragmentGlsl();
  // three's light uniforms (cloned: they belong to this material), then OUR objects by reference
  const uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.lights]);
  bindUniforms(uniforms, g, s, b);
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
