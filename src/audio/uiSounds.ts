// src/audio/uiSounds.ts — interface sounds on the ui bus (R2): the GameBus 'ui' event {hover | click | open | close}
// (App.ts emits it from the title / pause / settings menus). The menus read as camcorder controls: hover = a 2-3 ms
// jog-dial detent tick (~-32 dBFS at the default Interface volume), click / open / close = a transport key clunk and
// the tape mechanism whirring (~-22 dBFS short-term; open spins up, close spins down onto a latch).
// The 8 buffers (4 kinds x 2 variants) are tiny (~1.2 s of audio in total), so they are rendered synchronously on the
// main thread when the audio system starts: the first menu click after the context runs is already audible, without
// waiting on the DSP worker queue. The ui bus bypasses the pause muffle and the master fade (the title fades the
// master to silence while its own clicks must stay audible) but follows the user's Master slider (graph.setVolumes
// uiMaster: Master = 0 mutes them too), and still goes through the output make-up, compressor and limiter.

import type { GameEvents } from '../core/events.ts';
import { synthOneShot, type OneShotKind } from './dsp/oneshots.ts';
import type { AudioEnv } from './env.ts';
import { DEFAULT_SETTINGS } from '../core/settings.ts';
import { MAKEUP_DB, sliderGain } from './graph.ts';

type UiName = GameEvents['ui']['name'];

const KIND: Readonly<Record<UiName, OneShotKind>> = { hover: 'uiHover', click: 'uiClick', open: 'uiOpen', close: 'uiClose' };
/** Output gain per sound at Interface = 1 and the default Master (buffers are peak-normalized to 0.9; the output
 * make-up and the default Master gain are divided out, so these are levels at the speakers). With the default
 * sliders (Interface 0.6 -> 0.36, Master 0.8) hover lands at ~-32 dBFS (RMS over its 3 ms) and the clunks at
 * ~-22 dBFS (RMS over the first 100-300 ms). */
const OUT_LEVEL: Readonly<Record<UiName, number>> = { hover: 0.22, click: 1.24, open: 1.77, close: 1.77 };
const MAKEUP = Math.pow(10, MAKEUP_DB / 20) * sliderGain(DEFAULT_SETTINGS.volume.master);
/** Hover ticks closer together than this are dropped (sweeping the pointer over a list must not machine-gun). */
const HOVER_GAP = 0.045;
const VARIANTS = 2;

export class UiSounds {
  private readonly env: AudioEnv;
  private readonly buffers = new Map<UiName, AudioBuffer[]>();
  private lastHover = -1;
  private flip = 0;
  /** sounds started (tests / stats) */
  played = 0;

  constructor(env: AudioEnv) {
    this.env = env;
    const ctx = env.ctx;
    for (const name of Object.keys(KIND) as UiName[]) {
      const list: AudioBuffer[] = [];
      for (let v = 0; v < VARIANTS; v++) {
        const ch = synthOneShot(KIND[name], v, ctx.sampleRate)[0];
        const b = ctx.createBuffer(1, ch.length, ctx.sampleRate);
        b.getChannelData(0).set(ch);
        list.push(b);
      }
      this.buffers.set(name, list);
    }
  }

  /** Play one interface sound now (no-op for unknown names, while the context is not running, or for hover ticks
   * inside HOVER_GAP of the previous one). Returns true when a sound was started. */
  play(name: UiName): boolean {
    const env = this.env;
    const ctx = env.ctx;
    const list = this.buffers.get(name);
    if (!list || ctx.state !== 'running') return false;
    const now = ctx.currentTime;
    if (name === 'hover') {
      if (now - this.lastHover < HOVER_GAP) return false;
      this.lastHover = now;
    }
    this.flip = (this.flip + 1 + (env.rng.next() & 1)) % VARIANTS;
    const src = ctx.createBufferSource();
    src.buffer = list[this.flip];
    src.playbackRate.value = 1 + (env.rng.float() - 0.5) * 0.04; // +-35 cents: never the identical click twice
    const g = ctx.createGain();
    g.gain.value = OUT_LEVEL[name] / MAKEUP;
    src.connect(g).connect(env.graph.buses.ui);
    src.onended = (): void => { try { src.disconnect(); g.disconnect(); } catch { /* ignore */ } };
    src.start(now);
    this.played++;
    return true;
  }
}
