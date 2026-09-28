// tools/lib/procmem.mjs — process-tree memory sampler and the capture tools' runtime memory governor.
//
// The governor watches the tool's OWN process tree (Node + the Chromium it launched + a dev server it started) and
// the machine's MemAvailable, and tells the tool to shed load before the desktop runs out of memory:
//   MemAvailable < shedMb (3500):  'shed'   - close idle pages and extra lanes, start no new page until it recovers;
//   MemAvailable < closeMb (2500): 'closed' - close own pages and browser now, fail running jobs ('memory guard'),
//                                             start nothing until MemAvailable >= recoverMb (4500);
//   tree PSS > recyclePssMb (3200): recycle the page / browser between jobs.
// It only ever acts on processes the tool started (through the callbacks); it never kills anything else.
import { readFileSync, readdirSync } from 'node:fs';

const PAGE_KB = 4; // statm is in pages

export function memAvailableMb() {
  try {
    const m = /MemAvailable:\s+(\d+) kB/.exec(readFileSync('/proc/meminfo', 'utf8'));
    return m ? Number(m[1]) / 1024 : Infinity;
  } catch { return Infinity; }
}

/** Direct children of a pid (via /proc/<pid>/task/<tid>/children; falls back to a /proc scan). */
export function childrenOf(pid) {
  const out = [];
  let tasks = null;
  try { tasks = readdirSync(`/proc/${pid}/task`); } catch { return out; }
  let ok = false;
  for (const t of tasks) {
    try {
      const s = readFileSync(`/proc/${pid}/task/${t}/children`, 'utf8').trim();
      ok = true;
      if (s) for (const c of s.split(/\s+/)) out.push(Number(c));
    } catch { /* thread gone, or no CONFIG_PROC_CHILDREN */ }
  }
  if (ok) return out;
  for (const d of readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const st = readFileSync(`/proc/${d}/stat`, 'utf8');
      if (Number(st.slice(st.lastIndexOf(')') + 2).split(' ')[1]) === pid) out.push(Number(d));
    } catch { /* gone */ }
  }
  return out;
}

/** pid and all its descendants. */
export function descendants(root, includeRoot = true) {
  const out = [];
  const stack = [root];
  const seen = new Set();
  while (stack.length) {
    const p = stack.pop();
    if (seen.has(p)) continue;
    seen.add(p);
    if (p !== root || includeRoot) out.push(p);
    for (const c of childrenOf(p)) stack.push(c);
  }
  return out;
}

export function rssMb(pid) {
  try { return (Number(readFileSync(`/proc/${pid}/statm`, 'utf8').split(' ')[1]) * PAGE_KB) / 1024; } catch { return 0; }
}

export function pssMb(pid) {
  try {
    const m = /\nPss:\s+(\d+) kB/.exec(readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8'));
    return m ? Number(m[1]) / 1024 : 0;
  } catch { return 0; }
}

/** 'gpu' | 'renderer' | 'utility' | 'zygote' | 'browser' | 'vite' | 'node' | 'other' */
export function classify(pid) {
  let c = '';
  try { c = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' '); } catch { return 'other'; }
  if (c.includes('--type=gpu-process')) return 'gpu';
  if (c.includes('--type=renderer')) return 'renderer';
  if (c.includes('--type=utility')) return 'utility';
  if (c.includes('--type=zygote')) return 'zygote';
  if (/chrom/i.test(c)) return 'browser';
  if (c.includes('vite')) return 'vite';
  if (/\bnode\b|\/node /.test(c) || c.startsWith(process.execPath)) return 'node';
  return 'other';
}

/** Memory of a process tree: { rssMb, pssMb?, procs, byClass: { gpu: { rss, pss? }, ... } }. */
export function treeMem(root, { pss = false } = {}) {
  const pids = descendants(root);
  let rss = 0;
  let ps = 0;
  const byClass = {};
  for (const p of pids) {
    const r = rssMb(p);
    const s = pss ? pssMb(p) : 0;
    rss += r;
    ps += s;
    const k = classify(p);
    const e = (byClass[k] ??= { rss: 0, pss: 0 });
    e.rss += r;
    e.pss += s;
  }
  for (const e of Object.values(byClass)) { e.rss = Math.round(e.rss); e.pss = Math.round(e.pss); }
  return { rssMb: Math.round(rss), pssMb: pss ? Math.round(ps) : null, procs: pids.length, byClass };
}

/** Pids in a tree whose class matches (e.g. the Chromium browser process a tool launched). */
export function findInTree(root, cls) {
  return descendants(root, false).filter((p) => classify(p) === cls);
}

/**
 * Samples the tree RSS every rssMs and PSS every pssMs, tracks peaks and drives the governor state machine.
 * Callbacks fire on state transitions only: onShed(avail), onClose(avail), onRecover(avail), onRecycle(pssMb).
 */
export function createGovernor(o = {}) {
  const root = o.rootPid ?? process.pid;
  const memAvailable = o.memAvailable ?? memAvailableMb;
  const shedMb = o.shedMb ?? Number(process.env.BACKROOMS_SHED_MB ?? 3500);
  const closeMb = o.closeMb ?? Number(process.env.BACKROOMS_CLOSE_MB ?? 2500);
  const recoverMb = o.recoverMb ?? Number(process.env.BACKROOMS_MIN_FREE_MB ?? 4500);
  const recyclePssMb = o.recyclePssMb ?? Number(process.env.BACKROOMS_RECYCLE_PSS_MB ?? 3200);
  let state = 'ok';
  let recycleWanted = false;
  const peak = { rssMb: 0, pssMb: 0, minAvailMb: Infinity };
  let last = { t: 0, rssMb: 0, pssMb: 0, availMb: Infinity };
  let lastPssAt = 0;

  function step(now = Date.now()) {
    const avail = memAvailable();
    const withPss = now - lastPssAt >= (o.pssMs ?? 5000);
    const m = treeMem(root, { pss: withPss });
    if (withPss) lastPssAt = now;
    last = { t: now, rssMb: m.rssMb, pssMb: withPss ? m.pssMb : last.pssMb, availMb: Math.round(avail), procs: m.procs, byClass: m.byClass };
    peak.rssMb = Math.max(peak.rssMb, m.rssMb);
    if (withPss) peak.pssMb = Math.max(peak.pssMb, m.pssMb);
    peak.minAvailMb = Math.min(peak.minAvailMb, Math.round(avail));
    // state machine (hysteresis: back to ok only at recoverMb)
    const prev = state;
    if (avail < closeMb) state = 'closed';
    else if (state === 'closed') { if (avail >= recoverMb) state = 'ok'; }
    else if (avail < shedMb) state = 'shed';
    else if (state === 'shed' && avail >= Math.min(recoverMb, shedMb + 500)) state = 'ok';
    if (state !== prev) {
      if (state === 'closed') o.onClose?.(avail);
      else if (state === 'shed') o.onShed?.(avail);
      else o.onRecover?.(avail);
    }
    if (withPss && m.pssMb > recyclePssMb && !recycleWanted) { recycleWanted = true; o.onRecycle?.(m.pssMb); }
    return last;
  }

  const timer = o.manual ? null : setInterval(() => { try { step(); } catch { /* /proc race */ } }, o.rssMs ?? 500);
  timer?.unref?.();
  return {
    step,
    get state() { return state; },
    get last() { return last; },
    peak,
    /** true once tree PSS went over the cap; cleared by takeRecycle() when the caller recycled */
    get recycleWanted() { return recycleWanted; },
    takeRecycle() { const r = recycleWanted; recycleWanted = false; return r; },
    /** Resolves when a new page may start (state 'ok'); rejects with 'memory guard' after timeoutMs. */
    async whenOk(timeoutMs = 600000) {
      const t0 = Date.now();
      while (state !== 'ok') {
        if (Date.now() - t0 > timeoutMs) throw new Error(`memory guard: MemAvailable ${last.availMb} MB stayed below ${state === 'closed' ? recoverMb : shedMb} MB`);
        await new Promise((r) => setTimeout(r, 250));
        if (o.manual) step();
      }
    },
    stop() { if (timer) clearInterval(timer); },
  };
}
