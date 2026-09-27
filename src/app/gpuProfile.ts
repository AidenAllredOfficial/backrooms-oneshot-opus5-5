// src/app/gpuProfile.ts — per-pass GPU timing (__backrooms.gpuProfile). TIME_ELAPSED queries cannot nest, so the
// frame is cut into consecutive segments: mark(label) ends the running query and starts one for `label`. Hooks on
// the composer passes, the hand-rendered final pass, the shadow map and the planar reflection mark their own
// segment and return to the enclosing one afterwards. The frame-level GPU timer (core.gpu) is suspended while a
// profile runs, since its query would enclose the segments.

import type * as THREE from 'three';
import type { Pass } from 'postprocessing';

interface TimerExt { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number }

export interface GpuProfileReport {
  frames: number;
  /** mean GPU ms per frame for each segment, in first-seen order */
  passes: Record<string, number>;
  totalMs: number;
}

export interface GpuProfiler {
  /** close the running segment (if any) and open one for `label` */
  mark(label: string): void;
  /** close the running segment */
  stop(): void;
  /** the label of the running segment, or null */
  readonly current: string | null;
  /** poll finished queries; call once per frame */
  poll(): void;
  /** frames counted since the last reset (frames = number of endFrame calls with all queries resolved) */
  endFrame(): void;
  report(): GpuProfileReport;
  dispose(): void;
}

export function createGpuProfiler(gl: WebGL2RenderingContext): GpuProfiler | null {
  const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2') as TimerExt | null;
  if (!ext) return null;
  const free: WebGLQuery[] = [];
  const pending: { q: WebGLQuery; label: string }[] = [];
  const sums = new Map<string, number>();
  let frames = 0;
  let cur: { q: WebGLQuery; label: string } | null = null;
  const take = (): WebGLQuery => free.pop() ?? (gl.createQuery() as WebGLQuery);
  const close = (): void => {
    if (!cur) return;
    gl.endQuery(ext.TIME_ELAPSED_EXT);
    pending.push(cur);
    cur = null;
  };
  return {
    mark(label) {
      close();
      const q = take();
      gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
      cur = { q, label };
      if (!sums.has(label)) sums.set(label, 0);
    },
    stop: close,
    get current() { return cur ? cur.label : null; },
    poll() {
      const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT) as boolean;
      let i = 0;
      for (; i < pending.length; i++) {
        const p = pending[i];
        if (!gl.getQueryParameter(p.q, gl.QUERY_RESULT_AVAILABLE)) break;
        if (!disjoint) sums.set(p.label, (sums.get(p.label) ?? 0) + (gl.getQueryParameter(p.q, gl.QUERY_RESULT) as number) / 1e6);
        free.push(p.q);
      }
      pending.splice(0, i);
    },
    endFrame() { frames++; },
    report() {
      const passes: Record<string, number> = {};
      let total = 0;
      const n = Math.max(1, frames);
      for (const [k, v] of sums) { passes[k] = Math.round((v / n) * 1000) / 1000; total += v / n; }
      return { frames, passes, totalMs: Math.round(total * 1000) / 1000 };
    },
    dispose() {
      close();
      for (const p of pending) gl.deleteQuery(p.q);
      for (const q of free) gl.deleteQuery(q);
      pending.length = 0;
      free.length = 0;
    },
  };
}

/** Wrap `obj[key]` (a method) so that it runs inside segment `label`; returns the restore function. */
export function hookSegment<T extends object>(prof: GpuProfiler, obj: T, key: keyof T & string, label: string): () => void {
  const orig = obj[key] as unknown as (...a: unknown[]) => unknown;
  const had = Object.prototype.hasOwnProperty.call(obj, key);
  (obj as Record<string, unknown>)[key] = function (this: unknown, ...a: unknown[]): unknown {
    const outer = prof.current;
    prof.mark(label);
    try {
      return orig.apply(this, a);
    } finally {
      if (outer !== null) prof.mark(outer); else prof.stop();
    }
  };
  return () => {
    if (had) (obj as Record<string, unknown>)[key] = orig;
    else delete (obj as Record<string, unknown>)[key];
  };
}

/** Label for a composer pass: its name, or the effect names of an EffectPass. */
export function passLabel(p: Pass, i: number): string {
  const effects = (p as unknown as { effects?: { name: string }[] }).effects;
  if (effects && effects.length > 0) return effects.map((e) => e.name.replace(/Effect$/, '')).join('+');
  return p.name || `pass${i}`;
}

export interface ProfileTargets {
  renderer: THREE.WebGLRenderer;
  passes: Pass[];
  finalPass: Pass;
  reflection: { update(...a: never[]): void };
  /** package E: the ripple simulation ('waterSim' segment) */
  ripples?: { update(...a: never[]): void };
}

/** Hook every target; returns the restore function. */
export function hookAll(prof: GpuProfiler, t: ProfileTargets): () => void {
  const undo: (() => void)[] = [];
  t.passes.forEach((p, i) => undo.push(hookSegment(prof, p, 'render', passLabel(p, i))));
  undo.push(hookSegment(prof, t.finalPass, 'render', `final:${passLabel(t.finalPass, 0)}`));
  undo.push(hookSegment(prof, t.renderer.shadowMap as unknown as { render(): void }, 'render', 'shadowMap'));
  undo.push(hookSegment(prof, t.reflection, 'update', 'reflection'));
  if (t.ripples) undo.push(hookSegment(prof, t.ripples, 'update', 'waterSim'));
  return () => { for (const u of undo.reverse()) u(); };
}
