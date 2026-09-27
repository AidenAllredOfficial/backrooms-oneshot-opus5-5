// src/materials/ReflectionProbe.ts — package D: the camera-room reflection probe (high 128 px, ultra 256 px faces).
// A HalfFloat cube is captured around an ANCHOR near the eye, GGX-prefiltered into a second cube (mip k = roughness
// k / (K - 1), K = probeLevels) and published with the room box (lighting/probeBox.ts) as MaterialGlobals.probeTex /
// probeOn / probeLod / probeMin / probeMax / probePos. The surface programs box-project and lightmap-normalise it
// (chunks/probe.ts); chunks/lighting.ts mixes it into the environment and the clearcoat radiance, where the SSR
// composite overrides it on screen-space hits (it is part of the G-buffer fallback).
//
// - Anchor: the eye on the first frame; again after an invalidate() (teleport, seed reset: the bus's 'teleport'
//   event; a storey switch), when the eye moves more than PROBE.ANCHOR_MOVE from it, or leaves its box. A new anchor
//   captures its six faces PROBE.BURST per frame, keeping the previous probe published meanwhile (after an invalidate
//   none: probeOn 0), then prefilters every face and switches the published anchor and box at once.
// - Refresh: a streamed tile arriving or leaving within PROBE.FAR of the anchor marks every face stale (a new anchor
//   starts over); stale faces are re-captured PROBE.BURST per frame and, once none is left, every face is re-filtered
//   (the rough mips gather from all six). Otherwise one face is re-captured every PROBE.STEADY_EVERY frames round-robin and its mips re-filtered,
//   so flicker and moving props are at most 6 x STEADY_EVERY frames old. The box is re-estimated every
//   PROBE.BOX_REFRESH frames (chunks keep streaming in).
// - Capture: each face is ONE render of the scene (no depth prepass: at 128-256 px the overdraw costs the GPU next
//   to nothing, while the prepass doubled the main-thread submission; no frame-graph hooks) with the reflection-pass
//   flag set (uBrReflPass: props beyond 20 m and water discard; SSAO, contact shadows, POM, detail maps, the probe
//   itself and package F's eye-relative flashlight bounce are skipped; froxels fall back to the analytic haze),
//   MRT_PASS 0 (every specular inline), the flashlight at intensity 0 (its beam follows the camera, not the anchor:
//   SSR and the inline spot cover it), no debug view, shadow-map updates off, xr off, and the scene's world matrices
//   updated once per update instead of once per render. The face cameras render layer 0 only, so LAYER_LATE (water,
//   sparks, motes) is never captured.
// - Prefilter: level 0 copies the capture; level k takes PROBE.SAMPLES GGX samples (N = V = R, alpha = (k/(K-1))^2)
//   with filtered importance sampling into the capture's mips (chunks/probe.ts probeSamples, generated on the CPU).
// - Everything the shaders see is relative to the camera, computed in float64 here.

import * as THREE from 'three';
import { CHUNK_SIZE, TILE_SIZE } from '../core/constants.ts';
import type { GameBus } from '../core/events.ts';
import type { PlayerState } from '../core/player.ts';
import type { QualityConfig } from '../core/quality.ts';
import type { MaterialGlobals, WorldQuery } from '../core/runtime.ts';
import { probeBox } from '../lighting/probeBox.ts';
import { PROBE, PROBE_FILTER_FRAG, probeLevels, probeSamples } from './chunks/probe.ts';
import { MRT_PASS, REFL_PASS, WIRE_PX } from './shared.ts';

export interface ReflectionProbeInfo {
  /** faces captured by the last update */
  faces: number;
  /** the published anchor (world metres) and room box (xmin, ymin, zmin, xmax, ymax, zmax) */
  anchor: Float64Array;
  box: Float64Array;
  valid: boolean;
  /** main-thread ms of the last update that captured, and the running mean over every update (per-frame cost) */
  cpuMs: number;
  cpuMeanMs: number;
  /** draw calls of the last captured face */
  calls: number;
}

export interface ReflectionProbe {
  /** Loop step 10 (before the planar reflection and the post stack): anchor, capture, prefilter, publish.
   * `enabled` false (URL probe=0) publishes probeOn 0 and captures nothing. */
  update(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, world: WorldQuery, player: PlayerState, enabled: boolean): void;
  setQuality(q: QualityConfig): void;
  /** Drop the anchor: the next update re-anchors at the eye (probeOn 0 until its six faces exist). */
  invalidate(): void;
  /** The prefilter program (compiled ahead by boot). */
  readonly materials: readonly THREE.ShaderMaterial[];
  readonly info: ReflectionProbeInfo;
  /** Debug (__backrooms.probe.faces): the mean capture radiance of each face (+X, -X, +Y, -Y, +Z, -Z), then the
   * filtered cube's green channel along the 6 axes at every prefiltered mip; null without a probe. */
  faceMeans(renderer: THREE.WebGLRenderer): number[][] | null;
  dispose(): void;
}

/** Face look directions and up vectors (three's CubeCamera in the WebGL coordinate system: +X, -X, +Y, -Y, +Z, -Z). */
const FACES: readonly (readonly [number, number, number, number, number, number])[] = [
  [1, 0, 0, 0, 1, 0], [-1, 0, 0, 0, 1, 0], [0, 1, 0, 0, 0, -1], [0, -1, 0, 0, 0, 1], [0, 0, 1, 0, 1, 0], [0, 0, -1, 0, 1, 0],
];
const ALL_FACES = 63;
const QUAD_VERT = 'void main() { gl_Position = vec4( position.xy, 0.0, 1.0 ); }';

interface TextureProps { __webglTexture?: WebGLTexture }

const popcount6 = (m: number): number => {
  let n = 0;
  for (let f = 0; f < 6; f++) n += (m >> f) & 1;
  return n;
};

/** The lowest `n` set bits of face mask `m`. */
const firstFaces = (m: number, n: number): number => {
  let out = 0;
  for (let f = 0; f < 6 && n > 0; f++) if (m & (1 << f)) { out |= 1 << f; n--; }
  return out;
};

export function createReflectionProbe(globals: MaterialGlobals, q: QualityConfig, bus: GameBus | null, flashlight: () => THREE.Light | null): ReflectionProbe {
  let size = q.reflectionProbe;
  let levels = probeLevels(size);
  let captureRT: THREE.WebGLCubeRenderTarget | null = null;
  let filteredRT: THREE.WebGLCubeRenderTarget | null = null;
  const cams = FACES.map(() => {
    const c = new THREE.PerspectiveCamera(-90, 1, PROBE.NEAR, PROBE.FAR); // negative fov: three's cube convention
    c.layers.set(0);
    return c;
  });
  const target = new THREE.Vector3();

  // the prefilter: a screen triangle drawn into one face / mip of the filtered cube
  const samples = new Float32Array(4 * PROBE.SAMPLES);
  const sampleVecs = Array.from({ length: PROBE.SAMPLES }, () => new THREE.Vector4());
  const filter = new THREE.ShaderMaterial({
    name: 'br-probe-filter', glslVersion: THREE.GLSL3, vertexShader: QUAD_VERT, fragmentShader: PROBE_FILTER_FRAG,
    uniforms: {
      tCube: { value: null }, uFace: { value: 0 }, uSize: { value: 1 }, uCount: { value: 1 }, uSamples: { value: sampleVecs },
    },
    depthTest: false, depthWrite: false, blending: THREE.NoBlending, toneMapped: false,
  });
  const quadScene = new THREE.Scene();
  const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quad = new THREE.Mesh(new THREE.BufferGeometry(), filter);
  quad.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  quad.frustumCulled = false;
  quadScene.add(quad);
  quadScene.matrixWorldAutoUpdate = false;

  // anchor state: `live` is what the filtered cube holds (published), `next` a new anchor being captured
  const live = new Float64Array(3), liveBox = new Float64Array(6);
  const next = new Float64Array(3), nextBox = new Float64Array(6);
  let liveValid = false;
  let pending = false;
  /** faces of the anchor being captured (pending) or of the live anchor that are stale */
  let dirty = 0;
  let invalid = true;
  let lastStorey = -1;
  let boxAge = 0;
  let rr = 0;
  let tick = 0;
  const info: ReflectionProbeInfo = { faces: 0, anchor: live, box: liveBox, valid: false, cpuMs: 0, cpuMeanMs: 0, calls: 0 };

  const offTeleport = bus ? bus.on('teleport', () => api.invalidate()) : null;
  const offStorey = bus ? bus.on('storeyChanged', () => api.invalidate()) : null;
  // a tile arriving or leaving within the capture's reach (key 's:cx:cz:q') makes every face of the anchor stale
  const stale = (e: { key: string }): void => {
    if (!pending && !liveValid) return;
    const k = e.key.split(':');
    if (Number(k[0]) !== lastStorey) return;
    const q = Number(k[3]);
    const x0 = Number(k[1]) * CHUNK_SIZE + (q & 1) * TILE_SIZE, z0 = Number(k[2]) * CHUNK_SIZE + (q >> 1) * TILE_SIZE;
    const a = pending ? next : live;
    const dx = Math.max(x0 - a[0], 0, a[0] - x0 - TILE_SIZE), dz = Math.max(z0 - a[2], 0, a[2] - z0 - TILE_SIZE);
    if (dx * dx + dz * dz <= PROBE.FAR * PROBE.FAR) dirty = ALL_FACES;
  };
  const offLoad = bus ? bus.on('tileLoaded', stale) : null;
  const offUnload = bus ? bus.on('tileUnloaded', stale) : null;

  function ensureTargets(): void {
    if (captureRT && captureRT.width === size) return;
    releaseTargets();
    const opts = {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat, generateMipmaps: false, stencilBuffer: false,
      minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, colorSpace: THREE.NoColorSpace,
    } as const;
    captureRT = new THREE.WebGLCubeRenderTarget(size, { ...opts, depthBuffer: true });
    captureRT.texture.name = 'Probe.Capture';
    filteredRT = new THREE.WebGLCubeRenderTarget(size, { ...opts, depthBuffer: false });
    filteredRT.texture.name = 'Probe.Filtered';
    // the whole chain is allocated (texture completeness: the levels past K - 1 are never sampled)
    const chain = Math.floor(Math.log2(size)) + 1;
    filteredRT.texture.mipmaps = Array.from({ length: chain }, (_, k) => ({ data: null, width: size >> k, height: size >> k })) as unknown as THREE.Texture['mipmaps'];
  }

  function releaseTargets(): void {
    captureRT?.dispose();
    filteredRT?.dispose();
    captureRT = null;
    filteredRT = null;
    liveValid = false;
    pending = false;
    invalid = true;
    if (globals.probeTex.value !== null) globals.probeTex.value = null;
    globals.probeOn.value = 0;
    info.valid = false;
  }

  function placeCameras(a: Float64Array): void {
    for (let f = 0; f < 6; f++) {
      const c = cams[f], d = FACES[f];
      c.position.set(a[0], a[1], a[2]);
      c.up.set(d[3], d[4], d[5]);
      c.lookAt(target.set(a[0] + d[0], a[1] + d[1], a[2] + d[2]));
      c.updateMatrixWorld();
    }
  }

  function startAnchor(world: WorldQuery, p: PlayerState): void {
    next[0] = p.eyeX; next[1] = p.eyeY; next[2] = p.eyeZ;
    probeBox(world, p.eyeX, p.eyeY, p.eyeZ, p.y, nextBox);
    placeCameras(next);
    dirty = ALL_FACES;
    pending = true;
    invalid = false;
    boxAge = 0;
  }

  /** Render face f of the capture cube (state already switched for the reflection pass). */
  function captureFace(renderer: THREE.WebGLRenderer, scene: THREE.Scene, f: number): void {
    renderer.setRenderTarget(captureRT, f, 0);
    renderer.state.buffers.depth.setMask(true);
    renderer.clear();
    WIRE_PX.value = 2 / size; // |proj[1][1]| = 1 at 90 deg
    const c0 = renderer.info.render.calls;
    renderer.render(scene, cams[f]);
    info.calls = renderer.info.render.calls - c0;
  }

  /** The capture's mip chain (filtered importance sampling reads it). */
  function captureMips(renderer: THREE.WebGLRenderer): void {
    const gl = renderer.getContext() as WebGL2RenderingContext;
    const tex = (renderer.properties.get(captureRT!.texture) as TextureProps).__webglTexture;
    if (!tex) return;
    renderer.state.bindTexture(gl.TEXTURE_CUBE_MAP, tex);
    gl.generateMipmap(gl.TEXTURE_CUBE_MAP);
    renderer.state.unbindTexture();
  }

  /** Prefilter the faces in `mask`, every mip. */
  function prefilter(renderer: THREE.WebGLRenderer, mask: number): void {
    const rt = filteredRT!;
    const u = filter.uniforms;
    u.tCube.value = captureRT!.texture;
    for (let k = 0; k < levels; k++) {
      const r = k / (levels - 1);
      const n = probeSamples(r * r, size, samples);
      for (let i = 0; i < PROBE.SAMPLES; i++) sampleVecs[i].fromArray(samples, 4 * i);
      u.uCount.value = n;
      const s = Math.max(1, size >> k);
      u.uSize.value = s;
      rt.viewport.set(0, 0, s, s);
      for (let f = 0; f < 6; f++) {
        if ((mask & (1 << f)) === 0) continue;
        u.uFace.value = f;
        renderer.setRenderTarget(rt, f, k);
        renderer.render(quadScene, quadCam);
      }
    }
    rt.viewport.set(0, 0, size, size);
  }

  function publish(camera: THREE.Camera): void {
    const g = globals;
    if (!liveValid || !filteredRT) {
      g.probeOn.value = 0;
      info.valid = false;
      return;
    }
    camera.updateMatrixWorld();
    const e = camera.matrixWorld.elements;
    const cx = e[12], cy = e[13], cz = e[14];
    g.probeTex.value = filteredRT.texture;
    g.probeOn.value = 1;
    g.probeLod.value = levels - 1;
    g.probeMin.value.set(liveBox[0] - cx, liveBox[1] - cy, liveBox[2] - cz);
    g.probeMax.value.set(liveBox[3] - cx, liveBox[4] - cy, liveBox[5] - cz);
    g.probePos.value.set(live[0] - cx, live[1] - cy, live[2] - cz);
    info.valid = true;
  }

  /** Which faces this update captures (0: none). */
  function facesToCapture(): number {
    if (dirty !== 0) return firstFaces(dirty, PROBE.BURST);
    if (!liveValid || ++tick % PROBE.STEADY_EVERY !== 0) return 0;
    const f = 1 << rr;
    rr = (rr + 1) % 6;
    return f;
  }

  const api: ReflectionProbe = {
    get materials() { return [filter]; },
    info,
    update(renderer, scene, camera, world, p, enabled) {
      info.faces = 0;
      if (size <= 0 || !enabled) {
        globals.probeOn.value = 0;
        info.valid = false;
        return;
      }
      const t0 = performance.now();
      if (p.s !== lastStorey) {
        if (lastStorey >= 0) api.invalidate();
        lastStorey = p.s;
      }
      ensureTargets();
      // ---- anchor
      if (world.isLoaded(p.eyeX, p.eyeZ)) {
        const a = pending ? next : live, box = pending ? nextBox : liveBox;
        const moved = Math.hypot(p.eyeX - a[0], p.eyeY - a[1], p.eyeZ - a[2]) > PROBE.ANCHOR_MOVE;
        const outside = p.eyeX < box[0] || p.eyeX > box[3] || p.eyeZ < box[2] || p.eyeZ > box[5] || p.eyeY < box[1] || p.eyeY > box[4];
        if (invalid || (!pending && !liveValid) || moved || outside) startAnchor(world, p);
        else if (!pending && ++boxAge >= PROBE.BOX_REFRESH) {
          boxAge = 0;
          probeBox(world, live[0], live[1], live[2], live[1] - (p.eyeY - p.y), liveBox);
        }
      }
      // ---- capture + prefilter
      const faces = pending || liveValid ? facesToCapture() : 0;
      if (faces !== 0) {
        const prevRT = renderer.getRenderTarget();
        const prevFace = renderer.getActiveCubeFace();
        const prevLevel = renderer.getActiveMipmapLevel();
        const prevShadow = renderer.shadowMap.autoUpdate;
        const prevXr = renderer.xr.enabled;
        const prevWire = WIRE_PX.value;
        const prevView = globals.debugView.value;
        const prevMW = scene.matrixWorldAutoUpdate;
        const prevRefl = REFL_PASS.value, prevMrt = MRT_PASS.value;
        const light = flashlight();
        const prevIntensity = light ? light.intensity : 0;
        globals.debugView.value = 0; // the capture always sees the lit scene (debug views sample the probe)
        REFL_PASS.value = 1;
        MRT_PASS.value = 0;
        renderer.shadowMap.autoUpdate = false;
        renderer.xr.enabled = false;
        if (light) light.intensity = 0;
        try {
          scene.updateMatrixWorld();
          scene.matrixWorldAutoUpdate = false;
          for (let f = 0; f < 6; f++) if (faces & (1 << f)) captureFace(renderer, scene, f);
          captureMips(renderer);
          const wasDirty = dirty !== 0;
          dirty &= ~faces;
          if (pending) {
            if (dirty === 0) {
              prefilter(renderer, ALL_FACES);
              live.set(next);
              liveBox.set(nextBox);
              liveValid = true;
              pending = false;
            }
          } else {
            // the last stale face: every face's rough mips gather from all six
            prefilter(renderer, wasDirty && dirty === 0 ? ALL_FACES : faces);
          }
        } finally {
          scene.matrixWorldAutoUpdate = prevMW;
          if (light) light.intensity = prevIntensity;
          renderer.xr.enabled = prevXr;
          renderer.shadowMap.autoUpdate = prevShadow;
          REFL_PASS.value = prevRefl;
          MRT_PASS.value = prevMrt;
          WIRE_PX.value = prevWire;
          globals.debugView.value = prevView;
          renderer.setRenderTarget(prevRT, prevFace, prevLevel);
        }
        info.faces = popcount6(faces);
        info.cpuMs = performance.now() - t0;
      }
      info.cpuMeanMs += ((faces !== 0 ? info.cpuMs : performance.now() - t0) - info.cpuMeanMs) * 0.02;
      publish(camera);
    },
    setQuality(nq) {
      if (nq.reflectionProbe === size) return;
      size = nq.reflectionProbe;
      levels = probeLevels(size);
      releaseTargets();
    },
    invalidate() {
      invalid = true;
      liveValid = false;
      pending = false;
      globals.probeOn.value = 0;
      info.valid = false;
    },
    faceMeans(renderer) {
      if (!captureRT || !filteredRT || !liveValid) return null;
      const px = new Uint16Array(size * size * 4);
      const out: number[][] = [];
      const r3 = (v: number): number => Math.round(v * 1000) / 1000;
      for (let f = 0; f < 6; f++) {
        renderer.readRenderTargetPixels(captureRT, 0, 0, size, size, px, f);
        const m = [0, 0, 0];
        for (let i = 0; i < size * size; i++) for (let c = 0; c < 3; c++) m[c] += THREE.DataUtils.fromHalfFloat(px[i * 4 + c]);
        out.push(m.map((v) => r3(v / (size * size))));
      }
      // the filtered cube as the surfaces sample it: the 6 axis directions at every prefiltered mip
      const probeMat = new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3, vertexShader: QUAD_VERT,
        fragmentShader: /* glsl */ `
precision highp float;
uniform samplerCube tCube;
layout( location = 0 ) out highp vec4 o;
void main() {
	ivec2 p = ivec2( gl_FragCoord.xy );
	vec3 d = p.x == 0 ? vec3( 1, 0, 0 ) : p.x == 1 ? vec3( -1, 0, 0 ) : p.x == 2 ? vec3( 0, 1, 0 ) : p.x == 3 ? vec3( 0, -1, 0 )
		: p.x == 4 ? vec3( 0, 0, 1 ) : vec3( 0, 0, -1 );
	o = vec4( textureLod( tCube, d, float( p.y ) ).rgb, 1.0 );
}`,
        uniforms: { tCube: { value: filteredRT.texture } }, depthTest: false, depthWrite: false,
      });
      const rt = new THREE.WebGLRenderTarget(6, levels, { type: THREE.FloatType, depthBuffer: false });
      const prevRT = renderer.getRenderTarget();
      quad.material = probeMat;
      try {
        renderer.setRenderTarget(rt);
        renderer.render(quadScene, quadCam);
      } finally {
        renderer.setRenderTarget(prevRT);
        quad.material = filter;
      }
      const fp = new Float32Array(6 * levels * 4);
      renderer.readRenderTargetPixels(rt, 0, 0, 6, levels, fp);
      for (let k = 0; k < levels; k++) {
        const row: number[] = [];
        for (let f = 0; f < 6; f++) row.push(r3(fp[(k * 6 + f) * 4 + 1]));
        out.push(row);
      }
      rt.dispose();
      probeMat.dispose();
      return out;
    },
    dispose() {
      offTeleport?.();
      offStorey?.();
      offLoad?.();
      offUnload?.();
      releaseTargets();
      filter.dispose();
      quad.geometry.dispose();
    },
  };
  return api;
}
