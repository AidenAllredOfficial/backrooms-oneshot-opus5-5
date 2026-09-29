// src/post/effects/LensEffect.ts (WP11) — the cheap camcorder lens, applied to the finished image (bloom included,
// after SMAA). EffectAttribute.CONVOLUTION and NO mainUv (it samples `inputBuffer` itself), so it merges with the
// film grain in the last EffectPass:
//  - barrel distortion, k = -0.02 * film.distortion (corners stay in frame: the centre is magnified instead);
//  - radial (lateral) chromatic aberration, 1.5 px at the corners * film.chromaticAberration: a 5-tap SPECTRAL
//    smear (package C.6: taps at [-1, -.5, 0, .5, 1] x the CA scale, each channel a normalised weighting of the taps,
//    LENS_CA_WEIGHTS), so edges get graded purple-green-yellow fringes instead of hard cyan / orange outlines;
//  - camcorder mode: CMOS rolling-shutter skew (C.6: uRS, uv shift per unit of row offset from the frame centre, set
//    from MotionBlurEffect's angular velocity; zero on cuts and pause), applied before the distortion;
//  - (the cos^4 natural vignetting moved to ExposureEffect in R2-post: it acts on HDR radiance before the clip;
//    uLens.z stays for a residual display-side vignette and PostStack sets it to 0);
//  - glitch displacement (bands, RGB split, block dropouts) driven by post.glitch() and simulation time;
//  - lens MTF (R2-post): a 6-tap ring blur of radius 0.6 px at the centre growing to 1.4 px in the corners, mixed
//    70 %, then a mild camcorder "detail" unsharp mask (amount 0.25, ~1.5 px, in a gamma-like domain) for the
//    faint edge-enhancement halo of consumer video;
//  - camcorder mode: chroma bleed, faint interlace, head-switching noise band at the bottom, a faint vertical CCD
//    smear above/below clipped emitters and a slow fluorescent/rolling-shutter beat band (<= 2.5 %, ~0.5 Hz scroll,
//    scaled by uCam.w which PostStack zeroes for flicker Off and halves for Reduced).

import * as THREE from 'three';
import { BlendFunction, Effect, EffectAttribute } from 'postprocessing';
import { rollingShutterUv, type MotionBlurEffect } from './MotionBlurEffect.ts';

export const LENS_FRAG = /* glsl */ `
uniform vec4 uLens;     // x distortion K (>0 barrel), y CA px at the corner, z vignette exponent, w effective tan(fov/2)
uniform vec4 uGlitch;   // x amount 0..1, y frame index, z band seed, w unused
uniform vec4 uCam;      // x camcorder 0/1, y frame index, z simulation time, w beat-band amplitude (0..0.03)
uniform vec2 uMtf;      // x blur mix (0 = off), y unsharp amount
uniform vec2 uRS;       // rolling shutter: uv shift per unit of (st.y - .5) (camcorder mode; 0 = off)
float brLensHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec3 brLensYuv(vec3 c) {
  float y = dot(c, vec3(0.299, 0.587, 0.114));
  return vec3(y, (c.b - y) * 0.565, (c.r - y) * 0.713);
}
vec3 brLensRgb(vec3 v) {
  return vec3(v.x + 1.403 * v.z, v.x - 0.344 * v.y - 0.714 * v.z, v.x + 1.770 * v.y);
}
// spectral lateral CA: 5 full-RGB taps at radial scales [-1, -.5, 0, .5, 1] * caS; each channel a normalised weighting
// (red spreads outward, blue inward, green centred)
vec3 brLensFetch(vec2 uvd, float caS) {
  vec2 d = uvd - 0.5;
  vec3 t0 = texture2D(inputBuffer, clamp(0.5 + d * (1.0 - caS), 0.0, 1.0)).rgb;
  vec3 t1 = texture2D(inputBuffer, clamp(0.5 + d * (1.0 - 0.5 * caS), 0.0, 1.0)).rgb;
  vec3 t2 = texture2D(inputBuffer, clamp(uvd, 0.0, 1.0)).rgb;
  vec3 t3 = texture2D(inputBuffer, clamp(0.5 + d * (1.0 + 0.5 * caS), 0.0, 1.0)).rgb;
  vec3 t4 = texture2D(inputBuffer, clamp(0.5 + d * (1.0 + caS), 0.0, 1.0)).rgb;
  return vec3(0.0, 0.05, 0.55) * t0 + vec3(0.0, 0.2, 0.35) * t1 + vec3(0.1, 0.5, 0.1) * t2
    + vec3(0.35, 0.2, 0.0) * t3 + vec3(0.55, 0.05, 0.0) * t4;
}
void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec2 st = uv;
  // ---- glitch: horizontal band tearing driven by post.glitch()
  float ga = uGlitch.x;
  float split = 0.0;
  if (ga > 0.0) {
    float fr = uGlitch.y;
    float bands = 18.0 + floor(brLensHash(vec2(fr, 3.1)) * 40.0);
    float band = floor(st.y * bands);
    float hb = brLensHash(vec2(band, fr + uGlitch.z));
    if (hb < 0.35 * ga + 0.08) st.x += (brLensHash(vec2(band, fr * 1.7)) - 0.5) * 0.14 * ga;
    float blk = brLensHash(floor(st * vec2(24.0, 14.0)) + fr);
    if (blk > 1.0 - 0.06 * ga) st.y += (brLensHash(vec2(blk, fr)) - 0.5) * 0.03 * ga;
    split = 6.0 * ga * (0.5 + brLensHash(vec2(fr, 9.0)));
  }
  // ---- camcorder head-switching band (bottom ~3 % of the frame)
  float cam = uCam.x;
  float headBand = 0.0;
  if (cam > 0.5) {
    float hb = 1.0 - smoothstep(0.0, 0.03, st.y);
    headBand = hb;
    st.x += hb * (0.012 + 0.02 * brLensHash(vec2(floor(st.y * resolution.y), uCam.y)));
  }
  // ---- rolling shutter (camcorder): rows are read top to bottom while the camera turns, so vertical edges lean
  st = clamp(st + uRS * (st.y - 0.5), 0.0, 1.0);
  // ---- barrel distortion (normalised so the corners map to the corners)
  vec2 p = (st - 0.5) * vec2(aspect, 1.0);
  float r2 = dot(p, p) / (0.25 * (aspect * aspect + 1.0));
  vec2 uvd = 0.5 + (st - 0.5) * (1.0 + uLens.x * r2) / (1.0 + uLens.x);
  // ---- lateral CA: uLens.y px at the corner (radius 0.5 * |resolution| px)
  float caS = (uLens.y + split) / (0.5 * length(resolution));
  vec3 col;
  if (caS == 0.0) col = texture2D(inputBuffer, clamp(uvd, 0.0, 1.0)).rgb;
  else col = brLensFetch(uvd, caS);
  // ---- lens MTF: soft ring blur growing toward the corners, then the camcorder detail (unsharp) halo
  if (uMtf.x > 0.0) {
    vec2 pr = (uv - 0.5) * vec2(aspect, 1.0);
    float rr = clamp(dot(pr, pr) / (0.25 * (aspect * aspect + 1.0)), 0.0, 1.0);
    vec2 tr = texelSize * mix(0.6, 1.4, rr);
    vec3 ring = texture2D(inputBuffer, uvd + vec2(tr.x, 0.0)).rgb + texture2D(inputBuffer, uvd - vec2(tr.x, 0.0)).rgb
      + texture2D(inputBuffer, uvd + vec2(0.5, 0.866) * tr).rgb + texture2D(inputBuffer, uvd - vec2(0.5, 0.866) * tr).rgb
      + texture2D(inputBuffer, uvd + vec2(-0.5, 0.866) * tr).rgb + texture2D(inputBuffer, uvd - vec2(-0.5, 0.866) * tr).rgb;
    vec3 soft = mix(col, ring * (1.0 / 6.0), 0.6);
    col = mix(col, soft, uMtf.x);
    vec2 tw = texelSize * 1.6;
    vec3 wide = 0.25 * (texture2D(inputBuffer, uvd + vec2(tw.x, 0.0)).rgb + texture2D(inputBuffer, uvd - vec2(tw.x, 0.0)).rgb
      + texture2D(inputBuffer, uvd + vec2(0.0, tw.y)).rgb + texture2D(inputBuffer, uvd - vec2(0.0, tw.y)).rgb);
    vec3 sc = sqrt(max(col, vec3(0.0)));
    vec3 sw = sqrt(max(mix(soft, wide, 0.75), vec3(0.0)));
    sc = max(sc + uMtf.y * (sc - sw), vec3(0.0));
    col = sc * sc;
  }
  if (cam > 0.5) {
    // chroma bleed: chroma smeared to the right (low-bandwidth colour), luma sharp
    vec3 yuv = brLensYuv(col);
    vec2 acc = yuv.yz * 0.4;
    for (int k = 1; k <= 4; k++) {
      vec3 s = texture2D(inputBuffer, clamp(uvd - vec2(float(k) * 1.6 * texelSize.x, 0.0), 0.0, 1.0)).rgb;
      acc += brLensYuv(s).yz * 0.15;
    }
    col = max(brLensRgb(vec3(yuv.x, acc)), vec3(0.0));
    // faint interlace (field alternates each frame) and the noisy head-switch band
    float line = mod(floor(gl_FragCoord.y) + uCam.y, 2.0);
    col *= 0.975 + 0.025 * line;
    float n = brLensHash(gl_FragCoord.xy + uCam.y * 17.0);
    col = mix(col, vec3(dot(col, vec3(0.333)) * 0.8 + n * 0.12), headBand * 0.7);
    // CCD smear: a faint vertical streak through the column of a clipped emitter
    float sm = 0.0;
    float jit = brLensHash(vec2(gl_FragCoord.x, uCam.y)) / 16.0;
    for (int k = 0; k < 16; k++) {
      vec3 s = texture2D(inputBuffer, vec2(uvd.x, (float(k) + 0.5) / 16.0 + jit - 0.5 / 16.0)).rgb;
      sm += smoothstep(0.92, 1.0, min(min(s.r, s.g), s.b));
    }
    col += vec3(0.92, 0.95, 1.0) * (sm / 16.0) * 0.12;
    // fluorescent / rolling-shutter beat: slow scrolling horizontal bands
    col *= 1.0 + uCam.w * sin(6.2831853 * (st.y * 1.7 - uCam.z * 0.45));
  }
  // ---- residual display-side cos^4 vignette (0 = off; the optical one lives in ExposureEffect)
  float v = 1.0;
  if (uLens.z > 0.0) {
    vec2 q = (uv - 0.5) * 2.0 * vec2(aspect, 1.0) * uLens.w;
    float c2 = 1.0 / (1.0 + dot(q, q));
    v = pow(c2 * c2, uLens.z);
  }
  outputColor = vec4(col * v, inputColor.a);
}
`;


/** Effective focal length ~1.8x longer than the render camera's for the cos^4 vignette (a plain cos^4 at 62 deg
 * would be -2.6 EV): tan(fov/2) is scaled by this. */
export const VIGNETTE_FOCAL = 0.55;
/** Lens MTF defaults (R2-post): blur mix and unsharp amount at film strengths 1. */
export const LENS_MTF = { MIX: 0.7, UNSHARP: 0.25 } as const;
/** C.6 spectral CA: tap scales (x the CA scale) and each channel's (normalised) tap weights, as in LENS_FRAG. */
export const LENS_CA = {
  SCALES: [-1, -0.5, 0, 0.5, 1] as readonly number[],
  R: [0, 0, 0.1, 0.35, 0.55] as readonly number[],
  G: [0.05, 0.2, 0.5, 0.2, 0.05] as readonly number[],
  B: [0.55, 0.35, 0.1, 0, 0] as readonly number[],
} as const;

export class LensEffect extends Effect {
  private readonly uLens: THREE.Uniform<THREE.Vector4>;
  private readonly uGlitch: THREE.Uniform<THREE.Vector4>;
  private readonly uCam: THREE.Uniform<THREE.Vector4>;
  private readonly uMtf: THREE.Uniform<THREE.Vector2>;
  private readonly uRS: THREE.Uniform<THREE.Vector2>;
  private motion: Pick<MotionBlurEffect, 'angularVelocity' | 'wasCut'> | null = null;
  private motionCamera: THREE.PerspectiveCamera | null = null;
  private rollingShutterEnabled = true;
  constructor() {
    const uLens = new THREE.Uniform(new THREE.Vector4(0.02, 1.5, 1, 0.33));
    const uGlitch = new THREE.Uniform(new THREE.Vector4(0, 0, 0, 0));
    const uCam = new THREE.Uniform(new THREE.Vector4(0, 0, 0, 0));
    const uMtf = new THREE.Uniform(new THREE.Vector2(LENS_MTF.MIX, LENS_MTF.UNSHARP));
    const uRS = new THREE.Uniform(new THREE.Vector2(0, 0));
    super('LensEffect', LENS_FRAG, {
      attributes: EffectAttribute.CONVOLUTION,
      blendFunction: BlendFunction.SRC,
      uniforms: new Map<string, THREE.Uniform>([['uLens', uLens], ['uGlitch', uGlitch], ['uCam', uCam], ['uMtf', uMtf], ['uRS', uRS]]),
    });
    this.uLens = uLens;
    this.uGlitch = uGlitch;
    this.uCam = uCam;
    this.uMtf = uMtf;
    this.uRS = uRS;
  }
  /** Rolling-shutter skew (uv shift per unit of row offset from the centre; motionBlur rollingShutterUv); 0, 0 = off. */
  setRollingShutter(x: number, y: number): void {
    const lim = 0.05; // a wild frame (hitch) must not tear the image apart
    this.uRS.value.set(Math.max(-lim, Math.min(lim, x)), Math.max(-lim, Math.min(lim, y)));
  }
  /** The HDR pass updates the motion before this final lens pass, so the skew follows the current frame's turn. */
  setMotionSource(motion: Pick<MotionBlurEffect, 'angularVelocity' | 'wasCut'>, camera: THREE.PerspectiveCamera): void {
    this.motion = motion;
    this.motionCamera = camera;
  }
  setRollingShutterEnabled(on: boolean): void {
    this.rollingShutterEnabled = on;
  }
  override update(_renderer: THREE.WebGLRenderer, _inputBuffer: THREE.WebGLRenderTarget): void {
    const motion = this.motion, camera = this.motionCamera;
    if (!motion || !camera) return;
    if (!this.rollingShutterEnabled || this.uCam.value.x < 0.5 || motion.wasCut) {
      this.setRollingShutter(0, 0);
      return;
    }
    const av = motion.angularVelocity;
    const rs = rollingShutterUv(av.yaw, av.pitch, Math.tan(camera.fov * Math.PI / 360), camera.aspect);
    this.setRollingShutter(rs[0], rs[1]);
  }
  /** Lens softness (blur mix 0..1) and camcorder detail enhancement (unsharp amount); 0, 0 = a perfect lens. */
  setMtf(mix: number, unsharp: number): void {
    this.uMtf.value.set(Math.max(0, Math.min(1, mix)), Math.max(0, unsharp));
  }
  /** distortion/CA/vignette are the Settings.film strengths (0 disables); tanHalfFov of the render camera. */
  setLens(distortion: number, chromaticAberration: number, vignette: number, tanHalfFov: number): void {
    this.uLens.value.set(0.02 * distortion, 1.5 * chromaticAberration, vignette, tanHalfFov * VIGNETTE_FOCAL);
  }
  setGlitch(amount: number, frame: number, seed: number): void {
    this.uGlitch.value.set(amount, frame, seed, 0);
  }
  /** band = fluorescent beat-band amplitude (0 disables; PostStack scales it by the flicker setting). */
  setCamcorder(on: boolean, frame: number, t: number, band = 0): void {
    this.uCam.value.set(on ? 1 : 0, frame, t, Math.max(0, Math.min(0.03, band)));
  }
}
