// src/post/VolumetricFog.ts — package F: froxel volumetrics. The air between the camera and every surface, lit by the
// baked light field (lighting/LightAtlas.ts: lamp halos, lit air veiling dark doorways, dark rooms staying dark, live
// flicker) and by the shadowed, cookie-shaped flashlight (shafts behind obstacles), with drifting dust and mist over
// water (lighting/volumetricDensity.ts). Runs as the frame graph's afterDepth hook 'volumetrics' (order 40: after the
// prepass has updated the flashlight shadow map and after the 'lightAtlas' hook); the shading render then samples the
// integrated volume per pixel (chunks/volumetric.ts brVolLookup, dispatched by brHaze / brHazeT in chunks/common.ts).
//
// Grid: W x H x N froxels over the view frustum (high 160 x 90 x 64 to 48 m, ultra 192 x 108 x 80 to 56 m; W follows
// the aspect), exponential slices in view depth: b_0 = 0, b_k = zN (zF / zN)^((k - 1) / (N - 1)) for k >= 1, i.e. the
// continuous boundary coordinate s(z) = z / zN below zN, else 1 + (N - 1) ln(z / zN) / ln(zF / zN). The slices are
// tiled TILES_PER_ROW per row into 2D RGBA16F atlases (high 1280 x 720, ultra 1536 x 1080).
//  1. inject (one fragment per froxel, no history: deterministic under time= and without lag for the camera-held torch):
//     density sigma_t = haze + dust + mist, scattering sigma_s = haze albedo + dust 0.85 + mist 0.97;
//     baked light at the froxel centre: S_b = GAIN [w E p(mu) + sigma_s (2 (1 - w) E + Ef) / 4 PI] (the directional
//     part through the phase function, the ambient part as hemispherical fluence 2E and the flicker channels
//     isotropic), p = the sigma_s-weighted dual HG of haze + dust (the zone's forward weight) and HG(0.75) of mist;
//     torch: E_f = I cookie spot window vis / d^2 over the ray segment through the slice, the inverse square
//     integrated in closed form and two equiangular samples (dithered 2x2 across froxels) for the rest, with the
//     shadow map compared through sampler2DShadow in a camera-relative shadow matrix (float64 on the CPU).
//     out = (S tint (per metre), sigma_t).
//  2. filter: a 3x3 tent in x and y inside each slice (four bilinear taps), which cancels the 2x2 dither.
//  3. scanLocal: froxel k of group g = floor(k / 8) folds slices 8g..k front to back with the energy-conserving step
//     S += T S_i (1 - exp(-sigma_i D_i)) / sigma_i, T *= exp(-sigma_i D_i) (D_i = the ray's length in the slice).
//  4. scanCombine: the earlier groups' totals (their slice 8j + 7) composed in order, then the froxel's own local
//     value: (S, T) o (S', T') = (S + T S', T T'). Texel k = in-scatter and transmittance from the camera to b_{k+1}.
// Published: MaterialGlobals.volTex / volGrid (W, H, N, tiles per row) / volZ (zN, zF, (N - 1) / ln(zF / zN), on) /
// volScreen (1 / the target size). on = 1 only where the atlas holds the camera's own tile (loading, test scenes and
// the planar reflection keep the analytic haze).

import * as THREE from 'three';
import type { TorchUniforms } from '../lighting/dustMotes.ts';
import { lightAtlasGlsl, type LightAtlas } from '../lighting/LightAtlas.ts';
import { PHASE, PHASE_GLSL } from '../lighting/phase.ts';
import { noiseOffsets, VD, volumetricDensityGlsl } from '../lighting/volumetricDensity.ts';
import { f } from '../materials/chunks/params.ts';
import { FullscreenQuad, quadMaterial } from './frame/quad.ts';
import type { FrameContext } from './ScenePass.ts';

export const VOL = {
  /** VOL_GAIN: calibration of the baked in-scatter against the analytic haze it replaces (lit zones keep their
   * brightness; the final grade retune follows) */
  GAIN: 0.75,
  /** calibration of the torch in-scatter (1 = physical) */
  TORCH_GAIN: 1.0,
  /** m: the first slice boundary */
  ZN: 0.5,
  TILES_PER_ROW: 8,
  /** m: the smallest distance of a view ray from the torch in its inverse-square integral (the lamp is not a point) */
  TORCH_MIN_H: 0.1,
  /** shadow-map depth bias of the air samples (window depth units) */
  SHADOW_BIAS: 3e-4,
} as const;

export type VolGridName = 'high' | 'ultra';
export const VOL_GRIDS: Readonly<Record<VolGridName, { h: number; n: number; zF: number }>> = {
  high: { h: 90, n: 64, zF: 48 },
  // zF 56 m, not 64: the light atlas window only guarantees 57.6 m (LightAtlas LA.REACH)
  ultra: { h: 108, n: 80, zF: 56 },
};

/** Froxel columns for a grid of `h` rows at an aspect ratio (a multiple of 8). */
export const gridWidth = (h: number, aspect: number): number => Math.max(8, Math.round((h * aspect) / 8) * 8);

/** Continuous slice-boundary coordinate of view depth z (s(b_k) = k). */
export function sliceCoord(z: number, zN: number, zF: number, n: number): number {
  return z < zN ? z / zN : 1 + ((n - 1) * Math.log(z / zN)) / Math.log(zF / zN);
}
/** View depth of slice-boundary coordinate s (the inverse of sliceCoord). */
export function sliceDepth(s: number, zN: number, zF: number, n: number): number {
  return s < 1 ? s * zN : zN * Math.exp(((s - 1) * Math.log(zF / zN)) / (n - 1));
}
/** Atlas size (texels) of a W x H x N grid tiled `perRow` slices per row. */
export const atlasSize = (w: number, h: number, n: number, perRow: number = VOL.TILES_PER_ROW): [number, number] =>
  [w * perRow, h * Math.ceil(n / perRow)];

/** One scan step (TS twin of the GLSL): fold a slice of in-scatter s (per metre, per channel), extinction sigma and
 * length D into (S, T) in place: out = [S, T]. */
export function scanStep(out: [number, number], s: number, sigma: number, D: number): void {
  const st = sigma * D;
  const Ti = Math.exp(-st);
  const Si = st > 1e-5 ? (s * (1 - Ti)) / sigma : s * D;
  out[0] += out[1] * Si;
  out[1] *= Ti;
}
/** Composition of two consecutive segments (S, T) o (S', T'). */
export const scanCompose = (a: readonly [number, number], b: readonly [number, number]): [number, number] =>
  [a[0] + a[1] * b[0], a[1] * b[1]];

const SLICE_GLSL = /* glsl */ `
uniform vec4 uGrid; // W, H, N, slices per row
uniform vec4 uZ; // zN, zF, (N - 1) / ln(zF / zN), ln(zF / zN) / (N - 1)
uniform vec4 uProj; // 1 / P00, 1 / P11, P20, P21 of the camera projection
layout( location = 0 ) out highp vec4 outColor;
float brSliceDepth( float s ) { return s < 1.0 ? s * uZ.x : uZ.x * exp( ( s - 1.0 ) * uZ.w ); }
// the froxel this fragment of the tiled atlas stands for: false past the last slice
bool brFroxel( out ivec2 xy, out int k ) {
	ivec2 fc = ivec2( gl_FragCoord.xy );
	ivec2 g = ivec2( uGrid.xy );
	ivec2 t = fc / g;
	k = t.x + t.y * int( uGrid.w );
	xy = fc - t * g;
	return k < int( uGrid.z );
}
ivec2 brSliceTexel( int k, ivec2 xy ) {
	int per = int( uGrid.w );
	return ivec2( k - ( k / per ) * per, k / per ) * ivec2( uGrid.xy ) + xy;
}
// view-space ray through a froxel column at view depth 1 (z = -1)
vec3 brFroxelRay( ivec2 xy ) {
	vec2 ndc = ( vec2( xy ) + 0.5 ) / uGrid.xy * 2.0 - 1.0;
	return vec3( ( ndc.x + uProj.z ) * uProj.x, ( ndc.y + uProj.w ) * uProj.y, - 1.0 );
}
`;

function injectGlsl(): string {
  return /* glsl */ `
precision highp float;
precision highp sampler2DShadow;
${SLICE_GLSL}
uniform mat3 uCamRot; // view -> world rotation
uniform float uCamY; // camera y (storey-relative)
uniform vec4 uAir; // haze density, haze albedo, dust density, dust noise
uniform vec4 uAir2; // mist density, forward phase weight, baked gain, torch gain
uniform vec3 uTint;
uniform float uFlOn;
uniform vec3 uFlPos; // camera-relative
uniform vec3 uFlDir;
uniform vec2 uFlCone; // cos(angle), cos(angle (1 - penumbra))
uniform vec3 uFlCol; // colour x intensity (cd)
uniform float uFlRange;
uniform mat4 uFlShadowRel; // shadow matrix x translation(camera)
uniform sampler2D uFlCookie;
uniform sampler2DShadow uFlShadow;
${lightAtlasGlsl()}
${PHASE_GLSL}
${volumetricDensityGlsl()}
// 2x2 ordered dither (0, 2 / 3, 1): the tent filter pass cancels exactly this pattern
float brVolDither( ivec2 p ) {
	int i = ( p.y & 1 ) * 2 + ( p.x & 1 );
	const float m[ 4 ] = float[ 4 ]( 0.0, 2.0, 3.0, 1.0 );
	return ( m[ i ] + 0.5 ) * 0.25;
}
void main() {
	ivec2 xy; int k;
	if ( ! brFroxel( xy, k ) ) { outColor = vec4( 0.0 ); return; }
	vec3 rayV = brFroxelRay( xy );
	vec3 rd = normalize( uCamRot * rayV );
	// the medium at the froxel centre
	vec3 relC = uCamRot * ( rayV * brSliceDepth( float( k ) + 0.5 ) );
	vec3 pn = relC + uVdCam;
	float dust = uAir.z > 0.0 ? brDustDensity( uAir.z, uAir.w, brDustNoise( pn ), relC.y + uCamY ) : 0.0;
	float mist = uAir2.x > 0.0 ? uAir2.x * brMist( relC, pn ) : 0.0;
	float sAir = uAir.x * uAir.y + dust * ${f(VD.DUST_ALBEDO)}; // haze + dust: the zone's dual lobe
	float sMist = mist * ${f(VD.MIST_ALBEDO)}; // droplets: strongly forward
	float sigmaT = uAir.x + dust + mist;
	vec3 S = vec3( 0.0 );
	// baked light field
	vec3 E, Ld, Ef;
	float w;
	if ( sAir + sMist > 0.0 && brLaSample( relC, E, w, Ld, Ef ) ) {
		float mu = dot( Ld, rd );
		float ph = sAir * brPhaseAir( mu, uAir2.y ) + sMist * brPhaseMist( mu );
		S += uAir2.z * ( w * E * ph + ( sAir + sMist ) * ( 2.0 * ( 1.0 - w ) * E + Ef ) * ${f(1 / (4 * Math.PI))} );
	}
	// the torch over the ray segment through the slice, s in [s0, s1]: the inverse square integrates in closed form
	// (J = the integral of ds / d^2 = (a1 - a0) / h, h the beam origin's distance from the ray), and two equiangular
	// samples (uniform in the angle seen from the torch, i.e. spread by 1 / d^2; stratified with a 2x2 dither across
	// froxels, which the tent filter below averages into 8 positions) carry the cookie, the cone, the shadow and the
	// phase. Near the lens, where 1 / d^2 changes fastest, this stays smooth.
	if ( uFlOn > 0.5 && sAir + sMist > 0.0 ) {
		float len = length( rayV );
		float s0 = brSliceDepth( float( k ) ) * len;
		float s1 = brSliceDepth( float( k + 1 ) ) * len;
		float tc = dot( uFlPos, rd );
		float h = max( sqrt( max( dot( uFlPos, uFlPos ) - tc * tc, 0.0 ) ), ${f(VOL.TORCH_MIN_H)} );
		float a0 = atan( ( s0 - tc ) / h );
		float a1 = atan( ( s1 - tc ) / h );
		float dz = brVolDither( xy ) - 0.5;
		vec3 Sf = vec3( 0.0 );
		for ( int i = 0; i < 2; i ++ ) {
			float s = tc + h * tan( mix( a0, a1, ( float( i ) + 0.5 + dz ) * 0.5 ) );
			vec3 rel = rd * s;
			vec3 L = uFlPos - rel;
			float d = max( length( L ), 1e-3 );
			vec3 l = L / d;
			float spot = smoothstep( uFlCone.x, uFlCone.y, dot( - l, uFlDir ) );
			float q = d / uFlRange;
			float win = clamp( 1.0 - q * q * q * q, 0.0, 1.0 );
			if ( spot * win <= 0.0 ) continue;
			vec4 sc = uFlShadowRel * vec4( rel, 1.0 );
			vec3 sp = sc.xyz / sc.w;
			if ( sc.w <= 0.0 || any( lessThan( sp.xy, vec2( 0.0 ) ) ) || any( greaterThan( sp.xy, vec2( 1.0 ) ) ) ) continue;
			float vis = sp.z >= 1.0 ? 1.0 : textureLod( uFlShadow, vec3( sp.xy, sp.z - ${f(VOL.SHADOW_BIAS)} ), 0.0 );
			if ( vis <= 0.0 ) continue;
			vec3 ck = textureLod( uFlCookie, sp.xy, 0.0 ).rgb;
			float mu = dot( l, rd );
			Sf += uFlCol * ck * ( spot * win * win * vis ) * ( sAir * brPhaseAir( mu, uAir2.y ) + sMist * brPhaseMist( mu ) );
		}
		// the slice's mean in-scatter per metre: (1 / D) * J * the mean of the samples
		S += uAir2.w * Sf * ( 0.5 * ( a1 - a0 ) / ( h * max( s1 - s0, 1e-4 ) ) );
	}
	outColor = vec4( S * uTint, sigmaT );
}
`;
}

// 3x3 tent ([1 2 1] / 4 in x and y) of the injected slices from four bilinear taps at the texel corners, kept inside
// each slice's tile: it cancels the 2x2 dither pattern of the torch samples (whose samples straddle shadow edges
// and surfaces) at the cost of one froxel of blur
const FILTER_GLSL = /* glsl */ `
precision highp float;
${SLICE_GLSL}
uniform highp sampler2D uInj; // linear filtering
void main() {
	ivec2 xy; int k;
	if ( ! brFroxel( xy, k ) ) { outColor = vec4( 0.0 ); return; }
	vec2 org = vec2( brSliceTexel( k, ivec2( 0 ) ) );
	vec2 isz = 1.0 / vec2( textureSize( uInj, 0 ) );
	vec2 p = vec2( xy ) + 0.5;
	vec2 lo = vec2( 0.5 ), hi = uGrid.xy - 0.5;
	vec4 v = textureLod( uInj, ( org + clamp( p + vec2( - 0.5, - 0.5 ), lo, hi ) ) * isz, 0.0 )
		+ textureLod( uInj, ( org + clamp( p + vec2( 0.5, - 0.5 ), lo, hi ) ) * isz, 0.0 )
		+ textureLod( uInj, ( org + clamp( p + vec2( - 0.5, 0.5 ), lo, hi ) ) * isz, 0.0 )
		+ textureLod( uInj, ( org + clamp( p + vec2( 0.5, 0.5 ), lo, hi ) ) * isz, 0.0 );
	outColor = 0.25 * v;
}
`;

const SCAN_LOCAL_GLSL = /* glsl */ `
precision highp float;
${SLICE_GLSL}
uniform highp sampler2D uInj;
void main() {
	ivec2 xy; int k;
	if ( ! brFroxel( xy, k ) ) { outColor = vec4( 0.0, 0.0, 0.0, 1.0 ); return; }
	float len = length( brFroxelRay( xy ) ); // ray length per metre of view depth
	vec3 S = vec3( 0.0 );
	float T = 1.0;
	for ( int i = ( k / ${VOL.TILES_PER_ROW} ) * ${VOL.TILES_PER_ROW}; i <= k; i ++ ) {
		vec4 v = texelFetch( uInj, brSliceTexel( i, xy ), 0 );
		float D = ( brSliceDepth( float( i + 1 ) ) - brSliceDepth( float( i ) ) ) * len;
		float st = v.a * D;
		float Ti = exp( - st );
		S += T * ( st > 1e-5 ? v.rgb * ( ( 1.0 - Ti ) / v.a ) : v.rgb * D );
		T *= Ti;
	}
	outColor = vec4( S, T );
}
`;

const SCAN_COMBINE_GLSL = /* glsl */ `
precision highp float;
${SLICE_GLSL}
uniform highp sampler2D uLocal;
void main() {
	ivec2 xy; int k;
	if ( ! brFroxel( xy, k ) ) { outColor = vec4( 0.0, 0.0, 0.0, 1.0 ); return; }
	int g = k / ${VOL.TILES_PER_ROW};
	vec3 S = vec3( 0.0 );
	float T = 1.0;
	for ( int j = 0; j < g; j ++ ) {
		vec4 v = texelFetch( uLocal, brSliceTexel( j * ${VOL.TILES_PER_ROW} + ${VOL.TILES_PER_ROW - 1}, xy ), 0 );
		S += T * v.rgb;
		T *= v.a;
	}
	vec4 v = texelFetch( uLocal, brSliceTexel( k, xy ), 0 );
	outColor = vec4( S + T * v.rgb, T * v.a );
}
`;

/** Per-frame atmosphere of the froxels (LightingRuntime.update writes it). */
export interface VolAtmosphere {
  hazeDensity: number;
  hazeAlbedo: number;
  tint: [number, number, number];
  dust: number;
  dustNoise: number;
  mist: number;
  /** forward weight of the dual HG */
  phase: number;
  /** simulation time (s): the drift of the dust and the rise of the mist */
  t: number;
  /** water rects near the eye, world: (x0, z0, x1, z1, y, kind factor) x mistCount */
  mistRects: Float64Array;
  mistCount: number;
}

export function newVolAtmosphere(): VolAtmosphere {
  return {
    hazeDensity: 0, hazeAlbedo: 0.5, tint: [1, 1, 1], dust: 0, dustNoise: 0.5, mist: 0, phase: PHASE.W_F, t: 0,
    mistRects: new Float64Array(VD.MIST_MAX * 6), mistCount: 0,
  };
}

const rt = (w: number, h: number, linear: boolean, name: string): THREE.WebGLRenderTarget => {
  const t = new THREE.WebGLRenderTarget(w, h, {
    type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
    minFilter: linear ? THREE.LinearFilter : THREE.NearestFilter, magFilter: linear ? THREE.LinearFilter : THREE.NearestFilter,
    wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping,
  });
  t.texture.name = name;
  return t;
};

export class VolumetricFog {
  readonly atmosphere: VolAtmosphere = newVolAtmosphere();
  /** the torch uniforms this pass writes each frame (the dust motes bind the same objects) */
  readonly torch: TorchUniforms;
  private grid: VolGridName;
  private w = 0;
  private h = 0;
  private n = 0;
  private zF = 48;
  // three atlases: `lin` (linear) takes the injection, whose bilinear taps the filter reads, and then the integrated
  // result, whose bilinear taps the surfaces read; `filtered` and `local` are nearest
  private lin: THREE.WebGLRenderTarget | null = null;
  private filtered: THREE.WebGLRenderTarget | null = null;
  private local: THREE.WebGLRenderTarget | null = null;
  private readonly quad = new FullscreenQuad();
  private readonly injMat: THREE.ShaderMaterial;
  private readonly filterMat: THREE.ShaderMaterial;
  private readonly localMat: THREE.ShaderMaterial;
  private readonly combineMat: THREE.ShaderMaterial;
  private readonly u: Record<string, THREE.IUniform>;
  private readonly noise = new Float64Array(6);
  private readonly shadowRel = new THREE.Matrix4();
  private readonly tmpM = new THREE.Matrix4();
  private readonly lpos = new THREE.Vector3();
  private readonly tpos = new THREE.Vector3();
  /** the last render published a valid volume */
  on = false;

  private readonly atlas: LightAtlas;
  private readonly light: THREE.SpotLight;

  constructor(atlas: LightAtlas, light: THREE.SpotLight, grid: VolGridName) {
    this.atlas = atlas;
    this.light = light;
    this.grid = grid;
    const shared = {
      uGrid: { value: new THREE.Vector4(1, 1, 1, VOL.TILES_PER_ROW) },
      uZ: { value: new THREE.Vector4(VOL.ZN, 48, 1, 1) },
      uProj: { value: new THREE.Vector4(1, 1, 0, 0) },
    };
    const mistRect = Array.from({ length: VD.MIST_MAX }, () => new THREE.Vector4());
    const mistInfo = Array.from({ length: VD.MIST_MAX }, () => new THREE.Vector4());
    this.torch = {
      uFlOn: { value: 0 },
      uFlPos: { value: new THREE.Vector3() },
      uFlDir: { value: new THREE.Vector3(0, 0, -1) },
      uFlCone: { value: new THREE.Vector2(0.5, 0.6) },
      uFlCol: { value: new THREE.Vector3() },
      uFlRange: { value: 40 },
      uFlShadowRel: { value: this.shadowRel },
      uFlCookie: { value: null },
      uFlShadow: { value: null },
    };
    this.u = {
      ...shared,
      uCamRot: { value: new THREE.Matrix3() },
      uCamY: { value: 0 },
      uAir: { value: new THREE.Vector4() },
      uAir2: { value: new THREE.Vector4() },
      uTint: { value: new THREE.Vector3(1, 1, 1) },
      ...this.torch,
      uVdCam: { value: new THREE.Vector3() },
      uVdMistOff: { value: new THREE.Vector3() },
      uMistRect: { value: mistRect },
      uMistInfo: { value: mistInfo },
      uMistCount: { value: 0 },
      ...atlas.uniforms,
    };
    this.injMat = quadMaterial('br-vol-inject', injectGlsl(), {}, this.u);
    this.filterMat = quadMaterial('br-vol-filter', FILTER_GLSL, {}, { ...shared, uInj: { value: null } });
    this.localMat = quadMaterial('br-vol-scan-local', SCAN_LOCAL_GLSL, {}, { ...shared, uInj: { value: null } });
    this.combineMat = quadMaterial('br-vol-scan-combine', SCAN_COMBINE_GLSL, {}, { ...shared, uLocal: { value: null } });
  }

  /** The quad programs (compiled ahead by boot / the quality switch). */
  get materials(): readonly THREE.ShaderMaterial[] { return [this.injMat, this.filterMat, this.localMat, this.combineMat]; }

  setGrid(grid: VolGridName): void {
    if (grid === this.grid) return;
    this.grid = grid;
    this.w = 0; // re-grid at the next render
  }

  /** The froxel pass (afterDepth hook 'volumetrics'). */
  render(ctx: FrameContext): void {
    const g = ctx.globals;
    if (!g) return;
    const cam = ctx.camera;
    const cp = cam.position;
    this.on = this.atlas.validAt(cp.x, cp.z);
    if (!this.on) { g.volZ.value.w = 0; return; }
    this.ensureGrid(ctx.width / Math.max(1, ctx.height));
    const u = this.u;
    const a = this.atmosphere;
    // camera
    const pe = cam.projectionMatrix.elements;
    (u.uProj.value as THREE.Vector4).set(1 / pe[0], 1 / pe[5], pe[8], pe[9]);
    (u.uCamRot.value as THREE.Matrix3).setFromMatrix4(cam.matrixWorld);
    u.uCamY.value = cp.y;
    // the medium
    (u.uAir.value as THREE.Vector4).set(a.hazeDensity, a.hazeAlbedo, a.dust, a.dustNoise);
    (u.uAir2.value as THREE.Vector4).set(a.mist, a.phase, VOL.GAIN, VOL.TORCH_GAIN);
    (u.uTint.value as THREE.Vector3).set(a.tint[0], a.tint[1], a.tint[2]);
    noiseOffsets(cp.x, cp.y, cp.z, a.t, this.noise);
    (u.uVdCam.value as THREE.Vector3).set(this.noise[0], this.noise[1], this.noise[2]);
    (u.uVdMistOff.value as THREE.Vector3).set(this.noise[3], this.noise[4], this.noise[5]);
    const mr = u.uMistRect.value as THREE.Vector4[], mi = u.uMistInfo.value as THREE.Vector4[];
    const nm = Math.min(a.mistCount, VD.MIST_MAX);
    for (let i = 0; i < nm; i++) {
      const o = i * 6, r = a.mistRects;
      mr[i].set(r[o] - cp.x, r[o + 1] - cp.z, r[o + 2] - cp.x, r[o + 3] - cp.z);
      mi[i].set(r[o + 4] - cp.y, r[o + 5], 0, 0);
    }
    u.uMistCount.value = a.mist > 0 ? nm : 0;
    // the torch (its matrices were updated by the prepass render and its shadow map)
    const L = this.light;
    const torch = L.intensity > 0 && L.visible;
    u.uFlOn.value = torch ? 1 : 0;
    // the shadow sampler must always see a depth texture in compare mode (three's null fallback is an unallocated
    // texture, a GL error at the draw): the torch's own map exists from its first prepass on, else a 1x1 stand-in
    u.uFlShadow.value = L.shadow.map ? L.shadow.map.depthTexture : this.dummyShadow(ctx.renderer);
    u.uFlCookie.value = L.map;
    if (torch) {
      this.lpos.setFromMatrixPosition(L.matrixWorld);
      this.tpos.setFromMatrixPosition(L.target.matrixWorld);
      (u.uFlPos.value as THREE.Vector3).set(this.lpos.x - cp.x, this.lpos.y - cp.y, this.lpos.z - cp.z);
      (u.uFlDir.value as THREE.Vector3).subVectors(this.tpos, this.lpos).normalize();
      (u.uFlCone.value as THREE.Vector2).set(Math.cos(L.angle), Math.cos(L.angle * (1 - L.penumbra)));
      (u.uFlCol.value as THREE.Vector3).set(L.color.r * L.intensity, L.color.g * L.intensity, L.color.b * L.intensity);
      u.uFlRange.value = L.distance > 0 ? L.distance : 1e6;
      // camera-relative shadow matrix: shadow.matrix x T(camera), multiplied in float64 (Matrix4 elements are doubles)
      this.shadowRel.multiplyMatrices(L.shadow.matrix, this.tmpM.makeTranslation(cp.x, cp.y, cp.z));
    }
    const lin = this.lin as THREE.WebGLRenderTarget;
    const filtered = this.filtered as THREE.WebGLRenderTarget;
    const local = this.local as THREE.WebGLRenderTarget;
    const r = ctx.renderer;
    this.quad.render(r, this.injMat, lin);
    this.filterMat.uniforms.uInj.value = lin.texture;
    this.quad.render(r, this.filterMat, filtered);
    this.localMat.uniforms.uInj.value = filtered.texture;
    this.quad.render(r, this.localMat, local);
    this.combineMat.uniforms.uLocal.value = local.texture;
    this.quad.render(r, this.combineMat, lin);
    // publish (read by this frame's shading and late renders; the next frame's injection overwrites it)
    g.volTex.value = lin.texture;
    g.volGrid.value.set(this.w, this.h, this.n, VOL.TILES_PER_ROW);
    g.volZ.value.set(VOL.ZN, this.zF, (this.n - 1) / Math.log(this.zF / VOL.ZN), 1);
    g.volScreen.value.set(1 / Math.max(1, ctx.width), 1 / Math.max(1, ctx.height));
  }

  private dummy: THREE.WebGLRenderTarget | null = null;
  private dummyShadow(renderer: THREE.WebGLRenderer): THREE.DepthTexture {
    if (!this.dummy) {
      const d = new THREE.DepthTexture(1, 1, THREE.UnsignedIntType);
      d.compareFunction = THREE.LessEqualCompare;
      d.minFilter = d.magFilter = THREE.LinearFilter;
      this.dummy = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: true, depthTexture: d });
      renderer.initRenderTarget(this.dummy);
    }
    return this.dummy.depthTexture as THREE.DepthTexture;
  }

  dispose(): void {
    this.dummy?.depthTexture?.dispose();
    this.dummy?.dispose();
    this.dummy = null;
    this.lin?.dispose();
    this.filtered?.dispose();
    this.local?.dispose();
    this.lin = this.filtered = this.local = null;
    this.injMat.dispose();
    this.filterMat.dispose();
    this.localMat.dispose();
    this.combineMat.dispose();
  }

  private ensureGrid(aspect: number): void {
    const spec = VOL_GRIDS[this.grid];
    const w = gridWidth(spec.h, aspect);
    if (w === this.w && this.lin) return;
    this.w = w; this.h = spec.h; this.n = spec.n; this.zF = spec.zF;
    const [aw, ah] = atlasSize(w, spec.h, spec.n);
    if (!this.lin) {
      this.lin = rt(aw, ah, true, 'Vol.InjectIntegrated');
      this.filtered = rt(aw, ah, false, 'Vol.Filtered');
      this.local = rt(aw, ah, false, 'Vol.ScanLocal');
    } else {
      this.lin.setSize(aw, ah);
      (this.filtered as THREE.WebGLRenderTarget).setSize(aw, ah);
      (this.local as THREE.WebGLRenderTarget).setSize(aw, ah);
    }
    const lr = Math.log(this.zF / VOL.ZN);
    const z = this.u.uZ.value as THREE.Vector4;
    z.set(VOL.ZN, this.zF, (this.n - 1) / lr, lr / (this.n - 1));
    (this.u.uGrid.value as THREE.Vector4).set(w, spec.h, spec.n, VOL.TILES_PER_ROW);
  }
}
