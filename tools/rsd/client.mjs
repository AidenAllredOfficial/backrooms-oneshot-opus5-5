#!/usr/bin/env node
// tools/rsd/client.mjs — client of the capture daemon (tools/rsd/server.mjs).
//
//   node tools/rsd/client.mjs status        daemon state: browser, lanes, queue, memory, builds, memo
//   node tools/rsd/client.mjs stop          finish nothing, close the browser, exit
//   node tools/rsd/client.mjs start         start the daemon (tools start it on demand anyway)
//   node tools/rsd/client.mjs log [n]       last n lines of its log (/tmp/backrooms-render/daemon.log)
//
// Library: ensureDaemon() finds the machine's daemon through /tmp/backrooms-render/daemon.json, or starts one
// (detached, setsid) from this tree. A running daemon of another code version is asked to retire (it finishes its
// queued jobs, then exits) and a new one is started. render(request) posts a job and streams its results.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PAGE_HC, EVAL_TIMEOUT_MS } from '../lib/capture.mjs';

export const RUN_DIR = process.env.BACKROOMS_RSD_DIR ?? '/tmp/backrooms-render';
export const DAEMON_JSON = path.join(RUN_DIR, 'daemon.json');
export const LOG_FILE = path.join(RUN_DIR, 'daemon.log');
const TOOLS = path.resolve(import.meta.dirname, '..');
export const SERVER = path.join(TOOLS, 'rsd', 'server.mjs');

/** Version of the daemon code in this tree: SHA-1 of tools/rsd/*.mjs and tools/lib/*.mjs. */
export function daemonVersion(tools = TOOLS) {
  const h = createHash('sha1');
  for (const d of ['rsd', 'lib']) {
    for (const n of readdirSync(path.join(tools, d)).filter((x) => x.endsWith('.mjs')).sort()) {
      h.update(`${d}/${n}\0`).update(readFileSync(path.join(tools, d, n))).update('\0');
    }
  }
  return h.digest('hex').slice(0, 16);
}

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

export function readDaemonInfo() {
  try { return JSON.parse(readFileSync(DAEMON_JSON, 'utf8')); } catch { return null; }
}

async function getJson(url, ms = 3000) {
  const r = await fetch(url, { signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The running daemon of this code version ({ pid, port, url, version }), starting it when needed. */
export async function ensureDaemon({ log = (m) => console.error(`[rsd] ${m}`), version = daemonVersion() } = {}) {
  mkdirSync(RUN_DIR, { recursive: true });
  let spawned = false;
  let announcedRetire = false;
  const t0 = Date.now();
  for (;;) {
    const info = readDaemonInfo();
    if (info && pidAlive(info.pid)) {
      const url = `http://127.0.0.1:${info.port}`;
      if (info.version === version) {
        try { await getJson(`${url}/status?quick=1`, 5000); return { ...info, url }; } catch { /* starting up or wedged */ }
      } else {
        if (!announcedRetire) {
          log(`the running capture daemon (pid ${info.pid}) runs other tool code (${info.version} vs ${version}); asking it to retire after its current jobs`);
          announcedRetire = true;
        }
        try { await fetch(`${url}/retire`, { method: 'POST', signal: AbortSignal.timeout(3000) }); } catch { /* exiting */ }
        await sleep(250);
        continue;
      }
    } else if (!spawned || Date.now() - t0 > 15000) {
      spawned = true;
      const fd = openSync(LOG_FILE, 'a');
      const child = spawn(process.execPath, [SERVER], { detached: true, stdio: ['ignore', fd, fd], cwd: os.tmpdir(), env: { ...process.env } });
      child.unref();
      closeSync(fd);
    }
    if (Date.now() - t0 > 60000 && !announcedRetire) throw new Error(`the capture daemon did not start; see ${LOG_FILE}`);
    await sleep(100);
  }
}

/** Tile-cache settings of this process (the daemon serves each setting on its own origin). */
export function tileCacheEnv() {
  return {
    enabled: process.env.BACKROOMS_TILE_CACHE !== '0',
    dir: path.resolve(process.env.BACKROOMS_TILE_CACHE_DIR ?? path.join(os.homedir(), '.cache', 'backrooms-tilecache')),
    mb: Number(process.env.BACKROOMS_TILE_CACHE_MB ?? 8192),
  };
}

/** Browser settings that need a browser of their own (the daemon refuses a request whose settings differ). */
export function browserEnv() {
  return { CHROMIUM: process.env.CHROMIUM ?? '', BACKROOMS_GPU: process.env.BACKROOMS_GPU ?? '', BACKROOMS_UNCAPPED: process.env.BACKROOMS_UNCAPPED ?? '' };
}

/**
 * Renders shots through the daemon. req: { tool, tree | trees[], out | outs[], shots, size, wait, evals, draft,
 * streamCapture, memo, fresh, qa, class, onResult(index, { entry, qa, side }), onLog(msg) }.
 * Resolves { builds, done } after the last result; throws if the daemon refuses the job or the connection drops.
 */
export async function render(req) {
  const { onResult, onLog = (m) => console.error(m), ...rest } = req;
  for (let attempt = 0; ; attempt++) {
    const d = await ensureDaemon();
    const body = {
      client: `${req.tool ?? 'client'}:${process.pid}`, hc: PAGE_HC, evalTimeoutMs: EVAL_TIMEOUT_MS, tileCache: tileCacheEnv(), browserEnv: browserEnv(),
      cwd: process.cwd(), ...rest,
    };
    const res = await fetch(`${d.url}/render`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
    if (res.status === 409) {
      let why = {};
      try { why = await res.json(); } catch { /* not JSON */ }
      if (why.error === 'browser-env') {
        throw new Error(`capture daemon: its browser runs with other settings (CHROMIUM / BACKROOMS_GPU / BACKROOMS_UNCAPPED: ${why.mine}); ` +
          'use --direct, or stop it (node tools/rsd/client.mjs stop) once it is idle');
      }
      // retiring (a client with other tool code asked it to): it finishes its queued jobs, then exits and the next
      // ensureDaemon() starts one of this code. Wait for that instead of failing.
      if (attempt === 0) onLog(`[rsd] the capture daemon (pid ${d.pid}) is retiring; waiting for its queued jobs to finish`);
      for (let i = 0; i < 36000 && pidAlive(d.pid); i++) await sleep(100);
      if (pidAlive(d.pid)) throw new Error(`capture daemon: pid ${d.pid} is still retiring after an hour (see ${LOG_FILE}; --direct captures without it)`);
      continue;
    }
    if (!res.ok) throw new Error(`capture daemon: HTTP ${res.status} ${await res.text()}`);
    const builds = [];
    let done = null;
    let buf = '';
    const dec = new TextDecoder();
    const handle = (line) => {
      if (!line.trim()) return;
      const m = JSON.parse(line);
      if (m.type === 'build') builds[m.side ?? 0] = m;
      else if (m.type === 'shot') onResult?.(m.index, m);
      else if (m.type === 'log') onLog(m.msg);
      else if (m.type === 'error') throw Object.assign(new Error(`capture daemon: ${m.message}`), { daemon: m });
      else if (m.type === 'done') done = m;
    };
    for await (const chunk of res.body) {
      buf += dec.decode(chunk, { stream: true });
      let k;
      while ((k = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, k); buf = buf.slice(k + 1); handle(line); }
    }
    handle(buf);
    if (!done) throw new Error(`capture daemon: the connection closed before the job finished (see ${LOG_FILE}; --direct captures without the daemon)`);
    return { builds, build: builds[0], done };
  }
}

export async function status() {
  const info = readDaemonInfo();
  if (!info || !pidAlive(info.pid)) return null;
  return getJson(`http://127.0.0.1:${info.port}/status`, 5000);
}

export async function stop() {
  const info = readDaemonInfo();
  if (!info || !pidAlive(info.pid)) return false;
  try { await fetch(`http://127.0.0.1:${info.port}/stop`, { method: 'POST', signal: AbortSignal.timeout(5000) }); } catch { /* exiting */ }
  for (let i = 0; i < 100 && pidAlive(info.pid); i++) await sleep(100);
  return !pidAlive(info.pid);
}

function fmtStatus(s) {
  if (!s) return 'capture daemon: not running';
  const mb = (x) => (x == null ? '-' : `${Math.round(x)} MB`);
  const lines = [
    `capture daemon pid ${s.pid} port ${s.port} version ${s.version}${s.retiring ? ' (retiring)' : ''}, up ${Math.round(s.uptimeS)} s, idle ${Math.round(s.idleS)} s`,
    `browser: ${s.browser.open ? `open (${s.browser.shots} shots, ${s.browser.version ?? ''})` : 'closed'}; lanes: ${s.lanes.map((l) => `${l.id}:${l.busy ? 'busy' : l.warmPage ? 'warm page' : 'idle'}`).join(' ') || 'none'}`,
    `queue: ${s.queue.total} job(s)${Object.keys(s.queue.byClient).length ? ' ' + JSON.stringify(s.queue.byClient) : ''}; requests in flight: ${s.requests}`,
    `memory: tree ${mb(s.mem.rssMb)} RSS / ${mb(s.mem.pssMb)} PSS (peak ${mb(s.mem.peak.rssMb)} / ${mb(s.mem.peak.pssMb)}), MemAvailable ${mb(s.mem.availMb)}, governor ${s.mem.state}`,
    `builds: ${s.builds} on disk; memo: ${s.memo.entries} entries, ${mb(s.memo.bytes / 1048576)} (hits ${s.memo.hits}, misses ${s.memo.misses})`,
    `budget: ${s.budget.usedMb}/${s.budget.budgetMb} MB used, ${s.budget.holders.map((h) => `${h.label} ${h.weightMb}`).join('; ')}`,
  ];
  return lines.join('\n');
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const [cmd = 'status', arg] = process.argv.slice(2);
  (async () => {
    if (cmd === 'status') { const s = await status(); console.log(process.argv.includes('--json') ? JSON.stringify(s, null, 2) : fmtStatus(s)); }
    else if (cmd === 'stop') console.log((await stop()) ? 'stopped' : 'not running');
    else if (cmd === 'start') { const d = await ensureDaemon(); console.log(`capture daemon pid ${d.pid} on ${d.url}`); }
    else if (cmd === 'log') { if (existsSync(LOG_FILE)) console.log(readFileSync(LOG_FILE, 'utf8').trim().split('\n').slice(-Number(arg ?? 40)).join('\n')); }
    else { console.log('usage: node tools/rsd/client.mjs status [--json] | stop | start | log [n]'); process.exitCode = 2; }
  })().catch((e) => { console.error(e.message); process.exitCode = 1; });
}
