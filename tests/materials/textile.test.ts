// tests/materials/textile.test.ts (texture realism v2, lane A) — the textile family: the pile visibility and nap TS
// twins (chunks/family/textile.ts) must stay linear in the filtered texture values (mip-unbiased: no brightening or
// darkening with distance), the GLSL must use the same constants, and the textile recipe rows and detail lattices
// keep their conventions. The look itself is checked with captures (harness extra=detail, view=textile).

import { describe, expect, it } from 'vitest';
import { NOISE_WRAP } from '../../src/core/constants.ts';
import { Mat } from '../../src/core/ids.ts';
import { LAYER_DEFS } from '../../src/core/materials.ts';
import { napDiffuse, pileVisibility, TEXTILE, TEXTILE_HOOKS } from '../../src/materials/chunks/family/textile.ts';
import { f, TUNE } from '../../src/materials/chunks/params.ts';
import { Det, DETAIL_RECIPES, DETAIL_SIZE } from '../../src/textures/detail.ts';
import { LAYER_RECIPES_FULL } from '../../src/textures/registry.ts';

const TEXTILES = [Mat.CARPET_L0, Mat.CARPET_OFFICE, Mat.FABRIC_PARTITION] as const;

/** Deterministic samples in [0, 1). */
function samples(n: number, seed: number): number[] {
  const out: number[] = [];
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    out.push(s / 2 ** 32);
  }
  return out;
}

describe('pile visibility Dv = 1 - kp (1 - V) mu_v^kv', () => {
  it('is linear in V: the Dv of a mip-filtered V is the filtered Dv (no distance bias)', () => {
    const r = samples(4000, 7);
    for (const layer of TEXTILES) {
      const [kp, kv] = LAYER_RECIPES_FULL[layer].phys.pile;
      for (const mu of [0.05, 0.35, 0.7, 1]) {
        // a mip texel averages texels of V: the mean of Dv equals Dv of the mean
        const V = r.map((x) => 0.15 + 0.85 * x);
        const meanV = V.reduce((a, b) => a + b, 0) / V.length;
        const meanDv = V.reduce((a, v) => a + pileVisibility(v, mu, kp, kv), 0) / V.length;
        expect(Math.abs(meanDv - pileVisibility(meanV, mu, kp, kv)), `layer ${layer} mu ${mu}`).toBeLessThan(1e-9);
      }
    }
  });

  it('shows the gaps looking down and hides them at grazing', () => {
    const [kp, kv] = LAYER_RECIPES_FULL[Mat.CARPET_L0].phys.pile;
    expect(pileVisibility(0.62, 1, kp, kv)).toBeCloseTo(1 - kp * 0.38, 9);
    expect(pileVisibility(0.62, 0, kp, kv)).toBe(1);
    // monotone in mu_v: the carpet looks darker and richer straight down
    let prev = 2;
    for (let mu = 0; mu <= 1.0001; mu += 0.05) {
      const d = pileVisibility(0.62, mu, kp, kv);
      expect(d).toBeLessThanOrEqual(prev + 1e-12);
      prev = d;
    }
  });

  it('keeps the Level 0 calibration: T x Dv at a typical 3-4 m view (mu_v 0.35, V 0.62) is the old 0.55 trap', () => {
    const [kp, kv] = LAYER_RECIPES_FULL[Mat.CARPET_L0].phys.pile;
    const k = TEXTILE.TRAP * pileVisibility(0.62, 0.35, kp, kv);
    expect(k).toBeGreaterThan(0.5);
    expect(k).toBeLessThan(0.6);
  });

  it('is enabled on the three textile layers only', () => {
    for (const r of LAYER_RECIPES_FULL) {
      const on = r.phys.pile[0] > 0;
      expect(on, LAYER_DEFS[r.layer].name).toBe((TEXTILES as readonly number[]).includes(r.layer));
    }
  });
});

describe('nap shading', () => {
  it('is linear in the lean and symmetric, so a mip-averaged lean gives the averaged shading', () => {
    for (const mu of [0.1, 0.5, 0.9]) {
      for (const s of [0.1, 0.4, 0.8]) {
        expect(napDiffuse(s, mu) + napDiffuse(-s, mu)).toBeCloseTo(2, 12);
        expect(napDiffuse(s / 2, mu) - 1).toBeCloseTo((napDiffuse(s, mu) - 1) / 2, 12);
      }
    }
  });

  it('vanishes looking straight down, darkens pile leaning toward the camera at grazing', () => {
    expect(napDiffuse(0.8, 1)).toBe(1);
    expect(napDiffuse(0.8, 0.2)).toBeLessThan(0.9);
    expect(napDiffuse(-0.8, 0.2)).toBeGreaterThan(1.1);
  });
});

describe('textile GLSL', () => {
  const pars = TEXTILE_HOOKS.pars;
  it('uses the TS twins\' constants', () => {
    for (const [name, v] of [['TRAP', TEXTILE.TRAP], ['NAP_DIFF', TEXTILE.NAP_DIFF], ['NAP_SHEEN', TEXTILE.NAP_SHEEN],
      ['HIDE', TEXTILE.HIDE], ['WET_V', TEXTILE.WET_V]] as const) {
      expect(pars, name).toContain(`#define BR_TX_${name} ${f(v)}\n`);
    }
    expect(TEXTILE_HOOKS.matPost).toContain('1.0 - brTxKp.x * ( 1.0 - brTxVv ) * pow( brTxMu, brTxKp.y )');
    expect(TEXTILE_HOOKS.matPost).toContain('clamp( 1.0 - BR_TX_NAP_DIFF * brTxS * brTxVl, 0.6, 1.4 )');
  });

  it('the Level 0 pile trap lives on the diffuse albedo the lights see, not on the whole radiance (preFog)', () => {
    expect(TEXTILE_HOOKS.preFog).toBe('');
    expect(TEXTILE_HOOKS.matPost).toContain('BR_TX_TRAP');
    expect(TEXTILE_HOOKS.matPost).toContain('material.diffuseContribution *= brTxK');
    // the generic cavity multiply on the ambient is undone, nothing else happens after the lighting
    expect(TEXTILE_HOOKS.postLight).toContain('reflectedLight.indirectDiffuse /= max( brCav, 1e-3 )');
  });

  it('standing water and a film over the pile are not occluded by its gaps; Dv keeps the pile visibility', () => {
    // the generic specular occlusion and the SSR weight read the texture cavity ormh.r (= V on pile layers, mean 0.61):
    // a puddle over the carpet would reflect ~half and speckled with the tufts
    expect(TEXTILE_HOOKS.postWet).toContain('float brTxVis = brOrmh.r;');
    expect(TEXTILE_HOOKS.postWet).toContain('brOrmh.r = mix( brOrmh.r, 1.0, max( brPuddle, brFilm ) )');
    expect(TEXTILE_HOOKS.matPost).toContain('pow( clamp( brTxVis, 0.0, 1.0 ), 1.0 + BR_TX_WET_V * brAbs )');
    expect(TEXTILE_HOOKS.matPost).not.toMatch(/pow\( clamp\( brOrmh\.r/);
  });

  it('thin world features widen to the pixel footprint (no crawl far away)', () => {
    // spill edges and rims, the reversal-patch edge and the wicking front's 2.5 cm raggedness
    expect(TEXTILE_HOOKS.pars).toContain('float rw = max( rimW, fp );');
    expect(TEXTILE_HOOKS.grime).toContain('BR_TX_BLOT_RIM, brTxWob, brTxFp, brTxRim )');
    expect(TEXTILE_HOOKS.grime).toContain('max( BR_TX_REV_W, fwidth( brTxRn ) )');
    expect(TEXTILE_HOOKS.grime).toContain('1.0 - smoothstep( 0.25, 0.75, brTxFp / BR_TX_FRONT_CELL )');
  });

  it('a spill stays inside its 2.4 m feature cell, so the lookup reads one cell', () => {
    // brTxDiscs: the centre lies 0.25-0.75 across the cell; the outline reaches r (0.7 + 0.6 wob) along x and that over
    // the 0.75 minimum axis scale along z; the edge and rim lie inside the outline
    expect(TEXTILE_HOOKS.pars).toContain('( vec2( c ) + 0.25 + 0.5 * vec2(');
    expect(TEXTILE_HOOKS.pars).toContain('mix( 0.75, 1.25, brU01( brPcg( h + 4u ) ) )');
    expect(TEXTILE_HOOKS.pars).toContain('r * ( 0.7 + 0.6 * wob )');
    expect(TEXTILE_HOOKS.pars).not.toMatch(/for \( int/);
    expect((TEXTILE.BLOT_R[1] * 1.3) / 0.75).toBeLessThan(0.25 * TUNE.FEATURE_CELL);
  });

  it('every world lattice period is a whole number of cells per NOISE_WRAP', () => {
    for (const name of ['NAP_P', 'OUTLINE_P', 'OUTLINE_P2', 'FRONT_P', 'OFFICE_P']) {
      const m = new RegExp(`#define BR_TX_${name} (\\S+)\\n`).exec(pars);
      expect(m, name).not.toBeNull();
      expect(Number.isInteger(Number(m![1])), name).toBe(true);
    }
    for (const [cell, per] of [[TEXTILE.NAP_CELL, 'NAP_P'], [TEXTILE.FRONT_CELL, 'FRONT_P']] as const) {
      const n = Number(new RegExp(`#define BR_TX_${per} (\\S+)\\n`).exec(pars)![1]);
      expect(Math.abs(n * cell - NOISE_WRAP), per).toBeLessThan(1e-6);
    }
  });
});

describe('textile recipe rows', () => {
  it('carpets store the pile lean (no metalness on lean layers), the partition fabric does not', () => {
    expect(LAYER_RECIPES_FULL[Mat.CARPET_L0].aux).toBe('lean');
    expect(LAYER_RECIPES_FULL[Mat.CARPET_OFFICE].aux).toBe('lean');
    expect(LAYER_RECIPES_FULL[Mat.FABRIC_PARTITION].aux).toBe('none');
    for (const m of [Mat.CARPET_L0, Mat.CARPET_OFFICE]) expect(LAYER_DEFS[m].metal).toBe(0);
  });

  it('carpet repeats: 1.2 m frames, hex tiles dividing the Level 0 repeat, 0.6 m office tiles', () => {
    const l0 = LAYER_DEFS[Mat.CARPET_L0];
    expect(l0.repeat).toBe(1.2);
    expect(l0.repeat / (l0.hexTile ?? 1)).toBe(2);
    const off = LAYER_DEFS[Mat.CARPET_OFFICE];
    expect(off.repeat).toBe(1.2);
    expect(off.tileSize).toBe(0.6);
  });

  it('the trims are small: the palettes hit the table albedo themselves', () => {
    for (const m of TEXTILES) for (const t of LAYER_RECIPES_FULL[m].trim) expect(Math.abs(t - 1), LAYER_DEFS[m].name).toBeLessThan(0.1);
  });
});

describe('textile detail lattices', () => {
  // a regular lattice whose period is not a power-of-two number of texels beats in the box-filtered mips (streaks)
  const pow2 = (x: number): boolean => Number.isInteger(x) && (x & (x - 1)) === 0;
  it('the regular periods of D0, D1 and D7 are 2, 4 or 8 texels (D0 stitches are shifted per row: not regular)', () => {
    const lattice = (id: number): [number, number] => {
      const m = /const vec2 G = vec2\(([\d.]+), ([\d.]+)\)/.exec(DETAIL_RECIPES[id].glsl);
      expect(m, DETAIL_RECIPES[id].name).not.toBeNull();
      return [Number(m![1]), Number(m![2])];
    };
    expect(pow2(DETAIL_SIZE / lattice(Det.CUT_PILE)[1])).toBe(true); // tufting rows
    for (const g of lattice(Det.LOOP_PILE)) expect(pow2(DETAIL_SIZE / g), `LOOP_PILE ${g}`).toBe(true);
    const n = /const float N = ([\d.]+);/.exec(DETAIL_RECIPES[Det.WEAVE].glsl);
    expect(n).not.toBeNull();
    expect(pow2(DETAIL_SIZE / Number(n![1]))).toBe(true); // one thread
    expect(pow2((DETAIL_SIZE / Number(n![1])) * 4)).toBe(true); // the 2 x 2 basket repeat
  });
});
