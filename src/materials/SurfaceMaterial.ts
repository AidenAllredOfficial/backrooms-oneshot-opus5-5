// src/materials/SurfaceMaterial.ts — the surface material factory (shell / props / decal variants).
// Rules (§5 WP9): `new MeshStandardMaterial()` per call, never `.clone()` (Material.copy drops onBeforeCompile);
// onBeforeCompile puts the SHARED global uniform objects and the EXACT per-tile TileBindings objects into
// shader.uniforms (nothing copied by value); a constant customProgramCacheKey per (variant, quality defines);
// no map/normalMap/lightMap/aoMap, so three's USE_* paths stay off (USE_SHEEN / USE_CLEARCOAT come only from the
// quality defines below; their material fields are written by chunks/materialPost.ts).
// Graphics-realism packages plug in through stub chunk files with one owner each (A.0): screenspace, gbuffer (A);
// detail, pom, materialPost (B); emitters (C); probe (D); water (E); volumetric, bounce (F).

import * as THREE from 'three';
import { LENS_SHIMMER_GLSL } from '../core/flicker.ts';
import type { MaterialGlobals, TileBindings } from '../core/runtime.ts';
import { injectAt, SURFACE_INJECTIONS } from './anchors.ts';
import { VERT_INVARIANT_GLSL } from './DepthMaterial.ts';
import { BOUNCE_GLSL } from './chunks/bounce.ts';
import { fragmentCommon, HAZE_FUNCS_GLSL } from './chunks/common.ts';
import { DETAIL_PARS_GLSL } from './chunks/detail.ts';
import { EMITTER_GLSL } from './chunks/emitters.ts';
import { GBUFFER_PARS_GLSL } from './chunks/gbuffer.ts';
import { FRAG_FOG_GLSL } from './chunks/haze.ts';
import { FRAG_AO_REFL_GLSL, FRAG_LIGHTS_GLSL } from './chunks/lighting.ts';
import { FRAG_MATERIAL_POST_GLSL } from './chunks/materialPost.ts';
import { POM_PARS_GLSL } from './chunks/pom.ts';
import { PROBE_GLSL } from './chunks/probe.ts';
import { SCREENSPACE_GLSL } from './chunks/screenspace.ts';
import { VOLUMETRIC_GLSL } from './chunks/volumetric.ts';
import { WATER_SPOT_GLSL, WATER_SURF_GLSL } from './chunks/water.ts';
import {
  FRAG_EMISSIVE_GLSL, FRAG_MAIN_START_GLSL, FRAG_MAP_GLSL, FRAG_METALNESS_GLSL, FRAG_NORMAL_GLSL, FRAG_ROUGHNESS_GLSL,
  SURFACE_PARS_GLSL,
} from './chunks/surface.ts';
import { FRAG_VARYINGS_GLSL, VERT_BEGIN_GLSL, VERT_PARS_GLSL, VERT_UV_GLSL, VERT_WORLDPOS_GLSL, WIRE_GLSL } from './chunks/vertex.ts';
import { definesKey } from './shared.ts';
import type { QualityDefines, SharedUniforms } from './shared.ts';

export type SurfaceVariant = 'shell' | 'props' | 'decal';
export const SURFACE_VARIANTS: readonly SurfaceVariant[] = ['shell', 'props', 'decal'];
export const CACHE_KEY_PREFIX = 'br-surface-v1';

/** Code per injection point (keyed `${stage}:${include}`), exactly the SURFACE_INJECTIONS plan. */
function injectionCode(): Record<string, string> {
  return {
    'vertex:common': VERT_INVARIANT_GLSL + VERT_PARS_GLSL + WIRE_GLSL,
    'vertex:uv_vertex': VERT_UV_GLSL,
    'vertex:begin_vertex': VERT_BEGIN_GLSL,
    'vertex:worldpos_vertex': VERT_WORLDPOS_GLSL,
    'fragment:common': fragmentCommon() + SURFACE_PARS_GLSL + FRAG_VARYINGS_GLSL
      + SCREENSPACE_GLSL + GBUFFER_PARS_GLSL // A
      + DETAIL_PARS_GLSL + POM_PARS_GLSL // B
      + EMITTER_GLSL // C
      + PROBE_GLSL // D
      + WATER_SURF_GLSL // E
      + VOLUMETRIC_GLSL + BOUNCE_GLSL, // F
    'fragment:clipping_planes_pars_fragment': LENS_SHIMMER_GLSL + HAZE_FUNCS_GLSL + WATER_SPOT_GLSL,
    'fragment:clipping_planes_fragment': FRAG_MAIN_START_GLSL,
    'fragment:map_fragment': FRAG_MAP_GLSL,
    'fragment:roughnessmap_fragment': FRAG_ROUGHNESS_GLSL,
    'fragment:metalnessmap_fragment': FRAG_METALNESS_GLSL,
    'fragment:normal_fragment_maps': FRAG_NORMAL_GLSL,
    'fragment:emissivemap_fragment': FRAG_EMISSIVE_GLSL,
    'fragment:lights_physical_fragment': FRAG_MATERIAL_POST_GLSL,
    'fragment:lights_fragment_maps': FRAG_LIGHTS_GLSL,
    'fragment:aomap_fragment': FRAG_AO_REFL_GLSL,
    'fragment:fog_fragment': FRAG_FOG_GLSL,
  };
}

let codeCache: Record<string, string> | null = null;
const vertCache = new Map<string, string>();
const fragCache = new Map<string, string>();

/** Apply the vertex-stage injections to three's meshphysical vertex source (memoised). */
export function buildSurfaceVertex(src: string): string {
  let out = vertCache.get(src);
  if (out === undefined) {
    codeCache ??= injectionCode();
    out = src;
    for (const a of SURFACE_INJECTIONS) if (a.stage === 'vertex') out = injectAt(out, a.include, codeCache[`vertex:${a.include}`], a.mode);
    vertCache.set(src, out);
  }
  return out;
}

/** Apply the fragment-stage injections (identical text for every variant; the variant is a #define). */
export function buildSurfaceFragment(src: string): string {
  let out = fragCache.get(src);
  if (out === undefined) {
    codeCache ??= injectionCode();
    out = src;
    for (const a of SURFACE_INJECTIONS) if (a.stage === 'fragment') out = injectAt(out, a.include, codeCache[`fragment:${a.include}`], a.mode);
    fragCache.set(src, out);
  }
  return out;
}

/** Put the shared global objects and the exact per-tile binding objects into a uniforms map (by reference). */
export function bindUniforms(u: Record<string, THREE.IUniform>, g: MaterialGlobals, s: SharedUniforms, b: TileBindings): void {
  u.uTime = g.time;
  u.uDebugView = g.debugView;
  u.uHazeDensity = g.hazeDensity;
  u.uHazeTint = g.hazeTint;
  u.uHazeAlbedo = g.hazeAlbedo;
  u.uEdgeFog = g.edgeFog;
  u.uFarColor = g.farColor;
  u.uFlickerMode = g.flickerMode;
  u.uReflTex = g.reflTex;
  u.uReflMatrix = g.reflMatrix;
  u.uReflOn = g.reflOn;
  u.uReflY = g.reflY;
  u.uFloorReflOn = g.floorReflOn;
  u.uBrProbe = g.probeTex;
  u.uBrProbeOn = g.probeOn;
  u.uBrProbeLod = g.probeLod;
  u.uBrProbeMin = g.probeMin;
  u.uBrProbeMax = g.probeMax;
  u.uBrProbePos = g.probePos;
  u.uSceneColor = g.sceneColor;
  u.uSceneInvSize = g.sceneInvSize;
  u.uWaterVolOn = g.waterVolOn;
  u.uHiZ = g.hiZ;
  u.uHiZInfo = g.hiZInfo;
  u.uSsaoTex = g.ssaoTex;
  u.uSsaoP = g.ssaoParams;
  u.uSsaoProj = g.ssaoProj;
  u.uSsaoSize = g.ssaoSize;
  u.uCsOn = g.csOn;
  u.uVolTex = g.volTex;
  u.uVolGrid = g.volGrid;
  u.uVolZ = g.volZ;
  u.uVolScreen = g.volScreen;
  u.uFbOn = g.fbOn;
  u.uFbP = g.fbP;
  u.uFbN = g.fbN;
  u.uFbC = g.fbC;
  u.uFbBox = g.fbBox;
  u.uRipple = g.ripple;
  u.uRippleOrigin = g.rippleOrigin;
  u.uRippleSpan = g.rippleSpan;
  u.uRipplePlane = g.ripplePlane;
  u.uRippleOn = g.rippleOn;
  u.uDrips = g.drips;
  u.uNDrips = g.nDrips;
  u.uUwPos = g.uwPos;
  u.uUwDir = g.uwDir;
  u.uUwCol = g.uwCol;
  u.uNUw = g.nUw;
  u.uBrReflPass = s.reflPass;
  u.uBrMrt = s.mrt;
  u.uBrWirePx = s.wirePx;
  u.uBrAlbedo = s.albedo;
  u.uBrNormal = s.normal;
  u.uBrOrmh = s.ormh;
  u.uBrGrime = s.grime;
  u.uBrWaterNormals = s.waterNormals;
  u.uBrLayerA = s.layerA;
  u.uBrLayerB = s.layerB;
  u.uBrLayerC = s.layerC;
  u.uBrLayerD = s.layerD;
  u.uBrLayerE = s.layerE;
  u.uBrDetail = s.detail;
  u.uTileOrigin = b.tileOrigin;
  u.uNoiseOrigin = b.noiseOrigin;
  u.uLmIrr = b.lmIrr;
  u.uLmDir = b.lmDir;
  u.uLmMask = b.lmMask;
  u.uLmFlick = b.lmFlick;
  u.uEmission = b.emission;
  u.uVolA = b.volA;
  u.uVolB = b.volB;
  u.uVolC = b.volC;
  u.uVolMask = b.volMask;
  u.uFlick = b.flick;
  u.uOwnParity = b.ownParity;
  u.uFade = b.fade;
  u.uTileWater = b.water;
}

/** Variant + quality defines (material.defines is part of three's program key; so is the custom key). Every
 * QualityDefines field maps to exactly one define here (water: WaterMaterial.applyWaterDefines). */
export function applySurfaceDefines(m: THREE.Material, variant: SurfaceVariant, d: QualityDefines): void {
  const defs: Record<string, string> = {};
  if (variant === 'shell') defs.BR_SHELL = '';
  if (variant === 'props') { defs.BR_PROPS = ''; defs.BR_LV = ''; }
  if (variant === 'decal') defs.BR_DECAL = '';
  if (d.floorRefl) defs.BR_FLOOR_REFL = '';
  if (d.airlight) defs.BR_AIRLIGHT = '';
  if (d.lite) defs.BR_LITE = '';
  if (d.ssr) defs.BR_SSR = '';
  if (d.probe) defs.BR_PROBE = '';
  if (d.ssao) defs.BR_SSAO = '';
  if (d.cs > 0) defs.BR_CS_STEPS = String(d.cs);
  if (d.puddles) defs.BR_PUDDLES = '';
  if (d.detail) defs.BR_DETAIL_MAPS = '';
  if (d.pom > 0 && variant === 'shell') defs.BR_POM = String(d.pom);
  if (d.sheen) defs.USE_SHEEN = '';
  if (d.coat && variant === 'props') defs.USE_CLEARCOAT = '';
  if (d.specAA) defs.BR_SPEC_AA = '';
  if (d.waterRefract) defs.BR_WATER_VOL = '';
  if (d.waterDebris) defs.BR_WATER_WETBAND = '';
  if (d.causticsFull) defs.BR_CAUSTICS_FULL = '';
  if (d.volumetric) defs.BR_VOLUMETRIC = '';
  if (d.bounce > 0) defs.BR_BOUNCE_N = String(d.bounce);
  m.defines = defs;
  if (variant === 'decal') {
    // SSR: the decal's att1 write (0, 0, 0, coverage) scales the specular weight below it by (1 - coverage); rgb
    // blending (premultiplied One, OneMinusSrcAlpha) is unchanged
    m.blendSrcAlpha = d.ssr ? THREE.ZeroFactor : null;
    m.blendDstAlpha = d.ssr ? THREE.OneMinusSrcAlphaFactor : null;
    m.blendEquationAlpha = d.ssr ? THREE.AddEquation : null;
  }
  m.userData.brKey = `${CACHE_KEY_PREFIX}|${variant}|${definesKey(d)}`;
  m.needsUpdate = true;
}

// The flashlight must be shadowed on every surface we shade (a spot light outside its shadow test lights
// surfaces through walls); tile meshes are created by WP10, so the material enforces receiveShadow itself.
function forceReceiveShadow(this: THREE.Material, _r: THREE.WebGLRenderer, _s: THREE.Scene, _c: THREE.Camera, _g: THREE.BufferGeometry, object: THREE.Object3D): void {
  if (!object.receiveShadow) object.receiveShadow = true;
}

export function createSurfaceMaterial(variant: SurfaceVariant, g: MaterialGlobals, s: SharedUniforms, b: TileBindings, d: QualityDefines): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0, color: 0xffffff });
  m.name = `br-${variant}`;
  m.side = THREE.FrontSide;
  m.transparent = false;
  m.userData.brVariant = variant;
  if (variant === 'decal') {
    m.blending = THREE.CustomBlending;
    m.blendEquation = THREE.AddEquation;
    m.blendSrc = THREE.OneFactor;
    m.blendDst = THREE.OneMinusSrcAlphaFactor;
    m.depthWrite = false;
    m.polygonOffset = true;
    m.polygonOffsetFactor = -1;
    m.polygonOffsetUnits = -4;
  }
  applySurfaceDefines(m, variant, d);
  m.onBeforeCompile = (shader) => {
    bindUniforms(shader.uniforms, g, s, b);
    shader.vertexShader = buildSurfaceVertex(shader.vertexShader);
    shader.fragmentShader = buildSurfaceFragment(shader.fragmentShader);
  };
  m.customProgramCacheKey = () => m.userData.brKey as string;
  m.onBeforeRender = forceReceiveShadow as THREE.Material['onBeforeRender'];
  return m;
}
