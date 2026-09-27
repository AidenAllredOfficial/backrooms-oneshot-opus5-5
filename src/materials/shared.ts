// src/materials/shared.ts — uniform objects shared by every material of one MaterialSystem (texture set, layer
// table) plus the module-private reflection-pass flag (set only by PlanarReflection while it renders the mirrored
// view; props beyond 20 m and water surfaces are skipped in that pass), the MRT-pass flag (set by ScenePass while
// the opaque render writes the specular G-buffer) and the pixel size for thin props tubes (set by whoever renders
// the scene: ScenePass, PlanarReflection).

import type * as THREE from 'three';
import type { QualityConfig } from '../core/quality.ts';
import type { TextureSet } from '../core/runtime.ts';
import { buildLayerTable } from './chunks/params.ts';

/** three.js layer of everything ScenePass draws AFTER the opaque colour copy (water, sparks, motes). The main camera
 * enables it; the prepass hides those meshes anyway (no depth material). */
export const LAYER_LATE = 1;

export interface SharedUniforms {
  albedo: { value: THREE.Texture };
  normal: { value: THREE.Texture };
  ormh: { value: THREE.Texture };
  grime: { value: THREE.Texture };
  waterNormals: { value: THREE.Texture };
  layerA: { value: Float32Array };
  layerB: { value: Float32Array };
  /** package B layer tables (chunks/params.ts SURFACE_PHYS via buildLayerTable): C = (heightScale, pomTop, porosity,
   * tok), D = (detailId, detailStrength, sheen, sheenRough), E = (glazeRough, roughComp, 0, 0) */
  layerC: { value: Float32Array };
  layerD: { value: Float32Array };
  layerE: { value: Float32Array };
  /** package B detail-map array (TextureSet.detail; null until generated) */
  detail: { value: THREE.Texture | null };
  reflPass: { value: number };
  mrt: { value: number };
  wirePx: { value: number };
}

/** 1 while PlanarReflection renders the mirrored view (module singleton: one reflection pass at a time). */
export const REFL_PASS: { value: number } = { value: 0 };
/** 1 while ScenePass renders the opaque view into its MRT target (uBrMrt: the G-buffer split is written). */
export const MRT_PASS: { value: number } = { value: 0 };
/** World size of one pixel at unit view depth for the render in progress (chunks/vertex.ts WIRE_GLSL). */
export const WIRE_PX: { value: number } = { value: 0 };

/** Set WIRE_PX for rendering with `camera` into a target `heightPx` pixels high. */
export function setWirePixel(camera: THREE.Camera, heightPx: number): void {
  WIRE_PX.value = 2 / (camera.projectionMatrix.elements[5] * Math.max(1, heightPx));
}

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
    layerC: { value: t.c },
    layerD: { value: t.d },
    layerE: { value: t.e },
    detail: { value: textures.detail ?? null },
    reflPass: REFL_PASS,
    mrt: MRT_PASS,
    wirePx: WIRE_PX,
  };
}

/** Quality switches that change programs (defines). Owners: ssr/probe D; ssao/cs A; puddles, detail, pom, sheen,
 * coat, specAA B; water* and causticsFull E; volumetric/bounce F. applySurfaceDefines maps each to its define. */
export interface QualityDefines {
  floorRefl: boolean;
  airlight: boolean;
  lite: boolean;
  ssr: boolean;
  probe: boolean;
  ssao: boolean;
  cs: number; // contact-shadow steps (0 = off)
  puddles: boolean;
  detail: boolean;
  pom: number; // 0 | 1 | 2 (shell only)
  sheen: boolean;
  coat: boolean; // props clearcoat fields (never on lite)
  specAA: boolean;
  waterRefract: number; // refraction march steps of the split-frame water (0 = the legacy premultiplied water)
  waterWaves: number;
  waterRipple: boolean;
  waterDebris: boolean;
  causticsFull: boolean;
  waterVolLight: number; // in-water lights integrated (0 = off)
  volumetric: boolean;
  bounce: number; // flashlight bounce VPLs (0 = off)
}

export const qualityDefinesOf = (q: QualityConfig): QualityDefines => {
  const lite = q.shaderDetail === 'lite';
  const ssao = q.ao !== 'off';
  return {
    floorRefl: q.floorReflections,
    airlight: q.fogAirlight,
    lite,
    ssr: q.ssr !== 'off',
    probe: q.reflectionProbe > 0,
    ssao,
    cs: ssao ? q.contactShadowSteps : 0,
    puddles: q.wetPuddles,
    detail: q.detailMaps && !lite,
    pom: q.pom,
    sheen: q.clothSheen,
    coat: !lite,
    specAA: q.specularAA,
    waterRefract: q.colorPyramidScale > 0 ? Math.max(0, Math.round(q.waterRefractionSteps)) : 0,
    waterWaves: q.waterWaves,
    waterRipple: q.waterRippleRes > 0,
    waterDebris: q.waterDebris,
    causticsFull: q.waterCaustics === 'full',
    waterVolLight: q.waterVolumetrics,
    volumetric: q.volumetrics !== 'off',
    bounce: q.flashlightBounce,
  };
};

/** Short key tokens, in QualityDefines declaration order (after the R?A?L? prefix). */
const KEY_SHORTS: readonly (readonly [Exclude<keyof QualityDefines, 'floorRefl' | 'airlight' | 'lite'>, string])[] = [
  ['ssr', 'ssr'], ['probe', 'prb'], ['ssao', 'ao'], ['cs', 'cs'], ['puddles', 'pud'], ['detail', 'det'], ['pom', 'pom'],
  ['sheen', 'sh'], ['coat', 'cc'], ['specAA', 'saa'], ['waterRefract', 'wr'], ['waterWaves', 'ww'], ['waterRipple', 'wp'],
  ['waterDebris', 'wd'], ['causticsFull', 'wc'], ['waterVolLight', 'wv'], ['volumetric', 'vol'], ['bounce', 'fb'],
];

/** Canonical program key of a define set: the historic R?A?L? prefix, then '.' + short + value for every field that
 * is not false / 0 (true -> 1), so the keys of presets without the new features never change. */
export const definesKey = (d: QualityDefines): string => {
  let k = `R${d.floorRefl ? 1 : 0}A${d.airlight ? 1 : 0}L${d.lite ? 1 : 0}`;
  for (const [f, s] of KEY_SHORTS) {
    const v = d[f];
    if (v !== false && v !== 0) k += `.${s}${v === true ? 1 : v}`;
  }
  return k;
};
