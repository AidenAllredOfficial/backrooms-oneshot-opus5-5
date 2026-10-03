import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { throughPortal } from '../../src/core/portalMath.ts';
import { setupPortalCamera } from '../../src/materials/PortalViews.ts';

describe('doorway camera', () => {
  it('uses the camera world pose under a translated and rotated parent', () => {
    const a = { x: 10, y: 0, z: 20, nx: 0, nz: -1 };
    const b = { x: 140, y: 0, z: 120, nx: 1, nz: 0 };
    const rig = new THREE.Group();
    const main = new THREE.PerspectiveCamera(62, 1.6, 0.05, 400);
    rig.add(main);
    main.position.set(0, 1.62, 0);
    rig.position.set(a.x, 0, a.z - 1);
    rig.rotation.y = Math.PI;
    const destination = new THREE.PerspectiveCamera();
    setupPortalCamera(main, a, b, destination);
    const transformedEye = throughPortal(a, b, a.x, 1.62, a.z - 1);
    expect(destination.position.toArray()).toEqual([transformedEye.x, transformedEye.y, transformedEye.z]);
    for (const x of [-0.35, 0, 0.35]) {
      const source = new THREE.Vector3(a.x + x, 1.2, a.z + 0.1);
      const p = throughPortal(a, b, source.x, source.y, source.z);
      const sourceScreen = source.project(main);
      const destinationScreen = new THREE.Vector3(p.x, p.y, p.z).project(destination);
      expect(destinationScreen.x).toBeCloseTo(sourceScreen.x, 6);
      expect(destinationScreen.y).toBeCloseTo(sourceScreen.y, 6);
    }
  });

  it('preserves screen coordinates and clips the backing room at close, oblique angles', () => {
    for (const distance of [0.004, 0.031, 0.15, 1.2]) for (const yaw of [0, 0.08, 0.9]) for (const pitch of [0, -0.9674, 0.8]) {
      const a = { x: 46.2, y: 0, z: 85.2, nx: 0, nz: -1 };
      const b = { x: 140, y: 0, z: 120, nx: 1, nz: 0 };
      const main = new THREE.PerspectiveCamera(62, 1.6, Math.min(0.05, distance * 0.2), 400);
      main.position.set(a.x, 1.62, a.z - distance);
      main.rotation.set(pitch, Math.PI + yaw, 0, 'YXZ');
      main.updateMatrixWorld();
      const destination = new THREE.PerspectiveCamera();
      setupPortalCamera(main, a, b, destination);
      expect(destination.projectionMatrix.elements.every(Number.isFinite)).toBe(true);
      for (const x of [-0.35, 0, 0.35]) {
        const p = new THREE.Vector3(a.x + x, 1.2, a.z + 0.1);
        const q = throughPortal(a, b, p.x, p.y, p.z);
        const sourceScreen = p.project(main), targetScreen = new THREE.Vector3(q.x, q.y, q.z).project(destination);
        expect(targetScreen.x).toBeCloseTo(sourceScreen.x, 6);
        expect(targetScreen.y).toBeCloseTo(sourceScreen.y, 6);
      }
      const clip = (distance: number) => new THREE.Vector4(b.x + b.nx * distance, 1.62, b.z + b.nz * distance, 1)
        .applyMatrix4(destination.matrixWorldInverse).applyMatrix4(destination.projectionMatrix);
      const room = clip(0.1), backing = clip(-0.02);
      expect(room.z + room.w).toBeGreaterThan(0);
      expect(backing.z + backing.w).toBeLessThan(0);
    }
  });
});
