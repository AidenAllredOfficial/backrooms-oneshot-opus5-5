// R2 (B4) — exploration pacing: landmark / hero-room density, hero tier invariants and a curious-wanderer walk.
//
// The wanderer (after /tmp/lvl/wander.ts) walks cell to cell (1.2 m), prefers going straight and unvisited cells,
// drifts its heading every 200 steps, and turns only at real openings. It "meets" a landmark / hero room when the
// landmark rect comes within 10 cells (12 m) and a vignette within 12 m. Target (docs/contract-changes/R2-landmarks.md):
// something memorable every 150-300 m; >= 1.5 landmarks or hero rooms per km on every storey.
import { describe, expect, it } from 'vitest';
import { CHUNK_CELLS } from '../../src/core/constants.ts';
import { EDGE_WALKABLE } from '../../src/core/edges.ts';
import { cellIdx, exIdx, ezIdx } from '../../src/core/grid.ts';
import { CellFlag, EdgeKind, LANDMARK_COUNT, LANDMARK_NAMES, type StoreyId, type ZoneId } from '../../src/core/ids.ts';
import type { ChunkLayout } from '../../src/core/layout.ts';
import { hashString, Rng } from '../../src/core/rng.ts';
import type { WorldGen, WorldGenOptions } from '../../src/core/world.ts';
import { createDistricts } from '../../src/world/districts.ts';
import { heroKindsFor, LANDMARKS } from '../../src/world/landmarks/index.ts';
import { createSites } from '../../src/world/sites.ts';
import { createWorldGen } from '../../src/world/worldgen.ts';

const N = CHUNK_CELLS;
const opts = (seedText: string, o: Partial<WorldGenOptions> = {}): WorldGenOptions => ({
  seed: hashString(seedText), seedText, forceZone: null, forceMood: null, forceLandmark: null, testScene: null, lights: 'default', ...o,
});
const CHUNK_KM2 = (N * 1.2 / 1000) ** 2;

/** gapsNew: per landmark / vignette stretch, the distance walked over cells this run had not visited before. The
 * wanderer sometimes circles an explored 15-40 m pocket for 500-1000 steps (its heading drifts only every 200 steps)
 * after it has already met every vignette there; those loops inflate the raw stretch (up to ~1.2 km) without being
 * new ground. */
interface WalkStats { km: number; landmarks: number; gapsL: number[]; gapsLV: number[]; gapsNew: number[] }

/** One deterministic wanderer run of `steps` cells on storey s; returns encounter statistics. */
function wander(gen: WorldGen, s: StoreyId, runSeed: string, steps: number): WalkStats {
  const cache = new Map<string, ChunkLayout>();
  const lay = (cx: number, cz: number): ChunkLayout => {
    const k = `${cx},${cz}`;
    let l = cache.get(k);
    if (!l) {
      if (cache.size > 160) cache.delete(cache.keys().next().value as string);
      l = gen.generateChunk({ s, cx, cz });
      cache.set(k, l);
    }
    return l;
  };
  const at = (gi: number, gj: number): { l: ChunkLayout; li: number; lj: number; c: number } => {
    const cx = Math.floor(gi / N), cz = Math.floor(gj / N);
    const l = lay(cx, cz);
    const li = gi - N * cx, lj = gj - N * cz;
    return { l, li, lj, c: cellIdx(li, lj) };
  };
  const walkable = (gi: number, gj: number): boolean => {
    const { l, c } = at(gi, gj);
    return (l.flags[c] & (CellFlag.SOLID | CellFlag.VOID | CellFlag.NOWALK | CellFlag.TOWER | CellFlag.ELEVATOR)) === 0 && l.blockCm[c] === 0;
  };
  const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]];
  const pass = (gi: number, gj: number, d: number): boolean => {
    const { l, li, lj, c } = at(gi, gj);
    const ex = d === 0 || d === 2;
    const k = ex ? exIdx(d === 0 ? li + 1 : li, lj) : ezIdx(li, d === 1 ? lj + 1 : lj);
    const kind = ex ? l.ex.kind[k] : l.ez.kind[k], h = ex ? l.ex.hA[k] : l.ez.hA[k];
    if (!EDGE_WALKABLE[kind] || (kind === EdgeKind.HEADER && h < 190)) return false;
    const ni = gi + DIRS[d][0], nj = gj + DIRS[d][1];
    if (!walkable(ni, nj)) return false;
    const b = at(ni, nj);
    return Math.abs(b.l.floorCm[b.c] - l.floorCm[c]) <= 36 || l.solids.some((x) => x.kind === 'ramp') || b.l.solids.some((x) => x.kind === 'ramp');
  };
  const rng = new Rng(hashString(runSeed));
  let gi = rng.int(-60, 60), gj = rng.int(-60, 60);
  for (let t = 0; t < 800 && !walkable(gi, gj); t++) { gi = rng.int(-60, 60); gj = rng.int(-60, 60); }
  let dir = rng.int(0, 3), head = rng.float() * Math.PI * 2;
  const visited = new Map<number, number>();
  const seen = new Set<string>();
  const evL: number[] = [0], evLV: number[] = [0];
  const everVisited = new Set<number>(), gapsNew: number[] = [];
  let done = 0, fresh = 0;
  for (let step = 0; step < steps; step++, done++) {
    const cx0 = Math.floor(gi / N), cz0 = Math.floor(gj / N);
    if (!everVisited.has(gi * 100003 + gj)) { everVisited.add(gi * 100003 + gj); fresh++; }
    const nEv = evLV.length;
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const L = lay(cx0 + dx, cz0 + dz);
      const oi = L.key.cx * N, oj = L.key.cz * N;
      for (const m of L.landmarks) {
        const d = Math.max(0, oi + m.i0 - gi, gi - (oi + m.i1 - 1), oj + m.j0 - gj, gj - (oj + m.j1 - 1));
        const k = `L${L.key.cx},${L.key.cz},${m.kind}`;
        if (d <= 10 && !seen.has(k)) { seen.add(k); evL.push(step); evLV.push(step); }
      }
      for (const v of L.vignettes) {
        const k = `V${L.key.cx},${L.key.cz},${v.x},${v.z}`;
        if (!seen.has(k) && Math.hypot(v.x + oi * 1.2 - (gi + 0.5) * 1.2, v.z + oj * 1.2 - (gj + 0.5) * 1.2) < 12) { seen.add(k); evLV.push(step); }
      }
    }
    if (evLV.length > nEv) { gapsNew.push(fresh * 1.2); fresh = 0; }
    const key = gi * 100003 + gj;
    visited.set(key, (visited.get(key) ?? 0) + 1);
    if (step % 200 === 199) head += (rng.float() - 0.5) * Math.PI;
    let best = -1, bestScore = -1e9;
    for (let d = 0; d < 4; d++) {
      if (!pass(gi, gj, d)) continue;
      const v = visited.get((gi + DIRS[d][0]) * 100003 + gj + DIRS[d][1]) ?? 0;
      let sc = -v * 3 + rng.float() * 2.2 + 2.0 * (DIRS[d][0] * Math.cos(head) + DIRS[d][1] * Math.sin(head));
      if (d === dir) sc += 1.5;
      if (d === (dir + 2) % 4) sc -= 2;
      if (sc > bestScore) { bestScore = sc; best = d; }
    }
    if (best < 0) break;
    dir = best;
    gi += DIRS[dir][0];
    gj += DIRS[dir][1];
  }
  evL.push(done);
  evLV.push(done);
  gapsNew.push(fresh * 1.2);
  const gaps = (ev: number[]): number[] => ev.slice(1).map((e, i) => (e - ev[i]) * 1.2);
  return { km: (done * 1.2) / 1000, landmarks: evL.length - 2, gapsL: gaps(evL), gapsLV: gaps(evLV), gapsNew };
}

const quantile = (a: number[], p: number): number => {
  const b = [...a].sort((x, y) => x - y);
  return b[Math.min(b.length - 1, Math.floor(p * b.length))];
};

describe('landmark density (sites)', () => {
  it('>= 25 regular landmarks per km² on every storey, every kind appears across 8 seeds', () => {
    const R = 20;
    const seenKinds = new Set<number>();
    for (const s of [0, 1, 2] as StoreyId[]) {
      let regular = 0, all = 0, chunks = 0;
      for (const seedText of ['1', '2', '3', '4', '5', '6', '7', '8']) {
        const g = createWorldGen(opts(seedText));
        for (let cz = -R; cz < R; cz++) for (let cx = -R; cx < R; cx++) {
          chunks++;
          const lm = g.landmarkAt(s, cx, cz);
          if (!lm) continue;
          all++;
          seenKinds.add(lm.kind);
          if (!LANDMARKS[lm.kind].heroOnly) regular++;
        }
      }
      const km2 = chunks * CHUNK_KM2;
      expect(regular / km2, `storey ${s} regular landmarks / km²`).toBeGreaterThanOrEqual(25);
      expect(all / km2, `storey ${s} landmarks + hero rooms / km²`).toBeGreaterThanOrEqual(50);
    }
    const missing = LANDMARK_NAMES.filter((_, k) => !seenKinds.has(k));
    expect(missing, 'kinds never placed').toEqual([]);
    expect(seenKinds.size).toBe(LANDMARK_COUNT);
  });

  it('landmark sites stay >= 2 chunks apart; hero rooms never share a chunk with a tower, elevator or artery', () => {
    const g = createDistricts(opts('9'));
    const sites = createSites(hashString('9'), null, g);
    const cell: [number, number] = [0, 0];
    for (const s of [0, 1, 2] as StoreyId[]) {
      const regular: { cx: number; cz: number }[] = [];
      for (let cz = -40; cz < 40; cz++) for (let cx = -40; cx < 40; cx++) {
        const lm = sites.landmarkAt(s, cx, cz);
        if (!lm) continue;
        expect(sites.towerAt(cx, cz)).toBeNull();
        expect(sites.elevatorAt(cx, cz)).toBeNull();
        g.siteCellOf(s, cx, cz, cell);
        const hero = sites.heroOfSite(s, cell[0], cell[1]);
        if (hero && hero.cx === cx && hero.cz === cz) expect(sites.arteriesInChunk(cx, cz).length).toBe(0);
        else regular.push(lm);
      }
      for (let i = 0; i < regular.length; i++) for (let j = i + 1; j < regular.length; j++) {
        const d = Math.max(Math.abs(regular[i].cx - regular[j].cx), Math.abs(regular[i].cz - regular[j].cz));
        expect(d, `${JSON.stringify(regular[i])} ${JSON.stringify(regular[j])}`).toBeGreaterThanOrEqual(2);
      }
    }
  });
});

describe('hero rooms', () => {
  it('every district with an eligible zone gets one hero room of its zone, inside its own territory', () => {
    const o = opts('11');
    const d = createDistricts(o);
    const sites = createSites(o.seed >>> 0, null, d);
    const cell: [number, number] = [0, 0];
    for (const s of [0, 1, 2] as StoreyId[]) {
      let eligible = 0, placed = 0;
      for (let sz = -12; sz <= 12; sz++) for (let sx = -12; sx <= 12; sx++) {
        const di = d.districtBySite(s, sx, sz);
        const kinds = heroKindsFor(s, di.zone as ZoneId);
        const h = sites.heroOfSite(s, sx, sz);
        if (kinds.length === 0) { expect(h).toBeNull(); continue; }
        eligible++;
        if (!h) continue;
        placed++;
        expect(kinds).toContain(h.kind);
        expect(LANDMARKS[h.kind].hero).toContain(di.zone);
        d.siteCellOf(s, h.cx, h.cz, cell);
        expect(cell).toEqual([sx, sz]);
        expect(sites.landmarkAt(s, h.cx, h.cz)).toEqual(h);
      }
      expect(placed / eligible, `storey ${s}`).toBeGreaterThan(0.9);
    }
  });

  it('hero rooms are deterministic and storey-free structures are unaffected', () => {
    const a = createWorldGen(opts('5')), b = createWorldGen(opts('5'));
    for (const s of [0, 1, 2] as StoreyId[]) {
      for (let cz = -6; cz < 6; cz++) for (let cx = -6; cx < 6; cx++) expect(a.landmarkAt(s, cx, cz)).toEqual(b.landmarkAt(s, cx, cz));
    }
    // towers / elevators do not depend on the storey (the periodic stair and the lifts line up)
    for (let cz = -8; cz < 8; cz++) for (let cx = -8; cx < 8; cx++) {
      const t = a.towersNear(0, cx, cz), e = a.elevatorsNear(0, cx, cz);
      expect(a.towersNear(1, cx, cz)).toEqual(t);
      expect(a.towersNear(2, cx, cz)).toEqual(t);
      expect(a.elevatorsNear(2, cx, cz)).toEqual(e);
    }
  });

  it('goto=landmark:NAME resolves new kinds and hero rooms (findNearest lands inside the stamped rect)', () => {
    const g = createWorldGen(opts('7'));
    for (const [name, s] of [['LIGHT_WELL', 0], ['MOTEL_CORRIDOR', 1], ['SLIDE_TOWER', 2], ['CRT_WALL', 0], ['SUMP_PIT', 1]] as [string, StoreyId][]) {
      const p = g.findNearest(`landmark:${name}`, { s, x: 0, z: 0 }, 24);
      expect(p, name).not.toBeNull();
      if (!p) continue;
      const cx = Math.floor(p.x / (N * 1.2)), cz = Math.floor(p.z / (N * 1.2));
      const site = g.landmarkAt(s, cx, cz);
      expect(site && LANDMARK_NAMES[site.kind], name).toBe(name);
    }
  });
});

describe('curious-wanderer pacing', () => {
  it('>= 1.5 landmarks or hero rooms per km on every storey; the gaps stay short', () => {
    const report: string[] = [];
    for (const s of [0, 1, 2] as StoreyId[]) {
      let km = 0, landmarks = 0;
      const gapsL: number[] = [], gapsLV: number[] = [], gapsNew: number[] = [];
      for (const seedText of ['1', '2', '3']) {
        const g = createWorldGen(opts(seedText));
        for (let run = 0; run < 2; run++) {
          const r = wander(g, s, `pace:${seedText}:${s}:${run}`, 2000);
          km += r.km;
          landmarks += r.landmarks;
          gapsL.push(...r.gapsL);
          gapsLV.push(...r.gapsLV);
          gapsNew.push(...r.gapsNew);
        }
      }
      const rate = landmarks / km;
      report.push(`storey ${s}: ${rate.toFixed(2)} landmarks/km over ${km.toFixed(1)} km; landmark gap p50 ${quantile(gapsL, 0.5).toFixed(0)} m, ` +
        `with vignettes p50 ${quantile(gapsLV, 0.5).toFixed(0)} p90 ${quantile(gapsLV, 0.9).toFixed(0)} max ${Math.max(...gapsLV).toFixed(0)} m; new ground between them max ${Math.max(...gapsNew).toFixed(0)} m`);
      expect(rate, report[report.length - 1]).toBeGreaterThanOrEqual(1.5);
      // median distance between landmark / hero-room encounters: "something memorable every 150-300 m" (+ margin)
      expect(quantile(gapsL, 0.5), report[report.length - 1]).toBeLessThanOrEqual(420);
      // with vignettes (B6 raises their density): 90% of all stretches are shorter than 320 m
      expect(quantile(gapsLV, 0.9), report[report.length - 1]).toBeLessThanOrEqual(320);
      // polish: vignette fallback kinds (open / flooded halls) -- no stretch of new ground longer than ~300 m
      expect(Math.max(...gapsNew), report[report.length - 1]).toBeLessThanOrEqual(300);
    }
    console.log(report.join('\n'));
  }, 240_000);
});
