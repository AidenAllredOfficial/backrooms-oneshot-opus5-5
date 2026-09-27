// src/materials/chunks/vertex.ts — vertex-stage injections for the surface variants (shell/props/decal).
// Attribute names per core/mesh.ts (never uv1/uv2). brTint/brAux are normalized u8 (0..1); shaders multiply aux by
// 255. vBrLocal is the tile-local position (mesh vertices are tile-local; tile groups carry only a translation).
// Layer, flags, tint, emit and aux are per-face state (GeometryWriter.setState, mesh/buildTile.ts), equal on the
// three vertices of every triangle (tests/materials/depthPrepass.test.ts), so they are flat: no per-triangle
// interpolation setup, and each fragment reads the exact value.

import { DROP_LENS_AUX, DROP_LENS_H, VFlag } from '../../core/ids.ts';

/** Radius (px) below which thin props tubes are widened. A 4-sided tube of this radius is at least 1.06 px wide
 * (3-sided: 1.1 px), so every row / column it crosses has a covered pixel centre. */
export const WIRE_MIN_PX = 0.75;

/** Screen-space minimum width of thin props tubes (cables, cords, hanger rods: PartBuilder.wire, aux.y = radius in
 * 0.1 mm on PROP_AUX vertices). Their normals are radial and caps are never tagged, so the axis is p - n * r; the
 * vertex moves out along n until the tube's radius spans WIRE_MIN_PX at the axis' view depth. Shared verbatim by
 * the surface and depth-prepass programs (both invariant gl_Position). uBrWirePx: world size of one pixel at unit
 * view depth (2 / (P[1][1] * target height), materials/shared.ts setWirePixel). */
// Drop lenses (aux.y = DROP_LENS_AUX, core/ids.ts) use the same mechanism to keep a minimum projected depth.
export const WIRE_GLSL = /* glsl */ `
uniform float uBrWirePx;
vec3 brWire( vec3 p, vec3 n, float flags, float auxY ) {
	float r = auxY * 0.0255; // normalized u8 x 255 x 0.1 mm
	if ( r <= 0.0 || ( int( flags + 0.5 ) & ${VFlag.PROP_AUX} ) == 0 ) return p;
	if ( auxY * 255.0 > ${DROP_LENS_AUX - 0.5} ) {
		// drop lens: its down-facing vertices (bottom face, lower edge of the sides) move down until the lens is at
		// least 1 px deep, so a distant lens seen edge-on stays a continuous lit line
		if ( n.y > -0.5 ) return p;
		float dz = - ( modelViewMatrix * vec4( p, 1.0 ) ).z;
		return p - vec3( 0.0, max( 0.0, uBrWirePx * dz - ${DROP_LENS_H} ), 0.0 );
	}
	n = normalize( n );
	float depth = - ( modelViewMatrix * vec4( p - n * r, 1.0 ) ).z;
	return p + n * max( 0.0, ${WIRE_MIN_PX.toFixed(2)} * uBrWirePx * depth - r );
}
`;

/** After `#include <common>`. */
export const VERT_PARS_GLSL = /* glsl */ `
attribute vec2 brLmUv;
attribute float brLayer;
attribute float brFlags;
attribute vec4 brTint;
attribute float brEmit;
attribute vec4 brAux;
varying vec2 vBrUv;
varying vec2 vBrLmUv;
varying vec3 vBrLocal;
flat varying vec4 vBrTint;
flat varying vec4 vBrAux4;
flat varying float vBrLayer;
flat varying float vBrFlags;
flat varying float vBrEmit;
varying vec3 vBrNrmW;
`;

/** After `#include <uv_vertex>`. vBrNrmW: the tile-local normal (= world orientation; tile groups never rotate). */
export const VERT_UV_GLSL = /* glsl */ `
vBrUv = uv;
vBrLmUv = brLmUv;
vBrLayer = brLayer;
vBrFlags = brFlags;
vBrTint = brTint;
vBrEmit = brEmit;
vBrAux4 = brAux;
vBrNrmW = normal;
`;

/** After `#include <begin_vertex>` (before project_vertex). */
export const VERT_BEGIN_GLSL = /* glsl */ `
transformed = brWire( transformed, normal, brFlags, brAux.y );
`;

/** After `#include <worldpos_vertex>`. */
export const VERT_WORLDPOS_GLSL = /* glsl */ `
vBrLocal = transformed;
`;

/** Varyings as seen by the fragment stage (after `#include <common>`). */
export const FRAG_VARYINGS_GLSL = /* glsl */ `
varying vec2 vBrUv;
varying vec2 vBrLmUv;
varying vec3 vBrLocal;
flat varying vec4 vBrTint;
flat varying vec4 vBrAux4;
flat varying float vBrLayer;
flat varying float vBrFlags;
flat varying float vBrEmit;
varying vec3 vBrNrmW;
`;
