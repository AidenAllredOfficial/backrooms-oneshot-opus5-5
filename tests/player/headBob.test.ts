import { describe, expect, it } from 'vitest';
import { PLAYER } from '../../src/core/constants.ts';
import { createPlayerState } from '../../src/core/player.ts';
import { createCameraRig, handheldAmp, RIG } from '../../src/player/cameraRig.ts';
import { BOB, createBobState, kickLanding, updateBob } from '../../src/player/headBob.ts';

const DEG = Math.PI / 180;

function walking(speed: number, crouch = 0) {
  const s = createPlayerState(0, 0, 0, 0, 0, 0);
  s.speed = speed; s.crouch = crouch; s.onGround = true; s.vz = -speed;
  return s;
}

describe('head bob', () => {
  it('vertical bob is zero-mean over a stride and lowest at the footstep (integer phase)', () => {
    const s = walking(PLAYER.walk);
    const b = createBobState(PLAYER.eye);
    for (let i = 0; i < 240; i++) updateBob(b, s, 1 / 120, 1); // ease the amplitude in
    expect(b.amp).toBeCloseTo(BOB.walk.av, 4);
    let sum = 0, min = Infinity, minAt = -1;
    const N = 400;
    for (let i = 0; i < N; i++) {
      s.stridePhase = 10 + i / N;
      const o = updateBob(b, s, 0, 1);
      sum += o.dy;
      if (o.dy < min) { min = o.dy; minAt = i / N; }
    }
    expect(Math.abs(sum / N)).toBeLessThan(2e-4);
    expect(minAt === 0 || minAt > 0.995).toBe(true);
    expect(min).toBeCloseTo(-0.637 * BOB.walk.av, 4);
  });

  it('lateral sway alternates per step and the roll follows it', () => {
    const s = walking(PLAYER.walk);
    const b = createBobState(PLAYER.eye);
    for (let i = 0; i < 240; i++) updateBob(b, s, 1 / 120, 1);
    b.roll = 0;
    s.stridePhase = 20.5; const a = { ...updateBob(b, s, 0, 1) };
    s.stridePhase = 21.5; const c = { ...updateBob(b, s, 0, 1) };
    expect(a.dx).toBeCloseTo(BOB.walk.al, 4);
    expect(c.dx).toBeCloseTo(-BOB.walk.al, 4);
    expect(Math.sign(a.roll)).toBe(Math.sign(a.dx));
    expect(Math.abs(a.roll)).toBeLessThanOrEqual(BOB.walk.r + 1e-9);
  });

  it('sprint and crouch amplitudes; headBob = 0 disables the bob', () => {
    const b = createBobState(PLAYER.eye);
    const s = walking(PLAYER.sprint);
    for (let i = 0; i < 240; i++) updateBob(b, s, 1 / 120, 1);
    expect(b.amp).toBeCloseTo(BOB.sprint.av, 4);
    const c = walking(PLAYER.crouch, 1);
    const bc = createBobState(PLAYER.crouchEye);
    for (let i = 0; i < 240; i++) updateBob(bc, c, 1 / 120, 1);
    expect(bc.amp).toBeLessThanOrEqual(BOB.crouch.av + 1e-6);
    c.stridePhase = 3.5;
    expect(Math.abs(updateBob(bc, c, 0, 1).dx)).toBeLessThan(1e-9); // no lateral sway crouched
    s.stridePhase = 7.25;
    const off = updateBob(b, s, 0, 0);
    expect(Math.abs(off.dx) + Math.abs(off.roll) + Math.abs(off.pitch)).toBe(0);
  });

  it('amplitude eases with tau 0.15 s', () => {
    const s = walking(PLAYER.walk);
    const b = createBobState(PLAYER.eye);
    updateBob(b, s, 0.15, 1);
    expect(b.amp / BOB.walk.av).toBeCloseTo(1 - Math.exp(-1), 3);
  });

  it('landing dip = min(0.12, 0.03 v) at its lowest point', () => {
    for (const v of [2, 3.5, 6]) {
      const s = createPlayerState(0, 0, 0, 0, 0, 0);
      const b = createBobState(PLAYER.eye);
      kickLanding(b, v);
      let min = 0;
      for (let i = 0; i < 240; i++) { updateBob(b, s, 1 / 240, 1); min = Math.min(min, b.landing); }
      expect(-min).toBeCloseTo(Math.min(0.12, 0.03 * v), 2);
    }
  });

  it('stairs: the eye follows a critically damped spring (no overshoot)', () => {
    const s = createPlayerState(0, 0, 0, 0, 0, 0);
    const b = createBobState(PLAYER.eye);
    s.y = 0.3; // step up
    let prev = -Infinity, over = false;
    for (let i = 0; i < 120; i++) {
      const o = updateBob(b, s, 1 / 120, 0);
      const eye = s.y + PLAYER.eye + o.dy;
      if (eye > 0.3 + PLAYER.eye + 1e-6) over = true;
      expect(eye).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = eye;
    }
    expect(over).toBe(false);
    expect(prev).toBeCloseTo(0.3 + PLAYER.eye, 3);
  });

  it('idle breathing: 4 mm at 0.23 Hz plus 0.12 deg pitch', () => {
    const s = createPlayerState(0, 0, 0, 0, 0, 0);
    s.speed = 0;
    const b = createBobState(PLAYER.eye);
    let maxY = 0, maxP = 0;
    for (let i = 0; i < 120 * 10; i++) {
      const o = updateBob(b, s, 1 / 120, 1);
      maxY = Math.max(maxY, Math.abs(o.dy)); maxP = Math.max(maxP, Math.abs(o.pitch));
    }
    expect(maxY).toBeCloseTo(0.004, 3);
    expect(maxP).toBeCloseTo(0.12 * DEG, 4);
  });

  it('strafe lean and yaw-rate roll stay within 0.6 + 0.5 degrees', () => {
    const s = walking(PLAYER.walk);
    s.vx = PLAYER.walk; s.vz = 0; // strafing right at yaw 0
    const b = createBobState(PLAYER.eye);
    let maxRoll = 0;
    for (let i = 0; i < 240; i++) {
      s.yaw += 4 / 120; // fast turn
      const o = updateBob(b, s, 1 / 120, 1);
      maxRoll = Math.max(maxRoll, Math.abs(o.roll));
    }
    expect(maxRoll).toBeLessThanOrEqual((0.6 + 0.5 + 0.4) * DEG + 1e-6);
    expect(maxRoll).toBeGreaterThan(0.3 * DEG);
  });

  it('camera rig: sprint FOV kick eases to +3 deg with tau 0.4 s', () => {
    const s = walking(PLAYER.sprint);
    const rig = createCameraRig(s);
    rig.update(s, s, 0.4, 0, { headBob: 1, camcorder: false, shake: 0, frozen: false });
    expect(rig.fovKick).toBeCloseTo(3 * (1 - Math.exp(-1)), 3);
    for (let i = 0; i < 100; i++) rig.update(s, s, 0.05, 0, { headBob: 1, camcorder: false, shake: 0, frozen: false });
    expect(rig.fovKick).toBeCloseTo(3, 3);
  });

  it('camera rig: camcorder noise is bounded (~0.2-0.3 deg) and frozen time gives a fixed pose', () => {
    const s = createPlayerState(0, 0, 0, 0, 0, 0);
    const rig = createCameraRig(s);
    let max = 0;
    for (let i = 0; i < 600; i++) {
      rig.update(s, s, 1 / 60, i / 60, { headBob: 1, camcorder: true, shake: 0, frozen: false });
      max = Math.max(max, Math.abs(s.camYaw), Math.abs(s.camPitch - 0));
    }
    expect(max).toBeGreaterThan(0.08 * DEG);
    expect(max).toBeLessThan(0.35 * DEG);
    rig.update(s, s, 1 / 60, 10, { headBob: 1, camcorder: true, shake: 0, frozen: true });
    const a = [s.camYaw, s.camPitch, s.camRoll, s.eyeY];
    rig.update(s, s, 1 / 60, 10, { headBob: 1, camcorder: true, shake: 0, frozen: true });
    expect([s.camYaw, s.camPitch, s.camRoll]).toEqual(a.slice(0, 3));
  });

  it('camera rig: handheld sway ~0.15 deg at the default cameraShake, none at 0, none under frozen time', () => {
    const run = (o: { cameraShake: number; frozen: boolean; camcorder?: boolean }): number => {
      const s = createPlayerState(0, 0, 0, 0, 0, 0);
      const rig = createCameraRig(s);
      let max = 0;
      for (let i = 0; i < 1800; i++) {
        rig.update(s, s, 1 / 60, i / 60, { headBob: 0, camcorder: o.camcorder ?? false, cameraShake: o.cameraShake, shake: 0, frozen: o.frozen });
        max = Math.max(max, Math.abs(s.camYaw), Math.abs(s.camPitch), Math.abs(s.camRoll));
      }
      return max;
    };
    const def = run({ cameraShake: 0.5, frozen: false });
    expect(def).toBeGreaterThan(0.05 * DEG);
    expect(def).toBeLessThan(0.2 * DEG);
    expect(run({ cameraShake: 0, frozen: false })).toBe(0);
    expect(run({ cameraShake: 0, frozen: false, camcorder: true })).toBe(0); // comfort beats the camcorder look
    expect(run({ cameraShake: 1, frozen: true, camcorder: true })).toBe(0); // automation determinism
    expect(handheldAmp(0.5, false, 0, 0)).toBeCloseTo(0.15 * DEG, 8);
    expect(handheldAmp(0.5, true, 0, 0)).toBeCloseTo(RIG.camAmp, 8); // the old camcorder amplitude
    expect(handheldAmp(0.5, false, 1, 0)).toBeCloseTo(0.15 * DEG * RIG.camSprint, 8);
  });
});
