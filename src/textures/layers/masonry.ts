// src/textures/layers/masonry.ts — masonry: CMU_PAINTED, CMU_RAW (WP8; texture realism v2 lane C).

import { Mat } from '../../core/ids.ts';
import { Det } from '../detailRecipes/types.ts';
import { phys, type RecipeTable } from './types.ts';

/** heightScale of both CMU layers (m per height unit): the face rests at 0.62, the tooled joints 4.5 mm below it. */
const CMU_HS = 0.01;
/** Block module (m): 0.4 x 0.2 nominal (390 x 190 mm blocks and ~10 mm joints), 6 x 5 per 2.4 x 1.0 m frame. */
export const CMU_BLOCK: readonly [number, number] = [0.4, 0.2];
/** Course offsets in blocks, cycling every 5 courses. 15 courses fit a 3 m storey, so a true half bond cannot be
 * periodic; courses use a third bond, so every head joint is overlapped by >= 1/3 of a block. The world block key of
 * the shader (chunks/family/masonry.ts) follows the same sequence. */
export const CMU_BOND = [0, 1 / 3, 2 / 3, 1 / 3, 2 / 3] as const;

/**
 * Concrete block masonry on the 2.4 x 1.0 m frame, shared by the painted and the raw layer (`painted`). Everything
 * below 3 mm (sand, grit, pinholes, crevices) is the detail map's (D14 CMU_FACE / D15 CMU_RAW); the base carries what
 * its 2.34 x 0.98 mm texels resolve:
 * - joints: every block's own face is inset 4-6 mm per side (block tolerances), so joints are 8-12 mm wide and vary
 *   block to block, with arrises wavy by +-0.6 mm and rounded over 2 mm; the mortar is tooled concave (a 7 mm radius
 *   jointer, 4.5 mm deep at the centre; head and bed grooves cut into each other) with squeezed burrs on ~12 % of
 *   the joint length in the outer 2 mm;
 * - faces: lippage +-1 mm, tilt +-0.3 deg, a 0.3 mm warp at 6 cm, an open-texture field per block (denser toward
 *   one bed face, the top as cast) that controls the >= 3 mm voids (irregular, 1.6-4.5 mm radius, 2.5-4 mm deep;
 *   painted: 55 % of that with rounded rims);
 * - chips on 10 % of the edges and 25 % of the corners (conchoidal scoops of <= 8 mm radius, 1.2-3 mm deep: the
 *   2.4 m frame repeats, so nothing larger); painted over (65 %) or fresh (block grey, a lifted paint edge);
 * - painted: roller lap bands (0.24 m, +-1.2 % value, +-0.04 roughness, lap lines on 30 % of the band edges), the
 *   paint colour +-1 % per block (the shader adds the world variation), face roughness 0.52, voids 0.72, joints 0.58,
 *   fresh chips 0.85;
 * - raw: salt-and-pepper grey block, +-4 % per block and a batch cast (warmer or cooler) on 20 %; lighter, sandy
 *   mortar with a faint efflorescence haze near some joints; voids x0.5, fresh chips x0.8; roughness 0.9 / 0.92.
 * Surf.aux (the 'detailMask' channel) is 1 on faces and 0.3 in the joints (the tooled mortar is smoother than the
 * block face); the shader also reads it as the face / joint mask.
 */
const cmuBlock = (painted: boolean): string => /* glsl */ `
#define SS 4
#define CMU_HS ${CMU_HS.toFixed(4)}
#define MM (0.001 / CMU_HS)
float cmuOff(float c) {
  float cw = mod(c, 5.0);
  return cw < 0.5 ? 0.0 : cw < 1.5 ? 1.0 / 3.0 : cw < 2.5 ? 2.0 / 3.0 : cw < 3.5 ? 1.0 / 3.0 : 2.0 / 3.0;
}
// the block of course c at frame x (metres): its index along the course and its frame-wrapped id
vec2 cmuId(float x, float c, out float bx) {
  bx = x + cmuOff(c) * 0.4;
  float blk = floor(bx / 0.4);
  return vec2(mod(blk, 6.0), mod(c, 5.0));
}
// a block's face inset on one side (m): 4-6 mm, plus the wavy arris (+-0.6 mm) along that side
float cmuInset(vec2 id, int side, vec2 uv) {
  float w = 0.004 + 0.002 * hashf(id, 40 + side);
  int sd = int(hashf(id, 50 + side) * 997.0);
  return w + 0.0005 * gnoise(uv, PM(40.0), sd) + 0.00025 * gnoise(uv, PM(120.0), sd + 1);
}
// tooled concave joint: depth below the arris plane (height units) at d metres off the joint centre, half-width hw
float cmuGroove(float d, float hw) {
  float x = min(abs(d), min(hw, 0.0069));
  return max(4.5 - (7.0 - sqrt(49.0 - 1e6 * x * x)), 0.3) * MM * (1.0 - smoothstep(hw - 0.0002, hw + 0.0002, abs(d)));
}

void gen(vec2 uv, inout Surf s) {
  vec2 m = uv * FRAME;
  float c = floor(m.y / 0.2);
  float bx;
  vec2 id = cmuId(m.x, c, bx);
  vec2 lp = vec2(bx - (floor(bx / 0.4) + 0.5) * 0.4, m.y - (c + 0.5) * 0.2);
  vec4 r = hash4f(id, 7);
  vec4 r2 = hash4f(id, 8);
  // ---- this block's face rectangle (insets per side: 0 left, 1 right, 2 bottom, 3 top)
  float iL = cmuInset(id, 0, uv), iR = cmuInset(id, 1, uv), iB = cmuInset(id, 2, uv), iT = cmuInset(id, 3, uv);
  vec2 fc = vec2(iL - iR, iB - iT) * 0.5;
  vec2 fh = vec2(0.2, 0.1) - vec2(iL + iR, iB + iT) * 0.5;
  float e = -sdRoundBox(lp - fc, fh, 0.0015); // metres into the face (< 0 in the joint)
  // ---- the neighbours across the nearest head and bed joints, and the joints' centres and half-widths
  float sx = lp.x >= 0.0 ? 1.0 : -1.0, sy = lp.y >= 0.0 ? 1.0 : -1.0;
  float nbx;
  vec2 hId = cmuId(m.x + sx * 0.4, c, nbx);
  float hIn = cmuInset(hId, sx > 0.0 ? 0 : 1, uv);
  float aInX = sx > 0.0 ? iR : iL;
  float dH = lp.x - sx * (0.2 + 0.5 * (hIn - aInX)), hwH = 0.5 * (aInX + hIn);
  vec2 vId = cmuId(m.x, c + sy, nbx);
  float vIn = cmuInset(vId, sy > 0.0 ? 2 : 3, uv);
  float aInY = sy > 0.0 ? iT : iB;
  float dB = lp.y - sy * (0.1 + 0.5 * (vIn - aInY)), hwB = 0.5 * (aInY + vIn);
  // ---- mortar: head and bed grooves cut into each other (the deeper wins), squeezed burrs near the arrises
  float rest = 0.62;
  float groove = max(cmuGroove(dB, hwB), cmuGroove(dH, hwH));
  // burrs: 25 mm cells along each joint, 12 % hold a 4-8 mm long lump 1.2 mm proud in the outer 2 mm of one side
  // (cell ids: bed joints by course boundary and x cell, head joints by block boundary and y cell; frame-periodic)
  bool bBed = abs(dB) < abs(dH);
  float bAlong = bBed ? m.x : m.y - c * 0.2;
  float bAcross = bBed ? dB : dH;
  float bHw = bBed ? hwB : hwH;
  float bCell = floor(bAlong / 0.025);
  vec2 bId = bBed ? vec2(mod(bCell, 96.0), mod(c + max(sy, 0.0), 5.0))
                  : vec2(mod(floor(bx / 0.4) + max(sx, 0.0), 6.0) + 6.0 * bCell, 5.0 + mod(c, 5.0));
  vec4 bh = hash4f(bId, 60);
  float bPos = (bAlong / 0.025 - bCell - 0.5 - 0.6 * (bh.x - 0.5)) * 0.025;
  float bLen = mix(0.002, 0.004, bh.y);
  float bSide = bh.z < 0.5 ? -1.0 : 1.0;
  float burr = step(bh.w, 0.12) * (1.0 - smoothstep(0.4, 1.0, abs(bPos) / bLen))
             * (1.0 - smoothstep(0.0, 0.0012, abs(bAcross - bSide * (bHw - 0.001)) - 0.0003));
  float mortar = rest - groove + 1.2 * MM * burr + 0.15 * MM * fbm(uv, PM(90.0), 2, 61);
  // ---- face: lippage, tilt, warp, the arris round-over
  float bSgn = r2.w < 0.5 ? -1.0 : 1.0; // which bed face is the open (top as cast) one
  float open = sat(0.35 + 0.5 * fbm(uv, PM(8.0), 2, 62) + 0.4 * (r.z - 0.5) + 0.3 * bSgn * lp.y / 0.1);
  vec2 tilt = (r.xy - 0.5) * 2.0 * 0.0044;
  float face = rest + (r.w - 0.5) * 1.6 * MM + dot(lp - fc, tilt) / CMU_HS + 0.3 * MM * fbm(uv, PM(16.0), 2, 63);
  face -= 0.5 * MM * (1.0 - smoothstep(0.0, 0.002, e)) * (1.0 - smoothstep(0.0, 0.002, e));
  // ---- chips: one candidate per edge (10 %) and per corner (25 %), <= 8 mm, conchoidal
  float chip = 0.0, chipFresh = 0.0;
  for (int k = 0; k < 8; k++) {
    vec4 ch = hash4f(id, 70 + k);
    bool corner = k >= 4;
    if (ch.x >= (corner ? 0.25 : 0.1)) continue;
    float R = mix(0.004, 0.008, ch.y);
    vec2 ctr;
    if (corner) {
      vec2 sg = vec2(k == 4 || k == 7 ? -1.0 : 1.0, k < 6 ? -1.0 : 1.0);
      ctr = fc + sg * (fh + 0.28 * R);
    } else {
      float t = mix(-0.8, 0.8, ch.z);
      ctr = k == 0 ? vec2(fc.x - fh.x - 0.4 * R, fc.y + t * fh.y) : k == 1 ? vec2(fc.x + fh.x + 0.4 * R, fc.y + t * fh.y)
          : k == 2 ? vec2(fc.x + t * fh.x, fc.y - fh.y - 0.4 * R) : vec2(fc.x + t * fh.x, fc.y + fh.y + 0.4 * R);
    }
    vec2 dv = lp - ctr;
    float dd = length(dv * vec2(1.0, mix(0.8, 1.25, ch.w))) / R;
    if (dd < 1.0) {
      float depth = mix(1.2, 3.0, fract(ch.y * 7.31)) * MM * (1.0 - pow(dd, 1.5));
      if (depth > chip) { chip = depth; chipFresh = step(fract(ch.w * 13.7), 0.35); }
    }
  }
  float chipM = smoothstep(0.0, 0.3 * MM, chip);
  // ---- voids >= 3 mm (18 mm cells, warped 0.15 cell): irregular, only inside the face
  vec2 vw = vec2(fbm(uv, PM(20.0), 2, 64), fbm(uv, PM(20.0), 2, 65)) * 0.0027 / FRAME;
  Cell v = worley(uv + vw, PM(55.0), 0.9, 66);
  vec4 vh = hash4f(v.id, 67);
  float vr = mix(0.0016, 0.0045, vh.y) / 0.0182; // cell units
  vec2 vo = (vh.zw - 0.5) * vr * 1.3;
  float vd = min(length(v.rel), 1.25 * length(v.rel + vo)) + 0.08 * vr * gnoise(uv, PM(300.0), 68);
  float voidM = step(vh.x, 0.06 + 0.22 * open) * (1.0 - smoothstep(0.75 * vr, vr, vd)) * smoothstep(0.003, 0.007, e);
  float voidDepth = mix(2.5, 4.0, fract(vh.y * 5.7)) * MM * ${painted ? '0.55' : '1.0'};
  face -= voidDepth * voidM * ${painted ? 'smoothstep(0.0, 0.45, 1.0 - vd / vr)' : '1.0'};
  face -= chip;
  // ---- assemble
  float w = 0.7 * aaM();
  float fM = smoothstep(-w, w, e); // face coverage
  s.height = mix(mortar, face, fM);
  s.aux = mix(0.3, 1.0, fM);
${painted ? `  // roller bands and lap lines (vertical 0.24 m bands with wobbly edges)
  float bxw = m.x + 0.02 * fbm(uv, PMxy(2.0, 12.0), 2, 80);
  float band = floor(bxw / 0.24);
  float bv = hashf(vec2(mod(band, 10.0), 0.0), 81) - 0.5;
  float lapD = abs(bxw - (band + 0.5) * 0.24) - 0.12; // <= 0, distance inside the band edge
  float lap = step(hashf(vec2(mod(band, 10.0), 1.0), 82), 0.3) * (1.0 - smoothstep(0.0, 0.02, -lapD));
  vec3 paint = TABLE_ALBEDO * (1.0 + 0.02 * (r2.x - 0.5)) * (1.0 + 0.024 * bv) * (1.0 - 0.015 * lap);
  vec3 col = paint * mix(0.9, 1.0, fM); // pooled paint and dust in the joints
  col *= 1.0 - 0.04 * voidM * fM;
  vec3 blockGrey = srgb8(128.0, 126.0, 120.0);
  float edgeP = 1.0 - smoothstep(0.0, 0.3 * MM, chip - 0.1 * MM); // the 0.6 mm paint edge round a fresh chip
  col = mix(col, mix(paint * 0.97, mix(blockGrey, paint * 1.05, edgeP * 0.5), chipFresh), chipM * fM);
  s.albedo = col;
  float rf = 0.52 + 0.08 * bv - 0.05 * lap + 0.2 * voidM;
  s.rough = mix(0.58, mix(rf, mix(rf, 0.85, chipFresh), chipM), fM);` : `  // salt-and-pepper block grey (the detail map carries the grains), batch casts, sandy mortar, efflorescence haze
  vec3 batch = r2.y < 0.1 ? vec3(1.02, 1.0, 0.97) : r2.y < 0.2 ? vec3(0.98, 1.0, 0.99) : vec3(1.0);
  vec3 blk = TABLE_ALBEDO * (1.0 + 0.08 * (r2.x - 0.5)) * batch * (1.0 + 0.05 * fbm(uv, PM(30.0), 3, 83));
  blk *= 1.0 - 0.5 * voidM * fM;
  blk *= mix(1.0, 0.8, chipM * fM);
  vec3 mort = srgb8(160.0, 156.0, 146.0) * (1.0 + 0.06 * fbm(uv, PM(25.0), 2, 84)) * (0.94 + 0.12 * vnoise(uv, PM(250.0), 85));
  float eff = smoothstep(0.3, 0.7, fbm(uv, PM(6.0), 3, 86)) * (1.0 - smoothstep(0.0, 0.015, e));
  vec3 col = mix(mort, blk, fM);
  col = mix(col, saturation(col, 0.6) * 1.15, 0.6 * eff);
  s.albedo = col;
  s.rough = mix(0.92, 0.9, fM);`}
}
`;

// trim: albedo calibration (layerAlbedoCheck at 1024); phys: SurfacePhys (types.ts)
export const MASONRY_RECIPES: RecipeTable = {
  [Mat.CMU_PAINTED]: {
    glsl: cmuBlock(true), normalStrength: 1.0, heightScale: CMU_HS, trim: [1.007, 1.007, 1.008], aux: 'detailMask',
    phys: phys(0.3, { pomTop: 0.86, tok: 0.6, det: Det.CMU_FACE, detS: 1, sigma: 0.3 }),
  },
  [Mat.CMU_RAW]: {
    glsl: cmuBlock(false), normalStrength: 1.0, heightScale: CMU_HS, trim: [0.96, 0.965, 0.98], aux: 'detailMask',
    phys: phys(0.6, { pomTop: 0.86, tok: 0.8, det: Det.CMU_RAW, detS: 1, sigma: 0.45 }),
  },
};
