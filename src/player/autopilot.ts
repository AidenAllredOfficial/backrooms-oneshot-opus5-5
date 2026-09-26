// src/player/autopilot.ts (WP12) — seeded wanderer that drives PlayerInput for the attract mode and autowalk.
//
// Wander: every DECIDE_S (or when the way ahead closes) it samples N_DIRS headings. Each heading gets a body-width
// clearance (three parallel rays at 1.0 m height via WorldQuery.rayDistance), an openness probe from the point it
// leads to (dead ends score low), a continuity bonus, a penalty for recently visited cells and for non-walkable
// cells just ahead (pits, deep water), plus seeded jitter. It prefers long sightlines and avoids dead ends.
// Steering turns the view smoothly toward the chosen heading (lookDX; the mouse sensitivity is estimated from the
// observed yaw response, so any settings value works) and walks at a seeded 0.6-1.2 m/s that eases between
// values, slowing for sharp turns. setTarget(x, z) makes it head for a point (with the same obstacle scoring)
// until reached or given up, then it wanders again.
// Floor rises taller than a step (the rim of a sunken pit or split level) are invisible to the eye-height rays, so
// every clearance is also cut at the first such rise along the heading (riseClear); without it the wanderer walks
// into a sunken pit and pushes against the rim until the stuck detection gives up (soak QA, seed 1).
// Deterministic for a given seed and world: its clock is the elapsed time it is given (default: performance.now).

import { CHUNK_CELLS, PLAYER } from '../core/constants.ts';
import { DEFAULT_SETTINGS } from '../core/settings.ts';
import { cellIdx, worldToCell } from '../core/grid.ts';
import { CellFlag } from '../core/ids.ts';
import type { PlayerInput, PlayerState } from '../core/player.ts';
import { hash2, Rng } from '../core/rng.ts';
import type { WorldQuery } from '../core/runtime.ts';

export interface Autopilot {
  next(s: PlayerState, w: WorldQuery, out: PlayerInput): void;
  setTarget(x: number, z: number): void;
  /** drop the current target and wander */
  clearTarget(): void;
}

export const AUTOPILOT = {
  speedMin: 0.6, speedMax: 1.2,
  decideS: 0.45, dirs: 24, rayMax: 18, eyeY: 1.0, body: 0.24,
  turnRate: 2.4, // 1/s: fraction of the heading error removed per second (exponential)
  reachR: 0.6, targetGiveUpS: 40, visitedCells: 96,
} as const;

/** riseClear sampling step (m) and the tallest floor rise (cm) the controller climbs (stepMax + tolerance). */
const RISE_STEP = 0.3;
const RISE_MAX_CM = PLAYER.stepMax * 100 + 2;
const NO_FLOOR = CellFlag.VOID | CellFlag.TOWER | CellFlag.SOLID; // no reference floor (tower flights are ramps)

/** Walkable surface height (cm) of a global cell: floor plus a low blocker; null when unknown or not a floor. */
function surfaceCm(w: WorldQuery, gi: number, gj: number): number | null {
  const cx = Math.floor(gi / CHUNK_CELLS), cz = Math.floor(gj / CHUNK_CELLS);
  const l = w.layoutAt(cx, cz);
  if (!l) return null;
  const c = cellIdx(gi - cx * CHUNK_CELLS, gj - cz * CHUNK_CELLS);
  if ((l.flags[c] & NO_FLOOR) !== 0) return null;
  return l.floorCm[c] + l.blockCm[c];
}

/** Distance along the unit heading (dx, dz) from (x, z) to just before the first floor rise taller than a step,
 * capped at max. Unknown / VOID / TOWER cells reset the reference floor. */
export function riseClear(w: WorldQuery, x: number, z: number, dx: number, dz: number, max: number): number {
  let prev = NaN, pgi = NaN, pgj = NaN;
  for (let t = 0; t <= max; t += RISE_STEP) {
    const gi = worldToCell(x + dx * t), gj = worldToCell(z + dz * t);
    if (gi === pgi && gj === pgj) continue;
    pgi = gi; pgj = gj;
    const h = surfaceCm(w, gi, gj);
    if (h === null) { prev = NaN; continue; }
    if (prev === prev && h - prev > RISE_MAX_CM) return Math.max(0, t - RISE_STEP);
    prev = h;
  }
  return max;
}

const TAU = Math.PI * 2;
const wrap = (a: number): number => { a %= TAU; if (a > Math.PI) a -= TAU; else if (a < -Math.PI) a += TAU; return a; };

export function createAutopilot(seed: number, clock?: () => number): Autopilot {
  const now = clock ?? ((): number => performance.now() / 1000);
  const rng = new Rng(hash2(seed >>> 0, 0x6175746f));
  let heading = NaN;
  let lastT = NaN;
  let decideT = 0;
  let speed = AUTOPILOT.speedMin + (AUTOPILOT.speedMax - AUTOPILOT.speedMin) * rng.float();
  let speedTarget = speed;
  let speedT = 0;
  let pitchTarget = 0;
  let pitchT = 0;
  // sensitivity estimates (rad per look pixel), adapted from the observed response
  let sensX = DEFAULT_SETTINGS.mouseSensitivity, sensY = DEFAULT_SETTINGS.mouseSensitivity;
  let lastDX = 0, lastDY = 0, lastYaw = NaN, lastPitch = NaN;
  // target
  let tx = 0, tz = 0, hasTarget = false, targetT = 0;
  // progress / stuck
  let stuckT = 0, stuckX = NaN, stuckZ = NaN, avoidYaw = NaN, avoidT = 0;
  // visited cells ring
  const visited = new Int32Array(AUTOPILOT.visitedCells * 2).fill(0x7fffffff);
  let visitedHead = 0, lastCellI = 0x7fffffff, lastCellJ = 0x7fffffff;

  const visitedCount = (gi: number, gj: number, r: number): number => {
    let c = 0;
    for (let k = 0; k < AUTOPILOT.visitedCells; k++) {
      if (Math.abs(visited[k * 2] - gi) <= r && Math.abs(visited[k * 2 + 1] - gj) <= r) c++;
    }
    return c;
  };

  const clearance = (w: WorldQuery, x: number, y: number, z: number, dx: number, dz: number, max: number): number => {
    const px = -dz * AUTOPILOT.body, pz = dx * AUTOPILOT.body;
    const a = w.rayDistance(x, y, z, dx, dz, max);
    const b = w.rayDistance(x + px, y, z + pz, dx, dz, max);
    const c = w.rayDistance(x - px, y, z - pz, dx, dz, max);
    const m = Math.min(a, b, c);
    return m > 0 ? Math.min(m, riseClear(w, x, z, dx, dz, m)) : m;
  };

  const walkableAhead = (w: WorldQuery, x: number, z: number, dx: number, dz: number, d: number): boolean => {
    for (let k = 1; k <= 2; k++) {
      const t = Math.min(d - 0.3, k * 0.9);
      if (t <= 0) break;
      if (!w.cellWalkable(worldToCell(x + dx * t), worldToCell(z + dz * t))) return false;
    }
    return true;
  };

  const decide = (s: PlayerState, w: WorldQuery): void => {
    const y = s.y + AUTOPILOT.eyeY;
    const cur = heading === heading ? heading : s.yaw;
    const toTarget = hasTarget ? Math.atan2(-(tx - s.x), -(tz - s.z)) : NaN;
    const distT = hasTarget ? Math.hypot(tx - s.x, tz - s.z) : 0;
    // straight to the target if the way is clear
    if (hasTarget) {
      const dx = -Math.sin(toTarget), dz = -Math.cos(toTarget);
      if (clearance(w, s.x, y, s.z, dx, dz, distT + 0.5) >= distT - 0.05) { heading = toTarget; return; }
    }
    let best = -Infinity, bestYaw = cur;
    const off = rng.float() * (TAU / AUTOPILOT.dirs);
    for (let k = 0; k < AUTOPILOT.dirs; k++) {
      const yaw = wrap(off + (k * TAU) / AUTOPILOT.dirs);
      const dx = -Math.sin(yaw), dz = -Math.cos(yaw);
      const d = clearance(w, s.x, y, s.z, dx, dz, AUTOPILOT.rayMax);
      if (d < 1.1) continue;
      // openness where this heading leads (dead-end avoidance)
      const reach = Math.min(d - 0.6, 7);
      const ex = s.x + dx * reach, ez = s.z + dz * reach;
      const fwd = w.rayDistance(ex, y, ez, dx, dz, 10);
      const left = w.rayDistance(ex, y, ez, -dz, dx, 8);
      const right = w.rayDistance(ex, y, ez, dz, -dx, 8);
      const open = Math.max(fwd, left, right);
      let score = Math.min(d, AUTOPILOT.rayMax) / AUTOPILOT.rayMax * 1.0 + Math.min(open, 8) / 8 * 0.7;
      score += 0.55 * Math.cos(wrap(yaw - cur)); // keep going roughly the same way
      score -= 0.12 * visitedCount(worldToCell(ex), worldToCell(ez), 1);
      if (!walkableAhead(w, s.x, s.z, dx, dz, d)) score -= 3;
      if (avoidT > 0 && avoidYaw === avoidYaw) score -= 1.2 * Math.max(0, Math.cos(wrap(yaw - avoidYaw)));
      if (hasTarget) score += 1.4 * Math.cos(wrap(yaw - toTarget));
      score += 0.25 * rng.float();
      if (score > best) { best = score; bestYaw = yaw; }
    }
    if (best === -Infinity) bestYaw = wrap(cur + Math.PI * (0.5 + rng.float())); // boxed in: turn around
    heading = bestYaw;
  };

  const ap: Autopilot = {
    setTarget(x, z) { tx = x; tz = z; hasTarget = true; targetT = 0; decideT = 0; },
    clearTarget() { hasTarget = false; decideT = 0; },
    next(s, w, out) {
      const t = now();
      const dt = lastT === lastT ? Math.min(0.25, Math.max(0, t - lastT)) : 0;
      lastT = t;
      out.lookDX = 0; out.lookDY = 0; out.moveX = 0; out.moveZ = 0;
      out.sprint = false; out.crouch = false; out.flashlightPressed = false; out.interactPressed = false;

      // sensitivity estimate from the last command's effect
      if (lastYaw === lastYaw && Math.abs(lastDX) > 2) {
        const est = -wrap(s.yaw - lastYaw) / lastDX;
        if (est > 1e-5 && est < 0.05) sensX += (est - sensX) * 0.3;
      }
      if (lastPitch === lastPitch && Math.abs(lastDY) > 2 && Math.abs(s.pitch) < 1.45) {
        const est = -(s.pitch - lastPitch) / lastDY;
        if (Math.abs(est) > 1e-5 && Math.abs(est) < 0.05) sensY += (est - sensY) * 0.3;
      }

      // visited cells
      const gi = worldToCell(s.x), gj = worldToCell(s.z);
      if (gi !== lastCellI || gj !== lastCellJ) {
        lastCellI = gi; lastCellJ = gj;
        visited[visitedHead * 2] = gi; visited[visitedHead * 2 + 1] = gj;
        visitedHead = (visitedHead + 1) % AUTOPILOT.visitedCells;
      }

      // target bookkeeping
      if (hasTarget) {
        targetT += dt;
        if (Math.hypot(tx - s.x, tz - s.z) < AUTOPILOT.reachR || targetT > AUTOPILOT.targetGiveUpS) { hasTarget = false; decideT = 0; }
      }

      // stuck detection: < 0.25 m in 1.5 s while walking
      if (stuckX !== stuckX) { stuckX = s.x; stuckZ = s.z; }
      stuckT += dt;
      if (avoidT > 0) avoidT -= dt;
      if (stuckT >= 1.5) {
        if (Math.hypot(s.x - stuckX, s.z - stuckZ) < 0.25) { avoidYaw = s.yaw; avoidT = 4; decideT = 0; heading = NaN; }
        stuckT = 0; stuckX = s.x; stuckZ = s.z;
      }

      // decide
      decideT -= dt;
      const y = s.y + AUTOPILOT.eyeY;
      const fx = -Math.sin(s.yaw), fz = -Math.cos(s.yaw);
      const ahead = w.rayDistance(s.x, y, s.z, fx, fz, 3);
      if (decideT <= 0 || heading !== heading || ahead < 0.9) {
        decide(s, w);
        decideT = AUTOPILOT.decideS * (0.7 + 0.6 * rng.float());
      }

      // speed: eases toward a seeded target that changes every few seconds
      speedT -= dt;
      if (speedT <= 0) { speedTarget = AUTOPILOT.speedMin + (AUTOPILOT.speedMax - AUTOPILOT.speedMin) * rng.float(); speedT = 3 + 5 * rng.float(); }
      speed += (speedTarget - speed) * (1 - Math.exp(-dt / 1.5));
      // gentle look pitch
      pitchT -= dt;
      if (pitchT <= 0) { pitchTarget = -0.06 + 0.1 * (rng.float() - 0.5); pitchT = 2 + 3 * rng.float(); }

      // steer
      const err = wrap(heading - s.yaw);
      const g = 1 - Math.exp(-AUTOPILOT.turnRate * dt);
      const dYaw = err * g;
      out.lookDX = sensX > 0 ? -dYaw / sensX : 0;
      const dPitch = (pitchTarget - s.pitch) * (1 - Math.exp(-1.5 * dt));
      out.lookDY = sensY !== 0 ? -dPitch / sensY : 0;
      lastDX = out.lookDX; lastDY = out.lookDY; lastYaw = s.yaw; lastPitch = s.pitch;

      // walk (slower while turning hard or when the way ahead is short)
      const turnSlow = Math.max(0.15, 1 - Math.abs(err) / 1.2);
      const aheadSlow = Math.max(0.25, Math.min(1, (ahead - 0.45) / 1.2));
      const v = speed * turnSlow * aheadSlow;
      out.moveZ = Math.min(1, v / PLAYER.walk);
      // side clearance: drift away from a wall closer than a body width
      const rx = -fz, rz = fx;
      const l = w.rayDistance(s.x, y, s.z, -rx, -rz, 1), r = w.rayDistance(s.x, y, s.z, rx, rz, 1);
      if (l < 0.45 && r > l + 0.1) out.moveX = 0.25; else if (r < 0.45 && l > r + 0.1) out.moveX = -0.25;
      if (dt === 0) { out.moveZ = 0; out.moveX = 0; }
    },
  };
  return ap;
}
