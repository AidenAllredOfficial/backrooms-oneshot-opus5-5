// src/app/App.ts (WP14) — app shell: composition root for boot (§6.1, boot.ts), the frame loop (§6.2, loop.ts),
// window.__backrooms (§7.2, debugApi.ts), UI screens (src/ui), persistence and event wiring.
//
// Title flow: black title -> the world boots behind it -> at ready the attract walk fades in behind the menu.
// ENTER: pointer lock + audio start (the hum fades in) -> black -> teleport to the spawn -> picture fades in >= 1 s
// after the hum. Autostart (automation): no title, no pointer lock, audio starts at ready unless noaudio.
//
// R2 (B7) shell UX:
// * Title audio: the first pointerdown / keydown on the title starts the audio at a low, muffled level (a distant
//   hum under the attract walk); ENTER unmuffles it with the 1 s hum lead-in.
// * Nothing breaks the spell or loses progress: a beforeunload guard in play / pause (Ctrl+W), Ctrl is crouch only
//   in fullscreen with a keyboard lock (Fullscreen on the title, the pause menu and Settings > Video), WebGL context
//   loss freezes everything (loop, clock, audio, input) and offers 'Resume here' (reload in place; a restored
//   context reloads automatically), a zero-size window suspends rendering until it has a size again.
// * Discovery: first-play controls strip, camcorder captions on zone / storey changes and the first entry into a
//   landmark, a per-seed tape log on the pause screen (continueStore.ts), display names for the location line.
// * Esc on the pause menu shows 'Click to resume' at once (a key cannot take pointer lock after Esc).

import * as THREE from 'three';
import type { BackroomsDebugAPI, TeleportTarget } from '../core/debug.ts';
import { EventBus } from '../core/events.ts';
import type { GameEvents } from '../core/events.ts';
import { CHUNK_CELLS, STOREY_COUNT } from '../core/constants.ts';
import { cellIdx, worldToCell } from '../core/grid.ts';
import { CellFlag, DEBUG_VIEW_NAMES, LANDMARK_COUNT, ZONE_COUNT } from '../core/ids.ts';
import { QUALITY } from '../core/quality.ts';
import type { QualityConfig, QualityName } from '../core/quality.ts';
import { hashString } from '../core/rng.ts';
import type { FlickerMode, Settings } from '../core/settings.ts';
import { createAutopilot } from '../player/autopilot.ts';
import { INPUT_ACTION_EVENT, KEYBOARD_LOCK_CODES, setKeyboardLocked } from '../player/input.ts';
import type { InputExt } from '../player/input.ts';
import type { PlayerSystemExt } from '../player/PlayerSystem.ts';
import { clockText, tapeDate } from '../ui/dom.ts';
import { landmarkTitle, placeTitle, storeyTitle } from '../ui/names.ts';
import type { PauseInfo } from '../ui/pause.ts';
import { createUI } from '../ui/ui.ts';
import type { UI } from '../ui/ui.ts';
import type { AppCore, AppMode } from './appState.ts';
import { applyQuality, bootSystems, buildQuality, filmOf, startEarlyPool } from './boot.ts';
import type { LoadPhase } from './boot.ts';
import { createClock } from './clock.ts';
import { createContinueStore, createTapeLogStore } from './continueStore.ts';
import { createDebugApi } from './debugApi.ts';
import { createGate, createLoop, teleportPlayer } from './loop.ts';
import { createFrameStats, createGpuTimer } from './perf.ts';
import { isIntegratedRenderer, rendererString, resolveQuality, resolveQualityName } from './qualityAuto.ts';
import { UnsupportedError, createRenderer, primeGpuContext } from './renderer.ts';
import { createSettingsStore } from './settingsStore.ts';
import type { SettingsStore } from './settingsStore.ts';
import { locationSearch, parseLaunchParams } from './urlParams.ts';

export interface App { readonly debug: BackroomsDebugAPI; start(): Promise<void> }

const ENTER_FLAG = 'backrooms.enterOnReady';
const AUTOSAVE_S = 10;
const OVERLAY_HZ = 4;
const HUM_LEAD_MS = 1000; // the hum fades in 1 s before the picture
const ONBOARD_KEY = 'backrooms.onboarded.v1';
const ONBOARD_TEXT = 'WASD walk · Shift run · C crouch · F light · E use · Esc menu';
const ONBOARD_MS = 12000;
/** master gain on the title once a gesture started the audio (x the -12 dB low-passed pause muffle: a distant hum).
 * Measured output: 0.2 gave ~-58 dBFS rms (inaudible on laptop speakers); 0.6 measures ~-39 dBFS (the spec target ~-40; play: ~-20). */
const TITLE_GAIN = 0.6;
const CAPTION_STABLE_S = 1.0; // a zone must hold this long before it is captioned (no flapping at seams)
const DISCOVERY_DT = 0.25;
/** launch params carried over by 'Resume here' after a lost GPU context */
const RESUME_KEEP = ['autostart', 'noaudio', 'quality', 'hud', 'debug', 'camcorder', 'bake', 'fly', 'flicker', 'noprime'];
const INTERACT_VERBS: Record<number, string> = { 25: 'Try door', 21: 'Answer', 22: 'Radio off' };
const INTERACT_FEEDBACK: Record<number, string> = { 25: 'Locked', 21: 'No one there', 22: 'Off' };
const popcount = (v: number): number => { let n = 0; for (let x = v >>> 0; x; x &= x - 1) n++; return n; };

type KeyboardLock = { lock(codes?: string[]): Promise<void>; unlock(): void };
const keyboardApi = (): KeyboardLock | null => (navigator as Navigator & { keyboard?: KeyboardLock }).keyboard ?? null;

function storage(kind: 'local' | 'session'): Storage | null {
  try {
    const s = kind === 'local' ? window.localStorage : window.sessionStorage;
    const k = '__br_probe__';
    s.setItem(k, '1');
    s.removeItem(k);
    return s;
  } catch {
    return null;
  }
}

export function randomSeedText(): string {
  const d4 = (): string => String(Math.floor(Math.random() * 10000)).padStart(4, '0');
  return `${d4()}-${d4()}`;
}

const errText = (e: unknown): string => {
  if (e instanceof Error) return e.message || e.name;
  if (typeof e === 'string') return e;
  try { return JSON.stringify(e); } catch { return String(e); }
};

export function createApp(root: HTMLElement): App {
  const bootT0 = performance.now();
  const bus = new EventBus<GameEvents>();
  const canvas = document.createElement('canvas');
  canvas.tabIndex = -1;
  root.appendChild(canvas);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);
  const camera = new THREE.PerspectiveCamera(62, innerWidth / Math.max(1, innerHeight), 0.05, 400);
  camera.rotation.order = 'YXZ';

  // §6.1 step 1: settings, params
  const local = storage('local');
  const session = storage('session');
  const settings: SettingsStore = createSettingsStore(local);
  const continueStore = createContinueStore(local);
  const tapeStore = createTapeLogStore(local);
  const params = parseLaunchParams(location.search, settings.get(), randomSeedText());
  const enterOnReady = session?.getItem(ENTER_FLAG) === '1' && !params.autostart;
  session?.removeItem(ENTER_FLAG);

  const origConsoleError = console.error.bind(console);
  let logEvent: ((line: string) => void) | null = null; // the debug API's events() log, once it exists
  const recordError = (msg: string): void => {
    const m = msg.length > 500 ? `${msg.slice(0, 500)}…` : msg;
    logEvent?.(`error ${m}`); // §7.2 events(): game events + worker errors
    if (core.errors.length >= 100) return;
    core.errors.push(m);
  };

  const core: AppCore = {
    canvas, scene, camera, bus, clock: createClock(), frameStats: createFrameStats(), settings, params, bootT0,
    renderer: null, gpu: null, sys: null, mode: 'boot', attract: null, driver: null, frame: 0, cpuMs: 0,
    debug: null as unknown as BackroomsDebugAPI,
    gate: null as unknown as AppCore['gate'],
    hooks: [],
    flickerMode: params.flicker ?? settings.get().flicker,
    camcorderForced: params.camcorder,
    warnings: [], errors: [],
    warn(msg) {
      if (core.warnings.length < 100 && !core.warnings.includes(msg)) core.warnings.push(msg);
      console.warn(`[backrooms] ${msg}`);
    },
    fail(e) {
      recordError(errText(e));
      origConsoleError(e);
    },
    fov: () => params.fov ?? settings.get().fov,
  };
  core.gate = createGate(core);

  // console.error from any system (worker errors logged by the pool/streamer) counts as an error (§8.2 QA)
  console.error = (...args: unknown[]): void => {
    recordError(args.map(errText).join(' '));
    origConsoleError(...args);
  };
  addEventListener('error', (e) => recordError(`uncaught: ${e.message}`));
  addEventListener('unhandledrejection', (e) => recordError(`unhandled rejection: ${errText(e.reason)}`));

  let qualityChain: Promise<unknown> = Promise.resolve();
  let lastQualityKey = '';
  const qualityKey = (s: Settings): string => JSON.stringify([s.quality, s.overrides]);

  const setFlicker = (m: FlickerMode): void => {
    core.flickerMode = m;
    core.sys?.lighting.setFlickerMode(m);
    core.sys?.audio.setFlickerMode(m);
  };

  // Quality changes run one at a time; a request superseded by a newer one before it started is skipped (a dragged
  // render-scale slider or quick preset clicks apply only the latest state).
  let qualityGen = 0;
  const queueQuality = (make: () => QualityConfig): Promise<void> => {
    const gen = ++qualityGen;
    const run = async (): Promise<void> => {
      const s = core.sys;
      if (!s || gen !== qualityGen) return;
      const { reloadNeeded } = await applyQuality(core, make());
      ui.settings.setNotice(reloadNeeded ? 'Texture resolution changes after a reload.' : null, reloadNeeded);
    };
    const p = qualityChain.then(run, run);
    qualityChain = p.catch((e: unknown) => core.fail(e));
    return p;
  };

  const handle = createDebugApi(core, {
    setQuality: (name: QualityName) => queueQuality(() => buildQuality(name, settings.get(), params)),
    setFlicker,
  });
  core.debug = handle.api;
  logEvent = handle.log;
  window.__backrooms = handle.api;

  // ---------------------------------------------------------------- UI
  let mode: AppMode = 'boot';
  const setMode = (m: AppMode): void => { mode = m; core.mode = m; };
  let audioGain = 0; // title silence -> 1 in play
  let audioGainTarget = 0;
  let audioStarted = false;
  const volScratch: Settings['volume'] = { ...settings.get().volume };
  let playSeconds = 0;
  let autosaveT = 0;
  let overlayT = 0;
  let wasLocked = false;
  let resolvedAuto: QualityName = 'high';
  let bootDone: Promise<void> = Promise.resolve();
  let readyOnce: Promise<void> = Promise.resolve();
  let lost = false; // WebGL context lost: everything frozen until 'Resume here' reloads
  let lostWhilePlaying = false;
  let leaving = false; // our own navigation (no beforeunload prompt)
  let sizeSuspended = false; // zero-size window: rendering suspended
  let frameLoop: ((time: number) => void) | null = null;
  let resumePrompt = false; // 'Click to resume' after Esc on the pause menu
  const debugKeys = params.debug || params.fly || params.view !== DEBUG_VIEW_NAMES[0];

  const uiSound = (name: GameEvents['ui']['name']): void => bus.emit('ui', { name });

  // ---------------------------------------------------------------- tape log + discovery (R2, B7)
  const tapeLog = tapeStore.load(params.seedText);
  const disc = {
    t: 0, candZone: -1, candT: 0, capZone: -1, capS: -1, lastX: NaN, lastZ: NaN, lastS: -1,
    landmark: -1, landmarksSeen: new Set<string>(), zone: -1,
  };
  const saveTapeLog = (): void => {
    if (params.autostart || mode === 'auto' || mode === 'boot') return;
    tapeStore.save(params.seedText, tapeLog);
  };

  const saveContinue = (force = false): void => {
    const s = core.sys;
    if (!s || params.autostart || mode === 'auto' || mode === 'boot') return;
    if (!force && (mode === 'title' || mode === 'entering')) return;
    const st = s.player.state;
    continueStore.save({ seedText: params.seedText, s: st.s, x: st.x, y: st.y, z: st.z, yaw: st.yaw, savedAt: Date.now() });
    saveTapeLog();
  };

  const continueInfo = (): { seedText: string; storeyName: string } | null => {
    const cp = continueStore.load();
    return cp ? { seedText: cp.seedText, storeyName: storeyTitle(cp.s) } : null;
  };

  const startAudio = (): void => {
    const s = core.sys;
    if (!s || !params.audio || audioStarted) return;
    audioStarted = true;
    s.audio.start().catch((e: unknown) => core.fail(e));
  };

  /** Title: the first gesture starts a distant, muffled hum under the attract walk (never with noaudio / autostart). */
  const onTitleGesture = (): void => {
    if (mode !== 'title' || audioStarted || !params.audio || params.autostart || !core.sys || lost) return;
    startAudio();
    core.sys.audio.setPaused(true);
    audioGainTarget = TITLE_GAIN;
  };
  addEventListener('pointerdown', onTitleGesture, { capture: true });
  addEventListener('keydown', onTitleGesture, { capture: true });

  const pauseInfo = (): PauseInfo => {
    const s = core.sys;
    if (!s) return { place: '', coords: '', log: null };
    const st = s.player.state;
    const loaded = s.streamer.query.isLoaded(st.x, st.z);
    const zone = loaded ? s.streamer.query.zoneAt(st.x, st.z) : -1;
    let place = placeTitle(st.s, zone);
    if (disc.landmark >= 0) place = `${landmarkTitle(disc.landmark)} · ${place}`;
    const coords = `s${st.s} · x ${st.x.toFixed(1)} · z ${st.z.toFixed(1)} · tape ${params.seedText}`;
    const log = params.autostart ? null : {
      zones: [popcount(tapeLog.zones), ZONE_COUNT] as [number, number],
      landmarks: [tapeLog.landmarks.length, LANDMARK_COUNT] as [number, number],
      storeys: [popcount(tapeLog.storeys), STOREY_COUNT] as [number, number],
      metres: tapeLog.metres, seconds: tapeLog.seconds,
    };
    return { place, coords, log };
  };

  const captionsOn = (): boolean => params.hud && !params.autostart && mode === 'play' && !core.driver && !lost;
  const dateLine = (): string => { const now = new Date(); return `${tapeDate(params.seedText, now)}  ${clockText(now)}`; };

  /** Per-frame discovery bookkeeping while the player is in control (metres, tape time, zones, landmarks). */
  const discoveryTick = (dtS: number): void => {
    const s = core.sys;
    if (!s || mode !== 'play' || core.driver) { disc.lastS = -1; return; }
    const st = s.player.state;
    tapeLog.seconds += dtS;
    if (disc.lastS === st.s && Number.isFinite(disc.lastX)) {
      const d = Math.hypot(st.x - disc.lastX, st.z - disc.lastZ);
      if (d < 3) tapeLog.metres += d; // larger jumps are teleports / warps
    }
    disc.lastX = st.x; disc.lastZ = st.z; disc.lastS = st.s;
    disc.t -= dtS;
    if (disc.t > 0) return;
    disc.t = DISCOVERY_DT;
    // a teleport / storey switch is still streaming in: caption the place once it is actually there
    if (core.gate.active) { disc.candT = 0; return; }
    const q = s.streamer.query;
    if (!q.isLoaded(st.x, st.z)) return;
    tapeLog.storeys |= 1 << st.s;
    const gi = worldToCell(st.x), gj = worldToCell(st.z);
    const cx = Math.floor(gi / CHUNK_CELLS), cz = Math.floor(gj / CHUNK_CELLS);
    const l = q.layoutAt(cx, cz);
    if (!l) return;
    const li = gi - cx * CHUNK_CELLS, lj = gj - cz * CHUNK_CELLS;
    const flags = l.flags[cellIdx(li, lj)];
    // landmark footprint (first entry per instance this session: caption; the tape log counts kinds)
    let lmKind = -1;
    for (const m of l.landmarks) {
      if (li < m.i0 || li >= m.i1 || lj < m.j0 || lj >= m.j1) continue;
      lmKind = m.kind;
      const key = `${st.s}:${cx}:${cz}:${m.i0}:${m.j0}`;
      if (!disc.landmarksSeen.has(key)) {
        disc.landmarksSeen.add(key);
        if (!tapeLog.landmarks.includes(m.kind)) { tapeLog.landmarks.push(m.kind); saveTapeLog(); }
        if (captionsOn()) {
          ui.hud.caption(landmarkTitle(m.kind), placeTitle(st.s, q.zoneAt(st.x, st.z)), 3600);
          disc.capZone = q.zoneAt(st.x, st.z); disc.capS = st.s;
        }
      }
      break;
    }
    disc.landmark = lmKind;
    // zone: stairwells / elevator cars (structure zone) neither count nor caption
    if (flags & (CellFlag.TOWER | CellFlag.ELEVATOR)) return;
    const zone = q.zoneAt(st.x, st.z);
    disc.zone = zone;
    if (!(tapeLog.zones & (1 << zone))) { tapeLog.zones |= 1 << zone; saveTapeLog(); }
    if (zone !== disc.candZone) { disc.candZone = zone; disc.candT = 0; return; }
    disc.candT += DISCOVERY_DT;
    if (disc.candT >= CAPTION_STABLE_S && (zone !== disc.capZone || st.s !== disc.capS)) {
      disc.capZone = zone; disc.capS = st.s;
      if (captionsOn()) ui.hud.caption(placeTitle(st.s, zone), dateLine());
    }
  };
  bus.on('zoneChanged', (e) => { if (e.to !== disc.candZone) { disc.candZone = e.to; disc.candT = 0; disc.t = 0; } });
  bus.on('storeyChanged', () => { disc.capZone = -1; disc.capS = -1; disc.lastS = -1; });
  bus.on('teleport', () => { disc.lastS = -1; });
  bus.on('interact', (e) => {
    if (mode !== 'play' || !params.hud) return;
    ui.hud.cueFeedback(INTERACT_FEEDBACK[e.propKind] ?? 'Nothing here', e.propKind < 0 ? 900 : 1500);
  });

  // ---------------------------------------------------------------- fullscreen + keyboard lock
  const isFullscreen = (): boolean => !!document.fullscreenElement;
  const refreshFullscreenUi = (): void => {
    ui.title.refresh(isFullscreen());
    ui.pause.setFullscreen(isFullscreen());
    ui.settings.refresh();
  };
  const setFullscreen = (on: boolean): void => {
    if (on === isFullscreen()) return;
    if (!on) {
      keyboardApi()?.unlock();
      setKeyboardLocked(false);
      void document.exitFullscreen?.().catch(() => {});
      return;
    }
    const req = document.documentElement.requestFullscreen?.({ navigationUI: 'hide' });
    if (!req) { ui.toast('Fullscreen is not available here'); return; }
    req.then(async () => {
      const kb = keyboardApi();
      if (!kb) return;
      try { await kb.lock([...KEYBOARD_LOCK_CODES]); setKeyboardLocked(true); } catch { setKeyboardLocked(false); }
    }).catch(() => ui.toast('Fullscreen was refused by the browser'));
  };
  document.addEventListener('fullscreenchange', () => {
    if (!isFullscreen()) { setKeyboardLocked(false); keyboardApi()?.unlock(); }
    refreshFullscreenUi();
  });

  let pausedAt = 0;
  const pause = (): void => {
    if (mode !== 'play' || lost) return;
    pausedAt = performance.now();
    setMode('paused');
    core.clock.paused = true;
    bus.emit('pause', { paused: true });
    saveContinue();
    ui.hud.setCue(null);
    ui.hidePrompt();
    resumePrompt = false;
    if (document.pointerLockElement) document.exitPointerLock(); // Esc keydown may arrive while still locked
    ui.pause.setFullscreen(isFullscreen());
    ui.pause.show(pauseInfo());
  };

  /** Esc on the pause menu: a key cannot take pointer lock right after Esc, so ask for the click at once. */
  const resumeFromKey = (): void => {
    if (mode !== 'paused' || ui.settings.visible || lost) return;
    ui.pause.hide();
    resumePrompt = true;
    ui.showPrompt('Click to resume', () => { resumePrompt = false; resume(); });
  };

  const resume = (): void => {
    if (mode !== 'paused' || ui.settings.visible || lost) return;
    ui.pause.hide();
    ui.hidePrompt();
    resumePrompt = false;
    setMode('play');
    core.clock.paused = false;
    bus.emit('pause', { paused: false });
    const s = core.sys;
    if (!s) return;
    s.input.lock();
    // browsers refuse a re-lock shortly after the user left pointer lock with Esc: offer a click instead
    setTimeout(() => {
      if (mode === 'play' && !s.input.locked) ui.showPrompt('Click to look around', () => s.input.lock());
    }, 350);
  };

  const quitToTitle = (): void => {
    if (mode !== 'paused') return;
    saveContinue();
    ui.pause.hide();
    core.clock.paused = false;
    bus.emit('pause', { paused: false });
    audioGainTarget = audioStarted ? TITLE_GAIN : 0;
    core.sys?.audio.setPaused(true); // the title hears the muffled distance
    ui.hud.hideTransient();
    setMode('title');
    core.attract = createAutopilot((hashString(params.seedText) ^ 0x5eed) >>> 0, () => core.clock.t);
    if (document.pointerLockElement) document.exitPointerLock();
    ui.title.setContinue(continueInfo());
    ui.title.show();
  };

  const reloadWith = (search: string, enter: boolean): void => {
    if (enter) session?.setItem(ENTER_FLAG, '1');
    leaving = true;
    location.search = search;
  };

  /** Reload at the player's current place (lost GPU context): same seed, storey, position and view. */
  const resumeHere = (): void => {
    const st = core.sys?.player.state;
    let search = st ? locationSearch(params.seedText, st.s, st.x, st.z, st.yaw, st.pitch) : `?seed=${encodeURIComponent(params.seedText)}`;
    const cur = new URLSearchParams(location.search);
    const keep = new URLSearchParams();
    for (const k of RESUME_KEEP) { const v = cur.get(k); if (v !== null) keep.set(k, v); }
    const extra = keep.toString();
    if (extra) search += `&${extra}`;
    reloadWith(search, lostWhilePlaying);
  };

  const onContextLost = (): void => {
    if (lost) return;
    lost = true;
    lostWhilePlaying = mode === 'play' || mode === 'paused' || mode === 'entering';
    core.renderer?.setAnimationLoop(null); // nothing runs (player, streamer, audio updates) until the reload
    core.clock.paused = true;
    core.driver = null;
    const s = core.sys;
    if (s) {
      s.audio.setPaused(true);
      audioGain = 0; audioGainTarget = 0;
      s.audio.setVolumes({ ...settings.get().volume, master: 0 });
    }
    if (document.pointerLockElement) document.exitPointerLock();
    if (lostWhilePlaying) saveContinue(true);
    else saveTapeLog();
    resumePrompt = false;
    ui.error('GPU context lost', 'The graphics driver reset. Your place on the tape is kept: resume to rebuild the world where you stood.',
      undefined, { label: 'Resume here', run: resumeHere });
  };

  /** ENTER / CONTINUE (same seed): black, teleport, hum, picture. */
  const enter = async (dest: TeleportTarget | null): Promise<void> => {
    if (mode !== 'title') return;
    setMode('entering');
    ui.title.hide();
    ui.hidePrompt();
    settings.set({ lastSeed: params.seedText });
    core.sys?.input.lock(); // inside the user gesture
    startAudio();
    core.sys?.audio.setPaused(false); // lift the title's muffle
    let humAt = performance.now();
    if (audioStarted) audioGainTarget = 1;
    await ui.curtain(1, 450);
    if (!core.sys || !core.debug.ready) {
      ui.loading.show(ui.phases, params.seedText);
      await bootDone;
      await readyOnce;
      ui.loading.hide();
    }
    const s = core.sys;
    if (!s) return;
    core.attract = null;
    if (!audioStarted) { startAudio(); audioGainTarget = 1; humAt = performance.now(); }
    s.audio.setPaused(false);
    const st = s.player.state;
    const target: TeleportTarget = dest ?? { x: s.spawn.x, z: s.spawn.z, s: s.spawn.s, yaw: s.spawn.yaw, pitch: s.spawn.pitch };
    if (dest !== null || Math.hypot(st.x - target.x, st.z - target.z) > 0.25 || st.s !== target.s) {
      await teleportPlayer(core, target);
    }
    const wait = humAt + HUM_LEAD_MS - performance.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    if (lost) return;
    setMode('play');
    wasLocked = s.input.locked;
    void ui.curtain(0, 1300);
    if (!s.input.locked) ui.showPrompt('Click to look around', () => s.input.lock());
    // the tape opens on where you are; first play also gets the controls strip
    disc.capZone = -1; disc.capS = -1; disc.candT = 0; disc.lastS = -1;
    if (params.hud && local?.getItem(ONBOARD_KEY) !== '1') {
      setTimeout(() => {
        if (mode !== 'play' && mode !== 'paused') return;
        ui.hud.hint(ONBOARD_TEXT, ONBOARD_MS);
        try { local?.setItem(ONBOARD_KEY, '1'); } catch { /* private mode */ }
      }, 1700);
    }
  };

  const ui: UI = createUI(root, {
    seedText: params.seedText,
    storeyName: storeyTitle(params.s ?? 0),
    store: settings,
    title: {
      onEnter: () => { void enter(null).catch((e: unknown) => core.fail(e)); },
      onContinue: () => {
        const cp = continueStore.load();
        if (!cp) return;
        if (cp.seedText === params.seedText) {
          void enter({ x: cp.x, y: cp.y, z: cp.z, s: cp.s, yaw: cp.yaw, pitch: 0 }).catch((e: unknown) => core.fail(e));
        } else {
          settings.set({ lastSeed: cp.seedText });
          reloadWith(locationSearch(cp.seedText, cp.s, cp.x, cp.z, cp.yaw, 0), true);
        }
      },
      onSeed: (seed) => {
        settings.set({ lastSeed: seed });
        reloadWith(`?seed=${encodeURIComponent(seed)}`, true);
      },
      randomSeed: randomSeedText,
      onSettings: () => { ui.title.setInteractive(false); ui.settings.open('settings'); },
      onControls: () => { ui.title.setInteractive(false); ui.settings.open('keys'); },
      camcorder: () => settings.get().film.camcorder,
      onCamcorder: () => { const f = settings.get().film; settings.set({ film: { ...f, camcorder: !f.camcorder } }); },
      onFullscreen: () => setFullscreen(!isFullscreen()),
      sound: uiSound,
    },
    pause: {
      onResume: resume,
      onSettings: () => { ui.pause.setInteractive(false); ui.settings.open('settings'); },
      onControls: () => { ui.pause.setInteractive(false); ui.settings.open('keys'); },
      onFullscreen: () => setFullscreen(!isFullscreen()),
      onNewTape: () => {
        if (mode !== 'paused') return;
        saveContinue();
        const seed = randomSeedText();
        settings.set({ lastSeed: seed });
        reloadWith(`?seed=${encodeURIComponent(seed)}`, true);
      },
      locationLink: () => {
        const st = core.sys?.player.state;
        if (!st) return location.href;
        return `${location.origin}${location.pathname}${locationSearch(params.seedText, st.s, st.x, st.z, st.yaw, st.pitch)}`;
      },
      onQuit: quitToTitle,
      sound: uiSound,
    },
    settings: {
      sound: uiSound,
      onClose: () => {
        if (mode === 'paused') ui.pause.setInteractive(true);
        else ui.title.setInteractive(true);
      },
      autoQuality: () => resolvedAuto,
      presetRenderScale: () => {
        const s = settings.get();
        return QUALITY[s.quality === 'auto' ? resolvedAuto : s.quality].renderScale;
      },
      presetDynamicResolution: () => {
        const s = settings.get();
        return QUALITY[s.quality === 'auto' ? resolvedAuto : s.quality].dynamicResolution;
      },
      onReload: () => { leaving = true; saveContinue(); location.reload(); },
      fullscreen: isFullscreen,
      setFullscreen,
      debugKeys: params.debug,
    },
  });
  if (!params.hud) ui.setHudHidden(true);
  ui.overlay.setVisible(params.debug);

  // ---------------------------------------------------------------- live settings
  let lastSettingsFlicker = settings.get().flicker;
  let lastSettingsQuality = settings.get().quality;
  const applySettings = (s: Settings): void => {
    bus.emit('settingsChanged', s);
    const sys = core.sys;
    if (!sys) return;
    sys.post.setFilm(filmOf(core), s.brightnessEV);
    // the flicker= launch param overrides the setting until the user changes the setting itself
    if (s.flicker !== lastSettingsFlicker) { lastSettingsFlicker = s.flicker; setFlicker(s.flicker); }
    (sys.input as Partial<InputExt>).setSettings?.(s);
    Object.assign(volScratch, s.volume);
    volScratch.master = s.volume.master * audioGain;
    sys.audio.setVolumes(volScratch);
    const key = qualityKey(s);
    if (key !== lastQualityKey) {
      lastQualityKey = key;
      // keep the running preset (it may come from quality= in the URL) unless the preset setting itself changed
      const name: QualityName = s.quality === lastSettingsQuality ? sys.q.name : s.quality === 'auto' ? resolvedAuto : s.quality;
      lastSettingsQuality = s.quality;
      void queueQuality(() => buildQuality(name, s, params)).catch((e: unknown) => core.fail(e));
    }
    ui.settings.refresh();
  };
  settings.subscribe(applySettings);

  // ---------------------------------------------------------------- keys, pointer lock, visibility
  let viewIndex = Math.max(0, DEBUG_VIEW_NAMES.indexOf(params.view));
  let lastEscKeyAt = -1;
  window.addEventListener('keydown', (e: KeyboardEvent) => {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
    if (e.code === 'F3') {
      e.preventDefault();
      ui.overlay.setVisible(!ui.overlay.visible);
      overlayT = 1;
    } else if (e.code === 'F4') {
      if (!debugKeys) return; // debug views only with debug=1 / fly=1 / view= (never mid-play by accident)
      e.preventDefault();
      const s = core.sys;
      if (!s) return;
      viewIndex = (viewIndex + 1) % DEBUG_VIEW_NAMES.length;
      s.materials.setDebugView(viewIndex);
      if (params.hud) ui.toast(`view: ${DEBUG_VIEW_NAMES[viewIndex]}`);
    } else if (e.code === 'Escape') {
      lastEscKeyAt = performance.now();
      if (ui.settings.visible || lost) return;
      if (resumePrompt && mode === 'paused') {
        // Esc on 'Click to resume': back to the menu
        resumePrompt = false;
        ui.hidePrompt();
        pausedAt = performance.now();
        ui.pause.show(pauseInfo());
      } else if (mode === 'play') pause();
      // the Esc that released pointer lock (-> pause via pointerlockchange) may also arrive here: ignore it
      else if (mode === 'paused' && performance.now() - pausedAt > 400) resumeFromKey();
    }
  });
  // WP12 input actions: the keyboard ones (Esc / F3 / F4) are handled above (they also work before boot); the
  // gamepad Start button arrives only here as 'pause' and toggles the pause menu.
  window.addEventListener(INPUT_ACTION_EVENT, (e: Event) => {
    const a = (e as CustomEvent<{ action?: string }>).detail?.action;
    if (a !== 'pause' || performance.now() - lastEscKeyAt < 150 || ui.settings.visible) return;
    if (mode === 'play') pause();
    else if (mode === 'paused' && performance.now() - pausedAt > 400) resume();
  });
  document.addEventListener('pointerlockchange', () => {
    const locked = document.pointerLockElement === canvas;
    if (locked) ui.hidePrompt();
    if (mode === 'play' && wasLocked && !locked) pause();
    wasLocked = locked;
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      saveContinue();
      if (mode === 'play') pause();
    }
  });
  addEventListener('pagehide', () => saveContinue());
  // Ctrl+W / a stray reload in play: the browser asks first (our own reloads set `leaving`)
  addEventListener('beforeunload', (e: BeforeUnloadEvent) => {
    if (leaving || lost || (mode !== 'play' && mode !== 'paused')) return;
    saveContinue();
    e.preventDefault();
    e.returnValue = '';
  });

  // A zero-size window (minimised split view, collapsed iframe) would raise GL errors every frame and jump the
  // exposure: rendering is suspended until the window has a size again, then the exposure is snapped.
  addEventListener('resize', () => {
    const w = innerWidth, h = innerHeight;
    if (w < 1 || h < 1) {
      if (!sizeSuspended) { sizeSuspended = true; core.renderer?.setAnimationLoop(null); }
      return;
    }
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    if (core.sys) core.sys.post.setSize(w, h);
    else core.renderer?.setSize(w, h);
    if (sizeSuspended) {
      sizeSuspended = false;
      if (!lost && frameLoop && core.renderer) {
        core.sys?.post.snapExposure();
        core.renderer.setAnimationLoop(frameLoop);
      }
    }
  });

  // ---------------------------------------------------------------- per-frame UI work (loop step 12)
  const onFrame = (frameMs: number): void => {
    const s = core.sys;
    if (!s) return;
    const dtS = Math.min(frameMs, 250) / 1000;
    // hum fade (title silence <-> play)
    if (audioGain !== audioGainTarget) {
      const step = dtS / 1.4;
      audioGain = audioGain < audioGainTarget ? Math.min(audioGainTarget, audioGain + step) : Math.max(audioGainTarget, audioGain - step * 2);
      const v = settings.get().volume;
      volScratch.master = v.master * audioGain; volScratch.ambience = v.ambience; volScratch.hum = v.hum;
      volScratch.sfx = v.sfx; volScratch.ui = v.ui;
      s.audio.setVolumes(volScratch);
    }
    const playing = mode === 'play' || mode === 'auto';
    if (playing) playSeconds += dtS;
    (s.player as Partial<PlayerSystemExt>).setUserPace?.(mode === 'play' && !core.driver);
    discoveryTick(dtS);
    if (mode === 'play') {
      autosaveT += dtS;
      if (autosaveT >= AUTOSAVE_S) { autosaveT = 0; saveContinue(); }
    }
    if (params.hud) {
      const tgt = mode === 'play' && !core.driver ? s.player.state.target : -1;
      ui.hud.setCue(tgt >= 0 ? INTERACT_VERBS[tgt] ?? 'Use' : null);
      ui.hud.setRec((core.camcorderForced || settings.get().film.camcorder) && playing);
      ui.hud.tick(playSeconds);
    }
    if (ui.overlay.visible) {
      overlayT -= dtS;
      if (overlayT <= 0) {
        overlayT = 1 / OVERLAY_HZ;
        const d = core.driver ? 'driver: walking' : mode;
        ui.overlay.update(core.debug.stats(), `mode ${d}  view ${DEBUG_VIEW_NAMES[viewIndex] ?? '?'}`);
      }
    }
  };

  // ---------------------------------------------------------------- boot
  const boot = async (): Promise<void> => {
    // renderer first; 'auto' resolves against its own context (no probe context)
    const provisional = QUALITY[params.quality && params.quality !== 'auto' ? params.quality : 'high'];
    // absorb Chromium's first-context loss on a throwaway context; meanwhile the workers boot with the preset the
    // probe's renderer string resolves to (the same GPU the real context gets)
    const probe = primeGpuContext(params.prime);
    const probeName = resolveQualityName(params.quality ?? settings.get().quality, probe.renderer);
    const early = startEarlyPool(params, buildQuality(probeName, settings.get(), params));
    await probe.ready;
    const r = createRenderer(canvas, provisional);
    core.renderer = r;
    const gl = r.getContext() as WebGL2RenderingContext;
    resolvedAuto = resolveQuality('auto', gl);
    const gpuName = rendererString(gl);
    if (isIntegratedRenderer(gpuName)) {
      const short = gpuName.replace(/^ANGLE \(([^,]+), /, '').replace(/\s*\((?:radeonsi|RADV|0x)[^)]*\)/gi, '').replace(/,.*$/, '').replace(/\)+$/, '').trim();
      ui.title.setGpuNote(`Rendering on an integrated GPU (${short}). If this computer has a dedicated GPU, start the game with ` +
        '`npm run play`, or run the browser on the dedicated GPU (see README › Performance).');
      console.info(`[backrooms] integrated GPU: ${gpuName}`);
    }
    const qName = resolveQuality(params.quality ?? settings.get().quality, gl);
    const q = buildQuality(qName, settings.get(), params);
    lastQualityKey = qualityKey(settings.get());
    r.setPixelRatio(Math.min(devicePixelRatio, q.maxDpr) * q.renderScale);
    r.setSize(innerWidth, innerHeight);
    camera.fov = core.fov();
    camera.aspect = innerWidth / Math.max(1, innerHeight);
    camera.updateProjectionMatrix();
    core.gpu = createGpuTimer(gl);
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault(); // allow a restore
      core.fail(new Error('WebGL context lost'));
      onContextLost();
    });
    // a restored context cannot get the world back (every GPU resource is gone): rebuild it in place
    canvas.addEventListener('webglcontextrestored', () => { if (lost) resumeHere(); });

    // step 2: UI
    if (params.autostart) {
      setMode('auto');
      void ui.curtain(0, 0);
      ui.loading.show(ui.phases, params.seedText);
    } else {
      setMode('title');
      void ui.curtain(1, 0);
      ui.title.setStatus(ui.phases);
      ui.title.setContinue(continueInfo());
      ui.title.setReady(false);
      ui.title.show(true);
    }
    const onPhase = (p: LoadPhase): void => ui.phases.setPhase(p);
    const onProgress = (p: LoadPhase, f: number): void => ui.phases.setProgress(p, f);

    // steps 3-5
    const sys = await bootSystems(core, q, { phase: onPhase, progress: onProgress }, early);
    core.sys = sys;
    if (params.autostart) { audioGain = 1; audioGainTarget = 1; }
    // Settings changed on the title while the systems booted have not reached them yet: apply the current state
    // once (film, flicker, input, volumes scaled by the title's audio gain, and a queued quality change if the
    // preset or overrides moved since boot read them).
    applySettings(settings.get());
    // event wiring
    bus.on('glitch', (e) => sys.post.glitch(e.seconds, e.strength));
    bus.on('pause', (e) => { sys.post.setPaused(e.paused); sys.audio.setPaused(e.paused); });
    if (mode === 'title') core.attract = createAutopilot((hashString(params.seedText) ^ 0x5eed) >>> 0, () => core.clock.t);
    refreshFullscreenUi();

    // steps 6-7: loop + ready gate (the attract walk starts at ready)
    onPhase('world');
    const progressHook = (): boolean => {
      if (core.debug.ready) return true;
      const st = sys.streamer.stats();
      const need = 36; // radius-1 tiles (3 x 3 chunks x 4)
      ui.phases.setProgress('world', Math.min(1, st.tilesResident / need));
      if (core.debug.readyPhase === 'bake' || core.debug.readyPhase === 'frames') {
        ui.phases.setProgress('world', 1);
        ui.phases.setProgress('lighting', params.bake === 'full' ? Math.min(0.95, st.tilesFull / need) : 0.95);
      }
      return false;
    };
    core.hooks.push(progressHook);
    const ready = core.gate.open({ reason: 'boot', snapToWalkable: sys.spawn.reason === 'explicit' });
    readyOnce = ready;
    frameLoop = createLoop(core, onFrame);
    if (lost) return;
    if (innerWidth < 1 || innerHeight < 1) sizeSuspended = true; // armed by the resize handler
    else r.setAnimationLoop(frameLoop);
    await ready;
    ui.phases.complete();
    if (params.autostart) {
      ui.loading.hide(true);
      startAudio();
    } else {
      ui.title.setReady(true);
      ui.title.setStatus(null);
      if (mode === 'title') {
        void ui.curtain(0, 2600); // the attract walk fades in behind the menu
        if (enterOnReady) ui.showPrompt('Click to enter', () => { void enter(null).catch((e: unknown) => core.fail(e)); });
      }
    }
  };

  return {
    debug: handle.api,
    start() {
      const p = boot().catch((e: unknown) => {
        core.fail(e);
        if (e instanceof UnsupportedError) ui.error(e.title, e.message);
        else ui.error('Boot failed', errText(e), e instanceof Error && e.stack ? e.stack : undefined);
        throw e;
      });
      bootDone = p.then(() => undefined, () => undefined);
      return p;
    },
  };
}

