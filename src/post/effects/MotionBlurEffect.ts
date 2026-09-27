// src/post/effects/MotionBlurEffect.ts (package C.4) — HDR camera motion blur with an exposure-coupled camcorder
// shutter; the first effect of the hdrPass (CONVOLUTION | DEPTH: pmndrs sorts it first and hands it the composer's
// stable depth texture, which the prepass already fills; depth is only read).
//
// Every frame of real video integrates the scene over the shutter: a quick look-around smears the image and the
// troffers / highbays streak into light trails with their full HDR energy (the blur runs on nits, before AgX), and a
// camcorder's AE lengthens the shutter from 1/60 s to 1/30 s in low light, so dark zones smear more.
//  - Per pixel: the previous-frame position from depth (uReproj = prevViewProj * inverse(viewProj)), velocity
//    v = (uv - prevUv) * shutter / frameDt, clamped to MOTION_BLUR.MAX_BLUR * H px, and n = q.motionBlurTaps taps along
//    a CENTRED shutter (uv + v * ((i + .5 + j) / n - .5)) whose start is IGN-dithered per pixel and frame.
//  - Camera-only (the world is static): foreground edges bleed slightly into the background, as usual.
//  - Cuts (no blur that frame, history reset): a jump > 1 m, a rotation > 30 deg, dt > .1 s, snapExposure()
//    (teleport / new seed / time=), pause. A static camera reprojects exactly to itself, so the effect is a
//    bit-exact pass-through (frozen-time captures stay byte-stable); taps 0 (low) likewise.
//  - Exposes the camera's angular velocity (local yaw / pitch rad/s) for LensEffect's rolling shutter and any
//    future temporal filter (reuse these matrices and cuts instead of adding a second history).

import * as THREE from 'three';
import { BlendFunction, Effect, EffectAttribute } from 'postprocessing';

export const MOTION_BLUR = {
  /** camcorder shutter (s): 1/60 in good light, 1/30 at max sensor gain (PostStack's low-light factor) */
  SHUTTER: [1 / 60, 1 / 30] as readonly [number, number],
  /** maximum blur length as a fraction of the buffer height */
  MAX_BLUR: 0.045,
  /** shader loop bound (QualityConfig.motionBlurTaps <= this) */
  MAX_TAPS: 12,
  CUT_DISTANCE: 1, // m
  CUT_ANGLE_DEG: 30,
  CUT_DT: 0.1, // s
  /** frame dt clamp for the shutter / frame-time ratio */
  DT_MIN: 1 / 240,
  DT_MAX: 1 / 10,
  /** CMOS rolling-shutter readout time (top row to bottom row), LensEffect uRS */
  READOUT: 0.75 / 60,
} as const;

export const MB_FRAG = /* glsl */ `
uniform mat4 uReproj;
uniform vec4 uMB; // x shutter / frame dt, y max blur (px), z taps, w on
uniform float uMBFrame;
float brMbIgn(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
void mainImage(const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor) {
  outputColor = inputColor;
  if (uMB.w < 0.5) return;
  vec4 prev = uReproj * vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
  if (prev.w <= 1e-6) return;
  vec2 v = (uv - (prev.xy / prev.w * 0.5 + 0.5)) * uMB.x;
  float lpx = length(v * resolution);
  if (lpx < 0.5) return;
  v *= min(1.0, uMB.y / lpx);
  float j = brMbIgn(gl_FragCoord.xy + uMBFrame * 5.588) - 0.5;
  float n = uMB.z;
  vec3 acc = vec3(0.0);
  for (int i = 0; i < ${MOTION_BLUR.MAX_TAPS}; i++) {
    if (float(i) >= n) break;
    acc += texture2D(inputBuffer, uv + v * ((float(i) + 0.5 + j) / n - 0.5)).rgb;
  }
  outputColor = vec4(acc / n, inputColor.a);
}
`;

/** Exposure time (s): 1/60 s, lengthening to 1/30 s as the camcorder runs out of light (low 0..1), x the setting. */
export function motionShutter(low: number, strength: number): number {
  const l = Math.min(1, Math.max(0, low));
  const [a, b] = MOTION_BLUR.SHUTTER;
  return (a + (b - a) * l) * Math.min(1, Math.max(0, strength));
}

/** A camera cut: history must not be blurred across it. */
export function isCameraCut(moved: number, turnedRad: number, dt: number, forced: boolean): boolean {
  return forced || !(dt <= MOTION_BLUR.CUT_DT) || !(moved <= MOTION_BLUR.CUT_DISTANCE) || !(turnedRad <= (MOTION_BLUR.CUT_ANGLE_DEG * Math.PI) / 180);
}

/** TS twin of MB_FRAG's reprojection: the previous-frame uv of the pixel (uv, device depth). */
export function reprojectUv(reproj: THREE.Matrix4, u: number, v: number, depth: number): [number, number] {
  const p = new THREE.Vector4(u * 2 - 1, v * 2 - 1, depth * 2 - 1, 1).applyMatrix4(reproj);
  return [(p.x / p.w) * 0.5 + 0.5, (p.y / p.w) * 0.5 + 0.5];
}

/** Rolling-shutter skew (uv shift per unit of (st.y - .5)) for camera-local angular rates (rad/s): yaw about +Y
 * (positive = turning left), pitch about +X (positive = looking up). Rows are read top to bottom over READOUT. */
export function rollingShutterUv(yawRate: number, pitchRate: number, tanHalf: number, aspect: number): [number, number] {
  const T = MOTION_BLUR.READOUT;
  return [(yawRate / (2 * tanHalf * aspect)) * T, (-pitchRate / (2 * tanHalf)) * T];
}

/** The live per-frame state (the effect's own uniform values): GlareEffect blurs its prefilter along the same path. */
export interface MotionBlurState { readonly reproj: THREE.Matrix4; readonly params: THREE.Vector4 }

const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();

export class MotionBlurEffect extends Effect {
  /** camera-local angular velocity (rad/s): yaw about +Y (+ = left), pitch about +X (+ = up); 0 on cuts */
  readonly angularVelocity = { yaw: 0, pitch: 0 };
  /** true when the last update() was a cut (or the first frame) */
  wasCut = true;
  /** this frame's reprojection and (shutter / dt, max px, taps, on), updated in update() */
  readonly state: MotionBlurState;
  private readonly cam: THREE.Camera;
  private readonly uReproj: THREE.Uniform<THREE.Matrix4>;
  private readonly uMB: THREE.Uniform<THREE.Vector4>;
  private readonly uFrame: THREE.Uniform<number>;
  private readonly prevVP = new THREE.Matrix4();
  private readonly curVP = new THREE.Matrix4();
  private readonly inv = new THREE.Matrix4();
  private readonly prevPos = new THREE.Vector3();
  private readonly curPos = new THREE.Vector3();
  private readonly prevQuat = new THREE.Quaternion();
  private readonly curQuat = new THREE.Quaternion();
  private hasPrev = false;
  private cutPending = true;
  private taps = 0;
  private shutter = 0;
  private maxPx = 0;
  private frame = 0;

  constructor(camera: THREE.Camera) {
    const uReproj = new THREE.Uniform(new THREE.Matrix4());
    const uMB = new THREE.Uniform(new THREE.Vector4(0, 0, 0, 0));
    const uFrame = new THREE.Uniform(0);
    super('MotionBlurEffect', MB_FRAG, {
      attributes: EffectAttribute.CONVOLUTION | EffectAttribute.DEPTH,
      blendFunction: BlendFunction.SRC,
      uniforms: new Map<string, THREE.Uniform>([['uReproj', uReproj], ['uMB', uMB], ['uMBFrame', uFrame]]),
    });
    this.cam = camera;
    this.uReproj = uReproj;
    this.uMB = uMB;
    this.uFrame = uFrame;
    this.state = { reproj: uReproj.value, params: uMB.value };
  }

  /** taps = QualityConfig.motionBlurTaps (0 = off); shutter (s, 0 = off); maxPx = max blur length (buffer px). */
  set(taps: number, shutter: number, maxPx: number): void {
    this.taps = Math.max(0, Math.min(MOTION_BLUR.MAX_TAPS, Math.floor(taps)));
    this.shutter = Math.max(0, shutter);
    this.maxPx = Math.max(0, maxPx);
  }

  /** The next frame is a cut (teleport, snapExposure, pause). */
  cut(): void {
    this.cutPending = true;
  }

  override update(_renderer: THREE.WebGLRenderer, _inputBuffer: THREE.WebGLRenderTarget, deltaTime?: number): void {
    const cam = this.cam;
    const dt = deltaTime ?? 0;
    this.curVP.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    cam.matrixWorld.decompose(this.curPos, this.curQuat, _s);
    const turned = this.hasPrev ? this.curQuat.angleTo(this.prevQuat) : 0;
    const cut = !this.hasPrev || isCameraCut(this.hasPrev ? this.curPos.distanceTo(this.prevPos) : 0, turned, dt, this.cutPending);
    const same = this.hasPrev && this.curVP.equals(this.prevVP);
    const on = !cut && !same && this.taps > 0 && this.shutter > 0;
    const dtc = Math.min(MOTION_BLUR.DT_MAX, Math.max(MOTION_BLUR.DT_MIN, dt));
    if (on) {
      this.inv.copy(this.curVP).invert();
      this.uReproj.value.multiplyMatrices(this.prevVP, this.inv);
    }
    this.uMB.value.set(this.shutter / dtc, this.maxPx, this.taps, on ? 1 : 0);
    this.uFrame.value = this.frame = (this.frame + 1) % 1024;
    // camera-local angular velocity from the rotation delta (prev^-1 * cur, in the previous camera's frame)
    if (cut || turned <= 0) {
      this.angularVelocity.yaw = 0;
      this.angularVelocity.pitch = 0;
    } else {
      _q.copy(this.prevQuat).invert().multiply(this.curQuat);
      if (_q.w < 0) { _q.x = -_q.x; _q.y = -_q.y; _q.z = -_q.z; _q.w = -_q.w; }
      const sinHalf = Math.sqrt(_q.x * _q.x + _q.y * _q.y + _q.z * _q.z);
      const ang = 2 * Math.atan2(sinHalf, _q.w);
      const k = sinHalf > 1e-9 ? ang / sinHalf / dtc : 0;
      this.angularVelocity.yaw = _q.y * k;
      this.angularVelocity.pitch = _q.x * k;
    }
    this.wasCut = cut;
    this.prevVP.copy(this.curVP);
    this.prevPos.copy(this.curPos);
    this.prevQuat.copy(this.curQuat);
    this.hasPrev = true;
    this.cutPending = false;
  }
}
