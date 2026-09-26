// WP1 — districts: zone / mood mix, onboarding, overrides, params, warp.
import { describe, expect, it } from 'vitest';
import { Mood, type MoodId, type StoreyId, Zone, type ZoneId, ZONE_COUNT } from '../../src/core/ids.ts';
import { rngFor, SALT } from '../../src/core/rng.ts';
import type { WorldGenOptions } from '../../src/core/world.ts';
import { MOOD_WEIGHTS, ONBOARDING_ZONES, STRATA_WEIGHTS } from '../../src/core/zones.ts';
import { createDistricts, ONBOARDING_RADIUS } from '../../src/world/districts.ts';
import { createWorldGen } from '../../src/world/worldgen.ts';
import { generatorFor } from '../../src/world/zones/registry.ts';

const opts = (seed: number, o: Partial<WorldGenOptions> = {}): WorldGenOptions => ({
  seed, seedText: String(seed), forceZone: null, forceMood: null, forceLandmark: null, testScene: null, lights: 'default', ...o,
});

describe('districts', () => {
  it('zone frequencies over 10k districts outside the onboarding window match STRATA_WEIGHTS within ±3%', () => {
    for (const s of [0, 1, 2] as StoreyId[]) {
      const d = createDistricts(opts(12345 + s));
      const counts = new Array<number>(ZONE_COUNT).fill(0);
      let n = 0;
      for (let sz = -55; sz <= 55 && n < 10000; sz++) {
        for (let sx = -55; sx <= 55 && n < 10000; sx++) {
          if (Math.abs(sx) <= ONBOARDING_RADIUS && Math.abs(sz) <= ONBOARDING_RADIUS) continue;
          counts[d.districtBySite(s, sx, sz).zone]++;
          n++;
        }
      }
      expect(n).toBe(10000);
      const w = STRATA_WEIGHTS[s];
      const sum = w.reduce((a, b) => a + b, 0);
      for (let z = 0; z < ZONE_COUNT; z++) expect(Math.abs(counts[z] / n - w[z] / sum), `storey ${s} zone ${z}`).toBeLessThanOrEqual(0.03);
    }
  });

  it('mood: DARK zone forces DARK; other moods follow MOOD_WEIGHTS within ±3%', () => {
    const d = createDistricts(opts(99));
    const counts = [0, 0, 0, 0];
    let n = 0;
    for (let sz = -50; sz <= 50; sz++) {
      for (let sx = -50; sx <= 50; sx++) {
        const di = d.districtBySite(0, sx, sz);
        if (di.zone === Zone.DARK) { expect(di.mood).toBe(Mood.DARK); continue; }
        if (Math.abs(sx) <= ONBOARDING_RADIUS && Math.abs(sz) <= ONBOARDING_RADIUS) continue;
        counts[di.mood]++;
        n++;
      }
    }
    const sum = MOOD_WEIGHTS.reduce((a, b) => a + b, 0);
    for (let m = 0; m < 4; m++) expect(Math.abs(counts[m] / n - MOOD_WEIGHTS[m] / sum)).toBeLessThanOrEqual(0.03);
  });

  it('onboarding: rank 0 is the origin district (LOBBY, NORMAL); ranks 1–4 are a permutation of ONBOARDING_ZONES', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const d = createDistricts(opts(seed));
      const origin = d.districtAt(0, 0, 0);
      expect(origin.zone).toBe(Zone.LOBBY);
      expect(origin.mood).toBe(Mood.NORMAL);
      const byRank = new Map<number, ZoneId>();
      for (let sz = -ONBOARDING_RADIUS; sz <= ONBOARDING_RADIUS; sz++) {
        for (let sx = -ONBOARDING_RADIUS; sx <= ONBOARDING_RADIUS; sx++) {
          const r = d.onboardingRank(0, sx, sz);
          if (r >= 0) byRank.set(r, d.districtBySite(0, sx, sz).zone);
        }
      }
      expect([...byRank.keys()].sort()).toEqual([0, 1, 2, 3, 4]);
      expect(byRank.get(0)).toBe(Zone.LOBBY);
      const rest = [1, 2, 3, 4].map((r) => byRank.get(r) as ZoneId).sort();
      expect(rest).toEqual([...ONBOARDING_ZONES].sort());
      // the permutation is rngFor(seed, SALT.ONBOARDING).shuffle
      const perm = rngFor(seed, SALT.ONBOARDING).shuffle([...ONBOARDING_ZONES]);
      expect([1, 2, 3, 4].map((r) => byRank.get(r))).toEqual(perm);
      // onboarding exists only on storey 0
      expect(d.onboardingRank(1, 0, 0)).toBe(-1);
    }
  });

  it('forceZone / forceMood hold everywhere', () => {
    const g = createWorldGen(opts(7, { forceZone: Zone.OFFICE, forceMood: Mood.DYING as MoodId }));
    for (let i = 0; i < 300; i++) {
      const s = (i % 3) as StoreyId;
      const di = g.districtAt(s, (i * 37) % 91 - 45, (i * 53) % 77 - 38);
      expect(di.zone).toBe(Zone.OFFICE);
      expect(di.mood).toBe(Mood.DYING);
      expect(g.zoneAt(s, i, -i)).toBe(Zone.OFFICE);
    }
    const dark = createWorldGen(opts(7, { forceZone: Zone.DARK }));
    expect(dark.districtAt(0, 5, 5).mood).toBe(Mood.DARK);
  });

  it('params come from the zone generator with the district rng; identity is stable', () => {
    const d = createDistricts(opts(4242));
    for (let sx = -6; sx <= 6; sx++) {
      for (const s of [0, 1, 2] as StoreyId[]) {
        const di = d.districtBySite(s, sx, 3);
        const expected = generatorFor(di.zone).districtParams(rngFor(4242, SALT.DISTRICT_PARAMS, s, sx, 3), s);
        expect({ ...di.params }).toEqual(expected);
        expect(d.districtBySite(s, sx, 3)).toBe(di); // cached
      }
    }
    // chunk -> district is deterministic across instances
    const d2 = createDistricts(opts(4242));
    for (let i = 0; i < 200; i++) expect(d2.districtAt(1, i - 100, 50 - i).id).toBe(d.districtAt(1, i - 100, 50 - i).id);
  });

  it('districts average ~16 chunks and are warped (not a square grid)', () => {
    const d = createDistricts(opts(31337));
    const sizes = new Map<number, number>();
    for (let cz = -60; cz < 60; cz++) for (let cx = -60; cx < 60; cx++) {
      const id = d.districtAt(0, cx, cz).id;
      sizes.set(id, (sizes.get(id) ?? 0) + 1);
    }
    const mean = (120 * 120) / sizes.size;
    expect(mean).toBeGreaterThan(12);
    expect(mean).toBeLessThan(20);
    const not16 = [...sizes.values()].filter((v) => v !== 16).length;
    expect(not16 / sizes.size).toBeGreaterThan(0.5);
    // every chunk's nearest site is within reach (jitter 1.5 + warp 0.8 + half a site cell)
    const p: [number, number] = [0, 0];
    for (let i = 0; i < 100; i++) {
      const cx = i * 7 - 300, cz = 200 - i * 3;
      const di = d.districtAt(2, cx, cz);
      d.warped(2, cx, cz, p);
      expect(Math.hypot(di.siteX - p[0], di.siteZ - p[1])).toBeLessThan(4.5);
    }
  });
});
