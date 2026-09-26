// src/world/worldgen.ts — createWorldGen: the pure, deterministic WorldGen facade (+ caches) (WP1).
//
// Composes districts (districts.ts), fields (fields.ts), sites (sites.ts), seams (seams.ts), the chunk pipeline
// (chunkgen.ts), spawn search (spawn.ts) and ASCII maps (ascii.ts). generateChunk always returns a FRESH layout
// (callers may mutate or transfer it); spawn / find / asciiMap use a private LRU of layouts.

import { CHUNK_CELLS } from '../core/constants.ts';
import { chunkKeyStr, exIdx, ezIdx, type ChunkKey } from '../core/grid.ts';
import { Mood, SeamMode, type StoreyId, Zone } from '../core/ids.ts';
import type { ChunkLayout } from '../core/layout.ts';
import { rngFor, SALT } from '../core/rng.ts';
import type {
  DistrictInfo, FieldSampler, LightingProfile, SeamSpec, WorldGen, WorldGenOptions, ZonePalette,
} from '../core/world.ts';
import { asciiMapFromLayouts } from './ascii.ts';
import { ARTERY_STYLE } from './arteries.ts';
import { generateChunk, type GenWorld } from './chunkgen.ts';
import { createDistricts } from './districts.ts';
import { createFieldSampler } from './fields.ts';
import { createSeams } from './seams.ts';
import { createSites, SITES_NEAR_RADIUS } from './sites.ts';
import { findNearest as findNearestImpl, findSpawn as findSpawnImpl, type SpawnWorld } from './spawn.ts';
import { testSceneSpawn, testTowerSite } from './testScenes.ts';
import { generatorFor } from './zones/registry.ts';

const N = CHUNK_CELLS;
const LAYOUT_LRU = 128;
const NONE: readonly never[] = [];
const MAX_ASCII_CHUNKS = 64;

export function createWorldGen(opts: WorldGenOptions): WorldGen {
  const seed = opts.seed >>> 0;
  const districts = createDistricts({ ...opts, seed });
  const sites = createSites(seed, opts.forceLandmark, districts);
  const fieldCache = new Map<StoreyId, FieldSampler>();
  const paletteCache = new Map<string, ZonePalette>();
  const lightingCache = new Map<string, LightingProfile>();
  const arteryPalettes = new Map<StoreyId, ZonePalette>();
  const layouts = new Map<string, ChunkLayout>();

  const fields = (s: StoreyId): FieldSampler => {
    let f = fieldCache.get(s);
    if (!f) fieldCache.set(s, (f = createFieldSampler(seed, s)));
    return f;
  };
  const paletteOf = (s: StoreyId, d: DistrictInfo): ZonePalette => {
    const k = `${s},${d.id},${d.zone}`;
    let p = paletteCache.get(k);
    if (!p) {
      if (paletteCache.size > 4096) paletteCache.clear();
      paletteCache.set(k, (p = generatorFor(d.zone).palette(s, d)));
    }
    return p;
  };
  const lightingOf = (s: StoreyId, d: DistrictInfo): LightingProfile => {
    const k = `${s},${d.id},${d.zone}`;
    let p = lightingCache.get(k);
    if (!p) {
      if (lightingCache.size > 4096) lightingCache.clear();
      lightingCache.set(k, (p = generatorFor(d.zone).lighting(s, d)));
    }
    return p;
  };
  const arteryPalette = (s: StoreyId): ZonePalette => {
    let p = arteryPalettes.get(s);
    if (!p) {
      const zone = ARTERY_STYLE[s].zone;
      const gen = generatorFor(zone);
      const d: DistrictInfo = {
        id: 0, s, zone, mood: Mood.NORMAL, siteX: 0, siteZ: 0, seed: 0,
        params: Object.freeze(gen.districtParams(rngFor(seed, SALT.ARTERY, s, 0x7a11), s)),
      };
      arteryPalettes.set(s, (p = gen.palette(s, d)));
    }
    return p;
  };

  const seams = createSeams(seed, districts, sites, paletteOf);
  const scene = opts.testScene;

  // ---- test-scene world: every query answers from the hand-authored layouts
  const sceneDistrict = (s: StoreyId): DistrictInfo => ({ id: 0, s, zone: Zone.LOBBY, mood: Mood.NORMAL, siteX: 0, siteZ: 0, seed, params: {} });

  const facade: WorldGen = {
    opts,
    districtAt: (s, cx, cz) => (scene !== null ? sceneDistrict(s) : districts.districtAt(s, cx, cz)),
    arteriesNear: (_s, cx, cz) => (scene !== null ? NONE : sites.arteriesNear(cx, cz)),
    towersNear(_s, cx, cz) {
      if (scene === null) return sites.towersNear(cx, cz);
      if (scene !== 'tower' || Math.max(Math.abs(cx), Math.abs(cz)) > SITES_NEAR_RADIUS) return NONE;
      return [testTowerSite(seed)];
    },
    zoneAt: (s, cx, cz) => (scene !== null ? Zone.LOBBY : districts.districtAt(s, cx, cz).zone),
    fields,
    seam(s, axis, cx, cz): SeamSpec {
      if (scene === null) return seams.seam(s, axis, cx, cz);
      // test scenes: read the line back from the (cached) scene layout of chunk (cx, cz)
      const l = cachedLayout(s, cx, cz);
      const e = axis === 'x' ? l.ex : l.ez;
      const out: SeamSpec = {
        mode: SeamMode.BOUNDARY, kind: new Uint8Array(N), hA: new Int16Array(N), hB: new Int16Array(N),
        matNeg: new Uint8Array(N), matPos: new Uint8Array(N), trim: new Uint8Array(N),
      };
      for (let c = 0; c < N; c++) {
        const k = axis === 'x' ? exIdx(0, c) : ezIdx(c, 0);
        out.kind[c] = e.kind[k]; out.hA[c] = e.hA[k]; out.hB[c] = e.hB[k];
        out.matNeg[c] = e.matNeg[k]; out.matPos[c] = e.matPos[k]; out.trim[c] = e.trim[k];
      }
      return out;
    },
    elevatorsNear: (_s, cx, cz) => (scene !== null ? NONE : sites.elevatorsNear(cx, cz)),
    landmarkAt: (s, cx, cz) => (scene !== null ? null : sites.landmarkAt(s, cx, cz)),
    generateChunk: (key: ChunkKey) => generateChunk(world, key),
    findSpawn(s) {
      if (scene !== null) return testSceneSpawn(scene, s, seed);
      return findSpawnImpl(spawnWorld, s);
    },
    findNearest(query, from, maxChunks) {
      if (scene !== null) {
        const q = query.trim().toLowerCase();
        if (q === 'spawn') return testSceneSpawn(scene, from.s, seed);
        if (q === 'tower' && scene === 'tower') return testSceneSpawn(scene, from.s, seed);
        if (q !== 'safe') return null;
      }
      return findNearestImpl(spawnWorld, query, from, maxChunks);
    },
    asciiMap(s, cx0, cz0, cx1, cz1) {
      const x0 = Math.min(cx0, cx1), x1 = Math.max(cx0, cx1), z0 = Math.min(cz0, cz1), z1 = Math.max(cz0, cz1);
      const nx = x1 - x0 + 1, nz = z1 - z0 + 1;
      if (nx * nz > MAX_ASCII_CHUNKS) return `asciiMap: region too large (${nx}x${nz} chunks, max ${MAX_ASCII_CHUNKS})`;
      const ls: ChunkLayout[] = [];
      for (let cz = z0; cz <= z1; cz++) for (let cx = x0; cx <= x1; cx++) ls.push(cachedLayout(s, cx, cz));
      return asciiMapFromLayouts(ls, nx, nz);
    },
  };

  const world: GenWorld = { seed, opts, districts, sites, seams, fields, paletteOf, lightingOf, arteryPalette, facade };

  function cachedLayout(s: StoreyId, cx: number, cz: number): ChunkLayout {
    const k = chunkKeyStr({ s, cx, cz });
    let l = layouts.get(k);
    if (l) {
      layouts.delete(k);
      layouts.set(k, l);
      return l;
    }
    l = generateChunk(world, { s, cx, cz });
    if (layouts.size >= LAYOUT_LRU) layouts.delete(layouts.keys().next().value as string);
    layouts.set(k, l);
    return l;
  }
  const spawnWorld: SpawnWorld = { seed, districts, sites, layout: cachedLayout, fields };

  return facade;
}
