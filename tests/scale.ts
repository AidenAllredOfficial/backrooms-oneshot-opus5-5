// tests/scale.ts — sweep sizes per test tier (docs/TESTING.md).
//
// Every run that does not skip the 'sweep' tag gets BACKROOMS_TEST_FULL=1 (vitest.config.ts; `npm test` sets it too),
// so `npm test` and a plain `npx vitest run` are the same gate. An INVARIANT sweep (every seed / chunk must pass; any
// aggregate is a min or max) may run a small slice in the quick tiers (`--tags-filter='!sweep'`): the first `quick`
// items of the same deterministic sequence, so the slice is a subset of the full sweep and can never fail where the
// full one passes.
// Statistical thresholds (rates, means, "appears at least once per N chunks") never run scaled down: they carry the
// 'sweep' tag instead and run only in `npm test`.
export const FULL = process.env.BACKROOMS_TEST_FULL === '1';

/** Items of an invariant sweep: `full`, or the first `quick` in a quick-tier run. */
export const sweepSize = (full: number, quick: number): number => (FULL ? full : Math.min(full, quick));
