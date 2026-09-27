// src/app/loop.ts (WP14) — the frame loop (§6.2, renderer.setAnimationLoop), the ready gate (§6.1 steps 6-7 and
// "teleport and goto after ready") and teleports. Steps 1-11 do not allocate (scratch objects are preallocated).

import { cellIdx, worldToCell, worldToChunk } from '../core/grid.ts';
import { CellFlag } from '../core/ids.ts';
import type { TeleportTarget } from '../core/debug.ts';
import type { GameEvents } from '../core/events.ts';
import type { MoodId, StoreyId, ZoneId } from '../core/ids.ts';
import type { PlayerInput } from '../core/player.ts';
import { setFlashlightBounce } from '../lighting/LightingRuntime.ts';
import { DEFAULT_CONTROLLER, type PlayerInputExt } from '../player/controller.ts';
import { nearestWaterPlane } from '../materials/water/rippleSources.ts';
import type { AppCore, GateOptions, ReadyGate } from './appState.ts';
import { applyLaunchToggles } from './boot.ts';

/** §6.1 / STATUS 2026-09-24: 10 rendered frames after the boot gate and after every teleport. */
export const READY_FRAMES = 10;
/** Give up waiting for the stream after this long (reported as a warning, which fails headless QA). */
export const GATE_TIMEOUT_MS = 45_000;
/** Attract mode speed cap (m/s, §5 WP14 title: 0.6-1.0 m/s). */
const ATTRACT_MAX_SPEED = 1.0;
const WALK_SPEED = DEFAULT_CONTROLLER.walk;
const WATER_SCAN_INTERVAL = 6; // frames
const WATER_MAX_DIST = 40; // m (PlanarReflection renders planes within 40 m)
/** Upload budget while an automation ready gate (bake 'full') is closed: nobody watches, so uploads may take most
 * of the frame and skip the fade-in (processUploads burst). */
const BURST_UPLOAD_MS = 50;

export function createInputState(): PlayerInput {
  return { moveX: 0, moveZ: 0, lookDX: 0, lookDY: 0, sprint: false, crouch: false, flashlightPressed: false, interactPressed: false };
}

function clearInput(i: PlayerInput): void {
  i.moveX = 0; i.moveZ = 0; i.lookDX = 0; i.lookDY = 0;
  i.sprint = false; i.crouch = false; i.flashlightPressed = false; i.interactPressed = false;
  (i as PlayerInputExt).up = false; // fly-mode ascend (WP12 extension): a driver that writes the input must not inherit it
}

// ---------------------------------------------------------------- ready gate

/** Snap race guard: a snap result is applied only while the player is still this close (m) to where it was asked. */
const SNAP_STILL_M = 1;

/** Player gate (bake 'interactive' / 'preview'): preview-lit tiles within READY_NEAR_M of the player, plus tiles in
 * view within READY_VIEW_M. The rest of the radius streams in behind the haze and edge fog (each tile dithers in over
 * UPLOAD.FADE_IN_S), and full bakes swap in place as they arrive. */
export const READY_NEAR_M = 20;
export const READY_VIEW_M = 40;

/** The streamer queries the ready gate needs. */
export interface GateStream {
  isReady(radiusChunks: number, needFull: boolean): boolean;
  isReadyNear(nearM: number, viewM: number, needFull: boolean): boolean;
}

/** The stream condition of the ready gate for a `bake` launch mode (§6.1, R2 B9). 'full' (automation default:
 * deterministic screenshots) waits for every ring-1 tile fully baked; players ('interactive', 'preview') wait only
 * for the preview-lit tiles around and in front of them. */
export function streamReadyFor(bake: 'preview' | 'full' | 'interactive', st: GateStream): { pre: boolean; full: boolean } {
  if (bake === 'full') {
    const pre = st.isReady(1, false);
    return { pre, full: pre && st.isReady(1, true) };
  }
  return { pre: st.isReadyNear(READY_NEAR_M, READY_VIEW_M, false), full: true };
}

export function createGate(core: AppCore): ReadyGate {
  let active = false;
  let reason: GateOptions['reason'] = 'boot';
  let phase: 'stream' | 'frames' = 'stream';
  let frames = 0;
  let startMs = 0;
  let snap: 'none' | 'waitChunk' | 'busy' = 'none';
  let snapFloor = false;
  let togglesPending = false;
  // generation of the current open(): a findNearest answer that belongs to an older teleport is ignored
  let gen = 0;
  const waiters: (() => void)[] = [];

  const snapCheck = (): void => {
    const s = core.sys;
    if (!s) return;
    const st = s.player.state;
    const q = s.streamer.query;
    if (!q.isLoaded(st.x, st.z)) return;
    const gi = worldToCell(st.x), gj = worldToCell(st.z);
    const walkable = q.cellWalkable(gi, gj);
    const l = q.layoutAt(worldToChunk(st.x), worldToChunk(st.z));
    const inStructure = l !== null && (l.flags[cellIdx(gi & 31, gj & 31)] & (CellFlag.TOWER | CellFlag.ELEVATOR)) !== 0;
    // tower / elevator cells have their own floors (flights, cab): only the walkability rule applies there
    if (walkable && (!snapFloor || inStructure)) { snap = 'none'; return; }
    snap = 'busy';
    const yaw = st.yaw, pitch = st.pitch;
    const g = gen, fromS = st.s, fromX = st.x, fromZ = st.z;
    const from = { s: st.s, x: st.x, z: st.z };
    // 'clear': the point itself when it is standable floor, else the nearest standable spot; 'safe' as a fallback
    s.streamer.findNearest('clear', from, 2).then((c) => c ?? s.streamer.findNearest('safe', from, 4)).then((sp) => {
      if (g !== gen) return; // a newer teleport owns the gate (and its own snap state)
      const now = s.player.state;
      const still = now.s === fromS && Math.hypot(now.x - fromX, now.z - fromZ) <= SNAP_STILL_M;
      const moved = sp !== null && (Math.abs(sp.x - fromX) > 1e-3 || Math.abs(sp.z - fromZ) > 1e-3 || sp.s !== fromS);
      // a URL position without yaw= faces the spot's most open direction (not a wall at yaw 0)
      const aim = (reason === 'boot' || reason === 'seed') && core.params.x !== null && core.params.yaw === null;
      if (sp && still && (moved || aim)) {
        s.player.teleport(sp.s, sp.x, null, sp.z, aim ? sp.yaw : yaw, pitch);
        core.bus.emit('teleport', { s: sp.s, x: sp.x, y: s.player.state.y, z: sp.z });
      }
      snap = 'none';
    }, (e: unknown) => {
      if (g !== gen) return;
      core.fail(e);
      snap = 'none';
    });
  };

  return {
    get active() { return active; },
    open(o) {
      gen++;
      core.debug.ready = false;
      core.debug.readyPhase = 'chunks';
      if (!active || o.reason === 'boot' || o.reason === 'seed') reason = o.reason;
      if (o.reason === 'boot' || o.reason === 'seed') togglesPending = true;
      active = true;
      phase = 'stream';
      frames = 0;
      startMs = performance.now();
      snap = o.snapToWalkable ? 'waitChunk' : 'none';
      snapFloor = o.snapToWalkable && (o.snapFloor ?? ((o.reason === 'boot' || o.reason === 'seed') && core.params.y === null));
      return new Promise<void>((resolve) => { waiters.push(resolve); });
    },
    tick() {
      if (!active) return;
      const s = core.sys;
      if (!s) return;
      if (phase === 'stream') {
        if (snap === 'waitChunk') snapCheck();
        const { pre, full } = streamReadyFor(core.params.bake, s.streamer);
        core.debug.readyPhase = !pre ? 'chunks' : !full ? 'bake' : 'frames';
        const timedOut = performance.now() - startMs > GATE_TIMEOUT_MS;
        if (!(pre && full && snap === 'none') && !timedOut) return;
        if (timedOut) {
          core.warn(`ready gate (${reason}): stream not ready after ${GATE_TIMEOUT_MS / 1000} s ` +
            `(radius-1 ${pre ? 'uploaded' : 'not uploaded'}, ${full ? 'baked' : 'not full-baked'}); continuing`);
        }
        s.post.snapExposure();
        if (togglesPending) { togglesPending = false; applyLaunchToggles(core); }
        phase = 'frames';
        frames = 0;
        core.debug.readyPhase = 'frames';
        return;
      }
      if (++frames < READY_FRAMES) return;
      active = false;
      core.debug.ready = true;
      core.debug.readyPhase = 'ready';
      const now = performance.now();
      performance.mark('br:ready', { detail: reason });
      core.bus.emit('ready', { ms: now - (reason === 'boot' ? core.bootT0 : startMs) });
      // the boot pool's extra workers (~155 MB each) retire once the first radius is in (busy ones after their job)
      if (s.pool.size > s.poolTarget) void s.pool.resize(s.poolTarget);
      for (const w of waiters.splice(0)) w();
    },
  };
}

/** Teleport + ready gate (§6.1 "teleport and goto after ready"): resolves when ready again. */
export function teleportPlayer(core: AppCore, t: TeleportTarget): Promise<void> {
  const s = core.sys;
  if (!s) return Promise.reject(new Error('teleport: the app has not booted yet'));
  if (!Number.isFinite(t.x) || !Number.isFinite(t.z)) return Promise.reject(new Error('teleport: x and z must be finite numbers'));
  const st = s.player.state;
  const storey: StoreyId = t.s === 0 || t.s === 1 || t.s === 2 ? t.s : st.s;
  const yaw = t.yaw !== undefined && Number.isFinite(t.yaw) ? t.yaw : st.yaw;
  const pitch = t.pitch !== undefined && Number.isFinite(t.pitch) ? t.pitch : st.pitch;
  const y = t.y !== undefined && Number.isFinite(t.y) ? t.y : null;
  const done = core.gate.open({ reason: 'teleport', snapToWalkable: true, snapFloor: y === null });
  if (storey !== s.streamer.storey) s.streamer.switchStorey(storey);
  s.player.teleport(storey, t.x, y, t.z, yaw, pitch);
  core.bus.emit('teleport', { s: storey, x: t.x, y: s.player.state.y, z: t.z });
  return done;
}

// ---------------------------------------------------------------- frame loop

export interface Loop {
  (nowMs: number): void;
  /** nearest visible water plane (world y) from the last scan, or null */
  readonly waterY: number | null;
}

export function createLoop(core: AppCore, onFrame: (frameMs: number) => void): Loop {
  const input = createInputState();
  const drain = createInputState();
  const zonePayload: GameEvents['zoneChanged'] = { from: 0 as ZoneId, to: 0 as ZoneId, s: 0 as StoreyId, mood: 0 as MoodId };
  let lastZone = -1;
  let lastNow = -1;
  let waterY: number | null = null;

  const scanWater = (): void => {
    const s = core.sys;
    if (!s || s.q.planarReflectionScale <= 0) { waterY = null; return; }
    const st = s.player.state;
    const wp = nearestWaterPlane(s.streamer.query, st.eyeX, st.eyeY, st.eyeZ, -Math.sin(st.camYaw), -Math.cos(st.camYaw), WATER_MAX_DIST);
    waterY = wp ? wp.y : null;
  };

  const loop = ((now: number): void => {
    const s = core.sys;
    const r = core.renderer;
    if (!s || !r) return;
    const clock = core.clock;
    const frameMs = lastNow < 0 ? 1000 / 60 : now - lastNow;
    lastNow = now;
    clock.tick(now);
    const dt = clock.dt;
    const realDt = clock.realDt;
    const t = clock.t;
    r.info.reset();
    const t0 = performance.now();
    const st = s.player.state;
    const query = s.streamer.query;
    const mode = core.mode;
    try {
      // 0. a render-scale change queued by step 12 of the last frame: the canvas resize must precede this frame's draw
      s.dynRes.beforeRender();
      // 1. input (autopilot / drivers write inputState instead)
      const playing = mode === 'play' || mode === 'auto';
      let timeScale = 1;
      if (core.driver) {
        s.input.poll(drain);
        core.driver.drive(st, query, input, realDt);
        timeScale = core.driver.timeScale;
      } else if (playing) {
        s.input.poll(input);
      } else {
        s.input.poll(drain); // keep mouse deltas from piling up behind the menus
        clearInput(input);
        if (mode === 'title' && core.attract && core.debug.ready) {
          core.attract.next(st, query, input);
          const m = Math.sqrt(input.moveX * input.moveX + input.moveZ * input.moveZ);
          const cap = ATTRACT_MAX_SPEED / WALK_SPEED;
          if (m > cap) { input.moveX *= cap / m; input.moveZ *= cap / m; }
          input.sprint = false; input.crouch = false; input.flashlightPressed = false; input.interactPressed = false;
        }
      }
      if (input.flashlightPressed) s.lighting.flashlight.set(!s.lighting.flashlight.on);
      // 2. player (real dt so autowalk/walk work under time=; frozenTime freezes bob/breath)
      if (!clock.paused) s.player.update(realDt * timeScale, input, query, core.bus, clock.frozen);
      // 3. streaming
      s.streamer.update(st.x, st.z, -Math.sin(st.camYaw), -Math.cos(st.camYaw), core.camera, core.frame);
      // 4. uploads
      const burst = core.gate.active && core.params.bake === 'full';
      s.streamer.processUploads(r, burst ? BURST_UPLOAD_MS : s.q.uploadBudgetMs, burst);
      // 5. lighting (package F reads its URL toggle bounce= from the launch features)
      setFlashlightBounce(s.lighting, s.features.bounce);
      s.lighting.update(t, dt, s.streamer.tiles(), st, core.camera, query);
      // 6. anomalies
      s.anomaly.update(t, dt, st, query);
      // 7. material time
      s.materials.globals.time.value = t;
      // 8. camera
      s.player.applyToCamera(core.camera, core.fov());
      // 9. audio
      s.audio.update(t, dt, st, query, s.lighting);
      // 10. planar reflection
      if (core.frame % WATER_SCAN_INTERVAL === 0) scanWater();
      core.gpu?.begin();
      s.ripples.update(r, dt, t, st, query); // package E: ripple window and fixed steps (inside the GPU timer)
      s.reflection.update(r, core.scene, core.camera, waterY);
      // 11. post
      s.post.setAtmosphere(s.lighting.atmosphere());
      s.post.render(realDt, t);
      core.gpu?.end();
    } catch (e) {
      core.gpu?.end();
      core.fail(e);
    }
    core.cpuMs = performance.now() - t0;
    // 12. dynamic resolution, stats, overlay, hooks, zone events, ready gate
    try {
      // cost, not interval: a 50 Hz display or a 30 fps throttle is not GPU load (DynamicResolution.ts)
      if (s.q.dynamicResolution && core.debug.ready && !clock.paused) s.dynRes.update(frameMs, core.cpuMs, core.gpu?.consume() ?? null);
      core.frameStats.push(frameMs, core.cpuMs, now);
      if (query.isLoaded(st.x, st.z)) {
        const z = query.zoneAt(st.x, st.z);
        if (z !== lastZone) {
          if (lastZone >= 0) {
            zonePayload.from = lastZone as ZoneId;
            zonePayload.to = z;
            zonePayload.s = st.s;
            zonePayload.mood = query.moodAt(st.x, st.z);
            core.bus.emit('zoneChanged', zonePayload);
          }
          lastZone = z;
        }
      }
      const hooks = core.hooks;
      for (let i = hooks.length - 1; i >= 0; i--) {
        if (hooks[i](frameMs)) hooks.splice(i, 1);
      }
      onFrame(frameMs);
      core.gate.tick();
    } catch (e) {
      core.fail(e);
    }
    core.frame++;
  }) as Loop;
  Object.defineProperty(loop, 'waterY', { get: () => waterY });
  return loop;
}
