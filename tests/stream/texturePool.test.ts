// tests/stream/texturePool.test.ts (WP10) — the pool really pools (same texture object reused per class, capped).

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { createTexturePoolEx, POOL_CAP } from '../../src/stream/TexturePool.ts';

describe('TexturePool', () => {
  it('reuses released textures of the same class (same object => texSubImage re-upload)', () => {
    const p = createTexturePoolEx(null);
    const a = p.acquire2D(512, 256, 'half', new Uint16Array(512 * 256 * 4), false);
    expect(a.type).toBe(THREE.HalfFloatType);
    expect(a.minFilter).toBe(THREE.LinearFilter);
    expect(a.generateMipmaps).toBe(false);
    const v0 = a.version;
    p.release(a);
    expect(p.stats()).toMatchObject({ live: 0, pooled: 1 });
    const data = new Uint16Array(512 * 256 * 4);
    const b = p.acquire2D(512, 256, 'half', data, false);
    expect(b).toBe(a);
    expect((b.image as { data: unknown }).data).toBe(data);
    expect(b.version).toBeGreaterThan(v0); // marked for (sub-image) upload
    expect(p.stats()).toMatchObject({ live: 1, pooled: 0 });
    // different class: new texture
    const c = p.acquire2D(512, 512, 'half', new Uint16Array(512 * 512 * 4), false);
    expect(c).not.toBe(a);
    const d = p.acquire2D(512, 256, 'u8', new Uint8Array(512 * 256 * 4), false);
    expect(d).not.toBe(a);
    expect(d.type).toBe(THREE.UnsignedByteType);
  });

  it('caps pooled textures per class and disposes the excess', () => {
    const p = createTexturePoolEx(null);
    const ts = Array.from({ length: POOL_CAP + 3 }, () => p.acquire2D(88, 88, 'half', new Uint16Array(88 * 88 * 4), true));
    let disposed = 0;
    for (const t of ts) t.addEventListener('dispose', () => disposed++);
    for (const t of ts) p.release(t);
    expect(p.stats().pooled).toBe(POOL_CAP);
    expect(disposed).toBe(3);
    expect(ts[0].generateMipmaps).toBe(true);
    expect(ts[0].minFilter).toBe(THREE.LinearMipmapLinearFilter);
    p.drain();
    expect(p.stats()).toMatchObject({ live: 0, pooled: 0, bytes: 0, pooledBytes: 0 });
    expect(disposed).toBe(POOL_CAP + 3);
  });

  it('3D light volumes and the nearest-filtered wall mask', () => {
    const p = createTexturePoolEx(null);
    const v = p.acquire3D(32, 6, 32, 'half', new Uint16Array(32 * 6 * 32 * 4));
    expect(v.isData3DTexture).toBe(true);
    expect((v.image as { width: number; height: number; depth: number })).toMatchObject({ width: 32, height: 6, depth: 32 });
    p.release(v);
    expect(p.acquire3D(32, 6, 32, 'half', new Uint16Array(32 * 6 * 32 * 4))).toBe(v);
    expect(p.acquire3D(32, 6, 32, 'u8', new Uint8Array(32 * 6 * 32 * 4))).not.toBe(v);
    const m = p.acquire2D(18, 18, 'u8', new Uint8Array(18 * 18 * 4), false);
    expect(m.magFilter).toBe(THREE.NearestFilter);
    expect(m.minFilter).toBe(THREE.NearestFilter);
  });

  it('ignores textures it does not own and double releases; drops CPU data when pooled', () => {
    const p = createTexturePoolEx(null);
    const foreign = new THREE.DataTexture(new Uint8Array(4), 1, 1);
    p.release(foreign);
    expect(p.stats().pooled).toBe(0);
    const t = p.acquire2D(512, 256, 'u8', new Uint8Array(512 * 256 * 4), false);
    p.release(t);
    p.release(t);
    expect(p.stats().pooled).toBe(1);
    expect((t.image as { data: unknown }).data).toBe(null);
    expect(p.stats().bytes).toBe(512 * 256 * 4);
  });
});
