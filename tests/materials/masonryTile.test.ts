// tests/materials/masonryTile.test.ts (texture realism v2, lane C) — the world lattices of the masonry and tile hooks
// (periodic over NOISE_WRAP along the surface and STOREY_PITCH in y), the CMU world block key against the recipe's
// bond (JS twins of brMsKey's block index and of the recipe's cmuId), and painted CMU's roughness cap against SSR's
// G-buffer eligibility cut.

import { describe, expect, it } from 'vitest';
import { NOISE_WRAP, STOREY_PITCH, TILE_SIZE } from '../../src/core/constants.ts';
import { Mat } from '../../src/core/ids.ts';
import { LAYER_DEFS, layerRepeatY } from '../../src/core/materials.ts';
import { BLISTER_CELL, CMU_PAINTED_MAX_ROUGH, MASONRY_HOOKS } from '../../src/materials/chunks/family/masonry.ts';
import { GROUT_VARIATION, VCT_WEAR } from '../../src/materials/chunks/family/tile.ts';
import { SSR } from '../../src/post/ssr/ssrGlsl.ts';
import { CMU_BLOCK, CMU_BOND, cmuBondLit, MASONRY_RECIPES } from '../../src/textures/layers/masonry.ts';

const divides = (a: number, b: number): boolean => Math.abs(b / a - Math.round(b / a)) < 1e-9;
const mod = (a: number, n: number): number => a - n * Math.floor(a / n);
const off = (course: number): number => Number(cmuBondLit(CMU_BOND[mod(course, CMU_BOND.length)]));

/** brMsKey's block (chunks/family/masonry.ts): world 'along' (tile-local along + the noise origin's) and storey y */
function keyBlock(al: number, y: number): [number, number] {
  const crs = Math.floor(y / CMU_BLOCK[1]);
  return [Math.floor(al / CMU_BLOCK[0] + off(crs)), crs];
}
/** the recipe's cmuId (layers/masonry.ts) at the mesher's wall uv (u = tile-local along / repeat, v = y / repeatY) */
function recipeBlock(u: number, v: number): [number, number] {
  const d = LAYER_DEFS[Mat.CMU_PAINTED];
  const mx = mod(u, 1) * d.repeat, my = mod(v, 1) * layerRepeatY(d);
  const c = Math.floor(my / CMU_BLOCK[1]);
  const bx = mx + off(c) * CMU_BLOCK[0];
  return [mod(Math.floor(bx / CMU_BLOCK[0]), Math.round(d.repeat / CMU_BLOCK[0])), mod(c, CMU_BOND.length)];
}

describe('lane C masonry and tile', () => {
  it('world lattices are periodic over NOISE_WRAP and STOREY_PITCH', () => {
    for (const c of [CMU_BLOCK[0], BLISTER_CELL, ...GROUT_VARIATION.cells, VCT_WEAR.HEEL_CELL]) {
      expect(divides(c, NOISE_WRAP), `${c} | NOISE_WRAP`).toBe(true);
    }
    for (const c of [CMU_BLOCK[1], BLISTER_CELL, ...GROUT_VARIATION.cells]) {
      expect(divides(c, STOREY_PITCH), `${c} | STOREY_PITCH`).toBe(true);
    }
    // the key wraps its course index per storey: whole bond cycles, so the block pattern repeats with the storey
    expect(divides(CMU_BLOCK[1] * CMU_BOND.length, STOREY_PITCH)).toBe(true);
  });

  it('the bond overlaps every head joint by at least a third of a block and fits the texture frame', () => {
    for (let c = 0; c < CMU_BOND.length; c++) {
      const d = Math.abs(off(c + 1) - off(c));
      expect(Math.min(d, 1 - d), `courses ${c} / ${c + 1}`).toBeGreaterThanOrEqual(1 / 3 - 1e-6);
    }
    for (const m of [Mat.CMU_PAINTED, Mat.CMU_RAW]) {
      const d = LAYER_DEFS[m];
      expect(divides(CMU_BLOCK[0], d.repeat) && divides(CMU_BLOCK[0], TILE_SIZE)).toBe(true);
      expect(layerRepeatY(d)).toBeCloseTo(CMU_BLOCK[1] * CMU_BOND.length, 9); // one bond cycle per frame
    }
  });

  it('the recipe and the shader key emit the same course offsets', () => {
    const lits = CMU_BOND.map(cmuBondLit);
    for (const g of [MASONRY_RECIPES[Mat.CMU_PAINTED]?.glsl, MASONRY_RECIPES[Mat.CMU_RAW]?.glsl, MASONRY_HOOKS.pars]) {
      const chain = lits.map((o, i) => (i < lits.length - 1 ? `cw < ${i}.5 ? ${o} : ` : o)).join('');
      expect(g).toContain(chain);
    }
  });

  it('brMsKey twin: the world block key changes exactly where the texture block does', () => {
    const d = LAYER_DEFS[Mat.CMU_PAINTED];
    let s = 12345;
    const rnd = (): number => ((s = (s * 1103515245 + 12345) >>> 0) / 2 ** 32);
    let changes = 0;
    for (let i = 0; i < 20000; i++) {
      // a tile origin (a TILE_SIZE multiple) as the noise origin carries it, wrapped at NOISE_WRAP; a tile-local
      // point on the wall (y below the floor too: the service corridors are sunk) and a neighbour up to 3 cm away
      const origin = mod(Math.floor(rnd() * 4096 - 2048) * TILE_SIZE, NOISE_WRAP);
      const a = rnd() * TILE_SIZE, y = rnd() * 3.4 - 0.4;
      const b = a + (rnd() - 0.5) * 0.06, y2 = y + (rnd() - 0.5) * 0.06;
      const k0 = keyBlock(origin + a, y), k1 = keyBlock(origin + b, y2);
      const r0 = recipeBlock(a / d.repeat, y / layerRepeatY(d)), r1 = recipeBlock(b / d.repeat, y2 / layerRepeatY(d));
      const keySame = k0[0] === k1[0] && k0[1] === k1[1], texSame = r0[0] === r1[0] && r0[1] === r1[1];
      expect(keySame, `origin ${origin} along ${a} -> ${b}, y ${y} -> ${y2}`).toBe(texSame);
      if (!texSame) changes++;
    }
    expect(changes).toBeGreaterThan(1000); // the sample does cross joints
  });

  it('painted CMU stays on one side of SSR\'s G-buffer eligibility cut', () => {
    expect(CMU_PAINTED_MAX_ROUGH).toBeLessThan(SSR.ELIG_ROUGH);
    expect(CMU_PAINTED_MAX_ROUGH).toBeGreaterThan(0.6); // the unresolved aggregate's matte sheen stays
  });
});
