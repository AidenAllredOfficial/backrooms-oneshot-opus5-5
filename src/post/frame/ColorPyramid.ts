// src/post/frame/ColorPyramid.ts — the shared opaque colour + linear depth copy of split frames (post/ScenePass.ts),
// built after the opaque render and before water / sparks / motes: package D's SSR cone lookups and package E's water
// refraction, blur and contact band read it (MaterialGlobals.sceneColor / sceneInvSize, FrameContext.pyramid).
//  - RGBA16F, level 0 = round(W x s) x round(H x s) of the full-resolution target, s = QualityConfig.colorPyramidScale
//    (high 1.0, ultra 0.67), LinearMipmapLinear, ClampToEdge. PYR_LEVELS levels (floor-halved; TEXTURE_MAX_LEVEL
//    stops sampling there), each a low-pass of the one before (LowPassMips).
//  - rgb = the full opaque HDR colour, including fallback specular before SSR and water: the source texel at s = 1, otherwise a 4-tap bilinear
//    box over the texel's footprint (about 3x3 source texels at 0.67).
//  - a = the linear view depth (positive metres; the far plane where nothing was drawn) of the NEAREST full-resolution
//    depth texel: read it with texelFetch on level 0 only (the mips hold a weighted mean).
//  - rgb is clamped to PYR_MAX (about half the surfaces' HDR_CLAMP), and a non-finite colour is 0.
//
// LowPassMips: level k from level k - 1 with the separable binomial [1 3 3 1] / 8 (4 bilinear taps 0.75 source
// texels off the level-k texel's centre), in fp32 in the shader. gl.generateMipmap's 2x2 box (the pyramid until
// September 2026) had two faults: the SSR's anisotropic lookups of a lamp drew the box mips' 8-32 px blocks as
// staircase edges and blocky glows, and on some drivers (NVIDIA GL) it sums a 2x2 block of an RGBA16F level in half
// precision, so a lamp at HDR_CLAMP overflowed to Inf in the mips (white or red blocks in the water mirror, fireflies
// in the SSR). A binomial chain approximates a Gaussian (sd about half a texel of the level) with smooth tails.
// Level k renders into a scratch target of its own size from textureLod( level k - 1 ) and is blitted into level k,
// as HiZ does: rendering into level k of the sampled texture (base / max level fences) was no cheaper and leans on
// the driver's per-level feedback tracking.

import * as THREE from 'three';
import { FullscreenQuad, quadMaterial } from './quad.ts';

/** nits: the largest colour the pyramid stores */
export const PYR_MAX = 16000;
/** levels built and sampled (1920 x 1080: level 7 is 15 x 8; the SSR's widest lobes and the water's blur (lod <= 6)
 * need no coarser one) */
export const PYR_LEVELS = 8;

/** Floor-halved sizes of the first `max` levels of a w x h texture, down to 1 x 1 (three allocates `width >> k`). */
export function mipSizes(w: number, h: number, max = Infinity): [number, number][] {
  const n = Math.min(max, Math.floor(Math.log2(Math.max(w, h, 1))) + 1);
  const out: [number, number][] = [];
  for (let k = 0; k < n; k++) out.push([Math.max(1, w >> k), Math.max(1, h >> k)]);
  return out;
}

/** Give a render target `levels` mip levels: with the descriptors three allocates each level (and a framebuffer
 * per level) on its next setup. Call again after setSize (the count follows the size). */
export function allocMips(target: THREE.WebGLRenderTarget, max = PYR_LEVELS): void {
  const sizes = mipSizes(target.width, target.height, max);
  const cur = target.texture.mipmaps as unknown as { width: number; height: number }[] | undefined;
  if (cur && cur.length === sizes.length && cur.every((m, k) => m.width === sizes[k][0] && m.height === sizes[k][1])) return;
  target.texture.mipmaps = sizes.map(([width, height]) => ({ data: null, width, height })) as unknown as THREE.Texture['mipmaps'];
  target.texture.generateMipmaps = false;
}

/** The binomial [1 3 3 1] / 8 downsample of LowPassMips (tSrc = the chain's texture, uLod = the source level). */
export const MIP_DOWN_FRAG = /* glsl */ `
precision highp float;
uniform highp sampler2D tSrc;
uniform float uLod;    // source level
uniform vec2 uSrcInv;  // 1 / source level size
uniform vec2 uDstSize; // level being built (px)
uniform float uMax;    // rgb clamp
layout( location = 0 ) out highp vec4 outColor;
void main() {
	vec2 uv = gl_FragCoord.xy / uDstSize;
	vec2 o = 0.75 * uSrcInv;
	vec4 c = 0.25 * ( textureLod( tSrc, uv + vec2( - o.x, - o.y ), uLod ) + textureLod( tSrc, uv + vec2( o.x, - o.y ), uLod )
		+ textureLod( tSrc, uv + vec2( - o.x, o.y ), uLod ) + textureLod( tSrc, uv + vec2( o.x, o.y ), uLod ) );
	outColor = vec4( min( c.rgb, vec3( uMax ) ), c.a );
}
`;

interface GlTextureProps { __webglTexture?: WebGLTexture }
interface FramebufferProps { __webglFramebuffer?: WebGLFramebuffer | WebGLFramebuffer[] }

/** Builds levels 1.. of a render target's chain (allocMips) from its level 0, each a binomial low-pass of the one
 * before, rgb clamped to `max`: level k renders into a scratch target of exactly its size while the chain samples
 * level k - 1 (the chain is never attached while it is sampled), and a blit copies it into level k. One scratch per
 * level (together a third of level 0): a single level-1-sized scratch loaded and stored its whole attachment for every
 * level, which cost 0.1-0.2 ms at ultra. */
export class LowPassMips {
  readonly material: THREE.ShaderMaterial;
  private readonly quad = new FullscreenQuad();
  private readonly srcInv = new THREE.Vector2(1, 1);
  private readonly dstSize = new THREE.Vector2(1, 1);
  private readonly scratch: THREE.WebGLRenderTarget[] = [];
  private readonly name: string;

  constructor(name: string, max: number) {
    this.name = name;
    this.material = quadMaterial(name, MIP_DOWN_FRAG, {}, {
      tSrc: { value: null }, uLod: { value: 0 }, uSrcInv: { value: this.srcInv }, uDstSize: { value: this.dstSize },
      uMax: { value: max },
    });
  }

  /** The scratch target of level k, sized w x h. */
  private level(k: number, w: number, h: number): THREE.WebGLRenderTarget {
    let t = this.scratch[k];
    if (!t) {
      t = new THREE.WebGLRenderTarget(w, h, {
        type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
        minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
      });
      t.texture.name = `${this.name}.${k}`;
      this.scratch[k] = t;
    } else if (t.width !== w || t.height !== h) {
      t.setSize(w, h);
    }
    return t;
  }

  /** Levels 1..n-1 of `target` (n = its mip descriptors) from level 0; leaves the texture sampling levels 0..n-1
   * (TEXTURE_MAX_LEVEL: the levels past n - 1 are not allocated) and no target bound. */
  build(renderer: THREE.WebGLRenderer, target: THREE.WebGLRenderTarget): void {
    const n = (target.texture.mipmaps as unknown[] | undefined)?.length ?? 1;
    const gl = renderer.getContext() as WebGL2RenderingContext;
    const tex = (renderer.properties.get(target.texture) as GlTextureProps).__webglTexture;
    const fbs = (renderer.properties.get(target) as FramebufferProps).__webglFramebuffer;
    if (!tex || !Array.isArray(fbs)) return;
    const state = renderer.state;
    state.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, n - 1);
    const u = this.material.uniforms;
    u.tSrc.value = target.texture;
    let sw = target.width, sh = target.height;
    for (let k = 1; k < n; k++) {
      const w = Math.max(1, target.width >> k), h = Math.max(1, target.height >> k);
      u.uLod.value = k - 1;
      this.srcInv.set(1 / sw, 1 / sh);
      this.dstSize.set(w, h);
      const scratch = this.level(k, w, h);
      this.quad.render(renderer, this.material, scratch);
      const src = (renderer.properties.get(scratch) as FramebufferProps).__webglFramebuffer as WebGLFramebuffer;
      state.bindFramebuffer(gl.READ_FRAMEBUFFER, src);
      state.bindFramebuffer(gl.DRAW_FRAMEBUFFER, fbs[k]);
      gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
      state.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
      state.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
      sw = w;
      sh = h;
    }
    u.tSrc.value = null;
    renderer.setRenderTarget(null);
  }

  /** Free the scratch targets (they reallocate on the next build). */
  release(): void {
    for (const t of this.scratch) t?.dispose();
    this.scratch.length = 0;
  }

  dispose(): void {
    this.release();
    this.material.dispose();
  }
}

const FRAG = /* glsl */ `
precision highp float;
uniform highp sampler2D tColor;
uniform highp sampler2D tFallback;
uniform bool uFallback;
uniform highp sampler2D tDepth;
uniform vec2 uSrcSize; // full-resolution size (px)
uniform vec2 uDstSize; // level-0 size (px)
uniform float uNear;
uniform float uFar;
layout( location = 0 ) out highp vec4 outColor;
vec3 brOpaqueColor( vec2 uv ) {
	vec3 c = texture( tColor, uv ).rgb;
	if ( uFallback ) c += texture( tFallback, uv ).rgb;
	return c;
}
void main() {
	vec2 uv = gl_FragCoord.xy / uDstSize;
	ivec2 src = ivec2( uSrcSize );
#ifdef BR_PYR_FULL
	ivec2 p = min( ivec2( gl_FragCoord.xy ), src - 1 );
	vec3 c = texelFetch( tColor, p, 0 ).rgb;
	if ( uFallback ) c += texelFetch( tFallback, p, 0 ).rgb;
#else
	ivec2 p = min( ivec2( uv * uSrcSize ), src - 1 );
	vec2 o = 0.25 / uDstSize; // a quarter of a level-0 texel: the 4 bilinear taps span its footprint
	vec3 c = 0.25 * ( brOpaqueColor( uv + vec2( - o.x, - o.y ) ) + brOpaqueColor( uv + vec2( o.x, - o.y ) )
		+ brOpaqueColor( uv + vec2( - o.x, o.y ) ) + brOpaqueColor( uv + vec2( o.x, o.y ) ) );
#endif
	if ( any( isnan( c ) ) || any( isinf( c ) ) ) c = vec3( 0.0 );
	float d = texelFetch( tDepth, p, 0 ).x;
	// window depth -> positive view distance (perspective; the SSAO pass linearises the same way)
	float z = d >= 1.0 ? uFar : uNear * uFar / ( uFar - d * ( uFar - uNear ) );
	outColor = vec4( clamp( c, vec3( 0.0 ), vec3( ${PYR_MAX.toFixed(1)} ) ), z );
}
`;

export class ColorPyramid {
  readonly target: THREE.WebGLRenderTarget;
  /** 1 / level-0 size */
  readonly invSize = new THREE.Vector2(1, 1);
  private readonly full: THREE.ShaderMaterial;
  private readonly box: THREE.ShaderMaterial;
  private readonly mips = new LowPassMips('br-pyramid-down', PYR_MAX);
  private readonly quad = new FullscreenQuad();
  private readonly srcSize = new THREE.Vector2(1, 1);
  private readonly dstSize = new THREE.Vector2(1, 1);
  private scale = 1;

  constructor() {
    this.target = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false,
      generateMipmaps: false, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter,
      wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping,
    });
    this.target.texture.name = 'Frame.ColorPyramid';
    allocMips(this.target);
    const uniforms = (): Record<string, THREE.IUniform> => ({
      tColor: { value: null }, tFallback: { value: null }, uFallback: { value: false }, tDepth: { value: null },
      uSrcSize: { value: this.srcSize }, uDstSize: { value: this.dstSize },
      uNear: { value: 0.05 }, uFar: { value: 400 },
    });
    this.full = quadMaterial('br-pyramid-full', FRAG, { BR_PYR_FULL: '' }, uniforms());
    this.box = quadMaterial('br-pyramid-box', FRAG, {}, uniforms());
  }

  get texture(): THREE.Texture { return this.target.texture; }
  /** level-0 size (px) */
  get width(): number { return this.target.width; }
  get height(): number { return this.target.height; }
  get materials(): readonly THREE.ShaderMaterial[] { return [this.full, this.box, this.mips.material]; }

  /** Level-0 size for a `w` x `h` full-resolution target at scale `s` (reallocates only on change). */
  setSize(w: number, h: number, s: number): void {
    const dw = Math.max(1, Math.round(w * s)), dh = Math.max(1, Math.round(h * s));
    this.scale = s;
    this.srcSize.set(Math.max(1, w), Math.max(1, h));
    if (dw !== this.target.width || dh !== this.target.height) {
      this.target.setSize(dw, dh);
      allocMips(this.target);
    }
    this.dstSize.set(dw, dh);
    this.invSize.set(1 / dw, 1 / dh);
  }

  /** Build the complete opaque radiance and depth, then the low-passed levels. MRT frames supply their separate
   * fallback specular here, before filtering; the current SSR result is excluded to avoid reflection feedback. */
  build(renderer: THREE.WebGLRenderer, color: THREE.Texture, depth: THREE.Texture, camera: THREE.PerspectiveCamera, fallback: THREE.Texture | null = null): void {
    const m = this.scale === 1 ? this.full : this.box;
    const u = m.uniforms;
    u.tColor.value = color;
    u.tFallback.value = fallback;
    u.uFallback.value = fallback !== null;
    u.tDepth.value = depth;
    u.uNear.value = camera.near;
    u.uFar.value = camera.far;
    this.quad.render(renderer, m, this.target);
    this.mips.build(renderer, this.target);
  }

  /** Free the GL target (quality switch to a preset without split frames); the next build reallocates it. */
  release(): void {
    this.target.dispose();
    this.mips.release();
  }

  dispose(): void {
    this.target.dispose();
    this.full.dispose();
    this.box.dispose();
    this.mips.dispose();
  }
}
