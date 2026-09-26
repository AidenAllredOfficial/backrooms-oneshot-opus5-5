// src/textures/albedoCheck.ts — GPU checks on a generated TextureSet (run by harness/materials.html) (WP8).
//
// layerAlbedoCheck: a reduction shader over mip level 0 of the albedo array (texelFetch of the SRGB8_ALPHA8 array
//   decodes to linear before averaging; the driver's 1x1 mip is never used because some drivers average sRGB
//   mips in gamma space). Each layer must be within 10 % of LAYER_DEFS.albedoMean per channel (floor 0.01).
// tileSeamCheck: re-evaluates every recipe one texel OUTSIDE the texture (virtual row -1 and column -1, i.e. the
//   continuation of the infinite periodic surface) and compares it with the stored last row / column, which is
//   what the sampler shows there when the texture tiles. Compared: albedo rgba (stored sRGB bytes), ormh rgba and
//   height (normal.a). Normals are derived from the height with wrap sampling, so they tile iff the height does.
// arrowOrientationCheck: samples the arrow glyphs (SIGNAGE ARROW_UP / EXIT_LEFT / EXIT_RIGHT, DECAL CHALK_ARROW)
//   and checks that they point +v / left / right as the core DecalPlacement convention requires.

import * as THREE from 'three';
import { DecalKind, Mat, MAT_COUNT, SignKind } from '../core/ids.ts';
import { LAYER_DEFS } from '../core/materials.ts';
import type { LayerAlbedoReport } from '../core/debug.ts';
import type { TextureSet } from '../core/runtime.ts';
import { FULLSCREEN_VERTEX } from './glsl/common.ts';
import { createBlitter, createGenerator, OUT_ALBEDO, OUT_HEIGHT, OUT_ORMH, type Blitter } from './programs.ts';

const REDUCE_FRAGMENT = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2DArray;
uniform sampler2DArray uArr;
uniform int uGrid;   // output cells per layer side
uniform int uBlock;  // texels per cell side
layout(location = 0) out highp vec4 fragColor;
void main() {
  ivec2 o = ivec2(floor(gl_FragCoord.xy));
  int layer = o.y / uGrid;
  ivec2 cell = ivec2(o.x, o.y - layer * uGrid);
  vec4 acc = vec4(0.0);
  for (int y = 0; y < uBlock; y++) {
    vec4 row = vec4(0.0);
    for (int x = 0; x < uBlock; x++) row += texelFetch(uArr, ivec3(cell * uBlock + ivec2(x, y), layer), 0);
    acc += row;
  }
  fragColor = acc / float(uBlock * uBlock);
}
`;

const FETCH_FRAGMENT = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2DArray;
uniform sampler2DArray uArr;
uniform int uLayer;
uniform int uOffX;
uniform int uOffY;
uniform int uSize;
uniform int uMode; // 0 rgba, 1 alpha -> r
layout(location = 0) out highp vec4 fragColor;
void main() {
  ivec2 p = ivec2(floor(gl_FragCoord.xy)) + ivec2(uOffX, uOffY);
  p -= uSize * ivec2(floor(vec2(p) / float(uSize)));
  vec4 t = texelFetch(uArr, ivec3(p, uLayer), 0);
  fragColor = uMode == 1 ? vec4(t.a, 0.0, 0.0, 1.0) : t;
}
`;

const raw = (fragmentShader: string, uniforms: Record<string, THREE.IUniform>): THREE.RawShaderMaterial =>
  new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3, vertexShader: FULLSCREEN_VERTEX, fragmentShader, uniforms,
    depthTest: false, depthWrite: false, blending: THREE.NoBlending,
  });

function withState<T>(renderer: THREE.WebGLRenderer, fn: () => Promise<T>): Promise<T> {
  const prev = renderer.getRenderTarget();
  const prevAuto = renderer.autoClear;
  renderer.autoClear = false;
  return fn().finally(() => {
    renderer.setRenderTarget(prev);
    renderer.autoClear = prevAuto;
  });
}

/** Mean linear albedo per layer (mip 0), compared with LAYER_DEFS.albedoMean. */
export function layerAlbedoCheck(renderer: THREE.WebGLRenderer, set: TextureSet): Promise<LayerAlbedoReport[]> {
  return withState(renderer, async () => {
    const means = await reduceLayers(renderer, set.albedo, set.size);
    const out: LayerAlbedoReport[] = [];
    for (let l = 0; l < MAT_COUNT; l++) {
      const d = LAYER_DEFS[l];
      const measured: [number, number, number] = [means[l * 4], means[l * 4 + 1], means[l * 4 + 2]];
      const declared: [number, number, number] = [d.albedoMean[0], d.albedoMean[1], d.albedoMean[2]];
      const ok = measured.every((m, i) => Math.abs(m - declared[i]) <= Math.max(0.1 * declared[i], 0.01));
      out.push({ layer: l, name: d.name, measured, declared, ok });
    }
    return out;
  });
}

/** Per-layer mean of all four channels of an array texture at mip 0 (linear). Length MAT_COUNT * 4. */
export function reduceLayers(renderer: THREE.WebGLRenderer, arr: THREE.Texture, size: number): Promise<Float64Array> {
  return withState(renderer, () => reduceLayersImpl(renderer, arr, size));
}

/** Mean linear rgba of each 4x4 atlas slot of one layer (mip 0), slot s at uv [(s%4)/4, floor(s/4)/4]. Length 64. */
export function reduceAtlasSlots(renderer: THREE.WebGLRenderer, arr: THREE.Texture, size: number, layer: number): Promise<Float64Array> {
  return withState(renderer, async () => {
    const out = new Float64Array(64);
    await reduceLayersImpl(renderer, arr, size, (l, x, y, v) => {
      if (l !== layer) return;
      const s = (y >> 3) * 4 + (x >> 3);
      for (let c = 0; c < 4; c++) out[s * 4 + c] += v[c] / 64;
    });
    return out;
  });
}

type CellVisitor = (layer: number, x: number, y: number, rgba: readonly number[]) => void;

async function reduceLayersImpl(renderer: THREE.WebGLRenderer, arr: THREE.Texture, size: number, visit?: CellVisitor): Promise<Float64Array> {
  const grid = 32;
  const block = size / grid;
  // Float target when renderable (EXT_color_buffer_float); otherwise RGBA8 cells: each 32x32 cell mean is
  // quantised to 1/255, and the per-layer mean of 1024 cells keeps that error far below the 10 % / 0.01 tolerance.
  const float = renderer.extensions.has('EXT_color_buffer_float');
  const rt = new THREE.WebGLRenderTarget(grid, grid * MAT_COUNT, {
    type: float ? THREE.FloatType : THREE.UnsignedByteType, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false,
    minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false,
  });
  const mat = raw(REDUCE_FRAGMENT, { uArr: { value: arr }, uGrid: { value: grid }, uBlock: { value: block } });
  const blit = createBlitter(renderer);
  try {
    blit.draw(mat, rt);
    const n = grid * grid * MAT_COUNT * 4;
    let px: Float32Array | Uint8Array;
    let scale = 1;
    if (float) {
      px = new Float32Array(n);
    } else {
      px = new Uint8Array(n);
      scale = 1 / 255;
    }
    await renderer.readRenderTargetPixelsAsync(rt, 0, 0, grid, grid * MAT_COUNT, px);
    const out = new Float64Array(MAT_COUNT * 4);
    for (let l = 0; l < MAT_COUNT; l++) {
      for (let i = 0; i < grid * grid; i++) {
        const o = (l * grid * grid + i) * 4;
        for (let c = 0; c < 4; c++) out[l * 4 + c] += px[o + c];
        if (visit) visit(l, i % grid, Math.floor(i / grid), [px[o] * scale, px[o + 1] * scale, px[o + 2] * scale, px[o + 3] * scale]);
      }
      for (let c = 0; c < 4; c++) out[l * 4 + c] *= scale / (grid * grid);
    }
    return out;
  } finally {
    rt.dispose(); mat.dispose(); blit.dispose();
  }
}

/** Max texel delta (0..1, stored encoding) across the tiling edges of each layer. Must be < 2/255. */
export async function tileSeamCheck(renderer: THREE.WebGLRenderer, set: TextureSet): Promise<{ layer: number; maxEdgeDelta: number }[]> {
  const d = await tileSeamCheckDetailed(renderer, set);
  return d.map((r) => ({ layer: r.layer, maxEdgeDelta: r.maxEdgeDelta }));
}

export interface SeamDetail {
  layer: number;
  maxEdgeDelta: number;
  /** max delta (0..255) per part: [albedo rows, ormh rows, height rows, albedo cols, ormh cols, height cols] */
  parts: number[];
}

/** tileSeamCheck with the per-part breakdown (albedo / ormh / height, rows / columns). */
export function tileSeamCheckDetailed(renderer: THREE.WebGLRenderer, set: TextureSet): Promise<SeamDetail[]> {
  return withState(renderer, async () => {
    const S = set.size;
    const N = MAT_COUNT;
    const opts = (srgb: boolean): THREE.RenderTargetOptions => ({
      type: THREE.UnsignedByteType, format: THREE.RGBAFormat, colorSpace: srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace,
      depthBuffer: false, stencilBuffer: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false,
    });
    // rows: S wide; per layer 2 albedo rows (gen, stored) and 4 linear rows (gen ormh, stored ormh, gen h, stored h)
    const rowAlb = new THREE.WebGLRenderTarget(S, 2 * N, opts(true));
    const rowLin = new THREE.WebGLRenderTarget(S, 4 * N, opts(false));
    const colAlb = new THREE.WebGLRenderTarget(2 * N, S, opts(true));
    const colLin = new THREE.WebGLRenderTarget(4 * N, S, opts(false));
    const gen = createGenerator(renderer, S);
    const fetchU = {
      uArr: { value: set.albedo as THREE.Texture }, uLayer: { value: 0 }, uOffX: { value: 0 }, uOffY: { value: 0 },
      uSize: { value: S }, uMode: { value: 0 },
    };
    const fetch = raw(FETCH_FRAGMENT, fetchU);
    try {
      await gen.compile();
      const rowSlot = (rt: THREE.WebGLRenderTarget, k: number): void => { rt.viewport.set(0, k, S, 1); };
      const colSlot = (rt: THREE.WebGLRenderTarget, k: number): void => { rt.viewport.set(k, 0, 1, S); };
      const stored = (rt: THREE.WebGLRenderTarget, arr: THREE.Texture, L: number, mode: number, offX: number, offY: number): void => {
        fetchU.uArr.value = arr; fetchU.uLayer.value = L; fetchU.uMode.value = mode;
        fetchU.uOffX.value = offX; fetchU.uOffY.value = offY;
        gen.blit.draw(fetch, rt);
      };
      for (let L = 0; L < N; L++) {
        gen.pass(L, OUT_HEIGHT, gen.scratch); // scratch = this layer's height (cavity AO of the ORMH strips)
        // ---- rows: generated virtual row -1 vs stored row S-1
        let k = 2 * L;
        rowSlot(rowAlb, k); gen.pass(L, OUT_ALBEDO, rowAlb, 0, 0, -1 - k);
        rowSlot(rowAlb, k + 1); stored(rowAlb, set.albedo, L, 0, 0, S - 1 - (k + 1));
        k = 4 * L;
        rowSlot(rowLin, k); gen.pass(L, OUT_ORMH, rowLin, 0, 0, -1 - k);
        rowSlot(rowLin, k + 1); stored(rowLin, set.ormh, L, 0, 0, S - 1 - (k + 1));
        rowSlot(rowLin, k + 2); gen.pass(L, OUT_HEIGHT, rowLin, 0, 0, -1 - (k + 2));
        rowSlot(rowLin, k + 3); stored(rowLin, set.normal, L, 1, 0, S - 1 - (k + 3));
        // ---- columns: generated virtual column -1 vs stored column S-1
        k = 2 * L;
        colSlot(colAlb, k); gen.pass(L, OUT_ALBEDO, colAlb, 0, -1 - k, 0);
        colSlot(colAlb, k + 1); stored(colAlb, set.albedo, L, 0, S - 1 - (k + 1), 0);
        k = 4 * L;
        colSlot(colLin, k); gen.pass(L, OUT_ORMH, colLin, 0, -1 - k, 0);
        colSlot(colLin, k + 1); stored(colLin, set.ormh, L, 0, S - 1 - (k + 1), 0);
        colSlot(colLin, k + 2); gen.pass(L, OUT_HEIGHT, colLin, 0, -1 - (k + 2), 0);
        colSlot(colLin, k + 3); stored(colLin, set.normal, L, 1, S - 1 - (k + 3), 0);
      }
      const read = async (rt: THREE.WebGLRenderTarget): Promise<Uint8Array> => {
        rt.viewport.set(0, 0, rt.width, rt.height);
        const buf = new Uint8Array(rt.width * rt.height * 4);
        await renderer.readRenderTargetPixelsAsync(rt, 0, 0, rt.width, rt.height, buf);
        return buf;
      };
      const [ra, rl, ca, cl] = [await read(rowAlb), await read(rowLin), await read(colAlb), await read(colLin)];
      const out: SeamDetail[] = [];
      for (let L = 0; L < N; L++) {
        const cmpRows = (buf: Uint8Array, w: number, a: number, b: number, ch: number): number => {
          let max = 0;
          for (let x = 0; x < S; x++) {
            for (let c = 0; c < ch; c++) max = Math.max(max, Math.abs(buf[(a * w + x) * 4 + c] - buf[(b * w + x) * 4 + c]));
          }
          return max;
        };
        const cmpCols = (buf: Uint8Array, w: number, a: number, b: number, ch: number): number => {
          let max = 0;
          for (let y = 0; y < S; y++) {
            for (let c = 0; c < ch; c++) max = Math.max(max, Math.abs(buf[(y * w + a) * 4 + c] - buf[(y * w + b) * 4 + c]));
          }
          return max;
        };
        const parts = [
          cmpRows(ra, S, 2 * L, 2 * L + 1, 4),
          cmpRows(rl, S, 4 * L, 4 * L + 1, 4),
          cmpRows(rl, S, 4 * L + 2, 4 * L + 3, 1),
          cmpCols(ca, 2 * N, 2 * L, 2 * L + 1, 4),
          cmpCols(cl, 4 * N, 4 * L, 4 * L + 1, 4),
          cmpCols(cl, 4 * N, 4 * L + 2, 4 * L + 3, 1),
        ];
        out.push({ layer: L, maxEdgeDelta: Math.max(...parts) / 255, parts });
      }
      return out;
    } finally {
      rowAlb.dispose(); rowLin.dispose(); colAlb.dispose(); colLin.dispose();
      fetch.dispose(); gen.dispose();
    }
  });
}

export interface OrientationReport { name: string; ok: boolean; detail: string }

/** Copy one atlas slot (channel: 'a' = texture alpha) of an array layer into a w x w RGBA8 buffer (row 0 = low v). */
async function readSlot(renderer: THREE.WebGLRenderer, blit: Blitter, fetch: THREE.RawShaderMaterial, arr: THREE.Texture,
  size: number, layer: number, slot: number): Promise<{ px: Uint8Array; w: number }> {
  const w = size / 4;
  const rt = new THREE.WebGLRenderTarget(w, w, {
    type: THREE.UnsignedByteType, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false,
    minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false,
  });
  try {
    const u = fetch.uniforms;
    u.uArr.value = arr; u.uLayer.value = layer; u.uMode.value = 1; u.uSize.value = size;
    u.uOffX.value = (slot % 4) * w; u.uOffY.value = Math.floor(slot / 4) * w;
    blit.draw(fetch, rt);
    const px = new Uint8Array(w * w * 4);
    await renderer.readRenderTargetPixelsAsync(rt, 0, 0, w, w, px);
    return { px, w };
  } finally { rt.dispose(); }
}

/** v (0..1, slot-local) of the row with the widest alpha extent. */
function widestRowV(px: Uint8Array, w: number): number {
  let best = -1, bestRow = 0;
  for (let y = 0; y < w; y++) {
    let lo = -1, hi = -1;
    for (let x = 0; x < w; x++) if (px[(y * w + x) * 4] > 127) { if (lo < 0) lo = x; hi = x; }
    const ext = lo < 0 ? 0 : hi - lo + 1;
    if (ext > best) { best = ext; bestRow = y; }
  }
  return (bestRow + 0.5) / w;
}

/** Alpha/emissive mass in the u-range [u0, u1) of a slot. */
function massInColumns(px: Uint8Array, w: number, u0: number, u1: number): number {
  let m = 0;
  for (let y = 0; y < w; y++) for (let x = Math.floor(u0 * w); x < Math.floor(u1 * w); x++) m += px[(y * w + x) * 4];
  return m / 255;
}

export function arrowOrientationCheck(renderer: THREE.WebGLRenderer, set: TextureSet): Promise<OrientationReport[]> {
  return withState(renderer, async () => {
    const blit = createBlitter(renderer);
    const fetch = raw(FETCH_FRAGMENT, {
      uArr: { value: set.albedo }, uLayer: { value: 0 }, uOffX: { value: 0 }, uOffY: { value: 0 }, uSize: { value: set.size }, uMode: { value: 1 },
    });
    const out: OrientationReport[] = [];
    try {
      // widest row = the head base: ARROW_UP (filled stencil, long head) at v ~ 0.38; CHALK_ARROW (open head) at v ~ 0.7.
      // A flipped atlas puts it at 1 - v.
      const cases: [string, number, number, number][] = [
        ['SIGNAGE.ARROW_UP', Mat.SIGNAGE, SignKind.ARROW_UP, 0.38],
        ['DECAL.CHALK_ARROW', Mat.DECAL_ATLAS, DecalKind.CHALK_ARROW, 0.7],
      ];
      for (const [name, layer, slot, expect] of cases) {
        const { px, w } = await readSlot(renderer, blit, fetch, set.albedo, set.size, layer, slot);
        const v = widestRowV(px, w);
        out.push({ name, ok: Math.abs(v - expect) < Math.abs(v - (1 - expect)), detail: `head base v=${v.toFixed(3)} (expected ~${expect})` });
      }
      // EXIT_LEFT / EXIT_RIGHT: the glowing chevron sits at the pointed side (emissive mask in ormh.a)
      for (const [name, slot, left] of [['SIGNAGE.EXIT_LEFT', SignKind.EXIT_LEFT, true], ['SIGNAGE.EXIT_RIGHT', SignKind.EXIT_RIGHT, false]] as const) {
        const { px, w } = await readSlot(renderer, blit, fetch, set.ormh, set.size, Mat.SIGNAGE, slot);
        const l = massInColumns(px, w, 0.03, 0.14);
        const r = massInColumns(px, w, 0.86, 0.97);
        const ok = left ? l > 2 * r + 1 : r > 2 * l + 1;
        out.push({ name, ok, detail: `emissive mass left=${l.toFixed(0)} right=${r.toFixed(0)}` });
      }
      return out;
    } finally {
      fetch.dispose(); blit.dispose();
    }
  });
}
