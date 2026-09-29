// src/player/traversal/tower.ts (WP12) — invisible storey switches in the periodic stair towers (§2.4, §5 WP12).
//
// * After every controller sub-step: if the feet are inside a tower footprint (and its y-range), the switch rule
//   applies: feetY < -1.6 => storey (s+1)%3, y += 3; feetY > +1.6 => (s+2)%3, y -= 3. After a switch the feet are
//   at -+1.4, 0.2 m inside the threshold of the opposite direction: hysteresis, no thrashing.
// * ENDLESS_STAIRS towers shift y but never the storey.
// * A late destination stops motion on the flight at -+1.59, with feet still on its slope. Turning back stays free.
// * Both adjacent storeys prefetch on approach, before the player commits to either flight.
// * Events: transition {tower, enter|switch|exit}, storeyChanged {via: 'tower'}.

import { TOWER_SWITCH_Y } from '../../core/constants.ts';
import type { StoreyId } from '../../core/ids.ts';
import type { PortalHit } from '../../core/runtime.ts';
import { down, inPortal, portalCX, portalCZ, up, type TraversalCtx } from './common.ts';

export const CLAMP_Y = TOWER_SWITCH_Y - 0.01; // 1.59

interface TowerBox { x0: number; x1: number; z0: number; z1: number; y0: number; y1: number; id: number; endless: boolean }

export interface TowerTraversal {
  /** proximity tick: prefetch keep-alive */
  proximity(ctx: TraversalCtx): void;
  /** after every controller sub-step */
  afterStep(ctx: TraversalCtx, px: number, py: number, pz: number): void;
  reset(ctx: TraversalCtx): void;
  readonly inside: boolean;
  readonly clamped: number; // -1 clamped low, +1 clamped high, 0 free
  readonly switches: number;
}

export function createTowerTraversal(): TowerTraversal {
  const cur: TowerBox = { x0: 0, x1: 0, z0: 0, z1: 0, y0: 0, y1: 0, id: 0, endless: false };
  let inside = false;
  let clampDir = 0;
  let switches = 0;

  const set = (h: PortalHit): void => {
    cur.x0 = h.ox + h.spec.min[0]; cur.x1 = h.ox + h.spec.max[0];
    cur.z0 = h.oz + h.spec.min[2]; cur.z1 = h.oz + h.spec.max[2];
    cur.y0 = h.spec.min[1]; cur.y1 = h.spec.max[1];
    cur.id = h.spec.towerId; cur.endless = h.spec.endless;
  };
  const within = (x: number, y: number, z: number): boolean =>
    x >= cur.x0 && x <= cur.x1 && z >= cur.z0 && z <= cur.z1 && y >= cur.y0 - 0.5 && y <= cur.y1 + 0.5;

  const release = (ctx: TraversalCtx): void => {
    if (clampDir !== 0) { ctx.extra.yMin = NaN; ctx.extra.yMax = NaN; clampDir = 0; }
  };

  const doSwitch = (ctx: TraversalCtx, dy: number, target: StoreyId): void => {
    const s = ctx.state;
    const from = s.s;
    release(ctx);
    if (!cur.endless) {
      ctx.host.switchStorey(target);
      s.s = target;
    }
    s.y += dy;
    ctx.onShift(dy);
    switches++;
    if (!cur.endless) ctx.emit('storeyChanged', { from, to: target, dy, via: 'tower' });
    ctx.emit('transition', { kind: 'tower', phase: 'switch', id: cur.id });
    ctx.refreshPortals();
  };

  const t: TowerTraversal = {
    get inside() { return inside; },
    get clamped() { return clampDir; },
    get switches() { return switches; },

    proximity(ctx) {
      const s = ctx.state;
      if (s.fly) return;
      for (let i = 0; i < ctx.portalCount; i++) {
        const h = ctx.portals[i];
        if (!h || h.spec.kind !== 'tower' || h.spec.endless) continue;
        const cx = portalCX(h), cz = portalCZ(h);
        ctx.host.prefetch(down(s.s), cx, cz, 1);
        ctx.host.prefetch(up(s.s), cx, cz, 1);
      }
    },

    afterStep(ctx, px, py, pz) {
      const s = ctx.state;
      if (s.fly) { release(ctx); if (inside) { inside = false; ctx.emit('transition', { kind: 'tower', phase: 'exit', id: cur.id }); } return; }
      // which tower are we in?
      let now = inside && within(s.x, s.y, s.z);
      if (!now) {
        for (let i = 0; i < ctx.portalCount; i++) {
          const h = ctx.portals[i];
          if (!h || h.spec.kind !== 'tower') continue;
          if (inPortal(h, s.x, s.y, s.z)) {
            if (inside) ctx.emit('transition', { kind: 'tower', phase: 'exit', id: cur.id });
            set(h);
            now = true;
            ctx.emit('transition', { kind: 'tower', phase: 'enter', id: cur.id });
            break;
          }
        }
      }
      if (!now) {
        release(ctx);
        if (inside) ctx.emit('transition', { kind: 'tower', phase: 'exit', id: cur.id });
        inside = false;
        return;
      }
      inside = true;
      const lo = -TOWER_SWITCH_Y, hi = TOWER_SWITCH_Y;
      const tDown = cur.endless ? s.s : down(s.s);
      const tUp = cur.endless ? s.s : up(s.s);

      const stopOnFlight = (dir: number): void => {
        const y = dir * CLAMP_Y;
        const fraction = Math.max(0, Math.min(1, (y - py) / (s.y - py || 1)));
        s.x = px + (s.x - px) * fraction; s.z = pz + (s.z - pz) * fraction;
        s.y = y; s.vx = s.vy = s.vz = 0; s.speed = 0; s.onGround = true;
        clampDir = dir;
      };
      if (clampDir !== 0) {
        const dir = clampDir, target = dir < 0 ? tDown : tUp;
        if (dir * s.y < CLAMP_Y - 1e-6 || cur.endless || ctx.host.isPrefetched(target, s.x, s.z)) release(ctx);
        else { if (dir * s.y > CLAMP_Y) stopOnFlight(dir); return; }
      }
      if (s.y < lo) {
        if (cur.endless || ctx.host.isPrefetched(tDown, s.x, s.z)) doSwitch(ctx, 3, tDown);
        else {
          stopOnFlight(-1);
        }
      } else if (s.y > hi) {
        if (cur.endless || ctx.host.isPrefetched(tUp, s.x, s.z)) doSwitch(ctx, -3, tUp);
        else {
          stopOnFlight(1);
        }
      }
    },

    reset(ctx) {
      release(ctx);
      inside = false;
    },
  };
  return t;
}
