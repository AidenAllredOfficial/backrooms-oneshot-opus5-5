// src/app/renderer.ts (WP14) — the one WebGLRenderer (WebGL2, no MSAA, no tone mapping: post owns the display transform).

import * as THREE from 'three';
import type { QualityConfig } from '../core/quality.ts';
import { effectiveDpr, maxScaleFor } from '../post/DynamicResolution.ts';

/** Thrown when the GPU/browser cannot run the game; App shows the error screen with `title` + `message`. */
export class UnsupportedError extends Error {
  readonly title: string;
  constructor(title: string, message: string) {
    super(message);
    this.name = 'UnsupportedError';
    this.title = title;
  }
}

/** min(devicePixelRatio, maxDpr) x renderScale, the supersampling part capped so the ratio stays <= 2
 * (post/DynamicResolution.ts MAX_PIXEL_RATIO: ultra's 1.5x on a 2x display would otherwise ask for 3x buffers). */
export function pixelRatioFor(q: QualityConfig, dpr: number): number {
  return effectiveDpr(q, dpr) * maxScaleFor(q, dpr);
}

const PRIMED_KEY = 'backrooms.gpuPrimed';

/**
 * Chromium on Linux loses the first WebGL context of a fresh browser session on the NVIDIA GPU (ANGLE Vulkan, and
 * ANGLE GL under PRIME offload) ~0.3 s after it is created and restores it ~1 s later, whatever its powerPreference
 * (measured on this RTX 5070 Ti laptop; the AMD iGPU path does not). It is the native Wayland backend failing to set
 * up GPU compositing and restarting the GPU process in software-compositing mode; under XWayland
 * (--ozone-platform=x11) it does not happen. Losing the game's own context throws away every texture and program
 * built so far, so a throwaway 1x1 context absorbs the loss first: `ready` resolves when no loss came within 450 ms
 * or after the restore. The probe also reports the renderer string at once, so the quality preset (and the worker
 * pool that depends on it) can start while `ready` is pending. The wait runs once per tab, and not at all with
 * wait = false (launch param noprime=1: the play launcher under XWayland; ~0.55 s off the boot).
 */
export function primeGpuContext(wait = true): { renderer: string; ready: Promise<void> } {
  if (typeof document === 'undefined') return { renderer: '', ready: Promise.resolve() };
  const c = document.createElement('canvas');
  c.width = c.height = 1;
  const gl = c.getContext('webgl2');
  if (!gl) return { renderer: '', ready: Promise.resolve() };
  let renderer = '';
  try {
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    renderer = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
  } catch { /* no renderer string */ }
  let primed = false;
  try { primed = sessionStorage.getItem(PRIMED_KEY) !== null; } catch { /* storage blocked: prime anyway */ }
  const release = (): void => {
    try { sessionStorage.setItem(PRIMED_KEY, '1'); } catch { /* ignore */ }
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  };
  if (!wait || primed || !/vulkan|nvidia/i.test(renderer)) {
    release();
    return { renderer, ready: Promise.resolve() };
  }
  const ready = new Promise<void>((resolve) => {
    let lost = false;
    let done = false;
    const finish = (): void => { if (!done) { done = true; release(); resolve(); } };
    c.addEventListener('webglcontextlost', (e) => { e.preventDefault(); lost = true; });
    c.addEventListener('webglcontextrestored', finish);
    setTimeout(() => { if (!lost) finish(); }, 450);
    setTimeout(finish, 3000);
  });
  return { renderer, ready };
}

export function createRenderer(canvas: HTMLCanvasElement, q: QualityConfig): THREE.WebGLRenderer {
  let r: THREE.WebGLRenderer;
  try {
    r = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false, depth: true });
  } catch (e) {
    throw new UnsupportedError('WebGL 2 unavailable',
      `This browser could not create a WebGL 2 context (${e instanceof Error ? e.message : String(e)}). ` +
      'Enable hardware acceleration or try a current Chrome, Edge or Firefox.');
  }
  const gl = r.getContext();
  // HalfFloat render targets (the whole post stack, exposure, reflections) need float colour attachments.
  if (!gl.getExtension('EXT_color_buffer_float')) {
    r.dispose();
    throw new UnsupportedError('Float render targets unsupported',
      'EXT_color_buffer_float is missing: this GPU/driver cannot render to half-float targets, which the ' +
      'lighting pipeline requires.');
  }
  r.toneMapping = THREE.NoToneMapping;
  r.outputColorSpace = THREE.SRGBColorSpace;
  r.shadowMap.enabled = true;
  r.shadowMap.type = THREE.PCFShadowMap;
  r.info.autoReset = false; // reset once per frame by the loop
  r.setPixelRatio(pixelRatioFor(q, typeof devicePixelRatio === 'number' ? devicePixelRatio : 1));
  r.setClearColor(0x000000, 1);
  return r;
}
