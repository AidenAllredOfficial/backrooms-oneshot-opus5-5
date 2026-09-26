// WP1 — findSpawn / findNearest.
import { describe, expect, it } from 'vitest';
import { CELL, CHUNK_SIZE } from '../../src/core/constants.ts';
import { cellIdx, worldToCell, worldToChunk } from '../../src/core/grid.ts';
import { CellFlag, FixtureKind, LANDMARK_NAMES, LightState, Mood, PropKind, type StoreyId, Zone, ZONE_NAMES } from '../../src/core/ids.ts';
import type { SpawnPoint, WorldGen, WorldGenOptions } from '../../src/core/world.ts';
import { cellWalkable } from '../../src/world/connectivity.ts';
import { CellView, clearFloorAt, rayCells } from '../../src/world/spawn.ts';
import { PROP_DEFS } from '../../src/core/props.ts';
import { towerFrame } from '../../src/world/structures/tower.ts';
import { createWorldGen } from '../../src/world/worldgen.ts';

const opts = (seed: number, o: Partial<WorldGenOptions> = {}): WorldGenOptions => ({
  seed, seedText: String(seed), forceZone: null, forceMood: null, forceLandmark: null, testScene: null, lights: 'default', ...o,
});
const cellOf = (g: WorldGen, p: SpawnPoint) => {
  const cx = worldToChunk(p.x), cz = worldToChunk(p.z);
  const l = g.generateChunk({ s: p.s, cx, cz });
  const c = cellIdx(worldToCell(p.x) - cx * 32, worldToCell(p.z) - cz * 32);
  return { l, c, cx, cz };
};

describe('findSpawn', () => {
  it('is a lit SPAWN_OK cell near the origin (storey 0: the onboarding LOBBY), deterministic', () => {
    for (let seed = 1; seed <= 6; seed++) {
      for (const s of [0, 1, 2] as StoreyId[]) {
        const g = createWorldGen(opts(seed));
        const p = g.findSpawn(s);
        const { l, c, cx, cz } = cellOf(g, p);
        expect(Math.abs(cx)).toBeLessThanOrEqual(1);
        expect(Math.abs(cz)).toBeLessThanOrEqual(1);
        expect(cellWalkable(l, c)).toBe(true);
        expect(l.flags[c] & CellFlag.SPAWN_OK).toBeTruthy();
        expect(Number.isFinite(p.yaw)).toBe(true);
        expect(p.pitch).toBe(0);
        expect(p.y).toBe(l.floorCm[c] / 100);
        const lit = l.fixtures.some((f) => f.state === LightState.ON && Math.hypot(f.px + cx * CHUNK_SIZE - p.x, f.pz + cz * CHUNK_SIZE - p.z) <= 4);
        expect(lit).toBe(true);
        if (s === 0) expect(p.zone).toBe(Zone.LOBBY);
        // determinism (fresh generator)
        expect(createWorldGen(opts(seed)).findSpawn(s)).toEqual(p);
      }
    }
  }, 60_000);
});

describe('findNearest', () => {
  const g = createWorldGen(opts(11));
  const from = { s: 0 as StoreyId, x: 10, z: 10 };

  it('zone: stands in a cell of that zone', () => {
    for (const name of ['OFFICE', 'PILLAR_HALL', 'LOW_EXPANSE']) {
      const p = g.findNearest(`zone:${name}`, from, 24);
      expect(p, name).not.toBeNull();
      const { l, c } = cellOf(g, p as SpawnPoint);
      expect(l.cellZone[c]).toBe(ZONE_NAMES.indexOf(name));
      expect(cellWalkable(l, c)).toBe(true);
      expect(g.districtAt(0, worldToChunk(p!.x), worldToChunk(p!.z)).zone).toBe(ZONE_NAMES.indexOf(name));
    }
    expect(g.findNearest('zone:NOPE', from, 4)).toBeNull();
    expect(g.findNearest('zone:POOLROOMS', { s: 2, x: 0, z: 0 }, 24)).not.toBeNull();
  });

  it('zone:DARK looks into the dark: no emitting fixture within 4 m inside the view cone', () => {
    for (let seed = 1; seed <= 5; seed++) {
      const gd = createWorldGen(opts(seed));
      const p = gd.findNearest('zone:DARK', { s: 0, x: 0, z: 0 }, 24);
      expect(p, `seed ${seed}`).not.toBeNull();
      expect(gd.districtAt(0, worldToChunk(p!.x), worldToChunk(p!.z)).zone).toBe(Zone.DARK);
      const fx = -Math.sin(p!.yaw), fz = -Math.cos(p!.yaw); // yaw = atan2(-dx, -dz)
      const cx = worldToChunk(p!.x), cz = worldToChunk(p!.z);
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        for (const f of gd.generateChunk({ s: 0, cx: cx + dx, cz: cz + dz }).fixtures) {
          if (f.state === LightState.OFF) continue;
          const ex = (cx + dx) * CHUNK_SIZE + f.px - p!.x, ez = (cz + dz) * CHUNK_SIZE + f.pz - p!.z, d = Math.hypot(ex, ez);
          const inCone = d >= 1.4 && d <= 4 && ex * fx + ez * fz >= 0.6 * d;
          expect(inCone, `seed ${seed}: fixture ${f.id} (state ${f.state}) ${d.toFixed(1)} m ahead`).toBe(false);
        }
      }
    }
  }, 60_000);

  it('zone:DARK is not a black frame: some lighting fixture (not an exit sign) lies ahead within 30 m', () => {
    // exit signs glow but light nothing: seed 1's view "saw" only signs and one far fixture through a slit (a black
    // frame); views without a light in them now search a few chunk rings further
    for (let seed = 1; seed <= 7; seed++) {
      const gd = createWorldGen(opts(seed));
      const p = gd.findNearest('zone:DARK', { s: 0, x: 0, z: 0 }, 24);
      expect(p, `seed ${seed}`).not.toBeNull();
      const fx = -Math.sin(p!.yaw), fz = -Math.cos(p!.yaw);
      const cx = worldToChunk(p!.x), cz = worldToChunk(p!.z);
      let ahead = 0;
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        for (const f of gd.generateChunk({ s: 0, cx: cx + dx, cz: cz + dz }).fixtures) {
          if (f.state === LightState.OFF || f.kind === FixtureKind.EXIT_SIGN) continue;
          const ex = (cx + dx) * CHUNK_SIZE + f.px - p!.x, ez = (cz + dz) * CHUNK_SIZE + f.pz - p!.z, d = Math.hypot(ex, ez);
          if (d >= 1.4 && d <= 30 && ex * fx + ez * fz >= 0.6 * d) ahead++;
        }
      }
      expect(ahead, `seed ${seed}`).toBeGreaterThan(0);
    }
  }, 60_000);

  it('tower / elevator: stands at the exit cell facing the door', () => {
    const p = g.findNearest('tower', from, 8) as SpawnPoint;
    expect(p).not.toBeNull();
    const t = g.towersNear(0, worldToChunk(p.x), worldToChunk(p.z)).find((x) => x.cx === worldToChunk(p.x) && x.cz === worldToChunk(p.z));
    expect(t).toBeDefined();
    const e = g.findNearest('elevator', { s: 1, x: 0, z: 0 }, 24);
    expect(e).not.toBeNull();
  });

  it('landmark: stands near the landmark chunk', () => {
    let tried = 0;
    for (let cz = -6; cz <= 6 && tried < 3; cz++) {
      for (let cx = -6; cx <= 6 && tried < 3; cx++) {
        const lm = g.landmarkAt(0, cx, cz);
        if (!lm) continue;
        tried++;
        const p = g.findNearest(`landmark:${LANDMARK_NAMES[lm.kind]}`, { s: 0, x: (cx + 0.5) * CHUNK_SIZE, z: (cz + 0.5) * CHUNK_SIZE }, 4);
        expect(p).not.toBeNull();
        expect(worldToChunk(p!.x)).toBe(cx);
        expect(worldToChunk(p!.z)).toBe(cz);
      }
    }
    expect(tried).toBeGreaterThan(0);
  });

  it('dark / flicker / water / safe / spawn', () => {
    const dark = createWorldGen(opts(11, { forceMood: Mood.DARK })).findNearest('dark', from, 4);
    expect(dark).not.toBeNull();
    const fl = g.findNearest('flicker', from, 6) as SpawnPoint;
    expect(fl).not.toBeNull();
    const { l: fll, cx, cz } = cellOf(g, fl);
    const dyn = [-1, 0, 1].flatMap((dz) => [-1, 0, 1].map((dx) => g.generateChunk({ s: 0, cx: cx + dx, cz: cz + dz })))
      .some((l) => l.fixtures.some((f) => f.dynamic));
    expect(dyn || fll.fixtures.some((f) => f.dynamic)).toBe(true);
    const w = createWorldGen(opts(11, { forceZone: Zone.POOLROOMS })).findNearest('water', { s: 2, x: 0, z: 0 }, 4);
    if (w) expect(Number.isFinite(w.x)).toBe(true);
    const safe = g.findNearest('safe', { s: 0, x: 3.3, z: 7.9 }, 2) as SpawnPoint;
    const sc = cellOf(g, safe);
    expect(cellWalkable(sc.l, sc.c)).toBe(true);
    expect(sc.l.flags[sc.c] & (CellFlag.RESERVED | CellFlag.SEALED)).toBe(0);
    expect(Math.hypot(safe.x - 3.3, safe.z - 7.9)).toBeLessThan(10 * CELL);
    expect(g.findNearest('spawn', from, 1)).toEqual(g.findSpawn(0));
    expect(g.findNearest('bogus', from, 3)).toBeNull();
  }, 30_000);

  it('test scenes answer spawn / tower from the scene', () => {
    const t = createWorldGen(opts(1, { testScene: 'tower' }));
    expect(t.findNearest('tower', from, 4)?.reason).toContain('tower');
    expect(t.findSpawn(1).s).toBe(1);
    expect(t.towersNear(0, 0, 0).length).toBe(1);
  });
});

describe('QA views (R2 B9)', () => {
  const view = (g: WorldGen, s: StoreyId): CellView => new CellView({
    seed: 0, districts: null as never, sites: null as never, layout: (ss, cx, cz) => g.generateChunk({ s: ss, cx, cz }), fields: null as never,
  }, s);
  /** open distance straight ahead and the cells a 7-ray fan sees */
  const look = (g: WorldGen, p: SpawnPoint, pred: (gi: number, gj: number, v: CellView) => boolean): { open: number; seen: number } => {
    const v = view(g, p.s);
    const eye = p.y + 1.6;
    const seen = new Set<string>();
    let open = 0;
    for (const off of [-0.6, -0.4, -0.2, 0, 0.2, 0.4, 0.6]) {
      const a = p.yaw + off;
      const d = rayCells(v, p.x, p.z, -Math.sin(a), -Math.cos(a), eye, 24, (gi, gj) => { if (pred(gi, gj, v)) seen.add(gi + ',' + gj); });
      if (off === 0) open = d;
    }
    return { open, seen: seen.size };
  };

  it('tower: stands on the storey-level landing of the shaft looking up the flight; elevator: framed from outside', () => {
    for (const seed of [1, 7, 11]) {
      const gg = createWorldGen(opts(seed));
      const p = gg.findNearest('tower', { s: 0, x: 10, z: 10 }, 8) as SpawnPoint;
      expect(p, `seed ${seed}`).not.toBeNull();
      expect(p.reason).toContain('tower');
      const cx = worldToChunk(p.x), cz = worldToChunk(p.z);
      const t = gg.towersNear(0, cx, cz).find((x) => x.cx === cx && x.cz === cz);
      expect(t, `seed ${seed}: in a tower chunk`).toBeDefined();
      const { l, c } = cellOf(gg, p);
      expect(l.flags[c] & CellFlag.TOWER, `seed ${seed}: inside the shaft`).not.toBe(0);
      expect(p.y).toBe(0);
      // lane B (u = 1) ascends toward +v from the end0 landing: the camera looks along +v, over lane B
      const f = towerFrame(t!);
      const [dx, dz] = f.dir(0, 1);
      expect(-Math.sin(p.yaw)).toBeCloseTo(dx, 6);
      expect(-Math.cos(p.yaw)).toBeCloseTo(dz, 6);
      const [bx, bz] = f.point(1.5 * CELL, 0.5 * CELL);
      expect(Math.hypot(p.x - (cx * CHUNK_SIZE + bx), p.z - (cz * CHUNK_SIZE + bz)), `seed ${seed}: on the lane B landing`).toBeLessThan(CELL * 0.6);
      expect(p.pitch).toBeGreaterThan(0);
    }
    for (const seed of [1, 7]) {
      const gg = createWorldGen(opts(seed));
      const p = gg.findNearest('elevator', { s: 0, x: 10, z: 10 }, 16) as SpawnPoint;
      if (!p) continue;
      expect(p.reason).toContain('elevator');
      const { l, c } = cellOf(gg, p);
      expect(l.flags[c] & (CellFlag.TOWER | CellFlag.ELEVATOR)).toBe(0);
      const r = look(gg, p, (gi, gj, v) => (v.flags(gi, gj) & CellFlag.ELEVATOR) !== 0);
      if (p.reason.includes('view')) {
        expect(r.open, `seed ${seed}`).toBeGreaterThanOrEqual(4 - 1e-6);
        expect(r.seen, `seed ${seed}: elevator cells in frame`).toBeGreaterThan(0);
      }
    }
  }, 60_000);

  it('landmark:CHAIR_CATHEDRAL: behind the lit chair on the nave floor, chair and pendant in frame', () => {
    for (const seed of [1, 3, 7]) {
      const gg = createWorldGen(opts(seed));
      const p = gg.findNearest('landmark:CHAIR_CATHEDRAL', { s: 0, x: 0, z: 0 }, 24) as SpawnPoint;
      expect(p, `seed ${seed}`).not.toBeNull();
      expect(p.reason).toContain('(chair)');
      const { l } = cellOf(gg, p);
      const ox = worldToChunk(p.x) * CHUNK_SIZE, oz = worldToChunk(p.z) * CHUNK_SIZE;
      const chair = l.props.filter((q) => q.kind === PropKind.CHAIR_STACKING)
        .map((q) => ({ x: ox + q.x, z: oz + q.z, yaw: q.yaw }))
        .sort((a, b) => Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z))[0];
      expect(chair, `seed ${seed}`).toBeDefined();
      const d = Math.hypot(chair.x - p.x, chair.z - p.z);
      expect(d).toBeGreaterThanOrEqual(4.5);
      expect(d).toBeLessThanOrEqual(9.5);
      // looking at the chair, from behind it (the way it faces)
      const fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw);
      expect(((chair.x - p.x) * fx + (chair.z - p.z) * fz) / d).toBeGreaterThan(0.99);
      expect(fx * -Math.sin(chair.yaw) + fz * -Math.cos(chair.yaw)).toBeGreaterThan(0.8);
      // chair seat (0.45 m) and pendant (3.2 m) inside the 62 deg vertical FOV
      const eye = p.y + 1.6;
      for (const y of [0.45, 3.2]) expect(Math.abs(Math.atan2(y - eye, d) - p.pitch), `seed ${seed} y ${y}`).toBeLessThan(0.5);
    }
  }, 60_000);

  it('landmarks (any kind, by name): stands at / in the frame looking in, open view, many frame cells seen', () => {
    const gg = createWorldGen(opts(7));
    let tried = 0;
    for (let cz = -8; cz <= 8 && tried < 4; cz++) {
      for (let cx = -8; cx <= 8 && tried < 4; cx++) {
        const lm = gg.landmarkAt(0, cx, cz);
        if (!lm) continue;
        const l = gg.generateChunk({ s: 0, cx, cz });
        const inst = l.landmarks.find((m) => m.kind === lm.kind);
        if (!inst) continue;
        tried++;
        const name = LANDMARK_NAMES[lm.kind];
        const p = gg.findNearest(`landmark:${name}`, { s: 0, x: (cx + 0.5) * CHUNK_SIZE, z: (cz + 0.5) * CHUNK_SIZE }, 4) as SpawnPoint;
        expect(p, name).not.toBeNull();
        expect(worldToChunk(p.x)).toBe(cx);
        expect(worldToChunk(p.z)).toBe(cz);
        const gi0 = cx * 32, gj0 = cz * 32;
        const inRect = (gi: number, gj: number): boolean => gi >= gi0 + inst.i0 && gi < gi0 + inst.i1 && gj >= gj0 + inst.j0 && gj < gj0 + inst.j1;
        const r = look(gg, p, (gi, gj) => inRect(gi, gj));
        expect(r.open, name).toBeGreaterThanOrEqual(4 - 1e-6);
        const area = (inst.i1 - inst.i0) * (inst.j1 - inst.j0);
        expect(r.seen, `${name}: ${r.seen} of ${area} frame cells seen`).toBeGreaterThanOrEqual(Math.min(20, area / 4));
        // at the frame or at most ~3 m outside it
        const gi = worldToCell(p.x), gj = worldToCell(p.z);
        const out = Math.max(gi0 + inst.i0 - gi, 0, gi - (gi0 + inst.i1 - 1), gj0 + inst.j0 - gj, gj - (gj0 + inst.j1 - 1));
        expect(out * CELL, name).toBeLessThanOrEqual(3 + 2 * CELL);
      }
    }
    expect(tried).toBeGreaterThan(0);
  }, 60_000);

  it('zone:NAME prefers a NORMAL-mood district when one is within reach', () => {
    for (const seed of [7, 11]) {
      const gg = createWorldGen(opts(seed));
      for (const name of ['WAREHOUSE', 'OFFICE']) {
        const p = gg.findNearest(`zone:${name}`, { s: 0, x: 0, z: 0 }, 24);
        if (!p) continue;
        const d = gg.districtAt(0, worldToChunk(p.x), worldToChunk(p.z));
        // a NORMAL district of the zone exists in the searched rings -> it wins
        let normalNear = false;
        const R = Math.max(Math.abs(worldToChunk(p.x)), Math.abs(worldToChunk(p.z)));
        for (let cz = -R; cz <= R && !normalNear; cz++) for (let cx = -R; cx <= R && !normalNear; cx++) {
          const dd = gg.districtAt(0, cx, cz);
          if (dd.zone === ZONE_NAMES.indexOf(name) && dd.mood === Mood.NORMAL) normalNear = true;
        }
        if (normalNear) expect(d.mood, `seed ${seed} ${name}`).toBe(Mood.NORMAL);
      }
    }
  }, 60_000);

  it('flicker prefers the FLICKER channel and aims at it', () => {
    const p = createWorldGen(opts(7, { forceZone: Zone.LOBBY })).findNearest('flicker', { s: 0, x: 0, z: 0 }, 6) as SpawnPoint;
    expect(p).not.toBeNull();
    const gg = createWorldGen(opts(7, { forceZone: Zone.LOBBY }));
    const cx = worldToChunk(p.x), cz = worldToChunk(p.z);
    let aimed = false;
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      for (const f of gg.generateChunk({ s: 0, cx: cx + dx, cz: cz + dz }).fixtures) {
        if (!f.dynamic || f.state !== LightState.FLICKER) continue;
        const ex = (cx + dx) * CHUNK_SIZE + f.px - p.x, ez = (cz + dz) * CHUNK_SIZE + f.pz - p.z;
        const yawTo = Math.atan2(-ex, -ez);
        const dy = Math.atan2(Math.sin(yawTo - p.yaw), Math.cos(yawTo - p.yaw));
        if (Math.abs(dy) < 0.05 && p.pitch > 0) aimed = true;
      }
    }
    expect(aimed).toBe(true);
  }, 30_000);

  it('clear: a point on a desk / in a prop footprint moves to the nearest standable floor; a clear point stays', () => {
    const gg = createWorldGen(opts(6));
    const v = view(gg, 0);
    let checked = 0;
    for (let cz = -2; cz <= 2 && checked < 3; cz++) {
      for (let cx = -2; cx <= 2 && checked < 3; cx++) {
        const l = gg.generateChunk({ s: 0, cx, cz });
        for (const pr of l.props) {
          const def = PROP_DEFS[pr.kind];
          if (!def?.collide || def.size[1] * pr.scale < 0.6 || def.size[0] < 0.8 || def.size[2] < 0.6) continue;
          const x = cx * CHUNK_SIZE + pr.x, z = cz * CHUNK_SIZE + pr.z;
          if (!cellWalkable(l, cellIdx(worldToCell(x) - cx * 32, worldToCell(z) - cz * 32))) continue;
          expect(clearFloorAt(v, x, z)).toBe(false);
          const q = gg.findNearest('clear', { s: 0, x, z }, 2) as SpawnPoint;
          expect(q).not.toBeNull();
          expect(clearFloorAt(v, q.x, q.z)).toBe(true);
          expect(Math.hypot(q.x - x, q.z - z)).toBeLessThan(8 * CELL);
          const k = cellOf(gg, q);
          expect(k.l.ceilCm[k.c] / 100).toBeGreaterThan(q.y + 1.6 + 0.1);
          const again = gg.findNearest('clear', { s: 0, x: q.x, z: q.z }, 2) as SpawnPoint;
          expect([again.x, again.z]).toEqual([q.x, q.z]);
          checked++;
          break;
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
    // the reported repro: seed 6, x -380, z -120 (a desk under a low ceiling)
    const g6 = createWorldGen(opts(6));
    const r = g6.findNearest('clear', { s: 0, x: -380, z: -120 }, 2) as SpawnPoint;
    expect(r).not.toBeNull();
    const k = cellOf(g6, r);
    expect(k.l.ceilCm[k.c] / 100).toBeGreaterThan(r.y + 1.6 + 0.1);
    expect(clearFloorAt(view(g6, 0), r.x, r.z)).toBe(true);
  }, 60_000);
});
