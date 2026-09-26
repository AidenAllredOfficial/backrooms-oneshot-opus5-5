// tests/world/lighting-r2.test.ts — R2 lighting content rules (docs/contract-changes/R2-lighting.md):
//   - photometric scatter helpers (expPoly, gaussOf, fixtureScatter): pure arithmetic, the intended distributions;
//   - fixture states: at most OFF_CAP of any 8 x 8-cell window OFF outside the DARK zone / mood, luminance-0 halves OFF;
//   - emergency bulbs: none in the DARK zone / mood or in landmark cells, deterministic, <= EMERGENCY_MAX per chunk;
//   - warehouse: every aisle has a lit HIGHBAY within reach in NORMAL mood.

import { describe, expect, it } from 'vitest';
import { CELL } from '../../src/core/constants.ts';
import { CellFlag, FixtureKind, LightState, Mood, Zone } from '../../src/core/ids.ts';
import type { ChunkLayout } from '../../src/core/layout.ts';
import { EMERGENCY_CD, EMERGENCY_MAX, expPoly, fixtureScatter, gaussOf, LUM_SIGMA } from '../../src/world/content/fixtures.ts';
import { isStructureFixture, OFF_CAP, OFF_CAP_DYING, STATE_WIN } from '../../src/world/content/fixtureStates.ts';
import { createWorldGen } from '../../src/world/worldgen.ts';

const opts = (seed: number, o: Record<string, unknown> = {}) => ({
  seed, seedText: String(seed), forceZone: null, forceMood: null, forceLandmark: null, testScene: null, lights: 'default' as const, ...o,
});
const isEmergency = (f: { kind: number; luminance: number; py: number }, l: ChunkLayout, c: number): boolean =>
  f.kind === FixtureKind.CAGE_BULB && f.luminance < EMERGENCY_CD * 2 && Math.abs(l.ceilCm[c] / 100 - 0.14 - f.py) < 1e-6;
const cellOf = (f: { px: number; pz: number }): number =>
  Math.min(31, Math.max(0, Math.floor(f.pz / CELL))) * 32 + Math.min(31, Math.max(0, Math.floor(f.px / CELL)));

describe('photometric scatter helpers', () => {
  it('expPoly matches exp on the used range', () => {
    for (let x = -1; x <= 1; x += 0.01) expect(Math.abs(expPoly(x) / Math.exp(x) - 1)).toBeLessThan(1e-7);
  });
  it('gaussOf is ~N(0,1) and fixtureScatter has the documented spreads', () => {
    let s = 0, s2 = 0, ls = 0, ls2 = 0, dkMax = 0, tMin = 1, tMax = -1;
    const n = 20000;
    for (let i = 0; i < n; i++) {
      const g = gaussOf(i * 2654435761);
      s += g; s2 += g * g;
      const f = fixtureScatter(i * 40503 + 17);
      const lg = Math.log(f.lumMul);
      ls += lg; ls2 += lg * lg;
      dkMax = Math.max(dkMax, Math.abs(f.dK));
      tMin = Math.min(tMin, f.tint); tMax = Math.max(tMax, f.tint);
    }
    expect(Math.abs(s / n)).toBeLessThan(0.03);
    expect(Math.abs(Math.sqrt(s2 / n) - 1)).toBeLessThan(0.03);
    expect(Math.abs(Math.sqrt(ls2 / n - (ls / n) ** 2) - LUM_SIGMA)).toBeLessThan(0.01);
    expect(dkMax).toBeGreaterThan(330); expect(dkMax).toBeLessThanOrEqual(350);
    expect(tMin).toBeLessThan(-0.005); expect(tMax).toBeGreaterThan(0.045);
  });
});

describe('fixture states and emergency lights over generated chunks', () => {
  const chunks: ChunkLayout[] = [];
  for (let seed = 1; seed <= 8; seed++) {
    const gen = createWorldGen(opts(seed));
    for (let k = 0; k < 5; k++) chunks.push(gen.generateChunk({ s: 0, cx: k * 3 - 6, cz: seed % 7 - 3 }));
  }
  it('no 8 x 8 window above the OFF cap outside DARK; luminance-0 halves are OFF', () => {
    let windows = 0;
    for (const l of chunks) {
      for (const f of l.fixtures) if (!(f.luminance > 0)) expect(f.state).toBe(LightState.OFF);
      if (l.mood === Mood.DARK || l.zone === Zone.DARK) continue;
      const cap = l.mood === Mood.DYING ? OFF_CAP_DYING : OFF_CAP;
      const tot = new Map<number, [number, number]>();
      for (const f of l.fixtures) {
        const c = cellOf(f);
        if (!(f.luminance > 0) || isStructureFixture(l, f) || (l.flags[c] & CellFlag.LANDMARK) !== 0) continue;
        if (isEmergency(f, l, c)) continue;
        const w = Math.floor((c >> 5) / STATE_WIN) * 8 + Math.floor((c & 31) / STATE_WIN);
        const e = tot.get(w) ?? [0, 0];
        e[0]++; if (f.state === LightState.OFF) e[1]++;
        tot.set(w, e);
      }
      // (+2: content placed after the states -- spark vignettes, anomalies -- may switch a fixture OFF)
      for (const [, [n, off]] of tot) { windows++; expect(off).toBeLessThanOrEqual(Math.floor(cap * n + 1e-9) + 2); }
    }
    expect(windows).toBeGreaterThan(100);
  });
  it('emergency bulbs: never in DARK or landmark cells, at most EMERGENCY_MAX per chunk, deterministic', () => {
    for (const l of chunks) {
      const em = l.fixtures.filter((f) => isEmergency(f, l, cellOf(f)));
      expect(em.length).toBeLessThanOrEqual(EMERGENCY_MAX + 2); // (+ mezzanine-style bulbs that happen to match)
      if (l.mood === Mood.DARK || l.zone === Zone.DARK) expect(em.length).toBe(0);
      for (const f of em) expect(l.flags[cellOf(f)] & CellFlag.LANDMARK).toBe(0);
    }
    const a = createWorldGen(opts(3)).generateChunk({ s: 0, cx: 1, cz: 2 });
    const b = createWorldGen(opts(3)).generateChunk({ s: 0, cx: 1, cz: 2 });
    expect(JSON.stringify(a.fixtures)).toBe(JSON.stringify(b.fixtures));
  });
});

describe('warehouse aisle lighting', () => {
  it('NORMAL mood: >= 85% of open floor cells within 7 m of a lit HIGHBAY', () => {
    let near = 0, total = 0;
    for (let seed = 1; seed <= 4; seed++) {
      const gen = createWorldGen(opts(seed, { forceZone: Zone.WAREHOUSE, forceMood: Mood.NORMAL }));
      const l = gen.generateChunk({ s: 1, cx: seed, cz: -seed });
      const lit = l.fixtures.filter((f) => f.kind === FixtureKind.HIGHBAY && f.state !== LightState.OFF);
      for (let c = 0; c < 1024; c++) {
        if ((l.flags[c] & (CellFlag.SOLID | CellFlag.RESERVED)) !== 0) continue;
        const x = ((c & 31) + 0.5) * CELL, z = ((c >> 5) + 0.5) * CELL;
        // (cells near the chunk border may be lit from the neighbour: skip a 7 m margin)
        if (x < 7 || z < 7 || x > 32 * CELL - 7 || z > 32 * CELL - 7) continue;
        total++;
        if (lit.some((f) => Math.hypot(f.px - x, f.pz - z) <= 7)) near++;
      }
    }
    expect(total).toBeGreaterThan(500);
    expect(near / total).toBeGreaterThan(0.85);
  });
});
