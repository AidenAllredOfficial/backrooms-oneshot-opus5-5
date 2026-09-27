// src/post/frame/ColorPyramid.ts — the shared opaque colour + linear depth copy of split frames (post/ScenePass.ts),
// built after the opaque render and before water / sparks / motes: package D's SSR cone lookups and package E's water
// refraction, blur and contact band read it (MaterialGlobals.sceneColor / sceneInvSize, FrameContext.pyramid).
//  - RGBA16F, level 0 = round(W x s) x round(H x s) of the full-resolution target, s = QualityConfig.colorPyramidScale
//    (high 1.0, ultra 0.67), LinearMipmapLinear with the mip chain from gl.generateMipmap (three regenerates it after
//    each render into a mipmapped target), ClampToEdge.
//  - rgb = the opaque HDR colour before reflections and water: the source texel at s = 1, otherwise a 4-tap bilinear
//    box over the texel's footprint (about 3x3 source texels at 0.67).
//  - a = the linear view depth (positive metres; the far plane where nothing was drawn) of the NEAREST full-resolution
//    depth texel: read it with texelFetch on level 0 only (the mip chain averages it).

import * as THREE from 'three';
import { FullscreenQuad, quadMaterial } from './quad.ts';

const FRAG = /* glsl */ `
precision highp float;
uniform highp sampler2D tColor;
uniform highp sampler2D tDepth;
uniform vec2 uSrcSize; // full-resolution size (px)
uniform vec2 uDstSize; // level-0 size (px)
uniform float uNear;
uniform float uFar;
layout( location = 0 ) out highp vec4 outColor;
void main() {
	vec2 uv = gl_FragCoord.xy / uDstSize;
	ivec2 src = ivec2( uSrcSize );
#ifdef BR_PYR_FULL
	ivec2 p = min( ivec2( gl_FragCoord.xy ), src - 1 );
	vec3 c = texelFetch( tColor, p, 0 ).rgb;
#else
	ivec2 p = min( ivec2( uv * uSrcSize ), src - 1 );
	vec2 o = 0.25 / uDstSize; // a quarter of a level-0 texel: the 4 bilinear taps span its footprint
	vec3 c = 0.25 * ( texture( tColor, uv + vec2( - o.x, - o.y ) ).rgb + texture( tColor, uv + vec2( o.x, - o.y ) ).rgb
		+ texture( tColor, uv + vec2( - o.x, o.y ) ).rgb + texture( tColor, uv + vec2( o.x, o.y ) ).rgb );
#endif
	float d = texelFetch( tDepth, p, 0 ).x;
	// window depth -> positive view distance (perspective; the SSAO pass linearises the same way)
	float z = d >= 1.0 ? uFar : uNear * uFar / ( uFar - d * ( uFar - uNear ) );
	outColor = vec4( c, z );
}
`;

export class ColorPyramid {
  readonly target: THREE.WebGLRenderTarget;
  /** 1 / level-0 size */
  readonly invSize = new THREE.Vector2(1, 1);
  private readonly full: THREE.ShaderMaterial;
  private readonly box: THREE.ShaderMaterial;
  private readonly quad = new FullscreenQuad();
  private readonly srcSize = new THREE.Vector2(1, 1);
  private readonly dstSize = new THREE.Vector2(1, 1);
  private scale = 1;

  constructor() {
    this.target = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false,
      generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter,
      wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping,
    });
    this.target.texture.name = 'Frame.ColorPyramid';
    const uniforms = (): Record<string, THREE.IUniform> => ({
      tColor: { value: null }, tDepth: { value: null }, uSrcSize: { value: this.srcSize }, uDstSize: { value: this.dstSize },
      uNear: { value: 0.05 }, uFar: { value: 400 },
    });
    this.full = quadMaterial('br-pyramid-full', FRAG, { BR_PYR_FULL: '' }, uniforms());
    this.box = quadMaterial('br-pyramid-box', FRAG, {}, uniforms());
  }

  get texture(): THREE.Texture { return this.target.texture; }
  /** level-0 size (px) */
  get width(): number { return this.target.width; }
  get height(): number { return this.target.height; }
  get materials(): readonly THREE.ShaderMaterial[] { return [this.full, this.box]; }

  /** Level-0 size for a `w` x `h` full-resolution target at scale `s` (reallocates only on change). */
  setSize(w: number, h: number, s: number): void {
    const dw = Math.max(1, Math.round(w * s)), dh = Math.max(1, Math.round(h * s));
    this.scale = s;
    this.srcSize.set(Math.max(1, w), Math.max(1, h));
    if (dw !== this.target.width || dh !== this.target.height) this.target.setSize(dw, dh);
    this.dstSize.set(dw, dh);
    this.invSize.set(1 / dw, 1 / dh);
  }

  /** Build level 0 from the opaque colour and its depth (then the mips); leaves the pyramid target bound. */
  build(renderer: THREE.WebGLRenderer, color: THREE.Texture, depth: THREE.Texture, camera: THREE.PerspectiveCamera): void {
    const m = this.scale === 1 ? this.full : this.box;
    const u = m.uniforms;
    u.tColor.value = color;
    u.tDepth.value = depth;
    u.uNear.value = camera.near;
    u.uFar.value = camera.far;
    this.quad.render(renderer, m, this.target);
  }

  /** Free the GL target (quality switch to a preset without split frames); the next build reallocates it. */
  release(): void {
    this.target.dispose();
  }

  dispose(): void {
    this.target.dispose();
    this.full.dispose();
    this.box.dispose();
  }
}
