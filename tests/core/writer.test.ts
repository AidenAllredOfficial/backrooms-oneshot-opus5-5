import { describe, expect, it } from 'vitest';
import { GeometryWriter } from '../../src/core/writer.ts';

describe('GeometryWriter capacity', () => {
  it('grows from an empty initial capacity without losing vertex or index data', () => {
    const w = new GeometryWriter(0);
    const a = w.vertex(1, 2, 3, 0, 1, 0, 0, 0);
    const b = w.vertex(4, 5, 6, 0, 1, 0, 1, 0);
    const c = w.vertex(7, 8, 9, 0, 1, 0, 0, 1);
    w.tri(a, b, c);
    const m = w.finish();
    expect(m.vertexCount).toBe(3);
    expect(m.indexCount).toBe(3);
    expect(Array.from(m.position)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(Array.from(m.index)).toEqual([0, 1, 2]);
    expect(m.bounds).toEqual([1, 2, 3, 7, 8, 9]);
  });

  it('rejects capacities that cannot match an integer vertex count', () => {
    for (const capacity of [-1, 0.5, NaN, Infinity]) expect(() => new GeometryWriter(capacity)).toThrow(RangeError);
  });
});
