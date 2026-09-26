// src/post/DynamicResolution.ts — load-driven render scale (WP11, R2 B9).
//
// The frame INTERVAL is not the frame COST: a 50 Hz display, a 30 fps power-saving throttle or a background-tab
// clamp all produce long intervals while the GPU idles. The controller therefore decides on the cost of a frame
// relative to the display refresh, never on absolute milliseconds (a GPU downclocks under light load: the same
// frame reads 3.2 ms at scale 0.8 and 1.4 ms at 1.0, so absolute GPU thresholds oscillate).
//
// Every WINDOW_S window:
//   refresh = 20th percentile of the frame intervals, clamped to [6.9, 33.4] ms. It is tracked across windows: a
//             lower value is taken at once, a higher one is approached by REFRESH_RISE per window (a heavy stretch
//             at 60 Hz must not re-define the display as 30 Hz). The prior is 60 Hz.
//   with GPU timings (EXT_disjoint_timer_query_webgl2 results in at least half of the window's frames):
//             load = max(p90 gpu, p90 cpu); down DOWN when load > GPU_HIGH x refresh, up UP when < GPU_LOW x refresh
//   without:  down only when p50 interval > SLOW_P50 x refresh AND p90 cpu > SLOW_CPU x refresh (the main thread is
//             really busy: a throttle or a slow display has a short cpu time); up when p95 interval <= FAST_P95 x refresh
//   both:     missed vsyncs are load too, whatever the timer says (a TIME_ELAPSED query does not see compositor /
//             resolve / tiler work: ultra at 1.5x read 7 ms GPU while 11% of the 60 Hz frames took two intervals).
//             When the display estimate is stable (p20 <= REFRESH_STABLE x refresh: a throttle or a slower display
//             moves p20 itself), the main thread is light (p90 cpu < SLOW_CPU x refresh: a CPU stall is not fixed by
//             fewer pixels) and more than MISS_FRAC of the frames took > MISS_X x refresh in MISS_WINDOWS windows in a
//             row (the window in which a throttle starts mixes both intervals): down, and the
//             scale that missed becomes a ceiling for CEIL_HOLD windows (doubling on each repeat, up to CEIL_HOLD_MAX)
//             so the cost-based up-step does not climb straight back into the misses.
// Scale range [MIN, the preset's renderScale] (above 1 = supersampling, ultra). Applied with
// renderer.setPixelRatio(effectiveDpr x scale) and post.setSize at the start of the next frame (beforeRender: a canvas
// resize after the draw presents a cleared, black frame); the pixel ratio is capped at MAX_PIXEL_RATIO
// (supersampling a HiDPI display would otherwise ask for 3x+ buffers).
// Disabled when q.dynamicResolution is false (a scale= override): the preset scale is applied as is.

import * as THREE from 'three';
import type { QualityConfig } from '../core/quality.ts';
import type { PostStack } from '../core/runtime.ts';

export const DYNRES = {
  WINDOW_S: 2, DOWN: 0.1, UP: 0.05, MIN: 0.6, SETTLE_FRAMES: 10,
  REFRESH_P: 0.2, REFRESH_MIN: 6.9, REFRESH_MAX: 33.4, REFRESH_PRIOR: 1000 / 60, REFRESH_RISE: 0.25,
  GPU_HIGH: 0.85, GPU_LOW: 0.55, SLOW_P50: 1.25, SLOW_CPU: 0.5, FAST_P95: 1.05,
  MISS_X: 1.5, MISS_FRAC: 0.08, MISS_WINDOWS: 2, REFRESH_STABLE: 1.1, CEIL_HOLD: 15, CEIL_HOLD_MAX: 60,
  /** missed vsyncs count as GPU load only when the GPU timer (if any) reads >= this x refresh: an idle GPU's misses
   * are streaming / main-thread hitches that fewer pixels cannot fix (RTX 5070 Ti at 165 Hz: 2 of 6.1 ms = 0.33) */
  MISS_GPU_MIN: 0.5,
  /** the controller budgets for at least this frame time: on a high-refresh display (165 Hz: 6.06 ms) a missed vsync
   * still leaves 80+ fps, while every scale change re-allocates the post targets (a ~100 ms hitch measured on an RTX
   * 5070 Ti laptop), so load and misses are judged against max(refresh, 1000 / 90) */
  BUDGET_MIN_MS: 1000 / 90,
  /** legacy absolute thresholds, used only by push(frameMs) calls without cost information (pre-R2 callers) */
  HIGH_MS: 18, LOW_MS: 12,
} as const;

/** Upper bound of the applied pixel ratio (device pixels per CSS pixel, supersampling included). */
export const MAX_PIXEL_RATIO = 2;

/** Pure controller (unit-tested): feed frame intervals and costs, returns the new scale when a window closes with a
 * change. */
export interface ScaleController {
  readonly scale: number;
  /** current display-refresh estimate (ms) */
  readonly refreshMs: number;
  /** frameMs: frame interval; cpuMs: main-thread cost; gpuMs: GPU timer result (null = none this frame).
   * Returns the new scale if it changed at this frame, else NaN. Without cpuMs (legacy callers) the WP11 absolute
   * p95 thresholds apply. */
  push(frameMs: number, cpuMs?: number, gpuMs?: number | null): number;
  reset(scale: number): void;
  /** new upper bound (a devicePixelRatio change moved the pixel-ratio cap); the scale is clamped to it */
  setMax(maxScale: number): void;
}

const pct = (sorted: Float32Array, n: number, p: number): number => sorted[Math.min(n - 1, Math.max(0, Math.floor(n * p)))];

export function createScaleController(maxScale: number, initial = maxScale): ScaleController {
  const cap = 1024;
  const ring = new Float32Array(cap);
  const cpuRing = new Float32Array(cap);
  const gpuRing = new Float32Array(cap);
  const scratch = new Float32Array(cap);
  let n = 0;
  let nGpu = 0;
  let legacy = 0;
  let sumMs = 0;
  let settle = 0;
  let refresh: number = DYNRES.REFRESH_PRIOR;
  let maxS = maxScale;
  // missed-vsync ceiling: up-steps stay below `ceil` while ceilLeft > 0 windows remain
  let ceil = Infinity;
  let ceilLeft = 0;
  let ceilHold: number = DYNRES.CEIL_HOLD;
  let missedBefore = false;
  let missStreak = 0;
  const clampScale = (s: number): number => Math.min(maxS, Math.max(Math.min(DYNRES.MIN, maxS), s));
  let scale = clampScale(initial);
  const round = (v: number): number => Math.round(v * 100) / 100;
  const sortedOf = (src: Float32Array, k: number): Float32Array => {
    scratch.set(src.subarray(0, k));
    const v = scratch.subarray(0, k);
    v.sort();
    return v;
  };
  return {
    get scale() { return scale; },
    get refreshMs() { return refresh; },
    reset(s) {
      scale = clampScale(s); n = 0; nGpu = 0; legacy = 0; sumMs = 0; settle = DYNRES.SETTLE_FRAMES;
      ceil = Infinity; ceilLeft = 0; ceilHold = DYNRES.CEIL_HOLD; missedBefore = false; missStreak = 0;
    },
    setMax(m) { maxS = m; this.reset(Math.min(scale, m)); },
    push(ms, cpuMs, gpuMs) {
      if (!(ms > 0) || ms > 1000) return NaN;
      if (settle > 0) { settle--; return NaN; } // frames right after a resize are not representative
      if (n < cap) {
        ring[n] = ms;
        const hasCpu = cpuMs !== undefined && Number.isFinite(cpuMs);
        if (!hasCpu) legacy++;
        cpuRing[n] = hasCpu ? Math.max(0, cpuMs as number) : ms;
        if (gpuMs !== undefined && gpuMs !== null && Number.isFinite(gpuMs) && gpuMs >= 0) gpuRing[nGpu++] = gpuMs;
        n++;
      }
      sumMs += ms;
      if (sumMs < DYNRES.WINDOW_S * 1000) return NaN;
      const frames = sortedOf(ring, n);
      const p20 = pct(frames, n, DYNRES.REFRESH_P);
      const p50 = pct(frames, n, 0.5);
      const p95 = pct(frames, n, 0.95);
      const w = Math.min(DYNRES.REFRESH_MAX, Math.max(DYNRES.REFRESH_MIN, p20));
      refresh = w <= refresh ? w : refresh + (w - refresh) * DYNRES.REFRESH_RISE;
      let next = scale;
      let misses = 0;
      const budget = Math.max(refresh, DYNRES.BUDGET_MIN_MS);
      const missMs = DYNRES.MISS_X * budget;
      for (let i = n - 1; i >= 0 && frames[i] > missMs; i--) misses++;
      const stable = w <= DYNRES.REFRESH_STABLE * refresh;
      if (ceilLeft > 0 && --ceilLeft === 0) ceil = Infinity;
      if (legacy * 2 > n) {
        // pre-R2 caller: frame intervals only
        if (p95 > DYNRES.HIGH_MS) next = round(scale - DYNRES.DOWN);
        else if (p95 < DYNRES.LOW_MS) next = round(scale + DYNRES.UP);
      } else {
        const cpu90 = pct(sortedOf(cpuRing, n), n, 0.9);
        const timed = nGpu * 2 >= n;
        const gpu90 = timed ? pct(sortedOf(gpuRing, nGpu), nGpu, 0.9) : NaN;
        const gpuBusy = !timed || gpu90 >= DYNRES.MISS_GPU_MIN * budget;
        // two windows in a row: the window in which a throttle starts is a 16.7 / 33 ms mix that looks like misses
        missStreak = stable && gpuBusy && misses > DYNRES.MISS_FRAC * n && cpu90 < DYNRES.SLOW_CPU * budget ? missStreak + 1 : 0;
        if (missStreak >= DYNRES.MISS_WINDOWS) {
          missStreak = 0;
          next = round(scale - DYNRES.DOWN);
          // the scale that missed is the ceiling; a repeat (the ceiling expired and the probe missed again) holds longer
          if (ceil === Infinity && missedBefore) ceilHold = Math.min(DYNRES.CEIL_HOLD_MAX, ceilHold * 2);
          missedBefore = true;
          ceil = scale;
          ceilLeft = ceilHold;
        } else if (timed) {
          const load = Math.max(gpu90, cpu90);
          if (load > DYNRES.GPU_HIGH * budget) next = round(scale - DYNRES.DOWN);
          else if (load < DYNRES.GPU_LOW * budget) next = round(scale + DYNRES.UP);
        } else if (p50 > DYNRES.SLOW_P50 * budget && cpu90 > DYNRES.SLOW_CPU * budget) {
          next = round(scale - DYNRES.DOWN);
        } else if (p95 <= DYNRES.FAST_P95 * budget) {
          next = round(scale + DYNRES.UP);
        }
        // do not climb back into the missed-vsync scale, nor while a miss window awaits confirmation
        if (next > scale && (next >= ceil - 1e-6 || missStreak > 0)) next = scale;
      }
      n = 0;
      nGpu = 0;
      legacy = 0;
      sumMs = 0;
      next = clampScale(next);
      if (next === scale) return NaN;
      scale = next;
      settle = DYNRES.SETTLE_FRAMES;
      return scale;
    },
  };
}

/** Device pixels per CSS pixel before the render scale: min(devicePixelRatio, q.maxDpr). */
export function effectiveDpr(q: Pick<QualityConfig, 'maxDpr'>, dpr = globalThis.devicePixelRatio || 1): number {
  return Math.max(1e-3, Math.min(dpr > 0 ? dpr : 1, q.maxDpr));
}

/** Highest render scale usable at this DPR: the preset's, capped so the pixel ratio stays <= MAX_PIXEL_RATIO (but
 * never below 1: a preset without supersampling is not reduced by the cap). */
export function maxScaleFor(q: Pick<QualityConfig, 'maxDpr' | 'renderScale'>, dpr = globalThis.devicePixelRatio || 1): number {
  const base = effectiveDpr(q, dpr);
  return Math.min(q.renderScale, Math.max(1, MAX_PIXEL_RATIO / base));
}

export interface DynamicResolution {
  /** frameMs: frame interval; cpuMs: main-thread ms of the frame; gpuMs: GPU timer result or null. A new scale is
   * only queued: beforeRender() applies it. */
  update(frameMs: number, cpuMs: number, gpuMs: number | null): void;
  /** Applies a queued scale change. Call at the start of a frame, before anything draws: resizing the canvas clears
   * its drawing buffer, and a resize after the frame was drawn presented that cleared (black) buffer (R3). */
  beforeRender(): void;
  /** re-apply the pixel ratio after a devicePixelRatio change (window moved to another monitor) */
  refreshDpr(): void;
  readonly scale: number;
}

export function createDynamicResolution(post: PostStack, renderer: THREE.WebGLRenderer, q: QualityConfig): DynamicResolution {
  let maxScale = maxScaleFor(q);
  // a new preset starts at its own scale (not at the previous controller's reduced one)
  const ctl = createScaleController(maxScale, maxScale);
  const size = new THREE.Vector2();
  const apply = (scale: number): void => {
    const pr = effectiveDpr(q) * scale;
    if (Math.abs(renderer.getPixelRatio() - pr) < 1e-6) return;
    renderer.setPixelRatio(pr);
    renderer.getSize(size);
    post.setSize(size.x, size.y);
  };
  // Apply the live DPR and capped scale even when automatic adjustment is disabled.
  apply(ctl.scale);
  let pending = NaN;
  return {
    update(frameMs, cpuMs, gpuMs) {
      if (!q.dynamicResolution) return;
      const next = ctl.push(frameMs, cpuMs, gpuMs);
      if (!Number.isNaN(next)) pending = next;
    },
    beforeRender() {
      if (Number.isNaN(pending)) return;
      const s = pending;
      pending = NaN;
      apply(s);
    },
    refreshDpr() {
      pending = NaN; // applies ctl.scale, which already holds a queued change
      const m = maxScaleFor(q);
      if (m !== maxScale) {
        // at the old cap (not reduced by load): follow the cap both ways; reduced: keep the reduced scale (<= cap)
        const atCap = ctl.scale >= maxScale - 1e-6;
        maxScale = m;
        ctl.setMax(m);
        if (atCap) ctl.reset(m);
      }
      apply(ctl.scale);
    },
    get scale() {
      return q.dynamicResolution ? ctl.scale : post.renderScale;
    },
  };
}
