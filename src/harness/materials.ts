// src/harness/materials.ts (WP8) — harness page (§7.3): texture gallery, layerAlbedoCheck, tileSeamCheck.
//
// URL params:
//   view=albedo|normal|ormh|lit   (default albedo)
//   layer=N                       one layer (default: gallery of all MAT_COUNT, 7 x 5)
//   size=512|1024                 generation size (default 1024)
//   ch=rgb|r|g|b|a                channel shown in the texture views (default rgb)
//   mip=N                         show mip level N (default: trilinear)
//   tile=N                        repeats shown in single-layer texture views (default 2, seams at the centre)
//   extra=grime|water|cookie      show a 2D auxiliary texture instead of the arrays
//   extra=detail                  the LEAN detail array (textures/detail.ts; layer=k one layer, default a gallery):
//                                 ch=r|g mean slope / S, b albedo multiplier / 2, a E[slope^2] / 2S^2
//   t=seconds                     freeze the light animation of the lit view
//   base=N                        lit view of an alpha layer (DECAL_ATLAS, SIGNAGE, ...): composite it over layer N
//                                 (soft alpha, alpha-tested for SIGNAGE/chalk-like hard edges) instead of discarding
//   check=0                       skip the GPU checks
//   checks=albedo,range,seam,orient   which GPU checks run (default all): range = per-layer albedo percentile range
//                                 (stats().albedoRange), the texture height maximum against SURFACE_PHYS.pomTop
//                                 (stats().heightMax, heightFails) and the aux channel's range (stats().auxRange: ormh.a
//                                 per layer with its aux kind; view=ormh&ch=a shows the channel)
//   hud=0                         hide the text overlay
//   packh=1                       force the packed RGBA8 height scratch (fallback without float colour buffers)
// window.__backrooms (HarnessDebugAPI): ready once the textures are generated, the checks have run and a few frames
// were drawn. stats() returns timings and check summaries; layerAlbedoCheck() / tileSeamCheck() rerun the checks.

import * as THREE from 'three';
import { RectAreaLightUniformsLib } from 'three/examples/jsm/lights/RectAreaLightUniformsLib.js';
import type { HarnessDebugAPI, LayerAlbedoReport } from '../core/debug.ts';
import { MAT_COUNT, Mat, type MatId } from '../core/ids.ts';
import { LAYER_DEFS } from '../core/materials.ts';
import type { TextureSet } from '../core/runtime.ts';
import { SURFACE_PHYS } from '../materials/chunks/params.ts';
import {
  arrowOrientationCheck, layerAlbedoCheck, layerAlbedoRangeCheck, layerHeightMax, reduceAtlasSlots, reduceLayers, tileSeamCheck,
  tileSeamCheckDetailed, layerAuxRange, type LayerAuxRange, type LayerRangeReport, type OrientationReport, type SeamDetail,
} from '../textures/albedoCheck.ts';
import { generateTextures, textureBakeStats } from '../textures/TextureBaker.ts';
import { detailBakeStats, generateDetailTextures } from '../textures/DetailBaker.ts';
import { DETAIL_COUNT, DETAIL_RECIPES, DETAIL_SIZE } from '../textures/detail.ts';
import { setForcePackedScratch } from '../textures/programs.ts';
import { LAYER_RECIPES_FULL } from '../textures/registry.ts';

const READY_FRAMES = 5;
/** The generator frame of a layer (metres per texture repeat, u x v: RecipeBody.frame or repeat x repeatY). */
const frameOf = (l: number): readonly [number, number] => LAYER_RECIPES_FULL[l].frame;
const COLS = 7;
const ROWS = 5;

const q = new URLSearchParams(location.search);
const view = (q.get('view') ?? 'albedo') as 'albedo' | 'normal' | 'ormh' | 'lit';
const layerParam = q.get('layer');
const single = layerParam !== null && layerParam !== '' ? Math.max(0, Math.min(MAT_COUNT - 1, Number(layerParam) | 0)) : -1;
const size = (q.get('size') === '512' ? 512 : 1024) as 512 | 1024;
const chName = q.get('ch') ?? 'rgb';
const ch = ({ rgb: 0, r: 1, g: 2, b: 3, a: 4 } as Record<string, number>)[chName] ?? 0;
const mip = q.has('mip') ? Number(q.get('mip')) : -1;
const tile = Math.max(0.02, Number(q.get('tile') ?? 2)); // < 1 zooms in (e.g. tile=0.25: a quarter of the frame)
const extra = q.get('extra');
const detailView = extra === 'detail';
const baseParam = q.get('base');
const baseLayer = baseParam !== null && baseParam !== '' ? Math.max(0, Math.min(MAT_COUNT - 1, Number(baseParam) | 0)) : -1;
const tFixed = q.has('t') ? Number(q.get('t')) : null;
const runChecks = q.get('check') !== '0';
const checkList = (q.get('checks') ?? 'albedo,range,seam,orient').split(',');
const hud = q.get('hud') !== '0';
if (q.get('packh') === '1') setForcePackedScratch(true); // exercise the RGBA8 packed-height scratch fallback

// ---------------------------------------------------------------- texture views
const VIEW_VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;
const VIEW_FRAG = /* glsl */ `
precision highp sampler2DArray;
uniform sampler2DArray uArr;
uniform sampler2D uTex2D;
uniform int uUse2D;
uniform float uLayer;
uniform int uCh;
uniform float uMip;
uniform vec2 uTile;
uniform int uData;   // 0: linear colour (encode for display), 1: raw data (show stored values)
uniform int uAlphaChecker;
varying vec2 vUv;
void main() {
  vec2 uv = vUv * uTile;
  vec4 t;
  if (uUse2D == 1) t = uMip >= 0.0 ? textureLod(uTex2D, uv, uMip) : texture(uTex2D, uv);
  else t = uMip >= 0.0 ? textureLod(uArr, vec3(uv, uLayer), uMip) : texture(uArr, vec3(uv, uLayer));
  vec3 c = uCh == 0 ? t.rgb : vec3(uCh == 1 ? t.r : uCh == 2 ? t.g : uCh == 3 ? t.b : t.a);
  if (uAlphaChecker == 1 && uCh == 0) {
    vec2 cb = floor(vUv * 24.0);
    float chk = mod(cb.x + cb.y, 2.0) < 0.5 ? 0.12 : 0.22;
    c = mix(vec3(uData == 1 ? chk : chk * chk), c, t.a);
  }
  gl_FragColor = uData == 1 ? vec4(c, 1.0) : linearToOutputTexel(vec4(c, 1.0));
}
`;

function viewMaterial(set: TextureSet, layer: number): THREE.ShaderMaterial {
  const arr = detailView && set.detail ? set.detail : view === 'normal' ? set.normal : view === 'ormh' ? set.ormh : set.albedo;
  const tex2d = extra === 'grime' ? set.grime : extra === 'water' ? set.waterNormals : extra === 'cookie' ? set.cookie : set.grime;
  const d = LAYER_DEFS[layer];
  // single-layer views keep the physical aspect of the layer frame
  return new THREE.ShaderMaterial({
    vertexShader: VIEW_VERT,
    fragmentShader: VIEW_FRAG,
    uniforms: {
      uArr: { value: arr },
      uTex2D: { value: tex2d },
      uUse2D: { value: extra && !detailView ? 1 : 0 },
      uLayer: { value: layer },
      uCh: { value: ch },
      uMip: { value: mip },
      uTile: { value: new THREE.Vector2(single >= 0 || extra ? tile : 1, single >= 0 || extra ? tile : 1) },
      uData: { value: view === 'albedo' && !extra ? 0 : 1 },
      uAlphaChecker: { value: view === 'albedo' && !extra && (d.id === Mat.DECAL_ATLAS || d.id === Mat.SIGNAGE || d.id === Mat.METAL_GRATE || d.id === Mat.FLOOR_PAINT) ? 1 : 0 },
    },
  });
}

// ---------------------------------------------------------------- lit view
function litMaterial(set: TextureSet, layer: number, uvScale: THREE.Vector2, base = -1, baseScale = new THREE.Vector2(1, 1)): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ roughness: 1, metalness: 1 });
  const d = LAYER_DEFS[layer];
  const emitGain = d.id === Mat.PANEL_LENS ? 6 : d.id === Mat.SIGNAGE ? 3 : 0;
  const alphaTest = d.id === Mat.DECAL_ATLAS || d.id === Mat.SIGNAGE || d.id === Mat.METAL_GRATE || d.id === Mat.FLOOR_PAINT ? 1 : 0;
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uAlb = { value: set.albedo };
    shader.uniforms.uNrm = { value: set.normal };
    shader.uniforms.uOrmh = { value: set.ormh };
    shader.uniforms.uLayer = { value: layer };
    shader.uniforms.uScale = { value: uvScale };
    shader.uniforms.uEmit = { value: emitGain };
    shader.uniforms.uAlphaTest = { value: alphaTest };
    shader.uniforms.uBase = { value: base };
    shader.uniforms.uBaseScale = { value: baseScale };
    shader.uniforms.uHardAlpha = { value: d.id === Mat.SIGNAGE ? 1 : 0 };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nout vec2 vBrUv;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nvBrUv = uv;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
precision highp sampler2DArray;
uniform sampler2DArray uAlb; uniform sampler2DArray uNrm; uniform sampler2DArray uOrmh;
uniform float uLayer; uniform vec2 uScale; uniform float uEmit; uniform float uAlphaTest;
uniform float uBase; uniform vec2 uBaseScale; uniform float uHardAlpha;
in vec2 vBrUv;
vec4 brA; vec4 brN; vec4 brO;`)
      .replace('#include <map_fragment>', `#include <map_fragment>
vec2 brUv = vBrUv * uScale;
brA = texture(uAlb, vec3(brUv, uLayer));
brN = texture(uNrm, vec3(brUv, uLayer));
brO = texture(uOrmh, vec3(brUv, uLayer));
if (uBase >= 0.0) {
  // decal over a base surface: soft alpha (WP9 decal variant) or alpha-tested (SIGNAGE)
  vec2 bUv = vBrUv * uBaseScale;
  vec4 bA = texture(uAlb, vec3(bUv, uBase));
  vec4 bN = texture(uNrm, vec3(bUv, uBase));
  vec4 bO = texture(uOrmh, vec3(bUv, uBase));
  float a = uHardAlpha > 0.5 ? step(0.5, brA.a) : brA.a;
  brA = vec4(mix(bA.rgb, brA.rgb, a), 1.0);
  brN = mix(bN, brN, a);
  brO = vec4(mix(bO.rgb, brO.rgb, a), brO.a * a);
} else if (uAlphaTest > 0.5 && brA.a < 0.5) discard;
diffuseColor.rgb *= brA.rgb;`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = brO.g;')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = brO.b;')
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
{
  vec3 mapN = brN.xyz * 2.0 - 1.0;
  vec3 q0 = dFdx(-vViewPosition), q1 = dFdy(-vViewPosition);
  vec2 st0 = dFdx(brUv), st1 = dFdy(brUv);
  vec3 N = normal;
  vec3 q1perp = cross(q1, N), q0perp = cross(N, q0);
  vec3 T = q1perp * st0.x + q0perp * st1.x;
  vec3 B = q1perp * st0.y + q0perp * st1.y;
  float det = max(dot(T, T), dot(B, B));
  float sc = det == 0.0 ? 0.0 : faceDirection * inversesqrt(det);
  normal = normalize(T * (mapN.x * sc) + B * (mapN.y * sc) + N * mapN.z);
}`)
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += brO.a * uEmit * brA.rgb;')
      .replace('#include <aomap_fragment>', '#include <aomap_fragment>\nreflectedLight.indirectDiffuse *= brO.r;\nreflectedLight.indirectSpecular *= mix(1.0, brO.r, 0.7);');
  };
  m.customProgramCacheKey = () => 'br-materials-lit-v2';
  return m;
}

// ---------------------------------------------------------------- page
function label(root: HTMLElement, text: string, x: number, y: number, w: number): void {
  const el = document.createElement('div');
  el.textContent = text;
  el.style.cssText = `position:absolute;left:${x}px;top:${y}px;width:${w}px;font:11px/1.2 monospace;color:#ddd;` +
    'text-shadow:0 0 3px #000,0 0 2px #000;pointer-events:none;white-space:nowrap;overflow:hidden';
  root.appendChild(el);
}

async function main(): Promise<void> {
  const root = document.getElementById('app') ?? document.body;
  root.style.position = 'relative';
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(1);
  renderer.setSize(innerWidth, innerHeight);
  renderer.toneMapping = THREE.AgXToneMapping;
  renderer.toneMappingExposure = 1;
  root.appendChild(renderer.domElement);
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:absolute;inset:0;pointer-events:none';
  root.appendChild(overlay);
  const panel = document.createElement('pre');
  panel.style.cssText = 'position:absolute;right:6px;bottom:4px;margin:0;font:11px/1.25 monospace;color:#eee;' +
    'background:rgba(0,0,0,0.6);padding:4px 6px;max-height:48vh;overflow:hidden;pointer-events:none';
  if (hud) root.appendChild(panel);

  let frames = 0;
  let phase = 'textures';
  let albedo: LayerAlbedoReport[] | null = null;
  let range: LayerRangeReport[] | null = null;
  let heightMax: Float64Array | null = null;
  let seams: SeamDetail[] | null = null;
  let orient: OrientationReport[] | null = null;
  let ormhMeans: Float64Array | null = null;
  let auxRange: LayerAuxRange[] | null = null;
  let signSlots: Float64Array | null = null;
  let detailMeans: Float64Array | null = null;
  let set: TextureSet | null = null;
  const errors: string[] = [];

  const api: HarnessDebugAPI = {
    ready: false,
    isReady: () => api.ready,
    stats: () => ({
      page: 'materials', view, layer: single, size, phase, frames,
      bake: textureBakeStats(),
      detailMs: detailBakeStats(),
      // extra=detail: per layer the rms slope (m/m, from the mean of E[s^2]) and the mean albedo multiplier
      detailMoments: detailMeans ? DETAIL_RECIPES.map((r, l) => ({
        n: r.name, rmsSlope: +(Math.sqrt(2 * detailMeans![l * 4 + 3]) * r.slope).toPrecision(3), mult: +(2 * detailMeans![l * 4 + 2]).toFixed(3),
      })) : null,
      programs: renderer.info.programs?.length ?? 0,
      albedoFails: albedo ? albedo.filter((r) => !r.ok).map((r) => `${r.name} m=${r.measured.map((v) => v.toFixed(3)).join(',')} d=${r.declared.join(',')}`) : null,
      albedo: albedo?.map((r) => ({ n: r.name, m: r.measured.map((v) => +v.toFixed(4)), ok: r.ok })) ?? null,
      albedoRange: range?.map((r) => ({ n: r.name, p2: +r.p2.toFixed(4), p98: +r.p98.toFixed(4), ok: r.ok })) ?? null,
      albedoRangeFails: range ? range.filter((r) => !r.ok).map((r) => `${r.name} p2=${r.p2.toFixed(3)} p98=${r.p98.toFixed(3)}`) : null,
      // POM layers: the relief top must stay within 0.02 of SURFACE_PHYS.pomTop
      heightMax: heightMax ? Array.from(heightMax, (v, l) => `${LAYER_DEFS[l].name}: ${v.toFixed(3)}${SURFACE_PHYS[l as MatId].pomTop > 0 ? ` (pomTop ${SURFACE_PHYS[l as MatId].pomTop})` : ''}`) : null,
      heightFails: heightMax ? LAYER_DEFS.filter((d) => SURFACE_PHYS[d.id].pomTop > 0 && heightMax![d.id] > SURFACE_PHYS[d.id].pomTop + 0.02).map((d) => `${d.name}: ${heightMax![d.id].toFixed(3)}`) : null,
      seamMax: seams ? Math.max(...seams.map((s) => s.maxEdgeDelta)) * 255 : null,
      seamFails: seams ? seams.filter((s) => s.maxEdgeDelta >= 2 / 255).map((s) => `${LAYER_DEFS[s.layer].name}:${s.parts.join('/')}`) : null,
      orientation: orient,
      // calibration aid: trim that would put each layer's mean exactly on LAYER_DEFS (current trim x declared / measured)
      trimSuggest: albedo ? albedo.map((r) => `${r.layer}: [${LAYER_RECIPES_FULL[r.layer].trim.map((t, i) => (t * r.declared[i] / Math.max(1e-4, r.measured[i])).toFixed(3)).join(', ')}]`) : null,
      // per-slot mean linear albedo of the SIGNAGE atlas (SignKind order): which artwork drives the layer mean
      signSlotMeans: signSlots ? Array.from({ length: 16 }, (_, i) => Array.from(signSlots!.subarray(i * 4, i * 4 + 4), (v) => +v.toFixed(3))) : null,
      lensEmissiveMean: ormhMeans ? +ormhMeans[Mat.PANEL_LENS * 4 + 3].toFixed(3) : null,
      // texture realism v2: per-layer mean of ormh.a (the aux channel: 0 on 'none' layers, the emissive mask on
      // PANEL_LENS / SIGNAGE) and the layers whose ormh.a is not 0 although their aux kind is 'none'
      ormhAlphaMeans: ormhMeans ? Array.from({ length: MAT_COUNT }, (_, l) => +ormhMeans![l * 4 + 3].toFixed(4)) : null,
      auxNoneFails: ormhMeans ? LAYER_RECIPES_FULL.filter((r) => r.aux === 'none' && ormhMeans![r.layer * 4 + 3] !== 0).map((r) => LAYER_DEFS[r.layer].name) : null,
      // ...and per layer its range (min, p2, p98, max of the 32x32 cell means; checks=range) next to the aux kind
      auxRange: auxRange ? auxRange.map((r) => ({ n: r.name, kind: LAYER_RECIPES_FULL[r.layer].aux, min: +r.min.toFixed(3), p2: +r.p2.toFixed(3), p98: +r.p98.toFixed(3), max: +r.max.toFixed(3) })) : null,
      errors,
    }),
    layerAlbedoCheck: () => (set ? layerAlbedoCheck(renderer, set) : Promise.resolve([])),
    tileSeamCheck: () => (set ? tileSeamCheck(renderer, set) : Promise.resolve([])),
  };
  window.__backrooms = api;

  set = await generateTextures(renderer, size, renderer.capabilities.getMaxAnisotropy(), (f) => { phase = `textures ${(f * 100).toFixed(0)}%`; });
  if (detailView) set.detail = await generateDetailTextures(renderer, renderer.capabilities.getMaxAnisotropy());
  const ts = set;

  // ---- scene
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0c0c0c);
  const aspect = (): number => innerWidth / Math.max(1, innerHeight);
  let camera: THREE.Camera;
  let animate: ((t: number) => void) | null = null;

  if (view === 'lit') {
    RectAreaLightUniformsLib.init();
    const cam = new THREE.PerspectiveCamera(45, aspect(), 0.05, 100);
    camera = cam;
    const area = new THREE.RectAreaLight(0xfff1d8, 14, 1.2, 0.6);
    scene.add(area);
    const fill = new THREE.HemisphereLight(0xfff4e0, 0x302820, 0.35);
    scene.add(fill);
    const spot = new THREE.PointLight(0xffe8c8, 2.5, 12, 2);
    scene.add(spot);
    if (single >= 0) {
      const d = LAYER_DEFS[single];
      const bd = LAYER_DEFS[Math.max(0, baseLayer)];
      const fr = frameOf(single), bf = frameOf(Math.max(0, baseLayer));
      const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), litMaterial(ts, single, new THREE.Vector2(2 / fr[0], 2 / fr[1]),
        baseLayer, new THREE.Vector2(2 / bf[0], 2 / bf[1])));
      quad.rotation.x = -1.05;
      quad.position.set(0.55, -0.35, 0);
      scene.add(quad);
      const sphere = new THREE.Mesh(new THREE.SphereGeometry(0.42, 128, 64), litMaterial(ts, single, new THREE.Vector2(2.64 / fr[0], 1.32 / fr[1]),
        baseLayer, new THREE.Vector2(2.64 / bf[0], 1.32 / bf[1])));
      sphere.position.set(-0.95, 0.2, 0.1);
      scene.add(sphere);
      cam.position.set(0, 0.95, 2.6);
      cam.lookAt(0, -0.1, 0);
      label(overlay, `${single} ${d.name} (lit)${baseLayer >= 0 ? ` over ${baseLayer} ${bd.name}` : ''}`, 8, 6, 400);
      animate = (t) => {
        area.position.set(Math.sin(t * 0.6) * 1.3, 1.25, 0.6 + Math.cos(t * 0.6) * 0.9);
        area.lookAt(0, -0.3, 0);
        spot.position.set(Math.cos(t * 0.9) * 1.6, 0.6, 1.2);
      };
    } else {
      const grid = new THREE.Group();
      for (let l = 0; l < MAT_COUNT; l++) {
        const fr = frameOf(l);
        const quad = new THREE.Mesh(new THREE.PlaneGeometry(0.95, 0.95), litMaterial(ts, l, new THREE.Vector2(0.95 / fr[0], 0.95 / fr[1])));
        quad.position.set((l % COLS) - (COLS - 1) / 2, (ROWS - 1) / 2 - Math.floor(l / COLS), 0);
        grid.add(quad);
      }
      grid.rotation.x = -0.35;
      scene.add(grid);
      cam.position.set(0, 0, 6.4);
      cam.lookAt(0, 0, 0);
      animate = (t) => {
        area.width = 4; area.height = 1.5;
        area.position.set(Math.sin(t * 0.5) * 3, 2.2, 1.6);
        area.lookAt(0, 0, 0);
        spot.position.set(Math.cos(t * 0.7) * 3, -0.5, 2.0);
      };
    }
  } else {
    const ortho = new THREE.OrthographicCamera(-aspect(), aspect(), 1, -1, 0, 2);
    ortho.position.z = 1;
    camera = ortho;
    const H = innerHeight, W = innerWidth;
    if (detailView && single < 0) {
      // detail gallery: 4 x 3 layers
      const cols = 4, rows = Math.ceil(DETAIL_COUNT / cols);
      const cell = Math.min((2 * aspect()) / cols, 2 / rows);
      for (let l = 0; l < DETAIL_COUNT; l++) {
        const quad = new THREE.Mesh(new THREE.PlaneGeometry(cell * 0.97, cell * 0.97), viewMaterial(ts, l));
        const cx = ((l % cols) - (cols - 1) / 2) * cell;
        const cy = ((rows - 1) / 2 - Math.floor(l / cols)) * cell;
        quad.position.set(cx, cy, 0);
        scene.add(quad);
        const px = ((cx - cell * 0.485) / (2 * aspect()) + 0.5) * W;
        const py = (0.5 - (cy + cell * 0.485) / 2) * H;
        label(overlay, `D${l} ${DETAIL_RECIPES[l].name} ch=${chName}`, px + 3, py + 2, (cell / (2 * aspect())) * W - 6);
      }
    } else if (single >= 0 || extra) {
      const layer = single >= 0 ? single : 0;
      const d = LAYER_DEFS[layer];
      const fm = frameOf(layer);
      const fr = extra ? 1 : fm[1] / fm[0]; // frame aspect (v / u)
      const h = 1.9, w = h / fr;
      const sc = Math.min(1, (2 * aspect() * 0.98) / w);
      const quad = new THREE.Mesh(new THREE.PlaneGeometry(w * sc, h * sc), viewMaterial(ts, layer));
      scene.add(quad);
      const what = detailView ? `D${layer} ${DETAIL_RECIPES[Math.min(layer, DETAIL_COUNT - 1)].name} ch=${chName}, ${tile}x${tile} repeats of 0.3 m` : `extra=${extra}`;
      label(overlay, extra ? what : `${layer} ${d.name}  view=${view} ch=${chName}${mip >= 0 ? ` mip=${mip}` : ''}  ${fm[0]}x${fm[1]} m, ${tile}x${tile} repeats`, 8, 6, W - 16);
    } else {
      const cell = Math.min((2 * aspect()) / COLS, 2 / ROWS);
      for (let l = 0; l < MAT_COUNT; l++) {
        const quad = new THREE.Mesh(new THREE.PlaneGeometry(cell * 0.97, cell * 0.97), viewMaterial(ts, l));
        const cx = ((l % COLS) - (COLS - 1) / 2) * cell;
        const cy = ((ROWS - 1) / 2 - Math.floor(l / COLS)) * cell;
        quad.position.set(cx, cy, 0);
        scene.add(quad);
        const px = ((cx - cell * 0.485) / (2 * aspect()) + 0.5) * W;
        const py = (0.5 - (cy + cell * 0.485) / 2) * H;
        label(overlay, `${l} ${LAYER_DEFS[l].name}`, px + 3, py + 2, (cell / (2 * aspect())) * W - 6);
      }
    }
  }

  const resize = (): void => {
    renderer.setSize(innerWidth, innerHeight);
    if (camera instanceof THREE.PerspectiveCamera) { camera.aspect = aspect(); camera.updateProjectionMatrix(); }
    else if (camera instanceof THREE.OrthographicCamera) { camera.left = -aspect(); camera.right = aspect(); camera.updateProjectionMatrix(); }
  };
  addEventListener('resize', resize);

  // ---- checks
  if (runChecks) {
    try {
      phase = 'albedo check';
      if (checkList.includes('albedo')) {
        albedo = await layerAlbedoCheck(renderer, ts);
        ormhMeans = await reduceLayers(renderer, ts.ormh, ts.size);
        signSlots = await reduceAtlasSlots(renderer, ts.albedo, ts.size, Mat.SIGNAGE);
      }
      if (detailView && ts.detail) detailMeans = await reduceLayers(renderer, ts.detail, DETAIL_SIZE);
      phase = 'range check';
      if (checkList.includes('range')) {
        range = await layerAlbedoRangeCheck(renderer, ts);
        heightMax = await layerHeightMax(renderer, ts);
        auxRange = await layerAuxRange(renderer, ts);
      }
      phase = 'seam check';
      if (checkList.includes('seam')) seams = await tileSeamCheckDetailed(renderer, ts);
      phase = 'orientation check';
      if (checkList.includes('orient')) orient = await arrowOrientationCheck(renderer, ts);
    } catch (e) {
      errors.push(String((e as Error)?.stack ?? e));
      console.error(e);
    }
  }
  phase = 'frames';

  const b = textureBakeStats();
  const lines: string[] = [];
  if (b) lines.push(`size ${b.size}  compile ${b.compileMs.toFixed(0)} ms  gen ${b.genMs.toFixed(0)} ms  total ${b.totalMs.toFixed(0)} ms`);
  if (albedo) {
    const bad = albedo.filter((r) => !r.ok);
    lines.push(`albedo: ${albedo.length - bad.length}/${albedo.length} within 10%`);
    for (const r of bad) lines.push(`  FAIL ${r.name}: ${r.measured.map((v) => v.toFixed(3)).join(' ')} vs ${r.declared.join(' ')}`);
  }
  if (range) {
    const bad = range.filter((r) => !r.ok);
    lines.push(`albedo range: ${range.length - bad.length}/${range.length} p2/p98 in [0.02, 0.9]`);
    for (const r of bad) lines.push(`  FAIL ${r.name}: p2 ${r.p2.toFixed(3)} p98 ${r.p98.toFixed(3)}`);
  }
  if (seams) {
    const worst = seams.reduce((a, s) => (s.maxEdgeDelta > a.maxEdgeDelta ? s : a), seams[0]);
    lines.push(`seams: max ${(worst.maxEdgeDelta * 255).toFixed(1)}/255 (${LAYER_DEFS[worst.layer].name})`);
  }
  if (orient) for (const o of orient) lines.push(`${o.ok ? 'ok  ' : 'FAIL'} ${o.name}: ${o.detail}`);
  for (const e of errors) lines.push(`ERROR ${e.split('\n')[0]}`);
  panel.textContent = lines.join('\n');

  const clock = new THREE.Timer();
  renderer.setAnimationLoop(() => {
    clock.update();
    const t = tFixed ?? clock.getElapsed();
    animate?.(t);
    renderer.render(scene, camera);
    if (++frames >= READY_FRAMES) api.ready = true;
  });
}

main().catch((e) => {
  console.error(e);
});
