// tests/props/fixtures.test.ts — WP6 surface fixtures (§5 WP6 "Surface fixtures" + acceptance "Emitter
// calibration"): for every non-recessed kind and several mountings, (emissive nits x projected emissive area along
// the fixture normal) is within 20% of the intensity (SPHERE / disk) or of L*w*h (RECT); SPHERE geometry has radius
// exactly w/2 and the HIGHBAY disk radius w/2; state handling (OFF / DYING / BUZZ / dynamic FLICKER / ANOMALY):
// emit scale, DYN_EMIT / SHIMMER flags, aux.w = state and tint.a = seed & 255 on those vertices; tint = colour;
// suspensions reach the ceiling (HIGHBAY: the joist at ceil - 0.6); winding follows normals; no NaN.
// Graphics-realism C.3: emissive parts carry their emitter profile (aux.z bits 1-4 / 5-7, aux.x) with the profile's
// uv scheme, lens sides and OFF fixtures stay legacy, and non-emissive parts keep aux.z = the prop's bits.

import { describe, expect, it } from 'vitest';
import { EP, unpackProfile } from '../../src/core/emitterProfile.ts';
import { DYING_MEAN, FixtureKind, LightState, Mat, VFlag, type FixtureKindId, type LightStateId } from '../../src/core/ids.ts';
import { fixtureRadiance, type Fixture } from '../../src/core/layout.ts';
import type { MeshBuffers } from '../../src/core/mesh.ts';
import { GeometryWriter } from '../../src/core/writer.ts';
import { emitFixture } from '../../src/props/index.ts';
import { PartBuilder } from '../../src/props/builder.ts';
import { emitFixtureInto } from '../../src/props/fixtures.ts';
import { bounds, mirroredAtlasTris, triNormal, validate, windingMismatch } from './meshUtil.ts';

/** Typical generation dimensions (mirrors WP4's FIXTURE_DIMS and the zone generators' custom fixtures). */
const DIMS: Readonly<Record<number, { shape: 0 | 1; w: number; h: number; lum: number }>> = {
  [FixtureKind.TUBE_STRIP]: { shape: 0, w: 1.2, h: 0.1, lum: 8600 },
  [FixtureKind.CAGE_BULB]: { shape: 1, w: 0.1, h: 0.1, lum: 64 },
  [FixtureKind.HIGHBAY]: { shape: 1, w: 0.45, h: 0.45, lum: 9000 },
  [FixtureKind.PENDANT_LINEAR]: { shape: 0, w: 1.2, h: 0.12, lum: 6000 },
  [FixtureKind.SODIUM]: { shape: 0, w: 0.45, h: 0.25, lum: 9000 },
  [FixtureKind.EXIT_SIGN]: { shape: 0, w: 0.3, h: 0.15, lum: 150 },
  [FixtureKind.UNDERWATER]: { shape: 0, w: 0.3, h: 0.3, lum: 2500 },
  [FixtureKind.VENDING]: { shape: 0, w: 0.7, h: 1.4, lum: 600 },
  [FixtureKind.RED_BULB]: { shape: 1, w: 0.08, h: 0.08, lum: 150 },
};
const SURFACE_KINDS = Object.keys(DIMS).map(Number) as FixtureKindId[];
const WALL_KINDS = new Set<number>([FixtureKind.EXIT_SIGN, FixtureKind.UNDERWATER, FixtureKind.VENDING]);

interface Mount { name: string; n: [number, number, number]; t: [number, number, number] }
const DOWN_X: Mount = { name: 'ceiling, t=+x', n: [0, -1, 0], t: [1, 0, 0] };
const DOWN_Z: Mount = { name: 'ceiling, t=+z', n: [0, -1, 0], t: [0, 0, 1] };
const WALL_E: Mount = { name: 'wall facing +x', n: [1, 0, 0], t: [0, 0, 1] };
const WALL_N: Mount = { name: 'wall facing -z', n: [0, 0, -1], t: [1, 0, 0] };
const WALL_S_UPT: Mount = { name: 'wall facing +z, t up', n: [0, 0, 1], t: [0, 1, 0] };
const mountsOf = (k: number): Mount[] => (WALL_KINDS.has(k) ? [WALL_E, WALL_N, WALL_S_UPT] : [DOWN_X, DOWN_Z]);

function fixture(kind: FixtureKindId, m: Mount, state: LightStateId = LightState.ON, extra: Partial<Fixture> = {}): Fixture {
  const d = DIMS[kind];
  return {
    id: 0x1234567, kind, state, shape: d.shape, px: 25.3, py: 2.2, pz: 7.9,
    nx: m.n[0], ny: m.n[1], nz: m.n[2], tx: m.t[0], ty: m.t[1], tz: m.t[2],
    w: d.w, h: d.h, color: [1, 0.8, 0.55], luminance: d.lum, seed: 0xabcdef57, hum: 0.5, bakeGroup: 0,
    dynamic: false, ...extra,
  };
}

function build(f: Fixture, ceilY = Number.NaN, ox = 19.2, oz = 0): MeshBuffers {
  const w = new GeometryWriter(512);
  if (Number.isNaN(ceilY)) emitFixture(w, f, ox, oz);
  else emitFixtureInto(w, f, ox, oz, ceilY, 0, 54);
  return w.finish();
}

/** Sum over emissive triangles of emit * area * max(0, n_tri . n): radiant intensity along n (cd for nits*m^2). */
function emittedIntensity(m: MeshBuffers, n: readonly number[]): number {
  const tn = [0, 0, 0];
  let sum = 0;
  for (let t = 0; t < m.indexCount / 3; t++) {
    const a = m.index[t * 3], b = m.index[t * 3 + 1], c = m.index[t * 3 + 2];
    const e = (m.emit[a] + m.emit[b] + m.emit[c]) / 3;
    if (e <= 0) continue;
    const area = triNormal(m, t, tn);
    const cos = tn[0] * n[0] + tn[1] * n[1] + tn[2] * n[2];
    if (cos > 0) sum += e * area * cos;
  }
  return sum;
}
const emissiveVerts = (m: MeshBuffers): number[] => {
  const out: number[] = [];
  for (let i = 0; i < m.vertexCount; i++) if (m.emit[i] > 0) out.push(i);
  return out;
};
const expected = (f: Fixture): number => (f.shape === 1 ? f.luminance : f.luminance * f.w * f.h);

describe('WP6 surface fixtures', () => {
  for (const kind of SURFACE_KINDS) {
    for (const m of mountsOf(kind)) {
      it(`kind ${kind}: calibration, validity, winding (${m.name})`, () => {
        const f = fixture(kind, m);
        const mesh = build(f);
        expect(mesh.indexCount).toBeGreaterThan(0);
        expect(validate(mesh)).toEqual([]);
        expect(windingMismatch(mesh)).toBe(0);
        // tile-local: chunk-local centre (25.3, 7.9) minus the tile origin (19.2, 0)
        const b = bounds(mesh);
        expect(b[0]).toBeLessThan(25.3 - 19.2 + 0.05);
        expect(b[3]).toBeGreaterThan(25.3 - 19.2 - 0.05);
        const I = emittedIntensity(mesh, m.n);
        const want = expected(f);
        expect(Math.abs(I / want - 1), `kind ${kind}: emitted ${I.toFixed(2)} vs ${want.toFixed(2)}`).toBeLessThanOrEqual(0.2);
        // every emissive vertex: nits = fixtureRadiance, tint = colour, PROP_AUX metadata
        for (const i of emissiveVerts(mesh)) {
          expect(mesh.emit[i]).toBeCloseTo(fixtureRadiance(f), 1);
          expect(mesh.tint[i * 4]).toBe(255);
          expect(mesh.tint[i * 4 + 1]).toBe(Math.round(0.8 * 255));
          expect(mesh.tint[i * 4 + 2]).toBe(Math.round(0.55 * 255));
          expect(mesh.flags[i] & (VFlag.DYN_EMIT | VFlag.SHIMMER)).toBe(0);
        }
        for (let i = 0; i < mesh.vertexCount; i++) {
          expect(mesh.flags[i] & VFlag.PROP_AUX).toBe(VFlag.PROP_AUX);
          // edge coordinates (builder.ts edgeEncode) or 0 (curved axes), never NaN
          for (const x of [mesh.lmUv[i * 2], mesh.lmUv[i * 2 + 1]]) expect(x === 0 || Math.abs(x) >= 4).toBe(true);
        }
      });
    }
  }

  it('SPHERE emitters have radius exactly w/2; the HIGHBAY disk has radius w/2', () => {
    for (const kind of [FixtureKind.CAGE_BULB, FixtureKind.RED_BULB] as FixtureKindId[]) {
      const f = fixture(kind, DOWN_X);
      const m = build(f);
      let rMax = 0, rMin = Infinity;
      for (const i of emissiveVerts(m)) {
        const r = Math.hypot(m.position[i * 3] - (f.px - 19.2), m.position[i * 3 + 1] - f.py, m.position[i * 3 + 2] - f.pz);
        rMax = Math.max(rMax, r); rMin = Math.min(rMin, r);
      }
      expect(rMax).toBeCloseTo(f.w / 2, 4);
      expect(rMin).toBeCloseTo(f.w / 2, 4); // every sphere vertex (poles included) lies on the sphere
    }
    const hb = fixture(FixtureKind.HIGHBAY, DOWN_X);
    const m = build(hb);
    let rMax = 0;
    for (const i of emissiveVerts(m)) {
      rMax = Math.max(rMax, Math.hypot(m.position[i * 3] - (hb.px - 19.2), m.position[i * 3 + 2] - hb.pz));
      expect(Math.abs(m.position[i * 3 + 1] - hb.py)).toBeLessThan(0.005); // a flat disk at the emitter plane
    }
    expect(rMax).toBeCloseTo(hb.w / 2, 4);
  });

  it('a 64 cd CAGE_BULB shows about 8,150 nits (clips into bloom)', () => {
    const m = build(fixture(FixtureKind.CAGE_BULB, DOWN_X));
    const nits = m.emit[emissiveVerts(m)[0]];
    expect(nits).toBeGreaterThan(8000);
    expect(nits).toBeLessThan(8300);
  });

  it('states: OFF emits nothing, DYING x DYING_MEAN + SHIMMER, BUZZ SHIMMER, dynamic FLICKER / ANOMALY DYN_EMIT', () => {
    for (const kind of SURFACE_KINDS) {
      const m0 = mountsOf(kind)[0];
      const on = build(fixture(kind, m0));
      const L = fixtureRadiance(fixture(kind, m0));
      // OFF: same topology, no emission, an unlit lens
      const off = build(fixture(kind, m0, LightState.OFF));
      expect(off.indexCount).toBe(on.indexCount);
      expect(emissiveVerts(off)).toEqual([]);
      const cases: [LightStateId, boolean, number, number][] = [
        [LightState.DYING, false, L * DYING_MEAN, VFlag.SHIMMER],
        [LightState.BUZZ, false, L, VFlag.SHIMMER],
        [LightState.FLICKER, true, L, VFlag.DYN_EMIT],
        [LightState.ANOMALY, true, L, VFlag.DYN_EMIT],
      ];
      for (const [state, dynamic, emit, flag] of cases) {
        const f = fixture(kind, m0, state, { dynamic });
        const m = build(f);
        const ev = emissiveVerts(m);
        expect(ev.length).toBe(emissiveVerts(on).length);
        for (const i of ev) {
          expect(m.emit[i]).toBeCloseTo(emit, 1);
          expect(m.flags[i] & (VFlag.DYN_EMIT | VFlag.SHIMMER)).toBe(flag);
          expect(m.aux[i * 4 + 3]).toBe(state); // aux.w = LightState
          expect(m.tint[i * 4 + 3]).toBe(f.seed & 255); // tint.a = seed & 255
        }
      }
    }
  });

  it('suspensions reach the ceiling; the HIGHBAY drop rod ends at the joist (ceil - 0.6)', () => {
    const ceil = 4.0;
    const cases: [FixtureKindId, number, number][] = [
      [FixtureKind.TUBE_STRIP, ceil - 0.3, ceil],
      [FixtureKind.PENDANT_LINEAR, ceil - 1.2, ceil],
      [FixtureKind.CAGE_BULB, ceil - 0.5, ceil],
      [FixtureKind.SODIUM, ceil - 0.4, ceil],
      [FixtureKind.RED_BULB, ceil - 1.0, ceil],
      [FixtureKind.HIGHBAY, ceil - 2.5, ceil - 0.6],
    ];
    for (const [kind, py, top] of cases) {
      const m = build(fixture(kind, DOWN_X, LightState.ON, { py }), ceil);
      expect(bounds(m)[4], `kind ${kind}`).toBeCloseTo(top, 2);
      expect(bounds(m)[1], `kind ${kind}`).toBeGreaterThan(py - (DIMS[kind].shape === 1 ? DIMS[kind].w : 0.05));
    }
  });

  it('EXIT_SIGN: a SIGNAGE face (the EXIT slot) reading upright from the front', () => {
    for (const m of [WALL_E, WALL_N, WALL_S_UPT]) {
      const mesh = build(fixture(FixtureKind.EXIT_SIGN, m));
      const ev = emissiveVerts(mesh);
      expect(ev.length).toBe(4);
      expect(mirroredAtlasTris(mesh)).toBe(0);
      for (const i of ev) {
        expect(mesh.layer[i]).toBe(Mat.SIGNAGE);
        expect(mesh.uv[i * 2]).toBeGreaterThanOrEqual(0); // EXIT = slot 0: u,v in [0, 0.25]
        expect(mesh.uv[i * 2]).toBeLessThanOrEqual(0.25);
        expect(mesh.uv[i * 2 + 1]).toBeLessThanOrEqual(0.25);
      }
      // +v (glyph up) must point to world +y and +u to the viewer's right (the viewer looks along -n):
      // uv gradients of the quad from the centred sums (u - mean u) * p and (v - mean v) * p
      const du = [0, 0, 0], dv = [0, 0, 0];
      let mu = 0, mv = 0;
      for (const i of ev) { mu += mesh.uv[i * 2] / 4; mv += mesh.uv[i * 2 + 1] / 4; }
      for (const i of ev) {
        for (let k = 0; k < 3; k++) {
          du[k] += (mesh.uv[i * 2] - mu) * mesh.position[i * 3 + k];
          dv[k] += (mesh.uv[i * 2 + 1] - mv) * mesh.position[i * 3 + k];
        }
      }
      expect(dv[1]).toBeGreaterThan(0);
      expect(Math.abs(dv[1])).toBeGreaterThan(Math.hypot(dv[0], dv[2])); // upright, not rotated
      const right = [m.n[2], 0, -m.n[0]]; // up x n
      expect(du[0] * right[0] + du[2] * right[2]).toBeGreaterThan(0);
    }
  });

  it('recessed kinds (TROFFER_2x4, TROFFER_2x2, SKY_PANEL) are WP5 shell geometry: emitFixture writes nothing', () => {
    for (const kind of [FixtureKind.TROFFER_2x4, FixtureKind.TROFFER_2x2, FixtureKind.SKY_PANEL] as FixtureKindId[]) {
      const f: Fixture = { ...fixture(FixtureKind.TUBE_STRIP, DOWN_X), kind, w: 1.2, h: 0.6, luminance: 3300 };
      const w = new GeometryWriter(64);
      emitFixture(w, f, 0, 0);
      expect(w.indexCount).toBe(0);
      expect(emitFixtureInto(w, f, 0, 0, 2.7, 0, 54)).toBe(0);
      expect(w.vertexCount).toBe(0);
    }
  });

  it('fixtures are deterministic and independent of the tile origin up to translation', () => {
    const f = fixture(FixtureKind.PENDANT_LINEAR, DOWN_Z);
    const a = build(f, 3.5, 19.2, 0), b = build(f, 3.5, 19.2, 0), c = build(f, 3.5, 0, 0);
    expect(Array.from(a.position)).toEqual(Array.from(b.position));
    expect(Array.from(a.index)).toEqual(Array.from(b.index));
    for (let i = 0; i < a.vertexCount; i++) expect(c.position[i * 3] - a.position[i * 3]).toBeCloseTo(19.2, 3);
  });
});

describe('C.3 emitter profiles on surface fixtures', () => {
  /** Emissive vertices grouped by profile code: ep -> vertex indices. */
  function byProfile(m: MeshBuffers): Map<number, number[]> {
    const out = new Map<number, number[]>();
    for (const i of emissiveVerts(m)) {
      const ep = unpackProfile(m.aux[i * 4 + 2])[0];
      if (!out.has(ep)) out.set(ep, []);
      out.get(ep)?.push(i);
    }
    return out;
  }
  const EXPECT: Readonly<Record<number, number[]>> = {
    [FixtureKind.TUBE_STRIP]: [EP.TUBE], [FixtureKind.CAGE_BULB]: [EP.BULB], [FixtureKind.HIGHBAY]: [EP.HIGHBAY],
    [FixtureKind.PENDANT_LINEAR]: [EP.DROP, EP.LEGACY], [FixtureKind.SODIUM]: [EP.SODIUM, EP.LEGACY],
    [FixtureKind.EXIT_SIGN]: [EP.LEGACY], [FixtureKind.UNDERWATER]: [EP.LEGACY], [FixtureKind.VENDING]: [EP.LEGACY],
    [FixtureKind.RED_BULB]: [EP.BULB],
  };

  it('emissive parts carry the expected profile codes; only the tower bit of auxBits survives on emitters', () => {
    for (const kind of SURFACE_KINDS) {
      const f = fixture(kind, mountsOf(kind)[0]);
      const w = new GeometryWriter(512);
      emitFixtureInto(w, f, 19.2, 0, Number.NaN, 0xfd, 54); // tower bit + every dust / coat bit set
      const m = w.finish();
      expect([...byProfile(m).keys()].sort(), `kind ${kind}`).toEqual([...EXPECT[kind]].sort());
      for (const i of emissiveVerts(m)) expect(m.aux[i * 4 + 2] & 1, `kind ${kind}`).toBe(1);
      for (const i of emissiveVerts(m)) if (unpackProfile(m.aux[i * 4 + 2])[0] === EP.LEGACY) expect(m.aux[i * 4 + 2]).toBe(1);
    }
  });

  it('profile uv schemes: tube v in [-0.5, 0.5] with param = length cm; highbay |uv| <= 1; drop / sodium in [0, 1]^2', () => {
    const tube = build(fixture(FixtureKind.TUBE_STRIP, DOWN_X));
    const tv = byProfile(tube).get(EP.TUBE) ?? [];
    let vMin = Infinity, vMax = -Infinity;
    const variants = new Set<number>();
    for (const i of tv) {
      vMin = Math.min(vMin, tube.uv[i * 2 + 1]); vMax = Math.max(vMax, tube.uv[i * 2 + 1]);
      expect(tube.aux[i * 4]).toBe(120);
      variants.add(unpackProfile(tube.aux[i * 4 + 2])[1]);
    }
    expect(vMin).toBeCloseTo(-0.5, 4);
    expect(vMax).toBeCloseTo(0.5, 4);
    expect([...variants].sort()).toEqual([0, 1]); // one profile variant per tube
    const hb = build(fixture(FixtureKind.HIGHBAY, DOWN_X));
    let rMax = 0;
    for (const i of byProfile(hb).get(EP.HIGHBAY) ?? []) rMax = Math.max(rMax, Math.hypot(hb.uv[i * 2], hb.uv[i * 2 + 1]));
    expect(rMax).toBeCloseTo(1, 3);
    for (const [kind, ep, len] of [[FixtureKind.PENDANT_LINEAR, EP.DROP, 120], [FixtureKind.SODIUM, EP.SODIUM, 45]]) {
      const m = build(fixture(kind as FixtureKindId, DOWN_Z));
      const vs = byProfile(m).get(ep) ?? [];
      expect(vs.length).toBe(4);
      const us = vs.map((i) => m.uv[i * 2]), ws = vs.map((i) => m.uv[i * 2 + 1]);
      expect(Math.min(...us)).toBeCloseTo(0, 4); expect(Math.max(...us)).toBeCloseTo(1, 4);
      expect(Math.min(...ws)).toBeCloseTo(0, 4); expect(Math.max(...ws)).toBeCloseTo(1, 4);
      for (const i of vs) expect(m.aux[i * 4]).toBe(len);
    }
  });

  it('the uv scale never leaks into the following parts (non-emissive uvs equal the OFF fixture\'s)', () => {
    for (const kind of [FixtureKind.TUBE_STRIP, FixtureKind.HIGHBAY, FixtureKind.PENDANT_LINEAR, FixtureKind.SODIUM] as FixtureKindId[]) {
      const on = build(fixture(kind, DOWN_X)), off = build(fixture(kind, DOWN_X, LightState.OFF));
      expect(on.vertexCount).toBe(off.vertexCount);
      for (let i = 0; i < on.vertexCount; i++) {
        if (on.emit[i] > 0) continue; // the emitter itself (OFF: the same part with metre uvs)
        expect(on.uv[i * 2], `kind ${kind} v${i}`).toBeCloseTo(off.uv[i * 2], 5);
        expect(on.uv[i * 2 + 1], `kind ${kind} v${i}`).toBeCloseTo(off.uv[i * 2 + 1], 5);
      }
    }
  });

  it('OFF fixtures keep the legacy look (no profile bits)', () => {
    for (const kind of SURFACE_KINDS) {
      const m = build(fixture(kind, mountsOf(kind)[0], LightState.OFF));
      for (let i = 0; i < m.vertexCount; i++) expect(unpackProfile(m.aux[i * 4 + 2])[0], `kind ${kind}`).toBe(EP.LEGACY);
    }
  });
});

describe('C.3 PartBuilder aux.z contract', () => {
  function one(fn: (b: PartBuilder) => void, auxBits: number): number[] {
    const w = new GeometryWriter(16);
    const b = new PartBuilder();
    b.begin(w, false, auxBits, 40, 7);
    fn(b);
    b.quad(b.v(0, 0, 0, 0, 1, 0, 0, 0), b.v(1, 0, 0, 0, 1, 0, 1, 0), b.v(1, 0, 1, 0, 1, 0, 1, 1), b.v(0, 0, 1, 0, 1, 0, 0, 1));
    const m = w.finish();
    return [m.aux[0], m.aux[1], m.aux[2], m.aux[3], m.uv[2], m.uv[5]];
  }
  it('mat(): aux.z = auxBits with bit 1 = coat; aux.x = the roughness override', () => {
    expect(one((b) => b.mat(Mat.PLASTIC), 0b10101101)[2]).toBe(0b10101101);
    expect(one((b) => b.mat(Mat.PLASTIC, -1, -1, -1, 0, 0, false), 0b10101111)[2]).toBe(0b10101101);
    expect(one((b) => b.mat(Mat.PLASTIC, -1, -1, -1, 0, 0.4, true), 0b10101101)).toEqual(expect.arrayContaining([102]));
    expect(one((b) => b.mat(Mat.PLASTIC, -1, -1, -1, 0, 0.4, true), 0b10101101)[2]).toBe(0b10101111);
  });
  it('emissive(): aux = (param, 0, tower | ep << 1 | variant << 5, ceilByte); uvScale(su, sv) until the next material', () => {
    const a = one((b) => { b.emissive(Mat.PLASTIC, 1, 1, 1, 100, 0, 0, 9, EP.TUBE, 1, 120); b.uvScale(0.5, 2); }, 0b11111101);
    expect(a.slice(0, 4)).toEqual([120, 0, 1 | (EP.TUBE << 1) | (1 << 5), 40]);
    expect(a[4]).toBeCloseTo(0.5, 6); // u of vertex (1, 0, 0) = 1 * 0.5
    expect(a[5]).toBeCloseTo(2, 6); // v of vertex (1, 0, 1)... = 1 * 2
    const c = one((b) => { b.emissive(Mat.PLASTIC, 1, 1, 1, 100, 0, 0, 9, EP.TUBE, 1, 120); b.uvScale(0.5, 2); b.mat(Mat.FABRIC_PARTITION); }, 1);
    expect(c[4]).toBeCloseTo(1 / 1.2, 5); // back to metres / the layer repeat (1.2 m; no per-part offset on this layer)
  });
});
