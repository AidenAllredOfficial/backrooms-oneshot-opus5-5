// src/textures/layers/tile.ts — tiled floors and walls: VINYL_VCT, POOL_TILE, POOL_MOSAIC (WP8; texture realism v2
// lane C). All three are physical tiles that WP9 rotates/flips per tile (tileSize), so every tile's content is
// self-contained; a joint is drawn as two halves, one by each tile. Along-the-line grout colour and the traffic wear
// are world-space (chunks/family/tile.ts): POOL_TILE and POOL_MOSAIC store their grout coverage in ormh.a ('mask').

import { Mat } from '../../core/ids.ts';
import { phys, type RecipeTable } from './types.ts';

/** Vinyl composition tile, 0.3 m: calendered vinyl chips in three populations (dark, light and a few accent and
 * charcoal flecks, stretched 3:1 along the calender direction; the per-tile rotation lays them quarter-turn), faint
 * marbling, tile tone +-3 % with a few tiles from another lot, continuous hairline butt joints with a dirt fillet,
 * corner chips on a few tiles, a waxed finish (roughness 0.2-0.28; joints 0.6) with faint scuffs. */
const VINYL_VCT = /* glsl */ `
#define SS 4
void gen(vec2 uv, inout Surf s) {
  vec2 m = uv * FRAME;
  TileInfo t = tiles(m, vec2(0.3));
  vec4 r = tileRand4(t.id, 5);
  vec4 r2 = tileRand4(t.id, 16); // seed picked for one other-lot and one chipped tile in the 16 of the frame
  float lot = step(r2.x, 0.04);
  vec3 base = TABLE_ALBEDO * (1.0 + mix(0.06, 0.12, lot) * (r.x - 0.5)) * mix(vec3(1.0), vec3(1.025, 1.0, 0.96), lot * r2.y);
  // continuous butt joints (0.3 mm per side, filtered to a hairline) and the dirt / wax fillet beside them
  float e = t.edge;
  float joint = fillM(e - 0.0003);
  float fillet = 1.0 - smoothstep(0.0003, 0.0013, e);
  // one chipped corner on 5 % of the tiles, dirt-filled
  vec2 cs = sign(r2.zw - 0.5);
  float cr = mix(0.003, 0.007, fract(r2.y * 7.1));
  float chip = step(fract(r2.x * 13.3), 0.05) * fillM(length(t.local - cs * 0.15) - cr);
  // (each output pass evaluates only its own part: the chip populations are albedo only)
  if (uOut == OUT_HEIGHT) {
    s.height = 0.6 - 0.15 * fillet - 0.25 * joint - 0.4 * chip;
    return;
  }
  if (uOut == OUT_ORMH) {
    float wax = fbmV(uv, PM(4.0), 3, 16);
    float scuff = smoothstep(0.55, 0.85, gnoise(warp(uv, PM(3.0), 2, 18, 0.03), PMxy(14.0, 90.0), 17))
                * smoothstep(0.35, 0.7, fbmV(uv, PM(3.0), 2, 19));
    s.rough = mix(mix(0.2, 0.28, wax) + 0.06 * scuff, 0.6, max(joint, 0.5 * fillet));
    s.rough = mix(s.rough, 0.7, chip);
    return;
  }
  vec2 tuv = uv + floor(r.zw * 64.0) / 16.0; // per-tile pattern offset (keeps periodicity: multiples of 1/16)
  vec2 wv = warp(tuv, PM(8.0), 2, 11, 0.008);
  // chip populations: anisotropic Worley cells (11 x 3.7 mm, 8.3 x 2.8 mm, 4 x 2 mm), ragged outlines
  float rag = 0.12 * gnoise(wv, PMxy(160.0, 480.0), 12);
  Cell cd = worley(wv, PMxy(90.0, 270.0), 0.9, 13);
  float dk = step(hashf(cd.id, 17), 0.3) * (1.0 - smoothstep(-0.08, 0.0, cd.f1 + rag - mix(0.4, 0.62, hashf(cd.id, 16))));
  Cell cl = worley(wv + 0.37, PMxy(120.0, 360.0), 0.9, 14);
  float lt = step(hashf(cl.id, 19), 0.25) * (1.0 - smoothstep(-0.08, 0.0, cl.f1 + rag - mix(0.38, 0.58, hashf(cl.id, 18))));
  Cell ca = worley(wv + 0.71, PMxy(250.0, 500.0), 0.9, 15);
  float ah = hashf(ca.id, 21);
  float ac = step(ah, 0.12) * (1.0 - smoothstep(-0.1, 0.0, ca.f1 + rag - mix(0.3, 0.45, hashf(ca.id, 20))));
  float marb = fbm(wv, PMxy(8.0, 32.0), 4, 22);
  vec3 col = base * (1.0 + 0.05 * marb);
  col = mix(col, base * vec3(0.8, 0.82, 0.86), dk);
  col = mix(col, base * vec3(1.13, 1.12, 1.09), lt * (1.0 - dk));
  col = mix(col, ah < 0.08 ? base * vec3(1.3, 1.27, 1.2) : base * 0.55, ac);
  col *= (1.0 - 0.45 * joint) * (1.0 - 0.07 * fillet);
  col = mix(col, col * 0.7, chip);
  s.albedo = col;
}
`;

/** Pool tile, 0.15 m glazed ceramic (roughness 0.06-0.12). Each tile's face is inset 1.2-1.9 mm per side with a
 * +-0.25 mm wobble (hand-set joints: 2.4-3.8 mm, never ruler-straight), with a 4 mm cushion edge, a 'fat edge' glaze
 * ridge 3 mm inside it, a slight pillow and a +-0.5 deg tilt per axis (lippage: +-0.7 mm across a tile; +-1.5 deg
 * scattered the lamps into single-tile glints). Glaze shade +-4 %, 5 % cream and 3 % blue-white tiles from other
 * batches; visible crazing (a 0.8 mm crack net plus hairlines) on 12 % of the tiles; conchoidal chips at an edge or
 * corner of 6 % of the tiles showing the matte buff bisque; a hazy glaze rim at the joint. Sanded cement grout in a
 * concave profile ~1.5 mm below the cushion foot (roughness 0.8); its along-the-line colour is world-space (shader).
 * Pinholes and waviness of the glaze are D6's. */
const POOL_TILE = /* glsl */ `
#define SS 4
void gen(vec2 uv, inout Surf s) {
  vec2 m = uv * FRAME;
  TileInfo t = tiles(m, vec2(0.15));
  vec4 r = tileRand4(t.id, 3);
  vec4 r2 = tileRand4(t.id, 26); // seed picked for 4 chips, 4 cream and 2 blue-white tiles in the 64 of the frame
  vec4 hw = 0.0015 * mix(vec4(0.8), vec4(1.25), tileRand4(t.id, 11)); // grout half-widths: left, right, bottom, top
  hw.xy += 0.00025 * vec2(gnoise(uv, PM(60.0), 12), gnoise(uv, PM(60.0), 13));
  hw.zw += 0.00025 * vec2(gnoise(uv, PM(60.0), 14), gnoise(uv, PM(60.0), 15));
  vec2 fc = vec2(hw.x - hw.y, hw.z - hw.w) * 0.5;
  vec2 fh = vec2(0.075) - vec2(hw.x + hw.y, hw.z + hw.w) * 0.5;
  vec2 lp = t.local - fc;
  float e = -sdRoundBox(lp, fh, 0.0015); // metres into the tile face (< 0 in the grout)
  float w = 0.7 * aaM();
  float face = smoothstep(-w, w, e);
  // chip: one conchoidal scoop at an edge or a corner of 6 % of the tiles, 4-10 mm, 0.6-1.2 mm deep, bisque inside
  float chipD = 0.0;
  if (r2.y < 0.06) {
    float R = mix(0.004, 0.01, r2.z);
    float out_ = mix(0.0005, 0.002, fract(r2.w * 5.3));
    int k = int(r2.w * 8.0);
    vec2 sg = vec2(k == 0 || k == 3 || k == 4 ? -1.0 : 1.0, k < 2 || k == 4 ? -1.0 : 1.0);
    float tt = mix(-0.7, 0.7, fract(r2.z * 9.1));
    vec2 ctr = k < 4 ? sg * (fh + out_ * 0.7) : k == 4 ? vec2(-fh.x - out_, tt * fh.y) : k == 5 ? vec2(fh.x + out_, tt * fh.y)
             : k == 6 ? vec2(tt * fh.x, -fh.y - out_) : vec2(tt * fh.x, fh.y + out_);
    float dd = length(lp - ctr) / R;
    chipD = dd < 1.0 ? mix(0.0006, 0.0012, fract(r2.z * 3.7)) * (1.0 - pow(dd, 1.5)) : 0.0;
  }
  s.aux = 1.0 - face;
  if (uOut == OUT_HEIGHT) {
    // relief: cushion, fat-edge ridge, pillow, tilt, long-wave waviness, the chip; concave grout (0.14 at the tile edges,
    // 0.10 in the middle of the joint, the cell border)
    float cush = sat(e / 0.004);
    float cushH = 1.0 - (1.0 - cush) * (1.0 - cush);
    float ridge = gauss((e - 0.003) / 0.0012) * 0.00005 / 0.008; // the glaze pools on the cushion
    vec2 slope = (r.xy - 0.5) * 2.0 * 0.009;
    float wav = fbm(uv, PM(22.0), 2, 4) * 0.00012;
    float pillow = 0.012 * (1.0 - dot(t.local, t.local) / (2.0 * 0.075 * 0.075));
    float hTile = 0.3 + 0.25 * cushH + ridge + pillow + (dot(t.local, slope) + wav - chipD) / 0.008;
    float a = sat(-e / max(t.edge - e, 1e-5));
    float hGrout = 0.14 - 0.04 * a * a + 0.02 * vnoise(uv, PM(300.0), 8);
    s.height = mix(hGrout, hTile, face);
    return;
  }
  // glaze colour: batch shade, cream and blue-white odd tiles
  vec3 glaze = TABLE_ALBEDO * (1.0 + 0.08 * (r.z - 0.5)) * (1.0 + 0.008 * fbm(uv, PM(40.0), 2, 5));
  glaze *= r2.x < 0.05 ? vec3(0.985, 0.972, 0.935) : r2.x < 0.08 ? vec3(0.975, 0.985, 1.0) : vec3(1.0);
  // crazing: a crack net (22 mm cells) and finer hairlines in the glaze of 12 % of the tiles, dirt in the cracks
  // (evaluated on crazed tiles only: two exact Voronoi borders are the recipe's costliest part)
  float crz = 0.0;
  if (r.w < 0.12) {
    vec2 co = floor(r.zw * 16.0) / 8.0;
    vec3 cz = worleyEdge(uv + co, PM(45.0), 0.9, 30);
    vec3 cz2 = worleyEdge(uv + co.yx, PM(110.0), 0.9, 31);
    crz = max(lineM(cz.x * FRAME.x / float(PM(45.0).x), 0.0004), 0.6 * lineM(cz2.x * FRAME.x / float(PM(110.0).x), 0.00025))
        * smoothstep(0.002, 0.004, e);
  }
  glaze *= 1.0 - 0.1 * crz;
  float chipM = smoothstep(0.0, 0.00015, chipD) * face;
  vec3 bisque = srgb8(196.0, 182.0, 160.0) * (0.85 + 0.15 * sat(chipD / 0.0008)); // buff body, dirtier toward the scoop
  // grout haze: the glaze rim next to the joint is filmed over (cement residue, cleaning chemicals)
  vec3 groutCol = srgb8(176.0, 178.0, 170.0) * (0.94 + 0.12 * vnoise(uv, PM(300.0), 6));
  float haze = (1.0 - smoothstep(0.0, 0.0045, e)) * face;
  glaze = mix(glaze, groutCol, 0.08 * haze);
  glaze = mix(glaze, bisque, chipM);
  s.albedo = mix(groutCol, glaze, face);
  float rG = 0.06 + 0.06 * fbmV(uv, PM(10.0), 2, 7) + 0.06 * crz + 0.1 * haze;
  s.rough = mix(0.8, mix(rG, 0.85, chipM), face);
}
`;

/** 2.5 cm glass mosaic on 0.3 m paper-backed sheets (the shader's rotation cells). Chips with 2 mm rounded corners
 * (grout flats of 2 mm, small diamonds where four chips meet), a 1 mm edge round, a 0.15 mm dome, per-chip lippage
 * (+-0.25 mm) and tilt (+-0.5 deg per axis); the sheet edges show as slightly wider joints. A blend of five related
 * aqua hues (+-6 deg, value 0.83-1.19) and a few accents; the colour sits inside the glass: a cloudy interior, faint
 * streaks, bubbles in some chips, and a darker, more saturated edge band where the light path through the glass is
 * longer. Grout (roughness 0.8) with its along-the-line colour from the shader. */
const POOL_MOSAIC = /* glsl */ `
#define SS 4
vec3 hueRot(vec3 c, float a) {
  const vec3 k = vec3(0.57735027);
  float ca = cos(a), sa = sin(a);
  return max(c * ca + cross(k, c) * sa + k * dot(k, c) * (1.0 - ca), vec3(0.0));
}
void gen(vec2 uv, inout Surf s) {
  vec2 m = uv * FRAME;
  TileInfo sh = tiles(m, vec2(0.3));
  TileInfo t = tiles(m, vec2(0.025));
  vec4 r = tileRand4(t.id, 3);
  vec4 r2 = tileRand4(t.id, 5);
  // sheet edges: the outer chips of a sheet sit 0.3 mm further in (wider joints between sheets)
  vec2 ci = floor((sh.local + 0.15) / 0.025);
  vec4 ins = vec4(step(ci.x, 0.5), step(10.5, ci.x), step(ci.y, 0.5), step(10.5, ci.y)) * 0.0003;
  vec2 fc = vec2(ins.x - ins.y, ins.z - ins.w) * 0.5 + (r2.xy - 0.5) * 0.0004;
  vec2 fh = vec2(0.0115) - vec2(ins.x + ins.y, ins.z + ins.w) * 0.5;
  vec2 lp = t.local - fc;
  float d = sdRoundBox(lp, fh, 0.002); // < 0 on the chip
  float w = 0.7 * aaM();
  float chip = 1.0 - smoothstep(-w, w, d);
  float ed = sat(-d / 0.001);
  float edgeH = 1.0 - (1.0 - ed) * (1.0 - ed);
  float dome = 1.0 - dot(lp, lp) / (2.0 * 0.0115 * 0.0115);
  vec2 tilt = (r.yz - 0.5) * 2.0 * 0.009;
  float hChip = 0.3 + 0.35 * edgeH + (0.00015 * dome + (r2.z - 0.5) * 0.0005 + dot(lp, tilt)) / 0.004;
  vec2 po = floor(r.zw * 32.0) / 8.0;
  float bub = 0.0;
  if (r2.w < 0.05) {
    Cell bu = worley(uv + po, PM(250.0), 0.9, 11);
    bub = step(hashf(bu.id, 12), 0.35) * (1.0 - smoothstep(0.08, 0.14, bu.f1)) * step(0.002, -d);
  }
  s.rough = mix(0.8, 0.05 + 0.03 * r.w, chip);
  s.aux = 1.0 - chip;
  if (uOut == OUT_HEIGHT) {
    float a = sat(d / max(t.edge + d, 1e-5)); // 0 at the chip edge, 1 at the cell border (the joint's middle)
    s.height = mix(0.14 - 0.04 * a * a, hChip - 0.03 * bub, chip);
    return;
  }
  if (uOut != OUT_ALBEDO) return;
  // palette: five related hues and values, 5 % accents (a pale and a deep chip)
  vec3 T = TABLE_ALBEDO;
  float p = r.x;
  vec3 col = p < 0.3 ? T
           : p < 0.52 ? hueRot(T, -0.07) * 1.13
           : p < 0.72 ? hueRot(T, 0.09) * 0.87
           : p < 0.85 ? hueRot(T, 0.035) * 1.19
           : p < 0.95 ? hueRot(T, -0.1) * 0.83
           : p < 0.98 ? saturation(T, 0.6) * 1.12
           : hueRot(T, 0.3) * 0.84;
  col *= 1.0 + 0.06 * (r.w - 0.5);
  // inside the glass: cloud, streaks (per chip along u or v), the darker saturated edge band, bubbles
  col *= 1.0 + 0.3 * fbm(uv + po, PM(150.0), 3, 4);
  float stk = r2.w < 0.5 ? gnoise(uv + po, PMxy(60.0, 240.0), 9) : gnoise(uv + po, PMxy(240.0, 60.0), 10);
  col *= 1.0 + 0.08 * stk;
  float eb = 1.0 - smoothstep(0.0, 0.0015, -d);
  col = saturation(col, 1.0 + 0.1 * eb) * (1.0 - 0.1 * eb);
  col *= 1.0 + 0.15 * bub;
  vec3 groutCol = srgb8(168.0, 172.0, 168.0) * (0.94 + 0.12 * vnoise(uv, PM(400.0), 13));
  s.albedo = mix(groutCol, col, chip);
}
`;

// trim: albedo calibration (layerAlbedoCheck at 1024); phys: SurfacePhys (types.ts)
export const TILE_RECIPES: RecipeTable = {
  [Mat.VINYL_VCT]: {
    glsl: VINYL_VCT, normalStrength: 1.0, heightScale: 0.0015, trim: [1.014, 1.016, 1.02],
    phys: phys(0.05, { tok: 0.5, det: 6, detS: 0.5, glaze: 0.22, roughComp: 0.7 }),
  },
  [Mat.POOL_TILE]: {
    glsl: POOL_TILE, normalStrength: 1.0, heightScale: 0.008, trim: [1.019, 1.019, 1.023], aux: 'mask',
    phys: phys(0.08, { pomTop: 0.76, tok: 0.3, det: 6, detS: 1, glaze: 0.09, roughComp: 0.8 }),
  },
  [Mat.POOL_MOSAIC]: {
    glsl: POOL_MOSAIC, normalStrength: 1.0, heightScale: 0.004, trim: [0.977, 1.051, 1.068], aux: 'mask',
    phys: phys(0.05, { pomTop: 0.8, tok: 0.3, det: 6, detS: 0.7, glaze: 0.1, roughComp: 0.8 }),
  },
};
