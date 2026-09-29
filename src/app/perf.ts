// src/app/perf.ts (WP14) — frame-time statistics (allocation-free push), GPU timer queries and perf() recording.
// No three / DOM globals: usable from Node tests.

import type { PerfReport } from '../core/debug.ts';

/** Nearest-rank percentile of the first n entries of an ascending-sorted array. */
export function percentileSorted(sorted: ArrayLike<number>, n: number, p: number): number {
  if (n <= 0) return 0;
  return sorted[Math.min(n - 1, Math.max(0, Math.round(p * (n - 1))))];
}

export interface FrameSummary { fps: number; avg: number; p95: number; max: number; max5s: number; cpuMs: number }

export interface FrameStats {
  /** frameMs: real frame interval; cpuMs: main-thread time of loop steps 1-11; nowMs: timestamp */
  push(frameMs: number, cpuMs: number, nowMs: number): void;
  /** avg/p95/max over the last `window` frames; fps over the last second; max5s over the last 5 s */
  summary(window?: number): FrameSummary;
  readonly count: number;
  /** max frame interval pushed since `sinceMs` (ring capacity permitting) */
  maxSince(sinceMs: number): number;
  reset(): void;
}

export function createFrameStats(capacity = 2048): FrameStats {
  const ms = new Float64Array(capacity);
  const cpu = new Float64Array(capacity);
  const at = new Float64Array(capacity);
  let head = 0; // next write
  let count = 0;
  let sortBuf = new Float64Array(0);
  const idx = (k: number): number => (head - 1 - k + capacity * 2) % capacity; // k = 0 newest
  return {
    push(frameMs, cpuMs, nowMs) {
      ms[head] = frameMs;
      cpu[head] = cpuMs;
      at[head] = nowMs;
      head = (head + 1) % capacity;
      if (count < capacity) count++;
    },
    get count() { return count; },
    summary(window = 120) {
      if (count === 0) return { fps: 0, avg: 0, p95: 0, max: 0, max5s: 0, cpuMs: 0 };
      const n = Math.min(window, count);
      if (sortBuf.length < n) sortBuf = new Float64Array(n);
      let sum = 0, mx = 0, cpuSum = 0;
      for (let k = 0; k < n; k++) {
        const v = ms[idx(k)];
        sortBuf[k] = v;
        sum += v;
        cpuSum += cpu[idx(k)];
        if (v > mx) mx = v;
      }
      const s = sortBuf.subarray(0, n).sort();
      const now = at[idx(0)];
      let frames1s = 0, max5s = 0, oldestAge = 0;
      for (let k = 0; k < count; k++) {
        const i = idx(k);
        const age = now - at[i];
        if (age > 5000) break;
        if (age < 1000) { frames1s++; oldestAge = age; }
        if (ms[i] > max5s) max5s = ms[i];
      }
      // (frames - 1) intervals span oldestAge ms
      const fps = frames1s >= 2 && oldestAge > 0 ? ((frames1s - 1) * 1000) / oldestAge : 0;
      return { fps, avg: sum / n, p95: percentileSorted(s, n, 0.95), max: mx, max5s, cpuMs: cpuSum / n };
    },
    maxSince(sinceMs) {
      let m = 0;
      for (let k = 0; k < count; k++) {
        const i = idx(k);
        if (at[i] < sinceMs) break;
        if (ms[i] > m) m = ms[i];
      }
      return m;
    },
    reset() { head = 0; count = 0; },
  };
}

// ---------------------------------------------------------------- GPU timer (EXT_disjoint_timer_query_webgl2)

export interface GpuTimer {
  readonly available: boolean;
  begin(): void;
  end(): void;
  /** smoothed GPU ms of recent frames, null when unavailable or no result yet */
  readonly ms: number | null;
  /** last single-frame result (null if none) */
  readonly lastMs: number | null;
  /** the latest result if it arrived since the previous consume() call, else null (dynamic resolution: a stale
   * result repeated every frame would outweigh the fresh ones) */
  consume(): number | null;
}

interface TimerExt { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number }

/** Ring of 4 TIME_ELAPSED queries around the frame's GPU work; results are polled (never blocking). */
export function createGpuTimer(gl: WebGL2RenderingContext | null): GpuTimer {
  const ext = gl ? (gl.getExtension('EXT_disjoint_timer_query_webgl2') as TimerExt | null) : null;
  const N = 4;
  const queries: (WebGLQuery | null)[] = [];
  const pending = new Uint8Array(N);
  let cur = 0;
  let active = false;
  let smooth: number | null = null;
  let last: number | null = null;
  let fresh = false;
  if (gl && ext) for (let i = 0; i < N; i++) queries.push(gl.createQuery());
  const poll = (): boolean => {
    if (!gl || !ext) return false;
    const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT) as boolean;
    if (disjoint) {
      // Every outstanding query spans an invalid timer epoch, even results that are not available yet.
      pending.fill(0);
      smooth = last = null;
      fresh = false;
      return false;
    }
    // Starting at the next write slot visits old queries before new ones, including after ring wrap.
    for (let k = 0; k < N; k++) {
      const i = (cur + k) % N;
      const q = queries[i];
      if (!pending[i] || !q || (active && i === cur)) continue;
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) continue;
      pending[i] = 0;
      const ns = gl.getQueryParameter(q, gl.QUERY_RESULT) as number;
      last = ns / 1e6;
      fresh = true;
      smooth = smooth === null ? last : smooth + (last - smooth) * 0.1;
    }
    return true;
  };
  return {
    available: ext !== null,
    begin() {
      if (!gl || !ext || active) return;
      if (!poll()) return;
      // find a free slot; if all are pending (slow readback), skip timing this frame
      for (let k = 0; k < N; k++) {
        const i = (cur + k) % N;
        if (!pending[i]) {
          cur = i;
          const q = queries[i];
          if (!q) return;
          gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
          active = true;
          return;
        }
      }
    },
    end() {
      if (!gl || !ext || !active) return;
      gl.endQuery(ext.TIME_ELAPSED_EXT);
      pending[cur] = 1;
      active = false;
      cur = (cur + 1) % N;
    },
    get ms() { return smooth; },
    get lastMs() { return last; },
    consume() {
      if (!fresh) return null;
      fresh = false;
      return last;
    },
  };
}

// ---------------------------------------------------------------- perf(seconds)

export interface PerfRecorder {
  /** call once per frame; returns true when finished */
  frame(frameMs: number, drawCalls: number, triangles: number, gpuMs: number | null): boolean;
  report(): PerfReport;
}

export function createPerfRecorder(seconds: number): PerfRecorder {
  const dur = Math.max(0.1, Math.min(600, Number.isFinite(seconds) ? seconds : 5));
  const cap = Math.ceil(dur * 500) + 16;
  const ms = new Float64Array(cap);
  let n = 0, elapsed = 0, draws = 0, tris = 0, gpuSum = 0, gpuN = 0;
  let done = false;
  return {
    frame(frameMs, drawCalls, triangles, gpuMs) {
      if (done) return true;
      if (n < cap) ms[n++] = frameMs;
      elapsed += frameMs;
      draws += drawCalls;
      tris += triangles;
      if (gpuMs !== null) { gpuSum += gpuMs; gpuN++; }
      if (elapsed >= dur * 1000) done = true;
      return done;
    },
    report() {
      const s = ms.slice(0, n).sort();
      let sum = 0;
      for (let i = 0; i < n; i++) sum += s[i];
      return {
        seconds: elapsed / 1000, frames: n, fps: elapsed > 0 ? (n * 1000) / elapsed : 0,
        frameMs: {
          avg: n ? sum / n : 0, p50: percentileSorted(s, n, 0.5), p95: percentileSorted(s, n, 0.95),
          p99: percentileSorted(s, n, 0.99), max: n ? s[n - 1] : 0,
        },
        gpuMs: gpuN ? gpuSum / gpuN : null,
        drawCalls: n ? Math.round(draws / n) : 0,
        triangles: n ? Math.round(tris / n) : 0,
      };
    },
  };
}
