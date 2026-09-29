// src/textures/layers/wallpaper.ts — wall coverings: WALLPAPER_L0, WALLPAPER_MANILA, DRYWALL, TRIM_PAINT (WP8).

import { Mat } from '../../core/ids.ts';
import { phys, type RecipeTable } from './types.ts';

/** Level 0 wallpaper: mustard paper-backed vinyl (Type I, satin) in two 0.6 m rolls. Print (the Level 0 photo's
 * identity): vertical stripe system on a 0.15 m pitch, a slightly darker ink band carrying a column of stacked
 * up-pointing chevrons, flanked by pinlines. The print is surface-printed flat ink over the emboss (5-10 um film, a
 * 0.02 mm step with rounded shoulders, not a stamped relief), -22 % in value and a touch glossier (0.56), with gravure
 * density streaks along the roll and the band fill misregistered 0.2 mm against the strokes. The ground is a
 * fabric-look print in register with its emboss: a strie of 2.5-17 mm streaks (+-5 %) and raised slub dashes (+4 %,
 * vertical 3 x 25 mm and horizontal 25 x 3 mm), which carry the field's texture at room distance (the emboss alone
 * shaded < 1 % under the baked light), and a 0.05 mm cockle over 3-5 cm that only the sheen shows; the finer thread
 * emboss is D2 (VINYL_FABRIC). Satin roughness: ground 0.62 (emboss peaks -0.05, valleys +0.04), glue squeeze-out
 * along the roll seam 0.53 (all above the SSR cut-off at high, 0.45: below it the lamps glinted off single texels).
 * ormh.a is the detail mask: 0.6 on ink (the emboss under the ink film is shallower). Lifted edges, fading and stains
 * come from the WP7 mask and the walls family (chunks/family/walls.ts). */
const WALLPAPER_L0 = /* glsl */ `
#define SS 4
void gen(vec2 uv, inout Surf s) {
  vec2 m = uv * FRAME;
  // rolls (0.6 m): per-roll shade and pattern offset come from WP9 (world-anchored hash); hairline seam here
  float dSeam = distLines(m.x, 0.6);
  // stripe system, pitch 0.15 m: dark ink band centred on x = 0.075 + k 0.15; the band fill is printed by its own
  // cylinder, 0.2 mm right and 0.15 mm up of the stroke cylinder (misregistration)
  float xs = m.x - (floor(m.x / 0.15) + 0.5) * 0.15;
  float ax = abs(xs);
  float band = softM(abs(xs - 0.0002) - 0.021, 0.00025);
  float bandH = softM(abs(xs - 0.0002) - 0.021, 0.0005);
  float pins = lineM(ax - 0.0275, 0.0012) + 0.6 * lineM(ax - 0.0325, 0.0008);
  // chevrons, 30 mm pitch, pointing +v, 2.4 mm stroke, 24 mm wide (clipped by the band fill)
  float cy = m.y - (floor(m.y / 0.03) + 0.5) * 0.03;
  float dChev = sdSeg(vec2(ax, cy), vec2(0.0, 0.0055), vec2(0.0115, -0.0055)) - 0.0018;
  float chev = softM(dChev, 0.00025) * band;
  float ink = sat(max(chev, pins * 0.8));
  float inkH = sat(max(softM(dChev, 0.0005) * bandH, pins * 0.8));
  // gravure ink density streaks (along the roll, ~12 cm wide)
  float den = 0.88 + 0.12 * (0.5 + 0.5 * gnoise(uv, PMxy(8.0, 2.0), 21));
  // vinyl ground: vertical strie, slub dashes (vertical 3 x 25 mm, horizontal 25 x 3 mm), cockle, formation
  float strie = gnoise(uv, PMxy(60.0, 1.5), 14) * 0.4 + gnoise(uv, PMxy(160.0, 2.0), 15) * 0.35 + gnoise(uv, PMxy(400.0, 4.0), 18) * 0.35;
  Cell sv = worley(uv, PMxy(300.0, 40.0), 0.9, 31);
  float slubV = step(hashf(sv.id, 32), 0.3) * (1.0 - smoothstep(0.15, 0.55, sv.f1));
  Cell sh = worley(uv, PMxy(40.0, 300.0), 0.9, 33);
  float slubH = step(hashf(sh.id, 34), 0.2) * (1.0 - smoothstep(0.15, 0.55, sh.f1));
  float slub = max(slubV, slubH);
  float cockle = fbm(uv, PM(18.0), 3, 17);
  float formation = fbm(uv, PM(24.0), 3, 13);
  float age = fbm(uv, PM(2.5), 3, 16);
  float bandTone = 0.5 + 0.5 * cos(6.2831853 * xs / 0.15); // 1 at the ink band centre
  vec3 c = TABLE_ALBEDO;
  c *= 1.0 + 0.04 * slub + 0.05 * strie + 0.02 * formation;
  // ground print: the band is a slightly deeper mustard, the gap between a paler cream-yellow
  c *= mix(vec3(1.035, 1.03, 1.05), vec3(0.93, 0.915, 0.85), band * 0.85 + 0.15 * bandTone);
  // ageing: slightly browner, deeper patches
  c *= mix(vec3(1.0), vec3(0.965, 0.95, 0.9), sat(age * 1.6));
  // ink: about -22 % value, browner (more saturated): the chevrons must read at room distance
  c *= mix(vec3(1.0), vec3(0.8, 0.76, 0.62), ink * den);
  // roll seam: hairline gap, dirt line
  float gap = lineM(dSeam, 0.00025);
  float seamDirt = gauss(dSeam / 0.004);
  c *= 1.0 - 0.3 * gap - 0.04 * seamDirt;
  s.albedo = c;
  s.height = 0.5 + 0.04 * inkH + 0.06 * strie + 0.16 * slub + 0.12 * cockle + 0.2 * gauss(dSeam / 0.0018) - 0.2 * gap;
  float glue = gauss(dSeam / 0.004);
  s.rough = mix(0.62 + 0.04 * sat(-strie) - 0.05 * slub - 0.03 * sat(strie), 0.56, ink);
  s.rough = mix(s.rough, 0.53, glue);
  s.aux = 1.0 - 0.4 * ink;
}
`;

/** Manila: beige paper-backed vinyl, satin (~0.72), a fine linen emboss and vertical double pinstripes at 0.15 m
 * pitch. The pinstripes are two flat 1 mm ink lines at +-1.75 mm (11-18 % darker ink, a dip under 10 % once the texel
 * averages it, a slight hand-screen wobble of +-0.2 mm, a touch glossier), with no relief and no light line between
 * them: printed, not routed. The base holds what its texel can resolve: a linen ground printed and embossed in
 * register (warp and weft thread bundles as 4 mm streaks, +-3.5 %, and 2.5 x 50 mm slub dashes along both thread
 * directions: at room distance the ground's texture is this print, since the emboss alone shades < 1 % under the
 * baked light) and the paper's formation; the single linen threads are D17 (at a 0.15 m detail repeat, 0.29 mm
 * texels). */
const WALLPAPER_MANILA = /* glsl */ `
#define SS 4
void gen(vec2 uv, inout Surf s) {
  vec2 m = uv * FRAME;
  // pinstripes: two flat ink lines every 0.15 m, wobbling +-0.2 mm
  float wob = 0.0002 * gnoise(uv, PMxy(4.0, 1.0), 9);
  float d = distLines(m.x + wob, 0.15);
  float ink = sat(lineM(d - 0.00175, 0.0005) + lineM(d + 0.00175, 0.0005));
  // linen ground, printed and embossed in register: warp and weft thread bundles (4 mm streaks, 17 cm long) and
  // slubs (2.5 mm dashes along both thread directions), then the paper
  float linen = 0.6 * gnoise(uv, PMxy(250.0, 6.0), 21) + 0.4 * gnoise(uv, PMxy(6.0, 250.0), 22);
  float slub = max(smoothstep(0.62, 0.9, vnoise(uv, PMxy(400.0, 20.0), 3)), smoothstep(0.66, 0.92, vnoise(uv, PMxy(20.0, 400.0), 4)));
  float formation = fbm(uv, PM(25.0), 3, 5);
  float age = fbm(uv, PM(2.5), 3, 6);
  float dSeam = distLines(m.x, 0.6);
  vec3 c = TABLE_ALBEDO;
  c *= 1.0 + 0.02 * formation + 0.035 * linen + 0.025 * (slub - 0.3);
  c *= mix(vec3(1.0), vec3(0.975, 0.965, 0.935), sat(age * 1.5));
  c *= mix(vec3(1.0), vec3(0.89, 0.87, 0.82), ink);
  float gap = lineM(dSeam, 0.0002);
  c *= 1.0 - 0.3 * gap - 0.03 * gauss(dSeam / 0.003);
  s.albedo = c;
  s.height = 0.5 + 0.08 * slub + 0.06 * linen + 0.25 * gauss(dSeam / 0.0015) - 0.2 * gap + 0.3 * fbm(uv, PM(7.0), 2, 17);
  s.rough = 0.72 - 0.03 * slub - 0.03 * ink;
}
`;

/** Painted gypsum board, latex eggshell from a 3/8" nap roller. The base texel (2.34 mm) cannot hold the orange peel
 * (0.5-2 mm stipple, 20-60 um high: D16 ROLLER_STIPPLE), so the base holds only what is larger: the roller's mottle
 * (~4 cm), the 0.24 m roller laps (a faint ridge and sheen change between passes), and the taped joints every 1.2 m,
 * feathered ~0.25 m wide and crowned 0.075 mm, where the compound takes the primer differently: smoother, glossier
 * (roughness 0.55 against the field's 0.62) and 1 % lighter. ormh.a is the detail mask: 0.6 over the joint bands (the
 * stipple is shallower over compound). Screw spots, pops, patches, scuffs and damp come from the paint profile
 * (chunks/family/walls.ts). */
const DRYWALL = /* glsl */ `
#define SS 4
void gen(vec2 uv, inout Surf s) {
  vec2 m = uv * FRAME;
  float mottle = fbm(uv, PM(25.0), 3, 5);
  // roller laps: vertical passes 0.24 m wide, their edge ridges fading in and out along the wall
  float lapN = vnoise(uv, PMxy(1.0, 1.0), 7);
  float lap = cos(6.2831853 * m.x / 0.24) * (0.3 + 0.7 * lapN);
  // taped joints every 1.2 m (feathered ~0.25 m): crowned, smoother and glossier
  float dj = distLines(m.x, 1.2);
  float joint = gauss(dj / 0.12);
  vec3 col = TABLE_ALBEDO * (1.0 + 0.008 * fbm(uv, PM(5.0), 3, 8) + 0.01 * joint);
  s.albedo = col;
  s.height = 0.5 + 0.05 * mottle + 0.02 * lap + 0.15 * joint;
  s.rough = 0.62 - 0.07 * joint + 0.015 * lap + 0.01 * mottle;
  s.aux = 1.0 - 0.4 * smoothstep(0.3, 0.8, joint);
}
`;

/** Semi-gloss trim paint (baseboards, casings): orange peel, brush drag, scuffs and small dings. */
const TRIM_PAINT = /* glsl */ `
void gen(vec2 uv, inout Surf s) {
  float peel = fbm(uv, PM(220.0), 3, 3);
  float brush = gnoise(uv, PMxy(3.0, 320.0), 4) * 0.6 + gnoise(uv, PMxy(6.0, 700.0), 5) * 0.4;
  float scuffN = gnoise(warp(uv, PM(4.0), 2, 6, 0.02), PMxy(22.0, 150.0), 7);
  float scuffZone = smoothstep(0.15, 0.6, fbmV(uv, PM(3.0), 3, 8));
  float scuff = smoothstep(0.45, 0.85, scuffN) * scuffZone;
  Cell dg = worley(uv, PM(28.0), 0.9, 9);
  float ding = step(hashf(dg.id, 10), 0.12) * (1.0 - smoothstep(0.03, 0.07, dg.f1));
  vec3 col = TABLE_ALBEDO * (1.0 + 0.008 * peel + 0.012 * fbm(uv, PM(4.0), 3, 11));
  col = mix(col, srgb8(52.0, 48.0, 44.0), 0.55 * scuff);
  col *= 1.0 - 0.25 * ding;
  s.albedo = col;
  s.height = 0.55 + 0.12 * peel + 0.05 * brush - 0.3 * ding - 0.04 * scuff;
  s.rough = 0.44 + 0.05 * peel + 0.03 * brush + 0.25 * scuff + 0.2 * ding;
}
`;

// normalStrength (texture realism v2): the base texel (1.17-2.34 mm) holds only the relief it can resolve (slubs,
// strie, laps, joints, cockle), at a mild 1.5-2.5x over its real depth; the grain the eye reads up close is in the
// detail maps (D2, D16, D17: rms slopes 0.05-0.07), which become LEAN roughness with distance. The old 6-10x made
// the wallpaper's print a rubber stamp and the drywall stucco. Props that need a plain matte surface do not borrow
// these layers (kraft boxes on DRYWALL read as stucco).
// trim: albedo calibration (layerAlbedoCheck at 1024); phys: SurfacePhys (types.ts)
export const WALL_RECIPES: RecipeTable = {
  [Mat.WALLPAPER_L0]: {
    glsl: WALLPAPER_L0, normalStrength: 2.5, heightScale: 0.0004, trim: [1.007, 1.018, 1.037],
    phys: phys(0.35, { det: 2, detS: 1, detRep: 0.5, sigma: 0.2 }), aux: 'detailMask',
  },
  [Mat.WALLPAPER_MANILA]: {
    glsl: WALLPAPER_MANILA, normalStrength: 2.0, heightScale: 0.0006, trim: [1.009, 1.011, 1.014],
    phys: phys(0.35, { det: 17, detS: 1, detRep: 0.5, sigma: 0.2 }),
  },
  [Mat.DRYWALL]: {
    glsl: DRYWALL, normalStrength: 2.0, heightScale: 0.0005, trim: [0.998, 0.995, 1.001],
    phys: phys(0.5, { det: 16, detS: 1, sigma: 0.2 }), aux: 'detailMask',
  },
  [Mat.TRIM_PAINT]: {
    glsl: TRIM_PAINT, normalStrength: 4.0, heightScale: 0.0003, trim: [1.007, 1.01, 1.005],
    phys: phys(0.1, { det: 3, detS: 0.5, sigma: 0.2 }),
  },
};
