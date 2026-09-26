// src/world/sites.ts — towers, elevators, arteries and landmarks (WP1).
//
// Tower, elevator and artery positions are storey-independent (their hashes omit s): a tower is at the same place
// in every storey, which is what makes the periodic stair work. Landmark POSITIONS are storey-independent too;
// the landmark KIND is picked per storey among the kinds allowed there.
//
// R2 pacing (B4): landmark regions are 3x3 chunks (115 m) with p 0.9 and a 2-chunk minimum spacing (~8x the WP1
// density), and every district adds one HERO ROOM (landmarks/index.ts `hero`): a kind picked from the district
// zone's list, stamped in the free chunk nearest the district site (landmarkAt returns it like any landmark, so
// goto=landmark:NAME, spawn search and the tools see hero rooms too). Heroes never share a chunk with a regular
// landmark, a tower, an elevator or an artery.

import { ARTERY, CHUNK_CELLS, ELEVATOR, TOWER } from '../core/constants.ts';
import { floorDiv } from '../core/grid.ts';
import { LandmarkKind, type LandmarkKindId, type StoreyId } from '../core/ids.ts';
import { hash01, hash2, hash4, hash5, rngFor, SALT } from '../core/rng.ts';
import { elevatorFootprint, towerFootprint, type ArterySpan, type ElevatorSite, type LandmarkSite, type TowerSite } from '../core/world.ts';
import type { Districts } from './districts.ts';
import { heroKindsFor, LANDMARKS } from './landmarks/index.ts';

const N = CHUNK_CELLS;
const TSC = TOWER.SUPER_CHUNKS; // 4
const ESC = ELEVATOR.SUPER_CHUNKS; // 8
const LSC = 3; // landmark regions: 3x3 chunks (R2 pacing: was 8)
const LANDMARK_P = 0.9; // was 0.8
const LANDMARK_MIN_DIST = 2; // chunks (Chebyshev; was 4)
/** An artery chunk drawn for a landmark becomes an ENDLESS_HALL only with this probability (else the region retries
 * another chunk): with 3x3 regions every artery would otherwise turn into endless halls. */
const ENDLESS_ACCEPT_P = 0.4;
/** Salt offset of the hero-room kind pick (rngFor(seed, SALT.LANDMARK, HERO_SALT + s, sx, sz)). */
const HERO_SALT = 0x4e20;
const SITE_MARGIN = TOWER.SEAM_MARGIN; // 2 cells from seam lines
const RETRIES = 4;
const LANE_CHOICES = 27 - ARTERY.SEAM_MARGIN + 1; // lj in [3, 27]
const CACHE_MAX = 65536;
/** Radius (Chebyshev, chunks) of towersNear / elevatorsNear. */
export const SITES_NEAR_RADIUS = 2;

interface LandmarkCandidate { kind: LandmarkKindId; cx: number; cz: number; seed: number; h: number }

export interface Sites {
  towerOfSuper(srx: number, srz: number): TowerSite | null;
  elevatorOfRegion(erx: number, erz: number): ElevatorSite | null;
  /** The tower whose chunk is (cx, cz), if any. */
  towerAt(cx: number, cz: number): TowerSite | null;
  elevatorAt(cx: number, cz: number): ElevatorSite | null;
  /** Artery spans crossing chunk (cx, cz) (storey-free). */
  arteriesInChunk(cx: number, cz: number): readonly ArterySpan[];
  /** Spans crossing the 3x3 chunks around (cx, cz). */
  arteriesNear(cx: number, cz: number): readonly ArterySpan[];
  towersNear(cx: number, cz: number): readonly TowerSite[];
  elevatorsNear(cx: number, cz: number): readonly ElevatorSite[];
  /** The landmark or hero room stamped in chunk (cx, cz) of storey s (at most one per chunk). */
  landmarkAt(s: StoreyId, cx: number, cz: number): LandmarkSite | null;
  /** The hero room of the district owning site cell (sx, sz) (null: no eligible kind / no free chunk / no districts). */
  heroOfSite(s: StoreyId, sx: number, sz: number): LandmarkSite | null;
  /** True if local cell rect [i0,i1)x[j0,j1) (chunk (cx,cz)) intersects an artery lane. */
  hitsLane(cx: number, cz: number, i0: number, j0: number, i1: number, j1: number): boolean;
}

export function createSites(seed: number, forceLandmark: LandmarkKindId | null, districts: Districts | null = null): Sites {
  const arteryCache = new Map<string, readonly ArterySpan[]>();
  const towerCache = new Map<string, TowerSite | null>();
  const elevCache = new Map<string, ElevatorSite | null>();
  const lmCache = new Map<string, LandmarkCandidate | null>();
  const lmSiteCache = new Map<string, LandmarkSite | null>();
  const regularCache = new Map<string, LandmarkSite | null>();
  const heroCache = new Map<string, LandmarkSite | null>();
  const put = <T>(m: Map<string, T>, k: string, v: T): T => {
    if (m.size > CACHE_MAX) m.clear();
    m.set(k, v);
    return v;
  };

  // ------------------------------------------------------------------ arteries
  /** axis 0 = runs along x (band over cz), 1 = runs along z (band over cx). Returns the band's lane or null. */
  const band = (axis: 0 | 1, b: number): { chunk: number; lane: number } | null => {
    const h = hash4(seed, SALT.ARTERY, axis, b);
    if (hash01(h) >= ARTERY.BAND_P) return null;
    // lane (first of the WIDTH_CELLS lanes) in [3, 27]: both lanes and both flanking wall lines stay >= 3 cells
    // from the seam lines.
    return { chunk: ARTERY.BAND_CHUNKS * b + (h % ARTERY.BAND_CHUNKS), lane: ARTERY.SEAM_MARGIN + (hash2(h, 7) % LANE_CHOICES) };
  };
  const segment = (axis: 0 | 1, b: number, k: number): number | null => {
    const h = hash5(seed, SALT.ARTERY, axis, b, k);
    return hash01(h) < ARTERY.SEG_P ? hash2(h, 3) : null;
  };
  const arteriesInChunk = (cx: number, cz: number): readonly ArterySpan[] => {
    const key = `${cx},${cz}`;
    const hit = arteryCache.get(key);
    if (hit) return hit;
    const out: ArterySpan[] = [];
    const bz = floorDiv(cz, ARTERY.BAND_CHUNKS);
    const bx = band(0, bz);
    if (bx && bx.chunk === cz) {
      const k = floorDiv(cx, ARTERY.SEG_CHUNKS);
      const sd = segment(0, bz, k);
      if (sd !== null) out.push({ axis: 'x', row: N * cz + bx.lane, g0: k * ARTERY.SEG_CHUNKS * N, g1: (k + 1) * ARTERY.SEG_CHUNKS * N, seed: sd });
    }
    const bxz = floorDiv(cx, ARTERY.BAND_CHUNKS);
    const bz2 = band(1, bxz);
    if (bz2 && bz2.chunk === cx) {
      const k = floorDiv(cz, ARTERY.SEG_CHUNKS);
      const sd = segment(1, bxz, k);
      if (sd !== null) out.push({ axis: 'z', row: N * cx + bz2.lane, g0: k * ARTERY.SEG_CHUNKS * N, g1: (k + 1) * ARTERY.SEG_CHUNKS * N, seed: sd });
    }
    return put(arteryCache, key, out);
  };
  const arteriesNear = (cx: number, cz: number): readonly ArterySpan[] => {
    const out: ArterySpan[] = [];
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        for (const a of arteriesInChunk(cx + dx, cz + dz)) {
          if (!out.some((b) => b.axis === a.axis && b.row === a.row && b.g0 === a.g0)) out.push(a);
        }
      }
    }
    return out;
  };
  const hitsLane = (cx: number, cz: number, i0: number, j0: number, i1: number, j1: number): boolean => {
    for (const a of arteriesInChunk(cx, cz)) {
      if (a.axis === 'x') {
        const lj = a.row - N * cz;
        if (j0 < lj + ARTERY.WIDTH_CELLS && j1 > lj) return true;
      } else {
        const li = a.row - N * cx;
        if (i0 < li + ARTERY.WIDTH_CELLS && i1 > li) return true;
      }
    }
    return false;
  };

  // ------------------------------------------------------------------ towers / elevators
  /** With forceLandmark, chunk (0, 0) holds the forced landmark in every storey: no tower / elevator there (the
   * landmark stamp would overlap the structure). Only QA runs with forceLandmark see the shifted site. */
  const forcedOrigin = (cx: number, cz: number): boolean => forceLandmark !== null && cx === 0 && cz === 0;
  const placeFoot = (h: number, W: number, L: number, rot: 0 | 1 | 2 | 3): [number, number] => {
    const ex = (rot & 1) === 0 ? W : L, ez = (rot & 1) === 0 ? L : W;
    const h2 = hash2(h, 11);
    const nx = N - 2 * SITE_MARGIN - ex + 1, nz = N - 2 * SITE_MARGIN - ez + 1;
    return [SITE_MARGIN + (h2 % nx), SITE_MARGIN + ((h2 >>> 12) % nz)];
  };
  const towerOfSuper = (srx: number, srz: number): TowerSite | null => {
    const key = `${srx},${srz}`;
    const hit = towerCache.get(key);
    if (hit !== undefined) return hit;
    const origin = srx === 0 && srz === 0;
    let site: TowerSite | null = null;
    for (let a = 0; a <= RETRIES && !site; a++) {
      const h = a === 0 ? hash4(seed, SALT.TOWER, srx, srz) : hash5(seed, SALT.TOWER, srx, srz, a);
      const cx = origin ? h % 2 : TSC * srx + (h % TSC);
      const cz = origin ? (h >>> 1) % 2 : TSC * srz + ((h >>> 2) % TSC);
      if (forcedOrigin(cx, cz)) continue; // chunk (0, 0) belongs to the forced landmark
      const rot = ((h >>> 4) & 3) as 0 | 1 | 2 | 3;
      const [i0, j0] = placeFoot(h, TOWER.W_CELLS, TOWER.L_CELLS, rot);
      const cand: TowerSite = { id: h, cx, cz, i0, j0, rot, endless: !origin && hash01(hash2(h, 13)) < 0.05 };
      const [fi0, fj0, fi1, fj1] = towerFootprint(cand);
      if (hitsLane(cx, cz, fi0 - 1, fj0 - 1, fi1 + 1, fj1 + 1)) continue;
      site = cand;
    }
    return put(towerCache, key, site);
  };
  const towerAt = (cx: number, cz: number): TowerSite | null => {
    const t = towerOfSuper(floorDiv(cx, TSC), floorDiv(cz, TSC));
    return t && t.cx === cx && t.cz === cz ? t : null;
  };
  const elevatorOfRegion = (erx: number, erz: number): ElevatorSite | null => {
    const key = `${erx},${erz}`;
    const hit = elevCache.get(key);
    if (hit !== undefined) return hit;
    let site: ElevatorSite | null = null;
    for (let a = 0; a <= RETRIES && !site; a++) {
      const h = a === 0 ? hash4(seed, SALT.ELEVATOR, erx, erz) : hash5(seed, SALT.ELEVATOR, erx, erz, a);
      const cx = ESC * erx + (h % ESC);
      const cz = ESC * erz + ((h >>> 3) % ESC);
      if (towerAt(cx, cz) || forcedOrigin(cx, cz)) continue;
      const rot = ((h >>> 6) & 3) as 0 | 1 | 2 | 3;
      const [i0, j0] = placeFoot(h, ELEVATOR.W_CELLS, ELEVATOR.L_CELLS, rot);
      const cand: ElevatorSite = { id: h, cx, cz, i0, j0, rot };
      const [fi0, fj0, fi1, fj1] = elevatorFootprint(cand);
      if (hitsLane(cx, cz, fi0 - 1, fj0 - 1, fi1 + 1, fj1 + 1)) continue;
      site = cand;
    }
    return put(elevCache, key, site);
  };
  const elevatorAt = (cx: number, cz: number): ElevatorSite | null => {
    const e = elevatorOfRegion(floorDiv(cx, ESC), floorDiv(cz, ESC));
    return e && e.cx === cx && e.cz === cz ? e : null;
  };
  const towersNear = (cx: number, cz: number): readonly TowerSite[] => {
    const R = SITES_NEAR_RADIUS, out: TowerSite[] = [];
    for (let srz = floorDiv(cz - R, TSC); srz <= floorDiv(cz + R, TSC); srz++) {
      for (let srx = floorDiv(cx - R, TSC); srx <= floorDiv(cx + R, TSC); srx++) {
        const t = towerOfSuper(srx, srz);
        if (t && Math.abs(t.cx - cx) <= R && Math.abs(t.cz - cz) <= R) out.push(t);
      }
    }
    return out;
  };
  const elevatorsNear = (cx: number, cz: number): readonly ElevatorSite[] => {
    const R = SITES_NEAR_RADIUS, out: ElevatorSite[] = [];
    for (let erz = floorDiv(cz - R, ESC); erz <= floorDiv(cz + R, ESC); erz++) {
      for (let erx = floorDiv(cx - R, ESC); erx <= floorDiv(cx + R, ESC); erx++) {
        const e = elevatorOfRegion(erx, erz);
        if (e && Math.abs(e.cx - cx) <= R && Math.abs(e.cz - cz) <= R) out.push(e);
      }
    }
    return out;
  };

  // ------------------------------------------------------------------ landmarks
  const weights = new Array<number>(LANDMARKS.length).fill(0);
  const candidate = (s: StoreyId, lrx: number, lrz: number): LandmarkCandidate | null => {
    const key = `${s},${lrx},${lrz}`;
    const hit = lmCache.get(key);
    if (hit !== undefined) return hit;
    if (forceLandmark !== null && lrx === 0 && lrz === 0) {
      return put(lmCache, key, { kind: forceLandmark, cx: 0, cz: 0, seed: hash4(seed, SALT.LANDMARK, 0, 0), h: -1 });
    }
    const h = hash4(seed, SALT.LANDMARK, lrx, lrz);
    let c: LandmarkCandidate | null = null;
    if (hash01(h) < LANDMARK_P) {
      for (let a = 0; a < RETRIES && !c; a++) {
        const ha = a === 0 ? h : hash5(seed, SALT.LANDMARK, lrx, lrz, a);
        const cx = LSC * lrx + (ha % LSC), cz = LSC * lrz + ((ha >>> 3) % LSC);
        if (towerAt(cx, cz) || elevatorAt(cx, cz)) continue;
        const artery = arteriesInChunk(cx, cz).length > 0;
        // storey-free test (positions stay storey-independent): most artery draws retry another chunk
        if (artery && hash01(hash2(ha, 0xe7d)) >= ENDLESS_ACCEPT_P) continue;
        let any = false;
        for (let k = 0; k < LANDMARKS.length; k++) {
          const lg = LANDMARKS[k];
          const ok = !lg.heroOnly && lg.storeys.includes(s) && (artery ? lg.kind === LandmarkKind.ENDLESS_HALL : lg.kind !== LandmarkKind.ENDLESS_HALL);
          weights[k] = ok ? lg.weight : 0;
          if (ok && lg.weight > 0) any = true;
        }
        if (!any) { if (artery) continue; break; } // no eligible kind (storey 2 has no ENDLESS_HALL): try another chunk
        const kind = LANDMARKS[rngFor(seed, SALT.LANDMARK, lrx, lrz, 1).weighted(weights)].kind;
        c = { kind, cx, cz, seed: hash5(seed, SALT.LANDMARK, cx, cz, kind), h: ha };
      }
    }
    return put(lmCache, key, c);
  };
  const regularAt = (s: StoreyId, cx: number, cz: number): LandmarkSite | null => {
    const key = `${s},${cx},${cz}`;
    const hit = regularCache.get(key);
    if (hit !== undefined) return hit;
    const lrx = floorDiv(cx, LSC), lrz = floorDiv(cz, LSC);
    const c = candidate(s, lrx, lrz);
    let site: LandmarkSite | null = null;
    if (c && c.cx === cx && c.cz === cz) {
      site = { kind: c.kind, cx, cz, seed: c.seed };
      for (let dz = -1; dz <= 1 && site; dz++) {
        for (let dx = -1; dx <= 1 && site; dx++) {
          if (dx === 0 && dz === 0) continue;
          const n = candidate(s, lrx + dx, lrz + dz);
          if (!n) continue;
          if (Math.max(Math.abs(n.cx - cx), Math.abs(n.cz - cz)) >= LANDMARK_MIN_DIST) continue;
          // deterministic: the lower hash wins (forced landmark: h = -1 always wins); ties by region order
          if (n.h < c.h || (n.h === c.h && (dz < 0 || (dz === 0 && dx < 0)))) site = null;
        }
      }
    }
    return put(regularCache, key, site);
  };

  // ------------------------------------------------------------------ hero rooms (one per district)
  const hpos: [number, number] = [0, 0];
  const hcell: [number, number] = [0, 0];
  const heroOfSite = (s: StoreyId, sx: number, sz: number): LandmarkSite | null => {
    if (!districts) return null;
    const key = `${s},${sx},${sz}`;
    const hit = heroCache.get(key);
    if (hit !== undefined) return hit;
    const d = districts.districtBySite(s, sx, sz);
    const kinds = heroKindsFor(s, d.zone);
    let site: LandmarkSite | null = null;
    if (kinds.length > 0) {
      districts.sitePos(s, sx, sz, hpos);
      const px = hpos[0], pz = hpos[1];
      const bx = Math.floor(px), bz = Math.floor(pz);
      const cands: [number, number, number][] = [];
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        const cx = bx + dx, cz = bz + dz;
        cands.push([cx, cz, (cx + 0.5 - px) ** 2 + (cz + 0.5 - pz) ** 2]);
      }
      cands.sort((a, b) => a[2] - b[2]);
      for (const [cx, cz] of cands) {
        districts.siteCellOf(s, cx, cz, hcell);
        if (hcell[0] !== sx || hcell[1] !== sz) continue; // the chunk belongs to another district
        if (forcedOrigin(cx, cz) || towerAt(cx, cz) || elevatorAt(cx, cz) || arteriesInChunk(cx, cz).length > 0) continue;
        if (regularAt(s, cx, cz)) continue;
        const rng = rngFor(seed, SALT.LANDMARK, HERO_SALT + s, sx, sz);
        const kind = kinds[rng.weighted(kinds.map((k) => LANDMARKS[k].weight))];
        site = { kind, cx, cz, seed: hash5(seed, SALT.LANDMARK, cx, cz, HERO_SALT + kind) };
        break;
      }
    }
    return put(heroCache, key, site);
  };

  const landmarkAt = (s: StoreyId, cx: number, cz: number): LandmarkSite | null => {
    const key = `${s},${cx},${cz}`;
    const hit = lmSiteCache.get(key);
    if (hit !== undefined) return hit;
    let site = regularAt(s, cx, cz);
    if (!site && districts) {
      districts.siteCellOf(s, cx, cz, hcell);
      const h = heroOfSite(s, hcell[0], hcell[1]);
      if (h && h.cx === cx && h.cz === cz) site = h;
    }
    return put(lmSiteCache, key, site);
  };

  return {
    towerOfSuper, elevatorOfRegion, towerAt, elevatorAt, arteriesInChunk, arteriesNear, towersNear, elevatorsNear,
    landmarkAt, heroOfSite, hitsLane,
  };
}
