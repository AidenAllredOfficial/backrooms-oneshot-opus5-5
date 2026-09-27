// src/harness/chunk.ts (WP10) — harness page (§7.3): one chunk through the REAL worker pipeline (WorkerPool ->
// chunk.worker -> handleRequest -> ChunkStreamer residency) rendered with the MaterialSystem and a minimal post
// (HalfFloat scene target -> exposure + AgX display pass). Orbit / fly camera. Sets __backrooms.ready once the
// tiles are resident with the requested bake level (full by default) and a few frames have been drawn.
//
// URL params: seed, s, cx, cz, zone (forceZone name), view (DEBUG_VIEW_NAMES), tpc (8|12), bake (preview|full)
// extras: quality (low|medium|high|ultra, default high), radius (stream radius, default 0 = the chunk only),
//         testScene, bakeTerm, lights, forceMood, landmark, ev (EV100 of the display pass, default 8),
//         cam (orbit|eye), yaw, pitch (radians), dist (orbit distance), x, z (eye position, chunk-local metres)
// Controls: drag = orbit/look, wheel = zoom, WASD/QE = fly, R = reset view.

import * as THREE from 'three';
import { CHUNK_SIZE, PHOTOMETRY, PLAYER } from '../core/constants.ts';
import type { HarnessDebugAPI } from '../core/debug.ts';
import { EventBus, type GameEvents } from '../core/events.ts';
import { DEBUG_VIEW_NAMES, LANDMARK_NAMES, MOOD_NAMES, ZONE_NAMES, type LandmarkKindId, type MoodId, type StoreyId, type ZoneId } from '../core/ids.ts';
import { bakeQualityOf, QUALITY, QUALITY_NAMES, type QualityConfig, type QualityName } from '../core/quality.ts';
import { hashString } from '../core/rng.ts';
import type { MaterialSystem, WorldStreamer } from '../core/runtime.ts';
import type { BakeTerm, WorkerInit } from '../core/worker.ts';
import { TEST_SCENES, type TestSceneId } from '../core/world.ts';
import type { LightmapData, TileMesh } from '../core/mesh.ts';
import { createMaterialSystem } from '../materials/MaterialSystem.ts';
import { LAYER_LATE } from '../materials/shared.ts';
import { createChunkStreamer, getStreamTiming } from '../stream/ChunkStreamer.ts';
import { createWorkerPool, poolSizeFor, type WorkerPool } from '../stream/WorkerPool.ts';
import { generateTextures } from '../textures/TextureBaker.ts';
import { generateDetailTextures } from '../textures/DetailBaker.ts';

const READY_FRAMES = 5;

interface Params {
  seedText: string; s: StoreyId; cx: number; cz: number; zone: ZoneId | null; view: string; tpc: 8 | 12; bake: 'preview' | 'full';
  quality: QualityName; radius: number; testScene: TestSceneId | null; bakeTerm: BakeTerm; lights: 'default' | 'on' | 'dead';
  mood: MoodId | null; landmark: LandmarkKindId | null; ev: number; cam: 'orbit' | 'eye';
  yaw: number | null; pitch: number | null; dist: number | null; x: number | null; z: number | null;
}

function parseParams(search: string): Params {
  const p = new URLSearchParams(search);
  const num = (k: string): number | null => {
    const v = p.get(k);
    if (v === null || v.trim() === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const nameIdx = (k: string, names: readonly string[]): number | null => {
    const v = p.get(k);
    if (!v) return null;
    const i = names.indexOf(v.toUpperCase());
    return i >= 0 ? i : null;
  };
  const q = p.get('quality');
  const s = num('s');
  const tpc = num('tpc');
  const ts = p.get('testScene');
  const bt = p.get('bakeTerm');
  const lights = p.get('lights');
  return {
    seedText: p.get('seed') ?? '1',
    s: (s === 1 || s === 2 ? s : 0) as StoreyId,
    cx: Math.trunc(num('cx') ?? 0), cz: Math.trunc(num('cz') ?? 0),
    zone: (nameIdx('zone', ZONE_NAMES) ?? nameIdx('forceZone', ZONE_NAMES)) as ZoneId | null,
    view: (p.get('view') ?? 'final').toLowerCase(),
    tpc: tpc === 8 ? 8 : tpc === 12 ? 12 : (QUALITY[(QUALITY_NAMES as readonly string[]).includes(q ?? '') ? (q as QualityName) : 'high'].lmTpc),
    bake: p.get('bake') === 'preview' ? 'preview' : 'full',
    quality: (QUALITY_NAMES as readonly string[]).includes(q ?? '') ? (q as QualityName) : 'high',
    radius: Math.max(0, Math.min(3, Math.trunc(num('radius') ?? 0))),
    testScene: ts && (TEST_SCENES as readonly string[]).includes(ts) ? (ts as TestSceneId) : null,
    bakeTerm: bt === 'direct' || bt === 'indirect' ? bt : 'all',
    lights: lights === 'on' || lights === 'dead' ? lights : 'default',
    mood: (nameIdx('forceMood', MOOD_NAMES) ?? nameIdx('mood', MOOD_NAMES)) as MoodId | null,
    landmark: (nameIdx('landmark', LANDMARK_NAMES) ?? nameIdx('forceLandmark', LANDMARK_NAMES)) as LandmarkKindId | null,
    ev: num('ev') ?? 8,
    cam: p.get('cam') === 'eye' ? 'eye' : 'orbit',
    yaw: num('yaw'), pitch: num('pitch'), dist: num('dist'), x: num('x'), z: num('z'),
  };
}

interface AtlasRec {
  key: string; width: number; height: number; tpc: number; chartCount: number; chartHash: number; tris: number;
  shellTris: number; propsTris: number; decalTris: number; waterTris: number; previewMs: number; fullMs: number | null; flick: boolean;
}

async function main(): Promise<void> {
  const t0 = performance.now();
  const P = parseParams(location.search);
  const errors: string[] = [];
  window.addEventListener('error', (e) => errors.push(String(e.message)));
  window.addEventListener('unhandledrejection', (e) => errors.push(String((e as PromiseRejectionEvent).reason)));

  const root = document.getElementById('app') ?? document.body;
  const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance', stencil: false });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
  renderer.setSize(innerWidth, innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.info.autoReset = false;
  renderer.getContext().getExtension('EXT_color_buffer_float');
  root.appendChild(renderer.domElement);

  const hud = document.createElement('div');
  hud.style.cssText = 'position:fixed;left:8px;top:8px;font:12px monospace;color:#ddc;background:rgba(0,0,0,.55);padding:6px 8px;white-space:pre;pointer-events:none';
  document.body.appendChild(hud);

  const base = QUALITY[P.quality];
  const q: QualityConfig = { ...base, lmTpc: P.tpc, streamRadius: P.radius };
  const init: WorkerInit = {
    opts: {
      seed: hashString(P.seedText), seedText: P.seedText, forceZone: P.zone, forceMood: P.mood, forceLandmark: P.landmark,
      testScene: P.testScene, lights: P.lights,
    },
    bake: bakeQualityOf(q), bakeTerm: P.bakeTerm, validate: true,
  };

  // ---- api (set early so shoot.mjs sees a page that reports progress)
  let frames = 0, readyFrames = 0, readyMs = -1, phase = 'textures';
  let streamer: WorldStreamer | null = null;
  let pool: WorkerPool | null = null;
  let materials: MaterialSystem | null = null;
  const atlas = new Map<string, AtlasRec>();
  const snap = { calls: 0, triangles: 0 };
  const api: HarnessDebugAPI = {
    ready: false,
    isReady: () => api.ready,
    stats: () => {
      const recs = [...atlas.values()].sort((a, b) => a.key.localeCompare(b.key));
      const info = renderer.info;
      return {
        page: 'chunk', phase, frames, readyMs, params: P, errors,
        render: { drawCalls: snap.calls, triangles: snap.triangles, programs: info.programs?.length ?? 0, textures: info.memory.textures, geometries: info.memory.geometries },
        stream: streamer?.stats() ?? null,
        // main-thread cost of the streamer (max residency step / processUploads / update since boot)
        timing: (() => {
          const t = streamer ? getStreamTiming(streamer) : null;
          return t ? {
            maxStepMs: t.maxStepMs, maxStepKind: t.maxStepKind, maxUploadMs: t.maxUploadMs, maxUpdateMs: t.maxUpdateMs, steps: t.steps,
            uploadFrames: t.uploadFrames, overBudgetFrames: t.overBudgetFrames,
          } : null;
        })(),
        workers: pool ? { size: pool.size, queued: pool.queued(), busy: pool.busy() } : null,
        atlas: recs,
        totals: {
          tiles: recs.length,
          tris: recs.reduce((a, r) => a + r.tris, 0),
          atlasTexels: recs.reduce((a, r) => a + r.width * r.height, 0),
          charts: recs.reduce((a, r) => a + r.chartCount, 0),
          previewMsAvg: recs.length ? recs.reduce((a, r) => a + r.previewMs, 0) / recs.length : 0,
          fullMsAvg: recs.filter((r) => r.fullMs !== null).reduce((a, r, _, arr) => a + (r.fullMs as number) / arr.length, 0),
        },
      };
    },
  };
  window.__backrooms = api;

  // ---- textures, materials
  const textures = await generateTextures(renderer, q.textureSize, q.anisotropy);
  if (q.detailMaps && q.shaderDetail !== 'lite') textures.detail = await generateDetailTextures(renderer, q.anisotropy);
  phase = 'shaders';
  materials = createMaterialSystem(renderer, textures, q);
  const viewIdx = Math.max(0, DEBUG_VIEW_NAMES.indexOf(P.view));
  materials.setDebugView(viewIdx);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b0b0c);
  const camera = new THREE.PerspectiveCamera(60, innerWidth / Math.max(1, innerHeight), 0.05, 600);
  camera.rotation.order = 'YXZ';
  camera.layers.enable(LAYER_LATE); // the streamed tiles' water meshes live on the late layer (stream/TileObject.ts)
  scene.add(camera);

  // ---- minimal post: scene -> HalfFloat target -> exposure + AgX (final view) or passthrough (debug views)
  const size = new THREE.Vector2();
  renderer.getDrawingBufferSize(size);
  const rt = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, depthBuffer: true, samples: 0 });
  const quadMat = new THREE.MeshBasicMaterial({ map: rt.texture, depthTest: false, depthWrite: false });
  quadMat.toneMapped = true;
  const quadScene = new THREE.Scene();
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), quadMat);
  quad.frustumCulled = false;
  quadScene.add(quad);
  const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  // final view: exposure at EV100 `ev` + AgX. Debug views write v * BR_DEBUG_NITS nits, i.e. they read as v at the
  // L0 reference exposure (PHOTOMETRY.EV100_L0): linear display, clamped, no tone curve.
  if (viewIdx === 0) {
    renderer.toneMapping = THREE.AgXToneMapping;
    renderer.toneMappingExposure = 1 / (PHOTOMETRY.EXPOSURE_CAL * 2 ** P.ev);
  } else {
    renderer.toneMapping = THREE.LinearToneMapping;
    renderer.toneMappingExposure = 1 / (PHOTOMETRY.EXPOSURE_CAL * 2 ** PHOTOMETRY.EV100_L0);
  }

  await materials.warmup(renderer, camera, scene);

  // ---- worker pipeline + streamer
  phase = 'workers';
  pool = await createWorkerPool(poolSizeFor(q, navigator.hardwareConcurrency || 4), init);
  const bus = new EventBus<GameEvents>();
  streamer = createChunkStreamer({
    renderer, materials, quality: q, init, bus, pool, startStorey: P.s,
    onTileData: (key: string, kind: 'build' | 'bake', mesh: TileMesh | null, lm: LightmapData, ms: number) => {
      if (kind === 'build' && mesh) {
        const tri = (m: { indexCount: number } | null): number => (m ? m.indexCount / 3 : 0);
        atlas.set(key, {
          key, width: mesh.atlas.width, height: mesh.atlas.height, tpc: mesh.atlas.tpc, chartCount: mesh.atlas.chartCount,
          chartHash: mesh.atlas.chartHash, tris: mesh.tris, shellTris: tri(mesh.shell), propsTris: tri(mesh.props),
          decalTris: tri(mesh.decals), waterTris: tri(mesh.water), previewMs: ms, fullMs: null, flick: lm.flick !== null,
        });
      } else {
        const r = atlas.get(key);
        if (r) r.fullMs = ms;
      }
    },
  });
  scene.add(streamer.scene);
  phase = 'chunks';

  // ---- camera rig
  const ox = P.cx * CHUNK_SIZE, oz = P.cz * CHUNK_SIZE;
  const focus = new THREE.Vector3(ox + CHUNK_SIZE / 2, 0, oz + CHUNK_SIZE / 2);
  const rig = { yaw: 0, pitch: 0, dist: 0, pos: new THREE.Vector3() };
  const resetView = (): void => {
    if (P.cam === 'eye') {
      rig.pos.set(ox + (P.x ?? CHUNK_SIZE / 2), PLAYER.eye, oz + (P.z ?? CHUNK_SIZE / 2));
      rig.yaw = P.yaw ?? 0;
      rig.pitch = P.pitch ?? 0;
    } else {
      rig.yaw = P.yaw ?? 0.6;
      rig.pitch = P.pitch ?? -0.95;
      rig.dist = P.dist ?? 44;
    }
  };
  resetView();
  const camFwd = new THREE.Vector3();
  const flyDir = new THREE.Vector3();
  const applyCamera = (): void => {
    camera.rotation.set(rig.pitch, rig.yaw, 0, 'YXZ');
    if (P.cam === 'eye') camera.position.copy(rig.pos);
    else {
      const f = camFwd.set(0, 0, -1).applyEuler(camera.rotation);
      camera.position.copy(focus).addScaledVector(f, -rig.dist);
    }
    camera.updateMatrixWorld();
  };
  let dragging = false, lastX = 0, lastY = 0;
  renderer.domElement.addEventListener('pointerdown', (e) => { dragging = true; lastX = e.clientX; lastY = e.clientY; });
  window.addEventListener('pointerup', () => { dragging = false; });
  window.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    rig.yaw -= (e.clientX - lastX) * 0.005;
    rig.pitch = Math.max(-1.55, Math.min(1.55, rig.pitch - (e.clientY - lastY) * 0.005));
    lastX = e.clientX; lastY = e.clientY;
  });
  window.addEventListener('wheel', (e) => { rig.dist = Math.max(2, Math.min(300, rig.dist * Math.exp(e.deltaY * 0.001))); });
  const keys = new Set<string>();
  window.addEventListener('keydown', (e) => { keys.add(e.code); if (e.code === 'KeyR') resetView(); });
  window.addEventListener('keyup', (e) => keys.delete(e.code));
  const fly = (dt: number): void => {
    const sp = (keys.has('ShiftLeft') ? 12 : 4) * dt;
    const fx = -Math.sin(rig.yaw), fz = -Math.cos(rig.yaw);
    const d = flyDir.set(0, 0, 0);
    if (keys.has('KeyW')) d.x += fx, d.z += fz;
    if (keys.has('KeyS')) d.x -= fx, d.z -= fz;
    if (keys.has('KeyA')) d.x += fz, d.z -= fx;
    if (keys.has('KeyD')) d.x -= fz, d.z += fx;
    if (keys.has('KeyE')) d.y += 1;
    if (keys.has('KeyQ')) d.y -= 1;
    if (d.lengthSq() === 0) return;
    d.normalize().multiplyScalar(sp);
    if (P.cam === 'eye') rig.pos.add(d); else focus.add(d);
  };

  const resize = (): void => {
    renderer.setSize(innerWidth, innerHeight);
    renderer.getDrawingBufferSize(size);
    rt.setSize(size.x, size.y);
    camera.aspect = innerWidth / Math.max(1, innerHeight);
    camera.updateProjectionMatrix();
  };
  window.addEventListener('resize', resize);

  // ---- loop
  const fx = focus.x, fz = focus.z;
  let last = performance.now(), simT = 0;
  const mats = materials;
  const st = streamer;
  renderer.setAnimationLoop(() => {
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    simT += dt;
    frames++;
    fly(dt);
    applyCamera();
    // the desired set stays on the chunk (radius 0 = just this chunk)
    st.update(fx, fz, -Math.sin(rig.yaw), -Math.cos(rig.yaw), camera, frames);
    st.processUploads(renderer, 50);
    mats.globals.time.value = simT;
    renderer.info.reset();
    renderer.setRenderTarget(rt);
    renderer.render(scene, camera);
    snap.calls = renderer.info.render.calls;
    snap.triangles = renderer.info.render.triangles;
    renderer.setRenderTarget(null);
    renderer.render(quadScene, quadCam);

    if (!api.ready) {
      const ok = st.isReady(P.radius, P.bake === 'full');
      if (ok) {
        phase = 'frames';
        if (++readyFrames >= READY_FRAMES) {
          api.ready = true;
          phase = 'ready';
          readyMs = performance.now() - t0;
        }
      } else if (P.bake === 'full' && st.isReady(P.radius, false)) phase = 'bake';
    }
    if (frames % 15 === 0) {
      const s = st.stats();
      hud.textContent =
        `chunk ${P.s}:${P.cx}:${P.cz}  seed ${P.seedText}  view ${P.view}  tpc ${P.tpc}  bake ${P.bake}  phase ${phase}\n` +
        `tiles ${s.tilesResident} (full ${s.tilesFull})  queued ${s.queued}  busy ${s.workersBusy}/${s.workers}  uploads ${s.uploadsPending}\n` +
        `draws ${snap.calls}  tris ${snap.triangles}  programs ${renderer.info.programs?.length ?? 0}  textures ${renderer.info.memory.textures}  pooled ${s.texturesPooled}\n` +
        `build ${s.buildAvgMs.toFixed(1)} ms  full bake ${s.bakeAvgMs.toFixed(1)} ms (last ${s.bakeLastMs.toFixed(1)})` +
        (errors.length ? `\nerrors: ${errors.length} (${errors[0].slice(0, 120)})` : '');
    }
  });
}

main().catch((e) => {
  console.error('[chunk harness] boot failed', e);
  const api: HarnessDebugAPI = { ready: false, isReady: () => false, stats: () => ({ page: 'chunk', error: String(e) }) };
  window.__backrooms = api;
});
