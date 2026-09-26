// src/world/spawn.ts — findSpawn / findNearest (WP1).
//
// findSpawn(s) scores every SPAWN_OK cell of the 3x3 chunks around the origin:
//   2·(ON fixtures within 4 m) + (walkable cells within Chebyshev 2)/5 + longestSightline/5
// (sightlines: 8 directions, 2.5D DDA with edgeSolidAt at eye height floor + 1.6 m, clipped by solid boxes and large
// props, capped at 30 m; each direction is a 3-ray fan so narrow gaps score low).
// Yaw = direction of the best sightline fan; ties go to the lowest cell index. On every storey the district that
// contains chunk (0, 0) is preferred (storey 0: the onboarding LOBBY), falling back to the whole 3x3.
// findNearest(query, from, maxChunks) is a ring search by Chebyshev chunk distance; cheap matchers use the pure
// district / site functions, the rest generate chunks (through the WorldGen layout cache).
// zone:NAME views also weigh the emitting fixtures in the view cone (litViewWeight): zone:DARK loses sightline for
// each (it looks into the dark, not across into a lit district), other zones gain a capped bonus (an establishing
// shot shows its light sources). Near-target matchers (flicker) prefer the target's own room.
// R2 B9 QA views:
//  * tower / elevator / landmark:NAME frame their SUBJECT (pickSubjectView): candidate cells of the site chunk around
//    the subject x 16 yaws, each scored by the subject cells a 7-ray fan across the frame sees (cells entered, and
//    the faces it hits), with >= 4 m of open sightline straight ahead (no wall filling the frame), a lit-view bonus
//    and the framing penalty; landmarks prefer standing at / just inside their frame looking in (an entrance, the
//    end of an aisle), towers / elevators 4-9 m from the structure. Generic by LANDMARK_NAMES (any landmark kind).
//  * flicker prefers a FLICKER-state fixture (the dynamic channel that actually bursts) over ANOMALY ones.
//  * zone:NAME prefers districts of NORMAL mood (a DARK / DYING WAREHOUSE is not the zone's establishing shot):
//    other moods are kept as a fallback while up to MOOD_EXTRA_RINGS more rings are searched.
//  * clear: the nearest standable floor spot to a point (URL x/z, teleport without y): walkable, clear of prop /
//    solid footprints at body height, ceiling above feet + eye + 0.1 m; the point itself when it already is.

import { CELL, CHUNK_CELLS, CHUNK_SIZE } from '../core/constants.ts';
import { edgeSolidAt } from '../core/edges.ts';
import { cellIdx, exIdx, ezIdx, worldToCell, worldToChunk } from '../core/grid.ts';
import { CellFlag, FixtureKind, LANDMARK_NAMES, LandmarkKind, LightState, Mood, PropFlag, PropKind, type StoreyId, VIGNETTE_NAMES, Zone, ZONE_NAMES, type ZoneId } from '../core/ids.ts';
import type { ChunkLayout } from '../core/layout.ts';
import { PROP_DEFS } from '../core/props.ts';
import type { SpawnPoint, TowerSite } from '../core/world.ts';
import type { VignetteKindId } from '../core/ids.ts';
import { vignetteCandidates } from './content/vignettes.ts';
import { cellWalkable } from './connectivity.ts';
import type { Districts } from './districts.ts';
import type { Sites } from './sites.ts';
import { elevatorExitCell } from './structures/elevator.ts';
import { towerExitCell, towerFrame } from './structures/tower.ts';
import type { FieldSampler } from '../core/world.ts';

const N = CHUNK_CELLS;
const EYE = 1.6;
const SIGHT_MAX = 30;
const LIGHT_R = 4;
const GEN_RING_CAP = 6; // rings searched by generation-only matchers (water / flicker / vignette fallback)
const DIRS: readonly [number, number][] = [
  [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1],
].map(([x, z]) => { const n = Math.hypot(x, z); return [x / n, z / n] as [number, number]; });

export interface SpawnWorld {
  readonly seed: number;
  readonly districts: Districts;
  readonly sites: Sites;
  layout(s: StoreyId, cx: number, cz: number): ChunkLayout;
  fields(s: StoreyId): FieldSampler;
}

/** Global-cell view over cached layouts (one storey). Keeps the last chunk to make DDA steps cheap. */
export class CellView {
  private lcx = 0x7fffffff;
  private lcz = 0x7fffffff;
  private cur: ChunkLayout | null = null;
  private readonly w: SpawnWorld;
  readonly s: StoreyId;
  constructor(w: SpawnWorld, s: StoreyId) { this.w = w; this.s = s; }
  at(gi: number, gj: number): ChunkLayout {
    const cx = gi >> 5, cz = gj >> 5;
    if (cx !== this.lcx || cz !== this.lcz || !this.cur) {
      this.cur = this.w.layout(this.s, cx, cz);
      this.lcx = cx; this.lcz = cz;
    }
    return this.cur;
  }
  idx(gi: number, gj: number): number { return cellIdx(gi & 31, gj & 31); }
  flags(gi: number, gj: number): number { return this.at(gi, gj).flags[this.idx(gi, gj)]; }
  floorCm(gi: number, gj: number): number { return this.at(gi, gj).floorCm[this.idx(gi, gj)]; }
  walkable(gi: number, gj: number): boolean { return cellWalkable(this.at(gi, gj), this.idx(gi, gj)); }
  /** Line of sight blocked at cell (gi, gj) for eye height y (m)? */
  cellBlocks(gi: number, gj: number, y: number): boolean {
    const l = this.at(gi, gj), c = this.idx(gi, gj);
    if ((l.flags[c] & (CellFlag.SOLID | CellFlag.TOWER | CellFlag.ELEVATOR)) !== 0) return true;
    return (l.floorCm[c] + l.blockCm[c]) / 100 > y || l.ceilCm[c] / 100 < y;
  }
  /** x-edge on global line gi (between cells gi-1 and gi), row gj, crossed at along-edge t (m), height y. */
  exBlocks(gi: number, gj: number, t: number, y: number): boolean {
    const l = this.at(gi, gj); // the chunk storing line gi as its local line (gi & 31) (both copies agree)
    const k = exIdx(gi & 31, gj & 31);
    const sill = Math.max(this.floorCm(gi - 1, gj), this.floorCm(gi, gj)) / 100;
    return edgeSolidAt(l.ex.kind[k], l.ex.hA[k], l.ex.hB[k], t, y, sill);
  }
  private readonly obst = new Map<string, number[]>();
  /** View obstacles of chunk (cx, cz): world-space [x0, z0, x1, z1, y0, y1] per solid box / large prop. Pillars,
   * racks, cars and cabinets are solids or props, not cells, so the cell/edge DDA alone cannot see them. */
  obstacles(cx: number, cz: number): number[] {
    const key = cx + ',' + cz;
    let o = this.obst.get(key);
    if (o) return o;
    o = [];
    const l = this.w.layout(this.s, cx, cz);
    const ox = cx * CHUNK_SIZE, oz = cz * CHUNK_SIZE;
    for (const b of l.solids) {
      if (b.kind !== 'box') continue;
      if (b.max[1] - b.min[1] < 0.3) continue;
      o.push(ox + b.min[0], oz + b.min[2], ox + b.max[0], oz + b.max[2], b.min[1], b.max[1]);
    }
    for (const p of l.props) {
      const def = PROP_DEFS[p.kind];
      if (!def || (!def.collide && !def.occlude) || def.size[1] * p.scale < 0.9) continue;
      const q = Math.round(p.yaw / (Math.PI / 2)) & 1;
      const hx = (q ? def.size[2] : def.size[0]) * p.scale / 2, hz = (q ? def.size[0] : def.size[2]) * p.scale / 2;
      const h = def.size[1] * p.scale;
      const y0 = (p.flags & PropFlag.CEILING) !== 0 ? p.y - h : p.y;
      o.push(ox + p.x - hx, oz + p.z - hz, ox + p.x + hx, oz + p.z + hz, y0, y0 + h);
    }
    this.obst.set(key, o);
    return o;
  }
  ezBlocks(gi: number, gj: number, t: number, y: number): boolean {
    const l = this.at(gi, gj);
    const k = ezIdx(gi & 31, gj & 31);
    const sill = Math.max(this.floorCm(gi, gj - 1), this.floorCm(gi, gj)) / 100;
    return edgeSolidAt(l.ez.kind[k], l.ez.hA[k], l.ez.hB[k], t, y, sill);
  }
}

/** Distance (m) from (x, z) along the unit direction (dx, dz) to the first blocking edge / cell at height y. */
export function rayDistance(v: CellView, x: number, z: number, dx: number, dz: number, y: number, maxDist: number): number {
  let gi = worldToCell(x), gj = worldToCell(z);
  const stepX = dx > 0 ? 1 : -1, stepZ = dz > 0 ? 1 : -1;
  const adx = Math.abs(dx), adz = Math.abs(dz);
  const tDX = adx > 1e-12 ? CELL / adx : Infinity, tDZ = adz > 1e-12 ? CELL / adz : Infinity;
  let tMX = adx > 1e-12 ? (dx > 0 ? (gi + 1) * CELL - x : x - gi * CELL) / adx : Infinity;
  let tMZ = adz > 1e-12 ? (dz > 0 ? (gj + 1) * CELL - z : z - gj * CELL) / adz : Infinity;
  for (let n = 0; n < 512; n++) {
    let t: number;
    if (tMX <= tMZ) {
      t = tMX;
      if (t > maxDist) return maxDist;
      const line = dx > 0 ? gi + 1 : gi;
      if (v.exBlocks(line, gj, z + dz * t - gj * CELL, y)) return t;
      gi += stepX;
      tMX += tDX;
    } else {
      t = tMZ;
      if (t > maxDist) return maxDist;
      const line = dz > 0 ? gj + 1 : gj;
      if (v.ezBlocks(gi, line, x + dx * t - gi * CELL, y)) return t;
      gj += stepZ;
      tMZ += tDZ;
    }
    if (v.cellBlocks(gi, gj, y)) return t;
  }
  return maxDist;
}

/** Clear line of sight between two world points at height y. */
function losClear(v: CellView, x0: number, z0: number, x1: number, z1: number, y: number): boolean {
  const dx = x1 - x0, dz = z1 - z0, d = Math.hypot(dx, dz);
  if (d < 1e-6) return true;
  return rayDistance(v, x0, z0, dx / d, dz / d, y, d) >= d - 1e-6;
}

interface Cand { gi: number; gj: number; base: number; order: number; l: ChunkLayout; c: number }

/** Candidate base score: 2·(ON fixtures within 4 m) + walkable cells within Chebyshev 2 / 5. */
function baseScore(v: CellView, gi: number, gj: number, lights: readonly number[]): number {
  const x = (gi + 0.5) * CELL, z = (gj + 0.5) * CELL;
  let n = 0;
  for (let i = 0; i < lights.length; i += 2) {
    const dx = lights[i] - x, dz = lights[i + 1] - z;
    if (dx * dx + dz * dz <= LIGHT_R * LIGHT_R) n++;
  }
  let w = 0;
  for (let dj = -2; dj <= 2; dj++) for (let di = -2; di <= 2; di++) if (v.walkable(gi + di, gj + dj)) w++;
  return 2 * n + w / 5;
}

/** ON fixtures (world x, z pairs) of the 3x3 chunks around (cx, cz). */
function onLights(w: SpawnWorld, s: StoreyId, cx: number, cz: number): number[] {
  const out: number[] = [];
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      const l = w.layout(s, cx + dx, cz + dz);
      for (const f of l.fixtures) {
        if (f.state !== LightState.ON) continue;
        out.push((cx + dx) * CHUNK_SIZE + f.px, (cz + dz) * CHUNK_SIZE + f.pz);
      }
    }
  }
  return out;
}

/** Emitting fixtures (every state but OFF: ON, FLICKER, DYING, BUZZ, ANOMALY; world x, z pairs) of the 3x3 chunks
 * around (cx, cz): what a view actually sees lit. EXIT signs glow but light nothing (150 nits over a few dm²), so
 * a view whose only "lights" are exit signs is still a black frame. */
function emittingLights(w: SpawnWorld, s: StoreyId, cx: number, cz: number): number[] {
  const out: number[] = [];
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      const l = w.layout(s, cx + dx, cz + dz);
      for (const f of l.fixtures) {
        if (f.state === LightState.OFF || f.kind === FixtureKind.EXIT_SIGN) continue;
        out.push((cx + dx) * CHUNK_SIZE + f.px, (cz + dz) * CHUNK_SIZE + f.pz);
      }
    }
  }
  return out;
}

/** Distance along (dx, dz) from (x, z) to the first view obstacle (3x3 chunks around the start) spanning eye height y. */
function obstacleDistance(v: CellView, x: number, z: number, dx: number, dz: number, y: number, maxDist: number): number {
  const cx = worldToChunk(x), cz = worldToChunk(z);
  let best = maxDist;
  const idx = Math.abs(dx) > 1e-12 ? 1 / dx : Infinity, idz = Math.abs(dz) > 1e-12 ? 1 / dz : Infinity;
  for (let j = cz - 1; j <= cz + 1; j++) {
    for (let i = cx - 1; i <= cx + 1; i++) {
      const o = v.obstacles(i, j);
      for (let k = 0; k < o.length; k += 6) {
        if (o[k + 4] > y + 0.1 || o[k + 5] < y - 0.5) continue; // does not cover the eye band
        let t0 = 0, t1 = best;
        if (idx === Infinity) { if (x < o[k] || x > o[k + 2]) continue; } else {
          let a = (o[k] - x) * idx, b = (o[k + 2] - x) * idx;
          if (a > b) { const t = a; a = b; b = t; }
          t0 = Math.max(t0, a); t1 = Math.min(t1, b);
        }
        if (idz === Infinity) { if (z < o[k + 1] || z > o[k + 3]) continue; } else {
          let a = (o[k + 1] - z) * idz, b = (o[k + 3] - z) * idz;
          if (a > b) { const t = a; a = b; b = t; }
          t0 = Math.max(t0, a); t1 = Math.min(t1, b);
        }
        if (t0 <= t1) best = t0;
      }
    }
  }
  return best;
}

/** Sightline along (dx, dz): cells, edges and solid / prop obstacles. */
function viewDistance(v: CellView, x: number, z: number, dx: number, dz: number, y: number, zone: number): number {
  const d = obstacleDistance(v, x, z, dx, dz, y, rayDistance(v, x, z, dx, dz, y, SIGHT_MAX));
  if (zone < 0) return d;
  // zone views: the sightline counts only while it stays inside the zone (a zone:NAME view that looks out into the
  // neighbouring district shows the wrong place)
  for (let t = CELL * 0.5; t < d; t += CELL * 0.5) {
    const gi = worldToCell(x + dx * t), gj = worldToCell(z + dz * t);
    if (v.at(gi, gj).cellZone[v.idx(gi, gj)] !== zone) return t;
  }
  return d;
}

const FAN = 0.35; // rad: side rays of the view fan

const LIT_VIEW_R = SIGHT_MAX; // m: emitting fixtures farther than this do not count for / against a view
const LIT_VIEW_COS = 0.6; // ~53 deg half-angle: the horizontal half-FOV at 16:9
const DARK_VIEW_PEN = 12; // zone:DARK: m of sightline lost per unit of lit-view weight above DARK_VIEW_OK ...
const DARK_VIEW_OK = 0.35; // ... (about one fixture 9 m away: a distant light in the dark reads well) ...
const DARK_VIEW_MIN = 0.2; // ... and a flat DARK_VIEW_BLIND loss below this weight (no fixture within ~15 m in view): such a view is a
const DARK_VIEW_BLIND = 6; // black frame, not a picture of the dark zone
const DARK_EXTRA_RINGS = 3; // zone:DARK: chunk rings searched beyond the first one when all its views are blind
const LIT_VIEW_BONUS = 3; // other zone views: m of sightline gained per unit of lit-view weight ...
const LIT_VIEW_BONUS_MAX = 6; // ... capped (a lit establishing shot wins ties; it never beats a much longer view)

/** Lit-view weight of a view along (dx, dz): sum of 3 / max(3, d) over the emitting fixtures (world x, z pairs in `near`)
 * inside the horizontal view cone, more than 1.4 m away (closer ones are above the frame at pitch 0), with a clear
 * eye-height line of sight. 1 = one fixture within 3 m in view. */
function litViewWeight(v: CellView, x: number, z: number, y: number, dx: number, dz: number, near: readonly number[]): number {
  let w = 0;
  for (let i = 0; i < near.length; i += 2) {
    const ex = near[i] - x, ez = near[i + 1] - z, d = Math.hypot(ex, ez);
    if (d < 1.4 || (ex * dx + ez * dz) < LIT_VIEW_COS * d) continue;
    if (!losClear(v, x, z, near[i], near[i + 1], y)) continue;
    w += 3 / Math.max(3, d);
  }
  return w;
}

/** How a zone view values the lit fixtures it shows: `dark` (zone:DARK) looks into the dark, not across into a lit
 * district; `lit` (other zones) prefers an establishing shot that shows its light sources. */
interface LitPref { lights: readonly number[]; dark: boolean }

/** Best-view sightline from a cell: [length, yaw]. Each of the 8 directions is scored by a 3-ray fan
 * (0.5 centre + 0.25 per side ray at +-FAN), so a view threading a narrow gap or grazing a pillar loses to an
 * open one, and ties at the 30 m cap go to the wider view instead of the first direction. With `lit`, every
 * direction also gains (or, dark, loses) sightline for the emitting fixtures in view (litViewWeight). */
function bestView(v: CellView, gi: number, gj: number, zone = -1, lit: LitPref | null = null): [number, number] {
  const x = (gi + 0.5) * CELL, z = (gj + 0.5) * CELL;
  const y = v.floorCm(gi, gj) / 100 + EYE;
  let best = -Infinity, yaw = 0;
  const cf = Math.cos(FAN), sf = Math.sin(FAN);
  let near: number[] | null = null;
  if (lit) {
    near = [];
    const L = lit.lights;
    for (let i = 0; i < L.length; i += 2) {
      const ex = L[i] - x, ez = L[i + 1] - z;
      if (ex * ex + ez * ez <= LIT_VIEW_R * LIT_VIEW_R) near.push(L[i], L[i + 1]);
    }
  }
  for (const [dx, dz] of DIRS) {
    const c = viewDistance(v, x, z, dx, dz, y, zone);
    const l = viewDistance(v, x, z, dx * cf - dz * sf, dx * sf + dz * cf, y, zone);
    const r = viewDistance(v, x, z, dx * cf + dz * sf, -dx * sf + dz * cf, y, zone);
    let d = 0.5 * c + 0.25 * (l + r);
    if (lit && near) {
      const w = near.length ? litViewWeight(v, x, z, y, dx, dz, near) : 0;
      if (!lit.dark) d += Math.min(LIT_VIEW_BONUS_MAX, LIT_VIEW_BONUS * w);
      else d -= DARK_VIEW_PEN * Math.max(0, w - DARK_VIEW_OK) + (w < DARK_VIEW_MIN ? DARK_VIEW_BLIND : 0);
    }
    if (d > best + 1e-9) { best = d; yaw = Math.atan2(-dx, -dz); }
  }
  return [best, yaw];
}

/** Picks the best candidate by base + sightline/5 (sightlines only where they can still win). */
function pickBestView(v: CellView, cands: Cand[], zone = -1, lit: LitPref | null = null): { cand: Cand; score: number; yaw: number } | null {
  if (cands.length === 0) return null;
  const sorted = cands.slice().sort((a, b) => b.base - a.base || a.order - b.order);
  let best: { cand: Cand; score: number; yaw: number } | null = null;
  const maxView = SIGHT_MAX + (lit && !lit.dark ? LIT_VIEW_BONUS_MAX : 0);
  for (const c of sorted) {
    if (best && c.base + maxView / 5 < best.score) break;
    const [len, yaw] = bestView(v, c.gi, c.gj, zone, lit);
    const score = c.base + len / 5;
    if (!best || score > best.score + 1e-9 || (Math.abs(score - best.score) <= 1e-9 && c.order < best.cand.order)) best = { cand: c, score, yaw };
  }
  return best;
}

function toSpawn(s: StoreyId, c: Cand, yaw: number, pitch: number, score: number, reason: string): SpawnPoint {
  return {
    s, x: (c.gi + 0.5) * CELL, y: c.l.floorCm[c.c] / 100, z: (c.gj + 0.5) * CELL, yaw, pitch,
    zone: c.l.cellZone[c.c] as SpawnPoint['zone'], score, reason,
  };
}

/** Candidate cells of one chunk. `order` = global tie-break order (chunk rank · 1024 + cell index). */
function chunkCands(v: CellView, l: ChunkLayout, rank: number, filter: (l: ChunkLayout, c: number) => boolean, lights: readonly number[]): Cand[] {
  const out: Cand[] = [];
  const gi0 = l.key.cx * N, gj0 = l.key.cz * N;
  for (let c = 0; c < N * N; c++) {
    if (!filter(l, c)) continue;
    const gi = gi0 + (c & 31), gj = gj0 + (c >> 5);
    out.push({ gi, gj, base: baseScore(v, gi, gj, lights), order: rank * 1024 + c, l, c });
  }
  return out;
}

const isSpawnOk = (l: ChunkLayout, c: number): boolean => (l.flags[c] & CellFlag.SPAWN_OK) !== 0;
const isSafe = (l: ChunkLayout, c: number): boolean =>
  cellWalkable(l, c) && (l.flags[c] & (CellFlag.RESERVED | CellFlag.SEALED)) === 0;

export function findSpawn(w: SpawnWorld, s: StoreyId): SpawnPoint {
  const v = new CellView(w, s);
  const home = w.districts.districtAt(s, 0, 0).id;
  for (const restrict of [true, false]) {
    const cands: Cand[] = [];
    let rank = 0;
    for (let cz = -1; cz <= 1; cz++) {
      for (let cx = -1; cx <= 1; cx++, rank++) {
        if (restrict && w.districts.districtAt(s, cx, cz).id !== home) continue;
        const l = w.layout(s, cx, cz);
        cands.push(...chunkCands(v, l, rank, isSpawnOk, onLights(w, s, cx, cz)));
      }
    }
    const best = pickBestView(v, cands);
    if (best) return toSpawn(s, best.cand, best.yaw, 0, best.score, `spawn: best of ${cands.length} SPAWN_OK cells`);
  }
  // no lit cell anywhere near the origin: any safe cell, best view
  for (let r = 0; r <= 3; r++) {
    const cands: Cand[] = [];
    let rank = 0;
    for (let cz = -r; cz <= r; cz++) {
      for (let cx = -r; cx <= r; cx++, rank++) {
        if (Math.max(Math.abs(cx), Math.abs(cz)) !== r) continue;
        cands.push(...chunkCands(v, w.layout(s, cx, cz), rank, isSafe, []));
      }
    }
    const best = pickBestView(v, cands);
    if (best) return toSpawn(s, best.cand, best.yaw, 0, best.score, 'spawn: fallback (no SPAWN_OK cell)');
  }
  return { s, x: 0.6, y: 0, z: 0.6, yaw: 0, pitch: 0, zone: w.districts.districtAt(s, 0, 0).zone, score: 0, reason: 'spawn: no walkable cell' };
}

/** Chunks at Chebyshev ring d around (cx, cz), deterministic order (row-major). */
function ring(cx: number, cz: number, d: number, out: [number, number][]): void {
  out.length = 0;
  for (let z = cz - d; z <= cz + d; z++) {
    for (let x = cx - d; x <= cx + d; x++) {
      if (Math.max(Math.abs(x - cx), Math.abs(z - cz)) === d) out.push([x, z]);
    }
  }
}

const SIDE_ANGLE = 0.45; // rad: the side rays of a framing check (well inside the ~0.9 rad horizontal half-FOV)
const SIDE_CLEAR = 1.5; // m: an obstacle closer than this on a side ray fills that side of the frame
const EDGE_ANGLE = 0.75; // rad: the frame-edge rays ...
const EDGE_CLEAR = 1.2; // m: ... an obstacle closer than this there is a slab across that edge of the frame
const CENTRE_CLEAR = 3; // m: an obstacle closer than this straight ahead fills the frame (a rack face, a wall)
/** Framing penalty of a view along the unit (dx, dz) from (x, z): per side, SIDE_CLEAR minus the free distance to
 * the first wall / solid / prop (x 2), and the same straight ahead against CENTRE_CLEAR (props are not part of
 * losClear), so a camera pressed against a rack, facing its face or a wall end loses to one standing clear. */
function sideCrowding(v: CellView, x: number, z: number, dx: number, dz: number, y: number): number {
  const c = Math.cos(SIDE_ANGLE), sn = Math.sin(SIDE_ANGLE), co = Math.cos(EDGE_ANGLE), so = Math.sin(EDGE_ANGLE);
  const ahead = obstacleDistance(v, x, z, dx, dz, y, rayDistance(v, x, z, dx, dz, y, CENTRE_CLEAR));
  let pen = ahead < CENTRE_CLEAR ? 2 * (CENTRE_CLEAR - ahead) : 0;
  for (const k of [1, -1]) {
    const rx = dx * c - k * dz * sn, rz = k * dx * sn + dz * c;
    const free = obstacleDistance(v, x, z, rx, rz, y, rayDistance(v, x, z, rx, rz, y, SIDE_CLEAR));
    if (free < SIDE_CLEAR) pen += 2 * (SIDE_CLEAR - free);
    // frame edge (still inside the ~0.9 rad horizontal half-FOV): a rack side right next to the camera
    const ex = dx * co - k * dz * so, ez = k * dx * so + dz * co;
    const edge = obstacleDistance(v, x, z, ex, ez, y, rayDistance(v, x, z, ex, ez, y, EDGE_CLEAR));
    if (edge < EDGE_CLEAR) pen += 2 * (EDGE_CLEAR - edge);
  }
  return pen;
}

/** `room` (chunk-local room id in the target's chunk): candidates in the same room score +3, so the view is lit by the
 * target itself (a flicker fixture seen through a doorway from a dark room reads as a black frame). */
interface Target { x: number; z: number; y: number; allowReserved: boolean; inside?: [number, number, number, number]; room?: number }

/** 3D line of sight from (x, y0, z) to (tx, ty, tz) through cells and edges: every edge crossing and cell is tested
 * at the height of the line there (a soffit / bulkhead / lowered ceiling band hides a ceiling fixture from an eye
 * whose horizontal ray passes under it). */
function losClear3D(v: CellView, x: number, y0: number, z: number, tx: number, ty: number, tz: number): boolean {
  const d = Math.hypot(tx - x, tz - z);
  if (d < 1e-6) return true;
  const dx = (tx - x) / d, dz = (tz - z) / d, slope = (ty - y0) / d;
  let gi = worldToCell(x), gj = worldToCell(z);
  const stepX = dx > 0 ? 1 : -1, stepZ = dz > 0 ? 1 : -1;
  const adx = Math.abs(dx), adz = Math.abs(dz);
  const tDX = adx > 1e-12 ? CELL / adx : Infinity, tDZ = adz > 1e-12 ? CELL / adz : Infinity;
  let tMX = adx > 1e-12 ? (dx > 0 ? (gi + 1) * CELL - x : x - gi * CELL) / adx : Infinity;
  let tMZ = adz > 1e-12 ? (dz > 0 ? (gj + 1) * CELL - z : z - gj * CELL) / adz : Infinity;
  for (let n = 0; n < 512; n++) {
    let t: number;
    if (tMX <= tMZ) {
      t = tMX;
      if (t >= d) return true;
      const line = dx > 0 ? gi + 1 : gi;
      if (v.exBlocks(line, gj, z + dz * t - gj * CELL, y0 + slope * t)) return false;
      gi += stepX;
      tMX += tDX;
    } else {
      t = tMZ;
      if (t >= d) return true;
      const line = dz > 0 ? gj + 1 : gj;
      if (v.ezBlocks(gi, line, x + dx * t - gi * CELL, y0 + slope * t)) return false;
      gj += stepZ;
      tMZ += tDZ;
    }
    // the line's highest point inside this cell (it rises toward a ceiling target)
    const tOut = Math.min(tMX, tMZ, d);
    if (v.cellBlocks(gi, gj, y0 + slope * Math.max(t, tOut) - 0.02)) return false;
  }
  return true;
}

/** Rays at eye height from (x, z) to the target centre and to points 0.3 m to either side of it are clear of cells,
 * edges, solids and large props (the last 0.6 m excepted: a target mounted on a wall / in a ceiling), and the 3D line
 * from the eye to the target itself is clear (soffits, bulkheads). */
function targetInView(v: CellView, x: number, z: number, tx: number, tz: number, ty: number, eye: number, d: number): boolean {
  const ux = (tx - x) / d, uz = (tz - z) / d;
  for (const off of [0, -0.3, 0.3]) {
    const px = tx - uz * off, pz = tz + ux * off;
    const dd = Math.hypot(px - x, pz - z);
    if (dd < 1e-6) continue;
    const dx = (px - x) / dd, dz = (pz - z) / dd;
    if (obstacleDistance(v, x, z, dx, dz, eye, dd) < dd - 0.6) return false;
    if (off !== 0 && rayDistance(v, x, z, dx, dz, eye, dd) < dd - 0.6) return false;
  }
  // the central part of the frame is open: no door jamb / wall stub right in front of the lens (+-0.12 rad for 3 m,
  // +-0.3 rad for 1.5 m)
  for (const [a, reach] of [[-0.12, 3], [0.12, 3], [-0.3, 1.5], [0.3, 1.5]] as const) {
    const near = Math.min(reach, d - 0.6);
    if (near <= 0) continue;
    const c = Math.cos(a), sn = Math.sin(a);
    const dx = ux * c - uz * sn, dz = ux * sn + uz * c;
    if (rayDistance(v, x, z, dx, dz, eye, near) < near || obstacleDistance(v, x, z, dx, dz, eye, near) < near) return false;
  }
  // stop 0.15 m short of the target (a lamp flush with the ceiling / a sign on a wall)
  const k = Math.max(0, d - 0.15) / d;
  return losClear3D(v, x, eye, z, x + (tx - x) * k, eye + (ty - eye) * k, z + (tz - z) * k);
}

/** Stand 2.5–7 m from the target with a clear view of it; face it. */
function pickNear(v: CellView, w: SpawnWorld, l: ChunkLayout, rank: number, t: Target, reason: string): SpawnPoint | null {
  const s = v.s;
  const lights = onLights(w, s, l.key.cx, l.key.cz);
  const filter = (ll: ChunkLayout, c: number): boolean =>
    cellWalkable(ll, c) && (ll.flags[c] & CellFlag.SEALED) === 0 && (t.allowReserved || (ll.flags[c] & CellFlag.RESERVED) === 0);
  const cands = chunkCands(v, l, rank, filter, lights);
  let best: { c: Cand; score: number } | null = null;
  for (const c of cands) {
    const x = (c.gi + 0.5) * CELL, z = (c.gj + 0.5) * CELL;
    const d = Math.hypot(t.x - x, t.z - z);
    let score = c.base - Math.abs(d - 4.5);
    if (t.inside) {
      const [i0, j0, i1, j1] = t.inside;
      if (c.gi >= i0 && c.gi < i1 && c.gj >= j0 && c.gj < j1) score += 3;
    }
    if (t.room !== undefined && t.room !== 0 && c.l === l && l.room[c.c] === t.room) score += 3;
    if (best && score <= best.score + 1e-9 && !(Math.abs(score - best.score) <= 1e-9 && c.order < best.c.order)) continue;
    const eye = c.l.floorCm[c.c] / 100 + EYE;
    if (d > 0.5 && !losClear(v, x, z, t.x, t.z, eye)) continue;
    // pillars, racks and other solids / large props are not cells: the target (a panel is ~0.6-1.2 m wide) must not
    // hide behind one, nor sit on the silhouette edge of one (rays to its centre and 0.3 m either side) (R2 B9)
    if (d > 0.5 && !targetInView(v, x, z, t.x, t.z, t.y, eye, d)) continue;
    if (d > 0.3) {
      score -= sideCrowding(v, x, z, (t.x - x) / d, (t.z - z) / d, eye);
      if (best && score <= best.score + 1e-9 && !(Math.abs(score - best.score) <= 1e-9 && c.order < best.c.order)) continue;
    }
    best = { c, score };
  }
  if (!best) return null;
  const x = (best.c.gi + 0.5) * CELL, z = (best.c.gj + 0.5) * CELL;
  const dx = t.x - x, dz = t.z - z, d = Math.hypot(dx, dz);
  const yaw = d > 0.3 ? Math.atan2(-dx, -dz) : bestView(v, best.c.gi, best.c.gj)[1];
  const eye = best.c.l.floorCm[best.c.c] / 100 + EYE;
  // a target above eye height (a ceiling fixture) sits in the upper part of the frame (at most 0.4 rad above centre,
  // inside the ~0.6 rad vertical half-FOV) so the frame shows the room it lights rather than mostly ceiling
  const up = Math.atan2(t.y - eye, d);
  const aim = up > 0 ? Math.max(0.4 * up, up - 0.4) : up;
  const pitch = d > 0.3 ? Math.max(-0.6, Math.min(0.9, aim)) : 0;
  return toSpawn(s, best.c, yaw, pitch, best.score, reason);
}

// ---------------------------------------------------------------- subject views (R2 B9)

const SUBJECT_FAN = [-0.6, -0.4, -0.2, 0, 0.2, 0.4, 0.6]; // rad: rays across the frame (half-FOV ~0.9 at 16:9)
const SUBJECT_RANGE = 24; // m: a ray stops counting subject cells after this
const SUBJECT_MIN_OPEN = 4; // m: the centre ray must run this far (no wall 0.5-1 m in front of the lens)
const SUBJECT_YAWS = 16;
const SUBJECT_CAP = 80; // subject cells: seeing this many is a full score (large rooms)
const SUBJECT_TOP = 12; // best candidates that get the (costlier) framing penalty

/** Visits every cell the horizontal ray enters before it is blocked, then the cell whose face / edge blocks it.
 * Returns the open distance (capped at maxDist). Same stepping as rayDistance. */
export function rayCells(v: CellView, x: number, z: number, dx: number, dz: number, y: number, maxDist: number, visit: (gi: number, gj: number) => void): number {
  let gi = worldToCell(x), gj = worldToCell(z);
  visit(gi, gj);
  const stepX = dx > 0 ? 1 : -1, stepZ = dz > 0 ? 1 : -1;
  const adx = Math.abs(dx), adz = Math.abs(dz);
  const tDX = adx > 1e-12 ? CELL / adx : Infinity, tDZ = adz > 1e-12 ? CELL / adz : Infinity;
  let tMX = adx > 1e-12 ? (dx > 0 ? (gi + 1) * CELL - x : x - gi * CELL) / adx : Infinity;
  let tMZ = adz > 1e-12 ? (dz > 0 ? (gj + 1) * CELL - z : z - gj * CELL) / adz : Infinity;
  for (let n = 0; n < 512; n++) {
    let t: number;
    if (tMX <= tMZ) {
      t = tMX;
      if (t > maxDist) return maxDist;
      const line = dx > 0 ? gi + 1 : gi;
      if (v.exBlocks(line, gj, z + dz * t - gj * CELL, y)) { visit(gi + stepX, gj); return t; }
      gi += stepX;
      tMX += tDX;
    } else {
      t = tMZ;
      if (t > maxDist) return maxDist;
      const line = dz > 0 ? gj + 1 : gj;
      if (v.ezBlocks(gi, line, x + dx * t - gi * CELL, y)) { visit(gi, gj + stepZ); return t; }
      gj += stepZ;
      tMZ += tDZ;
    }
    visit(gi, gj);
    if (v.cellBlocks(gi, gj, y)) return t;
  }
  return maxDist;
}

/** What a view along `yaw` from (x, z) at eye height y shows of the subject: distinct subject cells seen by the
 * fan, their mean floor height, and the open distance of the centre ray (cells, edges, solids and props). */
function subjectSeen(v: CellView, x: number, z: number, y: number, yaw: number, subject: (gi: number, gj: number) => boolean): { seen: number; open: number; floorSum: number } {
  const seen = new Set<number>();
  let open = 0, floorSum = 0;
  const visit = (gi: number, gj: number): void => {
    if (!subject(gi, gj)) return;
    const k = (gi + 0x8000) * 0x10000 + (gj + 0x8000);
    if (seen.has(k)) return;
    seen.add(k);
    floorSum += v.floorCm(gi, gj) / 100;
  };
  for (const off of SUBJECT_FAN) {
    const a = yaw + off;
    const dx = -Math.sin(a), dz = -Math.cos(a);
    const d = rayCells(v, x, z, dx, dz, y, SUBJECT_RANGE, visit);
    if (off === 0) open = obstacleDistance(v, x, z, dx, dz, y, d);
  }
  return { seen: seen.size, open, floorSum };
}

interface SubjectSpec {
  /** cells of the subject (global cell coords) */
  subject: (gi: number, gj: number) => boolean;
  /** subject bounding box in global cells [i0, j0, i1, j1) */
  box: [number, number, number, number];
  /** camera may stand inside the box (landmark rooms) or only outside (tower / elevator shafts) */
  inside: boolean;
  /** preferred camera distance (m) from the box: [near, far] (0 = at / inside the frame) */
  dist: [number, number];
  reason: string;
}

/** The best framed view of a subject from the cells of chunk layout `l` (see the header). */
function pickSubjectView(v: CellView, w: SpawnWorld, l: ChunkLayout, rank: number, spec: SubjectSpec): SpawnPoint | null {
  const s = v.s;
  const [bi0, bj0, bi1, bj1] = spec.box;
  let total = 0;
  for (let gj = bj0; gj < bj1; gj++) for (let gi = bi0; gi < bi1; gi++) if (spec.subject(gi, gj)) total++;
  if (total === 0) return null;
  const cap = Math.min(SUBJECT_CAP, total);
  const margin = Math.ceil((spec.dist[1] + 3) / CELL);
  const gi0 = l.key.cx * N, gj0 = l.key.cz * N;
  const lights = emittingLights(w, s, l.key.cx, l.key.cz);
  const scored: { c: Cand; yaw: number; score: number; floorAvg: number; eye: number }[] = [];
  for (let c = 0; c < N * N; c++) {
    const gi = gi0 + (c & 31), gj = gj0 + (c >> 5);
    if (gi < bi0 - margin || gi >= bi1 + margin || gj < bj0 - margin || gj >= bj1 + margin) continue;
    if (!cellWalkable(l, c) || (l.flags[c] & (CellFlag.SEALED | CellFlag.TOWER | CellFlag.ELEVATOR)) !== 0) continue;
    const inBox = gi >= bi0 && gi < bi1 && gj >= bj0 && gj < bj1;
    if (inBox && !spec.inside) continue;
    const x = (gi + 0.5) * CELL, z = (gj + 0.5) * CELL;
    const eye = l.floorCm[c] / 100 + EYE;
    // distance from the camera to the subject box (0 inside)
    const ddx = Math.max(bi0 * CELL - x, 0, x - bi1 * CELL), ddz = Math.max(bj0 * CELL - z, 0, z - bj1 * CELL);
    const dBox = Math.hypot(ddx, ddz);
    const distPen = Math.max(0, spec.dist[0] - dBox) * 0.6 + Math.max(0, dBox - spec.dist[1]) * 0.6;
    let near: number[] | null = null;
    for (let k = 0; k < SUBJECT_YAWS; k++) {
      const yaw = -Math.PI + (k + 0.5) * (2 * Math.PI / SUBJECT_YAWS);
      const dx = -Math.sin(yaw), dz = -Math.cos(yaw);
      if (rayDistance(v, x, z, dx, dz, eye, SUBJECT_MIN_OPEN) < SUBJECT_MIN_OPEN) continue;
      const r = subjectSeen(v, x, z, eye, yaw, spec.subject);
      if (r.seen === 0 || r.open < SUBJECT_MIN_OPEN) continue;
      if (!near) {
        near = [];
        for (let i = 0; i < lights.length; i += 2) if (Math.hypot(lights[i] - x, lights[i + 1] - z) <= LIT_VIEW_R) near.push(lights[i], lights[i + 1]);
      }
      const lit = near.length ? litViewWeight(v, x, z, eye, dx, dz, near) : 0;
      const score = (Math.min(r.seen, cap) / cap) * 10 + (Math.min(r.open, 16) / 16) * 3 + Math.min(2, lit) - distPen;
      scored.push({ c: { gi, gj, base: 0, order: rank * 1024 + c, l, c }, yaw, score, floorAvg: r.floorSum / r.seen, eye });
    }
  }
  if (scored.length === 0) return null;
  scored.sort((a, b) => b.score - a.score || a.c.order - b.c.order);
  let best: (typeof scored)[number] | null = null, bestScore = -Infinity;
  for (let i = 0; i < Math.min(SUBJECT_TOP, scored.length); i++) {
    const e = scored[i];
    const x = (e.c.gi + 0.5) * CELL, z = (e.c.gj + 0.5) * CELL;
    const sc = e.score - 0.5 * sideCrowding(v, x, z, -Math.sin(e.yaw), -Math.cos(e.yaw), e.eye);
    if (sc > bestScore + 1e-9) { bestScore = sc; best = e; }
  }
  if (!best) return null;
  // a subject that lies mostly below the eye (a truck well, a drained pool) tilts the camera down a little
  const drop = best.eye - EYE - best.floorAvg;
  const pitch = spec.inside && drop > 0.5 ? -Math.min(0.25, 0.1 + drop * 0.05) : 0;
  return toSpawn(s, best.c, best.yaw, pitch, bestScore, spec.reason);
}

/** Global-cell bounding box [i0, j0, i1, j1) of the cells of chunk l with any of `flags`, or null. */
function flagBox(l: ChunkLayout, flags: number): [number, number, number, number] | null {
  let i0 = Infinity, j0 = Infinity, i1 = -Infinity, j1 = -Infinity;
  for (let c = 0; c < N * N; c++) {
    if ((l.flags[c] & flags) === 0) continue;
    const i = c & 31, j = c >> 5;
    if (i < i0) i0 = i; if (j < j0) j0 = j; if (i + 1 > i1) i1 = i + 1; if (j + 1 > j1) j1 = j + 1;
  }
  if (i0 === Infinity) return null;
  const gi0 = l.key.cx * N, gj0 = l.key.cz * N;
  return [gi0 + i0, gj0 + j0, gi0 + i1, gj0 + j1];
}

// ---------------------------------------------------------------- focal views (polish)

/** CHAIR_CATHEDRAL: the nave is dark except one pendant over a lone chair, so the generic subject view (which values
 * seeing many frame cells) framed the murky hall. Instead stand behind the lit chair on the nave floor, FOCAL_DIST
 * away, looking past it the way it faces, with the chair and its pendant both in frame. Null if the chair is not
 * found or no cell of the rect has a clear view of it. */
const FOCAL_DIST: [number, number, number] = [4.5, 6.5, 9.5]; // m: min, preferred, max camera distance
function pickChairView(v: CellView, l: ChunkLayout, rect: [number, number, number, number], rank: number, reason: string): SpawnPoint | null {
  const ox = l.key.cx * CHUNK_SIZE, oz = l.key.cz * CHUNK_SIZE;
  const [ri0, rj0, ri1, rj1] = rect;
  const mx = (ri0 + ri1) / 2 * CELL, mz = (rj0 + rj1) / 2 * CELL;
  let chair: { x: number; z: number; y: number; yaw: number } | null = null;
  let cd = Infinity;
  for (const p of l.props) {
    if (p.kind !== PropKind.CHAIR_STACKING) continue;
    const x = ox + p.x, z = oz + p.z, d = Math.hypot(x - mx, z - mz);
    if (d < cd) { cd = d; chair = { x, z, y: p.y, yaw: p.yaw }; }
  }
  if (!chair || cd > 3) return null;
  // the ON light over the chair (pendant)
  let lampY = chair.y + 3.2;
  for (const f of l.fixtures) {
    if (f.state === LightState.OFF) continue;
    if (Math.hypot(ox + f.px - chair.x, oz + f.pz - chair.z) < 1.5) { lampY = f.py; break; }
  }
  const fx = -Math.sin(chair.yaw), fz = -Math.cos(chair.yaw); // the way the chair faces
  let best: { gi: number; gj: number; score: number; d: number } | null = null;
  for (let gj = rj0; gj < rj1; gj++) {
    for (let gi = ri0; gi < ri1; gi++) {
      const cl = v.at(gi, gj), c = v.idx(gi, gj);
      if (!cellWalkable(cl, c) || (cl.flags[c] & CellFlag.SEALED) !== 0) continue;
      const x = (gi + 0.5) * CELL, z = (gj + 0.5) * CELL;
      const dx = chair.x - x, dz = chair.z - z, d = Math.hypot(dx, dz);
      if (d < FOCAL_DIST[0] || d > FOCAL_DIST[2]) continue;
      const align = (dx * fx + dz * fz) / d; // 1: straight behind the chair
      let score = 4 * align - 0.5 * Math.abs(d - FOCAL_DIST[1]);
      if (best && score <= best.score) continue;
      const eye = cl.floorCm[c] / 100 + EYE;
      if (!targetInView(v, x, z, chair.x, chair.z, chair.y + 0.8, eye, d)) continue;
      score -= sideCrowding(v, x, z, dx / d, dz / d, eye);
      if (best && score <= best.score) continue;
      best = { gi, gj, score, d };
    }
  }
  if (!best) return null;
  const x = (best.gi + 0.5) * CELL, z = (best.gj + 0.5) * CELL;
  const cl = v.at(best.gi, best.gj), c = v.idx(best.gi, best.gj);
  const eye = cl.floorCm[c] / 100 + EYE;
  // pitch halfway between the seat and the lamp (both inside the ~0.54 rad vertical half-FOV at these distances)
  const aSeat = Math.atan2(chair.y + 0.45 - eye, best.d), aLamp = Math.atan2(lampY - eye, best.d);
  const pitch = Math.max(-0.35, Math.min(0.2, (aSeat + aLamp) / 2 - 0.04));
  const cand: Cand = { gi: best.gi, gj: best.gj, base: 0, order: rank * 1024 + c, l: cl, c };
  return toSpawn(v.s, cand, Math.atan2(-(chair.x - x), -(chair.z - z)), pitch, best.score, reason);
}

/** Tower: stand on the storey-level landing (end0, y = 0) of the stair shaft over lane B, backed against the
 * perimeter wall, looking up the flight toward the lit upper landing: the frame that reads as "a stairwell" (the
 * outside of the 3.6 x 6 m shaft is a plain block wall with a door; looking down lane A the treads are unlit, and the
 * vestibule is a blank 1.2 m corridor). Lane B (u = 1) ascends from end0 toward +v. */
const TOWER_VIEW = { um: 1.8, vm: 0.55, pitch: 0.1 } as const;
function towerLandingView(s: StoreyId, l: ChunkLayout, site: TowerSite, reason: string): SpawnPoint {
  const f = towerFrame(site);
  const [lx, lz] = f.point(TOWER_VIEW.um, TOWER_VIEW.vm);
  const [dx, dz] = f.dir(0, 1);
  const li = Math.max(0, Math.min(N - 1, worldToCell(lx))), lj = Math.max(0, Math.min(N - 1, worldToCell(lz)));
  return {
    s, x: l.key.cx * CHUNK_SIZE + lx, y: 0, z: l.key.cz * CHUNK_SIZE + lz, yaw: Math.atan2(-dx, -dz), pitch: TOWER_VIEW.pitch,
    zone: l.cellZone[cellIdx(li, lj)] as SpawnPoint['zone'], score: 0, reason,
  };
}

// ---------------------------------------------------------------- clear floor (R2 B9)

const BODY_R = 0.3; // m: the player's footprint radius for the clearance test
const CLEAR_RING = 8; // cells searched around the point

/** Is the point (x, z) a standable floor spot: walkable, unsealed cell, no collide prop / solid box across the
 * body (feet + 0.35 m .. eye) within BODY_R, and the ceiling above feet + eye + 0.1 m? */
export function clearFloorAt(v: CellView, x: number, z: number): boolean {
  const gi = worldToCell(x), gj = worldToCell(z);
  const l = v.at(gi, gj), c = v.idx(gi, gj);
  if (!cellWalkable(l, c) || (l.flags[c] & CellFlag.SEALED) !== 0) return false;
  const floor = l.floorCm[c] / 100;
  if (l.ceilCm[c] / 100 <= floor + EYE + 0.1) return false;
  if (l.blockCm[c] > 35) return false;
  const cx = worldToChunk(x), cz = worldToChunk(z);
  for (let j = cz - 1; j <= cz + 1; j++) {
    for (let i = cx - 1; i <= cx + 1; i++) {
      const o = v.obstacles(i, j);
      for (let k = 0; k < o.length; k += 6) {
        if (o[k + 5] <= floor + 0.35 || o[k + 4] >= floor + EYE) continue; // below the knees / above the eyes
        if (x + BODY_R <= o[k] || x - BODY_R >= o[k + 2] || z + BODY_R <= o[k + 1] || z - BODY_R >= o[k + 3]) continue;
        return false;
      }
    }
  }
  // collide props lower than the obstacle cut-off (desks, tables): the obstacle list keeps props >= 0.9 m only
  const ox = cx * CHUNK_SIZE, oz = cz * CHUNK_SIZE;
  for (const p of l.props) {
    const def = PROP_DEFS[p.kind];
    if (!def || !def.collide || (p.flags & PropFlag.CEILING) !== 0) continue;
    const h = def.size[1] * p.scale;
    if (p.y + h <= floor + 0.35 || p.y >= floor + EYE) continue;
    const q = Math.round(p.yaw / (Math.PI / 2)) & 1;
    const hx = (q ? def.size[2] : def.size[0]) * p.scale / 2, hz = (q ? def.size[0] : def.size[2]) * p.scale / 2;
    const px = ox + p.x, pz = oz + p.z;
    if (x + BODY_R <= px - hx || x - BODY_R >= px + hx || z + BODY_R <= pz - hz || z - BODY_R >= pz + hz) continue;
    return false;
  }
  return true;
}

/** Nearest clear floor spot: the point itself if clear, else the nearest clear cell centre within CLEAR_RING cells. */
function findClear(v: CellView, x: number, z: number): SpawnPoint | null {
  const s = v.s;
  // yaw: the cell's best view (a URL x/z without yaw= faces the open direction instead of yaw 0)
  const at = (px: number, pz: number, score: number, reason: string): SpawnPoint => {
    const gi = worldToCell(px), gj = worldToCell(pz);
    const l = v.at(gi, gj), c = v.idx(gi, gj);
    return { s, x: px, y: l.floorCm[c] / 100, z: pz, yaw: bestView(v, gi, gj)[1], pitch: 0, zone: l.cellZone[c] as SpawnPoint['zone'], score, reason };
  };
  if (clearFloorAt(v, x, z)) return at(x, z, 0, 'clear: the point is clear');
  const fgi = worldToCell(x), fgj = worldToCell(z);
  let bx = 0, bz = 0, bd = Infinity;
  for (let r = 0; r <= CLEAR_RING; r++) {
    for (let dj = -r; dj <= r; dj++) {
      for (let di = -r; di <= r; di++) {
        if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
        const cx = (fgi + di + 0.5) * CELL, cz = (fgj + dj + 0.5) * CELL;
        const d = Math.hypot(cx - x, cz - z);
        if (d >= bd) continue;
        if (clearFloorAt(v, cx, cz)) { bx = cx; bz = cz; bd = d; }
      }
    }
    if (bd <= (r + 0.5) * CELL) break; // no farther ring can be nearer
  }
  return bd < Infinity ? at(bx, bz, -bd, 'clear: nearest standable floor') : null;
}

const MOOD_EXTRA_RINGS = 3; // zone:NAME: rings searched beyond a non-NORMAL-mood result for a NORMAL one

export function findNearest(w: SpawnWorld, query: string, from: { s: StoreyId; x: number; z: number }, maxChunks: number): SpawnPoint | null {
  const s = from.s;
  const q = query.trim();
  const [kindRaw, argRaw = ''] = q.split(':');
  const kind = kindRaw.toLowerCase();
  const arg = argRaw.toUpperCase();
  if (kind === 'spawn') return findSpawn(w, s);
  const v = new CellView(w, s);
  const fcx = worldToChunk(from.x), fcz = worldToChunk(from.z);
  const R = Math.max(0, Math.min(64, Math.floor(maxChunks)));

  if (kind === 'clear') return findClear(v, from.x, from.z);

  if (kind === 'safe') {
    const fgi = worldToCell(from.x), fgj = worldToCell(from.z);
    let best: { gi: number; gj: number; d: number; l: ChunkLayout; c: number } | null = null;
    for (let r = 0; r <= Math.max(1, Math.min(R, 2)) && !best; r++) {
      const cells: [number, number][] = [];
      ring(fcx, fcz, r, cells);
      for (const [cx, cz] of cells) {
        const l = w.layout(s, cx, cz);
        for (let c = 0; c < N * N; c++) {
          if (!isSafe(l, c)) continue;
          const gi = cx * N + (c & 31), gj = cz * N + (c >> 5);
          const d = (gi - fgi) * (gi - fgi) + (gj - fgj) * (gj - fgj);
          if (!best || d < best.d) best = { gi, gj, d, l, c };
        }
      }
    }
    if (!best) return null;
    return {
      s, x: (best.gi + 0.5) * CELL, y: best.l.floorCm[best.c] / 100, z: (best.gj + 0.5) * CELL, yaw: 0, pitch: 0,
      zone: best.l.cellZone[best.c] as SpawnPoint['zone'], score: -Math.sqrt(best.d), reason: 'safe: nearest walkable cell',
    };
  }

  const cells: [number, number][] = [];
  const zoneId = kind === 'zone' ? ZONE_NAMES.indexOf(arg) : -1;
  const lmKind = kind === 'landmark' ? LANDMARK_NAMES.indexOf(arg) : -1;
  const vgKind = kind === 'vignette' ? VIGNETTE_NAMES.indexOf(arg) : -1;
  if ((kind === 'zone' && zoneId < 0) || (kind === 'landmark' && lmKind < 0) || (kind === 'vignette' && vgKind < 0)) return null;
  if (!['zone', 'landmark', 'vignette', 'tower', 'elevator', 'dark', 'water', 'flicker'].includes(kind)) return null;
  const fields = w.fields(s);
  // zone:DARK: a view with no emitting fixture in it at all is a black frame. When the nearest ring only offers
  // such views, look up to DARK_EXTRA_RINGS further out for one that shows a distant light (the best of those
  // wins), and fall back to the nearest blind view otherwise.
  const darkZone = kind === 'zone' && zoneId === Zone.DARK;
  let blindBest: SpawnPoint | null = null;
  let blindRing = -1;
  const isBlind = (p: SpawnPoint): boolean => {
    const cx = worldToChunk(p.x), cz = worldToChunk(p.z);
    const L = emittingLights(w, s, cx, cz);
    const near: number[] = [];
    for (let i = 0; i < L.length; i += 2) if (Math.hypot(L[i] - p.x, L[i + 1] - p.z) <= LIT_VIEW_R) near.push(L[i], L[i + 1]);
    return litViewWeight(v, p.x, p.z, p.y + EYE, -Math.sin(p.yaw), -Math.cos(p.yaw), near) < DARK_VIEW_MIN;
  };

  // zone views outside NORMAL mood are a fallback (see the header)
  let moodBest: SpawnPoint | null = null;
  let moodRing = -1;
  const moodOf = (p: SpawnPoint): number => w.districts.districtAt(s, worldToChunk(p.x), worldToChunk(p.z)).mood;
  for (let d = 0; d <= R; d++) {
    if (blindBest && d > blindRing + DARK_EXTRA_RINGS) return blindBest;
    if (moodBest && d > moodRing + MOOD_EXTRA_RINGS) return moodBest;
    ring(fcx, fcz, d, cells);
    let best: SpawnPoint | null = null;
    let rank = 0;
    for (const [cx, cz] of cells) {
      rank++;
      let res: SpawnPoint | null = null;
      switch (kind) {
        case 'zone': {
          if (w.districts.districtAt(s, cx, cz).zone !== zoneId) break;
          const l = w.layout(s, cx, cz);
          const lights = onLights(w, s, cx, cz);
          const inZone = (ll: ChunkLayout, c: number): boolean => ll.cellZone[c] === zoneId && isSafe(ll, c);
          // the DARK zone is shown from the dark (a lit SPAWN_OK cell there is the exception, and its widest view
          // looks into the few lit rooms): every safe cell competes
          // (and gets no near-light bonus; every emitting fixture it would look at costs sightline, see litViewWeight)
          const dark = zoneId === Zone.DARK;
          const lit = dark ? [] : chunkCands(v, l, rank, (ll, c) => inZone(ll, c) && isSpawnOk(ll, c), lights);
          const pick = pickBestView(v, lit.length ? lit : chunkCands(v, l, rank, inZone, dark ? [] : lights), zoneId, { lights: emittingLights(w, s, cx, cz), dark });
          if (pick) res = toSpawn(s, pick.cand, pick.yaw, 0, pick.score, `zone:${arg} @ chunk ${cx},${cz}`);
          break;
        }
        case 'landmark': {
          const site = w.sites.landmarkAt(s, cx, cz);
          if (!site || site.kind !== lmKind) break;
          const l = w.layout(s, cx, cz);
          const inst = l.landmarks.find((m) => m.kind === lmKind);
          const gi0 = cx * N, gj0 = cz * N;
          const rect: [number, number, number, number] = inst ? [gi0 + inst.i0, gj0 + inst.j0, gi0 + inst.i1, gj0 + inst.j1] : [gi0 + 8, gj0 + 8, gi0 + 24, gj0 + 24];
          const inRect = (gi: number, gj: number): boolean => gi >= rect[0] && gi < rect[2] && gj >= rect[1] && gj < rect[3];
          if (lmKind === LandmarkKind.CHAIR_CATHEDRAL && inst) res = pickChairView(v, l, rect, rank, `landmark:${arg} @ chunk ${cx},${cz} (chair)`);
          res ??= pickSubjectView(v, w, l, rank, { subject: inRect, box: rect, inside: true, dist: [0, 3], reason: `landmark:${arg} @ chunk ${cx},${cz}` });
          if (!res) {
            const tx = (rect[0] + rect[2]) / 2 * CELL, tz = (rect[1] + rect[3]) / 2 * CELL;
            res = pickNear(v, w, l, rank, { x: tx, z: tz, y: EYE, allowReserved: true, inside: rect }, `landmark:${arg} @ chunk ${cx},${cz}`);
          }
          break;
        }
        case 'tower': case 'elevator': {
          const site = kind === 'tower' ? w.sites.towerAt(cx, cz) : w.sites.elevatorAt(cx, cz);
          if (!site) break;
          const e = kind === 'tower' ? towerExitCell(site as Parameters<typeof towerExitCell>[0]) : elevatorExitCell(site as Parameters<typeof elevatorExitCell>[0]);
          const l = w.layout(s, cx, cz);
          if (kind === 'tower') { res = towerLandingView(s, l, site as TowerSite, `tower landing @ chunk ${cx},${cz}`); break; }
          // elevator: frame the structure from outside: its cab cells, their faces and the doorway, 4-9 m away
          const flag = CellFlag.ELEVATOR;
          const box = flagBox(l, flag);
          if (box) {
            const isSub = (gi: number, gj: number): boolean => (v.flags(gi, gj) & flag) !== 0 && gi >= box[0] && gi < box[2] && gj >= box[1] && gj < box[3];
            res = pickSubjectView(v, w, l, rank, { subject: isSub, box, inside: false, dist: [2.5, 9], reason: `${kind} view @ chunk ${cx},${cz}` });
          }
          if (!res) {
            const c = cellIdx(Math.max(0, Math.min(N - 1, e.li)), Math.max(0, Math.min(N - 1, e.lj)));
            res = {
              s, x: cx * CHUNK_SIZE + (e.li + 0.5) * CELL, y: l.floorCm[c] / 100, z: cz * CHUNK_SIZE + (e.lj + 0.5) * CELL,
              yaw: e.yaw, pitch: 0, zone: l.cellZone[c] as SpawnPoint['zone'], score: 0, reason: `${kind} exit @ chunk ${cx},${cz}`,
            };
          }
          break;
        }
        case 'dark': {
          const dk = w.districts.districtAt(s, cx, cz).mood === Mood.DARK;
          if (!dk) {
            // cheap field pre-check on an 8x8 sample grid
            let any = false;
            for (let j = 0; j < 8 && !any; j++) for (let i = 0; i < 8 && !any; i++) {
              if (fields.power(cx * CHUNK_SIZE + (i + 0.5) * 4.8, cz * CHUNK_SIZE + (j + 0.5) * 4.8) < 0.15) any = true;
            }
            if (!any) break;
          }
          const l = w.layout(s, cx, cz);
          const filt = (ll: ChunkLayout, c: number): boolean => isSafe(ll, c) && (dk || ll.power[c] < 0.15 * 256);
          const pick = pickBestView(v, chunkCands(v, l, rank, filt, []));
          if (pick) res = toSpawn(s, pick.cand, pick.yaw, 0, pick.score, `dark @ chunk ${cx},${cz}`);
          break;
        }
        case 'water': {
          if (d > GEN_RING_CAP) break;
          const l = w.layout(s, cx, cz);
          if (l.water.length === 0) break;
          let wr = l.water[0];
          for (const r of l.water) if ((r.x1 - r.x0) * (r.z1 - r.z0) > (wr.x1 - wr.x0) * (wr.z1 - wr.z0)) wr = r;
          res = pickNear(v, w, l, rank, { x: cx * CHUNK_SIZE + (wr.x0 + wr.x1) / 2, z: cz * CHUNK_SIZE + (wr.z0 + wr.z1) / 2, y: wr.y, allowReserved: false }, `water @ chunk ${cx},${cz}`);
          break;
        }
        case 'flicker': {
          if (d > GEN_RING_CAP) break;
          const l = w.layout(s, cx, cz);
          // the FLICKER channel is the one that bursts (an ANOMALY light may sit idle in a capture)
          const f = l.fixtures.find((fx) => fx.dynamic && fx.state === LightState.FLICKER) ?? l.fixtures.find((fx) => fx.dynamic);
          if (!f) break;
          const fc = cellIdx(Math.max(0, Math.min(N - 1, Math.floor(f.px / CELL))), Math.max(0, Math.min(N - 1, Math.floor(f.pz / CELL))));
          res = pickNear(v, w, l, rank, { x: cx * CHUNK_SIZE + f.px, z: cz * CHUNK_SIZE + f.pz, y: f.py, allowReserved: false, room: l.room[fc] }, `flicker @ chunk ${cx},${cz}`);
          break;
        }
        case 'vignette': {
          const x0 = cx * CHUNK_SIZE, z0 = cz * CHUNK_SIZE;
          const pre = vignetteCandidates(w.seed, s, x0, z0, x0 + CHUNK_SIZE, z0 + CHUNK_SIZE,
            (x, z) => w.districts.districtAt(s, worldToChunk(x), worldToChunk(z)).zone as ZoneId).some((c) => c.kind === vgKind || c.alts.includes(vgKind as VignetteKindId));
          if (!pre && d > GEN_RING_CAP) break;
          const l = w.layout(s, cx, cz);
          const vg = l.vignettes.find((x) => x.kind === vgKind);
          if (!vg) break;
          res = pickNear(v, w, l, rank, { x: x0 + vg.x, z: z0 + vg.z, y: 0.5, allowReserved: false }, `vignette:${arg} @ chunk ${cx},${cz}`);
          break;
        }
      }
      if (res && (!best || res.score > best.score)) best = res;
    }
    if (best && darkZone && isBlind(best)) {
      if (!blindBest) { blindBest = best; blindRing = d; }
      continue;
    }
    if (best && kind === 'zone' && !darkZone && moodOf(best) !== Mood.NORMAL) {
      if (!moodBest) { moodBest = best; moodRing = d; }
      continue;
    }
    if (best) return best;
  }
  return blindBest ?? moodBest;
}
