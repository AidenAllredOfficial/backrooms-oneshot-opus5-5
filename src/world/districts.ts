// src/world/districts.ts — Voronoi districts: warp, jittered sites, zone/mood pick, onboarding, params (WP1).
//
// Positions are in CHUNK units. A chunk (cx, cz) is assigned to the district whose site is nearest to its warped
// centre p = (cx+0.5, cz+0.5) + 2·WARP_AMP·(fbm − 0.5). Sites live one per 4×4-chunk site cell, jittered ±1.5.
// Everything is a pure function of (seed, s, ...) and cached (per site cell and per chunk).

import { DISTRICT } from '../core/constants.ts';
import { floorDiv } from '../core/grid.ts';
import { Mood, type MoodId, type StoreyId, Zone, type ZoneId } from '../core/ids.ts';
import { fbm2 } from '../core/noise.ts';
import { hash01, hash2, hash3, hash4, hash5, rngFor, SALT } from '../core/rng.ts';
import type { DistrictInfo, WorldGenOptions } from '../core/world.ts';
import { MOOD_WEIGHTS, ONBOARDING_ZONES, STRATA_WEIGHTS } from '../core/zones.ts';
import { generatorFor } from './zones/registry.ts';

const SC = DISTRICT.SITE_CHUNKS; // 4
const JIT = DISTRICT.JITTER_CHUNKS * 2; // 3 (jitter = (u − 0.5)·3)
const WARP = 2 * DISTRICT.WARP_AMP_CHUNKS; // 1.6
const WARP_L = 1 / DISTRICT.WARP_WAVELENGTH_CHUNKS; // 1/6
/** Onboarding window: site cells in [-2, 2]² of storey 0. */
export const ONBOARDING_RADIUS = 2;
const CACHE_MAX = 65536;

export interface Districts {
  districtAt(s: StoreyId, cx: number, cz: number): DistrictInfo;
  /** District of site cell (sx, sz) (no chunk lookup). */
  districtBySite(s: StoreyId, sx: number, sz: number): DistrictInfo;
  /** Site cell owning chunk (cx, cz): out[0] = sx, out[1] = sz. */
  siteCellOf(s: StoreyId, cx: number, cz: number, out: [number, number]): void;
  /** Warped chunk-centre position used for the nearest-site test (chunk units). */
  warped(s: StoreyId, cx: number, cz: number, out: [number, number]): void;
  /** Site position (chunk units). */
  sitePos(s: StoreyId, sx: number, sz: number, out: [number, number]): void;
  /** Onboarding rank 0..4 of site cell (storey 0 only), -1 otherwise. */
  onboardingRank(s: StoreyId, sx: number, sz: number): number;
}

export function createDistricts(opts: WorldGenOptions): Districts {
  const seed = opts.seed;
  const siteCache = new Map<string, DistrictInfo>();
  const chunkCache = new Map<string, DistrictInfo>();
  let onboarding: Map<string, number> | null = null;
  let onboardingZones: ZoneId[] | null = null;

  const sitePos = (s: StoreyId, sx: number, sz: number, out: [number, number]): void => {
    const h = hash5(seed, SALT.DISTRICT, s, sx, sz);
    out[0] = sx * SC + 2 + (hash01(h) - 0.5) * JIT;
    out[1] = sz * SC + 2 + (hash01(hash2(h, 1)) - 0.5) * JIT;
  };
  const siteId = (s: StoreyId, sx: number, sz: number): number => hash4(seed, SALT.DISTRICT, s, sx * 65536 + sz);

  const warped = (s: StoreyId, cx: number, cz: number, out: [number, number]): void => {
    const px = cx + 0.5, pz = cz + 0.5;
    const s1 = seed ^ SALT.WARP ^ (s * 7919);
    const s2 = seed ^ SALT.WARP ^ (s * 7919 + 1);
    out[0] = px + WARP * (fbm2(s1, px * WARP_L, pz * WARP_L, 2) - 0.5);
    out[1] = pz + WARP * (fbm2(s2, px * WARP_L, pz * WARP_L, 2) - 0.5);
  };

  const pos: [number, number] = [0, 0];
  const pp: [number, number] = [0, 0];
  const siteCellOf = (s: StoreyId, cx: number, cz: number, out: [number, number]): void => {
    warped(s, cx, cz, pp);
    const px = pp[0], pz = pp[1];
    const bx = floorDiv(px, SC), bz = floorDiv(pz, SC);
    let best = Infinity, bestId = 0, bsx = bx, bsz = bz;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const sx = bx + dx, sz = bz + dz;
        sitePos(s, sx, sz, pos);
        const ex = pos[0] - px, ez = pos[1] - pz;
        const d = ex * ex + ez * ez;
        const id = siteId(s, sx, sz);
        if (d < best || (d === best && id < bestId)) { best = d; bestId = id; bsx = sx; bsz = sz; }
      }
    }
    out[0] = bsx; out[1] = bsz;
  };

  const onboardingRank = (s: StoreyId, sx: number, sz: number): number => {
    if (s !== 0 || Math.abs(sx) > ONBOARDING_RADIUS || Math.abs(sz) > ONBOARDING_RADIUS) return -1;
    if (!onboarding) {
      // The "world origin" is the warped centre of chunk (0, 0): rank 0 is therefore exactly the district that
      // contains the origin chunk (the spawn), whatever the warp does.
      const o: [number, number] = [0, 0];
      warped(0, 0, 0, o);
      const list: { sx: number; sz: number; d: number; id: number }[] = [];
      for (let z = -ONBOARDING_RADIUS; z <= ONBOARDING_RADIUS; z++) {
        for (let x = -ONBOARDING_RADIUS; x <= ONBOARDING_RADIUS; x++) {
          sitePos(0, x, z, pos);
          const ex = pos[0] - o[0], ez = pos[1] - o[1];
          list.push({ sx: x, sz: z, d: ex * ex + ez * ez, id: siteId(0, x, z) });
        }
      }
      list.sort((a, b) => a.d - b.d || a.id - b.id);
      onboarding = new Map();
      for (let r = 0; r < 5; r++) onboarding.set(`${list[r].sx},${list[r].sz}`, r);
      onboardingZones = rngFor(seed, SALT.ONBOARDING).shuffle([...ONBOARDING_ZONES]);
    }
    return onboarding.get(`${sx},${sz}`) ?? -1;
  };

  const districtBySite = (s: StoreyId, sx: number, sz: number): DistrictInfo => {
    const key = `${s},${sx},${sz}`;
    const hit = siteCache.get(key);
    if (hit) return hit;
    const rank = onboardingRank(s, sx, sz);
    let zone: ZoneId;
    if (opts.forceZone !== null) zone = opts.forceZone;
    else if (rank === 0) zone = Zone.LOBBY;
    else if (rank > 0) zone = (onboardingZones as ZoneId[])[rank - 1];
    else zone = rngFor(seed, SALT.DISTRICT_ZONE, s, sx, sz).weighted(STRATA_WEIGHTS[s]) as ZoneId;
    let mood: MoodId;
    if (opts.forceMood !== null) mood = opts.forceMood;
    else if (zone === Zone.DARK) mood = Mood.DARK;
    else if (rank === 0) mood = Mood.NORMAL;
    else mood = rngFor(seed, SALT.MOOD, s, sx, sz).weighted(MOOD_WEIGHTS) as MoodId;
    const id = siteId(s, sx, sz);
    sitePos(s, sx, sz, pos);
    const params = Object.freeze(generatorFor(zone).districtParams(rngFor(seed, SALT.DISTRICT_PARAMS, s, sx, sz), s));
    const d: DistrictInfo = { id, s, zone, mood, siteX: pos[0], siteZ: pos[1], seed: hash3(seed, SALT.DISTRICT_PARAMS, id), params };
    if (siteCache.size > CACHE_MAX) siteCache.clear();
    siteCache.set(key, d);
    return d;
  };

  const sc: [number, number] = [0, 0];
  const districtAt = (s: StoreyId, cx: number, cz: number): DistrictInfo => {
    const key = `${s},${cx},${cz}`;
    const hit = chunkCache.get(key);
    if (hit) return hit;
    siteCellOf(s, cx, cz, sc);
    const d = districtBySite(s, sc[0], sc[1]);
    if (chunkCache.size > CACHE_MAX) chunkCache.clear();
    chunkCache.set(key, d);
    return d;
  };

  return { districtAt, districtBySite, siteCellOf, warped, sitePos, onboardingRank };
}
