// R2 (B6) — content coverage: every vignette kind shows up on the storeys where its zones live, every anomaly kind
// somewhere in the world. Guards against compositions that silently never fit (WP4 shipped MATTRESS_CLOSET,
// BACKPACK_CAMP and REPEATED_ROOM at zero instances over 4,608 chunks).
import { describe, expect, it } from 'vitest';
import { AnomalyKind, type StoreyId, VIGNETTE_NAMES } from '../../src/core/ids.ts';
import { STRATA_WEIGHTS } from '../../src/core/zones.ts';
import { createWorldGen } from '../../src/world/worldgen.ts';
import { VIGNETTE_WEIGHTS, zoneColumn } from '../../src/world/content/vignettes.ts';
import { opts } from './wp4-helpers.ts';

/** Expected share of each vignette kind on a storey (STRATA_WEIGHTS mixture of the zone columns). */
function storeyShares(s: StoreyId): number[] {
  const out = new Array<number>(VIGNETTE_WEIGHTS.length).fill(0);
  const sw = STRATA_WEIGHTS[s];
  let total = 0;
  for (let z = 0; z < sw.length; z++) {
    if (sw[z] === 0) continue;
    let rowSum = 0;
    for (let k = 0; k < out.length; k++) rowSum += VIGNETTE_WEIGHTS[k][zoneColumn(z as never)];
    for (let k = 0; k < out.length; k++) out[k] += (sw[z] * VIGNETTE_WEIGHTS[k][zoneColumn(z as never)]) / rowSum;
    total += sw[z];
  }
  return out.map((v) => v / total);
}

/** A kind "has weight" on a storey when at least this share of its candidates would pick it. */
const MIN_SHARE = 0.03;

describe('content coverage', { tags: ['sweep'] }, () => {
  it('every vignette kind appears >= 1 per 256 chunks on each storey where it has weight', () => {
    for (const s of [0, 1, 2] as StoreyId[]) {
      const gen = createWorldGen(opts(11 + s));
      const counts = new Array<number>(VIGNETTE_WEIGHTS.length).fill(0);
      for (let cz = -8; cz < 8; cz++) for (let cx = -8; cx < 8; cx++) {
        for (const v of gen.generateChunk({ s, cx, cz }).vignettes) counts[v.kind]++;
      }
      const share = storeyShares(s);
      for (let k = 0; k < counts.length; k++) {
        if (share[k] < MIN_SHARE) continue;
        expect(counts[k], `${VIGNETTE_NAMES[k]} on storey ${s} (share ${share[k].toFixed(3)})`).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it('every anomaly kind appears >= 1 per 1024 chunks (storeys 0-2)', () => {
    const counts = new Array<number>(Object.keys(AnomalyKind).length).fill(0);
    const gen = createWorldGen(opts(5));
    for (const s of [0, 1, 2] as StoreyId[]) {
      // 3 x 342 = 1026 chunks
      for (let n = 0; n < 342; n++) {
        const cx = (n % 19) - 9, cz = Math.floor(n / 19) - 9;
        for (const a of gen.generateChunk({ s, cx, cz }).anomalies) counts[a.kind]++;
      }
    }
    for (const [name, k] of Object.entries(AnomalyKind)) expect(counts[k], name).toBeGreaterThanOrEqual(1);
  });
});
