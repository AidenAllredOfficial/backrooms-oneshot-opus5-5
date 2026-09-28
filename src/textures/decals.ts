// src/textures/decals.ts — DECAL_ATLAS layer recipe: 16 procedural decals in a 4x4 atlas (WP8).
//
// Slot s (DecalKind) occupies uv [(s%4)/4, floor(s/4)/4] .. +1/4 (core/ids.ts). Inside a slot, p is centred slot
// space in [-0.5, 0.5]^2 with +y = +v = the decal's "up" (core DecalPlacement convention); arrows point +v.
// Alpha lives in albedo.a. Stains, oil, footprints, handprints, burns and drips use feathered alpha (decal variant,
// premultiplied); CHALK_ARROW is drawn for hard alpha (WP9 discards < 0.5). Colour is defined over the whole
// slot interior (not only where alpha > 0) and fades to one shared background in a 3 % margin, so mip filtering
// never bleeds a foreign colour into an edge and the atlas border is seamless. Alpha is 0 in the margin.

import { Mat } from '../core/ids.ts';
import { phys, type RecipeTable } from './layers/types.ts';

export const DECAL_GLSL = /* glsl */ `
#define SS 4
struct D { vec3 col; float a; float rough; float h; float metal; };
float aaS() { return 4.0 * br_texel.x; }
float fillS(float d) { float w = 0.7 * aaS(); return 1.0 - smoothstep(-w, w, d); }
float softS(float d, float f) { float w = max(f, 0.7 * aaS()); return 1.0 - smoothstep(-w, w, d); }

void dWaterStain(vec2 p, vec2 uv, inout D d) {
  float n = fbm(uv, ivec2(24), 4, 101);
  float r = length(p * vec2(1.0, 1.1)) / 0.4 + 0.22 * n;
  float body = 1.0 - smoothstep(0.82, 1.0, r);
  float cut = 1.0 - smoothstep(1.0, 1.06, r);
  float tide = (gauss((r - 0.97) / 0.03) + 0.55 * gauss((r - 0.76) / 0.022) + 0.35 * gauss((r - 0.52) / 0.02)) * cut;
  float inner = 0.5 + 0.5 * fbm(uv, ivec2(48), 3, 102);
  d.col = mix(srgb8(150.0, 118.0, 70.0), srgb8(96.0, 66.0, 34.0), sat(tide));
  d.a = sat(body * (0.2 + 0.18 * inner) + 0.6 * tide);
  d.rough = 0.75;
}
void dMold(vec2 p, vec2 uv, inout D d) {
  float dens = fbmV(uv, ivec2(40), 4, 111);
  float rad = 1.0 - smoothstep(0.12, 0.45, length(p) + 0.12 * fbm(uv, ivec2(20), 3, 112));
  float cluster = sat((dens - 0.33) * 2.5) * rad;
  Cell c = worley(uv, ivec2(360), 0.9, 113);
  float dotR = 0.12 + 0.32 * cluster * hashf(c.id, 114);
  float spk = (1.0 - smoothstep(dotR - 0.08, dotR, c.f1)) * step(0.04, cluster);
  d.col = mix(srgb8(44.0, 48.0, 32.0), srgb8(18.0, 20.0, 16.0), hashf(c.id, 115));
  d.a = sat(spk * 0.95 + cluster * 0.35);
  d.rough = 0.9;
  d.h = 0.5 + 0.1 * spk;
}
float dShoe(vec2 q) {
  float fore = sdEllipse(q - vec2(0.0, 0.06), vec2(0.062, 0.1));
  float heel = sdEllipse(q - vec2(0.0, -0.125), vec2(0.05, 0.062));
  float arch = sdBox(q - vec2(0.014, -0.035), vec2(0.03, 0.06));
  return smin(smin(fore, heel, 0.025), arch, 0.03);
}
void dFootprints(vec2 p, vec2 uv, inout D d) {
  vec2 ql = rot2(p - vec2(-0.1, -0.17), 0.08);
  vec2 qr = rot2(p - vec2(0.1, 0.16), -0.08);
  qr.x = -qr.x;
  float sL = dShoe(ql), sR = dShoe(qr);
  float sole = max(softS(sL, 0.006), softS(sR, 0.006));
  float tread = 0.5 + 0.5 * sin(p.y * 190.0 + 3.0 * sin(p.x * 60.0));
  float lug = step(0.35, tread);
  float wet = 0.55 + 0.45 * fbm(uv, ivec2(48), 3, 121);
  d.col = srgb8(34.0, 32.0, 30.0);
  d.a = sat(sole * mix(0.25, 0.7, lug) * wet);
  d.rough = 0.12;
}
void dScuff(vec2 p, vec2 uv, inout D d) {
  float acc = 0.0;
  for (int i = 0; i < 7; i++) {
    vec4 r = hash4f(ivec2(i, 3), 131);
    vec2 c = (r.xy - 0.5) * 0.45;
    float R = 0.12 + 0.35 * r.z;
    vec2 q = p - c + vec2(0.0, R);
    float ang = atan(q.x, q.y);
    float span = 0.15 + 0.3 * r.w;
    float along = sat(1.0 - abs(ang) / span);
    float dd = abs(length(q) - R);
    float wdt = 0.003 + 0.012 * along;
    acc = max(acc, softS(dd - wdt, 0.004) * along * (0.45 + 0.55 * r.w));
  }
  acc *= 0.65 + 0.35 * gnoise(uv, ivec2(6, 260), 132);
  d.col = srgb8(28.0, 26.0, 26.0);
  d.a = sat(acc * 0.95);
  d.rough = 0.6;
}
void dCrack(vec2 p, vec2 uv, inout D d) {
  float n1 = 0.1 * fbm(vec2(0.3, uv.y), ivec2(1, 24), 4, 141);
  float taper1 = 1.0 - smoothstep(0.3, 0.45, abs(p.y));
  float d1 = abs(p.x - n1) - (0.0055 * taper1 + 0.0012);
  float yb = p.y - 0.04;
  float n2 = 0.05 * fbm(vec2(0.7, uv.y), ivec2(1, 32), 4, 142);
  float d2 = abs(p.x - (n1 + yb * 0.85 + n2)) / 1.31 - (0.004 * (1.0 - sat(yb / 0.34)) + 0.001);
  float b2 = step(0.0, yb) * (1.0 - smoothstep(0.25, 0.34, yb));
  float yc = -0.08 - p.y;
  float n3 = 0.05 * fbm(vec2(0.9, uv.y), ivec2(1, 32), 4, 143);
  float d3 = abs(p.x - (n1 - yc * 0.7 + n3)) / 1.22 - (0.0035 * (1.0 - sat(yc / 0.28)) + 0.001);
  float b3 = step(0.0, yc) * (1.0 - smoothstep(0.2, 0.28, yc));
  float crack = max(fillS(d1) * step(abs(p.y), 0.46), max(fillS(d2) * b2, fillS(d3) * b3));
  float halo = gauss((abs(p.x - n1)) / 0.02) * taper1 * 0.15;
  d.col = srgb8(22.0, 21.0, 20.0);
  d.a = sat(crack + halo);
  d.h = 0.5 - 0.45 * crack;
  d.rough = 0.9;
}
void dOil(vec2 p, vec2 uv, inout D d) {
  float r = length(p * vec2(1.0, 1.2)) / 0.34 + 0.25 * fbm(uv, ivec2(20), 4, 151);
  float body = 1.0 - smoothstep(0.72, 1.0, r);
  Cell c = worley(uv, ivec2(48), 0.8, 152);
  float drop = step(hashf(c.id, 153), 0.35) * (1.0 - smoothstep(0.1, 0.2, c.f1)) * (1.0 - smoothstep(0.3, 0.44, length(p)));
  float inner = 0.75 + 0.25 * fbm(uv, ivec2(40), 3, 154);
  d.col = srgb8(16.0, 15.0, 14.0);
  d.a = sat(max(body * inner, drop * 0.8)) * 0.9;
  d.rough = 0.22;
  d.h = 0.52;
}
void dRustStreak(vec2 p, vec2 uv, inout D d) {
  float top = 0.4;
  float t = sat((top - p.y) / 0.85);
  float env = gauss(p.x / (0.06 + 0.09 * t));
  float stri = 0.5 + 0.5 * gnoise(vec2(uv.x, 0.5), ivec2(160, 1), 161);
  float stri2 = 0.5 + 0.5 * gnoise(uv, ivec2(90, 6), 162);
  float src = gauss((p.y - top) / 0.025) * gauss(p.x / 0.05);
  float fadeDown = 1.0 - smoothstep(0.35, 1.0, t);
  float a = env * (0.3 + 0.45 * stri + 0.25 * stri2) * fadeDown * (1.0 - smoothstep(top, top + 0.03, p.y)) + src;
  d.col = mix(srgb8(140.0, 66.0, 28.0), srgb8(96.0, 46.0, 22.0), t);
  d.a = sat(a * 0.85);
  d.rough = 0.8;
}
void dDrain(vec2 p, vec2 uv, inout D d) {
  float r = length(p);
  float disk = fillS(r - 0.42);
  float rim = disk * (1.0 - fillS(r - 0.35));
  float fx = abs(fract(p.x * 14.0) - 0.5) / 14.0;
  float slot = fillS(fx - 0.019) * fillS(r - 0.31);
  float iron = disk * (1.0 - slot);
  float rust = smoothstep(0.1, 0.5, fbm(uv, ivec2(64), 3, 171));
  vec3 ironCol = mix(srgb8(62.0, 60.0, 58.0), srgb8(92.0, 58.0, 38.0), rust * 0.6) * (0.85 + 0.3 * vnoise(uv, ivec2(400), 172));
  d.col = mix(srgb8(10.0, 10.0, 10.0), ironCol, iron);
  d.a = disk;
  d.metal = 0.6 * iron * (1.0 - rust);
  d.rough = mix(0.5, 0.85, rust);
  d.h = 0.5 + 0.3 * rim - 0.45 * slot;
}
void dPoster(vec2 p, vec2 uv, inout D d) {
  float rect = sdBox(p, vec2(0.3, 0.4));
  vec2 corner = vec2(0.3, -0.4);
  float c = dot(p - corner, vec2(-0.7071, 0.7071));
  float jag = 0.012 * gnoise(uv, ivec2(220), 181) + 0.006 * gnoise(uv, ivec2(640), 182);
  float shape = max(rect, 0.075 + jag - c);
  float paper = fillS(shape);
  vec3 paperCol = srgb8(214.0, 204.0, 178.0) * (0.92 + 0.08 * fbm(uv, ivec2(40), 3, 183));
  vec3 col = paperCol;
  float header = fillS(sdBox(p - vec2(0.0, 0.31), vec2(0.25, 0.05)));
  col = mix(col, srgb8(160.0, 72.0, 58.0), header * 0.85);
  float img = fillS(sdBox(p - vec2(0.0, 0.07), vec2(0.24, 0.16)));
  vec3 imgCol = mix(srgb8(76.0, 96.0, 112.0), srgb8(176.0, 156.0, 118.0), 0.5 + 0.5 * fbm(uv, ivec2(32), 3, 184));
  col = mix(col, imgCol, img * 0.8);
  float ly = (p.y + 0.36) / 0.034;
  float row = floor(ly);
  float rowLen = 0.24 - 0.12 * step(0.75, hashf(ivec2(int(row) + 16, 7), 185));
  float words = step(0.3, vnoise(vec2(uv.x, row * 0.01), ivec2(96, 1), 186));
  float line = step(fract(ly), 0.42) * step(-0.36, p.y) * step(p.y, -0.13) * step(p.x, rowLen) * step(-0.24, p.x) * words;
  col = mix(col, srgb8(64.0, 58.0, 52.0), line * 0.8);
  col = mix(col, paperCol, 0.25);
  float crease = gauss(p.x / 0.004) + gauss((p.y - 0.02) / 0.004);
  col *= 1.0 - 0.06 * crease;
  float stain = smoothstep(0.2, 0.6, fbm(uv, ivec2(12), 4, 187));
  col = mix(col, col * vec3(0.85, 0.78, 0.66), stain * 0.6);
  d.col = col;
  d.a = paper;
  d.rough = 0.8;
  d.h = 0.5 + 0.08 * paper - 0.1 * crease * paper;
}
void dChalkArrow(vec2 p, vec2 uv, inout D d) {
  vec2 q = p + 0.006 * vec2(gnoise(uv, ivec2(40), 191), gnoise(uv, ivec2(40), 192));
  float shaft = sdSeg(q, vec2(0.0, -0.36), vec2(0.0, 0.33));
  float h1 = sdSeg(q, vec2(0.0, 0.38), vec2(-0.17, 0.2));
  float h2 = sdSeg(q, vec2(0.0, 0.38), vec2(0.17, 0.2));
  float dd = min(shaft, min(h1, h2));
  float stroke = fillS(dd - 0.028);
  float grain = 0.6 * vnoise(uv, ivec2(900), 193) + 0.4 * vnoise(uv, ivec2(300), 194);
  float core = 1.0 - smoothstep(0.0, 0.028, dd);
  float chalk = stroke * smoothstep(0.26, 0.34, grain + 0.3 * core);
  d.col = srgb8(222.0, 222.0, 214.0);
  d.a = chalk;
  d.rough = 0.95;
  d.h = 0.5 + 0.05 * chalk;
}
void dHandprint(vec2 p, vec2 uv, inout D d) {
  vec2 q = p + vec2(0.0, 0.06);
  float hand = sdEllipse(q - vec2(0.0, -0.1), vec2(0.125, 0.14));
  for (int i = 0; i < 4; i++) {
    float fx = -0.09 + float(i) * 0.06;
    float len = i == 0 ? 0.15 : i == 1 ? 0.2 : i == 2 ? 0.19 : 0.14;
    vec2 a = vec2(fx, 0.02);
    vec2 b = vec2(fx * 1.25, 0.02 + len);
    hand = smin(hand, sdSeg(q, a, b) - 0.027, 0.015);
  }
  hand = smin(hand, sdSeg(q, vec2(0.11, -0.13), vec2(0.23, -0.02)) - 0.03, 0.02);
  float smear = fbm(uv, ivec2(40), 4, 201);
  float ridges = 0.8 + 0.2 * vnoise(uv, ivec2(500), 202);
  d.col = srgb8(42.0, 36.0, 32.0);
  d.a = sat(softS(hand, 0.01) * (0.45 + 0.35 * smear) * ridges);
  d.rough = 0.7;
}
void dDrip(vec2 p, vec2 uv, inout D d) {
  float acc = 0.0;
  for (int i = 0; i < 9; i++) {
    vec4 r = hash4f(ivec2(i, 11), 211);
    float x0 = (r.x - 0.5) * 0.8;
    float len = 0.25 + 0.6 * r.y;
    float y0 = 0.44;
    float y1 = y0 - len;
    float wob = 0.005 * gnoise(vec2(0.13 * float(i + 1), uv.y), ivec2(1, 40), 212 + i);
    float w = 0.004 + 0.004 * r.z;
    float along = step(y1, p.y) * step(p.y, y0);
    float line = fillS(abs(p.x - x0 - wob) - w) * along * (0.55 + 0.45 * sat((p.y - y1) / len));
    float bulb = fillS(length(vec2(p.x - x0 - wob, (p.y - y1) * 0.8)) - w * 1.8);
    acc = max(acc, max(line, bulb) * (0.5 + 0.5 * r.w));
  }
  float band = gauss((p.y - 0.42) / 0.03) * (1.0 - smoothstep(0.35, 0.45, abs(p.x)));
  d.col = srgb8(74.0, 60.0, 42.0);
  d.a = sat(acc * 0.7 + band * 0.5);
  d.rough = 0.35;
}
void dTally(vec2 p, vec2 uv, inout D d) {
  float acc = 0.0;
  for (int g = 0; g < 3; g++) {
    float gx = -0.32 + float(g) * 0.25;
    for (int k = 0; k < 4; k++) {
      if (g == 2 && k >= 3) break;
      vec4 r = hash4f(ivec2(g, k), 221);
      float x = gx + float(k) * 0.045 + (r.x - 0.5) * 0.012;
      vec2 a0 = vec2(x + (r.y - 0.5) * 0.02, -0.12 + (r.z - 0.5) * 0.03);
      vec2 a1 = vec2(x + (r.w - 0.5) * 0.02, 0.12 + (r.x - 0.5) * 0.03);
      acc = max(acc, fillS(sdSeg(p, a0, a1) - 0.007));
    }
    if (g < 2) acc = max(acc, fillS(sdSeg(p, vec2(gx - 0.03, -0.1), vec2(gx + 0.17, 0.11)) - 0.007));
  }
  acc *= 0.8 + 0.2 * vnoise(uv, ivec2(300), 222);
  d.col = srgb8(26.0, 24.0, 28.0);
  d.a = acc * 0.92;
  d.rough = 0.5;
}
void dBurn(vec2 p, vec2 uv, inout D d) {
  vec2 q = p - vec2(0.0, -0.12);
  q.y *= q.y > 0.0 ? 0.55 : 1.0;
  float rr = length(q) / 0.3 + 0.25 * fbm(uv, ivec2(24), 4, 231);
  float core = 1.0 - smoothstep(0.2, 0.6, rr);
  float halo = 1.0 - smoothstep(0.45, 1.0, rr);
  d.col = mix(srgb8(76.0, 52.0, 32.0), srgb8(12.0, 11.0, 10.0), core);
  d.a = sat(halo * 0.75 + core * 0.25);
  d.rough = 0.85;
}
void dPaper(vec2 p, vec2 uv, inout D d) {
  vec2 q = rot2(p, 0.12);
  float sheet = fillS(sdBox(q, vec2(0.25, 0.34)));
  float cr = ridged(warp(uv, ivec2(12), 2, 241, 0.01), ivec2(28), 3, 242);
  float ly = (q.y + 0.27) / 0.028;
  float row = floor(ly);
  float words = step(0.28, vnoise(vec2(uv.x, row * 0.013), ivec2(120, 1), 243));
  float line = step(fract(ly), 0.38) * step(-0.27, q.y) * step(q.y, 0.24) * step(abs(q.x), 0.19) * words;
  vec3 col = srgb8(222.0, 220.0, 212.0) * (0.9 + 0.1 * cr);
  col = mix(col, srgb8(110.0, 108.0, 104.0), line * 0.75);
  d.col = col;
  d.a = sheet;
  d.h = 0.5 + 0.35 * cr * sheet;
  d.rough = 0.85;
}
float dSegD(vec2 q, vec2 a, vec2 b) { return sdSeg(q, a, b) - 0.024; }
float dDigit(vec2 q, int n) {
  int m = n == 0 ? 0x3F : n == 1 ? 0x06 : n == 2 ? 0x5B : n == 3 ? 0x4F : n == 4 ? 0x66
        : n == 5 ? 0x6D : n == 6 ? 0x7D : n == 7 ? 0x07 : n == 8 ? 0x7F : 0x6F;
  float d = 1e3;
  if ((m & 1) != 0) d = min(d, dSegD(q, vec2(-0.07, 0.2), vec2(0.07, 0.2)));
  if ((m & 2) != 0) d = min(d, dSegD(q, vec2(0.1, 0.17), vec2(0.1, 0.03)));
  if ((m & 4) != 0) d = min(d, dSegD(q, vec2(0.1, -0.03), vec2(0.1, -0.17)));
  if ((m & 8) != 0) d = min(d, dSegD(q, vec2(-0.07, -0.2), vec2(0.07, -0.2)));
  if ((m & 16) != 0) d = min(d, dSegD(q, vec2(-0.1, -0.03), vec2(-0.1, -0.17)));
  if ((m & 32) != 0) d = min(d, dSegD(q, vec2(-0.1, 0.17), vec2(-0.1, 0.03)));
  if ((m & 64) != 0) d = min(d, dSegD(q, vec2(-0.07, 0.0), vec2(0.07, 0.0)));
  return d;
}
// 0-9 digit strip for column stencils: 2 rows x 5 cells (0.18 x 0.45 of the slot); mesh/decals.ts composes a bay
// number from two digit sub-rects (digitRect: cell centre +- 0.085 x +- 0.16)
void dParkingNumber(vec2 p, vec2 uv, inout D d) {
  float col = clamp(floor((p.x + 0.45) / 0.18), 0.0, 4.0);
  float row = p.y > 0.0 ? 0.0 : 1.0;
  vec2 ctr = vec2(-0.36 + 0.18 * col, row < 0.5 ? 0.225 : -0.225);
  const float SC = 0.6;
  float dd = dDigit((p - ctr) / SC, int(row * 5.0 + col)) * SC;
  float wear = smoothstep(0.26, 0.42, fbmV(uv, ivec2(64), 4, 251) + 0.2 * (vnoise(uv, ivec2(600), 252) - 0.5));
  d.col = srgb8(226.0, 222.0, 208.0);
  d.a = fillS(dd) * wear;
  d.rough = 0.55;
  d.h = 0.5 + 0.05 * d.a;
}

void gen(vec2 uv, inout Surf s) {
  vec2 cell = floor(uv * 4.0);
  vec2 sl = cell - 4.0 * floor(cell / 4.0);
  int slot = int(sl.x) + 4 * int(sl.y);
  vec2 p = fract(uv * 4.0) - 0.5;
  D d;
  d.col = TABLE_ALBEDO; d.a = 0.0; d.rough = 0.7; d.h = 0.5; d.metal = 0.0;
  if (slot == 0) dWaterStain(p, uv, d);
  else if (slot == 1) dMold(p, uv, d);
  else if (slot == 2) dFootprints(p, uv, d);
  else if (slot == 3) dScuff(p, uv, d);
  else if (slot == 4) dCrack(p, uv, d);
  else if (slot == 5) dOil(p, uv, d);
  else if (slot == 6) dRustStreak(p, uv, d);
  else if (slot == 7) dDrain(p, uv, d);
  else if (slot == 8) dPoster(p, uv, d);
  else if (slot == 9) dChalkArrow(p, uv, d);
  else if (slot == 10) dHandprint(p, uv, d);
  else if (slot == 11) dDrip(p, uv, d);
  else if (slot == 12) dTally(p, uv, d);
  else if (slot == 13) dBurn(p, uv, d);
  else if (slot == 14) dPaper(p, uv, d);
  else dParkingNumber(p, uv, d);
  // shared margin: alpha 0, colour -> atlas background
  float mEdge = max(abs(p.x), abs(p.y));
  float inside = 1.0 - smoothstep(0.455, 0.485, mEdge);
  s.albedo = mix(TABLE_ALBEDO, d.col, inside);
  s.alpha = d.a * inside;
  s.rough = mix(0.7, d.rough, inside);
  s.metal = d.metal * inside;
  s.height = mix(0.5, d.h, inside);
}
`;

// trim: albedo calibration (layerAlbedoCheck at 1024)
export const DECAL_RECIPES: RecipeTable = {
  [Mat.DECAL_ATLAS]: { glsl: DECAL_GLSL, normalStrength: 1.0, heightScale: 0.002, trim: [0.936, 0.965, 0.921], phys: phys(0) },
};
