import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { QUALITY } from '../../src/core/quality.ts';
import type { PlayerState } from '../../src/core/player.ts';
import type { WorldQuery } from '../../src/core/runtime.ts';
import { createGlobals } from '../../src/materials/MaterialSystem.ts';
import { createReflectionProbe } from '../../src/materials/ReflectionProbe.ts';
import { PROBE, probeLevels } from '../../src/materials/chunks/probe.ts';

function setup() {
  const globals = createGlobals();
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();
  const world = {
    isLoaded: () => true, rayDistance: () => 5, floorAt: () => 0, ceilingAt: () => 3,
  } as unknown as WorldQuery;
  const player = { eyeX: 0, eyeY: 1.6, eyeZ: 0, y: 0, s: 0 } as PlayerState;
  const filtered: { face: number; mip: number; samples: THREE.Vector4[] }[] = [];
  let current: THREE.WebGLRenderTarget | null = null, face = 0, mip = 0;
  const renderer = {
    shadowMap: { autoUpdate: true }, xr: { enabled: false }, info: { render: { calls: 0 } },
    extensions: { has: () => true }, properties: { get: () => ({ __webglTexture: {} }) },
    getContext: () => ({ TEXTURE_CUBE_MAP: 1, generateMipmap() {} }),
    state: { bindTexture() {}, unbindTexture() {}, buffers: { depth: { setMask() {} } } },
    getRenderTarget: () => current, getActiveCubeFace: () => face, getActiveMipmapLevel: () => mip,
    setRenderTarget(t: THREE.WebGLRenderTarget | null, f = 0, k = 0) { current = t; face = f; mip = k; },
    clear() {},
    render(sc: THREE.Scene) {
      renderer.info.render.calls++;
      if (sc === scene) { expect(scene.matrixWorldAutoUpdate).toBe(false); return; }
      const material = (sc.children[0] as THREE.Mesh).material as THREE.ShaderMaterial;
      filtered.push({ face, mip, samples: material.uniforms.uSamples.value as THREE.Vector4[] });
    },
  } as unknown as THREE.WebGLRenderer;
  const probe = createReflectionProbe(globals, QUALITY.high, null, () => null);
  const update = () => probe.update(renderer, scene, camera, world, player, true);
  return { globals, filtered, probe, update };
}

describe('reflection probe capture', () => {
  it('publishes complete refreshes and updates every rough face when one capture face changes', () => {
    const t = setup();
    for (let i = 0; i < 6 / PROBE.BURST; i++) {
      t.update();
      if (i < 6 / PROBE.BURST - 1) {
        expect(t.filtered).toHaveLength(0);
        expect(t.globals.probeOn.value).toBe(0);
      }
    }
    const levels = probeLevels(QUALITY.high.reflectionProbe);
    expect(t.filtered).toHaveLength(6 * levels);
    expect(t.globals.probeOn.value).toBe(1);
    const kernels = Array.from({ length: levels }, (_, mip) => t.filtered.find((draw) => draw.mip === mip)!.samples);
    t.filtered.length = 0;
    for (let i = 0; i < PROBE.STEADY_EVERY; i++) t.update();
    // Sharp directions read only their own face. Rough lobes cross faces, so each must see the changed capture.
    expect(t.filtered.filter((draw) => draw.mip === 0).map((draw) => draw.face)).toEqual([0]);
    for (let mip = 1; mip < levels; mip++) {
      expect(t.filtered.filter((draw) => draw.mip === mip).map((draw) => draw.face)).toEqual([0, 1, 2, 3, 4, 5]);
    }
    for (const draw of t.filtered) expect(draw.samples).toBe(kernels[draw.mip]);

    t.probe.refresh();
    t.filtered.length = 0;
    for (let i = 0; i < 6 / PROBE.BURST; i++) {
      t.update();
      expect(t.globals.probeOn.value).toBe(1); // The last complete cube stays available while capture is incomplete.
      if (i < 6 / PROBE.BURST - 1) expect(t.filtered).toHaveLength(0);
    }
    expect(t.filtered).toHaveLength(6 * levels);
    expect(t.probe.info.settled).toBe(true);
    t.probe.dispose();
  });

  it('rebuilds cached GGX kernels when the probe resolution changes', () => {
    const t = setup();
    for (let i = 0; i < 6 / PROBE.BURST; i++) t.update();
    const oldKernel = t.filtered.find((draw) => draw.mip === 1)!.samples;
    const oldLod = oldKernel[0].w;
    t.filtered.length = 0;
    t.probe.setQuality(QUALITY.ultra);
    for (let i = 0; i < 6 / PROBE.BURST; i++) t.update();
    const newKernel = t.filtered.find((draw) => draw.mip === 1)!.samples;
    expect(newKernel).not.toBe(oldKernel);
    expect(newKernel[0].w).not.toBe(oldLod);
    expect(t.filtered).toHaveLength(6 * probeLevels(QUALITY.ultra.reflectionProbe));
    t.probe.dispose();
  });
});
