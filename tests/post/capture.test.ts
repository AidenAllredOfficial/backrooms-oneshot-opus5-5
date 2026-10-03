import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { createDisplayCapture } from '../../src/post/capture.ts';

function setup() {
  const capture = createDisplayCapture(8, 8);
  const original = new THREE.WebGLCubeRenderTarget(4);
  let target: THREE.WebGLRenderTarget | null = original, face = 3, level = 2, fail = false;
  const draws: string[] = [];
  const renderer = {
    getRenderTarget: () => target,
    getActiveCubeFace: () => face,
    getActiveMipmapLevel: () => level,
    setRenderTarget(rt: THREE.WebGLRenderTarget | null, f = 0, l = 0) { target = rt; face = f; level = l; },
    render(scene: THREE.Scene) {
      const material = (scene.children[0] as THREE.Mesh).material as THREE.ShaderMaterial;
      draws.push(material.name);
      if (fail) throw new Error('capture draw failed');
    },
    async readRenderTargetPixelsAsync(_rt: unknown, _x: number, _y: number, _w: number, _h: number, px: Uint8Array) { px.fill(17); },
  };
  return { capture, original, draws, r: renderer as unknown as THREE.WebGLRenderer,
    get target() { return target; }, get face() { return face; }, get level() { return level; },
    set fail(value: boolean) { fail = value; },
    dispose() { capture.dispose(); original.dispose(); },
  };
}

describe('display capture', () => {
  it('restores the previous target face and mip after downsampling', async () => {
    const t = setup();
    try {
      const pixels = await t.capture.read(t.r, 2.9, 3.1);
      expect(pixels).toHaveLength(2 * 3 * 4);
      expect(pixels.every((p) => p === 17)).toBe(true);
      expect(t.target).toBe(t.original);
      expect([t.face, t.level]).toEqual([3, 2]);
    } finally { t.dispose(); }
  });

  it('rejects a failed draw and restores renderer state so the following blit uses its material', async () => {
    const t = setup();
    try {
      t.fail = true;
      await expect(t.capture.read(t.r, 2, 2)).rejects.toThrow('capture draw failed');
      expect(t.target).toBe(t.original);
      expect([t.face, t.level]).toEqual([3, 2]);
      t.fail = false;
      t.capture.blit(t.r);
      expect(t.draws).toEqual(['br-post-capture', 'br-post-blit']);
    } finally { t.dispose(); }
  });

  it('rejects non-finite dimensions and requests after disposal without rendering', async () => {
    const t = setup();
    try {
      for (const [w, h] of [[NaN, 2], [2, Infinity], [-Infinity, 2]]) {
        await expect(t.capture.read(t.r, w, h)).rejects.toThrow('capture dimensions must be finite');
      }
      expect(t.draws).toHaveLength(0);
      t.capture.dispose();
      await expect(t.capture.read(t.r, 2, 2)).rejects.toThrow('display capture disposed');
      expect(t.draws).toHaveLength(0);
    } finally { t.dispose(); }
  });
});
