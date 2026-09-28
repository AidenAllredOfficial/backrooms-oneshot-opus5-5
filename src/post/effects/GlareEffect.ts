// src/post/effects/GlareEffect.ts (package C.1 glare, C.5 aperture flare) — energy-conserving lens glare in the HDR
// pass (replaces the pmndrs BloomEffect and the R2-post halation veil).
//
// out = in * (1 - k) + U0 * k [+ STAR * starGain + GHOST * ghostGain], in nits, before ExposureEffect. k is the lens's
// scatter fraction (GLARE.K x the atmosphere's bloomIntensity x the mood's bloomMul); U0 is the input blurred by the
// angular PSF of glareMath.ts. Nothing is thresholded: every pixel scatters the same fraction, so the glow around a
// troffer is physically sized and a dark corner far from any light keeps its black (the old bloom ADDED 0.175x of
// everything above 1/exposure and the halation re-added its two coarsest mips over the whole frame: a warm veil).
//
// GlareChain (a hand-driven Pass, run from update() inside the hdrPass, so it sees the frame before exposure):
//  - D_i, i = 0..L-1: RGBA16F, W / 2^(i+1) x H / 2^(i+1). D0 = the 13-tap 'COD' downsample of the full-res input with
//    each tap clamped to MAX_EXPOSED / exposure nits (HDR_CLAMP specular fireflies) and a NaN/Inf guard; D_i = the
//    same 13 taps from D_(i-1) (no threshold, no Karis average: that would lose the energy of small distant panels).
//    While the camera moves, D0 instead integrates the input along MotionBlurEffect's per-pixel shutter path (its
//    reprojection, shutter and taps, reading the pass's depth texture): the lens scatters what the sensor integrates,
//    so a panel's glow, star and ghosts smear with it instead of staying as a sharp copy inside the blurred frame.
//  - U_i, i = 0..L-2: U_(L-2) = w_(L-1) tent9(D_(L-1)) + w_(L-2) D_(L-2); U_i = tent9(U_(i+1)) + w_i D_i, the tent
//    taps one DESTINATION texel apart. Level i then blurs with sigma ~2 * 2^i full-res px (GLARE.SIGMA0_PX) and
//    w_i (glareWeights: tinted, summing to 1 in luma) is the PSF energy of its angular band.
//  - star (C.5, glareStreaks): one extract pass writes the hot part (exposed luma above FLARE.STAR_T) of D1 - D2 on a
//    buffer taller than FLARE.HI_RES_H (ultra's 1.4x supersampled buffer), which keeps the arms the same width on
//    screen and the cost flat - weighted toward compact sources (starCompactWeight: a level three steps coarser tells
//    a bulb or a distant highbay from a near tube strip, whose broad X would stain the ceiling); then 2 axes at +-45 deg x 3
//    cascaded 7-tap passes (steps 1, 4, 16 x starStepScale texels: the same on-screen length at any buffer height and
//    dynamic-resolution scale), the last pass with wavelength-scaled R/B offsets; axis 2 adds.
//  - ghosts (C.5, glareGhosts): one pass at the star level's half size: 5 scaled / mirrored copies of the hot part of
//    the next level (the one after when shrunk), windowed, area-normalised, coating-tinted, with lateral colour.
//  - Star and ghosts are folded into the last up pass (U0 += (starGain S + ghostGain G) / k), so the full-res composite
//    reads one texture.
// The chain is skipped when k = 0 (bloom disabled); the star / ghost targets exist only while their flag is on and
// their gains are 0 otherwise (uniform branches, no recompile).

import * as THREE from 'three';
import { BlendFunction, Effect, EffectAttribute, Pass } from 'postprocessing';
import { FLARE, GLARE, glareWeights, starLevel, starStepScale, streakWeights } from '../glareMath.ts';
import { MOTION_BLUR } from './MotionBlurEffect.ts';
import type { MotionBlurState } from './MotionBlurEffect.ts';

export const GLARE_FRAG = /* glsl */ `
uniform sampler2D uGlareMap; // U0: the scattered light (+ star and ghosts, pre-divided by k)
uniform float uGlareK;       // scatter fraction k (0 = off)
void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec3 c = inputColor.rgb;
  if (uGlareK > 0.0) c = c * (1.0 - uGlareK) + texture2D(uGlareMap, uv).rgb * uGlareK;
  outputColor = vec4(c, inputColor.a);
}
`;

const VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 1.0, 1.0); }
`;

/** 13-tap 'COD' downsample: 0.5 x the centre 2x2 box + 0.125 x each of the four corner boxes (in source texels).
 * GLARE_PREFILTER (full res -> D0): the motion-blurred variant (MotionBlurEffect's path, taps of 2x2 boxes). */
const DOWN_FRAG = /* glsl */ `
uniform sampler2D tIn;
uniform vec2 uTexel; // source texel
uniform float uClamp; // per-tap max channel (nits)
varying vec2 vUv;
#ifdef GLARE_PREFILTER
uniform sampler2D tDepth;
uniform mat4 uReproj; // MotionBlurEffect: previous viewProj * inverse(viewProj)
uniform vec4 uMB;     // MotionBlurEffect: x shutter / frame dt, y max blur (px), z taps, w on
float brGlIgn(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
#endif
vec3 brGlTap(vec2 o) {
  vec3 c = max(texture2D(tIn, vUv + o * uTexel).rgb, vec3(0.0));
  float m = max(c.r, max(c.g, c.b));
  // the clamp keeps the hue; NaN / Inf fail the compare (one bad texel must not spread over the whole frame)
  return m < 1e30 ? c * min(1.0, uClamp / max(m, 1e-6)) : vec3(0.0);
}
void main() {
#ifdef GLARE_PREFILTER
  if (uMB.w > 0.5) {
    vec4 prev = uReproj * vec4(vUv * 2.0 - 1.0, texture2D(tDepth, vUv).r * 2.0 - 1.0, 1.0);
    vec2 v = prev.w > 1e-6 ? (vUv - (prev.xy / prev.w * 0.5 + 0.5)) * uMB.x : vec2(0.0);
    float lpx = length(v / uTexel);
    if (lpx >= 0.5) {
      v *= min(1.0, uMB.y / lpx);
      float n = uMB.z;
      float jt = brGlIgn(gl_FragCoord.xy) - 0.5;
      vec3 acc = vec3(0.0);
      for (int t = 0; t < ${MOTION_BLUR.MAX_TAPS}; t++) {
        if (float(t) >= n) break;
        acc += brGlTap(v * ((float(t) + 0.5 + jt) / n - 0.5) / uTexel);
      }
      gl_FragColor = vec4(acc / n, 1.0);
      return;
    }
  }
#endif
  vec3 a = brGlTap(vec2(-2.0, -2.0)), b = brGlTap(vec2(0.0, -2.0)), c = brGlTap(vec2(2.0, -2.0));
  vec3 d = brGlTap(vec2(-1.0, -1.0)), e = brGlTap(vec2(1.0, -1.0));
  vec3 f = brGlTap(vec2(-2.0, 0.0)), g = brGlTap(vec2(0.0, 0.0)), h = brGlTap(vec2(2.0, 0.0));
  vec3 i = brGlTap(vec2(-1.0, 1.0)), j = brGlTap(vec2(1.0, 1.0));
  vec3 k = brGlTap(vec2(-2.0, 2.0)), l = brGlTap(vec2(0.0, 2.0)), m = brGlTap(vec2(2.0, 2.0));
  vec3 s = (d + e + i + j) * 0.125 + (a + c + k + m) * 0.03125 + (b + f + h + l) * 0.0625 + g * 0.125;
  gl_FragColor = vec4(s, 1.0);
}
`;

/** U = uWLow * tent9(tLow) + uWCur * tCur, the tent taps one destination texel apart. GLARE_FINAL (U0): + the star
 * and ghost images, weighted gain / k (the composite multiplies U0 by k). */
const UP_FRAG = /* glsl */ `
uniform sampler2D tLow;
uniform sampler2D tCur;
uniform vec2 uTexel; // destination texel
uniform vec3 uWLow;
uniform vec3 uWCur;
#ifdef GLARE_FINAL
uniform sampler2D tStar;
uniform sampler2D tGhost;
uniform vec2 uFlareW; // star, ghost weights (gain / k; 0 = off)
#endif
varying vec2 vUv;
void main() {
  vec2 t = uTexel;
  vec3 s = texture2D(tLow, vUv).rgb * 4.0;
  s += (texture2D(tLow, vUv + vec2(t.x, 0.0)).rgb + texture2D(tLow, vUv - vec2(t.x, 0.0)).rgb
    + texture2D(tLow, vUv + vec2(0.0, t.y)).rgb + texture2D(tLow, vUv - vec2(0.0, t.y)).rgb) * 2.0;
  s += texture2D(tLow, vUv + t).rgb + texture2D(tLow, vUv - t).rgb
    + texture2D(tLow, vUv + vec2(t.x, -t.y)).rgb + texture2D(tLow, vUv - vec2(t.x, -t.y)).rgb;
  vec3 u = s * (uWLow * (1.0 / 16.0)) + texture2D(tCur, vUv).rgb * uWCur;
#ifdef GLARE_FINAL
  if (uFlareW.x > 0.0) u += texture2D(tStar, vUv).rgb * uFlareW.x;
  if (uFlareW.y > 0.0) u += texture2D(tGhost, vUv).rgb * uFlareW.y;
#endif
  gl_FragColor = vec4(u, 1.0);
}
`;

/** The star's source: the hot part (exposed luma above STAR_T) of the star level, weighted toward compact sources by
 * the hot part of the level COMPACT_LEVELS steps coarser at the same place (glareMath starCompactWeight). */
const STAR_EXTRACT_FRAG = /* glsl */ `
uniform sampler2D tIn;     // the star level
uniform sampler2D tCoarse; // the level COMPACT_LEVELS steps coarser (or the last one)
uniform float uExposure;
varying vec2 vUv;
void main() {
  const vec3 Y = vec3(0.2126, 0.7152, 0.0722);
  vec3 c = texture2D(tIn, vUv).rgb;
  float y = dot(c, Y) * uExposure;
  float hot = max(0.0, y - ${FLARE.STAR_T.toFixed(3)});
  float f = max(0.0, dot(texture2D(tCoarse, vUv).rgb, Y) * uExposure - ${FLARE.STAR_T.toFixed(3)}) / max(hot, 1e-4);
  float w = 1.0 - smoothstep(${FLARE.COMPACT[0].toFixed(4)}, ${FLARE.COMPACT[1].toFixed(4)}, f);
  gl_FragColor = vec4(c * (hot / max(y, 1e-4) * w), 1.0);
}
`;

/** One cascaded 7-tap streak pass along uDir (uv per tap). STAR_CHROMA: R / B taps at wavelength-scaled offsets
 * (rainbow tips). */
const STAR_FRAG = /* glsl */ `
uniform sampler2D tIn;
uniform vec2 uDir;
uniform float uW[4]; // kernel weights for |j| = 0..3 (normalised over j = -3..3)
uniform vec2 uChroma; // R, B offset scales
varying vec2 vUv;
void main() {
  vec3 s = vec3(0.0);
  for (int j = -3; j <= 3; j++) {
    float w = uW[abs(j)];
    vec2 o = uDir * float(j);
#ifdef STAR_CHROMA
    s.r += w * texture2D(tIn, vUv + o * uChroma.x).r;
    s.g += w * texture2D(tIn, vUv + o).g;
    s.b += w * texture2D(tIn, vUv + o * uChroma.y).b;
#else
    s += w * texture2D(tIn, vUv + o).rgb;
#endif
  }
  gl_FragColor = vec4(s, 1.0);
}
`;

const NG = FLARE.GHOST_SCALES.length;
/** Lens ghosts: scaled (negative = mirrored through the centre) copies of the hot part of a chain level (the next,
 * blurrier one when |s| > 1: a shrunk ghost would alias). */
const GHOST_FRAG = /* glsl */ `
uniform sampler2D tA; // the ghost level
uniform sampler2D tB; // the level below it (or the same)
uniform float uExposure;
uniform float uScale[${NG}];
uniform vec3 uTint[${NG}];
varying vec2 vUv;
vec3 brGhHot(vec3 c) {
  float y = dot(c, vec3(0.2126, 0.7152, 0.0722)) * uExposure;
  return c * (max(0.0, y - ${FLARE.STAR_T.toFixed(3)}) / max(y, 1e-4));
}
vec3 brGhFetch(vec2 uv, bool coarse) {
  return brGhHot(coarse ? texture2D(tB, uv).rgb : texture2D(tA, uv).rgb);
}
void main() {
  vec3 g = vec3(0.0);
  vec2 d = vUv - 0.5;
  for (int j = 0; j < ${NG}; j++) {
    float s = uScale[j];
    bool coarse = abs(s) > 1.0;
    vec2 q = 0.5 + d * s;
    // window by the source's distance from the axis; a magnified ghost spreads its energy over 1/s^2 the area
    float win = smoothstep(0.75, 0.2, length(q - 0.5)) * min(1.0, s * s);
    if (win <= 0.0) continue;
    vec3 c;
    c.r = brGhFetch(0.5 + d * (s * ${(1 + FLARE.GHOST_CA).toFixed(4)}), coarse).r;
    c.g = brGhFetch(q, coarse).g;
    c.b = brGhFetch(0.5 + d * (s * ${(1 - FLARE.GHOST_CA).toFixed(4)}), coarse).b;
    g += c * uTint[j] * win;
  }
  gl_FragColor = vec4(g, 1.0);
}
`;

const rtOpts = (): THREE.RenderTargetOptions => ({
  type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false,
  generateMipmaps: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
  wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping,
});
const newRT = (name: string): THREE.WebGLRenderTarget => {
  const rt = new THREE.WebGLRenderTarget(1, 1, rtOpts());
  rt.texture.name = name;
  return rt;
};
const mat = (name: string, frag: string, uniforms: Record<string, THREE.IUniform>, defines: Record<string, string> = {}): THREE.ShaderMaterial =>
  new THREE.ShaderMaterial({
    name, vertexShader: VERT, fragmentShader: frag, uniforms, defines,
    depthTest: false, depthWrite: false, blending: THREE.NoBlending, toneMapped: false,
  });

/** The glare pyramid + star / ghost targets (see the header). Rendered by GlareEffect.update. */
export class GlareChain extends Pass {
  /** D_i (downsampled input, nits) */
  readonly down: THREE.WebGLRenderTarget[] = [];
  /** U_i (weighted up chain); U0 is the glare image */
  readonly up: THREE.WebGLRenderTarget[] = [];
  star: { e: THREE.WebGLRenderTarget; p: THREE.WebGLRenderTarget; q: THREE.WebGLRenderTarget; s: THREE.WebGLRenderTarget } | null = null;
  ghost: THREE.WebGLRenderTarget | null = null;
  /** tinted level weights (3 per level) */
  readonly weights: Float32Array = new Float32Array(3 * 16);
  private levels: number;
  private w = 1;
  private h = 1;
  private readonly preMat: THREE.ShaderMaterial;
  private readonly downMat: THREE.ShaderMaterial;
  private readonly upMat: THREE.ShaderMaterial;
  private readonly finalMat: THREE.ShaderMaterial;
  private readonly extractMat: THREE.ShaderMaterial;
  private readonly starMats: THREE.ShaderMaterial[];
  private readonly ghostMat: THREE.ShaderMaterial;
  private readonly starW = [streakWeights(FLARE.STAR_STEPS[0]), streakWeights(FLARE.STAR_STEPS[1]), streakWeights(FLARE.STAR_STEPS[2])];

  constructor(levels: number) {
    super('GlareChain');
    this.needsSwap = false;
    this.levels = Math.max(1, Math.min(12, Math.floor(levels)));
    this.downMat = mat('br-glare-down', DOWN_FRAG, { tIn: { value: null }, uTexel: { value: new THREE.Vector2() }, uClamp: { value: 1e30 } });
    this.preMat = mat('br-glare-prefilter', DOWN_FRAG, {
      tIn: { value: null }, uTexel: { value: new THREE.Vector2() }, uClamp: { value: 1e30 },
      tDepth: { value: null }, uReproj: { value: new THREE.Matrix4() }, uMB: { value: new THREE.Vector4() },
    }, { GLARE_PREFILTER: '1' });
    const upU = (): Record<string, THREE.IUniform> => ({
      tLow: { value: null }, tCur: { value: null }, uTexel: { value: new THREE.Vector2() },
      uWLow: { value: new THREE.Vector3(1, 1, 1) }, uWCur: { value: new THREE.Vector3() },
    });
    this.upMat = mat('br-glare-up', UP_FRAG, upU());
    this.finalMat = mat('br-glare-up0', UP_FRAG, {
      ...upU(), tStar: { value: null }, tGhost: { value: null }, uFlareW: { value: new THREE.Vector2() },
    }, { GLARE_FINAL: '1' });
    this.extractMat = mat('br-glare-star-extract', STAR_EXTRACT_FRAG, { tIn: { value: null }, tCoarse: { value: null }, uExposure: { value: 1 } });
    const starU = (): Record<string, THREE.IUniform> => ({
      tIn: { value: null }, uDir: { value: new THREE.Vector2() }, uW: { value: [0, 0, 0, 0] },
      uChroma: { value: new THREE.Vector2(FLARE.STAR_CHROMA[0], FLARE.STAR_CHROMA[1]) },
    });
    this.starMats = [
      mat('br-glare-star0', STAR_FRAG, starU()),
      mat('br-glare-star1', STAR_FRAG, starU()),
      mat('br-glare-star2', STAR_FRAG, starU(), { STAR_CHROMA: '1' }),
    ];
    this.ghostMat = mat('br-glare-ghost', GHOST_FRAG, {
      tA: { value: null }, tB: { value: null }, uExposure: { value: 1 },
      uScale: { value: FLARE.GHOST_SCALES.slice() },
      uTint: { value: FLARE.GHOST_TINTS.map((t) => new THREE.Vector3(t[0], t[1], t[2])) },
    });
    this.fullscreenMaterial = this.downMat;
    this.allocLevels();
  }

  get levelCount(): number { return this.levels; }
  /** The glare image (U0; D0 with a single level). */
  get output(): THREE.WebGLRenderTarget { return this.levels > 1 ? this.up[0] : this.down[0]; }
  get starTexture(): THREE.Texture | null { return this.star ? this.star.s.texture : null; }
  get ghostTexture(): THREE.Texture | null { return this.ghost ? this.ghost.texture : null; }
  /** Chain level the star reads (D1; D2 on a buffer taller than FLARE.HI_RES_H); the ghosts read the next one. */
  get starLevel(): number { return starLevel(this.h, this.levels); }
  private get ghostLevel(): number { return Math.min(this.levels - 1, this.starLevel + 1); }

  private allocLevels(): void {
    for (const rt of this.down) rt.dispose();
    for (const rt of this.up) rt.dispose();
    this.down.length = 0;
    this.up.length = 0;
    for (let i = 0; i < this.levels; i++) this.down.push(newRT(`Glare.D${i}`));
    for (let i = 0; i < this.levels - 1; i++) this.up.push(newRT(`Glare.U${i}`));
    this.resize();
  }

  private resize(): void {
    for (let i = 0; i < this.levels; i++) {
      const s = 2 ** (i + 1);
      const w = Math.max(1, Math.round(this.w / s));
      const h = Math.max(1, Math.round(this.h / s));
      this.down[i].setSize(w, h);
      if (i < this.levels - 1) this.up[i].setSize(w, h);
    }
    if (this.star) {
      const d = this.down[this.starLevel];
      this.star.e.setSize(d.width, d.height);
      this.star.p.setSize(d.width, d.height);
      this.star.q.setSize(d.width, d.height);
      this.star.s.setSize(d.width, d.height);
    }
    if (this.ghost) {
      const d = this.down[this.ghostLevel];
      this.ghost.setSize(d.width, d.height);
    }
  }

  setLevels(n: number): void {
    const l = Math.max(1, Math.min(12, Math.floor(n)));
    if (l === this.levels) return;
    this.levels = l;
    this.allocLevels();
  }

  /** Allocate / free the star and ghost targets. */
  setFlare(streaks: boolean, ghosts: boolean): void {
    if (streaks && !this.star) this.star = { e: newRT('Glare.StarE'), p: newRT('Glare.StarP'), q: newRT('Glare.StarQ'), s: newRT('Glare.Star') };
    else if (!streaks && this.star) {
      this.star.e.dispose(); this.star.p.dispose(); this.star.q.dispose(); this.star.s.dispose();
      this.star = null;
    }
    if (ghosts && !this.ghost) this.ghost = newRT('Glare.Ghost');
    else if (!ghosts && this.ghost) { this.ghost.dispose(); this.ghost = null; }
    this.resize();
  }

  override setSize(width: number, height: number): void {
    this.w = Math.max(1, width);
    this.h = Math.max(1, height);
    this.resize();
  }

  private draw(renderer: THREE.WebGLRenderer, m: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget): void {
    this.fullscreenMaterial = m;
    renderer.setRenderTarget(target);
    renderer.render(this.scene, this.camera);
  }

  /** Run the chain on the full-res HDR input (nits). starW / ghostW: their weights in U0 (gain / k; 0 = skip the pass).
   * motion: the camera motion blur of this frame (with the depth texture), or null for a static prefilter. */
  run(renderer: THREE.WebGLRenderer, input: THREE.Texture, inW: number, inH: number, exposure: number, starW: number, ghostW: number,
    motion: { state: MotionBlurState; depth: THREE.Texture } | null): void {
    const L = this.levels;
    const star = starW > 0 && this.star !== null && L > 1;
    const ghost = ghostW > 0 && this.ghost !== null && L > 1;
    // every pass overwrites its whole target, and the second star axis ADDS onto the first: never clear (the composer
    // runs with autoClear off, but do not depend on it)
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    // 1. prefilter (full res -> D0, per-tap clamp, motion-blurred while the camera moves) and the downs
    const pm = this.preMat.uniforms;
    pm.tIn.value = input;
    (pm.uTexel.value as THREE.Vector2).set(1 / Math.max(1, inW), 1 / Math.max(1, inH));
    pm.uClamp.value = GLARE.MAX_EXPOSED / Math.max(exposure, 1e-9);
    const mbOn = motion !== null && motion.state.params.w > 0.5;
    pm.tDepth.value = mbOn && motion ? motion.depth : null;
    if (mbOn && motion) (pm.uReproj.value as THREE.Matrix4).copy(motion.state.reproj);
    (pm.uMB.value as THREE.Vector4).set(0, 0, 0, 0);
    if (mbOn && motion) (pm.uMB.value as THREE.Vector4).copy(motion.state.params);
    this.draw(renderer, this.preMat, this.down[0]);
    const dm = this.downMat.uniforms;
    dm.uClamp.value = 1e30;
    for (let i = 1; i < L; i++) {
      const src = this.down[i - 1];
      dm.tIn.value = src.texture;
      (dm.uTexel.value as THREE.Vector2).set(1 / src.width, 1 / src.height);
      this.draw(renderer, this.downMat, this.down[i]);
    }
    // 2. aperture star from the compact hot part of its level: two axes, three cascaded passes each; the second axis
    // adds. Steps scale with the buffer height (starStepScale), so the arms keep their on-screen length.
    if (star && this.star) {
      const sl = this.starLevel;
      const d1 = this.down[sl];
      const tx = 1 / d1.width, ty = 1 / d1.height;
      const k = starStepScale(this.h, sl);
      const st = this.star;
      const em = this.extractMat.uniforms;
      em.tIn.value = d1.texture;
      em.tCoarse.value = this.down[Math.min(L - 1, sl + FLARE.COMPACT_LEVELS)].texture;
      em.uExposure.value = exposure;
      this.draw(renderer, this.extractMat, st.e);
      for (let a = 0; a < FLARE.STAR_ANGLES.length; a++) {
        const ang = (FLARE.STAR_ANGLES[a] * Math.PI) / 180;
        const dx = Math.cos(ang), dy = Math.sin(ang);
        const srcs = [st.e, st.p, st.q];
        const dsts = [st.p, st.q, st.s];
        for (let p = 0; p < 3; p++) {
          const m = this.starMats[p];
          const u = m.uniforms;
          const step = FLARE.STAR_STEPS[p] * k;
          u.tIn.value = srcs[p].texture;
          (u.uDir.value as THREE.Vector2).set(dx * step * tx, dy * step * ty);
          const w = this.starW[p];
          const uw = u.uW.value as number[];
          for (let j = 0; j < 4; j++) uw[j] = w[3 + j];
          if (p === 2) {
            m.blending = a === 0 ? THREE.NoBlending : THREE.CustomBlending;
            m.blendSrc = THREE.OneFactor; m.blendDst = THREE.OneFactor; m.blendEquation = THREE.AddEquation;
          }
          this.draw(renderer, m, dsts[p]);
        }
      }
    }
    // 3. ghosts from the hot part of the next level (and the one after it for the shrunk ghosts)
    if (ghost && this.ghost) {
      const u = this.ghostMat.uniforms;
      u.tA.value = this.down[this.ghostLevel].texture;
      u.tB.value = this.down[Math.min(L - 1, this.ghostLevel + 1)].texture;
      u.uExposure.value = exposure;
      this.draw(renderer, this.ghostMat, this.ghost);
    }
    // 4. the weighted up chain: U_(L-2) = w_(L-1) tent(D_(L-1)) + w_(L-2) D_(L-2); U_i = tent(U_(i+1)) + w_i D_i;
    // U0 also takes the star and the ghosts
    const W = this.weights;
    const fu = this.finalMat.uniforms;
    fu.tStar.value = star && this.star ? this.star.s.texture : null;
    fu.tGhost.value = ghost && this.ghost ? this.ghost.texture : null;
    (fu.uFlareW.value as THREE.Vector2).set(star ? starW : 0, ghost ? ghostW : 0);
    for (let i = L - 2; i >= 0; i--) {
      const m = i === 0 ? this.finalMat : this.upMat;
      const um = m.uniforms;
      const low = i === L - 2 ? this.down[L - 1] : this.up[i + 1];
      const dst = this.up[i];
      um.tLow.value = low.texture;
      um.tCur.value = this.down[i].texture;
      (um.uTexel.value as THREE.Vector2).set(1 / dst.width, 1 / dst.height);
      if (i === L - 2) (um.uWLow.value as THREE.Vector3).set(W[3 * (L - 1)], W[3 * (L - 1) + 1], W[3 * (L - 1) + 2]);
      else (um.uWLow.value as THREE.Vector3).set(1, 1, 1);
      (um.uWCur.value as THREE.Vector3).set(W[3 * i], W[3 * i + 1], W[3 * i + 2]);
      this.draw(renderer, m, dst);
    }
    this.fullscreenMaterial = this.downMat;
    renderer.autoClear = autoClear;
  }

  /** Every material of the chain (quality-switch warm-up). */
  materials(): THREE.ShaderMaterial[] {
    return [this.preMat, this.downMat, this.upMat, this.finalMat, this.extractMat, ...this.starMats, this.ghostMat];
  }

  /** Compile every chain program now (boot), not on the frame a quality flag first needs it. */
  warm(renderer: THREE.WebGLRenderer): void {
    for (const m of this.materials()) {
      this.fullscreenMaterial = m;
      renderer.compile(this.scene, this.camera);
    }
    this.fullscreenMaterial = this.downMat;
  }

  override dispose(): void {
    for (const rt of this.down) rt.dispose();
    for (const rt of this.up) rt.dispose();
    this.setFlare(false, false);
    for (const m of this.materials()) m.dispose();
  }
}

let blackTex: THREE.DataTexture | null = null;
function black(): THREE.DataTexture {
  if (!blackTex) {
    blackTex = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
    blackTex.name = 'Glare.Black';
    blackTex.needsUpdate = true;
  }
  return blackTex;
}

export class GlareEffect extends Effect {
  readonly chain: GlareChain;
  /** false: the chain is skipped and k forced to 0 (URL bloom=0 / setPost({ bloom: false })) */
  active = true;
  private readonly uK: THREE.Uniform<number>;
  private readonly uGlare: THREE.Uniform<THREE.Texture | null>;
  private motion: MotionBlurState | null = null;
  // the composer's depth texture, boxed: Effect.dispose() disposes every own Texture property, and this one is the
  // composer's, not ours
  private readonly depthRef: { tex: THREE.Texture | null } = { tex: null };
  private k = 0;
  private starGain = 0;
  private ghostGain = 0;
  private exposure = 1;
  private wTan = -1;
  private wH = -1;
  private wL = -1;

  constructor(levels: number) {
    const uK = new THREE.Uniform(0);
    const uGlare = new THREE.Uniform<THREE.Texture | null>(black());
    super('GlareEffect', GLARE_FRAG, {
      attributes: EffectAttribute.NONE,
      blendFunction: BlendFunction.SRC,
      uniforms: new Map<string, THREE.Uniform>([['uGlareMap', uGlare], ['uGlareK', uK]]),
    });
    this.uK = uK;
    this.uGlare = uGlare;
    this.chain = new GlareChain(levels);
  }

  /** k = scatter fraction (0 = off, chain skipped); exposure (1/nits); tanHalf = tan(vfov / 2); heightPx = buffer. */
  setParams(k: number, exposure: number, tanHalf: number, heightPx: number): void {
    this.k = Math.max(0, Math.min(0.5, k));
    this.exposure = exposure > 0 ? exposure : 1;
    const L = this.chain.levelCount;
    const fovChanged = Math.abs(Math.atan(tanHalf) - Math.atan(this.wTan)) * (360 / Math.PI) > GLARE.FOV_EPS_DEG;
    if (fovChanged || heightPx !== this.wH || L !== this.wL) {
      this.wTan = tanHalf;
      this.wH = heightPx;
      this.wL = L;
      glareWeights(tanHalf, heightPx, L, this.chain.weights);
    }
  }

  /** Aperture star / ghost gains (0 = off: no passes, no composite). Targets must exist (setFlare). */
  setFlareGains(star: number, ghost: number): void {
    this.starGain = Math.max(0, star);
    this.ghostGain = Math.max(0, ghost);
  }

  setLevels(n: number): void {
    this.chain.setLevels(n);
    this.wL = -1;
  }

  setFlare(streaks: boolean, ghosts: boolean): void {
    this.chain.setFlare(streaks, ghosts);
  }

  /** The camera motion blur of the same pass (its update() runs first: CONVOLUTION effects sort first). */
  setMotionSource(state: MotionBlurState | null): void {
    this.motion = state;
  }

  override setDepthTexture(depthTexture: THREE.Texture, depthPacking?: THREE.DepthPackingStrategies): void {
    super.setDepthTexture(depthTexture, depthPacking);
    this.depthRef.tex = depthTexture;
  }

  override update(renderer: THREE.WebGLRenderer, inputBuffer: THREE.WebGLRenderTarget): void {
    const on = this.active && this.k > 0;
    const depth = this.depthRef.tex;
    const motion = this.motion && depth ? { state: this.motion, depth } : null;
    if (on) {
      this.chain.run(renderer, inputBuffer.texture, inputBuffer.width, inputBuffer.height, this.exposure,
        this.starGain / this.k, this.ghostGain / this.k, motion);
    }
    this.uGlare.value = on ? this.chain.output.texture : black();
    this.uK.value = on ? this.k : 0;
  }

  override initialize(renderer: THREE.WebGLRenderer, alpha: boolean, frameBufferType: number): void {
    super.initialize(renderer, alpha, frameBufferType);
    this.chain.warm(renderer);
  }

  override setSize(width: number, height: number): void {
    this.chain.setSize(width, height);
  }

  // (Effect.dispose disposes every own Pass / target / material property: the chain included)
}
