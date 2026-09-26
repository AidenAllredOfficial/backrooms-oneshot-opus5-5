// tests/materials/reflection.test.ts (WP9) — planar reflection maths: the mirrored camera sees, through any point X
// of the mirror plane, exactly the scene point whose mirror image the main camera sees through X; the reflection
// matrix maps main-camera VIEW-space positions to that texture coordinate (no float32 world position needed); the
// oblique near plane clips everything below the mirror; and the update() gates publish reflOn / reflY correctly.

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { QUALITY } from '../../src/core/quality.ts';
import { createGlobals } from '../../src/materials/MaterialSystem.ts';
import { createPlanarReflection, createReflScratch, reflectionTextureMatrix, setupReflectionCamera } from '../../src/materials/PlanarReflection.ts';

function mainCamera(x: number, y: number, z: number, yaw: number, pitch: number): THREE.PerspectiveCamera {
  const c = new THREE.PerspectiveCamera(70, 16 / 9, 0.05, 400);
  c.rotation.order = 'YXZ';
  c.position.set(x, y, z);
  c.rotation.set(pitch, yaw, 0);
  c.updateMatrixWorld();
  c.updateProjectionMatrix();
  return c;
}

/** Texture uv (0..1) of world point p seen by camera cam with projection proj. */
function projectUv(p: THREE.Vector3, cam: THREE.Camera, proj: THREE.Matrix4): THREE.Vector2 {
  const v = new THREE.Vector4(p.x, p.y, p.z, 1).applyMatrix4(cam.matrixWorldInverse).applyMatrix4(proj);
  return new THREE.Vector2((v.x / v.w) * 0.5 + 0.5, (v.y / v.w) * 0.5 + 0.5);
}

const CASES: [number, number, number, number, number, number][] = [
  // x, y, z, yaw, pitch, planeY
  [3, 1.62, 2, 0.4, -0.3, -0.1],
  [1920.5, 1.62, -1150.2, -2.1, -0.6, -0.1], // far from the origin (precision)
  [0, 3.0, 0, 1.2, -1.1, 0.0],
  [-40, 0.8, 12, 3.0, -0.05, 0.5],
];

describe('WP9 planar reflection maths', () => {
  it('reflMatrix * viewPos(X) equals the mirrored camera\'s image of the reflected point', () => {
    const scratch = createReflScratch();
    for (const [x, y, z, yaw, pitch, planeY] of CASES) {
      const cam = mainCamera(x, y, z, yaw, pitch);
      const refl = new THREE.PerspectiveCamera();
      setupReflectionCamera(cam, planeY, refl, scratch);
      const M = new THREE.Matrix4();
      reflectionTextureMatrix(cam, refl, cam.projectionMatrix, M);
      const eye = cam.position.clone();
      const fwd = new THREE.Vector3();
      cam.getWorldDirection(fwd);
      for (const [a, b, h] of [[0.5, 0.2, 1.1], [-1.5, 0.8, 0.3], [2.0, -0.7, 2.4]]) {
        // a scene point P above the plane, in front of the camera
        const P = eye.clone().addScaledVector(fwd, 6).add(new THREE.Vector3(a, 0, b));
        P.y = planeY + h;
        const Pm = P.clone(); Pm.y = 2 * planeY - P.y; // its mirror image
        // X: where the main camera's ray towards the mirror image crosses the plane
        const d = Pm.clone().sub(eye);
        const t = (planeY - eye.y) / d.y;
        const X = eye.clone().addScaledVector(d, t);
        const viewX = X.clone().applyMatrix4(cam.matrixWorldInverse);
        const r = new THREE.Vector4(viewX.x, viewX.y, viewX.z, 1).applyMatrix4(M);
        const uvLookup = new THREE.Vector2(r.x / r.w, r.y / r.w);
        const uvRender = projectUv(P, refl, cam.projectionMatrix);
        expect(uvLookup.x).toBeCloseTo(uvRender.x, 4);
        expect(uvLookup.y).toBeCloseTo(uvRender.y, 4);
      }
    }
  });

  it('the mirrored camera sits below the plane and looks at the mirrored view', () => {
    const scratch = createReflScratch();
    const cam = mainCamera(2, 1.62, 3, 0.3, -0.4);
    const refl = new THREE.PerspectiveCamera();
    setupReflectionCamera(cam, -0.1, refl, scratch);
    expect(refl.position.y).toBeCloseTo(2 * -0.1 - 1.62, 9);
    const df = new THREE.Vector3(), dr = new THREE.Vector3();
    cam.getWorldDirection(df);
    refl.getWorldDirection(dr);
    expect(dr.x).toBeCloseTo(df.x, 6);
    expect(dr.y).toBeCloseTo(-df.y, 6);
    expect(dr.z).toBeCloseTo(df.z, 6);
  });

  it('the oblique near plane clips geometry below the mirror and keeps geometry above it', () => {
    const scratch = createReflScratch();
    const cam = mainCamera(0, 1.62, 0, 0, -0.35);
    const refl = new THREE.PerspectiveCamera();
    const planeY = -0.1;
    setupReflectionCamera(cam, planeY, refl, scratch);
    const clipZ = (p: THREE.Vector3): { z: number; w: number } => {
      const v = new THREE.Vector4(p.x, p.y, p.z, 1).applyMatrix4(refl.matrixWorldInverse).applyMatrix4(refl.projectionMatrix);
      return { z: v.z, w: v.w };
    };
    for (const zf of [-2, -5, -12]) {
      const below = clipZ(new THREE.Vector3(0.3, planeY - 0.3, zf));
      expect(below.z).toBeLessThan(-below.w); // outside the (oblique) near plane
      const above = clipZ(new THREE.Vector3(0.3, planeY + 0.5, zf));
      expect(above.z).toBeGreaterThan(-above.w);
      expect(above.z).toBeLessThan(above.w);
    }
  });

  it('update() gates: disabled at scale 0, no plane, or camera below the plane', () => {
    const g = createGlobals();
    const off = createPlanarReflection(g, QUALITY.low);
    expect(off.enabled).toBe(false);
    const fakeRenderer = {} as unknown as THREE.WebGLRenderer;
    const scene = new THREE.Scene();
    g.reflOn.value = 1;
    off.update(fakeRenderer, scene, mainCamera(0, 1.6, 0, 0, 0), 0);
    expect(g.reflOn.value).toBe(0);

    const on = createPlanarReflection(g, QUALITY.high);
    expect(on.enabled).toBe(true);
    g.reflOn.value = 1;
    on.update(fakeRenderer, scene, mainCamera(0, 1.6, 0, 0, 0), null);
    expect(g.reflOn.value).toBe(0);
    g.reflOn.value = 1;
    on.update(fakeRenderer, scene, mainCamera(0, -0.5, 0, 0, 0), 0); // underwater camera
    expect(g.reflOn.value).toBe(0);
    on.setQuality(QUALITY.low);
    expect(on.enabled).toBe(false);
    expect(g.reflTex.value).toBeNull();
    on.dispose();
  });
});
