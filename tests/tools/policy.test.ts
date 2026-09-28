// tools/rsd/policy.mjs: the capture daemon's memo keys, lane eligibility and round-robin job selection.
import { describe, expect, it } from 'vitest';
import path from 'node:path';

const mod = path.resolve(import.meta.dirname, '../../tools/rsd/policy.mjs');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { memoKey, memoAllowed, laneEligible, pickJob } = (await import(mod)) as any;

const R = { size: '1600x900', wait: null, evals: [], qa: false, memo: true, hc: 8 };
const key = (o: Record<string, unknown> = {}) => memoKey({
  distHash: 'd1', shot: { params: 'seed=7&zone=LOBBY' }, search: 'seed=7&zone=LOBBY&noprime=1&autostart=1', r: R, browserKey: 'chr\0gpu', codeHash: 'c1', ...o,
});

describe('capture memo', () => {
  it('keys by build, shot, browser and capture code', () => {
    const k = key();
    expect(key()).toBe(k);
    expect(key({ distHash: 'd2' })).not.toBe(k); // a new build never hits an old capture
    expect(key({ codeHash: 'c2' })).not.toBe(k); // nor new capture code
    expect(key({ browserKey: 'chr2\0gpu' })).not.toBe(k);
    expect(key({ search: 'seed=7&zone=OFFICE&noprime=1&autostart=1' })).not.toBe(k);
    expect(key({ r: { ...R, size: '1920x1080' } })).not.toBe(k);
    expect(key({ r: { ...R, qa: true } })).not.toBe(k);
    expect(key({ r: { ...R, wait: 500 } })).not.toBe(k);
    expect(key({ r: { ...R, hc: 6 } })).not.toBe(k);
    expect(key({ search: 'seed=7&zone=LOBBY&bake=preview&noprime=1&autostart=1' })).not.toBe(k); // drafts
  });

  it('ignores param order, autostart and noprime', () => {
    expect(key({ search: 'zone=LOBBY&seed=7&autostart=1' })).toBe(key());
  });

  it('is off for fresh shots, timing presets, evals and memo:false', () => {
    expect(memoAllowed({ params: 'seed=1' }, R)).toBe(true);
    expect(memoAllowed({ params: 'seed=1', fresh: true }, R)).toBe(false);
    for (const preset of ['perf', 'soak', 'stress', 'edge', 'ui']) expect(memoAllowed({ params: 'seed=1', preset }, R)).toBe(false);
    expect(memoAllowed({ params: 'seed=1', preset: 'zones' }, R)).toBe(true);
    expect(memoAllowed({ params: 'seed=1', eval: ['1'] }, R)).toBe(false);
    expect(memoAllowed({ params: 'seed=1' }, { ...R, evals: ['__backrooms.perf(1)'] })).toBe(false);
    expect(memoAllowed({ params: 'seed=1' }, { ...R, memo: false })).toBe(false);
  });
});

describe('lanes and job selection', () => {
  const job = (client: string, params: string, extra: Record<string, unknown> = {}) => ({ req: { client, size: '1600x900' }, shot: { params }, long: false, warmKey: null, ...extra });

  it('keeps lane 1 to warm-weight shots', () => {
    expect(laneEligible(0, job('a', 'quality=ultra'))).toBe(true);
    expect(laneEligible(1, job('a', 'quality=high'))).toBe(true);
    expect(laneEligible(1, job('a', 'quality=ultra'))).toBe(false);
    expect(laneEligible(1, { ...job('a', 'quality=high'), shot: { params: 'x=1', size: '2560x1440' } })).toBe(false);
    expect(laneEligible(1, job('a', 'quality=high', { long: true }))).toBe(false);
  });

  it('round-robins across clients and prefers the warm page key', () => {
    const queue = [job('a', 's=1'), job('a', 's=2', { warmKey: 'K' }), job('b', 's=3'), job('c', 's=4')];
    let last: string | null = null;
    const order: string[] = [];
    while (queue.length) {
      const r: { job: (typeof queue)[number]; last: string | null } = pickJob(queue, 0, { last, warmKey: 'K' });
      last = r.last;
      order.push(r.job.shot.params);
      queue.splice(queue.indexOf(r.job), 1);
    }
    expect(order).toEqual(['s=2', 's=3', 's=4', 's=1']);
  });

  it('runs at most one long job at a time', () => {
    const q = [job('a', 's=1', { long: true }), job('b', 's=2')];
    expect(pickJob(q, 0, { longRunning: 1 }).job.shot.params).toBe('s=2');
    expect(pickJob([q[0]], 0, { longRunning: 1 }).job).toBeNull();
    expect(pickJob([q[0]], 0, { longRunning: 0 }).job.shot.params).toBe('s=1');
  });
});
