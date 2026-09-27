// src/post/AmbientOcclusionPass.ts — pre-shade screen-space ambient occlusion (SsaoPre; replaced N8AO, which cost
// 9.5 ms of a 15.8 ms ultra frame on an RTX 5070 Ti: 64 samples at full resolution, two denoise passes, an
// accumulation copy, a composite and another full-screen copy).
//
// The estimator is N8AO's: view-space hemisphere samples on a Fibonacci disk lifted onto the hemisphere around the
// depth-reconstructed normal and a smooth range check (radius · falloff · 0.2 in view depth). It runs as the frame
// graph's afterDepth hook 'ssao' (post/ScenePass.ts), between the depth prepass and shading, so the surface shader
// applies the occlusion where it belongs: to the indirect light only, with albedo multi-bounce, and only the part the
// bake has not already applied (chunks/screenspace.ts brSsao, chunks/lighting.ts). Direct light, emitters, haze and
// water are no longer darkened. Steps:
//  0. The view depth of the full-resolution pixel each AO texel represents, into an R32F target at AO resolution,
//     and a second level at half that (every other texel, not averaged): the scattered sample taps read these small
//     textures (cache friendly, no per-tap linearisation); taps farther than 16 AO texels read the coarse level,
//     as in scalable AO (a 0.7 m radius spans hundreds of texels up close at 4K).
//  1. AO at half resolution (or full, halfRes = false). Each AO texel uses the depth of one full-resolution pixel
//     and its normal from the full-resolution depth (N8AO's 9-tap best-side derivative), rotating the sample set by
//     a 4x4 interleaved pattern (16 rotations x 16 radial offsets per 4x4 block). Output: occlusion, view depth
//     and an octahedral view-space normal in one RGBA16F texel.
//  2. A separable bilateral denoise (horizontal, then vertical; 5 taps each) with weights (0.5, 1, 1, 1, 0.5): every
//     residue class of the 4x4 pattern gets the same total weight, so flat areas lose the pattern exactly.
//     Edge-stopping as N8AO's denoise (tangent-plane distance and normal agreement). It filters .r only and copies
//     the centre texel's view depth and normal (.gba) unchanged: the surface shader's depth- and normal-aware upsample
//     and the contact shadows read them.
// The result (aoRT: r AO, g view Z, ba oct view normal) is published as MaterialGlobals.ssaoTex with ssaoParams (x on,
// y = the atmosphere's aoIntensity x SSAO_POW_SCALE, z = the tangent-plane falloff, w = the texel step), ssaoProj
// (P00, P11, P20, P21) and ssaoSize (the full-resolution size). The hook reads the opaque target's own depth texture
// while that target is not bound (the composer's stable copy is filled only after the scene pass) and binds only
// its own targets.

import * as THREE from 'three';
import type { MaterialGlobals } from '../core/runtime.ts';
import { FullscreenQuad, quadMaterial } from './frame/quad.ts';

export interface AoSettings {
  /** hemisphere samples per AO texel */
  samples: number;
  /** AO at half the drawing-buffer resolution */
  halfRes: boolean;
}

const COMMON = /* glsl */ `
precision highp float;
uniform highp sampler2D tDepth;
uniform vec2 uFull;      // full-resolution size (px)
uniform mat4 uProjInv;
uniform float uNear;
uniform float uFar;
// view-space position of window depth d at full-resolution uv (N8AO getWorldPos, perspective)
vec3 brViewPos( float d, vec2 uv ) {
	vec2 ndc = uv * 2.0 - 1.0;
	float z = d * 2.0 - 1.0;
	mat4 Q = uProjInv;
	vec3 v = vec3( Q[0][0] * ndc.x + Q[3][0], Q[1][1] * ndc.y + Q[3][1], Q[3][2] );
	return v / ( Q[2][3] * z + Q[3][3] );
}
float brDepth( ivec2 p ) { return texelFetch( tDepth, clamp( p, ivec2( 0 ), ivec2( uFull ) - 1 ), 0 ).x; }
vec2 brOctEnc( vec3 n ) {
	n /= abs( n.x ) + abs( n.y ) + abs( n.z );
	vec2 e = n.xy;
	if ( n.z < 0.0 ) e = ( 1.0 - abs( n.yx ) ) * vec2( n.x >= 0.0 ? 1.0 : -1.0, n.y >= 0.0 ? 1.0 : -1.0 );
	return e;
}
vec3 brOctDec( vec2 e ) {
	vec3 n = vec3( e, 1.0 - abs( e.x ) - abs( e.y ) );
	if ( n.z < 0.0 ) n.xy = ( 1.0 - abs( n.yx ) ) * vec2( n.x >= 0.0 ? 1.0 : -1.0, n.y >= 0.0 ? 1.0 : -1.0 );
	return normalize( n );
}
// view-space normal of full-resolution pixel p from depth (N8AO's 9-tap best-side derivative)
vec3 brNormal( ivec2 p, float c0, vec3 ce ) {
	float l2 = brDepth( p - ivec2( 2, 0 ) ), l1 = brDepth( p - ivec2( 1, 0 ) );
	float r1 = brDepth( p + ivec2( 1, 0 ) ), r2 = brDepth( p + ivec2( 2, 0 ) );
	float b2 = brDepth( p - ivec2( 0, 2 ) ), b1 = brDepth( p - ivec2( 0, 1 ) );
	float t1 = brDepth( p + ivec2( 0, 1 ) ), t2 = brDepth( p + ivec2( 0, 2 ) );
	float dl = abs( ( 2.0 * l1 - l2 ) - c0 ), dr = abs( ( 2.0 * r1 - r2 ) - c0 );
	float db = abs( ( 2.0 * b1 - b2 ) - c0 ), dt = abs( ( 2.0 * t1 - t2 ) - c0 );
	vec2 px = 1.0 / uFull;
	vec2 uv = ( vec2( p ) + 0.5 ) * px;
	vec3 dpdx = dl < dr ? ce - brViewPos( l1, uv - vec2( px.x, 0.0 ) ) : brViewPos( r1, uv + vec2( px.x, 0.0 ) ) - ce;
	vec3 dpdy = db < dt ? ce - brViewPos( b1, uv - vec2( 0.0, px.y ) ) : brViewPos( t1, uv + vec2( 0.0, px.y ) ) - ce;
	return normalize( cross( dpdx, dpdy ) );
}
// view position of the full-resolution pixel an AO texel represents, from its stored view depth
vec3 brTexelPos( ivec2 t, float viewZ ) {
	vec2 uv = ( vec2( t * BR_AO_STEP ) + 0.5 ) / uFull;
	vec3 r = brViewPos( 1.0, uv ); // any point on the pixel's view ray
	return r * ( viewZ / -r.z );
}
`;

const Z_FRAG = /* glsl */ `
${COMMON}
uniform int uZStep; // full-resolution pixels per texel of this level
layout( location = 0 ) out highp vec4 outZ;
void main() {
	ivec2 p = min( ivec2( gl_FragCoord.xy ) * uZStep, ivec2( uFull ) - 1 );
	float d = brDepth( p );
	float nf = uFar * uNear;
	// window depth -> positive view distance along -z (N8AO's linearisation); background = far
	outZ = vec4( d >= 1.0 ? uFar : nf / ( uFar - d * ( uFar - uNear ) ), 0.0, 0.0, 1.0 );
}
`;

const AO_FRAG = /* glsl */ `
${COMMON}
uniform highp sampler2D tZ;
uniform highp sampler2D tZ2;
uniform vec3 uSamples[ BR_AO_SAMPLES ];
uniform mat4 uProj;
uniform float uRadius;
uniform float uFalloff;
layout( location = 0 ) out highp vec4 outAo;
const float BAYER[ 16 ] = float[ 16 ]( 0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0 );
void main() {
	ivec2 t = ivec2( gl_FragCoord.xy );
	ivec2 p = min( t * BR_AO_STEP, ivec2( uFull ) - 1 );
	float d = brDepth( p );
	if ( d >= 1.0 ) { outAo = vec4( 1.0, 1e4, 0.0, 0.0 ); return; }
	vec2 uv = ( vec2( p ) + 0.5 ) / uFull;
	vec3 P = brViewPos( d, uv );
	vec3 N = brNormal( p, d, P );
	// 4x4 interleaved rotation (Bayer order) and radial start offset (R2 sequence over the same index)
	int k = ( t.x & 3 ) + ( ( t.y & 3 ) << 2 );
	float rot = BAYER[ k ] * ( 6.2831853 / 16.0 );
	float offs = fract( 0.5 + float( k ) * 0.7548776662 );
	vec3 helper = abs( N.y ) > 0.99 ? vec3( 1.0, 0.0, 0.0 ) : vec3( 0.0, 1.0, 0.0 );
	vec3 T = normalize( cross( helper, N ) );
	vec3 B = cross( N, T );
	float cr = cos( rot ), sr = sin( rot );
	vec3 Tr = T * cr + B * sr;
	vec3 Br = B * cr - T * sr;
	float fo = uRadius * uFalloff * 0.2;
	float occ = 0.0, tot = 0.0;
	float zc = texelFetch( tZ, t, 0 ).x;
	vec2 zSize = vec2( textureSize( tZ, 0 ) );
	for ( int i = 0; i < BR_AO_SAMPLES; i ++ ) {
		vec3 s = uSamples[ i ];
		vec3 dir = Tr * s.x + Br * s.y + N * s.z;
		float move = fract( offs + float( i ) / float( BR_AO_SAMPLES ) );
		vec3 sp = P + uRadius * move * dir;
		vec4 c = uProj * vec4( sp, 1.0 );
		vec3 o = c.xyz / c.w * 0.5 + 0.5;
		if ( all( greaterThan( o * ( 1.0 - o ), vec3( 0.0 ) ) ) ) {
			ivec2 sq = ivec2( o.xy * zSize );
			vec2 dq = vec2( sq - t );
			float distS = dot( dq, dq ) > 256.0 ? texelFetch( tZ2, sq >> 1, 0 ).x : texelFetch( tZ, sq, 0 ).x;
			float distW = -sp.z;
			float range = smoothstep( 0.0, 1.0, fo / abs( distS - distW ) );
			occ += range * float( distS != zc ) * step( distS, distW ) * step( 1.0, dot( dq, dq ) );
			tot += 1.0;
		}
	}
	float ao = clamp( 1.0 - occ / max( tot, 1.0 ), 0.0, 1.0 );
	outAo = vec4( ao, -P.z, brOctEnc( N ) );
}
`;

const DENOISE_FRAG = /* glsl */ `
${COMMON}
uniform highp sampler2D tAo;
uniform float uPlane; // tangent-plane falloff (m)
uniform ivec2 uDir;   // (1, 0) horizontal, (0, 1) vertical
layout( location = 0 ) out highp vec4 outAo;
void main() {
	ivec2 t = ivec2( gl_FragCoord.xy );
	ivec2 sz = textureSize( tAo, 0 );
	vec4 c = texelFetch( tAo, t, 0 );
	if ( c.g >= 1e4 ) { outAo = c; return; }
	vec3 N = brOctDec( c.ba );
	vec3 P = brTexelPos( t, c.g );
	float inv = 1.0 / uPlane;
	float sum = 0.0, wsum = 0.0;
	for ( int k = -2; k <= 2; k ++ ) {
		ivec2 q = clamp( t + uDir * k, ivec2( 0 ), sz - 1 );
		vec4 s = texelFetch( tAo, q, 0 );
		if ( s.g >= 1e4 ) continue;
		vec3 Ns = brOctDec( s.ba );
		vec3 Ps = brTexelPos( q, s.g );
		float w = ( abs( k ) == 2 ? 0.5 : 1.0 ) * exp( - abs( dot( Ps - P, N ) ) * inv ) * max( dot( N, Ns ), 0.0 );
		sum += s.r * w;
		wsum += w;
	}
	outAo = vec4( wsum > 1e-4 ? sum / wsum : c.r, c.gba );
}
`;

/** N8AO's hemisphere set: Fibonacci disk points lifted onto the unit hemisphere. */
export function hemisphereSamples(n: number): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  for (let k = 0; k < n; k++) {
    const theta = 2.399963 * k;
    const r = Math.sqrt(k + 0.5) / Math.sqrt(n);
    const x = r * Math.cos(theta), y = r * Math.sin(theta);
    out.push(new THREE.Vector3(x, y, Math.sqrt(1 - (x * x + y * y))));
  }
  return out;
}

/** The afterDepth hook's view of the frame (post/ScenePass.ts FrameContext). */
export interface SsaoFrame {
  renderer: THREE.WebGLRenderer;
  camera: THREE.PerspectiveCamera;
  depth: THREE.Texture;
  width: number;
  height: number;
  globals: MaterialGlobals | null;
}

export class SsaoPre {
  /** N8AO-compatible parameters */
  radius = 0.7;
  distanceFalloff = 0.6;
  /** the atmosphere's aoIntensity (the shader's exponent is this x powScale) */
  intensity = 1;
  powScale = 1;
  /** off: the hook renders nothing and the surfaces skip the lookup (ssaoParams.x = 0) */
  enabled = true;
  readonly settings: Readonly<AoSettings>;
  /** full-resolution pixels per AO texel */
  readonly step: number;
  private readonly cam: THREE.PerspectiveCamera;
  private readonly zRT: THREE.WebGLRenderTarget;
  private readonly zRT2: THREE.WebGLRenderTarget;
  private readonly aoRT: THREE.WebGLRenderTarget;
  private readonly denoiseRT: THREE.WebGLRenderTarget;
  private readonly zMat: THREE.ShaderMaterial;
  private readonly aoMat: THREE.ShaderMaterial;
  private readonly denoiseMat: THREE.ShaderMaterial;
  private readonly all: readonly THREE.ShaderMaterial[];
  private readonly quad = new FullscreenQuad();
  private readonly full = new THREE.Vector2(0, 0);
  /** the globals this helper published into and the texture it replaced there (restored on dispose) */
  private published: { g: MaterialGlobals; prev: THREE.Texture } | null = null;

  constructor(camera: THREE.PerspectiveCamera, settings: AoSettings) {
    this.cam = camera;
    this.settings = { samples: Math.max(4, Math.min(64, Math.round(settings.samples))), halfRes: settings.halfRes };
    const step = this.settings.halfRes ? 2 : 1;
    this.step = step;
    const opts = {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false,
      generateMipmaps: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
    } as const;
    this.zRT = new THREE.WebGLRenderTarget(1, 1, { ...opts, type: THREE.FloatType, format: THREE.RedFormat });
    this.zRT.texture.name = 'AO.ViewZ';
    this.zRT2 = new THREE.WebGLRenderTarget(1, 1, { ...opts, type: THREE.FloatType, format: THREE.RedFormat });
    this.zRT2.texture.name = 'AO.ViewZ2';
    this.aoRT = new THREE.WebGLRenderTarget(1, 1, opts);
    this.aoRT.texture.name = 'AO.Raw';
    this.denoiseRT = new THREE.WebGLRenderTarget(1, 1, opts);
    this.denoiseRT.texture.name = 'AO.Denoised';
    const shared = {
      tDepth: { value: null }, uFull: { value: this.full }, uProjInv: { value: camera.projectionMatrixInverse },
      uNear: { value: camera.near }, uFar: { value: camera.far },
    };
    const defs = { BR_AO_STEP: step, BR_AO_SAMPLES: this.settings.samples };
    this.zMat = quadMaterial('br-ao-z', Z_FRAG, defs, { ...shared, uZStep: { value: step } });
    this.aoMat = quadMaterial('br-ao', AO_FRAG, defs, {
      ...shared, tZ: { value: this.zRT.texture }, tZ2: { value: this.zRT2.texture }, uSamples: { value: hemisphereSamples(this.settings.samples) }, uProj: { value: camera.projectionMatrix },
      uRadius: { value: this.radius }, uFalloff: { value: this.distanceFalloff },
    });
    this.denoiseMat = quadMaterial('br-ao-denoise', DENOISE_FRAG, defs, { ...shared, tAo: { value: this.aoRT.texture }, uPlane: { value: 0.1 }, uDir: { value: new THREE.Vector2(1, 0) } });
    this.all = [this.zMat, this.aoMat, this.denoiseMat];
  }

  /** Every program of the helper (compiled ahead by the quality switch). */
  get materials(): readonly THREE.ShaderMaterial[] { return this.all; }

  /** r AO, g view Z, ba oct view normal (valid after renderPre). */
  get texture(): THREE.Texture { return this.aoRT.texture; }

  /** the tangent-plane falloff of the denoise and the surface upsample (m) */
  get plane(): number { return this.radius * this.distanceFalloff * 0.2; }

  /** Size the targets for a `width` x `height` full-resolution frame (reallocates only on change). */
  setSize(width: number, height: number): void {
    const w = Math.max(1, width), h = Math.max(1, height);
    if (w === this.full.x && h === this.full.y) return;
    this.full.set(w, h);
    const s = this.step;
    const aw = Math.ceil(w / s), ah = Math.ceil(h / s);
    this.zRT.setSize(aw, ah);
    this.zRT2.setSize(Math.ceil(aw / 2), Math.ceil(ah / 2));
    this.aoRT.setSize(aw, ah);
    this.denoiseRT.setSize(aw, ah);
  }

  /** Z, coarse Z, AO and the separable denoise from `depth` (the full-resolution depth texture, not bound);
   * binds only its own targets and leaves the result in aoRT. */
  renderPre(renderer: THREE.WebGLRenderer, depth: THREE.Texture): void {
    const cam = this.cam;
    for (const m of this.all) {
      const u = m.uniforms;
      u.tDepth.value = depth;
      u.uNear.value = cam.near;
      u.uFar.value = cam.far;
    }
    const au = this.aoMat.uniforms;
    au.uRadius.value = this.radius;
    au.uFalloff.value = this.distanceFalloff;
    this.denoiseMat.uniforms.uPlane.value = this.plane;

    const step = this.step;
    this.zMat.uniforms.uZStep.value = step;
    this.quad.render(renderer, this.zMat, this.zRT);
    this.zMat.uniforms.uZStep.value = step * 2;
    this.quad.render(renderer, this.zMat, this.zRT2);
    this.quad.render(renderer, this.aoMat, this.aoRT);
    // separable denoise: aoRT -> denoiseRT (horizontal) -> aoRT (vertical); the surfaces read aoRT
    const du = this.denoiseMat.uniforms;
    du.tAo.value = this.aoRT.texture;
    (du.uDir.value as THREE.Vector2).set(1, 0);
    this.quad.render(renderer, this.denoiseMat, this.denoiseRT);
    du.tAo.value = this.denoiseRT.texture;
    (du.uDir.value as THREE.Vector2).set(0, 1);
    this.quad.render(renderer, this.denoiseMat, this.aoRT);
  }

  /** The 'ssao' hook body: render (when enabled) and publish into the material globals. */
  run(f: SsaoFrame): void {
    const g = f.globals;
    if (!this.enabled) {
      if (g) g.ssaoParams.value.x = 0;
      return;
    }
    this.setSize(f.width, f.height);
    this.renderPre(f.renderer, f.depth);
    if (!g) return;
    if (g.ssaoTex.value !== this.aoRT.texture) {
      if (!this.published || this.published.g !== g) this.published = { g, prev: g.ssaoTex.value };
      g.ssaoTex.value = this.aoRT.texture;
    }
    g.ssaoParams.value.set(1, this.intensity * this.powScale, this.plane, this.step);
    const e = f.camera.projectionMatrix.elements;
    g.ssaoProj.value.set(e[0], e[5], e[8], e[9]);
    g.ssaoSize.value.set(this.full.x, this.full.y, 1 / this.full.x, 1 / this.full.y);
  }

  dispose(): void {
    // a successor (quality switch) publishes on its first enabled frame; until then no surface binds a freed target
    const p = this.published;
    if (p && p.g.ssaoTex.value === this.aoRT.texture) {
      p.g.ssaoTex.value = p.prev;
      p.g.ssaoParams.value.x = 0;
    }
    this.published = null;
    this.zRT.dispose();
    this.zRT2.dispose();
    this.aoRT.dispose();
    this.denoiseRT.dispose();
    this.zMat.dispose();
    this.aoMat.dispose();
    this.denoiseMat.dispose();
  }
}
