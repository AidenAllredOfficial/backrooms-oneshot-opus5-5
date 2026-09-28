// WP1 — seams (agreement, ports, boundary mix, PATTERN runs, artery lanes) and sites (towers, elevators,
// arteries, landmarks: eligibility and seam margins).
import { describe, expect, it } from 'vitest';
import { ARTERY, CHUNK_CELLS, ELEVATOR, TOWER } from '../../src/core/constants.ts';
import { exIdx, ezIdx } from '../../src/core/grid.ts';
import { EdgeKind, EdgeTrim, LandmarkKind, SeamMode, type StoreyId, Zone } from '../../src/core/ids.ts';
import type { ChunkLayout } from '../../src/core/layout.ts';
import { Rng } from '../../src/core/rng.ts';
import { elevatorFootprint, towerFootprint, type WorldGenOptions } from '../../src/core/world.ts';
import { ZONE_INFO } from '../../src/core/zones.ts';
import { createDistricts } from '../../src/world/districts.ts';
import { createSeams, seamEdgeWalkable } from '../../src/world/seams.ts';
import { createSites } from '../../src/world/sites.ts';
import { createWorldGen } from '../../src/world/worldgen.ts';
import { generatorFor } from '../../src/world/zones/registry.ts';

const N = CHUNK_CELLS;
const opts = (seed: number, o: Partial<WorldGenOptions> = {}): WorldGenOptions => ({
  seed, seedText: String(seed), forceZone: null, forceMood: null, forceLandmark: null, testScene: null, lights: 'default', ...o,
});
const worlds = (seed: number) => {
  const districts = createDistricts(opts(seed));
  const sites = createSites(seed, null);
  const seams = createSeams(seed, districts, sites, (s, d) => generatorFor(d.zone).palette(s, d));
  return { districts, sites, seams };
};
const walkRuns = (kind: Uint8Array, hA: Int16Array): number => {
  let runs = 0, prev = false;
  for (let i = 0; i < N; i++) { const w = seamEdgeWalkable(kind[i], hA[i]); if (w && !prev) runs++; prev = w; }
  return runs;
};
const maxWallRun = (kind: Uint8Array, hA: Int16Array): number => {
  let best = 0, run = 0;
  for (let i = 0; i < N; i++) { if (!seamEdgeWalkable(kind[i], hA[i])) best = Math.max(best, ++run); else run = 0; }
  return best;
};

describe('seams', () => {
  it('2000+ adjacent generated pairs: A line 32 equals B line 0 for all 6 edge arrays', { tags: ['sweep'] }, () => {
    const rng = new Rng(77);
    let pairs = 0;
    for (const s of [0, 1, 2] as StoreyId[]) {
      const g = createWorldGen(opts(1000 + s));
      const ox = rng.int(-500, 500), oz = rng.int(-500, 500);
      const W = 20, H = 19;
      const ls: ChunkLayout[] = [];
      for (let z = 0; z < H; z++) for (let x = 0; x < W; x++) ls.push(g.generateChunk({ s, cx: ox + x, cz: oz + z }));
      let bad = 0;
      for (let z = 0; z < H; z++) {
        for (let x = 0; x < W; x++) {
          const a = ls[z * W + x];
          if (x + 1 < W) {
            const b = ls[z * W + x + 1];
            pairs++;
            for (const f of ['kind', 'hA', 'hB', 'matNeg', 'matPos', 'trim'] as const) {
              for (let c = 0; c < N; c++) if (a.ex[f][exIdx(N, c)] !== b.ex[f][exIdx(0, c)]) bad++;
            }
          }
          if (z + 1 < H) {
            const b = ls[(z + 1) * W + x];
            pairs++;
            for (const f of ['kind', 'hA', 'hB', 'matNeg', 'matPos', 'trim'] as const) {
              for (let c = 0; c < N; c++) if (a.ez[f][ezIdx(c, N)] !== b.ez[f][ezIdx(c, 0)]) bad++;
            }
          }
        }
      }
      expect(bad, `storey ${s}`).toBe(0);
    }
    expect(pairs).toBeGreaterThanOrEqual(2000);
  });

  it('every seam has a port; hard BOUNDARY seams have >= 2 openings; PATTERN seams have no wall run > 12', () => {
    const rng = new Rng(4);
    let hard = 0, pattern = 0;
    for (let i = 0; i < 6000; i++) {
      const seed = 1 + (i % 7);
      const { seams } = worlds(seed);
      const s = (i % 3) as StoreyId, axis = i & 1 ? 'x' : 'z';
      const cx = rng.int(-300, 300), cz = rng.int(-300, 300);
      const sp = seams.seam(s, axis, cx, cz);
      const cls = seams.classify(s, axis, cx, cz);
      expect(sp.kind.length).toBe(N);
      expect(walkRuns(sp.kind, sp.hA)).toBeGreaterThanOrEqual(1);
      if (cls.boundary && !cls.soft) {
        hard++;
        expect(cls.openings).toBeGreaterThanOrEqual(2);
        expect(walkRuns(sp.kind, sp.hA)).toBeGreaterThanOrEqual(2);
      }
      if (sp.mode === SeamMode.PATTERN) { pattern++; expect(maxWallRun(sp.kind, sp.hA)).toBeLessThanOrEqual(12); }
      // the function is pure: same answer twice
      const again = seams.seam(s, axis, cx, cz);
      expect(Array.from(again.kind)).toEqual(Array.from(sp.kind));
    }
    expect(hard).toBeGreaterThan(100);
    expect(pattern).toBeGreaterThan(100);
  });

  it('soft BOUNDARY seams are 40% ± 5% of eligible district pairs (one decision per pair)', () => {
    let eligible = 0, soft = 0, inconsistent = 0;
    for (const s of [0, 2] as StoreyId[]) {
      const { seams, districts } = worlds(555 + s);
      const pairs = new Map<string, boolean>();
      for (let cz = -60; cz < 60; cz++) {
        for (let cx = -60; cx < 60; cx++) {
          for (const axis of ['x', 'z'] as const) {
            const c = seams.classify(s, axis, cx, cz);
            if (!c.boundary) continue;
            if (!c.softEligible) { expect(c.soft).toBe(false); continue; }
            const a = districts.districtAt(s, axis === 'x' ? cx - 1 : cx, axis === 'x' ? cz : cz - 1).id >>> 0;
            const b = districts.districtAt(s, cx, cz).id >>> 0;
            const key = a < b ? `${a},${b}` : `${b},${a}`;
            const prev = pairs.get(key);
            if (prev === undefined) { pairs.set(key, c.soft); eligible++; if (c.soft) soft++; }
            else if (prev !== c.soft) inconsistent++;
          }
        }
      }
    }
    expect(inconsistent, 'every seam of a district pair has the same soft/hard decision').toBe(0);
    expect(eligible).toBeGreaterThan(1000);
    expect(Math.abs(soft / eligible - 0.4)).toBeLessThanOrEqual(0.05);
  });

  it('hard boundary styles follow styleFor', () => {
    const { seams, districts } = worlds(31);
    let checked = 0, rollups = 0;
    for (let cz = -80; cz < 80 && checked < 400; cz++) {
      for (let cx = -80; cx < 80 && checked < 400; cx++) {
        const s: StoreyId = 1;
        const c = seams.classify(s, 'x', cx, cz);
        if (!c.boundary || c.soft) continue;
        const zA = districts.districtAt(s, cx - 1, cz).zone, zB = districts.districtAt(s, cx, cz).zone;
        const sp = seams.seam(s, 'x', cx, cz);
        const kinds = new Set(Array.from(sp.kind));
        if (zA === Zone.PARKING || zB === Zone.PARKING || zA === Zone.WAREHOUSE || zB === Zone.WAREHOUSE) {
          rollups++;
          expect(c.style).toBe('rollup');
          expect(kinds.has(EdgeKind.HEADER)).toBe(true);
          expect(Array.from(sp.trim).some((t) => (t & EdgeTrim.ROLLUP) !== 0)).toBe(true);
          for (let i = 0; i < N; i++) {
            if (sp.kind[i] !== EdgeKind.HEADER) continue;
            expect(sp.hA[i]).toBeGreaterThanOrEqual(220);
            const ceil = Math.min(generatorFor(zA).palette(s, districts.districtAt(s, cx - 1, cz)).ceilCm, generatorFor(zB).palette(s, districts.districtAt(s, cx, cz)).ceilCm);
            expect(sp.hA[i]).toBeLessThanOrEqual(Math.max(220, ceil - 30));
          }
        } else if (ZONE_INFO[zA].open || ZONE_INFO[zB].open) {
          expect(c.style).toBe('wide');
          const want = zA === Zone.POOLROOMS || zB === Zone.POOLROOMS ? EdgeKind.ARCH : EdgeKind.OPEN;
          expect(Array.from(sp.kind).every((k) => k === EdgeKind.WALL || k === want)).toBe(true);
        } else if (zA === Zone.OFFICE || zB === Zone.OFFICE) {
          expect(c.style).toBe('doorway');
        } else expect(c.style).toBe('header');
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(50);
    expect(rollups).toBeGreaterThan(5);
  });

  it('artery lanes crossing a seam line are OPEN', () => {
    const { seams, sites } = worlds(8);
    let found = 0;
    for (let cz = -60; cz < 60; cz++) {
      for (let cx = -60; cx < 60; cx++) {
        for (const a of sites.arteriesInChunk(cx, cz)) {
          found++;
          const s = (found % 3) as StoreyId;
          if (a.axis === 'x') {
            const sp = seams.seam(s, 'x', cx, cz);
            const idx = a.row - cz * N;
            expect(sp.kind[idx]).toBe(EdgeKind.OPEN);
            expect(sp.kind[idx + 1]).toBe(EdgeKind.OPEN);
          } else {
            const sp = seams.seam(s, 'z', cx, cz);
            const idx = a.row - cx * N;
            expect(sp.kind[idx]).toBe(EdgeKind.OPEN);
            expect(sp.kind[idx + 1]).toBe(EdgeKind.OPEN);
          }
        }
      }
    }
    expect(found).toBeGreaterThan(20);
  });
});

describe('sites', () => {
  it('tower and elevator footprints keep >= 2 cells from seams for all 4 rot, avoid artery lanes (+1 apron)', () => {
    const sites = createSites(2718, null);
    const rots = new Set<number>(), erots = new Set<number>();
    let towers = 0, elevators = 0;
    for (let sz = -40; sz < 40; sz++) {
      for (let sx = -40; sx < 40; sx++) {
        const t = sites.towerOfSuper(sx, sz);
        if (t) {
          towers++;
          rots.add(t.rot);
          const [i0, j0, i1, j1] = towerFootprint(t);
          expect(Math.min(i0, j0)).toBeGreaterThanOrEqual(TOWER.SEAM_MARGIN);
          expect(Math.max(i1, j1)).toBeLessThanOrEqual(N - TOWER.SEAM_MARGIN);
          expect(sites.hitsLane(t.cx, t.cz, i0 - 1, j0 - 1, i1 + 1, j1 + 1)).toBe(false);
          expect(Math.floor(t.cx / TOWER.SUPER_CHUNKS)).toBe(sx);
          expect(sites.towerAt(t.cx, t.cz)).toBe(t);
        }
        if (sx % 2 === 0 && sz % 2 === 0) {
          const e = sites.elevatorOfRegion(sx / 2, sz / 2);
          if (e) {
            elevators++;
            erots.add(e.rot);
            const [i0, j0, i1, j1] = elevatorFootprint(e);
            expect(Math.min(i0, j0)).toBeGreaterThanOrEqual(2);
            expect(Math.max(i1, j1)).toBeLessThanOrEqual(N - 2);
            expect(sites.towerAt(e.cx, e.cz)).toBeNull();
            expect(sites.hitsLane(e.cx, e.cz, i0 - 1, j0 - 1, i1 + 1, j1 + 1)).toBe(false);
            expect(Math.floor(e.cx / ELEVATOR.SUPER_CHUNKS)).toBe(sx / 2);
          }
        }
      }
    }
    expect(rots.size).toBe(4);
    expect(erots.size).toBe(4);
    expect(towers).toBeGreaterThan(6000);
    expect(elevators).toBeGreaterThan(1400);
    // the origin super-region's tower sits in chunk {0,1}^2 and is never endless
    for (let seed = 1; seed < 50; seed++) {
      const t = createSites(seed, null).towerOfSuper(0, 0);
      if (!t) continue;
      expect(t.cx === 0 || t.cx === 1).toBe(true);
      expect(t.cz === 0 || t.cz === 1).toBe(true);
      expect(t.endless).toBe(false);
    }
  });

  it('arteries: bands, lanes in [3, 27], 8-chunk segments', () => {
    const sites = createSites(99, null);
    let n = 0;
    for (let cz = -100; cz < 100; cz++) {
      for (let cx = -100; cx < 100; cx++) {
        for (const a of sites.arteriesInChunk(cx, cz)) {
          n++;
          const lane = a.row - N * (a.axis === 'x' ? cz : cx);
          expect(lane).toBeGreaterThanOrEqual(ARTERY.SEAM_MARGIN);
          expect(lane).toBeLessThanOrEqual(27);
          expect(a.g1 - a.g0).toBe(ARTERY.SEG_CHUNKS * N);
          const along = N * (a.axis === 'x' ? cx : cz);
          expect(along >= a.g0 && along < a.g1).toBe(true);
        }
      }
    }
    // expected density: 2 axes x (1/12 rows) x 0.5 x 0.7 of 40000 chunks ~ 2300
    expect(n).toBeGreaterThan(1200);
    expect(n).toBeLessThan(3600);
  });

  it('landmarks: ENDLESS_HALL only in artery chunks (storeys 0/1), artery chunks only ENDLESS_HALL, >= 2 chunks apart (R2 pacing: was 4)', () => {
    const sites = createSites(1234, null);
    for (const s of [0, 1, 2] as StoreyId[]) {
      const all: { cx: number; cz: number }[] = [];
      let endless = 0;
      for (let cz = -120; cz < 120; cz++) {
        for (let cx = -120; cx < 120; cx++) {
          const lm = sites.landmarkAt(s, cx, cz);
          if (!lm) continue;
          all.push(lm);
          const artery = sites.arteriesInChunk(cx, cz).length > 0;
          if (lm.kind === LandmarkKind.ENDLESS_HALL) { endless++; expect(artery).toBe(true); expect(s).not.toBe(2); }
          if (artery) expect(lm.kind).toBe(LandmarkKind.ENDLESS_HALL);
          expect(sites.towerAt(cx, cz)).toBeNull();
          expect(sites.elevatorAt(cx, cz)).toBeNull();
        }
      }
      expect(all.length).toBeGreaterThan(300);
      if (s !== 2) expect(endless).toBeGreaterThan(0);
      for (let i = 0; i < all.length; i++) {
        for (let j = i + 1; j < all.length; j++) {
          const d = Math.max(Math.abs(all[i].cx - all[j].cx), Math.abs(all[i].cz - all[j].cz));
          if (d < 2) throw new Error(`landmarks too close: ${JSON.stringify(all[i])} ${JSON.stringify(all[j])}`);
        }
      }
    }
  });

  it('forceLandmark puts that kind at chunk (0, 0) of every storey', () => {
    const sites = createSites(5, LandmarkKind.RED_ROOM);
    for (const s of [0, 1, 2] as StoreyId[]) expect(sites.landmarkAt(s, 0, 0)?.kind).toBe(LandmarkKind.RED_ROOM);
    // the forced landmark never shares chunk (0, 0) with a tower or an elevator (the stamps would overlap)
    let moved = 0, kept = 0;
    for (let seed = 0; seed < 400; seed++) {
      const free = createSites(seed, null), forced = createSites(seed, LandmarkKind.ATRIUM);
      expect(forced.towerAt(0, 0)).toBeNull();
      expect(forced.elevatorAt(0, 0)).toBeNull();
      if (free.towerAt(0, 0)) { moved++; if (forced.towerOfSuper(0, 0)) kept++; }
    }
    expect(moved).toBeGreaterThan(40); // ~25% of seeds put the origin tower in chunk (0, 0) without forcing
    expect(kept / moved).toBeGreaterThan(0.9); // ... and the retry moves it to another origin chunk
  });

  it('generated landmark footprints keep >= 2 cells from seam lines (except ENDLESS_HALL)', () => {
    const g = createWorldGen(opts(4040));
    let n = 0;
    for (const s of [0, 1, 2] as StoreyId[]) {
      for (let cz = -24; cz < 24 && n < 36 * (s + 1); cz++) {
        for (let cx = -24; cx < 24 && n < 36 * (s + 1); cx++) {
          if (!g.landmarkAt(s, cx, cz)) continue;
          n++;
          const l = g.generateChunk({ s, cx, cz });
          for (const m of l.landmarks) {
            if (m.kind === LandmarkKind.ENDLESS_HALL) continue;
            expect(Math.min(m.i0, m.j0), `landmark ${m.kind} @ ${s}:${cx}:${cz}`).toBeGreaterThanOrEqual(2);
            expect(Math.max(m.i1, m.j1), `landmark ${m.kind} @ ${s}:${cx}:${cz}`).toBeLessThanOrEqual(N - 2);
          }
        }
      }
    }
    expect(n).toBeGreaterThan(20);
  });
});
