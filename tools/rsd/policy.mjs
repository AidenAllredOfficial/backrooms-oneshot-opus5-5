// tools/rsd/policy.mjs — the capture daemon's pure decisions (unit-tested in tests/tools/policy.test.ts):
// which shots may be served from the capture memo and under which key, which lane may take a job, and which job a
// lane takes next.
import { createHash } from 'node:crypto';
import { NO_MEMO_PRESETS, parseSize } from '../lib/capture.mjs';

/**
 * Canonical form of a shot for the memo key: its final launch params sorted (minus autostart / noprime, which do not
 * change what is rendered) plus everything else that changes the capture or its report.
 * `r`: the request ({ size, wait, evals, qa }).
 */
export function canonicalShot(shot, search, r) {
  const p = [...new URLSearchParams(search)].filter(([k]) => k !== 'autostart' && k !== 'noprime')
    .map(([k, v]) => `${k}=${v}`).sort();
  const { width, height } = parseSize(shot.size ?? r.size);
  return [p, shot.page ?? '', `${width}x${height}`, shot.wait ?? r.wait ?? null, r.evals ?? [], shot.eval ?? [], shot.captures ?? null,
    shot.expect ?? null, shot.diff ?? null, !!r.qa, new URLSearchParams(String(shot.params ?? '')).get('autostart') === '0'];
}

/** Memo off for: requests without memo, fresh:true shots, timing/UI presets, and shots with evals (they may measure time). */
export function memoAllowed(shot, r) {
  if (!r.memo || shot.fresh || NO_MEMO_PRESETS.has(shot.preset)) return false;
  if ((r.evals?.length ?? 0) > 0 || (shot.eval?.length ?? 0) > 0) return false;
  return true;
}

/**
 * Memo key: SHA-1 of (distHash of the build, canonical shot, page hardwareConcurrency, Chromium version + GPU
 * renderer, capture-code hash). A new build, browser, GPU or capture code never hits an old entry.
 */
export function memoKey({ distHash, shot, search, r, browserKey, codeHash }) {
  return createHash('sha1').update(JSON.stringify([distHash, canonicalShot(shot, search, r), r.hc ?? 8, browserKey, codeHash])).digest('hex');
}

export function qualityOf(shot) { return new URLSearchParams(String(shot.params ?? '')).get('quality') ?? 'high'; }

/** Lane 0 takes anything; lane 1 only non-long shots at quality <= high and <= 1920x1080. */
export function laneEligible(laneId, job) {
  if (laneId === 0) return true;
  const { width, height } = parseSize(job.shot.size ?? job.req.size);
  return !job.long && qualityOf(job.shot) !== 'ultra' && width * height <= 1920 * 1080;
}

/**
 * Next job for a lane: round-robin over the clients with queued work (client ids in sorted order, starting after
 * `last`, the client served last); within the chosen client prefer a job matching the lane's warm-page key, else
 * its first queued job. At most one 'long' job runs at a time. Returns { job, last } (job null when nothing fits)
 * without mutating `queue`.
 */
export function pickJob(queue, laneId, { warmKey = null, longRunning = 0, last = null } = {}) {
  const clients = [...new Set(queue.map((j) => j.req.client))].sort();
  const start = last === null ? 0 : Math.max(0, clients.findIndex((c) => c > last));
  for (let k = 0; k < clients.length; k++) {
    const c = clients[(start + k) % clients.length];
    const mine = queue.filter((j) => j.req.client === c && laneEligible(laneId, j) && !(j.long && longRunning > 0));
    if (!mine.length) continue;
    const job = (warmKey && mine.find((j) => j.warmKey === warmKey)) || mine[0];
    return { job, last: c };
  }
  return { job: null, last };
}
