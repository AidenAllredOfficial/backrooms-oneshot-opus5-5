// src/audio/bank.ts — AudioBuffer cache fed by 1-2 DSP workers (fallback: main thread, one job per macrotask).
// Requests are deduplicated by synthKey; `get` is a synchronous lookup for hot paths (never allocates).

import { runSynth, synthKey, type SynthRequest } from './dsp/dispatch.ts';

interface Pending { key: string; req: SynthRequest; resolve: (b: AudioBuffer) => void; reject: (e: unknown) => void; priority: number }

export class BufferBank {
  readonly sampleRate: number;
  private readonly ctx: BaseAudioContext;
  private readonly buffers = new Map<string, AudioBuffer>();
  private readonly inflight = new Map<string, Promise<AudioBuffer>>();
  /** DSP workers (2 when the machine has the cores; 0 = main-thread fallback) */
  private workers: Worker[] = [];
  private readonly busy: number[] = [];
  private readonly waiting = new Map<number, { job: Pending; w: number }>();
  private readonly queue: Pending[] = []; // not yet sent (one job in flight per worker keeps priorities meaningful)
  private nextId = 1;
  private disposed = false;
  private inlineScheduled = false;
  /** synthesis wall time (ms) of completed jobs, for diagnostics */
  synthMs = 0;
  jobs = 0;

  constructor(ctx: BaseAudioContext, useWorker = true) {
    this.ctx = ctx;
    this.sampleRate = ctx.sampleRate;
    if (useWorker && typeof Worker !== 'undefined') {
      // 3 workers on 8+ cores so the start-up essentials (4 hum loops, room tone, zone bed) render in parallel
      const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency ?? 4 : 4;
      const n = cores >= 8 ? 3 : cores >= 4 ? 2 : 1;
      try {
        for (let i = 0; i < n; i++) {
          const w = new Worker(new URL('./dspWorker.ts', import.meta.url), { type: 'module' });
          w.onmessage = (e: MessageEvent<{ id: number; chans?: Float32Array[]; error?: string }>): void => this.onDone(e.data);
          w.onerror = (): void => this.fallBack();
          this.workers.push(w);
          this.busy.push(0);
        }
      } catch {
        for (const w of this.workers) { try { w.terminate(); } catch { /* ignore */ } }
        this.workers = [];
        this.busy.length = 0;
      }
    }
  }

  /** Synchronous lookup (null while not rendered yet). */
  get(key: string): AudioBuffer | null { return this.buffers.get(key) ?? null; }
  has(key: string): boolean { return this.buffers.has(key); }

  /** Render (or reuse) a buffer. Lower priority number = sooner. */
  request(req: SynthRequest, priority = 5): Promise<AudioBuffer> {
    const key = synthKey(req);
    const b = this.buffers.get(key);
    if (b) return Promise.resolve(b);
    const f = this.inflight.get(key);
    if (f) return f;
    const p = new Promise<AudioBuffer>((resolve, reject) => {
      const job: Pending = { key, req, resolve, reject, priority };
      let i = this.queue.length;
      while (i > 0 && this.queue[i - 1].priority > priority) i--;
      this.queue.splice(i, 0, job);
    });
    this.inflight.set(key, p);
    p.catch(() => this.inflight.delete(key));
    this.pump();
    return p;
  }

  /** The buffer if ready; otherwise queue it (fire-and-forget) and return null. */
  ensure(req: SynthRequest, priority = 5): AudioBuffer | null {
    const b = this.buffers.get(synthKey(req));
    if (b) return b;
    void this.request(req, priority).catch(() => undefined);
    return null;
  }

  private pump(): void {
    if (this.disposed) return;
    if (this.workers.length > 0) {
      for (let w = 0; w < this.workers.length && this.queue.length > 0; w++) {
        if (this.busy[w] > 0) continue;
        const job = this.queue.shift() as Pending;
        const id = this.nextId++;
        this.waiting.set(id, { job, w });
        this.busy[w]++;
        this.workers[w].postMessage({ id, req: job.req, sampleRate: this.sampleRate });
      }
      return;
    }
    if (this.inlineScheduled || this.queue.length === 0) return;
    this.inlineScheduled = true;
    setTimeout(() => {
      this.inlineScheduled = false;
      if (this.disposed) return;
      const job = this.queue.shift();
      if (job) {
        try {
          const t0 = performance.now();
          const chans = runSynth(job.req, this.sampleRate);
          this.synthMs += performance.now() - t0;
          this.finish(job, chans);
        } catch (e) {
          this.inflight.delete(job.key);
          job.reject(e);
        }
      }
      this.pump();
    }, 0);
  }

  private onDone(d: { id: number; chans?: Float32Array[]; error?: string }): void {
    const entry = this.waiting.get(d.id);
    if (!entry) return;
    this.waiting.delete(d.id);
    this.busy[entry.w] = Math.max(0, this.busy[entry.w] - 1);
    const job = entry.job;
    if (d.chans) this.finish(job, d.chans);
    else { this.inflight.delete(job.key); job.reject(new Error(d.error ?? 'dsp job failed')); }
    this.pump();
  }

  private finish(job: Pending, chans: Float32Array[]): void {
    if (this.disposed) return;
    const n = chans[0].length;
    const buf = this.ctx.createBuffer(chans.length, Math.max(1, n), this.sampleRate);
    for (let c = 0; c < chans.length; c++) buf.copyToChannel(chans[c] as Float32Array<ArrayBuffer>, c);
    this.buffers.set(job.key, buf);
    this.inflight.delete(job.key);
    this.jobs++;
    job.resolve(buf);
  }

  /** Worker failed: re-queue everything it held and continue on the main thread. */
  private fallBack(): void {
    if (this.workers.length === 0) return;
    for (const w of this.workers) { try { w.terminate(); } catch { /* ignore */ } }
    this.workers = [];
    this.busy.length = 0;
    for (const e of this.waiting.values()) this.queue.unshift(e.job);
    this.waiting.clear();
    this.pump();
  }

  /** Drop cached buffers whose key starts with a prefix (e.g. mains change: 'hum:'). */
  evict(prefix: string): void {
    for (const k of [...this.buffers.keys()]) if (k.startsWith(prefix)) this.buffers.delete(k);
  }

  dispose(): void {
    this.disposed = true;
    for (const w of this.workers) { try { w.terminate(); } catch { /* ignore */ } }
    this.workers = [];
    this.buffers.clear();
    this.queue.length = 0;
    this.waiting.clear();
  }
}
