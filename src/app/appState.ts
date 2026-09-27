// src/app/appState.ts (WP14, private) — the state shared by App (composition root), boot (§6.1), loop (§6.2),
// the ready gate and the debug API (§7.2).

import type * as THREE from 'three';
import type { BackroomsDebugAPI, LaunchParams, ReflView } from '../core/debug.ts';
import type { GameBus } from '../core/events.ts';
import type { PlayerInput, PlayerState } from '../core/player.ts';
import type { QualityConfig } from '../core/quality.ts';
import type { Settings } from '../core/settings.ts';
import type {
  AudioSystem, InputSource, LightingRuntime, MaterialSystem, PlayerSystem, PostStack, TextureSet, WorldQuery, WorldStreamer,
} from '../core/runtime.ts';
import type { WorkerInit } from '../core/worker.ts';
import type { SpawnPoint } from '../core/world.ts';
import type { PlanarReflection } from '../materials/PlanarReflection.ts';
import type { ScreenSpaceReflections } from '../post/ssr/SsrTrace.ts';
import type { WaterRipples } from '../materials/water/WaterRipples.ts';
import type { WorkerPool } from '../stream/WorkerPool.ts';
import type { Autopilot } from '../player/autopilot.ts';
import type { SimClock } from './clock.ts';
import type { FrameStats, GpuTimer } from './perf.ts';
import type { SettingsStore } from './settingsStore.ts';

/** Graphics-realism feature toggles (URL ssr= probe= cs= bounce= vol= reflView=; default on / 'off'), for A/B checks
 * against the full-quality path. Each owning package reads its own entry: ssr and probe (D), cs (A), bounce and
 * vol (F), reflView (D). */
export interface FeatureToggles {
  ssr: boolean;
  probe: boolean;
  cs: boolean;
  bounce: boolean;
  vol: boolean;
  reflView: ReflView;
}

export interface Systems {
  q: QualityConfig;
  /** set from the launch params by boot (bootSystems, applyLaunchToggles) */
  features: FeatureToggles;
  textures: TextureSet;
  materials: MaterialSystem;
  lighting: LightingRuntime;
  post: PostStack;
  reflection: PlanarReflection;
  /** package D: screen-space reflections (the frame graph's 'hiz' and 'ssr' hooks; setQuality on preset changes) */
  ssr: ScreenSpaceReflections;
  /** package E: the ripple heightfield around the player (updated in the loop, inside the GPU timer) */
  ripples: WaterRipples;
  anomaly: { reset(): void; update(t: number, dt: number, player: PlayerState, world: WorldQuery): void };
  /** load-driven render scale: update(frame interval, main-thread cost, GPU timer ms or null) queues a change,
   * beforeRender() (loop step 0) applies it before the frame draws */
  dynRes: { update(frameMs: number, cpuMs: number, gpuMs: number | null): void; beforeRender(): void; refreshDpr(): void; readonly scale: number };
  pool: WorkerPool;
  /** steady-state pool size: the boot pool is larger and is resized to this at the boot gate (R2 B9) */
  poolTarget: number;
  streamer: WorldStreamer;
  player: PlayerSystem;
  audio: AudioSystem;
  input: InputSource;
  init: WorkerInit;
  /** resolved launch spawn (ENTER returns here) */
  spawn: SpawnPoint;
}

/**
 * boot: before the frame loop runs. title: menu over the attract walk. entering: Enter pressed, waiting for the
 * fade/teleport. play: player in control. paused: pause menu. auto: autostart run (no title, no pointer lock).
 */
export type AppMode = 'boot' | 'title' | 'entering' | 'play' | 'paused' | 'auto';

/** Replaces input.poll() while active (autowalk / walk); timeScale multiplies the player's dt. */
export interface InputDriver {
  drive(st: PlayerState, world: WorldQuery, out: PlayerInput, realDt: number): void;
  readonly timeScale: number;
}

/** Called once per frame at step 12 with the real frame interval; return true to be removed. */
export type FrameHook = (frameMs: number) => boolean;

export interface GateOptions {
  /** 'boot' applies the launch toggles (§6.1 step 7) once the stream is ready */
  reason: 'boot' | 'seed' | 'teleport' | 'quality';
  /** snap an explicit position that lies inside a wall to the nearest walkable cell (x/z teleports) */
  snapToWalkable: boolean;
  /** also snap a position given without y to standable floor: out of prop footprints (a desk top), under a ceiling
   * with head room (R2 B9). Default: teleports without y; the boot gate for explicit x/z without a y= param. */
  snapFloor?: boolean;
}

export interface ReadyGate {
  /** ready = false; resolves when the stream is ready + exposure snapped + 10 frames rendered */
  open(o: GateOptions): Promise<void>;
  /** per frame, after rendering */
  tick(): void;
  readonly active: boolean;
}

export interface AppCore {
  readonly canvas: HTMLCanvasElement;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly bus: GameBus;
  readonly clock: SimClock;
  readonly frameStats: FrameStats;
  readonly settings: SettingsStore;
  readonly params: LaunchParams;
  readonly bootT0: number;
  renderer: THREE.WebGLRenderer | null;
  gpu: GpuTimer | null;
  sys: Systems | null;
  mode: AppMode;
  attract: Autopilot | null;
  driver: InputDriver | null;
  frame: number;
  /** last frame's main-thread ms (steps 1-11) */
  cpuMs: number;
  debug: BackroomsDebugAPI;
  gate: ReadyGate;
  hooks: FrameHook[];
  /** session flicker mode (settings, or the flicker= / setFlicker override) */
  flickerMode: Settings['flicker'];
  /** camcorder forced by camcorder=1 */
  camcorderForced: boolean;
  warnings: string[];
  errors: string[];
  warn(msg: string): void;
  fail(e: unknown): void;
  /** vertical FOV in degrees (fov= param, else settings) */
  fov(): number;
}

