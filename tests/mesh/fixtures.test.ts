// tests/mesh/fixtures.test.ts — WP5 acceptance: recessed fixtures are emitted whole in the tile containing their
// centre (never split across tiles), lens emission / flags / shimmer inputs follow rule 6, and dynLights slots match
// tileOfPoint of the neighbourhood's dynamic fixtures. Graphics-realism C.2: every lens (OFF included) carries its
// emitter profile (aux.x = size / lamp axis, aux.z = profile | variant, aux.w = state, tint.a = seed & 255).

import { describe, expect, test, vi } from 'vitest';
import { CELL, CHUNK_SIZE } from '../../src/core/constants.ts';
import { tileCell0, tileOfPoint } from '../../src/core/grid.ts';
import { EP, recessedProfile, unpackLensParam, unpackProfile } from '../../src/core/emitterProfile.ts';
import { DYING_MEAN, FixtureKind, LightState, Mat, VFlag, Zone, isRecessedFixture, type StoreyId, type ZoneId } from '../../src/core/ids.ts';
import { fixtureRadiance, type Fixture } from '../../src/core/layout.ts';
import { DYN_SLOT_OFFSETS, type MeshBuffers } from '../../src/core/mesh.ts';
import type { LayoutNeighborhood } from '../../src/core/world.ts';
import { buildTile } from '../../src/mesh/buildTile.ts';
import { mixNb } from './fixtures.ts';
import { genNb, tileKey, tri } from './helpers.ts';

vi.setConfig({ testTimeout: 180_000 }); // heavy generation + meshing under shared-machine load

/** Lens triangles (PANEL_LENS) of a buffer: [chunk-local centre x, z, area, first vertex]. */
function lensTris(m: MeshBuffers, ox: number, oz: number): [number, number, number, number][] {
  const out: [number, number, number, number][] = [];
  for (let t = 0; t < m.indexCount / 3; t++) {
    const v = m.index[t * 3];
    if (m.layer[v] !== Mat.PANEL_LENS) continue;
    const T = tri(m, t);
    out.push([T.centre[0] + ox, T.centre[2] + oz, T.area, v]);
  }
  return out;
}

function recessedIn(f: Fixture, x: number, z: number): boolean {
  const alongX = Math.abs(f.tx) >= Math.abs(f.tz);
  const hx = (alongX ? f.w : f.h) / 2, hz = (alongX ? f.h : f.w) / 2;
  return Math.abs(x - f.px) < hx + 1e-4 && Math.abs(z - f.pz) < hz + 1e-4;
}

describe('recessed fixtures (straddle rule)', () => {
  test('lens geometry of every recessed fixture lies whole in tileOfPoint(px, pz)', () => {
    const cases: [number, StoreyId, number, number, ZoneId][] = [[2, 0, 0, 0, Zone.LOBBY], [2, 0, 1, 0, Zone.OFFICE], [2, 0, 0, 1, Zone.LOW_EXPANSE], [2, 2, 0, 0, Zone.POOLROOMS], [4, 0, -1, 2, Zone.MANILA]];
    let checked = 0;
    for (const [seed, s, cx, cz, z] of cases) {
      const nb = genNb(seed, s, cx, cz, z);
      const lens: [number, number, number, number, number][] = [];
      for (let q = 0; q < 4; q++) {
        const { mesh } = buildTile(nb, tileKey(s, cx, cz, q), 8);
        const [li0, lj0] = tileCell0(q);
        for (const l of lensTris(mesh.shell, li0 * CELL, lj0 * CELL)) lens.push([...l, q]);
      }
      for (const f of nb.center.fixtures) {
        if (!isRecessedFixture(f.kind)) continue;
        const mine = lens.filter((l) => recessedIn(f, l[0], l[1]));
        const tiles = new Set(mine.map((l) => l[4]));
        expect([...tiles]).toEqual([tileOfPoint(f.px, f.pz)]);
        const area = mine.reduce((a, l) => a + l[2], 0);
        expect(area).toBeCloseTo(f.w * f.h, 4);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(20);
  });

  test('lens emit / tint / flags per state (ON, OFF, DYING, FLICKER-dynamic)', () => {
    const nb = mixNb();
    const seen = new Set<number>();
    for (let q = 0; q < 4; q++) {
      const { mesh } = buildTile(nb, tileKey(0, 0, 0, q), 12);
      const m = mesh.shell;
      const [li0, lj0] = tileCell0(q);
      for (const [x, z, , v] of lensTris(m, li0 * CELL, lj0 * CELL)) {
        const f = nb.center.fixtures.find((ff) => recessedIn(ff, x, z));
        expect(f).toBeDefined();
        if (!f) continue;
        seen.add(f.state);
        const flags = m.flags[v], emit = m.emit[v];
        const tint = [m.tint[v * 4], m.tint[v * 4 + 1], m.tint[v * 4 + 2], m.tint[v * 4 + 3]];
        const aux3 = m.aux[v * 4 + 3];
        // emitter profile contract, every state
        const alongX = Math.abs(f.tx) >= Math.abs(f.tz);
        const U = Math.round((alongX ? f.w : f.h) / 0.6), V = Math.round((alongX ? f.h : f.w) / 0.6);
        expect(unpackLensParam(m.aux[v * 4])).toEqual([U, V, alongX ? 0 : 1]);
        expect(m.aux[v * 4 + 1]).toBe(0);
        const [ep, variant] = unpackProfile(m.aux[v * 4 + 2]);
        const want = recessedProfile(f.kind, U, V, alongX ? 0 : 1, f.seed, nb.center.zone);
        expect([ep, variant]).toEqual([want.ep, want.variant]);
        expect(ep).toBe(f.kind === FixtureKind.SKY_PANEL ? EP.OPAL : ep === EP.LOUVER ? EP.LOUVER : EP.PRISM);
        expect(tint[3]).toBe(f.seed & 255);
        if (f.kind === FixtureKind.TROFFER_2x4) expect(U * V).toBe(2);
        switch (f.state) {
          case LightState.ON:
            expect(emit).toBeCloseTo(fixtureRadiance(f), 3);
            expect(flags & (VFlag.DYN_EMIT | VFlag.SHIMMER)).toBe(0);
            expect(tint[0]).toBe(Math.round(f.color[0] * 255));
            expect(aux3).toBe(LightState.ON);
            break;
          case LightState.OFF:
            expect(emit).toBe(0);
            expect(tint.slice(0, 3)).toEqual([Math.round(0.55 * 255), Math.round(0.53 * 255), Math.round(0.5 * 255)]);
            expect(aux3).toBe(LightState.OFF);
            break;
          case LightState.DYING:
            expect(emit).toBeCloseTo(fixtureRadiance(f) * DYING_MEAN, 3);
            expect(flags & VFlag.SHIMMER).toBe(VFlag.SHIMMER);
            expect(aux3).toBe(f.state);
            expect(tint[3]).toBe(f.seed & 255);
            break;
          case LightState.FLICKER:
            expect(f.dynamic).toBe(true);
            expect(emit).toBeCloseTo(fixtureRadiance(f), 3);
            expect(flags & VFlag.DYN_EMIT).toBe(VFlag.DYN_EMIT);
            expect(aux3).toBe(f.state);
            expect(tint[3]).toBe(f.seed & 255);
            break;
          default: break;
        }
      }
    }
    expect([...seen].sort()).toEqual([LightState.ON, LightState.OFF, LightState.FLICKER, LightState.DYING].sort());
  });
});

describe('dynLights', () => {
  function expected(nb: LayoutNeighborhood, cx: number, cz: number, q: number, dx: number, dz: number): Fixture | null {
    const gtx = (q & 1) + dx, gtz = (q >> 1) + dz;
    const dcx = Math.floor(gtx / 2), dcz = Math.floor(gtz / 2);
    const tq = (gtx - 2 * dcx) + 2 * (gtz - 2 * dcz);
    const l = nb.get(dcx as -1 | 0 | 1, dcz as -1 | 0 | 1);
    const list = l.fixtures.filter((f) => f.dynamic && tileOfPoint(f.px, f.pz) === tq);
    expect(list.length).toBeLessThanOrEqual(1);
    void cx; void cz;
    return list[0] ?? null;
  }
  test('the 9 slots hold the dynamic fixture of each neighbouring tile, in world metres', () => {
    let found = 0;
    for (const [seed, s, cx, cz] of [[1, 0, 0, 0], [3, 0, 2, -1], [8, 0, -3, 4], [5, 1, 1, 1]] as [number, StoreyId, number, number][]) {
      const nb = genNb(seed, s, cx, cz);
      for (let q = 0; q < 4; q++) {
        const { mesh } = buildTile(nb, tileKey(s, cx, cz, q), 8);
        expect(mesh.dynLights.length).toBe(9);
        DYN_SLOT_OFFSETS.forEach(([dx, dz], i) => {
          const f = expected(nb, cx, cz, q, dx, dz);
          const r = mesh.dynLights[i];
          if (!f) { expect(r).toBeNull(); return; }
          found++;
          expect(r).not.toBeNull();
          const gtx = (q & 1) + dx, gtz = (q >> 1) + dz;
          const ocx = (cx + Math.floor(gtx / 2)) * CHUNK_SIZE, ocz = (cz + Math.floor(gtz / 2)) * CHUNK_SIZE;
          expect(r).toEqual({ id: f.id, state: f.state, seed: f.seed, color: [...f.color], x: ocx + f.px, y: f.py, z: ocz + f.pz });
        });
      }
    }
    expect(found).toBeGreaterThan(0);
  });
});
