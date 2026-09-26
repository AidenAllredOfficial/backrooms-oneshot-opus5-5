// src/stream/TexturePool.ts — lightmap / light-volume texture pool (WP10).
//
// Textures are pooled per class (2D|3D, width, height, depth, type, mips, filter). A released texture keeps its
// GPU allocation; the next acquire of the same class assigns new data and marks it for update, so three
// re-uploads it with texSubImage (allocateMemory === false: same size, same sampler cache key) instead of
// allocating a new GL texture. At most POOL_CAP textures are kept per class; releases beyond the cap are disposed.
//
// CPU copies: 2D lightmap textures drop `image.data` right after their GPU upload (the JS heap would otherwise hold
// every resident lightmap twice); 3D light-volume textures and the 18x18 wall mask keep it (WP11 samples
// `volA.image.data` / `volMask.image.data` on the CPU for camIrradiance).

import * as THREE from 'three';

export interface TexturePool {
  acquire2D(w: number, h: number, type: 'half' | 'u8', data: Uint16Array | Uint8Array, mips: boolean): THREE.DataTexture;
  acquire3D(w: number, h: number, d: number, type: 'half' | 'u8', data: Uint16Array | Uint8Array): THREE.Data3DTexture;
  release(t: THREE.Texture): void; stats(): { live: number; pooled: number; bytes: number; pooledBytes: number };
}

/** Maximum pooled (released, GPU-resident) textures per class. */
export const POOL_CAP = 8;

interface Entry { cls: string; bytes: number; live: boolean }

const bytesPer = (type: 'half' | 'u8'): number => (type === 'half' ? 8 : 4); // RGBA
const mipFactor = (mips: boolean): number => (mips ? 4 / 3 : 1);

/** Drop the CPU copy once three has uploaded a 2D texture (runs inside WebGLTextures.uploadTexture). */
function dropCpuData(t: THREE.Texture): void {
  const img = t.image as { data: unknown } | null;
  if (img) img.data = null;
}

/** Filter used for small 2D classes that hold bit masks (the 18x18 wall mask): must never be interpolated. */
export const isMaskClass = (w: number, h: number, type: 'half' | 'u8'): boolean => w === 18 && h === 18 && type === 'u8';

/** The pool plus maintenance for its owner (the streamer). */
export interface TexturePoolEx extends TexturePool {
  /** dispose every pooled (released) texture; live textures are untouched */
  drain(): void;
}

// Pool cap: at most 8 pooled textures per (size, type) class; releases beyond the cap are disposed immediately.
export function createTexturePool(renderer: THREE.WebGLRenderer | null): TexturePool {
  return createTexturePoolEx(renderer);
}

export function createTexturePoolEx(renderer: THREE.WebGLRenderer | null): TexturePoolEx {
  void renderer; // uploads are driven by renderer.initTexture in the streamer's texture step
  const entries = new Map<THREE.Texture, Entry>();
  const free = new Map<string, THREE.Texture[]>();
  let live = 0, pooled = 0, bytes = 0, pooledBytes = 0;

  const take = (cls: string): THREE.Texture | undefined => {
    const list = free.get(cls);
    const t = list?.pop();
    if (t) {
      const e = entries.get(t) as Entry;
      e.live = true;
      pooled--; pooledBytes -= e.bytes;
      live++;
    }
    return t;
  };

  const track = (t: THREE.Texture, cls: string, n: number): void => {
    entries.set(t, { cls, bytes: n, live: true });
    live++;
    bytes += n;
  };

  return {
    acquire2D(w, h, type, data, mips) {
      const mask = isMaskClass(w, h, type);
      const cls = `2d|${w}|${h}|${type}|${mips ? 1 : 0}|${mask ? 'n' : 'l'}`;
      let t = take(cls) as THREE.DataTexture | undefined;
      if (t) {
        (t.image as { data: unknown }).data = data;
      } else {
        t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, type === 'half' ? THREE.HalfFloatType : THREE.UnsignedByteType);
        t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
        t.generateMipmaps = mips;
        t.magFilter = mask ? THREE.NearestFilter : THREE.LinearFilter;
        t.minFilter = mask ? THREE.NearestFilter : mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
        t.colorSpace = THREE.NoColorSpace;
        t.flipY = false;
        t.unpackAlignment = 1;
        if (!mask) t.onUpdate = dropCpuData; // the tiny wall mask keeps its CPU copy (WP11 samples it with volA)
        t.name = `pool:${cls}`;
        track(t, cls, Math.round(w * h * bytesPer(type) * mipFactor(mips)));
      }
      t.needsUpdate = true;
      return t;
    },
    acquire3D(w, h, d, type, data) {
      const cls = `3d|${w}|${h}|${d}|${type}`;
      let t = take(cls) as THREE.Data3DTexture | undefined;
      if (t) {
        (t.image as { data: unknown }).data = data;
      } else {
        t = new THREE.Data3DTexture(data, w, h, d);
        t.format = THREE.RGBAFormat;
        t.type = type === 'half' ? THREE.HalfFloatType : THREE.UnsignedByteType;
        t.wrapS = t.wrapT = t.wrapR = THREE.ClampToEdgeWrapping;
        t.magFilter = THREE.LinearFilter;
        t.minFilter = THREE.LinearFilter;
        t.generateMipmaps = false;
        t.colorSpace = THREE.NoColorSpace;
        t.unpackAlignment = 1;
        t.name = `pool:${cls}`;
        track(t, cls, w * h * d * bytesPer(type));
      }
      t.needsUpdate = true;
      return t;
    },
    release(t) {
      const e = entries.get(t);
      if (!e || !e.live) return; // not ours (shared zero textures) or already released
      e.live = false;
      live--;
      let list = free.get(e.cls);
      if (!list) free.set(e.cls, (list = []));
      if (list.length < POOL_CAP) {
        (t.image as { data: unknown }).data = null; // pooled textures hold GPU memory only
        list.push(t);
        pooled++;
        pooledBytes += e.bytes;
      } else {
        entries.delete(t);
        bytes -= e.bytes;
        t.dispose();
      }
    },
    stats() {
      return { live, pooled, bytes, pooledBytes };
    },
    drain() {
      for (const list of free.values()) {
        for (const t of list) {
          const e = entries.get(t) as Entry;
          entries.delete(t);
          bytes -= e.bytes;
          pooledBytes -= e.bytes;
          pooled--;
          t.dispose();
        }
        list.length = 0;
      }
    },
  };
}
