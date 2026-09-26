// src/post/AutoExposurePass.ts (WP11) — camcorder auto-exposure meter (custom postprocessing Pass, needsSwap false).
//  1. Render the centre-weighted log2(max(lum, 1e-4)) of the input buffer (16 taps per texel, per-pixel luminance
//     clamped at 2^(EV+3)*k so lenses do not dominate) into a 64x64 HalfFloat target with mipmaps
//     (r = w * log2 L, g = w). centerFocus (0..1, PostStack: flashlight on) narrows the weight toward the centre.
//  2. Read the 1x1 mip in a shader into a 1x1 RGBA8 target (log2 packed into 16 bits).
//  3. readRenderTargetPixelsAsync (RGBA8/UnsignedByte), at most one read in flight, every MEASURE_EVERY frames
//     (each read is a PBO readPixels + fence that can cost a pipelined frame on some drivers; the exposure spring
//     adapts over seconds, so ~20 reads/s at 165 Hz or ~8/s at 60 Hz are plenty).
//  4. CPU (PostStack): EV100 = avgLog2 + log2(100/12.5), clamped to the atmosphere range, spring-adapted.

import * as THREE from 'three';
import { Pass } from 'postprocessing';
import { LOG_PACK, unpackLog2 } from './exposureMath.ts';

const SIZE = 64;
const MIP_1x1 = 6;
export const MEASURE_EVERY = 8;

const VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 1.0, 1.0); }
`;

const LOG_FRAG = /* glsl */ `
uniform sampler2D tInput;
uniform float uMaxLum;
uniform float uFocus;
varying vec2 vUv;
void main() {
  vec2 fp = vec2(1.0 / ${SIZE}.0);
  float s = 0.0;
  for (int j = 0; j < 4; j++) {
    for (int i = 0; i < 4; i++) {
      vec2 uv = vUv + (vec2(float(i), float(j)) - 1.5) * 0.25 * fp;
      vec3 c = texture2D(tInput, uv).rgb;
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      s += log2(clamp(l, 1e-4, uMaxLum));
    }
  }
  s *= 1.0 / 16.0;
  vec2 d = (vUv - 0.5) * vec2(1.7, 2.2);
  // centre-weighted metering; uFocus (flashlight on) narrows it toward a spot meter on the beam
  float w = mix(0.3, 0.04, uFocus) + exp(-2.2 * (1.0 + 2.5 * uFocus) * dot(d, d));
  gl_FragColor = vec4(s * w, w, 0.0, 1.0);
}
`;

const PACK_FRAG = /* glsl */ `
uniform sampler2D tLog;
varying vec2 vUv;
void main() {
  vec4 m = textureLod(tLog, vec2(0.5), ${MIP_1x1}.0);
  float v = m.x / max(m.y, 1e-6);
  float q = floor(clamp((v - (${LOG_PACK.MIN.toFixed(1)})) / ${LOG_PACK.RANGE.toFixed(1)}, 0.0, 1.0) * 65535.0 + 0.5);
  float hi = floor(q / 256.0);
  float lo = q - hi * 256.0;
  gl_FragColor = vec4(hi / 255.0, lo / 255.0, 0.0, 1.0);
}
`;

export class AutoExposurePass extends Pass {
  /** Latest metered average log2 luminance (nits), NaN until the first readback resolves. */
  measuredLog2 = NaN;
  /** Increments on every completed readback. */
  measurements = 0;
  /** Per-pixel luminance clamp (nits); PostStack sets it from the current EV each frame. */
  maxLum = 1024;
  /** 0 = normal centre-weighted average, 1 = near-spot metering (the flashlight beam). */
  centerFocus = 0;
  paused = false;
  private readonly logRT: THREE.WebGLRenderTarget;
  private readonly packRT: THREE.WebGLRenderTarget;
  private readonly logMat: THREE.ShaderMaterial;
  private readonly packMat: THREE.ShaderMaterial;
  private readonly px = new Uint8Array(4);
  private inFlight = false;
  private frame = 0;
  private disposed = false;

  constructor() {
    super('AutoExposurePass');
    this.needsSwap = false;
    this.logRT = new THREE.WebGLRenderTarget(SIZE, SIZE, {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false,
      generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter,
    });
    this.logRT.texture.name = 'AutoExposure.Log';
    this.packRT = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.UnsignedByteType, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false,
      generateMipmaps: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
    });
    this.packRT.texture.name = 'AutoExposure.Pack';
    this.logMat = new THREE.ShaderMaterial({
      name: 'br-ae-log', vertexShader: VERT, fragmentShader: LOG_FRAG,
      uniforms: { tInput: { value: null }, uMaxLum: { value: 1024 }, uFocus: { value: 0 } },
      depthTest: false, depthWrite: false, blending: THREE.NoBlending, toneMapped: false,
    });
    this.packMat = new THREE.ShaderMaterial({
      name: 'br-ae-pack', vertexShader: VERT, fragmentShader: PACK_FRAG,
      uniforms: { tLog: { value: this.logRT.texture } },
      depthTest: false, depthWrite: false, blending: THREE.NoBlending, toneMapped: false,
    });
    this.fullscreenMaterial = this.logMat;
  }

  override render(renderer: THREE.WebGLRenderer, inputBuffer: THREE.WebGLRenderTarget | null): void {
    if (!inputBuffer || this.disposed) return;
    this.frame++;
    if (this.paused || this.inFlight || this.frame % MEASURE_EVERY !== 1) return;
    this.logMat.uniforms.tInput.value = inputBuffer.texture;
    this.logMat.uniforms.uMaxLum.value = this.maxLum;
    this.logMat.uniforms.uFocus.value = Math.min(1, Math.max(0, this.centerFocus));
    this.fullscreenMaterial = this.logMat;
    renderer.setRenderTarget(this.logRT);
    renderer.render(this.scene, this.camera);
    this.fullscreenMaterial = this.packMat;
    renderer.setRenderTarget(this.packRT);
    renderer.render(this.scene, this.camera);
    this.fullscreenMaterial = this.logMat;
    this.inFlight = true;
    renderer.readRenderTargetPixelsAsync(this.packRT, 0, 0, 1, 1, this.px).then(
      () => {
        this.inFlight = false;
        if (this.disposed) return;
        const v = unpackLog2(this.px[0], this.px[1]);
        if (Number.isFinite(v)) { this.measuredLog2 = v; this.measurements++; }
      },
      () => { this.inFlight = false; },
    );
  }

  override dispose(): void {
    this.disposed = true;
    this.logRT.dispose();
    this.packRT.dispose();
    this.logMat.dispose();
    this.packMat.dispose();
  }
}
