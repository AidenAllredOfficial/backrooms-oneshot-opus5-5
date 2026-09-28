// vitest.config.ts — test runner configuration (docs/TESTING.md). vitest reads this file INSTEAD of vite.config.ts;
// the game build and dev server never read it.
//
// - Native loading (experimental.viteModuleRunner: false): Node 24 strips the types and runs src/ as plain ESM, the
//   way the game runs in the browser. Vite's module runner turned every cross-module reference in the hot world /
//   bake code into a getter call (43% of the suite's CPU). Needs erasable TS only (tsconfig enforces it), no vi.mock,
//   and `import.meta.env` guarded (it is undefined under Node).
// - Forks are sized from the memory budget at startup (tests/util/forks.ts): 1-4, fewer while a tool browser runs or
//   other test runs hold forks (6 machine-wide), admitted through the machine-wide ledger (tools/lib/budget.mjs) when
//   it exists. Each fork's heap is capped.
// - Two projects: 'heavy' (world generation, baking, meshing, audio synthesis: one fresh process per file) and
//   'unit' (everything else: files share workers, no per-file process spawn and re-import).
// - The 'sweep' tag marks statistical / acceptance sweeps and real full-bake gates. `npm test` runs everything (the
//   pre-merge gate); `npm run test:quick` / `test:related` / `test:changed` skip sweeps.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { defineConfig } from 'vitest/config';
import {
  browserRunning, createForkRegistry, FORK_REGISTRY_DIR, MAX_FORKS, parseVitestArgv, planForks, readMemAvailableMb, TOTAL_FORKS, weightOf,
  type ForkWeights, type Ledger, type Plan,
} from './tests/util/forks.ts';

const ROOT = import.meta.dirname;
/** Files that generate worlds, bake, mesh or synthesise audio: isolated, one process per file. Whole directories,
 * plus the slow files elsewhere: the queue runs every 'heavy' file before any 'unit' file (projects sort by name,
 * then longest first), so a slow 'unit' file would start last and run alone at the end. */
const HEAVY = [
  'tests/{world,bake,integration,audio,mesh,workers}/**/*.test.ts',
  'tests/lighting/flicker.test.ts', 'tests/props/{props,tileProps}.test.ts', 'tests/player/traversal.test.ts',
  'tests/materials/depthPrepass.test.ts',
];

type BudgetModule = Partial<Ledger> & { WEIGHTS?: { vitestBase?: number; vitestFork?: number } };

/** tools/lib/budget.mjs (the machine-wide memory ledger of the capture tools), feature-detected. */
async function loadLedger(): Promise<{ ledger: Ledger; weights?: ForkWeights } | null> {
  const file = path.join(ROOT, 'tools', 'lib', 'budget.mjs');
  if (!existsSync(file)) return null;
  try {
    const m = (await import(pathToFileURL(file).href)) as BudgetModule & { default?: BudgetModule };
    const api = typeof m.acquire === 'function' ? m : m.default;
    if (!api || typeof api.acquire !== 'function') return null;
    const W = api.WEIGHTS;
    const weights = W && W.vitestBase! > 0 && W.vitestFork! > 0 ? { baseMb: W.vitestBase!, forkMb: W.vitestFork! } : undefined;
    return { ledger: api as Ledger, weights };
  } catch (e) {
    process.stderr.write(`vitest: tools/lib/budget.mjs failed to load (${(e as Error).message}); sizing forks from MemAvailable\n`);
    return null;
  }
}

async function sizeForks(): Promise<Plan> {
  const g = globalThis as { __backroomsForkPlan?: Promise<Plan> };
  if (g.__backroomsForkPlan) return g.__backroomsForkPlan; // one plan (and one ledger entry) per vitest process
  g.__backroomsForkPlan = (async () => {
    const argv = parseVitestArgv(process.argv);
    let want = argv.maxWorkers ?? Number(process.env.BACKROOMS_TEST_WORKERS ?? MAX_FORKS);
    // `vitest run a.test.ts b.test.ts`: never more forks than named test files
    const files = process.argv.slice(3).filter((a) => !a.startsWith('-') && /\.test\.ts$/.test(a) && existsSync(path.resolve(a)));
    if (argv.command === 'run' && files.length > 0 && files.length === process.argv.slice(3).filter((a) => !a.startsWith('-')).length) want = Math.min(want, files.length);
    const budget = argv.watch ? null : await loadLedger();
    const ledger = budget?.ledger ?? null;
    const minFreeMb = Number(process.env.BACKROOMS_MIN_FREE_MB ?? 4500);
    const plan = await planForks({
      want, watch: argv.watch, minFreeMb, ledger, weights: budget?.weights, label: `vitest ${path.basename(ROOT)}`,
      registry: argv.watch ? null : createForkRegistry(process.env.BACKROOMS_TEST_FORK_DIR ?? FORK_REGISTRY_DIR),
      totalForks: Number(process.env.BACKROOMS_TEST_FORKS_TOTAL ?? TOTAL_FORKS),
      memAvailableMb: readMemAvailableMb, browserRunning: () => browserRunning(ledger),
      log: (msg) => process.stderr.write(msg + '\n'),
    });
    process.once('exit', plan.release);
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
      process.once(sig, () => {
        plan.release();
        if (process.listenerCount(sig) === 0) process.kill(process.pid, sig); // nobody else handles it: default action
      });
    }
    if (argv.maxWorkers !== null && argv.maxWorkers > plan.forks) {
      process.stderr.write(`vitest: --maxWorkers ${argv.maxWorkers} overrides the memory-sized ${plan.forks}; prefer BACKROOMS_TEST_WORKERS\n`);
    }
    const note = plan.browser ? ', a tool browser is running' : '';
    process.stderr.write(`vitest: ${plan.forks} fork${plan.forks > 1 ? 's' : ''} (MemAvailable ${Math.round(readMemAvailableMb())} MB, ` +
      `${plan.via === 'ledger' ? `budget ledger ${weightOf(plan.forks, budget?.weights)} MB` : plan.via === 'watch' ? 'watch mode, no ledger' : 'no ledger'}${note})\n`);
    return plan;
  })();
  return g.__backroomsForkPlan;
}

export default defineConfig(async () => {
  const plan = await sizeForks();
  // V8 bytecode cache for three.js and src across the fresh fork processes (forks inherit the variable)
  process.env.NODE_COMPILE_CACHE ??= path.join(ROOT, 'node_modules', '.cache', 'node-compile');
  return {
    test: {
      environment: 'node',
      pool: 'forks',
      maxWorkers: plan.forks,
      // the largest heap measured at the end of a file is ~620 MB; a runaway fork fails instead of eating the machine
      execArgv: ['--max-old-space-size=1536'],
      experimental: { viteModuleRunner: false },
      // CPU-heavy tests under load (a browser bake pool, other agents) must not trip vitest's 5 s default; a test that
      // hangs still fails
      testTimeout: 60_000,
      hookTimeout: 60_000,
      tags: [{
        name: 'sweep',
        description: 'statistical / acceptance sweeps (hundreds of seeds or chunks, 1e5 s signals) and real full-bake gates: npm test only',
        timeout: 600_000,
      }],
      strictTags: true,
      // no root `include`: projects that extend the root concatenate include arrays (files would run twice)
      projects: [
        { extends: true, test: { name: 'heavy', include: HEAVY, isolate: true } },
        { extends: true, test: { name: 'unit', include: ['tests/**/*.test.ts'], exclude: HEAVY, isolate: false, unstubGlobals: true } },
      ],
    },
  };
});
