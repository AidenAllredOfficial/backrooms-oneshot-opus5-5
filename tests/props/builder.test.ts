// tests/props/builder.test.ts — texture realism v2 lane E: the PartBuilder's tint headroom (non-emissive parts store
// tint / 2, the shader decodes x2) and its face-local edge coordinates in the lmUv stream (edgeEncode / edgeDecode, the
// twin of chunks/family/props.ts brPropEdgeD), the grain axis and the per-part uv offsets.

import { describe, expect, it } from 'vitest';
import { Mat, PROP_KIND_COUNT, VFlag, type PropKindId } from '../../src/core/ids.ts';
import { GeometryWriter } from '../../src/core/writer.ts';
import { edgeDecode, edgeEncode, PartBuilder, tintByte, tintDecode } from '../../src/props/builder.ts';
import { emitPropInto, PROP_VARIANTS } from '../../src/props/index.ts';
import { bevelBox, box, cylinder, extrude, rect, sweep } from '../../src/props/primitives.ts';

function build(fn: (b: PartBuilder) => void, scale = 1) {
  const w = new GeometryWriter(64);
  const b = new PartBuilder();
  b.begin(w, false, 1, 40, 99, scale);
  fn(b);
  return w.finish();
}

describe('tint headroom', () => {
  it('round-trips every tint in [0, 2] within 1/127 (bytes >= 1)', () => {
    for (let t = 0; t <= 2.0001; t += 0.001) {
      const b = tintByte(t);
      expect(b).toBeGreaterThanOrEqual(1);
      expect(Math.abs(tintDecode(b) - t)).toBeLessThanOrEqual(1 / 127);
    }
  });

  it('every non-emissive prop part stays within the headroom (no colour clamps at 2x its layer mean)', () => {
    const clamped = new Set<string>();
    for (let kind = 0; kind < PROP_KIND_COUNT; kind++) {
      for (let v = 0; v < PROP_VARIANTS; v++) {
        const w = new GeometryWriter(512);
        emitPropInto(w, { kind: kind as PropKindId, variant: v, x: 0, y: 0, z: 0, yaw: 0, scale: 1, flags: 0, seed: 17 }, 0, 0, 1, 40);
        const m = w.finish();
        for (let i = 0; i < m.vertexCount; i++) {
          if (m.emit[i] > 0) continue;
          for (let c = 0; c < 3; c++) if (m.tint[i * 4 + c] === 255) clamped.add(`kind ${kind} v${v} layer ${m.layer[i]}`);
        }
      }
    }
    expect([...clamped]).toEqual([]);
  });

  it('emissive parts keep the x1 emitter colour', () => {
    const m = build((b) => { b.emissive(Mat.PLASTIC, 1, 0.5, 0.25, 100, 0, 0, 0); rect(b, 0, 0, 0, 0.1, 0, 0, 0, 0.1, 0, 0, 0, 1); });
    expect([m.tint[0], m.tint[1], m.tint[2]]).toEqual([255, 128, 64]);
    expect(m.flags[0] & VFlag.PROP_AUX).toBe(VFlag.PROP_AUX);
  });
});

describe('edge coordinates', () => {
  it('encode / decode: the half extent exactly (mm), s within 0.5 mm at 1 m in float32', () => {
    for (const half of [0.0004, 0.004, 0.05, 0.4, 1.0, 2.4]) {
      for (let s = -1; s <= 1.0001; s += 0.125) {
        const x = Math.fround(edgeEncode(half * 1000, s));
        const d = edgeDecode(x);
        expect(d.halfMm).toBe(Math.max(1, Math.round(half * 1000)));
        expect(Math.abs(d.s - s) * d.halfMm).toBeLessThanOrEqual(0.5);
        expect(Math.abs(edgeDecode(-x).halfMm)).toBe(d.halfMm); // the sign is a flag
      }
    }
  });

  it('box faces: distance to the nearer edge across each face axis, end grain on the long axis only', () => {
    const m = build((b) => { b.mat(Mat.WOOD); box(b, 0, 0, 0, 2, 0.1, 0.3); });
    let ends = 0;
    for (let i = 0; i < m.vertexCount; i++) {
      const a = edgeDecode(m.lmUv[i * 2]), c = edgeDecode(m.lmUv[i * 2 + 1]);
      expect(a.dMm).toBeCloseTo(0, 3); // corners
      expect(c.dMm).toBeCloseTo(0, 3);
      const nx = m.normal[i * 4];
      if (m.lmUv[i * 2] < 0) { ends++; expect(Math.abs(nx)).toBe(127); }
      // grain mode: u along the face's longer side (the 2 m axis on every side face)
      if (Math.abs(nx) !== 127) expect(Math.max(a.halfMm, c.halfMm)).toBe(a.halfMm);
    }
    expect(ends).toBe(8);
  });

  it('bevelBox: face rims lie one chamfer from the edge, chamfers and corners on it; prop scale is honoured', () => {
    const m = build((b) => { b.mat(Mat.METAL_PAINTED); bevelBox(b, 0, 0, 0, 0.4, 0.9, 0.02, 0.004); }, 2);
    let minFace = 1e9;
    for (let i = 0; i < m.vertexCount; i++) {
      const d = Math.min(edgeDecode(m.lmUv[i * 2]).dMm, edgeDecode(m.lmUv[i * 2 + 1]).dMm);
      expect(d).toBeLessThanOrEqual(2 * 4 + 1e-3); // at most one (scaled) chamfer in from an edge
      const n = [m.normal[i * 4], m.normal[i * 4 + 1], m.normal[i * 4 + 2]];
      if (n.some((c) => Math.abs(c) === 127)) minFace = Math.min(minFace, d);
    }
    expect(minFace).toBeCloseTo(8, 0); // every face rim: one 4 mm chamfer (x2 scale) from the box edge
    expect(Math.max(...Array.from(m.lmUv).map((x) => edgeDecode(x).halfMm))).toBe(900); // 2 x 0.45 m
  });

  it('curved sides: none around, the distance to the ends along; rect / extrude sides are exact', () => {
    const t = build((b) => { b.mat(Mat.METAL_PAINTED); sweep(b, [0, 0, 0, 1, 0, 0], 0.02, 6); cylinder(b, 0.02, 0.02, 0, 0.5, 6); });
    for (let i = 0; i < t.vertexCount; i++) {
      const [x, y] = [t.lmUv[i * 2], t.lmUv[i * 2 + 1]];
      expect(x === 0 || y === 0).toBe(true);
      expect(edgeDecode(x + y).dMm).toBeCloseTo(0, 3); // every ring vertex here is at an end
    }
    const r = build((b) => { b.mat(Mat.FABRIC_PARTITION); rect(b, 0, 0, 0, 0.3, 0, 0, 0, 0.1, 0, 0, 0, 1); });
    expect([0, 1, 2, 3].map((i) => edgeDecode(r.lmUv[i * 2]).halfMm)).toEqual([300, 300, 300, 300]);
    const e = build((b) => { b.mat(Mat.FABRIC_PARTITION); extrude(b, [0, 0, 0.1, 0, 0.1, 0.05, 0, 0.05], 0, 1, 0); });
    for (let i = 0; i < e.vertexCount; i++) expect(edgeDecode(e.lmUv[i * 2 + 1]).halfMm).toBe(500);
  });
});

describe('per-part uv offsets', () => {
  it('prop layers get a hashed offset per part; other layers and atlas / profile uvs none', () => {
    const uv0 = (layer: number, parts: number): number[] => {
      const m = build((b) => { for (let k = 0; k < parts; k++) { b.mat(layer); rect(b, 0, 0, 0, 0.1, 0, 0, 0, 0.1, 0, 0, 0, 1); } });
      return Array.from({ length: parts }, (_, k) => m.uv[k * 8]);
    };
    const w = uv0(Mat.WOOD, 3);
    expect(new Set(w).size).toBe(3);
    expect(uv0(Mat.FABRIC_PARTITION, 3)).toEqual([0, 0, 0]);
  });
});
