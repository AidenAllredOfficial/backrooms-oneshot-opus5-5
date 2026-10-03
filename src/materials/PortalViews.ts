import * as THREE from 'three';
import type { PortalFrame } from '../core/layout.ts';
import { portalDistance, portalRotation, throughPortal, worldPortalFrame } from '../core/portalMath.ts';
import type { PlayerState } from '../core/player.ts';
import type { MaterialGlobals, PortalHit, WorldStreamer } from '../core/runtime.ts';
import { MRT_PASS, REFL_PASS, WIRE_PX, setWirePixel } from './shared.ts';

/** Share the viewer's perspective, with the near plane cutting away the blind backing pocket. */
export function setupPortalCamera(camera: THREE.PerspectiveCamera, a: PortalFrame, b: PortalFrame, out: THREE.PerspectiveCamera): void {
  camera.updateWorldMatrix(true, false);
  const eye = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld);
  const p = throughPortal(a, b, eye.x, eye.y, eye.z);
  out.position.set(p.x, p.y, p.z);
  camera.getWorldQuaternion(out.quaternion);
  out.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), portalRotation(a, b)));
  out.near = camera.near; out.far = camera.far; out.layers.mask = camera.layers.mask;
  out.updateMatrixWorld(); out.projectionMatrix.copy(camera.projectionMatrix);
  const plane = new THREE.Plane(new THREE.Vector3(b.nx, 0, b.nz), -(b.x * b.nx + b.z * b.nz));
  plane.applyMatrix4(out.matrixWorldInverse);
  const clip = new THREE.Vector4(plane.normal.x, plane.normal.y, plane.normal.z, plane.constant);
  const e = out.projectionMatrix.elements;
  const q = new THREE.Vector4((Math.sign(clip.x) + e[8]) / e[0], (Math.sign(clip.y) + e[9]) / e[5], -1, (1 + e[10]) / e[14]);
  clip.multiplyScalar(2 / clip.dot(q));
  e[2] = clip.x; e[6] = clip.y; e[10] = clip.z + 1 - 0.0005; e[14] = clip.w;
  out.projectionMatrixInverse.copy(out.projectionMatrix).invert();
}

interface View { hit: PortalHit; mesh: THREE.Mesh; material: THREE.ShaderMaterial; target: THREE.WebGLRenderTarget | null }
const VERTEX = `invariant gl_Position; out vec4 screenPosition;
void main() { screenPosition = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position = screenPosition; }`;
const FRAGMENT = `uniform sampler2D destination; uniform float ready; uniform float reflectionPass; in vec4 screenPosition;
layout(location = 0) out vec4 portalColor;
layout(location = 1) out vec4 portalSpec;
layout(location = 2) out vec4 portalNormal;
layout(location = 3) out vec4 portalWeight;
void main() { if (reflectionPass > 0.5) discard; vec2 uv = screenPosition.xy / screenPosition.w * 0.5 + 0.5;
portalColor = ready > 0.5 ? vec4(texture(destination, uv).rgb, 1.0) : vec4(0.006, 0.006, 0.004, 1.0);
portalSpec = portalNormal = portalWeight = vec4(0.0); }`;

export function createPortalViews(scene: THREE.Scene, streamer: WorldStreamer, globals: MaterialGlobals, flashlight: THREE.SpotLight) {
  const root = new THREE.Group(); root.name = 'architectural portals'; scene.add(root);
  const views = new Map<string, View>();
  const hits: PortalHit[] = [], active: View[] = [];
  const camera = new THREE.PerspectiveCamera(), frustum = new THREE.Frustum(), vp = new THREE.Matrix4(), size = new THREE.Vector2();
  const geometry = new THREE.PlaneGeometry(0.9, 2.1);
  const depth = new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: VERTEX, fragmentShader: 'uniform float reflectionPass; layout(location = 0) out vec4 portalColor; void main() { if (reflectionPass > 0.5) discard; portalColor = vec4(0.0); }',
    uniforms: { reflectionPass: REFL_PASS }, colorWrite: false });
  const disposeView = (v: View) => { v.mesh.removeFromParent(); v.target?.dispose(); v.material.dispose(); };
  let storey = -1;
  return {
    update(player: PlayerState) {
      active.length = 0;
      if (storey !== player.s) { for (const v of views.values()) v.mesh.visible = false; storey = player.s; }
      streamer.query.portalsNear(player.x, player.z, 18, hits);
      const keep = new Set<string>();
      for (const hit of hits) {
        if (!hit.spec.doorway) continue;
        const frame = worldPortalFrame(hit), key = `${player.s}:${hit.ox}:${hit.oz}:${hit.spec.doorway.id}`;
        keep.add(key);
        let v = views.get(key);
        if (!v) {
          const material = new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: VERTEX, fragmentShader: FRAGMENT,
            uniforms: { destination: { value: null }, ready: { value: 0 }, reflectionPass: REFL_PASS }, toneMapped: false });
          material.userData.brDepth = depth;
          const mesh = new THREE.Mesh(geometry, material);
          mesh.position.set(frame.x, frame.y + 1.05, frame.z); mesh.rotation.y = Math.atan2(frame.nx, frame.nz);
          mesh.name = `portal:${key}`; root.add(mesh);
          v = { hit, mesh, material, target: null }; views.set(key, v);
        }
        v.hit = hit; v.mesh.visible = portalDistance(frame, player.eyeX, player.eyeZ) > -0.01;
        if (v.mesh.visible) active.push(v);
      }
      for (const [key, v] of views) if (!keep.has(key)) { disposeView(v); views.delete(key); }
    },
    render(renderer: THREE.WebGLRenderer, main: THREE.PerspectiveCamera, scale: number) {
      if (!active.length || !streamer.withStoreyView) return;
      frustum.setFromProjectionMatrix(vp.multiplyMatrices(main.projectionMatrix, main.matrixWorldInverse));
      renderer.getDrawingBufferSize(size);
      const visible = active.filter((v) => frustum.intersectsObject(v.mesh)).sort((a, b) => a.mesh.position.distanceToSquared(main.position) - b.mesh.position.distanceToSquared(main.position)).slice(0, 2);
      for (const v of visible) {
        const b = v.hit.spec.doorway!.target, a = worldPortalFrame(v.hit);
        if (!streamer.isPrefetched(b.s, b.x, b.z)) { v.material.uniforms.ready.value = 0; continue; }
        const w = Math.max(32, Math.round(size.x * scale)), h = Math.max(32, Math.round(size.y * scale));
        if (!v.target || v.target.width !== w || v.target.height !== h) {
          v.target?.dispose();
          v.target = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: true });
        }
        setupPortalCamera(main, a, b, camera);
        const rt = renderer.getRenderTarget(), face = renderer.getActiveCubeFace(), level = renderer.getActiveMipmapLevel();
        const shadowAuto = renderer.shadowMap.autoUpdate, xr = renderer.xr.enabled, auto = renderer.autoClear;
        const cc = renderer.autoClearColor, cd = renderer.autoClearDepth, cs = renderer.autoClearStencil;
        const mrt = MRT_PASS.value, wire = WIRE_PX.value;
        const toggles = [globals.reflOn, globals.probeOn, globals.fbOn, globals.waterVolOn, globals.rippleOn];
        const values = toggles.map((u) => u.value), ssao = globals.ssaoParams.value.x, vol = globals.volZ.value.w;
        const lightPos = flashlight.position.clone(), lightTarget = flashlight.target.position.clone(), castShadow = flashlight.castShadow;
        const pos = throughPortal(a, b, lightPos.x, lightPos.y, lightPos.z), target = throughPortal(a, b, lightTarget.x, lightTarget.y, lightTarget.z);
        try {
          root.visible = false;
          for (const u of toggles) u.value = 0;
          globals.ssaoParams.value.x = 0; globals.volZ.value.w = 0; MRT_PASS.value = 0;
          renderer.shadowMap.autoUpdate = false; renderer.xr.enabled = false;
          renderer.autoClear = false; renderer.autoClearColor = renderer.autoClearDepth = renderer.autoClearStencil = false;
          flashlight.position.set(pos.x, pos.y, pos.z); flashlight.target.position.set(target.x, target.y, target.z);
          flashlight.castShadow = false; flashlight.updateMatrixWorld(); flashlight.target.updateMatrixWorld();
          renderer.setRenderTarget(v.target); renderer.state.buffers.depth.setMask(true); renderer.clear(); setWirePixel(camera, h);
          streamer.withStoreyView(b.s, () => renderer.render(scene, camera));
          v.material.uniforms.destination.value = v.target.texture; v.material.uniforms.ready.value = 1;
        } finally {
          root.visible = true;
          for (let i = 0; i < toggles.length; i++) toggles[i].value = values[i];
          globals.ssaoParams.value.x = ssao; globals.volZ.value.w = vol;
          MRT_PASS.value = mrt; WIRE_PX.value = wire;
          flashlight.position.copy(lightPos); flashlight.target.position.copy(lightTarget); flashlight.castShadow = castShadow;
          flashlight.updateMatrixWorld(); flashlight.target.updateMatrixWorld();
          renderer.setRenderTarget(rt, face, level);
          renderer.shadowMap.autoUpdate = shadowAuto; renderer.xr.enabled = xr; renderer.autoClear = auto;
          renderer.autoClearColor = cc; renderer.autoClearDepth = cd; renderer.autoClearStencil = cs;
        }
      }
    },
    reset() { for (const v of views.values()) disposeView(v); views.clear(); active.length = 0; storey = -1; },
    dispose() { this.reset(); geometry.dispose(); depth.dispose(); root.removeFromParent(); },
  };
}
