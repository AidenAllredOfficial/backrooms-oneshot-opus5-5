// tests/props/tileProps.test.ts — WP6 buildTileProps (§5 WP6): contents per tile (props by origin after
// expandPeriodicProps, non-recessed fixtures by tileOfPoint after expandPeriodicFixtures, pipes of nb.center by
// midpoint), null for empty tiles, PROP_AUX anchor-cell metadata (tower bit, ceiling byte), determinism, and the
// per-tile props triangle report on generated chunks (target <= 40k).

import { describe, expect, it, vi } from 'vitest';
import { CELL } from '../../src/core/constants.ts';
import { cellIdx, type TileKey } from '../../src/core/grid.ts';
import { CellFlag, FixtureKind, LightState, Mat, Mood, PropKind, StructureKind, VFlag, Zone, type PropKindId, type StoreyId, type ZoneId } from '../../src/core/ids.ts';
import { createEmptyLayout, type ChunkLayout, type Fixture, type PropPlacement } from '../../src/core/layout.ts';
import { GeometryWriter } from '../../src/core/writer.ts';
import { emitFixture, emitPipe, propTris } from '../../src/props/index.ts';
import { buildTileProps, dustLevelOf, lastTilePropsStats } from '../../src/props/tileProps.ts';
import { bounds, fakeNeighborhood, genNb, validate, windingMismatch } from './meshUtil.ts';

vi.setConfig({ testTimeout: 120_000 });

const key = (q: 0 | 1 | 2 | 3, s: StoreyId = 0): TileKey => ({ s, cx: 0, cz: 0, q });

function openLayout(ceilCm = 270): ChunkLayout {
  const l = createEmptyLayout({ s: 0, cx: 0, cz: 0 }, Zone.LOBBY, 0, Mood.NORMAL);
  l.ceilCm.fill(ceilCm);
  return l;
}
const prop = (kind: number, x: number, z: number, extra: Partial<PropPlacement> = {}): PropPlacement =>
  ({ kind: kind as PropKindId, variant: 0, x, y: 0, z, yaw: 0, scale: 1, flags: 0, seed: 7, ...extra });
const fixture = (kind: number, x: number, y: number, z: number, extra: Partial<Fixture> = {}): Fixture => ({
  id: 99, kind: kind as Fixture['kind'], state: LightState.ON, shape: 0, px: x, py: y, pz: z, nx: 0, ny: -1, nz: 0, tx: 1, ty: 0, tz: 0,
  w: 1.2, h: 0.1, color: [1, 0.95, 0.9], luminance: 8600, seed: 1234, hum: 0.5, bakeGroup: 0, dynamic: false, ...extra,
});
const fixtureTris = (f: Fixture): number => { const w = new GeometryWriter(64); emitFixture(w, f, 0, 0); return w.indexCount / 3; };

describe('WP6 buildTileProps', () => {
  it('returns null for a tile with no props, surface fixtures or pipes (recessed fixtures belong to WP5)', () => {
    const l = openLayout();
    l.fixtures.push(fixture(FixtureKind.TROFFER_2x4, 3.0, 2.7, 3.0, { w: 1.2, h: 0.6, luminance: 3300 }));
    const nb = fakeNeighborhood(l);
    for (const q of [0, 1, 2, 3] as const) expect(buildTileProps(nb, key(q))).toBeNull();
  });

  it('emits exactly the props whose origin lies in the tile, whole, in tile-local metres', () => {
    const l = openLayout();
    // tile 0: a desk straddling the x = 19.2 line (origin inside tile 0) and a chair; tile 1: a crate; tile 3: a cone
    l.props.push(prop(PropKind.DESK, 18.9, 5), prop(PropKind.OFFICE_CHAIR, 4, 4), prop(PropKind.CRATE, 25, 6), prop(PropKind.CONE, 30, 30));
    const nb = fakeNeighborhood(l);
    const m0 = buildTileProps(nb, key(0))!;
    expect(m0.indexCount / 3).toBe(propTris(PropKind.DESK, 0) + propTris(PropKind.OFFICE_CHAIR, 0));
    expect(lastTilePropsStats.props).toBe(2);
    expect(bounds(m0)[3]).toBeGreaterThan(19.2); // the desk is emitted whole in its origin tile
    const m1 = buildTileProps(nb, key(1))!;
    expect(m1.indexCount / 3).toBe(propTris(PropKind.CRATE, 0));
    const b1 = bounds(m1);
    expect(b1[0]).toBeCloseTo(25 - 19.2 - 0.5, 3); // tile-local
    expect(buildTileProps(nb, key(2))).toBeNull();
    expect(buildTileProps(nb, key(3))!.indexCount / 3).toBe(propTris(PropKind.CONE, 0));
    for (const m of [m0, m1]) {
      expect(validate(m)).toEqual([]);
      expect(windingMismatch(m)).toBe(0);
    }
  });

  it('adds non-recessed fixtures by tileOfPoint and pipes of nb.center by midpoint', () => {
    const l = openLayout(300);
    const tube = fixture(FixtureKind.TUBE_STRIP, 30, 2.95, 30);
    l.fixtures.push(tube, fixture(FixtureKind.TROFFER_2x2, 30.6, 3.0, 25.2, { w: 0.6, h: 0.6, luminance: 3000 }));
    // pipe from tile 2 into tile 3 whose midpoint (20.4) lies in tile 3
    const pipe = { kind: 'pipe' as const, id: 1, a: [15, 2.6, 25] as [number, number, number], b: [25.8, 2.6, 25] as [number, number, number], r: 0.05, mat: Mat.METAL_PAINTED, flags: 0 };
    l.solids.push(pipe);
    const nb = fakeNeighborhood(l);
    const m3 = buildTileProps(nb, key(3))!;
    const pw = new GeometryWriter(256);
    emitPipe(pw, pipe, [pipe], 0, 0);
    expect(lastTilePropsStats.fixtures).toBe(1);
    expect(lastTilePropsStats.pipes).toBe(1);
    expect(lastTilePropsStats.fixtureTris).toBe(fixtureTris(tube));
    expect(m3.indexCount / 3).toBe(lastTilePropsStats.tris);
    expect(buildTileProps(nb, key(2))).toBeNull(); // the pipe is owned by its midpoint's tile only
    // emissive tube strip, ceiling at 3.0 m: its suspension reaches the ceiling
    expect(bounds(m3)[4]).toBeCloseTo(3.0, 2);
    let emissive = 0;
    for (let i = 0; i < m3.vertexCount; i++) if (m3.emit[i] > 0) emissive++;
    expect(emissive).toBeGreaterThan(0);
  });

  it('content anchored on the chunk seam belongs to the edge tile (tileOfPoint clamps); seam-crossing pipes do not', () => {
    const l = openLayout(300);
    // a wall-mounted outlet whose origin is exactly on the east seam (x = 38.4) and an EXIT sign on the south seam
    l.props.push(prop(PropKind.OUTLET, 38.4, 5, { y: 0.3 }));
    l.fixtures.push(fixture(FixtureKind.EXIT_SIGN, 20, 2.3, 38.4, { nx: 0, ny: 0, nz: -1, tx: 1, ty: 0, tz: 0, w: 0.3, h: 0.15, luminance: 60 }));
    // a pipe added to this chunk because it crosses the east seam, but whose midpoint (x = 39.4) lies in the
    // neighbour: the neighbour owns it
    l.solids.push({ kind: 'pipe', id: 1, a: [36, 2.6, 10], b: [42.8, 2.6, 10], r: 0.05, mat: Mat.METAL_PAINTED, flags: 0 });
    const nb = fakeNeighborhood(l);
    const m1 = buildTileProps(nb, key(1))!;
    expect(lastTilePropsStats.props).toBe(1);
    expect(lastTilePropsStats.pipes).toBe(0);
    expect(m1.indexCount / 3).toBe(propTris(PropKind.OUTLET, 0));
    buildTileProps(nb, key(3));
    expect(lastTilePropsStats.fixtures).toBe(1);
  });

  it('PROP_AUX carries the anchor cell: tower bit (with periodic replicas) and ceilCm / 5', () => {
    const l = openLayout(285);
    // a tower footprint cell block with a handrail inside it
    for (let j = 10; j < 15; j++) for (let i = 10; i < 13; i++) l.flags[cellIdx(i, j)] |= CellFlag.TOWER | CellFlag.RESERVED;
    l.structures.push({ id: 5, kind: StructureKind.TOWER, bakeGroup: 777, i0: 10, j0: 10, i1: 13, j1: 15, rot: 0, portal: null });
    l.props.push(prop(PropKind.HANDRAIL, 11.5 * CELL, 12.5 * CELL, { y: 0.2 }), prop(PropKind.TRASH_CAN, 3, 3));
    const nb = fakeNeighborhood(l);
    const m = buildTileProps(nb, key(0))!;
    // replicas at y + 3k, k in [-2, 2], clipped to |y| <= 6 (y = -5.8, -2.8, 0.2, 3.2; 6.2 is dropped)
    expect(m.indexCount / 3).toBe(4 * propTris(PropKind.HANDRAIL, 0) + propTris(PropKind.TRASH_CAN, 0));
    let tower = 0, plain = 0;
    for (let i = 0; i < m.vertexCount; i++) {
      expect(m.flags[i] & VFlag.PROP_AUX).toBe(VFlag.PROP_AUX);
      expect(m.aux[i * 4 + 3]).toBe(57); // 285 / 5
      if (m.aux[i * 4 + 2] & 1) tower++;
      else plain++;
    }
    expect(tower).toBeGreaterThan(0);
    expect(plain).toBeGreaterThan(0);
    const b = bounds(m);
    expect(b[1]).toBeLessThan(-4.9); // the k = -2 replica (base -5.8, rail brackets from +0.815)
    expect(b[4]).toBeGreaterThan(4); // the k = +1 replica (base 3.2, rail at +0.9)
  });

  it('PROP_AUX dust bits 2-7 follow the anchor cell decay; bit 0 stays the tower flag; floats never gather dust', () => {
    // monotonic in decay, a light film in fresh cells, full at the top
    let prev = -1;
    for (let d = 0; d <= 255; d++) {
      const v = dustLevelOf(d);
      expect(v).toBeGreaterThanOrEqual(prev);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(63);
      prev = v;
    }
    expect(dustLevelOf(0)).toBe(6);
    expect(dustLevelOf(255)).toBe(63);
    const l = openLayout(285);
    for (let j = 10; j < 15; j++) for (let i = 10; i < 13; i++) l.flags[cellIdx(i, j)] |= CellFlag.TOWER | CellFlag.RESERVED;
    l.structures.push({ id: 5, kind: StructureKind.TOWER, bakeGroup: 777, i0: 10, j0: 10, i1: 13, j1: 15, rot: 0, portal: null });
    l.decay[cellIdx(Math.floor(11.5), Math.floor(12.5))] = 200;
    l.decay[cellIdx(5, 5)] = 20;
    l.props.push(prop(PropKind.HANDRAIL, 11.5 * CELL, 12.5 * CELL, { y: 0.2 }), prop(PropKind.CRATE, 5.5 * CELL, 5.5 * CELL),
      prop(PropKind.POOL_FLOAT, 2.5 * CELL, 12.5 * CELL));
    const nb = fakeNeighborhood(l);
    const m = buildTileProps(nb, key(0))!;
    const seen = new Set<number>();
    for (let i = 0; i < m.vertexCount; i++) {
      const z = m.aux[i * 4 + 2];
      expect(z & 2).toBe(0); // bit 1 (clearcoat) is PartBuilder's, never set by the anchor bits
      seen.add(z);
    }
    expect(seen.has(1 | (dustLevelOf(200) << 2))).toBe(true); // tower handrail in a decayed cell
    expect(seen.has(dustLevelOf(20) << 2)).toBe(true); // crate in a fresh cell
    expect(seen.has(0)).toBe(true); // the pool float
    expect(dustLevelOf(200)).toBeGreaterThan(dustLevelOf(20));
  });

  it('is deterministic (byte-identical buffers)', () => {
    const nb = genNb(21, 0, 0, 0, Zone.OFFICE);
    for (const q of [0, 1, 2, 3] as const) {
      const a = buildTileProps(nb, key(q)), b = buildTileProps(nb, key(q));
      expect(a === null).toBe(b === null);
      if (!a || !b) continue;
      expect(Buffer.from(a.position.buffer).equals(Buffer.from(b.position.buffer))).toBe(true);
      expect(Buffer.from(a.index.buffer).equals(Buffer.from(b.index.buffer))).toBe(true);
      expect(Buffer.from(a.tint.buffer).equals(Buffer.from(b.tint.buffer))).toBe(true);
      expect(Buffer.from(a.aux.buffer).equals(Buffer.from(b.aux.buffer))).toBe(true);
      expect(Array.from(a.emit)).toEqual(Array.from(b.emit));
    }
  });

  it('reports the per-tile props triangle count on generated chunks (target <= 40k)', () => {
    const cases: [ZoneId, StoreyId, number, number][] = [
      [Zone.OFFICE, 0, 0, 0], [Zone.OFFICE, 0, 1, 0], [Zone.LOBBY, 0, 0, 0], [Zone.PILLAR_HALL, 0, 0, 0],
      [Zone.WAREHOUSE, 1, 0, 0], [Zone.WAREHOUSE, 1, 1, 1], [Zone.PIPEWORKS, 1, 0, 0], [Zone.PIPEWORKS, 1, 1, 0],
      [Zone.PARKING, 1, 0, 0], [Zone.CONCRETE, 1, 0, 0], [Zone.POOLROOMS, 2, 0, 0], [Zone.POOLROOMS, 2, 0, 1],
    ];
    const rows: string[] = [];
    let worst = 0, worstPipeworks = 0;
    for (const [zone, s, cx, cz] of cases) {
      const nb = genNb(7, s, cx, cz, zone);
      for (const q of [0, 1, 2, 3] as const) {
        const t0 = performance.now();
        const m = buildTileProps(nb, { s, cx, cz, q });
        const ms = performance.now() - t0;
        const st = lastTilePropsStats;
        if (m) {
          expect(validate(m)).toEqual([]);
          expect(m.indexCount / 3).toBe(st.tris);
        }
        if (zone === Zone.PIPEWORKS) worstPipeworks = Math.max(worstPipeworks, st.tris);
        else worst = Math.max(worst, st.tris);
        rows.push(`${String(zone).padStart(2)} ${s}:${cx}:${cz}:${q}  tris ${String(st.tris).padStart(6)}  (props ${st.props} / ${st.propTris}, fixtures ${st.fixtures} / ${st.fixtureTris}, pipes ${st.pipes} / ${st.pipeTris})  ${ms.toFixed(1)} ms`);
      }
    }
    console.log('[WP6] per-tile props mesh (zone s:cx:cz:q)\n' + rows.join('\n') +
      `\nworst tile: ${worst} tris (target <= 40000); PIPEWORKS worst ${worstPipeworks} tris`);
    expect(worst).toBeLessThanOrEqual(40_000);
    // PIPEWORKS generates ~160-300 pipe solids (100-170 elbows) and ~30 cage bulbs per tile (WP3 density); every elbow is a 6 x 10 torus
    // section per the spec, so the tile exceeds the 40k target. Hard ceiling to catch regressions:
    expect(worstPipeworks).toBeLessThanOrEqual(60_000);
  });
});
