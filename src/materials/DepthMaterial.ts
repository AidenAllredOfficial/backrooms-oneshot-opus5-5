// src/materials/DepthMaterial.ts — the depth-prepass program for shell and props surfaces (materials/prepass.ts).
// It must write exactly the depth the surface program will test with LEQUAL, and discard exactly the fragments the
// surface program discards:
//  - position: both vertex shaders declare `invariant gl_Position` and compute it with three's project_vertex
//    expressions from the same attribute and matrices (VERT_INVARIANT_GLSL is injected into the surface program),
//    after the same thin-tube widening (WIRE_GLSL);
//  - tile fade: the same ordered dither against the tile's own fade uniform object;
//  - alpha test (VFlag.DECAL on shell/props): alb.a < 0.5 on the plain textureGrad path. The layers that carry the
//    flag (METAL_GRATE, SIGNAGE, DECAL_ATLAS) have no rotated-tile or stochastic sampling
//    (tests/materials/depthMaterial.test.ts), so the surface program samples their albedo the same way;
//  - props in the reflection pass: beyond REFL_PROP_DIST, from the same interpolated view position (uPropCull = 1 on
//    the props material; one program for both).
// Soft decals, water and sparks never write depth and are hidden during the prepass.

import * as THREE from 'three';
import { VFlag } from '../core/ids.ts';
import { TUNE } from './chunks/params.ts';
import type { TileBindings } from '../core/runtime.ts';
import type { SharedUniforms } from './shared.ts';
import { WIRE_GLSL } from './chunks/vertex.ts';

export const DEPTH_CACHE_KEY = 'br-depth-v1';

/** Injected after `#include <common>` in the surface vertex shader. */
export const VERT_INVARIANT_GLSL = 'invariant gl_Position;';

const VERT = /* glsl */ `
invariant gl_Position;
in float brLayer;
in float brFlags;
in vec4 brAux;
${WIRE_GLSL}
out vec2 vBrUv;
flat out float vBrLayer;
flat out float vBrFlags;
out vec3 vViewPosition;
void main() {
	vBrUv = uv;
	vBrLayer = brLayer;
	vBrFlags = brFlags;
	// three's project_vertex, expression for expression
	vec3 transformed = vec3( position );
	transformed = brWire( transformed, normal, brFlags, brAux.y );
	vec4 mvPosition = vec4( transformed, 1.0 );
	mvPosition = modelViewMatrix * mvPosition;
	gl_Position = projectionMatrix * mvPosition;
	vViewPosition = - mvPosition.xyz;
}
`;

const FRAG = /* glsl */ `
precision highp sampler2DArray;
uniform sampler2DArray uBrAlbedo;
uniform float uFade;
uniform float uBrReflPass;
uniform float uPropCull;
in vec2 vBrUv;
flat in float vBrLayer;
flat in float vBrFlags;
in vec3 vViewPosition;
layout( location = 0 ) out highp vec4 outColor;
float brBayer4( vec2 fc ) {
	ivec2 p = ivec2( fc ) & 3;
	int i = p.y * 4 + p.x;
	const float m[ 16 ] = float[ 16 ]( 0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0 );
	return ( m[ i ] + 0.5 ) / 16.0;
}
void main() {
	if ( uFade < 1.0 && brBayer4( gl_FragCoord.xy ) >= uFade ) discard;
	if ( uPropCull > 0.5 && uBrReflPass > 0.5 && length( vViewPosition ) > ${TUNE.REFL_PROP_DIST.toFixed(1)} ) discard;
	if ( ( int( vBrFlags + 0.5 ) & ${VFlag.DECAL} ) != 0 ) {
		vec2 uv = vBrUv;
		if ( textureGrad( uBrAlbedo, vec3( uv, float( int( vBrLayer + 0.5 ) ) ), dFdx( uv ), dFdy( uv ) ).a < 0.5 ) discard;
	}
	outColor = vec4( 0.0 );
}
`;

/** props = true: the props variant (reflection-pass distance cull), same program. */
export function createDepthMaterial(s: SharedUniforms, b: TileBindings, props: boolean): THREE.ShaderMaterial {
  const m = new THREE.ShaderMaterial({
    name: 'br-depth',
    glslVersion: THREE.GLSL3,
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: { uBrAlbedo: s.albedo, uFade: b.fade, uBrReflPass: s.reflPass, uBrWirePx: s.wirePx, uPropCull: { value: props ? 1 : 0 } },
    side: THREE.FrontSide,
    colorWrite: false,
    depthWrite: true,
    depthTest: true,
    toneMapped: false,
  });
  m.customProgramCacheKey = () => DEPTH_CACHE_KEY;
  return m;
}
