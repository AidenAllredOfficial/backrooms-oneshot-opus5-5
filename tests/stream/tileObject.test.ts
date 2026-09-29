import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { LM_DIR_LAYERS } from '../../src/bake/encode.ts';
import { EMISSION, LV } from '../../src/core/constants.ts';
import type { LightmapData } from '../../src/core/mesh.ts';
import type { MaterialSystem, TileBindings, TileMaterials } from '../../src/core/runtime.ts';
import { createZeroTextures } from '../../src/materials/zeroTextures.ts';
import { createTileUploader } from '../../src/stream/TileObject.ts';

const maps = ['lmIrr', 'lmDir', 'lmMask', 'lmFlick', 'emission', 'volA', 'volB', 'volC', 'volMask'] as const;
const half = (n: number, tag: number) => new Uint16Array(n).fill(tag);
const bytes = (n: number, tag: number) => new Uint8Array(n).fill(tag);

function lightmap(tag: number, width = 4, dynamic = true): LightmapData {
  const n = width * 4 * 4, vn = LV.NX * LV.NY * LV.NZ * 4;
  const wallMask = bytes(18 * 18 * 4, 0);
  wallMask[0] = tag;
  wallMask[2] = tag; // water kind changes with the same atomic publication
  return {
    tileKey: '0/0/0/0/0', variant: tag === 1 ? 'preview' : 'full', width, height: 4, chartHash: 1,
    irr: half(n, tag), dir: bytes(n * LM_DIR_LAYERS, tag), mask: bytes(n, tag),
    flick: dynamic ? half(n, tag) : null, emission: half(EMISSION.RES * EMISSION.RES * 4, tag),
    volume: { a: half(vn, tag), b: bytes(vn, tag), c: dynamic ? half(vn, tag) : null, wallMask },
    stats: { ms: 0, texels: n / 4, rays: 0, lights: 0 },
  };
}

function harness() {
  const zeroTextures = createZeroTextures();
  const uploaded = new Map<THREE.Texture, number>();
  let uploads = 0, failAt = -1, target: THREE.WebGLRenderTarget | null = null;
  const renderer = {
    xr: { enabled: false },
    getRenderTarget: () => target,
    setRenderTarget: (t: THREE.WebGLRenderTarget | null) => { target = t; },
    render() {},
    initTexture(t: THREE.Texture) {
      if (++uploads === failAt) throw new Error('upload failed');
      uploaded.set(t, (t.image as { data: Uint16Array | Uint8Array }).data[0]);
      t.onUpdate?.(t); // real Three drops uploaded 2D CPU data through this callback
    },
  } as unknown as THREE.WebGLRenderer;
  const materials = {
    zeroTextures,
    createTileMaterials() {
      const bindings = {
        tileOrigin: { value: new THREE.Vector3() }, noiseOrigin: { value: new THREE.Vector3() },
        ownParity: { value: new THREE.Vector2() }, fade: { value: 1 }, water: { value: 0 },
      } as TileBindings;
      for (const name of maps) bindings[name] = { value: zeroTextures.lm2d };
      return { bindings, dispose() {} } as TileMaterials;
    },
  } as unknown as MaterialSystem;
  const uploader = createTileUploader(renderer, materials);
  const gpu = uploader.createTile({ s: 0, cx: 0, cz: 0, q: 0 }, true);
  uploader.uploadTextures(gpu, lightmap(1), () => true);
  return {
    uploader, gpu, uploaded, zeroTextures,
    bindings: () => maps.map((name) => gpu.materials.bindings[name].value),
    failIn(n: number) { failAt = uploads + n; },
    cleanup() {
      uploader.dispose(gpu);
      uploader.destroy();
      zeroTextures.lm2d.dispose(); zeroTextures.vol3d.dispose();
    },
  };
}

describe('TileObject full-bake publication', () => {
  it('keeps irradiance, direction, flicker and volumes from one bake between budgeted upload units', () => {
    const h = harness();
    try {
      const old = h.bindings(), versions = old.map((t) => t.version), full = lightmap(2);
      let units = 0;
      while (!h.uploader.swapLightmap(h.gpu, full, () => false)) {
        units++;
        expect(h.bindings()).toEqual(old);
        expect(old.map((t) => t.version)).toEqual(versions);
        expect(old.map((t) => h.uploaded.get(t))).toEqual(new Array(9).fill(1));
        expect((h.gpu.materials.bindings.volA.value.image as { data: Uint16Array }).data[0]).toBe(1);
        expect(h.gpu.materials.bindings.water.value).toBe(1);
      }
      expect(units).toBe(8);
      expect(h.bindings().map((t) => h.uploaded.get(t))).toEqual(new Array(9).fill(2));
      expect(h.gpu.materials.bindings.water.value).toBe(2);
      expect(h.uploader.memory!().texLive).toBe(9);
    } finally { h.cleanup(); }
  });

  it('releases an interrupted staging set when a different bake restarts the swap', () => {
    const h = harness();
    try {
      const old = h.bindings(), interrupted = lightmap(2), latest = lightmap(3);
      expect(h.uploader.swapLightmap(h.gpu, interrupted, () => false)).toBe(false);
      expect(h.uploader.swapLightmap(h.gpu, interrupted, () => false)).toBe(false);
      expect(h.uploader.memory!().texLive).toBe(11);
      expect(h.uploader.swapLightmap(h.gpu, latest, () => false)).toBe(false);
      expect(h.uploader.memory!().texLive).toBe(10);
      expect(h.bindings()).toEqual(old);
      expect(h.uploader.swapLightmap(h.gpu, latest, () => true)).toBe(true);
      expect(h.bindings().map((t) => h.uploaded.get(t))).toEqual(new Array(9).fill(3));
      expect(h.uploader.memory!().texLive).toBe(9);
    } finally { h.cleanup(); }
  });

  it('releases both displayed and staged textures on disposal', () => {
    const h = harness();
    try {
      expect(h.uploader.swapLightmap(h.gpu, lightmap(2), () => false)).toBe(false);
      expect(h.uploader.memory!().texLive).toBe(10);
      h.uploader.dispose(h.gpu);
      expect(h.uploader.memory!().texLive).toBe(0);
      expect(h.uploader.memory!().texPooled).toBe(10);
    } finally { h.cleanup(); }
  });

  it('immediately releases a cancelled swap while retaining the displayed bake', () => {
    const h = harness();
    try {
      const old = h.bindings(), full = lightmap(2);
      expect(h.uploader.swapLightmap(h.gpu, full, () => false)).toBe(false);
      expect(h.uploader.memory!().texLive).toBe(10);
      h.uploader.cancelLightmapSwap(h.gpu);
      expect(h.uploader.memory!().texLive).toBe(9);
      expect(h.bindings()).toEqual(old);
      expect(old.map((t) => h.uploaded.get(t))).toEqual(new Array(9).fill(1));
      h.uploader.cancelLightmapSwap(h.gpu); // repeated cancellation is safe
      expect(h.uploader.memory!().texLive).toBe(9);
      expect(h.uploader.swapLightmap(h.gpu, full, () => true)).toBe(true);
      expect(h.bindings().map((t) => h.uploaded.get(t))).toEqual(new Array(9).fill(2));
    } finally { h.cleanup(); }
  });

  it('publishes a one-call resized bake and removes absent dynamic channels together', () => {
    const h = harness();
    try {
      expect(h.uploader.swapLightmap(h.gpu, lightmap(2, 8, false), () => true)).toBe(true);
      const b = h.gpu.materials.bindings;
      expect((b.lmIrr.value.image as { width: number }).width).toBe(8);
      expect(b.lmFlick.value).toBe(h.zeroTextures.lm2d);
      expect(b.volC.value).toBe(h.zeroTextures.vol3d);
      expect(h.bindings().filter((t) => t !== h.zeroTextures.lm2d && t !== h.zeroTextures.vol3d)
        .map((t) => h.uploaded.get(t))).toEqual(new Array(7).fill(2));
      expect(h.uploader.memory!().texLive).toBe(7);
    } finally { h.cleanup(); }
  });

  it('keeps the displayed bake and releases all candidates if an upload fails', () => {
    const h = harness();
    try {
      const old = h.bindings(), full = lightmap(2);
      h.failIn(2);
      expect(() => h.uploader.swapLightmap(h.gpu, full, () => true)).toThrow('upload failed');
      expect(h.bindings()).toEqual(old);
      expect(h.uploader.memory!().texLive).toBe(9);
      expect(h.uploader.swapLightmap(h.gpu, full, () => true)).toBe(true);
      expect(h.bindings().map((t) => h.uploaded.get(t))).toEqual(new Array(9).fill(2));
    } finally { h.cleanup(); }
  });
});
