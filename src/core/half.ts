// src/core/half.ts — float32 <-> float16 (IEEE binary16) conversion for RGBA16F payloads built in workers.
// Table-based (same algorithm as three's DataUtils), no allocation per call.

const buf = new ArrayBuffer(4);
const f32 = new Float32Array(buf);
const u32 = new Uint32Array(buf);
const baseTable = new Uint32Array(512);
const shiftTable = new Uint32Array(512);
for (let i = 0; i < 256; ++i) {
  const e = i - 127;
  if (e < -27) {
    baseTable[i] = 0x0000; baseTable[i | 0x100] = 0x8000;
    shiftTable[i] = 24; shiftTable[i | 0x100] = 24;
  } else if (e < -14) {
    baseTable[i] = 0x0400 >> (-e - 14); baseTable[i | 0x100] = (0x0400 >> (-e - 14)) | 0x8000;
    shiftTable[i] = -e - 1; shiftTable[i | 0x100] = -e - 1;
  } else if (e <= 15) {
    baseTable[i] = (e + 15) << 10; baseTable[i | 0x100] = ((e + 15) << 10) | 0x8000;
    shiftTable[i] = 13; shiftTable[i | 0x100] = 13;
  } else if (e < 128) {
    baseTable[i] = 0x7c00; baseTable[i | 0x100] = 0xfc00;
    shiftTable[i] = 24; shiftTable[i | 0x100] = 24;
  } else {
    baseTable[i] = 0x7c00; baseTable[i | 0x100] = 0xfc00;
    shiftTable[i] = 13; shiftTable[i | 0x100] = 13;
  }
}

/** float -> half bits (values above 65504 become +Inf; callers clamp to HALF_MAX first). */
export function toHalf(v: number): number {
  f32[0] = v;
  const f = u32[0];
  const e = (f >> 23) & 0x1ff;
  return baseTable[e] + ((f & 0x007fffff) >> shiftTable[e]);
}

export function fromHalf(h: number): number {
  const s = (h & 0x8000) >> 15;
  const e = (h & 0x7c00) >> 10;
  const m = h & 0x03ff;
  if (e === 0) return (s ? -1 : 1) * 5.960464477539063e-8 * m;
  if (e === 0x1f) return m ? NaN : (s ? -Infinity : Infinity);
  return (s ? -1 : 1) * 2 ** (e - 15) * (1 + m / 1024);
}

export const HALF_MAX = 65504;
