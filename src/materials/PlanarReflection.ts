// src/materials/PlanarReflection.ts — mirrored view of the water plane nearest the camera (WP9).
// A proper-rotation reflection camera about y = waterY with Lengyel's oblique near-plane clip (the maths of
// three's Reflector.js), rendered at q.planarReflectionScale of the drawing buffer into a HalfFloat target with
// mipmaps (roughness-blurred lookups). Publishes globals.reflTex / reflMatrix / reflOn / reflY.
// reflMatrix maps MAIN-camera VIEW-space positions to reflection-texture clip coords (bias · P' · V' · V⁻¹,
// composed in float64 on the CPU), so shaders never need a float32 world position.
// While rendering: reflOn = 0 and reflTex = null (no feedback loop, not even a bound-but-unsampled texture), the
// module-private reflection-pass flag is 1 (props beyond 20 m and water surfaces discard), shadow maps are
// not re-rendered. The mirrored view is rendered with the depth prepass (materials/prepass.ts).
// Where the water is the mirror's only reader (mirrorWaterOnly: high / ultra), it is rendered only while a water
// draw passed the depth test lately (water/waterVisibility.ts occlusion queries): the plane scan does not see walls.

import * as THREE from 'three';
import type { MaterialGlobals } from '../core/runtime.ts';
import type { QualityConfig } from '../core/quality.ts';
import { REFL_PASS, setWirePixel } from './shared.ts';
import { TUNE } from './chunks/params.ts';
import { renderWithPrepass } from './prepass.ts';
import { WATER_VIS } from './water/waterVisibility.ts';

export interface PlanarReflection {
  readonly enabled: boolean;
  /** render the mirrored view if a water plane is visible within 40 m; binds globals.reflTex/reflMatrix/reflOn */
  update(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, waterY: number | null): void;
  setQuality(q: QualityConfig): void;
  dispose(): void;
}

const CLIP_BIAS = 0.003;
const MIN_CAMERA_CLEARANCE = 0.02; // m above the plane; below it the mirror is not rendered

/** Build the reflection camera for a horizontal mirror at y = planeY (pure maths, exported for tests). */
export function setupReflectionCamera(camera: THREE.PerspectiveCamera, planeY: number, out: THREE.PerspectiveCamera, scratch: ReflScratch): void {
  camera.updateMatrixWorld();
  const { camPos, dir, target, up, plane, clip, q } = scratch;
  camPos.setFromMatrixPosition(camera.matrixWorld);
  // mirror the eye, the look-at target and the up vector about y = planeY
  out.position.set(camPos.x, 2 * planeY - camPos.y, camPos.z);
  camera.getWorldDirection(dir);
  target.copy(camPos).add(dir);
  target.y = 2 * planeY - target.y;
  up.setFromMatrixColumn(camera.matrixWorld, 1).normalize();
  up.y = -up.y;
  out.up.copy(up);
  out.lookAt(target);
  out.far = camera.far;
  out.near = camera.near;
  out.updateMatrixWorld();
  out.matrixWorldInverse.copy(out.matrixWorld).invert();
  out.projectionMatrix.copy(camera.projectionMatrix);
  out.projectionMatrixInverse.copy(camera.projectionMatrixInverse);
  out.layers.mask = camera.layers.mask;
  // oblique near plane = the mirror plane (Lengyel), in reflection-camera view space
  plane.set(scratch.nrm.set(0, 1, 0), -planeY);
  plane.applyMatrix4(out.matrixWorldInverse);
  clip.set(plane.normal.x, plane.normal.y, plane.normal.z, plane.constant);
  const e = out.projectionMatrix.elements;
  q.x = (Math.sign(clip.x) + e[8]) / e[0];
  q.y = (Math.sign(clip.y) + e[9]) / e[5];
  q.z = -1.0;
  q.w = (1.0 + e[10]) / e[14];
  clip.multiplyScalar(2.0 / clip.dot(q));
  e[2] = clip.x;
  e[6] = clip.y;
  e[10] = clip.z + 1.0 - CLIP_BIAS;
  e[14] = clip.w;
  out.projectionMatrixInverse.copy(out.projectionMatrix).invert();
}

export interface ReflScratch {
  camPos: THREE.Vector3; dir: THREE.Vector3; target: THREE.Vector3; up: THREE.Vector3; nrm: THREE.Vector3;
  plane: THREE.Plane; clip: THREE.Vector4; q: THREE.Vector4; m: THREE.Matrix4; size: THREE.Vector2;
}
export function createReflScratch(): ReflScratch {
  return {
    camPos: new THREE.Vector3(), dir: new THREE.Vector3(), target: new THREE.Vector3(), up: new THREE.Vector3(),
    nrm: new THREE.Vector3(), plane: new THREE.Plane(), clip: new THREE.Vector4(), q: new THREE.Vector4(),
    m: new THREE.Matrix4(), size: new THREE.Vector2(),
  };
}

/** out = bias · P' (unclipped) · V' · V⁻¹ : main-camera view space -> reflection texture (xy/w in 0..1). */
export function reflectionTextureMatrix(camera: THREE.Camera, refl: THREE.PerspectiveCamera, unclippedProj: THREE.Matrix4, out: THREE.Matrix4): void {
  out.set(
    0.5, 0.0, 0.0, 0.5,
    0.0, 0.5, 0.0, 0.5,
    0.0, 0.0, 0.5, 0.5,
    0.0, 0.0, 0.0, 1.0,
  );
  out.multiply(unclippedProj);
  out.multiply(refl.matrixWorldInverse);
  out.multiply(camera.matrixWorld); // V⁻¹ (camera.matrixWorld is float64 on the CPU)
}

/** Whether the water is the mirror's only reader: the SSR and froxel presets compile the floors' planar path out
 * (chunks/lighting.ts), so the mirror may wait for a visible water pixel (water/waterVisibility.ts). */
export const mirrorWaterOnly = (q: QualityConfig): boolean => q.ssr !== 'off' || q.volumetrics !== 'off';

/** `waterVisible`: the occlusion gate's answer (tests inject their own; the app polls WATER_VIS on the renderer's
 * context). */
export function createPlanarReflection(globals: MaterialGlobals, q: QualityConfig,
  waterVisible: (renderer: THREE.WebGLRenderer) => boolean = (r) => WATER_VIS.poll(r.getContext() as WebGL2RenderingContext)): PlanarReflection {
  let scale = q.planarReflectionScale;
  WATER_VIS.enabled = scale > 0 && mirrorWaterOnly(q);
  WATER_VIS.reset();
  let target: THREE.WebGLRenderTarget | null = null;
  const reflCam = new THREE.PerspectiveCamera();
  reflCam.matrixAutoUpdate = true;
  const scratch = createReflScratch();
  const baseProj = new THREE.Matrix4();
  const hidden: THREE.Object3D[] = [];
  const propBounds = new THREE.Sphere();
  const cullReflection = (object: THREE.Object3D): void => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || Array.isArray(mesh.material)) return;
    const variant = mesh.material.userData.brVariant;
    let hide = variant === 'water';
    if (variant === 'props' && mesh.geometry.boundingSphere) {
      propBounds.copy(mesh.geometry.boundingSphere).applyMatrix4(mesh.matrixWorld);
      hide = propBounds.center.distanceTo(reflCam.position) - propBounds.radius > TUNE.REFL_PROP_DIST;
    }
    if (hide) { hidden.push(object); object.visible = false; }
  };
  globals.reflOn.value = 0;
  globals.reflTex.value = null;

  function ensureTarget(w: number, h: number): THREE.WebGLRenderTarget {
    if (target && target.width === w && target.height === h) return target;
    target?.dispose();
    target = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      generateMipmaps: true,
      depthBuffer: true,
      stencilBuffer: false,
      colorSpace: THREE.NoColorSpace,
    });
    target.texture.name = 'br-planar-reflection';
    target.texture.anisotropy = 8; // package E: the water's glossy streaks (textureGrad along the view plane)
    return target;
  }

  const api: PlanarReflection = {
    get enabled() { return scale > 0; },
    update(renderer, scene, camera, waterY) {
      if (scale <= 0 || waterY === null) { globals.reflOn.value = 0; return; }
      camera.updateMatrixWorld();
      const camY = camera.matrixWorld.elements[13];
      if (camY < waterY + MIN_CAMERA_CLEARANCE) { globals.reflOn.value = 0; return; }
      // no water pixel passed the depth test lately (every plane in reach is behind a wall): no mirror
      if (WATER_VIS.enabled && !waterVisible(renderer)) { globals.reflOn.value = 0; return; }
      renderer.getDrawingBufferSize(scratch.size);
      const w = Math.max(16, Math.round(scratch.size.x * scale));
      const h = Math.max(16, Math.round(scratch.size.y * scale));
      const rt = ensureTarget(w, h);

      setupReflectionCamera(camera, waterY, reflCam, scratch);
      baseProj.copy(camera.projectionMatrix);
      reflectionTextureMatrix(camera, reflCam, baseProj, globals.reflMatrix.value);

      // render the mirrored view (no feedback: reflTex unbound, reflOn off, water/props culled in shaders)
      const prevRT = renderer.getRenderTarget();
      const prevShadow = renderer.shadowMap.autoUpdate;
      const prevXr = renderer.xr.enabled;
      globals.reflOn.value = 0;
      globals.reflTex.value = null;
      REFL_PASS.value = 1;
      renderer.xr.enabled = false;
      renderer.shadowMap.autoUpdate = false;
      try {
        // These draws would discard every fragment. Cull whole meshes first;
        // partly visible props still use the shader's exact distance test.
        scene.updateMatrixWorld();
        scene.traverseVisible(cullReflection);
        renderer.setRenderTarget(rt);
        renderer.state.buffers.depth.setMask(true);
        renderer.clear();
        setWirePixel(reflCam, h);
        renderWithPrepass(renderer, scene, reflCam);
      } finally {
        for (const object of hidden) object.visible = true;
        hidden.length = 0;
        renderer.setRenderTarget(prevRT);
        renderer.shadowMap.autoUpdate = prevShadow;
        renderer.xr.enabled = prevXr;
        REFL_PASS.value = 0;
      }

      globals.reflTex.value = rt.texture;
      globals.reflY.value = waterY;
      globals.reflOn.value = 1;
    },
    setQuality(nq) {
      scale = nq.planarReflectionScale;
      const gate = scale > 0 && mirrorWaterOnly(nq);
      if (gate !== WATER_VIS.enabled) WATER_VIS.reset();
      WATER_VIS.enabled = gate;
      if (scale <= 0) {
        target?.dispose();
        target = null;
        globals.reflOn.value = 0;
        globals.reflTex.value = null;
      }
    },
    dispose() {
      target?.dispose();
      target = null;
      globals.reflOn.value = 0;
      globals.reflTex.value = null;
    },
  };
  return api;
}
