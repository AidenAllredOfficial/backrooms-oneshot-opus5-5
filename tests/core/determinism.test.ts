import { describe, expect, it } from 'vitest';
import { Rng, hash3, hashString } from '../../src/core/rng.ts';

describe('determinism pins', () => {
  it('hash3 is stable', () => expect(hash3(1, 2, 3)).toBe(2138774330));
  it('hashString is stable', () => expect(hashString('backrooms')).toBe(1081633719));
  it('Rng(1).next() is stable', () => expect(new Rng(1).next()).toBe(2828542811));
});
