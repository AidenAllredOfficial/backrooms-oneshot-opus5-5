// src/materials/dev/harness.ts — WP9-private dev harness (src/materials/dev/wp9.html). Renders the synthetic tile
// (dev/testTile.ts) with the REAL MaterialSystem / PlanarReflection / warmup into a HalfFloat target, then a
// minimal display pass (exposure + AgX + sRGB). Also runs the WP9 acceptance checks that need a GPU:
//   cache     — 100 tile material sets add no programs after warmup (one program per variant)
//   bindings  — replacing bindings.lmFlick.value after the first render changes the image
//   antitile  — VINYL_VCT at a grazing angle: per-rotation-class sharpness deviation < 5 %
// URL: view=<DEBUG_VIEW_NAMES|rot> cam=a|stain|b|pool|door|over|antitile scene=room|vct q=low|medium|high|ultra
//      ev=<EV100|auto> flash=1 time=<s> test=cache,bindings,antitile,views x,y,z,yaw,pitch (tile-local) tex=real

import * as THREE from 'three';
import { DEBUG_VIEW_NAMES } from '../../core/ids.ts';
import { NOISE_WRAP, PHOTOMETRY } from '../../core/constants.ts';
import { fromHalf } from '../../core/half.ts';
import { QUALITY } from '../../core/quality.ts';
import type { QualityName } from '../../core/quality.ts';
import type { HarnessDebugAPI } from '../../core/debug.ts';
import type { TileMaterials } from '../../core/runtime.ts';
import { createMaterialSystem } from '../MaterialSystem.ts';
import { createPlanarReflection } from '../PlanarReflection.ts';
import { DEBUG_VIEW_ROTATION } from '../chunks/debug.ts';
import { createFakeTextureSet } from './fakeTextures.ts';
import { generateTextures } from '../../textures/TextureBaker.ts';
import { generateDetailTextures } from '../../textures/DetailBaker.ts';
import { buildDevTile } from './testTile.ts';
import type { DevTile } from './testTile.ts';

const P = new URLSearchParams(location.search);
const num = (k: string, d: number): number => { const v = P.get(k); return v !== null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d; };
const qName = (P.get('q') ?? 'high') as QualityName;
const q = { ...(QUALITY[qName] ?? QUALITY.high) };
const sceneKind = P.get('scene') ?? (P.get('cam') === 'antitile' ? 'vct' : 'room');
const tests = (P.get('test') ?? '').split(',').filter(Boolean);
const TILE_ORIGIN = new THREE.Vector3(1920, 0, -1152); // far from the world origin (precision check)

const CAMS: Record<string, [number, number, number, number, number]> = {
  a: [8.6, 1.62, 8.6, 0.605, -0.12],
  stain: [6.0, 1.5, 3.2, 0.0, 0.12],
  b: [10.3, 1.62, 8.9, -0.78, -0.2],
  bwet: [18.6, 1.62, 5.0, 1.35, -0.28],
  pool: [2.0, 1.62, 18.5, -1.086, -0.3],
  door: [2.5, 1.62, 5.0, -1.571, -0.02],
  over: [9.6, 22, 9.6, 0, -1.5],
  antitile: [1.0, 1.0, 18.2, -0.81, -0.06],
  refl: [15.0, 1.62, 5.6, -0.53, -0.62],
  deck: [8.0, 1.62, 18.0, 0.3, -0.45],
};

async function main(): Promise<void> {
  const hud = document.getElementById('hud')!;
  const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(1);
  renderer.setSize(innerWidth, innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.AgXToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  document.getElementById('app')!.appendChild(renderer.domElement);
  const errors: string[] = [];
  const api: HarnessDebugAPI & { results: Record<string, unknown> } = {
    ready: false, isReady: () => api.ready, stats: () => stats(), results: {},
  };
  window.__backrooms = api;

  const t0 = performance.now();
  // tex=real: WP8's GPU texture set; default: the WP9 CPU stand-in (isotropic VCT chips for the anti-tiling check)
  const textures = P.get('tex') === 'real'
    ? await generateTextures(renderer, q.textureSize, q.anisotropy)
    : createFakeTextureSet(512, q.anisotropy, { isoVct: tests.includes('antitile') });
  if (q.detailMaps && q.shaderDetail !== 'lite') textures.detail = await generateDetailTextures(renderer, q.anisotropy);
  const texMs = performance.now() - t0;
  const tile: DevTile = buildDevTile({ vctOnly: sceneKind === 'vct' });

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(num('fov', 70), innerWidth / innerHeight, 0.05, 400);
  camera.rotation.order = 'YXZ';
  const materials = createMaterialSystem(renderer, textures, q);
  const g = materials.globals;
  g.hazeDensity.value = num('haze', 0.006);
  g.hazeTint.value.setRGB(1.0, 0.93, 0.75);
  g.hazeAlbedo.value = 0.35;
  g.edgeFog.value.set(42, 61);
  g.farColor.value.setRGB(600 * 0.35 / Math.PI * 0.3, 600 * 0.35 / Math.PI * 0.3 * 0.93, 600 * 0.35 / Math.PI * 0.3 * 0.75);
  scene.background = g.farColor.value;

  // flashlight as WP11 builds it (always present, shadow always on; off = intensity 0)
  const flash = new THREE.SpotLight(0xfff4e0, 0, 25, 0.45, 0.6, 2);
  flash.map = textures.cookie;
  flash.castShadow = true;
  flash.shadow.mapSize.set(q.flashlightShadow, q.flashlightShadow);
  flash.shadow.radius = 3;
  flash.shadow.normalBias = 0.02;
  flash.shadow.camera.far = 25;
  scene.add(flash, flash.target);

  // camera
  const cam = CAMS[P.get('cam') ?? 'a'] ?? CAMS.a;
  const local = new THREE.Vector3(num('x', cam[0]), num('y', cam[1]), num('z', cam[2]));
  camera.position.copy(local).add(TILE_ORIGIN);
  camera.rotation.set(num('pitch', cam[4]), num('yaw', cam[3]), 0);
  camera.updateMatrixWorld();
  flash.position.set(0.15, -0.2, 0).applyMatrix4(camera.matrixWorld);
  flash.target.position.set(0, -0.05, -5).applyMatrix4(camera.matrixWorld);
  flash.intensity = P.get('flash') === '1' ? 600 : 0;

  const tw = performance.now();
  await materials.warmup(renderer, camera, scene);
  const warmupMs = performance.now() - tw;
  const programsAfterWarmup = renderer.info.programs?.length ?? -1;

  // the tile
  const mats = materials.createTileMaterials(true);
  bindTile(mats, tile);
  const group = new THREE.Group();
  group.position.copy(TILE_ORIGIN);
  const add = (geo: THREE.BufferGeometry, m: THREE.Material, cast: boolean, order = 0): THREE.Mesh => {
    const mesh = new THREE.Mesh(geo, m);
    mesh.castShadow = cast;
    mesh.renderOrder = order;
    group.add(mesh);
    return mesh;
  };
  add(tile.shell, mats.shell, true);
  if (tile.props.getAttribute('position').count > 0) add(tile.props, mats.props, true);
  if (tile.decals.getAttribute('position').count > 0) add(tile.decals, mats.decal, false, 1);
  if (tile.water.getAttribute('position').count > 0 && mats.water) add(tile.water, mats.water, false);
  scene.add(group);

  const reflection = createPlanarReflection(g, q);
  const waterY = sceneKind === 'room' && P.get('refl') !== '0' ? -0.1 : null;

  const view = P.get('view') ?? 'final';
  const viewIdx = view === 'rot' ? DEBUG_VIEW_ROTATION : Math.max(0, DEBUG_VIEW_NAMES.indexOf(view));
  materials.setDebugView(viewIdx);

  // targets + display pass
  const W = renderer.domElement.width, H = renderer.domElement.height;
  const hdr = new THREE.WebGLRenderTarget(W, H, { type: THREE.HalfFloatType, depthBuffer: true });
  const ldr = new THREE.WebGLRenderTarget(W, H, { type: THREE.UnsignedByteType, depthBuffer: false });
  ldr.texture.colorSpace = THREE.SRGBColorSpace;
  const quadScene = new THREE.Scene();
  const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quadMat = new THREE.MeshBasicMaterial({ map: hdr.texture, toneMapped: true, depthTest: false, depthWrite: false });
  quadScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), quadMat));

  const time = num('time', 10);
  let ev100: number = PHOTOMETRY.EV100_L0;
  const exposureOf = (ev: number): number => 1 / (PHOTOMETRY.EXPOSURE_CAL * Math.pow(2, ev));

  function setFlicker(t: number): void {
    const c = tile.dynColor;
    const lum = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    const i = 0.55 + 0.45 * Math.sin(t * 2.3) * Math.sin(t * 7.1);
    const f = mats.bindings.flick.value;
    f[0] = (c[0] / lum) * i; f[1] = (c[1] / lum) * i; f[2] = (c[2] / lum) * i;
  }
  function renderHdr(t: number): void {
    g.time.value = t;
    setFlicker(t);
    reflection.update(renderer, scene, camera, waterY);
    renderer.setRenderTarget(hdr);
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
  }
  // three applies tone mapping / output conversion only when drawing to the canvas, so the LDR readback path
  // (bindings / antitile checks) exposes explicitly and clamps: a linear, exposed [0,1] image.
  const ldrMat = new THREE.MeshBasicMaterial({ map: hdr.texture, toneMapped: false, depthTest: false, depthWrite: false });
  const ldrScene = new THREE.Scene();
  ldrScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), ldrMat));
  function display(toLdr: boolean): void {
    renderer.toneMappingExposure = exposureOf(ev100);
    if (toLdr) {
      ldrMat.color.setScalar(exposureOf(ev100));
      renderer.setRenderTarget(ldr);
      renderer.render(ldrScene, quadCam);
    } else {
      renderer.setRenderTarget(null);
      renderer.render(quadScene, quadCam);
    }
    renderer.setRenderTarget(null);
  }
  function readHdr(): Float32Array {
    const raw = new Uint16Array(W * H * 4);
    renderer.readRenderTargetPixels(hdr, 0, 0, W, H, raw);
    const out = new Float32Array(W * H * 4);
    for (let i = 0; i < raw.length; i++) out[i] = fromHalf(raw[i]);
    return out;
  }
  function readLdrLuma(): Float32Array {
    display(true);
    const px = new Uint8Array(W * H * 4);
    renderer.readRenderTargetPixels(ldr, 0, 0, W, H, px);
    const l = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) l[i] = (0.2126 * px[i * 4] + 0.7152 * px[i * 4 + 1] + 0.0722 * px[i * 4 + 2]) / 255;
    return l;
  }
  function autoExposure(): void {
    const evParam = P.get('ev');
    if (evParam && evParam !== 'auto') { ev100 = Number(evParam); return; }
    if (viewIdx !== 0) { ev100 = PHOTOMETRY.EV100_L0; return; }
    const px = readHdr();
    let s = 0, n = 0;
    for (let i = 0; i < W * H; i += 7) {
      const L = 0.2126 * px[i * 4] + 0.7152 * px[i * 4 + 1] + 0.0722 * px[i * 4 + 2];
      if (!Number.isFinite(L)) continue;
      s += Math.log2(Math.max(L, 1e-3)); n++;
    }
    const avg = n ? s / n : 6;
    ev100 = Math.min(12.5, Math.max(5.5, avg + Math.log2(100 / 12.5) - num('bias', 0.3)));
  }

  // ---- tests
  const results: Record<string, unknown> = api.results;
  results.programsAfterWarmup = programsAfterWarmup;
  results.warmupMs = Math.round(warmupMs);
  results.textureGenMs = Math.round(texMs);
  results.tile = tile.stats;

  renderHdr(time);
  results.programsAfterFirstFrame = renderer.info.programs?.length ?? -1;
  autoExposure();

  if (tests.includes('cache')) {
    const before = renderer.info.programs?.length ?? 0;
    const extra: TileMaterials[] = [];
    const tmp = new THREE.Group();
    tmp.position.copy(TILE_ORIGIN);
    for (let i = 0; i < 100; i++) {
      const m = materials.createTileMaterials(true);
      bindTile(m, tile);
      extra.push(m);
      for (const [geo, mat] of [[tile.shell, m.shell], [tile.props, m.props], [tile.decals, m.decal], [tile.water, m.water!]] as const) {
        const mesh = new THREE.Mesh(geo, mat);
        mesh.frustumCulled = false;
        tmp.add(mesh);
      }
    }
    scene.add(tmp);
    renderHdr(time);
    const after = renderer.info.programs?.length ?? 0;
    scene.remove(tmp);
    for (const m of extra) m.dispose();
    renderHdr(time);
    const afterDispose = renderer.info.programs?.length ?? 0;
    results.cache = { before, after100: after, afterDispose, pass: after === before && afterDispose === before };
  }
  if (tests.includes('bindings')) {
    const a = readLdrLuma();
    const prev = mats.bindings.lmFlick.value;
    mats.bindings.lmFlick.value = tile.lmFlickAlt; // replace the VALUE of the exact uniform object
    renderHdr(time);
    const b = readLdrLuma();
    mats.bindings.lmFlick.value = prev;
    const prevFade = mats.bindings.fade.value;
    mats.bindings.fade.value = 0.5;
    renderHdr(time);
    const c = readLdrLuma();
    mats.bindings.fade.value = prevFade;
    renderHdr(time);
    let dAB = 0, dAC = 0;
    for (let i = 0; i < a.length; i++) { dAB += Math.abs(a[i] - b[i]); dAC += Math.abs(a[i] - c[i]); }
    results.bindings = { meanAbsDiffLmFlick: dAB / a.length, meanAbsDiffFade: dAC / a.length, pass: dAB / a.length > 1e-3 && dAC / a.length > 1e-3 };
  }
  if (tests.includes('antitile')) {
    const lum = readLdrLuma();
    materials.setDebugView(DEBUG_VIEW_ROTATION);
    renderHdr(time);
    const cls = readHdr();
    materials.setDebugView(viewIdx);
    renderHdr(time);
    results.antitile = antitileStats(lum, cls, W, H, exposureOf(PHOTOMETRY.EV100_L0));
  }
  if (tests.includes('views')) {
    // every debug view renders without GL errors (shader errors surface as console errors)
    const gl = renderer.getContext();
    const bad: string[] = [];
    for (let v = 0; v < DEBUG_VIEW_NAMES.length; v++) {
      materials.setDebugView(v);
      renderHdr(time);
      const e = gl.getError();
      if (e !== gl.NO_ERROR) bad.push(`${DEBUG_VIEW_NAMES[v]}:${e}`);
    }
    materials.setDebugView(viewIdx);
    renderHdr(time);
    results.views = { count: DEBUG_VIEW_NAMES.length, glErrors: bad, pass: bad.length === 0 };
  }

  let frames = 0;
  function stats(): unknown {
    return {
      page: 'wp9', view, cam: P.get('cam') ?? 'a', scene: sceneKind, quality: q.name, ev100: Number(ev100.toFixed(2)),
      programs: renderer.info.programs?.length ?? -1, drawCalls: renderer.info.render.calls, frames, errors,
      reflOn: g.reflOn.value, results,
    };
  }
  hud.textContent = `WP9 ${view} cam=${P.get('cam') ?? 'a'} EV ${ev100.toFixed(2)} programs ${renderer.info.programs?.length}`;
  renderer.setAnimationLoop(() => {
    const t = P.has('time') ? time : time + frames / 60;
    renderHdr(t);
    display(false);
    if (++frames >= 4) api.ready = true;
  });
}

function bindTile(m: TileMaterials, tile: DevTile): void {
  const b = m.bindings;
  b.tileOrigin.value.copy(TILE_ORIGIN);
  b.noiseOrigin.value.set(((TILE_ORIGIN.x % NOISE_WRAP) + NOISE_WRAP) % NOISE_WRAP, 0, ((TILE_ORIGIN.z % NOISE_WRAP) + NOISE_WRAP) % NOISE_WRAP);
  b.lmIrr.value = tile.lmIrr; b.lmDir.value = tile.lmDir; b.lmMask.value = tile.lmMask; b.lmFlick.value = tile.lmFlick;
  b.emission.value = tile.emission;
  b.volA.value = tile.volA; b.volB.value = tile.volB; b.volC.value = tile.volC; b.volMask.value = tile.volMask;
  // own parity: global tile x/z of the origin (1920/19.2 = 100 -> even; -1152/19.2 = -60 -> even)
  b.ownParity.value.set(Math.round(TILE_ORIGIN.x / 19.2) & 1, Math.round(TILE_ORIGIN.z / 19.2) & 1);
  b.fade.value = 1;
}

/** Per-rotation-class sharpness at matched depth bands (grazing VCT floor): relative high-pass energy (|Laplacian| /
 * local mean, so per-tile tint and lighting cancel) averaged per rotation/flip class. A filtering error on rotated
 * tiles (wrong gradients -> wrong mip / anisotropy) shows as a difference between the axis-preserving classes
 * {0,2,4,6} and the axis-swapping classes {1,3,5,7} (a sharpness checkerboard); the within-group spread is the
 * sampling-noise floor of the measurement (per-tile content differs between classes). Pass: the band-averaged
 * signed axis-group difference (the systematic checkerboard) is < 5 % of the mean. */
function antitileStats(lum: Float32Array, cls: Float32Array, W: number, H: number, dbgExposureRef: number): unknown {
  void dbgExposureRef;
  // class image: brDbg = (rot+1)/8 emitted as (rot+1)/8 * DEBUG_NITS (value in the red channel)
  const clsOf = (i: number): number => {
    const v = cls[i * 4];
    if (!Number.isFinite(v)) return -1;
    return Math.round((v / (1.2 * Math.pow(2, 9.4))) * 8) - 1; // -1: not a rotated-tile layer
  };
  const BANDS = 12;
  const y0 = Math.floor(H * 0.08), y1 = Math.floor(H * 0.48); // floor region (readback rows are bottom-up)
  const sums = new Float64Array(BANDS * 8), counts = new Float64Array(BANDS * 8);
  for (let y = y0 + 1; y < y1 - 1; y++) {
    const band = Math.floor(((y - y0) / (y1 - y0)) * BANDS);
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      const c = clsOf(i);
      if (c < 0) continue;
      let uniform = true;
      for (let dy = -1; dy <= 1 && uniform; dy++) for (let dx = -1; dx <= 1; dx++) if (clsOf(i + dy * W + dx) !== c) { uniform = false; break; }
      if (!uniform) continue;
      const m = (lum[i] + lum[i - 1] + lum[i + 1] + lum[i - W] + lum[i + W]) / 5;
      if (m < 0.02 || m > 0.98) continue; // black / clipped pixels carry no sharpness information
      const hp = Math.abs(4 * lum[i] - lum[i - 1] - lum[i + 1] - lum[i - W] - lum[i + W]) / m;
      sums[band * 8 + c] += hp; counts[band * 8 + c]++;
    }
  }
  let worstGroup = 0, worstCV = 0;
  const signed: number[] = [];
  const perBand: { cv: number; group: number; noise: number }[] = [];
  for (let b = 0; b < BANDS; b++) {
    const means: number[] = [];
    const ga: number[] = [], gb: number[] = [];
    for (let c = 0; c < 8; c++) {
      if (counts[b * 8 + c] <= 400) continue;
      const v = sums[b * 8 + c] / counts[b * 8 + c];
      means.push(v);
      ((c & 1) === 0 ? ga : gb).push(v);
    }
    if (means.length < 6 || ga.length < 2 || gb.length < 2) continue;
    const avg = (a: number[]): number => a.reduce((s, v) => s + v, 0) / a.length;
    const sd = (a: number[]): number => { const m = avg(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length); };
    const m = Math.max(avg(means), 1e-6);
    const cv = sd(means) / m;
    const group = Math.abs(avg(ga) - avg(gb)) / m;
    signed.push((avg(ga) - avg(gb)) / m);
    const noise = (sd(ga) + sd(gb)) / 2 / m;
    perBand.push({ cv: Number(cv.toFixed(4)), group: Number(group.toFixed(4)), noise: Number(noise.toFixed(4)) });
    worstGroup = Math.max(worstGroup, group);
    worstCV = Math.max(worstCV, cv);
  }
  const n = signed.length;
  const mean = n ? signed.reduce((a, v) => a + v, 0) / n : 0;
  const se = n > 1 ? Math.sqrt(signed.reduce((a, v) => a + (v - mean) ** 2, 0) / (n - 1) / n) : 0;
  return { bands: perBand, worstCV: Number(worstCV.toFixed(4)), worstAxisGroupDiff: Number(worstGroup.toFixed(4)),
    axisGroupDiff: Number(mean.toFixed(4)), axisGroupDiffSE: Number(se.toFixed(4)), pass: n > 0 && Math.abs(mean) < 0.05 };
}

main().catch((e: unknown) => {
  console.error('WP9 harness failed', e);
  const api = window.__backrooms as { ready: boolean } | undefined;
  if (api) api.ready = true;
});
