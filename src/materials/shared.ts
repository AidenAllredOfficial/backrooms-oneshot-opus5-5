// src/materials/shared.ts — uniform objects shared by every material of one MaterialSystem (texture set, layer
// table) plus the module-private reflection-pass flag (set only by PlanarReflection while it renders the mirrored
// view; props beyond 20 m and water surfaces are skipped in that pass).

import type * as THREE from 'three';
import type { QualityConfig } from '../core/quality.ts';
import type { TextureSet } from '../core/runtime.ts';
import { buildLayerTable } from './chunks/params.ts';

export interface SharedUniforms {
  albedo: { value: THREE.Texture };
  normal: { value: THREE.Texture };
  ormh: { value: THREE.Texture };
  grime: { value: THREE.Texture };
  waterNormals: { value: THREE.Texture };
  layerA: { value: Float32Array };
  layerB: { value: Float32Array };
  reflPass: { value: number };
}

/** 1 while PlanarReflection renders the mirrored view (module singleton: one reflection pass at a time). */
export const REFL_PASS: { value: number } = { value: 0 };

export function createSharedUniforms(textures: TextureSet): SharedUniforms {
  const t = buildLayerTable();
  return {
    albedo: { value: textures.albedo },
    normal: { value: textures.normal },
    ormh: { value: textures.ormh },
    grime: { value: textures.grime },
    waterNormals: { value: textures.waterNormals },
    layerA: { value: t.a },
    layerB: { value: t.b },
    reflPass: REFL_PASS,
  };
}

/** Quality switches that change programs (defines). */
export interface QualityDefines { floorRefl: boolean; airlight: boolean; lite: boolean }
export const qualityDefinesOf = (q: QualityConfig): QualityDefines => ({ floorRefl: q.floorReflections, airlight: q.fogAirlight, lite: q.shaderDetail === 'lite' });
export const definesKey = (d: QualityDefines): string => `R${d.floorRefl ? 1 : 0}A${d.airlight ? 1 : 0}L${d.lite ? 1 : 0}`;
