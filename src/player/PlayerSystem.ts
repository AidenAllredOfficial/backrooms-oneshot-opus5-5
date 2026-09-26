// src/player/PlayerSystem.ts (WP12) — owns PlayerState; 120 Hz controller sub-steps, traversal, camera rig.
//
// Frame (called at §6.2 step 2):
//   * look is applied once per frame (lowest latency, never interpolated);
//   * the controller runs fixed 1/120 s sub-steps; after each one the tower / glitch / pit rules run;
//   * every 0.25 s world.portalsNear(x, z, 12) refreshes the nearby portals (prefetch policy for towers, glitch
//     walls and pits, elevator tracking);
//   * elevator + warp state machines, interact targeting;
//   * the camera rig interpolates the last two sub-steps (alpha = accumulator / step) and writes eyeX..camRoll.
// Frozen simulation time (time= / freeze=): movement still runs on real time (QA walks), but bob, breathing and
// the handheld sway are frozen so captures are deterministic.
// R2 (B7): setUserPace(true) (the app, while the player is in control) walks at settings.walkSpeed; otherwise
// (attract walk, autowalk, automation) the default pace keeps autopilot / autowalk speeds exact.

import type { PerspectiveCamera } from 'three';
import { PLAYER } from '../core/constants.ts';
import type { Emit, GameBus } from '../core/events.ts';
import type { StoreyId } from '../core/ids.ts';
import type { MeshBuffers } from '../core/mesh.ts';
import { createPlayerState, type PlayerInput } from '../core/player.ts';
import type { CollisionWorld, DynamicMeshHandle, PlayerSystem, PortalHit } from '../core/runtime.ts';
import type { Settings } from '../core/settings.ts';
import type { SpawnPoint } from '../core/world.ts';
import { createCameraRig } from './cameraRig.ts';
import { penetrationAt } from './collision.ts';
import {
  applyLook, bodyHeight, controllerExtra, DEFAULT_CONTROLLER, resetController, stepPlayer, unstuckNow, WALK_SPEEDS,
  type ControllerConfig, type PlayerInputExt,
} from './controller.ts';
import { updateInputSettings } from './input.ts';
import { updateInteract } from './interact.ts';
import { PROXIMITY_R, PROXIMITY_S, type TraversalCtx } from './traversal/common.ts';
import { createElevatorTraversal } from './traversal/elevator.ts';
import { createGlitchTraversal, createWarp, proximityPrefetch } from './traversal/glitch.ts';
import { createPitTraversal } from './traversal/pit.ts';
import { createTowerTraversal } from './traversal/tower.ts';

export interface TraversalHost {
  prefetch(s: StoreyId, x: number, z: number, radiusChunks: number): void;
  isPrefetched(s: StoreyId, x: number, z: number): boolean; // -> WorldStreamer.isPrefetched
  switchStorey(to: StoreyId): void;
  findSafeSpawn(s: StoreyId, x: number, z: number): Promise<SpawnPoint | null>; // -> streamer.findNearest('safe', {s,x,z}, 4)
  attachDynamicMesh(tileKey: string, m: MeshBuffers): DynamicMeshHandle | null; // -> WorldStreamer.attachDynamicMesh
}

export const STEP = 1 / 120;
export const MAX_STEPS = 30; // per frame (0.25 s; WP14 may scale dt for fast autowalks)
export const SNAP_PROBE = 1.5; // teleport without y: highest walkable surface <= 1.5 + stepMax

/** Extra members of the object returned by createPlayerSystem (not part of the core PlayerSystem contract). */
export interface PlayerSystemExt extends PlayerSystem {
  /** true while a human drives the player: walk at settings.walkSpeed instead of the default pace */
  setUserPace(on: boolean): void;
  /** the walk speed in effect (m/s) */
  readonly walkSpeed: number;
}

/** Test / debug view of the internals (not part of the core PlayerSystem contract). */
export interface PlayerSystemDebug {
  readonly steps: number;
  readonly towerSwitches: number;
  readonly towerClamp: number;
  readonly glitchPush: number;
  readonly elevatorPhase: string;
  readonly warping: boolean;
  readonly unstuckCount: number;
}

export function createPlayerSystem(spawn: SpawnPoint, settings: Settings, bus: GameBus, host: TraversalHost): PlayerSystem {
  const state = createPlayerState(spawn.s, spawn.x, Number.isFinite(spawn.y) ? spawn.y : 0, spawn.z, spawn.yaw, spawn.pitch);
  const extra = controllerExtra(state);
  let cur = settings;
  let curBus = bus;
  let pendingSnap = !Number.isFinite(spawn.y);
  let spawnCheck = true;
  bus.on('settingsChanged', (s) => { cur = s; updateInputSettings(s); });
  const emit: Emit = (k, e) => curBus.emit(k, e);

  // ---------------------------------------------------------------- collision world with the door leaves' virtual boxes
  let inner: CollisionWorld | null = null;
  const elevator = createElevatorTraversal();
  const world: CollisionWorld = {
    get storey() { return inner ? inner.storey : state.s; },
    isLoaded: (x, z) => inner!.isLoaded(x, z),
    floorAt: (x, z, y) => inner!.floorAt(x, z, y),
    ceilingAt: (x, z, y) => inner!.ceilingAt(x, z, y),
    waterAt: (x, z) => inner!.waterAt(x, z),
    surfaceAt: (x, z, y) => inner!.surfaceAt(x, z, y),
    boxesNear: (x, z, r, out) => elevator.appendBoxes(x, z, r, out, inner!.boxesNear(x, z, r, out)),
    portalAt: (x, y, z) => inner!.portalAt(x, y, z),
    portalsNear: (x, z, r, out) => inner!.portalsNear(x, z, r, out),
    propAt: (x, z, yaw, d) => inner!.propAt(x, z, yaw, d),
  };

  // ---------------------------------------------------------------- traversal
  const portals: PortalHit[] = [];
  let portalsDirty = true;
  let proxT = 0;
  const rig = createCameraRig(state);
  // interpolation (previous sub-step)
  let pX = state.x, pY = state.y, pZ = state.z, pPh = 0;
  const view = createPlayerState(state.s, state.x, state.y, state.z, state.yaw, state.pitch);
  const snapInterp = (): void => { pX = state.x; pY = state.y; pZ = state.z; pPh = state.stridePhase; };
  const sub: PlayerInputExt = {
    moveX: 0, moveZ: 0, lookDX: 0, lookDY: 0, sprint: false, crouch: false, flashlightPressed: false, interactPressed: false, up: false,
  };
  const ctx: TraversalCtx = {
    state, extra, host, emit, world, raw: world, input: sub as PlayerInput, portals, portalCount: 0, shake: 0,
    refreshPortals() { portalsDirty = true; },
    onShift(dy) { pY += dy; rig.shiftY(dy); },
    onTeleported() {
      // a spawn point without a usable height snaps to the floor once its chunk answers (like teleport(y = null))
      if (!Number.isFinite(state.y)) { state.y = 0; pendingSnap = true; }
      snapInterp(); rig.snap(state); spawnCheck = true;
    },
  };
  const tower = createTowerTraversal();
  const glitch = createGlitchTraversal();
  const pit = createPitTraversal();
  const warp = createWarp();

  let acc = 0;
  let steps = 0;
  let simT = 0;
  let lastNow = -1;

  const refreshPortals = (w: CollisionWorld): void => {
    portalsDirty = false;
    let n = 0;
    try { n = w.portalsNear(state.x, state.z, PROXIMITY_R, portals); } catch { n = 0; }
    ctx.portalCount = Math.max(0, Math.min(n, portals.length));
  };

  const syncRigNow = (): void => {
    view.x = state.x; view.y = state.y; view.z = state.z; view.stridePhase = state.stridePhase;
    copyView();
    rig.update(view, state, 0, simT, { headBob: cur.headBob, camcorder: cur.film.camcorder, shake: 0, frozen: true });
  };
  const copyView = (): void => {
    view.s = state.s; view.yaw = state.yaw; view.pitch = state.pitch; view.crouch = state.crouch; view.onGround = state.onGround;
    view.vx = state.vx; view.vy = state.vy; view.vz = state.vz; view.speed = state.speed; view.fatigue = state.fatigue;
    view.surface = state.surface; view.waterDepth = state.waterDepth; view.fly = state.fly;
  };
  rig.snap(state);
  syncRigNow();

  let userPace = false;
  const userCfg: ControllerConfig = { ...DEFAULT_CONTROLLER };
  const controllerCfg = (): ControllerConfig => {
    if (!userPace) return DEFAULT_CONTROLLER;
    userCfg.walk = WALK_SPEEDS[cur.walkSpeed] ?? DEFAULT_CONTROLLER.walk;
    return userCfg;
  };

  const sys: PlayerSystemExt & { readonly debug: PlayerSystemDebug } = {
    state,
    setUserPace(on: boolean): void { userPace = on; },
    get walkSpeed() { return controllerCfg().walk; },
    debug: {
      get steps() { return steps; },
      get towerSwitches() { return tower.switches; },
      get towerClamp() { return tower.clamped; },
      get glitchPush() { return glitch.pushT; },
      get elevatorPhase() { return elevator.phase; },
      get warping() { return warp.active; },
      get unstuckCount() { return extra.unstuckCount; },
    },

    update(dt: number, input: PlayerInput, w: CollisionWorld, b: GameBus, frozenTime: boolean): void {
      curBus = b;
      inner = w;
      ctx.raw = w;
      ctx.input = input;
      // frozen simulation clock: keep walking on real time (QA walks), freeze the cosmetic motion. The app passes
      // real dt while frozen; a caller passing the frozen simulation dt (0) falls back to the wall clock.
      let fdt = dt;
      const now = typeof performance !== 'undefined' ? performance.now() : 0;
      if (frozenTime && !(dt > 0)) fdt = lastNow >= 0 ? Math.min(Math.max(0, (now - lastNow) / 1000), 0.1) : 0;
      lastNow = now;
      if (!(fdt >= 0)) fdt = 0;
      fdt = Math.min(fdt, MAX_STEPS * STEP);
      if (!frozenTime) simT += fdt;

      // teleport without y / first load: snap to the floor once the chunk is there; spawn-in-wall rescue
      if (pendingSnap) {
        const f = w.floorAt(state.x, state.z, SNAP_PROBE);
        if (f === f) {
          // no walkable surface within reach of the probe (a SOLID cell reports a surface far above, a bare VOID
          // cell -Infinity): stand at the storey datum and let the spawn check move the player to a free cell
          state.y = Number.isFinite(f) && f <= SNAP_PROBE + PLAYER.stepMax + 0.01 ? f : 0;
          state.vy = 0; state.onGround = true; pendingSnap = false;
          snapInterp(); rig.snap(state);
        }
      }
      if (!pendingSnap && spawnCheck && !state.fly && w.isLoaded(state.x, state.z)) {
        const f = w.floorAt(state.x, state.z, state.y);
        if (f === f) {
          spawnCheck = false;
          if (penetrationAt(world, state.x, state.z, state.y, bodyHeight(state), extra.scratch) > 0.01 && unstuckNow(state, world)) {
            snapInterp(); rig.snap(state);
          }
        }
      }

      // look once per frame
      applyLook(state, input, cur.mouseSensitivity, cur.invertY);
      sub.moveX = input.moveX; sub.moveZ = input.moveZ; sub.sprint = input.sprint; sub.crouch = input.crouch;
      sub.up = (input as PlayerInputExt).up === true;

      if (portalsDirty) refreshPortals(w);

      // fixed sub-steps
      const cfg = controllerCfg();
      acc += fdt;
      let n = 0;
      while (acc >= STEP && n < MAX_STEPS) {
        pX = state.x; pY = state.y; pZ = state.z; pPh = state.stridePhase;
        stepPlayer(state, sub, STEP, world, cfg, emit, cur.mouseSensitivity, cur.invertY);
        if (extra.landImpact > 0) { rig.landing(extra.landImpact); extra.landImpact = 0; }
        if (!state.fly && !pendingSnap) {
          tower.afterStep(ctx);
          if (portalsDirty) refreshPortals(w);
          glitch.afterStep(ctx, STEP, warp);
          pit.afterStep(ctx, warp);
        }
        acc -= STEP;
        n++;
        steps++;
      }
      if (n >= MAX_STEPS) acc = Math.min(acc, STEP);

      // proximity (prefetch policy + elevator tracking)
      proxT += fdt;
      if (proxT >= PROXIMITY_S || portalsDirty) {
        proxT = 0;
        refreshPortals(w);
        tower.proximity(ctx);
        proximityPrefetch(ctx);
        elevator.proximity(ctx);
      }
      elevator.update(ctx, fdt);
      warp.update(ctx, fdt);

      // interactables
      updateInteract(state, w, input.interactPressed, emit);

      // camera rig (interpolated)
      const a = Math.min(1, acc / STEP);
      view.x = pX + (state.x - pX) * a;
      view.y = pY + (state.y - pY) * a;
      view.z = pZ + (state.z - pZ) * a;
      view.stridePhase = pPh + (state.stridePhase - pPh) * a;
      copyView();
      rig.update(view, state, fdt, simT, {
        headBob: cur.headBob, camcorder: cur.film.camcorder, cameraShake: cur.cameraShake, shake: ctx.shake, frozen: frozenTime,
      });
    },

    teleport(s: StoreyId, x: number, y: number | null, z: number, yaw: number, pitch: number): void {
      if (s !== state.s) host.switchStorey(s);
      warp.cancel(ctx);
      tower.reset(ctx);
      elevator.reset(ctx);
      glitch.reset();
      state.s = s; state.x = x; state.z = z;
      state.yaw = yaw; state.pitch = Math.max(-1.5, Math.min(1.5, pitch));
      state.vx = 0; state.vy = 0; state.vz = 0; state.speed = 0; state.onGround = true; state.stillFor = 0;
      resetController(state);
      if (y === null || !Number.isFinite(y)) { pendingSnap = true; } else { state.y = y; pendingSnap = false; }
      spawnCheck = true;
      acc = 0;
      portalsDirty = true;
      snapInterp();
      rig.snap(state);
      syncRigNow();
    },

    applyToCamera(camera: PerspectiveCamera, fovDeg: number): void {
      camera.position.set(state.eyeX, state.eyeY, state.eyeZ);
      camera.rotation.set(state.camPitch, state.camYaw, state.camRoll, 'YXZ');
      const fov = fovDeg + rig.fovKick;
      if (Math.abs(camera.fov - fov) > 1e-3) { camera.fov = fov; camera.updateProjectionMatrix(); }
    },

    setFly(on: boolean): void {
      if (state.fly === on) return;
      state.fly = on;
      state.vy = 0;
      if (on) { extra.yMin = NaN; extra.yMax = NaN; state.onGround = false; }
      else { state.onGround = false; spawnCheck = true; }
    },
  };
  return sys;
}
