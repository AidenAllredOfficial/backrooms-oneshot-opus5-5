// tests/util/forks.test.ts — vitest fork sizing and admission (tests/util/forks.ts, used by vitest.config.ts).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { browserRunning, forksThatFit, parseVitestArgv, planForks, weightOf, type Ledger, type PlanInput } from './forks.ts';

const base = (o: Partial<PlanInput>): PlanInput => ({
  want: 4, watch: false, minFreeMb: 4500, ledger: null, label: 'vitest test', memAvailableMb: () => 16000,
  browserRunning: () => false, log: () => {}, sleep: async () => {}, pollMs: 0, ...o,
});

type FakeLedger = Ledger & { calls: { weightMb: number; wait?: boolean }[]; live: number; releases: number };
/** A ledger admitting while the sum of live weights + weight <= budget (wait: true always admits); records calls. */
function fakeLedger(budgetMb: number, held = 0): FakeLedger {
  const l: FakeLedger = {
    calls: [], live: held, releases: 0,
    acquire(o: { weightMb: number; wait?: boolean }) {
      l.calls.push({ weightMb: o.weightMb, wait: o.wait });
      if (l.live + o.weightMb > budgetMb && !o.wait) return null;
      l.live += o.weightMb;
      return { release: () => { l.live -= o.weightMb; l.releases++; } };
    },
  };
  return l;
}

let tmp: string | null = null;
afterEach(() => { if (tmp) rmSync(tmp, { recursive: true, force: true }); tmp = null; });

describe('fork sizing', () => {
  it('weights are 300 MB + 700 MB per fork; MemAvailable must keep minFree after the weight', () => {
    expect(weightOf(1)).toBe(1000);
    expect(weightOf(4)).toBe(3100);
    expect(forksThatFit(11400, 4, 4500)).toBe(4);
    expect(forksThatFit(7600, 4, 4500)).toBe(4); // 7600 - 3100 = 4500
    expect(forksThatFit(7599, 4, 4500)).toBe(3);
    expect(forksThatFit(5499, 4, 4500)).toBe(0);
    expect(forksThatFit(16000, 2, 4500)).toBe(2);
  });

  it('without a ledger: the most forks that leave MemAvailable >= minFree, never more than 4, 2 while a browser runs', async () => {
    expect((await planForks(base({}))).forks).toBe(4);
    expect((await planForks(base({ want: 9 }))).forks).toBe(4);
    expect((await planForks(base({ memAvailableMb: () => 6900 }))).forks).toBe(3);
    expect((await planForks(base({ browserRunning: () => true }))).forks).toBe(2);
    expect((await planForks(base({ want: 1 }))).forks).toBe(1);
    expect((await planForks(base({})).then((p) => p.via))).toBe('memory');
  });

  it('without a ledger: waits (with a message) only when even 1 fork does not fit', async () => {
    const mem = [5000, 5200, 6000];
    const logs: string[] = [];
    const p = await planForks(base({ memAvailableMb: () => mem.shift() ?? 6000, log: (m) => logs.push(m) }));
    expect(p.forks).toBe(1);
    expect(p.waited).toBe(true);
    expect(logs.join('\n')).toMatch(/waiting/);
  });

  it('watch mode takes no ledger entry and never waits', async () => {
    const ledger = fakeLedger(0);
    const p = await planForks(base({ watch: true, ledger, memAvailableMb: () => 3000 }));
    expect(p.forks).toBe(1);
    expect(p.via).toBe('watch');
    expect(ledger.calls).toEqual([]);
  });

  it('with a ledger: the largest admitted weight; later runs get fewer forks, then wait for 1; release is idempotent', async () => {
    const ledger = fakeLedger(7000, 1700); // a tool browser (700) and a page (1000) hold weight
    const a = await planForks(base({ ledger }));
    expect([a.forks, a.via, ledger.live]).toEqual([4, 'ledger', 4800]);
    const b = await planForks(base({ ledger }));
    expect([b.forks, ledger.live]).toEqual([2, 6500]); // 4 (+3100) and 3 (+2400) forks are refused
    const logs: string[] = [];
    const c = await planForks(base({ ledger, log: (m) => logs.push(m) }));
    expect([c.forks, c.waited]).toEqual([1, true]);
    expect(ledger.calls.at(-1)).toEqual({ weightMb: 1000, wait: true });
    expect(logs.join('\n')).toMatch(/does not admit even 1 fork/);
    a.release(); a.release();
    expect(ledger.releases).toBe(1);
    expect(ledger.live).toBe(6500 + 1000 - 3100);
  });

  it('a ledger that throws on every call falls back to MemAvailable', async () => {
    const ledger: Ledger = { acquire: () => { throw new Error('boom'); } };
    const logs: string[] = [];
    const p = await planForks(base({ ledger, log: (m) => logs.push(m) }));
    expect([p.forks, p.via]).toEqual([4, 'memory']);
    expect(logs.join('\n')).toMatch(/did not answer as expected/);
  });

  it('a live browser slot (tools/shoot.mjs acquireSlot) or a ledger holder labelled as a browser counts as a browser', async () => {
    tmp = mkdtempSync(path.join(tmpdir(), 'br-slots-'));
    expect(await browserRunning(null, tmp)).toBe(false);
    mkdirSync(path.join(tmp, 'slot-0'));
    writeFileSync(path.join(tmp, 'slot-0', 'pid'), '999999999'); // no such process
    expect(await browserRunning(null, tmp)).toBe(false);
    writeFileSync(path.join(tmp, 'slot-0', 'pid'), String(process.pid));
    expect(await browserRunning(null, tmp)).toBe(true);
    rmSync(path.join(tmp, 'slot-0'), { recursive: true });
    const ledger: Ledger = { acquire: () => null, status: () => ({ holders: [{ pid: process.pid, label: 'rsd browser', weightMb: 700 }] }) };
    expect(await browserRunning(ledger, tmp)).toBe(true);
  });

  it('reads watch mode and --maxWorkers from the vitest command line', () => {
    const argv = (...a: string[]): string[] => ['node', 'vitest.mjs', ...a];
    expect(parseVitestArgv(argv('run'), {}, true)).toEqual({ watch: false, maxWorkers: null, command: 'run' });
    expect(parseVitestArgv(argv('related', '--run', 'src/a.ts'), {}, true).watch).toBe(false);
    expect(parseVitestArgv(argv('related', 'src/a.ts'), {}, true).watch).toBe(true);
    expect(parseVitestArgv(argv('related', 'src/a.ts'), {}, false).watch).toBe(false);
    expect(parseVitestArgv(argv(), { CI: '1' }, true).watch).toBe(false);
    expect(parseVitestArgv(argv('list'), {}, true).watch).toBe(false);
    expect(parseVitestArgv(argv('run', '--maxWorkers=3'), {}, false).maxWorkers).toBe(3);
    expect(parseVitestArgv(argv('run', '--maxWorkers', '2'), {}, false).maxWorkers).toBe(2);
  });
});
