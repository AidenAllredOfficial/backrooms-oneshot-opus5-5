#!/usr/bin/env node
// tools/lib/budget.mjs — machine-wide memory budget for tool jobs (browsers, pages, builds, dev servers, test runs).
//
// Many agents share one 16 GB machine with the user's desktop. Every heavy tool job declares a weight (its measured
// peak in MB) and takes a lease from a ledger in /tmp/backrooms-budget before it starts. A lease is admitted when
//   (sum of live lease weights) + weight <= BACKROOMS_BUDGET_MB (default 7000)   AND
//   MemAvailable - weight >= BACKROOMS_MIN_FREE_MB (default 4500),
// otherwise the caller waits (printing the holders once). Browsers are also count-capped: a 'browser' lease takes one
// of BACKROOMS_BROWSER_SLOTS (default 1) lock directories in /tmp/backrooms-browser-slots, the same directories older
// versions of tools/shoot.mjs use, so old and new tools never run two browsers at once. A 'build' lease is capped at
// one at a time. Leases of dead processes are reclaimed (pid + process start time, so a reused pid does not count).
//
// API (stable; tools/rsd, tools/shoot.mjs, tools/qa.mjs and vitest.config.ts use it):
//   acquire({ weightMb, label, kind?, minFreeMb?, budgetMb?, wait = true, timeoutMs?, onWait? })
//     -> Promise<{ id, weightMb, kind, label, release(), resize(mb, { wait = false }) -> Promise<boolean> } | null>
//     (null only with wait: false when the lease is not admitted now, or when timeoutMs expires)
//   status() -> { budgetMb, minFreeMb, memAvailableMb, usedMb, headroomMb, holders, waiters, browsers }
//   WEIGHTS, pageWeight({ quality, width, height, cold }), memAvailableMb()
//   CLI: node tools/lib/budget.mjs --status [--json]
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Measured peak weights in MB (docs/CAPTURE.md "Memory policy"). */
export const WEIGHTS = Object.freeze({
  browser: 700, // idle headless Chromium (browser + GPU process + utility)
  page: 1000, // one capture page, high quality, <= 1080p, warm tile cache
  pageHeavy: 1600, // ultra, >= 1440p, or a cold location (4 bake workers busy)
  vite: 500, // dev server
  build: 950, // one `vite build`
  tsc: 550,
  vitestBase: 300, // vitest main process
  vitestFork: 700, // per fork
  legacySlot: 1700, // a browser slot held by an older tool that does not use this ledger (browser + page + vite)
});

/** Weight of one capture page. */
export function pageWeight({ quality = 'high', width = 1600, height = 900, cold = false } = {}) {
  return quality === 'ultra' || width * height >= 2560 * 1440 || cold ? WEIGHTS.pageHeavy : WEIGHTS.page;
}

export function memAvailableMb() {
  try {
    const m = /MemAvailable:\s+(\d+) kB/.exec(readFileSync('/proc/meminfo', 'utf8'));
    return m ? Number(m[1]) / 1024 : Infinity;
  } catch { return Infinity; }
}

/** Start time of a process (clock ticks since boot), or null if it does not exist. */
export function pidStartTime(pid) {
  try {
    const st = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return Number(st.slice(st.lastIndexOf(')') + 2).split(' ')[19]);
  } catch { return null; }
}

function pidAlive(pid, start) {
  if (!pid) return false;
  try { process.kill(pid, 0); } catch (e) { if (e.code !== 'EPERM') return false; }
  if (start == null) return true;
  const now = pidStartTime(pid);
  return now === null ? true : now === start; // /proc unreadable: trust kill(0)
}

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const envNum = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' && Number.isFinite(Number(process.env[k])) ? Number(process.env[k]) : d);

/**
 * A ledger over one directory. Tests create their own with an injected MemAvailable reader and temp directories;
 * the module-level acquire()/status() use the machine-wide one.
 */
export function createLedger(o = {}) {
  const dir = o.dir ?? process.env.BACKROOMS_BUDGET_DIR ?? '/tmp/backrooms-budget';
  const slotDir = o.slotDir ?? process.env.BACKROOMS_SLOT_DIR ?? '/tmp/backrooms-browser-slots';
  const memAvailable = o.memAvailable ?? memAvailableMb;
  const defBudget = () => o.budgetMb ?? envNum('BACKROOMS_BUDGET_MB', 7000);
  const defMinFree = () => o.minFreeMb ?? envNum('BACKROOMS_MIN_FREE_MB', 4500);
  const browserSlots = () => Math.max(1, o.browserSlots ?? envNum('BACKROOMS_BROWSER_SLOTS', 1));
  const pid = o.pid ?? process.pid;
  const myStart = pidStartTime(pid);
  const lockDir = path.join(dir, '.lock');
  let seq = 0;
  const mine = new Map(); // id -> holder file, for release at exit
  let exitHooked = false;

  function withLock(fn) {
    mkdirSync(dir, { recursive: true });
    for (let i = 0; ; i++) {
      try { mkdirSync(lockDir); break; } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        // a holder does a read-modify-write in well under a millisecond: a lock older than 5 s is stale
        try { if (Date.now() - statSync(lockDir).mtimeMs > 5000) rmSync(lockDir, { recursive: true, force: true }); } catch { /* raced */ }
        sleepSync(i < 20 ? 1 : 5);
      }
    }
    try { return fn(); } finally { try { rmSync(lockDir, { recursive: true, force: true }); } catch { /* ignore */ } }
  }

  function readJson(f) { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } }
  function writeAtomic(f, obj) { const t = `${f}.${pid}.tmp`; writeFileSync(t, JSON.stringify(obj)); renameSync(t, f); }

  /** Live holders and waiters (reclaims the files of dead processes). Call under the lock. */
  function scan() {
    const holders = [];
    const waiters = [];
    let names = [];
    try { names = readdirSync(dir); } catch { /* none */ }
    for (const n of names) {
      if (!/^[hw]-.*\.json$/.test(n)) continue;
      const f = path.join(dir, n);
      const h = readJson(f);
      if (!h || !pidAlive(h.pid, h.pidStart)) {
        // unreadable (being written) files are left alone unless old
        if (h || Date.now() - (statSafe(f)?.mtimeMs ?? 0) > 5000) {
          try { rmSync(f, { force: true }); } catch { /* ignore */ }
          if (h?.slot) releaseSlotDir(h.slot, h.pid);
        }
        continue;
      }
      (n[0] === 'h' ? holders : waiters).push({ ...h, file: f });
    }
    return { holders, waiters, slots: scanSlots(holders) };
  }

  function statSafe(f) { try { return statSync(f); } catch { return null; } }

  /** Browser slot directories: occupied ones, and those held by processes without a ledger lease ('legacy'). */
  function scanSlots(holders) {
    const used = [];
    const legacy = [];
    for (let i = 0; i < 64; i++) {
      const d = path.join(slotDir, `slot-${i}`);
      const st = statSafe(d);
      if (!st) continue;
      let p = 0;
      try { p = Number(readFileSync(path.join(d, 'pid'), 'utf8')); } catch { /* being created */ }
      if (p && !pidAlive(p)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } continue; }
      if (!p) {
        if (Date.now() - st.mtimeMs > 5000) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } continue; }
      }
      used.push({ slot: `slot-${i}`, pid: p });
      if (p && !holders.some((h) => h.slot === `slot-${i}` && h.pid === p)) legacy.push({ slot: `slot-${i}`, pid: p });
    }
    return { used, legacy };
  }

  function releaseSlotDir(slot, owner) {
    const d = path.join(slotDir, slot);
    try {
      const p = Number(readFileSync(path.join(d, 'pid'), 'utf8'));
      if (p && p !== owner) return; // someone else's now
    } catch { /* gone or empty */ }
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  function takeSlot() {
    mkdirSync(slotDir, { recursive: true });
    for (let i = 0; i < browserSlots(); i++) {
      const d = path.join(slotDir, `slot-${i}`);
      try { mkdirSync(d); } catch { continue; }
      writeFileSync(path.join(d, 'pid'), String(pid));
      return `slot-${i}`;
    }
    return null;
  }

  function usedMb(s, exceptId) {
    return s.holders.filter((h) => h.id !== exceptId).reduce((a, h) => a + (h.weightMb || 0), 0) + s.slots.legacy.length * WEIGHTS.legacySlot;
  }

  /** Admission check for `w` more MB (under the lock). Returns a reason string when refused, '' when admitted. */
  function refusal(s, w, kind, budgetMb, minFreeMb, exceptId) {
    const used = usedMb(s, exceptId);
    const others = s.holders.filter((h) => h.id !== exceptId).length + s.slots.legacy.length;
    // a single job heavier than the whole budget still runs, alone
    if (used + w > budgetMb && others > 0) return `budget ${Math.round(used)} + ${w} > ${budgetMb} MB`;
    const avail = memAvailable();
    if (avail - w < minFreeMb) return `MemAvailable ${Math.round(avail)} - ${w} < ${minFreeMb} MB`;
    if (kind === 'browser' && s.slots.used.length >= browserSlots()) return `browser slots ${s.slots.used.length}/${browserSlots()} taken`;
    if (kind === 'build' && s.holders.some((h) => h.kind === 'build' && h.id !== exceptId)) return 'another build is running';
    return '';
  }

  function describe(s) {
    const rows = s.holders.map((h) => `${h.label} (${h.kind}, ${h.weightMb} MB, pid ${h.pid}, ${Math.round((Date.now() - h.started) / 1000)} s)`);
    for (const l of s.slots.legacy) rows.push(`legacy browser slot ${l.slot} (pid ${l.pid}, counted as ${WEIGHTS.legacySlot} MB)`);
    return rows.length ? rows.join('; ') : 'none';
  }

  function hookExit() {
    if (exitHooked || o.noExitHook) return;
    exitHooked = true;
    process.once('exit', () => { for (const id of [...mine.keys()]) releaseById(id); });
  }

  function releaseById(id) {
    const e = mine.get(id);
    if (!e) return;
    mine.delete(id);
    try { rmSync(e.file, { force: true }); } catch { /* ignore */ }
    if (e.slot) releaseSlotDir(e.slot, pid);
  }

  function lease(h) {
    return {
      id: h.id, kind: h.kind, label: h.label,
      get weightMb() { return mine.get(h.id)?.weightMb ?? 0; },
      release() { withLock(() => releaseById(h.id)); },
      /** Changes the lease weight. Shrinking always succeeds; growing is admitted like a new lease of the difference. */
      async resize(mb, { wait = false, pollMs = 500, timeoutMs = Infinity } = {}) {
        const t0 = Date.now();
        for (;;) {
          const ok = withLock(() => {
            const e = mine.get(h.id);
            if (!e) return false;
            if (mb > e.weightMb) {
              const s = scan();
              const used = usedMb(s, h.id);
              const others = s.holders.filter((x) => x.id !== h.id).length + s.slots.legacy.length;
              if ((used + mb > e.budgetMb && others > 0) || memAvailable() - (mb - e.weightMb) < e.minFreeMb) return null;
            }
            e.weightMb = mb;
            writeAtomic(e.file, { ...e.record, weightMb: mb });
            e.record.weightMb = mb;
            return true;
          });
          if (ok !== null) return ok;
          if (!wait || Date.now() - t0 > timeoutMs) return false;
          await sleep(pollMs);
        }
      },
    };
  }

  async function acquire(opts = {}) {
    const weightMb = Math.max(0, Math.round(Number(opts.weightMb ?? 0)));
    const label = String(opts.label ?? path.basename(process.argv[1] ?? 'job'));
    const kind = String(opts.kind ?? 'job');
    const budgetMb = opts.budgetMb ?? defBudget();
    const minFreeMb = opts.minFreeMb ?? defMinFree();
    const wait = opts.wait ?? true;
    const pollMs = opts.pollMs ?? 500;
    const timeoutMs = opts.timeoutMs ?? Infinity;
    const id = `${pid}-${Date.now().toString(36)}-${seq++}`;
    const t0 = Date.now();
    let waiterFile = null;
    let announced = false;
    hookExit();
    try {
      for (;;) {
        const got = withLock(() => {
          const s = scan();
          const why = refusal(s, weightMb, kind, budgetMb, minFreeMb, null);
          if (why) return { why, s };
          let slot = null;
          if (kind === 'browser') { slot = takeSlot(); if (!slot) return { why: 'browser slot race', s }; }
          const record = { id, pid, pidStart: myStart, label, kind, weightMb, started: Date.now(), slot };
          const file = path.join(dir, `h-${id}.json`);
          writeAtomic(file, record);
          mine.set(id, { file, slot, weightMb, record, budgetMb, minFreeMb });
          return { record };
        });
        if (got.record) return lease(got.record);
        if (!wait || Date.now() - t0 > timeoutMs) return null;
        if (!waiterFile) {
          waiterFile = path.join(dir, `w-${id}.json`);
          withLock(() => writeAtomic(waiterFile, { id, pid, pidStart: myStart, label, kind, weightMb, started: Date.now() }));
          mine.set(`w-${id}`, { file: waiterFile });
        }
        if (!announced && Date.now() - t0 >= (opts.announceAfterMs ?? 1000)) {
          announced = true;
          const msg = `[budget] ${label} (${kind}, ${weightMb} MB) waits: ${got.why}. Holders: ${describe(got.s)}`;
          if (opts.onWait) opts.onWait(msg, got.s); else console.error(msg);
        }
        await sleep(pollMs);
      }
    } finally {
      if (waiterFile) { try { rmSync(waiterFile, { force: true }); } catch { /* ignore */ } mine.delete(`w-${id}`); }
    }
  }

  function status() {
    return withLock(() => {
      const s = scan();
      const budgetMb = defBudget();
      const minFreeMb = defMinFree();
      const used = usedMb(s, null);
      const avail = memAvailable();
      const strip = ({ file, ...h }) => ({ ...h, ageS: Math.round((Date.now() - h.started) / 1000) });
      return {
        budgetMb, minFreeMb, memAvailableMb: Math.round(avail), usedMb: used,
        // largest weight admitted right now (ignoring the count caps)
        headroomMb: Math.max(0, Math.floor(Math.min(budgetMb - used, avail - minFreeMb))),
        holders: s.holders.map(strip),
        waiters: s.waiters.map(strip),
        browsers: { slots: browserSlots(), used: s.slots.used.length, legacy: s.slots.legacy },
      };
    });
  }

  return { acquire, status, dir, slotDir };
}

let shared = null;
const ledger = () => (shared ??= createLedger());
export const acquire = (opts) => ledger().acquire(opts);
export const status = () => ledger().status();

function printStatus(s) {
  console.log(`budget ${s.usedMb}/${s.budgetMb} MB used, MemAvailable ${s.memAvailableMb} MB (floor ${s.minFreeMb}), headroom ${s.headroomMb} MB, browsers ${s.browsers.used}/${s.browsers.slots}`);
  for (const h of s.holders) console.log(`  holds  ${String(h.weightMb).padStart(5)} MB  ${h.kind.padEnd(8)} pid ${String(h.pid).padEnd(8)} ${String(h.ageS).padStart(5)} s  ${h.label}`);
  for (const l of s.browsers.legacy) console.log(`  holds  ${String(WEIGHTS.legacySlot).padStart(5)} MB  legacy   pid ${String(l.pid).padEnd(8)}          ${l.slot} (older tool)`);
  for (const w of s.waiters) console.log(`  waits  ${String(w.weightMb).padStart(5)} MB  ${w.kind.padEnd(8)} pid ${String(w.pid).padEnd(8)} ${String(w.ageS).padStart(5)} s  ${w.label}`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const a = process.argv.slice(2);
  if (a.includes('--status') || a.length === 0 || a.includes('--json')) {
    const s = status();
    if (a.includes('--json')) console.log(JSON.stringify(s, null, 2)); else printStatus(s);
  } else {
    console.log('usage: node tools/lib/budget.mjs --status [--json]');
  }
}
