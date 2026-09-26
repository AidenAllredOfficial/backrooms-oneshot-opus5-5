// src/post/effects/ColorGradeEffect.ts (WP11, R2-post) — display grade after AgX. Converts to sRGB-encoded space,
// applies temperature/tint (white balance), lift/gamma/gain, split-tone (fading to neutral near white, so emitters
// clip to pure white), saturation (reduced toward the shadows), a sensor-style highlight knee (channels bleach
// toward their max near clip), contrast (a luma S-curve that keeps black and white fixed and chroma ratios
// unchanged) and the sensor black pedestal (lifted blacks, never #000), then converts back to linear.

import * as THREE from 'three';
import { BlendFunction, Effect, EffectAttribute } from 'postprocessing';
import type { ColorGrade } from '../../core/runtime.ts';

export const GRADE_FRAG = /* glsl */ `
uniform float uGradeOn;
uniform vec3 uWB;
uniform vec3 uLift;
uniform vec3 uGamma;
uniform vec3 uGain;
uniform vec3 uShadowTint;
uniform vec3 uHighTint;
uniform vec3 uSatCon; // x saturation, y contrast, z pedestal (encoded black level)
vec3 brGradeEnc(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(max(c, vec3(0.0031308)), vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
vec3 brGradeDec(vec3 c) {
  return mix(c / 12.92, pow((max(c, vec3(0.04045)) + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}
void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  if (uGradeOn < 0.5) { outputColor = inputColor; return; }
  const vec3 W = vec3(0.2126, 0.7152, 0.0722);
  vec3 c = clamp(inputColor.rgb * uWB, 0.0, 1.0);
  vec3 e = brGradeEnc(c);
  e = uGain * (e + uLift * (1.0 - e));
  e = pow(max(e, vec3(0.0)), 1.0 / uGamma);
  float y = dot(e, W);
  // split-tone, fading to neutral near white: a clipped troffer stays pure white instead of tinted
  e *= mix(mix(uShadowTint, uHighTint, smoothstep(0.2, 0.8, y)), vec3(1.0), smoothstep(0.85, 1.0, y));
  y = dot(e, W);
  // shadows desaturate (cheap-camera / mesopic look): dim, warm-lit rooms read muddy rather than orange
  e = mix(vec3(y), e, uSatCon.x * mix(0.5, 1.0, smoothstep(0.06, 0.65, y)));
  // sensor knee: as the brightest channel nears clip the others follow (a consumer sensor clips to white, not
  // to a saturated yellow)
  float m = max(max(e.r, e.g), e.b);
  e = mix(e, vec3(m), smoothstep(0.8, 0.97, m));
  e = clamp(e, 0.0, 1.0);
  // contrast: the S-curve acts on luma and the colour is scaled by y'/y (chroma ratios kept). A per-channel curve
  // pushes the smallest channel of a dim warm colour down hardest, which over-saturates every dim Level 0 room.
  float k = uSatCon.y - 1.0;
  y = dot(e, W);
  float y2 = y + k * 4.0 * (y - 0.5) * y * (1.0 - y);
  e *= y2 / max(y, 1e-4);
  // sensor black pedestal (after the S-curve, so the curve cannot crush it back to 0)
  e = uSatCon.z + (1.0 - uSatCon.z) * clamp(e, 0.0, 1.0);
  outputColor = vec4(brGradeDec(clamp(e, 0.0, 1.0)), inputColor.a);
}
`;

/** White-balance multipliers (linear) for temperature/tint, normalised to unit Rec.709 luma. */
export function whiteBalance(temperature: number, tint: number, out: THREE.Vector3): THREE.Vector3 {
  const r = 1 + 0.22 * temperature + 0.06 * tint;
  const g = 1 - 0.1 * tint;
  const b = 1 - 0.22 * temperature + 0.06 * tint;
  const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return out.set(r / l, g / l, b / l);
}

export class ColorGradeEffect extends Effect {
  private readonly u: {
    on: THREE.Uniform<number>; wb: THREE.Uniform<THREE.Vector3>; lift: THREE.Uniform<THREE.Vector3>;
    gamma: THREE.Uniform<THREE.Vector3>; gain: THREE.Uniform<THREE.Vector3>; sh: THREE.Uniform<THREE.Vector3>;
    hi: THREE.Uniform<THREE.Vector3>; sc: THREE.Uniform<THREE.Vector3>;
  };
  constructor() {
    const u = {
      on: new THREE.Uniform(1), wb: new THREE.Uniform(new THREE.Vector3(1, 1, 1)),
      lift: new THREE.Uniform(new THREE.Vector3()), gamma: new THREE.Uniform(new THREE.Vector3(1, 1, 1)),
      gain: new THREE.Uniform(new THREE.Vector3(1, 1, 1)), sh: new THREE.Uniform(new THREE.Vector3(1, 1, 1)),
      hi: new THREE.Uniform(new THREE.Vector3(1, 1, 1)), sc: new THREE.Uniform(new THREE.Vector3(1, 1, 0)),
    };
    super('ColorGradeEffect', GRADE_FRAG, {
      attributes: EffectAttribute.NONE,
      blendFunction: BlendFunction.SRC,
      uniforms: new Map<string, THREE.Uniform>([
        ['uGradeOn', u.on], ['uWB', u.wb], ['uLift', u.lift], ['uGamma', u.gamma], ['uGain', u.gain],
        ['uShadowTint', u.sh], ['uHighTint', u.hi], ['uSatCon', u.sc],
      ]),
    });
    this.u = u;
  }
  set enabled(on: boolean) { this.u.on.value = on ? 1 : 0; }
  /** Current pedestal (encoded units), for the grain's soft floor. */
  get pedestal(): number { return this.u.on.value > 0.5 ? this.u.sc.value.z : 0; }
  get enabled(): boolean { return this.u.on.value > 0.5; }
  /** Allocation-free per-frame update from the blended atmosphere grade. */
  setGrade(g: ColorGrade): void {
    const u = this.u;
    whiteBalance(g.temperature, g.tint, u.wb.value);
    u.lift.value.set(g.lift[0], g.lift[1], g.lift[2]);
    u.gamma.value.set(Math.max(0.2, g.gamma[0]), Math.max(0.2, g.gamma[1]), Math.max(0.2, g.gamma[2]));
    u.gain.value.set(g.gain[0], g.gain[1], g.gain[2]);
    u.sh.value.set(g.shadowTint[0], g.shadowTint[1], g.shadowTint[2]);
    u.hi.value.set(g.highlightTint[0], g.highlightTint[1], g.highlightTint[2]);
    u.sc.value.set(g.saturation, g.contrast, Math.min(0.2, Math.max(0, g.pedestal ?? 0)));
  }
}
