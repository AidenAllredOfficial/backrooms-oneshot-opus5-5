import { describe, expect, it } from 'vitest';
import { CHUNK_SIZE } from '../../src/core/constants.ts';
import { portalDistance, worldPortalFrame } from '../../src/core/portalMath.ts';
import { CellFlag } from '../../src/core/ids.ts';
import { createDistricts } from '../../src/world/districts.ts';
import { createSites } from '../../src/world/sites.ts';
import { doorwaySites } from '../../src/world/structures/doorways.ts';
import { validateLayout } from '../../src/world/validate.ts';
import { createWorldGen } from '../../src/world/worldgen.ts';
import { opts } from './wp4-helpers.ts';

describe('rare doorway generation', () => {
  it('generates valid, reversible pairs in either load order, with sealed larger interiors', () => {
    let levels = 0, interiors = 0;
    for (let seed = 1; seed <= 8; seed++) {
      const options = opts(seed), sites = createSites(seed, null, createDistricts(options)), gen = createWorldGen(options);
      for (let rz = -1; rz <= 1; rz++) for (let rx = -1; rx <= 1; rx++) {
        let source;
        for (let z = 0; z < 4 && !source; z++) for (let x = 0; x < 4 && !source; x++) {
          source = doorwaySites(seed, rx * 4 + x, rz * 4 + z, sites).find((s) => s.source);
        }
        if (!source) continue;
        const target = source.target;
        // The distant room can arrive before the entrance: neither layout depends on its partner being loaded.
        const b = gen.generateChunk({ s: target.s, cx: Math.floor(target.x / CHUNK_SIZE), cz: Math.floor(target.z / CHUNK_SIZE) });
        const a = gen.generateChunk({ s: source.s, cx: source.cx, cz: source.cz });
        expect(validateLayout(a, gen)).toEqual([]);
        expect(validateLayout(b, gen)).toEqual([]);
        const pa = a.structures.find((s) => s.portal?.doorway?.id === source.id)!, pb = b.structures.find((s) => s.portal?.doorway?.id === source.id)!;
        const fa = worldPortalFrame({ spec: pa.portal!, ox: a.key.cx * CHUNK_SIZE, oz: a.key.cz * CHUNK_SIZE });
        const fb = worldPortalFrame({ spec: pb.portal!, ox: b.key.cx * CHUNK_SIZE, oz: b.key.cz * CHUNK_SIZE });
        expect(fb).toEqual({ x: target.x, y: target.y, z: target.z, nx: target.nx, nz: target.nz });
        expect(pb.portal!.doorway!.target).toEqual({ ...fa, s: a.key.s });
        expect(gen.generateChunk(a.key).hash).toBe(a.hash);
        expect(gen.generateChunk(b.key).hash).toBe(b.hash);
        expect(a.props.some((p) => p.seed === source.id && p.door)).toBe(true);
        expect(portalDistance(fb, fb.x + fb.nx, fb.z + fb.nz)).toBe(1);
        if (source.effect === 'level') { levels++; expect(a.key.s).not.toBe(b.key.s); }
        else {
          interiors++;
          expect((pb.i1 - pb.i0) * (pb.j1 - pb.j0)).toBeGreaterThan(10 * (pa.i1 - pa.i0) * (pa.j1 - pa.j0));
          for (let j = pb.j0; j < pb.j1; j++) for (let i = pb.i0; i < pb.i1; i++) expect(b.flags[j * 32 + i] & CellFlag.SEALED).toBeTruthy();
        }
      }
    }
    expect(levels).toBeGreaterThan(10); expect(interiors).toBeGreaterThan(10);
  });
});
