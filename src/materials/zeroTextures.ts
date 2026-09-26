// src/materials/zeroTextures.ts — shared all-zero stand-ins for missing per-tile data (no flicker channels,
// no light volume, bindings before the first upload). Owned by the MaterialSystem; never disposed per tile.

import * as THREE from 'three';

export interface ZeroTextures { lm2d: THREE.Texture; vol3d: THREE.Texture }

export function createZeroTextures(): ZeroTextures {
  const lm2d = new THREE.DataTexture(new Uint8Array(4), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  lm2d.name = 'br-zero-2d';
  lm2d.minFilter = THREE.NearestFilter;
  lm2d.magFilter = THREE.NearestFilter;
  lm2d.generateMipmaps = false;
  lm2d.needsUpdate = true;
  const vol3d = new THREE.Data3DTexture(new Uint8Array(4), 1, 1, 1);
  vol3d.name = 'br-zero-3d';
  vol3d.format = THREE.RGBAFormat;
  vol3d.type = THREE.UnsignedByteType;
  vol3d.minFilter = THREE.NearestFilter;
  vol3d.magFilter = THREE.NearestFilter;
  vol3d.generateMipmaps = false;
  vol3d.needsUpdate = true;
  return { lm2d, vol3d };
}
