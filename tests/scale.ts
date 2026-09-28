// tests/scale.ts — sweep sizes per test tier (docs/TESTING.md).
//
// `npm test` (the pre-merge gate) sets BACKROOMS_TEST_FULL=1. An INVARIANT sweep (every seed / chunk must pass; any
// aggregate is a min or max) may then run a small slice in the quick tiers: the first `quick` items of the same
// deterministic sequence, so the slice is a subset of the full sweep and can never fail where the full one passes.
// Statistical thresholds (rates, means, "appears at least once per N chunks") never run scaled down: they carry the
// 'sweep' tag instead and run only in `npm test`.
export const FULL = process.env.BACKROOMS_TEST_FULL === '1';

/** Items of an invariant sweep: `full` under `npm test`, else the first `quick`. */
export const sweepSize = (full: number, quick: number): number => (FULL ? full : Math.min(full, quick));
