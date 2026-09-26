// src/stream/geometry.ts — MeshBuffers -> THREE.BufferGeometry (WP10). Attribute names per core/mesh.ts:
// position, normal (Int8 x4 normalized), uv, brLmUv, brLayer, brFlags, brTint (u8 x4 normalized), brEmit,
// brAux (u8 x4 normalized). Never uv1/uv2 (three declares `attribute vec2 uv1` under USE_UV1).

import * as THREE from 'three';
import type { MeshBuffers } from '../core/mesh.ts';

export function toBufferGeometry(m: MeshBuffers): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(m.position, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(m.normal, 4, true));
  g.setAttribute('uv', new THREE.BufferAttribute(m.uv, 2));
  g.setAttribute('brLmUv', new THREE.BufferAttribute(m.lmUv, 2));
  g.setAttribute('brLayer', new THREE.BufferAttribute(m.layer, 1));
  g.setAttribute('brFlags', new THREE.BufferAttribute(m.flags, 1));
  g.setAttribute('brTint', new THREE.BufferAttribute(m.tint, 4, true));
  g.setAttribute('brEmit', new THREE.BufferAttribute(m.emit, 1));
  g.setAttribute('brAux', new THREE.BufferAttribute(m.aux, 4, true));
  g.setIndex(new THREE.BufferAttribute(m.index, 1));
  g.setDrawRange(0, m.indexCount);
  // Bounds come from the producer (tile-local AABB); three never has to scan the arrays.
  const b = m.bounds;
  g.boundingBox = new THREE.Box3(new THREE.Vector3(b[0], b[1], b[2]), new THREE.Vector3(b[3], b[4], b[5]));
  g.boundingSphere = g.boundingBox.getBoundingSphere(new THREE.Sphere());
  return g;
}

function disposeArray(this: THREE.BufferAttribute): void {
  (this as unknown as { array: unknown }).array = null;
}

/** Free the CPU copies of every attribute (and the index) as soon as three has uploaded them. Safe for static
 * geometry drawn with precomputed bounds (no raycasts, no wireframe, attributes never modified). */
export function releaseCpuArraysOnUpload(g: THREE.BufferGeometry): void {
  for (const name in g.attributes) {
    const a = g.attributes[name];
    if ((a as THREE.BufferAttribute).isBufferAttribute) (a as THREE.BufferAttribute).onUpload(disposeArray);
  }
  g.index?.onUpload(disposeArray);
}

/** Approximate GPU bytes of a MeshBuffers payload (stats only). */
export function meshBytes(m: MeshBuffers): number {
  return m.position.byteLength + m.normal.byteLength + m.uv.byteLength + m.lmUv.byteLength + m.layer.byteLength +
    m.flags.byteLength + m.tint.byteLength + m.emit.byteLength + m.aux.byteLength + m.index.byteLength;
}
