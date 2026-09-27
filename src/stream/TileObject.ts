// src/stream/TileObject.ts — GPU side of one render tile (WP10): textures, materials, meshes, forced upload,
// in-place lightmap swap, dynamic meshes, disposal. The residency state machine (ChunkStreamer.ts) drives it
// through the TileUploader interface, so the machine itself is testable in Node with a fake uploader.

import * as THREE from 'three';
import { EMISSION, LV, NOISE_WRAP } from '../core/constants.ts';
import { globalTileX, globalTileZ, mod, tileKeyStr, tileOriginX, tileOriginZ, type TileKey } from '../core/grid.ts';
import type { LightmapData, MeshBuffers, TileMesh } from '../core/mesh.ts';
import type { DynamicMeshHandle, MaterialSystem, TileBindings, TileMaterials } from '../core/runtime.ts';
import { LAYER_LATE } from '../materials/shared.ts';
import { meshBytes, releaseCpuArraysOnUpload, toBufferGeometry } from './geometry.ts';
import { createTexturePoolEx, type TexturePoolEx } from './TexturePool.ts';

/** GPU resources of one tile build. `group` is positioned at the tile origin; `props` is the props mesh (hidden
 * beyond q.propDistance by the streamer). */
export interface TileGpu {
  readonly key: string;
  readonly group: THREE.Group;
  readonly materials: TileMaterials;
  props: THREE.Object3D | null;
  /** tile-local bounds of everything in the group (x0,y0,z0,x1,y1,z1), for visibility tests */
  readonly bounds: Float64Array;
}

/** Upload work is split into units (one texture, one mesh) so a residency step can be resumed on later frames:
 * each resumable call does at least one unit, then keeps going while `more()` returns true (the streamer's
 * per-frame budget), and returns true once the step is complete. */
export interface TileUploader {
  /** Start of a texture step: fresh materials + the (empty) group of a new build. No GPU work. */
  createTile(key: TileKey, hasWater: boolean): TileGpu;
  /** Texture step (resumable): pool textures for every lightmap map, uploaded now (initTexture); bindings via
   * `.value`. Calling it with a different `lm` restarts the step. */
  uploadTextures(gpu: TileGpu, lm: LightmapData, more: () => boolean): boolean;
  /** Geometry step (resumable, one mesh per unit): meshes into gpu.group with their GPU upload forced now; the
   * group is added to `parent` when the last mesh is done. */
  uploadGeometry(gpu: TileGpu, mesh: TileMesh, parent: THREE.Group, more: () => boolean): boolean;
  /** Full bake arrived (resumable): same-size textures are re-uploaded in place (texSubImage); bindings updated
   * via .value. Calling it with a different `lm` restarts the swap. */
  swapLightmap(gpu: TileGpu, lm: LightmapData, more: () => boolean): boolean;
  setFade(gpu: TileGpu, f: number): void;
  attachDynamic(gpu: TileGpu, m: MeshBuffers): DynamicMeshHandle;
  /** Rebuild: move live dynamic meshes from an old build to its replacement. */
  moveDynamics(from: TileGpu, to: TileGpu): void;
  /** Dispose geometries + materials, release textures (the group must already be out of the scene). */
  dispose(gpu: TileGpu): void;
  texturesPooled(): number;
  /** debug: GPU memory held by tile builds (textures live + pooled, geometry buffers) */
  memory?(): UploaderMemory;
  destroy(): void;
}

export interface UploaderMemory { texLive: number; texBytes: number; texPooled: number; texPooledBytes: number; geoBytes: number; meshes: number }

// ---------------------------------------------------------------- texture slots

const SLOT_IRR = 0, SLOT_DIR = 1, SLOT_MASK = 2, SLOT_FLICK = 3, SLOT_EMISSION = 4, SLOT_VOLA = 5, SLOT_VOLB = 6,
  SLOT_VOLC = 7, SLOT_VOLMASK = 8;
const SLOT_COUNT = 9;

interface DynMesh { mesh: THREE.Mesh; owner: TileGpuImpl; handle: DynamicMeshHandle }

interface TileGpuImpl extends TileGpu {
  slots: (THREE.Texture | null)[]; // pool-owned textures; null = shared zero texture bound
  meshes: THREE.Mesh[];
  dyn: Set<DynMesh>;
  disposed: boolean;
  // resumable-step cursors
  texLm: LightmapData | null; texCur: number;
  geoMesh: TileMesh | null; geoCur: number;
  swapLm: LightmapData | null; swapCur: number;
}

function bindingOf(b: TileBindings, slot: number): { value: THREE.Texture } {
  switch (slot) {
    case SLOT_IRR: return b.lmIrr;
    case SLOT_DIR: return b.lmDir;
    case SLOT_MASK: return b.lmMask;
    case SLOT_FLICK: return b.lmFlick;
    case SLOT_EMISSION: return b.emission;
    case SLOT_VOLA: return b.volA;
    case SLOT_VOLB: return b.volB;
    case SLOT_VOLC: return b.volC;
    case SLOT_VOLMASK: default: return b.volMask;
  }
}

interface SlotSpec { dim: 2 | 3; w: number; h: number; d: number; type: 'half' | 'u8'; mips: boolean; data: Uint16Array | Uint8Array | null }

function setSpec(o: SlotSpec, dim: 2 | 3, w: number, h: number, d: number, type: 'half' | 'u8', mips: boolean, data: Uint16Array | Uint8Array | null): SlotSpec {
  o.dim = dim; o.w = w; o.h = h; o.d = d; o.type = type; o.mips = mips; o.data = data;
  return o;
}

/** The texture spec of `slot` for `lm`, written into `o` (no allocation). */
function slotSpec(lm: LightmapData, slot: number, o: SlotSpec): SlotSpec {
  const W = lm.width, H = lm.height;
  switch (slot) {
    case SLOT_IRR: return setSpec(o, 2, W, H, 1, 'half', false, lm.irr);
    case SLOT_DIR: return setSpec(o, 2, W, H, 1, 'u8', false, lm.dir);
    case SLOT_MASK: return setSpec(o, 2, W, H, 1, 'u8', false, lm.mask);
    case SLOT_FLICK: return setSpec(o, 2, W, H, 1, 'half', false, lm.flick);
    // emission: mipmapped for the colour lookup (WP7 §10); WP9 reads alpha with texelFetch at level 0
    case SLOT_EMISSION: return setSpec(o, 2, EMISSION.RES, EMISSION.RES, 1, 'half', true, lm.emission);
    case SLOT_VOLA: return setSpec(o, 3, LV.NX, LV.NY, LV.NZ, 'half', false, lm.volume.a);
    case SLOT_VOLB: return setSpec(o, 3, LV.NX, LV.NY, LV.NZ, 'u8', false, lm.volume.b);
    case SLOT_VOLC: return setSpec(o, 3, LV.NX, LV.NY, LV.NZ, 'half', false, lm.volume.c);
    default: return setSpec(o, 2, 18, 18, 1, 'u8', false, lm.volume.wallMask);
  }
}

const EMPTY_BOUNDS = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];

/** Package E: the water kinds in the tile's wall mask (b = kind + 1, bake/volume.ts bakeWallMask) as a bit mask,
 * 1 pool | 2 flooded | 4 film; 0 = dry. uTileWater gates the wet band (any water) and the above-water caustics
 * (pool water) on the tile's surfaces with one uniform branch. */
export function tileWaterOf(wallMask: Uint8Array): number {
  let m = 0;
  for (let i = 2; i < wallMask.length; i += 4) if (wallMask[i] !== 0) m |= 1 << (wallMask[i] - 1);
  return m;
}

const sameSize = (t: THREE.Texture, s: SlotSpec): boolean => {
  const img = t.image as { width: number; height: number; depth?: number };
  const is3 = (t as THREE.Data3DTexture).isData3DTexture === true;
  const type = t.type === THREE.HalfFloatType ? 'half' : 'u8';
  return img.width === s.w && img.height === s.h && (s.dim === 3) === is3 && (!is3 || img.depth === s.d) && type === s.type &&
    t.generateMipmaps === s.mips;
};

// ---------------------------------------------------------------- the uploader

export function createTileUploader(renderer: THREE.WebGLRenderer, materials: MaterialSystem): TileUploader {
  const pool: TexturePoolEx = createTexturePoolEx(renderer);

  // Forced-upload scratch: 1x1 target, trivial pinned material, scratch scene + camera. The pinned material's
  // program is compiled once here (at streamer creation), so forced uploads never compile anything.
  const scratchRT = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: true, stencilBuffer: false });
  const pinned = new THREE.MeshBasicMaterial({ color: 0xffffff });
  pinned.name = 'streamer-upload-pinned';
  const scratchScene = new THREE.Scene();
  scratchScene.matrixWorldAutoUpdate = true;
  const scratchCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 1);
  const warmGeo = new THREE.BufferGeometry();
  warmGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3));
  const warmMesh = new THREE.Mesh(warmGeo, pinned);
  warmMesh.frustumCulled = false;

  const scratchSave: THREE.Material[] = [];
  const cullSave: boolean[] = [];
  const parentSave: (THREE.Object3D | null)[] = [];
  const one: THREE.Mesh[] = [];
  const spec: SlotSpec = { dim: 2, w: 0, h: 0, d: 1, type: 'u8', mips: false, data: null };

  /** Draw `objs` once into the 1x1 target with the pinned material: three uploads every attribute + index of
   * each geometry (WebGLObjects.update) now, instead of lazily at the first visible draw. */
  function forceUpload(objs: readonly THREE.Mesh[]): void {
    if (objs.length === 0) return;
    for (let i = 0; i < objs.length; i++) {
      const m = objs[i];
      scratchSave[i] = m.material as THREE.Material;
      cullSave[i] = m.frustumCulled;
      parentSave[i] = m.parent;
      m.material = pinned; // explicit swap: independent of material.allowOverride
      m.frustumCulled = false;
      scratchScene.add(m);
    }
    scratchScene.overrideMaterial = pinned;
    const prevRT = renderer.getRenderTarget();
    const prevXr = renderer.xr.enabled;
    renderer.xr.enabled = false;
    try {
      renderer.setRenderTarget(scratchRT);
      renderer.render(scratchScene, scratchCam);
    } finally {
      renderer.setRenderTarget(prevRT);
      renderer.xr.enabled = prevXr;
      scratchScene.overrideMaterial = null;
      for (let i = 0; i < objs.length; i++) {
        const m = objs[i];
        m.material = scratchSave[i];
        m.frustumCulled = cullSave[i];
        const p = parentSave[i];
        if (p) p.add(m); else scratchScene.remove(m);
      }
      scratchSave.length = 0;
      cullSave.length = 0;
      parentSave.length = 0;
    }
  }
  one[0] = warmMesh;
  forceUpload(one);

  function acquire(s: SlotSpec, data: Uint16Array | Uint8Array): THREE.Texture {
    const t = s.dim === 3 ? pool.acquire3D(s.w, s.h, s.d, s.type, data) : pool.acquire2D(s.w, s.h, s.type, data, s.mips);
    renderer.initTexture(t); // upload now (texture step), not at first draw
    return t;
  }

  function zeroFor(slot: number): THREE.Texture {
    return slot === SLOT_VOLC ? materials.zeroTextures.vol3d : materials.zeroTextures.lm2d;
  }

  function addMesh(gpu: TileGpuImpl, m: MeshBuffers | null, mat: THREE.Material, castShadow: boolean, renderOrder: number, name: string): THREE.Mesh | null {
    if (!m || m.vertexCount === 0 || m.indexCount === 0) return null;
    const geo = toBufferGeometry(m);
    releaseCpuArraysOnUpload(geo);
    const mesh = new THREE.Mesh(geo, mat);
    const nb = meshBytes(m);
    mesh.userData.bytes = nb;
    geoBytes += nb;
    meshCount++;
    mesh.name = name;
    mesh.castShadow = castShadow;
    mesh.receiveShadow = true;
    mesh.renderOrder = renderOrder;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    gpu.group.add(mesh);
    gpu.meshes.push(mesh);
    const b = m.bounds, gb = gpu.bounds;
    if (b[0] < gb[0]) gb[0] = b[0]; if (b[1] < gb[1]) gb[1] = b[1]; if (b[2] < gb[2]) gb[2] = b[2];
    if (b[3] > gb[3]) gb[3] = b[3]; if (b[4] > gb[4]) gb[4] = b[4]; if (b[5] > gb[5]) gb[5] = b[5];
    return mesh;
  }

  /** Geometry-step unit `part` (0 shell, 1 props, 2 decals, 3 water): the mesh, or null when the part is empty. */
  function addPart(gpu: TileGpuImpl, mesh: TileMesh, part: number): THREE.Mesh | null {
    const mats = gpu.materials;
    switch (part) {
      case 0: return addMesh(gpu, mesh.shell, mats.shell, true, 0, 'shell');
      case 1: return (gpu.props = addMesh(gpu, mesh.props, mats.props, true, 0, 'props'));
      case 2: return addMesh(gpu, mesh.decals, mats.decal, false, 1, 'decals');
      default: {
        const w = mesh.water ? addMesh(gpu, mesh.water, mats.water ?? mats.shell, false, 2, 'water') : null;
        w?.layers.set(LAYER_LATE); // drawn by ScenePass's late render, over the opaque colour copy
        return w;
      }
    }
  }
  const GEO_PARTS = 4;

  let geoBytes = 0, meshCount = 0;
  const dropMesh = (m: THREE.Mesh): void => {
    m.geometry.dispose();
    geoBytes -= (m.userData.bytes as number | undefined) ?? 0;
    meshCount--;
  };

  const up: TileUploader = {
    createTile(key, hasWater) {
      const mats = materials.createTileMaterials(hasWater);
      const b = mats.bindings;
      const ox = tileOriginX(key), oz = tileOriginZ(key);
      b.tileOrigin.value.set(ox, 0, oz);
      b.noiseOrigin.value.set(mod(ox, NOISE_WRAP), 0, mod(oz, NOISE_WRAP));
      b.ownParity.value.set(globalTileX(key) & 1, globalTileZ(key) & 1);
      b.fade.value = 0;
      const group = new THREE.Group();
      group.name = `tile:${tileKeyStr(key)}`;
      group.position.set(ox, 0, oz);
      group.updateMatrix();
      const gpu: TileGpuImpl = {
        key: tileKeyStr(key), group, materials: mats, props: null,
        bounds: new Float64Array([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]),
        slots: new Array<THREE.Texture | null>(SLOT_COUNT).fill(null), meshes: [], dyn: new Set(), disposed: false,
        texLm: null, texCur: 0, geoMesh: null, geoCur: 0, swapLm: null, swapCur: 0,
      };
      // until the texture step reaches a slot, it samples the shared zero texture (never an unset uniform)
      for (let slot = 0; slot < SLOT_COUNT; slot++) bindingOf(b, slot).value = zeroFor(slot);
      return gpu;
    },

    uploadTextures(gpuIn, lm, more) {
      const gpu = gpuIn as TileGpuImpl;
      if (gpu.texLm !== lm) { gpu.texLm = lm; gpu.texCur = 0; }
      const b = gpu.materials.bindings;
      while (gpu.texCur < SLOT_COUNT) {
        const slot = gpu.texCur++;
        const s = slotSpec(lm, slot, spec);
        if (slot === SLOT_VOLMASK) b.water.value = tileWaterOf(lm.volume.wallMask);
        const binding = bindingOf(b, slot);
        const old = gpu.slots[slot];
        if (old) { pool.release(old); gpu.slots[slot] = null; } // restarted step (defensive)
        if (s.data) {
          const t = acquire(s, s.data);
          gpu.slots[slot] = t;
          binding.value = t;
          if (gpu.texCur < SLOT_COUNT && !more()) return false; // one texture upload = one unit
        } else {
          binding.value = zeroFor(slot);
        }
      }
      gpu.texLm = null;
      return true;
    },

    uploadGeometry(gpuIn, mesh, parent, more) {
      const gpu = gpuIn as TileGpuImpl;
      if (gpu.geoMesh !== mesh) {
        // (re)start: drop meshes of an interrupted step for another payload
        for (const m of gpu.meshes) { m.removeFromParent(); dropMesh(m); }
        gpu.meshes.length = 0;
        gpu.props = null;
        gpu.bounds.set(EMPTY_BOUNDS);
        gpu.geoMesh = mesh;
        gpu.geoCur = 0;
      }
      while (gpu.geoCur < GEO_PARTS) {
        const m = addPart(gpu, mesh, gpu.geoCur++);
        if (m) {
          one[0] = m;
          forceUpload(one);
          if (gpu.geoCur < GEO_PARTS && !more()) return false; // one mesh upload = one unit
        }
      }
      gpu.geoMesh = null;
      parent.add(gpu.group);
      return true;
    },

    swapLightmap(gpuIn, lm, more) {
      const gpu = gpuIn as TileGpuImpl;
      if (gpu.swapLm !== lm) { gpu.swapLm = lm; gpu.swapCur = 0; }
      const b = gpu.materials.bindings;
      while (gpu.swapCur < SLOT_COUNT) {
        const slot = gpu.swapCur++;
        const s = slotSpec(lm, slot, spec);
        if (slot === SLOT_VOLMASK) b.water.value = tileWaterOf(lm.volume.wallMask);
        const old = gpu.slots[slot];
        const binding = bindingOf(b, slot);
        if (s.data && old && sameSize(old, s)) {
          // same size: re-upload into the existing GL texture (texSubImage), binding unchanged
          (old.image as { data: unknown }).data = s.data;
          old.needsUpdate = true;
          renderer.initTexture(old);
        } else if (s.data) {
          const t = acquire(s, s.data);
          gpu.slots[slot] = t;
          binding.value = t;
          if (old) pool.release(old);
        } else {
          gpu.slots[slot] = null;
          binding.value = zeroFor(slot);
          if (old) pool.release(old);
          continue; // no upload: not a unit
        }
        if (gpu.swapCur < SLOT_COUNT && !more()) return false;
      }
      gpu.swapLm = null;
      return true;
    },

    setFade(gpu, f) {
      gpu.materials.bindings.fade.value = f;
    },

    attachDynamic(gpuIn, m) {
      const gpu = gpuIn as TileGpuImpl;
      const geo = toBufferGeometry(m);
      releaseCpuArraysOnUpload(geo);
      const mesh = new THREE.Mesh(geo, gpu.materials.props);
      mesh.name = 'dynamic';
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      gpu.group.add(mesh);
      one[0] = mesh;
      forceUpload(one);
      const rec: DynMesh = {
        mesh, owner: gpu,
        handle: {
          setOffset(x, y, z) { mesh.position.set(x, y, z); },
          dispose() {
            if (!rec.owner.dyn.has(rec)) return;
            rec.owner.dyn.delete(rec);
            mesh.removeFromParent();
            geo.dispose();
          },
        },
      };
      gpu.dyn.add(rec);
      return rec.handle;
    },

    moveDynamics(fromIn, toIn) {
      const from = fromIn as TileGpuImpl, to = toIn as TileGpuImpl;
      for (const d of from.dyn) {
        to.group.add(d.mesh);
        d.mesh.material = to.materials.props;
        to.dyn.add(d);
        d.owner = to;
      }
      from.dyn.clear();
    },

    dispose(gpuIn) {
      const gpu = gpuIn as TileGpuImpl;
      if (gpu.disposed) return;
      gpu.disposed = true;
      gpu.texLm = null; gpu.geoMesh = null; gpu.swapLm = null;
      gpu.group.removeFromParent();
      for (const d of [...gpu.dyn]) d.handle.dispose();
      for (const m of gpu.meshes) dropMesh(m);
      gpu.meshes.length = 0;
      gpu.group.clear();
      gpu.materials.dispose();
      for (let slot = 0; slot < SLOT_COUNT; slot++) {
        const t = gpu.slots[slot];
        if (t) pool.release(t);
        gpu.slots[slot] = null;
      }
    },

    texturesPooled: () => pool.stats().pooled,

    memory() {
      const p = pool.stats();
      return { texLive: p.live, texBytes: p.bytes, texPooled: p.pooled, texPooledBytes: p.pooledBytes, geoBytes, meshes: meshCount };
    },

    destroy() {
      pool.drain();
      scratchRT.dispose();
      warmGeo.dispose();
      pinned.dispose();
    },
  };
  return up;
}
