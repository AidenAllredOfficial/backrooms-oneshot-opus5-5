// tests/lighting/dustMotes.test.ts (package F) — dust motes: the toroidal box stays centred on the camera at any
// distance from the origin, the visible fraction follows moteDensity, the drift is bounded, and the Points object is
// a late-layer, additive, prepass-free scene child created only on presets with volumetrics.

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { EventBus } from '../../src/core/events.ts';
import type { GameBus } from '../../src/core/events.ts';
import { QUALITY } from '../../src/core/quality.ts';
import { DEFAULT_SETTINGS } from '../../src/core/settings.ts';
import type { TextureSet } from '../../src/core/runtime.ts';
import { DustMotes, motePosition, MOTES, moteSeeds } from '../../src/lighting/dustMotes.ts';
import { LightAtlas } from '../../src/lighting/LightAtlas.ts';
import { createLightingRuntime, lightingFrameHooks } from '../../src/lighting/LightingRuntime.ts';
import { VolumetricFog } from '../../src/post/VolumetricFog.ts';
import { createGlobals } from '../../src/materials/MaterialSystem.ts';
import { LAYER_LATE } from '../../src/materials/shared.ts';

describe('dust motes', () => {
  it('every mote stays within L / 2 of the camera, for cameras up to 1e6 m from the origin', () => {
    const seeds = moteSeeds(500);
    const out = new Float64Array(3);
    const L = MOTES.L;
    const m = (v: number): number => v - L * Math.floor(v / L);
    for (const cam of [[0, 1.6, 0], [1e6 + 0.3, 2.1, -1e6 + 0.7], [-523.3, -3, 77.7]]) {
      const drift = [m(0.028 * 1e4), m(-0.01 * 1e4), m(-0.029 * 1e4)];
      const cm = cam.map(m);
      for (let i = 0; i < 500; i++) {
        motePosition(seeds[i * 4], seeds[i * 4 + 1], seeds[i * 4 + 2], drift, cm, out);
        for (let k = 0; k < 3; k++) {
          expect(out[k]).toBeGreaterThanOrEqual(-L / 2);
          expect(out[k]).toBeLessThan(L / 2);
        }
      }
    }
    // the specks stay put in the world while the camera moves (less than half a box)
    const a = new Float64Array(3), b = new Float64Array(3);
    motePosition(0.5, 0.5, 0.5, [0, 0, 0], [m(10), m(1), m(10)], a);
    motePosition(0.5, 0.5, 0.5, [0, 0, 0], [m(10.8), m(1), m(10)], b);
    expect(a[0] - b[0]).toBeCloseTo(0.8, 9);
  });

  it('the visible fraction follows moteDensity; the seeds are deterministic', () => {
    const s = moteSeeds(6000);
    expect(moteSeeds(6000)).toEqual(s);
    for (const d of [0.1, 0.3, 0.7, 1]) {
      let n = 0;
      for (let i = 0; i < 6000; i++) if (s[i * 4 + 3] < d) n++;
      expect(n / 6000).toBeCloseTo(d, 1);
    }
  });

  it('the wobble is bounded and the sprite conserves energy (support SIZE_MIN..SIZE_MAX px)', () => {
    expect(MOTES.WOB_A.reduce((a, b) => a + b, 0)).toBeLessThan(0.25);
    expect(MOTES.SIZE_MIN).toBeGreaterThanOrEqual(1);
    expect(MOTES.SIZE_MAX).toBeGreaterThan(MOTES.SIZE_MIN);
    const d = new DustMotes(100, new LightAtlas().uniforms, new VolumetricFog(new LightAtlas(), new THREE.SpotLight(), 'high').torch);
    d.update(1e5, 0.5);
    const drift = d.material.uniforms.uMoteDrift.value as THREE.Vector3;
    for (const v of [drift.x, drift.y, drift.z]) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThan(MOTES.L); }
    expect(d.material.vertexShader).toMatch(/0\.25 \* size \* size/);
    d.dispose();
  });

  it('rejects clipped point centres before sampling the room or torch, leaving visible particle positions exact', () => {
    const a = new LightAtlas(), fog = new VolumetricFog(a, new THREE.SpotLight(), 'high');
    const d = new DustMotes(6000, a.uniforms, fog.torch);
    const body = d.material.vertexShader.slice(d.material.vertexShader.indexOf('void main()'));
    expect(body.indexOf('greaterThan( abs( clip.xyz ), vec3( clip.w ) )')).toBeLessThan(body.indexOf('brLaSample( rel'));
    expect(body.indexOf('greaterThan( abs( clip.xyz ), vec3( clip.w ) )')).toBeLessThan(body.indexOf('textureLod( uFlShadow'));
    expect(body).toContain('gl_Position = clip;');
    const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.05, 100);
    const seeds = moteSeeds(6000), clip = new THREE.Vector4();
    let rejected = 0;
    for (let i = 0; i < 6000; i++) {
      clip.set((seeds[i * 4] - 0.5) * MOTES.L, (seeds[i * 4 + 1] - 0.5) * MOTES.L, (seeds[i * 4 + 2] - 0.5) * MOTES.L, 1).applyMatrix4(camera.projectionMatrix);
      const culled = Math.abs(clip.x) > clip.w || Math.abs(clip.y) > clip.w || Math.abs(clip.z) > clip.w;
      if (culled) rejected++;
      else expect(Math.abs(clip.z / clip.w)).toBeLessThanOrEqual(1);
    }
    expect(rejected / 6000).toBeGreaterThan(0.75);
    d.dispose(); fog.dispose(); a.dispose();
  });

  it('a late-layer additive Points without a depth material, added by the runtime on presets with volumetrics', () => {
    const scene = new THREE.Scene();
    const bus: GameBus = new EventBus();
    const textures = { cookie: new THREE.Texture() } as unknown as TextureSet;
    const rt = createLightingRuntime(scene, createGlobals(), textures, QUALITY.ultra, DEFAULT_SETTINGS, bus);
    const pts = scene.children.find((o) => o.name === 'dustMotes') as THREE.Points;
    expect(pts).toBeTruthy();
    expect((pts.geometry.getAttribute('aSeed') as THREE.BufferAttribute).count).toBe(QUALITY.ultra.dustMotes);
    expect(pts.layers.mask).toBe(1 << LAYER_LATE);
    const m = pts.material as THREE.ShaderMaterial;
    expect(m.userData.brDepth).toBeUndefined();
    expect(m.blending).toBe(THREE.CustomBlending);
    expect([m.blendSrc, m.blendDst]).toEqual([THREE.OneFactor, THREE.OneFactor]);
    expect(m.depthWrite).toBe(false);
    expect(pts.frustumCulled).toBe(false);
    expect(lightingFrameHooks(rt).map((h) => [h.name, h.order])).toEqual([['lightAtlas', 30], ['volumetrics', 40]]);
    // high: fewer motes; medium: none (and no volumetrics)
    rt.setQuality(QUALITY.high);
    const hi = scene.children.find((o) => o.name === 'dustMotes') as THREE.Points;
    expect((hi.geometry.getAttribute('aSeed') as THREE.BufferAttribute).count).toBe(QUALITY.high.dustMotes);
    rt.setQuality(QUALITY.medium);
    expect(scene.children.find((o) => o.name === 'dustMotes')).toBeUndefined();
    const med = createLightingRuntime(new THREE.Scene(), createGlobals(), textures, QUALITY.medium, DEFAULT_SETTINGS, bus);
    expect(lightingFrameHooks(med).length).toBe(2); // registered once; no-ops without volumetrics
  });
});
