// src/post/AmbientOcclusionPass.ts — screen-space ambient occlusion (replaces N8AO, which cost 9.5 ms of a 15.8 ms
// ultra frame on an RTX 5070 Ti: 64 samples at full resolution, two denoise passes, an accumulation copy, a
// composite and another full-screen copy).
//
// The estimator and the composite are N8AO's, so the look carries over: view-space hemisphere samples on a
// Fibonacci disk lifted onto the hemisphere around the depth-reconstructed normal, a smooth range check
// (radius · falloff · 0.2 in view depth), and colour = scene · mix(aoColor, 1, ao^intensity). The work is organised
// differently:
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
//     Edge-stopping as N8AO's denoise (tangent-plane distance and normal agreement).
//  3. The composite multiplies the scene colour in place (blend ZERO, SRC_COLOR; needsSwap = false), upsampling
//     from the 2x2 nearest AO texels weighted by bilinear weight x the distance of the full-resolution pixel to
//     each texel's tangent plane x the agreement of the pixel's own normal (from full-resolution depth) with the
//     texel's. Plane distance alone lets the two faces of a crease borrow each other's AO (each face passes
//     within a centimetre of the other's plane there), which drew the AO edge along the side of every ceiling
//     grid bar in 2-pixel steps. A pixel with no texel of its own surface in the 2x2 (a face narrower than two
//     pixels) uses that surface's texels in the surrounding 4x4, and failing that is left unoccluded (a cable).
//     It samples the composer's stable depth copy, never the input buffer's own depth attachment, so there is
//     no feedback loop.

import * as THREE from 'three';
import { Pass } from 'postprocessing';

export interface AoSettings {
  /** hemisphere samples per AO texel */
  samples: number;
  /** AO at half the drawing-buffer resolution */
  halfRes: boolean;
}

const VERT = /* glsl */ `
void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

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

const COMPOSITE_FRAG = /* glsl */ `
${COMMON}
uniform highp sampler2D tAo;
uniform float uPlane;
uniform float uIntensity;
uniform vec3 uColor; // linear
layout( location = 0 ) out highp vec4 outColor;
// how well AO texel q (value s) describes the surface at P with normal N: distance of P to the texel's tangent
// plane, and normal agreement (the two faces of a crease are within a centimetre of each other's planes there)
float brSameSurface( vec4 s, ivec2 q, vec3 P, vec3 N ) {
	if ( s.g >= 1e4 ) return 0.0;
	vec3 Ns = brOctDec( s.ba );
	float nd = max( dot( N, Ns ), 0.0 );
	nd *= nd; nd *= nd; nd *= nd;
	return exp( - abs( dot( P - brTexelPos( q, s.g ), Ns ) ) / uPlane ) * nd;
}
void main() {
	ivec2 x = ivec2( gl_FragCoord.xy );
	float d = texelFetch( tDepth, x, 0 ).x;
	if ( d >= 1.0 ) { outColor = vec4( 1.0 ); return; }
	float ao;
#if BR_AO_STEP == 1
	ao = texelFetch( tAo, x, 0 ).r;
#else
	vec3 P = brViewPos( d, ( vec2( x ) + 0.5 ) / uFull );
	vec3 N = brNormal( x, d, P );
	ivec2 sz = textureSize( tAo, 0 );
	vec2 fc = vec2( x ) * 0.5;
	ivec2 b = ivec2( floor( fc ) );
	vec2 f = fc - vec2( b );
	float sum = 0.0, wsum = 0.0, gmax = 0.0;
	for ( int j = 0; j < 2; j ++ ) {
		for ( int i = 0; i < 2; i ++ ) {
			ivec2 q = min( b + ivec2( i, j ), sz - 1 );
			vec4 s = texelFetch( tAo, q, 0 );
			float g = brSameSurface( s, q, P, N );
			float w = ( ( i == 0 ? 1.0 - f.x : f.x ) * ( j == 0 ? 1.0 - f.y : f.y ) + 1e-3 ) * g;
			sum += s.r * w;
			wsum += w;
			gmax = max( gmax, g );
		}
	}
	if ( gmax < 0.1 ) {
		// no AO texel of the 2x2 lies on this pixel's surface (a face or sliver narrower than two pixels, such as
		// the side of a ceiling grid bar at a glancing angle): the texels of that surface in the surrounding 4x4
		sum = wsum = 0.0;
		for ( int j = -1; j <= 2; j ++ ) {
			for ( int i = -1; i <= 2; i ++ ) {
				ivec2 q = clamp( b + ivec2( i, j ), ivec2( 0 ), sz - 1 );
				vec4 s = texelFetch( tAo, q, 0 );
				vec2 dq = vec2( q * 2 - x );
				float w = exp( - 0.125 * dot( dq, dq ) ) * brSameSurface( s, q, P, N );
				sum += s.r * w;
				wsum += w;
			}
		}
	}
	// nothing of this surface within 4 pixels (a wire thinner than a pixel): unoccluded, rather than the AO of
	// whatever lies behind it
	ao = wsum > 1e-4 ? sum / wsum : 1.0;
#endif
	float a = pow( clamp( ao, 0.0, 1.0 ), uIntensity );
	// N8AO: mix( scene, color * scene, 1 - ao ) = scene * mix( color, 1, ao ), applied by the blend (dst * src)
	outColor = vec4( mix( uColor, vec3( 1.0 ), a ), 1.0 );
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

function quadMaterial(name: string, frag: string, defines: Record<string, string | number>, uniforms: Record<string, THREE.IUniform>): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name, glslVersion: THREE.GLSL3, vertexShader: VERT, fragmentShader: frag, defines, uniforms,
    depthTest: false, depthWrite: false, blending: THREE.NoBlending, toneMapped: false,
  });
}

export class AmbientOcclusionPass extends Pass {
  /** N8AO-compatible parameters */
  radius = 0.7;
  distanceFalloff = 0.6;
  intensity = 1;
  /** linear RGB */
  readonly color = new THREE.Color(0, 0, 0);
  readonly settings: Readonly<AoSettings>;
  private readonly cam: THREE.PerspectiveCamera;
  private readonly zRT: THREE.WebGLRenderTarget;
  private readonly zRT2: THREE.WebGLRenderTarget;
  private readonly aoRT: THREE.WebGLRenderTarget;
  private readonly denoiseRT: THREE.WebGLRenderTarget;
  private readonly zMat: THREE.ShaderMaterial;
  private readonly aoMat: THREE.ShaderMaterial;
  private readonly denoiseMat: THREE.ShaderMaterial;
  private readonly compMat: THREE.ShaderMaterial;
  private readonly all: readonly THREE.ShaderMaterial[];
  private readonly full = new THREE.Vector2(1, 1);
  private depth: THREE.Texture | null = null;

  constructor(camera: THREE.PerspectiveCamera, settings: AoSettings) {
    super('AmbientOcclusionPass');
    this.needsSwap = false;
    this.needsDepthTexture = true;
    this.cam = camera;
    this.settings = { samples: Math.max(4, Math.min(64, Math.round(settings.samples))), halfRes: settings.halfRes };
    const step = this.settings.halfRes ? 2 : 1;
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
    this.compMat = quadMaterial('br-ao-composite', COMPOSITE_FRAG, defs, {
      ...shared, tAo: { value: this.aoRT.texture }, uPlane: { value: 0.1 }, uIntensity: { value: 1 }, uColor: { value: new THREE.Color() },
    });
    // in-place multiply of the scene colour (alpha kept)
    this.compMat.blending = THREE.CustomBlending;
    this.compMat.blendEquation = THREE.AddEquation;
    this.compMat.blendSrc = THREE.ZeroFactor;
    this.compMat.blendDst = THREE.SrcColorFactor;
    this.compMat.blendSrcAlpha = THREE.ZeroFactor;
    this.compMat.blendDstAlpha = THREE.OneFactor;
    this.all = [this.zMat, this.aoMat, this.denoiseMat, this.compMat];
    this.fullscreenMaterial = this.aoMat;
  }

  /** Every program of the pass (compiled ahead by the quality switch). */
  get materials(): readonly THREE.ShaderMaterial[] { return this.all; }

  override setDepthTexture(depthTexture: THREE.Texture): void {
    this.depth = depthTexture;
  }

  override setSize(width: number, height: number): void {
    const w = Math.max(1, width), h = Math.max(1, height);
    this.full.set(w, h);
    const s = this.settings.halfRes ? 2 : 1;
    const aw = Math.ceil(w / s), ah = Math.ceil(h / s);
    this.zRT.setSize(aw, ah);
    this.zRT2.setSize(Math.ceil(aw / 2), Math.ceil(ah / 2));
    this.aoRT.setSize(aw, ah);
    this.denoiseRT.setSize(aw, ah);
  }

  override render(renderer: THREE.WebGLRenderer, inputBuffer: THREE.WebGLRenderTarget | null): void {
    if (!inputBuffer || !this.depth) return;
    const cam = this.cam;
    const plane = this.radius * this.distanceFalloff * 0.2;
    for (const m of this.materials) {
      const u = m.uniforms;
      u.tDepth.value = this.depth;
      u.uNear.value = cam.near;
      u.uFar.value = cam.far;
    }
    const au = this.aoMat.uniforms;
    au.uRadius.value = this.radius;
    au.uFalloff.value = this.distanceFalloff;
    this.denoiseMat.uniforms.uPlane.value = plane;
    const cu = this.compMat.uniforms;
    cu.uPlane.value = plane;
    cu.uIntensity.value = this.intensity;
    (cu.uColor.value as THREE.Color).copy(this.color);

    const step = this.settings.halfRes ? 2 : 1;
    this.fullscreenMaterial = this.zMat;
    this.zMat.uniforms.uZStep.value = step;
    renderer.setRenderTarget(this.zRT);
    renderer.render(this.scene, this.camera);
    this.zMat.uniforms.uZStep.value = step * 2;
    renderer.setRenderTarget(this.zRT2);
    renderer.render(this.scene, this.camera);
    this.fullscreenMaterial = this.aoMat;
    renderer.setRenderTarget(this.aoRT);
    renderer.render(this.scene, this.camera);
    // separable denoise: aoRT -> denoiseRT (horizontal) -> aoRT (vertical); the composite reads aoRT
    const du = this.denoiseMat.uniforms;
    this.fullscreenMaterial = this.denoiseMat;
    du.tAo.value = this.aoRT.texture;
    (du.uDir.value as THREE.Vector2).set(1, 0);
    renderer.setRenderTarget(this.denoiseRT);
    renderer.render(this.scene, this.camera);
    du.tAo.value = this.denoiseRT.texture;
    (du.uDir.value as THREE.Vector2).set(0, 1);
    renderer.setRenderTarget(this.aoRT);
    renderer.render(this.scene, this.camera);
    this.fullscreenMaterial = this.compMat;
    renderer.setRenderTarget(inputBuffer);
    renderer.render(this.scene, this.camera);
    this.fullscreenMaterial = this.aoMat;
  }

  override dispose(): void {
    this.depth = null;
    this.zRT.dispose();
    this.zRT2.dispose();
    this.aoRT.dispose();
    this.denoiseRT.dispose();
    this.zMat.dispose();
    this.aoMat.dispose();
    this.denoiseMat.dispose();
    this.compMat.dispose();
  }
}
