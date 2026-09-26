// src/audio/dspWorker.ts — DSP worker (WP13): renders synthesizer requests off the main thread.
// Loaded with new Worker(new URL('./dspWorker.ts', import.meta.url), { type: 'module' }). Imports only pure modules.

import { runSynth, type SynthRequest } from './dsp/dispatch.ts';

interface DspJob { id: number; req: SynthRequest; sampleRate: number }

self.onmessage = (e: MessageEvent<DspJob>): void => {
  const { id, req, sampleRate } = e.data;
  try {
    const chans = runSynth(req, sampleRate);
    self.postMessage({ id, chans }, { transfer: chans.map((c) => c.buffer as ArrayBuffer) });
  } catch (err) {
    self.postMessage({ id, error: String(err) });
  }
};
