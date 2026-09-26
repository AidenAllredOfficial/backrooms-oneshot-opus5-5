// src/textures/signage.ts — SIGNAGE layer: a 4x4 sign atlas drawn with Canvas2D and blitted by the layer recipe (WP8).
//
// Slot s = SignKind (core/ids.ts) at uv [(s%4)/4, floor(s/4)/4] .. +1/4. Canvas y runs down while v runs up, so the
// canvases are uploaded with flipY = true: the TOP of each glyph lands at HIGH v, and slot s is drawn at canvas
// row (3 - floor(s/4)). Every arrow points +v (ARROW_UP) or left/right with +v up (EXIT_LEFT / EXIT_RIGHT).
//
// Two canvases:
//   colour: sRGB artwork, opaque everywhere: each slot's edge pixels are dilated (clamp-to-edge) out through the slot
//           margin, so neither bilinear filtering nor the far mips bleed a foreign colour into a sign;
//   mask:   r = alpha (plate or stencil glyph), g = emissive mask (glowing letters -> ormh.a), b = 255 where the
//           slot is stencil paint (the recipe erodes the alpha with wear noise there).
//
// Aspect: each slot is authored for a face of SIGN_ASPECT[s] (width / height). Content is drawn in a
// (256 * aspect) x 256 virtual box squeezed into the square slot, so it looks right on a face of that aspect.

import { Mat, SignKind } from '../core/ids.ts';
import type { RecipeTable } from './layers/types.ts';

/** Face aspect (width / height) each sign slot is authored for (index = SignKind). */
export const SIGN_ASPECT: readonly number[] = [
  2, 2, 2, // EXIT, EXIT_LEFT, EXIT_RIGHT (0.3 x 0.15 m fixture face)
  1, // STAIRS
  1.6, 1.6, 1.6, // B1, B2, L0 (0.45 x 0.28 m tower lintel stencils)
  1, 1, // WET_FLOOR, NO_DIVING
  1.6, 1.6, // LEVEL_P1, LEVEL_P2
  1, // ELEVATOR
  1.5, // AUTHORIZED
  1, 1, 1, // FIRE, ARROW_UP, BLANK
];

/** Slots painted as stencils on the wall/floor (alpha = glyph only, worn). */
export const STENCIL_SLOTS: readonly number[] = [SignKind.B1, SignKind.B2, SignKind.L0, SignKind.LEVEL_P1, SignKind.LEVEL_P2, SignKind.ARROW_UP];

/** Canvas rectangle (x, y, size) of slot s in an atlas canvas of `size` px (y down). */
export function signSlotRect(s: number, size: number): { x: number; y: number; w: number } {
  const w = size / 4;
  return { x: (s % 4) * w, y: (3 - Math.floor(s / 4)) * w, w };
}

type Ctx = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
export interface SignageCanvases { color: OffscreenCanvas | HTMLCanvasElement; mask: OffscreenCanvas | HTMLCanvasElement }

const FONT = '"Arial Narrow", "Liberation Sans Narrow", "Roboto Condensed", "DejaVu Sans Condensed", "Nimbus Sans Narrow", Arial, "Liberation Sans", "DejaVu Sans", sans-serif';
// Atlas background before the slots are drawn (fully covered afterwards: every slot dilates its artwork to its edges).
const BG = '#808080';
const M_PLATE = 'rgb(255,0,0)';
const M_GLOW = 'rgb(255,255,0)';
const M_STENCIL = 'rgb(255,0,255)';
const M_BRIDGE = 'rgb(0,0,255)';

function makeCanvas(size: number): OffscreenCanvas | HTMLCanvasElement {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(size, size);
  const c = document.createElement('canvas');
  c.width = size; c.height = size;
  return c;
}

function roundRect(g: Ctx, x: number, y: number, w: number, h: number, r: number): void {
  g.beginPath();
  g.moveTo(x + r, y);
  g.lineTo(x + w - r, y); g.quadraticCurveTo(x + w, y, x + w, y + r);
  g.lineTo(x + w, y + h - r); g.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  g.lineTo(x + r, y + h); g.quadraticCurveTo(x, y + h, x, y + h - r);
  g.lineTo(x, y + r); g.quadraticCurveTo(x, y, x + r, y);
  g.closePath();
}

/** Draw text centred at (cx, cy) with cap height ~h, squeezed to maxW. */
function text(g: Ctx, str: string, cx: number, cy: number, h: number, maxW: number, weight = 'bold'): void {
  g.save();
  g.font = `${weight} ${Math.round(h * 1.38)}px ${FONT}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const w = g.measureText(str).width;
  const sx = Math.min(1, maxW / Math.max(1, w));
  g.translate(cx, cy + h * 0.04);
  g.scale(sx, 1);
  g.fillText(str, 0, 0);
  g.restore();
}

/** Stencil glyphs: text plus bridges through the bowls of round letters (mask only). */
function stencilText(c: Ctx, m: Ctx, str: string, cx: number, cy: number, h: number, maxW: number): void {
  m.fillStyle = M_STENCIL;
  text(m, str, cx, cy, h, maxW);
  m.save();
  m.font = `bold ${Math.round(h * 1.38)}px ${FONT}`;
  const total = m.measureText(str).width;
  const sx = Math.min(1, maxW / Math.max(1, total));
  let x = cx - (total * sx) / 2;
  m.fillStyle = M_BRIDGE;
  for (const ch of str) {
    const cw = m.measureText(ch).width * sx;
    if ('BDOPQR0689ASE'.includes(ch)) {
      const bx = x + cw * 0.5 - h * 0.045;
      m.fillRect(bx, cy - h * 0.62, h * 0.09, h * 0.3);
      m.fillRect(bx, cy + h * 0.32, h * 0.09, h * 0.3);
    }
    x += cw;
  }
  m.restore();
  void c;
}

function arrowPath(g: Ctx, tipX: number, tipY: number, dirX: number, dirY: number, len: number, headW: number, shaftW: number): void {
  // arrow along (dirX, dirY) with its tip at (tipX, tipY)
  const px = -dirY, py = dirX;
  const headL = headW * 0.9;
  const bx = tipX - dirX * headL, by = tipY - dirY * headL;
  const ex = tipX - dirX * len, ey = tipY - dirY * len;
  g.beginPath();
  g.moveTo(tipX, tipY);
  g.lineTo(bx + px * headW / 2, by + py * headW / 2);
  g.lineTo(bx + px * shaftW / 2, by + py * shaftW / 2);
  g.lineTo(ex + px * shaftW / 2, ey + py * shaftW / 2);
  g.lineTo(ex - px * shaftW / 2, ey - py * shaftW / 2);
  g.lineTo(bx - px * shaftW / 2, by - py * shaftW / 2);
  g.lineTo(bx - px * headW / 2, by - py * headW / 2);
  g.closePath();
}

function chevron(g: Ctx, cx: number, cy: number, s: number, left: boolean): void {
  const d = left ? -1 : 1;
  g.beginPath();
  g.moveTo(cx + d * s * 0.5, cy);
  g.lineTo(cx - d * s * 0.1, cy - s * 0.55);
  g.lineTo(cx - d * s * 0.45, cy - s * 0.55);
  g.lineTo(cx + d * s * 0.05, cy);
  g.lineTo(cx - d * s * 0.45, cy + s * 0.55);
  g.lineTo(cx - d * s * 0.1, cy + s * 0.55);
  g.closePath();
}

// ---------------------------------------------------------------- individual signs (virtual box W x 256)
type SignFn = (c: Ctx, m: Ctx, W: number) => void;

function plate(c: Ctx, m: Ctx, W: number, color: string, glow = false, r = 14, inset = 10): void {
  c.fillStyle = color;
  c.fillRect(0, 0, W, 256);
  m.fillStyle = glow ? 'rgb(255,20,0)' : M_PLATE;
  roundRect(m, inset, inset, W - inset * 2, 256 - inset * 2, r);
  m.fill();
  c.strokeStyle = 'rgba(0,0,0,0.22)';
  c.lineWidth = 3;
  roundRect(c, inset + 1.5, inset + 1.5, W - inset * 2 - 3, 256 - inset * 2 - 3, r);
  c.stroke();
}

const exitSign = (arrow: 0 | -1 | 1): SignFn => (c, m, W) => {
  plate(c, m, W, '#2a1210', true, 10, 6);
  const red = '#f0402c';
  const tx = arrow === 0 ? W / 2 : arrow < 0 ? W * 0.6 : W * 0.4;
  const tw = arrow === 0 ? W * 0.78 : W * 0.56;
  c.fillStyle = red; text(c, 'EXIT', tx, 130, 150, tw);
  m.fillStyle = M_GLOW; text(m, 'EXIT', tx, 130, 150, tw);
  if (arrow !== 0) {
    const ax = arrow < 0 ? W * 0.14 : W * 0.86;
    c.fillStyle = red; chevron(c, ax, 128, 150, arrow < 0); c.fill();
    m.fillStyle = M_GLOW; chevron(m, ax, 128, 150, arrow < 0); m.fill();
  }
};

const stencil = (label: string, paint: string): SignFn => (c, m, W) => {
  c.fillStyle = paint;
  c.fillRect(0, 0, W, 256);
  stencilText(c, m, label, W / 2, 128, 190, W * 0.9);
};

const SIGNS: SignFn[] = [];
SIGNS[SignKind.EXIT] = exitSign(0);
SIGNS[SignKind.EXIT_LEFT] = exitSign(-1);
SIGNS[SignKind.EXIT_RIGHT] = exitSign(1);
SIGNS[SignKind.STAIRS] = (c, m, W) => {
  plate(c, m, W, '#1f4e8f'); // stairwell identification blue
  c.fillStyle = '#f2f2ea';
  // stair pictogram: 4 steps rising to the right, with a walking figure
  c.beginPath();
  c.moveTo(40, 176);
  for (let i = 0; i < 4; i++) { c.lineTo(40 + i * 44, 176 - i * 30); c.lineTo(84 + i * 44, 176 - i * 30); }
  c.lineTo(216, 176 - 3 * 30); c.lineTo(216, 184); c.lineTo(40, 184); c.closePath();
  c.fill();
  c.beginPath(); c.arc(112, 52, 13, 0, Math.PI * 2); c.fill();
  c.lineWidth = 12; c.lineCap = 'round'; c.strokeStyle = '#f2f2ea';
  c.beginPath(); c.moveTo(110, 70); c.lineTo(104, 108); c.lineTo(122, 126); c.moveTo(104, 108); c.lineTo(88, 132);
  c.moveTo(108, 80); c.lineTo(130, 96); c.moveTo(108, 80); c.lineTo(90, 96); c.stroke();
  text(c, 'STAIRS', W / 2, 218, 34, W * 0.8);
};
SIGNS[SignKind.B1] = stencil('B1', '#e0a42a');
SIGNS[SignKind.B2] = stencil('B2', '#e0a42a');
SIGNS[SignKind.L0] = stencil('L0', '#dfd9ca');
SIGNS[SignKind.WET_FLOOR] = (c, m, W) => {
  plate(c, m, W, '#f2b418'); // amber caution yellow
  c.fillStyle = '#141414';
  text(c, 'CAUTION', W / 2, 44, 36, W * 0.84);
  c.fillRect(24, 70, W - 48, 5);
  // slipping figure
  c.lineWidth = 11; c.lineCap = 'round'; c.strokeStyle = '#141414';
  c.beginPath(); c.arc(150, 96, 12, 0, Math.PI * 2); c.fill();
  c.beginPath(); c.moveTo(142, 112); c.lineTo(116, 150); c.lineTo(84, 160); c.moveTo(116, 150); c.lineTo(140, 176);
  c.moveTo(136, 120); c.lineTo(168, 132); c.moveTo(134, 120); c.lineTo(104, 116); c.stroke();
  c.fillRect(60, 180, 130, 5);
  text(c, 'WET FLOOR', W / 2, 218, 34, W * 0.86);
};
SIGNS[SignKind.NO_DIVING] = (c, m, W) => {
  plate(c, m, W, '#e4dfd2');
  // diver
  c.fillStyle = '#1a1a1a'; c.strokeStyle = '#1a1a1a'; c.lineWidth = 12; c.lineCap = 'round';
  c.beginPath(); c.arc(96, 62, 12, 0, Math.PI * 2); c.fill();
  c.beginPath(); c.moveTo(106, 76); c.lineTo(150, 116); c.lineTo(176, 150); c.moveTo(106, 76); c.lineTo(78, 60);
  c.moveTo(150, 116); c.lineTo(150, 150); c.stroke();
  c.lineWidth = 6; c.beginPath(); c.moveTo(40, 164); c.quadraticCurveTo(80, 152, 120, 164); c.quadraticCurveTo(160, 176, 216, 164); c.stroke();
  // prohibition circle
  c.strokeStyle = '#d42420'; c.lineWidth = 16;
  c.beginPath(); c.arc(128, 108, 78, 0, Math.PI * 2); c.stroke();
  c.beginPath(); c.moveTo(128 - 55, 108 - 55); c.lineTo(128 + 55, 108 + 55); c.stroke();
  c.fillStyle = '#d42420';
  text(c, 'NO DIVING', W / 2, 221, 32, W * 0.86);
};
SIGNS[SignKind.LEVEL_P1] = stencil('P1', '#b8362c'); // colour-coded parking levels: P1 red
SIGNS[SignKind.LEVEL_P2] = stencil('P2', '#2a66b8'); // P2 blue
SIGNS[SignKind.ELEVATOR] = (c, m, W) => {
  plate(c, m, W, '#aeada8');
  // brushed steel streaks
  for (let y = 12; y < 244; y += 3) {
    c.fillStyle = `rgba(255,255,255,${0.03 + 0.05 * ((y * 7919) % 13) / 13})`;
    c.fillRect(10, y, W - 20, 1);
  }
  c.fillStyle = '#161616';
  c.beginPath(); c.moveTo(128, 34); c.lineTo(166, 86); c.lineTo(90, 86); c.closePath(); c.fill();
  c.beginPath(); c.moveTo(128, 162); c.lineTo(166, 110); c.lineTo(90, 110); c.closePath(); c.fill();
  text(c, 'ELEVATOR', W / 2, 210, 36, W * 0.84);
};
SIGNS[SignKind.AUTHORIZED] = (c, m, W) => {
  plate(c, m, W, '#e6e2d5');
  c.fillStyle = '#c42a22';
  roundRect(c, 14, 14, W - 28, 74, 10); c.fill();
  c.fillStyle = '#f4f2ea';
  text(c, 'NOTICE', W / 2, 52, 46, W * 0.7);
  c.fillStyle = '#1c1c1c';
  text(c, 'AUTHORIZED', W / 2, 122, 38, W * 0.86);
  text(c, 'PERSONNEL', W / 2, 172, 38, W * 0.86);
  text(c, 'ONLY', W / 2, 220, 38, W * 0.86);
};
SIGNS[SignKind.FIRE] = (c, m, W) => {
  plate(c, m, W, '#c8261e');
  c.fillStyle = '#f4f0e6';
  // extinguisher pictogram
  roundRect(c, 104, 70, 48, 110, 16); c.fill();
  c.fillRect(118, 52, 20, 20);
  c.fillRect(138, 56, 34, 9);
  c.strokeStyle = '#f4f0e6'; c.lineWidth = 7; c.beginPath(); c.moveTo(104, 80); c.quadraticCurveTo(76, 110, 88, 160); c.stroke();
  text(c, 'FIRE', W / 2, 30, 30, W * 0.6);
  text(c, 'EXTINGUISHER', W / 2, 214, 30, W * 0.9);
};
SIGNS[SignKind.ARROW_UP] = (c, m, W) => {
  c.fillStyle = '#dfd9ca';
  c.fillRect(0, 0, W, 256);
  m.fillStyle = M_STENCIL;
  arrowPath(m, W / 2, 26, 0, -1, 204, 150, 56);
  m.fill();
};
SIGNS[SignKind.BLANK] = (c, m, W) => {
  plate(c, m, W, '#d4cfc0');
  c.fillStyle = '#7a7872';
  for (const [x, y] of [[30, 30], [W - 30, 30], [30, 226], [W - 30, 226]]) { c.beginPath(); c.arc(x, y, 6, 0, Math.PI * 2); c.fill(); }
};

/** Clamp-to-edge dilation of a slot's inner artwork (inset by `margin`) out to the slot border: the margin (alpha 0
 * in the mask) carries the slot's own edge colours, so mip filtering never mixes a foreign colour into a sign. */
function dilateSlotMargin(g: Ctx, src: OffscreenCanvas | HTMLCanvasElement, x: number, y: number, w: number, margin: number): void {
  const a = Math.ceil(margin);          // first inner pixel (integer, fully inside the clip)
  const b = Math.floor(w - margin) - 1; // last inner pixel
  const n = b - a + 1;
  g.save();
  g.imageSmoothingEnabled = false;
  // edges: stretch the outermost inner row / column across the margin
  g.drawImage(src, x + a, y + a, n, 1, x + a, y, n, a);               // top
  g.drawImage(src, x + a, y + b, n, 1, x + a, y + b + 1, n, w - b - 1); // bottom
  g.drawImage(src, x + a, y + a, 1, n, x, y + a, a, n);               // left
  g.drawImage(src, x + b, y + a, 1, n, x + b + 1, y + a, w - b - 1, n); // right
  // corners: the corner pixel
  g.drawImage(src, x + a, y + a, 1, 1, x, y, a, a);
  g.drawImage(src, x + b, y + a, 1, 1, x + b + 1, y, w - b - 1, a);
  g.drawImage(src, x + a, y + b, 1, 1, x, y + b + 1, a, w - b - 1);
  g.drawImage(src, x + b, y + b, 1, 1, x + b + 1, y + b + 1, w - b - 1, w - b - 1);
  g.restore();
}

/** Draw the sign atlas (colour + mask). `size` = texture size (512 or 1024). */
export function drawSignageAtlas(size: number): SignageCanvases {
  const color = makeCanvas(size);
  const mask = makeCanvas(size);
  const c = color.getContext('2d') as Ctx | null;
  const m = mask.getContext('2d') as Ctx | null;
  if (!c || !m) throw new Error('signage: 2D canvas unavailable');
  c.fillStyle = BG; c.fillRect(0, 0, size, size);
  m.fillStyle = '#000'; m.fillRect(0, 0, size, size);
  for (let s = 0; s < 16; s++) {
    const r = signSlotRect(s, size);
    const A = SIGN_ASPECT[s];
    const margin = r.w * 0.03;
    const inner = r.w - 2 * margin;
    for (const g of [c, m]) {
      g.save();
      g.beginPath(); g.rect(r.x + margin, r.y + margin, inner, inner); g.clip();
      g.translate(r.x + margin, r.y + margin);
      g.scale(inner / (256 * A), inner / 256);
    }
    SIGNS[s](c, m, 256 * A);
    c.restore(); m.restore();
    dilateSlotMargin(c, color, r.x, r.y, r.w, margin);
    if (STENCIL_SLOTS.includes(s)) {
      // stencil flag: blue channel over the whole slot interior (glyph pixels already carry it)
      m.save();
      m.globalCompositeOperation = 'lighter';
      m.fillStyle = 'rgb(0,0,255)';
      m.fillRect(r.x + margin, r.y + margin, inner, inner);
      m.restore();
    }
  }
  return { color, mask };
}

/** SIGNAGE recipe: blit of the canvas atlas + wear on stencil slots + emissive mask. */
export const SIGNAGE_GLSL = /* glsl */ `
#define SS 4
uniform sampler2D uSignColor; // sRGB artwork (decoded to linear by the sampler)
uniform sampler2D uSignMask;  // r alpha, g emissive, b stencil flag
void gen(vec2 uv, inout Surf s) {
  vec4 c = texture(uSignColor, uv);
  vec4 k = texture(uSignMask, uv);
  float stencil = step(0.5, k.b);
  float wear = smoothstep(0.26, 0.44, fbmV(uv, ivec2(48), 4, 5) + 0.25 * (vnoise(uv, ivec2(700), 6) - 0.5));
  float a = k.r * mix(1.0, wear, stencil);
  s.albedo = c.rgb * mix(1.0, 0.94 + 0.06 * vnoise(uv, ivec2(200), 7), stencil);
  s.alpha = a;
  s.emissive = k.g * (1.0 - stencil);
  s.rough = mix(0.35, 0.6, stencil);
  s.height = 0.5 + 0.12 * k.r * (1.0 - stencil) + 0.04 * a * stencil;
}
`;

export const SIGNAGE_RECIPES: RecipeTable = {
  [Mat.SIGNAGE]: { glsl: SIGNAGE_GLSL, normalStrength: 1.0, heightScale: 0.001 },
};
