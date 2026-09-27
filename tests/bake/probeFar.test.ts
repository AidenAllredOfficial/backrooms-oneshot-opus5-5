// tests/bake/probeFar.test.ts — the probes' far field (bake/probes.ts `farR`, dda.ts traceHit2): the probes' own
// field is unchanged by it, a low probe under a desk top sees past the desk in its far field, probes away from props
// have far = full, and traceHit2 walks exactly like traceHit (plus the far hit).

import { describe, expect, it } from 'vitest';
import type { TileKey } from '../../src/core/grid.ts';
import { PropKind } from '../../src/core/ids.ts';
import { HIT_NONE, hit, hitFar, traceHit, traceHit2 } from '../../src/bake/dda.ts';
import { createJob } from '../../src/bake/job.ts';
import { NEAR } from '../../src/bake/nearfield.ts';
import { computeProbes } from '../../src/bake/probes.ts';
import { HALO_OFF, PROBE_OFF, PROBE_N } from '../../src/bake/util.ts';
import { MAT_PROP } from '../../src/bake/visgrid.ts';
import { Q_HIGH, addLight, carveRoom, handNeighborhood, solidLayout } from './helpers.ts';

const TILE: TileKey = { s: 0, cx: 0, cz: 0, q: 0 };

function deskRoom(): ReturnType<typeof handNeighborhood> {
  const l = solidLayout({ s: 0, cx: 0, cz: 0 });
  carveRoom(l, 1, 1, 15, 15);
  for (const [x, z] of [[4.2, 4.2], [9.0, 4.2], [4.2, 9.0], [9.0, 9.0], [13.8, 13.8]]) addLight(l, { px: x, pz: z, py: 2.7 });
  // desk centred on the cell centre (9.0, 9.0): the cell's low probe (0.4 m) sits under its top
  l.props.push({ kind: PropKind.DESK, variant: 0, x: 9.0, y: 0, z: 9.0, yaw: 0, scale: 1, flags: 0, seed: 1 });
  return handNeighborhood(l);
}

/** Probe index of halo cell (hi, hj) (tile-local cell + HALO_OFF), layer. */
const probeIdx = (i: number, j: number, layer: number): number => ((j + HALO_OFF - PROBE_OFF) * PROBE_N + (i + HALO_OFF - PROBE_OFF)) * 3 + layer;

describe('probe far field', () => {
  const nb = deskRoom();
  const job = createJob(nb, TILE, Q_HIGH, null);
  const full = computeProbes(job, false);
  const both = computeProbes(job, false, NEAR.PROBE_FAR);

  it("the probes' own field is bit-identical with and without the far field", () => {
    expect(full.farSh).toBeNull();
    expect(both.sh.every((v, i) => v === full.sh[i])).toBe(true);
    expect(both.cube.every((v, i) => v === full.cube[i])).toBe(true);
    expect(both.rho.every((v, i) => v === full.rho[i])).toBe(true);
  });

  it('the low probe under the desk top sees past it (its +y lobe changes by > 30%); a probe 3.6 m away: far = full', () => {
    const under = probeIdx(7, 7, 0); // cell (7, 7) = 8.4..9.6 m: the desk's cell
    const up = (cube: Float32Array, p: number): number => 0.2126 * cube[p * 18 + 6] + 0.7152 * cube[p * 18 + 7] + 0.0722 * cube[p * 18 + 8];
    // (the one-bounce patch radiance of this room's ceiling is below the desk underside's: the far field's +y is
    // darker here; what matters is that the desk top no longer stands in for the room above it)
    expect(Math.abs(up(both.farCube!, under) - up(both.cube, under))).toBeGreaterThan(0.3 * up(both.cube, under));
    const away = probeIdx(4, 7, 0);
    for (let k = 0; k < 18; k++) expect(both.farCube![away * 18 + k]).toBe(both.cube[away * 18 + k]);
  });

  const sameHit = (a: typeof hit, b: typeof hit): boolean => a.kind === b.kind && (a.kind === HIT_NONE ||
    (a.t === b.t && a.x === b.x && a.y === b.y && a.z === b.z && a.mat === b.mat && a.dir === b.dir && a.cell === b.cell && a.box === b.box && a.wet === b.wet));
  it('traceHit2: `hit` equals traceHit; hitFar passes prop boxes entered before skipT only', () => {
    const g = job.g;
    const x = HALO_OFF + 9.0 / 1.2, z = HALO_OFF + 9.0 / 1.2; // under the desk top (0.72 m) at 0.4 m
    let props = 0, same = 0;
    for (let k = 0; k < 200; k++) {
      const a = (k * 2.399963) % (2 * Math.PI), cy = 1 - (k + 0.5) / 200;
      const sy = Math.sqrt(1 - cy * cy), dx = Math.cos(a) * sy, dz = Math.sin(a) * sy;
      traceHit(g, x, 0.4, z, dx * 8 / 1.2, cy * 8, dz * 8 / 1.2, 0);
      const ref = { ...hit };
      traceHit2(g, x, 0.4, z, dx * 8 / 1.2, cy * 8, dz * 8 / 1.2, 0, NEAR.PROBE_FAR / 8);
      expect(sameHit(hit, ref)).toBe(true);
      if (ref.kind !== HIT_NONE && ref.mat === MAT_PROP && ref.t < NEAR.PROBE_FAR / 8) {
        props++;
        expect(hitFar.t).toBeGreaterThan(ref.t);
        expect(hitFar.kind === HIT_NONE || hitFar.mat !== MAT_PROP || hitFar.t >= NEAR.PROBE_FAR / 8).toBe(true);
      } else { same++; expect(sameHit(hitFar, ref)).toBe(true); }
    }
    expect(props).toBeGreaterThan(20);
    expect(same).toBeGreaterThan(20);
  });
});
