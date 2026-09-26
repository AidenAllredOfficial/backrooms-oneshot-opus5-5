// src/app/qualityAuto.ts (WP14) — 'auto' quality via WEBGL_debug_renderer_info (see core/quality.ts header):
// SwiftShader/llvmpipe/Software and weak integrated GPUs (Radeon 610M: 2 CUs; Intel UHD / HD Graphics) -> low;
// other integrated GPUs (Radeon 680M/780M/880M/890M, Iris Xe, Arc Graphics, Mali/Adreno/Apple) and entry-level /
// old discrete NVIDIA (GeForce MX, GT, GTX 7xx/9xx/10x0, Quadro K/M/P: 2-4 GB VRAM) -> medium; else high.
// On hybrid-GPU laptops Chromium on Linux renders on the GPU its GL backend picks (often the iGPU) and ignores
// powerPreference: isIntegratedRenderer() lets the title screen say so.
// The renderer string is read from the app's own renderer context (no probe context, STATUS 2026-09-24).

import type { QualityConfig, QualityName } from '../core/quality.ts';

const SOFTWARE = /swiftshader|llvmpipe|softpipe|software|basic render|microsoft basic|lavapipe|mesa offscreen/i;
// Apple discrete-class chips ("Apple M1 Max", "M2 Ultra"...) are still unified-memory iGPUs: medium is the safe start.
// entry-level / old discrete NVIDIA: 2-4 GB VRAM (high holds ~1.6 GB of tiles + targets at radius 2) (R2 B9)
const LOW_DISCRETE = /\bMX\s?\d{3}\b|\bGT\s?\d{3,4}\b|\bGTX\s?(7|9|10)\d0\b|\bQuadro [KMP]\d{3,4}\b/i;
const INTEGRATED = /intel|mali|adreno|powervr|apple|vivante|videocore|tegra|img tec|imagination|radeon\(tm\) graphics|radeon graphics|vega \d+ graphics/i;
// AMD APU graphics: "AMD Radeon 610M (radeonsi raphael_mendocino ...)", "Radeon(TM) 780M", RADV codenames
const AMD_IGPU = /radeon(\(tm\))?\s*\d{3}m\b|radeon(\(tm\))?\s*8\d{2}0s\b|raphael|mendocino|rembrandt|phoenix|hawk ?point|strix|krackan|renoir|cezanne|lucienne|barcelo|picasso|raven|vangogh|van gogh/i;
// weakest integrated parts: 2-CU RDNA2 (610M), Intel Gen9-12 UHD / HD Graphics
const WEAK_IGPU = /radeon(\(tm\))?\s*610m\b|mendocino|\buhd graphics\b|\bhd graphics\b/i;
const DISCRETE_INTEL = /arc\(tm\) [ab]\d{3}|\barc [ab]\d{3}/i;

/** True for an integrated GPU (shares system memory; on a hybrid laptop a discrete GPU may be idle). */
export function isIntegratedRenderer(renderer: string): boolean {
  if (SOFTWARE.test(renderer) || DISCRETE_INTEL.test(renderer)) return false;
  if (AMD_IGPU.test(renderer) || WEAK_IGPU.test(renderer)) return true;
  if (/nvidia|geforce|quadro|rtx|radeon rx|radeon pro/i.test(renderer)) return false;
  return INTEGRATED.test(renderer);
}

/** Pure classification of an (unmasked) renderer string. Empty/unknown strings are treated as capable ('high'). */
export function classifyRenderer(renderer: string): QualityName {
  if (SOFTWARE.test(renderer)) return 'low';
  if (WEAK_IGPU.test(renderer)) return 'low';
  if (AMD_IGPU.test(renderer)) return 'medium';
  if (/arc\(tm\) graphics|intel\(r\) arc\(tm\) graphics/i.test(renderer)) return 'medium'; // Meteor / Lunar Lake iGPU
  if (LOW_DISCRETE.test(renderer)) return 'medium';
  // ANGLE strings look like "ANGLE (NVIDIA, NVIDIA GeForce RTX 5070 Ti Laptop GPU (0x...) Direct3D11 ...)":
  // a discrete vendor anywhere wins over an integrated keyword (hybrid laptops report the active GPU).
  if (/nvidia|geforce|quadro|rtx|radeon rx|radeon pro|arc\(tm\)|intel\(r\) arc|intel arc/i.test(renderer)) return 'high';
  if (INTEGRATED.test(renderer)) return 'medium';
  return 'high';
}

/** Unmasked renderer string of a context ('' if unavailable). */
export function rendererString(gl: WebGL2RenderingContext): string {
  try {
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const s = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    return typeof s === 'string' ? s : '';
  } catch {
    return '';
  }
}

/** resolveQuality for a renderer string already read (the GPU-priming probe). */
export function resolveQualityName(q: QualityName | 'auto', renderer: string): QualityName {
  return q !== 'auto' ? q : classifyRenderer(renderer);
}

export function resolveQuality(q: QualityName | 'auto', gl: WebGL2RenderingContext): QualityName {
  if (q !== 'auto') return q;
  return classifyRenderer(rendererString(gl));
}

/** QualityConfig fields that only change the output resolution / prop culling (no programs, bakes or streaming). */
export const RESOLUTION_KEYS: readonly (keyof QualityConfig)[] = ['renderScale', 'dynamicResolution', 'maxDpr', 'propDistance'];

/** True when a and b differ at most in RESOLUTION_KEYS: applyQuality then skips warmup and the ready gate. */
export function isResolutionOnlyChange(a: QualityConfig, b: QualityConfig): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)] as (keyof QualityConfig)[]);
  for (const k of keys) if (!RESOLUTION_KEYS.includes(k) && a[k] !== b[k]) return false;
  return true;
}
