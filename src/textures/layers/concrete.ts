// src/textures/layers/concrete.ts — mineral surfaces: CONCRETE_FLOOR, CONCRETE_WALL, CONCRETE_CEIL, CMU_PAINTED,
// FLOOR_PAINT, TERRAZZO (WP8).

import { Mat } from '../../core/ids.ts';
import type { RecipeTable } from './types.ts';

// CONCRETE_FLOOR / CONCRETE_CEIL are authored over a 4.8 x 3.0 frame (vertical faces: v = y / 3.0) but are mostly
// seen on horizontal faces, where v spans 4.8 m. Noise periods use a compromise frame of 4.8 x 3.8 so features are
// within 1.26:1 of isotropic in both uses.
const ISO_FRAME = /* glsl */ `
#undef NOISE_FRAME
#define NOISE_FRAME vec2(4.8, 3.8)
`;

/** Power-floated slab: aggregate speckle (supersampled), a few exposed pebbles, trowel swirl arcs with burnished
 * (darker, glossier) burns, Worley crack network, curing mottle, chalky laitance and a soft sheen field (a
 * unimodal roughness 0.44-0.6 instead of sealed vs rough camouflage). Oil spots are decals; pinholes are detail. */
const CONCRETE_FLOOR = /* glsl */ `
#define SS 4
${ISO_FRAME}
void gen(vec2 uv, inout Surf s) {
  float big = fbm(uv, PM(0.8), 4, 1);
  float mid = fbm(uv, PM(5.0), 4, 2);
  float sand = vnoise(uv, PM(240.0), 3);
  float sand2 = vnoise(uv, PM(520.0), 4);
  float grains = smoothstep(0.68, 0.84, sand) - 0.8 * (1.0 - smoothstep(0.16, 0.32, sand));
  // exposed aggregate
  Cell ag = worley(uv, PM(42.0), 0.9, 5);
  float agOn = step(hashf(ag.id, 6), 0.07);
  float peb = agOn * (1.0 - smoothstep(0.16, 0.28, ag.f1 + 0.08 * vnoise(uv, PM(200.0), 7)));
  vec3 pebCol = mix(srgb8(92.0, 90.0, 86.0), srgb8(158.0, 152.0, 142.0), hashf(ag.id, 8));
  // power-trowel marks: partial overlapping arcs around ~0.45 m centres, varying pitch, mostly a sheen change
  Cell tw = worley(uv, PM(2.2), 0.8, 9);
  vec4 th = hash4f(tw.id, 10);
  float ang = atan(tw.rel.y, tw.rel.x);
  float sector = smoothstep(0.35, 0.85, 0.5 + 0.5 * sin(ang * (1.0 + floor(th.x * 2.0)) + th.y * 6.2831853));
  // radius wobble breaks the rings into overlapping, non-concentric blade passes; a broken-coverage mask keeps
  // only fragments of each pass (no bullseyes)
  float arcR = tw.f1 + 0.11 * fbm(uv, PM(3.0), 3, 11) + 0.025 * fbm(uv, PM(14.0), 2, 17);
  float arcs = 0.5 + 0.5 * sin(arcR * mix(38.0, 70.0, th.z) + th.w * 6.2831853);
  float arcMask = smoothstep(0.82, 0.98, arcs) * sector * smoothstep(0.3, 0.7, fbmV(uv, PM(1.5), 3, 12))
                * (1.0 - smoothstep(0.25, 0.75, tw.f1)) * smoothstep(0.05, 0.15, tw.f1)
                * smoothstep(0.35, 0.75, vnoise(uv, PM(7.0), 18));
  // crack network (Worley border distance), only partly present
  vec2 cuv = warp(uv, PM(8.0), 3, 12, 0.0035);
  ivec2 cp = PM(0.9);
  vec3 ce = worleyEdge(cuv, cp, 0.9, 13);
  float cellM = NOISE_FRAME.x / float(cp.x);
  float crackOn = smoothstep(0.05, 0.3, fbm(uv, PM(1.3), 3, 14));
  float cd = ce.x * cellM;
  float crack = lineM(cd, 0.0006) * crackOn;
  float halo = (1.0 - smoothstep(0.0, 0.012, cd)) * crackOn;
  // soft sheen field (wear and old sealer, 1-2 m): a unimodal roughness variation, no hard glossy / matte patches
  float sheen = smoothstep(-0.35, 0.45, fbm(uv, PM(0.6), 3, 15));
  // trowel burn: overworked blade passes, darker and burnished
  float burn = arcMask * smoothstep(0.45, 0.8, vnoise(uv, PM(1.2), 19));
  // curing mottle: irregular ~30 cm blotches where the slab cured under a mat / dried unevenly
  Cell mo = worley(warp(uv, PM(6.0), 2, 22, 0.025), PM(3.2), 0.9, 20);
  float mott = (1.0 - smoothstep(0.25, 0.8, mo.f1 + 0.25 * fbm(uv, PM(12.0), 2, 23))) * step(hashf(mo.id, 21), 0.45);
  // laitance: chalky, paler, rougher skin of fines on the surface
  float lait = smoothstep(0.55, 0.85, fbmV(uv, PM(2.0), 3, 24));
  vec3 col = TABLE_ALBEDO * (1.0 + 0.09 * big + 0.05 * mid + 0.07 * grains + 0.03 * (sand2 - 0.5));
  col *= mix(vec3(1.0), vec3(0.95, 0.96, 0.985), sheen * 0.6);
  col = mix(col, pebCol, peb * 0.65);
  col *= 1.0 - 0.015 * arcMask - 0.08 * halo;
  col *= 1.0 - 0.09 * burn;
  col *= 1.0 - 0.05 * mott;
  col = mix(col, col * vec3(1.1, 1.1, 1.08), 0.6 * lait);
  col = mix(col, col * 0.3, crack);
  s.albedo = col;
  s.height = 0.5 + 0.06 * mid + 0.06 * (sand - 0.5) + 0.08 * peb - 0.4 * crack + 0.015 * arcMask;
  s.rough = mix(0.6, 0.44, sheen) - 0.06 * arcMask - 0.14 * burn + 0.05 * mott + 0.08 * lait + 0.2 * crack + 0.04 * (sand2 - 0.5);
}
`;

/** Cast-in-place wall, frame 2.4 x 1.5 m: plywood formwork panels 1.2 x 1.5 m (seam fins, per-panel tone, grain
 * imprint), 4 tie holes per panel, bug holes, laitance mottling. Relief for parallax occlusion mapping: the face rests
 * at 0.9 (x CONCRETE_WALL_HS = 18 mm above height 0, pomTop 0.92) and the tie holes are cones from the rim down to 0
 * (the plastic cones of the snap ties leave 18 mm deep conical recesses); every other amplitude is 1/5 of its value at
 * the former 4 mm heightScale, so normals and cavity AO of the face are unchanged. The cone keeps the concrete colour
 * (a little darker): the relief shades it. */
const CONCRETE_WALL_HS = 0.02; // heightScale (m per height unit)
const CONCRETE_WALL = /* glsl */ `
#define SS 4
void gen(vec2 uv, inout Surf s) {
  vec2 m = uv * FRAME;
  TileInfo pn = tiles(m, vec2(1.2, 1.5));
  vec4 pr = tileRand4(pn.id, 3);
  vec3 col = TABLE_ALBEDO * (1.0 + 0.07 * (pr.x - 0.5)) * mix(vec3(1.0), vec3(1.02, 1.0, 0.97), pr.y);
  vec2 guv = warp(uv + pr.zw, PMxy(2.0, 6.0), 3, 4, 0.02);
  float grain = gnoise(guv, PMxy(1.5, 90.0), 5) * 0.6 + gnoise(guv, PMxy(4.0, 220.0), 6) * 0.4;
  float mot = fbm(uv, PM(3.0), 4, 7);
  float mot2 = fbm(uv, PM(14.0), 3, 8);
  Cell bh = worley(uv, PM(60.0), 0.9, 9);
  float bhOn = step(hashf(bh.id, 10), 0.18);
  float bhR = mix(0.04, 0.12, hashf(bh.id, 11));
  float bug = bhOn * (1.0 - smoothstep(bhR * 0.65, bhR, bh.f1));
  float fin = gauss(pn.edge / 0.0025);
  float seamLine = lineM(pn.edge, 0.0012);
  vec2 tl = vec2(abs(pn.local.x) - 0.3, abs(pn.local.y) - 0.375);
  float tr = length(tl);
  float tie = 1.0 - smoothstep(0.011, 0.0125 + 0.7 * aaM(), tr);
  float tieRing = gauss((tr - 0.017) / 0.003);
  float cone = 0.9 * sat(tr / 0.0125);
  col *= 1.0 + 0.05 * mot + 0.03 * mot2 + 0.025 * grain;
  col *= 1.0 - 0.35 * bug;
  col *= 1.0 - 0.2 * seamLine + 0.03 * fin;
  // the cone recess is the same concrete (cast against a smooth plastic cone, a little darker from form oil and dirt):
  // its depth now darkens it through the cavity AO, micro-shadowing and POM; the former dark plug colour on top of
  // that turned every tie hole into a pure black disc
  col = mix(col, col * 0.62, tie);
  col *= 1.0 - 0.1 * tieRing;
  s.albedo = col;
  float face = 0.9 + 0.008 * grain + 0.006 * mot2 - 0.06 * bug + 0.05 * fin + 0.008 * tieRing;
  s.height = mix(face, cone, tie);
  s.rough = 0.85 + 0.05 * mot2 + 0.05 * bug - 0.1 * tie;
}
`;

/** Board-formed soffit: boards along u (20 per frame), wood-grain imprint, per-board depth and tone, cement fins
 * at board joints, staggered butt joints. */
const CONCRETE_CEIL = /* glsl */ `
#define SS 4
${ISO_FRAME}
void gen(vec2 uv, inout Surf s) {
  float bv = uv.y * 20.0;
  float board = floor(bv);
  float by = bv - board;
  vec2 bid = wrapCell(vec2(board, 0.0), vec2(20.0, 1.0));
  vec4 br = hash4f(bid, 3);
  float bw = FRAME.y / 20.0;
  float edge = min(by, 1.0 - by) * bw;
  // butt joints: one per board per 2.4 m, staggered
  float jd = distLines((uv.x - br.x) * FRAME.x, 2.4);
  vec2 guv = warp(uv + br.yz, PMxy(1.0, 8.0), 3, 4, 0.01);
  float grain = gnoise(guv, PMxy(1.2, 160.0), 5) * 0.6 + gnoise(guv, PMxy(3.0, 420.0), 6) * 0.35;
  float mot = fbm(uv, PM(2.5), 4, 7);
  float pores = smoothstep(0.75, 0.9, vnoise(uv, PM(90.0), 8));
  float seam = lineM(edge, 0.0006);
  float ridge = gauss(edge / 0.003);
  float butt = lineM(jd, 0.0006);
  vec3 col = TABLE_ALBEDO * (1.0 + 0.07 * (br.w - 0.5) + 0.05 * mot + 0.045 * grain);
  col *= 1.0 - 0.15 * seam - 0.12 * butt - 0.2 * pores;
  s.albedo = col;
  s.height = 0.5 + 0.08 * (br.w - 0.5) + 0.06 * grain + 0.15 * ridge - 0.2 * seam - 0.15 * butt - 0.15 * pores;
  s.rough = 0.9 + 0.04 * mot;
}
`;

/** Painted CMU, frame 2.4 x 1.0 m: 0.4 x 0.2 m blocks (6 x 5 courses) with 10 mm concave recessed joints; paint
 * over porous block faces, paint-bridged voids, paint pooled glossier and darker in the joints; each block face is
 * laid slightly out of plane (+-0.35 deg), so the sheen changes block by block along a wall. 15 courses fit a 3 m
 * storey, so a true half bond cannot be periodic; courses use a third bond (offset sequence 0, 1/3, 2/3, 1/3, 2/3 of
 * a block), so every head joint is overlapped by >= 1/3. */
const CMU_HS = 0.014; // heightScale (m per height unit): 5.6 mm tooled joints below the face
const CMU_PAINTED = /* glsl */ `
#define SS 4
void gen(vec2 uv, inout Surf s) {
  vec2 m = uv * FRAME;
  float course = floor(m.y / 0.2);
  float cw = mod(course, 5.0);
  float off = cw < 0.5 ? 0.0 : cw < 1.5 ? 1.0 / 3.0 : cw < 2.5 ? 2.0 / 3.0 : cw < 3.5 ? 1.0 / 3.0 : 2.0 / 3.0;
  float bx = m.x + off * 0.4;
  float blk = floor(bx / 0.4);
  vec2 lp = vec2(bx - (blk + 0.5) * 0.4, m.y - (course + 0.5) * 0.2);
  vec2 bid = vec2(mod(blk, 6.0), cw);
  float e = min(0.2 - abs(lp.x), 0.1 - abs(lp.y));
  float w = 0.7 * aaM();
  float joint = 1.0 - smoothstep(0.005 - w, 0.005 + w, e);
  float jprof = 1.0 - (1.0 - sat(e / 0.005)) * (1.0 - sat(e / 0.005));
  float coarse = fbm(uv, PM(60.0), 3, 3);
  Cell po = worley(uv, PM(200.0), 0.95, 4);
  float pore = step(hashf(po.id, 5), 0.45) * (1.0 - smoothstep(0.1, 0.3, po.f1));
  float edgeRound = smoothstep(0.005, 0.013, e);
  // voids in the block face that the paint bridged over: shallow dimples
  Cell vo = worley(uv, PM(90.0), 0.9, 12);
  float vd = step(hashf(vo.id, 13), 0.3) * (1.0 - smoothstep(0.12, 0.3, vo.f1));
  float face = 0.72 + 0.05 * coarse - 0.1 * pore - 0.12 * vd;
  vec2 bt = (hash2f(bid, 7) - 0.5) * 0.012; // face tilt (slope), metres per metre
  face += dot(lp, bt) / ${CMU_HS};
  face = mix(face - 0.1, face, edgeRound);
  s.height = mix(face, 0.3 + 0.12 * jprof, joint);
  vec3 col = TABLE_ALBEDO * (1.0 + 0.03 * (tileRand(bid, 6) - 0.5) + 0.02 * coarse);
  col *= 1.0 - 0.1 * pore;
  col *= 1.0 - 0.08 * vd;
  col *= mix(1.0, 0.82, joint);
  s.albedo = col;
  s.rough = mix(0.46 + 0.12 * pore + 0.03 * coarse, 0.52, joint);
}
`;

/** Worn floor paint (safety yellow): alpha from thresholded warped noise, slightly raised glossy film. */
const FLOOR_PAINT = /* glsl */ `
void gen(vec2 uv, inout Surf s) {
  float wear = fbm(warp(uv, PM(6.0), 3, 3, 0.02), PM(9.0), 5, 4);
  float fine = vnoise(uv, PM(300.0), 5);
  float a = smoothstep(-0.36, -0.2, wear + 0.22 * (fine - 0.5));
  float thin = smoothstep(-0.2, 0.05, wear);
  vec3 col = TABLE_ALBEDO * (1.0 + 0.04 * fbm(uv, PM(30.0), 2, 6));
  col *= mix(0.86, 1.0, thin);
  s.alpha = a;
  s.albedo = col;
  s.rough = 0.45 + 0.12 * (1.0 - thin);
  s.height = 0.4 + 0.25 * a;
}
`;

/** Terrazzo: marble/stone chips in a grey cement matrix, polished (0.13-0.2; pits 0.3+); brass divider strips on the
 * 2.4 m frame. */
const TERRAZZO = /* glsl */ `
#define SS 4
vec3 tzChip(float h) {
  return h < 0.3 ? srgb8(226.0, 222.0, 212.0)
       : h < 0.52 ? srgb8(146.0, 142.0, 136.0)
       : h < 0.68 ? srgb8(46.0, 45.0, 46.0)
       : h < 0.86 ? srgb8(206.0, 190.0, 162.0)
       : h < 0.94 ? srgb8(150.0, 86.0, 66.0)
       : srgb8(88.0, 112.0, 94.0);
}
void gen(vec2 uv, inout Surf s) {
  vec2 m = uv * FRAME;
  vec3 matrixCol = TABLE_ALBEDO * (1.0 + 0.04 * fbm(uv, PM(5.0), 3, 3)) * (0.95 + 0.1 * vnoise(uv, PM(600.0), 4));
  // large chips: angular (mix of L2 and L-inf distance), warped
  vec2 w1 = warp(uv, PM(40.0), 2, 5, 0.004);
  Cell c1 = worley(w1, PM(55.0), 0.95, 6);
  vec4 h1 = hash4f(c1.id, 7);
  float d1 = mix(c1.f1, max(abs(c1.rel.x), abs(c1.rel.y)) * 1.15, h1.z);
  float r1 = mix(0.24, 0.4, h1.y);
  float chip1 = step(h1.w, 0.8) * (1.0 - smoothstep(r1 - 0.03, r1, d1));
  // small chips
  Cell c2 = worley(uv, PM(170.0), 0.95, 8);
  vec4 h2 = hash4f(c2.id, 9);
  float chip2 = step(h2.x, 0.65) * (1.0 - smoothstep(0.2, 0.3, c2.f1));
  vec3 col = mix(matrixCol, tzChip(h2.y) * (0.95 + 0.1 * h2.z), chip2);
  col = mix(col, tzChip(h1.x) * (0.94 + 0.12 * vnoise(uv, PM(300.0), 10)), chip1);
  float strip = fillM(min(distLines(m.x, 2.4), distLines(m.y, 2.4)) - 0.0015);
  col = mix(col, srgb8(170.0, 136.0, 80.0), strip);
  Cell pt = worley(uv, PM(120.0), 0.9, 11);
  float pit = step(hashf(pt.id, 12), 0.1) * (1.0 - smoothstep(0.05, 0.12, pt.f1)) * (1.0 - chip1);
  col *= 1.0 - 0.3 * pit;
  s.albedo = col;
  s.metal = strip;
  s.rough = mix(0.13 + 0.07 * fbmV(uv, PM(3.0), 3, 13) + 0.2 * pit, 0.3, strip);
  s.height = 0.5 + 0.02 * chip1 - 0.3 * pit;
}
`;

export const CONCRETE_RECIPES: RecipeTable = {
  // normalStrength (as the wall coverings, textures/layers/wallpaper.ts): the trowelled slab, the formwork face and the
  // board-formed soffit had mip-0 slopes of 0.006 / 0.015 / 0.024 (0.3-1.4 degrees) and shaded flat
  [Mat.CONCRETE_FLOOR]: { glsl: CONCRETE_FLOOR, normalStrength: 6.0, heightScale: 0.004 },
  [Mat.CONCRETE_WALL]: { glsl: CONCRETE_WALL, normalStrength: 5.0, heightScale: CONCRETE_WALL_HS },
  [Mat.CONCRETE_CEIL]: { glsl: CONCRETE_CEIL, normalStrength: 3.0, heightScale: 0.005 },
  [Mat.CMU_PAINTED]: { glsl: CMU_PAINTED, normalStrength: 1.0, heightScale: CMU_HS },
  [Mat.FLOOR_PAINT]: { glsl: FLOOR_PAINT, normalStrength: 1.0, heightScale: 0.0003 },
  [Mat.TERRAZZO]: { glsl: TERRAZZO, normalStrength: 1.0, heightScale: 0.001 },
};
