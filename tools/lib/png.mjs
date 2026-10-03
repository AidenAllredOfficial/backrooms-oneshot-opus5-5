// tools/lib/png.mjs — dependency-free PNG decode/encode and image comparison for the capture tools.
import { deflateSync, inflateSync } from 'node:zlib';

/** Decodes an 8-bit, non-interlaced greyscale / grey+alpha / RGB / RGBA PNG to { w, h, rgba }. */
export function decodePNG(buf) {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) if (buf[i] !== sig[i]) throw new Error('not a PNG');
  let off = 8, w = 0, h = 0, depth = 0, ctype = 0, interlace = 0, headerSeen = false, ended = false;
  const idat = [];
  while (off < buf.length) {
    if (buf.length - off < 12) throw new Error('truncated PNG chunk');
    const len = buf.readUInt32BE(off);
    if (len > buf.length - off - 12) throw new Error('truncated PNG chunk');
    const type = buf.toString('latin1', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      if (off !== 8 || headerSeen || len !== 13) throw new Error('invalid PNG header');
      headerSeen = true;
      w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; ctype = data[9]; interlace = data[12];
      if (w === 0 || h === 0 || data[10] !== 0 || data[11] !== 0) throw new Error('invalid PNG header');
    } else if (!headerSeen) throw new Error('missing PNG header');
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') { if (len !== 0) throw new Error('invalid PNG end'); ended = true; break; }
    off += 12 + len;
  }
  if (!headerSeen || !ended || idat.length === 0) throw new Error('incomplete PNG');
  if (depth !== 8 || interlace !== 0) throw new Error(`unsupported PNG (depth ${depth}, interlace ${interlace})`);
  const ch = ctype === 6 ? 4 : ctype === 2 ? 3 : ctype === 4 ? 2 : ctype === 0 ? 1 : 0;
  if (!ch) throw new Error(`unsupported PNG colour type ${ctype}`);
  const stride = w * ch;
  const expected = (stride + 1) * h;
  if (!Number.isSafeInteger(expected)) throw new Error('invalid PNG dimensions');
  const raw = inflateSync(Buffer.concat(idat), { maxOutputLength: expected });
  if (raw.length !== expected) throw new Error('truncated PNG pixels');
  const px = new Uint8Array(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    if (f > 4) throw new Error(`unsupported PNG filter ${f}`);
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? px[dst + x - ch] : 0;
      const b = y > 0 ? px[dst - stride + x] : 0;
      const c = x >= ch && y > 0 ? px[dst - stride + x - ch] : 0;
      let v = raw[src + x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c; const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      px[dst + x] = v & 255;
    }
  }
  if (ch === 4) return { w, h, rgba: px };
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const s = i * ch;
    if (ch >= 3) { rgba[i * 4] = px[s]; rgba[i * 4 + 1] = px[s + 1]; rgba[i * 4 + 2] = px[s + 2]; }
    else { rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = px[s]; }
    rgba[i * 4 + 3] = ch === 4 ? px[s + 3] : ch === 2 ? px[s + 1] : 255;
  }
  return { w, h, rgba };
}

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  return t;
})();
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return ~c >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, c]);
}

/** Encodes RGB (3 channels) or RGBA (4) pixels as a PNG (filter 0 per row; zlib `level`). */
export function encodePNG(w, h, pixels, { channels = 3, level = 3 } = {}) {
  if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0 || w > 0xffffffff || h > 0xffffffff || !Number.isSafeInteger(w * h * channels)) {
    throw new Error('invalid PNG dimensions');
  }
  if (channels !== 3 && channels !== 4) throw new Error(`unsupported PNG channels ${channels}`);
  if (!(pixels instanceof Uint8Array) || pixels.length < w * h * channels) throw new Error('truncated PNG pixels');
  const stride = w * channels;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(pixels.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = channels === 4 ? 6 : 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level })), chunk('IEND', Buffer.alloc(0))]);
}

/** Box-filter downsample to W x H (RGB, float 0..1). */
export function downsample(img, W = 64, H = 36) {
  const out = new Float32Array(W * H * 3);
  for (let y = 0; y < H; y++) {
    const y0 = Math.floor((y * img.h) / H), y1 = Math.max(y0 + 1, Math.floor(((y + 1) * img.h) / H));
    for (let x = 0; x < W; x++) {
      const x0 = Math.floor((x * img.w) / W), x1 = Math.max(x0 + 1, Math.floor(((x + 1) * img.w) / W));
      let r = 0, g = 0, b = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) {
        const k = (yy * img.w + xx) * 4;
        r += img.rgba[k]; g += img.rgba[k + 1]; b += img.rgba[k + 2]; n++;
      }
      const o = (y * W + x) * 3;
      out[o] = r / n / 255; out[o + 1] = g / n / 255; out[o + 2] = b / n / 255;
    }
  }
  return out;
}

/** Mean absolute RGB difference (0..1) of two decoded images of equal size (or of two downsamples). */
export function mad(a, b) {
  if (a.rgba && b.rgba) {
    if (a.w !== b.w || a.h !== b.h) return 1;
    let s = 0;
    const n = a.w * a.h;
    for (let i = 0; i < n; i++) {
      const k = i * 4;
      s += Math.abs(a.rgba[k] - b.rgba[k]) + Math.abs(a.rgba[k + 1] - b.rgba[k + 1]) + Math.abs(a.rgba[k + 2] - b.rgba[k + 2]);
    }
    return s / (n * 3 * 255);
  }
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
}

/**
 * Full-resolution comparison of two decoded images: pixels that differ at all, pixels more than 8 levels off (max over
 * RGB), the largest difference, and the mean absolute difference in % of full scale (RGB mean, same as mad() x 100).
 * `diff` (optional Uint8Array w*h) receives the per-pixel max difference.
 */
export function pixelDiff(a, b, diff = null) {
  if (a.w !== b.w || a.h !== b.h) return { sizeMismatch: true, px: a.w * a.h, px8: a.w * a.h, max: 255, madPct: 100 };
  let n = 0, n8 = 0, mx = 0, sum = 0;
  const A = a.rgba, B = b.rgba;
  for (let p = 0, k = 0; p < a.w * a.h; p++, k += 4) {
    const dr = Math.abs(A[k] - B[k]), dg = Math.abs(A[k + 1] - B[k + 1]), db = Math.abs(A[k + 2] - B[k + 2]);
    const d = dr > dg ? (dr > db ? dr : db) : (dg > db ? dg : db);
    if (diff) diff[p] = d;
    if (d) { n++; sum += dr + dg + db; if (d > 8) n8++; if (d > mx) mx = d; }
  }
  return { px: n, px8: n8, max: mx, madPct: +((sum / (a.w * a.h * 3 * 255)) * 100).toFixed(4) };
}
