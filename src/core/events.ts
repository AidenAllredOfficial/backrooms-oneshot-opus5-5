// src/core/events.ts — typed synchronous event bus (main thread only). emit() does not allocate.
// Producers own their events: player (WP12) footstep/land/breath/interact; traversal (WP12) storeyChanged/
// transition/glitch (glitch is emitted ONLY by traversal); lighting (WP11) lightToggle/flashlight/anomaly/spark;
// streamer (WP10) tile/chunk events; app (WP14) the rest. WP14 wires 'glitch' -> post.glitch.

import type { StoreyId, SurfaceSoundId, ZoneId, MoodId } from './ids.ts';
import type { Settings } from './settings.ts';

export interface GameEvents {
  footstep: { surface: SurfaceSoundId; intensity: number; foot: 0 | 1; x: number; y: number; z: number; waterDepth: number; settle: boolean };
  land: { surface: SurfaceSoundId; impact: number; x: number; y: number; z: number };
  breath: { rate: number; depth: number }; // sprint fatigue / idle breathing, emitted at 2 Hz while changing
  lightToggle: { lightId: number; on: boolean; x: number; y: number; z: number };
  flashlight: { on: boolean };
  zoneChanged: { from: ZoneId; to: ZoneId; s: StoreyId; mood: MoodId };
  storeyChanged: { from: StoreyId; to: StoreyId; dy: number; via: 'tower' | 'elevator' | 'pit' | 'glitch' | 'doorway' };
  transition: { kind: 'tower' | 'elevator' | 'pit' | 'glitch'; phase: 'enter' | 'doorsClosing' | 'ride' | 'switch' | 'doorsOpening' | 'exit'; id: number };
  anomaly: { kind: string; phase: 'start' | 'trigger' | 'end'; x: number; z: number };
  glitch: { seconds: number; strength: number };
  spark: { x: number; y: number; z: number; strength: number }; // SPARKING anomaly burst (visual WP11, crackle WP13)
  /** interact key pressed; propKind = targeted INTERACTABLE_PROPS kind or -1 (nothing within 1.6 m) */
  interact: { propKind: number; x: number; y: number; z: number; yaw: number; seed: number; door?: 'open' | 'close' | 'latch' };
  tileLoaded: { key: string };
  tileUnloaded: { key: string };
  chunkLoaded: { key: string };
  chunkUnloaded: { key: string };
  teleport: { s: StoreyId; x: number; y: number; z: number };
  settingsChanged: Settings;
  pause: { paused: boolean };
  ready: { ms: number };
  ui: { name: 'hover' | 'click' | 'open' | 'close' };
}

type Handler<T> = (e: T) => void;

export class EventBus<E extends object> {
  private handlers: { [K in keyof E]?: Handler<E[K]>[] } = {};
  on<K extends keyof E>(k: K, fn: Handler<E[K]>): () => void {
    const list = (this.handlers[k] ??= []);
    list.push(fn);
    return () => {
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    };
  }
  emit<K extends keyof E>(k: K, e: E[K]): void {
    const list = this.handlers[k];
    if (!list) return;
    for (let i = 0; i < list.length; i++) list[i](e);
  }
  clear(): void { this.handlers = {}; }
}

export type GameBus = EventBus<GameEvents>;
export type Emit = <K extends keyof GameEvents>(k: K, e: GameEvents[K]) => void;
