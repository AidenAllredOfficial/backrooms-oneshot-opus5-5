// src/app/autowalk.ts (WP14) — measurement walks for the debug API (§7.2): autowalk (seeded autopilot wander, soak)
// and walk (waypoints). Both install an InputDriver (replaces input.poll) and a frame hook; they end on their own.

import type { AutowalkReport } from '../core/debug.ts';
import type { PlayerInput, PlayerState } from '../core/player.ts';
import type { WorldQuery } from '../core/runtime.ts';
import { DEFAULT_CONTROLLER } from '../player/controller.ts';
import { createAutopilot } from '../player/autopilot.ts';
import type { AppCore, InputDriver } from './appState.ts';

/** Input magnitude / sprint / player time scale that realise a requested ground speed (m/s). */
export function speedToInput(speed: number): { mag: number; sprint: boolean; timeScale: number } {
  const walk = DEFAULT_CONTROLLER.walk;
  const sprint = DEFAULT_CONTROLLER.sprint;
  const v = Number.isFinite(speed) && speed > 0 ? speed : walk;
  if (v <= walk) return { mag: v / walk, sprint: false, timeScale: 1 };
  if (v <= sprint) return { mag: v / sprint, sprint: true, timeScale: 1 };
  // faster than a sprint (soak: 6 m/s): scale the player's dt (120 Hz sub-steps keep the collision exact)
  return { mag: 1, sprint: true, timeScale: v / sprint };
}

const TELEPORT_JUMP = 4; // m in one frame: a teleport / glitch, not walking

function renderCounts(core: AppCore): { geometries: number; textures: number } {
  const info = core.renderer?.info;
  const pooled = core.sys?.streamer.stats().texturesPooled ?? 0;
  return { geometries: info?.memory.geometries ?? 0, textures: (info?.memory.textures ?? 0) - pooled };
}

function countEvents(core: AppCore): { footsteps: () => number; storeys: () => number; dispose: () => void } {
  let footsteps = 0, storeys = 0;
  const a = core.bus.on('footstep', () => { footsteps++; });
  const b = core.bus.on('storeyChanged', () => { storeys++; });
  return { footsteps: () => footsteps, storeys: () => storeys, dispose: () => { a(); b(); } };
}

let activeCancel: ((why: string) => void) | null = null;

function install(core: AppCore, driver: InputDriver, hook: (frameMs: number) => boolean, cancel: (why: string) => void): void {
  activeCancel?.('superseded by a new walk');
  activeCancel = cancel;
  core.driver = driver;
  core.hooks.push(hook);
}

function uninstall(core: AppCore, driver: InputDriver): void {
  if (core.driver === driver) core.driver = null;
  activeCancel = null;
}

// ---------------------------------------------------------------- autowalk

/** A heading walk re-targets the autopilot this far ahead along the heading ... (150 m, was 60: a far target keeps
 * the wanderer on long arteries instead of turning into every side room; a node simulation of the soak walk over
 * the real generator gave a median of ~900 m of ground instead of ~530 m, and 5 % of runs under 400 m instead of 10 %) */
export const HEADING_AHEAD_M = 150;
/** ... every this many seconds of walk time (and whenever the previous target is reached). */
export const HEADING_RETARGET_S = 10;
/** Pocket escape: a heading walk that moved less than HEADING_POCKET_M net in HEADING_POCKET_S of walk time is caught
 * in a local minimum (the heading points into the rim of a sunken pit or a dead-end room, and the ray-based
 * autopilot has no path search), so it drops the target and wanders freely for HEADING_WANDER_S before retargeting. */
export const HEADING_POCKET_S = 20;
export const HEADING_POCKET_M = 8;
export const HEADING_WANDER_S = 20;

export function runAutowalk(core: AppCore, o: { distance: number; speed?: number; seed?: number; heading?: number }): Promise<AutowalkReport> {
  const s = core.sys;
  if (!s) return Promise.reject(new Error('autowalk: the app has not booted yet'));
  const target = Math.max(1, Number.isFinite(o.distance) ? o.distance : 100);
  const speed = o.speed !== undefined && Number.isFinite(o.speed) && o.speed > 0 ? o.speed : null;
  const seed = (o.seed ?? 1) >>> 0;
  const heading = o.heading !== undefined && Number.isFinite(o.heading) ? o.heading : null;
  const hx = heading === null ? 0 : -Math.sin(heading), hz = heading === null ? 0 : -Math.cos(heading);
  const conv = speed === null ? null : speedToInput(speed);
  // the autopilot's decision clock is the walk's own player time (real dt x timeScale), so a time-scaled soak
  // makes its turns at the same places as a real-time walk and does not depend on the wall clock
  let walkT = 0;
  const pilot = createAutopilot(seed, () => walkT);
  const nominal = speed ?? 1.0;
  const limitS = (target / nominal) * 3 + 60;
  const start = renderCounts(core);
  const errors0 = core.errors.length;
  const ev = countEvents(core);
  const st = s.player.state;
  let px = st.x, pz = st.z;
  const x0 = st.x, z0 = st.z;
  let dist = 0, elapsed = 0, maxFrame = 0;
  let headT = HEADING_RETARGET_S; // the first target is set on the first frame
  let pocketT = 0, pocketX = st.x, pocketZ = st.z, wanderT = 0;
  let checkT = 0, checkX = st.x, checkZ = st.z, noProgress = 0, kick = 1;
  let stuck = false;

  const driver: InputDriver = {
    get timeScale() { return conv ? conv.timeScale : 1; },
    drive(ps: PlayerState, w: WorldQuery, out: PlayerInput, realDt: number) {
      walkT += realDt * (conv ? conv.timeScale : 1);
      pilot.next(ps, w, out);
      if (conv) {
        const m = Math.sqrt(out.moveX * out.moveX + out.moveZ * out.moveZ);
        if (m > 1e-3) { out.moveX *= conv.mag / m; out.moveZ *= conv.mag / m; }
        out.sprint = conv.sprint;
      }
      out.crouch = false;
      out.flashlightPressed = false;
      out.interactPressed = false;
    },
  };

  return new Promise<AutowalkReport>((resolve) => {
    const finish = (): void => {
      uninstall(core, driver);
      ev.dispose();
      const end = renderCounts(core);
      resolve({
        distance: dist, seconds: elapsed, footsteps: ev.footsteps(), storeyChanges: ev.storeys(),
        frameMsMax5s: maxFrame, frameMsMax: maxFrame, geometriesStart: start.geometries, geometriesEnd: end.geometries,
        texturesStart: start.textures, texturesEnd: end.textures, errors: core.errors.length - errors0, stuck,
        displacement: Math.hypot(s.player.state.x - x0, s.player.state.z - z0),
      });
    };
    let cancelled = false;
    const hook = (frameMs: number): boolean => {
      if (cancelled) return true;
      const p = s.player.state;
      const dx = p.x - px, dz = p.z - pz;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d < TELEPORT_JUMP) dist += d;
      px = p.x; pz = p.z;
      elapsed += frameMs / 1000;
      if (core.debug.ready && elapsed > 1 && frameMs > maxFrame) maxFrame = frameMs;
      // heading walk: keep a target 60 m ahead along the heading (the autopilot's obstacle scoring finds the way;
      // a blocked heading is detoured by the progress kick below)
      if (heading !== null) {
        const wdt = (frameMs / 1000) * (conv ? conv.timeScale : 1);
        headT += wdt;
        pocketT += wdt;
        if (wanderT > 0) {
          wanderT -= wdt;
          if (wanderT <= 0) headT = HEADING_RETARGET_S; // retarget now
        } else if (pocketT >= HEADING_POCKET_S) {
          if (Math.hypot(p.x - pocketX, p.z - pocketZ) < HEADING_POCKET_M) { wanderT = HEADING_WANDER_S; pilot.clearTarget(); }
          pocketT = 0; pocketX = p.x; pocketZ = p.z;
        }
        if (wanderT <= 0 && headT >= HEADING_RETARGET_S) {
          headT = 0;
          pilot.setTarget(p.x + hx * HEADING_AHEAD_M, p.z + hz * HEADING_AHEAD_M);
        }
      }
      // progress check every 5 s: < 1 m moved -> nudge the autopilot; 30 s without progress -> stuck
      checkT += frameMs / 1000;
      if (checkT >= 5) {
        const m = Math.hypot(p.x - checkX, p.z - checkZ);
        checkT = 0; checkX = p.x; checkZ = p.z;
        if (m < 1 && core.debug.ready) {
          noProgress += 5;
          const a = kick * 2.39996;
          kick++;
          pilot.setTarget(p.x + Math.cos(a) * 30, p.z + Math.sin(a) * 30);
        } else if (m >= 1) {
          noProgress = 0;
        }
        if (noProgress >= 30) stuck = true;
      }
      if (dist >= target || stuck || elapsed >= limitS) {
        if (elapsed >= limitS && dist < target) stuck = true;
        finish();
        return true;
      }
      return false;
    };
    install(core, driver, hook, () => { cancelled = true; stuck = true; finish(); });
  });
}

// ---------------------------------------------------------------- walk(path)

export function runWalk(core: AppCore, path: { x: number; z: number }[], speed?: number): Promise<{ footsteps: number; ms: number }> {
  const s = core.sys;
  if (!s) return Promise.reject(new Error('walk: the app has not booted yet'));
  const pts = (Array.isArray(path) ? path : []).filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.z));
  const conv = speedToInput(speed ?? DEFAULT_CONTROLLER.walk);
  const ev = countEvents(core);
  let i = 0, ms = 0, best = Infinity, sinceBest = 0, total = 0;
  {
    let x = s.player.state.x, z = s.player.state.z;
    for (const p of pts) { total += Math.hypot(p.x - x, p.z - z); x = p.x; z = p.z; }
  }
  const limitMs = ((total / Math.max(0.3, speed ?? DEFAULT_CONTROLLER.walk)) * 3 + 20) * 1000;

  const driver: InputDriver = {
    get timeScale() { return conv.timeScale; },
    drive(ps: PlayerState, _w: WorldQuery, out: PlayerInput) {
      out.moveX = 0; out.moveZ = 0; out.lookDX = 0; out.lookDY = 0;
      out.sprint = false; out.crouch = false; out.flashlightPressed = false; out.interactPressed = false;
      const p = pts[i];
      if (!p) return;
      const dx = p.x - ps.x, dz = p.z - ps.z;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d < 1e-4) return;
      ps.yaw = Math.atan2(-dx, -dz); // forward = (-sin yaw, -cos yaw)
      // slow down on the last waypoint so we stop on it
      const m = i === pts.length - 1 ? Math.min(conv.mag, Math.max(0.25, d / 0.8)) : conv.mag;
      out.moveZ = m;
      out.sprint = conv.sprint;
    },
  };

  return new Promise((resolve) => {
    const finish = (): void => {
      uninstall(core, driver);
      ev.dispose();
      resolve({ footsteps: ev.footsteps(), ms });
    };
    let cancelled = false;
    const hook = (frameMs: number): boolean => {
      if (cancelled) return true;
      ms += frameMs;
      const p = pts[i];
      if (p) {
        const st = s.player.state;
        const d = Math.hypot(p.x - st.x, p.z - st.z);
        if (d < best - 0.1) { best = d; sinceBest = 0; } else sinceBest += frameMs;
        if (d < 0.3 || sinceBest > 4000) { // reached, or no progress for 4 s: next waypoint
          i++;
          best = Infinity;
          sinceBest = 0;
        }
      }
      if (i >= pts.length || ms > limitMs) { finish(); return true; }
      return false;
    };
    install(core, driver, hook, () => { cancelled = true; finish(); });
  });
}
