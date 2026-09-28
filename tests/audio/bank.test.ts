// tests/audio/bank.test.ts — BufferBank bookkeeping: pending() counts queued, in-flight and scheduled jobs, and idle()
// resolves only when all of them are done, across failures, the worker -> main-thread re-queue and follow-up requests
// made from a resolved request (tests/audio/engine.test.ts drains the bank with idle()).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BufferBank } from '../../src/audio/bank.ts';
import type { SynthRequest } from '../../src/audio/dsp/dispatch.ts';
import { MockContext } from './webaudioMock.ts';

const tink = (variant: number): SynthRequest => ({ op: 'fixture', kind: 'tink', variant });
/** runSynth returns undefined for an unknown op; finish() then throws, so the request rejects. */
const broken = { op: 'broken', variant: 0 } as unknown as SynthRequest;
const ctx = (): BaseAudioContext => new MockContext() as unknown as BaseAudioContext;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Resolves true if `p` settles within `ms`. */
async function settlesWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  let done = false;
  void p.then(() => { done = true; }, () => { done = true; });
  await sleep(ms);
  return done;
}

/** A Worker stand-in that holds every posted job until the test answers it or fails the worker. */
class FakeWorker {
  static all: FakeWorker[] = [];
  onmessage: ((e: { data: { id: number; chans?: Float32Array[]; error?: string } }) => void) | null = null;
  onerror: (() => void) | null = null;
  readonly jobs: { id: number; req: SynthRequest }[] = [];
  terminated = false;
  constructor() { FakeWorker.all.push(this); }
  postMessage(m: { id: number; req: SynthRequest }): void { this.jobs.push(m); }
  terminate(): void { this.terminated = true; }
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeWorker.all = [];
});

describe('BufferBank pending() / idle()', () => {
  it('is idle at once when nothing was requested', async () => {
    const bank = new BufferBank(ctx(), false);
    expect(bank.pending()).toBe(0);
    expect(await settlesWithin(bank.idle(), 20)).toBe(true);
  });

  it('main thread: counts queued and scheduled jobs; a failing job neither hangs idle() nor hides the others', async () => {
    const bank = new BufferBank(ctx(), false);
    const a = bank.request(tink(0));
    const bad = bank.request(broken);
    const b = bank.request(tink(1));
    expect(bank.pending()).toBe(3 + 1); // three queued + the scheduled inline macrotask
    const idle = bank.idle();
    const results = await Promise.allSettled([a, bad, b]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
    await idle;
    expect(bank.pending()).toBe(0);
    expect(bank.jobs).toBe(2);
    expect(bank.has('fix:tink:0') && bank.has('fix:tink:1')).toBe(true);
  });

  it('waits for work queued by the callback of a finished request', async () => {
    const bank = new BufferBank(ctx(), false);
    let chained: Promise<AudioBuffer> | null = null;
    void bank.request(tink(2)).then(() => { chained = bank.request(tink(3)); });
    await bank.idle();
    expect(chained).not.toBeNull();
    expect(bank.has('fix:tink:3')).toBe(true);
    expect(bank.pending()).toBe(0);
  });

  it('workers: in-flight jobs count until answered; a failed worker re-queues its jobs on the main thread', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const bank = new BufferBank(ctx(), true);
    const n = FakeWorker.all.length;
    expect(n).toBeGreaterThan(0);
    const reqs = Array.from({ length: n + 2 }, (_, i) => tink(10 + i));
    const done = reqs.map((r) => bank.request(r));
    // one job per worker in flight, the rest queued
    expect(FakeWorker.all.every((w) => w.jobs.length === 1)).toBe(true);
    expect(bank.pending()).toBe(n + 2);
    const idle = bank.idle();
    // the first worker answers its job with a real buffer; another job becomes in flight on it
    const w0 = FakeWorker.all[0];
    w0.onmessage!({ data: { id: w0.jobs[0].id, chans: [new Float32Array(64)] } });
    expect(bank.pending()).toBe(n + 1);
    expect(w0.jobs.length).toBe(2);
    expect(await settlesWithin(idle, 20)).toBe(false);
    // a worker error: every in-flight job goes back to the queue and renders on the main thread
    FakeWorker.all[1].onerror!();
    expect(FakeWorker.all.every((w) => w.terminated)).toBe(true);
    expect(bank.pending()).toBeGreaterThan(0);
    await Promise.all(done);
    await idle;
    expect(bank.pending()).toBe(0);
    for (let i = 0; i < reqs.length; i++) expect(bank.has(`fix:tink:${10 + i}`)).toBe(true);
  });

  it('dispose() releases idle() waiters', async () => {
    const bank = new BufferBank(ctx(), false);
    void bank.request(tink(4)).catch(() => undefined);
    const idle = bank.idle();
    bank.dispose();
    expect(await settlesWithin(idle, 20)).toBe(true);
  });
});
