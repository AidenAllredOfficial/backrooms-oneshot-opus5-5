// src/materials/prepass.ts — render a scene with a depth prepass (post/ScenePass.ts: the main view, the frame graph;
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
// Frame-graph options (ScenePass only; PlanarReflection passes none): `afterDepth` runs between the two renders, when
// the depth is complete and the shadow map updated (pre-shade SSAO and the other depth hooks); `excludeLayer` then
// names a layer the shading render skips (LAYER_LATE on split frames: water, sparks and motes are drawn later, over
// the opaque colour copy). With options, the prepass also records whether a hidden LAYER_LATE mesh is in view.

import * as THREE from 'three';
import { LAYER_LATE } from './shared.ts';

/** false: single-pass rendering (A/B timing and image checks) */
export const PREPASS = { enabled: true };

export interface PrepassOptions {
  /** After the depth render (materials restored, shadow map updated, shadow auto-update already off) and before
   * shading. Hooks may bind their own targets: the callback must rebind the caller's target before it returns. */
  afterDepth?: () => void;
  /** Read after afterDepth: a layer the shading render leaves out (camera.layers is restored afterwards). */
  excludeLayer?: () => number | undefined;
}

/** Whether the last renderWithPrepass call WITH options hid a LAYER_LATE mesh (non-empty draw range) whose world
 * bounding sphere intersects the view frustum, for a camera that renders LAYER_LATE. Always false when the prepass
 * is disabled. */
export const PREPASS_LATE = { visible: false };

// swap bookkeeping, reused every frame (cleared slot by slot, never shrunk, so no reallocation)
const swapped: (THREE.Mesh | null)[] = [];
const saved: (THREE.Material | THREE.Material[] | null)[] = [];
const hidden: (THREE.Object3D | null)[] = [];
let nSwapped = 0;
let nHidden = 0;
let trackLate = false;
const lateBit = 1 << LAYER_LATE;
const frustum = new THREE.Frustum();
const viewProj = new THREE.Matrix4();

/** The depth material of a mesh's (first) material, if it takes part in the prepass. */
function depthOf(mat: THREE.Material | THREE.Material[] | undefined): THREE.Material | undefined {
  const m = Array.isArray(mat) ? mat[0] : mat;
  return m?.userData.brDepth as THREE.Material | undefined;
}

/** A hidden late-layer object that would draw something inside the frustum. */
function lateInView(o: THREE.Object3D): boolean {
  if ((o.layers.mask & lateBit) === 0) return false;
  const g = (o as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
  if (!g || g.drawRange.count <= 0) return false; // e.g. idle sparks
  return !o.frustumCulled || frustum.intersectsObject(o);
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
    if (trackLate && !PREPASS_LATE.visible && lateInView(o)) PREPASS_LATE.visible = true;
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
export function renderWithPrepass(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, opts?: PrepassOptions): void {
  const layerMask = camera.layers.mask;
  if (!PREPASS.enabled) {
    // single pass: the hooks see the cleared depth (no occlusion, no contact shadows) and nothing is split off
    if (opts) PREPASS_LATE.visible = false;
    try {
      opts?.afterDepth?.();
      const ex = opts?.excludeLayer?.();
      if (ex !== undefined) camera.layers.disable(ex);
      renderer.render(scene, camera);
    } finally {
      camera.layers.mask = layerMask;
    }
    return;
  }
  const depthBuf = renderer.state.buffers.depth;
  const shadowAuto = renderer.shadowMap.autoUpdate;
  const autoClear = renderer.autoClear;
  renderer.autoClear = false;
  try {
    if (opts) PREPASS_LATE.visible = false;
    // a camera without the late layer never draws those meshes, so they cannot ask for a split
    trackLate = opts !== undefined && (camera.layers.mask & lateBit) !== 0;
    if (trackLate) {
      // three's render does the same update first (idempotent)
      if (camera.parent === null && camera.matrixWorldAutoUpdate) camera.updateMatrixWorld();
      frustum.setFromProjectionMatrix(viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    }
    scene.traverseVisible(toDepth);
    renderer.render(scene, camera);
    restore();
    renderer.shadowMap.autoUpdate = false;
    if (opts) {
      opts.afterDepth?.();
      const ex = opts.excludeLayer?.();
      if (ex !== undefined) camera.layers.disable(ex);
    }
    depthBuf.setMask(false);
    depthBuf.setLocked(true);
    renderer.render(scene, camera);
  } finally {
    trackLate = false;
    restore();
    camera.layers.mask = layerMask;
    depthBuf.setLocked(false);
    depthBuf.setMask(true);
    renderer.shadowMap.autoUpdate = shadowAuto;
    renderer.autoClear = autoClear;
  }
}
