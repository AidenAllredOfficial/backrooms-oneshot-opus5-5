// src/app/clock.ts (WP14) — the simulation clock (§6.2): t advances by realDt unless frozen (time= / freeze= /
// setTime) or paused. Frozen time also freezes grain, flicker, water and bob so captures are deterministic.

export const MAX_REAL_DT = 0.1; // s; longer frames (tab switches, hitches) are clamped

export interface SimClock {
  /** simulation seconds */
  readonly t: number;
  /** time frozen by the automation contract (time=, freeze=, setTime) */
  readonly frozen: boolean;
  /** pause menu open: simulation dt is 0 but time is not considered "frozen" */
  paused: boolean;
  /** real (wall) seconds since the previous tick, clamped to MAX_REAL_DT; valid after tick() */
  readonly realDt: number;
  /** simulation dt of the last tick (0 when frozen or paused) */
  readonly dt: number;
  /** advance with a rAF timestamp in ms; returns the simulation dt */
  tick(nowMs: number): number;
  /** freeze at t (number) or release (null) */
  set(t: number | null): void;
  /** freeze at the current value */
  freezeNow(): void;
}

export function createClock(t0 = 0): SimClock {
  let t = t0;
  let frozen = false;
  let last = -1;
  let realDt = 0;
  let dt = 0;
  const c: SimClock = {
    get t() { return t; },
    get frozen() { return frozen; },
    paused: false,
    get realDt() { return realDt; },
    get dt() { return dt; },
    tick(nowMs) {
      realDt = last < 0 ? 1 / 60 : Math.min(Math.max((nowMs - last) / 1000, 0), MAX_REAL_DT);
      last = nowMs;
      dt = frozen || c.paused ? 0 : realDt;
      t += dt;
      return dt;
    },
    set(v) {
      if (v === null) { frozen = false; return; }
      if (Number.isFinite(v)) { t = v; frozen = true; }
    },
    freezeNow() { frozen = true; },
  };
  return c;
}
