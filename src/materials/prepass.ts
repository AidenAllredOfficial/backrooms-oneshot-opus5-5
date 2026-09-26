// src/materials/prepass.ts — render a scene with a depth prepass (post/ScenePass.ts: the main view;
// materials/PlanarReflection.ts: the mirrored view).
// The surface shader is expensive and three draws the opaque list by material (every tile has its own materials),
// so without a prepass many pixels are shaded more than once. The prepass draws every shell / props mesh with its
// tile's depth material (materials/DepthMaterial.ts: position only, the same fade dither, alpha test and
// reflection-pass props cull) and hides everything that never writes depth (soft decals, water, sparks). The shading
// pass then renders the scene as usual with depth writes locked off; the materials' LEQUAL test passes exactly the
// visible fragments, because the depth program reproduces the surface program's gl_Position (both `invariant`) and
// discards. The output is identical to a single pass.
// A spot-light shadow map updates inside the prepass render (if the renderer's autoUpdate allows it): the shading
// pass has depth writes locked off, which would also stop the shadow map's own clear and depth writes. Shadow casting
// only reads the swapped material's side and visibility, which the depth materials share with the surface materials
// (FrontSide, no shadowSide).

import type * as THREE from 'three';

/** false: single-pass rendering (A/B timing and image checks) */
export const PREPASS = { enabled: true };

// swap bookkeeping, reused every frame (cleared slot by slot, never shrunk, so no reallocation)
const swapped: (THREE.Mesh | null)[] = [];
const saved: (THREE.Material | THREE.Material[] | null)[] = [];
const hidden: (THREE.Object3D | null)[] = [];
let nSwapped = 0;
let nHidden = 0;

/** The depth material of a mesh's (first) material, if it takes part in the prepass. */
function depthOf(mat: THREE.Material | THREE.Material[] | undefined): THREE.Material | undefined {
  const m = Array.isArray(mat) ? mat[0] : mat;
  return m?.userData.brDepth as THREE.Material | undefined;
}

function toDepth(o: THREE.Object3D): void {
  const m = o as THREE.Mesh;
  if (!m.isMesh && !(o as THREE.Points).isPoints && !(o as THREE.Line).isLine && !(o as THREE.Sprite).isSprite) return;
  const depth = depthOf(m.material);
  if (depth) {
    swapped[nSwapped] = m;
    saved[nSwapped++] = m.material;
    m.material = depth;
  } else {
    hidden[nHidden++] = o;
    o.visible = false;
  }
}

function restore(): void {
  for (let i = 0; i < nSwapped; i++) {
    (swapped[i] as THREE.Mesh).material = saved[i] as THREE.Material | THREE.Material[];
    swapped[i] = null;
    saved[i] = null;
  }
  for (let i = 0; i < nHidden; i++) {
    (hidden[i] as THREE.Object3D).visible = true;
    hidden[i] = null;
  }
  nSwapped = 0;
  nHidden = 0;
}

/** Render `scene` into the current render target (already cleared: both renders run with autoClear off) with a
 * depth prepass. */
export function renderWithPrepass(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera): void {
  if (!PREPASS.enabled) { renderer.render(scene, camera); return; }
  const depthBuf = renderer.state.buffers.depth;
  const shadowAuto = renderer.shadowMap.autoUpdate;
  const autoClear = renderer.autoClear;
  renderer.autoClear = false;
  try {
    scene.traverseVisible(toDepth);
    renderer.render(scene, camera);
    restore();
    renderer.shadowMap.autoUpdate = false;
    depthBuf.setMask(false);
    depthBuf.setLocked(true);
    renderer.render(scene, camera);
  } finally {
    restore();
    depthBuf.setLocked(false);
    depthBuf.setMask(true);
    renderer.shadowMap.autoUpdate = shadowAuto;
    renderer.autoClear = autoClear;
  }
}
