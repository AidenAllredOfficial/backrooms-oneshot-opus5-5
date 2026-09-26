// src/materials/MaterialSystem.ts — tile material factory (WP9).
// Fresh materials + fresh uniform objects per tile (never Material.clone()), shared global uniform objects,
// the exact TileBindings objects placed in shader.uniforms, one program per variant (constant cache key),
// debug views as an int uniform, quality defines applied only in setQuality (then warmup again), and pinned
// warmup materials so the program set stays constant for the app's lifetime.

import * as THREE from 'three';
import type { MaterialGlobals, MaterialSystem, TextureSet, TileBindings, TileMaterials } from '../core/runtime.ts';
import type { QualityConfig } from '../core/quality.ts';
import { applySurfaceDefines, createSurfaceMaterial } from './SurfaceMaterial.ts';
import type { SurfaceVariant } from './SurfaceMaterial.ts';
import { applyWaterDefines, createWaterMaterial } from './WaterMaterial.ts';
import { createDepthMaterial } from './DepthMaterial.ts';
import { createSharedUniforms, qualityDefinesOf } from './shared.ts';
import type { QualityDefines } from './shared.ts';
import { createZeroTextures } from './zeroTextures.ts';
import { runWarmup } from './warmup.ts';

export function createGlobals(): MaterialGlobals {
  return {
    time: { value: 0 },
    debugView: { value: 0 },
    hazeDensity: { value: 0 },
    hazeTint: { value: new THREE.Color(1, 1, 1) },
    hazeAlbedo: { value: 0 },
    edgeFog: { value: new THREE.Vector2(1e5, 2e5) },
    farColor: { value: new THREE.Color(0, 0, 0) },
    flickerMode: { value: 0 },
    reflTex: { value: null },
    reflMatrix: { value: new THREE.Matrix4() },
    reflOn: { value: 0 },
    reflY: { value: 0 },
    floorReflOn: { value: 0 },
  };
}

export function createMaterialSystem(renderer: THREE.WebGLRenderer, textures: TextureSet, q: QualityConfig): MaterialSystem {
  void renderer;
  const globals = createGlobals();
  const zeroTextures = createZeroTextures();
  const shared = createSharedUniforms(textures);
  let defs: QualityDefines = qualityDefinesOf(q);
  globals.floorReflOn.value = q.floorReflections ? 1 : 0;
  /** every live material (tile + pinned), so setQuality can re-define them */
  const live = new Set<THREE.Material>();
  let pinned: TileMaterials | null = null;

  function createBindings(): TileBindings {
    const z2 = zeroTextures.lm2d;
    const z3 = zeroTextures.vol3d;
    return {
      tileOrigin: { value: new THREE.Vector3() },
      noiseOrigin: { value: new THREE.Vector3() },
      lmIrr: { value: z2 }, lmDir: { value: z2 }, lmMask: { value: z2 },
      lmFlick: { value: z2 },
      emission: { value: z2 },
      volA: { value: z3 }, volB: { value: z3 }, volC: { value: z3 },
      volMask: { value: z2 },
      flick: { value: new Float32Array(27) },
      ownParity: { value: new THREE.Vector2() },
      fade: { value: 1 },
    };
  }

  function createTileMaterials(withWater: boolean): TileMaterials {
    const bindings = createBindings();
    const shell = createSurfaceMaterial('shell', globals, shared, bindings, defs);
    const props = createSurfaceMaterial('props', globals, shared, bindings, defs);
    const decal = createSurfaceMaterial('decal', globals, shared, bindings, defs);
    const water: THREE.ShaderMaterial | null = withWater ? createWaterMaterial(globals, shared, bindings, defs) : null;
    const depth = createDepthMaterial(shared, bindings, false);
    const depthProps = createDepthMaterial(shared, bindings, true);
    // materials/prepass.ts swaps meshes carrying brDepth to it for the depth prepass
    shell.userData.brDepth = depth;
    props.userData.brDepth = depthProps;
    live.add(shell); live.add(props); live.add(decal);
    if (water) live.add(water);
    let disposed = false;
    return {
      shell, props, decal, water, depth, depthProps, bindings,
      dispose() {
        if (disposed) return;
        disposed = true;
        depth.dispose();
        depthProps.dispose();
        for (const m of [shell, props, decal, water]) {
          if (!m) continue;
          live.delete(m);
          m.dispose();
        }
      },
    };
  }

  return {
    globals,
    zeroTextures,
    createTileMaterials,
    setDebugView(v: number): void {
      globals.debugView.value = Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0;
    },
    setQuality(nq: QualityConfig): void {
      globals.floorReflOn.value = nq.floorReflections ? 1 : 0;
      const nd = qualityDefinesOf(nq);
      if (nd.floorRefl === defs.floorRefl && nd.airlight === defs.airlight) return;
      defs = nd;
      for (const m of live) {
        const variant = m.userData.brVariant as SurfaceVariant | 'water';
        if (variant === 'water') applyWaterDefines(m as THREE.ShaderMaterial, defs);
        else applySurfaceDefines(m, variant, defs);
      }
    },
    async warmup(r: THREE.WebGLRenderer, camera: THREE.Camera, scene: THREE.Scene): Promise<void> {
      pinned ??= createTileMaterials(true); // pinned for the app's lifetime (never disposed)
      await runWarmup(r, camera, scene, pinned);
    },
  };
}
