// src/audio/reverb.ts — the runtime room probe (§5 WP13 "Room probe (4 Hz)"):
//  1. 24 horizontal rayDistance rays (max 40 m) at y = feet + 1.2 -> floor polygon area and perimeter;
//  2. ceiling height -> V and S;  3. surface-weighted LAYER_DEFS.absorption of the floor / walls / ceiling
//  materials around the listener (5 x 5 cells; water surfaces reflect, open / dark ceilings swallow);
//  4. RT60 = 0.161 V / (S a);  5. nearest IR with +-15 % hysteresis, A/B crossfade over 1.5 s;
//  6. pre-delay = mfp / 343 (5-60 ms); wet level from reverberance and openness. Return EQ from zoneAudio.

import { CELL, CHUNK_CELLS } from '../core/constants.ts';
import { CeilKind, CellFlag, Mat, type ZoneId } from '../core/ids.ts';
import { NO_WATER } from '../core/layout.ts';
import { LAYER_DEFS } from '../core/materials.ts';
import type { WorldQuery } from '../core/runtime.ts';
import type { SynthRequest } from './dsp/dispatch.ts';
import { synthKey } from './dsp/dispatch.ts';
import type { AudioEnv } from './env.ts';
import {
  createRoomEstimate, IR_RT60, pickIR, preDelayOf, PROBE_MAX, PROBE_RAYS, PROBE_Y, roomFromRays, wetOf, type RoomEstimate,
} from './roomProbe.ts';
import { zoneAudio } from './zoneAudio.ts';

const OPEN_CEIL_ALPHA = 0.55;
const WATER_ALPHA = 0.01;

export class Reverb {
  private readonly env: AudioEnv;
  private readonly rays = new Float32Array(PROBE_RAYS);
  private readonly dirX = new Float32Array(PROBE_RAYS);
  private readonly dirZ = new Float32Array(PROBE_RAYS);
  readonly room: RoomEstimate = createRoomEstimate();
  rt60 = 0.6;
  private rtInit = false;
  irIndex = -1;
  private wanted = -1;
  private readonly keys: string[] = [];
  lastZone: ZoneId = 0;

  constructor(env: AudioEnv) {
    this.env = env;
    for (let i = 0; i < PROBE_RAYS; i++) {
      const a = (i / PROBE_RAYS) * Math.PI * 2;
      this.dirX[i] = Math.cos(a);
      this.dirZ[i] = Math.sin(a);
    }
    for (let i = 0; i < IR_RT60.length; i++) this.keys.push(synthKey({ op: 'ir', index: i }));
  }

  static requests(): SynthRequest[] {
    const r: SynthRequest[] = [];
    for (let i = 0; i < IR_RT60.length; i++) r.push({ op: 'ir', index: i });
    return r;
  }

  /** 4 Hz probe. feetY = player feet (storey-relative). */
  probe(world: WorldQuery, x: number, feetY: number, z: number, zone: ZoneId): void {
    const y = feetY + PROBE_Y;
    for (let i = 0; i < PROBE_RAYS; i++) {
      const d = world.rayDistance(x, y, z, this.dirX[i], this.dirZ[i], PROBE_MAX);
      this.rays[i] = Number.isFinite(d) ? Math.min(PROBE_MAX, Math.max(0.3, d)) : PROBE_MAX;
    }
    let h = world.ceilingAt(x, z, feetY + 1.0) - feetY;
    if (!Number.isFinite(h) || h <= 0) h = 8;
    h = Math.min(20, Math.max(2, h));
    const a = this.absorption(world, x, z);
    roomFromRays(this.rays, PROBE_RAYS, PROBE_MAX, h, a[0], a[1], a[2], this.room);
    const rt = this.room.rt60;
    if (!this.rtInit) { this.rt60 = rt; this.rtInit = true; } else this.rt60 += (rt - this.rt60) * 0.35;
    this.wanted = pickIR(this.rt60, this.irIndex);
    this.lastZone = zone;
    const za = zoneAudio(zone);
    this.env.graph.setReverb(preDelayOf(this.room.mfp), wetOf(this.rt60, this.room.openness), za.eqLowDb, za.eqHighDb);
    this.applyIR();
  }

  /** Load / crossfade to the wanted IR when its buffer is ready and no crossfade is running. */
  applyIR(): void {
    if (this.wanted < 0 || this.wanted === this.irIndex) return;
    const buf = this.env.bank.get(this.keys[this.wanted]) ?? this.env.bank.ensure({ op: 'ir', index: this.wanted }, 1);
    if (!buf) return;
    if (this.env.graph.swapIR(buf, this.wanted)) {
      if (this.irIndex >= 0) this.env.log(`reverb IR ${IR_RT60[this.irIndex]} s -> ${IR_RT60[this.wanted]} s (RT60 ${this.rt60.toFixed(2)} s)`);
      this.irIndex = this.wanted;
    }
  }

  private readonly abs: [number, number, number] = [0.1, 0.1, 0.1];
  /** [floor, wall, ceiling] Sabine absorption averaged over the 5 x 5 cells around the listener. */
  private absorption(world: WorldQuery, x: number, z: number): [number, number, number] {
    const gi = Math.floor(x / CELL + 1e-7), gj = Math.floor(z / CELL + 1e-7);
    let sf = 0, sw = 0, sc = 0, n = 0;
    for (let dj = -2; dj <= 2; dj++) for (let di = -2; di <= 2; di++) {
      const ci = gi + di, cj = gj + dj;
      const cx = Math.floor(ci / CHUNK_CELLS), cz = Math.floor(cj / CHUNK_CELLS);
      const l = world.layoutAt(cx, cz);
      if (!l) continue;
      const k = (cj - cz * CHUNK_CELLS) * CHUNK_CELLS + (ci - cx * CHUNK_CELLS);
      if ((l.flags[k] & CellFlag.SOLID) !== 0) continue;
      const fm = LAYER_DEFS[l.floorMat[k]] ?? LAYER_DEFS[Mat.CARPET_L0];
      const wm = LAYER_DEFS[l.wallMat[k]] ?? LAYER_DEFS[Mat.WALLPAPER_L0];
      const cm = LAYER_DEFS[l.ceilMat[k]] ?? LAYER_DEFS[Mat.CEILING_TILE];
      sf += l.waterCm[k] !== NO_WATER ? WATER_ALPHA : fm.absorption;
      sw += wm.absorption;
      const ck = l.ceilKind[k];
      sc += (l.flags[k] & CellFlag.NO_CEIL) !== 0 || ck === CeilKind.OPEN_DARK ? OPEN_CEIL_ALPHA : cm.absorption;
      n++;
    }
    if (n > 0) { this.abs[0] = sf / n; this.abs[1] = sw / n; this.abs[2] = sc / n; }
    return this.abs;
  }
}
