// WP1 — chunk pipeline: determinism, palette setup, arteries, structure zones, test scenes, forced zones,
// performance (GEN_PERF=1) and golden hashes (tests/world/golden.json; UPDATE_GOLDEN=1 rewrites it).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CELL, CHUNK_CELLS, CHUNK_CELL_COUNT, CHUNK_SIZE, GEN_VERSION } from '../../src/core/constants.ts';
import { cellIdx, exIdx, ezIdx } from '../../src/core/grid.ts';
import { CellFlag, EdgeKind, EdgeTrim, PROP_KIND_COUNT, type StoreyId, Zone, type ZoneId, ZONE_COUNT, ZONE_NAMES } from '../../src/core/ids.ts';
import { PROP_DEFS } from '../../src/core/props.ts';
import { cloneLayout, type Fixture } from '../../src/core/layout.ts';
import { Rng } from '../../src/core/rng.ts';
import { TEST_SCENES, type WorldGenOptions } from '../../src/core/world.ts';
import { STRUCTURE_ZONE } from '../../src/core/zones.ts';
import { ARTERY_STYLE } from '../../src/world/arteries.ts';
import { createFieldSampler } from '../../src/world/fields.ts';
import { makeNeighborhood } from '../../src/world/neighborhood.ts';
import { layoutHash, validateLayout } from '../../src/world/validate.ts';
import { createWorldGen } from '../../src/world/worldgen.ts';
import { generatorFor } from '../../src/world/zones/registry.ts';

const N = CHUNK_CELLS;
const opts = (seed: number, o: Partial<WorldGenOptions> = {}): WorldGenOptions => ({
  seed, seedText: String(seed), forceZone: null, forceMood: null, forceLandmark: null, testScene: null, lights: 'default', ...o,
});
const GOLDEN = new URL('./golden.json', import.meta.url);

describe('generateChunk', () => {
  it('is deterministic: 200 random keys hash identically fresh and after 50 other chunks', { tags: ['sweep'] }, () => {
    const rng = new Rng(2025);
    const keys = Array.from({ length: 200 }, () => ({ s: rng.int(0, 2) as StoreyId, cx: rng.int(-400, 400), cz: rng.int(-400, 400) }));
    const others = Array.from({ length: 50 }, () => ({ s: rng.int(0, 2) as StoreyId, cx: rng.int(-400, 400), cz: rng.int(-400, 400) }));
    const fresh = keys.map((k) => createWorldGen(opts(77)).generateChunk(k).hash);
    const g = createWorldGen(opts(77));
    for (const k of others) g.generateChunk(k);
    const warm = keys.map((k) => g.generateChunk(k).hash);
    expect(warm).toEqual(fresh);
    // and the hash is the layoutHash of the returned layout
    const l = g.generateChunk(keys[0]);
    expect(layoutHash(l)).toBe(l.hash);
  });

  it('writes the district palette per cell (wallMat / trimMat) and the hash covers them', () => {
    const g = createWorldGen(opts(5));
    for (let i = 0; i < 12; i++) {
      const key = { s: (i % 3) as StoreyId, cx: i * 3 - 17, cz: 11 - i * 2 };
      const l = g.generateChunk(key);
      const d = g.districtAt(key.s, key.cx, key.cz);
      const pal = generatorFor(d.zone).palette(key.s, d);
      expect(l.zone).toBe(d.zone);
      expect(l.districtId).toBe(d.id);
      let plain = 0, match = 0;
      for (let c = 0; c < CHUNK_CELL_COUNT; c++) {
        if ((l.flags[c] & (CellFlag.RESERVED | CellFlag.LANDMARK | CellFlag.ARTERY)) !== 0) continue;
        plain++;
        if (l.wallMat[c] === pal.wallMat && l.trimMat[c] === pal.trimMat) match++;
      }
      expect(match / Math.max(1, plain)).toBeGreaterThan(0.95);
      const c2 = cloneLayout(l);
      c2.wallMat[0] ^= 1;
      expect(layoutHash(c2)).not.toBe(l.hash);
      const c3 = cloneLayout(l);
      c3.trimMat[5] ^= 1;
      expect(layoutHash(c3)).not.toBe(l.hash);
    }
  });

  it('fields are sampled at cell centres; DARK (decayAdd) raises decay', () => {
    const g = createWorldGen(opts(31, { forceZone: Zone.DARK }));
    const key = { s: 0 as StoreyId, cx: 3, cz: -2 };
    const l = g.generateChunk(key);
    const f = createFieldSampler(31, 0);
    const add = generatorFor(Zone.DARK).lighting(0, g.districtAt(0, 3, -2)).decayAdd ?? 0;
    for (const [li, lj] of [[0, 0], [17, 9], [31, 31]]) {
      const x = key.cx * CHUNK_SIZE + (li + 0.5) * CELL, z = key.cz * CHUNK_SIZE + (lj + 0.5) * CELL;
      const c = cellIdx(li, lj);
      expect(l.power[c]).toBe(Math.floor(f.power(x, z) * 256));
      expect(l.decay[c]).toBe(Math.floor(Math.min(0.999, f.decay(x, z) + add) * 256));
    }
  });

  it('artery chunks: ARTERY|RESERVED lanes with the storey palette, flanking walls with side doors every 4–10 cells, lights', () => {
    const g = createWorldGen(opts(8));
    let found = 0;
    for (let cz = -40; cz < 40 && found < 6; cz++) {
      for (let cx = -40; cx < 40 && found < 6; cx++) {
        const spans = g.arteriesNear(0, cx, cz).filter((a) => (a.axis === 'x' ? Math.floor(a.row / N) === cz && a.g0 <= cx * N && a.g1 > cx * N : Math.floor(a.row / N) === cx && a.g0 <= cz * N && a.g1 > cz * N));
        if (spans.length !== 1) continue;
        const a = spans[0];
        const s = (found % 3) as StoreyId;
        found++;
        const l = g.generateChunk({ s, cx, cz });
        const L = a.row - N * (a.axis === 'x' ? cz : cx);
        let lanes = 0, zoneOk = 0;
        for (let c = 0; c < N; c++) {
          for (let w = 0; w < 2; w++) {
            const cell = a.axis === 'x' ? cellIdx(c, L + w) : cellIdx(L + w, c);
            if ((l.flags[cell] & (CellFlag.ARTERY | CellFlag.RESERVED)) === (CellFlag.ARTERY | CellFlag.RESERVED)) lanes++;
            if (l.cellZone[cell] === ARTERY_STYLE[s].zone || (l.flags[cell] & CellFlag.LANDMARK)) zoneOk++;
          }
        }
        expect(lanes).toBe(2 * N);
        expect(zoneOk).toBe(2 * N);
        // flank walls: WALL runs broken by side doors (OPEN / DOORWAY) at spacing 4..10
        for (const line of [L, L + 2]) {
          const kinds: number[] = [];
          for (let c = 0; c < N; c++) kinds.push(a.axis === 'x' ? l.ez.kind[ezIdx(c, line)] : l.ex.kind[exIdx(line, c)]);
          const walls = kinds.filter((k) => k === EdgeKind.WALL).length;
          const doors = kinds.map((k, i) => (k !== EdgeKind.WALL ? i : -1)).filter((i) => i >= 0);
          if (l.landmarks.length === 0) {
            expect(walls).toBeGreaterThan(N / 2);
            for (let i = 1; i < doors.length; i++) expect(doors[i] - doors[i - 1]).toBeGreaterThanOrEqual(4);
            expect(doors.length).toBeGreaterThanOrEqual(2);
          }
        }
        // lights along the lane
        const laneLights = l.fixtures.filter((f) => {
          const li = Math.floor(f.px / CELL), lj = Math.floor(f.pz / CELL);
          const cc = a.axis === 'x' ? lj : li;
          return cc >= L - 1 && cc <= L + 2;
        });
        expect(laneLights.length).toBeGreaterThanOrEqual(Math.floor(N / ARTERY_STYLE[s].every) - 2);
        expect(validateLayout(l, g)).toEqual([]);
      }
    }
    expect(found).toBeGreaterThanOrEqual(3);
  });

  it('tower and elevator cells belong to STRUCTURE_ZONE; tower exits are walkable', () => {
    const g = createWorldGen(opts(3));
    let towers = 0;
    for (let cz = -8; cz < 8; cz++) {
      for (let cx = -8; cx < 8; cx++) {
        const t = g.towersNear(0, cx, cz).find((x) => x.cx === cx && x.cz === cz);
        if (!t) continue;
        towers++;
        for (const s of [0, 1, 2] as StoreyId[]) {
          const l = g.generateChunk({ s, cx, cz });
          for (let c = 0; c < CHUNK_CELL_COUNT; c++) {
            if ((l.flags[c] & (CellFlag.TOWER | CellFlag.ELEVATOR)) !== 0) expect(l.cellZone[c]).toBe(STRUCTURE_ZONE);
          }
        }
      }
    }
    expect(towers).toBeGreaterThan(8);
  });

  it('every zone generates valid layouts under forceZone (all storeys)', () => {
    for (let z = 0; z < ZONE_COUNT; z++) {
      const g = createWorldGen(opts(100 + z, { forceZone: z as ZoneId }));
      for (let i = 0; i < 6; i++) {
        const key = { s: (i % 3) as StoreyId, cx: i * 5 - 7, cz: 3 - i * 4 };
        const l = g.generateChunk(key);
        expect(l.zone).toBe(z);
        expect(validateLayout(l, g), `${ZONE_NAMES[z]} ${key.s}:${key.cx}:${key.cz}`).toEqual([]);
      }
    }
  });

  it('test scenes: valid, scene at chunk (0,0), SOLID elsewhere (grid tiles everywhere), seams agree', () => {
    for (const id of TEST_SCENES) {
      const g = createWorldGen(opts(1, { testScene: id }));
      const l = g.generateChunk({ s: 0, cx: 0, cz: 0 });
      expect(validateLayout(l, g), id).toEqual([]);
      let walk = 0;
      for (let c = 0; c < CHUNK_CELL_COUNT; c++) if (!(l.flags[c] & CellFlag.SOLID)) walk++;
      expect(walk).toBeGreaterThan(30);
      expect(l.fixtures.length).toBeGreaterThan(0);
      const far = g.generateChunk({ s: 1, cx: 2, cz: -1 });
      if (id === 'grid') expect(far.fixtures.length).toBe(16);
      else expect(Array.from(far.flags).every((f) => (f & CellFlag.SOLID) !== 0)).toBe(true);
      // seam agreement between the scene chunk and its neighbours
      const e = g.generateChunk({ s: 0, cx: 1, cz: 0 });
      for (let c = 0; c < N; c++) expect(l.ex.kind[exIdx(N, c)]).toBe(e.ex.kind[exIdx(0, c)]);
      const sp = g.findSpawn(0);
      expect(sp.reason).toContain(id);
    }
    // flicker scene: exactly one dynamic light plus 3 DYING; cornell has one SKY_PANEL and a grey wall
    const fl = createWorldGen(opts(1, { testScene: 'flicker' })).generateChunk({ s: 0, cx: 0, cz: 0 });
    expect(fl.fixtures.filter((f) => f.dynamic).length).toBe(1);
    expect(fl.fixtures.filter((f) => f.state === 3).length).toBe(3);
    const co = createWorldGen(opts(1, { testScene: 'cornell' })).generateChunk({ s: 0, cx: 0, cz: 0 });
    expect(co.fixtures.filter((f) => f.kind === 2).length).toBe(1);
    const mat = createWorldGen(opts(1, { testScene: 'materials' })).generateChunk({ s: 0, cx: 0, cz: 0 });
    expect(new Set(Array.from(mat.floorMat.slice(0))).size).toBeGreaterThanOrEqual(28);
  });

  it('materials scene: one prop of every kind along the gallery walls, inside the room, not overlapping', () => {
    const l = createWorldGen(opts(1, { testScene: 'materials' })).generateChunk({ s: 0, cx: 0, cz: 0 });
    expect(l.props.map((p) => p.kind).sort((a, b) => a - b)).toEqual(Array.from({ length: PROP_KIND_COUNT }, (_, i) => i));
    const boxes = l.props.map((p) => {
      const d = PROP_DEFS[p.kind].size;
      // facing +-x: the prop's x extent runs along z, its depth along x
      const hx = (d[2] * p.scale) / 2, hz = (d[0] * p.scale) / 2;
      expect(Math.abs(Math.abs(p.yaw) - Math.PI / 2)).toBeLessThan(1e-9);
      expect(p.y + d[1] * p.scale).toBeLessThanOrEqual(2.7);
      return { x0: p.x - hx, x1: p.x + hx, z0: p.z - hz, z1: p.z + hz };
    });
    for (const b of boxes) {
      expect(b.x0).toBeGreaterThanOrEqual(2 * CELL);
      expect(b.x1).toBeLessThanOrEqual(30 * CELL);
      expect(b.z0).toBeGreaterThanOrEqual(2 * CELL);
      expect(b.z1).toBeLessThanOrEqual(30 * CELL);
    }
    for (let a = 0; a < boxes.length; a++) {
      for (let b = a + 1; b < boxes.length; b++) {
        const A = boxes[a], B = boxes[b];
        expect(A.x0 < B.x1 && B.x0 < A.x1 && A.z0 < B.z1 && B.z0 < A.z1, `props ${a} / ${b} overlap`).toBe(false);
      }
    }
  });

  it('lights=on / dead override the test scenes (no dynamic lights; structure lights stay ON)', () => {
    const on = createWorldGen(opts(1, { testScene: 'flicker', lights: 'on' })).generateChunk({ s: 0, cx: 0, cz: 0 });
    expect(on.fixtures.every((f) => f.state === 0 && !f.dynamic)).toBe(true);
    expect(layoutHash(on)).toBe(on.hash);
    const dead = createWorldGen(opts(1, { testScene: 'tower', lights: 'dead' })).generateChunk({ s: 0, cx: 0, cz: 0 });
    expect(dead.fixtures.some((f) => f.bakeGroup === 0 && f.state === 1)).toBe(true);
    expect(dead.fixtures.filter((f) => f.bakeGroup === 0).every((f) => f.state === 1)).toBe(true);
    expect(dead.fixtures.filter((f) => f.bakeGroup !== 0).every((f) => f.state === 0)).toBe(true);
    expect(validateLayout(dead, createWorldGen(opts(1, { testScene: 'tower', lights: 'dead' })))).toEqual([]);
  });

  it('makeNeighborhood: fixturesNear matches brute force; halo edge / cell lookups agree with the layouts', () => {
    const g = createWorldGen(opts(12));
    const ls = [];
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) ls.push(g.generateChunk({ s: 0, cx: 2 + dx, cz: -3 + dz }));
    const nb = makeNeighborhood(ls);
    const all = ls.flatMap((l, idx) => l.fixtures.map((f) => ({ id: f.id, x: f.px + ((idx % 3) - 1) * CHUNK_SIZE, z: f.pz + (Math.floor(idx / 3) - 1) * CHUNK_SIZE })));
    const rng = new Rng(3);
    const out: Fixture[] = [];
    for (let i = 0; i < 300; i++) {
      const x = rng.range(-45, 80), z = rng.range(-45, 80), r = rng.range(0.5, 22);
      nb.fixturesNear(x, z, r, out);
      const want = all.filter((f) => (f.x - x) ** 2 + (f.z - z) ** 2 <= r * r).map((f) => f.id).sort();
      expect(out.map((f) => f.id).sort()).toEqual(want);
      for (const f of out) expect((f.px - x) ** 2 + (f.pz - z) ** 2).toBeLessThanOrEqual(r * r + 1e-9);
    }
    // cells and edges across the halo
    for (let i = 0; i < 500; i++) {
      const li = rng.int(-32, 63), lj = rng.int(-32, 63);
      const idx = (Math.floor(lj / 32) + 1) * 3 + Math.floor(li / 32) + 1;
      const c = cellIdx(((li % 32) + 32) % 32, ((lj % 32) + 32) % 32);
      expect(nb.flags(li, lj)).toBe(ls[idx].flags[c]);
      expect(nb.floorCm(li, lj)).toBe(ls[idx].floorCm[c]);
      expect(nb.exKind(li, lj)).toBe(ls[idx].ex.kind[exIdx(((li % 32) + 32) % 32, ((lj % 32) + 32) % 32)]);
      expect(nb.ezKind(li, lj)).toBe(ls[idx].ez.kind[ezIdx(((li % 32) + 32) % 32, ((lj % 32) + 32) % 32)]);
      const r = nb.room(li, lj);
      if (ls[idx].room[c] !== 0) expect(r).toBe((idx << 12) | ls[idx].room[c]);
      if (nb.flags(li, lj) & CellFlag.SOLID) expect(nb.region(li, lj)).toBe(0);
      else expect(nb.region(li, lj)).toBeGreaterThan(0);
    }
    // the east seam line seen from the centre (i = 32) and from the east chunk (its line 0) agree
    for (let j = 0; j < N; j++) expect(nb.exKind(32, j)).toBe(ls[5].ex.kind[exIdx(0, j)]);
    expect(nb.exKind(64, 5)).toBe(ls[5].ex.kind[exIdx(32, 5)]);
    expect(nb.solids().length).toBe(ls.reduce((a, l) => a + l.solids.length, 0));
  });

  it('baseboards follow the palette on interior walls', () => {
    const g = createWorldGen(opts(9, { forceZone: Zone.LOBBY }));
    const l = g.generateChunk({ s: 0, cx: 4, cz: 4 });
    let walls = 0, withBase = 0;
    for (let k = 0; k < l.ex.kind.length; k++) {
      const i = k % 33;
      if (i === 0 || i === 32 || l.ex.kind[k] !== EdgeKind.WALL) continue;
      walls++;
      if (l.ex.trim[k] & EdgeTrim.BASEBOARD) withBase++;
    }
    expect(walls).toBeGreaterThan(0);
    expect(withBase / walls).toBeGreaterThan(0.9);
  });

  it.skipIf(!process.env.GEN_PERF)('performance: mean <= 6 ms, p95 <= 12 ms over 100 chunks', () => {
    // measured in a plain Node process (tools/map.ts --bench): vitest's module transform turns every cross-module
    // call into a property lookup, which roughly doubles the cost of hot generator loops.
    const out = execFileSync(process.execPath, ['tools/map.ts', '--seed', '424242', '--bench', '100'], { encoding: 'utf8' });
    const r = JSON.parse(out.trim().split('\n').pop() as string) as { mean: number; p95: number; max: number };
    console.log(`generateChunk: mean ${r.mean.toFixed(2)} ms, p95 ${r.p95.toFixed(2)} ms, max ${r.max.toFixed(2)} ms`);
    expect(r.mean).toBeLessThanOrEqual(6);
    expect(r.p95).toBeLessThanOrEqual(12);
  });

  it('golden hashes (3 chunks per zone)', () => {
    const entries: { zone: string; s: number; cx: number; cz: number; hash: number }[] = [];
    for (let z = 0; z < ZONE_COUNT; z++) {
      const g = createWorldGen(opts(1, { forceZone: z as ZoneId }));
      for (let i = 0; i < 3; i++) {
        const key = { s: i as StoreyId, cx: z * 3 + i - 10, cz: 7 - z * 2 };
        entries.push({ zone: ZONE_NAMES[z], ...key, hash: g.generateChunk(key).hash });
      }
    }
    if (process.env.UPDATE_GOLDEN) {
      writeFileSync(GOLDEN, JSON.stringify({ genVersion: GEN_VERSION, seed: 1, entries }, null, 1) + '\n');
      return;
    }
    if (!existsSync(GOLDEN)) {
      console.warn('tests/world/golden.json missing: created during integration with UPDATE_GOLDEN=1 (skipped)');
      return;
    }
    const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as { genVersion: number; entries: typeof entries };
    expect(golden.genVersion, 'GEN_VERSION changed: regenerate golden.json with UPDATE_GOLDEN=1').toBe(GEN_VERSION);
    expect(entries).toEqual(golden.entries);
  });
});
