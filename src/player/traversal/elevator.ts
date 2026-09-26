// src/player/traversal/elevator.ts (WP12) — the elevator ride (closed-box teleport between storeys).
//
//  1. Entering the lobby strip (or the cab): host.prefetch(target, x, z, 1), target = (s+1)%3, or (s+2)%3 for a
//     WRONG_ELEVATOR (portal.wrong); repeated at the proximity cadence as keep-alive.
//  2. Standing in the cab for 2 s: transition 'doorsClosing'; the doors close over 1.5 s (leaving the cab while
//     they close reopens them).
//  3. transition 'ride' for 6 s with +-0.2 deg camera shake (WP13 plays motor, cable rumble, ding from the phases).
//  4. At 3 s, once host.isPrefetched(target) (the ride extends until it is): host.switchStorey(target); the player
//     keeps the same xz (the cab is identical in every storey); storeyChanged {via: 'elevator'}.
//  5. transition 'doorsOpening'; the doors open. The ride re-arms once the player has left the cab.
// Door leaves: traversal/doors.ts (dynamic meshes + virtual collision boxes). The nearest elevator within TRACK_R
// runs the state machine above; every other elevator within DECOR_R (scanned every DECOR_TICKS proximity ticks)
// shows its leaves parked open (so an open cab seen from afar is not missing its doors) and keeps their collision.
// Hand-over between the two sets happens inside one proximity tick (no frame without leaves).

import { ELEVATOR } from '../../core/constants.ts';
import type { StoreyId } from '../../core/ids.ts';
import type { PortalHit } from '../../core/runtime.ts';
import { down, up, type TraversalCtx } from './common.ts';
import { createElevatorDoors, DOOR_TIME, elevatorFrame, portalOnlyFrame, type DoorFrame, type ElevatorDoors } from './doors.ts';

export const DWELL_S = 2; // standing in the cab before the doors close
export const RIDE_S = ELEVATOR.RIDE_S; // 6
export const SWITCH_AT_S = ELEVATOR.RIDE_S / 2; // 3
export const CAB_INSET = 0.3; // the centre must be this far inside the cab AABB to count as "in the cab"
export const TRACK_R = 14; // m: the ride state machine follows the nearest elevator this close
export const DECOR_R = 40; // m: other elevators this close show their (open) door leaves
export const DECOR_MAX = 4; // at most this many parked door pairs
export const DECOR_TICKS = 4; // proximity ticks between wide scans (1 s)

export type ElevatorPhase = 'open' | 'closing' | 'ride' | 'opening' | 'done';

export interface ElevatorTraversal {
  readonly phase: ElevatorPhase;
  readonly doors: ElevatorDoors;
  readonly rides: number;
  /** elevators currently showing parked (open) leaves */
  readonly parked: number;
  /** append the virtual boxes of every door leaf (tracked + parked) near (x, z, r); returns the new count */
  appendBoxes(x: number, z: number, r: number, out: Float32Array, n: number): number;
  proximity(ctx: TraversalCtx): void;
  update(ctx: TraversalCtx, dt: number): void;
  reset(ctx: TraversalCtx): void;
}

interface Parked { x: number; z: number; doors: ElevatorDoors; seen: boolean }

const smooth01 = (t: number): number => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
const inRect = (r: readonly number[], x: number, z: number, inset: number): boolean =>
  x >= r[0] + inset && x <= r[2] - inset && z >= r[1] + inset && z <= r[3] - inset;

export function createElevatorTraversal(): ElevatorTraversal {
  const doors = createElevatorDoors();
  let frame: DoorFrame | null = null;
  let wrong = false;
  let phase: ElevatorPhase = 'open';
  let dwell = 0, t = 0, rideT = 0, switchT = -1;
  let target: StoreyId = 0;
  let inCabPrev = false;
  let rides = 0;
  let keepT = 0;
  let trackedX = NaN, trackedZ = NaN; // world min corner of the tracked portal
  // parked (open, idle) door pairs of the other elevators within DECOR_R
  const wide: PortalHit[] = [];
  let wideN = 0;
  let wideTick = DECOR_TICKS; // scan on the first proximity tick
  let wideStorey = -1;
  const parked: Parked[] = [];

  const dropParked = (i: number): void => {
    parked[i].doors.dispose();
    parked[i] = parked[parked.length - 1];
    parked.pop();
  };
  const clearParked = (): void => { while (parked.length > 0) dropParked(parked.length - 1); wideN = 0; wideTick = DECOR_TICKS; };
  const isTracked = (px: number, pz: number): boolean =>
    frame !== null && Math.abs(px - trackedX) < 1e-3 && Math.abs(pz - trackedZ) < 1e-3;

  const syncParked = (ctx: TraversalCtx): void => {
    const s = ctx.state;
    if (s.s !== wideStorey) { clearParked(); wideStorey = s.s; }
    if (++wideTick >= DECOR_TICKS) {
      wideTick = 0;
      let n = 0;
      try { n = ctx.world.portalsNear(s.x, s.z, DECOR_R, wide); } catch { n = 0; }
      wideN = Math.max(0, Math.min(n, wide.length));
    }
    for (let i = 0; i < parked.length; i++) parked[i].seen = false;
    for (let i = 0; i < wideN; i++) {
      const h = wide[i];
      if (!h || h.spec.kind !== 'elevator') continue;
      const px = h.ox + h.spec.min[0], pz = h.oz + h.spec.min[2];
      if (isTracked(px, pz)) continue; // the tracked elevator owns its leaves
      let e: Parked | null = null;
      for (let k = 0; k < parked.length; k++) {
        if (Math.abs(parked[k].x - px) < 1e-3 && Math.abs(parked[k].z - pz) < 1e-3) { e = parked[k]; break; }
      }
      if (!e) {
        if (parked.length >= DECOR_MAX) continue;
        const f = elevatorFrame(ctx.raw, h);
        if (!f || !f.hasLeaves) continue; // layout not readable yet: retried next tick
        const d = createElevatorDoors();
        d.setFrame(f, s.s);
        e = { x: px, z: pz, doors: d, seen: false };
        parked.push(e);
      }
      e.seen = true;
    }
    for (let i = parked.length - 1; i >= 0; i--) if (!parked[i].seen) dropParked(i);
    for (let i = 0; i < parked.length; i++) parked[i].doors.tick(ctx.host, s.s);
  };

  const emitT = (ctx: TraversalCtx, p: 'enter' | 'doorsClosing' | 'ride' | 'switch' | 'doorsOpening' | 'exit'): void => {
    ctx.emit('transition', { kind: 'elevator', phase: p, id: frame ? frame.id : 0 });
  };
  const targetOf = (s: StoreyId): StoreyId => (wrong ? up(s) : down(s));

  const track = (ctx: TraversalCtx, h: PortalHit | null): void => {
    if (!h) {
      if (frame && phase !== 'ride' && phase !== 'closing') { frame = null; doors.setFrame(null, ctx.state.s); phase = 'open'; }
      return;
    }
    wrong = h.spec.wrong === true;
    // same portal as the tracked one (and its door side is known): nothing to rebuild (no per-tick allocation)
    const px = h.ox + h.spec.min[0], pz = h.oz + h.spec.min[2];
    const samePortal = frame !== null && Math.abs(px - trackedX) < 1e-3 && Math.abs(pz - trackedZ) < 1e-3;
    if (samePortal && frame!.hasLeaves) return;
    trackedX = px; trackedZ = pz;
    const f = elevatorFrame(ctx.raw, h) ?? portalOnlyFrame(h);
    if (samePortal) {
      // the layout became available: upgrade the portal-only frame in place (the phase and door openness stay)
      if (f.hasLeaves) { frame = f; doors.setFrame(f, ctx.state.s); }
      return;
    }
    const same = frame && Math.abs(frame.cx - f.cx) < 1e-3 && Math.abs(frame.cz - f.cz) < 1e-3;
    if (!same) {
      frame = f;
      phase = 'open'; dwell = 0;
      doors.setFrame(f, ctx.state.s);
      doors.setOpen(1);
    }
  };

  return {
    get phase() { return phase; },
    get doors() { return doors; },
    get rides() { return rides; },
    get parked() { return parked.length; },

    appendBoxes(x, z, r, out, n) {
      n = doors.appendBoxes(x, z, r, out, n);
      for (let i = 0; i < parked.length; i++) n = parked[i].doors.appendBoxes(x, z, r, out, n);
      return n;
    },

    proximity(ctx) {
      const s = ctx.state;
      // nearest elevator portal within the proximity radius
      let best: PortalHit | null = null, bd = Infinity;
      for (let i = 0; i < ctx.portalCount; i++) {
        const h = ctx.portals[i];
        if (!h || h.spec.kind !== 'elevator') continue;
        const cx = h.ox + (h.spec.min[0] + h.spec.max[0]) / 2, cz = h.oz + (h.spec.min[2] + h.spec.max[2]) / 2;
        const d = Math.hypot(cx - s.x, cz - s.z);
        if (d < bd && d < TRACK_R) { bd = d; best = h; }
      }
      // during a ride the portal list may briefly be empty (storey swap): keep the current frame
      if (best || (phase !== 'ride' && phase !== 'closing')) track(ctx, best);
      if (frame) doors.tick(ctx.host, s.s);
      // during a ride the storey is about to change: the parked set is rebuilt afterwards
      if (phase !== 'ride') syncParked(ctx);
    },

    update(ctx, dt) {
      const s = ctx.state;
      ctx.shake = 0;
      if (!frame) return;
      const inCab = inRect(frame.cab, s.x, s.z, CAB_INSET) && s.y > frame.floorY - 0.5 && s.y < frame.floorY + 1.5;
      const inLobby = inRect(frame.lobby, s.x, s.z, -0.2);
      if (inCab !== inCabPrev && phase !== 'ride') emitT(ctx, inCab ? 'enter' : 'exit');
      inCabPrev = inCab;
      // prefetch keep-alive (entering the lobby strip or already inside)
      keepT += dt;
      if ((inLobby || inCab) && (phase === 'open' || phase === 'closing' || phase === 'ride') && keepT >= 0.25) {
        keepT = 0;
        ctx.host.prefetch(targetOf(s.s), frame.cx, frame.cz, 1);
      }
      switch (phase) {
        case 'open':
          doors.setOpen(1);
          if (inCab && !s.fly) {
            dwell += dt;
            if (dwell >= DWELL_S) {
              phase = 'closing'; t = 0; target = targetOf(s.s);
              ctx.host.prefetch(target, frame.cx, frame.cz, 1);
              emitT(ctx, 'doorsClosing');
            }
          } else dwell = 0;
          break;
        case 'closing':
          t += dt;
          if (!inCab) {
            // the player stepped out: reopen from where the doors are
            phase = 'opening'; t = DOOR_TIME - Math.min(t, DOOR_TIME); switchT = -2; // smoothstep symmetry: same openness
            emitT(ctx, 'doorsOpening');
            break;
          }
          doors.setOpen(1 - smooth01(t / DOOR_TIME));
          if (t >= DOOR_TIME) {
            doors.setOpen(0);
            phase = 'ride'; rideT = 0; switchT = -1;
            emitT(ctx, 'ride');
          }
          break;
        case 'ride':
          rideT += dt;
          ctx.shake = Math.min(1, rideT / 0.6, Math.max(0, (Math.max(RIDE_S, switchT + 1) - rideT) / 0.6));
          if (switchT < 0 && rideT >= SWITCH_AT_S && ctx.host.isPrefetched(target, s.x, s.z)) {
            const from = s.s;
            ctx.host.switchStorey(target);
            s.s = target;
            switchT = rideT;
            rides++;
            doors.rebuild(target);
            doors.tick(ctx.host, target);
            doors.setOpen(0);
            ctx.refreshPortals();
            ctx.emit('storeyChanged', { from, to: target, dy: 0, via: 'elevator' });
            emitT(ctx, 'switch');
          }
          if (switchT >= 0 && rideT >= Math.max(RIDE_S, switchT + 1)) {
            phase = 'opening'; t = 0;
            emitT(ctx, 'doorsOpening');
          }
          break;
        case 'opening':
          t += dt;
          doors.setOpen(smooth01(t / DOOR_TIME));
          if (t >= DOOR_TIME) {
            doors.setOpen(1);
            phase = switchT === -2 ? 'open' : 'done';
            dwell = 0;
          }
          break;
        case 'done':
          doors.setOpen(1);
          if (!inCab) { phase = 'open'; dwell = 0; }
          break;
      }
    },

    reset(ctx) {
      doors.dispose();
      clearParked();
      frame = null; phase = 'open'; dwell = 0; t = 0; rideT = 0; switchT = -1; inCabPrev = false;
      ctx.shake = 0;
    },
  };
}
