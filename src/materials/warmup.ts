// src/materials/warmup.ts — compile AND draw every material variant with the real scene's light/shadow state.
// The program cache key includes the output colour space (linear for any render target) and the light/shadow
// state, so the warmup renders into a HalfFloat target inside the REAL scene (flashlight present). ANGLE builds
// pipelines at first draw, hence one real draw after compileAsync. The flashlight is set to intensity 0 with
// castShadow = true and shadow.needsUpdate = true so the spot-shadow depth program is built too. The warmup
// materials stay pinned for the app's lifetime (releaseProgram would destroy a program when its last user —
// e.g. the last water tile — is disposed).
// Dev / QA builds then check each variant's linked program against the 16-unit surface sampler budget (the
// static twin is tests/materials/samplerBudget.test.ts): an overrun is a console error, which fails headless QA.

import * as THREE from 'three';
import type { TileMaterials } from '../core/runtime.ts';

/** Texture units one surface / water program may use: the WebGL2 minimum MAX_TEXTURE_IMAGE_UNITS, and exactly what
 * ANGLE on D3D11 and Metal expose. A new surface sampler requires removing one. */
export const SURFACE_SAMPLER_BUDGET = 16;

const SAMPLER_TYPES = new Set<number>([
  0x8b5e, 0x8b5f, 0x8b60, 0x8b62, // SAMPLER_2D, SAMPLER_3D, SAMPLER_CUBE, SAMPLER_2D_SHADOW
  0x8dc1, 0x8dc4, 0x8dc5, // SAMPLER_2D_ARRAY, SAMPLER_2D_ARRAY_SHADOW, SAMPLER_CUBE_SHADOW
  0x8dca, 0x8dcb, 0x8dcc, 0x8dcf, // INT_SAMPLER_2D, _3D, _CUBE, _2D_ARRAY
  0x8dd2, 0x8dd3, 0x8dd4, 0x8dd7, // UNSIGNED_INT_SAMPLER_2D, _3D, _CUBE, _2D_ARRAY
]);

/** Texture units used by the linked program three built for `m` (active sampler uniforms, array elements counted
 * one by one); -1 before the material has a program. */
export function activeSamplerUnits(renderer: THREE.WebGLRenderer, m: THREE.Material): number {
  const prog = (renderer.properties.get(m) as { currentProgram?: { program?: WebGLProgram } }).currentProgram?.program;
  if (!prog) return -1;
  const gl = renderer.getContext();
  const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS) as number;
  let units = 0;
  for (let i = 0; i < n; i++) {
    const u = gl.getActiveUniform(prog, i);
    if (u && SAMPLER_TYPES.has(u.type)) units += u.size;
  }
  return units;
}

/** One triangle carrying every attribute the surface/water shaders declare (types as in stream/geometry.ts). */
export function createWarmupGeometry(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, 0, 0.1, 0, 0, 0, 0, 0.1]), 3));
  g.setAttribute('normal', new THREE.BufferAttribute(new Int8Array([0, 127, 0, 0, 0, 127, 0, 0, 0, 127, 0, 0]), 4, true));
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(6), 2));
  g.setAttribute('brLmUv', new THREE.BufferAttribute(new Float32Array(6), 2));
  g.setAttribute('brLayer', new THREE.BufferAttribute(new Uint8Array(3), 1));
  g.setAttribute('brFlags', new THREE.BufferAttribute(new Uint8Array(3), 1));
  g.setAttribute('brTint', new THREE.BufferAttribute(new Uint8Array(12).fill(255), 4, true));
  g.setAttribute('brEmit', new THREE.BufferAttribute(new Float32Array(3), 1));
  g.setAttribute('brAux', new THREE.BufferAttribute(new Uint8Array(12), 4, true));
  g.setIndex(new THREE.BufferAttribute(new Uint32Array([0, 2, 1]), 1));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1);
  return g;
}

export async function runWarmup(renderer: THREE.WebGLRenderer, camera: THREE.Camera, scene: THREE.Scene, pinned: TileMaterials): Promise<void> {
  const geo = createWarmupGeometry();
  const group = new THREE.Group();
  group.name = 'br-warmup';
  // the (+y facing) triangle turned to face the camera and placed 1 m ahead so that it covers the centre pixel of
  // the 1x1 target: the real draw then rasterises every variant (a horizontal triangle at eye level is edge-on)
  camera.updateMatrixWorld();
  const facing = new THREE.Quaternion().setFromRotationMatrix(camera.matrixWorld)
    .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2));
  const ahead = new THREE.Vector3(-0.03, 0.03, -1).applyMatrix4(camera.matrixWorld);
  const mats: THREE.Material[] = [pinned.shell, pinned.props, pinned.decal];
  if (pinned.water) mats.push(pinned.water);
  mats.push(pinned.depth); // the depth-prepass program (materials/prepass.ts); depthProps shares it
  for (const m of mats) {
    const mesh = new THREE.Mesh(geo, m);
    mesh.frustumCulled = false;
    const variant = m.userData.brVariant as string;
    mesh.castShadow = variant === 'shell' || variant === 'props';
    mesh.receiveShadow = true;
    if (variant === 'decal') mesh.renderOrder = 1;
    mesh.position.copy(ahead);
    mesh.quaternion.copy(facing);
    group.add(mesh);
  }

  // flashlight(s): dark but shadow-casting for the warmup frames
  const spots: { l: THREE.SpotLight; intensity: number; cast: boolean }[] = [];
  scene.traverse((o) => {
    const l = o as THREE.SpotLight;
    if (l.isSpotLight) spots.push({ l, intensity: l.intensity, cast: l.castShadow });
  });
  for (const s of spots) {
    s.l.intensity = 0;
    s.l.castShadow = true;
    s.l.shadow.needsUpdate = true;
  }

  const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: true });
  const prevRT = renderer.getRenderTarget();
  scene.add(group);
  try {
    renderer.setRenderTarget(rt);
    // compileAsync compiles synchronously, then polls on timers: the app's frames keep rendering meanwhile, and must
    // not draw the warmup triangles (1 m ahead of the eye; the water one on layer 0 would also land in the MRT
    // sceneRT of a split frame, which it has no outputs for: GL_INVALID_OPERATION). Hidden while waiting, shown again
    // for the real draw right below (no frame can run in between).
    const compiled = renderer.compileAsync(scene, camera);
    group.visible = false;
    await compiled;
    group.visible = true;
    renderer.setRenderTarget(rt);
    renderer.render(scene, camera);
    if (import.meta.env.DEV) {
      for (const m of mats) {
        const n = activeSamplerUnits(renderer, m);
        if (n > SURFACE_SAMPLER_BUDGET) console.error(`surface sampler budget: ${m.name} uses ${n} texture units (max ${SURFACE_SAMPLER_BUDGET})`);
      }
    }
  } finally {
    renderer.setRenderTarget(prevRT);
    scene.remove(group);
    for (const s of spots) {
      s.l.intensity = s.intensity;
      s.l.castShadow = s.cast;
    }
    rt.dispose();
    geo.dispose();
  }
}

// ---------------------------------------------------------------- post-pass warmup (R2 B9)

/** Shader materials reachable from post passes (pmndrs passes / effects / their internal passes and materials):
 * a bounded walk of their own properties that never enters scenes, cameras, renderers, textures or targets. */
export function collectPassMaterials(roots: readonly object[]): THREE.ShaderMaterial[] {
  const out = new Set<THREE.ShaderMaterial>();
  const seen = new Set<object>();
  const walk = (o: unknown, depth: number): void => {
    if (o === null || typeof o !== 'object' || depth > 5 || seen.has(o)) return;
    seen.add(o);
    if (o instanceof THREE.Material) {
      if ((o as THREE.ShaderMaterial).isShaderMaterial) out.add(o as THREE.ShaderMaterial);
      return;
    }
    if (o instanceof THREE.Mesh) { walk(o.material, depth + 1); return; }
    if (o instanceof THREE.Object3D || o instanceof THREE.WebGLRenderer || o instanceof THREE.Texture ||
      o instanceof THREE.RenderTarget || o instanceof THREE.BufferGeometry || ArrayBuffer.isView(o)) return;
    if (Array.isArray(o)) { for (const v of o) walk(v, depth + 1); return; }
    if (o instanceof Map || o instanceof Set) { for (const v of o.values()) walk(v, depth + 1); return; }
    for (const v of Object.values(o as Record<string, unknown>)) walk(v, depth + 1);
  };
  for (const r of roots) walk(r, 0);
  return [...out];
}

/** Compile (KHR_parallel_shader_compile, without blocking the main thread) the programs of freshly created post
 * passes with a HalfFloat target bound like the real passes (the program key includes the output colour space). Callers keep the passes disabled until this resolves, so the frame loop never links them synchronously
 * (the ~100-330 ms hitch of a runtime quality switch). */
export async function warmPassMaterials(renderer: THREE.WebGLRenderer, materials: readonly THREE.ShaderMaterial[]): Promise<void> {
  if (materials.length === 0) return;
  const scene = new THREE.Scene();
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 10);
  for (const m of materials) {
    const mesh = new THREE.Mesh(geo, m);
    mesh.frustumCulled = false;
    scene.add(mesh);
  }
  const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
  const prevRT = renderer.getRenderTarget();
  try {
    renderer.setRenderTarget(rt);
    // compile only: no draw (pass materials get some array uniforms, e.g. AO sample kernels, at their first render)
    await renderer.compileAsync(scene, cam);
  } finally {
    renderer.setRenderTarget(prevRT);
    rt.dispose();
    geo.dispose();
  }
}
