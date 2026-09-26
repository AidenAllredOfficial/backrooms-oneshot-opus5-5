// src/player/traversal/glitch.ts (WP12) — noclip glitch walls, plus the shared "warp" sequence used by pits.
//
// Glitch: while the feet are inside a 'glitch' portal volume, push time accumulates whenever the move input
// points into the edge (dot(inputDir, intoWall) > 0.5) and the collision response removed >= 80% of the motion;
// anything else resets it. At 1.2 s:
//   1. bus 'glitch' {seconds: 0.8, strength: 1} (traversal is the only 'glitch' producer);
//   2. host.findSafeSpawn((s+1)%3, x, z);
//   3. host.prefetch keep-alive until host.isPrefetched, then teleport. The target storey is already prefetched
//      around the player's position from the moment the warp starts (and around every nearby glitch / pit portal
//      at the proximity cadence, see proximityPrefetch), so the wait is normally zero. If it is not, the glitch is
//      re-emitted to hold the screen, but only when the previous one has run out (never overlapping), at most once
//      per HOLD_S: each 'glitch' also restarts WP13's tape-stop, so a hold must not re-trigger faster than it.
// The GLITCH edge itself collides like a WALL (core/edges), so pushing never passes through it.
// intoWall: the portal box is the edge AABB grown by radius + 0.05 on the walkable side, so its short axis is the
// wall normal and the wall lies at the end of that axis farther from the player.

import type { StoreyId } from '../../core/ids.ts';
import type { SpawnPoint } from '../../core/world.ts';
import { down, inPortal, portalCX, portalCZ, type TraversalCtx } from './common.ts';

export const GLITCH_PUSH_S = 1.2;
export const GLITCH_REMOVED = 0.8;
export const GLITCH_DOT = 0.5;
export const WARP_TIMEOUT_S = 20;
/** Duration of a hold re-emit (s): >= WP13's tape-stop cycle (0.4 s stop + 0.6 s silence), so consecutive hold
 * events never restart the tape stop inside its own silence. */
export const HOLD_S = 1.0;

/** Proximity keep-alive: glitch walls and pits warp into (s+1)%3, so prefetch it around every nearby one (the same
 * 1-chunk radius and 0.25 s cadence as the tower policy). */
export function proximityPrefetch(ctx: TraversalCtx): void {
  const s = ctx.state;
  if (s.fly) return;
  for (let i = 0; i < ctx.portalCount; i++) {
    const h = ctx.portals[i];
    if (!h || (h.spec.kind !== 'glitch' && h.spec.kind !== 'pit')) continue;
    ctx.host.prefetch(down(s.s), portalCX(h), portalCZ(h), 1);
  }
}

export interface Warp {
  readonly active: boolean;
  /** 'glitch' events emitted so far (the trigger plus hold re-emits) */
  readonly emitted: number;
  start(ctx: TraversalCtx, kind: 'glitch' | 'pit', target: StoreyId, seconds: number, strength: number): void;
  update(ctx: TraversalCtx, dt: number): void;
  cancel(ctx: TraversalCtx): void;
}

export function createWarp(): Warp {
  let active = false;
  let kind: 'glitch' | 'pit' = 'glitch';
  let target: StoreyId = 0;
  let seconds = 0.8, strength = 1;
  let token = 0;
  let phase: 'find' | 'prefetch' = 'find';
  let spawn: SpawnPoint | null = null;
  let holdT = 0, holdLen = 0, keepT = 0, totalT = 0, retries = 0;
  let emitted = 0;

  const find = (ctx: TraversalCtx, s: StoreyId): void => {
    const my = ++token;
    phase = 'find';
    const st = ctx.state;
    let p: Promise<SpawnPoint | null>;
    try { p = ctx.host.findSafeSpawn(s, st.x, st.z); } catch { p = Promise.resolve(null); }
    p.then((sp) => {
      if (my !== token || !active) return;
      if (sp) { spawn = sp; target = s; phase = 'prefetch'; keepT = 1e9; return; }
      // nothing in the target storey: fall back to the current storey once
      if (retries++ === 0 && s !== ctx.state.s) find(ctx, ctx.state.s);
      else finish(ctx, false);
    }, () => {
      if (my !== token || !active) return;
      if (retries++ === 0 && s !== ctx.state.s) find(ctx, ctx.state.s);
      else finish(ctx, false);
    });
  };

  const finish = (ctx: TraversalCtx, ok: boolean): void => {
    active = false;
    token++;
    ctx.extra.hold = false;
    ctx.extra.yMin = NaN; ctx.extra.yMax = NaN;
    if (!ok) return;
  };

  const w: Warp = {
    get active() { return active; },
    get emitted() { return emitted; },
    start(ctx, k, t, sec, str) {
      if (active) return;
      active = true; kind = k; target = t; seconds = sec; strength = str;
      spawn = null; holdT = 0; holdLen = seconds; keepT = 0; totalT = 0; retries = 0;
      ctx.extra.hold = true;
      emitted++;
      ctx.emit('glitch', { seconds, strength });
      // start streaming the target around the player right away: the safe spawn is searched near (x, z)
      ctx.host.prefetch(t, ctx.state.x, ctx.state.z, 1);
      find(ctx, t);
    },
    update(ctx, dt) {
      if (!active) return;
      totalT += dt;
      if (totalT > WARP_TIMEOUT_S) { finish(ctx, false); return; }
      keepT += dt;
      const ready = phase === 'prefetch' && spawn !== null && ctx.host.isPrefetched(target, spawn.x, spawn.z);
      if (!ready) {
        // hold the screen while we wait: a new glitch only once the previous one has fully run out
        holdT += dt;
        if (holdT >= holdLen) {
          holdT = 0; holdLen = HOLD_S;
          emitted++;
          ctx.emit('glitch', { seconds: HOLD_S, strength });
        }
        if (keepT >= 0.25) {
          keepT = 0;
          if (spawn) ctx.host.prefetch(target, spawn.x, spawn.z, 1);
          else ctx.host.prefetch(target, ctx.state.x, ctx.state.z, 1);
        }
        return;
      }
      if (!spawn) return;
      // teleport
      const s = ctx.state;
      const from = s.s, oldY = s.y;
      if (target !== s.s) ctx.host.switchStorey(target);
      s.s = target;
      s.x = spawn.x; s.y = spawn.y; s.z = spawn.z;
      if (Number.isFinite(spawn.yaw)) s.yaw = spawn.yaw;
      s.pitch = Number.isFinite(spawn.pitch) ? spawn.pitch : 0;
      s.vx = 0; s.vy = 0; s.vz = 0; s.speed = 0; s.onGround = true;
      finish(ctx, true);
      ctx.onTeleported();
      ctx.refreshPortals();
      if (from !== target) ctx.emit('storeyChanged', { from, to: target, dy: s.y - oldY, via: kind });
      ctx.emit('transition', { kind, phase: 'switch', id: 0 });
    },
    cancel(ctx) {
      if (!active) return;
      finish(ctx, false);
    },
  };
  return w;
}

export interface GlitchTraversal {
  afterStep(ctx: TraversalCtx, dt: number, warp: Warp): void;
  reset(): void;
  readonly pushT: number;
  readonly triggers: number;
}

export function createGlitchTraversal(): GlitchTraversal {
  let pushT = 0;
  let triggers = 0;
  return {
    get pushT() { return pushT; },
    get triggers() { return triggers; },
    afterStep(ctx, dt, warp) {
      const s = ctx.state;
      if (warp.active || s.fly) { pushT = 0; return; }
      let hit = -1;
      for (let i = 0; i < ctx.portalCount; i++) {
        const h = ctx.portals[i];
        if (h && h.spec.kind === 'glitch' && inPortal(h, s.x, s.y + 0.05, s.z)) { hit = i; break; }
      }
      if (hit < 0) { pushT = 0; return; }
      const h = ctx.portals[hit];
      // wall normal: the short horizontal axis of the portal box; the wall is at its far end from the player
      const x0 = h.ox + h.spec.min[0], x1 = h.ox + h.spec.max[0], z0 = h.oz + h.spec.min[2], z1 = h.oz + h.spec.max[2];
      let ix = 0, iz = 0;
      if (x1 - x0 <= z1 - z0) ix = s.x - x0 > x1 - s.x ? -1 : 1;
      else iz = s.z - z0 > z1 - s.z ? -1 : 1;
      const e = ctx.extra;
      const dot = e.inX * ix + e.inZ * iz;
      const req2 = e.reqX * e.reqX + e.reqZ * e.reqZ;
      let removed: number;
      if (req2 < 1e-12) removed = dot > 0 ? 1 : 0; // velocity already killed by the wall
      else removed = 1 - Math.max(0, (e.movX * e.reqX + e.movZ * e.reqZ) / req2);
      if (dot > GLITCH_DOT && removed >= GLITCH_REMOVED) pushT += dt; else pushT = 0;
      if (pushT >= GLITCH_PUSH_S) {
        pushT = 0;
        triggers++;
        warp.start(ctx, 'glitch', down(s.s), 0.8, 1);
      }
    },
    reset() { pushT = 0; },
  };
}
