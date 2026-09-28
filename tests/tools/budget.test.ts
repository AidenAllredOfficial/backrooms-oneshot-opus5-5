// tools/lib/budget.mjs: the machine-wide memory ledger (admission, browser slots, dead-pid reclaim, concurrency).
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLedger, pageWeight, WEIGHTS } from '../../tools/lib/budget.mjs';

const BUDGET = path.resolve(import.meta.dirname, '../../tools/lib/budget.mjs');
let root = '';
let dir = '';
let slotDir = '';
let avail = 12000;
const mk = (o: Record<string, unknown> = {}) =>
  createLedger({ dir, slotDir, memAvailable: () => avail, budgetMb: 7000, minFreeMb: 4500, browserSlots: 1, noExitHook: true, ...o });

/** pid of a process that has already exited */
function deadPid(): number {
  const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  return Number(r.stdout);
}

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'budget-test-'));
  dir = path.join(root, 'ledger');
  slotDir = path.join(root, 'slots');
  avail = 12000;
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('budget ledger', () => {
  it('admits leases within the budget and refuses the rest without waiting', async () => {
    const L = mk();
    const a = await L.acquire({ weightMb: 3000, label: 'a', wait: false });
    const b = await L.acquire({ weightMb: 3000, label: 'b', wait: false });
    expect(a && b).toBeTruthy();
    expect(await L.acquire({ weightMb: 1500, label: 'c', wait: false })).toBeNull(); // 6000 + 1500 > 7000
    const s = L.status();
    expect(s.usedMb).toBe(6000);
    expect(s.headroomMb).toBe(1000);
    expect(s.holders.map((h) => h.label).sort()).toEqual(['a', 'b']);
    a!.release();
    expect(await L.acquire({ weightMb: 1500, label: 'c', wait: false })).not.toBeNull();
  });

  it('keeps MemAvailable - weight above the floor', async () => {
    const L = mk();
    avail = 6000;
    expect(await L.acquire({ weightMb: 2000, wait: false })).toBeNull(); // 6000 - 2000 < 4500
    expect(await L.acquire({ weightMb: 1000, wait: false })).not.toBeNull();
    expect(L.status().headroomMb).toBe(1500);
  });

  it('runs a job heavier than the whole budget alone', async () => {
    const L = mk();
    const big = await L.acquire({ weightMb: 7500, wait: false });
    expect(big).not.toBeNull();
    expect(await L.acquire({ weightMb: 100, wait: false })).toBeNull();
    big!.release();
  });

  it('caps browsers with the slot directories older tools use', async () => {
    const L = mk();
    const b1 = await L.acquire({ weightMb: WEIGHTS.browser, kind: 'browser', wait: false });
    expect(b1).not.toBeNull();
    expect(readFileSync(path.join(slotDir, 'slot-0', 'pid'), 'utf8')).toBe(String(process.pid));
    expect(await L.acquire({ weightMb: WEIGHTS.browser, kind: 'browser', wait: false })).toBeNull();
    expect(L.status().browsers.used).toBe(1);
    b1!.release();
    expect(existsSync(path.join(slotDir, 'slot-0'))).toBe(false);
    // a live process holding a slot the old way (no ledger entry) blocks browsers and counts as a legacy weight
    mkdirSync(path.join(slotDir, 'slot-0'), { recursive: true });
    writeFileSync(path.join(slotDir, 'slot-0', 'pid'), String(process.ppid));
    expect(await L.acquire({ weightMb: WEIGHTS.browser, kind: 'browser', wait: false })).toBeNull();
    const s = L.status();
    expect(s.browsers.legacy).toEqual([{ slot: 'slot-0', pid: process.ppid }]);
    expect(s.usedMb).toBe(WEIGHTS.legacySlot);
  });

  it('allows one build at a time', async () => {
    const L = mk();
    const b = await L.acquire({ weightMb: WEIGHTS.build, kind: 'build', wait: false });
    expect(await L.acquire({ weightMb: WEIGHTS.build, kind: 'build', wait: false })).toBeNull();
    b!.release();
    expect(await L.acquire({ weightMb: WEIGHTS.build, kind: 'build', wait: false })).not.toBeNull();
  });

  it('reclaims the leases and slots of dead processes', async () => {
    const L = mk();
    const pid = deadPid();
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'h-dead.json'), JSON.stringify({ id: 'dead', pid, label: 'dead', kind: 'page', weightMb: 6500, started: Date.now() }));
    mkdirSync(path.join(slotDir, 'slot-0'), { recursive: true });
    writeFileSync(path.join(slotDir, 'slot-0', 'pid'), String(pid));
    const b = await L.acquire({ weightMb: 2000, kind: 'browser', wait: false });
    expect(b).not.toBeNull();
    expect(existsSync(path.join(dir, 'h-dead.json'))).toBe(false);
    expect(L.status().holders.map((h) => h.weightMb)).toEqual([2000]);
  });

  it('treats a reused pid (different start time) as dead', async () => {
    const L = mk();
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'h-reused.json'), JSON.stringify({ id: 'reused', pid: process.pid, pidStart: 1, label: 'old', kind: 'page', weightMb: 6500, started: Date.now() }));
    expect(await L.acquire({ weightMb: 2000, label: 'new', wait: false })).not.toBeNull();
    expect(L.status().holders.map((h) => h.label)).toEqual(['new']);
  });

  it('resizes leases: shrinking always, growing only when admitted', async () => {
    const L = mk();
    const a = await L.acquire({ weightMb: 3000, label: 'a', wait: false });
    await L.acquire({ weightMb: 3000, label: 'b', wait: false });
    expect(await a!.resize(4500)).toBe(false); // 3000 + 4500 > 7000
    expect(await a!.resize(4000)).toBe(true);
    expect(L.status().usedMb).toBe(7000);
    expect(await a!.resize(1000)).toBe(true);
    expect(a!.weightMb).toBe(1000);
    expect(L.status().usedMb).toBe(4000);
  });

  it('waits for a release, announces the holders and lists itself as a waiter', async () => {
    const L = mk();
    const a = await L.acquire({ weightMb: 6000, label: 'holder', wait: false });
    const msgs: string[] = [];
    const p = L.acquire({ weightMb: 2000, label: 'waiter', pollMs: 20, announceAfterMs: 0, onWait: (m: string) => msgs.push(m) });
    await new Promise((r) => setTimeout(r, 120));
    expect(L.status().waiters.map((w) => w.label)).toEqual(['waiter']);
    a!.release();
    const b = await p;
    expect(b).not.toBeNull();
    expect(msgs[0]).toMatch(/waiter.*holder/);
    expect(L.status().waiters).toEqual([]);
  });

  it('gives up after timeoutMs', async () => {
    const L = mk();
    await L.acquire({ weightMb: 6000, wait: false });
    const t0 = Date.now();
    expect(await L.acquire({ weightMb: 2000, pollMs: 10, timeoutMs: 60, onWait: () => {} })).toBeNull();
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('serialises concurrent processes to the budget', async () => {
    const log = path.join(root, 'log.txt');
    const script = `
      import { createLedger } from ${JSON.stringify(BUDGET)};
      import { appendFileSync } from 'node:fs';
      const L = createLedger({ dir: ${JSON.stringify(dir)}, slotDir: ${JSON.stringify(slotDir)}, memAvailable: () => 20000, budgetMb: 7000, minFreeMb: 4500 });
      const l = await L.acquire({ weightMb: 3000, label: 'p' + process.pid, pollMs: 15, onWait: () => {} });
      appendFileSync(${JSON.stringify(log)}, 'in ' + Date.now() + '\\n');
      await new Promise((r) => setTimeout(r, 250));
      appendFileSync(${JSON.stringify(log)}, 'out ' + Date.now() + '\\n');
      l.release();
    `;
    const kids = Array.from({ length: 5 }, () => spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: 'inherit' }));
    await Promise.all(kids.map((k) => new Promise((r) => k.on('exit', r))));
    const ev = readFileSync(log, 'utf8').trim().split('\n').map((l) => { const [k, t] = l.split(' '); return { k, t: Number(t) }; });
    expect(ev.filter((e) => e.k === 'in')).toHaveLength(5);
    // replay: 'out' before 'in' at equal times
    ev.sort((a, b) => a.t - b.t || (a.k === 'out' ? -1 : 1));
    let live = 0;
    let max = 0;
    for (const e of ev) { live += e.k === 'in' ? 1 : -1; max = Math.max(max, live); }
    expect(max).toBeLessThanOrEqual(2); // 3 x 3000 > 7000
    expect(max).toBe(2);
    expect(readdirSync(dir).filter((n) => n.startsWith('h-'))).toEqual([]);
  }, 30000);

  it('weights pages by quality and size', () => {
    expect(pageWeight({ quality: 'high', width: 1920, height: 1080 })).toBe(WEIGHTS.page);
    expect(pageWeight({ quality: 'ultra' })).toBe(WEIGHTS.pageHeavy);
    expect(pageWeight({ quality: 'high', width: 2560, height: 1440 })).toBe(WEIGHTS.pageHeavy);
    expect(pageWeight({ cold: true })).toBe(WEIGHTS.pageHeavy);
  });
});
