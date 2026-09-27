// tests/props/props.test.ts — WP6 prop acceptance: bounds inside PROP_DEFS.size for every kind, variant and 4
// yaws; triangle budgets; propTris() == emitted triangles (seed independent); no NaN / degenerate triangles;
// winding matches normals; outward normals (sampled ray tests); CEILING mirroring; PROP_AUX metadata.

import { describe, expect, it } from 'vitest';
import { Mat, PROP_KIND_COUNT, PropFlag, VFlag, type PropKindId } from '../../src/core/ids.ts';
import type { PropPlacement } from '../../src/core/layout.ts';
import { PROP_DEFS } from '../../src/core/props.ts';
import { GeometryWriter } from '../../src/core/writer.ts';
import { emitProp, emitPropInto, PROP_VARIANTS, propTris } from '../../src/props/index.ts';
import { backfaceVisibility, bounds, mirroredAtlasTris, validate, windingMismatch } from './meshUtil.ts';

const place = (kind: number, variant: number, yaw = 0, seed = 1234, extra: Partial<PropPlacement> = {}): PropPlacement =>
  ({ kind: kind as PropKindId, variant, x: 5, y: 0.5, z: 7, yaw, scale: 1, flags: 0, seed, ...extra });

function build(p: PropPlacement, ox = 0, oz = 0) {
  const w = new GeometryWriter(1024);
  emitProp(w, p, ox, oz);
  return w.finish();
}

const TOL = 2e-4; // float32 positions around x = 5 m

/** Rays that can never reach a placed prop: from below its base plane (floor props; from above for CEILING props,
 * which hang from the ceiling) and, for wall-mounted props, from behind the wall (prop-local +Z). Such props
 * legitimately omit their bottom / back faces. `yaw` = the prop's yaw (the writer's R_y). */
function hiddenRays(yaw: number, wallMounted: boolean, ceiling: boolean): (dx: number, dy: number, dz: number) => boolean {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return (dx, dy, dz) => {
    if (ceiling ? dy < -0.02 : dy > 0.02) return true; // travelling up from under the floor (down through the ceiling)
    const localDz = s * dx + c * dz; // inverse of the writer rotation
    // travelling toward -Z: came from behind the wall plane (a grazing ray that enters an open back face has
    // passed through the wall; skipped faces let the neighbouring faces run flush to the wall)
    return wallMounted && localDz < 0;
  };
}
const KINDS = Array.from({ length: PROP_KIND_COUNT }, (_, i) => i);

describe('WP6 props: every kind, variant and yaw', () => {
  it('has a builder and PROP_DEFS entry for all 45 kinds', () => {
    expect(PROP_DEFS.length).toBe(PROP_KIND_COUNT);
    for (const k of KINDS) expect(propTris(k as PropKindId, 0)).toBeGreaterThan(0);
  });

  for (const kind of KINDS) {
    const def = PROP_DEFS[kind];
    it(`${def.name}: fits PROP_DEFS.size, budget, valid buffers`, () => {
      const [sx, sy, sz] = def.size;
      for (let v = 0; v < PROP_VARIANTS; v++) {
        const tris = propTris(kind as PropKindId, v);
        expect(tris, `${def.name} v${v} tris ${tris} > ${def.maxTris}`).toBeLessThanOrEqual(def.maxTris);
        for (let q = 0; q < 4; q++) {
          const yaw = (q * Math.PI) / 2;
          const m = build(place(kind, v, yaw));
          expect(m.indexCount / 3).toBe(tris);
          expect(validate(m), `${def.name} v${v} yaw${q}`).toEqual([]);
          const b = bounds(m);
          // rotated footprint: quarter turns swap x / z extents
          const hx = (q & 1 ? sz : sx) / 2, hz = (q & 1 ? sx : sz) / 2;
          const msg = `${def.name} v${v} yaw${q} bounds ${b.map((x) => x.toFixed(3)).join(',')}`;
          expect(b[0], msg).toBeGreaterThanOrEqual(5 - hx - TOL);
          expect(b[3], msg).toBeLessThanOrEqual(5 + hx + TOL);
          expect(b[2], msg).toBeGreaterThanOrEqual(7 - hz - TOL);
          expect(b[5], msg).toBeLessThanOrEqual(7 + hz + TOL);
          expect(b[1], msg).toBeGreaterThanOrEqual(0.5 - TOL);
          expect(b[4], msg).toBeLessThanOrEqual(0.5 + sy + TOL);
        }
      }
    });

    it(`${def.name}: winding follows normals, normals point outward`, () => {
      for (let v = 0; v < PROP_VARIANTS; v++) {
        const m = build(place(kind, v, 0.7));
        expect(windingMismatch(m), `${def.name} v${v}`).toBe(0);
        const vis = backfaceVisibility(m, 32, 10, hiddenRays(0.7, def.wallMounted, false));
        expect(vis.hits).toBeGreaterThan(0);
        expect(vis.backFrac, `${def.name} v${v}: ${(vis.backFrac * 100).toFixed(2)}% of outside rays hit a back face first`).toBeLessThanOrEqual(0.01);
      }
    });
  }

  it('sign / label atlas faces read correctly from the front (never mirrored)', () => {
    let atlasTris = 0;
    for (const kind of KINDS) {
      for (let v = 0; v < PROP_VARIANTS; v++) {
        const m = build(place(kind, v, 0.4));
        expect(mirroredAtlasTris(m), `${PROP_DEFS[kind].name} v${v}`).toBe(0);
        for (let i = 0; i < m.vertexCount; i++) if (m.layer[i] === 23 || m.layer[i] === 24) atlasTris++;
      }
    }
    expect(atlasTris).toBeGreaterThan(0); // WET_FLOOR_SIGN, EXTINGUISHER
  });

  it('propTris is independent of seed, yaw, scale and position; variants wrap modulo 4', () => {
    for (const kind of KINDS) {
      for (let v = 0; v < 6; v++) {
        const t = propTris(kind as PropKindId, v);
        for (const seed of [0, 1, 77, 123456789, -5]) {
          const m = build(place(kind, v, 1.1, seed, { scale: 1.3, x: 11.1, z: 3.3 }));
          expect(m.indexCount / 3).toBe(t);
        }
        if (v >= 4) expect(t).toBe(propTris(kind as PropKindId, v - 4));
      }
    }
  });

  it('writes tile-local positions with the writer transform (yaw, scale, origin)', () => {
    const p = place(8, 0, Math.PI / 2, 1, { x: 25, z: 30 }); // CRATE 1.0 x 0.8 x 1.0 at chunk-local (25, 30)
    const m = build(p, 19.2, 19.2);
    const b = bounds(m);
    expect(b[0]).toBeCloseTo(25 - 19.2 - 0.5, 3);
    expect(b[3]).toBeCloseTo(25 - 19.2 + 0.5, 3);
    expect(b[5]).toBeCloseTo(30 - 19.2 + 0.5, 3);
    const s = build({ ...p, scale: 2 }, 19.2, 19.2);
    expect(bounds(s)[4]).toBeCloseTo(0.5 + 1.6, 3);
  });

  it('front faces -Z at yaw 0 (wall-mounted backs on +Z)', () => {
    // VENDING_MACHINE: the dark window glass faces -Z; FILING_CABINET handles protrude toward -Z
    const m = build(place(3, 0, 0));
    const b = bounds(m);
    expect(7 - b[2]).toBeGreaterThan(b[5] - 7 - 0.01);
  });

  it('PropFlag.CEILING mirrors the prop in y about its base, winding still follows normals', () => {
    for (const kind of [0, 1, 2, 7, 11, 17]) {
      const def = PROP_DEFS[kind];
      const up = build(place(kind, 1, 0.3));
      const dn = build(place(kind, 1, 0.3, 1234, { y: 2.7, flags: PropFlag.CEILING }));
      expect(dn.indexCount).toBe(up.indexCount);
      const b = bounds(dn);
      expect(b[4]).toBeLessThanOrEqual(2.7 + TOL);
      expect(b[1]).toBeGreaterThanOrEqual(2.7 - def.size[1] - TOL);
      expect(windingMismatch(dn)).toBe(0);
      // mirrored positions: y' = 2.7 - (y - 0.5)
      for (let i = 0; i < 30; i++) {
        expect(dn.position[i * 3 + 1]).toBeCloseTo(2.7 - (up.position[i * 3 + 1] - 0.5), 4);
        expect(dn.normal[i * 4 + 1] + up.normal[i * 4 + 1]).toBe(0);
      }
      expect(backfaceVisibility(dn, 16, 8, hiddenRays(0.3, def.wallMounted, true)).backFrac).toBeLessThanOrEqual(0.01);
    }
  });

  it('every prop vertex carries PROP_AUX with (bits, ceilByte) of its anchor cell and tint.a = seed & 255', () => {
    const bad: string[] = [];
    for (const kind of KINDS) {
      const w = new GeometryWriter(512);
      emitPropInto(w, place(kind, 2, 0, 0x1a7), 0, 0, 1, 57);
      const m = w.finish();
      for (let i = 0; i < m.vertexCount; i++) {
        const f = m.flags[i];
        const dyn = (f & (VFlag.DYN_EMIT | VFlag.SHIMMER)) !== 0;
        if ((f & VFlag.PROP_AUX) === 0 || (f & VFlag.FLOOR_AUX) !== 0) bad.push(`${kind}: flags ${f}`);
        // aux.z = the anchor's bits; bit 1 = clearcoat on coated parts (car paint)
        if (m.aux[i * 4 + 1] !== 0 || (m.aux[i * 4 + 2] & ~2) !== 1) bad.push(`${kind}: aux.yz`);
        if (!dyn && (m.aux[i * 4 + 3] !== 57 || m.tint[i * 4 + 3] !== 0xa7)) bad.push(`${kind}: aux.w / tint.a`);
        if (m.lmUv[i * 2] !== 0 || m.lmUv[i * 2 + 1] !== 0) bad.push(`${kind}: lmUv`);
        if (bad.length > 5) break;
      }
    }
    expect(bad).toEqual([]);
  });

  it('clearcoat bit (aux.z & 2): the car body and pillar paint, nothing else of the car and no other kind', () => {
    const CAR = PROP_DEFS.findIndex((d) => d.name === 'CAR_SEDAN');
    for (const kind of KINDS) {
      for (let v = 0; v < PROP_VARIANTS; v++) {
        const m = build(place(kind, v));
        let coat = 0;
        for (let i = 0; i < m.vertexCount; i++) {
          if ((m.flags[i] & (VFlag.DYN_EMIT | VFlag.SHIMMER)) !== 0 || m.emit[i] > 0) continue; // emitters: profile bits
          if ((m.aux[i * 4 + 2] & 2) === 0) continue;
          coat++;
          expect(m.layer[i], `${PROP_DEFS[kind].name} v${v}`).toBe(Mat.METAL_PAINTED);
        }
        if (kind === CAR) expect(coat, `CAR_SEDAN v${v}`).toBeGreaterThan(m.vertexCount / 6); // body + pillars (wheels are dense)
        else expect(coat, PROP_DEFS[kind].name).toBe(0);
      }
    }
  });

  it('SHELF_RACK variant 2 is the collapsed rack and CAR_SEDAN variant 3 has the driver door open', () => {
    const rack = build(place(10, 0)), collapsed = build(place(10, 2));
    const top = (m: ReturnType<typeof build>): number => {
      // highest vertex among those in the +x quarter of the rack (the buckled end leans toward -x)
      let y = -Infinity;
      for (let i = 0; i < m.vertexCount; i++) if (m.position[i * 3] > 5 + 0.9) y = Math.max(y, m.position[i * 3 + 1]);
      return y;
    };
    expect(top(rack)).toBeGreaterThan(4.5);
    expect(top(collapsed)).toBeLessThan(3);
    const car = bounds(build(place(15, 0))), open = bounds(build(place(15, 3)));
    // the open door is the widest point of the (narrower) variant-3 body
    expect(open[0]).toBeLessThan(5 - 0.85);
    expect(car[3] - car[0]).toBeGreaterThan(1.7);
  });

  it('reports the triangle table', () => {
    const rows: string[] = [];
    for (const kind of KINDS) {
      const d = PROP_DEFS[kind];
      rows.push(`${d.name.padEnd(17)} ${[0, 1, 2, 3].map((v) => String(propTris(kind as PropKindId, v)).padStart(5)).join('')}  / ${d.maxTris}`);
    }
    console.log('[WP6] prop triangles per variant (v0..v3) / budget\n' + rows.join('\n'));
  });
});
