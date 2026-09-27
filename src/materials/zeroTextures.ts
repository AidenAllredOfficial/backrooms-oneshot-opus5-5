// src/materials/zeroTextures.ts — shared all-zero stand-ins for missing per-tile data (no flicker channels,
// no light volume, bindings before the first upload). Owned by the MaterialSystem; never disposed per tile.
// Also the inert 1x1 stand-ins of the screen-space globals (MaterialGlobals.ssaoTex / volTex) until their passes
// publish real targets: they read as "no occlusion" and "no in-scatter, full transmittance".

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

/** A 1x1 RGBA16F texel (nearest, no mips). */
function halfTexel(name: string, r: number, g: number, b: number, a: number): THREE.DataTexture {
  const h = THREE.DataUtils.toHalfFloat;
  const t = new THREE.DataTexture(new Uint16Array([h(r), h(g), h(b), h(a)]), 1, 1, THREE.RGBAFormat, THREE.HalfFloatType);
  t.name = name;
  t.minFilter = THREE.NearestFilter;
  t.magFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

/** SSAO stand-in (aoRT layout: r AO, g view Z, ba oct normal): white = unoccluded. */
export const createInertSsaoTexture = (): THREE.DataTexture => halfTexel('br-ssao-inert', 1, 1, 1, 1);

/** Froxel-volume stand-in (rgb in-scatter, a transmittance): (0, 0, 0, 1) = no fog. */
export const createInertVolumeTexture = (): THREE.DataTexture => halfTexel('br-vol-inert', 0, 0, 0, 1);
