// src/core/debug.ts — automation contract: URL launch params and window.__backrooms (installed by WP14).
// tools/shoot.mjs appends `autostart=1` and waits for window.__backrooms.ready === true (60 s timeout).
// Capture contract v2 (captureGate: 2): with bake=full, ready means the capture set is baked and uploaded and the
// frame has settled (app/loop.ts): a capture at ready needs no wall-clock wait. whenReady() resolves at the next
// ready; load(search) applies a whole shot in place (same boot parameters: BOOT_PARAM_KEYS in app/urlParams.ts).

import type { QualityName } from './quality.ts';
import type { FlickerMode } from './settings.ts';
import type { MoodId, StoreyId, ZoneId, LandmarkKindId } from './ids.ts';
import type { SpawnPoint, TestSceneId } from './world.ts';
import type { BakeTerm } from './worker.ts';

/** SSR debug output (URL reflView=; package D): the reflection alone, or its confidence with misses in magenta. */
export type ReflView = 'off' | 'ssr' | 'conf';

/** Parsed URL params (WP14 app/urlParams.ts: pure, never throws; bad values -> warnings + defaults). */
export interface LaunchParams {
  seedText: string; // 'seed' (default: settings.lastSeed || random 'NNNN-NNNN')
  autostart: boolean;
  s: StoreyId | null; x: number | null; y: number | null; z: number | null; // 's' = storey
  yaw: number | null; pitch: number | null; // radians ('yawDeg' also accepted)
  fov: number | null;
  goto: string | null; // 'zone:NAME' | 'landmark:NAME' | 'vignette:NAME' | 'tower' | 'elevator' | 'dark' | 'water' | 'flicker' | 'spawn'
  zone: ZoneId | null; // shorthand for goto=zone:NAME
  forceZone: ZoneId | null; // every district becomes this zone
  forceMood: MoodId | null;
  forceLandmark: LandmarkKindId | null;
  testScene: TestSceneId | null;
  quality: QualityName | 'auto' | null;
  scale: number | null; // render scale override
  radius: number | null; // stream radius override (chunks)
  view: string; // DEBUG_VIEW_NAMES entry, default 'final'
  time: number | null; // freeze simulation clock at t (flicker, grain, water, bob) + snap exposure
  freeze: boolean; // freeze clock at its value when ready
  exposure: number | 'auto'; // EV100 lock
  flashlight: boolean;
  fly: boolean;
  audio: boolean; // 'noaudio=1' => false
  post: boolean; // 'nopost=1' => false
  ao: boolean; bloom: boolean; grain: boolean; lens: boolean; // 'ao=0' etc.
  // graphics-realism feature toggles ('ssr=0' etc.; default on): app/boot.ts applyLaunchToggles copies them into
  // Systems.features, where the owning package reads them (ssr, probe: D; cs: A; bounce, vol: F)
  ssr: boolean; probe: boolean; cs: boolean; bounce: boolean; vol: boolean;
  reflView: ReflView;
  flicker: FlickerMode | null;
  lights: 'default' | 'on' | 'dead';
  // ready requires: 'full' = full bakes in radius 1 (default with autostart=1: automation / QA);
  // 'interactive' = radius-1 previews + full bakes of the player's own chunk (default without autostart: the title
  // boot and ENTER / Continue reach play ~2x sooner; the ring-1 full bakes swap in while the player looks around);
  // 'preview' = radius-1 previews only
  bake: 'preview' | 'full' | 'interactive';
  bakeTerm: BakeTerm;
  camcorder: boolean;
  hud: boolean;
  debug: boolean; // F3 overlay on
  // 'noprime=1' => false: skip the wait for Chromium's first-context loss (app/renderer.ts primeGpuContext); the
  // play launcher passes it when it runs the browser under XWayland, where that loss does not happen
  prime: boolean;
  // 'stream=capture' (with bake=full only): stream the capture set alone, before and after ready (shoot / ab); default
  // 'full': the whole stream radius once ready (players, QA)
  stream: 'capture' | 'full';
  warnings: string[];
}

/** __backrooms.load(search): the shot was applied in place and is ready, or a boot parameter differs (the caller
 * boots a fresh page instead). */
export type LoadResult = { ok: true; ms: number } | { ok: false; reason: 'boot-param'; keys: string[] } | { ok: false; reason: 'busy' | 'lost'; keys: string[] };

export interface ImageStats {
  width: number; height: number; // readback size (160x90 unless rect given)
  meanLum: number; p5: number; p50: number; p95: number; // display-referred luma 0..1
  clipped: number; black: number; // fractions (>0.98, <0.02)
  meanRGB: [number, number, number];
  hueDeg: number; sat: number; // of meanRGB
  grid3x3: number[]; // mean luma per third
}

export interface PerfReport {
  seconds: number; frames: number; fps: number;
  frameMs: { avg: number; p50: number; p95: number; p99: number; max: number };
  gpuMs: number | null; // EXT_disjoint_timer_query_webgl2 if present (usually null in Chromium)
  drawCalls: number; triangles: number;
}

export interface AutowalkReport {
  distance: number; seconds: number; footsteps: number; storeyChanges: number;
  /** @deprecated the longest frame of the whole walk (despite the name, not a 5 s window): use frameMsMax */
  frameMsMax5s: number; geometriesStart: number; geometriesEnd: number; texturesStart: number; texturesEnd: number;
  errors: number; stuck: boolean;
  /** longest frame interval of the walk (after its first second) (R2 B9) */
  frameMsMax?: number;
  /** straight-line distance (m) from the start to the end point (a heading walk covers ground; a wander does not) */
  displacement?: number;
}

/** GPU / heap memory snapshot (R2 B9). texBytes / geoBytes: tile textures (live) and geometry buffers the streamer
 * holds; pooledBytes: released tile textures kept for reuse; heapMB: JS heap (performance.memory; null outside
 * Chromium). */
export interface MemoryStats { heapMB: number | null; texBytes: number; geoBytes: number; pooledBytes: number }

export interface CellInfo {
  s: StoreyId; gi: number; gj: number; chunk: [number, number]; tile: number; zone: string; mood: string;
  flags: number; floorY: number; ceilY: number; waterY: number | null; room: number;
  power: number; decay: number; humidity: number; warmth: number;
  edges: { W: string; N: string; E: string; S: string };
}

export interface LayerAlbedoReport { layer: number; name: string; measured: [number, number, number]; declared: [number, number, number]; ok: boolean }

export interface DebugStats {
  version: string; seed: string; quality: QualityName; renderScale: number; readyPhase: string; ready: boolean;
  fps: number; frameMs: { avg: number; p95: number; max: number; max5s: number }; cpuMs: number; gpuMs: number | null;
  render: { drawCalls: number; triangles: number; programs: number; textures: number; texturesPooled: number; geometries: number };
  chunks: { resident: number; desired: number; layoutsPending: number };
  tiles: {
    resident: number; preview: number; full: number; queued: number; inFlight: number; uploadsPending: number; fadingIn: number; otherStoreys: number;
    /** automation (bake=full): tiles in the capture set, how many of them are ready, the stream scope */
    gate?: number; gateReady?: number; scope?: 'capture' | 'full';
  };
  workers: { count: number; busy: number };
  bake: { lastMs: number; avgMs: number; buildAvgMs: number };
  player: {
    s: StoreyId; x: number; y: number; z: number; yaw: number; pitch: number; zone: string; mood: string;
    surface: string; cell: [number, number]; chunk: [number, number]; onGround: boolean; fly: boolean;
  };
  exposure: { ev100: number; value: number; locked: boolean };
  lights: { dynamicResident: number; flickerMode: FlickerMode };
  audio: { state: string; voices: number; rt60: number } | null;
  timeFrozen: boolean;
  warnings: string[];
  errors: string[];
  /** R2 B9: resident GPU bytes of the streamer + JS heap */
  memory?: MemoryStats;
}

export interface TeleportTarget { x: number; z: number; y?: number; s?: StoreyId; yaw?: number; pitch?: number }

export interface BackroomsDebugAPI {
  ready: boolean;
  isReady(): boolean;
  readyPhase: string; // 'boot'|'textures'|'shaders'|'spawn'|'chunks'|'bake'|'frames'|'ready'
  version: string;
  seed: string;
  stats(): DebugStats;
  /** Change seed in place, retaining the renderer, textures and compiled programs. */
  newSeed(seed: string): Promise<void>;
  /** Resolves when the target is ready again (radius-1 tiles baked per `bake` param) + 10 frames. */
  teleport(t: TeleportTarget): Promise<void>;
  goto(target: string): Promise<boolean>;
  look(yaw: number, pitch: number): void;
  setQuality(q: QualityName): Promise<void>;
  setView(v: string): void;
  setTime(t: number | null): void;
  setExposure(ev100: number | null): void;
  setFlashlight(on: boolean): void;
  setPost(p: Partial<Record<'ao' | 'bloom' | 'lens' | 'grain' | 'smaa' | 'exposure' | 'grade', boolean>>): void;
  setFlicker(mode: FlickerMode): void;
  waitForIdle(timeoutMs?: number): Promise<boolean>; // no queued/in-flight jobs, no pending uploads
  cellAt(x: number, z: number): CellInfo | null;
  zoneAt(x: number, z: number): string;
  findNearest(query: string, maxChunks?: number): Promise<SpawnPoint | null>;
  ascii(radiusCells?: number): string; // resident layouts around the player
  gen: {
    asciiMap(s: StoreyId, cx0: number, cz0: number, cx1: number, cz1: number): Promise<string>;
    districtAt(s: StoreyId, cx: number, cz: number): { id: number; zone: string; mood: string };
  };
  perf(seconds: number): Promise<PerfReport>;
  /** GPU ms of one frame's rendering (planar reflection + post stack, scene included), measured by rendering it
   * `repeats` times back to back inside one timer query (median of 7 rounds). Back to back keeps the GPU clocked
   * up: single-frame timings at display rate are inflated by downclocking. */
  gpuBench?(repeats?: number): Promise<{ ms: number | null; rounds: number; repeats: number; buffer: [number, number]; reflection: boolean }>;
  /** Mean GPU ms per frame of every post pass, the shadow map and the planar reflection (timer queries). */
  gpuProfile?(seconds: number): Promise<{ frames: number; passes: Record<string, number>; totalMs: number; drawCalls: number; triangles: number; buffer: [number, number] }>;
  imageStats(rect?: [number, number, number, number]): Promise<ImageStats>; // rect in 0..1 screen fractions
  /** heading (radians, yaw convention: forward = (-sin, -cos)): a directed walk that keeps re-targeting the
   * autopilot 60 m ahead along it every ~10 s (km-scale soaks); without it the autopilot wanders */
  autowalk(o: { distance: number; speed?: number; seed?: number; heading?: number }): Promise<AutowalkReport>;
  walk(path: { x: number; z: number }[], speed?: number): Promise<{ footsteps: number; ms: number }>;
  layerAlbedoCheck(): Promise<LayerAlbedoReport[]>;
  audio: { stats(): { state: string; voices: number; rt60: number; ir: number }; recentEvents(): string[] };
  events(): string[]; // last 200 GameEvents + worker errors, stringified
  /** QA (R2 B9): the resident FLICKER light nearest the view centre (within 20 m, in front) and two sim times for a
   * deterministic before/after pair: `high` = steady (before its next burst after `after`), `low` = inside that
   * burst (its last, LOW slot). null when no such light is resident or the flicker mode is 'off'. */
  flickerWindow?(after?: number): { x: number; y: number; z: number; high: number; low: number; lowLevel: number } | null;
  /** Capture contract version: 2 = gate v2 (position-defined capture set, frame-counted settle, exposure settled;
   * no wall-clock wait needed after ready), whenReady(), load(), frames(), stream=capture. Absent on older builds. */
  readonly captureGate?: number;
  /** Resolves at ready (at once when ready now). */
  whenReady?(): Promise<void>;
  /** Apply a whole shot (a URL search string) in place, resolving once it is ready, or refuse when a boot parameter
   * (BOOT_PARAM_KEYS) differs from this page's. Resets everything the debug API and evals can change. */
  load?(search: string): Promise<LoadResult>;
  /** Resolves after n more rendered frames. */
  frames?(n: number): Promise<void>;
}

/** Minimal surface set by the harness pages (§7.3); shoot.mjs only needs ready/isReady/stats. */
export interface HarnessDebugAPI {
  ready: boolean;
  isReady(): boolean;
  stats(): unknown;
  layerAlbedoCheck?(): Promise<LayerAlbedoReport[]>;
  /** §7.3 materials harness: max texel delta across tile edges per texture layer (tiling seam check) */
  tileSeamCheck?(): Promise<{ layer: number; maxEdgeDelta: number }[]>;
}

declare global {
  interface Window { __backrooms?: BackroomsDebugAPI | HarnessDebugAPI }
}
