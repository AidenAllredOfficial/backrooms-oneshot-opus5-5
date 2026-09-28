// tests/util/check.ts — cheap predicates for guarding expect() inside hot loops (docs/TESTING.md).
//
// expect(x).toBe(y) costs ~2.7 µs and toEqual on a 33-element array ~5.6 µs, against ~0.003 µs for the comparison
// itself; a message template passed to expect() is built on every call even when the check passes. Loops over every
// cell / edge / sample of hundreds of chunks therefore spent half their time in the assertion library. The pattern:
//
//   if (!Object.is(a, b)) expect(a, `msg ${i}`).toBe(b);             // toBe is Object.is: NaN and -0 behave the same
//   if (!(a >= b)) expect(a, `msg ${i}`).toBeGreaterThanOrEqual(b);  // negated, so NaN / non-numbers still fail
//   if (!isDeepStrictEqual(a, b)) expect(a).toEqual(b);             // strict deep equality implies toEqual
//   if (LIST.indexOf(x) === -1) expect(LIST).toContain(x);          // toContain on an array is indexOf (===)
//
// The failing path runs the very same matcher with the very same message, so failure output does not change.
export { isDeepStrictEqual } from 'node:util';

/** Element-wise Object.is over two array-likes of primitives: when true, `expect(a).toEqual(b)` passes for arrays. */
export function sameValues(a: ArrayLike<unknown>, b: ArrayLike<unknown>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
  return true;
}
