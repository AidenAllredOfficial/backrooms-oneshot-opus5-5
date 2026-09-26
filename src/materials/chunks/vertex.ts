// src/materials/chunks/vertex.ts — vertex-stage injections for the surface variants (shell/props/decal).
// Attribute names per core/mesh.ts (never uv1/uv2). brTint/brAux are normalized u8 (0..1); shaders multiply aux by
// 255. vBrLocal is the tile-local position (mesh vertices are tile-local; tile groups carry only a translation).
// Layer, flags, tint, emit and aux are per-face state (GeometryWriter.setState, mesh/buildTile.ts), equal on the
// three vertices of every triangle (tests/materials/depthPrepass.test.ts), so they are flat: no per-triangle
// interpolation setup, and each fragment reads the exact value.

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
