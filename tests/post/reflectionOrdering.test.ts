import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { QUALITY } from '../../src/core/quality.ts';
import { createGlobals } from '../../src/materials/MaterialSystem.ts';
import { createPlanarReflection } from '../../src/materials/PlanarReflection.ts';
import { LAYER_LATE } from '../../src/materials/shared.ts';
import { ScenePass } from '../../src/post/ScenePass.ts';

describe('main-view shadows and planar reflection frame ordering', () => {
  it('refreshes the shadow map once before the nested mirror prepass, then restores main-view materials and state', () => {
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(62, 2, 0.05, 400);
    camera.position.set(0, 1.6, 3);
    camera.layers.enable(LAYER_LATE);
    camera.updateMatrixWorld();
    const depthMaterial = new THREE.MeshBasicMaterial();
    const surfaceMaterial = new THREE.MeshBasicMaterial();
    surfaceMaterial.userData.brDepth = depthMaterial;
    const shell = new THREE.Mesh(new THREE.BoxGeometry(), surfaceMaterial);
    shell.position.set(0, 1, -4);
    scene.add(shell);
    const waterMaterial = new THREE.MeshBasicMaterial();
    waterMaterial.userData.brVariant = 'water';
    const water = new THREE.Mesh(new THREE.PlaneGeometry(), waterMaterial);
    water.layers.set(LAYER_LATE);
    scene.add(water);
    const light = new THREE.SpotLight();
    light.map = new THREE.Texture();
    light.castShadow = true;
    light.position.set(1.4, 1.4, 3);
    light.target.position.set(0, 1, -4);
    scene.add(light, light.target);
    // This is the preceding frame's shadow map. The fake render follows Three's relevant ordering: update the
    // map when shadow auto-update allows it, then update the cookie spotlight matrix even when it does not.
    const shadowMap = new THREE.WebGLRenderTarget(4, 4, { depthTexture: new THREE.DepthTexture(4, 4) });
    shadowMap.depthTexture!.userData.poseX = -0.8;
    light.shadow.map = shadowMap;
    const globals = createGlobals();
    const reflection = createPlanarReflection(globals, QUALITY.medium, () => true);
    const pass = new ScenePass(scene, camera);
    pass.setQuality(QUALITY.medium);
    pass.bindGlobals(globals);
    const input = new THREE.WebGLRenderTarget(64, 32, { depthTexture: new THREE.DepthTexture(64, 32, THREE.FloatType) });
    const output = new THREE.WebGLRenderTarget(64, 32);
    const draws: { view: string; material: THREE.Material | THREE.Material[]; pose: unknown; shadows: boolean; water: boolean }[] = [];
    let current: THREE.WebGLRenderTarget | null = null;
    let shadowUpdates = 0;
    const depth = {
      locked: false, mask: true,
      setMask(v: boolean) { if (!this.locked) this.mask = v; },
      setLocked(v: boolean) { this.locked = v; },
    };
    const renderer = {
      autoClear: true, autoClearColor: true, autoClearDepth: true, autoClearStencil: true,
      shadowMap: { autoUpdate: true }, xr: { enabled: false },
      state: { buffers: { depth, color: { setMask() {} } } },
      properties: { get: () => ({}) }, getContext: () => ({}), getClearAlpha: () => 1,
      getDrawingBufferSize: (size: THREE.Vector2) => size.set(64, 32),
      setRenderTarget(target: THREE.WebGLRenderTarget | null) { current = target; },
      getRenderTarget: () => current, getActiveCubeFace: () => 0, getActiveMipmapLevel: () => 0,
      clear() {},
      render(renderScene: THREE.Scene, renderCamera: THREE.Camera) {
        if (renderScene !== scene) return;
        if (this.shadowMap.autoUpdate && light.shadow.autoUpdate) {
          shadowUpdates++;
          shadowMap.depthTexture!.userData.poseX = light.matrixWorld.elements[12];
        }
        light.shadow.updateMatrices(light);
        draws.push({ view: renderCamera === camera ? 'main' : 'mirror', material: shell.material,
          pose: shadowMap.depthTexture!.userData.poseX, shadows: this.shadowMap.autoUpdate, water: water.visible });
      },
    };
    pass.addHook('afterDepth', { name: 'planar', order: 5, run: () => {
      expect(shell.material).toBe(surfaceMaterial);
      expect(water.visible).toBe(true);
      reflection.update(renderer as unknown as THREE.WebGLRenderer, scene, camera, 0);
    } });
    const run = (): void => pass.render(renderer as unknown as THREE.WebGLRenderer, input, output);
    run();
    expect(draws.map((d) => [d.view, d.material === depthMaterial ? 'depth' : 'shade'])).toEqual([
      ['main', 'depth'], ['mirror', 'depth'], ['mirror', 'shade'], ['main', 'shade'],
    ]);
    expect(draws.map((d) => d.pose)).toEqual([1.4, 1.4, 1.4, 1.4]);
    expect(draws.map((d) => d.shadows)).toEqual([true, false, false, false]);
    expect(draws.map((d) => d.water)).toEqual([false, false, false, true]);
    expect(shadowUpdates).toBe(1);
    expect(shell.material).toBe(surfaceMaterial);
    expect(scene.matrixWorldAutoUpdate).toBe(true);
    expect(renderer.shadowMap.autoUpdate).toBe(true);
    expect(depth).toMatchObject({ locked: false, mask: true });
    expect(water.visible).toBe(true);
    expect(globals.reflOn.value).toBe(1);
    draws.length = 0;
    light.position.x = -2;
    run();
    expect(draws.map((d) => d.pose)).toEqual([-2, -2, -2, -2]);
    expect(shadowUpdates).toBe(2);
    reflection.dispose();
    pass.dispose();
    input.dispose(); output.dispose(); shadowMap.dispose();
    shell.geometry.dispose(); water.geometry.dispose();
    depthMaterial.dispose(); surfaceMaterial.dispose(); waterMaterial.dispose(); light.map.dispose();
  });
});
