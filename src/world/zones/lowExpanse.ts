// src/world/zones/lowExpanse.ts — LOW_EXPANSE generator (WP2). GLOBAL seams: hashed features per 6x6 global block.
//
// A low (210-230 cm), wide open carpeted field under a perfectly regular troffer grid, broken by sparse world-space
// features: wall segments, L corners, SOLID blocks and the odd closed room with one door. Every feature is a pure
// function of its global block, so the chunk rasterizes all candidates within reach and globalSeam() rasterizes the
// same candidates onto a seam line: both sides agree.

import { CeilKind, FixtureKind, Mat, PropKind, Zone } from '../../core/ids.ts';
import { transitionStamps } from '../structures/transitions.ts';
import type { LightingProfile, PropRuleSet, SeamEdges, ZoneGenerator, ZonePalette } from '../../core/world.ts';
import {
  FEATURE_TAG, featureDoorHa, featureSeam, num, rasterizeFeaturesLocal, storeyStyle, styleLighting, stylePalette, writeFeatures,
  type FeatureParams,
} from './l0common.ts';

/** Candidate keep probability of the LOW_EXPANSE feature process (§5.WP2). */
export const LOW_EXPANSE_KEEP = 0.6;

/** Default district ceiling (cm) when the params carry none. */
const DEFAULT_CEIL = 220;
const ceilOf = (p: Readonly<Record<string, number>>): number => num(p, 'ceilCm', DEFAULT_CEIL);

export const lowExpanseFeatures = (seed: number, s: number, ceilCm: number = DEFAULT_CEIL): FeatureParams => ({
  seed, s: s as FeatureParams['s'], tag: FEATURE_TAG.LOW_EXPANSE, keepP: LOW_EXPANSE_KEEP, wallsOnly: false,
  doorHa: featureDoorHa(ceilCm),
});

export const lowExpanseGenerator: ZoneGenerator = {
  id: Zone.LOW_EXPANSE,
  seamMode: 'global',
  districtParams(rng, _s) {
    return {
      ceilCm: 210 + 10 * rng.int(0, 2),
      phaseX: rng.int(0, 3),
      phaseZ: rng.int(0, 3),
    };
  },
  globalSeam(q): SeamEdges {
    return featureSeam(lowExpanseFeatures(q.seed, q.s, ceilOf(q.district.params)), q.axis, q.line, q.g0);
  },
  generate(ctx) {
    const fp = lowExpanseFeatures(ctx.seed, ctx.key.s, ceilOf(ctx.district.params));
    writeFeatures(ctx.grid, rasterizeFeaturesLocal(fp, ctx.grid.gi0, ctx.grid.gj0), fp.doorHa);
    transitionStamps(ctx, null); // R2: soft-boundary palette dither (its 210-230 cm ceiling never hosts connectors)
  },
  palette(s, d) {
    const base: ZonePalette = {
      floorMat: Mat.CARPET_L0, wallMat: Mat.WALLPAPER_L0, ceilMat: Mat.CEILING_TILE, trimMat: Mat.TRIM_PAINT,
      ceilKind: CeilKind.TILES, ceilCm: ceilOf(d.params), baseboard: true,
    };
    return stylePalette(storeyStyle(d.zone, s), base);
  },
  lighting(s, d) {
    // perfectly regular: a square [4,4] TROFFER_2x4 lattice, no per-district lattice choice
    const base: LightingProfile = {
      kind: FixtureKind.TROFFER_2x4, placement: 'lattice', lattice: [4, 4],
      phase: [num(d.params, 'phaseX', 0) % 4, num(d.params, 'phaseZ', 0) % 4], axis: 1,
      cctRange: [3700, 4600], luminance: 3000, zoneMul: 1, mountCm: 0,
    };
    return styleLighting(storeyStyle(d.zone, s), base, d.params);
  },
  props: {
    rules: [
      { kind: PropKind.OUTLET, where: 'wallMounted', per100m2: 0.8, variants: 2, minSpacing: 3.6, yCm: 30 },
      { kind: PropKind.CHAIR_STACKING, where: 'center', per100m2: 0.08, variants: 3, minSpacing: 12, yCm: 0 },
      { kind: PropKind.CHAIR_STACKING, where: 'wall', per100m2: 0.12, variants: 3, minSpacing: 8, yCm: 0 },
      { kind: PropKind.CARDBOARD_BOX, where: 'corner', per100m2: 0.06, variants: 2, minSpacing: 12, yCm: 0 },
    ],
  } satisfies PropRuleSet,
};
