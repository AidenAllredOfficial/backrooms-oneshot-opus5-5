// src/player/traversal/pit.ts (WP12) — collapsed-floor pits. VOID cells have no floor, so the player falls.
// Inside a 'pit' portal with the feet below -1.5 m: bus 'glitch' {seconds: 1.2, strength: 0.6} (the screen holds
// dark), then the glitch warp sequence into (s+1)%3 (find safe spawn, prefetch, teleport) with
// storeyChanged {via: 'pit'}. The fall is held at the trigger depth while the warp waits.
// Safety net: a player that ends up below -FALL_RESCUE_Y outside any tower (a VOID cell without a portal, a bad
// spawn) is warped the same way to a safe spot of the current storey.

import { TOWER_SPAN } from '../../core/constants.ts';
import { down, inPortal, inPortalXZ, type TraversalCtx } from './common.ts';
import type { Warp } from './glitch.ts';

export const PIT_TRIGGER_Y = -1.5;
export const FALL_RESCUE_Y = TOWER_SPAN - 1; // 5 m below the storey datum

export interface PitTraversal {
  afterStep(ctx: TraversalCtx, warp: Warp): void;
  readonly triggers: number;
}

export function createPitTraversal(): PitTraversal {
  let triggers = 0;
  return {
    get triggers() { return triggers; },
    afterStep(ctx, warp) {
      const s = ctx.state;
      if (warp.active || s.fly) return;
      let inTower = false;
      for (let i = 0; i < ctx.portalCount; i++) {
        const h = ctx.portals[i];
        if (!h) continue;
        if (h.spec.kind === 'tower' && inPortalXZ(h, s.x, s.z)) inTower = true;
        if (h.spec.kind === 'pit' && s.y < PIT_TRIGGER_Y && inPortal(h, s.x, s.y, s.z, 0.3)) {
          triggers++;
          ctx.extra.yMin = s.y; // hold the fall here
          s.vy = 0;
          warp.start(ctx, 'pit', down(s.s), 1.2, 0.6);
          return;
        }
      }
      if (!inTower && s.y < -FALL_RESCUE_Y) {
        triggers++;
        ctx.extra.yMin = s.y;
        s.vy = 0;
        warp.start(ctx, 'pit', s.s, 1.2, 0.6);
      }
    },
  };
}
