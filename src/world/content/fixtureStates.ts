// src/world/content/fixtureStates.ts — per-fixture light states and dynamic-light selection (WP4).
//
// p = power(cell) * lighting.zoneMul * MOOD_POWER_MUL[mood], u = hash01(hash2(id, SALT.FIXTURE_STATE)):
//   p < 0.18         OFF 85%  FLICKER 10%  DYING 5%
//   0.18 <= p < 0.35 OFF 35%  FLICKER 15%  DYING 10%          (rest ON)
//   otherwise        OFF 3%   FLICKER 2%   DYING 2%  BUZZ 3%  (+ up to 6% each to OFF and DYING from decay)
// Then at most one dynamic light per render tile: the FLICKER fixture with the lowest u owns the tile's flicker
// channel; the other FLICKER fixtures (and any mounted > LIGHT.DYN_MAX_MOUNT above their floor) become DYING.
// Tower / elevator fixtures are always ON. Landmark fixtures keep their authored state (FLICKER ones still go
// through the one-dynamic-per-tile rule). QA overrides: lights 'on' -> all ON, 'dead' -> all OFF.
// R2 lighting (docs/contract-changes/R2-lighting.md):
//   - a fixture with luminance 0 (the dead half of a lamp-out troffer) is OFF (QA 'on' keeps it ON: it emits nothing);
//   - HIGHBAY lamps (HID, long warm-up, often dead) that come out ON are OFF with p HIGHBAY_OFF_P;
//   - OFF cap: in NORMAL / SPARSE (DYING) moods at most OFF_CAP (OFF_CAP_DYING) of the fixtures of any 8 x 8-cell
//     window are OFF; the OFF fixtures with the highest u are revived as DYING (or FLICKER, p 0.25);
//   - emergency lights (fixtures.ts placeEmergencyLights): outside the DARK zone and DARK mood, open cells with no lit
//     fixture in reach and line of sight get dim caged bulbs (greedy cover), so a dead area reads as a dark room lit
//     by spill instead of a black void.

import { LIGHT } from '../../core/constants.ts';
import { CellFlag, FixtureKind, LightState, Mood, MOOD_POWER_MUL, SALT, cellIdx, clamp, hash01, hash2, tileOfPoint, worldToCell, Zone } from '../../core/index.ts';
import { placeEmergencyLights } from './fixtures.ts';
import type { ChunkLayout, Fixture, LightStateId, ZoneGenContext } from '../../core/index.ts';
import { N } from './util.ts';

/** Probabilities [OFF, FLICKER, DYING, BUZZ] (ON = the rest) for power product p and decay d in [0, 1). */
export function stateProbabilities(p: number, decay: number): [number, number, number, number] {
  if (p < 0.18) return [0.85, 0.1, 0.05, 0];
  if (p < 0.35) return [0.35, 0.15, 0.1, 0];
  const d = clamp(decay, 0, 1);
  return [0.03 + 0.06 * d, 0.02, 0.02 + 0.06 * d, 0.03];
}

export function stateFromU(u: number, pr: readonly number[]): LightStateId {
  let a = pr[0];
  if (u < a) return LightState.OFF;
  a += pr[1];
  if (u < a) return LightState.FLICKER;
  a += pr[2];
  if (u < a) return LightState.DYING;
  a += pr[3];
  if (u < a) return LightState.BUZZ;
  return LightState.ON;
}

export const fixtureU = (id: number): number => hash01(hash2(id, SALT.FIXTURE_STATE));

/** Cell index containing a fixture centre (clamped into the chunk). */
export function fixtureCell(f: Pick<Fixture, 'px' | 'pz'>): number {
  const li = clamp(worldToCell(f.px), 0, N - 1), lj = clamp(worldToCell(f.pz), 0, N - 1);
  return cellIdx(li, lj);
}
export const isStructureFixture = (l: ChunkLayout, f: Fixture): boolean =>
  f.bakeGroup !== 0 || (l.flags[fixtureCell(f)] & (CellFlag.TOWER | CellFlag.ELEVATOR)) !== 0;

/** Power product p of a fixture (the formula input). */
export function fixturePower(ctx: ZoneGenContext, f: Fixture): number {
  const l = ctx.grid.layout;
  return (l.power[fixtureCell(f)] / 256) * ctx.lighting.zoneMul * MOOD_POWER_MUL[l.mood];
}

/** HIGHBAY lamps that come out ON are dead with this probability (15-25% of a warehouse roof is dark). */
export const HIGHBAY_OFF_P = 0.17;
/** Max OFF fraction per 8 x 8-cell window in NORMAL / SPARSE moods, and in the DYING mood. */
export const OFF_CAP = 0.7, OFF_CAP_DYING = 0.85;
/** Window size (cells) of the OFF cap and the emergency-light pockets. */
export const STATE_WIN = 8;

export function assignFixtureStates(ctx: ZoneGenContext): void {
  const l = ctx.grid.layout;
  const mode = ctx.opts.lights;
  for (const f of l.fixtures) {
    f.dynamic = false;
    if (isStructureFixture(l, f)) { f.state = LightState.ON; continue; }
    if (mode === 'on') { f.state = LightState.ON; continue; }
    if (mode === 'dead') { f.state = LightState.OFF; continue; }
    if (!(f.luminance > 0)) { f.state = LightState.OFF; continue; } // dead half of a lamp-out troffer
    const c = fixtureCell(f);
    if ((l.flags[c] & CellFlag.LANDMARK) !== 0) continue; // authored by the landmark
    const pr = stateProbabilities(fixturePower(ctx, f), l.decay[c] / 256);
    const u = fixtureU(f.id);
    f.state = stateFromU(u, pr);
    if (f.kind === FixtureKind.HIGHBAY && f.state === LightState.ON && hash01(hash2(f.id, 0x4b1d)) < HIGHBAY_OFF_P) f.state = LightState.OFF;
  }
  if (mode === 'on' || mode === 'dead') return;
  const dark = l.mood === Mood.DARK || l.zone === Zone.DARK;
  if (!dark) capOff(l, l.mood === Mood.DYING ? OFF_CAP_DYING : OFF_CAP);
  enforceDynamicRule(l);
  if (!dark) placeEmergencyLights(ctx);
}

/** Revive OFF fixtures (highest u first: the ones nearest to having survived) as DYING / FLICKER until at most
 * `cap` of the adjustable fixtures of every STATE_WIN x STATE_WIN window are OFF. */
function capOff(l: ChunkLayout, cap: number): void {
  const nw = N / STATE_WIN;
  const wins: Fixture[][] = [];
  for (let k = 0; k < nw * nw; k++) wins.push([]);
  for (const f of l.fixtures) {
    if (!(f.luminance > 0) || isStructureFixture(l, f)) continue;
    const c = fixtureCell(f);
    if ((l.flags[c] & CellFlag.LANDMARK) !== 0) continue;
    const li = c % N, lj = (c - li) / N;
    wins[Math.floor(lj / STATE_WIN) * nw + Math.floor(li / STATE_WIN)].push(f);
  }
  for (const w of wins) {
    if (w.length === 0) continue;
    const off = w.filter((f) => f.state === LightState.OFF);
    const allowed = Math.floor(cap * w.length + 1e-9);
    if (off.length <= allowed) continue;
    off.sort((a, b) => fixtureU(b.id) - fixtureU(a.id) || a.id - b.id);
    for (let k = 0; k < off.length - allowed; k++) {
      const f = off[k];
      f.state = hash01(hash2(f.id, 0xd1e5)) < 0.25 ? LightState.FLICKER : LightState.DYING;
    }
  }
}

/** One dynamic light per tile (lowest u among FLICKER, mount <= DYN_MAX_MOUNT); every other FLICKER -> DYING. */
export function enforceDynamicRule(l: ChunkLayout): void {
  const best: (Fixture | null)[] = [null, null, null, null];
  const bestU = [2, 2, 2, 2];
  for (const f of l.fixtures) {
    f.dynamic = false;
    if (f.state !== LightState.FLICKER) continue;
    const mount = f.py - l.floorCm[fixtureCell(f)] / 100;
    if (mount > LIGHT.DYN_MAX_MOUNT) { f.state = LightState.DYING; continue; }
    const q = tileOfPoint(f.px, f.pz);
    const u = fixtureU(f.id);
    if (u < bestU[q] || (u === bestU[q] && best[q] !== null && f.id < best[q]!.id)) { bestU[q] = u; best[q] = f; }
  }
  for (const f of l.fixtures) {
    if (f.state !== LightState.FLICKER) continue;
    const q = tileOfPoint(f.px, f.pz);
    if (best[q] === f) f.dynamic = true;
    else f.state = LightState.DYING;
  }
}
