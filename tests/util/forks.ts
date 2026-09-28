// tests/util/forks.ts — how many vitest forks a run may start, and its machine-wide admission (vitest.config.ts).
//
// Several agents run vitest (and the capture tools) at once on a 16 GB machine shared with the user's desktop. A run
// declares a weight of FORK_BASE_MB + FORK_MB per fork and takes the most forks (<= 4) that the memory budget admits:
// - with tools/lib/budget.mjs (the machine-wide ledger): the ledger admits the weight (sum of live weights + weight
//   <= BACKROOMS_BUDGET_MB, and MemAvailable - weight >= BACKROOMS_MIN_FREE_MB);
// - without it: MemAvailable - weight >= BACKROOMS_MIN_FREE_MB (default 4500).
// While a tool browser runs, at most 2 forks. Only when even 1 fork is refused does the run wait, saying why.
// Watch mode never takes a ledger entry (it would hold it for hours) and never waits.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** vitest main process (native loading: ~160 MB) plus headroom. */
export const FORK_BASE_MB = 300;
/** Per fork: about the p90 fork RSS plus headroom (native: p50 303 MB, max 985 MB with the 1.5 GB heap cap). */
export const FORK_MB = 700;
export const MAX_FORKS = 4;
/** Fork cap while a tool browser (shoot / qa / the capture daemon) is running. */
export const BROWSER_MAX_FORKS = 2;
export const BROWSER_SLOT_DIR = '/tmp/backrooms-browser-slots';

export interface ForkWeights { baseMb: number; forkMb: number }
export const DEFAULT_WEIGHTS: ForkWeights = { baseMb: FORK_BASE_MB, forkMb: FORK_MB };
export const weightOf = (forks: number, w: ForkWeights = DEFAULT_WEIGHTS): number => w.baseMb + w.forkMb * forks;

/** tools/lib/budget.mjs as far as this file relies on it (feature-detected; see docs/TESTING.md): acquire() resolves
 * to a lease, or to null when `wait: false` and the weight is not admitted now. */
export interface Lease { release(): unknown }
export interface Ledger {
  acquire(o: { weightMb: number; label: string; kind?: string; minFreeMb?: number; budgetMb?: number; wait?: boolean }): unknown;
  status?(): unknown;
}

export interface PlanInput {
  /** Requested fork count before memory sizing (BACKROOMS_TEST_WORKERS, --maxWorkers, or 4). */
  want: number;
  watch: boolean;
  minFreeMb: number;
  ledger: Ledger | null;
  label: string;
  memAvailableMb: () => number;
  browserRunning: () => boolean | Promise<boolean>;
  log: (msg: string) => void;
  /** vitest weights of the ledger (budget.mjs WEIGHTS.vitestBase / vitestFork), else DEFAULT_WEIGHTS */
  weights?: ForkWeights;
  sleep?: (ms: number) => Promise<void>;
  /** Fallback path: poll interval while waiting for memory (ms). */
  pollMs?: number;
}

export interface Plan {
  forks: number;
  via: 'ledger' | 'memory' | 'watch';
  browser: boolean;
  waited: boolean;
  release: () => void;
}

const noop = (): void => {};

function asLease(v: unknown): Lease | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as { release?: unknown; ok?: unknown; admitted?: unknown };
  if (typeof o.release !== 'function' || o.ok === false || o.admitted === false) return null;
  return o as Lease;
}

function once(fn: () => unknown): () => void {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    try { void fn(); } catch { /* the ledger reclaims entries of dead pids anyway */ }
  };
}

/** The largest n in [1, cap] with MemAvailable - weightOf(n) >= minFree, or 0 if even 1 does not fit. */
export function forksThatFit(memAvailableMb: number, cap: number, minFreeMb: number, w: ForkWeights = DEFAULT_WEIGHTS): number {
  for (let n = cap; n >= 1; n--) if (memAvailableMb - weightOf(n, w) >= minFreeMb) return n;
  return 0;
}

export async function planForks(o: PlanInput): Promise<Plan> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const w = o.weights ?? DEFAULT_WEIGHTS;
  const capNow = async (): Promise<{ cap: number; browser: boolean }> => {
    const browser = await o.browserRunning();
    const cap = Math.max(1, Math.min(MAX_FORKS, Math.floor(o.want) || MAX_FORKS, browser ? BROWSER_MAX_FORKS : MAX_FORKS));
    return { cap, browser };
  };
  let { cap, browser } = await capNow();

  if (o.watch) {
    return { forks: Math.max(1, forksThatFit(o.memAvailableMb(), cap, o.minFreeMb, w)), via: 'watch', browser, waited: false, release: noop };
  }

  if (o.ledger) {
    const tryAcquire = async (n: number, wait: boolean): Promise<Lease | null> =>
      asLease(await o.ledger!.acquire({ weightMb: weightOf(n, w), label: `${o.label} (${n} fork${n > 1 ? 's' : ''})`, kind: 'vitest', minFreeMb: o.minFreeMb, wait }));
    let threw = 0;
    for (let n = cap; n >= 1; n--) {
      try {
        const lease = await tryAcquire(n, false);
        if (lease) return { forks: n, via: 'ledger', browser, waited: false, release: once(() => lease.release()) };
      } catch { threw++; }
    }
    if (threw < cap) {
      o.log(`vitest: the memory budget does not admit even 1 fork (${weightOf(1, w)} MB) right now; waiting for other jobs (node tools/lib/budget.mjs --status)...`);
      try {
        const lease = await tryAcquire(1, true);
        if (lease) return { forks: 1, via: 'ledger', browser, waited: true, release: once(() => lease.release()) };
      } catch { /* fall through to the MemAvailable formula */ }
    }
    o.log('vitest: tools/lib/budget.mjs did not answer as expected; sizing forks from MemAvailable instead');
  }

  let waited = false;
  for (let t = 0; ; t++) {
    const n = forksThatFit(o.memAvailableMb(), cap, o.minFreeMb, w);
    if (n > 0) return { forks: n, via: 'memory', browser, waited, release: noop };
    if (t % 15 === 0) {
      o.log(`vitest: MemAvailable ${Math.round(o.memAvailableMb())} MB is below ${o.minFreeMb} + ${weightOf(1, w)} MB for even 1 fork; waiting...`);
    }
    waited = true;
    await sleep(o.pollMs ?? 2000);
    ({ cap, browser } = await capNow());
  }
}

// ---------------------------------------------------------------- environment probes

export function readMemAvailableMb(): number {
  try {
    const m = /MemAvailable:\s+(\d+) kB/.exec(readFileSync('/proc/meminfo', 'utf8'));
    return m ? Number(m[1]) / 1024 : Infinity;
  } catch { return Infinity; }
}

export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** A live holder of a tool browser slot (<dir>/slot-N/pid, taken by tools/shoot.mjs and by the ledger's 'browser'
 * leases), or a ledger holder of kind 'browser' (or labelled as one). */
export async function browserRunning(ledger: Ledger | null, slotDir = BROWSER_SLOT_DIR): Promise<boolean> {
  try {
    for (const d of readdirSync(slotDir)) {
      if (!d.startsWith('slot-')) continue;
      try { if (pidAlive(Number(readFileSync(path.join(slotDir, d, 'pid'), 'utf8')))) return true; } catch { /* being created / removed */ }
    }
  } catch { /* no slot dir: no browser */ }
  if (ledger?.status) {
    try {
      const s = (await ledger.status()) as { holders?: unknown[]; browsers?: { used?: number } } | unknown[] | null;
      if (s && !Array.isArray(s) && (s.browsers?.used ?? 0) > 0) return true;
      const list = Array.isArray(s) ? s : (s?.holders ?? []);
      for (const h of list as { label?: unknown; kind?: unknown; pid?: unknown }[]) {
        const named = h?.kind === 'browser' || (typeof h?.label === 'string' && /browser|chrom/i.test(h.label));
        if (named && (typeof h.pid !== 'number' || pidAlive(h.pid))) return true;
      }
    } catch { /* status is informational */ }
  }
  return false;
}

/** vitest's own CLI: watch mode, and a --maxWorkers the user passed (it overrides the config). */
export function parseVitestArgv(argv: readonly string[], env: NodeJS.ProcessEnv = process.env, stdinTty = !!process.stdin.isTTY): { watch: boolean; maxWorkers: number | null; command: string | null } {
  const args = argv.slice(2);
  let maxWorkers: number | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const m = /^--max-?[wW]orkers(?:=(.*))?$/.exec(a);
    if (m) { const v = Number(m[1] ?? args[i + 1]); if (Number.isFinite(v) && v > 0) maxWorkers = Math.floor(v); }
  }
  const command = args.find((a) => /^(run|related|watch|dev|list|bench|init)$/.test(a)) ?? null;
  let watch: boolean;
  if (args.includes('--run') || args.includes('--watch=false') || args.includes('--no-watch')) watch = false;
  else if (args.includes('--watch') || args.includes('-w')) watch = true;
  else if (command === 'run' || command === 'list' || command === 'init') watch = false;
  else if (command === 'watch' || command === 'dev') watch = true;
  else watch = !env.CI && stdinTty; // `vitest`, `vitest related`, `vitest <filter>`: vitest watches on a TTY outside CI
  return { watch, maxWorkers, command };
}
