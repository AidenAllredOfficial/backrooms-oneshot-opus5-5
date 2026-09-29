// tests/post/motionBlur.test.ts (package C.4 / C.6) — camera motion blur maths, cut detection and the effect's state.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  isCameraCut, MOTION_BLUR, MotionBlurEffect, motionShutter, reprojectUv, rollingShutterUv,
} from '../../src/post/effects/MotionBlurEffect.ts';
import { QUALITY } from '../../src/core/quality.ts';
import { LensEffect } from '../../src/post/effects/LensEffect.ts';

const mkCam = (): THREE.PerspectiveCamera => {
  const c = new THREE.PerspectiveCamera(62, 16 / 9, 0.05, 400);
  c.rotation.order = 'YXZ';
  c.position.set(3, 1.6, -2);
  c.updateMatrixWorld();
  return c;
};
const viewProj = (c: THREE.PerspectiveCamera): THREE.Matrix4 => {
  c.updateMatrixWorld();
  return new THREE.Matrix4().multiplyMatrices(c.projectionMatrix, c.matrixWorldInverse);
};
/** The GPU's uReproj for a camera change a -> b (b = current). */
const reprojFor = (a: THREE.Matrix4, b: THREE.Matrix4): THREE.Matrix4 => new THREE.Matrix4().multiplyMatrices(a, b.clone().invert());
/** Private uniform state of an effect (x shutter/dt, y max px, z taps, w on). */
const mbState = (fx: MotionBlurEffect): THREE.Vector4 => (fx.uniforms.get('uMB') as THREE.Uniform<THREE.Vector4>).value;

describe('motion blur maths', () => {
  it('a static camera reprojects every pixel onto itself', () => {
    const c = mkCam();
    const vp = viewProj(c);
    const r = reprojFor(vp, vp);
    for (const [u, v, d] of [[0.5, 0.5, 0.9], [0.1, 0.8, 0.999], [0.93, 0.07, 0.3]]) {
      const [pu, pv] = reprojectUv(r, u, v, d);
      expect(pu).toBeCloseTo(u, 9);
      expect(pv).toBeCloseTo(v, 9);
    }
  });

  it('a pure yaw shifts the image horizontally by angle / (2 tan(fov/2) aspect) near the centre', () => {
    const c = mkCam();
    const prev = viewProj(c);
    const dYaw = 0.02; // rad, turning left
    c.rotation.y += dYaw;
    const cur = viewProj(c);
    const r = reprojFor(prev, cur);
    // a far point at the centre of the current frame was left of centre in the previous frame (the image content
    // moves right while the camera turns left)
    const [pu, pv] = reprojectUv(r, 0.5, 0.5, 0.9999);
    const tanHalf = Math.tan((62 * Math.PI) / 360);
    const expected = -Math.tan(dYaw) / (2 * tanHalf * c.aspect);
    expect(pu - 0.5).toBeCloseTo(expected, 5);
    expect(pv).toBeCloseTo(0.5, 6);
  });

  it('the shutter is 1/60 s in good light, 1/30 s at max gain, scaled by the setting', () => {
    expect(motionShutter(0, 1)).toBeCloseTo(1 / 60, 12);
    expect(motionShutter(1, 1)).toBeCloseTo(1 / 30, 12);
    expect(motionShutter(0.5, 1)).toBeCloseTo((1 / 60 + 1 / 30) / 2, 12);
    expect(motionShutter(1, 0)).toBe(0);
    expect(motionShutter(2, 5)).toBeCloseTo(1 / 30, 12); // clamped
  });

  it('cuts: a 1 m jump, a 30 deg turn, a 0.1 s hitch or a forced cut', () => {
    expect(isCameraCut(0.05, 0.02, 1 / 60, false)).toBe(false);
    expect(isCameraCut(1.2, 0, 1 / 60, false)).toBe(true);
    expect(isCameraCut(0, (31 * Math.PI) / 180, 1 / 60, false)).toBe(true);
    expect(isCameraCut(0, 0, 0.15, false)).toBe(true);
    expect(isCameraCut(0, 0, 1 / 60, true)).toBe(true);
    expect(isCameraCut(NaN, 0, 1 / 60, false)).toBe(true);
    for (const dt of [0, -1 / 60, NaN, Infinity]) expect(isCameraCut(0, 0, dt, false)).toBe(true);
  });

  it('rolling shutter: a left turn shifts upper rows left of lower rows (the top was read first)', () => {
    const tanHalf = Math.tan((62 * Math.PI) / 360);
    const [x, y] = rollingShutterUv(2, 0, tanHalf, 16 / 9);
    expect(x).toBeCloseTo((2 / (2 * tanHalf * (16 / 9))) * MOTION_BLUR.READOUT, 12);
    expect(y).toBe(-0);
    // st.x += uRS.x * (st.y - .5): the image content moves right during a left turn, so the top row (read first,
    // st.y = 1) shows it further left, i.e. samples further right (uRS.x > 0)
    expect(x).toBeGreaterThan(0);
    const [, py] = rollingShutterUv(0, 1, tanHalf, 16 / 9);
    expect(py).toBeLessThan(0);
  });
});

describe('MotionBlurEffect state', () => {
  it('a zero-time camera change is a cut, with no shutter blur or rolling-shutter velocity', () => {
    const c = mkCam();
    const fx = new MotionBlurEffect(c);
    fx.set(8, 1 / 60, 48);
    const up = (dt: number): void => fx.update(null as unknown as THREE.WebGLRenderer, null as unknown as THREE.WebGLRenderTarget, dt);
    up(1 / 60);
    c.rotation.y += 0.03;
    c.updateMatrixWorld();
    up(0);
    expect(fx.wasCut).toBe(true);
    expect(mbState(fx).w).toBe(0);
    expect(fx.angularVelocity.yaw).toBe(0);
    up(NaN);
    expect(mbState(fx).toArray().every(Number.isFinite)).toBe(true);
    fx.dispose();
  });

  it('rolling shutter follows the current turn and stops on the first stationary frame', () => {
    const c = mkCam();
    const motion = new MotionBlurEffect(c);
    const lens = new LensEffect();
    lens.setMotionSource(motion, c);
    lens.setCamcorder(true, 0, 0);
    const rs = (): THREE.Vector2 => (lens.uniforms.get('uRS') as THREE.Uniform<THREE.Vector2>).value;
    const frame = (): void => {
      motion.update(null as unknown as THREE.WebGLRenderer, null as unknown as THREE.WebGLRenderTarget, 1 / 60);
      lens.update(null as unknown as THREE.WebGLRenderer, null as unknown as THREE.WebGLRenderTarget);
    };
    frame();
    expect(rs().length()).toBe(0);
    c.rotation.y += 0.01;
    c.updateMatrixWorld();
    frame();
    const expected = rollingShutterUv(0.01 * 60, 0, Math.tan(c.fov * Math.PI / 360), c.aspect);
    expect(rs().x).toBeCloseTo(expected[0], 9);
    frame();
    expect(rs().length()).toBe(0);
    c.rotation.y += 0.01;
    c.updateMatrixWorld();
    lens.setRollingShutterEnabled(false);
    frame();
    expect(rs().length()).toBe(0);
    lens.setRollingShutterEnabled(true);
    motion.cut();
    frame();
    expect(rs().length()).toBe(0);
    c.rotation.y += 0.01;
    c.updateMatrixWorld();
    lens.setCamcorder(false, 0, 0);
    frame();
    expect(rs().length()).toBe(0);
    motion.dispose();
    lens.dispose();
  });

  it('is off on the first frame, for a static camera (byte-stable captures) and with taps 0', () => {
    const c = mkCam();
    const fx = new MotionBlurEffect(c);
    fx.set(8, 1 / 60, 48);
    const up = (dt: number): void => fx.update(null as unknown as THREE.WebGLRenderer, null as unknown as THREE.WebGLRenderTarget, dt);
    up(1 / 60);
    expect(mbState(fx).w).toBe(0); // first frame = cut
    up(1 / 60);
    expect(mbState(fx).w).toBe(0); // no motion
    c.rotation.y += 0.05;
    c.updateMatrixWorld();
    up(1 / 60);
    expect(mbState(fx).w).toBe(1);
    expect(mbState(fx).x).toBeCloseTo(1, 9); // shutter / dt
    expect(mbState(fx).z).toBe(8);
    expect(fx.angularVelocity.yaw).toBeCloseTo(0.05 * 60, 6);
    expect(fx.angularVelocity.pitch).toBeCloseTo(0, 9);
    fx.set(0, 1 / 60, 48);
    c.rotation.y += 0.05;
    c.updateMatrixWorld();
    up(1 / 60);
    expect(mbState(fx).w).toBe(0);
  });

  it('a cut() (teleport / snapExposure / pause) or a big jump resets the history for one frame', () => {
    const c = mkCam();
    const fx = new MotionBlurEffect(c);
    fx.set(10, 1 / 30, 48);
    const up = (dt: number): void => fx.update(null as unknown as THREE.WebGLRenderer, null as unknown as THREE.WebGLRenderTarget, dt);
    up(1 / 60);
    c.rotation.y += 0.03; c.updateMatrixWorld();
    up(1 / 60);
    expect(mbState(fx).w).toBe(1);
    fx.cut();
    c.rotation.y += 0.03; c.updateMatrixWorld();
    up(1 / 60);
    expect(mbState(fx).w).toBe(0);
    expect(fx.wasCut).toBe(true);
    expect(fx.angularVelocity.yaw).toBe(0);
    c.rotation.y += 0.03; c.updateMatrixWorld();
    up(1 / 60);
    expect(mbState(fx).w).toBe(1);
    c.position.x += 5; c.updateMatrixWorld();
    up(1 / 60);
    expect(mbState(fx).w).toBe(0);
    // dt is clamped for the shutter ratio: a 240 Hz frame blurs 4x its own displacement at 1/60 s
    fx.set(10, 1 / 60, 48);
    c.rotation.y += 0.01; c.updateMatrixWorld();
    up(1 / 1000);
    expect(mbState(fx).x).toBeCloseTo((1 / 60) * 240, 9);
  });

  it('quality taps: low 0 (off), medium 6, high 8, ultra 10, within the shader loop bound', () => {
    expect([QUALITY.low, QUALITY.medium, QUALITY.high, QUALITY.ultra].map((q) => q.motionBlurTaps)).toEqual([0, 6, 8, 10]);
    for (const q of Object.values(QUALITY)) expect(q.motionBlurTaps).toBeLessThanOrEqual(MOTION_BLUR.MAX_TAPS);
  });
});
