// src/harness/post.ts (WP11) — harness page (§7.3): the real PostStack on synthetic HDR scenes.
//   harness/post.html?scene=panels|dark|shimmer&preset=low|medium|high|ultra[&time=10][&anim=1][&camcorder=1][&glitch=0..1]
//   [&checks=0[&meter=0]] (skip the checks and their captures; meter=0 also pauses the auto-exposure readback)
// panels : a Level-0 room (MeshStandardMaterial walls, RectAreaLight-lit, emissive 3300-nit troffers, flashlight).
//          Checks: clipped fraction outside the panels < 3 %, panels bloom (ring luma with bloom > 1.25 x without), AO draw
//          calls (AO on - off) <= 5, and two captures at frozen t = 10 are identical.
// dark   : a dark hall, flashlight only; a far wall 20 m away half behind an occluder (as seen from the light).
//          Check: the occluded half stays dark, the unoccluded half is lit (shadow map covers the whole range).
// shimmer: a 16 x 48 quad array evaluating brLensShimmer (LENS_SHIMMER_GLSL) on the GPU for 16 seeds x 8 times x
//          {DYING, BUZZ} x {standard, reduced, off}; readback compared with lensShimmer (TS) within 1e-2.
// window.__backrooms = HarnessDebugAPI; stats() returns every measurement; ready once the checks have run.

import * as THREE from 'three';
import { RectAreaLightUniformsLib } from 'three/examples/jsm/lights/RectAreaLightUniformsLib.js';
import { CHUNK_SIZE, EDGE_FOG } from '../core/constants.ts';
import type { HarnessDebugAPI } from '../core/debug.ts';
import { LENS_SHIMMER_GLSL, lensShimmer } from '../core/flicker.ts';
import { LightState, Mood, Zone } from '../core/ids.ts';
import type { LightStateId } from '../core/ids.ts';
import { QUALITY } from '../core/quality.ts';
import type { QualityName } from '../core/quality.ts';
import { DEFAULT_SETTINGS } from '../core/settings.ts';
import type { FlickerMode } from '../core/settings.ts';
import { atmosphereTarget, newAtmosphereState } from '../lighting/atmosphereBlend.ts';
import { createFlashlight } from '../lighting/Flashlight.ts';
import { FAR_FRACTION, FAR_WARM } from '../lighting/LightingRuntime.ts';
import { createPostStack, postInternals } from '../post/PostStack.ts';

type SceneKind = 'panels' | 'dark' | 'shimmer';

const params = new URLSearchParams(location.search);
const kind: SceneKind = (['panels', 'dark', 'shimmer'] as const).find((k) => k === params.get('scene')) ?? 'panels';
const presetName: QualityName = (['low', 'medium', 'high', 'ultra'] as const).find((k) => k === params.get('preset')) ?? 'high';
const q = { ...QUALITY[presetName] };
const tParam = params.get('time');
const T_FIXED = tParam !== null && Number.isFinite(Number(tParam)) ? Number(tParam) : 10;
const animate = params.get('anim') === '1';
const camcorder = params.get('camcorder') === '1';
const glitchParam = Number(params.get('glitch') ?? '0');
const runChecks = params.get('checks') !== '0'; // checks=0: no captures (isolates the auto-exposure readback)

// ---------------------------------------------------------------- helpers
function cookieTexture(): THREE.DataTexture {
  const n = 128;
  const d = new Uint8Array(n * n * 4);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = (i + 0.5) / n * 2 - 1, y = (j + 0.5) / n * 2 - 1;
      const r = Math.hypot(x, y);
      const hot = Math.exp(-r * r * 9) * 0.55;
      const body = Math.max(0, 1 - r * r) ** 1.4 * 0.55;
      const ring = 0.06 * Math.exp(-((r - 0.62) ** 2) * 300);
      const v = Math.min(1, hot + body + ring);
      const o = (j * n + i) * 4;
      d[o] = Math.round(255 * v); d[o + 1] = Math.round(255 * v * 0.97); d[o + 2] = Math.round(255 * v * 0.9); d[o + 3] = 255;
    }
  }
  const t = new THREE.DataTexture(d, n, n, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.minFilter = THREE.LinearFilter; t.magFilter = THREE.LinearFilter; t.needsUpdate = true;
  return t;
}

const stdMat = (rgb: [number, number, number], rough: number, metal = 0): THREE.MeshStandardMaterial => {
  const m = new THREE.MeshStandardMaterial({ roughness: rough, metalness: metal });
  m.color.setRGB(rgb[0], rgb[1], rgb[2], THREE.LinearSRGBColorSpace);
  return m;
};
function box(scene: THREE.Scene, m: THREE.Material, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0), m);
  mesh.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  mesh.castShadow = true; mesh.receiveShadow = true;
  scene.add(mesh);
  return mesh;
}

interface Built { panels: THREE.Mesh[]; eye: THREE.Vector3; yaw: number; pitch: number; flash: { on: boolean; x: number; y: number; z: number; yaw: number; pitch: number } }

// ---------------------------------------------------------------- panels scene (Level 0 room)
function buildPanels(scene: THREE.Scene): Built {
  RectAreaLightUniformsLib.init();
  const H = 2.7;
  const wall = stdMat([0.42, 0.34, 0.12], 0.8);
  const carpet = stdMat([0.33, 0.25, 0.1], 0.95);
  const ceil = stdMat([0.6, 0.56, 0.44], 0.9);
  const trim = stdMat([0.45, 0.4, 0.3], 0.5);
  const X0 = -8.4, X1 = 8.4, Z0 = -12, Z1 = 6;
  box(scene, carpet, X0, -0.1, Z0, X1, 0, Z1);
  box(scene, ceil, X0, H, Z0, X1, H + 0.1, Z1);
  box(scene, wall, X0 - 0.15, 0, Z0, X0, H, Z1);
  box(scene, wall, X1, 0, Z0, X1 + 0.15, H, Z1);
  box(scene, wall, X0, 0, Z0 - 0.15, X1, H, Z0);
  box(scene, wall, X0, 0, Z1, X1, H, Z1 + 0.15);
  // interior walls with doorways -> depth and corners
  box(scene, wall, -3.6, 0, -4.8, -0.45, H, -4.65);
  box(scene, wall, 0.45, 0, -4.8, 4.8, H, -4.65);
  box(scene, wall, -0.45, 2.1, -4.8, 0.45, H, -4.65);
  box(scene, wall, 2.4, 0, -12, 2.55, H, -7.2);
  box(scene, wall, -6.0, 0, 0.6, -5.85, H, 6);
  // baseboards
  for (const [x0, z0, x1, z1] of [[X0, Z0, X1, Z0 + 0.02], [X0, Z1 - 0.02, X1, Z1], [X0, Z0, X0 + 0.02, Z1], [X1 - 0.02, Z0, X1, Z1]] as const) {
    box(scene, trim, x0, 0, z0, x1, 0.1, z1);
  }
  // a few props
  const chair = stdMat([0.2, 0.2, 0.22], 0.6, 0.3);
  box(scene, chair, 1.2, 0, 1.5, 1.7, 0.45, 2.0);
  box(scene, chair, 1.2, 0.45, 1.95, 1.7, 0.95, 2.0);
  box(scene, stdMat([0.35, 0.22, 0.12], 0.55), -3.6, 0, -2.4, -1.8, 0.75, -1.6);
  // troffers: emissive lens + RectAreaLight (luminance in nits)
  const lensMat = new THREE.MeshStandardMaterial({ color: 0x000000, roughness: 0.3 });
  lensMat.emissive.setRGB(1.0, 0.97, 0.88, THREE.LinearSRGBColorSpace);
  lensMat.emissiveIntensity = 3300;
  const housing = stdMat([0.5, 0.5, 0.48], 0.4);
  const panels: THREE.Mesh[] = [];
  for (let z = Z0 + 1.8; z < Z1; z += 3.6) {
    for (let x = X0 + 2.4; x < X1; x += 3.6) {
      const lensMesh = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 1.2), lensMat);
      lensMesh.rotation.x = Math.PI / 2;
      lensMesh.position.set(x, H - 0.012, z);
      scene.add(lensMesh);
      panels.push(lensMesh);
      box(scene, housing, x - 0.33, H - 0.01, z - 0.63, x + 0.33, H, z + 0.63);
      const rl = new THREE.RectAreaLight(0xfff4e0, 3300 * 0.8, 0.6, 1.2);
      rl.position.set(x, H - 0.02, z);
      rl.lookAt(x, 0, z);
      scene.add(rl);
    }
  }
  const amb = new THREE.AmbientLight(0xffe7b0, 90); // ~bounce irradiance (lux)
  scene.add(amb);
  return {
    panels, eye: new THREE.Vector3(-4.2, 1.62, 4.6), yaw: -0.55, pitch: 0.1,
    flash: { on: true, x: -4.2, y: 1.62, z: 4.6, yaw: -0.55, pitch: -0.25 },
  };
}

// ---------------------------------------------------------------- dark scene (flashlight occlusion)
const DARK = { occluder: [-3, 0] as const, farZ: -20, flashEye: [0, 1.62, 0] as const };
function buildDark(scene: THREE.Scene): Built {
  const concrete = stdMat([0.33, 0.32, 0.3], 0.85);
  const floor = stdMat([0.28, 0.27, 0.25], 0.6);
  box(scene, floor, -9, -0.1, DARK.farZ - 0.5, 9, 0, 3);
  box(scene, concrete, -9, 3.2, DARK.farZ - 0.5, 9, 3.3, 3);
  box(scene, concrete, -9, 0, DARK.farZ - 0.3, 9, 3.2, DARK.farZ); // far wall (20 m)
  box(scene, concrete, -9.3, 0, DARK.farZ, -9, 3.2, 3);
  box(scene, concrete, 9, 0, DARK.farZ, 9.3, 3.2, 3);
  box(scene, concrete, -9, 0, 3, 9, 3.2, 3.3);
  // the occluder: left half of the beam at z = -5 (full height)
  box(scene, concrete, DARK.occluder[0], 0, -5.1, DARK.occluder[1], 3.2, -4.9);
  // pillars and crates for the visual
  box(scene, concrete, 4.2, 0, -10.3, 4.8, 3.2, -9.7);
  box(scene, stdMat([0.3, 0.22, 0.14], 0.7), 1.2, 0, -13, 2.2, 0.9, -12);
  return {
    panels: [], eye: new THREE.Vector3(2.5, 1.6, 1.0), yaw: Math.atan2(3.5, 21), pitch: -0.01,
    flash: { on: true, x: DARK.flashEye[0], y: DARK.flashEye[1], z: DARK.flashEye[2], yaw: 0, pitch: 0 },
  };
}

// ---------------------------------------------------------------- shimmer parity (GPU vs TS)
const SH_SEEDS = [0, 1, 7, 13, 42, 77, 99, 128, 150, 177, 200, 211, 233, 240, 254, 255];
const SH_TIMES = [0.37, 1.9, 7.25, 13.1, 42.8, 99.9, 250.5, 777.7];
const SH_MODES: FlickerMode[] = ['standard', 'reduced', 'off'];
const SH_STATES: LightStateId[] = [LightState.DYING, LightState.BUZZ];
function shimmerMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: 'br-shimmer-parity',
    uniforms: { uSeeds: { value: SH_SEEDS.slice() }, uTimes: { value: SH_TIMES.slice() } },
    vertexShader: 'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: `
${LENS_SHIMMER_GLSL}
uniform float uSeeds[16];
uniform float uTimes[8];
void main() {
  int ix = int(gl_FragCoord.x);
  int iy = int(gl_FragCoord.y);
  int ti = iy % 8;
  int si = (iy / 8) % 2;
  int mi = iy / 16;
  float v = brLensShimmer(si == 0 ? 3 : 4, uSeeds[ix], uTimes[ti], mi);
  float q = floor(clamp((v - 0.4) / 0.8, 0.0, 1.0) * 65535.0 + 0.5);
  float hi = floor(q / 256.0);
  gl_FragColor = vec4(hi / 255.0, (q - hi * 256.0) / 255.0, 0.0, 1.0);
}`,
    depthTest: false, depthWrite: false, toneMapped: false,
  });
}

async function runShimmer(renderer: THREE.WebGLRenderer): Promise<Record<string, unknown>> {
  const W = 16, H = 48;
  const rt = new THREE.WebGLRenderTarget(W, H, { type: THREE.UnsignedByteType, depthBuffer: false });
  const sc = new THREE.Scene();
  const tri = new THREE.BufferGeometry();
  tri.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  const mesh = new THREE.Mesh(tri, shimmerMaterial());
  mesh.frustumCulled = false;
  sc.add(mesh);
  const cam = new THREE.OrthographicCamera();
  renderer.setRenderTarget(rt);
  renderer.render(sc, cam);
  renderer.setRenderTarget(null);
  const px = new Uint8Array(W * H * 4);
  await renderer.readRenderTargetPixelsAsync(rt, 0, 0, W, H, px);
  let maxErr = 0;
  let worst = '';
  let sum = 0;
  const gpu: number[] = [];
  for (let iy = 0; iy < H; iy++) {
    const ti = iy % 8, si = (iy >> 3) % 2, mi = Math.floor(iy / 16);
    for (let ix = 0; ix < W; ix++) {
      const o = (iy * W + ix) * 4;
      const v = ((px[o] * 256 + px[o + 1]) / 65535) * 0.8 + 0.4;
      const ref = lensShimmer(SH_STATES[si], SH_SEEDS[ix], SH_TIMES[ti], SH_MODES[mi]);
      const e = Math.abs(v - ref);
      sum += e;
      gpu.push(v);
      if (e > maxErr) { maxErr = e; worst = `state ${SH_STATES[si]} seed ${SH_SEEDS[ix]} t ${SH_TIMES[ti]} mode ${SH_MODES[mi]}: gpu ${v.toFixed(5)} ts ${ref.toFixed(5)}`; }
    }
  }
  rt.dispose();
  return { samples: W * H, maxErr, meanErr: sum / (W * H), worst, pass: maxErr <= 1e-2, gpuMin: Math.min(...gpu), gpuMax: Math.max(...gpu) };
}

// ---------------------------------------------------------------- image measurements
const luma = (px: Uint8Array, i: number): number => (0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]) / 255;
function rectMean(px: Uint8Array, w: number, x0: number, y0: number, x1: number, y1: number): number {
  let s = 0, n = 0;
  for (let y = Math.max(0, Math.floor(y0)); y < Math.ceil(y1); y++) {
    for (let x = Math.max(0, Math.floor(x0)); x < Math.min(w, Math.ceil(x1)); x++) { s += luma(px, (y * w + x) * 4); n++; }
  }
  return n > 0 ? s / n : NaN;
}

// ---------------------------------------------------------------- main
function main(): void {
  const root = document.getElementById('app') ?? document.body;
  const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance', stencil: false, depth: true });
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.info.autoReset = false;
  renderer.setPixelRatio(Math.min(devicePixelRatio, q.maxDpr) * q.renderScale);
  renderer.setSize(innerWidth, innerHeight);
  root.appendChild(renderer.domElement);

  const errors: string[] = [];
  const results: Record<string, unknown> = {};
  let frames = 0;
  let lastCalls = 0;
  const api: HarnessDebugAPI = {
    ready: false,
    isReady: () => api.ready,
    stats: () => ({
      page: 'post', scene: kind, preset: presetName, frames, t: T_FIXED,
      programs: renderer.info.programs?.length ?? 0, drawCalls: lastCalls, ...results, errors,
    }),
  };
  window.__backrooms = api;

  if (kind === 'shimmer') {
    runShimmer(renderer).then((r) => {
      Object.assign(results, { shimmer: r });
      // visualise: the GPU values as a grey grid
      const W = innerWidth, H = innerHeight;
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      c.style.cssText = 'position:fixed;inset:0;';
      const g = c.getContext('2d');
      if (g) {
        g.fillStyle = '#111'; g.fillRect(0, 0, W, H);
        const cw = W / 16, ch = H / 48;
        for (let iy = 0; iy < 48; iy++) {
          for (let ix = 0; ix < 16; ix++) {
            const v = lensShimmer(SH_STATES[(iy >> 3) % 2], SH_SEEDS[ix], SH_TIMES[iy % 8], SH_MODES[Math.floor(iy / 16)]);
            const l = Math.round(Math.max(0, Math.min(1, (v - 0.5) / 0.7)) * 255);
            g.fillStyle = `rgb(${l},${l},${l})`;
            g.fillRect(ix * cw + 1, H - (iy + 1) * ch + 1, cw - 2, ch - 2);
          }
        }
        g.fillStyle = r.pass ? '#8f8' : '#f88';
        g.font = '20px monospace';
        g.fillText(`brLensShimmer vs lensShimmer: max |err| = ${(r.maxErr as number).toExponential(2)} (${r.pass ? 'PASS' : 'FAIL'})`, 20, 30);
      }
      document.body.appendChild(c);
      api.ready = true;
    }, (e: unknown) => { errors.push(String(e)); api.ready = true; });
    return;
  }

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(62, innerWidth / Math.max(1, innerHeight), 0.05, 400);
  camera.rotation.order = 'YXZ';
  const built = kind === 'dark' ? buildDark(scene) : buildPanels(scene);
  camera.position.copy(built.eye);
  camera.rotation.set(built.pitch, built.yaw, 0);
  camera.updateMatrixWorld();

  const flash = createFlashlight(scene, cookieTexture(), q, null);
  flash.set(built.flash.on);
  const aimFlash = (): void => {
    const f = built.flash;
    flash.aim(f.x, f.y, f.z, f.yaw, f.pitch, 0, 0);
  };
  aimFlash();

  const post = createPostStack(renderer, scene, camera, q, DEFAULT_SETTINGS);
  post.setSize(innerWidth, innerHeight);
  if (camcorder) post.setFilm({ ...DEFAULT_SETTINGS.film, camcorder: true }, 0);
  const atm = newAtmosphereState();
  atmosphereTarget(kind === 'dark' ? Zone.CONCRETE : Zone.LOBBY, kind === 'dark' ? Mood.DARK : Mood.NORMAL, atm);
  const irr = kind === 'dark' ? 2 : 450;
  atm.camIrradiance[0] = irr; atm.camIrradiance[1] = irr * 0.95; atm.camIrradiance[2] = irr * 0.8;
  atm.edgeFog[0] = EDGE_FOG.START * q.streamRadius * CHUNK_SIZE;
  atm.edgeFog[1] = EDGE_FOG.END * q.streamRadius * CHUNK_SIZE;
  atm.flashlight = built.flash.on ? 1 : 0;
  post.setAtmosphere(atm);
  const bg = new THREE.Color().setRGB(
    atm.camIrradiance[0] * atm.hazeAlbedo / Math.PI * FAR_FRACTION * atm.hazeTint[0] * FAR_WARM[0],
    atm.camIrradiance[1] * atm.hazeAlbedo / Math.PI * FAR_FRACTION * atm.hazeTint[1] * FAR_WARM[1],
    atm.camIrradiance[2] * atm.hazeAlbedo / Math.PI * FAR_FRACTION * atm.hazeTint[2] * FAR_WARM[2],
  );
  scene.background = bg;

  addEventListener('resize', () => {
    camera.aspect = innerWidth / Math.max(1, innerHeight);
    camera.updateProjectionMatrix();
    post.setSize(innerWidth, innerHeight);
  });

  const waiters: (() => void)[] = [];
  const nextFrames = (n: number): Promise<void> => new Promise((res) => {
    let k = n;
    const tick = (): void => { if (--k <= 0) res(); else waiters.push(tick); };
    waiters.push(tick);
  });
  let last = performance.now();
  renderer.setAnimationLoop((now) => {
    const realDt = Math.min(0.1, (now - last) / 1000);
    last = now;
    const t = animate ? T_FIXED + frames / 60 : T_FIXED;
    try {
      renderer.info.reset();
      aimFlash();
      post.render(realDt || 1 / 60, t);
      lastCalls = renderer.info.render.calls;
    } catch (e) {
      if (errors.length < 20) errors.push(e instanceof Error ? e.message : String(e));
    }
    frames++;
    for (const w of waiters.splice(0)) w();
  });

  const project = (x: number, y: number, z: number, w: number, h: number): [number, number] => {
    const v = new THREE.Vector3(x, y, z).project(camera);
    return [(v.x * 0.5 + 0.5) * w, (1 - (v.y * 0.5 + 0.5)) * h];
  };

  const checks = async (): Promise<void> => {
    const pi = postInternals(post);
    await nextFrames(30);
    post.snapExposure();
    await nextFrames(12);
    // ---- pre-shade SSAO draw-call cost (two Z levels, AO, the separable denoise; never a scene render)
    if (pi) {
      post.setEnabled({ ao: true });
      await nextFrames(3);
      const on = lastCalls;
      post.setEnabled({ ao: false });
      await nextFrames(3);
      const off = lastCalls;
      post.setEnabled({ ao: true });
      await nextFrames(3);
      results.ao = { enabled: pi.ao.enabled, drawCallsOn: on, drawCallsOff: off, diff: on - off, pass: on - off <= 5 };
      results.passes = pi.passes.map((p) => p.name);
    }
    // ---- determinism at frozen t
    const a = await post.capture(160, 90);
    await nextFrames(4);
    const b = await post.capture(160, 90);
    let diff = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++;
    results.determinism = { t: T_FIXED, differingBytes: diff, pass: diff === 0 };
    results.exposure = { ...post.exposure, target: pi?.targetEv() ?? null, measurements: pi?.measurements() ?? 0 };

    if (kind === 'panels') {
      // panels = what clips without bloom; bloom must not clip more than 3 % elsewhere, and must glow around them
      post.setEnabled({ bloom: false });
      await nextFrames(3);
      const nb = await post.capture(160, 90);
      post.setEnabled({ bloom: true });
      await nextFrames(3);
      const wb = await post.capture(160, 90);
      const W = 160, H = 90;
      const panel = new Uint8Array(W * H);
      for (let i = 0; i < W * H; i++) if (luma(nb, i * 4) > 0.9) panel[i] = 1; // the light sources
      const dil = (m: Uint8Array, r: number): Uint8Array => {
        const o = new Uint8Array(W * H);
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
          if (!m[y * W + x]) continue;
          for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
            const xx = x + dx, yy = y + dy;
            if (xx >= 0 && yy >= 0 && xx < W && yy < H) o[yy * W + xx] = 1;
          }
        }
        return o;
      };
      const p1 = dil(panel, 1);
      const p4 = dil(panel, 4);
      let outside = 0, clippedOut = 0, ring = 0, ringOn = 0, ringOff = 0, panelPx = 0, clippedAll = 0, meanL = 0;
      for (let i = 0; i < W * H; i++) {
        const l = luma(wb, i * 4);
        meanL += l;
        if (l > 0.98) clippedAll++;
        if (panel[i]) panelPx++;
        if (!p1[i]) { outside++; if (l > 0.98) clippedOut++; }
        if (p4[i] && !p1[i]) { ring++; ringOn += l; ringOff += luma(nb, i * 4); }
      }
      let mr = 0, mg = 0, mb = 0;
      for (let i = 0; i < W * H; i++) { mr += wb[i * 4]; mg += wb[i * 4 + 1]; mb += wb[i * 4 + 2]; }
      mr /= W * H * 255; mg /= W * H * 255; mb /= W * H * 255;
      const mx = Math.max(mr, mg, mb), mn = Math.min(mr, mg, mb);
      let hue = 0;
      if (mx - mn > 1e-9) {
        hue = mx === mr ? ((mg - mb) / (mx - mn)) % 6 : mx === mg ? (mb - mr) / (mx - mn) + 2 : (mr - mg) / (mx - mn) + 4;
        hue *= 60; if (hue < 0) hue += 360;
      }
      results.panels = {
        meanRGB: [mr, mg, mb], hueDeg: hue, sat: mx > 0 ? (mx - mn) / mx : 0,
        panelFraction: panelPx / (W * H), clippedAll: clippedAll / (W * H), clippedOutside: clippedOut / Math.max(1, outside),
        ringLumaBloom: ringOn / Math.max(1, ring), ringLumaNoBloom: ringOff / Math.max(1, ring), meanLum: meanL / (W * H),
        pass: panelPx > 0 && clippedOut / Math.max(1, outside) < 0.03 && ringOn > ringOff * 1.25, // R2-post: visible camcorder bloom
      };
    } else {
      // dark: exposure locked so the 20 m wall is measurable; bloom/grade/lens/grain off for a clean measurement
      post.setEnabled({ lens: false, grain: false, bloom: false, grade: false });
      post.setExposureLock(0.5);
      await nextFrames(4);
      const px = await post.capture(160, 90);
      const W = 160, H = 90;
      const rect = (xa: number, xb: number): [number, number, number, number] => {
        const [ax, ay] = project(xa, 2.1, DARK.farZ, W, H);
        const [bx, by] = project(xb, 0.9, DARK.farZ, W, H);
        return [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)];
      };
      const sr = rect(-4.5, -1.6);
      const lr = rect(1.6, 4.5);
      const shadow = rectMean(px, W, sr[0], sr[1], sr[2], sr[3]);
      const lit = rectMean(px, W, lr[0], lr[1], lr[2], lr[3]);
      results.dark = { shadowRect: sr.map(Math.round), litRect: lr.map(Math.round), shadowLuma: shadow, litLuma: lit, pass: shadow < 0.02 && lit > 0.1 && lit > shadow * 5 };
      post.setExposureLock(null);
      post.setEnabled({ lens: true, grain: true, bloom: true, grade: true });
      post.snapExposure();
      await nextFrames(20);
    }
    if (glitchParam > 0) post.glitch(1e6, Math.min(1, glitchParam));
    api.ready = true;
  };
  if (!runChecks) {
    if (params.get('meter') === '0') post.setPaused(true); // meter=0: no auto-exposure readback either
    void nextFrames(120).then(() => { api.ready = true; });
    return;
  }
  checks().catch((e: unknown) => { errors.push(e instanceof Error ? e.message : String(e)); api.ready = true; });
}

main();
