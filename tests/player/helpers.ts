// tests/player/helpers.ts (WP12) — synthetic worlds for the player tests: layouts from ASCII (WP1 layoutFromAscii
// when it agrees with the format, a local parser otherwise) + WP12 buildChunkCollision, queried by a reference
// CollisionWorld / WorldQuery implementation that follows the §5 WP10 query semantics.

import { CELL, CHUNK_CELLS, CHUNK_SIZE, PLAYER, STD_CEIL_CM } from '../../src/core/constants.ts';
import { edgeDefaults } from '../../src/core/edges.ts';
import { EventBus, type GameEvents } from '../../src/core/events.ts';
import { cellIdx, exIdx, ezIdx, worldToCell, worldToChunk } from '../../src/core/grid.ts';
import { CellFlag, EdgeKind, Mood, SolidFlag, type StoreyId, type ZoneId, SurfaceSound, Zone } from '../../src/core/ids.ts';
import { createEmptyLayout, NO_WATER, type ChunkLayout } from '../../src/core/layout.ts';
import type { ChunkCollision, MeshBuffers } from '../../src/core/mesh.ts';
import { INTERACTABLE_PROPS, PROP_DEFS } from '../../src/core/props.ts';
import type {
  DynamicMeshHandle, EmitterRef, FixtureRef, PortalHit, PropHit, WorldQuery,
} from '../../src/core/runtime.ts';
import type { SpawnPoint } from '../../src/core/world.ts';
import { layoutFromAscii } from '../../src/world/ascii.ts';
import { buildChunkCollision, rampHeightAt } from '../../src/player/collisionBuild.ts';
import type { TraversalHost } from '../../src/player/PlayerSystem.ts';

const N = CHUNK_CELLS;
/** Ramp slab thickness under the walking plane (WP10 WorldQueryImpl RAMP_SLAB). */
export const RAMP_SLAB = 0.2;
const EDGE_OF: Record<string, number> = {
  '-': EdgeKind.WALL, '|': EdgeKind.WALL, d: EdgeKind.DOORWAY, h: EdgeKind.HEADER, a: EdgeKind.ARCH, ':': EdgeKind.PARTITION,
  '=': EdgeKind.HALF, '"': EdgeKind.RAIL, w: EdgeKind.WINDOW, '%': EdgeKind.GLITCH, ' ': EdgeKind.OPEN,
};

/** Local parser of the §5 WP1 ASCII format (cells outside the text are SOLID, like WP1's). */
export function parseAscii(s: StoreyId, cx: number, cz: number, text: string): ChunkLayout {
  const l = createEmptyLayout({ s, cx, cz }, Zone.LOBBY, 0, Mood.NORMAL);
  l.ceilCm.fill(STD_CEIL_CM);
  l.flags.fill(CellFlag.SOLID);
  const lines = text.replace(/\r/g, '').split('\n');
  const at = (x: number, y: number): string => (y < lines.length && x < lines[y].length ? lines[y][x] : ' ');
  const H = Math.min(N, Math.floor((lines.length - 1) / 2));
  let W = 0;
  for (const ln of lines) W = Math.max(W, Math.floor((ln.length - 1) / 2));
  W = Math.min(N, W);
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const ch = at(2 * i + 1, 2 * j + 1);
      const c = cellIdx(i, j);
      l.flags[c] = ch === '#' ? CellFlag.SOLID : ch === ' ' ? CellFlag.VOID : 0;
    }
  }
  const setE = (axis: 'x' | 'z', idx: number, ch: string): void => {
    const k = EDGE_OF[ch];
    if (k === undefined) return;
    const e = axis === 'x' ? l.ex : l.ez;
    const d = edgeDefaults(k);
    e.kind[idx] = k; e.hA[idx] = d[0]; e.hB[idx] = d[1];
  };
  for (let j = 0; j < H; j++) for (let i = 0; i <= W; i++) setE('x', exIdx(i, j), at(2 * i, 2 * j + 1));
  for (let j = 0; j <= H; j++) for (let i = 0; i < W; i++) setE('z', ezIdx(i, j), at(2 * i + 1, 2 * j));
  return l;
}

/** layoutFromAscii (WP1) if it parses `text` like the format says, else the local parser. */
export function layoutFrom(text: string, s: StoreyId = 0, cx = 0, cz = 0): ChunkLayout {
  const mine = parseAscii(s, cx, cz, text);
  try {
    const theirs = layoutFromAscii({ s, cx, cz }, text);
    let same = true;
    const mask = CellFlag.SOLID | CellFlag.VOID;
    for (let c = 0; c < N * N && same; c++) if ((theirs.flags[c] & mask) !== (mine.flags[c] & mask)) same = false;
    for (let k = 0; k < mine.ex.kind.length && same; k++) if (theirs.ex.kind[k] !== mine.ex.kind[k] || theirs.ez.kind[k] !== mine.ez.kind[k]) same = false;
    if (same) {
      // keep WP1's layout but normalise the fields the tests set explicitly
      theirs.floorCm.fill(0); theirs.blockCm.fill(0); theirs.waterCm.fill(NO_WATER);
      for (let c = 0; c < N * N; c++) theirs.flags[c] &= CellFlag.SOLID | CellFlag.VOID;
      theirs.props.length = 0; theirs.solids.length = 0; theirs.structures.length = 0;
      return theirs;
    }
  } catch { /* stub or broken parser */ }
  return mine;
}

/** Build a room sketch: `rows` use the ASCII format with the top-left vertex at local cell (0,0). */
export const sketch = (rows: string[]): string => rows.join('\n');

/** Moves an ASCII sketch to local cell (di, dj); everything around it is SOLID. */
export function place(text: string, di: number, dj: number): string {
  const src = text.split('\n');
  const w = Math.max(...src.map((r) => r.length));
  const H = 2 * dj + src.length, W = 2 * di + w;
  const g: string[][] = [];
  for (let r = 0; r < H; r++) {
    const row: string[] = [];
    for (let c = 0; c < W; c++) row.push(r % 2 === 0 && c % 2 === 0 ? '+' : r % 2 === 1 && c % 2 === 1 ? '#' : ' ');
    g.push(row);
  }
  for (let r = 0; r < src.length; r++) for (let c = 0; c < src[r].length; c++) g[2 * dj + r][2 * di + c] = src[r][c];
  return g.map((r) => r.join('')).join('\n');
}

/** Open rectangle of walkable cells [0,w) x [0,h) surrounded by walls. */
export function roomText(w: number, h: number): string {
  const rows: string[] = [];
  let top = '+';
  for (let i = 0; i < w; i++) top += '-+';
  rows.push(top);
  for (let j = 0; j < h; j++) {
    let mid = '|';
    for (let i = 0; i < w; i++) mid += i === w - 1 ? '.|' : '. ';
    rows.push(mid);
    if (j < h - 1) { let sep = '+'; for (let i = 0; i < w; i++) sep += ' +'; rows.push(sep); }
  }
  rows.push(top);
  return rows.join('\n');
}

export function openLayout(s: StoreyId = 0, cx = 0, cz = 0): ChunkLayout {
  const l = createEmptyLayout({ s, cx, cz }, Zone.LOBBY, 0, Mood.NORMAL);
  l.ceilCm.fill(STD_CEIL_CM);
  return l;
}

interface Entry { l: ChunkLayout; c: ChunkCollision; ox: number; oz: number }

/** Reference WorldQuery over explicit layouts (§5 WP10 semantics; allocation is fine in tests). */
export class TestWorld implements WorldQuery {
  storey: StoreyId = 0;
  readonly data = new Map<string, Entry>(); // key `${s}:${cx}:${cz}`

  add(l: ChunkLayout, collision?: ChunkCollision): this {
    this.data.set(`${l.key.s}:${l.key.cx}:${l.key.cz}`, { l, c: collision ?? buildChunkCollision(l), ox: l.key.cx * CHUNK_SIZE, oz: l.key.cz * CHUNK_SIZE });
    return this;
  }
  rebuild(): void { for (const e of this.data.values()) e.c = buildChunkCollision(e.l); }
  private at(x: number, z: number): Entry | null {
    return this.data.get(`${this.storey}:${worldToChunk(x)}:${worldToChunk(z)}`) ?? null;
  }
  private cell(e: Entry, x: number, z: number): number {
    const li = worldToCell(x) - e.l.key.cx * N, lj = worldToCell(z) - e.l.key.cz * N;
    return cellIdx(Math.max(0, Math.min(N - 1, li)), Math.max(0, Math.min(N - 1, lj)));
  }
  private boxesOfCell(e: Entry, c: number): number[] {
    const out: number[] = [];
    for (let k = e.c.cellStart[c]; k < e.c.cellStart[c + 1]; k++) out.push(e.c.cellBoxes[k]);
    return out;
  }

  isLoaded(x: number, z: number): boolean { return this.at(x, z) !== null; }
  floorAt(x: number, z: number, feetY: number): number {
    const e = this.at(x, z);
    if (!e) return NaN;
    const c = this.cell(e, x, z);
    const lim = feetY + PLAYER.stepMax + 1e-6;
    let best = -Infinity;
    const fl = e.l.flags[c];
    if (!(fl & (CellFlag.SOLID | CellFlag.VOID))) {
      const f = e.l.floorCm[c] / 100;
      if (f <= lim) best = f;
    }
    const lx = x - e.ox, lz = z - e.oz;
    for (const b of this.boxesOfCell(e, c)) {
      if (!(e.c.boxFlags[b] & SolidFlag.WALKABLE_TOP)) continue;
      const o = b * 6, bx = e.c.boxes;
      if (lx < bx[o] || lx > bx[o + 3] || lz < bx[o + 2] || lz > bx[o + 5]) continue;
      const top = bx[o + 4];
      if (top <= lim && top > best) best = top;
    }
    for (let o = 0; o < e.c.ramps.length; o += 8) {
      const h = rampHeightAt(e.c.ramps, o, lx, lz);
      if (h === h && h <= lim && h > best) best = h;
    }
    return best;
  }
  ceilingAt(x: number, z: number, y: number): number {
    const e = this.at(x, z);
    if (!e) return Infinity;
    const c = this.cell(e, x, z);
    if (e.l.flags[c] & CellFlag.SOLID) return y;
    let best = Infinity;
    if (!(e.l.flags[c] & CellFlag.NO_CEIL) && e.l.ceilCm[c] / 100 >= y - 1e-6) best = e.l.ceilCm[c] / 100;
    const lx = x - e.ox, lz = z - e.oz;
    for (const b of this.boxesOfCell(e, c)) {
      const o = b * 6, bx = e.c.boxes;
      if (lx < bx[o] || lx > bx[o + 3] || lz < bx[o + 2] || lz > bx[o + 5]) continue;
      if (bx[o + 1] >= y && bx[o + 1] < best) best = bx[o + 1];
    }
    // ramp undersides (a flight's soffit; a FILLED body is solid down to the floor), like WP10's query
    for (let o = 0; o < e.c.ramps.length; o += 8) {
      const h = rampHeightAt(e.c.ramps, o, lx, lz);
      if (h === h && e.c.ramps[o + 7] !== 0) { if (h > y + 1e-6 && y < best) best = y; continue; }
      if (h === h && h - RAMP_SLAB >= y - 1e-6 && h - RAMP_SLAB < best) best = h - RAMP_SLAB;
    }
    return best;
  }
  waterAt(x: number, z: number): number | null {
    const e = this.at(x, z);
    if (!e) return null;
    const w = e.l.waterCm[this.cell(e, x, z)];
    return w === NO_WATER ? null : w / 100;
  }
  surfaceAt(): typeof SurfaceSound[keyof typeof SurfaceSound] { return SurfaceSound.CARPET; }
  boxesNear(x: number, z: number, r: number, out: Float32Array): number {
    let n = 0;
    const cap = (out.length / 6) | 0;
    const seen = new Set<string>();
    for (let gj = worldToCell(z - r); gj <= worldToCell(z + r); gj++) {
      for (let gi = worldToCell(x - r); gi <= worldToCell(x + r); gi++) {
        const e = this.at((gi + 0.5) * CELL, (gj + 0.5) * CELL);
        if (!e) continue;
        const c = cellIdx(gi - e.l.key.cx * N, gj - e.l.key.cz * N);
        for (const b of this.boxesOfCell(e, c)) {
          const key = `${e.l.key.cx}:${e.l.key.cz}:${b}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const o = b * 6, bx = e.c.boxes;
          const x0 = bx[o] + e.ox, z0 = bx[o + 2] + e.oz, x1 = bx[o + 3] + e.ox, z1 = bx[o + 5] + e.oz;
          const qx = Math.max(x0, Math.min(x, x1)), qz = Math.max(z0, Math.min(z, z1));
          if ((qx - x) ** 2 + (qz - z) ** 2 > r * r) continue;
          if (n >= cap) return n;
          out[n * 6] = x0; out[n * 6 + 1] = bx[o + 1]; out[n * 6 + 2] = z0;
          out[n * 6 + 3] = x1; out[n * 6 + 4] = bx[o + 4]; out[n * 6 + 5] = z1;
          n++;
        }
      }
    }
    return n;
  }
  private allPortals(): PortalHit[] {
    const out: PortalHit[] = [];
    for (const e of this.data.values()) {
      if (e.l.key.s !== this.storey) continue;
      for (const st of e.l.structures) if (st.portal) out.push({ spec: st.portal, ox: e.ox, oz: e.oz });
    }
    return out;
  }
  portalAt(x: number, y: number, z: number): PortalHit | null {
    for (const h of this.allPortals()) {
      const m = h.spec.min, M = h.spec.max;
      if (x >= h.ox + m[0] && x <= h.ox + M[0] && z >= h.oz + m[2] && z <= h.oz + M[2] && y >= m[1] && y <= M[1]) return h;
    }
    return null;
  }
  portalsNear(x: number, z: number, r: number, out: PortalHit[]): number {
    let n = 0;
    for (const h of this.allPortals()) {
      const m = h.spec.min, M = h.spec.max;
      const qx = Math.max(h.ox + m[0], Math.min(x, h.ox + M[0])), qz = Math.max(h.oz + m[2], Math.min(z, h.oz + M[2]));
      if ((qx - x) ** 2 + (qz - z) ** 2 <= r * r) out[n++] = h;
    }
    return n;
  }
  propAt(x: number, z: number, yaw: number, maxDist: number): PropHit | null {
    const dx = -Math.sin(yaw), dz = -Math.cos(yaw);
    let best: PropHit | null = null, bestT = maxDist;
    for (const e of this.data.values()) {
      if (e.l.key.s !== this.storey) continue;
      for (const p of e.l.props) {
        if (!INTERACTABLE_PROPS.includes(p.kind)) continue;
        const d = PROP_DEFS[p.kind];
        const q = ((Math.round(p.yaw / (Math.PI / 2)) % 4) + 4) % 4 & 1;
        const hx = (q ? d.size[2] : d.size[0]) / 2 + 0.05, hz = (q ? d.size[0] : d.size[2]) / 2 + 0.05;
        const cx = p.x + e.ox, cz = p.z + e.oz;
        // slab test
        let t0 = 0, t1 = bestT;
        for (const [o, dd, c, h] of [[x, dx, cx, hx], [z, dz, cz, hz]] as const) {
          if (Math.abs(dd) < 1e-9) { if (Math.abs(o - c) > h) { t0 = Infinity; } continue; }
          let a = (c - h - o) / dd, b = (c + h - o) / dd;
          if (a > b) [a, b] = [b, a];
          t0 = Math.max(t0, a); t1 = Math.min(t1, b);
        }
        if (t0 <= t1 && t0 < bestT) { bestT = t0; best = { kind: p.kind, x: cx, y: p.y, z: cz, seed: p.seed, cx: e.l.key.cx, cz: e.l.key.cz }; }
      }
    }
    return best;
  }
  layoutAt(cx: number, cz: number): ChunkLayout | null { return this.data.get(`${this.storey}:${cx}:${cz}`)?.l ?? null; }
  zoneAt(): ZoneId { return Zone.LOBBY; }
  moodAt(): typeof Mood[keyof typeof Mood] { return Mood.NORMAL; }
  fixturesNear(_x: number, _z: number, _r: number, _out: FixtureRef[]): number { return 0; }
  emittersNear(_x: number, _z: number, _r: number, _out: EmitterRef[]): number { return 0; }
  losClear(): boolean { return true; }
  /** Analytic ray vs every collision box at height y (occluding edges collide) and the loaded area. */
  rayDistance(x: number, y: number, z: number, dx: number, dz: number, maxDist: number): number {
    let best = maxDist;
    for (const e of this.data.values()) {
      if (e.l.key.s !== this.storey) continue;
      const b = e.c.boxes;
      for (let o = 0; o < b.length; o += 6) {
        if (y < b[o + 1] || y > b[o + 4]) continue;
        let t0 = 0, t1 = best;
        const x0 = b[o] + e.ox, x1 = b[o + 3] + e.ox, z0 = b[o + 2] + e.oz, z1 = b[o + 5] + e.oz;
        if (Math.abs(dx) < 1e-12) { if (x < x0 || x > x1) continue; } else {
          let a = (x0 - x) / dx, c = (x1 - x) / dx; if (a > c) [a, c] = [c, a];
          t0 = Math.max(t0, a); t1 = Math.min(t1, c);
        }
        if (Math.abs(dz) < 1e-12) { if (z < z0 || z > z1) continue; } else {
          let a = (z0 - z) / dz, c = (z1 - z) / dz; if (a > c) [a, c] = [c, a];
          t0 = Math.max(t0, a); t1 = Math.min(t1, c);
        }
        if (t0 <= t1 && t0 < best) best = t0;
      }
    }
    // unloaded space is opaque
    for (let t = 0; t < best; t += 0.6) if (!this.isLoaded(x + dx * t, z + dz * t)) { best = t; break; }
    return best;
  }
  edgeSound(): number { return 1; }
  cellWalkable(gi: number, gj: number): boolean {
    const e = this.at((gi + 0.5) * CELL, (gj + 0.5) * CELL);
    if (!e) return false;
    const c = cellIdx(gi - e.l.key.cx * N, gj - e.l.key.cz * N);
    return !(e.l.flags[c] & (CellFlag.SOLID | CellFlag.VOID | CellFlag.NOWALK)) && e.l.blockCm[c] === 0;
  }
}

/** Recording traversal host. */
export class TestHost implements TraversalHost {
  prefetched = new Set<StoreyId>([0, 1, 2]);
  prefetchCalls: { s: StoreyId; x: number; z: number }[] = [];
  switches: StoreyId[] = [];
  attached: { key: string; m: MeshBuffers; off: [number, number, number]; disposed: boolean }[] = [];
  safe: SpawnPoint | null = null;
  private world: TestWorld | null;
  constructor(world: TestWorld | null = null) { this.world = world; }
  prefetch(s: StoreyId, x: number, z: number): void { this.prefetchCalls.push({ s, x, z }); }
  isPrefetched(s: StoreyId): boolean { return this.prefetched.has(s); }
  switchStorey(to: StoreyId): void { this.switches.push(to); if (this.world) this.world.storey = to; }
  findSafeSpawn(s: StoreyId, x: number, z: number): Promise<SpawnPoint | null> {
    return Promise.resolve(this.safe ? { ...this.safe, s } : { s, x, y: 0, z, yaw: 0, pitch: 0, zone: 0, score: 0, reason: 'test' });
  }
  attachDynamicMesh(key: string, m: MeshBuffers): DynamicMeshHandle | null {
    const rec = { key, m, off: [0, 0, 0] as [number, number, number], disposed: false };
    this.attached.push(rec);
    return { setOffset(x, y, z) { rec.off = [x, y, z]; }, dispose() { rec.disposed = true; } };
  }
}

export type Recorded = { [K in keyof GameEvents]?: GameEvents[K][] };
/** A bus that records every event (with the time it was emitted, via `clock`). */
export function recordingBus(clock: () => number = () => 0): { bus: EventBus<GameEvents>; ev: Recorded; times: Record<string, number[]> } {
  const bus = new EventBus<GameEvents>();
  const ev: Recorded = {};
  const times: Record<string, number[]> = {};
  const orig = bus.emit.bind(bus);
  bus.emit = ((k: keyof GameEvents, e: never) => {
    ((ev[k] ??= []) as unknown[]).push(e);
    (times[k] ??= []).push(clock());
    orig(k, e);
  }) as typeof bus.emit;
  return { bus, ev, times };
}

export const spawnAt = (x: number, z: number, yaw = 0, s: StoreyId = 0, y = 0): SpawnPoint =>
  ({ s, x, y, z, yaw, pitch: 0, zone: 0, score: 0, reason: 'test' });

export function input(o: Partial<{ moveX: number; moveZ: number; sprint: boolean; crouch: boolean; lookDX: number; lookDY: number; interactPressed: boolean }> = {}) {
  return { moveX: 0, moveZ: 0, lookDX: 0, lookDY: 0, sprint: false, crouch: false, flashlightPressed: false, interactPressed: false, ...o };
}

/** Yaw that looks along the world direction (dx, dz). */
export const yawOf = (dx: number, dz: number): number => Math.atan2(-dx, -dz);
