// src/lighting/dustMotes.ts — package F: dust motes. Individual specks drifting in a box around the camera, lit by the
// baked light field (lighting/LightAtlas.ts: specks catch the troffer light when looking toward a lamp) and by the
// shadowed, cookie-shaped torch (a Tyndall sparkle inside the beam only, none behind the shelves it shadows).
//
// One THREE.Points of QualityConfig.dustMotes points (3000 high, 6000 ultra) on LAYER_LATE: drawn by ScenePass's late
// render after the opaque colour copy (never in the colour pyramid or SSR), additive HDR (One, One), depth-tested
// against the prepass depth, no depth writes; collapsed in reflection passes (REFL_PASS). No per-frame CPU work per
// mote: the vertex shader places each one from its seed,
//   rel = (fract(seed.xyz + (drift - camMod) / L) - 0.5) L          (camera-relative; toroidal box of side L)
// drift = the air's slow wind (volumetricDensity VD.WIND, x t, mod L on the CPU) + three small per-mote wobbles + a
// slow settling, camMod = the camera position mod L (float64 on the CPU), so the specks stay put in the world while
// the box follows the camera. seed.w is a visibility rank: a fraction moteDensity of the motes is drawn.
// Light: a mote of cross-section CROSS scatters I = CROSS (E_amb + E_dir + E_torch) (cd per lux of phase-weighted
// irradiance), phase HGm = 0.7 HG(0.75) + 0.3 / 4 PI (large grains: strongly forward); the torch term twinkles
// (rotating flakes). Its image is energy-conserving: the sprite (a gaussian of `size` px, at least a defocus disc of
// the camcorder's small aperture focused at FOCUS m) sums to I / (d^2 px^2) in radiance x pixels.

import * as THREE from 'three';
import { HDR_CLAMP } from '../core/constants.ts';
import { hash2, hash01 } from '../core/rng.ts';
import { f } from '../materials/chunks/params.ts';
import { LAYER_LATE, REFL_PASS, WIRE_PX } from '../materials/shared.ts';
import { lightAtlasGlsl, type LightAtlasUniforms } from './LightAtlas.ts';
import { VD } from './volumetricDensity.ts';

export const MOTES = {
  /** m: side of the camera-centred box */
  L: 6,
  /** m^2: effective scattering cross-section of a mote (calibrated: a mote 1.5 m into the torch's hotspot reads about
   * as bright as the lit wall behind it, while specks in the dim spill fade into the dark instead of a starfield) */
  CROSS: 4e-6,
  /** weight of the room's diffuse (ambient and flicker) light on the motes relative to directional light: a lit room
   * full of bright dots reads as salt noise; dust shows in a strong beam, forward toward a lamp or in the torch */
  AMBIENT: 0.3,
  /** m: no motes closer than this (they would cover the lens) */
  NEAR: 0.25,
  /** m: the camcorder's focus distance and aperture diameter (defocus disc of near specks) */
  FOCUS: 2.5,
  APERTURE: 0.0025,
  /** px: sprite diameter range (the gaussian's support) */
  SIZE_MIN: 2,
  SIZE_MAX: 7,
  /** m/s: settling */
  SETTLE: 0.003,
  /** wobbles: amplitude (m) and angular rate (rad/s) */
  WOB_A: [0.12, 0.06, 0.03] as const,
  WOB_W: [0.11, 0.29, 0.71] as const,
  SALT: 0x6d07e5,
} as const;

/** Seeds of `count` motes: xyz uniform in [0, 1)^3, w = visibility rank in [0, 1) (deterministic). */
export function moteSeeds(count: number): Float32Array {
  const s = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    for (let k = 0; k < 4; k++) s[i * 4 + k] = hash01(hash2(MOTES.SALT + k, i));
  }
  return s;
}

/** TS mirror of the placement: the camera-relative position of a mote (out[0..2]); drift and camMod as uploaded. */
export function motePosition(sx: number, sy: number, sz: number, drift: readonly number[], camMod: readonly number[], out: Float64Array): void {
  const L = MOTES.L;
  const s = [sx, sy, sz];
  for (let k = 0; k < 3; k++) {
    const v = s[k] + (drift[k] - camMod[k]) / L;
    out[k] = (v - Math.floor(v) - 0.5) * L;
  }
}

/** Uniforms of the torch the motes share with the froxels (post/VolumetricFog.ts writes them each frame). */
export interface TorchUniforms {
  uFlOn: { value: number };
  uFlPos: { value: THREE.Vector3 };
  uFlDir: { value: THREE.Vector3 };
  uFlCone: { value: THREE.Vector2 };
  uFlCol: { value: THREE.Vector3 };
  uFlRange: { value: number };
  uFlShadowRel: { value: THREE.Matrix4 };
  uFlCookie: { value: THREE.Texture | null };
  uFlShadow: { value: THREE.Texture | null };
}

const VERT = /* glsl */ `
precision highp sampler2DShadow;
attribute vec4 aSeed;
uniform float uTime;
uniform vec3 uMoteDrift; // wind x t + settling, mod L
uniform vec3 uMoteCamMod; // camera mod L
uniform float uMoteDensity;
uniform float uMoteOn;
uniform float uBrReflPass;
uniform float uBrWirePx;
uniform float uFlOn;
uniform vec3 uFlPos;
uniform vec3 uFlDir;
uniform vec2 uFlCone;
uniform vec3 uFlCol;
uniform float uFlRange;
uniform mat4 uFlShadowRel;
uniform sampler2D uFlCookie;
uniform sampler2DShadow uFlShadow;
${lightAtlasGlsl()}
varying vec3 vColor;
float brMoteHG( float mu, float g ) { float d = 1.0 + g * g - 2.0 * g * mu; return ( 1.0 - g * g ) / ( 12.566370614359172 * d * sqrt( d ) ); }
float brMotePhase( float mu ) { return 0.7 * brMoteHG( mu, 0.75 ) + ${f(0.3 / (4 * Math.PI))}; }
float brMoteH( float a, float k ) { return fract( sin( a * 12.9898 + k * 78.233 ) * 43758.5453 ); }
void main() {
	vColor = vec3( 0.0 );
	gl_PointSize = 1.0;
	gl_Position = vec4( 2.0, 2.0, 2.0, 1.0 ); // collapsed (clipped)
	if ( uMoteOn < 0.5 || aSeed.w >= uMoteDensity || uBrReflPass > 0.5 ) return;
	float t = uTime;
	vec3 wob = vec3( 0.0 );
	${[0, 1, 2].map((i) => `wob += ${f(MOTES.WOB_A[i])} * sin( ${f(MOTES.WOB_W[i])} * t + 6.2831853 * vec3( brMoteH( aSeed.x, ${f(i + 1)} ), brMoteH( aSeed.y, ${f(i + 4)} ), brMoteH( aSeed.z, ${f(i + 7)} ) ) );`).join('\n\t')}
	vec3 rel = ( fract( aSeed.xyz + ( uMoteDrift + wob - uMoteCamMod ) * ${f(1 / MOTES.L)} ) - 0.5 ) * ${f(MOTES.L)};
	float d = length( rel );
	float fade = smoothstep( ${f(MOTES.NEAR)}, ${f(MOTES.NEAR + 0.35)}, d )
		* ( 1.0 - smoothstep( ${f(0.35 * MOTES.L)}, ${f(0.5 * MOTES.L)}, max( max( abs( rel.x ), abs( rel.y ) ), abs( rel.z ) ) ) );
	if ( fade <= 0.0 ) return;
	vec3 rd = rel / d;
	// light: the baked field (ambient + dominant direction) and the shadowed torch
	vec3 E, Ld, Ef;
	float w;
	vec3 I = vec3( 0.0 );
	// the room's diffuse fill shows the specks only weakly (AMBIENT): what makes dust visible is a strong beam,
	// forward toward a lamp or in the torch
	if ( brLaSample( rel, E, w, Ld, Ef ) ) I += w * E * brMotePhase( dot( Ld, rd ) ) + ( 2.0 * ( 1.0 - w ) * E + Ef ) * ${f(MOTES.AMBIENT / (4 * Math.PI))};
	if ( uFlOn > 0.5 ) {
		vec3 L = uFlPos - rel;
		float dl = max( length( L ), 0.3 );
		vec3 l = L / dl;
		float spot = smoothstep( uFlCone.x, uFlCone.y, dot( - l, uFlDir ) );
		float q = dl / uFlRange;
		float win = clamp( 1.0 - q * q * q * q, 0.0, 1.0 );
		vec4 sc = uFlShadowRel * vec4( rel, 1.0 );
		vec3 sp = sc.xyz / sc.w;
		if ( spot * win > 0.0 && sc.w > 0.0 && all( greaterThanEqual( sp.xy, vec2( 0.0 ) ) ) && all( lessThanEqual( sp.xy, vec2( 1.0 ) ) ) ) {
			float vis = sp.z >= 1.0 ? 1.0 : textureLod( uFlShadow, vec3( sp.xy, sp.z - 3e-4 ), 0.0 );
			vec3 ck = textureLod( uFlCookie, sp.xy, 0.0 ).rgb;
			// rotating flakes glint now and then
			float glint = 1.0 + 5.0 * pow( max( sin( t * ( 1.3 + 2.7 * aSeed.x ) + 6.2831853 * aSeed.y ), 0.0 ), 24.0 );
			I += uFlCol * ck * ( spot * win * win * vis / ( dl * dl ) ) * brMotePhase( dot( l, rd ) ) * glint;
		}
	}
	I *= ${f(MOTES.CROSS)} * fade;
	vec4 pv = vec4( mat3( viewMatrix ) * rel, 1.0 );
	gl_Position = projectionMatrix * pv;
	// sprite: the defocus disc of the camcorder (focused at FOCUS), at least SIZE_MIN px; energy-conserving
	float px = max( uBrWirePx, 1e-6 ); // m per px at unit depth
	float coc = ${f(MOTES.APERTURE)} * abs( 1.0 / d - ${f(1 / MOTES.FOCUS)} ) / px;
	float size = clamp( coc, ${f(MOTES.SIZE_MIN)}, ${f(MOTES.SIZE_MAX)} );
	gl_PointSize = size;
	// pixel sum of exp(-3 q^2) over the sprite (q in the unit disc) = (size / 2)^2 * PI / 3 * (1 - e^-3)
	vColor = I / ( d * d * px * px * 0.25 * size * size * ${f((Math.PI / 3) * (1 - Math.exp(-3)))} );
}
`;

const FRAG = /* glsl */ `
varying vec3 vColor;
void main() {
	vec2 q = gl_PointCoord * 2.0 - 1.0;
	float r2 = dot( q, q );
	if ( r2 >= 1.0 ) discard;
	gl_FragColor = vec4( min( vColor * exp( - 3.0 * r2 ), vec3( ${f(HDR_CLAMP)} ) ), 0.0 );
}
`;

export class DustMotes {
  readonly points: THREE.Points;
  private readonly mat: THREE.ShaderMaterial;
  private readonly u: Record<string, THREE.IUniform>;
  private density = 0;

  constructor(count: number, atlas: LightAtlasUniforms, torch: TorchUniforms) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3)); // unused (three needs it)
    geo.setAttribute('aSeed', new THREE.BufferAttribute(moteSeeds(count), 4));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
    this.u = {
      uTime: { value: 0 },
      uMoteDrift: { value: new THREE.Vector3() },
      uMoteCamMod: { value: new THREE.Vector3() },
      uMoteDensity: { value: 0 },
      uMoteOn: { value: 0 },
      uBrReflPass: REFL_PASS,
      uBrWirePx: WIRE_PX,
      ...torch,
      ...atlas,
    };
    this.mat = new THREE.ShaderMaterial({
      name: 'br-motes', vertexShader: VERT, fragmentShader: FRAG, uniforms: this.u,
      transparent: false, depthWrite: false, depthTest: true, toneMapped: false,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
    });
    const p = new THREE.Points(geo, this.mat);
    p.name = 'dustMotes';
    p.frustumCulled = false;
    p.renderOrder = 3;
    p.matrixAutoUpdate = false;
    p.layers.set(LAYER_LATE); // drawn after the opaque colour copy (post/ScenePass.ts)
    // hidden until the volumetrics hook has bound the torch's shadow map (a shadow sampler without a depth texture in
    // compare mode is a GL error at the draw)
    p.visible = false;
    this.points = p;
  }

  get material(): THREE.ShaderMaterial { return this.mat; }

  /** CPU per frame: simulation time and the visible fraction (the atmosphere's moteDensity). */
  update(t: number, density: number): void {
    this.u.uTime.value = t;
    this.density = density;
    const L = MOTES.L;
    const m = (v: number): number => v - L * Math.floor(v / L);
    (this.u.uMoteDrift.value as THREE.Vector3).set(m(VD.WIND[0] * t), m((VD.WIND[1] - MOTES.SETTLE) * t), m(VD.WIND[2] * t));
  }

  /** At render time (the volumetrics hook): the camera box, and whether the light sources are valid. */
  prepare(camera: THREE.Camera, on: boolean): void {
    const L = MOTES.L, p = camera.position;
    (this.u.uMoteCamMod.value as THREE.Vector3).set(p.x - L * Math.floor(p.x / L), p.y - L * Math.floor(p.y / L), p.z - L * Math.floor(p.z / L));
    this.u.uMoteOn.value = on ? 1 : 0;
    this.u.uMoteDensity.value = on ? this.density : 0;
    this.points.visible = on && this.density > 0;
  }

  dispose(): void {
    this.points.removeFromParent();
    this.points.geometry.dispose();
    this.mat.dispose();
  }
}
