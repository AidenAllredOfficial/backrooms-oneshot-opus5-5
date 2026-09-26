// Serial worker pipeline benchmark, including cold spawn, geometry and both lighting stages.
// Usage: node tools/workerbench.ts [7 42 ...] > workerbench.json
import { pathToFileURL } from 'node:url';
import { createHandlerState, handleRequest } from '../src/workers/handler.ts';
import { QUALITY, bakeQualityOf } from '../src/core/quality.ts';
import { hashString } from '../src/core/rng.ts';
import { worldToChunk, type TileKey } from '../src/core/grid.ts';
import type { WorkerRequest, WorkerResponse } from '../src/core/worker.ts';
import { lastBake } from '../src/bake/index.ts';

export function workerBench(seeds: string[]): object[] {
  const rows: object[] = [];
  for (const seed of seeds) {
    const state = createHandlerState();
    const request = <T extends WorkerRequest['t']>(req: Extract<WorkerRequest, { t: T }>): Extract<WorkerResponse, { t: T }> => {
      const { res } = handleRequest(req, state);
      if (res.t === 'error') throw new Error(res.message);
      return res as Extract<WorkerResponse, { t: T }>;
    };
    request({ t: 'init', job: 0, init: {
      opts: { seed: hashString(seed), seedText: seed, forceZone: null, forceMood: null, forceLandmark: null, testScene: null, lights: 'default' },
      bake: bakeQualityOf(QUALITY.high), bakeTerm: 'all', validate: false,
    } });
    const start = performance.now();
    const spawn = request({ t: 'spawn', job: 1, s: 0 }).result;
    rows.push({ seed, spawnMs: performance.now() - start, spawn });
    for (let q = 0; q < 4; q++) {
      const key: TileKey = { s: spawn.s, cx: worldToChunk(spawn.x), cz: worldToChunk(spawn.z), q: q as TileKey['q'] };
      const build = request({ t: 'build', job: 2, key });
      rows.push({ seed, q, build: build.ms, preview: { ...lastBake.ms }, texels: lastBake.texels });
      const full = request({ t: 'bake', job: 3, key });
      rows.push({ seed, q, bakeMs: full.ms, full: { ...lastBake.ms } });
    }
  }
  return rows;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const seeds = process.argv.slice(2);
  console.log(JSON.stringify(workerBench(seeds.length ? seeds : ['7', '42']), null, 2));
}
