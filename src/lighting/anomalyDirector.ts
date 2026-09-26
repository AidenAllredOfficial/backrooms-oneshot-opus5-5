// src/lighting/anomalyDirector.ts — spark bursts and "light dies ahead" (WP11). Never emits 'glitch'
// (reserved for traversal; WP14 wires 'glitch' -> post.glitch).
//  - SPARKING sites (layout.anomalies, within 20 m of the player): Poisson bursts, lambda 1/8 s, scheduled as a
//    pure function of simulation time (1 s bins, one burst max per bin), so shots under time= are deterministic.
//    Each burst emits `spark` and draws the additive particle burst (sparks.ts); a dynamic light within 2 m dips
//    via lighting.setOverride(id, 0.2) for the burst.
//  - "Light dies ahead": with p 1/600 per second in DYING/DARK moods, the nearest visible dynamic light ramps
//    ANOMALY -> 0 over 2 s (setOverride), then recovers after 20 s (setOverride(id, null)).

import type * as THREE from 'three';
import { CHUNK_SIZE } from '../core/constants.ts';
import type { GameBus, GameEvents } from '../core/events.ts';
import { AnomalyKind, Mood } from '../core/ids.ts';
import type { PlayerState } from '../core/player.ts';
import { hash2, hash3, hash01, SALT } from '../core/rng.ts';
import type { FixtureRef, LightingRuntime, WorldQuery } from '../core/runtime.ts';
import { createSparks } from './sparks.ts';

export const ANOMALY_TUNING = {
  SPARK_RANGE: 20, // m
  SPARK_RATE: 1 / 8, // bursts per second per site
  SPARK_DIP: 0.2,
  SPARK_DIP_S: 0.18,
  SPARK_DIP_RANGE: 2, // m
  DIE_P: 1 / 600, // per second, DYING/DARK moods
  DIE_RAMP_S: 2,
  DIE_HOLD_S: 20,
  DIE_RANGE: 18, // m
} as const;

/** Burst time of site `seed` inside the 1 s bin `bin` (NaN if none): Poisson(1/8) approximated per 1 s bin. */
export function sparkBurstTime(seed: number, bin: number): number {
  const h = hash3(seed | 0, SALT.ANOMALY, bin | 0);
  const p = 1 - Math.exp(-ANOMALY_TUNING.SPARK_RATE);
  if (hash01(h) >= p) return NaN;
  return bin + hash01(hash2(h, 1));
}

/** Whether the "light dies" roll fires in 1 s bin `bin` (deterministic in t). */
export function lightDiesRoll(bin: number, salt: number): boolean {
  return hash01(hash3(SALT.ANOMALY, 0x4c44 ^ salt, bin | 0)) < ANOMALY_TUNING.DIE_P;
}

const MAX_SITES = 32;

export function createAnomalyDirector(bus: GameBus, lighting: LightingRuntime, scene: THREE.Scene): { reset(): void; update(t: number, dt: number, player: PlayerState, world: WorldQuery): void } {
  const A = ANOMALY_TUNING;
  const sparks = createSparks(scene);
  const fx: FixtureRef[] = [];
  // gathered SPARKING sites (world metres)
  const siteX = new Float64Array(MAX_SITES), siteY = new Float64Array(MAX_SITES), siteZ = new Float64Array(MAX_SITES);
  const siteSeed = new Int32Array(MAX_SITES);
  let siteCount = 0;
  const sparkEv: GameEvents['spark'] = { x: 0, y: 0, z: 0, strength: 0 };
  const anomalyEv: GameEvents['anomaly'] = { kind: '', phase: 'start', x: 0, z: 0 };
  let prevT = NaN;
  // spark dip
  let dipId = -1;
  let dipUntil = -1;
  // light dies
  let dieId = -1;
  let dieStart = 0;
  let dieFrom = 1;
  let dieX = 0, dieZ = 0;

  function gatherSites(player: PlayerState, world: WorldQuery): void {
    siteCount = 0;
    const pcx = Math.floor(player.x / CHUNK_SIZE), pcz = Math.floor(player.z / CHUNK_SIZE);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const lay = world.layoutAt(pcx + dx, pcz + dz);
        if (!lay) continue;
        const ox = (pcx + dx) * CHUNK_SIZE, oz = (pcz + dz) * CHUNK_SIZE;
        for (let i = 0; i < lay.anomalies.length && siteCount < MAX_SITES; i++) {
          const a = lay.anomalies[i];
          if (a.kind !== AnomalyKind.SPARKING) continue;
          const wx = ox + a.x, wz = oz + a.z;
          const ddx = wx - player.x, ddz = wz - player.z;
          if (ddx * ddx + ddz * ddz > A.SPARK_RANGE * A.SPARK_RANGE) continue;
          // spark from the (dead) fixture at the site if there is one, else from just below the ceiling
          const ci = Math.min(31, Math.max(0, Math.floor(a.x / 1.2))), cj = Math.min(31, Math.max(0, Math.floor(a.z / 1.2)));
          let wy = lay.ceilCm[cj * 32 + ci] / 100 - 0.08;
          let best = 1.5 * 1.5;
          for (let f = 0; f < lay.fixtures.length; f++) {
            const fi = lay.fixtures[f];
            const d2 = (fi.px - a.x) * (fi.px - a.x) + (fi.pz - a.z) * (fi.pz - a.z);
            if (d2 < best) { best = d2; wy = fi.py - 0.03; }
          }
          siteX[siteCount] = wx; siteY[siteCount] = wy; siteZ[siteCount] = wz; siteSeed[siteCount] = a.seed | 0;
          siteCount++;
        }
      }
    }
  }

  function burst(i: number, bt: number, world: WorldQuery): void {
    const strength = 0.6 + 0.4 * hash01(hash2(siteSeed[i], Math.floor(bt * 1000)));
    sparks.burst(siteX[i], siteY[i], siteZ[i], strength, bt, hash2(siteSeed[i], Math.floor(bt)));
    sparkEv.x = siteX[i]; sparkEv.y = siteY[i]; sparkEv.z = siteZ[i]; sparkEv.strength = strength;
    bus.emit('spark', sparkEv);
    // dip a dynamic light within 2 m for the burst
    const n = world.fixturesNear(siteX[i], siteZ[i], A.SPARK_DIP_RANGE, fx);
    for (let k = 0; k < n; k++) {
      const f = fx[k].f;
      if (!f.dynamic || f.id === dieId) continue;
      if (dipId >= 0 && dipId !== f.id) lighting.setOverride(dipId, null);
      dipId = f.id;
      dipUntil = bt + A.SPARK_DIP_S;
      lighting.setOverride(f.id, A.SPARK_DIP);
      break;
    }
  }

  function pickDyingLight(player: PlayerState, world: WorldQuery): boolean {
    const n = world.fixturesNear(player.x, player.z, A.DIE_RANGE, fx);
    const fwx = -Math.sin(player.camYaw), fwz = -Math.cos(player.camYaw);
    let best = -1;
    let bestD = Infinity;
    for (let k = 0; k < n; k++) {
      const r = fx[k];
      if (!r.f.dynamic || r.f.id === dipId) continue;
      const dx = r.wx - player.eyeX, dz = r.wz - player.eyeZ;
      const d = Math.hypot(dx, dz);
      if (d < 1.5 || (dx * fwx + dz * fwz) / d < 0.55) continue; // ahead, inside the view cone
      if (d >= bestD) continue;
      if (!world.losClear(player.eyeX, player.eyeY, player.eyeZ, r.wx, r.wy - 0.05, r.wz)) continue;
      best = k; bestD = d;
    }
    if (best < 0) return false;
    const r = fx[best];
    dieId = r.f.id;
    dieFrom = lighting.intensityOf(dieId);
    dieX = r.wx; dieZ = r.wz;
    return true;
  }

  return {
    reset() {
      if (dipId >= 0) lighting.setOverride(dipId, null);
      if (dieId >= 0) lighting.setOverride(dieId, null);
      dipId = dieId = -1;
      prevT = NaN;
      fx.length = 0;
      siteCount = 0;
      sparks.update(Infinity);
    },
    update(t, dt, player, world) {
      sparks.update(t);
      if (!(t > prevT) || t - prevT > 1) {
        // first frame, frozen/rewound clock or a long hitch: no retroactive bursts
        prevT = t;
        return;
      }
      const t0 = prevT;
      prevT = t;
      gatherSites(player, world);
      // spark bursts scheduled in (t0, t]
      const b0 = Math.floor(t0), b1 = Math.floor(t);
      for (let i = 0; i < siteCount; i++) {
        for (let bin = b0; bin <= b1; bin++) {
          const bt = sparkBurstTime(siteSeed[i], bin);
          if (bt > t0 && bt <= t) burst(i, bt, world);
        }
      }
      if (dipId >= 0 && t >= dipUntil) {
        lighting.setOverride(dipId, null);
        dipId = -1;
      }
      // light dies ahead
      if (dieId < 0) {
        const mood = world.moodAt(player.x, player.z);
        if (mood === Mood.DYING || mood === Mood.DARK) {
          for (let bin = b0 + 1; bin <= b1; bin++) {
            if (lightDiesRoll(bin, player.s) && pickDyingLight(player, world)) {
              dieStart = t;
              anomalyEv.kind = 'lightDies'; anomalyEv.phase = 'start'; anomalyEv.x = dieX; anomalyEv.z = dieZ;
              bus.emit('anomaly', anomalyEv);
              break;
            }
          }
        }
      } else {
        const e = t - dieStart;
        if (e < A.DIE_RAMP_S) {
          const w = e / A.DIE_RAMP_S;
          lighting.setOverride(dieId, dieFrom * (1 - w * w * (3 - 2 * w)));
        } else if (e < A.DIE_RAMP_S + A.DIE_HOLD_S) {
          lighting.setOverride(dieId, 0);
        } else {
          lighting.setOverride(dieId, null);
          anomalyEv.kind = 'lightDies'; anomalyEv.phase = 'end'; anomalyEv.x = dieX; anomalyEv.z = dieZ;
          bus.emit('anomaly', anomalyEv);
          dieId = -1;
        }
      }
      void dt;
    },
  };
}
